import React, { useState, useEffect } from "react";
import CharacterBuilder from "./CharacterBuilder";
import { CAMPAIGN_CONTEXT } from "../data/campaign";

/** Persos créés via le builder : uniquement dans le navigateur (clé localStorage). */
const STORAGE_KEY = "dnd_characters";

function characterIdentityKey(c) {
  if (!c || typeof c !== "object") return "";
  return `${String(c.name ?? c.nom ?? "").trim()}|${String(c.race ?? "").trim()}|${String(c.entityClass ?? c.classe ?? "").trim()}`;
}

/** Pré-tirés (fiches exportées depuis le créateur intégré). */
const PREGENERATED = [
  {
    id: "pre-1",
    type: "player",
    name: "Thorin Pied-de-Pierre",
    entityClass: "Guerrier",
    race: "Nain des Montagnes",
    level: 1,
    alignment: "Loyal Bon",
    background: "Soldat",
    backgroundFeature: "Grade militaire",
    ideals:
      "Responsabilité. C'est mon devoir de protéger ceux qui ne peuvent pas se protéger eux-mêmes.",
    bonds: "Ceux qui se battent à mes côtés dans les tranchées sont ma véritable famille.",
    flaws:
      "Je fonce souvent tête baissée dans le danger, convaincu que mon armure suffira à me sauver.",
    description:
      "Nain trapu aux larges épaules, barbe rousse tressée avec des anneaux d'acier. Regard sévère mais protecteur, toujours prêt à dégainer.",
    initiative: 1,
    speed: "25 ft",
    visible: true,
    isAlive: true,
    hp: { current: 13, max: 13 },
    ac: 19,
    xp: 0,
    hitDie: "d10",
    hitDiceTotal: 1,
    hitDiceRemaining: 1,
    stats: { FOR: 17, DEX: 13, CON: 16, INT: 12, SAG: 10, CHA: 8 },
    skillProficiencies: ["Athlétisme", "Intimidation", "Perception", "Survie"],
    proficiencies: ["Athlétisme", "Intimidation", "Perception", "Survie"],
    features: [
      "Vision dans le noir (60ft)",
      "Résistance naine (Avantage/Résistance au poison)",
      "Style de combat",
      "Second souffle",
      "Grade militaire",
    ],
    classFeatures: ["Style de combat", "Second souffle"],
    languages: ["Commun", "Nain"],
    selectedSpells: [],
    inventory: [
      "Cotte de mailles",
      "Bouclier",
      "Épée longue",
      "Arbalète légère",
      "Sac d'explorateur",
      "Outils de voleur",
    ],
    weapons: [
      { name: "Épée longue", attackBonus: 5, damageDice: "1d8", damageBonus: 3 },
      { name: "Arbalète légère", attackBonus: 3, damageDice: "1d8", damageBonus: 1 },
    ],
    fighter: {
      fightingStyle: "Défense",
      asiBonuses: { FOR: 0, DEX: 0, CON: 0, INT: 0, SAG: 0, CHA: 0 },
      resources: {
        secondWind: { max: 1, remaining: 1 },
      },
    },
  },
  {
    id: "pre-2",
    type: "player",
    name: "Elyndra Lame-d'Ombre",
    entityClass: "Magicien",
    race: "Haut-Elfe",
    level: 1,
    alignment: "Neutre Bon",
    background: "Sage",
    backgroundFeature: "Chercheur",
    ideals:
      "Connaissance. Le savoir est la clé pour comprendre et maîtriser les mystères du multivers.",
    bonds:
      "Je garde précieusement un vieux grimoire légué par mon mentor disparu ; je dois en percer tous les secrets.",
    flaws:
      "Je suis facilement distraite par la promesse d'une nouvelle information ou d'un mystère magique, même en plein danger.",
    description:
      "Elfe élancée aux cheveux argentés et yeux violets perçants. Porte de longues robes sombres et consulte nerveusement son grimoire.",
    initiative: 2,
    speed: "30 ft",
    visible: true,
    isAlive: true,
    hp: { current: 8, max: 8 },
    ac: 12,
    xp: 0,
    hitDie: "d6",
    hitDiceTotal: 1,
    hitDiceRemaining: 1,
    spellSlots: {
      1: { max: 2, remaining: 2 },
    },
    stats: { FOR: 10, DEX: 15, CON: 14, INT: 16, SAG: 12, CHA: 8 },
    skillProficiencies: ["Arcanes", "Histoire", "Investigation", "Perspicacité"],
    proficiencies: ["Arcanes", "Histoire", "Investigation", "Perspicacité"],
    features: [
      "Vision dans le noir (60ft)",
      "Sens aiguisés",
      "Ascendance fée",
      "Transe",
      "Tour de magie supplémentaire",
      "Incantation",
      "Restauration arcanique",
      "Chercheur",
    ],
    classFeatures: [],
    languages: ["Commun", "Elfique", "Draconique", "Céleste", "Gobelin"],
    selectedSpells: [
      "Prestidigitation",
      "Main de mage",
      "Trait de feu",
      "Armure de mage",
      "Mains brûlantes",
      "Bouclier",
      "Projectile magique",
    ],
    inventory: ["Bâton", "Dague", "Sac d'érudit", "Focaliseur arcanique", "Grimoire"],
    weapons: [
      { name: "Bâton", attackBonus: 2, damageDice: "1d6", damageBonus: 0 },
      { name: "Dague", attackBonus: 4, damageDice: "1d4", damageBonus: 2 },
    ],
    wizard: {
      spellbook: [
        "Armure de mage",
        "Bouclier",
        "Projectile magique",
        "Mains brûlantes",
        "Détection de la magie",
        "Sommeil",
      ],
      preparedSpells: [
        "Prestidigitation",
        "Main de mage",
        "Trait de feu",
        "Armure de mage",
        "Mains brûlantes",
        "Bouclier",
        "Projectile magique",
      ],
      arcaneRecovery: { used: false },
    },
  },
];

