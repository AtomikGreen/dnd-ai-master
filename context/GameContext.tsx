"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
  type SetStateAction,
} from "react";
import { CAMPAIGN_CONTEXT, GOBLIN_CAVE } from "@/data/campaign";
import { BESTIARY } from "@/data/bestiary";
import { resolveCombatantDisplayName } from "@/lib/combatDisplayName";

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
  type: string;
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

export interface Player {
  /** Pré-tirés / créateur : identifiant stable pour savoir si le joueur a changé de perso. */
  id?: string | number;
  type: "player";
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
  /** Emplacements de sorts par niveau (ex: {1: {max: 4, remaining: 4}}) */
  spellSlots?: SpellSlotsMap;
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

export interface PendingRoll {
  stat: string;       // ex: "FOR", "DEX"
  totalBonus: number; // modificateur total (stat mod + maîtrise + bonus arme…)
  raison: string;     // ex: "attaque à l'Épée Longue"
  kind?: "attack" | "check" | "save";
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
   * "scene-image" → image générée (affichée dans le chat + miniature)
   * "scene-image-pending" → créneau réservé pendant l'appel au générateur (ordre chronologique)
   */
  type?:
    | "dice"
    | "meta"
    | "meta-reply"
    | "enemy-turn"
    | "combat-detail"
    | "turn-end"
    | "turn-divider"
    | "debug"
    | "scene-image"
    | "scene-image-pending"
    | "continue"
    | "retry-action"
    | "campaign-context";
  content: string;
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
  name: string;
  /** hostile=attaque le joueur, npc=neutre/réactif, friendly=allié, object=inanimé */
  type: EntityType;
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
}

/** Mise à jour partielle d'une entité envoyée par l'IA */
export interface EntityUpdate {
  id?: string;
  action: "spawn" | "update" | "kill" | "remove";
  templateId?: string;
  name?: string;
  type?: EntityType;
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
  /** Modificateur additif d'AC (ex: -2 si pas de bouclier). */
  acDelta?: number;
  /** Modificateurs additifs de caractéristiques (FOR/DEX/CON/INT/SAG/CHA). */
  statDeltas?: Partial<EntityStats>;
}

function normalizeEntityType(t: any): EntityType | undefined {
  if (t === "monster") return "hostile"; // compat ancien prompt/états
  if (t === "hostile" || t === "npc" || t === "friendly" || t === "object") return t;
  return undefined;
}

function inferTemplateIdFromEntityId(entityId: string): string | null {
  const id = String(entityId ?? "").trim().toLowerCase();
  if (!id) return null;
  const withoutSuffix = id.replace(/_\d+$/g, "");
  return withoutSuffix || null;
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

export type GameMode = "exploration" | "combat";

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

interface GameContextValue {
  // Joueur
  player: Player | null;
  setPlayer: React.Dispatch<SetStateAction<Player | null>>;
  updatePlayer: (patch: Partial<Player>) => void;
  setHp: (value: number) => void;
  // Démarrage
  isGameStarted: boolean;
  startGame: () => void;
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
    contextBox?: { title: string }
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
  /** Résumé mécanique des événements déjà résolus dans une salle (pièges, embuscades, etc.). */
  getRoomMemory: (roomId: string) => string;
  /** Met à jour la mémoire de salle seulement si cela change réellement un fait mémorisé. */
  appendRoomMemory: (roomId: string, line: string) => boolean;
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
  setCombatOrder: (order: CombatEntry[]) => void;
  combatTurnIndex: number;
  setCombatTurnIndex: (idx: number) => void;
  /** Combat démarré sans combatOrder : jets PNJ pré-calculés, attente du jet joueur */
  awaitingPlayerInitiative: boolean;
  /** Brouillon d'initiative (ennemis) avant clic « Lancer l'initiative » */
  npcInitiativeDraft: CombatEntry[];
  /** Retourne l'ordre d'initiative fusionné (pour enchaîner les tours PNJ côté UI), ou null si rien n'a été commité. */
  commitPlayerInitiativeRoll: () => CombatEntry[] | null;
  /** Enregistré par ChatInterface : enchaînement des tours (ex. après « Fin de tour ») */
  registerCombatNextTurn: (fn: (() => Promise<void>) | null) => void;
  nextTurn: () => Promise<void>;
  // Théâtre de l'esprit (moteur)
  engagedWithId: string | null; // id de la créature au corps à corps avec le joueur (rétrocompat)
  setEngagedWithId: (id: string | null) => void;
  hasDisengagedThisTurn: boolean;
  setHasDisengagedThisTurn: (v: boolean) => void;
  turnResources: TurnResources;
  setTurnResources: (r: TurnResources) => void;
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
  // Fournisseur IA
  aiProvider: AiProvider;
  setAiProvider: (p: AiProvider) => void;
  // Mode auto-joueur (IA qui joue à la place du joueur)
  autoPlayerEnabled: boolean;
  setAutoPlayerEnabled: (v: boolean) => void;
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
// Données chargées au démarrage
// ---------------------------------------------------------------------------

const INITIAL_PLAYER: Player = {
  type: "player",
  name: "Thorin Pied-de-Pierre",
  entityClass: "Guerrier",
  race: "Nain de Montagne",
  level: 1,
  alignment: "Loyal Bon",
  background: "Héros du Peuple",
  backgroundFeature: "Hospitalité rustique",
  ideals: "Personne n'est au-dessus des lois.",
  bonds: "Reprendre un jour les terres de son clan et protéger les plus faibles.",
  flaws: "Trop indulgent envers les orphelins et les âmes perdues.",
  description:
    "Nain trapu aux cheveux tressés, barbe rousse striée de gris, armure cabossée mais entretenue, regard dur qui cache un cœur loyal.",
  initiative: 1,
  speed: "25 ft",
  visible: true,
  isAlive: true,
  hp: { current: 28, max: 40 },
  ac: 16,
  xp: 0,
  hitDie: "d10",
  hitDiceTotal: 1,
  hitDiceRemaining: 1,
  stats: {
    FOR: 16,
    DEX: 12,
    CON: 14,
    INT: 10,
    SAG: 8,
    CHA: 13,
  },
  inventory: [
    "Bouclier en bois",
    "Potion de soin ×2",
    "Clé rouillée",
    "Flèches ×20",
  ],
  languages: ["Commun", "Nain"],
  // Guerrier typique : Athlétisme + Perception (exemple)
  skillProficiencies: ["Athletics", "Perception", "Intimidation"],
  proficiencies: ["Athlétisme", "Intimidation", "Haches de guerre"],
  features: ["Vision dans le noir (Darkvision)", "Résistance naine (Poison)"],
  weapons: [
    { name: "Épée Longue",   attackBonus: 5, damageDice: "1d8", damageBonus: 3 },
    { name: "Hache de Main",  attackBonus: 5, damageDice: "1d6", damageBonus: 3 },
    { name: "Arc Court",      attackBonus: 3, damageDice: "1d6", damageBonus: 1 },
  ],
};

function normalizePlayerShape(value: any): Player | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, any>;
  const {
    nom: _legacyName,
    classe: _legacyClass,
    armorClass: _legacyArmorClass,
    inventaire: _legacyInventory,
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
  const acRaw = raw.ac ?? raw.armorClass;
  const ac = Number.isFinite(Number(acRaw)) ? Math.trunc(Number(acRaw)) : 10;
  return {
    ...rest,
    type: "player",
    name: String(raw.name ?? raw.nom ?? "Joueur").trim() || "Joueur",
    entityClass:
      String(raw.entityClass ?? raw.classe ?? "Aventurier").trim() || "Aventurier",
    description:
      raw.description == null ? undefined : String(raw.description),
    visible: raw.visible !== false,
    isAlive: hp.current > 0,
    hp,
    ac,
    inventory: inventorySource.map((x: any) => String(x ?? "").trim()).filter(Boolean),
    weapons: Array.isArray(raw.weapons) ? raw.weapons : [],
    level:
      typeof raw.level === "number" && Number.isFinite(raw.level)
        ? Math.max(1, Math.trunc(raw.level))
        : 1,
    stats: raw.stats ?? { FOR: 10, DEX: 10, CON: 10, INT: 10, SAG: 10, CHA: 10 },
    skillProficiencies: Array.isArray(raw.skillProficiencies) ? raw.skillProficiencies : [],
  } as Player;
}

const INITIAL_MESSAGES: Message[] = [
  {
    id: "init-1",
    role: "ai",
    content:
      "Bienvenue, aventurier. Vous vous réveillez dans une taverne sombre. Une silhouette encapuchonnée vous observe depuis le coin de la salle. Que faites-vous ?",
  },
  {
    id: "init-2",
    role: "user",
    content: "Je m'approche prudemment de la silhouette, la main sur la garde de mon épée.",
  },
  {
    id: "init-3",
    role: "ai",
    content:
      "La silhouette lève une main apaisante. Une voix douce murmure : « Je ne vous veux aucun mal, Thorin. J'ai une proposition… et peu de temps. »",
  },
];

/** Entités présentes dès le départ dans la Taverne du Sanglier Borgne (stats D&D 5e officielles) */
const INITIAL_ENTITIES: Entity[] = [
  // Objets de scène (ciblables)
  {
    id: "cheminee",
    name: "Cheminée",
    type: "object",
    race: "—",
    entityClass: "Décor",
    cr: 0,
    visible: true,
    isAlive: true,
    hp: null,
    ac: null,
    stats: null,
    attackBonus: null,
    damageDice: null,
    damageBonus: null,
    description: "Âtre en pierre où crépite un feu (source de flamme).",
  },
  {
    id: "tonneau_vin",
    name: "Tonneau de vin",
    type: "object",
    race: "—",
    entityClass: "Objet",
    cr: 0,
    visible: true,
    isAlive: true,
    hp: { current: 10, max: 10 },
    ac: 10,
    stats: null,
    attackBonus: null,
    damageDice: null,
    damageBonus: null,
    description: "Gros tonneau cerclé de fer, plein de vin. Une flèche bien placée peut le percer.",
  },
  {
    id: "rideaux",
    name: "Rideaux",
    type: "object",
    race: "—",
    entityClass: "Décor",
    cr: 0,
    visible: true,
    isAlive: true,
    hp: { current: 4, max: 4 },
    ac: 10,
    stats: null,
    attackBonus: null,
    damageDice: null,
    damageBonus: null,
    description: "Tissu épais et sec : inflammable.",
  },
  {
    id: "silhouette",
    name: "Silhouette Encapuchonnée",
    type: "npc",
    race: "Inconnue",
    entityClass: "Espion (Spy)",
    cr: 1,
    visible: true,
    isAlive: true,
    hp: { current: 27, max: 27 },
    ac: 12,
    stats: { FOR: 10, DEX: 15, CON: 10, INT: 12, SAG: 14, CHA: 16 },
    attackBonus: 4,
    damageDice: "1d6",
    damageBonus: 2,
    description: "Figure immobile dans le coin le plus sombre, visage masqué par une capuche noire",
  },
  {
    id: "tavernier",
    name: "Tavernier",
    type: "npc",
    race: "Humain",
    entityClass: "Roturier (Commoner)",
    cr: 0,
    visible: true,
    isAlive: true,
    hp: { current: 9, max: 9 },
    ac: 11,
    stats: { FOR: 14, DEX: 10, CON: 13, INT: 11, SAG: 12, CHA: 11 },
    attackBonus: 4,
    damageDice: "1d4",
    damageBonus: 2,
    description: "Homme corpulent derrière le comptoir poisseux, une massue à portée de main",
  },
  {
    id: "serveuse",
    name: "Serveuse",
    type: "npc",
    race: "Humaine",
    entityClass: "Roturière (Commoner)",
    cr: 0,
    visible: true,
    isAlive: true,
    hp: { current: 4, max: 4 },
    ac: 10,
    stats: { FOR: 10, DEX: 10, CON: 10, INT: 10, SAG: 10, CHA: 10 },
    attackBonus: 2,
    damageDice: "1d4",
    damageBonus: 0,
    description: "Serveuse épuisée qui circule entre les tables, plateau chargé de chopes",
  },
  {
    id: "mercenaire_1",
    name: "Mercenaire Balafré",
    type: "npc",
    race: "Humain",
    entityClass: "Bandit (Fighter 1)",
    cr: 0.125,
    visible: true,
    isAlive: true,
    hp: { current: 11, max: 11 },
    ac: 12,
    stats: { FOR: 13, DEX: 12, CON: 12, INT: 10, SAG: 10, CHA: 10 },
    attackBonus: 3,
    damageDice: "1d6",
    damageBonus: 1,
    description: "Mercenaire à l'air sombre avec une balafre sur la joue, main posée sur son épée",
  },
  {
    id: "mercenaire_2",
    name: "Mercenaire",
    type: "npc",
    race: "Humain",
    entityClass: "Bandit (Fighter 1)",
    cr: 0.125,
    visible: true,
    isAlive: true,
    hp: { current: 11, max: 11 },
    ac: 12,
    stats: { FOR: 13, DEX: 12, CON: 12, INT: 10, SAG: 10, CHA: 10 },
    attackBonus: 3,
    damageDice: "1d6",
    damageBonus: 1,
    description: "Second mercenaire qui observe la salle d'un œil méfiant depuis son coin",
  },
  {
    id: "marchands",
    name: "Groupe de Marchands",
    type: "npc",
    race: "Humains",
    entityClass: "Roturiers (Commoners)",
    cr: 0,
    visible: true,
    isAlive: true,
    hp: { current: 6, max: 6 },
    ac: 10,
    stats: { FOR: 10, DEX: 10, CON: 10, INT: 12, SAG: 10, CHA: 12 },
    attackBonus: 2,
    damageDice: "1d4",
    damageBonus: 0,
    description: "Trois marchands à une table, discutant à voix basse de prix et de routes",
  },
];

const INITIAL_SCENE_NAME = "Intérieur de la Taverne du Sanglier Borgne";

const INITIAL_SCENE =
  `${INITIAL_SCENE_NAME}. ` +
  "L'air est chaud et chargé de fumée de pipe et de graisse brûlée. " +
  "Des tables en bois massif jonchent la salle, certaines renversées. " +
  "Un comptoir poisseux longe le mur du fond. " +
  "Un feu de cheminée crépite dans l'angle, projetant des ombres mouvantes sur les murs de pierre. " +
  "Une douzaine de clients : des marchands, des mercenaires à l'air sombre, une serveuse épuisée. " +
  "Une silhouette encapuchonnée est assise seule dans le coin le plus sombre.";

// ---------------------------------------------------------------------------
// Persistance locale (F5 / tests)
// ---------------------------------------------------------------------------

const PERSISTENCE_KEY = "dnd-ai-master-game-state-v1";
const PERSISTENCE_VERSION = 1;

/** Normalise les PV après chargement JSON (sauvegarde / cache par salle). */
function normalizeLoadedEntitiesList(raw: unknown): Entity[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((e: any) => {
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
    const awareOfPlayer =
      typeof e?.awareOfPlayer === "boolean"
        ? e.awareOfPlayer
        : normalizedType === "hostile";
    return { ...e, type: normalizedType, hp, awareOfPlayer } as Entity;
  });
}

function isHostileReadyForCombat(entity: Entity | null | undefined): boolean {
  return !!entity && entity.type === "hostile" && entity.isAlive && entity.awareOfPlayer !== false;
}

interface PersistedPayload {
  player: Player | null;
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
  combatOrder: CombatEntry[];
  combatTurnIndex: number;
  engagedWithId: string | null;
  hasDisengagedThisTurn: boolean;
  meleeState: Record<string, string[]>;
  reactionState: Record<string, boolean>;
  turnResources: TurnResources;
  aiProvider: AiProvider;
  debugMode: boolean;
  currentSceneImage: string;
  imageModel: ImageModelId;
  debugNextRoll: number | null;
  autoPlayerEnabled: boolean;
  autoRollEnabled: boolean;
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

export function GameProvider({ children }: { children: ReactNode }) {
  const [player, setPlayerState]      = useState<Player | null>(null);
  const [messages, setMessages]       = useState<Message[]>(INITIAL_MESSAGES);
  const [pendingRoll, setPendingRoll] = useState<PendingRoll | null>(null);
  const [isGameStarted, setIsGameStarted] = useState<boolean>(false);
  const [currentSceneName, setCurrentSceneName] = useState<string>(INITIAL_SCENE_NAME);
  const [currentScene, setCurrentScene] = useState<string>(INITIAL_SCENE);
  const [currentRoomId, setCurrentRoomId] = useState<string>("scene_village");
  const [sceneVersion, setSceneVersion] = useState<number>(0);
  // On ne conserve que les créatures (pas les objets de décor) dans l'état de jeu.
  const [entities, setEntities]       = useState<Entity[]>(INITIAL_ENTITIES.filter((e) => e.type !== "object"));
  const [gameMode, setGameModeState] = useState<GameMode>("exploration");

  const entitiesRef = useRef<Entity[]>(entities);
  entitiesRef.current = entities;

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
      setGameModeState(mode);
    },
    []
  );

  const [combatOrder, setCombatOrder] = useState<CombatEntry[]>([]);
  const [combatTurnIndex, setCombatTurnIndex] = useState<number>(0);
  const [awaitingPlayerInitiative, setAwaitingPlayerInitiative] = useState(false);
  const [npcInitiativeDraft, setNpcInitiativeDraft] = useState<CombatEntry[]>([]);
  /** Cache du brouillon d'initiative PNJ (même tirage si l'effet remonte 2× — StrictMode). */
  const initiativeDraftCacheRef = useRef<CombatEntry[] | null>(null);
  const combatNextTurnRef = useRef<(() => Promise<void>) | null>(null);
  const [engagedWithId, setEngagedWithId] = useState<string | null>(null);
  const [hasDisengagedThisTurn, setHasDisengagedThisTurn] = useState<boolean>(false);
  const [meleeState, setMeleeState] = useState<Record<string, string[]>>({});
  const [reactionState, setReactionState] = useState<Record<string, boolean>>({});
  const [turnResources, setTurnResources] = useState<TurnResources>({
    action: true,
    bonus: false,
    reaction: true,
    movement: true,
  });
  const [aiProvider, setAiProvider]         = useState<AiProvider>("openrouter");
  const [debugMode, setDebugMode]           = useState<boolean>(false);
  const [currentSceneImage, setCurrentSceneImage] = useState<string>("/TaverneSanglierBorgne.jpg");
  const [imageModel, setImageModel] = useState<ImageModelId>("disabled");
  const [debugNextRoll, setDebugNextRoll]   = useState<number | null>(null);
  const [autoPlayerEnabled, setAutoPlayerEnabled] = useState<boolean>(false);
  const [autoRollEnabled, setAutoRollEnabled] = useState<boolean>(false);

  /** false jusqu'à ce que la restauration localStorage ait été tentée (évite d'écraser la sauvegarde au premier rendu). */
  const [persistenceReady, setPersistenceReady] = useState(false);

  const messageSeqRef = useRef(0);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Snapshot immuable du personnage au moment de la sélection (sert aux resets d'aventure). */
  const playerInitialSnapshotRef = useRef<Player | null>(null);

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
      if (!isGameStarted) {
        if (!normalized) {
          playerInitialSnapshotRef.current = null;
        } else if (!prev || prev.id !== normalized.id) {
          playerInitialSnapshotRef.current = clonePlayer(normalized);
        }
      }
      return normalized;
    });
  }, [clonePlayer, isGameStarted]);

  // Restauration au montage
  useEffect(() => {
    if (typeof window === "undefined") {
      setPersistenceReady(true);
      return;
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
      const p = data.payload;
      setPlayerState(normalizePlayerShape(p.player ?? null));
      if (Array.isArray(p.messages) && p.messages.length > 0) {
        const cleaned = p.messages.filter((m) => (m as Message).type !== "scene-image-pending");
        setMessages(cleaned);
      }
      setPendingRoll(p.pendingRoll ?? null);
      setIsGameStarted(!!p.isGameStarted);
      setCurrentSceneName(typeof p.currentSceneName === "string" ? p.currentSceneName : INITIAL_SCENE_NAME);
      setCurrentScene(typeof p.currentScene === "string" ? p.currentScene : INITIAL_SCENE);
      setCurrentRoomId(typeof p.currentRoomId === "string" ? p.currentRoomId : "scene_village");
      setSceneVersion(typeof p.sceneVersion === "number" ? p.sceneVersion : 0);
      const loadedEntities = Array.isArray(p.entities) ? normalizeLoadedEntitiesList(p.entities) : [];
      if (Array.isArray(p.entities)) setEntities(loadedEntities as Entity[]);

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
      if (p.gameMode === "combat" || p.gameMode === "exploration") {
        const want = p.gameMode;
        setGameModeState(want === "exploration" && hostileAlive ? "combat" : want);
      }
      if (Array.isArray(p.combatOrder)) setCombatOrder(p.combatOrder);
      setCombatTurnIndex(typeof p.combatTurnIndex === "number" ? p.combatTurnIndex : 0);
      setEngagedWithId(p.engagedWithId ?? null);
      setHasDisengagedThisTurn(!!p.hasDisengagedThisTurn);
      if (p.meleeState && typeof p.meleeState === "object") setMeleeState(p.meleeState);
      if (p.reactionState && typeof p.reactionState === "object") setReactionState(p.reactionState);
      if (p.turnResources && typeof p.turnResources === "object") {
        setTurnResources({
          action: !!p.turnResources.action,
          bonus: !!p.turnResources.bonus,
          reaction: !!p.turnResources.reaction,
          // Compat avec anciennes sauvegardes (movement en number):
          // - 0 => false
          // - >0 => true
          // - boolean => conservé
          movement:
            typeof p.turnResources.movement === "boolean"
              ? p.turnResources.movement
              : Number(p.turnResources.movement) > 0,
        });
      }
      if (p.aiProvider === "gemini" || p.aiProvider === "openrouter") setAiProvider(p.aiProvider);
      setDebugMode(!!p.debugMode);
      if (typeof p.currentSceneImage === "string") setCurrentSceneImage(p.currentSceneImage);
      // Par défaut, le toggle Image API doit démarrer sur "Désactivé".
      // On ignore donc la valeur persistée de `imageModel` (elle ne doit pas
      // forcer Gemini au prochain chargement).
      setImageModel("disabled");
      setDebugNextRoll(typeof p.debugNextRoll === "number" ? p.debugNextRoll : null);
      setAutoPlayerEnabled(!!p.autoPlayerEnabled);
      setAutoRollEnabled(!!p.autoRollEnabled);
    } catch {
      /* JSON corrompu ou quota : ignorer */
    }
    setPersistenceReady(true);
  }, []);

  // Hostiles engagés → combat obligatoire (filet de sécurité si gameMode resterait en exploration)
  useEffect(() => {
    if (gameMode !== "exploration") return;
    if (entities.some((e) => isHostileReadyForCombat(e))) {
      setGameModeState("combat");
    }
  }, [gameMode, entities]);

  // Sauvegarde différée à chaque changement d'état pertinent
  useEffect(() => {
    if (!persistenceReady || typeof window === "undefined") return;

    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      try {
        const payload: PersistedPayload = {
          player,
          messages,
          pendingRoll,
          isGameStarted,
          currentSceneName,
          currentScene,
          currentRoomId,
          sceneVersion,
          entities,
          entitiesByRoom: { ...entitiesByRoomRef.current },
          roomMemoryByRoom: { ...roomMemoryByRoom },
          gameMode,
          combatOrder,
          combatTurnIndex,
          engagedWithId,
          hasDisengagedThisTurn,
          meleeState,
          reactionState,
          turnResources,
          aiProvider,
          debugMode,
          currentSceneImage,
          imageModel,
          debugNextRoll,
          autoPlayerEnabled,
          autoRollEnabled,
        };
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
    turnResources,
    aiProvider,
    debugMode,
    currentSceneImage,
    imageModel,
    debugNextRoll,
    autoPlayerEnabled,
    autoRollEnabled,
  ]);

  const startNewGame = useCallback(() => {
    try {
      localStorage.removeItem(PERSISTENCE_KEY);
    } catch {
      /* ignore */
    }
    setRoomMemoryByRoom({});
    setIsGameStarted(false);
  }, []);

  useEffect(() => {
    if (!persistenceReady) return;
    if (gameMode !== "combat") {
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
      | "scene-image"
      | "scene-image-pending"
      | "continue"
      | "retry-action"
      | "campaign-context",
    id?: string,
    contextBox?: { title: string }
  ) {
    setMessages((prev) => [
      ...prev,
      {
        id: id ?? nextMessageId(),
        role,
        content,
        ...(type && { type }),
        ...(contextBox ? { contextBox } : {}),
      },
    ]);
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
      return next;
    });
  }

  function updateMessage(messageId: string, patch: Partial<Message>) {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? ({ ...m, ...patch } as Message) : m))
    );
  }

  function removeMessagesByIds(ids: string[]) {
    const set = new Set(ids);
    setMessages((prev) => prev.filter((m) => !set.has(m.id)));
  }

  const updatePlayer = useCallback((patch: Partial<Player>) => {
    setPlayer((prev) => {
      if (!prev) return prev;
      return { ...prev, ...patch };
    });
  }, [setPlayer]);

  function setHp(value: number) {
    setPlayer((prev) => {
      if (!prev || !prev.hp) return prev;
      const nextCurrent = Math.max(0, Math.min(value, prev.hp.max));
      return {
        ...prev,
        isAlive: nextCurrent > 0,
        hp: {
          ...prev.hp,
          current: nextCurrent,
        },
      };
    });
  }

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
            inventory: Array.isArray(update.inventory)
              ? update.inventory.map((x) => String(x ?? "").trim()).filter(Boolean)
              : Array.isArray(update.lootItems)
                ? update.lootItems.map((x) => String(x ?? "").trim()).filter(Boolean)
                : [],
          }),
          ...(update.surprised !== undefined && { surprised: !!update.surprised }),
          ...(update.awareOfPlayer !== undefined && { awareOfPlayer: !!update.awareOfPlayer }),
        };

        if (update.hp !== undefined) {
          const nextHp =
            normalizeHpShape(update.hp, currentPlayer.hp) ?? {
              current: 0,
              max: currentPlayer.hp.max,
            };
          merged.hp = nextHp;
          merged.isAlive = nextHp.current > 0;
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

        currentPlayer = merged;
      }

      return currentPlayer;
    };

    const playerUpdateIds = new Set(
      ["player", String(player?.id ?? "").trim()].filter(Boolean)
    );

    const playerUpdates = (Array.isArray(updates) ? updates : []).filter((update) => {
      const id = typeof update?.id === "string" ? update.id.trim() : "";
      return playerUpdateIds.has(id);
    });

    if (playerUpdates.length) {
      if (
        playerUpdates.some((update) => update?.action === "kill" || update?.action === "remove")
      ) {
        pruneDeadFromMelee("player");
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
            (incomingId ? inferTemplateIdFromEntityId(incomingId) : null);
          const template =
            templateId && (BESTIARY as any)?.[templateId] ? (BESTIARY as any)[templateId] : null;
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
          const providedRaw = update.name;
          const providedName = typeof providedRaw === "string" ? providedRaw.trim() : "";
          const idx = current.findIndex((e) => e.id === resolvedSpawnId);

          // Anti-clone : même id déjà en jeu → fusion (évite Gobelin C/D si l'IA respawn le même id)
          if (idx >= 0) {
            const ent = current[idx];
            const mergedName = providedName || ent.name;
            const nt = normType ?? ent.type;
            current = current.map((e, i) =>
              i !== idx
                ? e
                : {
                    ...e,
                    name: mergedName,
                    type: nt,
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
                    isAlive: true,
                  }
            );
            continue;
          }

          const resolvedSpawnName =
            providedName || String(template?.name ?? "").trim() || resolvedSpawnId;

          const newEntity: Entity = {
            id: resolvedSpawnId,
            name: resolvedSpawnName,
            type: normType ?? "npc",
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
            // Si on nous demande de transformer une entité en "object", on la retire simplement.
            if (normType === "object") {
              return null as any;
            }
            const merged = {
              ...e,
              ...(update.name        !== undefined && { name:        update.name }),
              ...(update.type        !== undefined && normType && { type: normType ?? e.type }),
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
            };
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

      return current;
    });
  }

  function addMeleeMutual(a: string, b: string) {
    if (a === b) return;
    setMeleeState((prev) => {
      const next = { ...prev };
      const listA = [...(next[a] ?? [])];
      if (!listA.includes(b)) listA.push(b);
      next[a] = listA;
      const listB = [...(next[b] ?? [])];
      if (!listB.includes(a)) listB.push(a);
      next[b] = listB;
      return next;
    });
    if (a === "player" || b === "player") {
      const other = a === "player" ? b : a;
      setEngagedWithId(other);
    }
  }

  function removeFromMelee(a: string, b: string) {
    setMeleeState((prev) => {
      const next = { ...prev };
      next[a] = (prev[a] ?? []).filter((id) => id !== b);
      next[b] = (prev[b] ?? []).filter((id) => id !== a);
      return next;
    });
    if (a === "player" || b === "player") {
      setEngagedWithId((curr) => (curr === a || curr === b ? null : curr));
    }
  }

  function clearMeleeFor(id: string) {
    setMeleeState((prev) => {
      const next = { ...prev };
      const withMe = prev[id] ?? [];
      for (const otherId of withMe) {
        next[otherId] = (next[otherId] ?? []).filter((x) => x !== id);
      }
      next[id] = [];
      return next;
    });
    if (id === "player") setEngagedWithId(null);
  }

  function getMeleeWith(id: string): string[] {
    return meleeState[id] ?? [];
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
  }

  function pruneDeadFromMelee(deadId: string) {
    setMeleeState((prev) => {
      const next = { ...prev };
      const withDead = prev[deadId] ?? [];
      for (const otherId of withDead) {
        next[otherId] = (next[otherId] ?? []).filter((x) => x !== deadId);
      }
      next[deadId] = [];
      return next;
    });
    if (deadId === "player") setEngagedWithId(null);
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

  const commitPlayerInitiativeRoll = useCallback((): CombatEntry[] | null => {
    if (!player || !awaitingPlayerInitiative || npcInitiativeDraft.length === 0) return null;
    const nat = debugNextRoll !== null ? debugNextRoll : rollInitiativeD20();
    if (debugNextRoll !== null) setDebugNextRoll(null);
    const dex = Math.floor(((player.stats?.DEX ?? 10) - 10) / 2);
    const playerEntry: CombatEntry = {
      id: "player",
      name: player.name,
      initiative: nat + dex,
    };
    const merged = [...npcInitiativeDraft, playerEntry].sort((a, b) => b.initiative - a.initiative);

    // Messages d'initiative dans le chat : gérés par ChatInterface.handleCommitInitiative (makeMsgId + récap visible).

    initCombatReactions(merged);
    setCombatOrder(merged);
    // Le tour actif est toujours le 1er de l'ordre d'initiative (plus haut score), pas la position du PJ dans la liste.
    setCombatTurnIndex(0);
    setAwaitingPlayerInitiative(false);
    setNpcInitiativeDraft([]);
    initiativeDraftCacheRef.current = null;
    return merged;
  }, [
    player,
    awaitingPlayerInitiative,
    npcInitiativeDraft,
    debugNextRoll,
    setDebugNextRoll,
  ]);

  // Initiative : en combat sans ordre, jets PNJ automatiques puis attente du d20 joueur
  useEffect(() => {
    if (gameMode !== "combat") {
      initiativeDraftCacheRef.current = null;
      setAwaitingPlayerInitiative(false);
      setNpcInitiativeDraft([]);
      return;
    }
    if (combatOrder.length > 0) {
      initiativeDraftCacheRef.current = null;
      setAwaitingPlayerInitiative(false);
      setNpcInitiativeDraft([]);
      return;
    }
    if (!player) return;
    const hostiles = entities.filter((e) => isHostileReadyForCombat(e));
    if (hostiles.length === 0) return;

    const cached = initiativeDraftCacheRef.current;
    if (cached && cached.length > 0) {
      // Le cache fige id + initiative ; les noms suivent toujours la fiche entité actuelle.
      setNpcInitiativeDraft(
        cached.map((entry) => ({
          ...entry,
          name: resolveCombatantDisplayName(entry, entities, player?.name ?? null),
        }))
      );
      setAwaitingPlayerInitiative(true);
      return;
    }

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
  }, [gameMode, combatOrder.length, entities, player]);

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

  function replaceEntities(next: Entity[]) {
    // Ne conserver que les entités non-objets (créatures, PNJ, hostiles).
    setEntities(next.filter((e) => e.type !== "object"));
    setCombatOrder([]);
    setCombatTurnIndex(0);
    setGameModeState("exploration");
    setMeleeState({});
    setReactionState({});
    setSceneVersion((v) => v + 1);
  }

  function clearEntities() {
    setEntities([]);
    setCombatOrder([]);
    setCombatTurnIndex(0);
    setGameModeState("exploration");
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
        hp: { ...restored.hp, current: restored.hp.max },
      };
    });
    setMeleeState({});
    setReactionState({});
    setEngagedWithId(null);
    setHasDisengagedThisTurn(false);
    initiativeDraftCacheRef.current = null;
    setAwaitingPlayerInitiative(false);
    setNpcInitiativeDraft([]);
    setTurnResources({ action: true, bonus: true, reaction: true, movement: true });

    // Scène
    setCurrentRoomId(start?.id ?? "scene_village");
    setCurrentSceneName(start?.title ?? (CAMPAIGN_CONTEXT as any)?.title ?? "Campagne");
    setCurrentScene(start?.description ?? "");
    // Évite d'afficher l'image "taverne" par défaut quand on lance la campagne
    setCurrentSceneImage("/file.svg");

    // État de combat / entités : initialiser quelques PNJ présents dès l'intro
    setEntities([
      {
        id: "thron",
        name: "Thron",
        type: "npc",
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
        id: `campaign-context-${Date.now()}-ctx`,
        role: "ai",
        type: "campaign-context",
        content: openingBody,
        contextBox: {
          title: (typeof opening?.title === "string" && opening.title.trim()) || "Contexte",
        },
      });
    }
    openingMsgs.push({
      id: `init-campaign-${Date.now()}-forge`,
      role: "ai",
      content:
        `À la forge de Thron, l'ambiance est lourde : le chef du village vous a convoqués à l'abri des oreilles indiscrètes. ` +
        `Il essuie ses mains noircies sur son tablier, puis baisse la voix.\n\n` +
        `« Mes enfants… le commis du meunier a vu des gobelins sur la colline à l’ouest. Ils portaient une jeune femme… et elle ressemblait à ma Lanéa. »\n` +
        `Sa mâchoire se crispe; le feu crépite dans le foyer.\n\n` +
        `« Je vous en supplie. Ramenez-la discrètement. Si sa mère l’apprend… elle en mourra d’inquiétude. »`,
    });
    setMessages(openingMsgs);

    // Jets en attente
    setPendingRoll(null);
    setDebugNextRoll(null);
    setSceneVersion((v) => v + 1);
  }

  const startGame = () => {
    setIsGameStarted(true);
    resetToCampaignStart();
  };

  /** Même effet que repartir de zéro côté monde + PV, sans repasser par le menu. */
  function restartAdventure() {
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
      isGameStarted, startGame,
      messages, addMessage, appendSceneImagePendingSlot, updateMessage, removeMessagesByIds,
      pendingRoll, setPendingRoll,
      currentSceneName, setCurrentSceneName,
      currentScene, setCurrentScene,
      sceneVersion, setSceneVersion,
      currentRoomId, setCurrentRoomId,
      entities, applyEntityUpdates, replaceEntities, clearEntities,
      rememberRoomEntitiesSnapshot, takeEntitiesForRoom, clearRoomEntitySnapshots,
      getRoomMemory, appendRoomMemory, clearRoomMemory,
      gameMode, setGameMode,
      combatOrder, setCombatOrder,
      combatTurnIndex, setCombatTurnIndex,
      awaitingPlayerInitiative,
      npcInitiativeDraft,
      commitPlayerInitiativeRoll,
      registerCombatNextTurn,
      nextTurn,
      engagedWithId, setEngagedWithId,
      hasDisengagedThisTurn, setHasDisengagedThisTurn,
      turnResources, setTurnResources,
      meleeState, setMeleeState,
      reactionState, setReactionState,
      addMeleeMutual, removeFromMelee, clearMeleeFor,
      getMeleeWith, setReactionFor, hasReaction,
      initCombatReactions, pruneDeadFromMelee,
      aiProvider, setAiProvider,
      autoPlayerEnabled, setAutoPlayerEnabled,
      autoRollEnabled, setAutoRollEnabled,
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
