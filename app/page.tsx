"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Image from "next/image";
import ChatInterface from "@/components/ChatInterface";
import CampaignMenu from "@/components/CampaignMenu";
import CharacterSelection from "@/components/CharacterSelection";
import {
  useGame,
  type PlayerStats,
  type Weapon,
  type Entity,
  type CombatEntry,
} from "@/context/GameContext";
import { SPELLS } from "@/data/srd5";
import { resolveCombatantDisplayName } from "@/lib/combatDisplayName";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const ENTITY_TYPE_META: Record<string, { icon: string; color: string; label: string }> = {
  hostile:  { icon: "☠",  color: "text-red-400",    label: "Hostile"  },
  npc:      { icon: "👤", color: "text-slate-300",  label: "PNJ"      },
  friendly: { icon: "🛡", color: "text-green-400",  label: "Allié"    },
  object:   { icon: "📦", color: "text-amber-400",  label: "Objet"    },
};

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

type ModalType = "player" | "stats" | "weapons" | "spells" | "inventory" | "entities" | "scene" | "combat" | null;

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
function EntityCard({ entity, godMode, onClick }: { entity: Entity; godMode: boolean; onClick?: () => void }) {
  const meta = ENTITY_TYPE_META[entity.type] ?? { icon: "?", color: "text-slate-400", label: "" };
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
        <span className={`text-sm ${meta.color}`}>{meta.icon}</span>
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
function EntityCardFull({ entity, godMode }: { entity: Entity; godMode: boolean }) {
  const meta = ENTITY_TYPE_META[entity.type] ?? { icon: "?", color: "text-slate-400", label: "Inconnu" };
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
        <span className={`text-2xl ${meta.color}`}>{meta.icon}</span>
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

export default function Home() {
  const {
    isGameStarted, startGame, setPlayer, startNewGame,
    player, entities, gameMode, combatOrder, combatTurnIndex, debugMode, currentSceneName, currentSceneImage,
    turnResources,
    getMeleeWith,
  } = useGame();

  /** Créature au corps à corps avec le PJ (état mêlée du moteur). */
  const isInMeleeWithPlayer = (combatantId: string) =>
    combatantId !== "player" && getMeleeWith("player").includes(combatantId);

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
  const closeModal = useCallback(() => setActiveModal(null), []);

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

  // Étape 0 : aucun personnage sélectionné → écran de sélection/création
  if (!player) {
    return <CharacterSelection onSelect={setPlayer} />;
  }

  // Si le jeu n'a pas commencé, on affiche UNIQUEMENT le menu
  if (!isGameStarted) {
    return <CampaignMenu onStart={startGame} onBack={() => setPlayer(null)} />;
  }

  const stats: PlayerStats  = player.stats;
  const inventaire: string[] = player.inventaire;
  const weapons: Weapon[]    = player.weapons;

  const displayEntities = debugMode
    ? entities
    : entities.filter((e) => e.visible && e.type !== "object");
  const isInCombat = gameMode === "combat";
  const isPlayerTurn =
    isInCombat &&
    combatOrder.length > 0 &&
    combatOrder[combatTurnIndex]?.id === "player";
  const activeCombatantId =
    isInCombat && combatOrder.length > 0
      ? combatOrder[combatTurnIndex]?.id ?? null
      : null;

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
          <h3 className="text-2xl font-bold text-slate-100">{player.nom}</h3>
          <p className="text-slate-400">
            {player.race ? `${player.race} — ${player.classe}` : player.classe}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Niveau {player.level} · Initiative {player.initiative ?? abilityMod(stats.DEX)} · Vitesse {player.speed ?? "30 ft"}
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
          <p className="text-3xl font-bold text-blue-300">{player.armorClass}</p>
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
              {player.hitDie && (
                <>
                  {" · "}Dés de vie :{" "}
                  <span className="tabular-nums text-slate-300">
                    {player.hitDiceRemaining ?? player.level}/{player.hitDiceTotal ?? player.level} ({player.hitDie})
                  </span>
                </>
              )}
            </p>
          )}
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
                      {names.map((name) => {
                        const spell: any = (SPELLS as any)[name];
                        const line =
                          spell?.damage
                            ? `${spell.damage}${spell.damageType ? ` ${spell.damageType}` : ""}`
                            : spell?.effect || "";
                        return (
                          <div
                            key={name}
                            className="rounded-md border border-slate-700 bg-slate-900/60 px-3 py-2"
                          >
                            <p className="text-sm font-semibold text-slate-100">{name}</p>
                            {line && (
                              <p className="text-[11px] text-slate-400 mt-0.5">
                                {line}
                              </p>
                            )}
                          </div>
                        );
                      })}
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
        <ul className="grid grid-cols-2 gap-1.5">
          {inventaire.map((item: string, i: number) => (
            <li key={i} className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800/50 px-3 py-2 text-sm text-slate-300">
              <span className="text-slate-500">·</span>
              {item}
            </li>
          ))}
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
          <p className="text-3xl font-bold text-blue-300">{player.armorClass}</p>
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
                    {names.map((name) => {
                      const spell: any = (SPELLS as any)[name];
                      const line =
                        spell?.damage
                          ? `${spell.damage}${spell.damageType ? ` ${spell.damageType}` : ""}`
                          : spell?.effect || "";
                      return (
                        <div key={name} className="rounded-md border border-slate-700 bg-slate-900/60 px-3 py-2">
                          <p className="text-sm font-semibold text-slate-100">{name}</p>
                          {line && (
                            <p className="text-[11px] text-slate-400 mt-0.5">
                              {line}
                            </p>
                          )}
                        </div>
                      );
                    })}
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
        <span className="text-xs text-slate-500 tabular-nums">{inventaire.length} objet(s)</span>
      </div>
      <div className="max-h-[55vh] overflow-y-auto pr-1">
        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {inventaire.map((item: string, i: number) => (
            <li
              key={i}
              className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800/50 px-3 py-2 text-sm text-slate-300"
            >
              <span className="text-slate-500">·</span>
              <span className="break-words">{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );

  const modalEntities = (
    <div className="space-y-4">
      {displayEntities.length === 0 ? (
        <p className="text-slate-500 italic text-center py-8">Aucune entité dans cette scène.</p>
      ) : (
        displayEntities.map((entity: Entity) => (
          <EntityCardFull key={entity.id} entity={entity} godMode={debugMode} />
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
            if (entry.id === "player") return true;
            const ent = entities.find((e) => e.id === entry.id);
            if (!ent) return debugMode; // inconnu : seulement en debug
            if (ent.type !== "hostile") return debugMode; // on n'affiche que les hostiles en combat (hors debug)
            if (ent.isAlive === false && !debugMode) return false; // hostile mort : caché
            if (!ent.visible && !debugMode) return false; // hostile invisible : caché à l'UI
            return true;
          })
          .map((entry: CombatEntry, idx: number) => {
          const entityData = entities.find((e) => e.id === entry.id);
          const meta = entityData ? ENTITY_TYPE_META[entityData.type] : null;
          const isPlayer = entry.id === "player";
          const isActive = activeCombatantId != null && entry.id === activeCombatantId;
          return (
            <div
              key={`combat-init-${entry.id}-${idx}`}
              className={`flex items-center gap-4 rounded-xl border px-5 py-3 transition-colors ${
                isActive
                  ? "border-red-600 bg-red-950/40"
                  : isPlayer
                  ? "border-blue-700 bg-blue-950/30"
                  : "border-slate-700 bg-slate-800/40"
              }`}
            >
              <div className="flex w-12 shrink-0 items-center justify-center gap-0.5">
                <span className={`text-2xl text-center ${isActive ? "animate-pulse" : ""}`}>
                  {isActive ? "▶" : isPlayer ? "🧙" : (meta?.icon ?? "👤")}
                </span>
                {!isPlayer && isInMeleeWithPlayer(entry.id) && (
                  <span
                    className="text-base leading-none text-amber-400"
                    title="Au contact avec vous (mêlée)"
                    aria-label="Au contact, mêlée"
                  >
                    ⚔
                  </span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className={`font-bold ${isPlayer ? "text-blue-300" : "text-slate-100"}`}>
                  {resolveCombatantDisplayName(entry, entities, player?.nom)}
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
              <h2 className="text-base font-bold tracking-wide text-slate-200">{player.nom}</h2>
              <span className="text-[10px] text-slate-600 group-hover:text-slate-400 transition-colors">voir ↗</span>
            </div>
            <p className="text-xs text-slate-400 mb-2">{player.classe}</p>
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
                <span className="tabular-nums font-semibold text-slate-200">{player.armorClass}</span>
              </div>
            </div>
          </div>

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
              {inventaire.slice(0, 8).map((item: string, i: number) => (
                <li key={i} className="flex items-center gap-1.5">
                  <span className="text-slate-600">·</span>
                  <span className="truncate">{item}</span>
                </li>
              ))}
            </ul>
            {inventaire.length > 8 && (
              <p className="mt-2 text-[11px] text-slate-500">
                +{inventaire.length - 8} autre(s) objet(s)… (cliquer pour ouvrir)
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
                : "border-slate-700 bg-slate-800/60 text-slate-400"
            }`}
          >
            {isInCombat ? "⚔️ COMBAT" : "🗺️ EXPLORATION"}
            {debugMode && <span className="text-teal-400 text-xs font-normal">[Debug]</span>}
            {isInCombat && <span className="text-[10px] text-red-600">↗</span>}
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
                    if (entry.id === "player") return true;
                    const ent = entities.find((e) => e.id === entry.id);
                    if (!ent) return debugMode;
                    if (ent.type !== "hostile") return debugMode;
                    if (ent.isAlive === false && !debugMode) return false;
                    if (!ent.visible && !debugMode) return false;
                    return true;
                  })
                  .map((entry: CombatEntry, idx: number) => (
                  <li
              key={`combat-init-${entry.id}-${idx}`}
              className={`flex items-center justify-between rounded px-2 py-1 text-xs border transition-all ${
                activeCombatantId != null && entry.id === activeCombatantId
                        ? "bg-red-900/45 border-red-500/70 text-red-100 font-semibold shadow-[0_0_0_1px_rgba(239,68,68,0.15),0_0_14px_rgba(239,68,68,0.2)]"
                        : "border-transparent text-slate-400"
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {activeCombatantId != null && entry.id === activeCombatantId && <span className="shrink-0 text-red-400">▶</span>}
                      {entry.id !== "player" && isInMeleeWithPlayer(entry.id) && (
                        <span
                          className="shrink-0 text-amber-400"
                          title="Au contact avec vous (mêlée)"
                          aria-label="Au contact, mêlée"
                        >
                          ⚔
                        </span>
                      )}
                      <span
                        className={`truncate ${entry.id === "player" ? "text-blue-300" : ""}`}
                      >
                        {resolveCombatantDisplayName(entry, entities, player?.nom)}
                      </span>
                    </span>
                    <span className="tabular-nums text-slate-500">{entry.initiative}</span>
                  </li>
                ))}
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
                  <EntityCard key={entity.id} entity={entity} godMode={debugMode} />
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
        <Modal title={`${player.nom} — Fiche de personnage`} onClose={closeModal}>
          {modalPlayer}
        </Modal>
      )}
      {activeModal === "stats" && (
        <Modal title={`${player.nom} — Stats & compétences`} onClose={closeModal}>
          {modalStats}
        </Modal>
      )}
      {activeModal === "weapons" && (
        <Modal title={`${player.nom} — Armes`} onClose={closeModal}>
          {modalWeapons}
        </Modal>
      )}
      {activeModal === "spells" && (
        <Modal title={`${player.nom} — Sorts & magie`} onClose={closeModal}>
          {modalSpells}
        </Modal>
      )}
      {activeModal === "inventory" && (
        <Modal title={`${player.nom} — Inventaire`} onClose={closeModal}>
          {modalInventory}
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
