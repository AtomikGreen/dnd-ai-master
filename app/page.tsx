"use client";

import { Suspense, useState, useEffect, useCallback, useMemo } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import ChatInterface from "@/components/ChatInterface";
import CampaignMenu from "@/components/CampaignMenu";
import CharacterSelection from "@/components/CharacterSelection";
import {
  useGame,
  normalizeMultiplayerSessionId,
  type PlayerStats,
  type Weapon,
  type Entity,
  type CombatEntry,
} from "@/context/GameContext";
import { SPELLS } from "@/data/srd5";
import {
  computePlayerArmorClass,
  tryEquipFromInventory,
  tryUnequipAttunement,
  emptyEquipment,
  inventoryCandidatesForSlot,
  inventoryExcludingEquipped,
  listEquippedItemsDisplayOrder,
  MAX_ATTUNED_ITEMS,
  type EquipSlot,
} from "@/lib/playerEquipment";
import { resolveCombatantDisplayName } from "@/lib/combatDisplayName";
import { resolveLocalPlayerCombatantId } from "@/lib/combatLocalPlayerId";
import { formatSpellComponentsAbbrev, getSpellComponents } from "@/lib/spellCastingComponents";
import {
  resourceKindForCastingTime,
  spellAttackOrSaveSummary,
  spellCastingTimeLine,
  spellConsumesLabelFr,
  spellDamageSummary,
  spellDescriptionText,
  spellDurationLine,
  spellRangeCategoryLine,
} from "@/lib/spellDisplayMeta";
import {
  formatCombatTimedStatesShort,
  getAcBonusFromCombatTimedStates,
  normalizeCombatTimedStates,
} from "@/lib/combatTimedStates";

// Next.js 16 : évite l'échec de prerender quand `useSearchParams()` est utilisé.
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const ENTITY_TYPE_META: Record<string, { icon: string; color: string; label: string }> = {
  hostile:  { icon: "☠",  color: "text-red-400",    label: "Hostile"  },
  npc:      { icon: "👤", color: "text-slate-300",  label: "PNJ"      },
  friendly: { icon: "🛡", color: "text-green-400",  label: "Allié"    },
  object:   { icon: "📦", color: "text-amber-400",  label: "Objet"    },
};

function getEntityTypeMetaForDisplay(entity: Entity) {
  // Un "friendly" piloté par l'IA est un PNJ allié, pas un joueur connecté.
  if (entity?.type === "friendly" && String((entity as any)?.controller ?? "") !== "player") {
    return ENTITY_TYPE_META.npc;
  }
  return ENTITY_TYPE_META[entity?.type] ?? { icon: "?", color: "text-slate-400", label: "Inconnu" };
}

/** Initiative : tolère string ou objet incomplet (réponses JSON IA incorrectes). */
function normalizeCombatOrderEntry(raw: unknown): CombatEntry | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const id = raw.trim();
    if (!id) return null;
    return { id, name: id, initiative: 0 };
  }
  if (typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : null;
  if (!id) return null;
  let initiative = 0;
  if (typeof o.initiative === "number" && Number.isFinite(o.initiative)) initiative = o.initiative;
  else if (typeof o.initiative === "string") {
    const n = parseInt(String(o.initiative).trim(), 10);
    if (Number.isFinite(n)) initiative = n;
  }
  const name =
    typeof o.name === "string" && o.name.trim()
      ? String(o.name).trim()
      : id === "player"
        ? "Joueur"
        : id;
  return { id, name, initiative };
}

type ModalType =
  | "player"
  | "stats"
  | "weapons"
  | "spells"
  | "inventory"
  | "equipment"
  | "entities"
  | "scene"
  | "combat"
  | null;

/** Carte sort : temps d'incantation, ressource de tour, portée, composantes, dégâts, attaque/sauvegarde, effet. */
function SpellBookCard({ name }: { name: string }) {
  const spell: Record<string, unknown> | undefined = (SPELLS as Record<string, Record<string, unknown>>)[name];
  if (!spell) return null;
  const comp = getSpellComponents(name);
  const ct = typeof spell.castingTime === "string" ? spell.castingTime : "";
  const rk = resourceKindForCastingTime(ct);
  const desc = spellDescriptionText(spell as { description?: string; effect?: string });
  const metaLines = [
    spellCastingTimeLine(spell as { castingTime?: string }),
    spellConsumesLabelFr(rk),
    typeof spell.school === "string" && spell.school.trim()
      ? `École : ${spell.school}`
      : null,
    spellRangeCategoryLine(spell as { range?: string }),
    spellDurationLine(spell as { duration?: string }),
    spellDamageSummary(spell as { damage?: string; damageType?: string }),
    spellAttackOrSaveSummary(spell as { attack?: string; save?: string; damage?: string }),
  ].filter(Boolean) as string[];

  return (
    <div className="rounded-md border border-slate-700 bg-slate-900/60 px-3 py-2">
      <p className="text-sm font-semibold text-slate-100">{name}</p>
      <p
        className="text-[10px] text-slate-500 mt-0.5 font-mono tracking-wide"
        title={
          comp.materialCostly
            ? "M* : composante matérielle coûteuse (le focaliseur ne suffit pas)"
            : "Composantes d'incantation (SRD 2014)"
        }
      >
        {formatSpellComponentsAbbrev(name)}
      </p>
      {metaLines.map((line, i) => (
        <p key={i} className="text-[11px] text-slate-400 mt-0.5">
          {line}
        </p>
      ))}
      {desc ? <p className="text-[11px] text-slate-500 mt-1 border-t border-slate-700/80 pt-1 leading-snug">{desc}</p> : null}
    </div>
  );
}