const PREGENERATED_IDENTITY_SET = new Set(PREGENERATED.map(characterIdentityKey));

export default function CharacterSelection({ onSelect }) {
  const [customCharacters, setCustomCharacters] = useState([]);
  const [charactersLoaded, setCharactersLoaded] = useState(false);
  const [mode, setMode] = useState("list"); // "list" | "builder"

  useEffect(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setCustomCharacters(parsed);
      }
    } catch {
      // ignore
    }
    setCharactersLoaded(true);
  }, []);

  const customNotDuplicatingPregens = customCharacters.filter(
    (c) => !PREGENERATED_IDENTITY_SET.has(characterIdentityKey(c))
  );
  const allCharacters = [...PREGENERATED, ...customNotDuplicatingPregens];

  const handleSaveCharacter = (character) => {
    const next = [...customCharacters, character];
    setCustomCharacters(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
    setMode("list");
  };

  if (!charactersLoaded) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-4">
        <p className="text-sm text-slate-400">Chargement des personnages…</p>
      </div>
    );
  }

  if (mode === "builder") {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-5xl space-y-6">
          <button
            type="button"
            onClick={() => setMode("list")}
            className="text-xs text-slate-400 hover:text-slate-200 mb-2"
          >
            ← Retour à la sélection de personnages
          </button>
          <CharacterBuilder onSave={handleSaveCharacter} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-4xl space-y-6">
        <div className="text-center">
          <h1 className="text-3xl sm:text-4xl font-black tracking-tight">
            Choisissez votre héros
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            Campagne : <span className="text-slate-200">{CAMPAIGN_CONTEXT.title}</span>
          </p>
        </div>

        <div className="flex justify-between items-center">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
            Personnages disponibles
          </h2>
          <button
            type="button"
            onClick={() => setMode("builder")}
            className="rounded-md bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
          >
            Créer un Héros
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {allCharacters.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect?.(c)}
              className="group text-left rounded-xl border border-slate-800 bg-slate-900/70 p-4 hover:border-blue-500 hover:bg-slate-900/90 transition-colors"
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <p className="text-base font-semibold text-slate-50">{c.name ?? c.nom}</p>
                <span className="text-[11px] rounded-full border border-slate-700 px-2 py-0.5 text-slate-300">
                  Niveau {c.level ?? 1}
                </span>
              </div>
              <p className="text-xs text-slate-400 mb-1">
                {c.race} — {c.entityClass ?? c.classe}
              </p>
              <p className="text-xs text-slate-500">
                PV {c.hp?.current ?? "?"}/{c.hp?.max ?? "?"} · CA {c.ac ?? c.armorClass ?? "?"} · Vitesse {c.speed ?? "—"}
              </p>
            </button>
          ))}

          {allCharacters.length === 0 && (
            <p className="text-sm text-slate-500 col-span-full">
              Aucun personnage disponible. Créez un héros pour commencer.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

