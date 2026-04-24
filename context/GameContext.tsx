"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react";
import { isWeaponDamageRollIdResolved } from "@/lib/weaponDamageRollDedupe";
import {
  arrayRemove,
  arrayUnion,
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { CAMPAIGN_CONTEXT, CAMPAIGN_START_WORLD_TIME_MINUTES, GOBLIN_CAVE } from "@/data/campaign";
import { BESTIARY } from "@/data/bestiary";
import { getWeaponIdByName } from "@/data/compendium";
import { resolveCombatantDisplayName } from "@/lib/combatDisplayName";
import { stackInventory } from "@/lib/inventoryStack";
import { resolveLocalPlayerCombatantId } from "@/lib/combatLocalPlayerId";
import {
  computePlayerArmorClass,
  inferEquipmentFromLegacy,
  normalizeEquipmentState,
  type PlayerEquipmentState,
} from "@/lib/playerEquipment";
import { db } from "@/lib/firebase";

/**
 * Pendant la résolution d'un jet côté client, les snapshots Firestore peuvent encore contenir
 * l'ancien `pendingRoll` ; sans ce garde-fou, `applySharedSessionPayload` réaffiche le prompt jet.
 */
export const skipRemotePendingRollApplyRef = { current: false };

/** Identifiant de document Firestore `sessions/{id}` (URL, formulaire, stockage). */
export function normalizeMultiplayerSessionId(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 40);
}

const MULTIPLAYER_COMMAND_LEASE_TTL_MS = 180_000;
/** Au-delà de ce délai, un verrou « intent » auto-joueur abandonné peut être repris par un autre client. */
const MULTIPLAYER_AUTO_INTENT_STALE_MS = 120_000;
/**
 * Les `updatedAtMs` des profils participants proviennent d'horloges locales différentes.
 * Une dérive inter-machines peut faire paraître "ancien" un update pourtant valide.
 */
const MULTIPLAYER_PROFILE_CLOCK_SKEW_TOLERANCE_MS = 10 * 60 * 1000;

/**
 * Messages du chat inclus dans le document `sessions/*` (payload partagé).
 * Tronquer limite la taille du doc et, surtout, réduit le nombre d'écritures « utiles » :
 * chaque `setDoc` sur ce doc déclenche ~1 lecture facturée par client qui écoute (onSnapshot).
 */
const FIRESTORE_SHARED_MESSAGES_CAP = 48;

/**
 * Dernière tranche pour Firestore.
 * On ne force plus la conservation des anciennes bulles `initiative-order-*` :
 * elles doivent disparaître naturellement de l'historique partagé.
 */
function sliceMessagesForSharedFirestorePayload(messages: Message[], cap: number): Message[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  if (messages.length <= cap) return messages;
  return messages.slice(-cap);
}

/** Debounce synchro hôte : plus c'est long, moins on écrit sur Firestore (quota lectures + écritures). */
const HOST_SESSION_SYNC_DEBOUNCE_MS = 1250;

/** Heartbeat profil participant : éviter updateDoc trop fréquent (STALE_PROFILE_MS = 45s). */
const PARTICIPANT_PROFILE_HEARTBEAT_MS = 18_000;

/**
 * Firestore rejette les champs `undefined`. Nettoie récursivement objets / tableaux avant setDoc/updateDoc.
 */
export function sanitizeForFirestore<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeForFirestore(item))
      .filter((item) => item !== undefined) as T;
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined) continue;
    const s = sanitizeForFirestore(v);
    if (s !== undefined) out[k] = s;
  }
  return out as T;
}

export type JoinMultiplayerSessionResult =
  | { ok: true }
  | { ok: false; reason: "invalid_id" | "not_found" | "full" | "duplicate_character" };

// ---------------------------------------------------------------------------
// Types joueur
// ---------------------------------------------------------------------------

export interface PlayerStats {
  FOR: number;
  DEX: number;
  CON: number;
  INT: number;
  SAG: number;
  CHA: number;
}

export interface CombatWeapon {
  name: string;
  attackBonus: number;
  damageDice: string;
  damageBonus: number;
  kind?: "melee" | "ranged";
  reach?: string;
  range?: string;
}

export type Weapon = CombatWeapon;

export interface SpellSlotRow {
  max: number;
  remaining: number;
}

export type SpellSlotsMap = { [spellLevel: number]: SpellSlotRow };

export interface CombatantBase {
  id: string;
  templateId?: string;
  type: string;
  controller?: CombatantController;
  name: string;
  entityClass?: string;
  race?: string;
  level?: number;
  visible: boolean;
  isAlive: boolean;
  hp: { current: number; max: number } | null;
  ac: number | null;
  stats: PlayerStats | EntityStats | null;
  inventory?: string[] | null;
  weapons?: CombatWeapon[] | null;
  features?: string[] | null;
  selectedSpells?: string[] | null;
  spellSlots?: SpellSlotsMap | null;
  spellAttackBonus?: number | null;
  spellSaveDc?: number | null;
  surprised?: boolean;
}

/** Effets de combat à durée (décrémentés par le moteur à chaque début de tour d’initiative). */
export interface CombatTimedStateEntry {
  stateId: string;
  rounds: number;
}

export interface Player {
  /** Pré-tirés / créateur : identifiant stable pour savoir si le joueur a changé de perso. */
  id?: string | number;
  type: "player";
  controller: "player";
  name: string;
  entityClass: string;
  race?: string;
  level: number;
  /** Alignement (ex: Loyal Bon, Neutre Mauvais, Chaotique Bon...) */
  alignment?: string;
  /** Historique (background) SRD du personnage, ex: "Héros du Peuple" */
  background?: string;
  /** Aptitude spéciale principale de l'historique (texte court) */
  backgroundFeature?: string;
  /** Idéaux (RP) résumés en une phrase */
  ideals?: string;
  /** Liens importants (bonds) en une phrase */
  bonds?: string;
  /** Défauts majeurs en une phrase */
  flaws?: string;
  /** Description physique / courte biographie libre */
  description?: string;
  initiative?: number;
  speed?: string;
  visible: boolean;
  isAlive: boolean;
  hp: { current: number; max: number };
  ac: number;
  /** Surpris au début du combat : perd son premier tour, puis repasse à false à la fin de ce tour. */
  surprised?: boolean;
  /** Points d'expérience courants (0 au niveau 1) */
  xp?: number;
  /** Type de dé de vie au format "d10", "d8", etc. */
  hitDie?: string;
  /** Nombre total de dés de vie (en général = level) */
  hitDiceTotal?: number;
  /** Nombre de dés de vie restants après repos */
  hitDiceRemaining?: number;
  /** États D&D (prone, blinded, poisoned, …) pour avantage/désavantage. */
  conditions?: string[];
  /** États temporels de combat (ex. bouclier magique) : `rounds` = pas d’initiative restants. */
  combatTimedStates?: CombatTimedStateEntry[];
  /** État D&D 5e à 0 PV : inconscience, stabilisation, jets contre la mort, mort. */
  deathState?: DeathState;
  /** Minute monde du dernier repos long effectivement bénéficié. */
  lastLongRestFinishedAtMinute?: number | null;
  /** Emplacements de sorts par niveau (ex: {1: {max: 4, remaining: 4}}) */
  spellSlots?: SpellSlotsMap;
  spellAttackBonus?: number | null;
  spellSaveDc?: number | null;
  stats: PlayerStats;
  /** Compétences maîtrisées (D&D 5e) */
  skillProficiencies: string[];
  /** Maîtrises (armes, outils, etc.) en clair pour l'affichage RP */
  proficiencies?: string[];
  /** Traits/racials et capacités de classe notables */
  features?: string[];
  /** Liste calculée de capacités de classe (par niveau), utile UI/prompt */
  classFeatures?: string[];
  /** Langues connues (ex: Commun, Nain, Elfique...) */
  languages?: string[];
  selectedSpells?: string[];
  inventory: string[];
  weapons: CombatWeapon[];
  /** Armure, mains, accessoires — la CA affichée est dérivée (voir `computePlayerArmorClass`). */
  equipment?: PlayerEquipmentState;
  /** Dons (SRD / maison) pour prérequis (ex. Ambidextrie). */
  feats?: string[];
  /** Données spécifiques à certaines classes (ex: Guerrier) */
  fighter?: {
    fightingStyle?: string; // ex: "Défense", "Duel", "Archerie"...
    martialArchetype?: "Champion" | "Maître de guerre" | "Chevalier occulte";
    /**
     * Bonus ASI appliqués (au-delà du tableau 15/14/13/12/10/8 et des bonus raciaux).
     * Le builder reste maître de l'application; le moteur lit juste ces valeurs.
     */
    asiBonuses?: Partial<PlayerStats>;
    /** Ressources de classe (valeurs “restantes” mises à jour par le moteur). */
    resources?: {
      secondWind?: { max: number; remaining: number };
      actionSurge?: { max: number; remaining: number };
      indomitable?: { max: number; remaining: number };
      superiorityDice?: { die: string; dice: number; remaining: number };
    };
    battleMaster?: {
      maneuvers?: string[];
    };
    eldritchKnight?: {
      schoolChoices?: string[]; // ex: ["Abjuration","Évocation"]
      cantripsKnown?: string[];
      spellsKnown?: string[];
    };
  };

  /** Données spécifiques au Magicien (SRD) */
  wizard?: {
    /** Tradition arcanique (école) choisie au niveau 2 */
    arcaneTradition?: string;
    /** Grimoire complet (sorts de niveau 1+ inscrits) */
    spellbook?: string[];
    /** Sorts préparés (source de vérité gameplay) */
    preparedSpells?: string[];
    /** Restauration arcanique (1/jour) */
    arcaneRecovery?: { used: boolean };
  };

  /** Données spécifiques au Clerc (SRD) */
  cleric?: {
    /** Domaine divin choisi au niveau 1 */
    divineDomain?: string;
    /** Sorts préparés (hors sorts de domaine); utile UI/prompt */
    preparedSpells?: string[];
    /** Sorts de domaine toujours préparés (automatiques); utile UI/prompt */
    domainSpells?: string[];
    /** Ressources (valeurs “restantes” mises à jour par le moteur). */
    resources?: {
      channelDivinity?: { max: number; remaining: number };
    };
  };

  /** Données spécifiques au Roublard (SRD) */
  rogue?: {
    archetype?: "Voleur" | "Assassin" | "Escroc arcanique";
    expertise?: {
      /** Compétences en expertise (bonus de maîtrise doublé) */
      skills?: string[];
      /** Expertise sur outils de voleur */
      thievesTools?: boolean;
    };
    arcaneTrickster?: {
      cantripsKnown?: string[];
      spellsKnown?: string[];
      schoolRestriction?: string[];
    };
    resources?: {
      luck?: { max: number; remaining: number };
    };
  };
}

export interface TurnResources {
  action: boolean;
  bonus: boolean;
  reaction: boolean;
  // Ressource de déplacement "théâtre de l'esprit" : elle est disponible ou pas,
  // et ne peut être utilisée qu'une seule fois par tour.
  movement: boolean;
}

/** Valeur initiale + ref : doit rester aligné avec le useState ci-dessous. */
const DEFAULT_TURN_RESOURCES: TurnResources = {
  action: true,
  bonus: false,
  reaction: true,
  movement: true,
};

export interface PendingRoll {
  stat: string;       // ex: "FOR", "DEX"
  totalBonus: number; // modificateur total (stat mod + maîtrise + bonus arme…)
  raison: string;     // ex: "attaque à l'Épée Longue"
  kind?: "attack" | "check" | "save" | "hit_die" | "death_save" | "damage_roll";
  /** Pour un test : nom de compétence (Perception, Acrobatics, etc.) si applicable */
  skill?: string;
  /** Pour une attaque : id de la cible dans `entities` */
  targetId?: string;
  /** Pour une attaque : nom de l'arme (doit correspondre à player.weapons[].name) */
  weaponName?: string;
  /** Un identifiant libre défini par l'IA pour empêcher les relances abusives (ex: "perception_ruelle_chat"). */
  id?: string;
  /** Contexte optionnel pour une résolution purement moteur (sans repasser par le MJ). */
  engineContext?: Record<string, any> | null;
  /** Personnage joueur qui doit lancer le dé (id stable, ex. fiche PJ). */
  forPlayerId?: string | null;
  /** Client (onglet) qui a déclenché l'action — en session partagée, seul ce client a le bouton actif. */
  forClientId?: string | null;
  /** Nom affiché pour les autres joueurs en attente du jet. */
  forPlayerName?: string | null;
  /** Notation optionnelle (ex. "1d20") pour jets génériques. */
  roll?: string;
  /** Avantage / désavantage explicite (sinon déduit du contexte / conditions). */
  rollMode?: "normal" | "advantage" | "disadvantage" | "cancelled";
  /** Libellé court pour le résumé de chat (ex. « empoisonné »). */
  advDisReason?: string;
  /**
   * Jet de compétence demandé par l'arbitre de scène : `single` = un seul PJ (défaut),
   * `global` = tous les PJ connectés doivent lancer avant une seule relance arbitre,
   * `selected` = sous-ensemble explicite (`rollTargetEntityIds`, ids d'entités PJ type `mp-player-…`).
   */
  audience?: "single" | "global" | "selected";
  /** Avec `audience: "selected"` : ids d'entité (bloc Entités) qui doivent chacun lancer le même test. */
  rollTargetEntityIds?: string[];
  /** En MP : résultats partiels d'un jet de groupe (clé = clientId Firestore du joueur). */
  globalRollsByClientId?: Record<
    string,
    { nat: number; total: number; success: boolean | null; playerName?: string | null }
  >;
  /** DD pour jets de compétence / sauvegarde (arbitre, pièges, etc.). */
  dc?: number | null;
  /** Après résolution, relance unique `/api/gm-arbiter` avec le résultat structuré. */
  returnToArbiter?: boolean;
  /** Contexte sérialisé pour la relance arbitre (jet lieu / piège). */
  sceneArbiterContext?: Record<string, unknown> | null;
}

export interface DeathState {
  successes: number;
  failures: number;
  stable: boolean;
  unconscious: boolean;
  dead: boolean;
  autoRecoverAtMinute?: number | null;
}

/**
 * Multijoueur : un snapshot Firestore peut arriver avec `pendingRoll: null` avant que le flush
 * (débounce hôte ~1,25s) n’ait poussé le jet de mort — sans ce garde-fou, le bandeau disparaît.
 */
function shouldRetainLocalDeathSavePendingRoll(
  inMultiplayerSession: boolean,
  remotePr: PendingRoll | null | undefined,
  localPr: PendingRoll | null | undefined,
  playerSnapshot: Player | null | undefined,
  clientIdStr: string | null | undefined
): boolean {
  if (!inMultiplayerSession) return false;
  if (remotePr != null) return false;
  if (!localPr || localPr.kind !== "death_save") return false;
  const hp = playerSnapshot?.hp?.current;
  if (typeof hp !== "number" || hp > 0) return false;
  const ds = playerSnapshot?.deathState;
  if (ds?.dead === true || ds?.stable === true) return false;
  const pid = playerSnapshot?.id != null ? String(playerSnapshot.id).trim() : "";
  const cid = clientIdStr != null ? String(clientIdStr).trim() : "";
  if (localPr.forPlayerId && pid && String(localPr.forPlayerId).trim() === pid) return true;
  if (localPr.forClientId && cid && String(localPr.forClientId).trim() === cid) return true;
  if (!localPr.forPlayerId && !localPr.forClientId) return true;
  return false;
}

/**
 * Multijoueur : comme pour death_save, un snapshot Firestore peut temporairement porter
 * pendingRoll=null pendant qu'un jet de dé de vie local est en cours d'affichage.
 * On conserve localement le pendingRoll hit_die ciblé sur ce client pour éviter
 * la disparition/flicker du bandeau "Lancer le dé".
 */
function shouldRetainLocalHitDiePendingRoll(
  inMultiplayerSession: boolean,
  remotePr: PendingRoll | null | undefined,
  localPr: PendingRoll | null | undefined,
  playerSnapshot: Player | null | undefined,
  clientIdStr: string | null | undefined,
  gameModeSnapshot: GameMode | null | undefined
): boolean {
  if (!inMultiplayerSession) return false;
  if (remotePr != null) return false;
  if (!localPr || localPr.kind !== "hit_die") return false;
  if (gameModeSnapshot !== "short_rest") return false;
  const pid = playerSnapshot?.id != null ? String(playerSnapshot.id).trim() : "";
  const cid = clientIdStr != null ? String(clientIdStr).trim() : "";
  if (localPr.forPlayerId && pid && String(localPr.forPlayerId).trim() === pid) return true;
  if (localPr.forClientId && cid && String(localPr.forClientId).trim() === cid) return true;
  if (!localPr.forPlayerId && !localPr.forClientId) return true;
  return false;
}

function shouldRetainLocalDirectedPendingRoll(
  inMultiplayerSession: boolean,
  remotePr: PendingRoll | null | undefined,
  localPr: PendingRoll | null | undefined,
  playerSnapshot: Player | null | undefined,
  clientIdStr: string | null | undefined
): boolean {
  if (!inMultiplayerSession) return false;
  if (remotePr != null) return false;
  if (!localPr) return false;
  if (localPr.kind === "death_save" || localPr.kind === "hit_die") return false;
  const pid = playerSnapshot?.id != null ? String(playerSnapshot.id).trim() : "";
  const cid = clientIdStr != null ? String(clientIdStr).trim() : "";
  if (localPr.forPlayerId && pid && String(localPr.forPlayerId).trim() === pid) return true;
  if (localPr.forClientId && cid && String(localPr.forClientId).trim() === cid) return true;
  return false;
}

function globalSkillPendingRollSignature(pr: PendingRoll | null | undefined): string {
  if (!pr || typeof pr !== "object") return "";
  const ctx = pr.sceneArbiterContext as Record<string, unknown> | null | undefined;
  const rid = ctx?.roomId != null ? String(ctx.roomId).trim() : "";
  const dc = typeof pr.dc === "number" && Number.isFinite(pr.dc) ? String(Math.trunc(pr.dc)) : "";
  const aud = String(pr.audience ?? "").trim();
  const tgt =
    aud === "selected" && Array.isArray(pr.rollTargetEntityIds)
      ? [...new Set(pr.rollTargetEntityIds.map((x) => String(x ?? "").trim()).filter(Boolean))].sort().join(",")
      : "";
  return `${rid}|${String(pr.stat ?? "").trim()}|${String(pr.skill ?? "").trim()}|${dc}|${aud}|${tgt}`;
}

function mergeGlobalSkillCheckPendingRolls(
  remotePr: PendingRoll,
  localPr: PendingRoll | null | undefined
): PendingRoll {
  const rMap =
    remotePr.globalRollsByClientId && typeof remotePr.globalRollsByClientId === "object"
      ? { ...remotePr.globalRollsByClientId }
      : {};
  const lMap =
    localPr?.globalRollsByClientId && typeof localPr.globalRollsByClientId === "object"
      ? localPr.globalRollsByClientId
      : {};
  return {
    ...remotePr,
    globalRollsByClientId: { ...rMap, ...lMap },
  };
}

// ---------------------------------------------------------------------------
// Types messages
// ---------------------------------------------------------------------------

export interface Message {
  id: string;
  role: "user" | "ai";
  /**
   * "dice"        → résultat de lancer de dé joueur (bulle dorée)
   * "meta"        → message joueur hors-RP (bulle teal)
   * "meta-reply"  → réponse IA hors-RP (bulle indigo)
   * "enemy-turn"  → attaque ennemie simulée côté client (bulle rouge)
   * "combat-detail" → détail mécanique d'une attaque (bulle orange, PJ cible — solo = joueur local)
   * "turn-end"    → fin de tour (moteur, bulle orange)
   * "turn-divider" → ligne de séparation visuelle entre tours
   * "debug"       → logs du moteur (masqués hors debug)
   * "intent-error" → erreur d'intention / action refusée (UI locale uniquement en MP)
   * "scene-image" → image générée (affichée dans le chat + miniature)
   * "scene-image-pending" → créneau réservé pendant l'appel au générateur (ordre chronologique)
   */
  type?:
    | "dice"
    | "meta"
    /** Réplique / action joueur en scène (combat) — bulle verte centrée (multijoueur). */
    | "player-utterance"
    | "meta-reply"
    | "enemy-turn"
    | "combat-detail"
    | "turn-end"
    | "turn-divider"
    | "debug"
    | "intent-error"
    | "scene-image"
    | "scene-image-pending"
    | "continue"
    | "retry-action"
    | "campaign-context";
  content: string;
  /** Nom affiché au-dessus des messages joueur en multijoueur. */
  senderName?: string;
  /** Titre de l’encadré d’ouverture (type campaign-context). */
  contextBox?: { title: string };
}

// ---------------------------------------------------------------------------
// Types entités de scène
// ---------------------------------------------------------------------------

/**
 * Tag de comportement pour le moteur.
 * "hostile"  = participe au combat et attaque le joueur.
 * "npc"      = neutre/réactif (peut devenir hostile ou allié).
 * "friendly" = allié.
 * "object"   = inanimé.
 */
export type EntityType = "hostile" | "npc" | "friendly" | "object";
export type CombatantController = "player" | "ai";

/** Caractéristiques D&D 5e d'une entité */
export interface EntityStats {
  FOR: number;
  DEX: number;
  CON: number;
  INT: number;
  SAG: number;
  CHA: number;
}

export type EnemyWeapon = CombatWeapon;

export interface Entity {
  id: string;
  templateId?: string;
  name: string;
  /** hostile=attaque le joueur, npc=neutre/réactif, friendly=allié, object=inanimé */
  type: EntityType;
  /** Qui décide de ses actions quand c'est son tour. */
  controller: CombatantController;
  race: string;
  entityClass: string;
  cr: number;
  /** Visible par le joueur → affiché dans la colonne droite et décrit par l'IA */
  visible: boolean;
  isAlive: boolean;
  hp: { current: number; max: number } | null;
  ac: number | null;
  stats: EntityStats | null;
  /** Bonus d'attaque total (mod caractéristique + maîtrise) */
  attackBonus: number | null;
  damageDice: string | null;
  damageBonus: number | null;
  weapons?: CombatWeapon[] | null;
  features?: string[] | null;
  selectedSpells?: string[] | null;
  spellSlots?: SpellSlotsMap | null;
  spellAttackBonus?: number | null;
  spellSaveDc?: number | null;
  description: string;
  /** DD pour être repéré par un jet (Perception/Investigation). Si absent → pas de mécanique spéciale. */
  stealthDc?: number | null;
  /** Butin portable présent sur le corps / l'entité (simple liste texte). */
  lootItems?: string[] | null;
  /** Indique que le corps/entité a déjà été pillé. */
  looted?: boolean;
  /** Surpris au début du combat : perd son prochain tour, puis repasse à false. */
  surprised?: boolean;
  /** True si la créature a repéré le joueur et participe activement au combat. */
  awareOfPlayer?: boolean;
  /** États D&D (prone, blinded, poisoned, invisible, …) — avantage/désavantage au combat. */
  conditions?: string[];
  /** États temporels de combat (ex. bouclier magique). */
  combatTimedStates?: CombatTimedStateEntry[];
}

/** Mise à jour partielle d'une entité envoyée par l'IA */
export interface EntityUpdate {
  id?: string;
  action: "spawn" | "update" | "kill" | "remove";
  templateId?: string;
  name?: string;
  type?: EntityType;
  controller?: CombatantController;
  race?: string;
  entityClass?: string;
  cr?: number;
  visible?: boolean;
  hp?: { current: number; max: number } | null;
  ac?: number | null;
  stats?: EntityStats | null;
  attackBonus?: number | null;
  damageDice?: string | null;
  damageBonus?: number | null;
  weapons?: CombatWeapon[] | null;
  features?: string[] | null;
  selectedSpells?: string[] | null;
  spellSlots?: SpellSlotsMap | null;
  spellAttackBonus?: number | null;
  spellSaveDc?: number | null;
  description?: string;
  stealthDc?: number | null;
  lootItems?: string[] | null;
  inventory?: string[] | null;
  looted?: boolean;
  surprised?: boolean;
  awareOfPlayer?: boolean;
  /** Remplace la liste d'états D&D (prone, blinded, …). */
  conditions?: string[];
  /** Remplace les états de combat à durée (bouclier, …). */
  combatTimedStates?: CombatTimedStateEntry[] | null;
  /** Modificateur additif d'AC (ex: -2 si pas de bouclier). */
  acDelta?: number;
  /** Modificateurs additifs de caractéristiques (FOR/DEX/CON/INT/SAG/CHA). */
  statDeltas?: Partial<EntityStats>;
  /** Dés de vie (PJ / godmode) — valeurs absolues. */
  hitDiceRemaining?: number | null;
  hitDiceTotal?: number | null;
}

function normalizeEntityType(t: any): EntityType | undefined {
  if (t === "monster") return "hostile"; // compat ancien prompt/états
  if (t === "neutral") return "npc"; // MJ / arbitre (ex. PNJ non hostile)
  if (t === "hostile" || t === "npc" || t === "friendly" || t === "object") return t;
  return undefined;
}

function normalizeEntityController(controller: unknown): CombatantController {
  return controller === "player" ? "player" : "ai";
}

function characterIdentityKeyFromPlayer(p: Player | null | undefined): string {
  if (!p || typeof p !== "object") return "";
  const name = normalizeEntityNameKey(p.name);
  const race = normalizeEntityNameKey((p as any).race);
  const entityClass = normalizeEntityNameKey((p as any).entityClass);
  if (!name && !race && !entityClass) return "";
  return `${name}|${race}|${entityClass}`;
}

function characterIdentityKeyFromProfileRaw(raw: any): string {
  if (!raw || typeof raw !== "object") return "";
  const name = normalizeEntityNameKey(raw.name);
  const race = normalizeEntityNameKey(raw.race);
  const entityClass = normalizeEntityNameKey(raw.entityClass);
  if (!name && !race && !entityClass) return "";
  return `${name}|${race}|${entityClass}`;
}

function normalizeEntityNameKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

/** Regroupe npc + friendly sous la même clé : même nom = un seul PNJ / allié non-joueur (évite Gandelme ×2). */
function entityCoalesceBucket(type: EntityType | undefined): string {
  const t = normalizeEntityType(type) ?? "npc";
  if (t === "hostile") return "hostile";
  if (t === "object") return "object";
  if (t === "npc" || t === "friendly") return "social";
  return t;
}

function reconcileNpcFriendlyTypes(a: EntityType | undefined, b: EntityType | undefined): EntityType {
  const aa = normalizeEntityType(a) ?? "npc";
  const bb = normalizeEntityType(b) ?? "npc";
  if (aa === bb) return aa;
  if (
    (aa === "npc" && bb === "friendly") ||
    (aa === "friendly" && bb === "npc")
  ) {
    return "npc";
  }
  return aa;
}

function coalesceLogicalEntityDuplicates(entities: Entity[]): Entity[] {
  const result: Entity[] = [];
  const indexByLogicalKey = new Map<string, number>();
  for (const entity of Array.isArray(entities) ? entities : []) {
    if (!entity) continue;
    const nameKey = normalizeEntityNameKey(entity.name);
    const bucket = entityCoalesceBucket(entity.type);
    const logicalKey = nameKey ? `${bucket}::${nameKey}` : "";
    if (!logicalKey) {
      result.push(entity);
      continue;
    }
    const existingIdx = indexByLogicalKey.get(logicalKey);
    if (existingIdx == null) {
      indexByLogicalKey.set(logicalKey, result.length);
      result.push(entity);
      continue;
    }
    const existing = result[existingIdx];
    const mergedHp = (() => {
      if (!existing.hp && !entity.hp) return existing.hp;
      if (!existing.hp) return entity.hp;
      if (!entity.hp) return existing.hp;
      const a = existing.hp.current;
      const b = entity.hp.current;
      if (typeof a === "number" && typeof b === "number") {
        const max = Math.max(existing.hp.max ?? 0, entity.hp.max ?? 0, 1);
        const cur = Math.min(a, b);
        return { current: cur, max: Math.max(max, cur) };
      }
      return existing.hp.current > 0 ? existing.hp : entity.hp;
    })();
    result[existingIdx] = {
      ...existing,
      ...entity,
      id: existing.id,
      name: existing.name || entity.name,
      type: reconcileNpcFriendlyTypes(existing.type, entity.type),
      controller: existing.controller ?? entity.controller,
      visible: existing.visible || entity.visible,
      isAlive: existing.isAlive || entity.isAlive,
      hp: mergedHp,
      awareOfPlayer:
        typeof existing.awareOfPlayer === "boolean"
          ? existing.awareOfPlayer || entity.awareOfPlayer === true
          : entity.awareOfPlayer,
      surprised:
        typeof existing.surprised === "boolean"
          ? existing.surprised && entity.surprised !== false
          : entity.surprised,
      lootItems:
        Array.isArray(existing.lootItems) && existing.lootItems.length > 0
          ? existing.lootItems
          : entity.lootItems ?? existing.lootItems,
    };
  }
  return result;
}

function inferTemplateIdFromEntityId(entityId: string): string | null {
  const id = String(entityId ?? "").trim().toLowerCase();
  if (!id) return null;
  const withoutSuffix = id.replace(/_\d+$/g, "");
  return withoutSuffix || null;
}

function inferTemplateIdFromEntityLike(entityLike: any): string | null {
  const explicitTemplateId =
    typeof entityLike?.templateId === "string" && entityLike.templateId.trim()
      ? entityLike.templateId.trim()
      : null;
  if (explicitTemplateId && (BESTIARY as any)?.[explicitTemplateId]) {
    return explicitTemplateId;
  }

  const byId = inferTemplateIdFromEntityId(String(entityLike?.id ?? "").trim());
  if (byId && (BESTIARY as any)?.[byId]) {
    return byId;
  }

  const normalizedName = String(entityLike?.name ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ");
  const nameTokens = normalizedName
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
  for (const token of nameTokens) {
    if ((BESTIARY as any)?.[token]) {
      return token;
    }
  }

  return null;
}

function getEncounterTemplateIdForRoom(roomId: string, entityId: string): string | null {
  const room = roomId && (GOBLIN_CAVE as any)?.[roomId] ? (GOBLIN_CAVE as any)[roomId] : null;
  const entries = Array.isArray(room?.encounterEntities) ? room.encounterEntities : [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      if (entry === entityId) return inferTemplateIdFromEntityId(entry);
      continue;
    }
    if (entry && typeof entry === "object" && entry.id === entityId) {
      if (typeof entry.templateId === "string" && entry.templateId.trim()) return entry.templateId.trim();
      return inferTemplateIdFromEntityId(entityId);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Types combat
// ---------------------------------------------------------------------------

export type GameMode = "exploration" | "combat" | "short_rest";

export interface CombatEntry {
  id: string;
  name: string;
  initiative: number;
}

// ---------------------------------------------------------------------------
// Provider type
// ---------------------------------------------------------------------------

export type AiProvider = "gemini" | "openrouter";
/** gemini-3.1-flash-image-preview : génération d'image via GEMINI_API_KEY (route /api/scene-image). */
export type ImageModelId = "gemini-3.1-flash-image-preview" | "disabled";

export interface SessionParticipantProfile {
  clientId: string;
  name: string;
  entityClass?: string;
  race?: string;
  /** Identité stable du personnage choisi (sert à empêcher les doublons en multijoueur). */
  characterKey?: string;
  level?: number | null;
  hpCurrent?: number | null;
  hpMax?: number | null;
  ac?: number | null;
  /** Snapshot complet de fiche joueur (source gameplay pour le moteur côté clients distants). */
  playerSnapshot?: Player | null;
  connected: boolean;
  updatedAtMs?: number | null;
}

export interface MultiplayerPendingCommand {
  id: string;
  userContent: string;
  msgType?: string | null;
  isDebug?: boolean;
  senderName: string;
  playerSnapshot: Player | null;
  /** Snapshot de contexte de l'émetteur, utilisé par le client qui prend le lease. */
  gameModeSnapshot?: GameMode | null;
  currentRoomIdSnapshot?: string | null;
  currentSceneSnapshot?: string | null;
  currentSceneNameSnapshot?: string | null;
  entitiesSnapshot?: Entity[] | null;
  /** Ressources de tour au moment de l'envoi (soumetteur) — évite que l'hôte résolve avec un état périmé. */
  turnResourcesSnapshot?: TurnResources | null;
  /** Identifiant client (onglet), aligné sur `GameContext.clientId` — sert à cibler le jet (forClientId). */
  submittedBy: string;
  submittedAtMs: number;
}

export interface MultiplayerThinkingState {
  active: boolean;
  actor: "gm" | "auto-player" | null;
  label?: string | null;
  /** Client (onglet) qui détient la réservation Firestore pour l’appel /api/auto-joueur en cours. */
  byClientId?: string | null;
  /** Horodatage local ms de la réservation auto-joueur (expiration « stale » côté serveur). */
  autoPlayerIntentAtMs?: number | null;
}

interface GameContextValue {
  // Joueur
  player: Player | null;
  setPlayer: React.Dispatch<SetStateAction<Player | null>>;
  updatePlayer: (patch: Partial<Player>) => void;
  setHp: (value: number) => void;
  worldTimeMinutes: number;
  setWorldTimeMinutes: React.Dispatch<SetStateAction<number>>;
  // Démarrage
  isGameStarted: boolean;
  startGame: () => void;
  /** false jusqu'à la restauration localStorage (évite qu'un effet client réinitialise action/mouvement avant la sauvegarde). */
  persistenceReady: boolean;
  // Messages
  messages: Message[];
  addMessage: (
    role: "user" | "ai",
    content: string,
    type?:
      | "dice"
      | "meta"
      | "meta-reply"
      | "enemy-turn"
      | "combat-detail"
      | "debug"
      | "scene-image"
      | "scene-image-pending"
      | "continue"
      | "retry-action"
      | "campaign-context",
    id?: string,
    contextBox?: { title: string },
    senderName?: string
  ) => void;
  /** Retire les messages « illustration en cours » puis ajoute le créneau + log debug optionnel à la fin du fil actuel (moment de la requête). */
  appendSceneImagePendingSlot: (
    pendingId: string,
    pendingLabel: string,
    debugContent: string | null
  ) => void;
  /** Met à jour un message existant (ex. pending → URL image). */
  updateMessage: (messageId: string, patch: Partial<Message>) => void;
  /** Supprime des messages par id (ex. annulation / requête obsolète). */
  removeMessagesByIds: (ids: string[]) => void;
  debugMode: boolean;
  setDebugMode: (v: boolean) => void;
  // Dés
  pendingRoll: PendingRoll | null;
  setPendingRoll: (roll: PendingRoll | null) => void;
  debugNextRoll: number | null;
  setDebugNextRoll: (v: number | null) => void;
  // Scène
  currentSceneName: string;
  setCurrentSceneName: (name: string) => void;
  currentScene: string;
  setCurrentScene: (scene: string) => void;
  /** Compteur logique de scène (incrémenté à chaque sceneUpdate/changement de salle) */
  sceneVersion: number;
  setSceneVersion: (v: number) => void;
  currentRoomId: string;
  setCurrentRoomId: (id: string) => void;
  // Entités
  entities: Entity[];
  applyEntityUpdates: (updates: EntityUpdate[]) => void;
  replaceEntities: (entities: Entity[]) => void;
  clearEntities: () => void;
  /** Mémorise les créatures présentes dans une salle quand le PJ la quitte (cadavres inclus). */
  rememberRoomEntitiesSnapshot: (roomId: string, roomEntities: Entity[]) => void;
  /** Restaure l'état mémorisé d'une salle (tableau vide si jamais visitée). scene_journey reste toujours vide. */
  takeEntitiesForRoom: (roomId: string) => Entity[];
  /** Nouvelle partie / reset : efface les snapshots de toutes les salles. */
  clearRoomEntitySnapshots: () => void;
  /**
   * Entités lues sur `entitiesRef` (à jour dès fusion Firestore, avant le prochain rendu React).
   * À utiliser pour jets combat / dégâts en MP afin d’éviter une cible aux PV périmés.
   */
  getEntitiesSnapshot: () => Entity[];
  /** Résumé mécanique des événements déjà résolus dans une salle (pièges, embuscades, etc.). */
  getRoomMemory: (roomId: string) => string;
  /** Met à jour la mémoire de salle seulement si cela change réellement un fait mémorisé. */
  appendRoomMemory: (roomId: string, line: string) => boolean;
  /** Remplace ou efface la mémoire d'une salle ciblée. */
  setRoomMemoryText: (roomId: string, text: string) => void;
  clearRoomMemory: () => void;
  // Mode de jeu
  gameMode: GameMode;
  /** Pour exploration : passe entitiesSnapshot (ex. post-màj) si le ref n’est pas encore à jour. */
  setGameMode: (
    mode: GameMode,
    entitiesSnapshotForExplorationCheck?: Entity[],
    options?: { force?: boolean }
  ) => void;
  // Combat
  combatOrder: CombatEntry[];
  setCombatOrder: Dispatch<SetStateAction<CombatEntry[]>>;
  combatTurnIndex: number;
  /** Révision monotone : augmente à chaque commit d'index (y compris même index, ex. retour au même slot). Pour effets UI (jets contre la mort, etc.). */
  combatTurnWriteSeq: number;
  /** opts.forceWriteSeq : appliquer l’index depuis un snapshot distant avec ce numéro de révision (anti-flicker). */
  setCombatTurnIndex: (idx: number, opts?: { forceWriteSeq?: number; bumpSeq?: boolean }) => void;
  /** Combat démarré sans combatOrder : jets PNJ pré-calculés, attente du jet joueur */
  awaitingPlayerInitiative: boolean;
  /** Synchronisé avec Firestore : même timing pour tous les clients (narration avant bandeau initiative). */
  waitForGmNarrationForInitiative: boolean;
  setWaitForGmNarrationForInitiative: (v: boolean) => void;
  /** Brouillon d'initiative (ennemis) avant clic « Lancer l'initiative » */
  npcInitiativeDraft: CombatEntry[];
  /** Retourne l'ordre d'initiative fusionné (pour enchaîner les tours PNJ côté UI), ou null si rien n'a été commité. */
  commitPlayerInitiativeRoll: (options?: { manualNat?: number | null }) => CombatEntry[] | null;
  /** Enregistré par ChatInterface : enchaînement des tours (ex. après « Fin de tour ») */
  registerCombatNextTurn: (fn: (() => Promise<void>) | null) => void;
  nextTurn: () => Promise<void>;
  // Théâtre de l'esprit (moteur)
  engagedWithId: string | null; // id de la créature au corps à corps avec le joueur (rétrocompat)
  setEngagedWithId: (id: string | null) => void;
  hasDisengagedThisTurn: boolean;
  setHasDisengagedThisTurn: (v: boolean) => void;
  turnResourcesByCombatantId: TurnResourcesMap;
  setTurnResourcesForCombatant: (
    combatantId: string,
    next: SetStateAction<TurnResources>
  ) => void;
  /** Corps à corps : chaque créature → liste d'ids en contact (actif en combat uniquement) */
  meleeState: Record<string, string[]>;
  setMeleeState: (s: Record<string, string[]> | ((prev: Record<string, string[]>) => Record<string, string[]>)) => void;
  /** Réactions : chaque combattant a hasReaction (réinitialisé au début de son tour) */
  reactionState: Record<string, boolean>;
  setReactionState: (s: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)) => void;
  /** Ajouter un contact mutuel entre a et b */
  addMeleeMutual: (a: string, b: string) => void;
  /** Retirer b de la liste de a (et a de celle de b) */
  removeFromMelee: (a: string, b: string) => void;
  /** Se désengager : retirer cette créature du corps à corps avec tous les autres */
  clearMeleeFor: (id: string) => void;
  /** Obtenir la liste des créatures au contact (filtrer les morts côté appelant) */
  getMeleeWith: (id: string) => string[];
  /** Mettre hasReaction pour une entité */
  setReactionFor: (id: string, value: boolean) => void;
  /** hasReaction pour une entité */
  hasReaction: (id: string) => boolean;
  /** Initialiser réactions au début du combat ; pruner les morts des meleeState */
  initCombatReactions: (combatOrder: { id: string }[]) => void;
  /** Retirer une entité morte de toutes les listes melee */
  pruneDeadFromMelee: (deadId: string) => void;
  /** Combattants actuellement cachés (moteur : avantage à l’attaque, désavantage pour être ciblé). */
  combatHiddenIds: string[];
  setCombatHiddenIds: Dispatch<SetStateAction<string[]>>;
  /** Total du jet de Discrétion (DD à battre en Perception active) par id de combattant caché. */
  combatStealthTotalByCombatantId: Record<string, number>;
  setCombatStealthTotalForCombatant: (combatantId: string, total: number | null) => void;
  /** Réinitialise tous les totaux de Discrétion (fin de combat, patch MJ, etc.). */
  clearCombatStealthTotals: () => void;
  // Fournisseur IA
  aiProvider: AiProvider;
  setAiProvider: (p: AiProvider) => void;
  // Mode auto-joueur (IA qui joue à la place du joueur)
  autoPlayerEnabled: boolean;
  setAutoPlayerEnabled: (v: boolean) => void;
  // Session multijoueur (Firestore)
  multiplayerSessionId: string | null;
  multiplayerConnected: boolean;
  multiplayerParticipants: number;
  multiplayerParticipantProfiles: SessionParticipantProfile[];
  /** Met à jour les PV d'un autre joueur (profil Firestore `participantProfiles`). */
  patchParticipantProfileHp: (participantClientId: string, hpCurrent: number) => Promise<void>;
  /** Met à jour l'inventaire d'un participant (snapshot joueur partagé), ex. loot résolu par un autre client. */
  patchParticipantProfileInventory: (participantClientId: string, inventory: string[]) => Promise<void>;
  /** Remplace le snapshot joueur d'un participant (utile pour repos long global, resync complète). */
  patchParticipantProfilePlayerSnapshot: (participantClientId: string, snapshot: Player) => Promise<void>;
  /** Met à jour l'état de mort d'un participant (snapshot joueur partagé). */
  patchParticipantProfileDeathState: (
    participantClientId: string,
    deathStatePatch: Partial<DeathState>,
    options?: { hpCurrent?: number | null }
  ) => Promise<void>;
  multiplayerHostClientId: string | null;
  /** @deprecated Plus de privilège hôte ; conservé pour compat. Toujours false. */
  multiplayerIsHost: boolean;
  multiplayerPendingCommand: MultiplayerPendingCommand | null;
  multiplayerThinkingState: MultiplayerThinkingState;
  createMultiplayerSession: () => Promise<string | null>;
  joinMultiplayerSession: (sessionId: string) => Promise<JoinMultiplayerSessionResult>;
  leaveMultiplayerSession: () => Promise<void>;
  /** Force une écriture immédiate de `payload.gameMode` en session partagée (anti-races). */
  setMultiplayerGameModeImmediate: (mode: GameMode) => Promise<void>;
  flushMultiplayerSharedState: () => Promise<void>;
  submitMultiplayerCommand: (command: MultiplayerPendingCommand) => Promise<boolean>;
  clearMultiplayerPendingCommand: (commandId: string) => Promise<void>;
  tryAcquireMultiplayerCommandLease: (commandId: string) => Promise<"acquired" | "busy" | "gone">;
  releaseMultiplayerCommandLease: (commandId: string) => Promise<void>;
  setMultiplayerThinkingState: (thinking: MultiplayerThinkingState) => Promise<void>;
  /** Verrou transactionnel : un seul client peut être en train d’appeler /api/auto-player pour la session. */
  acquireMultiplayerAutoPlayerIntentLock: () => Promise<boolean>;
  releaseMultiplayerAutoPlayerIntentLock: () => Promise<void>;
  acquireMultiplayerProcessingLock: (label?: string) => Promise<string | null>;
  releaseMultiplayerProcessingLock: (lockId: string | null) => Promise<void>;
  /** Debug : libère tous les mutex locaux, force l’ouverture du verrou `processing` Firestore et coupe l’état « MJ réfléchit ». */
  debugForceUnblockProcessingPipeline: () => Promise<void>;
  /** Identifiant stable de ce client (sessions multijoueur, ciblage de jets). */
  clientId: string;
  /** Efface la sauvegarde locale et renvoie au menu campagne (même personnage). */
  startNewGame: () => void;
  /** Efface la sauvegarde, restaure les PV au max et relance la campagne (game over / recommencer). */
  restartAdventure: () => void;
  // Image de scène
  currentSceneImage: string;
  setCurrentSceneImage: (url: string) => void;
  imageModel: ImageModelId;
  setImageModel: (m: ImageModelId) => void;
  autoRollEnabled: boolean;
  setAutoRollEnabled: (v: boolean) => void;
}

// ---------------------------------------------------------------------------
// Valeurs par défaut (avant perso / avant chargement sauvegarde) — alignées sur la campagne `GOBLIN_CAVE`.
// ---------------------------------------------------------------------------

const sceneVillageIntro = (GOBLIN_CAVE as { scene_village?: { title?: string; description?: string } }).scene_village;
const DEFAULT_SCENE_NAME =
  typeof sceneVillageIntro?.title === "string" && sceneVillageIntro.title.trim()
    ? sceneVillageIntro.title
    : String(CAMPAIGN_CONTEXT.title ?? "Campagne");
const DEFAULT_SCENE_DESCRIPTION =
  typeof sceneVillageIntro?.description === "string" ? sceneVillageIntro.description : "";

function normalizeDeathState(raw: any, hpCurrent: number): DeathState {
  const source = raw && typeof raw === "object" ? raw : {};
  const dead = source.dead === true;
  const stable = !dead && source.stable === true;
  const unconscious = dead ? false : source.unconscious === true || hpCurrent <= 0;
  return {
    successes:
      typeof source.successes === "number" && Number.isFinite(source.successes)
        ? Math.max(0, Math.min(3, Math.trunc(source.successes)))
        : 0,
    failures:
      typeof source.failures === "number" && Number.isFinite(source.failures)
        ? Math.max(0, Math.min(3, Math.trunc(source.failures)))
        : 0,
    stable,
    unconscious,
    dead,
    autoRecoverAtMinute:
      typeof source.autoRecoverAtMinute === "number" && Number.isFinite(source.autoRecoverAtMinute)
        ? Math.max(0, Math.trunc(source.autoRecoverAtMinute))
        : null,
  };
}

function normalizePlayerShape(value: any): Player | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, any>;
  const {
    nom: _legacyName,
    classe: _legacyClass,
    armorClass: _legacyArmorClass,
    inventaire: _legacyInventory,
    ac: _legacyAcIgnored,
    equipment: _rawEquipment,
    feats: rawFeats,
    ...rest
  } = raw;
  const incomingHp = raw.hp;
  let hp = { current: 1, max: 1 };
  if (incomingHp && typeof incomingHp === "object") {
    const current = Number(incomingHp.current);
    const max = Number(incomingHp.max);
    const safeCurrent = Number.isFinite(current) ? Math.max(0, Math.trunc(current)) : 1;
    const safeMax = Number.isFinite(max) ? Math.max(1, Math.trunc(max)) : Math.max(1, safeCurrent);
    hp = { current: safeCurrent, max: Math.max(safeMax, safeCurrent) };
  }
  const inventorySource = Array.isArray(raw.inventory)
    ? raw.inventory
    : Array.isArray(raw.inventaire)
      ? raw.inventaire
      : [];
  const statsNorm = raw.stats ?? { FOR: 10, DEX: 10, CON: 10, INT: 10, SAG: 10, CHA: 10 };
  const level =
    typeof raw.level === "number" && Number.isFinite(raw.level)
      ? Math.max(1, Math.trunc(raw.level))
      : 1;
  const hitDiceTotal =
    typeof raw.hitDiceTotal === "number" && Number.isFinite(raw.hitDiceTotal)
      ? Math.max(1, Math.trunc(raw.hitDiceTotal))
      : level;
  const hitDiceRemaining =
    typeof raw.hitDiceRemaining === "number" && Number.isFinite(raw.hitDiceRemaining)
      ? Math.max(0, Math.min(hitDiceTotal, Math.trunc(raw.hitDiceRemaining)))
      : hitDiceTotal;
  const deathState = normalizeDeathState(raw.deathState, hp.current);
  const normalizedWeapons = Array.isArray(raw.weapons)
    ? raw.weapons
        .map((w: any) => {
          if (!w) return null;
          if (typeof w === "string") {
            const name = String(w).trim();
            if (!name) return null;
            return { weaponId: getWeaponIdByName(name) ?? undefined, name };
          }
          if (typeof w === "object") {
            const name = String(w?.name ?? "").trim();
            const weaponIdRaw =
              typeof w?.weaponId === "string" && w.weaponId.trim() ? w.weaponId.trim() : null;
            const weaponId = weaponIdRaw ?? (name ? getWeaponIdByName(name) : null) ?? undefined;
            return {
              ...w,
              ...(weaponId ? { weaponId } : {}),
            };
          }
          return null;
        })
        .filter(Boolean)
    : [];
  const equipmentResolved = (() => {
    const n = normalizeEquipmentState(_rawEquipment);
    const hasSlot =
      !!n.armor ||
      !!n.mainHand ||
      !!n.offHand ||
      !!n.bottes ||
      !!n.cape ||
      !!n.tete ||
      !!n.gants ||
      (n.attunedItems?.length ?? 0) > 0;
    if (hasSlot) return n;
    return inferEquipmentFromLegacy({
      inventory: inventorySource,
      weapons: normalizedWeapons,
      stats: statsNorm,
      entityClass: String(raw.entityClass ?? raw.classe ?? ""),
      features: Array.isArray(raw.features) ? raw.features : undefined,
      feats: Array.isArray(raw.feats) ? raw.feats : undefined,
    });
  })();
  const acComputed = computePlayerArmorClass({
    stats: statsNorm,
    entityClass: String(raw.entityClass ?? raw.classe ?? "Aventurier"),
    equipment: equipmentResolved,
    fighter: raw.fighter,
  });
  return {
    ...rest,
    type: "player",
    controller: "player",
    name: String(raw.name ?? raw.nom ?? "Joueur").trim() || "Joueur",
    entityClass:
      String(raw.entityClass ?? raw.classe ?? "Aventurier").trim() || "Aventurier",
    description:
      raw.description == null ? undefined : String(raw.description),
    visible: raw.visible !== false,
    isAlive: deathState.dead !== true,
    hp,
    ac: acComputed,
    equipment: equipmentResolved,
    feats: Array.isArray(rawFeats)
      ? rawFeats.map((x: any) => String(x ?? "").trim()).filter(Boolean)
      : undefined,
    inventory: stackInventory(inventorySource.map((x: any) => String(x ?? "").trim()).filter(Boolean)),
    weapons: normalizedWeapons,
    level,
    hitDie:
      typeof raw.hitDie === "string" && raw.hitDie.trim()
        ? raw.hitDie.trim()
        : undefined,
    hitDiceTotal,
    hitDiceRemaining,
    deathState,
    lastLongRestFinishedAtMinute:
      typeof raw.lastLongRestFinishedAtMinute === "number" &&
      Number.isFinite(raw.lastLongRestFinishedAtMinute)
        ? Math.max(0, Math.trunc(raw.lastLongRestFinishedAtMinute))
        : null,
    stats: statsNorm,
    skillProficiencies: Array.isArray(raw.skillProficiencies) ? raw.skillProficiencies : [],
    conditions: Array.isArray(raw.conditions)
      ? raw.conditions.map((x: any) => String(x ?? "").trim()).filter(Boolean)
      : undefined,
  } as Player;
}

/** Aligné sur l’init `clientId` du GameProvider — lecture du PJ sauvegardé pour `?session=` au F5. */
const SESSION_STORAGE_CLIENT_ID_KEY = "dnd-ai-master-client-id-v1-tab";
/** Snapshot PJ par session MP + onglet (évite re-sélection / PV max après reload avec `?session=`). */
const MP_SESSION_PLAYER_STORAGE_PREFIX = "dnd-mp-player-v1";

function readMpPlayerFromSessionStorageForUrlSession(): Player | null {
  if (typeof window === "undefined") return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const sid = normalizeMultiplayerSessionId(params.get("session") ?? "");
    if (!sid) return null;
    const cid = window.sessionStorage.getItem(SESSION_STORAGE_CLIENT_ID_KEY)?.trim();
    if (!cid) return null;
    const raw = window.sessionStorage.getItem(`${MP_SESSION_PLAYER_STORAGE_PREFIX}:${sid}:${cid}`);
    if (!raw) return null;
    return normalizePlayerShape(JSON.parse(raw));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Persistance locale (F5 / tests)
// ---------------------------------------------------------------------------

const PERSISTENCE_KEY = "dnd-ai-master-game-state-v2";
const PERSISTENCE_VERSION = 2;

/** Normalise les PV après chargement JSON (sauvegarde / cache par salle). */
function normalizeLoadedEntitiesList(raw: unknown): Entity[] {
  if (!Array.isArray(raw)) return [];
  return coalesceLogicalEntityDuplicates(raw.map((e: any) => {
    const rawHp = e?.hp;
    let hp = rawHp;
    if (typeof rawHp === "number" && Number.isFinite(rawHp)) {
      const v = Math.max(0, Math.floor(rawHp));
      hp = { current: v, max: v };
    } else if (rawHp && typeof rawHp === "object") {
      const curr = Number.isFinite(rawHp.current) ? Math.max(0, Math.floor(rawHp.current)) : 0;
      const maxRaw = Number.isFinite(rawHp.max) ? Math.max(1, Math.floor(rawHp.max)) : curr || 1;
      hp = { current: curr, max: Math.max(maxRaw, curr) };
    } else if (rawHp !== null && rawHp !== undefined) {
      hp = null;
    }
    const normalizedType = normalizeEntityType(e?.type) ?? "npc";
    const normalizedController = normalizeEntityController(e?.controller);
    const awareOfPlayer =
      typeof e?.awareOfPlayer === "boolean"
        ? e.awareOfPlayer
        : normalizedType === "hostile";
    const hpCurr =
      hp && typeof hp === "object" && Number.isFinite(hp.current) ? Math.max(0, Math.floor(hp.current)) : null;
    let isAlive = typeof e?.isAlive === "boolean" ? e.isAlive : true;
    if (hpCurr != null) {
      if (hpCurr > 0) isAlive = true;
      else isAlive = typeof e?.isAlive === "boolean" ? e.isAlive : false;
    }
    return { ...e, type: normalizedType, controller: normalizedController, hp, awareOfPlayer, isAlive } as Entity;
  }));
}

function isHostileReadyForCombat(entity: Entity | null | undefined): boolean {
  return !!entity && entity.type === "hostile" && entity.isAlive && entity.awareOfPlayer !== false;
}

/** Brouillon d'initiative PNJ : même ensemble d'ids que les hostiles prêts au combat (nouvelle escarmouche). */
function npcInitiativeDraftMatchesHostiles(draft: CombatEntry[], hostiles: Entity[]): boolean {
  if (!Array.isArray(draft) || !Array.isArray(hostiles)) return false;
  const hIds = new Set(hostiles.map((h) => String(h?.id ?? "").trim()).filter(Boolean));
  if (hIds.size !== hostiles.length) return false;
  const dIds = new Set(draft.map((d) => String(d?.id ?? "").trim()).filter(Boolean));
  if (dIds.size !== draft.length || dIds.size !== hIds.size) return false;
  for (const id of dIds) {
    if (!hIds.has(id)) return false;
  }
  return true;
}

/** Ordre d'initiative déjà en cours : doit au minimum contenir tous les hostiles actuellement engagés. */
function combatOrderMatchesCurrentHostiles(order: CombatEntry[], hostiles: Entity[]): boolean {
  if (!Array.isArray(order) || !Array.isArray(hostiles)) return false;
  if (hostiles.length === 0) return true;
  const orderIds = new Set(order.map((entry) => String(entry?.id ?? "").trim()).filter(Boolean));
  if (orderIds.size === 0) return false;
  for (const hostile of hostiles) {
    const id = String(hostile?.id ?? "").trim();
    if (!id || !orderIds.has(id)) return false;
  }
  return true;
}

/**
 * Multijoueur : un snapshot Firestore peut arriver avec un sceneVersion plus bas (autre onglet / client en retard)
 * et écraser des spawns récents. On réinjecte les créatures de scène (hostile / npc / friendly) encore présentes
 * localement mais absentes du payload — pas seulement les hostiles, sinon un PNJ spawné côté invité disparaît
 * dès que l’hôte renvoie un snapshot sans ce spawn.
 */
function mergeHostilesFromPrevWhenRemoteStale(
  prevEnts: Entity[],
  incoming: Entity[],
  p: SharedSessionPayload,
  localRoomIdBeforeApply: string,
  localSceneVersionBeforeApply: number
): Entity[] {
  const remoteRoom = typeof p.currentRoomId === "string" ? p.currentRoomId.trim() : "";
  const localRoom = String(localRoomIdBeforeApply ?? "").trim();
  if (!localRoom || !remoteRoom || localRoom !== remoteRoom) return incoming;

  const remoteSv = typeof p.sceneVersion === "number" ? p.sceneVersion : 0;
  const staleByVersion = remoteSv < localSceneVersionBeforeApply;

  const incomingById = new Map(incoming.map((e) => [e.id, e]));
  const prevCreatures = prevEnts.filter((e) => {
    if (!e?.id) return false;
    const id = String(e.id).trim();
    if (!id || id.startsWith("mp-player-")) return false;
    if (e.type !== "hostile" && e.type !== "npc" && e.type !== "friendly") return false;
    return e.isAlive !== false;
  });

  const missing: Entity[] = [];
  for (const h of prevCreatures) {
    if (!incomingById.has(h.id)) missing.push(h);
  }
  if (missing.length === 0) return incoming;

  if (!staleByVersion) return incoming;

  const out = [...incoming];
  for (const h of missing) {
    out.push(h);
  }
  return normalizeLoadedEntitiesList(out);
}

/**
 * Invité MP : avant écriture Firestore, on part du snapshot distant et on ajoute les entités présentes localement
 * mais absentes du remote (ex. spawn d’un PNJ appliqué seulement sur l’invité). L’hôte reste la base pour les ids
 * déjà synchronisés ; on n’ajoute que des ids nouveaux pour limiter les écrasements.
 */
function appendLocalEntitiesAbsentFromRemote(local: Entity[], remote: unknown): Entity[] {
  const rem = Array.isArray(remote) ? normalizeLoadedEntitiesList(remote as Entity[]) : [];
  const loc = Array.isArray(local) ? normalizeLoadedEntitiesList(local) : [];
  const localById = new Map(loc.map((e) => [String(e?.id ?? "").trim(), e] as const));
  const remoteIds = new Set(rem.map((e) => String(e?.id ?? "").trim()).filter(Boolean));

  const merged = rem.map((remoteEntity) => {
    const id = String(remoteEntity?.id ?? "").trim();
    if (!id) return remoteEntity;
    const localEntity = localById.get(id);
    if (!localEntity) return remoteEntity;
    if (id.startsWith("mp-player-") || id === "player") return remoteEntity;

    let next = remoteEntity;
    let changed = false;

    const remoteHp = remoteEntity?.hp && typeof remoteEntity.hp.current === "number" ? remoteEntity.hp.current : NaN;
    const localHp = localEntity?.hp && typeof localEntity.hp.current === "number" ? localEntity.hp.current : NaN;
    if (Number.isFinite(remoteHp) && Number.isFinite(localHp) && localHp < remoteHp) {
      const remoteMax =
        remoteEntity?.hp && typeof remoteEntity.hp.max === "number" && Number.isFinite(remoteEntity.hp.max)
          ? remoteEntity.hp.max
          : Math.max(1, Math.trunc(remoteHp));
      const localMax =
        localEntity?.hp && typeof localEntity.hp.max === "number" && Number.isFinite(localEntity.hp.max)
          ? localEntity.hp.max
          : remoteMax;
      next = {
        ...next,
        hp: {
          current: Math.max(0, Math.trunc(localHp)),
          max: Math.max(1, Math.trunc(localMax), Math.trunc(remoteMax)),
        },
      };
      changed = true;
    }

    if (localEntity?.isAlive === false && next?.isAlive !== false) {
      next = {
        ...next,
        isAlive: false,
        hp:
          next?.hp && typeof next.hp === "object"
            ? { ...next.hp, current: 0 }
            : { current: 0, max: 1 },
      };
      changed = true;
    }

    if (String(localEntity?.type ?? "").trim() === "hostile" && String(next?.type ?? "").trim() !== "hostile") {
      next = { ...next, type: "hostile" };
      changed = true;
    }

    return changed ? next : remoteEntity;
  });

  const out = [...merged];
  for (const e of loc) {
    const id = String(e?.id ?? "").trim();
    if (!id || remoteIds.has(id)) continue;
    out.push(e);
  }
  return normalizeLoadedEntitiesList(out);
}

/**
 * Un snapshot Firestore peut arriver avant flushMultiplayerSharedState et réinjecter d'anciens PV.
 * On garde donc la valeur la plus basse entre local et remote pour éviter les "résurrections" visuelles
 * (ex: ennemi à 0 PV qui remonte à 2/11 après un snapshot retardé).
 */
function mergeIncomingEntitiesHpWithPrev(prevEnts: Entity[], incoming: Entity[]): Entity[] {
  const prevById = new Map(prevEnts.map((e) => [e.id, e]));
  return incoming.map((inc) => {
    const p = prevById.get(inc.id);
    // Anti-stale états de combat :
    // si on a déjà consommé localement `surprised:false`, un snapshot Firestore en retard
    // ne doit pas remettre `surprised:true` (sinon les ennemis sautent leurs tours en boucle).
    const shouldKeepLocalUnsurprised =
      p?.surprised === false && inc?.surprised === true;
    // Idem : après engagement / première attaque, un snapshot en retard avec encore
    // `awareOfPlayer:false` (ex. gobelins « endormis ») ne doit pas annuler la prise de conscience
    // locale — sinon `isHostileReadyForCombat` retombe à faux, l’effet initiative vide le
    // brouillon et le mode repasse en exploration.
    const shouldKeepLocalAware =
      p?.awareOfPlayer === true && inc?.awareOfPlayer === false;

    const patchStaleCombatFlags = (base: Entity): Entity => {
      if (!shouldKeepLocalUnsurprised && !shouldKeepLocalAware) return base;
      return {
        ...base,
        ...(shouldKeepLocalUnsurprised ? { surprised: false as const } : {}),
        ...(shouldKeepLocalAware ? { awareOfPlayer: true as const } : {}),
      };
    };

    if (!p?.hp || !inc.hp) {
      return patchStaleCombatFlags(inc);
    }
    const pc = typeof p.hp.current === "number" ? p.hp.current : NaN;
    const ic = typeof inc.hp.current === "number" ? inc.hp.current : NaN;
    if (!Number.isFinite(pc) || !Number.isFinite(ic)) return patchStaleCombatFlags(inc);
    if (pc === ic) return patchStaleCombatFlags(inc);
    const mergedCurrent = ic > pc ? pc : ic;
    if (mergedCurrent === ic) {
      return patchStaleCombatFlags(inc);
    }
    const id = String(inc.id ?? "").trim();
    const controller = String((inc as any)?.controller ?? "").trim();
    const type = String((inc as any)?.type ?? "").trim();
    const isPlayerLike =
      id === "player" || id.startsWith("mp-player-") || controller === "player" || type === "player";
    const alive =
      mergedCurrent > 0
        ? true
        : isPlayerLike
          ? (typeof inc.isAlive === "boolean" ? inc.isAlive : true)
          : false;
    return patchStaleCombatFlags({
      ...inc,
      hp: { ...inc.hp, current: mergedCurrent },
      isAlive: alive,
    });
  });
}

/**
 * Réconciliation des PV entre l'état React précédent et un snapshot Firestore.
 * Sans horodatage, `Math.min` seul empêchait toute **remontée** de PV (long repos, reset début
 * d'aventure après 0 PV) tant que le state local gardait l'ancien 0.
 * On fait donc confiance au profil **le plus récent** via `updatedAtMs`, et on ne prend le minimum
 * qu'en cas d'égalité / timestamps absents (deux lectures du même instant, horloges manquantes).
 */
function mergeIncomingParticipantProfilesHpWithPrev(
  prev: SessionParticipantProfile[],
  incoming: SessionParticipantProfile[]
): SessionParticipantProfile[] {
  const prevById = new Map(prev.map((p) => [String(p.clientId ?? "").trim(), p]));
  return incoming.map((inc) => {
    const pid = String(inc.clientId ?? "").trim();
    const p = prevById.get(pid);
    if (!p) return inc;

    const pMs = typeof p.updatedAtMs === "number" && Number.isFinite(p.updatedAtMs) ? p.updatedAtMs : -1;
    const iMs = typeof inc.updatedAtMs === "number" && Number.isFinite(inc.updatedAtMs) ? inc.updatedAtMs : -1;

    if (iMs > pMs) {
      return inc;
    }
    if (pMs > iMs) {
      const next: SessionParticipantProfile = { ...inc };
      if (typeof p.hpCurrent === "number" && Number.isFinite(p.hpCurrent)) {
        const cur = Math.trunc(p.hpCurrent);
        next.hpCurrent = cur;
        const snap = next.playerSnapshot && typeof next.playerSnapshot === "object" ? next.playerSnapshot : null;
        if (snap?.hp && typeof snap.hp === "object") {
          next.playerSnapshot = {
            ...snap,
            hp: { ...snap.hp, current: Math.max(0, cur) },
          } as Player;
        }
      }
      if (typeof p.hpMax === "number" && Number.isFinite(p.hpMax)) {
        next.hpMax = Math.trunc(p.hpMax);
      }
      return next;
    }

    const pc = typeof p.hpCurrent === "number" && Number.isFinite(p.hpCurrent) ? p.hpCurrent : NaN;
    const ic = typeof inc.hpCurrent === "number" && Number.isFinite(inc.hpCurrent) ? inc.hpCurrent : NaN;
    if (!Number.isFinite(pc) || !Number.isFinite(ic)) return inc;
    if (pc === ic) return inc;
    const mergedCurrent = Math.min(pc, ic);
    if (mergedCurrent === ic) return inc;
    const next: SessionParticipantProfile = { ...inc, hpCurrent: mergedCurrent };
    const snap = inc.playerSnapshot && typeof inc.playerSnapshot === "object" ? inc.playerSnapshot : null;
    if (snap?.hp && typeof snap.hp === "object") {
      next.playerSnapshot = {
        ...snap,
        hp: { ...snap.hp, current: mergedCurrent },
      } as Player;
    }
    return next;
  });
}

/** Personnages vivants contrôlés par un joueur (hors PNJ / IA) — pour l'initiative multijoueur. */
function getPlayerEntityIdsForInitiative(entities: Entity[]): string[] {
  const out: string[] = [];
  for (const e of entities ?? []) {
    if (!e || e.isAlive === false) continue;
    if (e.controller === "player") {
      out.push(e.id);
    }
  }
  return out;
}

function buildMergedInitiativeOrder(
  playerIds: string[],
  rolls: Record<string, number>,
  npcDraft: CombatEntry[],
  entities: Entity[],
  localPlayerName: string | null,
  participantNameById: Record<string, string> = {}
): CombatEntry[] {
  const playerEntries: CombatEntry[] = playerIds.map((id) => {
    const ent = entities.find((e) => e.id === id) ?? null;
    const knownName = String(participantNameById?.[id] ?? "").trim();
    return {
      id,
      name: resolveCombatantDisplayName(
        { id, name: knownName || (typeof ent?.name === "string" ? ent.name : "") },
        entities,
        localPlayerName
      ),
      initiative: rolls[id]!,
    };
  });
  return [...npcDraft, ...playerEntries].sort((a, b) => b.initiative - a.initiative);
}

interface PersistedPayload {
  player: Player | null;
  worldTimeMinutes: number;
  messages: Message[];
  pendingRoll: PendingRoll | null;
  isGameStarted: boolean;
  currentSceneName: string;
  currentScene: string;
  currentRoomId: string;
  sceneVersion: number;
  entities: Entity[];
  /** Entités par salle (hors salle courante) pour retrouver cadavres / état au retour. */
  entitiesByRoom?: Record<string, Entity[]>;
  /** Mémoire narrative/mécanique par salle (lignes séparées par \\n). */
  roomMemoryByRoom?: Record<string, string>;
  gameMode: GameMode;
  gameModeUpdatedAtMs?: number;
  combatOrder: CombatEntry[];
  combatTurnIndex: number;
  combatTurnWriteSeq?: number;
  initiativeStateUpdatedAtMs?: number;
  engagedWithId: string | null;
  hasDisengagedThisTurn: boolean;
  meleeState: Record<string, string[]>;
  reactionState: Record<string, boolean>;
  /** Ressources par combattant (vérité partagée). `turnResources` reste un miroir du combattant actif pour compat. */
  turnResourcesByCombatantId: TurnResourcesMap;
  turnResources: TurnResources;
  npcInitiativeDraft?: CombatEntry[];
  playerInitiativeRollsByEntityId?: Record<string, number>;
  awaitingPlayerInitiative?: boolean;
  /** MP/solo : masquer le bandeau initiative jusqu'à la narration MJ dans le chat partagé. */
  waitForGmNarrationForInitiative?: boolean;
  aiProvider: AiProvider;
  debugMode: boolean;
  currentSceneImage: string;
  imageModel: ImageModelId;
  debugNextRoll: number | null;
  autoPlayerEnabled: boolean;
  autoRollEnabled: boolean;
  combatHiddenIds?: string[];
  combatStealthTotalByCombatantId?: Record<string, number>;
  /** Révision locale du graphe de mêlée : dernier changement l’emporte sur les syncs périmées. */
  meleeEngagementSeq?: number;
}

interface SharedSessionPayload {
  worldTimeMinutes: number;
  messages: Message[];
  pendingRoll: PendingRoll | null;
  isGameStarted: boolean;
  currentSceneName: string;
  currentScene: string;
  currentRoomId: string;
  sceneVersion: number;
  entities: Entity[];
  entitiesByRoom?: Record<string, Entity[]>;
  roomMemoryByRoom?: Record<string, string>;
  gameMode: GameMode;
  /** Horodatage logique (ms) de la dernière mutation explicite de mode. */
  gameModeUpdatedAtMs?: number;
  combatOrder: CombatEntry[];
  combatTurnIndex: number;
  /** Révision monotone des changements d’index de tour (MP) — ignore les snapshots Firestore plus anciens. */
  combatTurnWriteSeq?: number;
  initiativeStateUpdatedAtMs?: number;
  /** Jets PNJ + attente PJ : partagés pour un même tirage et des jets partiels multijoueur. */
  npcInitiativeDraft?: CombatEntry[] | null;
  playerInitiativeRollsByEntityId?: Record<string, number> | null;
  awaitingPlayerInitiative?: boolean | null;
  waitForGmNarrationForInitiative?: boolean | null;
  engagedWithId: string | null;
  hasDisengagedThisTurn: boolean;
  meleeState: Record<string, string[]>;
  reactionState: Record<string, boolean>;
  turnResourcesByCombatantId: TurnResourcesMap;
  turnResources: TurnResources;
  currentSceneImage: string;
  /** Combattants cachés (Discrétion réussie). */
  combatHiddenIds?: string[];
  /** Total Discrétion (DD Perception active) par combattant caché. */
  combatStealthTotalByCombatantId?: Record<string, number>;
  /** Révision du graphe de mêlée (MP) — comparée localement pour ignorer les snapshots obsolètes. */
  meleeEngagementSeq?: number;
}

/**
 * Types de bulles « moteur » à réinjecter tant que le snapshot Firestore n’a pas encore le même id.
 * Inclut debug : sinon les clients distants ne voient jamais ces lignes après merge.
 */
function isStickyEngineOrPlayerMessage(m: Message): boolean {
  const content = String(m?.content ?? "").trim();
  const t = String(m?.type ?? "");
  const id = String(m?.id ?? "").trim();
  if (t === "continue") return false;
  // Ne jamais réinjecter d'anciennes cartes d'initiative via le merge sticky.
  if (id.startsWith("initiative-order-")) return false;
  if (
    t === "scene-image-pending" ||
    t === "scene-image" ||
    t === "intent-error" ||
    t === "dice" ||
    t === "meta" ||
    t === "meta-reply" ||
    t === "enemy-turn" ||
    t === "combat-detail" ||
    t === "turn-end" ||
    t === "turn-divider" ||
    t === "debug" ||
    t === "retry-action" ||
    t === "campaign-context"
  ) {
    return true;
  }
  if (m.role === "user" && content.length > 0) return true;
  // Narration MJ / image sans type explicite
  if (m.role === "ai" && content.length > 0 && t !== "debug" && t !== "dice") return true;
  return false;
}

/** Limite la taille du document Firestore (messages récents × contenu long surtout debug). */
function truncateMessageForSharedPayload(m: Message): Message {
  const t = String((m as any)?.type ?? "");
  const maxByType: Record<string, number> = {
    debug: 8000,
    "combat-detail": 12000,
    dice: 10000,
    meta: 6000,
    "meta-reply": 6000,
    "intent-error": 2000,
  };
  const max = maxByType[t] ?? 14000;
  const c = String((m as any)?.content ?? "");
  if (c.length <= max) return m;
  return { ...(m as any), content: c.slice(0, Math.max(0, max - 1)) + "…" } as Message;
}

/**
 * Réinjecte dans l’historique les messages locaux absents du snapshot distant (latence Firestore),
 * en conservant l’ordre approximatif (insertion après le dernier prédécesseur présent côté remote).
 *
 * Important : la narration MJ (`ai` hors debug/dice) doit rester « sticky » tant que le payload
 * distant n’a pas le même `id`. Sinon un snapshot Firestore un peu en retard peut effacer la
 * réponse du MJ déjà affichée après `callApi`, et le chat repasse sur le dernier message joueur.
 *
 * Les bulles `dice` (jets / lignes mécaniques mêlée) et `meta` (retours moteur en MP) doivent aussi
 * être sticky : sinon un flush juste après `addMessage` peut écrire un payload sans elles, puis le
 * snapshot suivant écrase l’UI — le joueur ne voit plus aucune confirmation après parse-intent.
 */
function mergeStickyLocalMessagesIntoRemote(prev: Message[], remote: Message[]): Message[] {
  const remoteList = Array.isArray(remote) ? [...remote] : [];
  const remoteIdSet = new Set(
    remoteList.map((m) => String(m?.id ?? "").trim()).filter(Boolean)
  );

  const insertions: { afterId: string | null; msg: Message }[] = [];
  // Évite l'effet "boomerang" : une bulle ancienne tombée hors cap Firestore ne doit pas
  // réapparaître plusieurs tours plus tard en bas du chat.
  const STICKY_LOOKBACK_COUNT = 40;
  const startIdx = Math.max(0, prev.length - STICKY_LOOKBACK_COUNT);

  for (let i = startIdx; i < prev.length; i++) {
    const m = prev[i];
    const id = String(m?.id ?? "").trim();
    if (!id || remoteIdSet.has(id)) continue;
    const keep = isStickyEngineOrPlayerMessage(m);
    if (!keep) continue;

    let afterId: string | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const pid = String(prev[j]?.id ?? "").trim();
      if (pid && remoteIdSet.has(pid)) {
        afterId = pid;
        break;
      }
    }
    insertions.push({ afterId, msg: m });
  }

  if (insertions.length === 0) return remoteList;

  const byAfter = new Map<string | null, Message[]>();
  for (const ins of insertions) {
    const arr = byAfter.get(ins.afterId) ?? [];
    arr.push(ins.msg);
    byAfter.set(ins.afterId, arr);
  }

  const result: Message[] = [];
  const headOrphans = byAfter.get(null);
  if (headOrphans) {
    for (const m of headOrphans) result.push(m);
  }

  for (const m of remoteList) {
    result.push(m);
    const mid = String(m?.id ?? "").trim();
    const appended = mid ? byAfter.get(mid) : undefined;
    if (appended) {
      for (const x of appended) result.push(x);
    }
  }

  const seen = new Set<string>();
  return result.filter((m) => {
    const id = String(m?.id ?? "").trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Réinjecte des messages locaux explicitement listés (ex. `initiative-order-*` absents du snapshot
 * à cause du cap Firestore) au bon endroit : même logique que mergeSticky (après le dernier
 * prédécesseur présent dans `remote`). Évite `[...remote, ...missing]` qui recolle la carte
 * d'initiative en bas du fil à chaque sync.
 */
function reinjectExplicitLocalMessagesIntoRemote(
  prev: Message[],
  remote: Message[],
  explicitMissing: Message[]
): Message[] {
  let remoteList = Array.isArray(remote) ? [...remote] : [];
  const remoteIdSet = new Set(
    remoteList.map((m) => String(m?.id ?? "").trim()).filter(Boolean)
  );

  const insertions: { afterId: string | null; msg: Message }[] = [];
  for (const m of explicitMissing) {
    const id = String(m?.id ?? "").trim();
    if (!id || remoteIdSet.has(id)) continue;
    const i = prev.findIndex((x) => String(x?.id ?? "").trim() === id);
    let afterId: string | null = null;
    const startJ = i >= 0 ? i - 1 : prev.length - 1;
    for (let j = startJ; j >= 0; j--) {
      const pid = String(prev[j]?.id ?? "").trim();
      if (pid && remoteIdSet.has(pid)) {
        afterId = pid;
        break;
      }
    }
    // Cas rehydrate : si une carte d'initiative n'a plus de prédécesseur distant (cap Firestore),
    // on utilise le placement dédié dans la timeline de combat au lieu d'un append "au hasard".
    if (!afterId && id.startsWith("initiative-order-")) {
      remoteList = insertInitiativeOrderMessageIntoTimeline(remoteList, m);
      remoteIdSet.add(id);
      continue;
    }
    insertions.push({ afterId, msg: m });
  }

  if (insertions.length === 0) return remoteList;

  const byAfter = new Map<string | null, Message[]>();
  for (const ins of insertions) {
    const arr = byAfter.get(ins.afterId) ?? [];
    arr.push(ins.msg);
    byAfter.set(ins.afterId, arr);
  }

  const result: Message[] = [];
  const headOrphans = byAfter.get(null);
  if (headOrphans) {
    for (const m of headOrphans) result.push(m);
  }

  for (const m of remoteList) {
    result.push(m);
    const mid = String(m?.id ?? "").trim();
    const appended = mid ? byAfter.get(mid) : undefined;
    if (appended) {
      for (const x of appended) result.push(x);
    }
  }

  const seen = new Set<string>();
  return result.filter((m) => {
    const id = String(m?.id ?? "").trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Nouvelle carte initiative : la placer avant le journal combat s'il a déjà commencé, sinon en fin de fil. */
function insertInitiativeOrderMessageIntoTimeline(prev: Message[], initiativeMsg: Message): Message[] {
  const mid = String(initiativeMsg?.id ?? "").trim();
  if (!mid) return [...prev, initiativeMsg];
  if (prev.some((m) => String(m?.id ?? "").trim() === mid)) return prev;

  const isCombatTimelineAnchor = (m: Message) => {
    const t = String(m?.type ?? "");
    return (
      t === "combat-detail" ||
      t === "enemy-turn" ||
      t === "turn-end" ||
      t === "turn-divider"
    );
  };
  const anchorIdx = prev.findIndex(isCombatTimelineAnchor);
  if (anchorIdx >= 0) {
    return [...prev.slice(0, anchorIdx), initiativeMsg, ...prev.slice(anchorIdx)];
  }
  return [...prev, initiativeMsg];
}

export function normalizeTurnResourcesInput(tr: TurnResources | null | undefined): TurnResources {
  if (!tr || typeof tr !== "object") {
    return { action: true, bonus: true, reaction: true, movement: true };
  }
  return {
    action: !!tr.action,
    bonus: !!tr.bonus,
    reaction: !!tr.reaction,
    movement: typeof tr.movement === "boolean" ? tr.movement : Number(tr.movement) > 0,
  };
}

/**
 * Multijoueur : deux snapshots peuvent arriver dans le désordre (flush local vs écriture d'un autre client).
 * Sur le même segment de tour (même combatTurnIndex), on fusionne les disponibilités par ET logique :
 * si l'un des deux a déjà consommé une ressource (false), on garde false — évite qu'un snapshot
 * « vieux » réaffiche Mouvement: Oui après un déplacement résolu localement.
 */
function mergeTurnResourcesSameCombatSegment(
  local: TurnResources,
  remote: TurnResources
): TurnResources {
  return {
    action: local.action && remote.action,
    bonus: local.bonus && remote.bonus,
    reaction: local.reaction && remote.reaction,
    movement: local.movement && remote.movement,
  };
}

/** Ressources de tour indexées par id de combattant (PJ, mp-player-*, PNJ hostiles…). */
export type TurnResourcesMap = Record<string, TurnResources>;

function normalizeTurnResourcesMapInput(m: TurnResourcesMap | null | undefined): TurnResourcesMap {
  if (!m || typeof m !== "object" || Array.isArray(m)) return {};
  const out: TurnResourcesMap = {};
  for (const [k, v] of Object.entries(m)) {
    const id = String(k ?? "").trim();
    if (!id) continue;
    out[id] = normalizeTurnResourcesInput(v as TurnResources);
  }
  return out;
}

function mergeTurnResourcesMapSameCombatSegment(
  local: TurnResourcesMap,
  remote: TurnResourcesMap
): TurnResourcesMap {
  const out: TurnResourcesMap = { ...local };
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const k of keys) {
    const l = local[k];
    const r = remote[k];
    if (l && r) {
      out[k] = mergeTurnResourcesSameCombatSegment(
        normalizeTurnResourcesInput(l),
        normalizeTurnResourcesInput(r)
      );
    } else if (r) {
      out[k] = normalizeTurnResourcesInput(r);
    } else if (l) {
      out[k] = normalizeTurnResourcesInput(l);
    }
  }
  return out;
}

/** Action, bonus et réaction déjà dépensés (mouvement seul ne suffit pas à dire « début de tour »). */
function isTurnResourcesCoreSpent(tr: TurnResources | null | undefined): boolean {
  const n = normalizeTurnResourcesInput(tr);
  return !n.action && !n.bonus && !n.reaction;
}

/** Migration : anciennes sauvegardes avec un seul `turnResources` global. */
function migratePayloadTurnResourcesToMap(
  p: Partial<SharedSessionPayload> | Partial<PersistedPayload>
): TurnResourcesMap {
  const existing = normalizeTurnResourcesMapInput(
    (p as { turnResourcesByCombatantId?: TurnResourcesMap }).turnResourcesByCombatantId
  );
  if (Object.keys(existing).length > 0) return existing;
  const legacy = (p as { turnResources?: TurnResources }).turnResources;
  if (!legacy || typeof legacy !== "object") return {};
  const co = (p as { combatOrder?: CombatEntry[] }).combatOrder;
  const idxRaw = (p as { combatTurnIndex?: number }).combatTurnIndex;
  const idx = typeof idxRaw === "number" && Number.isFinite(idxRaw) ? Math.trunc(idxRaw) : 0;
  let activeId = "";
  if (Array.isArray(co) && co.length > 0 && idx >= 0 && idx < co.length) {
    activeId = String(co[idx]?.id ?? "").trim();
  }
  const tr = normalizeTurnResourcesInput(legacy as TurnResources);
  if (activeId) return { [activeId]: tr };
  return { player: tr };
}

function turnResourcesMirrorFromMap(
  map: TurnResourcesMap,
  combatOrder: CombatEntry[] | null | undefined,
  combatTurnIndex: number
): TurnResources {
  const co = combatOrder;
  const tidx = combatTurnIndex;
  const activeId =
    Array.isArray(co) && co.length > 0 && typeof tidx === "number" && tidx >= 0 && tidx < co.length
      ? String(co[tidx]?.id ?? "").trim()
      : "";
  if (activeId && map[activeId]) {
    return normalizeTurnResourcesInput(map[activeId]);
  }
  return normalizeTurnResourcesInput(undefined);
}

function chatMessagesVisualEqual(a: Message[], b: Message[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ma = a[i];
    const mb = b[i];
    if (String(ma?.id ?? "") !== String(mb?.id ?? "")) return false;
    if (String(ma?.content ?? "") !== String(mb?.content ?? "")) return false;
    if (ma?.role !== mb?.role) return false;
    if (String(ma?.type ?? "") !== String(mb?.type ?? "")) return false;
  }
  return true;
}

/** Salon : partie non lancée, URL partageable avant « Démarrer l'aventure ». */
function buildLobbySharedSessionPayload(): SharedSessionPayload {
  const lobbyMsgId = `lobby-welcome-${Date.now()}`;
  const lobbySceneName =
    (GOBLIN_CAVE as any)?.scene_village?.title ??
    DEFAULT_SCENE_NAME;
  return {
    worldTimeMinutes: 0,
    messages: [
      {
        id: lobbyMsgId,
        role: "ai",
        type: "meta-reply",
        content:
          "Session multijoueur ouverte. Partagez l’URL de la page (avec ?session=…) pour inviter les autres joueurs. " +
          "Quand tout le monde est prêt, n’importe quel joueur peut cliquer sur « Démarrer l’aventure » : la campagne démarre pour tout le monde en même temps.",
      },
    ],
    pendingRoll: null,
    isGameStarted: false,
    currentSceneName: lobbySceneName,
    currentScene:
      "Les aventuriers se retrouvent avant d’entrer dans la campagne. Choisissez vos personnages, partagez le lien, puis lancez quand vous êtes prêts.",
    currentRoomId: "lobby",
    sceneVersion: 0,
    entities: [],
    entitiesByRoom: {},
    roomMemoryByRoom: {},
    gameMode: "exploration",
    combatOrder: [],
    combatTurnIndex: 0,
    combatTurnWriteSeq: 0,
    engagedWithId: null,
    hasDisengagedThisTurn: false,
    meleeState: {},
    reactionState: {},
    turnResourcesByCombatantId: {},
    turnResources: { action: true, bonus: true, reaction: true, movement: true },
    currentSceneImage: "/file.svg",
    combatHiddenIds: [],
    combatStealthTotalByCombatantId: {},
  };
}

/**
 * IDs stables des bulles d'ouverture (contexte campagne + scène forge). Doivent être **identiques**
 * dans `buildInitialCampaignSharedPayload` et `resetToCampaignStart`. Sinon, en multijoueur,
 * `mergeStickyLocalMessagesIntoRemote` garde les messages locaux (autres `Date.now()`) en plus
 * du snapshot distant → doublons CONTEXTE / narration MJ.
 */
const OPENING_MSG_ID_CAMPAIGN_CONTEXT = "opening-campaign-context-v1";
const OPENING_MSG_ID_FORGE_INTRO = "opening-init-campaign-forge-v1";

/** État mondial initial aligné sur `resetToCampaignStart` (commit unique au premier « Démarrer » en multijoueur). */
function buildInitialCampaignSharedPayload(): SharedSessionPayload {
  const start: any = (GOBLIN_CAVE as any)?.scene_village ?? null;
  const opening = (CAMPAIGN_CONTEXT as { chatOpeningContext?: { title?: string; body?: string } })
    .chatOpeningContext;
  const openingBody = typeof opening?.body === "string" ? opening.body.trim() : "";
  const openingMsgs: Message[] = [];
  if (openingBody) {
    openingMsgs.push({
      id: OPENING_MSG_ID_CAMPAIGN_CONTEXT,
      role: "ai",
      type: "campaign-context",
      content: openingBody,
      contextBox: {
        title: (typeof opening?.title === "string" && opening.title.trim()) || "Contexte",
      },
    });
  }
  openingMsgs.push({
    id: OPENING_MSG_ID_FORGE_INTRO,
    role: "ai",
    content:
      `En début d’après-midi, Thron, le forgeron qui fait également\n` +
      `office de chef du village, convoque les personnages.\n` +
      `Mes enfants, vous êtes les jeunes les plus aguerris du\n` +
      `village, et certains d’entre vous sont des amis de ma fille\n` +
      `Lanéa.\n` +
      `Un commis du vieil Erdrios, le meunier, vient de\n` +
      `m’apprendre qu’il vient de voir sur la colline un petit\n` +
      `groupe de gobelins portant une jeune femme qui\n` +
      `ressemblait beaucoup à ma fille. Or justement Lanéa est\n` +
      `partie tôt ce matin dans cette direction, et elle n’est pas\n` +
      `revenue à l’heure du repas. Je ne vous cache pas ma\n` +
      `préoccupation, et si sa mère l’apprend, elle risque de\n` +
      `mourir d’inquiétude.\n` +
      `Alors en toute franchise, je voudrais vous demander un\n` +
      `énorme service : pourriez-vous aller vérifier si c’est bien\n` +
      `ma fille que ces monstres ont attrapée et, si vous le\n` +
      `pensez possible, en profiter pour la délivrer des mains de\n` +
      `ces créatures ? Si j’y vais moi, ma femme va se douter\n` +
      `que quelque chose de grave est en train de se passer.`,
  });
  const rawEntities = [
    {
      id: "thron",
      name: "Thron",
      type: "npc",
      controller: "ai",
      race: "Humain",
      entityClass: "Forgeron (Chef du village)",
      cr: 0,
      visible: true,
      isAlive: true,
      hp: { current: 9, max: 9 },
      ac: 11,
      stats: { FOR: 14, DEX: 10, CON: 13, INT: 11, SAG: 12, CHA: 12 },
      attackBonus: 2,
      damageDice: "1d4",
      damageBonus: 0,
      description:
        "Forgeron robuste au tablier noirci, regard inquiet; il vous a convoqués en secret.",
      stealthDc: null,
    },
    {
      id: "commis_meunier",
      name: "Commis du meunier",
      type: "npc",
      controller: "ai",
      race: "Humain",
      entityClass: "Villageois",
      cr: 0,
      visible: true,
      isAlive: true,
      hp: { current: 4, max: 4 },
      ac: 10,
      stats: { FOR: 10, DEX: 10, CON: 10, INT: 10, SAG: 11, CHA: 10 },
      attackBonus: 1,
      damageDice: "1d4",
      damageBonus: 0,
      description:
        "Jeune homme nerveux, les mains sales de farine; témoin de l'enlèvement, il évite votre regard.",
      stealthDc: null,
    },
  ];
  const loadedEntities = normalizeLoadedEntitiesList(rawEntities);
  const worldTime =
    typeof CAMPAIGN_START_WORLD_TIME_MINUTES === "number" && Number.isFinite(CAMPAIGN_START_WORLD_TIME_MINUTES)
      ? Math.max(0, Math.trunc(CAMPAIGN_START_WORLD_TIME_MINUTES))
      : 0;
  return {
    worldTimeMinutes: worldTime,
    messages: openingMsgs,
    pendingRoll: null,
    isGameStarted: true,
    currentSceneName: start?.title ?? (CAMPAIGN_CONTEXT as any)?.title ?? "Campagne",
    currentScene: start?.description ?? "",
    currentRoomId: start?.id ?? "scene_village",
    sceneVersion: 1,
    entities: loadedEntities as Entity[],
    entitiesByRoom: {},
    roomMemoryByRoom: {},
    gameMode: "exploration",
    combatOrder: [],
    combatTurnIndex: 0,
    combatTurnWriteSeq: 0,
    engagedWithId: null,
    hasDisengagedThisTurn: false,
    meleeState: {},
    reactionState: {},
    turnResourcesByCombatantId: {},
    turnResources: { action: true, bonus: true, reaction: true, movement: true },
    currentSceneImage: "/file.svg",
    combatHiddenIds: [],
    combatStealthTotalByCombatantId: {},
  };
}

// ---------------------------------------------------------------------------
// Contexte
// ---------------------------------------------------------------------------

const GameContext = createContext<GameContextValue | null>(null);

function resetRemainingResourcesDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => resetRemainingResourcesDeep(v)) as T;
  }
  if (!value || typeof value !== "object") return value;

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(obj)) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const candidate = raw as Record<string, unknown>;
      const hasMax = typeof candidate.max === "number";
      const hasRemaining = typeof candidate.remaining === "number";
      if (hasMax && hasRemaining) {
        out[key] = { ...candidate, remaining: candidate.max as number };
        continue;
      }
    }
    out[key] = resetRemainingResourcesDeep(raw);
  }

  return out as T;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Copie pour snapshots / ref synchrone — évite de sérialiser un objet partagé et muté ailleurs. */
function cloneMeleeStateRecord(s: Record<string, string[]>): Record<string, string[]> {
  const o: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(s)) {
    o[k] = Array.isArray(v) ? [...v] : [];
  }
  return o;
}

/**
 * Ferme transitivement la mêlée:
 * si A est au contact de B et B de C, alors A, B et C sont tous mutuellement au contact.
 */
function normalizeMeleeStateTransitive(raw: Record<string, string[]>): Record<string, string[]> {
  const nodeSet = new Set<string>();
  for (const [k, peers] of Object.entries(raw ?? {})) {
    const kk = String(k ?? "").trim();
    if (!kk) continue;
    nodeSet.add(kk);
    for (const p of Array.isArray(peers) ? peers : []) {
      const pp = String(p ?? "").trim();
      if (pp && pp !== kk) nodeSet.add(pp);
    }
  }
  const nodes = [...nodeSet];
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n, new Set<string>());
  for (const [k, peers] of Object.entries(raw ?? {})) {
    const a = String(k ?? "").trim();
    if (!a || !adj.has(a)) continue;
    for (const p of Array.isArray(peers) ? peers : []) {
      const b = String(p ?? "").trim();
      if (!b || b === a || !adj.has(b)) continue;
      adj.get(a)!.add(b);
      adj.get(b)!.add(a);
    }
  }
  const out: Record<string, string[]> = {};
  const seen = new Set<string>();
  for (const start of nodes) {
    if (seen.has(start)) continue;
    const stack = [start];
    const comp: string[] = [];
    seen.add(start);
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      comp.push(cur);
      for (const nxt of adj.get(cur) ?? []) {
        if (seen.has(nxt)) continue;
        seen.add(nxt);
        stack.push(nxt);
      }
    }
    for (const id of comp) {
      out[id] = comp.filter((x) => x !== id);
    }
  }
  return out;
}

export function GameProvider({ children }: { children: ReactNode }) {
  // IMPORTANT MP : on veut un `clientId` stable par onglet (pour éviter
  // la duplication de profils après un F5/reload). `sessionStorage` est
  // propre à l'onglet, donc pas besoin de scoper sur `?session=...`.
  const [clientId] = useState<string>(() => {
    if (typeof window === "undefined") return `ssr-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const sessionStore = window.sessionStorage;
      const existing = sessionStore.getItem(SESSION_STORAGE_CLIENT_ID_KEY);
      if (existing && existing.trim()) return existing.trim();
      const created =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      sessionStore.setItem(SESSION_STORAGE_CLIENT_ID_KEY, created);
      return created;
    } catch {
      // Fallback : si sessionStorage indisponible, on retombe sur localStorage,
      // mais on garde un scope minimal pour limiter les collisions.
      try {
        const existing = window.localStorage.getItem(SESSION_STORAGE_CLIENT_ID_KEY);
        if (existing && existing.trim()) return existing.trim();
        const created =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        window.localStorage.setItem(SESSION_STORAGE_CLIENT_ID_KEY, created);
        return created;
      } catch {
        return `client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      }
    }
  });

  /** Toujours `null` au premier rendu SSR + 1er paint client : évite mismatch d’hydratation avec `readMpPlayerFromSessionStorageForUrlSession()`. */
  const [player, setPlayerState] = useState<Player | null>(null);
  /** Toujours la dernière valeur `player` (profil MP / heartbeat sans redémarrer l’intervalle à chaque PV). */
  const playerRef = useRef<Player | null>(null);
  playerRef.current = player;

  useLayoutEffect(() => {
    const restored = readMpPlayerFromSessionStorageForUrlSession();
    if (restored) setPlayerState(restored);
  }, []);
  /**
   * Horodatage `updatedAtMs` du dernier profil participant **que nous avons poussé** (ou patch PV).
   * Évite la boucle 5↔8 : un snapshot Firestore peut encore contenir d’anciens PV avant notre écriture ;
   * on n’aligne alors pas `player` sur ce snapshot si son `updatedAtMs` est plus vieux que ce repère.
   */
  const lastLocalParticipantProfilePushAtMsRef = useRef<number>(-1);
  /** Toujours aligné sur la dernière valeur d'horloge (mise à jour synchrone dans le setter) pour que les snapshots Firestore ne repoussent pas un vieux `worldTimeMinutes` avant le commit React. */
  const initialWorldTimeMinutes =
    typeof CAMPAIGN_START_WORLD_TIME_MINUTES === "number" && Number.isFinite(CAMPAIGN_START_WORLD_TIME_MINUTES)
      ? Math.max(0, Math.trunc(CAMPAIGN_START_WORLD_TIME_MINUTES))
      : 0;
  const worldTimeMinutesSyncRef = useRef<number>(initialWorldTimeMinutes);
  const [worldTimeMinutes, setWorldTimeMinutesState] = useState<number>(initialWorldTimeMinutes);
  const setWorldTimeMinutes = useCallback((action: React.SetStateAction<number>) => {
    // IMPORTANT MP: mettre à jour la ref synchrone avant tout flush Firestore.
    // Sinon un snapshot partagé peut publier une ancienne horloge (course setState/flush).
    const prev = worldTimeMinutesSyncRef.current;
    const nextRaw = typeof action === "function" ? (action as (p: number) => number)(prev) : action;
    const next = Math.max(0, Math.trunc(Number(nextRaw) || 0));
    worldTimeMinutesSyncRef.current = next;
    setWorldTimeMinutesState(next);
  }, []);
  const [messages, setMessages]       = useState<Message[]>([]);
  const [pendingRoll, setPendingRollState] = useState<PendingRoll | null>(null);
  /** Même principe que messagesStateRef : valeur à jour avant le commit React (flush Firestore / sauvegarde). */
  const pendingRollRef = useRef<PendingRoll | null>(null);
  const setPendingRoll = useCallback((roll: PendingRoll | null) => {
    pendingRollRef.current = roll;
    setPendingRollState(roll);
  }, []);
  const [isGameStarted, setIsGameStarted] = useState<boolean>(false);
  const [currentSceneName, setCurrentSceneNameState] = useState<string>(DEFAULT_SCENE_NAME);
  const [currentScene, setCurrentSceneState] = useState<string>(DEFAULT_SCENE_DESCRIPTION);
  const [currentRoomId, setCurrentRoomIdState] = useState<string>("scene_village");
  /** Valeurs à jour avant le commit React (flush Firestore multijoueur / payload partagé). */
  const currentRoomIdLiveRef = useRef<string>("scene_village");
  const currentSceneNameLiveRef = useRef<string>(DEFAULT_SCENE_NAME);
  const currentSceneLiveRef = useRef<string>(DEFAULT_SCENE_DESCRIPTION);

  const setCurrentRoomId = useCallback((id: string) => {
    currentRoomIdLiveRef.current = id;
    setCurrentRoomIdState(id);
  }, []);

  const setCurrentSceneName = useCallback((name: string) => {
    currentSceneNameLiveRef.current = name;
    setCurrentSceneNameState(name);
  }, []);

  const setCurrentScene = useCallback((scene: string) => {
    currentSceneLiveRef.current = scene;
    setCurrentSceneState(scene);
  }, []);
  const [sceneVersion, setSceneVersion] = useState<number>(0);
  const sceneVersionRef = useRef(0);
  useEffect(() => {
    sceneVersionRef.current = sceneVersion;
  }, [sceneVersion]);
  // On ne conserve que les créatures (pas les objets de décor) dans l'état de jeu.
  const [entities, setEntitiesState] = useState<Entity[]>([]);
  const [gameMode, setGameModeState] = useState<GameMode>("exploration");
  const gameModeRef = useRef<GameMode>(gameMode);
  const gameModeUpdatedAtMsRef = useRef<number>(0);
  useEffect(() => {
    gameModeRef.current = gameMode;
  }, [gameMode]);

  const entitiesRef = useRef<Entity[]>(entities);
  entitiesRef.current = entities;
  const setEntities = useCallback((next: SetStateAction<Entity[]>) => {
    setEntitiesState((prev) => {
      const resolved = typeof next === "function" ? (next as (p: Entity[]) => Entity[])(prev) : next;
      entitiesRef.current = resolved;
      return resolved;
    });
  }, []);

  /** État persistant par roomId (même hors salle courante). Non filtré React : lu à la sauvegarde. */
  const entitiesByRoomRef = useRef<Record<string, Entity[]>>({});

  const rememberRoomEntitiesSnapshot = useCallback((roomId: string, roomEntities: Entity[]) => {
    if (!roomId || typeof roomId !== "string") return;
    const list = Array.isArray(roomEntities) ? roomEntities : [];
    const creatures = list.filter((e) => e.type !== "object");
    try {
      entitiesByRoomRef.current = {
        ...entitiesByRoomRef.current,
        [roomId]: normalizeLoadedEntitiesList(JSON.parse(JSON.stringify(creatures))),
      };
    } catch {
      entitiesByRoomRef.current = { ...entitiesByRoomRef.current, [roomId]: [...creatures] };
    }
  }, []);

  const takeEntitiesForRoom = useCallback((roomId: string): Entity[] => {
    if (!roomId || roomId === "scene_journey") return [];
    const raw = entitiesByRoomRef.current[roomId];
    if (!raw || !Array.isArray(raw)) return [];
    return normalizeLoadedEntitiesList(raw).filter((e) => e.type !== "object");
  }, []);

  const clearRoomEntitySnapshots = useCallback(() => {
    entitiesByRoomRef.current = {};
  }, []);

  const [roomMemoryByRoom, setRoomMemoryByRoom] = useState<Record<string, string>>({});
  const roomMemoryByRoomRef = useRef<Record<string, string>>({});

  function normalizeRoomMemoryLine(line: string) {
    return String(line ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 400);
  }

  function normalizeRoomMemoryMatch(text: string) {
    return String(text ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function isRoomAwarenessOrSurpriseLine(line: string) {
    const n = normalizeRoomMemoryMatch(line);
    const mentionsRoomActors =
      n.includes("gobelin") ||
      n.includes("gobelins") ||
      n.includes("garde") ||
      n.includes("gardes") ||
      n.includes("occupant") ||
      n.includes("occupants");
    const mentionsAwarenessOrSurprise =
      n.includes("surpris") ||
      n.includes("alerte") ||
      n.includes("vacarme") ||
      n.includes("intrus tente de forcer") ||
      n.includes("ne pourront pas etre surpris") ||
      n.includes("ne pourra pas etre surpris");
    return mentionsRoomActors && mentionsAwarenessOrSurprise;
  }

  function isRoomShieldReadinessLine(line: string) {
    const n = normalizeRoomMemoryMatch(line);
    const mentionsRoomActors =
      n.includes("gobelin") ||
      n.includes("gobelins") ||
      n.includes("garde") ||
      n.includes("gardes");
    return mentionsRoomActors && n.includes("bouclier");
  }

  function mergeRoomMemoryText(oldText: string, newLine?: string) {
    const rawLines = String(oldText ?? "")
      .split("\n")
      .map((line) => normalizeRoomMemoryLine(line))
      .filter(Boolean);
    const incoming = newLine ? normalizeRoomMemoryLine(newLine) : "";
    const nextLines = [...rawLines];

    const pruneFamily = (predicate: (line: string) => boolean) => {
      for (let i = nextLines.length - 1; i >= 0; i -= 1) {
        if (predicate(nextLines[i])) nextLines.splice(i, 1);
      }
    };

    if (incoming) {
      if (isRoomAwarenessOrSurpriseLine(incoming)) {
        pruneFamily(isRoomAwarenessOrSurpriseLine);
      }
      if (isRoomShieldReadinessLine(incoming)) {
        pruneFamily(isRoomShieldReadinessLine);
      }
      if (!nextLines.includes(incoming)) {
        nextLines.push(incoming);
      }
    }

    return nextLines.join("\n");
  }

  const getRoomMemory = useCallback(
    (roomId: string) => {
      if (!roomId || typeof roomId !== "string") return "";
      const raw = roomMemoryByRoomRef.current[roomId] ?? "";
      return mergeRoomMemoryText(raw);
    },
    []
  );

  const appendRoomMemory = useCallback((roomId: string, line: string) => {
    if (!roomId || typeof roomId !== "string") return false;
    const t = normalizeRoomMemoryLine(line);
    if (!t) return false;
    const prev = roomMemoryByRoomRef.current;
    const old = prev[roomId] ?? "";
    const nextText = mergeRoomMemoryText(old, t);
    if (nextText === old) return false;
    const next = { ...prev, [roomId]: nextText };
    roomMemoryByRoomRef.current = next;
    setRoomMemoryByRoom(next);
    return true;
  }, []);

  const setRoomMemoryText = useCallback((roomId: string, text: string) => {
    if (!roomId || typeof roomId !== "string") return;
    const normalized = String(text ?? "")
      .split("\n")
      .map((line) => normalizeRoomMemoryLine(line))
      .filter(Boolean)
      .join("\n");
    const prev = roomMemoryByRoomRef.current;
    const old = prev[roomId] ?? "";
    if (normalized === old) return;
    const next = { ...prev };
    if (normalized) next[roomId] = normalized;
    else delete next[roomId];
    roomMemoryByRoomRef.current = next;
    setRoomMemoryByRoom(next);
  }, []);

  const clearRoomMemory = useCallback(() => {
    roomMemoryByRoomRef.current = {};
    setRoomMemoryByRoom({});
  }, []);

  /** Refuse exploration tant qu'un hostile engagé a repéré le joueur (sécurité moteur). */
  const setGameMode = useCallback(
    (mode: GameMode, entitiesSnapshotForExplorationCheck?: Entity[], options?: { force?: boolean }) => {
      if (mode === "exploration" && !options?.force) {
        const ents = entitiesSnapshotForExplorationCheck ?? entitiesRef.current;
        if (ents.some((e) => isHostileReadyForCombat(e))) {
          console.warn(
            "[GameContext] Passage en exploration refusé : au moins un hostile engagé est encore présent."
          );
          return;
        }
      }
      gameModeRef.current = mode;
      gameModeUpdatedAtMsRef.current = Date.now();
      setGameModeState(mode);
    },
    []
  );

  const [combatOrder, setCombatOrderState] = useState<CombatEntry[]>([]);
  const [combatTurnIndex, setCombatTurnIndexState] = useState<number>(0);
  /** Miroir de `combatTurnWriteSeqRef` pour les effets React (même index numérique, nouveau « vrai » tour). */
  const [combatTurnWriteSeq, setCombatTurnWriteSeqState] = useState(0);
  /** Mis à jour dans le même tick que setCombatTurnIndex (avant re-render) pour buildSharedSessionPayloadSnapshot / flush MP. */
  const combatTurnIndexRef = useRef(0);
  /** S’incrémente à chaque changement d’index de tour local ; les snapshots avec un numéro plus bas sont ignorés (MP). */
  const combatTurnWriteSeqRef = useRef(0);
  const initiativeStateUpdatedAtMsRef = useRef<number>(0);
  /**
   * Dernier `initiativeStateUpdatedAtMs` après `setWaitForGmNarrationForInitiative(false)` (narration finie / déblocage).
   * Refuse les snapshots distants qui réarment `wait` avec un horodatage d’initiative ≤ à ce sceau (replay Firestore / autre client).
   */
  const waitNarrationClearBarrierMsRef = useRef(0);
  const bumpInitiativeStateUpdatedAtMs = useCallback(() => {
    const now = Date.now();
    initiativeStateUpdatedAtMsRef.current = now;
    return now;
  }, []);
  const setCombatOrder = useCallback<Dispatch<SetStateAction<CombatEntry[]>>>((next) => {
    bumpInitiativeStateUpdatedAtMs();
    setCombatOrderState((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      combatOrderRef.current = resolved;
      return resolved;
    });
  }, [bumpInitiativeStateUpdatedAtMs]);
  const setCombatTurnIndex = useCallback((next: number, opts?: { forceWriteSeq?: number; bumpSeq?: boolean }) => {
    const v = typeof next === "number" && Number.isFinite(next) ? Math.trunc(next) : 0;
    if (opts?.forceWriteSeq !== undefined && Number.isFinite(opts.forceWriteSeq)) {
      combatTurnWriteSeqRef.current = Math.max(combatTurnWriteSeqRef.current, Math.trunc(opts.forceWriteSeq));
    } else if (combatTurnIndexRef.current !== v || opts?.bumpSeq) {
      combatTurnWriteSeqRef.current += 1;
    }
    combatTurnIndexRef.current = v;
    setCombatTurnIndexState(v);
    setCombatTurnWriteSeqState(combatTurnWriteSeqRef.current);
  }, []);
  const [awaitingPlayerInitiative, setAwaitingPlayerInitiativeState] = useState(false);
  const setAwaitingPlayerInitiative = useCallback((value: boolean) => {
    const v = !!value;
    bumpInitiativeStateUpdatedAtMs();
    awaitingPlayerInitiativeRef.current = v;
    setAwaitingPlayerInitiativeState(v);
  }, [bumpInitiativeStateUpdatedAtMs]);
  /** Aligné sur le setter : mis à jour dans le même tick que l’état pour les snapshots Firestore (évite wait=true figé si flush part avant le commit React). */
  const waitForGmNarrationForInitiativeSyncRef = useRef(false);
  const [waitForGmNarrationForInitiative, setWaitForGmNarrationForInitiativeState] = useState(false);
  const setWaitForGmNarrationForInitiative = useCallback((value: boolean) => {
    const v = !!value;
    bumpInitiativeStateUpdatedAtMs();
    if (!v) {
      waitNarrationClearBarrierMsRef.current = initiativeStateUpdatedAtMsRef.current;
    }
    waitForGmNarrationForInitiativeSyncRef.current = v;
    waitForGmNarrationForInitiativeRef.current = v;
    setWaitForGmNarrationForInitiativeState(v);
  }, [bumpInitiativeStateUpdatedAtMs]);
  const [npcInitiativeDraft, setNpcInitiativeDraftState] = useState<CombatEntry[]>([]);
  const setNpcInitiativeDraft = useCallback((next: SetStateAction<CombatEntry[]>) => {
    bumpInitiativeStateUpdatedAtMs();
    setNpcInitiativeDraftState((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      npcInitiativeDraftRef.current = resolved;
      return resolved;
    });
  }, [bumpInitiativeStateUpdatedAtMs]);
  /** Jets d'initiative des PJs par id d'entité (synchronisés ; ordre final seulement quand tous ont jeté). */
  const [playerInitiativeRollsByEntityId, setPlayerInitiativeRollsByEntityIdState] = useState<
    Record<string, number>
  >({});
  const setPlayerInitiativeRollsByEntityId = useCallback((next: SetStateAction<Record<string, number>>) => {
    bumpInitiativeStateUpdatedAtMs();
    setPlayerInitiativeRollsByEntityIdState((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      playerInitiativeRollsByEntityIdRef.current = resolved;
      return resolved;
    });
  }, [bumpInitiativeStateUpdatedAtMs]);
  /** Refs alignés sur l’état combat / initiative pour les flush Firestore dans le même tick que setState. */
  const combatOrderRef = useRef<CombatEntry[]>(combatOrder);
  const awaitingPlayerInitiativeRef = useRef(awaitingPlayerInitiative);
  const npcInitiativeDraftRef = useRef(npcInitiativeDraft);
  const playerInitiativeRollsByEntityIdRef = useRef(playerInitiativeRollsByEntityId);
  const waitForGmNarrationForInitiativeRef = useRef(waitForGmNarrationForInitiative);
  combatOrderRef.current = combatOrder;
  combatTurnIndexRef.current = combatTurnIndex;
  awaitingPlayerInitiativeRef.current = awaitingPlayerInitiative;
  npcInitiativeDraftRef.current = npcInitiativeDraft;
  playerInitiativeRollsByEntityIdRef.current = playerInitiativeRollsByEntityId;
  waitForGmNarrationForInitiativeRef.current = waitForGmNarrationForInitiative;
  /** Cache du brouillon d'initiative PNJ (même tirage si l'effet remonte 2× — StrictMode). */
  const initiativeDraftCacheRef = useRef<CombatEntry[] | null>(null);
  /** Évite une double fusion d'initiative depuis l'effet « sync distante » (StrictMode / re-renders). */
  const initiativeRemoteFinalizeSigRef = useRef<string | null>(null);
  const combatNextTurnRef = useRef<(() => Promise<void>) | null>(null);
  const [engagedWithId, setEngagedWithId] = useState<string | null>(null);
  const [hasDisengagedThisTurn, setHasDisengagedThisTurn] = useState<boolean>(false);
  const [meleeState, setMeleeState] = useState<Record<string, string[]>>({});
  /**
   * Même graphe que `meleeState`, mis à jour **dans le même tick** que les mutations / le bump de seq.
   * Sinon les snapshots Firestore peuvent avoir `meleeEngagementSeq` à jour (ref) et `meleeState` `{}`
   * (React pas encore commit), ce qui écrase la mêlée chez les autres clients.
   */
  const meleeStateRef = useRef<Record<string, string[]>>({});
  /** Incrémenté à chaque mutation locale du graphe de mêlée ; les snapshots distants plus petits sont ignorés. */
  const meleeEngagementSeqRef = useRef(0);
  const [reactionState, setReactionState] = useState<Record<string, boolean>>({});
  const [combatHiddenIds, setCombatHiddenIdsState] = useState<string[]>([]);
  const combatHiddenIdsRef = useRef<string[]>([]);
  const setCombatHiddenIds = useCallback((next: SetStateAction<string[]>) => {
    setCombatHiddenIdsState((prev) => {
      const resolved = typeof next === "function" ? (next as (p: string[]) => string[])(prev) : next;
      const cleaned = Array.isArray(resolved)
        ? [...new Set(resolved.map((x) => String(x ?? "").trim()).filter(Boolean))]
        : [];
      combatHiddenIdsRef.current = cleaned;
      return cleaned;
    });
  }, []);
  const [combatStealthTotalByCombatantId, setCombatStealthTotalByCombatantIdState] = useState<
    Record<string, number>
  >({});
  const combatStealthTotalByCombatantIdRef = useRef<Record<string, number>>({});
  const setCombatStealthTotalForCombatant = useCallback((combatantId: string, total: number | null) => {
    const id = String(combatantId ?? "").trim();
    if (!id) return;
    setCombatStealthTotalByCombatantIdState((prev) => {
      const next = { ...prev };
      if (total == null || !Number.isFinite(total)) {
        delete next[id];
      } else {
        next[id] = Math.trunc(total);
      }
      combatStealthTotalByCombatantIdRef.current = next;
      return next;
    });
  }, []);
  const clearCombatStealthTotals = useCallback(() => {
    combatStealthTotalByCombatantIdRef.current = {};
    setCombatStealthTotalByCombatantIdState({});
  }, []);
  /** Applique un graphe de mêlée distant seulement s’il n’est pas périmé (meleeEngagementSeq / révision locale). */
  const applyIncomingMeleeStateIfNotStale = useCallback(
    (incoming: Record<string, string[]>, rawSeq: unknown, hasSeqInPayload: boolean) => {
      const remoteSeq =
        hasSeqInPayload && typeof rawSeq === "number" && Number.isFinite(rawSeq)
          ? Math.trunc(rawSeq as number)
          : -1;
      const localSeq = meleeEngagementSeqRef.current;
      const stale = remoteSeq >= 0 ? remoteSeq < localSeq : localSeq > 0;
      if (stale) return false;
      /** Même révision que locale mais graphe vide = snapshot hôte écrit avant commit React (voir meleeStateRef). */
      if (
        remoteSeq >= 0 &&
        remoteSeq === localSeq &&
        Object.keys(incoming).length === 0 &&
        Object.keys(meleeStateRef.current).length > 0
      ) {
        return false;
      }
      const normalized = normalizeMeleeStateTransitive(cloneMeleeStateRecord(incoming));
      meleeStateRef.current = normalized;
      setMeleeState(normalized);
      if (remoteSeq >= 0) {
        meleeEngagementSeqRef.current = Math.max(localSeq, remoteSeq);
      }
      return true;
    },
    [setMeleeState]
  );
  /** Ref mise à jour dans le setter (avant commit React) pour snapshots Firestore / persistance. */
  const turnResourcesByCombatantIdRef = useRef<TurnResourcesMap>({});
  const [turnResourcesByCombatantId, setTurnResourcesByCombatantIdState] =
    useState<TurnResourcesMap>({});
  /** Déclaré avant `setTurnResourcesForCombatant` (évite TDZ : le setter lit `multiplayerSessionId`). */
  const [multiplayerSessionId, setMultiplayerSessionId] = useState<string | null>(null);
  const setTurnResourcesForCombatant = useCallback(
    (combatantId: string, next: SetStateAction<TurnResources>) => {
      const id = String(combatantId ?? "").trim();
      if (!id) return;
      // Écrire d'abord dans le ref (source de vérité pour flush/snapshots même tick),
      // puis refléter dans l'état React.
      const cur = normalizeTurnResourcesInput(turnResourcesByCombatantIdRef.current[id]);
      const resolved =
        typeof next === "function" ? (next as (p: TurnResources) => TurnResources)(cur) : next;
      const normalized = normalizeTurnResourcesInput(resolved);
      const merged = { ...turnResourcesByCombatantIdRef.current, [id]: normalized };
      turnResourcesByCombatantIdRef.current = merged;
      // Pas de flushSync ici : interdit pendant rendu / effets (ex. useEffect qui réaligne le mouvement).
      setTurnResourcesByCombatantIdState(merged);
    },
    []
  );
  const [aiProvider, setAiProvider]         = useState<AiProvider>("gemini");
  const [debugMode, setDebugMode]           = useState<boolean>(false);
  const [currentSceneImage, setCurrentSceneImage] = useState<string>("/file.svg");
  const [imageModel, setImageModel] = useState<ImageModelId>("disabled");
  const [debugNextRoll, setDebugNextRoll]   = useState<number | null>(null);
  const [autoPlayerEnabled, setAutoPlayerEnabled] = useState<boolean>(false);
  const [autoRollEnabled, setAutoRollEnabled] = useState<boolean>(false);
  const [multiplayerConnected, setMultiplayerConnected] = useState<boolean>(false);
  const [multiplayerParticipants, setMultiplayerParticipants] = useState<number>(1);
  const [multiplayerParticipantClientIds, setMultiplayerParticipantClientIds] = useState<string[]>([]);
  const [multiplayerParticipantProfiles, setMultiplayerParticipantProfiles] = useState<SessionParticipantProfile[]>([]);
  const [multiplayerHostClientId, setMultiplayerHostClientId] = useState<string | null>(null);
  /** ID combattant du client courant — aligné sur `combatOrder` / initiative (voir `resolveLocalPlayerCombatantId`). */
  const localPlayerCombatantIdForMelee = useMemo(
    () =>
      resolveLocalPlayerCombatantId({
        player,
        entities,
        multiplayerSessionId,
        clientId,
      }),
    [player, entities, multiplayerSessionId, clientId]
  );
  const [multiplayerPendingCommand, setMultiplayerPendingCommand] = useState<MultiplayerPendingCommand | null>(null);
  const [multiplayerThinkingState, setMultiplayerThinkingStateLocal] = useState<MultiplayerThinkingState>({
    active: false,
    actor: null,
    label: null,
    byClientId: null,
    autoPlayerIntentAtMs: null,
  });

  /** false jusqu'à ce que la restauration localStorage ait été tentée (évite d'écraser la sauvegarde au premier rendu). */
  const [persistenceReady, setPersistenceReady] = useState(false);

  const messageSeqRef = useRef(0);
  const messagesStateRef = useRef<Message[]>(messages);
  /** Anti-boomerang carte initiative : une fois vue pendant un combat, ne pas la réinsérer en bas du chat. */
  const seenInitiativeCardsRef = useRef<Set<string>>(new Set());
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const participantProfileHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Sérialise les `flushMultiplayerSharedState` pour ne pas saturer la file d'écriture Firestore. */
  const flushWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  /**
   * Sérialise sur **ce** client toute prise de `processing` (jet, callApi MJ, etc.).
   * Même avec un verrou Firestore, deux opérations peuvent se chevaucher (latence, skipSessionLock côté
   * narration) ; la file évite deux `/api/chat` parallèles. Hors session Firestore, c’est le seul verrou
   * (campagne « un joueur connecté » = même structure de jeu).
   */
  const processingClientMutexTailRef = useRef<Promise<void>>(Promise.resolve());
  const processingLockMutexReleaseRef = useRef<Map<string, () => void>>(new Map());
  const applyingRemoteSessionRef = useRef(false);
  const lastSessionSnapshotHashRef = useRef<string>("");
  const lastSessionWriteHashRef = useRef<string>("");
  /** Invité : true après au moins un snapshot de session avec payload appliqué (évite d'écraser la vérité serveur avant la synchro initiale). */
  const hasReceivedPlayableSessionPayloadRef = useRef(false);
  /** Dernier `isGameStarted` vu côté payload distant (null = inconnu). Transition false→true : reset PJ depuis le template hors Combat partagé). */
  const remoteIsGameStartedRef = useRef<boolean | null>(null);
  /** Première application de `messages` depuis le snapshot distant (utile pour la rehydrate F5). */
  const firstRemoteMessagesAppliedRef = useRef(false);
  /** Snapshot immuable du personnage au moment de la sélection (sert aux resets d'aventure). */
  const playerInitialSnapshotRef = useRef<Player | null>(null);

  useEffect(() => {
    // Reset uniquement lors d'un vrai reset de session/partie, pas sur des bascules transitoires
    // exploration<->combat liées aux snapshots MP retardés.
    if (!multiplayerSessionId) return;
    if (!isGameStarted) {
      seenInitiativeCardsRef.current.clear();
    }
  }, [multiplayerSessionId, isGameStarted]);

  useEffect(() => {
    if (!awaitingPlayerInitiative) {
      setWaitForGmNarrationForInitiative(false);
    }
  }, [awaitingPlayerInitiative]);

  // Watchdog MP UX : parfois `thinkingState.active=true` (auto-player) reste figé côté client
  // alors que `pendingCommand` est déjà vide. En pratique, sans nouveau snapshot Firestore,
  // le gate auto-joueur ne retente jamais → on coupe localement après TTL.
  useEffect(() => {
    if (!multiplayerSessionId) return;
    if (!multiplayerThinkingState.active) return;
    if (multiplayerThinkingState.actor !== "auto-player") return;
    if (multiplayerPendingCommand?.id) return; // rien d'orphelin : une commande est encore là

    const intentAtMs =
      typeof multiplayerThinkingState.autoPlayerIntentAtMs === "number" &&
      Number.isFinite(multiplayerThinkingState.autoPlayerIntentAtMs)
        ? Math.trunc(multiplayerThinkingState.autoPlayerIntentAtMs)
        : null;

    const STALE_AUTO_LOCAL_CLEAR_MS = 8000;
    const ageMs = intentAtMs == null ? STALE_AUTO_LOCAL_CLEAR_MS + 1 : Date.now() - intentAtMs;
    const delayMs = Math.max(0, STALE_AUTO_LOCAL_CLEAR_MS - ageMs);

    const clear = () => {
      setMultiplayerThinkingStateLocal({
        active: false,
        actor: null,
        label: null,
        byClientId: null,
        autoPlayerIntentAtMs: null,
      });
    };

    const t = setTimeout(() => {
      // Re-check sur l'état courant avant de couper (évite d'interférer si ça a évolué).
      if (multiplayerPendingCommand?.id) return;
      if (!multiplayerThinkingState.active) return;
      if (multiplayerThinkingState.actor !== "auto-player") return;
      clear();
    }, delayMs);

    return () => clearTimeout(t);
  }, [
    multiplayerSessionId,
    multiplayerThinkingState.active,
    multiplayerThinkingState.actor,
    multiplayerThinkingState.autoPlayerIntentAtMs,
    multiplayerPendingCommand?.id,
  ]);

  const clonePlayer = useCallback((value: Player | null): Player | null => {
    if (!value) return null;
    try {
      return JSON.parse(JSON.stringify(value)) as Player;
    } catch {
      return value;
    }
  }, []);

  const setPlayer = useCallback((next: SetStateAction<Player | null>) => {
    setPlayerState((prev) => {
      const resolved = typeof next === "function" ? (next as (p: Player | null) => Player | null)(prev) : next;
      const normalized = normalizePlayerShape(resolved);
      // On capture le template uniquement hors aventure (sélection/menu).
      // Toujours rafraîchir si même id : sinon un ancien run (0 PV) reste figé pour resetToCampaignStart / nouvelle partie.
      if (!isGameStarted) {
        if (!normalized) {
          playerInitialSnapshotRef.current = null;
        } else {
          playerInitialSnapshotRef.current = clonePlayer(normalized);
        }
      }
      return normalized;
    });
  }, [clonePlayer, isGameStarted]);

  /**
   * Multijoueur : snapshot du PJ dans sessionStorage (même onglet).
   * Au reload avec `?session=`, `localStorage` jeu est ignoré — cette clé évite l’écran de sélection
   * et les PV « pleins » par défaut.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!multiplayerSessionId || !clientId) return;
    const sid = String(multiplayerSessionId).trim();
    const cid = String(clientId).trim();
    if (!sid || !cid) return;
    const key = `${MP_SESSION_PLAYER_STORAGE_PREFIX}:${sid}:${cid}`;
    if (!player) {
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      window.sessionStorage.setItem(key, JSON.stringify(player));
    } catch {
      /* quota */
    }
  }, [multiplayerSessionId, clientId, player]);

  const buildPersistedPayloadSnapshot = useCallback((): PersistedPayload => {
    return {
      player,
      worldTimeMinutes: worldTimeMinutesSyncRef.current,
      messages,
      pendingRoll: pendingRollRef.current,
      isGameStarted,
      currentSceneName: currentSceneNameLiveRef.current,
      currentScene: currentSceneLiveRef.current,
      currentRoomId: currentRoomIdLiveRef.current,
      sceneVersion,
      entities: entitiesRef.current,
      entitiesByRoom: { ...entitiesByRoomRef.current },
      roomMemoryByRoom: { ...roomMemoryByRoomRef.current },
      gameMode: gameModeRef.current,
      gameModeUpdatedAtMs: gameModeUpdatedAtMsRef.current,
      combatOrder,
      combatTurnIndex,
      combatTurnWriteSeq: combatTurnWriteSeqRef.current,
      initiativeStateUpdatedAtMs: initiativeStateUpdatedAtMsRef.current,
      engagedWithId,
      hasDisengagedThisTurn,
      meleeState: cloneMeleeStateRecord(meleeStateRef.current),
      reactionState,
      turnResourcesByCombatantId: { ...turnResourcesByCombatantIdRef.current },
      turnResources: turnResourcesMirrorFromMap(
        turnResourcesByCombatantIdRef.current,
        combatOrder,
        combatTurnIndex
      ),
      npcInitiativeDraft,
      playerInitiativeRollsByEntityId,
      awaitingPlayerInitiative,
      waitForGmNarrationForInitiative: waitForGmNarrationForInitiativeSyncRef.current,
      aiProvider,
      debugMode,
      currentSceneImage,
      imageModel,
      debugNextRoll,
      autoPlayerEnabled,
      autoRollEnabled,
      combatHiddenIds,
      combatStealthTotalByCombatantId: { ...combatStealthTotalByCombatantIdRef.current },
      meleeEngagementSeq: meleeEngagementSeqRef.current,
    };
  }, [
    player,
    messages,
    isGameStarted,
    sceneVersion,
    gameMode,
    combatOrder,
    combatTurnIndex,
    engagedWithId,
    hasDisengagedThisTurn,
    reactionState,
    npcInitiativeDraft,
    playerInitiativeRollsByEntityId,
    awaitingPlayerInitiative,
    aiProvider,
    debugMode,
    currentSceneImage,
    imageModel,
    debugNextRoll,
    autoPlayerEnabled,
    autoRollEnabled,
    combatHiddenIds,
    combatStealthTotalByCombatantId,
  ]);

  const buildSharedSessionPayloadSnapshot = useCallback((): SharedSessionPayload => {
    // Toutes les bulles moteur visibles localement doivent pouvoir être synchronisées (MP).
    // On tronque les contenus très longs (surtout debug) pour limiter la taille du document Firestore.
    // On exclut seulement `continue` (prompt interne de poursuite, pas une bulle joueur).
    const persistedMessages = sliceMessagesForSharedFirestorePayload(
      Array.isArray(messagesStateRef.current)
        ? messagesStateRef.current
            .filter((m) => String((m as any)?.type ?? "") !== "continue")
            .map((m) => truncateMessageForSharedPayload(m as Message))
        : [],
      FIRESTORE_SHARED_MESSAGES_CAP
    );
    const snapshot: SharedSessionPayload = {
      worldTimeMinutes: worldTimeMinutesSyncRef.current,
      messages: persistedMessages,
      pendingRoll: pendingRollRef.current,
      isGameStarted,
      currentSceneName: currentSceneNameLiveRef.current,
      currentScene: currentSceneLiveRef.current,
      currentRoomId: currentRoomIdLiveRef.current,
      sceneVersion,
      entities: entitiesRef.current,
      entitiesByRoom: { ...entitiesByRoomRef.current },
      roomMemoryByRoom: { ...roomMemoryByRoomRef.current },
      gameMode,
      combatOrder: combatOrderRef.current,
      combatTurnIndex: combatTurnIndexRef.current,
      combatTurnWriteSeq: combatTurnWriteSeqRef.current,
      initiativeStateUpdatedAtMs: initiativeStateUpdatedAtMsRef.current,
      engagedWithId,
      hasDisengagedThisTurn,
      meleeState: cloneMeleeStateRecord(meleeStateRef.current),
      reactionState,
      turnResourcesByCombatantId: { ...turnResourcesByCombatantIdRef.current },
      turnResources: turnResourcesMirrorFromMap(
        turnResourcesByCombatantIdRef.current,
        combatOrderRef.current,
        combatTurnIndexRef.current
      ),
      currentSceneImage,
      waitForGmNarrationForInitiative: waitForGmNarrationForInitiativeSyncRef.current,
      combatHiddenIds: combatHiddenIdsRef.current,
      combatStealthTotalByCombatantId: { ...combatStealthTotalByCombatantIdRef.current },
      meleeEngagementSeq: meleeEngagementSeqRef.current,
    };
    // Durcissement MP UX : le bandeau initiative côté UI dépend de `awaitingPlayerInitiative`.
    // On le sérialise systématiquement (true/false) pour éviter des snapshots partiels
    // où un client ne reçoit pas le flag au bon moment.
    snapshot.awaitingPlayerInitiative = !!awaitingPlayerInitiativeRef.current;
    if (awaitingPlayerInitiativeRef.current && npcInitiativeDraftRef.current.length > 0) {
      snapshot.npcInitiativeDraft = npcInitiativeDraftRef.current;
    }
    if (
      awaitingPlayerInitiativeRef.current &&
      Object.keys(playerInitiativeRollsByEntityIdRef.current).length > 0
    ) {
      snapshot.playerInitiativeRollsByEntityId = { ...playerInitiativeRollsByEntityIdRef.current };
    }
    return snapshot;
  }, [
    isGameStarted,
    sceneVersion,
    gameMode,
    engagedWithId,
    hasDisengagedThisTurn,
    reactionState,
    currentSceneImage,
    combatHiddenIds,
    combatStealthTotalByCombatantId,
  ]);

  const applySharedSessionPayload = useCallback((p: SharedSessionPayload) => {
    const prevRemoteIsGameStarted = remoteIsGameStartedRef.current;
    const nowRemoteIsGameStarted = !!p.isGameStarted;
    // `remoteIsGameStartedRef` vaut `null` au premier snapshot : avec `=== false` on ne détectait
    // jamais le passage salon→aventure → mergeSticky gardait le message « Session multijoueur… »
    // (meta-reply collant) même après lancement, tout en affichant l’UI « en jeu » / combat.
    const isStartingAdventureTransition =
      prevRemoteIsGameStarted !== true && nowRemoteIsGameStarted === true;
    const incomingRoomId = typeof p.currentRoomId === "string" ? p.currentRoomId.trim() : "";
    const isLobbyPayload = !p.isGameStarted && incomingRoomId === "lobby";
    const localRoomAtApplyStart = String(currentRoomIdLiveRef.current ?? "").trim();
    const localSceneVersionAtApplyStart = Math.trunc(Number(sceneVersionRef.current ?? 0) || 0);
    const localAlreadyInAdventure =
      localSceneVersionAtApplyStart > 0 ||
      (localRoomAtApplyStart !== "" && localRoomAtApplyStart !== "lobby");
    const payloadCarriesGameplayHints =
      ((Array.isArray(p.entities) && p.entities.length > 0) ||
        (Array.isArray(p.combatOrder) && p.combatOrder.length > 0) ||
        p.gameMode === "combat" ||
        (typeof p.worldTimeMinutes === "number" && Number.isFinite(p.worldTimeMinutes) && p.worldTimeMinutes > 0) ||
        (Array.isArray(p.messages) &&
          p.messages.some((m) => {
            const t = String((m as Message | null | undefined)?.type ?? "").trim();
            if (t === "enemy-turn" || t === "turn-end" || t === "turn-divider" || t === "dice") return true;
            const c = String((m as Message | null | undefined)?.content ?? "").toLowerCase();
            return c.includes("combat") || c.includes("initiative") || c.includes("attaque");
          })));
    const shouldIgnoreStaleLobbyPayload =
      isLobbyPayload && localAlreadyInAdventure && payloadCarriesGameplayHints;
    if (shouldIgnoreStaleLobbyPayload) {
      // Snapshot Firestore obsolète (retour salon) reçu après une partie déjà engagée :
      // l'appliquer remettrait currentRoomId=lobby et supprimerait les sorties visibles.
      return;
    }

    if (!skipRemotePendingRollApplyRef.current) {
      setWorldTimeMinutes(
        typeof p.worldTimeMinutes === "number" && Number.isFinite(p.worldTimeMinutes)
          ? Math.max(0, Math.trunc(p.worldTimeMinutes))
          : 0
      );
    }
    if (Array.isArray(p.messages) && !skipRemotePendingRollApplyRef.current) {
      const isFirstRemoteMessagesApply = !firstRemoteMessagesAppliedRef.current;
      const cleanedRemote = p.messages.filter((m) => (m as Message).type !== "scene-image-pending");
      const shouldKeepInitiativeCards =
        p.gameMode === "combat" ||
        p.awaitingPlayerInitiative === true ||
        (Array.isArray(p.combatOrder) && p.combatOrder.length > 0);
      const remoteForMerge = shouldKeepInitiativeCards
        ? cleanedRemote
        : cleanedRemote.filter(
            (m) => !(typeof m?.id === "string" && m.id.startsWith("initiative-order-"))
          );
      for (const m of remoteForMerge) {
        const mid = String(m?.id ?? "").trim();
        if (mid.startsWith("initiative-order-")) {
          seenInitiativeCardsRef.current.add(mid);
        }
      }

      const prev = Array.isArray(messagesStateRef.current) ? messagesStateRef.current : [];
      const localHasInitiativeDice = prev.some(
        (m) => typeof m?.id === "string" && m.id.startsWith("initiative-order-")
      );
      const remoteHasInitiativeDice = remoteForMerge.some(
        (m) => typeof m?.id === "string" && m.id.startsWith("initiative-order-")
      );

      // Au moment où on passe "salon" -> "aventure", on veut 100% refléter le snapshot distant.
      // Sinon, on peut conserver des "initiative-order-*" anciens (localStorage précédent) et
      // observer 2 messages d'initiative sur un seul client.
      // Hors transition : fusion pour ne pas effacer des bulles locales pas encore dans Firestore.
      //
      // Salon multijoueur (room lobby) : remplacer le journal — sinon mergeSticky garde d'anciens
      // messages de combat issus de la sauvegarde locale d'une autre session / partie solo.
      if (isStartingAdventureTransition || isLobbyPayload) {
        messagesStateRef.current = remoteForMerge;
        setMessages(remoteForMerge);
      } else if (remoteHasInitiativeDice) {
        const merged = mergeStickyLocalMessagesIntoRemote(prev, remoteForMerge);
        messagesStateRef.current = merged;
        if (!chatMessagesVisualEqual(prev, merged)) {
          setMessages(merged);
        }
      } else if (localHasInitiativeDice && shouldKeepInitiativeCards && isFirstRemoteMessagesApply) {
        const remoteIds = new Set(remoteForMerge.map((m) => String(m?.id ?? "").trim()).filter(Boolean));
        const localMissingInitiative = prev.filter(
          (m) =>
            typeof m?.id === "string" &&
            m.id.startsWith("initiative-order-") &&
            !remoteIds.has(String(m.id ?? "").trim())
        );
        const withInitiative = reinjectExplicitLocalMessagesIntoRemote(
          prev,
          remoteForMerge,
          localMissingInitiative
        );
        const merged = mergeStickyLocalMessagesIntoRemote(prev, withInitiative);
        messagesStateRef.current = merged;
        if (!chatMessagesVisualEqual(prev, merged)) {
          setMessages(merged);
        }
      } else {
        const merged = mergeStickyLocalMessagesIntoRemote(prev, remoteForMerge);
        messagesStateRef.current = merged;
        if (!chatMessagesVisualEqual(prev, merged)) {
          setMessages(merged);
        }
      }
      firstRemoteMessagesAppliedRef.current = true;
    }
    {
      let nextPr = p.pendingRoll ?? null;
      if (skipRemotePendingRollApplyRef.current) {
        nextPr = pendingRollRef.current;
      } else if (
        shouldRetainLocalDeathSavePendingRoll(
          !!multiplayerSessionId,
          nextPr,
          pendingRollRef.current,
          playerRef.current,
          clientId
        )
      ) {
        nextPr = pendingRollRef.current;
      } else if (
        shouldRetainLocalHitDiePendingRoll(
          !!multiplayerSessionId,
          nextPr,
          pendingRollRef.current,
          playerRef.current,
          clientId,
          (p.gameMode as GameMode | null | undefined) ?? (gameModeRef.current as GameMode | null | undefined)
        )
      ) {
        nextPr = pendingRollRef.current;
      } else if (
        shouldRetainLocalDirectedPendingRoll(
          !!multiplayerSessionId,
          nextPr,
          pendingRollRef.current,
          playerRef.current,
          clientId
        )
      ) {
        nextPr = pendingRollRef.current;
      } else if (
        !!multiplayerSessionId &&
        nextPr &&
        pendingRollRef.current &&
        nextPr.kind === "check" &&
        pendingRollRef.current.kind === "check" &&
        (nextPr.audience === "global" || nextPr.audience === "selected") &&
        (pendingRollRef.current.audience === "global" || pendingRollRef.current.audience === "selected") &&
        nextPr.returnToArbiter === true &&
        pendingRollRef.current.returnToArbiter === true &&
        globalSkillPendingRollSignature(nextPr) === globalSkillPendingRollSignature(pendingRollRef.current)
      ) {
        nextPr = mergeGlobalSkillCheckPendingRolls(nextPr, pendingRollRef.current);
      } else if (
        nextPr &&
        typeof nextPr === "object" &&
        nextPr.kind === "damage_roll" &&
        typeof nextPr.id === "string" &&
        isWeaponDamageRollIdResolved(nextPr.id)
      ) {
        // Snapshot Firestore en retard : réinjecte un jet de dégâts déjà résolu localement
        // (bulle 🎲 déjà affichée) → ne pas rebloquer la saisie.
        nextPr = null;
      }
      pendingRollRef.current = nextPr;
      setPendingRollState(nextPr);
    }
    setIsGameStarted(!!p.isGameStarted);
    const localRoomBeforeApply = currentRoomIdLiveRef.current;
    const localSvBeforeApply = sceneVersionRef.current;
    const remoteSv = typeof p.sceneVersion === "number" ? p.sceneVersion : 0;
    const canApplyRemoteSceneIdentity = remoteSv >= localSvBeforeApply;
    if (canApplyRemoteSceneIdentity) {
      setCurrentSceneName(typeof p.currentSceneName === "string" ? p.currentSceneName : DEFAULT_SCENE_NAME);
      setCurrentScene(typeof p.currentScene === "string" ? p.currentScene : DEFAULT_SCENE_DESCRIPTION);
      setCurrentRoomId(typeof p.currentRoomId === "string" ? p.currentRoomId : "scene_village");
    } else {
      // Snapshot partagé en retard : ne pas écraser la salle/scène locales déjà plus récentes.
      setCurrentSceneName(currentSceneNameLiveRef.current);
      setCurrentScene(currentSceneLiveRef.current);
      setCurrentRoomId(localRoomBeforeApply);
    }
    const loadedEntities = Array.isArray(p.entities) ? normalizeLoadedEntitiesList(p.entities) : [];
    let hostileCheckEntities: Entity[] = loadedEntities;
    if (Array.isArray(p.entities)) {
      const prevEnts = (entitiesRef.current ?? []) as Entity[];
      // Toujours fusionner : `mergeIncomingEntitiesHpWithPrev` empêche un snapshot Firestore « en retard »
      // (PV encore pleins avant flush local) d'écraser des dégâts déjà appliqués ici (ic > pc → garde pc).
      // Si on ignorait tout le bloc pendant skipRemotePendingRollApplyRef, un autre joueur pouvait avoir
      // flushé des PV corrects pendant qu'on résout un jet : ce client restait sur d'anciens PV jusqu'à +900 ms
      // après le jet → attaques et dégâts calculés sur une cible fantôme à PV max.
      const mergedEntities = mergeHostilesFromPrevWhenRemoteStale(
        prevEnts,
        loadedEntities,
        p,
        localRoomBeforeApply,
        localSvBeforeApply
      );
      const mergedWithLocalHp = mergeIncomingEntitiesHpWithPrev(prevEnts, mergedEntities);
      const incomingEmpty = mergedWithLocalHp.length === 0;
      const skipEmptyWipe =
        incomingEmpty &&
        prevEnts.length > 0 &&
        prevEnts.some((e) => isHostileReadyForCombat(e)) &&
        p.gameMode === "combat" &&
        (!Array.isArray(p.combatOrder) || p.combatOrder.length === 0);
      if (!skipEmptyWipe) {
        entitiesRef.current = mergedWithLocalHp as Entity[];
        setEntities(mergedWithLocalHp as Entity[]);
        hostileCheckEntities = mergedWithLocalHp;
      } else {
        hostileCheckEntities = prevEnts;
      }
    }
    setSceneVersion(Math.max(remoteSv, localSvBeforeApply));

    if (!skipRemotePendingRollApplyRef.current) {
      if (p.entitiesByRoom && typeof p.entitiesByRoom === "object" && !Array.isArray(p.entitiesByRoom)) {
        const nextMap: Record<string, Entity[]> = {};
        for (const [k, v] of Object.entries(p.entitiesByRoom)) {
          if (!k || !Array.isArray(v)) continue;
          nextMap[k] = normalizeLoadedEntitiesList(v);
        }
        entitiesByRoomRef.current = nextMap;
      } else {
        entitiesByRoomRef.current = {};
      }
    }
    if (p.roomMemoryByRoom && typeof p.roomMemoryByRoom === "object" && !Array.isArray(p.roomMemoryByRoom)) {
      const mem: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.roomMemoryByRoom)) {
        if (!k || typeof v !== "string") continue;
        const trimmed = v.trim();
        if (trimmed) mem[k] = mergeRoomMemoryText(trimmed);
      }
      roomMemoryByRoomRef.current = mem;
      setRoomMemoryByRoom(mem);
    } else {
      roomMemoryByRoomRef.current = {};
      setRoomMemoryByRoom({});
    }
    const hostileAlive = hostileCheckEntities.some((e) => isHostileReadyForCombat(e));
    const hasCombatOrder = Array.isArray(p.combatOrder) && p.combatOrder.length > 0;
    const preserveCombatFromPayload = p.gameMode === "combat" && hasCombatOrder;
    const inInitiativePhase = p.awaitingPlayerInitiative === true;
    if (p.gameMode === "combat" || p.gameMode === "exploration" || p.gameMode === "short_rest") {
      const incomingModeMs =
        typeof p.gameModeUpdatedAtMs === "number" && Number.isFinite(p.gameModeUpdatedAtMs)
          ? Math.trunc(p.gameModeUpdatedAtMs)
          : 0;
      if (incomingModeMs < gameModeUpdatedAtMsRef.current) {
        // Snapshot mode plus ancien que le dernier mode local déjà appliqué.
      } else {
        gameModeUpdatedAtMsRef.current = incomingModeMs;
        const want = p.gameMode;
      // Repos court : le snapshot partagé est la source de vérité — ne pas l'écraser en « combat »
      // parce qu'encore des hostiles vivants / un vieux combatOrder (sinon MJ reste en exploration).
        if (want === "short_rest") {
          setGameModeState("short_rest");
        } else if (!hostileAlive && !preserveCombatFromPayload) {
          // Ordre d'initiative distant souvent encore rempli alors que tous les hostiles sont morts :
          // sans ce garde, `hasCombatOrder` seul forçait le mode combat indéfiniment.
          setGameModeState("exploration");
        } else {
          const shouldCombat =
            hasCombatOrder ||
            (hostileAlive && (want === "combat" || inInitiativePhase));
          setGameModeState(shouldCombat ? "combat" : want);
        }
      }
    }
    const prevCombatTurnIdxBeforeApply = combatTurnIndexRef.current;
    const prevCombatOrderSnapshot = Array.isArray(combatOrderRef.current)
      ? combatOrderRef.current.map((e) => ({ id: e?.id, name: e?.name, initiative: e?.initiative }))
      : [];
    // Ne pas défaut à 0 si le champ est absent : certains snapshots Firestore sont partiels
    // et `undefined` deviendrait 0 → prev (ex: 1) !== incoming (0) → sameCombatSegment faux
    // → mergedMap = remoteMap seul → efface movement:false sur mp-player-* (flicker Mouvement).
    const incomingCombatTurnIdx =
      typeof p.combatTurnIndex === "number" && Number.isFinite(p.combatTurnIndex)
        ? Math.trunc(p.combatTurnIndex)
        : prevCombatTurnIdxBeforeApply;
    const incomingTurnWriteSeq =
      typeof p.combatTurnWriteSeq === "number" && Number.isFinite(p.combatTurnWriteSeq)
        ? Math.trunc(p.combatTurnWriteSeq)
        : null;
    const hasAuthoritativeIncomingTurnSeq =
      incomingTurnWriteSeq !== null || combatTurnWriteSeqRef.current <= 0;
    /** Snapshot plus ancien que nos derniers commits locaux d’index — ne pas réappliquer l’index (vas-et-vient initiative). */
    const staleCombatTurnWrite =
      incomingTurnWriteSeq !== null && incomingTurnWriteSeq < combatTurnWriteSeqRef.current;
    const incomingInitiativeMs =
      typeof p.initiativeStateUpdatedAtMs === "number" && Number.isFinite(p.initiativeStateUpdatedAtMs)
        ? Math.trunc(p.initiativeStateUpdatedAtMs)
        : 0;
    const hasCombatOrderInPayload = Array.isArray(p.combatOrder) && p.combatOrder.length > 0;
    const hasAnyInitiativeRollInPayload =
      p.playerInitiativeRollsByEntityId &&
      typeof p.playerInitiativeRollsByEntityId === "object" &&
      !Array.isArray(p.playerInitiativeRollsByEntityId) &&
      Object.keys(p.playerInitiativeRollsByEntityId as Record<string, number>).length > 0;
    // Anti-stale : par défaut on n'applique que si le snapshot est >= local,
    // mais on force l'application si le serveur a déjà progressé l'initiative
    // (ordre final / rolls déjà reçus) : sinon l'UI redemande à tort sur reload.
    const canApplyIncomingInitiative =
      incomingInitiativeMs >= initiativeStateUpdatedAtMsRef.current || hasCombatOrderInPayload || hasAnyInitiativeRollInPayload;
    /** Ref locale (bump clear-wait, etc.) avant ce merge — ne pas réarmer `wait` depuis un snapshot plus vieux. */
    const initiativeMsBaselineBeforeInitiativeMerge = initiativeStateUpdatedAtMsRef.current;
    if (canApplyIncomingInitiative) {
      initiativeStateUpdatedAtMsRef.current = Math.max(
        initiativeStateUpdatedAtMsRef.current,
        incomingInitiativeMs
      );
      if (!hostileAlive && !preserveCombatFromPayload) {
        setCombatOrderState([]);
        combatOrderRef.current = [];
        combatTurnWriteSeqRef.current = 0;
        combatTurnIndexRef.current = 0;
        setCombatTurnIndexState(0);
        setCombatTurnWriteSeqState(0);
      } else if (Array.isArray(p.combatOrder)) {
        const incomingCombatOrder = p.combatOrder;
        const localCombatOrderLen = Array.isArray(combatOrderRef.current) ? combatOrderRef.current.length : 0;
        const shouldIgnoreTransientEmptyCombatOrder =
          incomingCombatOrder.length === 0 &&
          localCombatOrderLen > 0 &&
          (hostileAlive || preserveCombatFromPayload);
        if (!shouldIgnoreTransientEmptyCombatOrder && hasAuthoritativeIncomingTurnSeq) {
          setCombatOrderState(incomingCombatOrder);
          combatOrderRef.current = incomingCombatOrder;
          if (!staleCombatTurnWrite) {
            setCombatTurnIndex(
              incomingCombatTurnIdx,
              incomingTurnWriteSeq !== null ? { forceWriteSeq: incomingTurnWriteSeq } : undefined
            );
          }
        }
      } else if (!staleCombatTurnWrite && hasAuthoritativeIncomingTurnSeq) {
        setCombatTurnIndex(
          incomingCombatTurnIdx,
          incomingTurnWriteSeq !== null ? { forceWriteSeq: incomingTurnWriteSeq } : undefined
        );
      }

      if (Array.isArray(p.combatOrder) && p.combatOrder.length > 0) {
        awaitingPlayerInitiativeRef.current = false;
        setAwaitingPlayerInitiativeState(false);
        waitForGmNarrationForInitiativeSyncRef.current = false;
        waitForGmNarrationForInitiativeRef.current = false;
        setWaitForGmNarrationForInitiativeState(false);
        playerInitiativeRollsByEntityIdRef.current = {};
        setPlayerInitiativeRollsByEntityIdState({});
        npcInitiativeDraftRef.current = [];
        setNpcInitiativeDraftState([]);
        initiativeDraftCacheRef.current = null;
        initiativeRemoteFinalizeSigRef.current = null;
      } else {
        if (Array.isArray(p.npcInitiativeDraft) && p.npcInitiativeDraft.length > 0) {
          initiativeDraftCacheRef.current = p.npcInitiativeDraft;
          const nextDraft = p.npcInitiativeDraft.map((entry) => ({
            ...entry,
            name: resolveCombatantDisplayName(entry, entitiesRef.current ?? [], null),
          }));
          npcInitiativeDraftRef.current = nextDraft;
          setNpcInitiativeDraftState(nextDraft);
        }
        if (
          p.playerInitiativeRollsByEntityId &&
          typeof p.playerInitiativeRollsByEntityId === "object" &&
          !Array.isArray(p.playerInitiativeRollsByEntityId)
        ) {
          // Multi-joueurs : on fusionne (union) les jets reçus.
          // Les snapshots Firestore peuvent être partiels (un client n'a pas encore tous les rolls),
          // sinon on perd des clés et on court-circuite / bloque l'attente.
          const incoming = { ...(p.playerInitiativeRollsByEntityId as Record<string, number>) };
          const merged = { ...(playerInitiativeRollsByEntityIdRef.current ?? {}), ...incoming };
          playerInitiativeRollsByEntityIdRef.current = merged;
          setPlayerInitiativeRollsByEntityIdState(merged);
        }
        if (typeof p.awaitingPlayerInitiative === "boolean") {
          if (!p.awaitingPlayerInitiative) {
            const trustIncomingAwaitingFalse =
              incomingInitiativeMs >= initiativeMsBaselineBeforeInitiativeMerge ||
              hasCombatOrderInPayload;
            if (trustIncomingAwaitingFalse) {
              awaitingPlayerInitiativeRef.current = false;
              setAwaitingPlayerInitiativeState(false);
            }
          } else {
            const nextAwaiting = (hostileAlive || hasCombatOrder) && p.awaitingPlayerInitiative;
            awaitingPlayerInitiativeRef.current = nextAwaiting;
            setAwaitingPlayerInitiativeState(nextAwaiting);
          }
        } else if (!hostileAlive && !hasCombatOrder) {
          awaitingPlayerInitiativeRef.current = false;
          setAwaitingPlayerInitiativeState(false);
        }
        if (typeof p.waitForGmNarrationForInitiative === "boolean") {
          const incomingWait = !!p.waitForGmNarrationForInitiative;
          let nextWait: boolean;
          if (!incomingWait) {
            nextWait = false;
          } else {
            const barrierMs = waitNarrationClearBarrierMsRef.current;
            const mayRearmNarrationWait =
              hasCombatOrderInPayload ||
              incomingInitiativeMs > barrierMs ||
              barrierMs === 0;
            nextWait = !!((hostileAlive || hasCombatOrder) && mayRearmNarrationWait);
          }
          waitForGmNarrationForInitiativeSyncRef.current = nextWait;
          waitForGmNarrationForInitiativeRef.current = nextWait;
          setWaitForGmNarrationForInitiativeState(nextWait);
        } else if (!hostileAlive && !hasCombatOrder) {
          waitForGmNarrationForInitiativeSyncRef.current = false;
          waitForGmNarrationForInitiativeRef.current = false;
          setWaitForGmNarrationForInitiativeState(false);
        }
      }
    }

    // Snapshots Firestore peuvent être partiels : sans clé, ne pas écraser l'état local
    // (sinon `undefined` → null effaçait engagedWithId / mêlée à chaque sync).
    if (Object.prototype.hasOwnProperty.call(p, "engagedWithId")) {
      setEngagedWithId(p.engagedWithId ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(p, "hasDisengagedThisTurn")) {
      setHasDisengagedThisTurn(!!p.hasDisengagedThisTurn);
    }
    if (Object.prototype.hasOwnProperty.call(p, "meleeState") && p.meleeState && typeof p.meleeState === "object") {
      const rawSeq = (p as SharedSessionPayload & { meleeEngagementSeq?: number }).meleeEngagementSeq;
      applyIncomingMeleeStateIfNotStale(
        p.meleeState,
        rawSeq,
        Object.prototype.hasOwnProperty.call(p, "meleeEngagementSeq")
      );
    }
    if (p.reactionState && typeof p.reactionState === "object") setReactionState(p.reactionState);
    if (Array.isArray(p.combatHiddenIds)) {
      setCombatHiddenIds(p.combatHiddenIds.map((x) => String(x ?? "").trim()).filter(Boolean));
    }
    if (p.combatStealthTotalByCombatantId && typeof p.combatStealthTotalByCombatantId === "object") {
      const cleaned: Record<string, number> = {};
      for (const [k, v] of Object.entries(p.combatStealthTotalByCombatantId)) {
        const id = String(k ?? "").trim();
        if (!id) continue;
        if (typeof v === "number" && Number.isFinite(v)) cleaned[id] = Math.trunc(v);
      }
      combatStealthTotalByCombatantIdRef.current = cleaned;
      setCombatStealthTotalByCombatantIdState(cleaned);
    }
    if (!skipRemotePendingRollApplyRef.current) {
      const trById = p.turnResourcesByCombatantId;
      const hasRemoteTurnResources =
        (p.turnResources && typeof p.turnResources === "object") ||
        (trById &&
          typeof trById === "object" &&
          !Array.isArray(trById) &&
          Object.keys(trById as object).length > 0);
      if (hasRemoteTurnResources) {
        let remoteMap = migratePayloadTurnResourcesToMap(p);
        // MP : le payload distant peut n'avoir que la clé legacy `player` alors que l'UI / le moteur
        // utilisent `mp-player-<clientId>`. Sans alias, la fusion ne voit pas la même entrée et
        // `mergedMap = remoteMap` (hors segment) peut effacer la clé locale → mouvement « réinitialisé ».
        const me = String(clientId ?? "").trim();
        if (multiplayerSessionId && me) {
          const mpId = `mp-player-${me}`;
          const legacyPlayer = remoteMap["player"];
          if (legacyPlayer != null && remoteMap[mpId] == null) {
            remoteMap = {
              ...remoteMap,
              [mpId]: normalizeTurnResourcesInput(legacyPlayer as TurnResources),
            };
          }
        }
        const localMap = { ...turnResourcesByCombatantIdRef.current };
        // Solo : sans cette condition, `sameCombatSegment` était toujours faux → on remplaçait
        // tout l'état local par le snapshot (souvent périmé) et on perdait ex. movement:false.
        // Si on a ignoré un index distant périmé (staleCombatTurnWrite), on reste sur le segment local.
        const sameCombatSegment =
          p.gameMode === "combat" &&
          (staleCombatTurnWrite || prevCombatTurnIdxBeforeApply === incomingCombatTurnIdx);
        let mergedMap: TurnResourcesMap = sameCombatSegment
          ? mergeTurnResourcesMapSameCombatSegment(localMap, remoteMap)
          : { ...localMap, ...remoteMap };
        // MP : le ref local du PJ courant est à jour (effet « début de tour » + consommations)
        // avant un snapshot Firestore souvent encore à l'état précédent. La fusion AND
        // (local.action && remote.action) ou un remoteMap incomplet faisait perdre action/réaction.
        if (multiplayerSessionId && me) {
          const mpId = `mp-player-${me}`;
          const selfLocal = localMap[mpId];
          const sheetId = String(playerRef.current?.id ?? "").trim();
          const prevLen = prevCombatOrderSnapshot.length;
          const prevIdxClamp =
            prevLen > 0
              ? Math.min(Math.max(0, prevCombatTurnIdxBeforeApply), prevLen - 1)
              : -1;
          const prevActiveId =
            prevIdxClamp >= 0 ? String(prevCombatOrderSnapshot[prevIdxClamp]?.id ?? "").trim() : "";
          const coIncoming = Array.isArray(p.combatOrder) ? p.combatOrder : [];
          const incIdxClamp =
            coIncoming.length > 0
              ? Math.min(Math.max(0, incomingCombatTurnIdx), coIncoming.length - 1)
              : -1;
          const incomingActiveId =
            incIdxClamp >= 0 ? String(coIncoming[incIdxClamp]?.id ?? "").trim() : "";
          const imActiveNow =
            !!incomingActiveId &&
            (incomingActiveId === mpId || (!!sheetId && incomingActiveId === sheetId));
          const wasSomeoneElse =
            !!prevActiveId &&
            prevActiveId !== mpId &&
            (!sheetId || prevActiveId !== sheetId);
          const justBecameMyTurn = imActiveNow && wasSomeoneElse;
          const surprisedLocal = playerRef.current?.surprised === true;
          // 1) Snapshot avec mpId encore en « fin de tour » écrasait le grant local.
          // 2) Premier snapshot du nouveau tour avant l'effet React qui restaure les ressources.
          if (imActiveNow && !surprisedLocal) {
            const remoteSelf = remoteMap[mpId];
            const remoteCoreSpentOrMissing =
              remoteSelf == null || isTurnResourcesCoreSpent(remoteSelf);
            if (
              justBecameMyTurn &&
              isTurnResourcesCoreSpent(mergedMap[mpId]) &&
              remoteCoreSpentOrMissing
            ) {
              mergedMap = {
                ...mergedMap,
                [mpId]: normalizeTurnResourcesInput({
                  action: true,
                  bonus: true,
                  reaction: true,
                  movement: true,
                }),
              };
            } else if (selfLocal) {
              mergedMap = {
                ...mergedMap,
                [mpId]: normalizeTurnResourcesInput(selfLocal),
              };
            }
          }
        }
        turnResourcesByCombatantIdRef.current = mergedMap;
        setTurnResourcesByCombatantIdState(mergedMap);
      }
    }
    if (typeof p.currentSceneImage === "string") setCurrentSceneImage(p.currentSceneImage);

    const prevRemote = remoteIsGameStartedRef.current;
    const nowRemote = !!p.isGameStarted;
    if (prevRemote === false && nowRemote === true) {
      setPlayerState((prev) => {
        const seed = clonePlayer(playerInitialSnapshotRef.current) ?? clonePlayer(prev);
        if (!seed?.hp) return prev;
        const restored = resetRemainingResourcesDeep(seed);
        return {
          ...restored,
          isAlive: true,
          hp: { ...restored.hp, current: restored.hp.max },
          hitDiceRemaining: restored.hitDiceTotal ?? restored.level ?? 1,
          deathState: normalizeDeathState(null, restored.hp.max),
          lastLongRestFinishedAtMinute: null,
        };
      });
      if (multiplayerSessionId) {
        lastLocalParticipantProfilePushAtMsRef.current = Date.now();
      }
    }
    remoteIsGameStartedRef.current = nowRemote;
  }, [clonePlayer, clientId, multiplayerSessionId, applyIncomingMeleeStateIfNotStale]);

  const applyPersistedPayload = useCallback((p: PersistedPayload) => {
    setPlayerState(normalizePlayerShape(p.player ?? null));
    setWorldTimeMinutes(
      typeof p.worldTimeMinutes === "number" && Number.isFinite(p.worldTimeMinutes)
        ? Math.max(0, Math.trunc(p.worldTimeMinutes))
        : 0
    );
    if (Array.isArray(p.messages)) {
      const cleaned = p.messages.filter((m) => (m as Message).type !== "scene-image-pending");
      messagesStateRef.current = cleaned;
      setMessages(cleaned);
    }
    {
      const nextPr = p.pendingRoll ?? null;
      pendingRollRef.current = nextPr;
      setPendingRollState(nextPr);
    }
    setIsGameStarted(!!p.isGameStarted);
    setCurrentSceneName(typeof p.currentSceneName === "string" ? p.currentSceneName : DEFAULT_SCENE_NAME);
    setCurrentScene(typeof p.currentScene === "string" ? p.currentScene : DEFAULT_SCENE_DESCRIPTION);
    setCurrentRoomId(typeof p.currentRoomId === "string" ? p.currentRoomId : "scene_village");
    setSceneVersion(typeof p.sceneVersion === "number" ? p.sceneVersion : 0);
    const loadedEntities = Array.isArray(p.entities) ? normalizeLoadedEntitiesList(p.entities) : [];
    if (Array.isArray(p.entities)) {
      entitiesRef.current = loadedEntities as Entity[];
      setEntities(loadedEntities as Entity[]);
    }

    if (p.entitiesByRoom && typeof p.entitiesByRoom === "object" && !Array.isArray(p.entitiesByRoom)) {
      const nextMap: Record<string, Entity[]> = {};
      for (const [k, v] of Object.entries(p.entitiesByRoom)) {
        if (!k || !Array.isArray(v)) continue;
        nextMap[k] = normalizeLoadedEntitiesList(v);
      }
      entitiesByRoomRef.current = nextMap;
    } else {
      entitiesByRoomRef.current = {};
    }
    if (p.roomMemoryByRoom && typeof p.roomMemoryByRoom === "object" && !Array.isArray(p.roomMemoryByRoom)) {
      const mem: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.roomMemoryByRoom)) {
        if (!k || typeof v !== "string") continue;
        const trimmed = v.trim();
        if (trimmed) mem[k] = mergeRoomMemoryText(trimmed);
      }
      roomMemoryByRoomRef.current = mem;
      setRoomMemoryByRoom(mem);
    } else {
      roomMemoryByRoomRef.current = {};
      setRoomMemoryByRoom({});
    }
    const hostileAlive = loadedEntities.some((e) => isHostileReadyForCombat(e));
    const hasCombatOrder = Array.isArray(p.combatOrder) && p.combatOrder.length > 0;
    const preserveCombatFromPayload = p.gameMode === "combat" && hasCombatOrder;
    const inInitiativePhase = p.awaitingPlayerInitiative === true;
    if (p.gameMode === "combat" || p.gameMode === "exploration" || p.gameMode === "short_rest") {
      const incomingModeMs =
        typeof p.gameModeUpdatedAtMs === "number" && Number.isFinite(p.gameModeUpdatedAtMs)
          ? Math.trunc(p.gameModeUpdatedAtMs)
          : 0;
      if (incomingModeMs >= gameModeUpdatedAtMsRef.current) {
        gameModeUpdatedAtMsRef.current = incomingModeMs;
        const want = p.gameMode;
        if (want === "short_rest") {
          setGameModeState("short_rest");
        } else if (!hostileAlive && !preserveCombatFromPayload) {
          setGameModeState("exploration");
        } else {
          const shouldCombat =
            hasCombatOrder ||
            (hostileAlive && (want === "combat" || inInitiativePhase));
          setGameModeState(shouldCombat ? "combat" : want);
        }
      }
    }
    {
      const incomingInitiativeMsP =
        typeof p.initiativeStateUpdatedAtMs === "number" && Number.isFinite(p.initiativeStateUpdatedAtMs)
          ? Math.trunc(p.initiativeStateUpdatedAtMs)
          : 0;
      const hasCombatOrderInPayloadP = Array.isArray(p.combatOrder) && p.combatOrder.length > 0;
      const hasAnyInitiativeRollInPayloadP =
        p.playerInitiativeRollsByEntityId &&
        typeof p.playerInitiativeRollsByEntityId === "object" &&
        !Array.isArray(p.playerInitiativeRollsByEntityId) &&
        Object.keys(p.playerInitiativeRollsByEntityId as Record<string, number>).length > 0;
      const canApplyIncomingInitiativeP =
        incomingInitiativeMsP >= initiativeStateUpdatedAtMsRef.current ||
        hasCombatOrderInPayloadP ||
        hasAnyInitiativeRollInPayloadP;
      const initiativeMsBaselineBeforePersistInitiativeMerge = initiativeStateUpdatedAtMsRef.current;
      const incomingTurnWriteSeqP =
        typeof p.combatTurnWriteSeq === "number" && Number.isFinite(p.combatTurnWriteSeq)
          ? Math.trunc(p.combatTurnWriteSeq)
          : null;
      const hasAuthoritativeIncomingTurnSeqP =
        incomingTurnWriteSeqP !== null || combatTurnWriteSeqRef.current <= 0;
      const staleCombatTurnWriteP =
        incomingTurnWriteSeqP !== null && incomingTurnWriteSeqP < combatTurnWriteSeqRef.current;
      if (canApplyIncomingInitiativeP) {
        initiativeStateUpdatedAtMsRef.current = Math.max(
          initiativeStateUpdatedAtMsRef.current,
          incomingInitiativeMsP
        );
        if (!hostileAlive && !preserveCombatFromPayload) {
          setCombatOrderState([]);
          combatOrderRef.current = [];
          combatTurnWriteSeqRef.current = 0;
          combatTurnIndexRef.current = 0;
          setCombatTurnIndexState(0);
          setCombatTurnWriteSeqState(0);
        } else if (Array.isArray(p.combatOrder)) {
          const incomingCombatOrderP = p.combatOrder;
          const localCombatOrderLenP = Array.isArray(combatOrderRef.current) ? combatOrderRef.current.length : 0;
          const shouldIgnoreTransientEmptyCombatOrderP =
            incomingCombatOrderP.length === 0 &&
            localCombatOrderLenP > 0 &&
            (hostileAlive || preserveCombatFromPayload);
          if (!shouldIgnoreTransientEmptyCombatOrderP && hasAuthoritativeIncomingTurnSeqP) {
            setCombatOrderState(incomingCombatOrderP);
            combatOrderRef.current = incomingCombatOrderP;
            if (!staleCombatTurnWriteP) {
              const idx =
                typeof p.combatTurnIndex === "number" && Number.isFinite(p.combatTurnIndex)
                  ? Math.trunc(p.combatTurnIndex)
                  : 0;
              setCombatTurnIndex(
                idx,
                incomingTurnWriteSeqP !== null ? { forceWriteSeq: incomingTurnWriteSeqP } : undefined
              );
            }
          }
        } else if (!staleCombatTurnWriteP && hasAuthoritativeIncomingTurnSeqP) {
          const idx =
            typeof p.combatTurnIndex === "number" && Number.isFinite(p.combatTurnIndex)
              ? Math.trunc(p.combatTurnIndex)
              : 0;
          setCombatTurnIndex(
            idx,
            incomingTurnWriteSeqP !== null ? { forceWriteSeq: incomingTurnWriteSeqP } : undefined
          );
        }
      }

    if (canApplyIncomingInitiativeP) {
      if (Array.isArray(p.combatOrder) && p.combatOrder.length > 0) {
        awaitingPlayerInitiativeRef.current = false;
        setAwaitingPlayerInitiativeState(false);
        waitForGmNarrationForInitiativeSyncRef.current = false;
        waitForGmNarrationForInitiativeRef.current = false;
        setWaitForGmNarrationForInitiativeState(false);
        playerInitiativeRollsByEntityIdRef.current = {};
        setPlayerInitiativeRollsByEntityIdState({});
        npcInitiativeDraftRef.current = [];
        setNpcInitiativeDraftState([]);
        initiativeDraftCacheRef.current = null;
        initiativeRemoteFinalizeSigRef.current = null;
      } else {
        if (Array.isArray(p.npcInitiativeDraft) && p.npcInitiativeDraft.length > 0) {
          initiativeDraftCacheRef.current = p.npcInitiativeDraft;
          const nextDraft = p.npcInitiativeDraft.map((entry) => ({
            ...entry,
            name: resolveCombatantDisplayName(entry, entitiesRef.current ?? [], null),
          }));
          npcInitiativeDraftRef.current = nextDraft;
          setNpcInitiativeDraftState(nextDraft);
        }
        if (
          p.playerInitiativeRollsByEntityId &&
          typeof p.playerInitiativeRollsByEntityId === "object" &&
          !Array.isArray(p.playerInitiativeRollsByEntityId)
        ) {
          const nextRolls = { ...p.playerInitiativeRollsByEntityId };
          playerInitiativeRollsByEntityIdRef.current = nextRolls;
          setPlayerInitiativeRollsByEntityIdState(nextRolls);
        }
        if (typeof p.awaitingPlayerInitiative === "boolean") {
          if (!p.awaitingPlayerInitiative) {
            const trustIncomingAwaitingFalseP =
              incomingInitiativeMsP >= initiativeMsBaselineBeforePersistInitiativeMerge ||
              hasCombatOrderInPayloadP;
            if (trustIncomingAwaitingFalseP) {
              awaitingPlayerInitiativeRef.current = false;
              setAwaitingPlayerInitiativeState(false);
            }
          } else {
            const nextAwaiting = (hostileAlive || hasCombatOrder) && p.awaitingPlayerInitiative;
            awaitingPlayerInitiativeRef.current = nextAwaiting;
            setAwaitingPlayerInitiativeState(nextAwaiting);
          }
        } else if (!hostileAlive && !hasCombatOrder) {
          awaitingPlayerInitiativeRef.current = false;
          setAwaitingPlayerInitiativeState(false);
        }
        if (typeof p.waitForGmNarrationForInitiative === "boolean") {
          const incomingWaitP = !!p.waitForGmNarrationForInitiative;
          let nextWait: boolean;
          if (!incomingWaitP) {
            nextWait = false;
          } else {
            const barrierMsP = waitNarrationClearBarrierMsRef.current;
            const mayRearmNarrationWaitP =
              hasCombatOrderInPayloadP ||
              incomingInitiativeMsP > barrierMsP ||
              barrierMsP === 0;
            nextWait = !!((hostileAlive || hasCombatOrder) && mayRearmNarrationWaitP);
          }
          waitForGmNarrationForInitiativeSyncRef.current = nextWait;
          waitForGmNarrationForInitiativeRef.current = nextWait;
          setWaitForGmNarrationForInitiativeState(nextWait);
        } else if (!hostileAlive && !hasCombatOrder) {
          waitForGmNarrationForInitiativeSyncRef.current = false;
          waitForGmNarrationForInitiativeRef.current = false;
          setWaitForGmNarrationForInitiativeState(false);
        }
      }
    }
    }

    setEngagedWithId(p.engagedWithId ?? null);
    setHasDisengagedThisTurn(!!p.hasDisengagedThisTurn);
    if (Object.prototype.hasOwnProperty.call(p, "meleeState") && p.meleeState && typeof p.meleeState === "object") {
      const rawSeq = p.meleeEngagementSeq;
      applyIncomingMeleeStateIfNotStale(
        p.meleeState,
        rawSeq,
        Object.prototype.hasOwnProperty.call(p, "meleeEngagementSeq")
      );
    }
    /** F5 / reload : les refs repartent à 0 ; sans seq persistée, un snapshot Firestore « vide » écrasait la mêlée. */
    if (
      Object.prototype.hasOwnProperty.call(p, "meleeEngagementSeq") &&
      typeof p.meleeEngagementSeq === "number" &&
      Number.isFinite(p.meleeEngagementSeq)
    ) {
      meleeEngagementSeqRef.current = Math.max(
        meleeEngagementSeqRef.current,
        Math.trunc(p.meleeEngagementSeq as number)
      );
    } else if (
      Object.prototype.hasOwnProperty.call(p, "meleeState") &&
      p.meleeState &&
      typeof p.meleeState === "object" &&
      Object.keys(p.meleeState as object).length > 0
    ) {
      meleeEngagementSeqRef.current = Math.max(meleeEngagementSeqRef.current, 1);
    }
    if (p.reactionState && typeof p.reactionState === "object") setReactionState(p.reactionState);
    if (Array.isArray(p.combatHiddenIds)) {
      setCombatHiddenIds(p.combatHiddenIds.map((x) => String(x ?? "").trim()).filter(Boolean));
    }
    if (p.combatStealthTotalByCombatantId && typeof p.combatStealthTotalByCombatantId === "object") {
      const cleaned: Record<string, number> = {};
      for (const [k, v] of Object.entries(p.combatStealthTotalByCombatantId)) {
        const id = String(k ?? "").trim();
        if (!id) continue;
        if (typeof v === "number" && Number.isFinite(v)) cleaned[id] = Math.trunc(v);
      }
      combatStealthTotalByCombatantIdRef.current = cleaned;
      setCombatStealthTotalByCombatantIdState(cleaned);
    }
    {
      const loadedMap = migratePayloadTurnResourcesToMap(p);
      turnResourcesByCombatantIdRef.current = loadedMap;
      setTurnResourcesByCombatantIdState(loadedMap);
    }
    if (p.aiProvider === "gemini" || p.aiProvider === "openrouter") setAiProvider(p.aiProvider);
    setDebugMode(!!p.debugMode);
    if (typeof p.currentSceneImage === "string") setCurrentSceneImage(p.currentSceneImage);
    setImageModel("disabled");
    setDebugNextRoll(typeof p.debugNextRoll === "number" ? p.debugNextRoll : null);
    setAutoPlayerEnabled(!!p.autoPlayerEnabled);
    setAutoRollEnabled(!!p.autoRollEnabled);
  }, [applyIncomingMeleeStateIfNotStale]);

  // Restauration au montage
  useEffect(() => {
    if (typeof window === "undefined") {
      setPersistenceReady(true);
      return;
    }
    // Session multijoueur via URL (?session=...) : ne pas réappliquer la sauvegarde locale
    // d'une ancienne partie (PV à 0, combatOrder/pendingRoll obsolètes, etc.).
    // La source de vérité doit venir du document Firestore de la session jointe.
    try {
      const params = new URLSearchParams(window.location.search);
      const sid = String(params.get("session") ?? "").trim();
      if (sid) {
        setPersistenceReady(true);
        return;
      }
    } catch {
      /* ignore URL parse errors */
    }
    try {
      const raw = localStorage.getItem(PERSISTENCE_KEY);
      if (!raw) {
        setPersistenceReady(true);
        return;
      }
      const data = JSON.parse(raw) as { v?: number; payload?: PersistedPayload };
      if (data?.v !== PERSISTENCE_VERSION || !data.payload) {
        setPersistenceReady(true);
        return;
      }
      applyPersistedPayload(data.payload);
    } catch {
      /* JSON corrompu ou quota : ignorer */
    }
    setPersistenceReady(true);
  }, [applyPersistedPayload]);

  // Hostiles qui vous ont repéré → combat obligatoire en exploration uniquement.
  // En repos court, on ne force pas le combat (l'entrée en repos est déjà refusée si menace immédiate).
  // Multijoueur : tant que la partie n'a pas démarré (salon), ne pas appliquer l'état persistant
  // local (entités / sauvegarde solo) — sinon combat fantôme sur une nouvelle session.
  useEffect(() => {
    if (gameMode !== "exploration") return;
    if (multiplayerSessionId && !isGameStarted) return;
    if (entities.some((e) => isHostileReadyForCombat(e))) {
      setGameModeState("combat");
    }
  }, [gameMode, entities, multiplayerSessionId, isGameStarted]);

  // Sauvegarde différée à chaque changement d'état pertinent
  useEffect(() => {
    if (!persistenceReady || typeof window === "undefined") return;

    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      try {
        const payload: PersistedPayload = buildPersistedPayloadSnapshot();
        localStorage.setItem(
          PERSISTENCE_KEY,
          JSON.stringify({ v: PERSISTENCE_VERSION, payload })
        );
      } catch {
        /* quota dépassé */
      }
    }, 400);

    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [
    persistenceReady,
    player,
    worldTimeMinutes,
    messages,
    pendingRoll,
    isGameStarted,
    currentSceneName,
    currentScene,
    currentRoomId,
    sceneVersion,
    entities,
    roomMemoryByRoom,
    gameMode,
    combatOrder,
    combatTurnIndex,
    npcInitiativeDraft,
    playerInitiativeRollsByEntityId,
    awaitingPlayerInitiative,
    engagedWithId,
    hasDisengagedThisTurn,
    meleeState,
    reactionState,
    combatHiddenIds,
    combatStealthTotalByCombatantId,
    turnResourcesByCombatantId,
    aiProvider,
    debugMode,
    currentSceneImage,
    imageModel,
    debugNextRoll,
    autoPlayerEnabled,
    autoRollEnabled,
    buildPersistedPayloadSnapshot,
  ]);

  const buildLocalParticipantProfile = useCallback((): SessionParticipantProfile => {
    const src = playerRef.current;
    const normalizedSnapshot = normalizePlayerShape(src);
    const out: SessionParticipantProfile = {
      clientId,
      name: String(src?.name ?? "Joueur").trim() || "Joueur",
      connected: true,
      updatedAtMs: Date.now(),
      playerSnapshot: normalizedSnapshot,
    };
    const key = characterIdentityKeyFromPlayer(src);
    if (key) out.characterKey = key;
    if (typeof src?.entityClass === "string" && src.entityClass.trim()) out.entityClass = src.entityClass;
    if (typeof src?.race === "string" && src.race.trim()) out.race = src.race;
    if (typeof src?.level === "number" && Number.isFinite(src.level)) out.level = Math.trunc(src.level);
    if (typeof src?.hp?.current === "number" && Number.isFinite(src.hp.current)) out.hpCurrent = src.hp.current;
    if (typeof src?.hp?.max === "number" && Number.isFinite(src.hp.max)) out.hpMax = src.hp.max;
    if (typeof src?.ac === "number" && Number.isFinite(src.ac)) out.ac = src.ac;
    return out;
  }, [clientId]);

  /** Pousse le profil Firestore dès que l’identité affichable change (sans attendre ~18s de heartbeat). */
  const participantIdentitySig = useMemo(
    () =>
      `${String(player?.name ?? "").trim()}|${String(player?.entityClass ?? "").trim()}|${String(player?.race ?? "").trim()}`,
    [player?.name, player?.entityClass, player?.race]
  );

  /** Pousse aussi les ressources PJ persistantes (PV + dés de vie) vers Firestore. */
  const participantResourceSyncSig = useMemo(
    () =>
      `${player?.hp?.current ?? ""}|${player?.hp?.max ?? ""}|${player?.hitDiceRemaining ?? ""}|${player?.hitDiceTotal ?? ""}`,
    [player?.hp?.current, player?.hp?.max, player?.hitDiceRemaining, player?.hitDiceTotal]
  );

  /**
   * Stabilisation à 0 PV : `autoRecoverAtMinute` est posé sans changement de PV → sans cette clé,
   * le profil Firestore (playerSnapshot.deathState) ne se mettait pas à jour et le réveil à 1 PV
   * après 1d4 h ne se déclenchait pas pour les autres clients.
   */
  const participantDeathStateSyncSig = useMemo(() => {
    const ds = player?.deathState;
    if (!ds || typeof ds !== "object") return "";
    const auto =
      typeof ds.autoRecoverAtMinute === "number" && Number.isFinite(ds.autoRecoverAtMinute)
        ? Math.trunc(ds.autoRecoverAtMinute)
        : "";
    return [
      ds.stable === true ? 1 : 0,
      ds.dead === true ? 1 : 0,
      ds.unconscious === true ? 1 : 0,
      auto,
      typeof ds.successes === "number" && Number.isFinite(ds.successes) ? Math.trunc(ds.successes) : "",
      typeof ds.failures === "number" && Number.isFinite(ds.failures) ? Math.trunc(ds.failures) : "",
    ].join("|");
  }, [
    player?.deathState?.stable,
    player?.deathState?.dead,
    player?.deathState?.unconscious,
    player?.deathState?.autoRecoverAtMinute,
    player?.deathState?.successes,
    player?.deathState?.failures,
  ]);

  /** Nouvelle session (ou sortie) : repère de fraîcheur profil pour éviter d’écraser les PV locaux avec un vieux snapshot. */
  useEffect(() => {
    lastLocalParticipantProfilePushAtMsRef.current = -1;
  }, [multiplayerSessionId]);

  useEffect(() => {
    if (!multiplayerSessionId) return;
    try {
      const rawProfile = buildLocalParticipantProfile();
      lastLocalParticipantProfilePushAtMsRef.current = rawProfile.updatedAtMs ?? Date.now();
      const profile = sanitizeForFirestore(rawProfile);
      const sessionRef = doc(db, "sessions", multiplayerSessionId);
      flushWriteChainRef.current = flushWriteChainRef.current
        .then(async () => {
          await updateDoc(sessionRef, {
            [`participantProfiles.${clientId}`]: profile,
            participants: arrayUnion(clientId),
            updatedAt: serverTimestamp(),
          });
        })
        .catch(() => {
          /* quota / réseau */
        });
    } catch {
      /* ignore */
    }
  }, [
    multiplayerSessionId,
    participantIdentitySig,
    participantResourceSyncSig,
    participantDeathStateSyncSig,
    buildLocalParticipantProfile,
    clientId,
  ]);

  /**
   * Multijoueur : le moteur met à jour `participantProfiles.hpCurrent` (dégâts, etc.) mais pas `player`.
   * La fiche PJ lit `player.hp` — on aligne le state local sur le profil Firestore du client courant.
   * Ne pas appliquer un snapshot plus vieux que notre dernier push (sinon oscillation PV 5↔8).
   */
  useEffect(() => {
    if (!multiplayerSessionId || !clientId) return;
    const me = String(clientId).trim();
    const prof = multiplayerParticipantProfiles.find((p) => String(p?.clientId ?? "").trim() === me);
    if (!prof || typeof prof.hpCurrent !== "number") return;
    const profMs =
      typeof prof.updatedAtMs === "number" && Number.isFinite(prof.updatedAtMs) ? prof.updatedAtMs : 0;
    const lastPush = lastLocalParticipantProfilePushAtMsRef.current;
    // PV locaux : on refuse strictement tout profil plus ancien que notre dernier push.
    // Une large tolérance temporelle ici provoque des oscillations (valeur locale fraîche
    // écrasée par un snapshot Firestore arrivé en retard).
    if (lastPush >= 0 && profMs < lastPush) return;
    const prev = playerRef.current;
    if (!prev?.hp) return;
    const nextCur = Math.max(0, Math.trunc(prof.hpCurrent));
    const nextMax =
      typeof prof.hpMax === "number" && Number.isFinite(prof.hpMax)
        ? Math.max(1, Math.trunc(prof.hpMax))
        : prev.hp.max;
    if (prev.hp.current === nextCur && prev.hp.max === nextMax) return;
    setPlayerState((p) => {
      if (!p?.hp) return p;
      if (p.hp.current === nextCur && p.hp.max === nextMax) return p;
      return {
        ...p,
        hp: { current: nextCur, max: nextMax },
        deathState: normalizeDeathState(p.deathState, nextCur),
      };
    });
  }, [multiplayerSessionId, clientId, multiplayerParticipantProfiles]);

  /**
   * Multijoueur : aligner l'inventaire local sur `participantProfiles.*.playerSnapshot` quand le profil
   * distant est au moins aussi récent que notre dernier push (loot patché par un autre client, etc.).
   */
  useEffect(() => {
    if (!multiplayerSessionId || !clientId) return;
    const me = String(clientId).trim();
    const prof = multiplayerParticipantProfiles.find((p) => String(p?.clientId ?? "").trim() === me);
    if (!prof?.playerSnapshot) return;
    const rawInv = (prof.playerSnapshot as Player).inventory;
    if (!Array.isArray(rawInv)) return;
    const profInv = stackInventory(rawInv.map((x) => String(x ?? "").trim()).filter(Boolean));
    const profMs =
      typeof prof.updatedAtMs === "number" && Number.isFinite(prof.updatedAtMs) ? prof.updatedAtMs : 0;
    const lastPush = lastLocalParticipantProfilePushAtMsRef.current;
    if (lastPush >= 0 && profMs + MULTIPLAYER_PROFILE_CLOCK_SKEW_TOLERANCE_MS < lastPush) return;
    const prev = playerRef.current;
    if (!prev) return;
    const prevInv = stackInventory(
      Array.isArray(prev.inventory) ? prev.inventory.map((x) => String(x ?? "").trim()).filter(Boolean) : []
    );
    if (JSON.stringify(prevInv) === JSON.stringify(profInv)) return;
    setPlayerState((p) => {
      if (!p) return p;
      const cur = stackInventory(
        Array.isArray(p.inventory) ? p.inventory.map((x) => String(x ?? "").trim()).filter(Boolean) : []
      );
      if (JSON.stringify(cur) === JSON.stringify(profInv)) return p;
      return { ...p, inventory: profInv };
    });
  }, [multiplayerSessionId, clientId, multiplayerParticipantProfiles]);

  /**
   * Multijoueur : lors d'un repos long déclenché par un autre client, notre profil Firestore reçoit
   * un `playerSnapshot` restauré (slots, dés de vie, marqueur de repos), mais la vue locale ne
   * resynchronisait jusque-là que les PV + inventaire.
   */
  useEffect(() => {
    if (!multiplayerSessionId || !clientId) return;
    const me = String(clientId).trim();
    const prof = multiplayerParticipantProfiles.find((p) => String(p?.clientId ?? "").trim() === me);
    if (!prof?.playerSnapshot) return;
    const profSnap = normalizePlayerShape(prof.playerSnapshot);
    if (!profSnap) return;

    const profMs =
      typeof prof.updatedAtMs === "number" && Number.isFinite(prof.updatedAtMs) ? prof.updatedAtMs : 0;
    const lastPush = lastLocalParticipantProfilePushAtMsRef.current;
    if (lastPush >= 0 && profMs + MULTIPLAYER_PROFILE_CLOCK_SKEW_TOLERANCE_MS < lastPush) return;

    const prev = playerRef.current;
    if (!prev) return;

    const slotsChanged = JSON.stringify(prev.spellSlots ?? null) !== JSON.stringify(profSnap.spellSlots ?? null);
    const hdRemainingChanged = (prev.hitDiceRemaining ?? null) !== (profSnap.hitDiceRemaining ?? null);
    const hdTotalChanged = (prev.hitDiceTotal ?? null) !== (profSnap.hitDiceTotal ?? null);
    const lastLongRestChanged =
      (prev.lastLongRestFinishedAtMinute ?? null) !== (profSnap.lastLongRestFinishedAtMinute ?? null);

    if (!slotsChanged && !hdRemainingChanged && !hdTotalChanged && !lastLongRestChanged) return;

    setPlayerState((p) => {
      if (!p) return p;
      const curSlots = JSON.stringify(p.spellSlots ?? null);
      const nextSlots = JSON.stringify(profSnap.spellSlots ?? null);
      const curHdRemaining = p.hitDiceRemaining ?? null;
      const curHdTotal = p.hitDiceTotal ?? null;
      const curLastLongRest = p.lastLongRestFinishedAtMinute ?? null;
      if (
        curSlots === nextSlots &&
        curHdRemaining === (profSnap.hitDiceRemaining ?? null) &&
        curHdTotal === (profSnap.hitDiceTotal ?? null) &&
        curLastLongRest === (profSnap.lastLongRestFinishedAtMinute ?? null)
      ) {
        return p;
      }
      return {
        ...p,
        spellSlots: profSnap.spellSlots ?? p.spellSlots,
        hitDiceRemaining: profSnap.hitDiceRemaining ?? p.hitDiceRemaining,
        hitDiceTotal: profSnap.hitDiceTotal ?? p.hitDiceTotal,
        lastLongRestFinishedAtMinute: profSnap.lastLongRestFinishedAtMinute ?? p.lastLongRestFinishedAtMinute,
      };
    });
  }, [multiplayerSessionId, clientId, multiplayerParticipantProfiles]);

  const multiplayerIsHost = false;

  const createMultiplayerSession = useCallback(async (): Promise<string | null> => {
    const seed = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const sessionId = normalizeMultiplayerSessionId(seed);
    if (!sessionId) return null;
    const payload = buildLobbySharedSessionPayload();
    // Nouvelle session = nouveau contexte : forcer l'acceptation de l'identité de scène
    // du payload lobby même si le sceneVersion local est plus élevé (ancienne partie).
    sceneVersionRef.current = -1;
    applySharedSessionPayload(payload);
    const profile = sanitizeForFirestore(buildLocalParticipantProfile());
    const sessionRef = doc(db, "sessions", sessionId);
    await setDoc(sessionRef, {
      v: PERSISTENCE_VERSION,
      payload: sanitizeForFirestore(payload),
      createdBy: clientId,
      createdAt: serverTimestamp(),
      updatedBy: clientId,
      updatedAt: serverTimestamp(),
      participants: [clientId],
      participantProfiles: {
        [clientId]: profile,
      },
      commandLease: null,
      processing: {
        locked: false,
        lockId: null,
        by: null,
        label: null,
        startedAtMs: null,
      },
      thinkingState: {
        active: false,
        actor: null,
        label: null,
      },
    });
    setMultiplayerSessionId(sessionId);
    setMultiplayerConnected(true);
    setMultiplayerParticipants(1);
    setMultiplayerParticipantClientIds([String(clientId ?? "").trim()].filter(Boolean));
    setMultiplayerParticipantProfiles([profile]);
    setMultiplayerPendingCommand(null);
    const me = String(clientId ?? "").trim();
    if (me) setMultiplayerHostClientId(me);
    return sessionId;
  }, [applySharedSessionPayload, buildLocalParticipantProfile, clientId]);

  const joinMultiplayerSession = useCallback(async (rawSessionId: string): Promise<JoinMultiplayerSessionResult> => {
    const sessionId = normalizeMultiplayerSessionId(rawSessionId);
    if (!sessionId) return { ok: false, reason: "invalid_id" };
    const sessionRef = doc(db, "sessions", sessionId);

    // Anti-doublon personnages : empêcher deux joueurs de rejoindre avec le même personnage.
    // (par identité stable : name|race|entityClass)
    const incomingProfile = sanitizeForFirestore(buildLocalParticipantProfile());
    const incomingKey = incomingProfile.characterKey ?? "";

    // Transaction atomique pour empêcher deux clients d'échapper au check simultanément.
    const joinResult = await runTransaction(db, async (tx) => {
      const snap = await tx.get(sessionRef);
      if (!snap.exists()) return { ok: false, reason: "not_found" } as const;

      const rawData = snap.data() as any;
      const participants = Array.isArray(rawData?.participants) ? (rawData.participants as unknown[]) : [];
      if (participants.length >= 4 && !participants.includes(clientId)) {
        return { ok: false, reason: "full" } as const;
      }

      if (incomingKey) {
        const rawProfiles =
          rawData?.participantProfiles && typeof rawData.participantProfiles === "object"
            ? rawData.participantProfiles
            : {};

        for (const [pid, raw] of Object.entries(rawProfiles as Record<string, any>)) {
          if (pid === clientId) continue;
          if (!raw || typeof raw !== "object") continue;

          const alreadyConnected = raw.connected !== false;
          if (!alreadyConnected) continue;

          // Re-calculer la clé à partir des champs bruts pour matcher même si l'ancien champ `characterKey`
          // était absent / non normalisé.
          const otherKey = characterIdentityKeyFromProfileRaw(raw);
          if (otherKey && otherKey === incomingKey) {
            return { ok: false, reason: "duplicate_character" } as const;
          }
        }
      }

      tx.update(sessionRef, {
        participants: arrayUnion(clientId),
        updatedAt: serverTimestamp(),
        [`participantProfiles.${clientId}`]: incomingProfile,
      });
      return { ok: true } as const;
    });

    if (!joinResult.ok) return joinResult;

    // Join d'une session existante : vider immédiatement le contexte local pour éviter qu'un
    // ancien currentRoomId/messages déclenchent parse-intent/arbiter avant le 1er snapshot Firestore.
    sceneVersionRef.current = -1;
    applySharedSessionPayload(buildLobbySharedSessionPayload());
    setMultiplayerSessionId(sessionId);
    setMultiplayerConnected(true);
    setMultiplayerPendingCommand(null);
    return { ok: true };
  }, [applySharedSessionPayload, buildLocalParticipantProfile, clientId]);

  /** Retire ce client de `participants` ; le document Firestore n'est pas supprimé (l'hôte / derniers joueurs peuvent encore y être). */
  const leaveMultiplayerSession = useCallback(async () => {
    const currentSessionId = multiplayerSessionId;
    if (!currentSessionId) return;
    try {
      const sessionRef = doc(db, "sessions", currentSessionId);
      await updateDoc(sessionRef, {
        participants: arrayRemove(clientId),
        updatedAt: serverTimestamp(),
        [`participantProfiles.${clientId}.connected`]: false,
        [`participantProfiles.${clientId}.updatedAtMs`]: Date.now(),
      });
    } catch {
      /* ignore network errors on leave */
    }
    try {
      if (typeof window !== "undefined" && currentSessionId && clientId) {
        window.sessionStorage.removeItem(
          `${MP_SESSION_PLAYER_STORAGE_PREFIX}:${String(currentSessionId).trim()}:${String(clientId).trim()}`
        );
      }
    } catch {
      /* ignore */
    }
    setMultiplayerSessionId(null);
    setMultiplayerConnected(false);
    setMultiplayerParticipants(1);
    setMultiplayerParticipantClientIds([]);
    setMultiplayerParticipantProfiles([]);
    setMultiplayerHostClientId(null);
    setMultiplayerPendingCommand(null);

    // Rediriger vers le menu initial (on ne peut pas rester en "jeu" sans session).
    setIsGameStarted(false);
    resetToCampaignStart();
  }, [clientId, multiplayerSessionId]);

  const setMultiplayerGameModeImmediate = useCallback(
    async (mode: GameMode) => {
      const nowMs = Date.now();
      gameModeRef.current = mode;
      gameModeUpdatedAtMsRef.current = nowMs;
      setGameModeState(mode);
      if (!multiplayerSessionId) return;
      const sessionRef = doc(db, "sessions", multiplayerSessionId);
      try {
        await updateDoc(sessionRef, {
          "payload.gameMode": mode,
          "payload.gameModeUpdatedAtMs": nowMs,
          updatedBy: clientId,
          updatedAt: serverTimestamp(),
          participants: arrayUnion(clientId),
        });
      } catch {
        /* ignore quota/réseau; le flush global reprendra */
      }
    },
    [clientId, multiplayerSessionId]
  );

  useEffect(() => {
    if (!multiplayerSessionId) return;
    const sessionRef = doc(db, "sessions", multiplayerSessionId);
    const unsubscribe = onSnapshot(sessionRef, (snap) => {
      if (!snap.exists()) {
        setMultiplayerConnected(false);
        return;
      }
      const data = snap.data() as any;
      if (sessionSyncTimerRef.current) {
        clearTimeout(sessionSyncTimerRef.current);
        sessionSyncTimerRef.current = null;
      }
      // IMPORTANT (anti-"participants fantômes"):
      // après un refresh, un ancien client peut rester `connected=true` dans Firestore
      // (car `leaveMultiplayerSession()` n'est pas appelé). On considère alors ces
      // profils comme "stale" à partir de `updatedAtMs`.
      // Seuil anti-profils fantômes (F5 onglet fermé) :
      // 10s était trop agressif et faisait disparaître de vrais joueurs
      // pendant des latences / freeze courts.
      const STALE_PROFILE_MS = 45_000;
      const now = Date.now();
      const payload = data?.payload && typeof data.payload === "object" ? data.payload : null;
      const payloadGameMode = payload?.gameMode;
      // IMPORTANT: pendant TOUT le combat (y compris la phase initiative où combatOrder est encore vide),
      // ne pas dégrader les profils participants en "stale", sinon les PJ disparaissent de la liste.
      const keepParticipantsConnectedDuringCombat = payloadGameMode === "combat";
      const participantsArr = Array.isArray(data?.participants) ? (data.participants as unknown[]) : [];
      const participantClientIds = Array.from(
        new Set(
          participantsArr
            .map((p) => String(p ?? "").trim())
            .filter(Boolean)
        )
      );
      setMultiplayerParticipantClientIds(participantClientIds);
      const createdByRaw =
        typeof data?.createdBy === "string" && data.createdBy.trim()
          ? data.createdBy.trim()
          : participantsArr.length > 0
            ? String(participantsArr[0] ?? "").trim()
            : null;
      setMultiplayerHostClientId(createdByRaw || null);
      const rawProfiles =
        data?.participantProfiles && typeof data.participantProfiles === "object"
          ? (data.participantProfiles as Record<string, any>)
          : {};
      const nextProfiles = Object.entries(rawProfiles)
        .map(([pid, raw]) => {
          if (!raw || typeof raw !== "object") return null;
          return {
            clientId: pid,
            name: String(raw.name ?? "Joueur").trim() || "Joueur",
            entityClass: typeof raw.entityClass === "string" ? raw.entityClass : undefined,
            race: typeof raw.race === "string" ? raw.race : undefined,
            characterKey:
              typeof raw.characterKey === "string" && raw.characterKey.trim()
                ? raw.characterKey
                : characterIdentityKeyFromProfileRaw(raw),
            level: typeof raw.level === "number" ? Math.trunc(raw.level) : null,
            hpCurrent: typeof raw.hpCurrent === "number" ? Math.trunc(raw.hpCurrent) : null,
            hpMax: typeof raw.hpMax === "number" ? Math.trunc(raw.hpMax) : null,
            ac: typeof raw.ac === "number" ? Math.trunc(raw.ac) : null,
            playerSnapshot: normalizePlayerShape(raw.playerSnapshot),
            connected: raw.connected !== false,
            updatedAtMs: typeof raw.updatedAtMs === "number" ? Math.trunc(raw.updatedAtMs) : null,
          } satisfies SessionParticipantProfile;
        })
        .filter(Boolean) as SessionParticipantProfile[];
      const stabilizedProfiles = nextProfiles.map((p) => {
        if (String(p.clientId ?? "").trim() === String(clientId ?? "").trim()) {
          // Le client local ne doit jamais se voir "déconnecté" à cause d'un retard de heartbeat.
          // Affichage : refléter tout de suite le perso choisi (Firestore peut encore dire « Joueur »
          // jusqu’au prochain heartbeat / écriture profil).
          const local = playerRef.current;
          const ln = local?.name && String(local.name).trim() ? String(local.name).trim() : null;
          const le =
            typeof local?.entityClass === "string" && local.entityClass.trim() ? local.entityClass.trim() : null;
          const lr = typeof local?.race === "string" && local.race.trim() ? local.race.trim() : null;
          return {
            ...p,
            connected: true,
            name: ln || p.name,
            entityClass: le ?? p.entityClass,
            race: lr ?? p.race,
          };
        }
        const stale =
          !keepParticipantsConnectedDuringCombat &&
          typeof p.updatedAtMs === "number" &&
          p.updatedAtMs > 0
            ? now - p.updatedAtMs > STALE_PROFILE_MS
            : false;
        return stale ? { ...p, connected: false } : p;
      });
      setMultiplayerParticipantProfiles((prev) =>
        mergeIncomingParticipantProfilesHpWithPrev(prev, stabilizedProfiles)
      );
      const connectedCount = stabilizedProfiles.filter((p) => p && p.connected !== false).length;
      setMultiplayerParticipants(Math.max(1, connectedCount));
      const pendingEarly =
        data?.pendingCommand && typeof data.pendingCommand === "object" ? data.pendingCommand : null;
      const pendingIdEarly = String(pendingEarly?.id ?? "").trim();
      const processingSnap =
        data?.processing && typeof data.processing === "object" ? (data.processing as Record<string, any>) : {};
      const processingLocked = processingSnap.locked === true;
      const startedAtMsSnap =
        typeof processingSnap.startedAtMs === "number" && Number.isFinite(processingSnap.startedAtMs)
          ? processingSnap.startedAtMs
          : null;
      const procStale =
        startedAtMsSnap == null ||
        !Number.isFinite(startedAtMsSnap) ||
        Date.now() - startedAtMsSnap > 180000;
      // Le verrou est "busy" seulement s'il est verrouillé et pas encore stale.
      // Sinon, on ne doit pas considérer le flag `thinking` comme bloquant.
      const sessionProcessingBusy = processingLocked && !procStale;
      const rawThinking =
        data?.thinkingState && typeof data.thinkingState === "object"
          ? (data.thinkingState as Record<string, any>)
          : null;
      // Orphelin fréquent : « MJ réfléchit » reste actif si clearMultiplayerPendingCommand / API a échoué
      // alors qu'il n'y a plus de commande — bloque l'auto-joueur et la résolution sur tous les clients.
      // Exception : combat / jets résolus hors pendingCommand (attaque, dégâts, etc.) — `processing.locked`
      // tient le verrou session pendant handleRoll + callApi ; sans cette exception l'UI efface l'indicateur
      // dès le snapshot alors qu'on attend encore la narration /api/chat.
      let thinkingActive = rawThinking?.active === true;
      if (thinkingActive && !pendingIdEarly) {
        // Ne pas « couper » actor=gm ici : en multijoueur, la résolution pending utilise souvent
        // `skipSessionLock` → `processing.locked` reste false pendant /api/chat. Ce faux « orphelin »
        // effaçait « Le MJ réfléchit… » sur les autres clients (pending encore en route) et laissait
        // l’auto-joueur tenter des soumissions → « Une autre action est déjà en attente… ».
        // Cas "auto-player" figé : si plus aucune commande n'est présente, on libère si (a) le verrou n'est pas busy
        // ou (b) l'intention est clairement ancienne.
        if (rawThinking?.actor === "auto-player") {
          const nowMs = Date.now();
          const intentAtMs =
            typeof rawThinking?.autoPlayerIntentAtMs === "number" && Number.isFinite(rawThinking.autoPlayerIntentAtMs)
              ? Math.trunc(rawThinking.autoPlayerIntentAtMs)
              : null;
          const STALE_AUTO_PLAYER_THINKING_MS = 15000;
          const isStaleIntent = intentAtMs == null ? true : nowMs - intentAtMs > STALE_AUTO_PLAYER_THINKING_MS;
          if (!sessionProcessingBusy || isStaleIntent) thinkingActive = false;
        }
      }
      setMultiplayerThinkingStateLocal({
        active: thinkingActive,
        actor: rawThinking?.actor === "gm" || rawThinking?.actor === "auto-player" ? rawThinking.actor : null,
        label:
          typeof rawThinking?.label === "string" && rawThinking.label.trim()
            ? rawThinking.label.trim()
            : null,
        byClientId:
          typeof rawThinking?.byClientId === "string" && rawThinking.byClientId.trim()
            ? rawThinking.byClientId.trim()
            : null,
        autoPlayerIntentAtMs:
          typeof rawThinking?.autoPlayerIntentAtMs === "number" && Number.isFinite(rawThinking.autoPlayerIntentAtMs)
            ? Math.trunc(rawThinking.autoPlayerIntentAtMs)
            : null,
      });
      const pending =
        data?.pendingCommand && typeof data.pendingCommand === "object" ? (data.pendingCommand as Record<string, any>) : null;
      setMultiplayerPendingCommand(
        pending
          ? {
              id: String(pending.id ?? "").trim(),
              userContent: String(pending.userContent ?? ""),
              msgType: pending.msgType == null ? null : String(pending.msgType),
              isDebug: pending.isDebug === true,
              senderName: String(pending.senderName ?? "Joueur").trim() || "Joueur",
              playerSnapshot: pending.playerSnapshot && typeof pending.playerSnapshot === "object"
                ? normalizePlayerShape(pending.playerSnapshot)
                : null,
              gameModeSnapshot:
                pending.gameModeSnapshot === "exploration" ||
                pending.gameModeSnapshot === "combat" ||
                pending.gameModeSnapshot === "short_rest"
                  ? pending.gameModeSnapshot
                  : null,
              currentRoomIdSnapshot:
                typeof pending.currentRoomIdSnapshot === "string" && pending.currentRoomIdSnapshot.trim()
                  ? pending.currentRoomIdSnapshot.trim()
                  : null,
              currentSceneSnapshot:
                typeof pending.currentSceneSnapshot === "string" ? pending.currentSceneSnapshot : null,
              currentSceneNameSnapshot:
                typeof pending.currentSceneNameSnapshot === "string" ? pending.currentSceneNameSnapshot : null,
              entitiesSnapshot: Array.isArray(pending.entitiesSnapshot)
                ? normalizeLoadedEntitiesList(pending.entitiesSnapshot)
                : null,
              turnResourcesSnapshot:
                pending.turnResourcesSnapshot && typeof pending.turnResourcesSnapshot === "object"
                  ? {
                      action: !!pending.turnResourcesSnapshot.action,
                      bonus: !!pending.turnResourcesSnapshot.bonus,
                      reaction: !!pending.turnResourcesSnapshot.reaction,
                      movement:
                        typeof pending.turnResourcesSnapshot.movement === "boolean"
                          ? pending.turnResourcesSnapshot.movement
                          : Number(pending.turnResourcesSnapshot.movement) > 0,
                    }
                  : null,
              submittedBy: String(pending.submittedBy ?? "").trim(),
              submittedAtMs:
                typeof pending.submittedAtMs === "number" && Number.isFinite(pending.submittedAtMs)
                  ? Math.trunc(pending.submittedAtMs)
                  : 0,
            }
          : null
      );
      setMultiplayerConnected(true);
      if (!data?.payload || data?.v !== PERSISTENCE_VERSION) return;
      const hash = JSON.stringify({ v: data.v, payload: data.payload });
      const previousSnapshotHash = lastSessionSnapshotHashRef.current;
      lastSessionSnapshotHashRef.current = hash;
      if (hash === previousSnapshotHash) return;
      if (hash === lastSessionWriteHashRef.current) return;
      applyingRemoteSessionRef.current = true;
      hasReceivedPlayableSessionPayloadRef.current = true;
      applySharedSessionPayload(data.payload as SharedSessionPayload);
    });
    return () => unsubscribe();
  }, [applySharedSessionPayload, multiplayerSessionId]);

  /**
   * Heartbeat profil participant : rafraîchir `updatedAtMs` en boucle (sinon un seul setTimeout
   * ne tire qu'une fois, et au bout de ~STALE_PROFILE_MS l'autre client est exclu du décompte).
   */
  useEffect(() => {
    if (!multiplayerSessionId) return;
    if (participantProfileHeartbeatRef.current) {
      clearInterval(participantProfileHeartbeatRef.current);
      participantProfileHeartbeatRef.current = null;
    }
    const tick = () => {
      try {
        const rawProfile = buildLocalParticipantProfile();
        const profile = sanitizeForFirestore(rawProfile);
        const sessionRef = doc(db, "sessions", multiplayerSessionId);
        flushWriteChainRef.current = flushWriteChainRef.current
          .then(async () => {
            await updateDoc(sessionRef, {
              [`participantProfiles.${clientId}`]: profile,
              participants: arrayUnion(clientId),
              updatedAt: serverTimestamp(),
            });
          })
          .catch(() => {
            /* quota / réseau / file d'écriture saturée */
          });
      } catch {
        /* ignore */
      }
    };
    tick();
    participantProfileHeartbeatRef.current = setInterval(tick, PARTICIPANT_PROFILE_HEARTBEAT_MS);
    return () => {
      if (participantProfileHeartbeatRef.current) {
        clearInterval(participantProfileHeartbeatRef.current);
        participantProfileHeartbeatRef.current = null;
      }
    };
  }, [buildLocalParticipantProfile, clientId, multiplayerSessionId]);

  const submitMultiplayerCommand = useCallback(async (command: MultiplayerPendingCommand): Promise<boolean> => {
    if (!multiplayerSessionId) return false;
    const sessionRef = doc(db, "sessions", multiplayerSessionId);
    try {
      const submitted = await runTransaction(db, async (tx) => {
        const snap = await tx.get(sessionRef);
        if (!snap.exists()) return false;
        const data = snap.data() as any;
        const hasPending =
          data?.pendingCommand && typeof data.pendingCommand === "object" && String(data.pendingCommand.id ?? "").trim();
        if (hasPending) return false;

        const processing = data?.processing && typeof data.processing === "object" ? data.processing : {};
        const procLocked = processing.locked === true;
        const startedAtMs =
          typeof processing.startedAtMs === "number" && Number.isFinite(processing.startedAtMs)
            ? processing.startedAtMs
            : null;
        const procStale =
          startedAtMs == null ||
          !Number.isFinite(startedAtMs) ||
          Date.now() - startedAtMs > 180000;
        const processingBusy = procLocked && !procStale;
        if (processingBusy) return false;

        const rawThinking =
          data?.thinkingState && typeof data.thinkingState === "object" ? data.thinkingState : null;
        if (rawThinking?.active === true) {
          const actor =
            rawThinking.actor === "gm" || rawThinking.actor === "auto-player" ? rawThinking.actor : null;
          // Si processingBusy, on a déjà refusé plus haut. Sinon « MJ réfléchit » seul = orphelin → on écrase.
          if (actor === "auto-player") {
            const holder = String(rawThinking.byClientId ?? "").trim();
            const sub = String(command.submittedBy ?? "").trim();
            if (!sub) return false;
            // Ancien snapshot sans byClientId : laisser un client reprendre avec sa soumission.
            if (holder && holder !== sub) return false;
          } else if (actor !== "gm") {
            return false;
          }
        }

        const payload =
          data?.payload && typeof data.payload === "object" ? { ...(data.payload as Record<string, any>) } : {};
        const existingMessages = Array.isArray(payload.messages) ? payload.messages : [];
        const newMessage: Message = {
          id: command.id,
          role: "user",
          content: command.userContent,
          ...(command.msgType ? { type: command.msgType as Message["type"] } : {}),
          senderName: command.senderName,
        };
        const mergedCmdMessages = [...existingMessages, newMessage];
        payload.messages = sliceMessagesForSharedFirestorePayload(
          mergedCmdMessages,
          FIRESTORE_SHARED_MESSAGES_CAP
        );
        const safePayload = sanitizeForFirestore(payload);
        const pendingPayload = {
          id: command.id,
          userContent: command.userContent,
          msgType: command.msgType ?? null,
          isDebug: command.isDebug === true,
          senderName: command.senderName,
          playerSnapshot: command.playerSnapshot ?? null,
          gameModeSnapshot:
            command.gameModeSnapshot === "exploration" ||
            command.gameModeSnapshot === "combat" ||
            command.gameModeSnapshot === "short_rest"
              ? command.gameModeSnapshot
              : null,
          currentRoomIdSnapshot: command.currentRoomIdSnapshot ?? null,
          currentSceneSnapshot: command.currentSceneSnapshot ?? null,
          currentSceneNameSnapshot: command.currentSceneNameSnapshot ?? null,
          entitiesSnapshot: Array.isArray(command.entitiesSnapshot) ? command.entitiesSnapshot : null,
          turnResourcesSnapshot:
            command.turnResourcesSnapshot && typeof command.turnResourcesSnapshot === "object"
              ? {
                  action: !!command.turnResourcesSnapshot.action,
                  bonus: !!command.turnResourcesSnapshot.bonus,
                  reaction: !!command.turnResourcesSnapshot.reaction,
                  movement:
                    typeof command.turnResourcesSnapshot.movement === "boolean"
                      ? command.turnResourcesSnapshot.movement
                      : Number(command.turnResourcesSnapshot.movement) > 0,
                }
              : null,
          submittedBy: command.submittedBy,
          submittedAtMs: command.submittedAtMs,
        };
        tx.update(sessionRef, {
          payload: safePayload,
          pendingCommand: sanitizeForFirestore(pendingPayload),
          commandLease: null,
          thinkingState: {
            active: true,
            actor: "gm",
            label: "Le MJ réfléchit…",
            byClientId: null,
            autoPlayerIntentAtMs: null,
          },
          updatedAt: serverTimestamp(),
        });
        return true;
      });
      if (submitted) {
        setMessages((prev) => {
          if (prev.some((m) => String(m?.id ?? "").trim() === String(command.id ?? "").trim())) {
            return prev;
          }
          const next = [
            ...prev,
            {
              id: command.id,
              role: "user" as const,
              content: command.userContent,
              ...(command.msgType ? { type: command.msgType as Message["type"] } : {}),
              senderName: command.senderName,
            },
          ];
          messagesStateRef.current = next;
          return next;
        });
      }
      return submitted;
    } catch {
      return false;
    }
  }, [multiplayerSessionId]);

  const clearMultiplayerPendingCommand = useCallback(async (commandId: string) => {
    if (!multiplayerSessionId || !commandId) return;
    const sessionRef = doc(db, "sessions", multiplayerSessionId);
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(sessionRef);
        if (!snap.exists()) return;
        const data = snap.data() as any;
        const pendingId = String(data?.pendingCommand?.id ?? "").trim();
        if (pendingId !== commandId) return;
        // Toujours couper thinkingState ici : sinon si `setMultiplayerThinkingState({ active:false })`
        // échoue (quota/réseau) alors que ce clear réussit, Firestore reste « MJ réfléchit » sans
        // pendingCommand → auto-joueur et autres clients bloqués indéfiniment.
        tx.update(sessionRef, {
          pendingCommand: null,
          commandLease: null,
          thinkingState: {
            active: false,
            actor: null,
            label: null,
            byClientId: null,
            autoPlayerIntentAtMs: null,
          },
          updatedAt: serverTimestamp(),
        });
      });
    } catch {
      /* ignore */
    }
  }, [multiplayerSessionId]);

  const tryAcquireMultiplayerCommandLease = useCallback(
    async (commandId: string): Promise<"acquired" | "busy" | "gone"> => {
      if (!multiplayerSessionId || !commandId) return "gone";
      const sessionRef = doc(db, "sessions", multiplayerSessionId);
      try {
        const outcome = await runTransaction(db, async (tx) => {
          const snap = await tx.get(sessionRef);
          if (!snap.exists()) return "gone" as const;
          const data = snap.data() as any;
          const pendingId = String(data?.pendingCommand?.id ?? "").trim();
          if (pendingId !== commandId) return "gone" as const;
          // N'importe quel client connecté peut acquérir le bail : `callApi` reçoit `actingPlayer`,
          // `entitiesSnapshot`, `turnResourcesSnapshot` et `commandSubmitterClientId` depuis la commande,
          // donc le moteur cible le bon `mp-player-*`. Avant : seul le soumetteur pouvait résoudre —
          // si son onglet était fermé ou en arrière-plan, « MJ réfléchit… » restait bloqué indéfiniment.
          const lease = data?.commandLease && typeof data.commandLease === "object" ? data.commandLease : null;
          const untilMs = typeof lease?.untilMs === "number" && Number.isFinite(lease.untilMs) ? lease.untilMs : 0;
          const holder = String(lease?.holderClientId ?? "").trim();
          const leaseCommandId = String(lease?.commandId ?? "").trim();
          const leaseAlive = untilMs > Date.now() && holder && leaseCommandId === pendingId;
          if (leaseAlive && holder !== clientId) return "busy" as const;
          tx.update(sessionRef, {
            commandLease: {
              holderClientId: clientId,
              commandId,
              untilMs: Date.now() + MULTIPLAYER_COMMAND_LEASE_TTL_MS,
            },
            updatedAt: serverTimestamp(),
          });
          return "acquired" as const;
        });
        return outcome ?? "busy";
      } catch {
        return "busy";
      }
    },
    [clientId, multiplayerSessionId]
  );

  const releaseMultiplayerCommandLease = useCallback(
    async (commandId: string) => {
      if (!multiplayerSessionId || !commandId) return;
      const sessionRef = doc(db, "sessions", multiplayerSessionId);
      try {
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(sessionRef);
          if (!snap.exists()) return;
          const data = snap.data() as any;
          const lease = data?.commandLease && typeof data.commandLease === "object" ? data.commandLease : null;
          const holder = String(lease?.holderClientId ?? "").trim();
          const leaseCmd = String(lease?.commandId ?? "").trim();
          if (leaseCmd !== commandId || holder !== clientId) return;
          tx.update(sessionRef, {
            commandLease: null,
            updatedAt: serverTimestamp(),
          });
        });
      } catch {
        /* ignore */
      }
    },
    [clientId, multiplayerSessionId]
  );

  const patchParticipantProfileHp = useCallback(
    async (participantClientId: string, hpCurrent: number) => {
      const pid = String(participantClientId ?? "").trim();
      if (!multiplayerSessionId || !pid) return;
      const safeHp = Math.max(0, Math.trunc(Number(hpCurrent) || 0));
      const sessionRef = doc(db, "sessions", multiplayerSessionId);
      const nowMs = Date.now();
      try {
        await updateDoc(sessionRef, {
          [`participantProfiles.${pid}.hpCurrent`]: safeHp,
          [`participantProfiles.${pid}.updatedAtMs`]: nowMs,
          updatedAt: serverTimestamp(),
        });
      } catch {
        /* quota / réseau */
      }
      if (pid === String(clientId ?? "").trim()) {
        lastLocalParticipantProfilePushAtMsRef.current = nowMs;
      }
      setMultiplayerParticipantProfiles((prev) =>
        prev.map((p) =>
          String(p.clientId ?? "").trim() === pid
            ? { ...p, hpCurrent: safeHp, updatedAtMs: nowMs }
            : p
        )
      );
    },
    [multiplayerSessionId, clientId]
  );

  const patchParticipantProfileInventory = useCallback(
    async (participantClientId: string, inventory: string[]) => {
      const pid = String(participantClientId ?? "").trim();
      if (!multiplayerSessionId || !pid) return;
      const nextInv = stackInventory(inventory.map((x) => String(x ?? "").trim()).filter(Boolean));
      const nowMs = Date.now();
      const sessionRef = doc(db, "sessions", multiplayerSessionId);
      try {
        await updateDoc(sessionRef, {
          [`participantProfiles.${pid}.playerSnapshot.inventory`]: sanitizeForFirestore(nextInv),
          [`participantProfiles.${pid}.updatedAtMs`]: nowMs,
          updatedAt: serverTimestamp(),
        });
      } catch {
        /* quota / réseau */
      }
      if (pid === String(clientId ?? "").trim()) {
        lastLocalParticipantProfilePushAtMsRef.current = nowMs;
        setPlayer((prev) => (prev ? { ...prev, inventory: nextInv } : prev));
      }
      setMultiplayerParticipantProfiles((prev) =>
        prev.map((p) => {
          if (String(p.clientId ?? "").trim() !== pid) return p;
          const snap =
            p.playerSnapshot && typeof p.playerSnapshot === "object"
              ? normalizePlayerShape(p.playerSnapshot)
              : null;
          return {
            ...p,
            playerSnapshot: snap ? { ...snap, inventory: nextInv } : snap,
            updatedAtMs: nowMs,
          };
        })
      );
    },
    [multiplayerSessionId, clientId, setPlayer]
  );

  const patchParticipantProfilePlayerSnapshot = useCallback(
    async (participantClientId: string, snapshot: Player) => {
      const pid = String(participantClientId ?? "").trim();
      if (!multiplayerSessionId || !pid) return;
      const normalized = normalizePlayerShape(snapshot);
      if (!normalized) return;
      const nowMs = Date.now();
      const safeHpCurrent =
        typeof normalized.hp?.current === "number" && Number.isFinite(normalized.hp.current)
          ? Math.max(0, Math.trunc(normalized.hp.current))
          : 0;
      const safeHpMax =
        typeof normalized.hp?.max === "number" && Number.isFinite(normalized.hp.max)
          ? Math.max(1, Math.trunc(normalized.hp.max))
          : Math.max(1, safeHpCurrent);
      const sessionRef = doc(db, "sessions", multiplayerSessionId);
      try {
        await updateDoc(sessionRef, {
          [`participantProfiles.${pid}.playerSnapshot`]: sanitizeForFirestore(normalized),
          [`participantProfiles.${pid}.hpCurrent`]: safeHpCurrent,
          [`participantProfiles.${pid}.hpMax`]: safeHpMax,
          [`participantProfiles.${pid}.updatedAtMs`]: nowMs,
          updatedAt: serverTimestamp(),
        });
      } catch {
        /* quota / réseau */
      }
      if (pid === String(clientId ?? "").trim()) {
        lastLocalParticipantProfilePushAtMsRef.current = nowMs;
        setPlayer(normalized);
      }
      setMultiplayerParticipantProfiles((prev) =>
        prev.map((p) =>
          String(p.clientId ?? "").trim() === pid
            ? {
                ...p,
                hpCurrent: safeHpCurrent,
                hpMax: safeHpMax,
                playerSnapshot: normalized,
                updatedAtMs: nowMs,
              }
            : p
        )
      );
    },
    [multiplayerSessionId, clientId, setPlayer]
  );

  const patchParticipantProfileDeathState = useCallback(
    async (
      participantClientId: string,
      deathStatePatch: Partial<DeathState>,
      options?: { hpCurrent?: number | null }
    ) => {
      const pid = String(participantClientId ?? "").trim();
      if (!multiplayerSessionId || !pid) return;
      const nowMs = Date.now();
      const hpOptRaw = options?.hpCurrent;
      const hpOpt =
        typeof hpOptRaw === "number" && Number.isFinite(hpOptRaw)
          ? Math.max(0, Math.trunc(hpOptRaw))
          : null;
      const profileLocal =
        multiplayerParticipantProfiles.find((p) => String(p?.clientId ?? "").trim() === pid) ?? null;
      const snapLocal =
        profileLocal?.playerSnapshot && typeof profileLocal.playerSnapshot === "object"
          ? normalizePlayerShape(profileLocal.playerSnapshot)
          : null;
      const hpBase =
        hpOpt != null
          ? hpOpt
          : typeof profileLocal?.hpCurrent === "number" && Number.isFinite(profileLocal.hpCurrent)
            ? Math.max(0, Math.trunc(profileLocal.hpCurrent))
            : typeof snapLocal?.hp?.current === "number" && Number.isFinite(snapLocal.hp.current)
              ? Math.max(0, Math.trunc(snapLocal.hp.current))
              : 0;
      const currentDs = normalizeDeathState(snapLocal?.deathState, hpBase);
      const nextDs = normalizeDeathState({ ...currentDs, ...(deathStatePatch ?? {}) }, hpBase);

      const updates: Record<string, unknown> = {
        [`participantProfiles.${pid}.playerSnapshot.deathState`]: sanitizeForFirestore(nextDs),
        [`participantProfiles.${pid}.updatedAtMs`]: nowMs,
        updatedAt: serverTimestamp(),
      };
      if (hpOpt != null) {
        updates[`participantProfiles.${pid}.hpCurrent`] = hpOpt;
        updates[`participantProfiles.${pid}.playerSnapshot.hp.current`] = hpOpt;
      }
      const sessionRef = doc(db, "sessions", multiplayerSessionId);
      try {
        await updateDoc(sessionRef, updates);
      } catch {
        /* quota / réseau */
      }

      setMultiplayerParticipantProfiles((prev) =>
        prev.map((p) => {
          if (String(p.clientId ?? "").trim() !== pid) return p;
          const snap =
            p.playerSnapshot && typeof p.playerSnapshot === "object"
              ? normalizePlayerShape(p.playerSnapshot)
              : null;
          const hpLocal =
            hpOpt != null
              ? hpOpt
              : typeof p.hpCurrent === "number" && Number.isFinite(p.hpCurrent)
                ? Math.max(0, Math.trunc(p.hpCurrent))
                : typeof snap?.hp?.current === "number" && Number.isFinite(snap.hp.current)
                  ? Math.max(0, Math.trunc(snap.hp.current))
                  : 0;
          const nextSnap = snap
            ? {
                ...snap,
                hp: snap.hp
                  ? { ...snap.hp, ...(hpOpt != null ? { current: hpOpt } : {}) }
                  : snap.hp,
                deathState: normalizeDeathState({ ...(snap.deathState ?? {}), ...(deathStatePatch ?? {}) }, hpLocal),
              }
            : snap;
          return {
            ...p,
            ...(hpOpt != null ? { hpCurrent: hpOpt } : {}),
            playerSnapshot: nextSnap,
            updatedAtMs: nowMs,
          };
        })
      );
    },
    [multiplayerSessionId, multiplayerParticipantProfiles]
  );

  const acquireMultiplayerAutoPlayerIntentLock = useCallback(async (): Promise<boolean> => {
    if (!multiplayerSessionId) return false;
    const sessionRef = doc(db, "sessions", multiplayerSessionId);
    const me = String(clientId ?? "").trim();
    if (!me) return false;
    try {
      return await runTransaction(db, async (tx) => {
        const snap = await tx.get(sessionRef);
        if (!snap.exists()) return false;
        const data = snap.data() as any;
        const hasPending =
          data?.pendingCommand &&
          typeof data.pendingCommand === "object" &&
          String(data.pendingCommand.id ?? "").trim();
        if (hasPending) return false;

        const rawThinking =
          data?.thinkingState && typeof data.thinkingState === "object" ? data.thinkingState : null;
        if (rawThinking?.active === true) {
          const actor =
            rawThinking.actor === "gm" || rawThinking.actor === "auto-player" ? rawThinking.actor : null;
          if (actor === "gm") return false;
          if (actor === "auto-player") {
            const holder = String(rawThinking.byClientId ?? "").trim();
            const startedRaw = rawThinking.autoPlayerIntentAtMs;
            const started =
              typeof startedRaw === "number" && Number.isFinite(startedRaw) ? startedRaw : 0;
            const stale = started > 0 && Date.now() - started > MULTIPLAYER_AUTO_INTENT_STALE_MS;
            if (!stale && holder && holder !== me) return false;
          } else {
            return false;
          }
        }

        const processing = data?.processing && typeof data.processing === "object" ? data.processing : {};
        const procLocked = processing.locked === true;
        const startedAtMs =
          typeof processing.startedAtMs === "number" && Number.isFinite(processing.startedAtMs)
            ? processing.startedAtMs
            : null;
        const procStale = startedAtMs != null && Date.now() - startedAtMs > 180000;
        if (procLocked && !procStale) return false;

        const nowMs = Date.now();
        tx.update(sessionRef, {
          thinkingState: {
            active: true,
            actor: "auto-player",
            label: "L'IA joueur réfléchit…",
            byClientId: me,
            autoPlayerIntentAtMs: nowMs,
          },
          updatedAt: serverTimestamp(),
        });
        return true;
      });
    } catch {
      return false;
    }
  }, [clientId, multiplayerSessionId]);

  const releaseMultiplayerAutoPlayerIntentLock = useCallback(async (): Promise<void> => {
    if (!multiplayerSessionId) return;
    const sessionRef = doc(db, "sessions", multiplayerSessionId);
    const me = String(clientId ?? "").trim();
    if (!me) return;
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(sessionRef);
        if (!snap.exists()) return;
        const data = snap.data() as any;
        const t = data?.thinkingState && typeof data.thinkingState === "object" ? data.thinkingState : null;
        if (!t || t.active !== true || t.actor !== "auto-player") return;
        if (String(t.byClientId ?? "").trim() !== me) return;
        tx.update(sessionRef, {
          thinkingState: {
            active: false,
            actor: null,
            label: null,
            byClientId: null,
            autoPlayerIntentAtMs: null,
          },
          updatedAt: serverTimestamp(),
        });
      });
    } catch {
      /* ignore */
    }
  }, [clientId, multiplayerSessionId]);

  const setMultiplayerThinkingState = useCallback(async (thinking: MultiplayerThinkingState) => {
    // Toujours mettre à jour l'UI locale tout de suite (si Firestore est saturé, évite un MJ « bloqué »)
    setMultiplayerThinkingStateLocal(thinking);
    if (!multiplayerSessionId) {
      return;
    }
    const sessionRef = doc(db, "sessions", multiplayerSessionId);
    flushWriteChainRef.current = flushWriteChainRef.current
      .then(async () => {
        await setDoc(
          sessionRef,
          {
            thinkingState: {
              active: thinking.active === true,
              actor:
                thinking.actor === "gm" || thinking.actor === "auto-player"
                  ? thinking.actor
                  : null,
              label:
                typeof thinking.label === "string" && thinking.label.trim()
                  ? thinking.label.trim()
                  : null,
              byClientId:
                typeof thinking.byClientId === "string" && thinking.byClientId.trim()
                  ? thinking.byClientId.trim()
                  : null,
              autoPlayerIntentAtMs:
                typeof thinking.autoPlayerIntentAtMs === "number" && Number.isFinite(thinking.autoPlayerIntentAtMs)
                  ? Math.trunc(thinking.autoPlayerIntentAtMs)
                  : null,
            },
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      })
      .catch(() => {
        /* resource-exhausted : ne pas bloquer la chaîne */
      });
    try {
      await flushWriteChainRef.current;
    } catch {
      /* ignore */
    }
  }, [multiplayerSessionId]);

  const flushMultiplayerSharedState = useCallback(async () => {
    if (!multiplayerSessionId) return;
    if (!hasReceivedPlayableSessionPayloadRef.current) return;

    flushWriteChainRef.current = flushWriteChainRef.current
      .then(async () => {
        const sessionRef = doc(db, "sessions", multiplayerSessionId);
        const payload = sanitizeForFirestore(buildSharedSessionPayloadSnapshot()) as SharedSessionPayload;
        try {
          const remoteSnap = await getDoc(sessionRef);
          if (remoteSnap.exists()) {
            const remoteData = remoteSnap.data() as any;
            const remotePayload =
              remoteData?.payload && typeof remoteData.payload === "object"
                ? (remoteData.payload as Partial<SharedSessionPayload>)
                : null;
            const remoteMessages = Array.isArray(remotePayload?.messages)
              ? (remotePayload.messages as Message[]).filter((m) => (m as Message).type !== "scene-image-pending")
              : [];
            const localMessages = Array.isArray(payload.messages) ? payload.messages : [];
            const mergedMessages = mergeStickyLocalMessagesIntoRemote(localMessages, remoteMessages);
            payload.messages = sliceMessagesForSharedFirestorePayload(
              mergedMessages,
              FIRESTORE_SHARED_MESSAGES_CAP
            );

            const hostIdForEntityMerge = String(multiplayerHostClientId ?? "").trim();
            const meForEntityMerge = String(clientId ?? "").trim();
            const localRoomForEntityMerge = String(payload.currentRoomId ?? "").trim();
            const remoteRoomForEntityMerge = String(remotePayload?.currentRoomId ?? "").trim();
            // Invité : ne pas fusionner « entités locales absentes du remote » si la salle ne correspond pas.
            // Sinon le snapshot hôte (encore dans la pièce précédente) sert de base et chaque PNJ de la
            // nouvelle salle (nouveaux ids) est ajouté par-dessus → doublons visuels (anciens + nouveaux).
            const roomsAlignedForNpcSpawnMerge =
              !!localRoomForEntityMerge &&
              !!remoteRoomForEntityMerge &&
              localRoomForEntityMerge === remoteRoomForEntityMerge;
            if (
              hostIdForEntityMerge &&
              meForEntityMerge &&
              hostIdForEntityMerge !== meForEntityMerge &&
              roomsAlignedForNpcSpawnMerge
            ) {
              payload.entities = appendLocalEntitiesAbsentFromRemote(
                Array.isArray(payload.entities) ? (payload.entities as Entity[]) : [],
                remotePayload?.entities
              );
            }

            // Source de vérité MP (mode): "dernier changement gagne" via gameModeUpdatedAtMs.
            {
              const remoteModeMs =
                typeof remotePayload?.gameModeUpdatedAtMs === "number" &&
                Number.isFinite(remotePayload.gameModeUpdatedAtMs)
                  ? Math.trunc(remotePayload.gameModeUpdatedAtMs)
                  : 0;
              const localModeMs =
                typeof (payload as any)?.gameModeUpdatedAtMs === "number" &&
                Number.isFinite((payload as any).gameModeUpdatedAtMs)
                  ? Math.trunc((payload as any).gameModeUpdatedAtMs)
                  : 0;
              if (remoteModeMs > localModeMs) {
                (payload as any).gameMode = remotePayload?.gameMode;
                (payload as any).gameModeUpdatedAtMs = remoteModeMs;
              }
            }

            // MP — ressources par combattant + miroir du combattant actif.
            // Ne jamais omettre `turnResources` / `turnResourcesByCombatantId` du payload (merge Firestore).
            // Si ce client n'est pas le combattant actif : ne pas écraser la tranche active avec l'état local.
            {
              const co = combatOrderRef.current;
              const tidx = combatTurnIndexRef.current;
              const activeId =
                Array.isArray(co) &&
                co.length > 0 &&
                typeof tidx === "number" &&
                tidx >= 0 &&
                tidx < co.length
                  ? String(co[tidx]?.id ?? "").trim()
                  : "";
              const localMpId = `mp-player-${String(clientId ?? "").trim()}`;
              const isLocalActiveCombatant =
                !!activeId &&
                (activeId === localMpId ||
                  (activeId === "player" && multiplayerParticipants <= 1));
              const snapshotMap = { ...turnResourcesByCombatantIdRef.current };
              const remoteMap = normalizeTurnResourcesMapInput(
                remotePayload?.turnResourcesByCombatantId as TurnResourcesMap | undefined
              );
              /** Combattant actif local : l'état local est la source de vérité (ne pas AND avec un snapshot distant périmé). */
              let payloadMap: TurnResourcesMap =
                activeId && isLocalActiveCombatant
                  ? { ...snapshotMap }
                  : mergeTurnResourcesMapSameCombatSegment(snapshotMap, remoteMap);
              if (activeId && !isLocalActiveCombatant) {
                const trFirst =
                  remoteMap[activeId] != null
                    ? normalizeTurnResourcesInput(remoteMap[activeId])
                    : remotePayload?.turnResources && typeof remotePayload.turnResources === "object"
                      ? normalizeTurnResourcesInput(remotePayload.turnResources as TurnResources)
                      : null;
                let trOut: TurnResources | null = trFirst;
                try {
                  const freshSnap = await getDoc(sessionRef);
                  if (freshSnap.exists()) {
                    const freshData = freshSnap.data() as any;
                    const freshPayload =
                      freshData?.payload && typeof freshData.payload === "object"
                        ? (freshData.payload as Partial<SharedSessionPayload>)
                        : null;
                    const freshRm = normalizeTurnResourcesMapInput(
                      freshPayload?.turnResourcesByCombatantId as TurnResourcesMap | undefined
                    );
                    const trFresh =
                      freshRm[activeId] != null
                        ? normalizeTurnResourcesInput(freshRm[activeId])
                        : freshPayload?.turnResources && typeof freshPayload.turnResources === "object"
                          ? normalizeTurnResourcesInput(freshPayload.turnResources as TurnResources)
                          : null;
                    if (trFresh) {
                      trOut = trFirst
                        ? mergeTurnResourcesSameCombatSegment(trFirst, trFresh)
                        : trFresh;
                    }
                  }
                } catch {
                  /* garder trOut */
                }
                if (trOut) {
                  payloadMap = { ...payloadMap, [activeId]: trOut };
                }
              }
              payload.turnResourcesByCombatantId = payloadMap;
              payload.turnResources = turnResourcesMirrorFromMap(
                payloadMap,
                payload.combatOrder ?? combatOrderRef.current,
                combatTurnIndexRef.current
              );
            }
          }
        } catch {
          /* ignore read-before-write merge failures */
        }
        const hash = JSON.stringify({ v: PERSISTENCE_VERSION, payload });
        if (hash === lastSessionWriteHashRef.current) return;
        await setDoc(
          sessionRef,
          {
            v: PERSISTENCE_VERSION,
            payload,
            updatedBy: clientId,
            updatedAt: serverTimestamp(),
            participants: arrayUnion(clientId),
            [`participantProfiles.${clientId}`]: sanitizeForFirestore(buildLocalParticipantProfile()),
          },
          { merge: true }
        );
        lastSessionWriteHashRef.current = hash;
        lastSessionSnapshotHashRef.current = hash;
      })
      .catch(() => {
        /* resource-exhausted / réseau : ne pas bloquer la chaîne suivante */
      });

    await flushWriteChainRef.current;
  }, [
    buildLocalParticipantProfile,
    buildSharedSessionPayloadSnapshot,
    clientId,
    multiplayerHostClientId,
    multiplayerParticipants,
    multiplayerSessionId,
  ]);

  /**
   * Hôte : poussée différée du payload partagé. DOIT passer par `flushMultiplayerSharedState`
   * (lecture Firestore + fusion messages / turnResources). Sinon l’hôte réécrit souvent
   * `movement: true` alors que le combattant actif (souvent un invité) vient de consommer
   * le mouvement — spam de déplacement possible pour tout le monde.
   */
  useEffect(() => {
    if (!persistenceReady || !multiplayerSessionId) return;
    if (!hasReceivedPlayableSessionPayloadRef.current) return;
    if (!multiplayerHostClientId || multiplayerHostClientId !== clientId) return;
    if (applyingRemoteSessionRef.current) {
      applyingRemoteSessionRef.current = false;
      return;
    }
    if (sessionSyncTimerRef.current) clearTimeout(sessionSyncTimerRef.current);
    sessionSyncTimerRef.current = setTimeout(() => {
      void flushMultiplayerSharedState();
    }, HOST_SESSION_SYNC_DEBOUNCE_MS);
    return () => {
      if (sessionSyncTimerRef.current) clearTimeout(sessionSyncTimerRef.current);
    };
  }, [
    persistenceReady,
    multiplayerSessionId,
    multiplayerHostClientId,
    clientId,
    flushMultiplayerSharedState,
    worldTimeMinutes,
    messages,
    pendingRoll,
    isGameStarted,
    currentSceneName,
    currentScene,
    currentRoomId,
    sceneVersion,
    entities,
    roomMemoryByRoom,
    gameMode,
    combatOrder,
    combatTurnIndex,
    engagedWithId,
    hasDisengagedThisTurn,
    meleeState,
    reactionState,
    turnResourcesByCombatantId,
    currentSceneImage,
    player?.name,
    player?.hp?.current,
    player?.hp?.max,
    player?.ac,
    player?.entityClass,
    player?.race,
    player?.level,
  ]);

  useEffect(() => {
    hasReceivedPlayableSessionPayloadRef.current = false;
    remoteIsGameStartedRef.current = null;
    firstRemoteMessagesAppliedRef.current = false;
    lastSessionSnapshotHashRef.current = "";
    lastSessionWriteHashRef.current = "";
  }, [multiplayerSessionId]);

  const acquireMultiplayerProcessingLock = useCallback(async (label = "command"): Promise<string | null> => {
    const prev = processingClientMutexTailRef.current;
    let releaseClientMutex: () => void = () => {};
    const clientMutexGate = new Promise<void>((resolve) => {
      releaseClientMutex = () => resolve();
    });
    processingClientMutexTailRef.current = prev.then(() => clientMutexGate);
    await prev;

    const finishClientMutex = () => {
      releaseClientMutex();
    };

    if (!multiplayerSessionId) {
      const lockId = `local-mem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      processingLockMutexReleaseRef.current.set(lockId, finishClientMutex);
      return lockId;
    }

    const sessionRef = doc(db, "sessions", multiplayerSessionId);
    const lockId = `${clientId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    /** Initiative / jets courts : débloquer plus vite si un client a laissé un verrou orphelin. */
    const staleAfterMs = label === "initiative" ? 25000 : 180000;
    try {
      const acquired = await runTransaction(db, async (tx) => {
        const snap = await tx.get(sessionRef);
        if (!snap.exists()) return false;
        const data = snap.data() as any;
        const processing = data?.processing && typeof data.processing === "object" ? data.processing : {};
        const locked = processing.locked === true;
        const startedAtMs =
          typeof processing.startedAtMs === "number" && Number.isFinite(processing.startedAtMs)
            ? processing.startedAtMs
            : null;
        // Sans startedAtMs, l'ancienne formule laissait stale=false → verrou bloqué pour toujours.
        const stale =
          startedAtMs == null ||
          !Number.isFinite(startedAtMs) ||
          Date.now() - startedAtMs > staleAfterMs;
        if (locked && !stale) return false;
        tx.update(sessionRef, {
          processing: {
            locked: true,
            lockId,
            by: clientId,
            label,
            startedAtMs: Date.now(),
          },
          updatedAt: serverTimestamp(),
        });
        return true;
      });
      if (!acquired) {
        finishClientMutex();
        return null;
      }
      processingLockMutexReleaseRef.current.set(lockId, finishClientMutex);
      return lockId;
    } catch {
      finishClientMutex();
      return null;
    }
  }, [clientId, multiplayerSessionId]);

  const releaseMultiplayerProcessingLock = useCallback(async (lockId: string | null) => {
    if (!lockId) return;
    const finishClientMutex = processingLockMutexReleaseRef.current.get(lockId);
    if (finishClientMutex) {
      processingLockMutexReleaseRef.current.delete(lockId);
    }
    try {
      if (!lockId.startsWith("local-mem-") && multiplayerSessionId) {
        const sessionRef = doc(db, "sessions", multiplayerSessionId);
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(sessionRef);
          if (!snap.exists()) return;
          const data = snap.data() as any;
          const processing = data?.processing && typeof data.processing === "object" ? data.processing : {};
          if (processing.lockId !== lockId) return;
          tx.update(sessionRef, {
            processing: {
              locked: false,
              lockId: null,
              by: null,
              label: null,
              startedAtMs: null,
            },
            updatedAt: serverTimestamp(),
          });
        });
      }
    } catch {
      /* ignore */
    } finally {
      finishClientMutex?.();
    }
  }, [multiplayerSessionId]);

  const debugForceUnblockProcessingPipeline = useCallback(async () => {
    const entries = [...processingLockMutexReleaseRef.current.entries()];
    processingLockMutexReleaseRef.current.clear();
    for (const [, finish] of entries) {
      try {
        finish();
      } catch {
        /* ignore */
      }
    }
    if (multiplayerSessionId) {
      const sessionRef = doc(db, "sessions", multiplayerSessionId);
      try {
        await updateDoc(sessionRef, {
          processing: {
            locked: false,
            lockId: null,
            by: null,
            label: null,
            startedAtMs: null,
          },
          updatedAt: serverTimestamp(),
        });
      } catch {
        /* quota / réseau */
      }
    }
    try {
      await setMultiplayerThinkingState({
        active: false,
        actor: null,
        label: null,
        byClientId: null,
        autoPlayerIntentAtMs: null,
      });
    } catch {
      /* ignore */
    }
  }, [multiplayerSessionId, setMultiplayerThinkingState]);

  const startNewGame = useCallback(() => {
    try {
      localStorage.removeItem(PERSISTENCE_KEY);
    } catch {
      /* ignore */
    }
    setRoomMemoryByRoom({});
    setIsGameStarted(false);
    // Repartir des stats « template » (PV max, état de mort, ressources) comme resetToCampaignStart — sans réinitialiser tout le monde.
    setPlayerState((prev) => {
      const seed = clonePlayer(playerInitialSnapshotRef.current) ?? clonePlayer(prev);
      if (!seed?.hp) return prev;
      const restored = resetRemainingResourcesDeep(seed);
      const next = {
        ...restored,
        isAlive: true,
        hp: { ...restored.hp, current: restored.hp.max },
        hitDiceRemaining: restored.hitDiceTotal ?? restored.level ?? 1,
        deathState: normalizeDeathState(null, restored.hp.max),
        lastLongRestFinishedAtMinute: null,
      };
      playerInitialSnapshotRef.current = clonePlayer(next);
      return normalizePlayerShape(next);
    });
    if (multiplayerSessionId) {
      lastLocalParticipantProfilePushAtMsRef.current = Date.now();
    }
  }, [clonePlayer, multiplayerSessionId]);

  useEffect(() => {
    if (!persistenceReady) return;
    if (gameMode !== "combat") {
      meleeEngagementSeqRef.current += 1;
      meleeStateRef.current = {};
      setMeleeState({});
      setReactionState({});
    }
  }, [gameMode, persistenceReady]);

  function nextMessageId() {
    messageSeqRef.current += 1;
    return `${Date.now()}-${messageSeqRef.current}`;
  }

  function addMessage(
    role: "user" | "ai",
    content: string,
    type?:
      | "dice"
      | "meta"
      | "meta-reply"
      | "enemy-turn"
      | "combat-detail"
      | "turn-end"
      | "debug"
      | "intent-error"
      | "scene-image"
      | "scene-image-pending"
      | "continue"
      | "retry-action"
      | "campaign-context",
    id?: string,
    contextBox?: { title: string },
    senderName?: string
  ) {
    // MP : les erreurs d'intention sont synchronisées comme `meta` pour que tous les clients
    // voient le même journal (évite les intent-error filtrés du payload + disparition au snapshot).
    let effectiveType = type;
    let effectiveContent = content;
    if (multiplayerSessionId && type === "intent-error") {
      effectiveType = "meta";
      effectiveContent = `[Moteur] ${String(content ?? "").trim()}`;
    }
    const newMsg = {
      id: id ?? nextMessageId(),
      role,
      content: effectiveContent,
      ...(effectiveType && { type: effectiveType }),
      ...(senderName ? { senderName } : {}),
      ...(contextBox ? { contextBox } : {}),
    };
    // Append atomique basé sur le ref à jour : évite une fenêtre où un flush Firestore
    // lit un historique sans le dernier message (désynchronisation inter-clients).
    const base = Array.isArray(messagesStateRef.current) ? messagesStateRef.current : [];
    const next = [...base, newMsg as Message];
    messagesStateRef.current = next;
    setMessages(next);
  }

  function appendSceneImagePendingSlot(
    pendingId: string,
    pendingLabel: string,
    debugContent: string | null
  ) {
    setMessages((prev) => {
      const filtered = prev.filter((m) => m.type !== "scene-image-pending");
      const next: Message[] = [
        ...filtered,
        {
          id: pendingId,
          role: "ai",
          content: pendingLabel,
          type: "scene-image-pending" as const,
        },
      ];
      if (debugContent) {
        next.push({
          id: nextMessageId(),
          role: "ai",
          content: debugContent,
          type: "debug",
        });
      }
      messagesStateRef.current = next;
      return next;
    });
  }

  function updateMessage(messageId: string, patch: Partial<Message>) {
    setMessages((prev) => {
      const next = prev.map((m) => (m.id === messageId ? ({ ...m, ...patch } as Message) : m));
      messagesStateRef.current = next;
      return next;
    });
  }

  function removeMessagesByIds(ids: string[]) {
    const set = new Set(ids);
    setMessages((prev) => {
      const next = prev.filter((m) => !set.has(m.id));
      messagesStateRef.current = next;
      return next;
    });
  }

  const updatePlayer = useCallback((patch: Partial<Player>) => {
    setPlayer((prev) => {
      if (!prev) return prev;
      let next: Player;
      if (patch.inventory !== undefined && Array.isArray(patch.inventory)) {
        next = {
          ...prev,
          ...patch,
          inventory: stackInventory(
            patch.inventory.map((x) => String(x ?? "").trim()).filter(Boolean)
          ),
        };
      } else {
        next = { ...prev, ...patch };
      }
      if (
        patch.equipment !== undefined ||
        patch.stats !== undefined ||
        patch.fighter !== undefined ||
        patch.entityClass !== undefined ||
        patch.feats !== undefined
      ) {
        next = {
          ...next,
          ac: computePlayerArmorClass({
            stats: next.stats,
            entityClass: next.entityClass,
            equipment: next.equipment,
            fighter: next.fighter,
          }),
        };
      }
      return next;
    });
  }, [setPlayer]);

  function setHp(value: number) {
    setPlayer((prev) => {
      if (!prev || !prev.hp) return prev;
      const nextCurrent = Math.max(0, Math.min(value, prev.hp.max));
      const nextDeathState =
        nextCurrent > 0
          ? normalizeDeathState(null, nextCurrent)
          : normalizeDeathState(prev.deathState, nextCurrent);
      return {
        ...prev,
        isAlive: nextDeathState.dead !== true,
        deathState: nextDeathState,
        hp: {
          ...prev.hp,
          current: nextCurrent,
        },
      };
    });
  }

  const getEntitiesSnapshot = useCallback((): Entity[] => {
    return Array.isArray(entitiesRef.current) ? entitiesRef.current : [];
  }, []);

  function applyEntityUpdates(updates: EntityUpdate[]) {
    const normalizeHpShape = (
      incomingHp: any,
      fallbackHp: { current: number; max: number } | null
    ): { current: number; max: number } | null => {
      if (incomingHp === null) return null;
      if (typeof incomingHp === "number" && Number.isFinite(incomingHp)) {
        const v = Math.max(0, Math.floor(incomingHp));
        return { current: v, max: v };
      }
      if (incomingHp && typeof incomingHp === "object") {
        const currRaw = incomingHp.current;
        const maxRaw = incomingHp.max;
        const fallbackCurrent =
          typeof fallbackHp?.current === "number" ? fallbackHp.current : 0;
        const fallbackMax =
          typeof fallbackHp?.max === "number"
            ? fallbackHp.max
            : Math.max(fallbackCurrent, 1);
        const currentVal =
          typeof currRaw === "number" && Number.isFinite(currRaw)
            ? Math.max(0, Math.floor(currRaw))
            : fallbackCurrent;
        const maxValRaw =
          typeof maxRaw === "number" && Number.isFinite(maxRaw)
            ? Math.max(1, Math.floor(maxRaw))
            : fallbackMax;
        return { current: currentVal, max: Math.max(maxValRaw, currentVal) };
      }
      return fallbackHp ?? null;
    };

    const normalizePlayerWeapons = (
      incomingWeapons: EntityUpdate["weapons"],
      fallbackWeapons: CombatWeapon[]
    ): CombatWeapon[] => {
      if (!Array.isArray(incomingWeapons)) return fallbackWeapons;
      return incomingWeapons
        .map((weapon) => {
          if (!weapon || typeof weapon !== "object") return null;
          const name = String((weapon as any).name ?? "").trim();
          if (!name) return null;
          return {
            name,
            attackBonus:
              typeof (weapon as any).attackBonus === "number" &&
              Number.isFinite((weapon as any).attackBonus)
                ? Math.trunc((weapon as any).attackBonus)
                : 0,
            damageDice:
              typeof (weapon as any).damageDice === "string" &&
              String((weapon as any).damageDice).trim()
                ? String((weapon as any).damageDice).trim()
                : "1d4",
            damageBonus:
              typeof (weapon as any).damageBonus === "number" &&
              Number.isFinite((weapon as any).damageBonus)
                ? Math.trunc((weapon as any).damageBonus)
                : 0,
            kind:
              (weapon as any).kind === "melee" || (weapon as any).kind === "ranged"
                ? (weapon as any).kind
                : undefined,
            reach:
              typeof (weapon as any).reach === "string" && String((weapon as any).reach).trim()
                ? String((weapon as any).reach).trim()
                : undefined,
            range:
              typeof (weapon as any).range === "string" && String((weapon as any).range).trim()
                ? String((weapon as any).range).trim()
                : undefined,
          } satisfies CombatWeapon;
        })
        .filter(Boolean) as CombatWeapon[];
    };

    const applyPlayerUpdates = (base: Player | null, playerUpdates: EntityUpdate[]): Player | null => {
      if (!base) return base;
      let currentPlayer = base;

      for (const update of playerUpdates) {
        if (!update || typeof update !== "object") continue;
        const action = String(update.action ?? "").trim();

        if (action === "kill" || action === "remove") {
          currentPlayer = {
            ...currentPlayer,
            controller: "player",
            isAlive: false,
            hp: {
              ...currentPlayer.hp,
              current: 0,
            },
            surprised: false,
          };
          continue;
        }

        if (action !== "update" && action !== "spawn") continue;

        const merged: Player = {
          ...currentPlayer,
          controller: "player",
          ...(update.name !== undefined && { name: String(update.name ?? "").trim() || currentPlayer.name }),
          ...(update.visible !== undefined && { visible: update.visible }),
          ...(update.race !== undefined && { race: update.race }),
          ...(update.entityClass !== undefined && { entityClass: update.entityClass }),
          ...(update.description !== undefined && { description: update.description }),
          ...(update.stats !== undefined &&
            update.stats && {
              stats: {
                FOR: update.stats.FOR,
                DEX: update.stats.DEX,
                CON: update.stats.CON,
                INT: update.stats.INT,
                SAG: update.stats.SAG,
                CHA: update.stats.CHA,
              },
            }),
          ...(update.features !== undefined && { features: update.features ?? [] }),
          ...(update.selectedSpells !== undefined && {
            selectedSpells: Array.isArray(update.selectedSpells)
              ? update.selectedSpells.map((x) => String(x ?? "").trim()).filter(Boolean)
              : [],
          }),
          ...(update.spellSlots !== undefined && { spellSlots: update.spellSlots ?? undefined }),
          ...(update.spellAttackBonus !== undefined && {
            spellAttackBonus:
              typeof update.spellAttackBonus === "number" && Number.isFinite(update.spellAttackBonus)
                ? Math.trunc(update.spellAttackBonus)
                : currentPlayer.spellAttackBonus,
          }),
          ...(update.spellSaveDc !== undefined && {
            spellSaveDc:
              typeof update.spellSaveDc === "number" && Number.isFinite(update.spellSaveDc)
                ? Math.trunc(update.spellSaveDc)
                : currentPlayer.spellSaveDc,
          }),
          ...(update.weapons !== undefined && {
            weapons: normalizePlayerWeapons(update.weapons, currentPlayer.weapons ?? []),
          }),
          ...((update.inventory !== undefined || update.lootItems !== undefined) && {
            inventory: stackInventory(
              Array.isArray(update.inventory)
                ? update.inventory.map((x) => String(x ?? "").trim()).filter(Boolean)
                : Array.isArray(update.lootItems)
                  ? [
                      ...(Array.isArray(currentPlayer.inventory)
                        ? currentPlayer.inventory.map((x) => String(x ?? "").trim()).filter(Boolean)
                        : []),
                      ...update.lootItems.map((x) => String(x ?? "").trim()).filter(Boolean),
                    ]
                  : []
            ),
          }),
          ...(update.surprised !== undefined && { surprised: !!update.surprised }),
          ...(update.awareOfPlayer !== undefined && { awareOfPlayer: !!update.awareOfPlayer }),
          ...(update.conditions !== undefined && {
            conditions: Array.isArray(update.conditions)
              ? update.conditions.map((x) => String(x ?? "").trim()).filter(Boolean)
              : [],
          }),
          ...(update.combatTimedStates !== undefined && {
            combatTimedStates: Array.isArray(update.combatTimedStates)
              ? (update.combatTimedStates as CombatTimedStateEntry[])
                  .filter(
                    (x) =>
                      x &&
                      typeof x.stateId === "string" &&
                      typeof x.rounds === "number" &&
                      Number.isFinite(x.rounds) &&
                      x.rounds > 0
                  )
                  .map((x) => ({
                    stateId: String(x.stateId ?? "").trim(),
                    rounds: Math.max(1, Math.trunc(x.rounds)),
                  }))
                  .filter((x) => x.stateId.length > 0)
              : [],
          }),
        };

        if (update.hp !== undefined) {
          const nextHp =
            normalizeHpShape(update.hp, currentPlayer.hp) ?? {
              current: 0,
              max: currentPlayer.hp.max,
            };
          merged.hp = nextHp;
          merged.isAlive = nextHp.current > 0;
          if (nextHp.current > 0) {
            merged.deathState = {
              successes: 0,
              failures: 0,
              stable: false,
              unconscious: false,
              dead: false,
              autoRecoverAtMinute: null,
            };
          }
        }

        if (update.ac !== undefined) {
          merged.ac =
            typeof update.ac === "number" && Number.isFinite(update.ac)
              ? Math.trunc(update.ac)
              : currentPlayer.ac;
        }

        if (typeof update.acDelta === "number" && Number.isFinite(update.acDelta)) {
          merged.ac = merged.ac + update.acDelta;
        }

        if (typeof update.hitDiceTotal === "number" && Number.isFinite(update.hitDiceTotal)) {
          merged.hitDiceTotal = Math.max(1, Math.trunc(update.hitDiceTotal));
        }
        const hitDiceCap =
          merged.hitDiceTotal ?? currentPlayer.hitDiceTotal ?? currentPlayer.level ?? 1;
        if (typeof update.hitDiceRemaining === "number" && Number.isFinite(update.hitDiceRemaining)) {
          merged.hitDiceRemaining = Math.max(
            0,
            Math.min(hitDiceCap, Math.trunc(update.hitDiceRemaining))
          );
        } else if (typeof update.hitDiceTotal === "number" && Number.isFinite(update.hitDiceTotal)) {
          const prevRem = currentPlayer.hitDiceRemaining ?? 0;
          merged.hitDiceRemaining = Math.min(hitDiceCap, prevRem);
        }

        currentPlayer = merged;
      }

      return currentPlayer;
    };

    const playerUpdateIds = new Set([String(player?.id ?? "").trim()].filter(Boolean));
    // Solo / hors session : `id:"player"` désigne la fiche locale. En MP, un autre onglet peut résoudre
    // l'API avec le snapshot du soumetteur : ne jamais traiter `player` comme le PJ de cet onglet
    // (sinon loot / mises à jour IA sur la mauvaise fiche).
    if (!multiplayerSessionId) {
      playerUpdateIds.add("player");
    }
    if (multiplayerSessionId && typeof clientId === "string" && clientId.trim()) {
      playerUpdateIds.add(`mp-player-${clientId.trim()}`);
    }

    const playerUpdates = (Array.isArray(updates) ? updates : []).filter((update) => {
      const id = typeof update?.id === "string" ? update.id.trim() : "";
      return playerUpdateIds.has(id);
    });

    if (playerUpdates.length) {
      if (
        playerUpdates.some((update) => update?.action === "kill" || update?.action === "remove")
      ) {
        pruneDeadFromMelee(localPlayerCombatantIdForMelee);
        if (localPlayerCombatantIdForMelee !== "player") pruneDeadFromMelee("player");
      }
      setPlayer((prev) => applyPlayerUpdates(prev, playerUpdates));
    }

    const nonPlayerUpdates = (Array.isArray(updates) ? updates : []).filter((update) => {
      const id = typeof update?.id === "string" ? update.id.trim() : "";
      return !playerUpdateIds.has(id);
    });

    if (!nonPlayerUpdates.length) return;

    setEntities((prev) => {
      let current = [...prev];
      const applyDerivedModifiers = (base: Entity, update: EntityUpdate): Entity => {
        let next = base;

        if (typeof update.acDelta === "number" && Number.isFinite(update.acDelta)) {
          const currAc = typeof next.ac === "number" ? next.ac : 0;
          next = { ...next, ac: currAc + update.acDelta };
        }

        if (update.statDeltas && typeof update.statDeltas === "object") {
          const currStats = next.stats ?? {
            FOR: 10,
            DEX: 10,
            CON: 10,
            INT: 10,
            SAG: 10,
            CHA: 10,
          };
          const deltas = update.statDeltas;
          const merged: EntityStats = {
            FOR: currStats.FOR + (typeof deltas.FOR === "number" ? deltas.FOR : 0),
            DEX: currStats.DEX + (typeof deltas.DEX === "number" ? deltas.DEX : 0),
            CON: currStats.CON + (typeof deltas.CON === "number" ? deltas.CON : 0),
            INT: currStats.INT + (typeof deltas.INT === "number" ? deltas.INT : 0),
            SAG: currStats.SAG + (typeof deltas.SAG === "number" ? deltas.SAG : 0),
            CHA: currStats.CHA + (typeof deltas.CHA === "number" ? deltas.CHA : 0),
          };
          next = { ...next, stats: merged };
        }

        return next;
      };

      const usedIds = new Set(current.map((e) => e.id));
      const spawnCounters: Record<string, number> = {};
      const toSafeIdBase = (s: string) =>
        String(s ?? "")
          .trim()
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "") || "spawn";
      const nextSpawnId = (baseHint: string) => {
        const base = toSafeIdBase(baseHint);
        const currentCount = spawnCounters[base] ?? 0;
        let n = Math.max(1, currentCount + 1);
        let candidate = `${base}_${n}`;
        while (usedIds.has(candidate)) {
          n += 1;
          candidate = `${base}_${n}`;
        }
        spawnCounters[base] = n;
        usedIds.add(candidate);
        return candidate;
      };

      for (const update of nonPlayerUpdates) {
        if (update.action === "spawn") {
          const incomingId =
            typeof update.id === "string" && update.id.trim() ? update.id.trim() : null;
          const templateId =
            (typeof update.templateId === "string" && update.templateId.trim()
              ? update.templateId.trim()
              : null) ??
            (incomingId ? getEncounterTemplateIdForRoom(currentRoomId, incomingId) : null) ??
            (incomingId ? inferTemplateIdFromEntityId(incomingId) : null) ??
            inferTemplateIdFromEntityLike(update);
          const template =
            templateId && (BESTIARY as any)?.[templateId] ? (BESTIARY as any)[templateId] : null;
          const providedRaw = update.name;
          const providedName = typeof providedRaw === "string" ? providedRaw.trim() : "";
          const resolvedSpawnName =
            providedName || String(template?.name ?? "").trim() || incomingId || "";
          const resolvedSpawnId =
            incomingId ??
            nextSpawnId(
              String(
                templateId ??
                  update.name ??
                  template?.name ??
                  update.type ??
                  "spawn"
              )
            );

          const normType = normalizeEntityType(update.type ?? template?.type);
          if (normType === "object") {
            // On ignore désormais les objets de décor : seules les créatures sont conservées.
            continue;
          }
          const idx = current.findIndex((e) => e.id === resolvedSpawnId);
          const logicalDuplicateIdx =
            resolvedSpawnName
              ? current.findIndex((e) => {
                  if (normalizeEntityNameKey(e?.name) !== normalizeEntityNameKey(resolvedSpawnName)) {
                    return false;
                  }
                  const et = normalizeEntityType(e?.type) ?? "npc";
                  const ntSpawn = normType ?? "npc";
                  if (et === ntSpawn) return true;
                  return (
                    entityCoalesceBucket(et) === "social" && entityCoalesceBucket(ntSpawn) === "social"
                  );
                })
              : -1;
          const mergeIdx = idx >= 0 ? idx : logicalDuplicateIdx;

          // Anti-clone : même id déjà en jeu → fusion (évite Gobelin C/D si l'IA respawn le même id)
          if (mergeIdx >= 0) {
            const ent = current[mergeIdx];
            const mergedName = resolvedSpawnName || ent.name;
            const nt = reconcileNpcFriendlyTypes(normType ?? "npc", ent.type);
            current = current.map((e, i) =>
              i !== mergeIdx
                ? e
                : {
                    ...e,
                    templateId: templateId ?? e.templateId,
                    name: mergedName,
                    type: nt,
                    controller: normalizeEntityController(update.controller ?? ent.controller),
                    ...(update.race !== undefined && { race: update.race }),
                    ...(update.entityClass !== undefined && { entityClass: update.entityClass }),
                    ...(update.cr !== undefined && { cr: update.cr }),
                    ...(update.visible !== undefined && { visible: update.visible }),
                    ...(update.hp !== undefined && {
                      hp: normalizeHpShape(update.hp, ent.hp),
                    }),
                    ...(update.ac !== undefined && { ac: update.ac }),
                    ...(update.stats !== undefined && { stats: update.stats }),
                    ...(update.attackBonus !== undefined && { attackBonus: update.attackBonus }),
                    ...(update.damageDice !== undefined && { damageDice: update.damageDice }),
                    ...(update.damageBonus !== undefined && { damageBonus: update.damageBonus }),
                    ...(update.weapons !== undefined && { weapons: update.weapons }),
                    ...(update.features !== undefined && { features: update.features }),
                    ...(update.selectedSpells !== undefined && { selectedSpells: update.selectedSpells }),
                    ...(update.spellSlots !== undefined && { spellSlots: update.spellSlots }),
                    ...(update.spellAttackBonus !== undefined && {
                      spellAttackBonus: update.spellAttackBonus,
                    }),
                    ...(update.spellSaveDc !== undefined && { spellSaveDc: update.spellSaveDc }),
                    ...(update.description !== undefined && { description: update.description }),
                    ...(update.stealthDc !== undefined && { stealthDc: update.stealthDc }),
                    ...(update.surprised !== undefined && { surprised: !!update.surprised }),
                    ...(update.awareOfPlayer !== undefined && { awareOfPlayer: !!update.awareOfPlayer }),
                    ...(Array.isArray(update.conditions) && {
                      conditions: update.conditions.map((x) => String(x ?? "").trim()).filter(Boolean),
                    }),
                    ...(update.combatTimedStates !== undefined && {
                      combatTimedStates: Array.isArray(update.combatTimedStates)
                        ? (update.combatTimedStates as CombatTimedStateEntry[])
                            .filter(
                              (x) =>
                                x &&
                                typeof x.stateId === "string" &&
                                typeof x.rounds === "number" &&
                                Number.isFinite(x.rounds) &&
                                x.rounds > 0
                            )
                            .map((x) => ({
                              stateId: String(x.stateId ?? "").trim(),
                              rounds: Math.max(1, Math.trunc(x.rounds)),
                            }))
                            .filter((x) => x.stateId.length > 0)
                        : [],
                    }),
                    isAlive: true,
                  }
            );
            continue;
          }

          const resolvedController = normalizeEntityController(update.controller);

          const newEntity: Entity = {
            id: resolvedSpawnId,
            templateId: templateId ?? undefined,
            name: resolvedSpawnName,
            type: normType ?? "npc",
            controller: resolvedController,
            race: update.race ?? template?.race ?? "Inconnu",
            entityClass: update.entityClass ?? template?.entityClass ?? "Inconnu",
            cr: update.cr ?? template?.cr ?? 0,
            visible: update.visible ?? true,
            isAlive: true,
            hp: normalizeHpShape(update.hp ?? template?.hp ?? null, null),
            ac: update.ac ?? template?.ac ?? null,
            stats: update.stats ?? template?.stats ?? null,
            attackBonus: update.attackBonus ?? template?.attackBonus ?? null,
            damageDice: update.damageDice ?? template?.damageDice ?? null,
            damageBonus: update.damageBonus ?? template?.damageBonus ?? null,
            weapons: update.weapons ?? template?.weapons ?? null,
            features: update.features ?? template?.features ?? null,
            selectedSpells: update.selectedSpells ?? template?.selectedSpells ?? null,
            spellSlots: update.spellSlots ?? template?.spellSlots ?? null,
            spellAttackBonus: update.spellAttackBonus ?? template?.spellAttackBonus ?? null,
            spellSaveDc: update.spellSaveDc ?? template?.spellSaveDc ?? null,
            description: update.description ?? template?.description ?? "",
            stealthDc: update.stealthDc ?? template?.stealthDc ?? null,
            conditions: Array.isArray(update.conditions)
              ? update.conditions.map((x) => String(x ?? "").trim()).filter(Boolean)
              : undefined,
            combatTimedStates: Array.isArray(update.combatTimedStates)
              ? (update.combatTimedStates as CombatTimedStateEntry[])
                  .filter(
                    (x) =>
                      x &&
                      typeof x.stateId === "string" &&
                      typeof x.rounds === "number" &&
                      Number.isFinite(x.rounds) &&
                      x.rounds > 0
                  )
                  .map((x) => ({
                    stateId: String(x.stateId ?? "").trim(),
                    rounds: Math.max(1, Math.trunc(x.rounds)),
                  }))
                  .filter((x) => x.stateId.length > 0)
              : undefined,
            lootItems:
              update.lootItems ??
              (Array.isArray(update.inventory)
                ? update.inventory.map((x) => String(x ?? "").trim()).filter(Boolean)
                : null),
            looted: update.looted ?? false,
            surprised: update.surprised ?? false,
            awareOfPlayer:
              typeof update.awareOfPlayer === "boolean"
                ? update.awareOfPlayer
                : (normType ?? "npc") === "hostile",
          };
          current = [...current, applyDerivedModifiers(newEntity, update)];
        } else if (update.action === "update") {
          const updateId = typeof update.id === "string" && update.id.trim() ? update.id.trim() : null;
          if (!updateId) continue;
          const exists = current.some((e) => e.id === updateId);
          if (!exists) {
            continue;
          }
          current = current.map((e) => {
            if (e.id !== updateId) return e;
            const normType = update.type !== undefined ? normalizeEntityType(update.type) : undefined;
            const inferredTemplateId =
              (typeof update.templateId === "string" && update.templateId.trim()
                ? update.templateId.trim()
                : null) ??
              inferTemplateIdFromEntityLike({ ...e, ...update, id: updateId });
            const template =
              inferredTemplateId && (BESTIARY as any)?.[inferredTemplateId]
                ? (BESTIARY as any)[inferredTemplateId]
                : null;
            // Si on nous demande de transformer une entité en "object", on la retire simplement.
            if (normType === "object") {
              return null as any;
            }
            const merged: Entity = {
              ...e,
              ...(inferredTemplateId && { templateId: inferredTemplateId }),
              ...(update.name        !== undefined && { name:        update.name }),
              ...(update.type        !== undefined && normType && { type: normType ?? e.type }),
              ...(update.controller  !== undefined && { controller: normalizeEntityController(update.controller) }),
              ...(update.race        !== undefined && { race:        update.race }),
              ...(update.entityClass !== undefined && { entityClass: update.entityClass }),
              ...(update.cr          !== undefined && { cr:          update.cr }),
              ...(update.visible     !== undefined && { visible:     update.visible }),
              ...(update.hp          !== undefined && {
                hp: normalizeHpShape(update.hp, e.hp),
              }),
              ...(update.ac          !== undefined && { ac:          update.ac }),
              ...(update.stats       !== undefined && { stats:       update.stats }),
              ...(update.attackBonus !== undefined && { attackBonus: update.attackBonus }),
              ...(update.damageDice  !== undefined && { damageDice:  update.damageDice }),
              ...(update.damageBonus !== undefined && { damageBonus: update.damageBonus }),
              ...(update.weapons     !== undefined && { weapons:     update.weapons }),
              ...(update.features    !== undefined && { features:    update.features }),
              ...(update.selectedSpells !== undefined && { selectedSpells: update.selectedSpells }),
              ...(update.spellSlots !== undefined && { spellSlots: update.spellSlots }),
              ...(update.spellAttackBonus !== undefined && {
                spellAttackBonus: update.spellAttackBonus,
              }),
              ...(update.spellSaveDc !== undefined && { spellSaveDc: update.spellSaveDc }),
              ...(update.description !== undefined && { description: update.description }),
              ...(update.stealthDc   !== undefined && { stealthDc:   update.stealthDc }),
              ...(update.lootItems   !== undefined && { lootItems:   update.lootItems }),
              ...(update.looted      !== undefined && { looted:      update.looted }),
              ...(update.surprised   !== undefined && { surprised:   !!update.surprised }),
              ...(update.awareOfPlayer !== undefined && { awareOfPlayer: !!update.awareOfPlayer }),
              ...(update.conditions !== undefined && {
                conditions: Array.isArray(update.conditions)
                  ? update.conditions.map((x) => String(x ?? "").trim()).filter(Boolean)
                  : [],
              }),
              ...(update.combatTimedStates !== undefined && {
                combatTimedStates: Array.isArray(update.combatTimedStates)
                  ? (update.combatTimedStates as CombatTimedStateEntry[])
                      .filter(
                        (x) =>
                          x &&
                          typeof x.stateId === "string" &&
                          typeof x.rounds === "number" &&
                          Number.isFinite(x.rounds) &&
                          x.rounds > 0
                      )
                      .map((x) => ({
                        stateId: String(x.stateId ?? "").trim(),
                        rounds: Math.max(1, Math.trunc(x.rounds)),
                      }))
                      .filter((x) => x.stateId.length > 0)
                  : [],
              }),
            };
            if (update.hp !== undefined) {
              merged.isAlive = (merged.hp?.current ?? 0) > 0;
            }
            const nextType = normType ?? merged.type;
            if (nextType === "hostile" && template) {
              if (!merged.race) merged.race = template.race ?? merged.race;
              if (!merged.entityClass || merged.entityClass === "Inconnu") {
                merged.entityClass = template.entityClass ?? merged.entityClass;
              }
              if (merged.cr == null) merged.cr = template.cr ?? merged.cr;
              if (merged.ac == null) merged.ac = template.ac ?? merged.ac;
              if (!merged.stats) merged.stats = template.stats ?? merged.stats;
              if (merged.attackBonus == null) merged.attackBonus = template.attackBonus ?? merged.attackBonus;
              if (!merged.damageDice) merged.damageDice = template.damageDice ?? merged.damageDice;
              if (merged.damageBonus == null) merged.damageBonus = template.damageBonus ?? merged.damageBonus;
              if (!Array.isArray(merged.weapons) || merged.weapons.length === 0) {
                merged.weapons = template.weapons ?? merged.weapons;
              }
              if (!Array.isArray(merged.features) || merged.features.length === 0) {
                merged.features = template.features ?? merged.features;
              }
              if (!Array.isArray(merged.selectedSpells) || merged.selectedSpells.length === 0) {
                merged.selectedSpells = template.selectedSpells ?? merged.selectedSpells;
              }
              if (!merged.spellSlots) merged.spellSlots = template.spellSlots ?? merged.spellSlots;
              if (merged.spellAttackBonus == null) {
                merged.spellAttackBonus = template.spellAttackBonus ?? merged.spellAttackBonus;
              }
              if (merged.spellSaveDc == null) {
                merged.spellSaveDc = template.spellSaveDc ?? merged.spellSaveDc;
              }
              if (!merged.description) merged.description = template.description ?? merged.description;
              if (merged.stealthDc == null) merged.stealthDc = template.stealthDc ?? merged.stealthDc;
            }
            return applyDerivedModifiers(merged, update);
          }).filter(Boolean) as Entity[];
        } else if (update.action === "kill") {
          const updateId = typeof update.id === "string" && update.id.trim() ? update.id.trim() : null;
          if (!updateId) continue;
          pruneDeadFromMelee(updateId);
          current = current.map((e) => {
            if (e.id !== updateId) return e;
            return {
              ...e,
              isAlive: false,
              hp: e.hp ? { ...e.hp, current: 0 } : null,
            };
          });
        } else if (update.action === "remove") {
          const updateId = typeof update.id === "string" && update.id.trim() ? update.id.trim() : null;
          if (!updateId) continue;
          current = current.filter((e) => e.id !== updateId);
        }
      }

      current = coalesceLogicalEntityDuplicates(current);
      entitiesRef.current = current;
      return current;
    });
    if (
      nonPlayerUpdates.some((u) => {
        const a = String(u?.action ?? "").trim();
        return a === "spawn" || a === "kill" || a === "remove";
      })
    ) {
      setSceneVersion((v) => v + 1);
    }

    const hostTrim = String(multiplayerHostClientId ?? "").trim();
    const meTrim = String(clientId ?? "").trim();
    if (
      multiplayerSessionId &&
      hostTrim &&
      meTrim &&
      hostTrim !== meTrim &&
      nonPlayerUpdates.some((u) => String(u?.action ?? "").trim() === "spawn")
    ) {
      void flushMultiplayerSharedState();
    }
  }

  function addMeleeMutual(a: string, b: string) {
    if (a === b) return;
    /** Sans ce bump, `localSeq` reste 0 et un snapshot distant legacy peut écraser la mêlée fraîche. */
    meleeEngagementSeqRef.current += 1;
    setMeleeState((prev) => {
      const next = cloneMeleeStateRecord(prev);
      const listA = [...(next[a] ?? [])];
      if (!listA.includes(b)) listA.push(b);
      next[a] = listA;
      const listB = [...(next[b] ?? [])];
      if (!listB.includes(a)) listB.push(a);
      next[b] = listB;
      const normalized = normalizeMeleeStateTransitive(next);
      meleeStateRef.current = cloneMeleeStateRecord(normalized);
      return normalized;
    });
    /** D&D 5e : entrer au contact révèle la position — on retire l’état « caché » moteur pour les deux. */
    setCombatHiddenIds((prev) => prev.filter((id) => id !== a && id !== b));
    setCombatStealthTotalByCombatantIdState((prev) => {
      const next = { ...prev };
      delete next[a];
      delete next[b];
      combatStealthTotalByCombatantIdRef.current = next;
      return next;
    });
    if (a === localPlayerCombatantIdForMelee || b === localPlayerCombatantIdForMelee) {
      const other = a === localPlayerCombatantIdForMelee ? b : a;
      setEngagedWithId(other);
    }
  }

  function removeFromMelee(a: string, b: string) {
    meleeEngagementSeqRef.current += 1;
    setMeleeState((prev) => {
      const next = cloneMeleeStateRecord(prev);
      next[a] = (prev[a] ?? []).filter((id) => id !== b);
      next[b] = (prev[b] ?? []).filter((id) => id !== a);
      const normalized = normalizeMeleeStateTransitive(next);
      meleeStateRef.current = cloneMeleeStateRecord(normalized);
      return normalized;
    });
    if (a === localPlayerCombatantIdForMelee || b === localPlayerCombatantIdForMelee) {
      setEngagedWithId((curr) => (curr === a || curr === b ? null : curr));
    }
  }

  function clearMeleeFor(id: string) {
    meleeEngagementSeqRef.current += 1;
    setMeleeState((prev) => {
      const next = cloneMeleeStateRecord(prev);
      const withMe = prev[id] ?? [];
      for (const otherId of withMe) {
        next[otherId] = (next[otherId] ?? []).filter((x) => x !== id);
      }
      next[id] = [];
      const normalized = normalizeMeleeStateTransitive(next);
      meleeStateRef.current = cloneMeleeStateRecord(normalized);
      return normalized;
    });
    if (id === localPlayerCombatantIdForMelee) setEngagedWithId(null);
  }

  function getMeleeWith(id: string): string[] {
    const direct = meleeState[id];
    if (Array.isArray(direct) && direct.length > 0) return direct;
    const mid = localPlayerCombatantIdForMelee;
    /** Solo : mêlée parfois sous `player` alors que l’ordre utilise `player.id`. */
    if (!multiplayerSessionId) {
      if (id === "player" && mid && mid !== "player") {
        const alt = meleeState[mid];
        if (Array.isArray(alt) && alt.length > 0) return alt;
      }
      if (id === mid && mid !== "player") {
        const leg = meleeState["player"];
        if (Array.isArray(leg) && leg.length > 0) return leg;
      }
    } else if (mid) {
      /** Multijoueur : tolère `player` vs `mp-player-<cid>` pour la même mêlée. */
      if (id === mid) {
        const leg = meleeState["player"];
        if (Array.isArray(leg) && leg.length > 0) return leg;
      }
      if (id === "player") {
        const alt = meleeState[mid];
        if (Array.isArray(alt) && alt.length > 0) return alt;
      }
    }
    /** Si la clé `id` est vide mais un autre combattant liste `id` (sync partiel / état asymétrique). */
    const reverse: string[] = [];
    for (const [k, peers] of Object.entries(meleeState)) {
      if (!Array.isArray(peers) || k === id) continue;
      if (peers.includes(id)) reverse.push(k);
    }
    if (reverse.length > 0) return [...new Set(reverse)];
    const tail = meleeState[id];
    return Array.isArray(tail) ? tail : [];
  }

  const setReactionFor = useCallback((id: string, value: boolean) => {
    setReactionState((prev) => {
      if (prev[id] === value) return prev;
      return { ...prev, [id]: value };
    });
  }, []);

  function hasReaction(id: string): boolean {
    return reactionState[id] !== false;
  }

  function initCombatReactions(combatOrder: { id: string }[]) {
    const initial: Record<string, boolean> = {};
    for (const entry of combatOrder ?? []) {
      if (entry?.id) initial[entry.id] = true;
    }
    setReactionState(initial);
    setCombatHiddenIds([]);
    combatStealthTotalByCombatantIdRef.current = {};
    setCombatStealthTotalByCombatantIdState({});
  }

  function pruneDeadFromMelee(deadId: string) {
    meleeEngagementSeqRef.current += 1;
    setMeleeState((prev) => {
      const next = cloneMeleeStateRecord(prev);
      const withDead = prev[deadId] ?? [];
      for (const otherId of withDead) {
        next[otherId] = (next[otherId] ?? []).filter((x) => x !== deadId);
      }
      next[deadId] = [];
      const normalized = normalizeMeleeStateTransitive(next);
      meleeStateRef.current = cloneMeleeStateRecord(normalized);
      return normalized;
    });
    setCombatHiddenIds((prev) => prev.filter((id) => id !== deadId));
    setCombatStealthTotalForCombatant(deadId, null);
    if (deadId === localPlayerCombatantIdForMelee || deadId === "player") setEngagedWithId(null);
  }

  function rollInitiativeD20() {
    return Math.floor(Math.random() * 20) + 1;
  }

  const registerCombatNextTurn = useCallback((fn: (() => Promise<void>) | null) => {
    combatNextTurnRef.current = fn;
  }, []);

  const nextTurn = useCallback(async () => {
    const fn = combatNextTurnRef.current;
    if (fn) await fn();
  }, []);

  const commitPlayerInitiativeRoll = useCallback((options?: { manualNat?: number | null }): CombatEntry[] | null => {
    if (!player || !awaitingPlayerInitiative) return null;
    // Le bandeau peut être affiché avec `awaitingPlayerInitiative` venant du sync alors que
    // `npcInitiativeDraft` est encore vide (snapshot Firestore sans brouillon PNJ, ou effet
    // d'hostiles en retard). Sans brouillon, le clic « Lancer l'initiative » ne fait rien.
    const hostilesNow = entities.filter((e) => isHostileReadyForCombat(e));
    let draftForMerge = npcInitiativeDraft;
    if (draftForMerge.length > 0 && !npcInitiativeDraftMatchesHostiles(draftForMerge, hostilesNow)) {
      draftForMerge = [];
      npcInitiativeDraftRef.current = [];
      setNpcInitiativeDraft([]);
    }
    if (draftForMerge.length === 0) {
      const cached = initiativeDraftCacheRef.current;
      const cacheOk =
        cached &&
        Array.isArray(cached) &&
        cached.length > 0 &&
        npcInitiativeDraftMatchesHostiles(cached, hostilesNow);
      if (cacheOk) {
        draftForMerge = cached.map((entry) => ({
          ...entry,
          name: resolveCombatantDisplayName(entry, entities, player.name ?? null),
        }));
      } else {
        if (cached && cached.length > 0) {
          initiativeDraftCacheRef.current = null;
        }
        if (hostilesNow.length === 0) return null;
        draftForMerge = hostilesNow.map((e) => {
          const dex = Math.floor(((e.stats?.DEX ?? 10) - 10) / 2);
          return {
            id: e.id,
            name: e.name,
            initiative: rollInitiativeD20() + dex,
          };
        });
        initiativeDraftCacheRef.current = draftForMerge;
      }
      npcInitiativeDraftRef.current = draftForMerge;
      setNpcInitiativeDraft(draftForMerge);
    }
    // Garde-fou anti-dédoublement : si un combat est déjà initialisé,
    // on ne doit jamais re-finaliser une nouvelle initiative (sinon tu obtiens
    // plusieurs "Jet d'Initiative" avec des valeurs différentes).
    if (Array.isArray(combatOrderRef.current) && combatOrderRef.current.length > 0) return null;
    // En multijoueur, on stocke les jets par participant (clé stable par client),
    // pour éviter qu'un PJ local écrase le jet des autres clients.
    const pid =
      multiplayerSessionId
        ? `mp-player-${String(clientId ?? "").trim()}`
        : typeof player.id === "string" && player.id.trim()
          ? player.id.trim()
          : "player";

    const participantNameById: Record<string, string> =
      multiplayerSessionId && Array.isArray(multiplayerParticipantProfiles)
        ? Object.fromEntries(
            multiplayerParticipantProfiles
              .map((p) => {
                const cid = String(p?.clientId ?? "").trim();
                if (!cid) return null;
                const preferredName = String(
                  p?.playerSnapshot?.name ?? p?.name ?? ""
                ).trim();
                if (!preferredName) return null;
                return [`mp-player-${cid}`, preferredName];
              })
              .filter(Boolean) as [string, string][]
          )
        : {};
    const mpParticipantEntitiesForInitiative =
      multiplayerSessionId && Array.isArray(multiplayerParticipantProfiles)
        ? multiplayerParticipantProfiles
            // Ne pas exclure les PJ à 0 PV : ils restent dans l'ordre (jets contre la mort au tour).
            // (Profil déconnecté : on garde quand même l'entrée pour ne pas casser l'ordre mid-combat.)
            .map(
              (p): any => ({
                id: `mp-player-${p.clientId}`,
                name:
                  participantNameById[`mp-player-${String(p?.clientId ?? "").trim()}`] ??
                  `Participant ${p.clientId}`,
                type: "friendly",
                controller: "player",
                visible: true,
                isAlive: true,
                hp: p.hpCurrent != null && p.hpMax != null ? { current: p.hpCurrent, max: p.hpMax } : null,
              })
            )
        : [];

    const mpParticipantIdsForInitiative =
      mpParticipantEntitiesForInitiative.length > 0
        ? mpParticipantEntitiesForInitiative
            .map((e: any) => String(e.id ?? "").trim())
            .filter(Boolean)
        : [];
    const existingVal = playerInitiativeRollsByEntityIdRef.current?.[pid];
    // Durcissement MP : si on a déjà un jet d'initiative enregistré pour ce participant
    // dans le cycle courant, on ne doit pas relancer un d20 (sinon tu obtiens plusieurs
    // "Jet d'Initiative" avec des valeurs différentes).
    const shouldReRoll = !(typeof existingVal === "number" && Number.isFinite(existingVal));

    let val: number;
    if (shouldReRoll) {
      let nat: number;
      const rawManual = options?.manualNat;
      if (typeof rawManual === "number" && Number.isFinite(rawManual)) {
        const t = Math.trunc(rawManual);
        if (t >= 1 && t <= 20) {
          nat = t;
        } else if (debugNextRoll !== null) {
          nat = debugNextRoll;
          setDebugNextRoll(null);
        } else {
          nat = rollInitiativeD20();
        }
      } else if (debugNextRoll !== null) {
        nat = debugNextRoll;
        setDebugNextRoll(null);
      } else {
        nat = rollInitiativeD20();
      }
      const dex = Math.floor(((player.stats?.DEX ?? 10) - 10) / 2);
      val = nat + dex;
    } else {
      val = existingVal as number;
    }

    const nextRolls = { ...playerInitiativeRollsByEntityId, [pid]: val };
    setPlayerInitiativeRollsByEntityId(nextRolls);
    playerInitiativeRollsByEntityIdRef.current = nextRolls;

    // Durcissement MP : si un client n'a pas encore la liste des participants (profiles),
    // il ne doit pas finaliser l'initiative "avec seulement [pid]" (sinon un seul client coupe
    // le bandeau initiative chez les autres).
    let ids: string[] = [];
    if (multiplayerSessionId) {
      const requiredMpIdsFromParticipants =
        multiplayerParticipantClientIds.length > 0
          ? multiplayerParticipantClientIds.map((cid) => `mp-player-${cid}`)
          : [];
      if (requiredMpIdsFromParticipants.length > 1) {
        ids = requiredMpIdsFromParticipants;
      } else if (mpParticipantIdsForInitiative.length > 0) {
        ids = mpParticipantIdsForInitiative;
      } else if (multiplayerParticipants > 1) {
        const mpRolledIds = Object.keys(nextRolls).filter((k) => k.startsWith("mp-player-"));
        if (mpRolledIds.length < multiplayerParticipants) return null;
        ids = mpRolledIds;
      } else {
        ids = [pid];
      }
    } else {
      const required = getPlayerEntityIdsForInitiative(entities);
      ids = required.length > 0 ? required : [pid];
    }

    const allReady = ids.every((id) => typeof nextRolls[id] === "number" && Number.isFinite(nextRolls[id]));
    if (!allReady) return null;

    const entitiesForInitiative =
      multiplayerSessionId && mpParticipantEntitiesForInitiative.length > 0
        ? [...entities, ...mpParticipantEntitiesForInitiative]
        : entities;

    const merged = buildMergedInitiativeOrder(
      ids,
      nextRolls,
      draftForMerge,
      entitiesForInitiative,
      player.name ?? null,
      participantNameById
    );

    // Messages d'initiative dans le chat : ChatInterface.handleCommitInitiative (id déterministe + récap).

    initCombatReactions(merged);
    combatOrderRef.current = merged;
    combatTurnIndexRef.current = 0;
    awaitingPlayerInitiativeRef.current = false;
    npcInitiativeDraftRef.current = [];
    playerInitiativeRollsByEntityIdRef.current = {};
    setCombatOrder(merged);
    setCombatTurnIndex(0);
    setAwaitingPlayerInitiative(false);
    setNpcInitiativeDraft([]);
    setPlayerInitiativeRollsByEntityId({});
    initiativeDraftCacheRef.current = null;
    initiativeRemoteFinalizeSigRef.current = null;
    return merged;
  }, [
    player,
    awaitingPlayerInitiative,
    npcInitiativeDraft,
    playerInitiativeRollsByEntityId,
    entities,
    multiplayerSessionId,
    clientId,
    multiplayerParticipantClientIds,
    multiplayerParticipantProfiles,
    multiplayerParticipants,
    debugNextRoll,
    setDebugNextRoll,
  ]);

  /** Finalise l'ordre quand le dernier jet arrive par sync (sans clic local du dernier joueur). */
  useEffect(() => {
    if (!awaitingPlayerInitiative) return;
    if (combatOrder.length > 0) return;
    if (!player) return;

    const hostilesForInit = entities.filter((e) => isHostileReadyForCombat(e));
    let draftForFinalize = npcInitiativeDraft;
    if (draftForFinalize.length > 0 && !npcInitiativeDraftMatchesHostiles(draftForFinalize, hostilesForInit)) {
      draftForFinalize = [];
    }
    if (draftForFinalize.length === 0) {
      const cached = initiativeDraftCacheRef.current;
      const cacheOk =
        cached &&
        Array.isArray(cached) &&
        cached.length > 0 &&
        npcInitiativeDraftMatchesHostiles(cached, hostilesForInit);
      if (cacheOk) {
        draftForFinalize = cached.map((entry) => ({
          ...entry,
          name: resolveCombatantDisplayName(entry, entities, player?.name ?? null),
        }));
      } else {
        if (cached && cached.length > 0) {
          initiativeDraftCacheRef.current = null;
        }
        if (hostilesForInit.length === 0) return;
        draftForFinalize = hostilesForInit.map((e) => {
          const dex = Math.floor(((e.stats?.DEX ?? 10) - 10) / 2);
          return {
            id: e.id,
            name: e.name,
            initiative: rollInitiativeD20() + dex,
          };
        });
        initiativeDraftCacheRef.current = draftForFinalize;
      }
      npcInitiativeDraftRef.current = draftForFinalize;
      setNpcInitiativeDraft(draftForFinalize);
    }

    const pid =
      multiplayerSessionId
        ? `mp-player-${String(clientId ?? "").trim()}`
        : typeof player.id === "string" && player.id.trim()
          ? player.id.trim()
          : "player";

    const mpParticipantEntitiesForInitiative =
      multiplayerSessionId && Array.isArray(multiplayerParticipantProfiles)
        ? multiplayerParticipantProfiles
            // Même logique que commitPlayerInitiativeRoll : 0 PV n'enlève pas le PJ de l'ordre.
            .map(
              (p): any => ({
                id: `mp-player-${p.clientId}`,
                name:
                  String(p?.playerSnapshot?.name ?? p?.name ?? "").trim() ||
                  `Participant ${p.clientId}`,
                type: "friendly",
                controller: "player",
                visible: true,
                isAlive: true,
                hp: p.hpCurrent != null && p.hpMax != null ? { current: p.hpCurrent, max: p.hpMax } : null,
              })
            )
        : [];

    const mpParticipantIdsForInitiative =
      mpParticipantEntitiesForInitiative.length > 0
        ? mpParticipantEntitiesForInitiative
            .map((e: any) => String(e.id ?? "").trim())
            .filter(Boolean)
        : [];

    let ids: string[] = [];
    if (multiplayerSessionId) {
      const requiredMpIdsFromParticipants =
        multiplayerParticipantClientIds.length > 0
          ? multiplayerParticipantClientIds.map((cid) => `mp-player-${cid}`)
          : [];
      if (requiredMpIdsFromParticipants.length > 1) {
        ids = requiredMpIdsFromParticipants;
      } else if (mpParticipantIdsForInitiative.length > 0) {
        ids = mpParticipantIdsForInitiative;
      } else if (multiplayerParticipants > 1) {
        const mpRolledIds = Object.keys(playerInitiativeRollsByEntityId).filter((k) => k.startsWith("mp-player-"));
        if (mpRolledIds.length < multiplayerParticipants) return;
        ids = mpRolledIds;
      } else {
        ids = [pid];
      }
    } else {
      const required = getPlayerEntityIdsForInitiative(entities);
      ids = required.length > 0 ? required : [pid];
    }

    if (!ids.every((id) => typeof playerInitiativeRollsByEntityId[id] === "number")) return;

    const sig = JSON.stringify({
      ids: [...ids].sort(),
      rolls: ids.map((id) => playerInitiativeRollsByEntityId[id]),
      npc: draftForFinalize.map((e) => [e.id, e.initiative]),
    });
    if (initiativeRemoteFinalizeSigRef.current === sig) return;
    initiativeRemoteFinalizeSigRef.current = sig;

    const entitiesForInitiative =
      multiplayerSessionId && mpParticipantEntitiesForInitiative.length > 0
        ? [...entities, ...mpParticipantEntitiesForInitiative]
        : entities;

    const participantNameById: Record<string, string> =
      multiplayerSessionId && Array.isArray(multiplayerParticipantProfiles)
        ? Object.fromEntries(
            multiplayerParticipantProfiles
              .map((p) => {
                const cid = String(p?.clientId ?? "").trim();
                if (!cid) return null;
                const preferredName = String(
                  p?.playerSnapshot?.name ?? p?.name ?? ""
                ).trim();
                if (!preferredName) return null;
                return [`mp-player-${cid}`, preferredName];
              })
              .filter(Boolean) as [string, string][]
          )
        : {};
    const merged = buildMergedInitiativeOrder(
      ids,
      playerInitiativeRollsByEntityId,
      draftForFinalize,
      entitiesForInitiative,
      player.name ?? null,
      participantNameById
    );
    initCombatReactions(merged);
    combatOrderRef.current = merged;
    combatTurnIndexRef.current = 0;
    awaitingPlayerInitiativeRef.current = false;
    npcInitiativeDraftRef.current = [];
    playerInitiativeRollsByEntityIdRef.current = {};
    setCombatOrder(merged);
    setCombatTurnIndex(0);
    setAwaitingPlayerInitiative(false);
    setNpcInitiativeDraft([]);
    setPlayerInitiativeRollsByEntityId({});
    initiativeDraftCacheRef.current = null;

    const msgId = `initiative-order-${merged
      .map((e) => `${e.id}:${e.initiative}`)
      .sort()
      .join("|")}`;
    const hadInitiativeCard = messagesStateRef.current.some((m) => m.id === msgId);
    if (hadInitiativeCard) {
      seenInitiativeCardsRef.current.add(msgId);
    }
    const initiativeAlreadySeenThisCombat = seenInitiativeCardsRef.current.has(msgId);
    /** Narration MJ d'abord (ChatInterface) : ne pas insérer la carte initiative tant que le MJ n'a pas parlé. */
    if (!waitForGmNarrationForInitiativeRef.current && !initiativeAlreadySeenThisCombat) {
      setMessages((prev) => {
        if (prev.some((m) => m.id === msgId)) return prev;
        const rankLabel = (i: number) => (i === 0 ? "1er" : `${i + 1}e`);
        const orderText = merged
          .map((entry, idx) => {
            const display = resolveCombatantDisplayName(
              entry,
              entitiesRef.current ?? [],
              player.name ?? null
            );
            return `[${rankLabel(idx)}] ${display} (${entry.initiative})`;
          })
          .join("\n");
        const content = `🎲 **Jet d'Initiative**\n\n${orderText}\n\n⚔️ Le combat commence !`;
        const initiativeMsg: Message = { id: msgId, role: "ai", content, type: "dice" };
        const next = insertInitiativeOrderMessageIntoTimeline(prev, initiativeMsg);
        seenInitiativeCardsRef.current.add(msgId);
        messagesStateRef.current = next;
        return next;
      });
      if (multiplayerSessionId && !hadInitiativeCard) {
        setTimeout(() => {
          void flushMultiplayerSharedState();
        }, 0);
      }
    }
  }, [
    awaitingPlayerInitiative,
    combatOrder.length,
    npcInitiativeDraft,
    playerInitiativeRollsByEntityId,
    entities,
    player,
    multiplayerSessionId,
    clientId,
    multiplayerParticipantClientIds,
    multiplayerParticipantProfiles,
    multiplayerParticipants,
    flushMultiplayerSharedState,
    waitForGmNarrationForInitiative,
  ]);

  /** Signature stable de l'ordre d'initiative (évite de relancer l'effet « réparation » à chaque nouvelle référence de tableau). */
  const combatOrderInitiativeSig = useMemo(() => {
    if (!Array.isArray(combatOrder) || combatOrder.length === 0) return "";
    return combatOrder
      .map((e) => `${String(e.id ?? "")}:${e.initiative}`)
      .sort()
      .join("|");
  }, [combatOrder]);

  /**
   * Si l'ordre d'initiative a été finalisé pendant l'attente narration MJ, la carte
   * n'a pas été insérée (effet ci-dessus). Dès que `wait` tombe, on ajoute la carte une seule fois.
   */
  useEffect(() => {
    if (waitForGmNarrationForInitiative) return;
    if (awaitingPlayerInitiative) return;
    if (combatOrder.length === 0) return;
    // Ne pas recréer la carte d'initiative une fois le combat réellement démarré.
    // Sinon, si la carte est tombée hors payload/messages cap, elle réapparaît en bas au moindre sync.
    if ((typeof combatTurnWriteSeq === "number" && combatTurnWriteSeq > 0) || combatTurnIndex > 0) return;

    const msgId = `initiative-order-${combatOrder
      .map((e) => `${e.id}:${e.initiative}`)
      .sort()
      .join("|")}`;
    if (messagesStateRef.current.some((m) => m.id === msgId)) return;
    if (seenInitiativeCardsRef.current.has(msgId)) return;

    setMessages((prev) => {
      if (prev.some((m) => m.id === msgId)) return prev;
      const rankLabel = (i: number) => (i === 0 ? "1er" : `${i + 1}e`);
      const orderText = combatOrder
        .map((entry, idx) => {
          const display = resolveCombatantDisplayName(
            entry,
            entitiesRef.current ?? [],
            player?.name ?? null
          );
          return `[${rankLabel(idx)}] ${display} (${entry.initiative})`;
        })
        .join("\n");
      const content = `🎲 **Jet d'Initiative**\n\n${orderText}\n\n⚔️ Le combat commence !`;
      const initiativeMsg: Message = { id: msgId, role: "ai", content, type: "dice" };
      const next = insertInitiativeOrderMessageIntoTimeline(prev, initiativeMsg);
      seenInitiativeCardsRef.current.add(msgId);
      messagesStateRef.current = next;
      return next;
    });
    if (multiplayerSessionId) {
      setTimeout(() => {
        void flushMultiplayerSharedState();
      }, 0);
    }
  }, [
    waitForGmNarrationForInitiative,
    awaitingPlayerInitiative,
    combatOrderInitiativeSig,
    player?.name,
    multiplayerSessionId,
    flushMultiplayerSharedState,
    setMessages,
  ]);

  /**
   * MP : ordre d'initiative déjà présent mais carte « Jet d'Initiative » absente du journal
   * (ex. snapshot reçu après un flush sans les bulles). Répare sans dupliquer si déjà là.
   * Ne pas dépendre de `combatOrder` par référence : sinon effet en rafale + doublon quand le slice Firestore tronque l’historique.
   */
  useEffect(() => {
    if (!multiplayerSessionId) return;
    if (gameMode !== "combat") return;
    if (awaitingPlayerInitiative) return;
    if (combatOrder.length === 0) return;
    if (waitForGmNarrationForInitiativeRef.current) return;
    // MP sync tardif : ne jamais "réparer" la carte d'initiative au milieu/fin de combat.
    if ((typeof combatTurnWriteSeq === "number" && combatTurnWriteSeq > 0) || combatTurnIndex > 0) return;

    const msgId = `initiative-order-${combatOrder
      .map((e) => `${e.id}:${e.initiative}`)
      .sort()
      .join("|")}`;
    if (messagesStateRef.current.some((m) => m.id === msgId)) return;
    // Carte déjà affichée plus tôt dans ce combat puis purgée (cap Firestore/chat) :
    // ne pas la réinsérer artificiellement en bas.
    if (seenInitiativeCardsRef.current.has(msgId)) return;

    setMessages((prev) => {
      if (prev.some((m) => m.id === msgId)) return prev;
      const rankLabel = (i: number) => (i === 0 ? "1er" : `${i + 1}e`);
      const orderText = combatOrder
        .map((entry, idx) => {
          const display = resolveCombatantDisplayName(
            entry,
            entitiesRef.current ?? [],
            player?.name ?? null
          );
          return `[${rankLabel(idx)}] ${display} (${entry.initiative})`;
        })
        .join("\n");
      const content = `🎲 **Jet d'Initiative**\n\n${orderText}\n\n⚔️ Le combat commence !`;
      const initiativeMsg: Message = { id: msgId, role: "ai", content, type: "dice" };
      const next = insertInitiativeOrderMessageIntoTimeline(prev, initiativeMsg);
      seenInitiativeCardsRef.current.add(msgId);
      messagesStateRef.current = next;
      return next;
    });
    setTimeout(() => {
      void flushMultiplayerSharedState();
    }, 0);
  }, [
    multiplayerSessionId,
    gameMode,
    awaitingPlayerInitiative,
    combatOrderInitiativeSig,
    combatTurnIndex,
    combatTurnWriteSeq,
    flushMultiplayerSharedState,
    player?.name,
    setMessages,
    waitForGmNarrationForInitiative,
  ]);

  // Initiative : en combat sans ordre, jets PNJ automatiques puis attente du d20 joueur
  useEffect(() => {
    if (gameMode !== "combat") {
      initiativeDraftCacheRef.current = null;
      initiativeRemoteFinalizeSigRef.current = null;
      setAwaitingPlayerInitiative(false);
      setNpcInitiativeDraft([]);
      setPlayerInitiativeRollsByEntityId({});
      playerInitiativeRollsByEntityIdRef.current = {};
      return;
    }
    const hostiles = entities.filter((e) => isHostileReadyForCombat(e));
    if (combatOrder.length > 0) {
      if (!combatOrderMatchesCurrentHostiles(combatOrder, hostiles)) {
        // Nouveau combat / nouveaux hostiles : l'ancien ordre ne correspond plus à la scène actuelle.
        initiativeDraftCacheRef.current = null;
        initiativeRemoteFinalizeSigRef.current = null;
        setCombatOrder([]);
        setCombatTurnIndex(0);
        setCombatHiddenIds([]);
        clearCombatStealthTotals();
        setAwaitingPlayerInitiative(false);
        setNpcInitiativeDraft([]);
        setPlayerInitiativeRollsByEntityId({});
        playerInitiativeRollsByEntityIdRef.current = {};
        return;
      }
      initiativeDraftCacheRef.current = null;
      initiativeRemoteFinalizeSigRef.current = null;
      setAwaitingPlayerInitiative(false);
      setNpcInitiativeDraft([]);
      setPlayerInitiativeRollsByEntityId({});
      playerInitiativeRollsByEntityIdRef.current = {};
      return;
    }
    if (!player) return;
    if (hostiles.length === 0) {
      // Plus aucun hostile engagé (repère le PJ) : ne pas garder le bandeau initiative ni le mode combat.
      initiativeDraftCacheRef.current = null;
      initiativeRemoteFinalizeSigRef.current = null;
      setAwaitingPlayerInitiative(false);
      setWaitForGmNarrationForInitiative(false);
      setNpcInitiativeDraft([]);
      setPlayerInitiativeRollsByEntityId({});
      playerInitiativeRollsByEntityIdRef.current = {};
      setCombatOrder([]);
      setCombatTurnIndex(0);
      setCombatHiddenIds([]);
      clearCombatStealthTotals();
      setGameMode("exploration", entities);
      return;
    }

    const cached = initiativeDraftCacheRef.current;
    if (cached && cached.length > 0) {
      if (!npcInitiativeDraftMatchesHostiles(cached, hostiles)) {
        initiativeDraftCacheRef.current = null;
      } else {
        // Le cache fige id + initiative ; les noms suivent toujours la fiche entité actuelle.
        if (!awaitingPlayerInitiativeRef.current) {
          // Nouveau cycle : on évite de court-circuiter l'attente avec des rolls d'une manche précédente.
          setPlayerInitiativeRollsByEntityId({});
          playerInitiativeRollsByEntityIdRef.current = {};
        }
        setNpcInitiativeDraft(
          cached.map((entry) => ({
            ...entry,
            name: resolveCombatantDisplayName(entry, entities, player?.name ?? null),
          }))
        );
        setAwaitingPlayerInitiative(true);
        return;
      }
    }

    // Nouveau cycle d'initiative : on évite de réutiliser les jets d'une manche précédente.
    if (!awaitingPlayerInitiativeRef.current) {
      setPlayerInitiativeRollsByEntityId({});
      playerInitiativeRollsByEntityIdRef.current = {};
    }

    initiativeRemoteFinalizeSigRef.current = null;
    const draft: CombatEntry[] = hostiles.map((e) => {
      const dex = Math.floor(((e.stats?.DEX ?? 10) - 10) / 2);
      return {
        id: e.id,
        name: e.name,
        initiative: rollInitiativeD20() + dex,
      };
    });
    initiativeDraftCacheRef.current = draft;
    setNpcInitiativeDraft(draft);
    setAwaitingPlayerInitiative(true);
  }, [
    gameMode,
    combatOrder.length,
    entities,
    player,
    setGameMode,
    setCombatOrder,
    setCombatTurnIndex,
    setCombatHiddenIds,
    clearCombatStealthTotals,
  ]);

  // Aligner les libellés combatOrder sur entities / joueur (sauvegarde, parseur, messages).
  useEffect(() => {
    if (combatOrder.length === 0) return;
    setCombatOrder((prev) => {
      let changed = false;
      const next = prev.map((entry) => {
        const display = resolveCombatantDisplayName(entry, entities, player?.name ?? null);
        if (display === entry.name) return entry;
        changed = true;
        return { ...entry, name: display };
      });
      return changed ? next : prev;
    });
  }, [entities, player?.name, combatOrder.length]);

  /** D&D 5e : la surprise se termine à la fin du tour du créature — pas seulement dans quelques branches du client. */
  const surpriseTurnPrevIndexRef = useRef<number | null>(null);
  const surpriseTurnOrderWasEmptyRef = useRef(true);

  useLayoutEffect(() => {
    if (gameMode !== "combat") {
      surpriseTurnPrevIndexRef.current = null;
      surpriseTurnOrderWasEmptyRef.current = true;
      return;
    }
    const order = combatOrderRef.current;
    const len = Array.isArray(order) ? order.length : 0;
    if (len <= 0) {
      surpriseTurnPrevIndexRef.current = null;
      surpriseTurnOrderWasEmptyRef.current = true;
      return;
    }

    if (surpriseTurnOrderWasEmptyRef.current) {
      surpriseTurnOrderWasEmptyRef.current = false;
      surpriseTurnPrevIndexRef.current = combatTurnIndex;
      return;
    }

    const prev = surpriseTurnPrevIndexRef.current;
    if (prev === null) {
      surpriseTurnPrevIndexRef.current = combatTurnIndex;
      return;
    }
    if (prev === combatTurnIndex) {
      return;
    }

    const endedIdx = Math.min(Math.max(0, prev), len - 1);
    const endedId = String(order[endedIdx]?.id ?? "").trim();
    if (endedId) {
      const p = playerRef.current;
      const localCombatantId = resolveLocalPlayerCombatantId({
        player: p,
        entities: entitiesRef.current,
        multiplayerSessionId,
        clientId,
      });
      const isLocalPc =
        endedId === localCombatantId ||
        (!multiplayerSessionId && endedId === "player") ||
        (multiplayerSessionId &&
          p?.id != null &&
          String(endedId).trim() === String(p.id).trim());

      if (isLocalPc && p?.surprised === true) {
        updatePlayer({ surprised: false });
      }

      const ents = entitiesRef.current ?? [];
      const ent = ents.find((e) => e && String(e.id ?? "").trim() === endedId);
      if (ent && ent.surprised === true) {
        applyEntityUpdates([{ id: endedId, action: "update", surprised: false }]);
      }
    }

    surpriseTurnPrevIndexRef.current = combatTurnIndex;
  }, [gameMode, combatTurnIndex, clientId, multiplayerSessionId, updatePlayer]);

  function replaceEntities(next: Entity[]) {
    // Ne conserver que les entités non-objets (créatures, PNJ, hostiles).
    const normalized = normalizeLoadedEntitiesList(next).filter((e) => e.type !== "object");
    entitiesRef.current = normalized;
    setEntities(normalized);
    setCombatOrder([]);
    setCombatTurnIndex(0);
    setGameModeState("exploration");
    meleeEngagementSeqRef.current += 1;
    meleeStateRef.current = {};
    setMeleeState({});
    setReactionState({});
    setCombatHiddenIds([]);
    combatStealthTotalByCombatantIdRef.current = {};
    setCombatStealthTotalByCombatantIdState({});
    turnResourcesByCombatantIdRef.current = {};
    setTurnResourcesByCombatantIdState({});
    setSceneVersion((v) => v + 1);
  }

  function clearEntities() {
    entitiesRef.current = [];
    setEntities([]);
    setCombatOrder([]);
    setCombatTurnIndex(0);
    setGameModeState("exploration");
    setCombatHiddenIds([]);
    combatStealthTotalByCombatantIdRef.current = {};
    setCombatStealthTotalByCombatantIdState({});
    turnResourcesByCombatantIdRef.current = {};
    setTurnResourcesByCombatantIdState({});
    setSceneVersion((v) => v + 1);
  }

  function resetToCampaignStart() {
    const start: any = (GOBLIN_CAVE as any)?.scene_village ?? null;

    clearRoomEntitySnapshots();
    clearRoomMemory();

    // Joueur : repartir du template initial sélectionné (inventaire/équipement d'origine).
    setPlayerState((prev) => {
      const seed = clonePlayer(playerInitialSnapshotRef.current) ?? clonePlayer(prev);
      if (!seed?.hp) return seed;
      const restored = resetRemainingResourcesDeep(seed);
      return {
        ...restored,
        isAlive: true,
        hp: { ...restored.hp, current: restored.hp.max },
        hitDiceRemaining: restored.hitDiceTotal ?? restored.level ?? 1,
        deathState: normalizeDeathState(null, restored.hp.max),
        lastLongRestFinishedAtMinute: null,
      };
    });
    setWorldTimeMinutes(
      typeof CAMPAIGN_START_WORLD_TIME_MINUTES === "number" && Number.isFinite(CAMPAIGN_START_WORLD_TIME_MINUTES)
        ? Math.max(0, Math.trunc(CAMPAIGN_START_WORLD_TIME_MINUTES))
        : 0
    );
    meleeEngagementSeqRef.current += 1;
    meleeStateRef.current = {};
    setMeleeState({});
    setReactionState({});
    setCombatHiddenIds([]);
    combatStealthTotalByCombatantIdRef.current = {};
    setCombatStealthTotalByCombatantIdState({});
    setEngagedWithId(null);
    setHasDisengagedThisTurn(false);
    initiativeDraftCacheRef.current = null;
    setAwaitingPlayerInitiative(false);
    setWaitForGmNarrationForInitiative(false);
    setNpcInitiativeDraft([]);
    turnResourcesByCombatantIdRef.current = {};
    setTurnResourcesByCombatantIdState({});

    // Scène
    setCurrentRoomId(start?.id ?? "scene_village");
    setCurrentSceneName(start?.title ?? (CAMPAIGN_CONTEXT as any)?.title ?? "Campagne");
    setCurrentScene(start?.description ?? "");
    // Placeholder visuel jusqu’à image de scène générée / définie par la campagne
    setCurrentSceneImage("/file.svg");

    // État de combat / entités : initialiser quelques PNJ présents dès l'intro
    const initialCampaignEntities = normalizeLoadedEntitiesList([
      {
        id: "thron",
        name: "Thron",
        type: "npc",
        controller: "ai",
        race: "Humain",
        entityClass: "Forgeron (Chef du village)",
        cr: 0,
        visible: true,
        isAlive: true,
        hp: { current: 9, max: 9 },
        ac: 11,
        stats: { FOR: 14, DEX: 10, CON: 13, INT: 11, SAG: 12, CHA: 12 },
        attackBonus: 2,
        damageDice: "1d4",
        damageBonus: 0,
        description:
          "Forgeron robuste au tablier noirci, regard inquiet; il vous a convoqués en secret.",
        stealthDc: null,
      },
      {
        id: "commis_meunier",
        name: "Commis du meunier",
        type: "npc",
        controller: "ai",
        race: "Humain",
        entityClass: "Villageois",
        cr: 0,
        visible: true,
        isAlive: true,
        hp: { current: 4, max: 4 },
        ac: 10,
        stats: { FOR: 10, DEX: 10, CON: 10, INT: 10, SAG: 11, CHA: 10 },
        attackBonus: 1,
        damageDice: "1d4",
        damageBonus: 0,
        description:
          "Jeune homme nerveux, les mains sales de farine; témoin de l'enlèvement, il évite votre regard.",
        stealthDc: null,
      },
    ]);
    entitiesRef.current = initialCampaignEntities;
    setEntities(initialCampaignEntities);
    setCombatOrder([]);
    setCombatTurnIndex(0);
    setGameModeState("exploration");

    // Messages : encadré contexte campagne puis scène d'ouverture
    const opening = (CAMPAIGN_CONTEXT as { chatOpeningContext?: { title?: string; body?: string } })
      .chatOpeningContext;
    const openingBody = typeof opening?.body === "string" ? opening.body.trim() : "";
    const openingMsgs: Message[] = [];
    if (openingBody) {
      openingMsgs.push({
        id: OPENING_MSG_ID_CAMPAIGN_CONTEXT,
        role: "ai",
        type: "campaign-context",
        content: openingBody,
        contextBox: {
          title: (typeof opening?.title === "string" && opening.title.trim()) || "Contexte",
        },
      });
    }
    openingMsgs.push({
      id: OPENING_MSG_ID_FORGE_INTRO,
      role: "ai",
      content:
        `En début d’après-midi, Thron, le forgeron qui fait également\n` +
        `office de chef du village, convoque les personnages.\n` +
        `Mes enfants, vous êtes les jeunes les plus aguerris du\n` +
        `village, et certains d’entre vous sont des amis de ma fille\n` +
        `Lanéa.\n` +
        `Un commis du vieil Erdrios, le meunier, vient de\n` +
        `m’apprendre qu’il vient de voir sur la colline un petit\n` +
        `groupe de gobelins portant une jeune femme qui\n` +
        `ressemblait beaucoup à ma fille. Or justement Lanéa est\n` +
        `partie tôt ce matin dans cette direction, et elle n’est pas\n` +
        `revenue à l’heure du repas. Je ne vous cache pas ma\n` +
        `préoccupation, et si sa mère l’apprend, elle risque de\n` +
        `mourir d’inquiétude.\n` +
        `Alors en toute franchise, je voudrais vous demander un\n` +
        `énorme service : pourriez-vous aller vérifier si c’est bien\n` +
        `ma fille que ces monstres ont attrapée et, si vous le\n` +
        `pensez possible, en profiter pour la délivrer des mains de\n` +
        `ces créatures ? Si j’y vais moi, ma femme va se douter\n` +
        `que quelque chose de grave est en train de se passer.`,
    });
    messagesStateRef.current = openingMsgs;
    setMessages(openingMsgs);

    // Jets en attente
    setPendingRoll(null);
    setDebugNextRoll(null);
    setSceneVersion((v) => v + 1);

    // Évite que l'effet `hpCurrent` ← profil Firestore réapplique d'anciens 0 PV avant le prochain
    // `buildLocalParticipantProfile` (même tick que reset / début d'aventure).
    if (multiplayerSessionId) {
      lastLocalParticipantProfilePushAtMsRef.current = Date.now();
    }
  }

  const tryCommitSharedCampaignStart = useCallback(async (): Promise<boolean> => {
    if (!multiplayerSessionId) return false;
    const sessionRef = doc(db, "sessions", multiplayerSessionId);
    const initial = sanitizeForFirestore(buildInitialCampaignSharedPayload());
    try {
      return await runTransaction(db, async (tx) => {
        const snap = await tx.get(sessionRef);
        if (!snap.exists()) return false;
        const data = snap.data() as any;
        const p =
          data?.payload && typeof data.payload === "object" ? (data.payload as SharedSessionPayload) : null;
        if (p?.isGameStarted === true) return false;
        tx.update(sessionRef, {
          payload: initial,
          updatedAt: serverTimestamp(),
        });
        return true;
      });
    } catch {
      return false;
    }
  }, [multiplayerSessionId]);

  const startGame = () => {
    if (!multiplayerSessionId) return;
    void (async () => {
      const ok = await tryCommitSharedCampaignStart();
      if (ok) {
        setIsGameStarted(true);
        resetToCampaignStart();
        return;
      }
      // Un autre client a peut‑être déjà committé, ou la transaction a échoué : resynchroniser
      // depuis Firestore pour éviter de rester bloqué sur le salon sans bouton utile côté menu.
      try {
        const sessionRef = doc(db, "sessions", multiplayerSessionId);
        const snap = await getDoc(sessionRef);
        if (!snap.exists()) return;
        const data = snap.data() as any;
        const remotePayload =
          data?.payload && typeof data.payload === "object" ? (data.payload as SharedSessionPayload) : null;
        if (remotePayload?.isGameStarted === true) {
          applySharedSessionPayload(remotePayload);
        }
      } catch {
        /* ignore */
      }
    })();
  };

  /** Même effet que repartir de zéro côté monde + PV, sans repasser par le menu. */
  function restartAdventure() {
    if (!multiplayerSessionId) return;
    try {
      localStorage.removeItem(PERSISTENCE_KEY);
    } catch {
      /* ignore */
    }
    setIsGameStarted(true);
    resetToCampaignStart();
  }

  return (
    <GameContext.Provider value={{
      player, updatePlayer, setHp,
      setPlayer,
      worldTimeMinutes,
      setWorldTimeMinutes,
      isGameStarted, startGame,
      persistenceReady,
      messages, addMessage, appendSceneImagePendingSlot, updateMessage, removeMessagesByIds,
      pendingRoll, setPendingRoll,
      currentSceneName, setCurrentSceneName,
      currentScene, setCurrentScene,
      sceneVersion, setSceneVersion,
      currentRoomId, setCurrentRoomId,
      entities, getEntitiesSnapshot, applyEntityUpdates, replaceEntities, clearEntities,
      rememberRoomEntitiesSnapshot, takeEntitiesForRoom, clearRoomEntitySnapshots,
      getRoomMemory, appendRoomMemory, setRoomMemoryText, clearRoomMemory,
      gameMode, setGameMode,
      combatOrder, setCombatOrder,
      combatTurnIndex, combatTurnWriteSeq, setCombatTurnIndex,
      awaitingPlayerInitiative,
      waitForGmNarrationForInitiative,
      setWaitForGmNarrationForInitiative,
      npcInitiativeDraft,
      commitPlayerInitiativeRoll,
      registerCombatNextTurn,
      nextTurn,
      engagedWithId, setEngagedWithId,
      hasDisengagedThisTurn, setHasDisengagedThisTurn,
      turnResourcesByCombatantId, setTurnResourcesForCombatant,
      meleeState, setMeleeState,
      reactionState, setReactionState,
      addMeleeMutual, removeFromMelee, clearMeleeFor,
      getMeleeWith, setReactionFor, hasReaction,
      initCombatReactions, pruneDeadFromMelee,
      combatHiddenIds, setCombatHiddenIds,
      combatStealthTotalByCombatantId,
      setCombatStealthTotalForCombatant,
      clearCombatStealthTotals,
      aiProvider, setAiProvider,
      autoPlayerEnabled, setAutoPlayerEnabled,
      autoRollEnabled, setAutoRollEnabled,
      multiplayerSessionId,
      multiplayerConnected,
      multiplayerParticipants,
      multiplayerParticipantProfiles,
      patchParticipantProfileHp,
      patchParticipantProfileInventory,
      patchParticipantProfilePlayerSnapshot,
      patchParticipantProfileDeathState,
      multiplayerHostClientId,
      multiplayerIsHost,
      multiplayerPendingCommand,
      multiplayerThinkingState,
      createMultiplayerSession,
      joinMultiplayerSession,
      leaveMultiplayerSession,
      setMultiplayerGameModeImmediate,
      flushMultiplayerSharedState,
      submitMultiplayerCommand,
      clearMultiplayerPendingCommand,
      tryAcquireMultiplayerCommandLease,
      releaseMultiplayerCommandLease,
      setMultiplayerThinkingState,
      acquireMultiplayerAutoPlayerIntentLock,
      releaseMultiplayerAutoPlayerIntentLock,
      acquireMultiplayerProcessingLock,
      releaseMultiplayerProcessingLock,
      debugForceUnblockProcessingPipeline,
      clientId,
      startNewGame,
      restartAdventure,
      debugMode, setDebugMode,
      currentSceneImage, setCurrentSceneImage,
      imageModel, setImageModel,
      debugNextRoll, setDebugNextRoll,
    }}>
      {children}
    </GameContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook utilitaire
// ---------------------------------------------------------------------------

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error("useGame doit être utilisé à l'intérieur d'un <GameProvider>.");
  return ctx;
}