function extractSessionIdFromJoinInput(raw: string): string {
  const t = String(raw ?? "").trim();
  if (!t) return "";
  const queryIdx = t.toLowerCase().indexOf("session=");
  if (queryIdx >= 0) {
    const after = t.slice(queryIdx + "session=".length);
    const end = after.search(/[&\s#]/);
    const token = (end >= 0 ? after.slice(0, end) : after).trim();
    const fromQuery = normalizeMultiplayerSessionId(token);
    if (fromQuery) return fromQuery;
  }
  return normalizeMultiplayerSessionId(t);
}

// ---------------------------------------------------------------------------
// Sous-composants utilitaires
// ---------------------------------------------------------------------------

const SKILL_TO_ABILITY: Record<string, keyof PlayerStats> = {
  Athletics: "FOR",
  Acrobatics: "DEX",
  "Sleight of Hand": "DEX",
  Stealth: "DEX",
  Arcana: "INT",
  History: "INT",
  Investigation: "INT",
  Nature: "INT",
  Religion: "INT",
  "Animal Handling": "SAG",
  Insight: "SAG",
  Medicine: "SAG",
  Perception: "SAG",
  Survival: "SAG",
  Deception: "CHA",
  Intimidation: "CHA",
  Performance: "CHA",
  Persuasion: "CHA",
};

const ALL_SKILLS = Object.keys(SKILL_TO_ABILITY);

function abilityMod(score: number) {
  return Math.floor((score - 10) / 2);
}

function proficiencyBonus(level: number) {
  if (level <= 4) return 2;
  if (level <= 8) return 3;
  if (level <= 12) return 4;
  if (level <= 16) return 5;
  return 6;
}

function formatWorldTimeLabel(totalMinutes: number) {
  const safeMinutes = Math.max(0, Math.trunc(Number(totalMinutes) || 0));
  const day = Math.floor(safeMinutes / 1440) + 1;
  const minutesInDay = safeMinutes % 1440;
  const hours = Math.floor(minutesInDay / 60);
  const minutes = minutesInDay % 60;
  return `Jour ${day}, ${String(hours).padStart(2, "0")}h${String(minutes).padStart(2, "0")}`;
}

function HpBar({ current, max, thick = false }: { current: number; max: number; thick?: boolean }) {
  const pct = Math.max(0, Math.min(100, Math.round((current / max) * 100)));
  const color = pct > 60 ? "bg-green-500" : pct > 30 ? "bg-yellow-500" : "bg-red-500";
  const h = thick ? "h-2" : "h-1.5";
  return (
    <div className={`${h} w-full rounded-full bg-slate-700 mt-1`}>
      <div className={`${h} rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function StatPill({ label, value }: { label: string; value: number }) {
  const mod = Math.floor((value - 10) / 2);
  return (
    <div className="flex flex-col items-center rounded border border-slate-600 bg-slate-700/60 px-2 py-1.5 text-center">
      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
      <span className="text-lg font-bold text-slate-100 leading-none mt-0.5">{value}</span>
      <span className={`text-xs font-medium ${mod >= 0 ? "text-green-400" : "text-red-400"}`}>
        {mod >= 0 ? `+${mod}` : mod}
      </span>
    </div>
  );
}

/** Carte entité compacte (colonne droite) */
function EntityCard({
  entity,
  godMode,
  onClick,
  combatStealthHidden,
}: {
  entity: Entity;
  godMode: boolean;
  onClick?: () => void;
  /** Créature hostile camouflée (moteur : jet de Discrétion vs Perception passive). */
  combatStealthHidden?: boolean;
}) {
  const meta = getEntityTypeMetaForDisplay(entity);
  const isHidden = !entity.visible;
  return (
    <div
      onClick={onClick}
      className={`rounded-md border p-2 text-xs transition-all ${
        onClick ? "cursor-pointer hover:border-slate-500 hover:bg-slate-700/80" : ""
      } ${
        !entity.isAlive
          ? "border-slate-800 bg-slate-900 opacity-40"
          : isHidden && godMode
          ? "border-slate-600/50 bg-slate-800/50 border-dashed"
          : "border-slate-700 bg-slate-800"
      }`}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="flex shrink-0 items-center gap-0.5">
          {combatStealthHidden && entity.type === "hostile" && entity.isAlive && (
            <span
              className="text-xs leading-none text-slate-400"
              title="Caché — jet de Discrétion réussi (tant que non repéré)"
              aria-label="Caché (discrétion)"
            >
              🥷
            </span>
          )}
          <span className={`text-sm ${meta.color}`}>{meta.icon}</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className={`font-semibold truncate ${entity.isAlive ? "text-slate-200" : "text-slate-500 line-through"}`}>
            {entity.name}
            {isHidden && godMode && <span className="ml-1 text-slate-500 font-normal">(caché)</span>}
          </p>
          <p className="text-slate-500 truncate">{entity.description}</p>
        </div>
        {!entity.isAlive && <span className="text-slate-600 shrink-0">mort</span>}
      </div>
      {godMode && entity.hp && entity.isAlive && (
        <div className="mt-1">
          <div className="flex justify-between text-slate-500">
            <span>HP</span>
            <span className="tabular-nums">{entity.hp.current}/{entity.hp.max}</span>
          </div>
          <HpBar current={entity.hp.current} max={entity.hp.max} />
        </div>
      )}
    </div>
  );
}

/** Carte entité détaillée (modal) */
function EntityCardFull({
  entity,
  godMode,
  combatStealthHidden,
}: {
  entity: Entity;
  godMode: boolean;
  combatStealthHidden?: boolean;
}) {
  const meta = getEntityTypeMetaForDisplay(entity);
  const isHidden = !entity.visible;

  return (
    <div className={`rounded-lg border p-4 transition-opacity ${
      !entity.isAlive
        ? "border-slate-800 bg-slate-900/60 opacity-50"
        : isHidden && godMode
        ? "border-slate-600/50 bg-slate-800/40 border-dashed"
        : "border-slate-700 bg-slate-800/60"
    }`}>
      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex shrink-0 items-center gap-1">
          {combatStealthHidden && entity.type === "hostile" && entity.isAlive && (
            <span
              className="text-lg leading-none text-slate-400"
              title="Caché — jet de Discrétion réussi (tant que non repéré)"
              aria-hidden
            >
              🥷
            </span>
          )}
          <span className={`text-2xl ${meta.color}`}>{meta.icon}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className={`text-base font-bold ${entity.isAlive ? "text-slate-100" : "text-slate-500 line-through"}`}>
              {entity.name}
            </h3>
            <span className={`text-xs px-1.5 py-0.5 rounded border ${meta.color} border-current bg-current/10`}>
              {meta.label}
            </span>
            {isHidden && godMode && (
              <span className="text-xs px-1.5 py-0.5 rounded border border-slate-600 text-slate-500">caché</span>
            )}
            {!entity.isAlive && (
              <span className="text-xs px-1.5 py-0.5 rounded border border-red-900 text-red-600 bg-red-950/40">mort</span>
            )}
          </div>
          {godMode && (
            <p className="text-sm text-slate-400 mt-0.5">
              {entity.race} · {entity.entityClass} · CR {entity.cr}
            </p>
          )}
        </div>
      </div>

      {/* Description */}
      <p className="text-sm text-slate-300 italic mb-3">{entity.description}</p>

      {/* Stats D&D 5e */}
      {godMode && entity.stats && (
        <div className="grid grid-cols-6 gap-1.5 mb-3">
          {(Object.entries(entity.stats) as [string, number][]).map(([k, v]) => (
            <StatPill key={k} label={k} value={v} />
          ))}
        </div>
      )}

      {/* Défenses & Attaque */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        {/* PV exacts (current/max) uniquement en mode debug */}
        {/* PV / barre : uniquement en mode debug (MJ) — hors debug, pas de jauge pour les joueurs */}
        {godMode && entity.hp && (
          <div className="rounded bg-slate-700/50 px-3 py-2">
            <p className="text-slate-400 mb-1">Points de vie</p>
            <p className="font-bold text-slate-100">{entity.hp.current} / {entity.hp.max}</p>
            <HpBar current={entity.hp.current} max={entity.hp.max} thick />
          </div>
        )}
        {godMode && entity.ac !== null && (
          <div className="rounded bg-slate-700/50 px-3 py-2">
            <p className="text-slate-400 mb-1">Classe d'armure</p>
            <p className="font-bold text-slate-100 text-base">{entity.ac}</p>
          </div>
        )}
        {godMode && entity.attackBonus !== null && entity.damageDice && (
          <div className="rounded bg-slate-700/50 px-3 py-2 col-span-2">
            <p className="text-slate-400 mb-1">Attaque</p>
            <p className="font-bold text-slate-100">
              <span className="text-green-400">+{entity.attackBonus}</span>
              {" · "}
              <span className="text-orange-400">
                {entity.damageDice}
                {entity.damageBonus ? (entity.damageBonus > 0 ? `+${entity.damageBonus}` : entity.damageBonus) : ""}
              </span>
            </p>
          </div>
        )}
      </div>

      {/* Inventaire/butin de l'entité (debug uniquement) */}
      {godMode && (
        <div className="mt-3 rounded bg-slate-700/40 px-3 py-2">
          <p className="text-slate-400 mb-1 text-xs">Objets possédés / butin</p>
          {Array.isArray(entity.lootItems) && entity.lootItems.length > 0 ? (
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              {entity.lootItems.map((it, idx) => (
                <li
                  key={`${entity.id}-loot-${idx}`}
                  className="rounded border border-slate-600 bg-slate-800/60 px-2 py-1 text-xs text-slate-200"
                >
                  {it}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-500 italic">Aucun objet.</p>
          )}
          {entity.looted && (
            <p className="text-[11px] text-amber-400 mt-1">Corps déjà pillé.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal générique
// ---------------------------------------------------------------------------

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  // Fermeture par Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />

      {/* Panneau */}
      <div className="relative z-10 flex max-h-[92vh] w-full max-w-5xl flex-col rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-700 px-6 py-4 shrink-0">
          <h2 className="text-lg font-bold text-slate-100">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-700 hover:text-white transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>
        {/* Contenu scrollable */}
        <div className="flex-1 overflow-y-auto p-6">
          {children}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composant principal
// ---------------------------------------------------------------------------

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    isGameStarted, startGame, setPlayer, startNewGame, updatePlayer,
    player, entities, gameMode, combatOrder, combatTurnIndex, debugMode, currentSceneName, currentSceneImage,
    worldTimeMinutes,
    getMeleeWith,
    engagedWithId,
    combatHiddenIds,
    messages,
    clientId,
    multiplayerSessionId,
    multiplayerConnected,
    multiplayerParticipants,
    multiplayerParticipantProfiles,
    createMultiplayerSession,
    joinMultiplayerSession,
    leaveMultiplayerSession,
    pendingRoll,
  } = useGame();

  const localPlayerCombatantId = useMemo(
    () => resolveLocalPlayerCombatantId({ player, entities, multiplayerSessionId, clientId }),
    [player, entities, multiplayerSessionId, clientId]
  );

  const combatHiddenSet = useMemo(
    () => new Set((combatHiddenIds ?? []).map((x) => String(x ?? "").trim()).filter(Boolean)),
    [combatHiddenIds]
  );
  const combatOrderIdSet = useMemo(() => {
    const out = new Set<string>();
    for (const raw of Array.isArray(combatOrder) ? combatOrder : []) {
      const entry = normalizeCombatOrderEntry(raw);
      if (!entry?.id) continue;
      out.add(String(entry.id).trim());
    }
    return out;
  }, [combatOrder]);

  const resolveEngagementPeerName = useCallback(
    (id: string) => {
      if (id === "player" || id === localPlayerCombatantId) return player?.name ?? "PJ";
      if (String(id).startsWith("mp-player-")) {
        const cid = String(id).slice("mp-player-".length);
        const prof = multiplayerParticipantProfiles.find(
          (p) => String(p?.clientId ?? "").trim() === String(cid).trim()
        );
        return prof?.name ?? "PJ";
      }
      const ent = entities.find((e) => e.id === id);
      return ent?.name ?? id;
    },
    [entities, localPlayerCombatantId, multiplayerParticipantProfiles, player?.name]
  );

  /** Icône ⚔ Initiative : getMeleeWith + engagedWithId (rétrocompat moteur). */
  const initiativeRowMeleeEngage = useCallback(
    (
      entryId: string,
      isPlayerRow: boolean,
      meleePeers: string[]
    ): { showIcon: boolean; tooltip: string } => {
      const validPeers = (Array.isArray(meleePeers) ? meleePeers : [])
        .map((pid) => String(pid ?? "").trim())
        .filter((pid) => !!pid && pid !== entryId && combatOrderIdSet.has(pid));
      const peerNames = validPeers.map((pid) => resolveEngagementPeerName(pid)).filter(Boolean);
      const listTitle = peerNames.length ? `Mêlée : ${peerNames.join(", ")}` : "";
      if (isPlayerRow) {
        const legacyEngagedValid =
          !!engagedWithId &&
          String(engagedWithId).trim() !== String(entryId).trim() &&
          combatOrderIdSet.has(String(engagedWithId).trim());
        const show = validPeers.length > 0 || legacyEngagedValid;
        const tooltip =
          listTitle ||
          (legacyEngagedValid ? `Engagé avec : ${resolveEngagementPeerName(engagedWithId)}` : "");
        return { showIcon: show, tooltip: tooltip || "Au corps à corps" };
      }
      const vsLocal =
        validPeers.includes(localPlayerCombatantId) ||
        (!multiplayerSessionId && validPeers.includes("player"));
      const byLegacy =
        engagedWithId != null &&
        String(engagedWithId).trim() === String(entryId).trim() &&
        combatOrderIdSet.has(String(entryId).trim());
      const show = vsLocal || byLegacy;
      const tooltip =
        listTitle || (byLegacy ? "Corps à corps avec vous (état moteur engagedWithId)" : "");
      return { showIcon: show, tooltip: tooltip || "Corps à corps avec vous" };
    },
    [
      engagedWithId,
      combatOrderIdSet,
      localPlayerCombatantId,
      multiplayerSessionId,
      resolveEngagementPeerName,
    ]
  );

  // Lock scroll uniquement en jeu (évite le décalage), mais autorise le scroll dans les menus (création perso, etc.)
  useEffect(() => {
    if (typeof document === "undefined") return;
    const lock = !!player && !!isGameStarted;
    document.body.dataset.lockScroll = lock ? "true" : "false";
    return () => {
      // nettoyage au démontage
      delete document.body.dataset.lockScroll;
    };
  }, [player, isGameStarted]);

  const [activeModal, setActiveModal] = useState<ModalType>(null);
  const [sessionJoinInput, setSessionJoinInput] = useState("");
  const [sessionUiError, setSessionUiError] = useState<string | null>(null);
  const [joiningSession, setJoiningSession] = useState(false);
  const [equipmentUiError, setEquipmentUiError] = useState<string | null>(null);
  const closeModal = useCallback(() => setActiveModal(null), []);

  useEffect(() => {
    const sessionFromUrl = normalizeMultiplayerSessionId(searchParams?.get("session") ?? "");
    if (!sessionFromUrl || sessionFromUrl === multiplayerSessionId) return;
    let cancelled = false;
    let redirectTimer: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      setJoiningSession(true);
      setSessionUiError(null);
      try {
        const maxNotFoundRetries = 5;
        const retryDelayMs = 450;

        for (let attempt = 0; attempt <= maxNotFoundRetries; attempt++) {
          const result = await joinMultiplayerSession(sessionFromUrl);
          if (cancelled) return;

          if (result.ok) break;

          // Cas courant : le joueur ouvre l'URL pendant que l'hôte n'a pas encore créé le doc Firestore.
          if (result.reason === "not_found" && attempt < maxNotFoundRetries) {
            await new Promise((r) => setTimeout(r, retryDelayMs));
            continue;
          }

          if (!result.ok) {
            if (result.reason === "full") {
              setSessionUiError("Cette session est complète (4 joueurs maximum).");
            } else if (result.reason === "invalid_id") {
              setSessionUiError("Identifiant de session invalide.");
              redirectTimer = setTimeout(() => {
                const qp = new URLSearchParams(Array.from(searchParams?.entries?.() ?? []));
                qp.delete("session");
                const next = qp.toString();
                router.replace(next ? `?${next}` : "/");
                setSessionUiError(null);
              }, 4500);
            } else if (result.reason === "duplicate_character") {
              setSessionUiError("Ce personnage est déjà pris dans la session.");
            } else {
              setSessionUiError(
                "Cette session n'existe pas ou n'est plus disponible sur le serveur. Vous allez être redirigé dans quelques secondes…"
              );
              redirectTimer = setTimeout(() => {
                const qp = new URLSearchParams(Array.from(searchParams?.entries?.() ?? []));
                qp.delete("session");
                const next = qp.toString();
                router.replace(next ? `?${next}` : "/");
                setSessionUiError(null);
              }, 4500);
            }
          }

          break;
        }

        // En cas de réussite, la boucle se casse dès que `result.ok` est vrai.
      } finally {
        if (!cancelled) setJoiningSession(false);
      }
    })();
    return () => {
      cancelled = true;
      if (redirectTimer) clearTimeout(redirectTimer);
    };
  }, [joinMultiplayerSession, multiplayerSessionId, router, searchParams]);

  // Si l'URL ne contient plus `?session=...` mais qu'on est encore en session (état React),
  // forcer une sortie et revenir au menu.
  useEffect(() => {
    const sessionFromUrl = normalizeMultiplayerSessionId(searchParams?.get("session") ?? "");
    if (sessionFromUrl) return; // on est dans le cas "session présente" (l'effet join gère)
    if (!multiplayerSessionId) return;
    if (!isGameStarted) return;

    let cancelled = false;
    (async () => {
      try {
        await leaveMultiplayerSession();
        if (cancelled) return;
        router.replace("/");
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [searchParams, multiplayerSessionId, isGameStarted, leaveMultiplayerSession, router]);

  const handleCreateSession = useCallback(async () => {
    setSessionUiError(null);
    setJoiningSession(true);
    try {
      const sessionId = await createMultiplayerSession();
      if (!sessionId) {
        setSessionUiError("Impossible de créer la session.");
        return;
      }
      const qp = new URLSearchParams(Array.from(searchParams?.entries?.() ?? []));
      qp.set("session", sessionId);
      router.replace(`?${qp.toString()}`);
    } finally {
      setJoiningSession(false);
    }
  }, [createMultiplayerSession, router, searchParams]);

  const handleJoinSession = useCallback(async () => {
    const target = extractSessionIdFromJoinInput(sessionJoinInput);
    if (!target) return;
    setSessionUiError(null);
    setJoiningSession(true);
    try {
      const result = await joinMultiplayerSession(target);
      if (!result.ok) {
        if (result.reason === "full") setSessionUiError("Session complète (4/4).");
        else if (result.reason === "invalid_id") setSessionUiError("Identifiant invalide.");
        else if (result.reason === "duplicate_character") setSessionUiError("Ce personnage est déjà pris dans la session.");
        else setSessionUiError("Session introuvable.");
        return;
      }
      const qp = new URLSearchParams(Array.from(searchParams?.entries?.() ?? []));
      qp.set("session", target);
      router.replace(`?${qp.toString()}`);
    } finally {
      setJoiningSession(false);
    }
  }, [joinMultiplayerSession, router, searchParams, sessionJoinInput]);

  const handleLeaveSession = useCallback(async () => {
    setSessionUiError(null);
    setJoiningSession(true);
    try {
      await leaveMultiplayerSession();
      const qp = new URLSearchParams(Array.from(searchParams?.entries?.() ?? []));
      qp.delete("session");
      const next = qp.toString();
      router.replace(next ? `?${next}` : "?");
    } finally {
      setJoiningSession(false);
    }
  }, [leaveMultiplayerSession, router, searchParams]);

   // Toujours appeler les hooks avant tout return conditionnel
  const effectiveLevel = player?.level ?? 1;
  const pb = proficiencyBonus(effectiveLevel);

  const spellsByLevel = useMemo(() => {
    const grouped = new Map<number, string[]>();
    const names = Array.isArray(player?.selectedSpells) ? player!.selectedSpells : [];
    for (const name of names) {
      const spell: any = (SPELLS as any)[name];
      const lvl = typeof spell?.level === "number" ? spell.level : 0;
      if (!grouped.has(lvl)) grouped.set(lvl, []);
      grouped.get(lvl)!.push(name);
    }
    return grouped;
  }, [player?.selectedSpells]);

  const displayedArmorClass = useMemo(() => {
    if (!player) return 10;
    let base = computePlayerArmorClass({
      stats: player.stats,
      entityClass: player.entityClass,
      equipment: player.equipment,
      fighter: player.fighter,
    });
    if (gameMode === "combat") {
      base += getAcBonusFromCombatTimedStates(player.combatTimedStates);
    }
    return base;
  }, [player, gameMode]);

  /** Sac (hors équipement porté) — hook avant tout return pour respecter l’ordre des hooks. */
  const inventaireAffiche = useMemo(() => {
    if (!player) return [];
    return inventoryExcludingEquipped(player.inventory, player.equipment);
  }, [player?.inventory, player?.equipment]);

  /** Aperçu colonne latérale : objets portés / harmonisés (même ordre que la fiche équipement). */
  const equipementListeApercu = useMemo(
    () => listEquippedItemsDisplayOrder(player?.equipment),
    [player?.equipment]
  );

  // Étape 0 : aucun personnage sélectionné → écran de sélection/création
  if (!player) {
    const sessionParam = normalizeMultiplayerSessionId(searchParams?.get("session") ?? "");
  return (
      <div className="relative min-h-screen">
        {(joiningSession && sessionParam) || sessionUiError ? (
          <div
            className="fixed left-0 right-0 top-0 z-[100] border-b border-slate-600 bg-slate-900/95 px-4 py-3 text-center text-sm text-slate-100 shadow-lg"
            role="status"
          >
            {joiningSession && sessionParam && !sessionUiError ? (
              <p>Connexion à la session <span className="font-mono text-slate-300">{sessionParam}</span>…</p>
            ) : null}
            {sessionUiError ? <p className="text-amber-200">{sessionUiError}</p> : null}
          </div>
        ) : null}
        <CharacterSelection onSelect={setPlayer} />
      </div>
    );
  }

  const resourceRows: Array<{ key: string; label: string; value: string }> = [];
  if (player.hitDie) {
    resourceRows.push({
      key: "hit-dice",
      label: "Dés de vie",
      value: `${player.hitDiceRemaining ?? player.level}/${player.hitDiceTotal ?? player.level} (${player.hitDie})`,
    });
  }
  const secondWind = player.fighter?.resources?.secondWind;
  if (secondWind) {
    resourceRows.push({
      key: "second-wind",
      label: "Second souffle",
      value: `${secondWind.remaining}/${secondWind.max}`,
    });
  }
  const actionSurge = player.fighter?.resources?.actionSurge;
  if (actionSurge) {
    resourceRows.push({
      key: "action-surge",
      label: "Sursaut d'action",
      value: `${actionSurge.remaining}/${actionSurge.max}`,
    });
  }
  const indomitable = player.fighter?.resources?.indomitable;
  if (indomitable) {
    resourceRows.push({
      key: "indomitable",
      label: "Indomptable",
      value: `${indomitable.remaining}/${indomitable.max}`,
    });
  }
  const superiorityDice = player.fighter?.resources?.superiorityDice;
  if (superiorityDice) {
    resourceRows.push({
      key: "superiority-dice",
      label: "Dés de supériorité",
      value: `${superiorityDice.remaining}/${superiorityDice.dice} (${superiorityDice.die})`,
    });
  }
  const channelDivinity = player.cleric?.resources?.channelDivinity;
  if (channelDivinity) {
    resourceRows.push({
      key: "channel-divinity",
      label: "Conduit divin",
      value: `${channelDivinity.remaining}/${channelDivinity.max}`,
    });
  }
  const rogueLuck = player.rogue?.resources?.luck;
  if (rogueLuck) {
    resourceRows.push({
      key: "rogue-luck",
      label: "Chance (Roublard)",
      value: `${rogueLuck.remaining}/${rogueLuck.max}`,
    });
  }
  if (player.wizard?.arcaneRecovery) {
    resourceRows.push({
      key: "arcane-recovery",
      label: "Restauration arcanique",
      value: player.wizard.arcaneRecovery.used ? "Utilisée" : "Disponible",
    });
  }

  // Si le jeu n'a pas commencé OU qu'on n'est pas en session multijoueur,
  // on affiche UNIQUEMENT le menu. (Le jeu ne doit jamais s'afficher sans session.)
  if (!isGameStarted || !multiplayerSessionId) {
    return (
      <CampaignMenu
        onStart={startGame}
        onBack={() => setPlayer(null)}
        messages={messages}
        multiplayer={{
          sessionId: multiplayerSessionId,
          participants: multiplayerParticipants,
          connected: multiplayerConnected,
          participantProfiles: multiplayerParticipantProfiles,
          meCharacterName: player?.name ?? null,
          onCreate: handleCreateSession,
          onLeave: handleLeaveSession,
          joinInput: sessionJoinInput,
          setJoinInput: setSessionJoinInput,
          onJoin: handleJoinSession,
          joining: joiningSession,
          error: sessionUiError,
        }}
      />
    );
  }

  const stats: PlayerStats  = player.stats;
  /** Source de vérité : tout ce que le PJ possède (équipé ou non). */
  const inventaireComplet: string[] = player.inventory;
  const weapons: Weapon[]    = player.weapons;

  const sortedMultiplayerParticipantProfiles = Array.isArray(multiplayerParticipantProfiles)
    ? [...multiplayerParticipantProfiles].sort((a, b) =>
        String(a?.clientId ?? "").localeCompare(String(b?.clientId ?? ""))
      )
    : [];
  const participantClientIdsSet = new Set(
    (Array.isArray(multiplayerParticipants) ? multiplayerParticipants : [])
      .map((id) => String(id ?? "").trim())
      .filter(Boolean)
  );

  const sessionParticipantEntities: Entity[] = !multiplayerSessionId
    ? []
    : sortedMultiplayerParticipantProfiles
        .filter((profile) => {
          if (profile.connected === false) return false;
          const pid = String(profile?.clientId ?? "").trim();
          if (!pid) return false;
          // Ne garder que les profils des vrais participants connectés à la session.
          // Evite d'afficher des PNJ/artefacts comme "Aventurier connecté".
          if (participantClientIdsSet.size > 0 && !participantClientIdsSet.has(pid)) return false;
          return true;
        })
        .map(
          (profile): Entity => ({
            id: `mp-player-${profile.clientId}`,
            type: "friendly",
            controller: "player",
            name: profile.name,
            entityClass: profile.entityClass ?? "Aventurier",
            race: profile.race?.trim() ? profile.race : "—",
            cr: 0,
            visible: true,
            // 0 PV = encore au combat (inconscient / jets contre la mort), pas retiré de l'ordre.
            isAlive:
              profile.hpCurrent != null
                ? true
                : profile.hpMax != null
                  ? true
                  : (profile.hpCurrent ?? 1) > 0,
            hp:
              profile.hpCurrent != null && profile.hpMax != null
                ? { current: profile.hpCurrent, max: profile.hpMax }
                : null,
            ac: profile.ac ?? null,
            stats: null,
            attackBonus: 0,
            damageDice: null,
            damageBonus: 0,
            weapons: null,
            description: "Aventurier connecté à cette session partagée.",
          })
        );

  const displayEntitiesBase = debugMode
    ? entities
    : entities.filter((e) => e.visible && e.type !== "object");
  const displayEntities = [...sessionParticipantEntities, ...displayEntitiesBase];
  const isInCombat = gameMode === "combat";
  const isShortRestMode = gameMode === "short_rest";
  const combatOrderSafeIndex =
    isInCombat && combatOrder.length > 0
      ? Math.min(Math.max(0, combatTurnIndex), combatOrder.length - 1)
      : 0;
  const isPlayerTurn =
    isInCombat &&
    combatOrder.length > 0 &&
    (combatOrder[combatOrderSafeIndex]?.id === "player" ||
      combatOrder[combatOrderSafeIndex]?.id === localPlayerCombatantId);
  const activeCombatantId =
    isInCombat && combatOrder.length > 0
      ? combatOrder[combatOrderSafeIndex]?.id ?? null
      : null;
  const participantRowsForNameResolution = Array.isArray(multiplayerParticipantProfiles)
    ? multiplayerParticipantProfiles
        .map((profile) => {
          const cid = String(profile?.clientId ?? "").trim();
          const pname = String(profile?.playerSnapshot?.name ?? profile?.name ?? "").trim();
          if (!cid || !pname) return null;
          return { id: `mp-player-${cid}`, name: pname };
        })
        .filter(Boolean)
    : [];
  const nameResolutionEntities = [
    ...(Array.isArray(entities) ? entities : []),
    ...participantRowsForNameResolution,
  ] as { id: string; name?: string }[];

  const canChangeEquipment = gameMode !== "combat";

  const applyEquipmentSlot = (slot: EquipSlot, itemName: string | null) => {
    if (!canChangeEquipment) {
      setEquipmentUiError("Changement d'équipement impossible pendant le combat.");
      return;
    }
    setEquipmentUiError(null);
    const eq = player.equipment ?? emptyEquipment();
    const r = tryEquipFromInventory(eq, slot, itemName, inventaireComplet, {
      stats: player.stats,
      entityClass: player.entityClass,
      fighter: player.fighter,
      features: player.features,
      feats: player.feats,
    });
    if (!r.ok || !r.equipment) {
      setEquipmentUiError(r.reason ?? "Action impossible.");
      return;
    }
    updatePlayer({ equipment: r.equipment });
  };

  const applyAttunement = (itemName: string) => {
    if (!canChangeEquipment) {
      setEquipmentUiError("Impossible pendant le combat.");
      return;
    }
    setEquipmentUiError(null);
    const eq = player.equipment ?? emptyEquipment();
    const r = tryEquipFromInventory(eq, "attune", itemName, inventaireComplet, {
      stats: player.stats,
      entityClass: player.entityClass,
      fighter: player.fighter,
      features: player.features,
      feats: player.feats,
    });
    if (!r.ok || !r.equipment) {
      setEquipmentUiError(r.reason ?? "Action impossible.");
      return;
    }
    updatePlayer({ equipment: r.equipment });
  };

  const removeAttunement = (itemName: string) => {
    if (!canChangeEquipment) return;
    const eq = player.equipment ?? emptyEquipment();
    updatePlayer({ equipment: tryUnequipAttunement(eq, itemName) });
  };

  const hpPct = Math.round((player.hp.current / player.hp.max) * 100);

  // ---------------------------------------------------------------------------
  // Contenu des modals
  // ---------------------------------------------------------------------------

  const modalPlayer = (
    <div className="space-y-6">
      {/* Identité */}
      <div className="flex items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-blue-500 bg-blue-950/40 text-3xl">
          🧙
        </div>
        <div>
          <h3 className="text-2xl font-bold text-slate-100">{player.name}</h3>
          <p className="text-slate-400">
            {player.race ? `${player.race} — ${player.entityClass}` : player.entityClass}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Niveau {player.level} · Initiative {player.initiative ?? abilityMod(stats.DEX)} · Vitesse {player.speed ?? "30 ft"}
          </p>
          <p className="text-xs text-slate-500 mt-0.5">
            Bonus de maîtrise (PB) : <span className="font-semibold text-slate-300">+{pb}</span>
          </p>
          {player.alignment && (
            <p className="text-xs text-slate-500 mt-0.5">
              Alignement : {player.alignment}
            </p>
          )}
        </div>
      </div>

      {/* HP + CA */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-4">
          <p className="text-xs text-slate-400 mb-1 uppercase tracking-wider">Points de vie</p>
          <p className="text-3xl font-bold text-slate-100">{player.hp.current} <span className="text-slate-500 text-lg">/ {player.hp.max}</span></p>
          <HpBar current={player.hp.current} max={player.hp.max} thick />
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-4">
          <p className="text-xs text-slate-400 mb-1 uppercase tracking-wider">Classe d&apos;armure</p>
          <p className="text-3xl font-bold text-blue-300">{displayedArmorClass}</p>
        </div>
      </div>

      {gameMode === "combat" && normalizeCombatTimedStates(player.combatTimedStates).length > 0 ? (
        <div className="rounded-lg border border-amber-800/50 bg-amber-950/35 px-4 py-3 text-xs text-amber-100">
          <span className="font-semibold uppercase tracking-wider text-amber-300/90">
            États (combat, durée)
          </span>
          <p className="mt-1.5 text-amber-50/95">
            {formatCombatTimedStatesShort(player.combatTimedStates)}
          </p>
          <p className="mt-1 text-[10px] text-amber-200/70">
            Le compteur diminue à chaque début de tour dans l&apos;ordre d&apos;initiative (tous les
            combattants).
          </p>
        </div>
      ) : null}

      {/* Ressources suivies */}
      <div>
        <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3">
          Ressources disponibles
        </h4>
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-4">
          {resourceRows.length > 0 ? (
            <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {resourceRows.map((row) => (
                <li
                  key={row.key}
                  className="rounded-md border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-200 flex items-center justify-between gap-3"
                >
                  <span className="text-slate-300">{row.label}</span>
                  <span className="tabular-nums font-semibold text-slate-100">{row.value}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-500 italic">Aucune ressource de classe suivie pour ce personnage.</p>
          )}
        </div>
      </div>

      {/* Contexte RP court */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-4 space-y-2 text-sm text-slate-200">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">Contexte & Background</h4>
          {player.background && (
            <p>
              <span className="font-semibold">Historique :</span> {player.background}
            </p>
          )}
          {player.backgroundFeature && (
            <p className="text-xs text-slate-400">
              <span className="font-semibold text-slate-300">Aptitude d&apos;historique :</span> {player.backgroundFeature}
            </p>
          )}
          {player.description && (
            <p className="text-xs text-slate-300 italic">
              {player.description}
            </p>
          )}
          {Array.isArray(player.languages) && player.languages.length > 0 && (
            <p className="text-xs text-slate-400">
              <span className="font-semibold text-slate-300">Langues :</span> {player.languages.join(", ")}
            </p>
          )}
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-4 space-y-1 text-xs text-slate-300">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">Personnalité</h4>
          {player.ideals && (
            <p>
              <span className="font-semibold text-slate-200">Idéaux :</span> {player.ideals}
            </p>
          )}
          {player.bonds && (
            <p>
              <span className="font-semibold text-slate-200">Liens :</span> {player.bonds}
            </p>
          )}
          {player.flaws && (
            <p>
              <span className="font-semibold text-slate-200">Défauts :</span> {player.flaws}
            </p>
          )}
          {player.xp !== undefined && (
            <p className="mt-2 text-slate-500">
              XP : <span className="tabular-nums text-slate-300">{player.xp}</span>
            </p>
          )}
          {player.deathState?.dead ? (
            <p className="text-red-400">État : mort</p>
          ) : player.hp.current <= 0 ? (
            <p className="text-amber-400">
              État : {player.deathState?.stable ? "stabilisé" : "inconscient"} ·
              jets {player.deathState?.successes ?? 0}/3 réussites, {player.deathState?.failures ?? 0}/3 échecs
            </p>
          ) : null}
        </div>
      </div>

      {/* Caractéristiques & Compétences (aperçu) */}
      <div>
        <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3">Caractéristiques</h4>
        <div className="grid grid-cols-6 gap-2">
          {(Object.entries(stats) as [string, number][]).map(([key, val]) => (
            <StatPill key={key} label={key} value={val} />
          ))}
        </div>
      </div>

      {/* Magie */}
      <div>
        <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3">Magie</h4>
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-4 text-xs text-slate-300 space-y-4">
          {/* Emplacements de sorts */}
          {player.spellSlots && Object.keys(player.spellSlots).length > 0 ? (
            <div>
              <p className="text-slate-400 mb-1">
                <span className="font-semibold text-slate-300">Emplacements de sorts :</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(player.spellSlots).map(([lvl, s]: any) => (
                  <span
                    key={lvl}
                    className="rounded-full border border-indigo-600/60 bg-indigo-950/40 px-2.5 py-1 text-[11px] text-indigo-100 tabular-nums"
                  >
                    Niv {lvl}: {s.remaining ?? s.max}/{s.max}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-slate-500 italic">Aucun emplacement de sort suivi pour ce personnage.</p>
          )}

          {/* Sorts connus groupés par niveau */}
          {spellsByLevel.size > 0 ? (
            <div className="space-y-3">
              {Array.from(spellsByLevel.entries())
                .sort(([a], [b]) => a - b)
                .map(([lvl, names]) => (
                  <div key={lvl}>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                      Niveau {lvl === 0 ? "0 — Tours de magie" : lvl}
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {names.map((name) => (
                        <SpellBookCard key={name} name={name} />
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <p className="text-slate-500 italic">Aucun sort connu renseigné.</p>
          )}
        </div>
      </div>

      {/* Armes */}
      <div>
        <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3">Armes</h4>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {weapons.map((w: Weapon, i: number) => (
            <div key={i} className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
              <p className="font-bold text-slate-100">{w.name}</p>
              <p className="text-sm text-slate-400 mt-1">
                Attaque <span className="text-green-400 font-semibold">+{w.attackBonus}</span>
                {" · "}
                Dégâts <span className="text-orange-400 font-semibold">{w.damageDice}+{w.damageBonus}</span>
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Sorts (aperçu) */}
      <div>
        <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3">Sorts</h4>
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-xs text-slate-300">
          {spellsByLevel.size > 0 ? (
            <ul className="space-y-1.5">
              {Array.from(spellsByLevel.entries())
                .sort(([a], [b]) => a - b)
                .map(([lvl, names]) => (
                  <li key={lvl}>
                    <span className="font-semibold text-slate-200">
                      Niv {lvl} :
                    </span>{" "}
                    <span className="text-slate-300">
                      {names.join(", ")}
                    </span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="text-slate-500 italic">Aucun sort connu.</p>
          )}
        </div>
      </div>

      {/* Inventaire */}
      <div>
        <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3">Inventaire</h4>
        <p className="text-[11px] text-slate-500 mb-2">
          Objets dans le sac (non équipés ; armure, armes et bouclier portés sont dans « Équipement »).
        </p>
        <ul className="grid grid-cols-2 gap-1.5">
          {inventaireAffiche.length ? (
            inventaireAffiche.map((item: string, i: number) => (
              <li key={i} className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800/50 px-3 py-2 text-sm text-slate-300">
                <span className="text-slate-500">·</span>
                {item}
              </li>
            ))
          ) : (
            <li className="col-span-2 text-sm text-slate-500 italic">
              {inventaireComplet.length ? "Tout votre équipement est porté — voir « Équipement »." : "Aucun objet."}
            </li>
          )}
        </ul>
      </div>

      {/* Maîtrises & Traits */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-2">Maîtrises</h4>
          {Array.isArray(player.proficiencies) && player.proficiencies.length > 0 ? (
            <ul className="space-y-1 text-sm text-slate-300">
              {player.proficiencies.map((p: string, i: number) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
                  {p}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-600 italic">Aucune maîtrise renseignée.</p>
          )}
        </div>
        <div>
          <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-2">Traits & Capacités</h4>
          {Array.isArray(player.features) && player.features.length > 0 ? (
            <ul className="space-y-1 text-sm text-slate-300">
              {player.features.map((f: string, i: number) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
                  {f}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-600 italic">Aucun trait particulier renseigné.</p>
          )}
        </div>
      </div>
    </div>
  );

  const modalStats = (
    <div className="space-y-6">
      {/* HP + CA rapides */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-4">
          <p className="text-xs text-slate-400 mb-1 uppercase tracking-wider">Points de vie</p>
          <p className="text-3xl font-bold text-slate-100">
            {player.hp.current} <span className="text-slate-500 text-lg">/ {player.hp.max}</span>
          </p>
          <HpBar current={player.hp.current} max={player.hp.max} thick />
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-4">
          <p className="text-xs text-slate-400 mb-1 uppercase tracking-wider">Classe d&apos;armure</p>
          <p className="text-3xl font-bold text-blue-300">{displayedArmorClass}</p>
        </div>
      </div>

      {/* Caractéristiques détaillées */}
      <div>
        <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-400 mb-3">Caractéristiques</h4>
        <div className="grid grid-cols-6 gap-2">
          {(Object.entries(stats) as [string, number][]).map(([key, val]) => (
            <StatPill key={key} label={key} value={val} />
          ))}
        </div>
      </div>

      {/* Compétences détaillées */}
      <div>
        <div className="flex items-end justify-between gap-4 mb-3">
          <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Compétences</h4>
          <p className="text-xs text-slate-500">
            Bonus de maîtrise (PB) : <span className="font-bold text-slate-300">+{pb}</span>
          </p>
        </div>

        <div className="rounded-lg border border-slate-700 bg-slate-800/40 overflow-hidden">
          <div className="grid grid-cols-12 gap-0 border-b border-slate-700 bg-slate-900/40 px-3 py-2 text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
            <div className="col-span-5">Skill</div>
            <div className="col-span-3">Carac</div>
            <div className="col-span-2 text-right">Mod</div>
            <div className="col-span-2 text-right">Maîtrise</div>
          </div>

          <div className="divide-y divide-slate-700/60">
            {ALL_SKILLS.map((skill) => {
              const ability = SKILL_TO_ABILITY[skill];
              const base = abilityMod(stats[ability]);
              const proficient = (player.skillProficiencies ?? []).includes(skill);
              const total = base + (proficient ? pb : 0);
              const modStr = total >= 0 ? `+${total}` : `${total}`;
              return (
                <div key={skill} className="grid grid-cols-12 px-3 py-2 text-sm items-center">
                  <div className="col-span-5 text-slate-200 font-medium">{skill}</div>
                  <div className="col-span-3 text-slate-400">{ability}</div>
                  <div className={`col-span-2 text-right tabular-nums font-bold ${total >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {modStr}
                  </div>
                  <div className="col-span-2 text-right text-slate-400">
                    {proficient ? <span className="text-yellow-300 font-semibold">★</span> : <span className="text-slate-600">—</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );

  const modalWeapons = (
    <div className="space-y-4">
      <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Armes</h4>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {weapons.map((w: Weapon, i: number) => (
          <div key={i} className="rounded-lg border border-slate-700 bg-slate-800/60 p-3">
            <p className="font-bold text-slate-100">{w.name}</p>
            <p className="text-sm text-slate-400 mt-1">
              Attaque <span className="text-green-400 font-semibold">+{w.attackBonus}</span>
              {" · "}
              Dégâts <span className="text-orange-400 font-semibold">{w.damageDice}+{w.damageBonus}</span>
            </p>
          </div>
        ))}
      </div>
    </div>
  );

  const modalSpells = (
    <div className="space-y-6">
      <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-4 text-xs text-slate-300 space-y-4">
        {player.spellSlots && Object.keys(player.spellSlots).length > 0 ? (
          <div>
            <p className="text-slate-400 mb-1">
              <span className="font-semibold text-slate-300">Emplacements de sorts :</span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(player.spellSlots).map(([lvl, s]: any) => (
                <span
                  key={lvl}
                  className="rounded-full border border-indigo-600/60 bg-indigo-950/40 px-2.5 py-1 text-[11px] text-indigo-100 tabular-nums"
                >
                  Niv {lvl}: {s.remaining ?? s.max}/{s.max}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-slate-500 italic">Aucun emplacement de sort suivi pour ce personnage.</p>
        )}
      </div>

      <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-4 text-xs text-slate-300 space-y-4">
        {spellsByLevel.size > 0 ? (
          <div className="space-y-3">
            {Array.from(spellsByLevel.entries())
              .sort(([a], [b]) => a - b)
              .map(([lvl, names]) => (
                <div key={lvl}>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                    Niveau {lvl === 0 ? "0 — Tours de magie" : lvl}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {names.map((name) => (
                      <SpellBookCard key={name} name={name} />
                    ))}
                  </div>
                </div>
              ))}
          </div>
        ) : (
          <p className="text-slate-500 italic">Aucun sort connu.</p>
        )}
      </div>
    </div>
  );

  const modalInventory = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Inventaire</h4>
        <span className="text-xs text-slate-500 tabular-nums">{inventaireAffiche.length} objet(s) au sac</span>
      </div>
      <p className="text-[11px] text-slate-500">
        Sont listés ici uniquement les objets <strong className="text-slate-400">non équipés</strong> (le reste est dans
        « Équipement »).
      </p>
      <div className="max-h-[55vh] overflow-y-auto pr-1">
        {inventaireAffiche.length ? (
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {inventaireAffiche.map((item: string, i: number) => (
              <li
                key={i}
                className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800/50 px-3 py-2 text-sm text-slate-300"
              >
                <span className="text-slate-500">·</span>
                <span className="break-words">{item}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500 italic py-4 text-center">
            {inventaireComplet.length
              ? "Tout est équipé — voir l’encadré « Équipement »."
              : "Aucun objet."}
          </p>
        )}
      </div>
    </div>
  );

  const modalEquipment = (
    <div className="space-y-4 text-sm text-slate-200">
      {!canChangeEquipment && (
        <p className="rounded-md border border-amber-800/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">
          En combat, l&apos;équipement ne peut pas être modifié.
        </p>
      )}
      {equipmentUiError ? (
        <p className="rounded-md border border-red-800/60 bg-red-950/40 px-3 py-2 text-xs text-red-100">
          {equipmentUiError}
        </p>
      ) : null}
      <p className="text-xs text-slate-400">
        CA actuelle : <span className="font-semibold text-slate-200">{displayedArmorClass}</span> — calculée
        selon l&apos;armure, le bouclier et le style de combat (ex. Défense).
      </p>
      <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
        {(
          [
            { slot: "armor" as const, label: "Armure (une seule)" },
            { slot: "mainHand" as const, label: "Main principale" },
            { slot: "offHand" as const, label: "Main secondaire (arme légère ou bouclier)" },
            { slot: "bottes" as const, label: "Bottes / chaussures" },
            { slot: "cape" as const, label: "Cape / manteau" },
            { slot: "tete" as const, label: "Couvre-chef" },
            { slot: "gants" as const, label: "Gants / gantelets" },
          ] as const
        ).map(({ slot, label }) => {
          const eq = player.equipment ?? emptyEquipment();
          const current =
            slot === "armor"
              ? eq.armor
              : slot === "mainHand"
                ? eq.mainHand
                : slot === "offHand"
                  ? eq.offHand
                  : slot === "bottes"
                    ? eq.bottes
                    : slot === "cape"
                      ? eq.cape
                      : slot === "tete"
                        ? eq.tete
                        : eq.gants;
          const candidates = inventoryCandidatesForSlot(inventaireComplet, slot);
          return (
            <div
              key={slot}
              className="space-y-2 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  {label}
                </span>
                {current ? (
                  <button
                    type="button"
                    disabled={!canChangeEquipment}
                    onClick={() => applyEquipmentSlot(slot, null)}
                    className="text-[11px] text-amber-300 hover:text-amber-100 disabled:opacity-40"
                  >
                    Déséquiper
                  </button>
                ) : null}
              </div>
              <p className="text-slate-100">{current ?? "—"}</p>
              <select
                className="w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 disabled:opacity-40"
                disabled={!canChangeEquipment}
                defaultValue=""
                onChange={(e) => {
                  const v = e.target.value.trim();
                  if (v) applyEquipmentSlot(slot, v);
                  e.target.value = "";
                }}
              >
                <option value="">Équiper depuis l&apos;inventaire…</option>
                {candidates.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>

      <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-800/50 px-3 py-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Harmonisation (max {MAX_ATTUNED_ITEMS})
        </h4>
        <p className="text-[11px] text-slate-500">
          Objets magiques harmonisés — maximum {MAX_ATTUNED_ITEMS} à la fois (règle D&amp;D 5e).
        </p>
        <ul className="space-y-1">
          {(player.equipment?.attunedItems ?? []).map((name) => (
            <li key={name} className="flex items-center justify-between gap-2 text-slate-200">
              <span>{name}</span>
              <button
                type="button"
                disabled={!canChangeEquipment}
                onClick={() => removeAttunement(name)}
                className="text-[11px] text-amber-300 hover:text-amber-100 disabled:opacity-40"
              >
                Retirer
              </button>
            </li>
          ))}
        </ul>
        {(player.equipment?.attunedItems ?? []).length < MAX_ATTUNED_ITEMS ? (
          <select
            className="w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 disabled:opacity-40"
            disabled={!canChangeEquipment}
            defaultValue=""
            onChange={(e) => {
              const v = e.target.value.trim();
              if (v) applyAttunement(v);
              e.target.value = "";
            }}
          >
            <option value="">Harmoniser un objet…</option>
            {inventaireComplet
              .filter((x) => !(player.equipment?.attunedItems ?? []).includes(x))
              .map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
          </select>
        ) : null}
      </div>
    </div>
  );

  const modalEntities = (
    <div className="space-y-4">
      {displayEntities.length === 0 ? (
        <p className="text-slate-500 italic text-center py-8">Aucune entité dans cette scène.</p>
      ) : (
        displayEntities.map((entity: Entity) => (
          <EntityCardFull
            key={entity.id}
            entity={entity}
            godMode={debugMode}
            combatStealthHidden={
              gameMode === "combat" &&
              entity.type === "hostile" &&
              entity.isAlive &&
              combatHiddenSet.has(entity.id)
            }
          />
        ))
      )}
    </div>
  );

  const modalScene = (
    <div className="flex flex-col items-center gap-4">
      <div className="relative w-full overflow-hidden rounded-xl border border-slate-700">
        <Image
          src={currentSceneImage}
          alt="Illustration de la scène"
          width={1200}
          height={800}
          className="w-full h-auto object-cover"
          priority
        />
      </div>
    </div>
  );

  const modalCombat = (
    <div className="space-y-3">
      {combatOrder.length === 0 ? (
        <p className="text-slate-500 italic text-center py-8">Pas de combat en cours.</p>
      ) : (
        combatOrder
          .map((raw) => normalizeCombatOrderEntry(raw))
          .filter((entry): entry is CombatEntry => entry !== null)
          .filter((entry: CombatEntry) => {
            if (entry.id === "player" || entry.id === localPlayerCombatantId) return true;
            if (String(entry.id ?? "").startsWith("mp-player-")) {
              const cid = String(entry.id).slice("mp-player-".length);
              const prof = multiplayerParticipantProfiles.find(
                (p) => String(p?.clientId ?? "").trim() === String(cid).trim()
              );
              if (!prof) return debugMode;
              if (prof.connected === false && !debugMode) return false;
              return true;
            }
            const ent = entities.find((e) => e.id === entry.id);
            if (!ent) return true;
            if (ent.type !== "hostile") return debugMode;
            if (ent.isAlive === false) return false;
            return true;
          })
          .map((entry: CombatEntry, idx: number) => {
          const entityData = entities.find((e) => e.id === entry.id);
          const meta = entityData ? ENTITY_TYPE_META[entityData.type] : null;
          const isPlayerRow = entry.id === "player" || entry.id === localPlayerCombatantId;
          const isActive = activeCombatantId != null && entry.id === activeCombatantId;
          const meleePeers = getMeleeWith(entry.id);
          const engage = initiativeRowMeleeEngage(entry.id, isPlayerRow, meleePeers);
          const stealthHiddenRow = (() => {
            const eid = String(entry.id ?? "").trim();
            if (isPlayerRow) {
              const aliases = [
                eid,
                String(localPlayerCombatantId ?? "").trim(),
                "player",
                player?.id != null ? String(player.id).trim() : "",
              ].filter(Boolean);
              return aliases.some((id) => combatHiddenSet.has(id));
            }
            return combatHiddenSet.has(eid);
          })();
          return (
            <div
              key={`combat-init-${entry.id}-${idx}`}
              className={`flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors ${
                isActive
                  ? "border-red-600 bg-red-950/40"
                  : isPlayerRow
                  ? "border-blue-700 bg-blue-950/30"
                  : "border-slate-700 bg-slate-800/40"
              }`}
            >
              {engage.showIcon || stealthHiddenRow ? (
                <div className="flex w-11 shrink-0 flex-col items-center justify-center gap-0.5">
                  {engage.showIcon ? (
                    <span className="text-2xl leading-none text-amber-300" title={engage.tooltip}>
                      ⚔
                    </span>
                  ) : null}
                  {stealthHiddenRow ? (
                    <span
                      className="text-xl leading-none text-slate-400"
                      title="Caché — jet de Discrétion réussi (tant que non repéré)"
                    >
                      🥷
                    </span>
                  ) : null}
                </div>
              ) : null}
              <div className="flex w-12 shrink-0 items-center justify-center gap-0.5">
                <span className={`text-2xl text-center ${isActive ? "animate-pulse" : ""}`}>
                  {isActive ? "▶" : isPlayerRow ? "🧙" : (meta?.icon ?? "👤")}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p
                  className={`font-bold flex items-center gap-1.5 min-w-0 ${isPlayerRow ? "text-blue-300" : "text-slate-100"}`}
                >
                  <span className="truncate">
                    {resolveCombatantDisplayName(entry, nameResolutionEntities, player?.name)}
                  </span>
                </p>
                {entityData && (
                  <p className="text-xs text-slate-400">{entityData.race} · {entityData.entityClass}</p>
                )}
        </div>
              <div className="text-right">
                <p className="text-2xl font-bold tabular-nums text-slate-100">{entry.initiative}</p>
                <p className="text-xs text-slate-500">initiative</p>
              </div>
              {/* Barres de vie : visibles uniquement en mode debug (modale initiative) */}
              {debugMode && entityData?.hp && (
                <div className="w-24">
                  <p className="text-xs text-slate-400 text-right">{entityData.hp.current}/{entityData.hp.max}</p>
                  <HpBar current={entityData.hp.current} max={entityData.hp.max} />
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );

  // ---------------------------------------------------------------------------
  // Rendu
  // ---------------------------------------------------------------------------
  return (
    <>
      <div className="flex h-screen w-screen overflow-hidden bg-slate-900 text-white">

        {/* ── Colonne Gauche — Fiche Personnage (20%) ── */}
        <aside className="flex w-1/5 flex-col gap-3 border-r border-slate-700 p-4 overflow-y-auto">

          {/* En-tête joueur — cliquable */}
          <div
            onClick={() => setActiveModal("player")}
            className="cursor-pointer rounded-lg border border-slate-700 bg-slate-800/60 p-3 hover:border-slate-500 hover:bg-slate-700/60 transition-all group"
          >
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-base font-bold tracking-wide text-slate-200">{player.name}</h2>
              <span className="text-[10px] text-slate-600 group-hover:text-slate-400 transition-colors">voir ↗</span>
            </div>
            <p className="text-xs text-slate-400 mb-2">{player.entityClass}</p>
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-slate-400">
                <span>HP</span>
                <span className="tabular-nums">{player.hp.current} / {player.hp.max}</span>
              </div>
              <div className="h-2 w-full rounded-full bg-slate-700">
                <div
                  className="h-2 rounded-full bg-green-500 transition-all"
                  style={{ width: `${hpPct}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-slate-400 pt-1">
                <span>Classe d&apos;Armure</span>
                <span className="tabular-nums font-semibold text-slate-200">{displayedArmorClass}</span>
              </div>
            </div>
          </div>

          {!player.deathState?.dead &&
            (player.hp?.current ?? 0) <= 0 &&
            !player.deathState?.stable && (
              <div className="rounded-lg border border-amber-700/70 bg-amber-950/50 px-3 py-2.5 text-xs text-amber-50 shadow-sm">
                <p className="font-semibold uppercase tracking-wide text-amber-200/95">
                  Jets contre la mort
                </p>
                <p className="mt-1 tabular-nums text-slate-100">
                  Réussites <span className="font-semibold">{player.deathState?.successes ?? 0}</span>/3 ·
                  Échecs <span className="font-semibold">{player.deathState?.failures ?? 0}</span>/3
                </p>
                <p className="mt-1.5 text-[11px] leading-snug text-amber-100/90">
                  {pendingRoll?.kind === "death_save"
                    ? "C\u2019est votre tour : lancez le dé depuis la zone de chat (bouton ou raccourci habituel)."
                    : isInCombat && !isPlayerTurn
                      ? "Ce n'est pas encore votre tour : le jet de sauvegarde sera demandé quand votre tour reviendra."
                      : isInCombat
                        ? "En attente du jet de sauvegarde — le prompt devrait apparaître dans le chat sous peu."
                        : "Hors combat, restez vigilant : si vous revenez en combat à 0 PV non stabilisé, les jets contre la mort reprendront."}
                </p>
              </div>
            )}

          {/* Stats — cliquables */}
          <div
            onClick={() => setActiveModal("stats")}
            className="cursor-pointer rounded-md border border-slate-700 bg-slate-800 p-3 hover:border-slate-500 hover:bg-slate-700/60 transition-all group"
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Stats</h3>
              <span className="text-[10px] text-slate-600 group-hover:text-slate-400 transition-colors">voir ↗</span>
        </div>
            <div className="grid grid-cols-3 gap-1">
              {(Object.entries(stats) as [string, number][]).map(([key, val]) => {
                const mod = Math.floor((val - 10) / 2);
                return (
                  <div key={key} className="flex flex-col items-center rounded border border-slate-700 bg-slate-700/40 py-1 text-center">
                    <span className="text-[9px] font-bold uppercase tracking-wider text-slate-500">{key}</span>
                    <span className="text-sm font-bold text-slate-200 leading-none mt-0.5">{val}</span>
                    <span className={`text-[10px] font-medium ${mod >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {mod >= 0 ? `+${mod}` : mod}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              PB <span className="font-semibold text-slate-300">+{pb}</span>
            </p>
          </div>

          {/* Armes */}
          <div
            onClick={() => setActiveModal("weapons")}
            className="cursor-pointer rounded-md border border-slate-700 bg-slate-800 p-3 hover:border-slate-500 hover:bg-slate-700/60 transition-all group"
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Armes</h3>
              <span className="text-[10px] text-slate-600 group-hover:text-slate-400 transition-colors">voir ↗</span>
            </div>
            <ul className="space-y-1.5">
              {weapons.map((w: Weapon, i: number) => (
                <li key={i} className="text-xs">
                  <p className="font-semibold text-slate-200">{w.name}</p>
                  <p className="text-slate-500">
                    Atk <span className="text-green-400">+{w.attackBonus}</span>
                    {" · "}
                    Dég <span className="text-orange-400">{w.damageDice}+{w.damageBonus}</span>
                  </p>
                </li>
              ))}
            </ul>
          </div>

          {/* Sorts (aperçu) */}
          <div
            onClick={() => setActiveModal("spells")}
            className="cursor-pointer rounded-md border border-slate-700 bg-slate-800 p-3 hover:border-slate-500 hover:bg-slate-700/60 transition-all group"
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Sorts</h3>
              <span className="text-[10px] text-slate-600 group-hover:text-slate-400 transition-colors">voir ↗</span>
            </div>
            <div className="space-y-1 text-xs text-slate-300">
              {spellsByLevel.size > 0 ? (
                Array.from(spellsByLevel.entries())
                  .sort(([a], [b]) => a - b)
                  .slice(0, 3)
                  .map(([lvl, names]) => (
                    <p key={lvl} className="truncate">
                      <span className="font-semibold text-slate-200">Niv {lvl}:</span>{" "}
                      <span className="text-slate-300">{names.join(", ")}</span>
                    </p>
                  ))
              ) : (
                <p className="text-slate-500 italic">Aucun sort connu.</p>
              )}
            </div>
          </div>

          {/* Équipement */}
          <div
            onClick={() => {
              setEquipmentUiError(null);
              setActiveModal("equipment");
            }}
            className={`cursor-pointer rounded-md border border-slate-700 bg-slate-800 p-3 hover:border-slate-500 hover:bg-slate-700/60 transition-all group ${
              isInCombat ? "opacity-60" : ""
            }`}
            title={isInCombat ? "Lecture seule en combat" : "Gérer armes, armure, bouclier"}
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Équipement</h3>
              <span className="text-[10px] text-slate-600 group-hover:text-slate-400 transition-colors">voir ↗</span>
            </div>
            <p className="text-[11px] text-slate-400 mb-1.5">
              CA <span className="font-semibold text-slate-200 tabular-nums">{displayedArmorClass}</span>
              {isInCombat ? <span className="text-slate-500"> · combat (verrouillé)</span> : null}
            </p>
            {equipementListeApercu.length > 0 ? (
              <ul className="space-y-1 text-xs text-slate-300 max-h-28 overflow-hidden">
                {equipementListeApercu.slice(0, 8).map((name: string, i: number) => (
                  <li key={`${name}-${i}`} className="flex items-center gap-1.5">
                    <span className="text-slate-600 shrink-0">·</span>
                    <span className="truncate">{name}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] text-slate-500 italic">Aucun objet équipé.</p>
            )}
            {equipementListeApercu.length > 8 ? (
              <p className="mt-1.5 text-[11px] text-slate-500">
                +{equipementListeApercu.length - 8} autre(s)…
              </p>
            ) : null}
          </div>

          {/* Inventaire */}
          <div
            onClick={() => setActiveModal("inventory")}
            className="cursor-pointer rounded-md border border-slate-700 bg-slate-800 p-3 hover:border-slate-500 hover:bg-slate-700/60 transition-all group"
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Inventaire</h3>
              <span className="text-[10px] text-slate-600 group-hover:text-slate-400 transition-colors">voir ↗</span>
            </div>
            <ul className="space-y-1 text-xs text-slate-300 max-h-32 overflow-hidden">
              {inventaireAffiche.slice(0, 8).map((item: string, i: number) => (
                <li key={i} className="flex items-center gap-1.5">
                  <span className="text-slate-600">·</span>
                  <span className="truncate">{item}</span>
                </li>
              ))}
            </ul>
            {inventaireAffiche.length === 0 && inventaireComplet.length > 0 ? (
              <p className="mt-1 text-[10px] text-slate-500 italic">Sac vide — tout est équipé.</p>
            ) : null}
            {inventaireAffiche.length > 8 && (
              <p className="mt-2 text-[11px] text-slate-500">
                +{inventaireAffiche.length - 8} autre(s) objet(s)… (cliquer pour ouvrir)
              </p>
            )}
          </div>

          <button
            type="button"
            title="Quitte l'aventure : efface la progression et perd l'aventure (le personnage actuel est conservé)"
            onClick={() => {
              if (
                typeof window !== "undefined" &&
                !window.confirm(
                  "Quitter l'aventure ? La progression en cours sera effacée du navigateur (sauvegarde locale) et l'aventure sera perdue. Le personnage actuel est conservé."
                )
              ) {
                return;
              }
              startNewGame();
            }}
            className="mt-auto shrink-0 rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs font-semibold text-amber-200/90 hover:bg-amber-900/50 hover:border-amber-700 transition-colors"
          >
            Quitter
          </button>
        </aside>

        {/* ── Colonne Centre — Chat (60%) ── */}
        <main className="flex w-3/5 flex-col border-r border-slate-700">
          <ChatInterface />
      </main>

        {/* ── Colonne Droite — État du Jeu (20%) ── */}
        <aside className="flex w-1/5 flex-col gap-3 p-4 overflow-y-auto">

          {/* Badge mode de jeu — cliquable si en combat */}
          <div
            onClick={() => isInCombat ? setActiveModal("combat") : undefined}
            className={`flex items-center justify-center gap-2 rounded-lg border py-2 text-sm font-bold tracking-wide transition-colors ${
              isInCombat
                ? "border-red-700 bg-red-950/60 text-red-300 cursor-pointer hover:bg-red-900/50"
                : isShortRestMode
                  ? "border-emerald-700 bg-emerald-950/60 text-emerald-300"
                : "border-slate-700 bg-slate-800/60 text-slate-400"
            }`}
          >
            {isInCombat ? "⚔️ COMBAT" : isShortRestMode ? "🛌 REPOS COURT" : "🗺️ EXPLORATION"}
            {debugMode && <span className="text-teal-400 text-xs font-normal">[Debug]</span>}
            {isInCombat && <span className="text-[10px] text-red-600">↗</span>}
    </div>

          {/* Horloge de campagne (Jour / Heure) */}
          <div className="rounded-md border border-slate-700 bg-slate-800/60 px-3 py-2 text-xs text-slate-300">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold uppercase tracking-wider text-slate-500">Temps</span>
              <span className="tabular-nums font-semibold text-slate-200">
                {formatWorldTimeLabel(worldTimeMinutes)}
              </span>
            </div>
          </div>

          {/* Session multijoueur */}
          <div className="rounded-md border border-slate-700 bg-slate-800/60 px-3 py-2 text-xs text-slate-300 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold uppercase tracking-wider text-slate-500">Session</span>
              <span className={`font-semibold ${multiplayerConnected ? "text-emerald-300" : "text-slate-400"}`}>
                {multiplayerConnected ? "connectée" : "locale"}
              </span>
            </div>
            {multiplayerSessionId ? (
              <div className="space-y-1">
                <p className="text-[11px] text-slate-400">
                  id: <span className="font-mono text-slate-200">{multiplayerSessionId}</span>
                </p>
                <p className="text-[11px] text-slate-400">Participants: {multiplayerParticipants}/4</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      const url = `${window.location.origin}${window.location.pathname}?session=${multiplayerSessionId}`;
                      try { await navigator.clipboard.writeText(url); } catch {}
                    }}
                    className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700/50"
                  >
                    Copier lien
                  </button>
                  <button
                    type="button"
                    onClick={handleLeaveSession}
                    disabled={joiningSession}
                    className="rounded border border-amber-700/60 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-900/40 disabled:opacity-50"
                  >
                    Quitter
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleCreateSession}
                    disabled={joiningSession}
                    className="rounded border border-emerald-700/60 px-2 py-1 text-[11px] text-emerald-200 hover:bg-emerald-900/40 disabled:opacity-50"
                  >
                    Créer
                  </button>
                  <input
                    value={sessionJoinInput}
                    onChange={(e) => setSessionJoinInput(e.target.value)}
                    placeholder="session id"
                    className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-900/70 px-2 py-1 text-[11px] text-slate-100"
                  />
                  <button
                    type="button"
                    onClick={handleJoinSession}
                    disabled={joiningSession || !sessionJoinInput.trim()}
                    className="rounded border border-blue-700/60 px-2 py-1 text-[11px] text-blue-200 hover:bg-blue-900/40 disabled:opacity-50"
                  >
                    Rejoindre
                  </button>
                </div>
              </div>
            )}
            {sessionUiError && <p className="text-[11px] text-amber-300">{sessionUiError}</p>}
          </div>

          {/* Ordre d'initiative (compact) — cliquable */}
          {isInCombat && combatOrder.length > 0 && (
            <div
              onClick={() => setActiveModal("combat")}
              className="cursor-pointer rounded-md border border-red-900/50 bg-red-950/30 p-3 hover:border-red-700/60 hover:bg-red-950/50 transition-all group"
            >
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-red-400">Initiative</h3>
                <span className="text-[10px] text-red-700 group-hover:text-red-500 transition-colors">voir ↗</span>
              </div>
              <ol className="space-y-1">
                {combatOrder
                  .map((raw) => normalizeCombatOrderEntry(raw))
                  .filter((entry): entry is CombatEntry => entry !== null)
                  .filter((entry: CombatEntry) => {
                    if (entry.id === "player" || entry.id === localPlayerCombatantId) return true;
                    if (String(entry.id ?? "").startsWith("mp-player-")) {
                      const cid = String(entry.id).slice("mp-player-".length);
                      const prof = multiplayerParticipantProfiles.find(
                        (p) => String(p?.clientId ?? "").trim() === String(cid).trim()
                      );
                      if (!prof) return debugMode;
                      if (prof.connected === false && !debugMode) return false;
                      return true;
                    }
                    const ent = entities.find((e) => e.id === entry.id);
                    // combatOrder est synchronisé (MJ / multijoueur) : afficher même si l'entité
                    // n'est pas encore dans `entities` sur ce client (hostiles souvent absents du sync).
                    if (!ent) return true;
                    if (ent.type !== "hostile") return debugMode;
                    if (ent.isAlive === false) return false;
                    return true;
                  })
                  .map((entry: CombatEntry, idx: number) => {
                  const meleePeersCompact = getMeleeWith(entry.id);
                  const isPlayerRowCompact =
                    entry.id === "player" || entry.id === localPlayerCombatantId;
                  const engageCompact = initiativeRowMeleeEngage(
                    entry.id,
                    isPlayerRowCompact,
                    meleePeersCompact
                  );
                  const stealthHiddenCompact = (() => {
                    const eid = String(entry.id ?? "").trim();
                    if (isPlayerRowCompact) {
                      const aliases = [
                        eid,
                        String(localPlayerCombatantId ?? "").trim(),
                        "player",
                        player?.id != null ? String(player.id).trim() : "",
                      ].filter(Boolean);
                      return aliases.some((id) => combatHiddenSet.has(id));
                    }
                    return combatHiddenSet.has(eid);
                  })();
                  const isTurnActive =
                    activeCombatantId != null && entry.id === activeCombatantId;
                  return (
                  <li
              key={`combat-init-${entry.id}-${idx}`}
              className={`flex items-center justify-between rounded px-2 py-1 text-xs border transition-all ${
                isTurnActive
                        ? "bg-red-900/45 border-red-500/70 text-red-100 font-semibold shadow-[0_0_0_1px_rgba(239,68,68,0.15),0_0_14px_rgba(239,68,68,0.2)]"
                        : "border-transparent text-slate-400"
                    }`}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-1">
                      {engageCompact.showIcon ? (
                        <span
                          className="inline-flex w-5 shrink-0 justify-center"
                          title={engageCompact.tooltip}
                        >
                          <span className="text-sm leading-none text-amber-300" aria-hidden>
                            ⚔
                          </span>
                        </span>
                      ) : null}
                      {stealthHiddenCompact ? (
                        <span
                          className="inline-flex w-5 shrink-0 justify-center"
                          title="Caché — jet de Discrétion réussi (tant que non repéré)"
                        >
                          <span className="text-sm leading-none text-slate-400" aria-hidden>
                            🥷
                          </span>
                        </span>
                      ) : null}
                      {isTurnActive && <span className="shrink-0 text-red-400">▶</span>}
                      <span
                        className={`min-w-0 truncate ${
                          entry.id === "player" || entry.id === localPlayerCombatantId ? "text-blue-300" : ""
                        }`}
                      >
                        {resolveCombatantDisplayName(entry, nameResolutionEntities, player?.name)}
                      </span>
                    </span>
                    <span className="tabular-nums text-slate-500">{entry.initiative}</span>
                  </li>
                );
                })}
              </ol>
            </div>
          )}

          {/* Entités — cliquables */}
          <div
            onClick={() => setActiveModal("entities")}
            className="flex-1 cursor-pointer rounded-md border border-slate-700 bg-slate-800/40 p-3 hover:border-slate-500 hover:bg-slate-700/40 transition-all group"
          >
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                {debugMode ? "Toutes les entités" : (currentSceneName || "Scène actuelle")}
              </h3>
              <span className="text-[10px] text-slate-600 group-hover:text-slate-400 transition-colors">voir ↗</span>
            </div>

            {displayEntities.length === 0 ? (
              <p className="text-xs text-slate-600 italic">Aucune entité — explorez.</p>
            ) : (
              <div className="space-y-2">
                {displayEntities.map((entity: Entity) => (
                  <EntityCard
                    key={entity.id}
                    entity={entity}
                    godMode={debugMode}
                    combatStealthHidden={
                      gameMode === "combat" &&
                      entity.type === "hostile" &&
                      entity.isAlive &&
                      combatHiddenSet.has(entity.id)
                    }
                  />
                ))}
              </div>
            )}
          </div>

          {/* Image de scène — cliquable */}
          <div
            onClick={() => setActiveModal("scene")}
            className="cursor-pointer rounded-lg overflow-hidden border border-slate-700 hover:border-slate-500 transition-all group relative shrink-0"
          >
            <div className="relative w-full aspect-video">
              <Image
                src={currentSceneImage}
                alt="Illustration de la scène"
                fill
                className="object-cover transition-transform duration-300 group-hover:scale-105"
                sizes="20vw"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-900/70 to-transparent" />
              <span className="absolute bottom-1.5 right-2 text-[10px] text-slate-400 group-hover:text-slate-200 transition-colors">
                voir ↗
              </span>
            </div>
          </div>

        </aside>
      </div>

      {/* ── Modals ── */}
      {activeModal === "player" && (
        <Modal title={`${player.name} — Fiche de personnage`} onClose={closeModal}>
          {modalPlayer}
        </Modal>
      )}
      {activeModal === "stats" && (
        <Modal title={`${player.name} — Stats & compétences`} onClose={closeModal}>
          {modalStats}
        </Modal>
      )}
      {activeModal === "weapons" && (
        <Modal title={`${player.name} — Armes`} onClose={closeModal}>
          {modalWeapons}
        </Modal>
      )}
      {activeModal === "spells" && (
        <Modal title={`${player.name} — Sorts & magie`} onClose={closeModal}>
          {modalSpells}
        </Modal>
      )}
      {activeModal === "inventory" && (
        <Modal title={`${player.name} — Inventaire`} onClose={closeModal}>
          {modalInventory}
        </Modal>
      )}
      {activeModal === "equipment" && (
        <Modal
          title={`${player.name} — Équipement porté`}
          onClose={() => {
            setEquipmentUiError(null);
            closeModal();
          }}
        >
          {modalEquipment}
        </Modal>
      )}
      {activeModal === "entities" && (
        <Modal title={debugMode ? "Toutes les entités (Debug)" : "Entités présentes dans la scène"} onClose={closeModal}>
          {modalEntities}
        </Modal>
      )}
      {activeModal === "scene" && (
        <Modal title="Illustration de la scène" onClose={closeModal}>
          {modalScene}
        </Modal>
      )}
      {activeModal === "combat" && (
        <Modal title="⚔️ Ordre de combat — Initiative" onClose={closeModal}>
          {modalCombat}
        </Modal>
      )}
    </>
  );
}

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeContent />
    </Suspense>
  );
}
