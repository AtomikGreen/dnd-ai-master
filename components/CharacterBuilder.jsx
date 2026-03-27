import React, { useState, useMemo, useEffect } from "react";
import {
  RACES,
  CLASSES,
  WEAPONS,
  ARMORS,
  STARTING_EQUIPMENT,
  BACKGROUNDS,
  SKILLS_DB,
  SPELLS,
  CALCULATE_MODIFIER,
  LANGUAGES,
  FIGHTING_STYLES_FIGHTER,
  FIGHTER_ARCHETYPES_SRD,
  FIGHTER_ASI_LEVELS,
  FIGHTER_FEATURES_BY_LEVEL,
  FIGHTER_CHAMPION_FEATURES_BY_LEVEL,
  BATTLEMASTER_DICE_BY_LEVEL,
  BATTLEMASTER_MANEUVERS_SRD,
  ELDRITCH_KNIGHT_SLOTS_BY_LEVEL,
  ELDRITCH_KNIGHT_SPELLS_KNOWN_BY_LEVEL,
  ARCANE_TRADITIONS_SRD,
  WIZARD_ASI_LEVELS,
  WIZARD_FEATURES_BY_LEVEL,
  WIZARD_CANTRIPS_KNOWN_BY_LEVEL,
  WIZARD_SLOTS_BY_LEVEL,
  CLERIC_DOMAINS_SRD,
  CLERIC_ASI_LEVELS,
  CLERIC_FEATURES_BY_LEVEL,
  CLERIC_CANTRIPS_KNOWN_BY_LEVEL,
  CLERIC_SLOTS_BY_LEVEL,
  CLERIC_DOMAIN_FEATURES_BY_LEVEL,
  clericDomainSpellsForLevel,
  ROGUE_ARCHETYPES_SRD,
  ROGUE_ASI_LEVELS,
  ROGUE_FEATURES_BY_LEVEL,
  ROGUE_ARCHETYPE_FEATURES_BY_LEVEL,
  ROGUE_SNEAK_ATTACK_DICE_BY_LEVEL,
  ARCANE_TRICKSTER_SLOTS_BY_LEVEL,
  ARCANE_TRICKSTER_SPELLS_KNOWN_BY_LEVEL,
  ARCANE_TRICKSTER_ALLOWED_SCHOOLS,
  ARCANE_TRICKSTER_ANY_SCHOOL_SPELL_LEVELS,
} from "../data/srd5";

const BASE_SCORES = [15, 14, 13, 12, 10, 8];
const ABILITIES = ["FOR", "DEX", "CON", "INT", "SAG", "CHA"];

function normalizeFrLocal(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Table officielle PX → niveau / bonus de maîtrise (niv 1–20)
const XP_BY_LEVEL = {
  1: 0,
  2: 300,
  3: 900,
  4: 2700,
  5: 6500,
  6: 14000,
  7: 23000,
  8: 34000,
  9: 48000,
  10: 64000,
  11: 85000,
  12: 100000,
  13: 120000,
  14: 140000,
  15: 165000,
  16: 195000,
  17: 225000,
  18: 265000,
  19: 305000,
  20: 355000,
};

function proficiencyBonusForLevel(level) {
  if (level <= 4) return 2;
  if (level <= 8) return 3;
  if (level <= 12) return 4;
  if (level <= 16) return 5;
  return 6;
}

function averageHitDiePerLevel(hitDie) {
  if (!hitDie) return 1;
  // Règle RAW : moyenne arrondie au supérieur, ex d10 → 6
  return Math.floor(hitDie / 2) + 1;
}

// Nombre d'opportunités d'« Amélioration de caractéristiques » génériques
// (niveaux 4, 8, 12, 16, 19) — approximation valable pour la plupart des classes.
function asiOpportunitiesForLevel(level) {
  const thresholds = [4, 8, 12, 16, 19];
  return thresholds.filter((t) => level >= t).length;
}

function min1(n) {
  const v = Number(n) || 0;
  return v < 1 ? 1 : v;
}

// Progression spécifique du Barde (PHB 2014) :
// nombre de sorts mineurs connus, sorts connus totaux et niveau max de sort accessible.
// N.B. : nom local pour éviter tout conflit de nom avec d'autres fichiers.
const BARD_SPELL_PROGRESS_LOCAL = {
  1:  { cantrips: 2, spells: 4,  maxSpellLevel: 1 },
  2:  { cantrips: 2, spells: 5,  maxSpellLevel: 1 },
  3:  { cantrips: 2, spells: 6,  maxSpellLevel: 2 },
  4:  { cantrips: 3, spells: 7,  maxSpellLevel: 2 },
  5:  { cantrips: 3, spells: 8,  maxSpellLevel: 3 },
  6:  { cantrips: 3, spells: 9,  maxSpellLevel: 3 },
  7:  { cantrips: 3, spells: 10, maxSpellLevel: 4 },
  8:  { cantrips: 3, spells: 11, maxSpellLevel: 4 },
  9:  { cantrips: 3, spells: 12, maxSpellLevel: 5 },
  10: { cantrips: 4, spells: 14, maxSpellLevel: 5 },
  11: { cantrips: 4, spells: 15, maxSpellLevel: 6 },
  12: { cantrips: 4, spells: 15, maxSpellLevel: 6 },
  13: { cantrips: 4, spells: 16, maxSpellLevel: 7 },
  14: { cantrips: 4, spells: 18, maxSpellLevel: 7 },
  15: { cantrips: 4, spells: 19, maxSpellLevel: 8 },
  16: { cantrips: 4, spells: 19, maxSpellLevel: 8 },
  17: { cantrips: 4, spells: 20, maxSpellLevel: 9 },
  18: { cantrips: 4, spells: 22, maxSpellLevel: 9 },
  19: { cantrips: 4, spells: 22, maxSpellLevel: 9 },
  20: { cantrips: 4, spells: 22, maxSpellLevel: 9 },
};

// Emplacements de sorts pour le Barde (niveaux 1–9)
// Forme : { [niveau de personnage]: { [niveau de sort]: nombre d'emplacements } }
// N.B. : nom local pour éviter tout conflit de nom avec d'autres fichiers.
const BARD_SPELL_SLOTS_LOCAL = {
  "1":  { "1": 2 },
  "2":  { "1": 3 },
  "3":  { "1": 4, "2": 2 },
  "4":  { "1": 4, "2": 3 },
  "5":  { "1": 4, "2": 3, "3": 2 },
  "6":  { "1": 4, "2": 3, "3": 3 },
  "7":  { "1": 4, "2": 3, "3": 3, "4": 1 },
  "8":  { "1": 4, "2": 3, "3": 3, "4": 2 },
  "9":  { "1": 4, "2": 3, "3": 3, "4": 3, "5": 1 },
  "10": { "1": 4, "2": 3, "3": 3, "4": 3, "5": 2 },
  "11": { "1": 4, "2": 3, "3": 3, "4": 3, "5": 2, "6": 1 },
  "12": { "1": 4, "2": 3, "3": 3, "4": 3, "5": 2, "6": 1 },
  "13": { "1": 4, "2": 3, "3": 3, "4": 3, "5": 2, "6": 1, "7": 1 },
  "14": { "1": 4, "2": 3, "3": 3, "4": 3, "5": 2, "6": 1, "7": 1 },
  "15": { "1": 4, "2": 3, "3": 3, "4": 3, "5": 2, "6": 1, "7": 1, "8": 1 },
  "16": { "1": 4, "2": 3, "3": 3, "4": 3, "5": 2, "6": 1, "7": 1, "8": 1 },
  "17": { "1": 4, "2": 3, "3": 3, "4": 3, "5": 2, "6": 1, "7": 1, "8": 1, "9": 1 },
  "18": { "1": 4, "2": 3, "3": 3, "4": 3, "5": 3, "6": 1, "7": 1, "8": 1, "9": 1 },
  "19": { "1": 4, "2": 3, "3": 3, "4": 3, "5": 3, "6": 2, "7": 1, "8": 1, "9": 1 },
  "20": { "1": 4, "2": 3, "3": 3, "4": 3, "5": 3, "6": 2, "7": 2, "8": 1, "9": 1 },
};

export default function CharacterBuilder({ onSave }) {
  const [name, setName] = useState("");
  const [race, setRace] = useState("");
  const [className, setClassName] = useState("");
  const [background, setBackground] = useState("");
  const [alignment, setAlignment] = useState("");
  const [ideals, setIdeals] = useState("");
  const [bonds, setBonds] = useState("");
  const [flaws, setFlaws] = useState("");
  const [description, setDescription] = useState("");
  const [level, setLevel] = useState(1);
  const [selectedSkills, setSelectedSkills] = useState([]);
  const [selectedSpells, setSelectedSpells] = useState([]); // [{name, level}]
  // Magicien (SRD) : grimoire + préparations + tradition
  const [wizardTradition, setWizardTradition] = useState("");
  const [wizardSpellbook, setWizardSpellbook] = useState([]); // [name]
  const [wizardPrepared, setWizardPrepared] = useState([]); // [name]
  const [wizardAsiBonuses, setWizardAsiBonuses] = useState({
    FOR: 0,
    DEX: 0,
    CON: 0,
    INT: 0,
    SAG: 0,
    CHA: 0,
  });
  // Clerc (SRD) : domaine + sorts préparés
  const [clericDomain, setClericDomain] = useState("");
  const [clericCantrips, setClericCantrips] = useState([]); // [name] lvl 0
  const [clericPrepared, setClericPrepared] = useState([]); // [name] lvl 1+
  const [clericAsiBonuses, setClericAsiBonuses] = useState({
    FOR: 0,
    DEX: 0,
    CON: 0,
    INT: 0,
    SAG: 0,
    CHA: 0,
  });
  // Roublard (SRD) : archétype + expertise + (option) Escroc arcanique
  const [rogueArchetype, setRogueArchetype] = useState("");
  const [rogueExpertiseSkills, setRogueExpertiseSkills] = useState([]); // [skillName]
  const [rogueExpertiseThievesTools, setRogueExpertiseThievesTools] = useState(false);
  const [arcaneTricksterCantrips, setArcaneTricksterCantrips] = useState([]); // [name]
  const [arcaneTricksterSpells, setArcaneTricksterSpells] = useState([]); // [name]
  const [rogueAsiBonuses, setRogueAsiBonuses] = useState({
    FOR: 0,
    DEX: 0,
    CON: 0,
    INT: 0,
    SAG: 0,
    CHA: 0,
  });
  const [fighterStyle, setFighterStyle] = useState("");
  const [fighterArchetype, setFighterArchetype] = useState("");
  const [fighterManeuvers, setFighterManeuvers] = useState([]); // Maître de guerre
  const [fighterAsiBonuses, setFighterAsiBonuses] = useState({
    FOR: 0,
    DEX: 0,
    CON: 0,
    INT: 0,
    SAG: 0,
    CHA: 0,
  });
  const [baseStats, setBaseStats] = useState({
    FOR: 15,
    DEX: 14,
    CON: 13,
    INT: 12,
    SAG: 10,
    CHA: 8,
  });

  const raceObj = race ? RACES[race] : null;
  const classObj = className ? CLASSES[className] : null;
  const bgObj = background ? BACKGROUNDS[background] : null;
  const bgSkills = Array.isArray(bgObj?.skills) ? bgObj.skills : [];

  const isFighter = className === "Guerrier";
  const isWizard = className === "Magicien";
  const isCleric = className === "Clerc";
  const isRogue = className === "Roublard";

  const wizardAsiPointsAllowed = useMemo(() => {
    if (!isWizard) return 0;
    const levels = Array.isArray(WIZARD_ASI_LEVELS) ? WIZARD_ASI_LEVELS : [];
    return levels.filter((t) => level >= t).length * 2;
  }, [isWizard, level]);

  const wizardAsiPointsUsed = useMemo(() => {
    if (!isWizard) return 0;
    return Object.values(wizardAsiBonuses).reduce((a, b) => a + (Number(b) || 0), 0);
  }, [isWizard, wizardAsiBonuses]);

  const clericAsiPointsAllowed = useMemo(() => {
    if (!isCleric) return 0;
    const levels = Array.isArray(CLERIC_ASI_LEVELS) ? CLERIC_ASI_LEVELS : [];
    return levels.filter((t) => level >= t).length * 2;
  }, [isCleric, level]);

  const clericAsiPointsUsed = useMemo(() => {
    if (!isCleric) return 0;
    return Object.values(clericAsiBonuses).reduce((a, b) => a + (Number(b) || 0), 0);
  }, [isCleric, clericAsiBonuses]);

  const rogueAsiPointsAllowed = useMemo(() => {
    if (!isRogue) return 0;
    const levels = Array.isArray(ROGUE_ASI_LEVELS) ? ROGUE_ASI_LEVELS : [];
    return levels.filter((t) => level >= t).length * 2;
  }, [isRogue, level]);

  const rogueAsiPointsUsed = useMemo(() => {
    if (!isRogue) return 0;
    return Object.values(rogueAsiBonuses).reduce((a, b) => a + (Number(b) || 0), 0);
  }, [isRogue, rogueAsiBonuses]);

  const fighterAsiPointsAllowed = useMemo(() => {
    if (!isFighter) return 0;
    const levels = Array.isArray(FIGHTER_ASI_LEVELS) ? FIGHTER_ASI_LEVELS : [];
    return levels.filter((t) => level >= t).length * 2; // +2 ou +1/+1
  }, [isFighter, level]);

  const fighterAsiPointsUsed = useMemo(() => {
    if (!isFighter) return 0;
    return Object.values(fighterAsiBonuses).reduce((a, b) => a + (Number(b) || 0), 0);
  }, [fighterAsiBonuses, isFighter]);

  useEffect(() => {
    // Reset choix Guerrier quand on change de classe
    if (!isFighter) {
      setFighterStyle("");
      setFighterArchetype("");
      setFighterManeuvers([]);
      setFighterAsiBonuses({ FOR: 0, DEX: 0, CON: 0, INT: 0, SAG: 0, CHA: 0 });
    }
  }, [isFighter]);

  useEffect(() => {
    // Reset choix Magicien quand on change de classe
    if (!isWizard) {
      setWizardTradition("");
      setWizardSpellbook([]);
      setWizardPrepared([]);
      setWizardAsiBonuses({ FOR: 0, DEX: 0, CON: 0, INT: 0, SAG: 0, CHA: 0 });
    }
  }, [isWizard]);

  useEffect(() => {
    // Reset choix Clerc quand on change de classe
    if (!isCleric) {
      setClericDomain("");
      setClericCantrips([]);
      setClericPrepared([]);
      setClericAsiBonuses({ FOR: 0, DEX: 0, CON: 0, INT: 0, SAG: 0, CHA: 0 });
    }
  }, [isCleric]);

  useEffect(() => {
    // Reset choix Roublard quand on change de classe
    if (!isRogue) {
      setRogueArchetype("");
      setRogueExpertiseSkills([]);
      setRogueExpertiseThievesTools(false);
      setArcaneTricksterCantrips([]);
      setArcaneTricksterSpells([]);
      setRogueAsiBonuses({ FOR: 0, DEX: 0, CON: 0, INT: 0, SAG: 0, CHA: 0 });
    }
  }, [isRogue]);

  // Règle UX demandée : quand le niveau change, reset les choix dépendants du niveau
  // (évite les états incohérents quand on monte/descend le niveau).
  useEffect(() => {
    if (!className) return;

    // Sorts : reset générique (les plafonds/quotas varient beaucoup selon les classes)
    setSelectedSpells([]);

    // Guerrier : reset des choix liés au niveau (archétype/ASI)
    if (className === "Guerrier") {
      setFighterArchetype(level >= 3 ? fighterArchetype : "");
      setFighterManeuvers([]);
      setFighterAsiBonuses({ FOR: 0, DEX: 0, CON: 0, INT: 0, SAG: 0, CHA: 0 });
      // on conserve le style (niveau 1) sauf si niveau < 1 (impossible)
    }

    // Magicien : reset grimoire/préparés/ASI/tradition (strict)
    if (className === "Magicien") {
      setWizardTradition(level >= 2 ? wizardTradition : "");
      setWizardSpellbook([]);
      setWizardPrepared([]);
      setWizardAsiBonuses({ FOR: 0, DEX: 0, CON: 0, INT: 0, SAG: 0, CHA: 0 });
    }

    // Clerc : reset domaine/sorts/ASI (strict)
    if (className === "Clerc") {
      setClericDomain(level >= 1 ? clericDomain : "");
      setClericCantrips([]);
      setClericPrepared([]);
      setClericAsiBonuses({ FOR: 0, DEX: 0, CON: 0, INT: 0, SAG: 0, CHA: 0 });
    }

    // Roublard : reset archétype/expertise/magie AT/ASI (strict)
    if (className === "Roublard") {
      setRogueArchetype(level >= 3 ? rogueArchetype : "");
      setRogueExpertiseSkills([]);
      setRogueExpertiseThievesTools(false);
      setArcaneTricksterCantrips([]);
      setArcaneTricksterSpells([]);
      setRogueAsiBonuses({ FOR: 0, DEX: 0, CON: 0, INT: 0, SAG: 0, CHA: 0 });
    }
  }, [level]);

  useEffect(() => {
    // Si le niveau baisse, s'assurer que les champs restent cohérents
    if (!isFighter) return;
    if (level < 3) {
      setFighterArchetype("");
      setFighterManeuvers([]);
    }
    if (fighterAsiPointsUsed > fighterAsiPointsAllowed) {
      // fallback simple: reset (évite des états incohérents)
      setFighterAsiBonuses({ FOR: 0, DEX: 0, CON: 0, INT: 0, SAG: 0, CHA: 0 });
    }
  }, [isFighter, level, fighterAsiPointsAllowed, fighterAsiPointsUsed]);

  useEffect(() => {
    if (!isWizard) return;
    if (level < 2) setWizardTradition("");
    // Si on réduit les ASI, reset simple
    if (wizardAsiPointsUsed > wizardAsiPointsAllowed) {
      setWizardAsiBonuses({ FOR: 0, DEX: 0, CON: 0, INT: 0, SAG: 0, CHA: 0 });
    }
  }, [isWizard, level, wizardAsiPointsAllowed, wizardAsiPointsUsed]);

  useEffect(() => {
    if (!isCleric) return;
    if (clericAsiPointsUsed > clericAsiPointsAllowed) {
      setClericAsiBonuses({ FOR: 0, DEX: 0, CON: 0, INT: 0, SAG: 0, CHA: 0 });
    }
  }, [isCleric, clericAsiPointsAllowed, clericAsiPointsUsed]);

  useEffect(() => {
    if (!isRogue) return;
    if (level < 3) {
      setRogueArchetype("");
      setArcaneTricksterCantrips([]);
      setArcaneTricksterSpells([]);
    }
    if (rogueAsiPointsUsed > rogueAsiPointsAllowed) {
      setRogueAsiBonuses({ FOR: 0, DEX: 0, CON: 0, INT: 0, SAG: 0, CHA: 0 });
    }
  }, [isRogue, level, rogueAsiPointsAllowed, rogueAsiPointsUsed]);

  const [chosenLanguages, setChosenLanguages] = useState([]);

  const raceExtraLanguageSlots = raceObj?.extraLanguageSlots ?? 0;
  const bgExtraLanguageSlots = bgObj?.extraLanguages ?? 0;
  const totalLanguageSlots = raceExtraLanguageSlots + bgExtraLanguageSlots;

  const baseLanguages = useMemo(
    () => (Array.isArray(raceObj?.languages) ? raceObj.languages : []),
    [raceObj]
  );

  const languages = useMemo(
    () => Array.from(new Set([...baseLanguages, ...chosenLanguages])),
    [baseLanguages, chosenLanguages]
  );

  const availableLanguages = useMemo(() => {
    // Toutes les langues possibles moins celles déjà obtenues "gratuitement" par la race
    const all = LANGUAGES ?? [];
    const baseSet = new Set(baseLanguages);
    return all.filter((lang) => !baseSet.has(lang));
  }, [baseLanguages]);

  useEffect(() => {
    // Si on réduit le nombre d'emplacements (changement de race/background),
    // on garde simplement les premières langues choisies.
    if (totalLanguageSlots <= 0) {
      setChosenLanguages([]);
      return;
    }
    setChosenLanguages((prev) =>
      prev.length > totalLanguageSlots ? prev.slice(0, totalLanguageSlots) : prev
    );
  }, [totalLanguageSlots]);

  const finalStats = useMemo(() => {
    const bonuses = raceObj?.statBonuses ?? {};
    const result = {};
    for (const key of ABILITIES) {
      const base = Number(baseStats[key]) || 0;
      const bonus = Number(bonuses[key]) || 0;
      const asi =
        isFighter ? Number(fighterAsiBonuses?.[key] ?? 0) :
        isWizard ? Number(wizardAsiBonuses?.[key] ?? 0) :
        isCleric ? Number(clericAsiBonuses?.[key] ?? 0) :
        isRogue ? Number(rogueAsiBonuses?.[key] ?? 0) :
        0;
      result[key] = Math.min(20, base + bonus + asi);
    }
    return result;
  }, [baseStats, raceObj, isFighter, fighterAsiBonuses, isWizard, wizardAsiBonuses, isCleric, clericAsiBonuses, isRogue, rogueAsiBonuses]);

  const modifiers = useMemo(() => {
    const mods = {};
    for (const key of ABILITIES) {
      mods[key] = CALCULATE_MODIFIER(finalStats[key] || 0);
    }
    return mods;
  }, [finalStats]);

  const maxHp = useMemo(() => {
    if (!classObj) return null;
    const conMod = modifiers.CON ?? 0;
    const hitDie = classObj.hitDice || 0;
    const base = Math.max(1, hitDie + conMod); // niveau 1 : max du dé + CON
    if (level <= 1) return base;
    const avgPerLevel = Math.max(1, averageHitDiePerLevel(hitDie) + conMod);
    return base + (level - 1) * avgPerLevel;
  }, [classObj, modifiers, level]);

  const proficiencyBonus = useMemo(
    () => proficiencyBonusForLevel(level),
    [level]
  );

  const startingEquipment = useMemo(() => {
    if (!className) return null;
    return STARTING_EQUIPMENT?.[className] ?? null;
  }, [className]);

  const inventory = useMemo(() => {
    if (!startingEquipment) return [];
    const out = [];
    if (startingEquipment.armor && startingEquipment.armor !== "Aucune") out.push(startingEquipment.armor);
    if (startingEquipment.shield && startingEquipment.shield !== "Aucun") out.push(startingEquipment.shield);
    if (Array.isArray(startingEquipment.weapons)) out.push(...startingEquipment.weapons);
    if (Array.isArray(startingEquipment.items)) out.push(...startingEquipment.items);
    return out.filter(Boolean);
  }, [startingEquipment]);

  const armorClass = useMemo(() => {
    const dexMod = modifiers.DEX ?? 0;
    const wisMod = modifiers.SAG ?? 0;
    const conMod = modifiers.CON ?? 0;

    const armorName = startingEquipment?.armor ?? "Aucune";
    const shieldName = startingEquipment?.shield ?? "Aucun";

    const hasShield = shieldName === "Bouclier";
    const shieldBonus = hasShield ? (ARMORS?.Bouclier?.baseAC ?? 2) : 0;

    const fighterDefenseBonus =
      isFighter && fighterStyle === "Défense" && armorName && armorName !== "Aucune" && ARMORS?.[armorName]
        ? 1
        : 0;

    // Armure "Aucune" ou inconnue -> CA de base + éventuellement Défense sans armure
    if (!armorName || armorName === "Aucune" || !ARMORS?.[armorName]) {
      let base = 10 + dexMod;
      if (className === "Moine") base += wisMod;
      if (className === "Barbare") base += conMod;
      return base + shieldBonus;
    }

    const armor = ARMORS[armorName];
    const baseAC = Number(armor.baseAC ?? 10);
    let modPart = 0;
    if (armor.modifier === "DEX") modPart = dexMod;
    else if (armor.modifier === "DEX_MAX_2") modPart = Math.min(2, dexMod);
    else if (armor.modifier === "NONE") modPart = 0;
    // "SHIELD" géré via shieldBonus

    return baseAC + modPart + shieldBonus + fighterDefenseBonus;
  }, [startingEquipment, modifiers, className, isFighter, fighterStyle]);

  const attacks = useMemo(() => {
    const list = [];
    const weaponNames = startingEquipment?.weapons ?? [];
    const strMod = modifiers.FOR ?? 0;
    const dexMod = modifiers.DEX ?? 0;

    for (const wName of weaponNames) {
      const w = WEAPONS?.[wName] ?? null;
      if (!w) continue; // résilient : ignore si DB manquante

      const statTag = w.stat ?? "FOR";
      const abilityMod =
        statTag === "DEX"
          ? dexMod
          : statTag === "FINESSE"
          ? Math.max(strMod, dexMod)
          : strMod;

      // Style Archerie : +2 aux jets d'attaque avec une arme à distance
      const isRanged = (w?.properties ?? []).some((p) => String(p).toLowerCase().includes("munitions"));
      const archeryBonus = isFighter && fighterStyle === "Archerie" && isRanged ? 2 : 0;

      const toHit = abilityMod + proficiencyBonus + archeryBonus;
      const dmgBonus = abilityMod;
      const dmgDice = String(w.damage ?? "1");
      const dmgType = w.damageType ?? "—";

      list.push({
        name: wName,
        toHit,
        damageDice: dmgDice,
        damageBonus: dmgBonus,
        damageType: dmgType,
      });
    }

    return list;
  }, [startingEquipment, modifiers, proficiencyBonus, isFighter, fighterStyle]);

  const fighterClassFeatures = useMemo(() => {
    if (!isFighter) return [];
    const base = [];
    for (let i = 1; i <= level; i += 1) {
      const feats = FIGHTER_FEATURES_BY_LEVEL?.[i];
      if (Array.isArray(feats)) base.push(...feats);
      if (fighterArchetype === "Champion") {
        const ch = FIGHTER_CHAMPION_FEATURES_BY_LEVEL?.[i];
        if (Array.isArray(ch)) base.push(...ch);
      }
      if (fighterArchetype === "Maître de guerre") {
        if (i === 3) base.push("Supériorité martiale", "Disciple martial");
        if (i === 7) base.push("Observation de l'ennemi");
        if (i === 10) base.push("Supériorité martiale améliorée");
        if (i === 15) base.push("Implacable");
        if (i === 18) base.push("Supériorité martiale améliorée (d12)");
      }
      if (fighterArchetype === "Chevalier occulte") {
        if (i === 3) base.push("Incantation (Chevalier occulte)", "Lien avec une arme");
        if (i === 7) base.push("Magie de guerre");
        if (i === 10) base.push("Frappe occulte");
        if (i === 15) base.push("Charge arcanique");
        if (i === 18) base.push("Magie de guerre améliorée");
      }
    }
    return Array.from(new Set(base));
  }, [fighterArchetype, isFighter, level]);

  const fighterSecondWindResource = useMemo(() => {
    if (!isFighter) return null;
    return { max: 1, remaining: 1 };
  }, [isFighter]);

  const fighterBattleMasterMeta = useMemo(() => {
    if (!isFighter || fighterArchetype !== "Maître de guerre") return null;
    // Choisir le plus haut palier <= level
    const keys = Object.keys(BATTLEMASTER_DICE_BY_LEVEL ?? {})
      .map((k) => parseInt(k, 10))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);
    let picked = null;
    for (const k of keys) {
      if (k <= level) picked = BATTLEMASTER_DICE_BY_LEVEL[k];
    }
    return picked;
  }, [fighterArchetype, isFighter, level]);

  const fighterEldritchKnightMeta = useMemo(() => {
    if (!isFighter || fighterArchetype !== "Chevalier occulte") return null;
    const prog = ELDRITCH_KNIGHT_SPELLS_KNOWN_BY_LEVEL?.[level] ?? null;
    const slotsRow = ELDRITCH_KNIGHT_SLOTS_BY_LEVEL?.[level] ?? null;
    return { prog, slotsRow };
  }, [fighterArchetype, isFighter, level]);

  const toggleManeuver = (name) => {
    setFighterManeuvers((prev) => {
      const has = prev.includes(name);
      if (has) return prev.filter((m) => m !== name);
      const max = fighterBattleMasterMeta?.maneuversKnown ?? 0;
      if (max && prev.length >= max) return prev;
      return [...prev, name];
    });
  };

  const setAsiBonus = (ability, value) => {
    const v = Math.max(0, Math.min(2, Number(value) || 0));
    setFighterAsiBonuses((prev) => {
      const next = { ...prev, [ability]: v };
      const used = Object.values(next).reduce((a, b) => a + (Number(b) || 0), 0);
      if (used > fighterAsiPointsAllowed) return prev;
      return next;
    });
  };

  const availableSkillChoices = useMemo(() => {
    const sc = classObj?.skillChoices ?? null;
    if (!sc || !Array.isArray(sc.options) || typeof sc.count !== "number") return null;
    // options peuvent référencer SKILLS_DB; on garde seulement celles existantes pour être safe
    const opts = sc.options.filter((s) => typeof s === "string" && (SKILLS_DB?.[s] || true));
    return { count: sc.count, options: opts };
  }, [classObj]);

  const casterSpells = useMemo(() => {
    if (!className) return null;
    // Niveau max de sort accessible selon la classe / niveau
    let maxSpellLevel = 1;
    if (className === "Barde") {
      const prog = BARD_SPELL_PROGRESS_LOCAL[level];
      if (prog) maxSpellLevel = prog.maxSpellLevel;
    }
    if (className === "Magicien") {
      const row = WIZARD_SLOTS_BY_LEVEL?.[level] ?? null;
      if (row) {
        const keys = Object.keys(row).map((k) => parseInt(k, 10)).filter((n) => !Number.isNaN(n));
        maxSpellLevel = keys.length ? Math.max(...keys) : 1;
      } else {
        maxSpellLevel = 1;
      }
    }
    if (className === "Clerc") {
      const row = CLERIC_SLOTS_BY_LEVEL?.[level] ?? null;
      if (row) {
        const keys = Object.keys(row).map((k) => parseInt(k, 10)).filter((n) => !Number.isNaN(n));
        maxSpellLevel = keys.length ? Math.max(...keys) : 1;
      } else {
        maxSpellLevel = 1;
      }
    }
    const entries = Object.entries(SPELLS ?? {});
    const allowed = entries
      .filter(([, s]) => {
        const lvl = Number(s?.level);
        const classes = Array.isArray(s?.classes) ? s.classes : [];
        if (!classes.includes(className)) return false;
        if (lvl === 0) return true; // tours de magie toujours visibles
        if (!maxSpellLevel || lvl > maxSpellLevel) return false;
        return true;
      })
      .map(([name, s]) => ({
        name,
        level: s.level,
        damage: s.damage,
        damageType: s.damageType,
        effect: s.effect,
        attack: s.attack,
        save: s.save,
      }));
    return allowed.length ? allowed : null;
  }, [className, level]);

  // Clerc : cantrips + préparations + domaine
  const clericCantripLimit = useMemo(() => {
    if (!isCleric) return 0;
    const n = CLERIC_CANTRIPS_KNOWN_BY_LEVEL?.[level] ?? 3;
    return Number(n) || 3;
  }, [isCleric, level]);

  const clericSpellSlotsRow = useMemo(() => {
    if (!isCleric) return null;
    return CLERIC_SLOTS_BY_LEVEL?.[level] ?? null;
  }, [isCleric, level]);

  const clericMaxSpellLevel = useMemo(() => {
    if (!isCleric) return 0;
    const row = clericSpellSlotsRow;
    if (!row) return 1;
    const keys = Object.keys(row).map((k) => parseInt(k, 10)).filter((n) => !Number.isNaN(n));
    return keys.length ? Math.max(...keys) : 1;
  }, [isCleric, clericSpellSlotsRow]);

  const clericPreparedLimit = useMemo(() => {
    if (!isCleric) return 0;
    return min1((modifiers.SAG ?? 0) + (level || 1));
  }, [isCleric, modifiers.SAG, level]);

  const clericDomainSpells = useMemo(() => {
    if (!isCleric || !clericDomain) return [];
    return clericDomainSpellsForLevel(clericDomain, level) ?? [];
  }, [isCleric, clericDomain, level]);

  const clericAvailableSpells = useMemo(() => {
    if (!isCleric) return { cantrips: [], leveled: [] };
    const all = Object.entries(SPELLS ?? {}).map(([name, s]) => ({ name, ...s }));
    const cantrips = all.filter((s) => Array.isArray(s?.classes) && s.classes.includes("Clerc") && Number(s.level) === 0);
    const leveled = all.filter((s) => Array.isArray(s?.classes) && s.classes.includes("Clerc") && Number(s.level) >= 1 && Number(s.level) <= clericMaxSpellLevel);
    return { cantrips, leveled };
  }, [isCleric, clericMaxSpellLevel]);

  const toggleClericCantrip = (spellName) => {
    setClericCantrips((prev) => {
      const has = prev.includes(spellName);
      if (has) return prev.filter((s) => s !== spellName);
      if (prev.length >= clericCantripLimit) return prev;
      return [...prev, spellName];
    });
  };

  const toggleClericPrepared = (spellName) => {
    setClericPrepared((prev) => {
      const has = prev.includes(spellName);
      if (has) return prev.filter((s) => s !== spellName);
      if (prev.length >= clericPreparedLimit) return prev;
      return [...prev, spellName];
    });
  };

  const setClericAsiBonus = (ability, value) => {
    const v = Math.max(0, Math.min(2, Number(value) || 0));
    setClericAsiBonuses((prev) => {
      const next = { ...prev, [ability]: v };
      const used = Object.values(next).reduce((a, b) => a + (Number(b) || 0), 0);
      if (used > clericAsiPointsAllowed) return prev;
      return next;
    });
  };

  const setRogueAsiBonus = (ability, value) => {
    const v = Math.max(0, Math.min(2, Number(value) || 0));
    setRogueAsiBonuses((prev) => {
      const next = { ...prev, [ability]: v };
      const used = Object.values(next).reduce((a, b) => a + (Number(b) || 0), 0);
      if (used > rogueAsiPointsAllowed) return prev;
      return next;
    });
  };

  const rogueSneakDice = useMemo(() => {
    if (!isRogue) return null;
    return ROGUE_SNEAK_ATTACK_DICE_BY_LEVEL?.[level] ?? "1d6";
  }, [isRogue, level]);

  const rogueExpertiseAllowedCount = useMemo(() => {
    if (!isRogue) return 0;
    // niv 1: 2 choix; niv 6: +2
    return (level >= 1 ? 2 : 0) + (level >= 6 ? 2 : 0);
  }, [isRogue, level]);

  const rogueExpertiseUsedCount = useMemo(() => {
    if (!isRogue) return 0;
    const skills = Array.isArray(rogueExpertiseSkills) ? rogueExpertiseSkills.length : 0;
    const tools = rogueExpertiseThievesTools ? 1 : 0;
    return skills + tools;
  }, [isRogue, rogueExpertiseSkills, rogueExpertiseThievesTools]);

  const finalSkillProficiencies = useMemo(() => {
    const merged = [...bgSkills, ...selectedSkills].filter(
      (s) => typeof s === "string" && s.trim()
    );
    return Array.from(new Set(merged));
  }, [bgSkills, selectedSkills]);

  const rogueExpertiseOptions = useMemo(() => {
    if (!isRogue) return [];
    // options = compétences maîtrisées finales + option outils de voleur
    const opts = Array.isArray(finalSkillProficiencies)
      ? finalSkillProficiencies
      : [];
    return opts;
  }, [isRogue, finalSkillProficiencies]);

  const toggleRogueExpertiseSkill = (skill) => {
    setRogueExpertiseSkills((prev) => {
      const p = Array.isArray(prev) ? prev : [];
      const has = p.includes(skill);
      if (has) return p.filter((s) => s !== skill);
      if (rogueExpertiseUsedCount >= rogueExpertiseAllowedCount) return p;
      return [...p, skill];
    });
  };

  const toggleRogueExpertiseThievesTools = () => {
    setRogueExpertiseThievesTools((prev) => {
      if (prev) return false;
      if (rogueExpertiseUsedCount >= rogueExpertiseAllowedCount) return prev;
      return true;
    });
  };

  const isArcaneTrickster = isRogue && rogueArchetype === "Escroc arcanique" && level >= 3;

  const arcaneTricksterMeta = useMemo(() => {
    if (!isArcaneTrickster) return null;
    return ARCANE_TRICKSTER_SPELLS_KNOWN_BY_LEVEL?.[level] ?? null;
  }, [isArcaneTrickster, level]);

  const arcaneTricksterSlotsRow = useMemo(() => {
    if (!isArcaneTrickster) return null;
    return ARCANE_TRICKSTER_SLOTS_BY_LEVEL?.[level] ?? null;
  }, [isArcaneTrickster, level]);

  const arcaneTricksterAllowedWizardSpells = useMemo(() => {
    if (!isArcaneTrickster) return { cantrips: [], leveled: [] };
    const meta = arcaneTricksterMeta;
    const maxSpellLevel = meta?.maxSpellLevel ?? 1;
    const all = Object.entries(SPELLS ?? {}).map(([name, s]) => ({ name, ...s }));
    const cantrips = all.filter((s) => Array.isArray(s?.classes) && s.classes.includes("Magicien") && Number(s.level) === 0);
    const leveled = all.filter((s) => {
      if (!Array.isArray(s?.classes) || !s.classes.includes("Magicien")) return false;
      const lvl = Number(s.level);
      if (!(lvl >= 1 && lvl <= maxSpellLevel)) return false;
      const school = String(s.school ?? "");
      const allowedSchool = ARCANE_TRICKSTER_ALLOWED_SCHOOLS.includes(school);
      if (allowedSchool) return true;
      // Exceptions : un seul sort hors école appris aux niveaux 3/8/14/20
      // On modélise côté UI: on autorise hors-école uniquement si on est à un de ces niveaux
      return ARCANE_TRICKSTER_ANY_SCHOOL_SPELL_LEVELS.includes(level);
    });
    return { cantrips, leveled };
  }, [isArcaneTrickster, arcaneTricksterMeta, level]);

  const toggleArcaneTricksterCantrip = (name) => {
    setArcaneTricksterCantrips((prev) => {
      const p = Array.isArray(prev) ? prev : [];
      const has = p.includes(name);
      const limit = arcaneTricksterMeta?.cantrips ?? 0;
      if (has) {
        // main de mage obligatoire (niv3) : empêcher de retirer si obligatoire
        if (normalizeFrLocal(name) === normalizeFrLocal("Main de mage")) return p;
        return p.filter((s) => s !== name);
      }
      if (limit && p.length >= limit) return p;
      return [...p, name];
    });
  };

  const toggleArcaneTricksterSpell = (name) => {
    setArcaneTricksterSpells((prev) => {
      const p = Array.isArray(prev) ? prev : [];
      const has = p.includes(name);
      if (has) return p.filter((s) => s !== name);
      const limit = arcaneTricksterMeta?.spells ?? 0;
      if (limit && p.length >= limit) return p;
      return [...p, name];
    });
  };

  const clericChannelDivinityMax = useMemo(() => {
    if (!isCleric) return 0;
    if (level < 2) return 0;
    if (level >= 18) return 3;
    if (level >= 6) return 2;
    return 1;
  }, [isCleric, level]);

  // Magicien : cantrips connus (hors quota préparés)
  const wizardCantripLimit = useMemo(() => {
    if (!isWizard) return 0;
    const n = WIZARD_CANTRIPS_KNOWN_BY_LEVEL?.[level] ?? 3;
    return Number(n) || 3;
  }, [isWizard, level]);

  const wizardSpellSlotsRow = useMemo(() => {
    if (!isWizard) return null;
    return WIZARD_SLOTS_BY_LEVEL?.[level] ?? null;
  }, [isWizard, level]);

  const wizardMaxSpellLevel = useMemo(() => {
    if (!isWizard) return 0;
    const row = wizardSpellSlotsRow;
    if (!row) return 1;
    const keys = Object.keys(row).map((k) => parseInt(k, 10)).filter((n) => !Number.isNaN(n));
    return keys.length ? Math.max(...keys) : 1;
  }, [isWizard, wizardSpellSlotsRow]);

  const wizardPreparedLimit = useMemo(() => {
    if (!isWizard) return 0;
    return min1((modifiers.INT ?? 0) + (level || 1));
  }, [isWizard, modifiers.INT, level]);

  const wizardSpellbookExpected = useMemo(() => {
    if (!isWizard) return 0;
    // SRD : 6 sorts au niveau 1, puis +2 par niveau
    return 6 + Math.max(0, (level - 1) * 2);
  }, [isWizard, level]);

  const wizardAvailableWizardSpells = useMemo(() => {
    if (!isWizard) return { cantrips: [], leveled: [] };
    const all = Object.entries(SPELLS ?? {}).map(([name, s]) => ({ name, ...s }));
    const cantrips = all.filter((s) => Array.isArray(s?.classes) && s.classes.includes("Magicien") && Number(s.level) === 0);
    const leveled = all.filter((s) => Array.isArray(s?.classes) && s.classes.includes("Magicien") && Number(s.level) >= 1 && Number(s.level) <= wizardMaxSpellLevel);
    return { cantrips, leveled };
  }, [isWizard, wizardMaxSpellLevel]);

  const toggleWizardSpellbook = (spellName) => {
    setWizardSpellbook((prev) => {
      const has = prev.includes(spellName);
      if (has) {
        // retirer du grimoire implique retirer des préparés si besoin
        setWizardPrepared((p) => p.filter((x) => x !== spellName));
        return prev.filter((s) => s !== spellName);
      }
      return [...prev, spellName];
    });
  };

  const toggleWizardPrepared = (spellName) => {
    setWizardPrepared((prev) => {
      const has = prev.includes(spellName);
      if (has) return prev.filter((s) => s !== spellName);
      // Le quota "INT + niveau" ne compte que les sorts de niveau >= 1 (les cantrips ont un quota séparé)
      const preparedLeveledCount = prev.filter((n) => (SPELLS?.[n]?.level ?? 0) >= 1).length;
      if (preparedLeveledCount >= wizardPreparedLimit) return prev;
      return [...prev, spellName];
    });
  };

  const toggleWizardCantripPrepared = (spellName) => {
    // On stocke les cantrips dans selectedSpells via selectedSpells (pour compat moteur) ? Non:
    // on les inclut dans wizardPrepared également, mais sans compter dans le quota.
    setWizardPrepared((prev) => {
      const has = prev.includes(spellName);
      if (has) return prev.filter((s) => s !== spellName);
      // limite cantrips
      const currentCantrips = prev.filter((n) => (SPELLS?.[n]?.level ?? 0) === 0).length;
      if (currentCantrips >= wizardCantripLimit) return prev;
      return [...prev, spellName];
    });
  };

  const setWizardAsiBonus = (ability, value) => {
    const v = Math.max(0, Math.min(2, Number(value) || 0));
    setWizardAsiBonuses((prev) => {
      const next = { ...prev, [ability]: v };
      const used = Object.values(next).reduce((a, b) => a + (Number(b) || 0), 0);
      if (used > wizardAsiPointsAllowed) return prev;
      return next;
    });
  };

  const toggleSkill = (skill) => {
    if (!availableSkillChoices) return;
    setSelectedSkills((prev) => {
      const has = prev.includes(skill);
      if (has) return prev.filter((s) => s !== skill);
      if (prev.length >= availableSkillChoices.count) return prev; // limite stricte
      return [...prev, skill];
    });
  };

  const toggleSpell = (spellName) => {
    setSelectedSpells((prev) => {
      const has = prev.some((s) => s.name === spellName);
      if (has) return prev.filter((s) => s.name !== spellName);

      const spell = casterSpells?.find((s) => s.name === spellName);
      if (!spell) return prev;

      // Limites par classe/niveau
      let maxCantrips = 0;
      let maxSpells = 0;
      if (className === "Barde") {
        const prog = BARD_SPELL_PROGRESS_LOCAL[level] || BARD_SPELL_PROGRESS_LOCAL[1];
        maxCantrips = prog.cantrips;
        maxSpells = prog.spells;
      } else {
        // Autres classes : plafond générique large pour l'instant
        maxCantrips = 8;
        maxSpells = 8;
      }

      const currentCantrips = prev.filter((s) => s.level === 0).length;
      const currentLevel1Plus = prev.filter((s) => s.level >= 1).length;

      if (spell.level === 0 && currentCantrips >= maxCantrips) return prev;
      if (spell.level >= 1 && currentLevel1Plus >= maxSpells) return prev;

      return [...prev, { name: spell.name, level: spell.level }];
    });
  };

  // Quand le niveau ou la classe changent (surtout pour Barde),
  // on purge automatiquement les sorts qui dépassent les limites
  // (niveau de sort trop élevé ou quantité au-delà du maximum).
  useEffect(() => {
    if (className !== "Barde") return;
    const prog = BARD_SPELL_PROGRESS_LOCAL[level] || BARD_SPELL_PROGRESS_LOCAL[1];
    if (!prog) return;

    setSelectedSpells((prev) => {
      // Sépare cantrips / sorts de niveau >=1
      const cantrips = prev.filter((s) => s.level === 0);
      const leveled = prev.filter(
        (s) => s.level >= 1 && s.level <= prog.maxSpellLevel
      );

      // Tronque si au‑delà des quotas
      const keptCantrips = cantrips.slice(0, prog.cantrips);
      const keptLeveled = leveled.slice(0, prog.spells);

      // Conserver l'ordre original de sélection
      const allowedSet = new Set(
        [...keptCantrips, ...keptLeveled].map((s) => `${s.name}|${s.level}`)
      );
      const next = prev.filter((s) =>
        allowedSet.has(`${s.name}|${s.level}`)
      );

      // Si rien ne change, ne pas déclencher de re‑render inutile
      if (next.length === prev.length) return prev;
      return next;
    });
  }, [className, level]);

  const handleStatChange = (ability, value) => {
    const v = Number(value);
    if (!BASE_SCORES.includes(v)) return;
    setBaseStats((prev) => {
      const current = prev[ability];
      if (current === v) return prev;

      // Trouver si une autre carac possède déjà ce score → on swap
      const otherKey = Object.keys(prev).find(
        (k) => k !== ability && Number(prev[k]) === v
      );

      if (!otherKey) {
        // Personne n'avait cette valeur → simple assignation (devrait être rare)
        return { ...prev, [ability]: v };
      }

      return {
        ...prev,
        [ability]: v,
        [otherKey]: current,
      };
    });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (
      !name.trim() ||
      !raceObj ||
      !classObj ||
      !bgObj ||
      !maxHp ||
      !alignment ||
      !description.trim() ||
      !ideals.trim() ||
      !bonds.trim() ||
      !flaws.trim()
    ) {
      return;
    }

    const id = Date.now();
    const hitDieValue = classObj?.hitDice;
    const hitDie = hitDieValue ? `d${hitDieValue}` : null;
    const weaponsForState = attacks.map((a) => ({
      name: a.name,
      attackBonus: a.toHit,
      damageDice: a.damageDice,
      damageBonus: a.damageBonus,
    }));
    // Emplacements de sorts (actuellement : progression détaillée pour Barde)
    let spellSlots = undefined;
    if (className === "Barde") {
      const row = BARD_SPELL_SLOTS_LOCAL[level];
      if (row) {
        spellSlots = {};
        Object.entries(row).forEach(([sl, n]) => {
          const num = Number(n);
          const lvl = Number(sl);
          if (num > 0) {
            spellSlots[lvl] = { max: num, remaining: num };
          }
        });
      }
    }
    if (className === "Magicien") {
      const row = WIZARD_SLOTS_BY_LEVEL?.[level] ?? null;
      if (row) {
        spellSlots = {};
        Object.entries(row).forEach(([sl, n]) => {
          const num = Number(n);
          const lvl = Number(sl);
          if (num > 0) {
            spellSlots[lvl] = { max: num, remaining: num };
          }
        });
      }
    }
    if (className === "Clerc") {
      const row = CLERIC_SLOTS_BY_LEVEL?.[level] ?? null;
      if (row) {
        spellSlots = {};
        Object.entries(row).forEach(([sl, n]) => {
          const num = Number(n);
          const lvl = Number(sl);
          if (num > 0) {
            spellSlots[lvl] = { max: num, remaining: num };
          }
        });
      }
    }
    if (className === "Roublard" && rogueArchetype === "Escroc arcanique" && arcaneTricksterSlotsRow) {
      const row = arcaneTricksterSlotsRow;
      spellSlots = {};
      Object.entries(row).forEach(([sl, n]) => {
        const num = Number(n);
        const lvl = Number(sl);
        if (num > 0) {
          spellSlots[lvl] = { max: num, remaining: num };
        }
      });
    }

    const character = {
      id,
      type: "player",
      name: name.trim(),
      entityClass: className,
      race,
      level,
      alignment: alignment || undefined,
      background: background || undefined,
      backgroundFeature: Array.isArray(bgObj.features) && bgObj.features.length ? bgObj.features[0] : undefined,
      ideals: ideals || undefined,
      bonds: bonds || undefined,
      flaws: flaws || undefined,
      description: description || undefined,
      initiative: modifiers.DEX ?? 0,
      speed: `${raceObj.speed ?? 30} ft`,
      visible: true,
      isAlive: true,
      hp: { current: maxHp, max: maxHp },
      ac: armorClass,
      xp: XP_BY_LEVEL[level] ?? 0,
      hitDie: hitDie || undefined,
      hitDiceTotal: level,
      hitDiceRemaining: level,
      spellSlots,
      stats: finalStats,
      skillProficiencies: finalSkillProficiencies,
      // Pour l'IA: compétences maîtrisées = celles donnant le +2 (PB) sur jets
      proficiencies: finalSkillProficiencies,
      features: [
        ...(raceObj.features ?? []),
        ...(classObj.features ?? []),
        ...(bgObj.features ?? []),
      ],
      classFeatures: fighterClassFeatures,
      languages,
      selectedSpells:
        className === "Magicien"
          ? Array.from(new Set(wizardPrepared))
          : className === "Clerc"
            ? Array.from(new Set([...(clericCantrips ?? []), ...(clericPrepared ?? []), ...(clericDomainSpells ?? [])]))
            : className === "Roublard" && rogueArchetype === "Escroc arcanique"
              ? Array.from(new Set([...(arcaneTricksterCantrips ?? []), ...(arcaneTricksterSpells ?? [])]))
          : Array.isArray(selectedSpells)
            ? selectedSpells.map((s) => s.name)
            : [],
      inventory,
      weapons: weaponsForState.length ? weaponsForState : [],
      ...(isFighter
        ? {
            fighter: {
              fightingStyle: fighterStyle || undefined,
              martialArchetype: fighterArchetype || undefined,
              asiBonuses: fighterAsiBonuses,
              resources: {
                secondWind: fighterSecondWindResource,
                ...(fighterArchetype === "Maître de guerre" && fighterBattleMasterMeta
                  ? {
                      superiorityDice: {
                        die: fighterBattleMasterMeta.die,
                        dice: fighterBattleMasterMeta.dice,
                        remaining: fighterBattleMasterMeta.dice,
                      },
                    }
                  : {}),
              },
              ...(fighterArchetype === "Maître de guerre"
                ? { battleMaster: { maneuvers: fighterManeuvers } }
                : {}),
              ...(fighterArchetype === "Chevalier occulte"
                ? {
                    eldritchKnight: {
                      schoolChoices: ["Abjuration", "Évocation"],
                      cantripsKnown: [],
                      spellsKnown: [],
                    },
                  }
                : {}),
            },
            ...(fighterArchetype === "Chevalier occulte" && fighterEldritchKnightMeta?.slotsRow
              ? (() => {
                  const row = fighterEldritchKnightMeta.slotsRow;
                  const spellSlots = {};
                  Object.entries(row).forEach(([sl, n]) => {
                    const num = Number(n);
                    const lvl = Number(sl);
                    if (num > 0) {
                      spellSlots[lvl] = { max: num, remaining: num };
                    }
                  });
                  return { spellSlots };
                })()
              : {}),
          }
        : {}),
      ...(isWizard
        ? {
            wizard: {
              arcaneTradition: wizardTradition || undefined,
              spellbook: Array.isArray(wizardSpellbook) ? wizardSpellbook : [],
              preparedSpells: Array.isArray(wizardPrepared) ? wizardPrepared : [],
              arcaneRecovery: { used: false },
            },
          }
        : {}),
      ...(isCleric
        ? {
            cleric: {
              divineDomain: clericDomain || undefined,
              preparedSpells: Array.isArray(clericPrepared) ? clericPrepared : [],
              domainSpells: Array.isArray(clericDomainSpells) ? clericDomainSpells : [],
              resources: clericChannelDivinityMax
                ? { channelDivinity: { max: clericChannelDivinityMax, remaining: clericChannelDivinityMax } }
                : undefined,
            },
          }
        : {}),
      ...(isRogue
        ? {
            rogue: {
              archetype: rogueArchetype || undefined,
              expertise: {
                skills: Array.isArray(rogueExpertiseSkills) ? rogueExpertiseSkills : [],
                thievesTools: !!rogueExpertiseThievesTools,
              },
              ...(rogueArchetype === "Escroc arcanique"
                ? {
                    arcaneTrickster: {
                      cantripsKnown: Array.isArray(arcaneTricksterCantrips) ? arcaneTricksterCantrips : [],
                      spellsKnown: Array.isArray(arcaneTricksterSpells) ? arcaneTricksterSpells : [],
                      schoolRestriction: ARCANE_TRICKSTER_ALLOWED_SCHOOLS,
                    },
                  }
                : {}),
            },
          }
        : {}),
    };

    onSave?.(character);
  };

  return (
    <div className="w-full max-w-4xl mx-auto rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl shadow-black/40">
      <h2 className="text-2xl font-bold text-slate-50 mb-4">Création de personnage</h2>
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Ligne 1 : Nom */}
        <div>
          <label className="block text-sm font-medium text-slate-200 mb-1">
            Nom du personnage
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            placeholder="Ex : Thorin Pied-de-Pierre"
          />
        </div>

        {/* Personnalité : Idéaux / Liens / Défauts */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
              Idéaux
            </label>
            <textarea
              value={ideals}
              onChange={(e) => setIdeals(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none"
              placeholder="Ce en quoi il croit (justice, liberté, pouvoir…)."
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
              Liens
            </label>
            <textarea
              value={bonds}
              onChange={(e) => setBonds(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none"
              placeholder="Personnes/lieux/idées qu'il protège à tout prix."
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
              Défauts
            </label>
            <textarea
              value={flaws}
              onChange={(e) => setFlaws(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none"
              placeholder="Faiblesses, vices, réactions excessives…"
            />
          </div>
        </div>

        {/* Ligne 2 : Race / Classe / Background / Niveau */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
              Race
            </label>
            <select
              value={race}
              onChange={(e) => setRace(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            >
              <option value="">Choisir une race…</option>
              {Object.keys(RACES).map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
              Classe
            </label>
            <select
              value={className}
              onChange={(e) => setClassName(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            >
              <option value="">Choisir une classe…</option>
              {Object.keys(CLASSES).map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-1">
            <label className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
              Historique
            </label>
            <select
              value={background}
              onChange={(e) => setBackground(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            >
              <option value="">Choisir un historique…</option>
              {Object.keys(BACKGROUNDS).map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
              Niveau
            </label>
            <select
              value={level}
              onChange={(e) => setLevel(Number(e.target.value) || 1)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            >
              {Array.from({ length: 20 }, (_, i) => i + 1).map((lvl) => (
                <option key={lvl} value={lvl}>
                  Niveau {lvl}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Ligne 2b : Alignement & RP court */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
              Alignement
            </label>
            <select
              value={alignment}
              onChange={(e) => setAlignment(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            >
              <option value="">Choisir un alignement…</option>
              <option value="Loyal Bon">Loyal Bon</option>
              <option value="Neutre Bon">Neutre Bon</option>
              <option value="Chaotique Bon">Chaotique Bon</option>
              <option value="Loyal Neutre">Loyal Neutre</option>
              <option value="Neutre">Neutre</option>
              <option value="Chaotique Neutre">Chaotique Neutre</option>
              <option value="Loyal Mauvais">Loyal Mauvais</option>
              <option value="Neutre Mauvais">Neutre Mauvais</option>
              <option value="Chaotique Mauvais">Chaotique Mauvais</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
              Description courte (apparence, attitude…)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none"
              placeholder="Ex : Nain trapu, barbe tressée, regard méfiant mais loyal."
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
              Langues & emplacements
            </label>
            <div className="space-y-1">
              <p className="text-[11px] text-slate-400">
                Langues raciales :{" "}
                {baseLanguages.length ? baseLanguages.join(", ") : "—"}
              </p>
              {totalLanguageSlots > 0 ? (
                <>
                  <p className="text-[11px] text-slate-400">
                    Langues supplémentaires autorisées par race/historique :{" "}
                    <span className="font-semibold text-slate-200">
                      {chosenLanguages.length}/{totalLanguageSlots}
                    </span>
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-1 rounded-md border border-slate-700 bg-slate-950/60 p-2">
                    {availableLanguages.map((lang) => {
                      const checked = chosenLanguages.includes(lang);
                      const disabled =
                        !checked && chosenLanguages.length >= totalLanguageSlots;
                      return (
                        <label
                          key={lang}
                          className={`flex items-center gap-1 text-[11px] ${
                            disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="accent-emerald-500"
                            checked={checked}
                            disabled={disabled}
                            onChange={() => {
                              setChosenLanguages((prev) => {
                                const has = prev.includes(lang);
                                if (has) {
                                  return prev.filter((l) => l !== lang);
                                }
                                if (prev.length >= totalLanguageSlots) return prev;
                                return [...prev, lang];
                              });
                            }}
                          />
                          <span className="text-slate-200">{lang}</span>
                        </label>
                      );
                    })}
                  </div>
                </>
              ) : (
                <p className="text-[11px] text-slate-500">
                  Cette combinaison race/historique ne donne pas de langue
                  supplémentaire au-delà des langues raciales.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Ligne 3 : Stats de base */}
        <div>
          <p className="text-xs uppercase tracking-wider text-slate-400 mb-2">
            Répartition des caractéristiques (utilisez les valeurs : 15, 14, 13, 12, 10, 8)
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
            {ABILITIES.map((ab) => (
              <div key={ab} className="rounded-lg border border-slate-700 bg-slate-950/60 p-2 text-center">
                <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  {ab}
                </div>
                <select
                  value={baseStats[ab]}
                  onChange={(e) => handleStatChange(ab, e.target.value)}
                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100 outline-none focus:border-blue-500"
                >
                  {BASE_SCORES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>

        {/* Résumé en direct */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-4">
            <h3 className="text-sm font-semibold text-slate-200 mb-3">
              Caractéristiques finales
            </h3>
            <div className="space-y-1 text-sm">
              {ABILITIES.map((ab) => (
                <div key={ab} className="flex justify-between text-slate-200">
                  <span className="font-medium">{ab}</span>
                  <span className="tabular-nums">
                    Base {baseStats[ab]}{" "}
                    {raceObj?.statBonuses?.[ab]
                      ? `+ ${raceObj.statBonuses[ab]}`
                      : ""}{" "}
                    = <strong>{finalStats[ab]}</strong> (
                    {modifiers[ab] >= 0 ? `+${modifiers[ab]}` : modifiers[ab]})
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-4 space-y-2 text-sm text-slate-200">
            <h3 className="text-sm font-semibold text-slate-200 mb-1">
              Résumé mécanique & équipement
            </h3>
            <p className="text-xs text-slate-400">
              <span className="font-semibold text-slate-300">Niveau :</span> {level}{" "}
              · <span className="font-semibold text-slate-300">XP :</span>{" "}
              {XP_BY_LEVEL[level] ?? 0}{" "}
              · <span className="font-semibold text-slate-300">Bonus de maîtrise :</span>{" "}
              +{proficiencyBonus}
            </p>
            {isFighter && (
              <p className="text-xs text-slate-400">
                <span className="font-semibold text-slate-300">Jets de sauvegarde maîtrisés :</span>{" "}
                FOR, CON
                {fighterStyle ? (
                  <>
                    {" "}
                    · <span className="font-semibold text-slate-300">Style :</span> {fighterStyle}
                  </>
                ) : (
                  ""
                )}
                {fighterArchetype && level >= 3 ? (
                  <>
                    {" "}
                    · <span className="font-semibold text-slate-300">Archétype :</span> {fighterArchetype}
                  </>
                ) : (
                  ""
                )}
              </p>
            )}
            {asiOpportunitiesForLevel(level) > 0 && (
              <p className="text-[11px] text-slate-500">
                Ce niveau donne droit à{" "}
                <span className="font-semibold text-slate-300">
                  {asiOpportunitiesForLevel(level)} amélioration(s) de caractéristiques
                </span>{" "}
                (à appliquer manuellement sur les scores de base, sans dépasser 20).
              </p>
            )}
            {alignment && (
              <p className="text-xs text-slate-400">
                <span className="font-semibold text-slate-300">Alignement :</span> {alignment}
              </p>
            )}
            {languages.length > 0 && (
              <p className="text-xs text-slate-400">
                <span className="font-semibold text-slate-300">Langues :</span> {languages.join(", ")}
              </p>
            )}
            {className === "Barde" && BARD_SPELL_SLOTS_LOCAL[level] && (
              <p className="text-xs text-slate-400">
                <span className="font-semibold text-slate-300">Emplacements de sorts (Barde) :</span>{" "}
                {Object.entries(BARD_SPELL_SLOTS_LOCAL[level])
                  .map(([sl, n]) => `Niv ${sl}: ${n}`)
                  .join(" · ")}
              </p>
            )}
            {isCleric && clericSpellSlotsRow && (
              <p className="text-xs text-slate-400">
                <span className="font-semibold text-slate-300">Emplacements de sorts (Clerc) :</span>{" "}
                {Object.entries(clericSpellSlotsRow)
                  .map(([sl, n]) => `Niv ${sl}: ${n}`)
                  .join(" · ")}
              </p>
            )}
            {isFighter && fighterArchetype === "Chevalier occulte" && fighterEldritchKnightMeta?.slotsRow && (
              <p className="text-xs text-slate-400">
                <span className="font-semibold text-slate-300">Emplacements de sorts (Chevalier occulte) :</span>{" "}
                {Object.entries(fighterEldritchKnightMeta.slotsRow)
                  .map(([sl, n]) => `Niv ${sl}: ${n}`)
                  .join(" · ")}
              </p>
            )}
            <p>
              <span className="font-semibold">PV Max :</span>{" "}
              {maxHp ? (
                <>
                  {maxHp}{" "}
                  <span className="text-slate-400">
                    ({classObj?.hitDice} + mod CON {modifiers.CON >= 0 ? `+${modifiers.CON}` : modifiers.CON})
                  </span>
                </>
              ) : (
                <span className="text-slate-500">Choisissez une classe pour calculer.</span>
              )}
            </p>
            <p>
              <span className="font-semibold">CA :</span>{" "}
              <span className="tabular-nums">{armorClass}</span>
              <span className="text-slate-500">
                {startingEquipment?.armor ? ` · ${startingEquipment.armor}` : ""}
                {startingEquipment?.shield && startingEquipment.shield !== "Aucun" ? ` + ${startingEquipment.shield}` : ""}
              </span>
            </p>
            {raceObj && (
              <p className="text-xs text-slate-400">
                Vitesse raciale : {raceObj.speed} ft · Taille : {raceObj.size}
              </p>
            )}

            <div className="pt-2">
              <p className="text-xs uppercase tracking-wider text-slate-400 mb-1">
                Attaques (preview)
              </p>
              {attacks.length ? (
                <ul className="space-y-1 text-sm text-slate-200">
                  {attacks.map((a, idx) => {
                    const toHitStr = a.toHit >= 0 ? `+${a.toHit}` : `${a.toHit}`;
                    const dmgBonusStr = a.damageBonus === 0 ? "" : a.damageBonus > 0 ? `+${a.damageBonus}` : `${a.damageBonus}`;
                    return (
                      <li key={`${a.name}-${idx}`} className="flex justify-between gap-3">
                        <span className="font-medium text-slate-100">{a.name}</span>
                        <span className="tabular-nums text-slate-300">
                          {toHitStr} · {a.damageDice}{dmgBonusStr} {a.damageType}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-xs text-slate-500 italic">Choisissez une classe pour voir l’équipement de départ.</p>
              )}
            </div>

            <div className="pt-2">
              <p className="text-xs uppercase tracking-wider text-slate-400 mb-1">
                Inventaire (preview)
              </p>
              {inventory.length ? (
                <p className="text-xs text-slate-300 leading-relaxed">
                  {inventory.join(", ")}
                </p>
              ) : (
                <p className="text-xs text-slate-500 italic">Sélectionnez une classe.</p>
              )}
            </div>

            {!isWizard && selectedSpells?.length > 0 && (
              <div className="pt-2">
                <p className="text-xs uppercase tracking-wider text-slate-400 mb-1">
                  Sorts connus (preview)
                </p>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {selectedSpells.map((s) => s.name).join(", ")}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Options Guerrier */}
        {isFighter && (
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 space-y-4">
            <div className="flex items-end justify-between gap-4">
              <h3 className="text-sm font-semibold text-slate-200">Options de Guerrier (SRD)</h3>
              <p className="text-xs text-slate-500">
                Niveau {level} · ASI :{" "}
                <span className="text-slate-200 font-semibold">
                  {fighterAsiPointsUsed}/{fighterAsiPointsAllowed}
                </span>
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
                  Style de combat (niv 1)
                </label>
                <select
                  value={fighterStyle}
                  onChange={(e) => setFighterStyle(e.target.value)}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Choisir…</option>
                  {(FIGHTING_STYLES_FIGHTER ?? []).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-slate-500">
                  Les effets gameplay implémentés dans le prototype (niv 1) : Défense (+1 CA avec armure), Archerie (+2 attaque à distance).
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
                  Archétype martial (niv 3)
                </label>
                <select
                  value={fighterArchetype}
                  onChange={(e) => setFighterArchetype(e.target.value)}
                  disabled={level < 3}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-40"
                >
                  <option value="">Choisir…</option>
                  {(FIGHTER_ARCHETYPES_SRD ?? []).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-slate-500">
                  Ces choix sont sauvegardés sur la fiche même si la partie ne monte pas au-delà du niveau 1.
                </p>
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">
                Améliorations de caractéristiques (ASI)
              </p>
              <p className="text-[11px] text-slate-500 mb-2">
                Paliers Guerrier : {(FIGHTER_ASI_LEVELS ?? []).join(", ") || "—"}. Chaque ASI = +2 ou +1/+1 (max 20).
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
                {ABILITIES.map((ab) => (
                  <div key={`asi-${ab}`} className="rounded-lg border border-slate-800 bg-slate-950/40 p-2">
                    <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                      {ab}
                    </div>
                    <select
                      value={fighterAsiBonuses[ab]}
                      onChange={(e) => setAsiBonus(ab, e.target.value)}
                      disabled={fighterAsiPointsAllowed === 0}
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100 outline-none focus:border-blue-500 disabled:opacity-40"
                    >
                      <option value={0}>+0</option>
                      <option value={1}>+1</option>
                      <option value={2}>+2</option>
                    </select>
                  </div>
                ))}
              </div>
            </div>

            {fighterArchetype === "Maître de guerre" && fighterBattleMasterMeta && (
              <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                <div className="flex items-end justify-between gap-4 mb-2">
                  <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    Maître de guerre — Manœuvres
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Dés: {fighterBattleMasterMeta.dice} × {fighterBattleMasterMeta.die} · Choisissez{" "}
                    <span className="text-slate-200 font-semibold">
                      {fighterManeuvers.length}/{fighterBattleMasterMeta.maneuversKnown}
                    </span>
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-48 overflow-y-auto">
                  {(BATTLEMASTER_MANEUVERS_SRD ?? []).map((m) => {
                    const checked = fighterManeuvers.includes(m);
                    const disabled = !checked && fighterManeuvers.length >= fighterBattleMasterMeta.maneuversKnown;
                    return (
                      <label
                        key={m}
                        className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${
                          checked
                            ? "border-amber-600/60 bg-amber-950/25 text-amber-100"
                            : "border-slate-800 bg-slate-950/40 text-slate-200"
                        } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:border-slate-600"}`}
                      >
                        <input
                          type="checkbox"
                          className="accent-amber-500"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleManeuver(m)}
                        />
                        <span>{m}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {fighterClassFeatures.length > 0 && (
              <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                  Capacités Guerrier (liste par niveau)
                </p>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {fighterClassFeatures.join(" · ")}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Options Magicien */}
        {isWizard && (
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 space-y-4">
            <div className="flex items-end justify-between gap-4">
              <h3 className="text-sm font-semibold text-slate-200">Options de Magicien (SRD)</h3>
              <p className="text-xs text-slate-500">
                Niveau {level} · ASI :{" "}
                <span className="text-slate-200 font-semibold">
                  {wizardAsiPointsUsed}/{wizardAsiPointsAllowed}
                </span>
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
                  Tradition arcanique (niv 2)
                </label>
                <select
                  value={wizardTradition}
                  onChange={(e) => setWizardTradition(e.target.value)}
                  disabled={level < 2}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-40"
                >
                  <option value="">Choisir…</option>
                  {(ARCANE_TRADITIONS_SRD ?? []).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-slate-500">
                  En aventure, le moteur bloque les sorts non préparés (règle Magicien stricte).
                </p>
              </div>

              <div>
                <p className="text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
                  Emplacements (niveau {level})
                </p>
                {wizardSpellSlotsRow ? (
                  <p className="text-xs text-slate-300">
                    {Object.entries(wizardSpellSlotsRow)
                      .map(([sl, n]) => `Niv ${sl}: ${n}`)
                      .join(" · ")}
                  </p>
                ) : (
                  <p className="text-xs text-slate-500 italic">—</p>
                )}
                <p className="mt-1 text-[11px] text-slate-500">
                  DD sorts = 8 + PB + mod INT. Attaque de sort = PB + mod INT.
                </p>
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">
                Améliorations de caractéristiques (ASI)
              </p>
              <p className="text-[11px] text-slate-500 mb-2">
                Paliers Magicien : {(WIZARD_ASI_LEVELS ?? []).join(", ") || "—"}.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
                {ABILITIES.map((ab) => (
                  <div key={`wiz-asi-${ab}`} className="rounded-lg border border-slate-800 bg-slate-950/40 p-2">
                    <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                      {ab}
                    </div>
                    <select
                      value={wizardAsiBonuses[ab]}
                      onChange={(e) => setWizardAsiBonus(ab, e.target.value)}
                      disabled={wizardAsiPointsAllowed === 0}
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100 outline-none focus:border-blue-500 disabled:opacity-40"
                    >
                      <option value={0}>+0</option>
                      <option value={1}>+1</option>
                      <option value={2}>+2</option>
                    </select>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                <div className="flex items-end justify-between gap-4 mb-2">
                  <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    Sorts mineurs connus
                  </p>
                  <p className="text-[11px] text-slate-500">
                    <span className="text-slate-200 font-semibold">
                      {wizardPrepared.filter((n) => (SPELLS?.[n]?.level ?? 0) === 0).length}
                    </span>
                    /{wizardCantripLimit}
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto">
                  {(wizardAvailableWizardSpells.cantrips ?? []).map((s) => {
                    const checked = wizardPrepared.includes(s.name);
                    const disabled =
                      !checked &&
                      wizardPrepared.filter((n) => (SPELLS?.[n]?.level ?? 0) === 0).length >= wizardCantripLimit;
                    return (
                      <label
                        key={`wiz-cantrip-${s.name}`}
                        className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${
                          checked
                            ? "border-indigo-600/60 bg-indigo-950/30 text-indigo-100"
                            : "border-slate-800 bg-slate-950/40 text-slate-200"
                        } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:border-slate-600"}`}
                      >
                        <input
                          type="checkbox"
                          className="accent-indigo-500"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleWizardCantripPrepared(s.name)}
                        />
                        <span>{s.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                <div className="flex items-end justify-between gap-4 mb-2">
                  <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    Grimoire (niveau 1+)
                  </p>
                  <p className="text-[11px] text-slate-500">
                    <span className="text-slate-200 font-semibold">{wizardSpellbook.length}</span> /{" "}
                    {wizardSpellbookExpected} attendu
                  </p>
                </div>
                <p className="text-[11px] text-slate-500 mb-2">
                  Au niveau 1 : choisissez 6 sorts de niveau 1 (SRD). Puis +2 par niveau (recherche/XP, sans économie).
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto">
                  {(wizardAvailableWizardSpells.leveled ?? []).map((s) => {
                    const checked = wizardSpellbook.includes(s.name);
                    return (
                      <label
                        key={`wiz-book-${s.name}`}
                        className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
                          checked
                            ? "border-emerald-600/60 bg-emerald-950/25 text-emerald-100"
                            : "border-slate-800 bg-slate-950/40 text-slate-200"
                        } cursor-pointer hover:border-slate-600`}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-emerald-500"
                          checked={checked}
                          onChange={() => toggleWizardSpellbook(s.name)}
                        />
                        <div className="flex-1 flex items-center justify-between gap-2">
                          <span>{s.name}</span>
                          <span className="text-[10px] text-slate-400">Niv {s.level}</span>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
              <div className="flex items-end justify-between gap-4 mb-2">
                <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  Sorts préparés (lancables)
                </p>
                <p className="text-[11px] text-slate-500">
                  <span className="text-slate-200 font-semibold">
                    {wizardPrepared.filter((n) => (SPELLS?.[n]?.level ?? 0) >= 1).length}
                  </span>
                  /{wizardPreparedLimit} (INT + niveau)
                </p>
              </div>
              <p className="text-[11px] text-slate-500 mb-2">
                Choisissez uniquement parmi les sorts présents dans le grimoire (et de niveau accessible).
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-56 overflow-y-auto">
                {wizardSpellbook.map((name) => {
                  const lvl = Number(SPELLS?.[name]?.level ?? 1);
                  if (lvl < 1 || lvl > wizardMaxSpellLevel) return null;
                  const checked = wizardPrepared.includes(name);
                  const preparedCount = wizardPrepared.filter((n) => (SPELLS?.[n]?.level ?? 0) >= 1).length;
                  const disabled = !checked && preparedCount >= wizardPreparedLimit;
                  return (
                    <label
                      key={`wiz-prep-${name}`}
                      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${
                        checked
                          ? "border-blue-600/60 bg-blue-950/30 text-blue-100"
                          : "border-slate-800 bg-slate-950/40 text-slate-200"
                      } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:border-slate-600"}`}
                    >
                      <input
                        type="checkbox"
                        className="accent-blue-500"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleWizardPrepared(name)}
                      />
                      <span className="flex-1">{name}</span>
                      <span className="text-[10px] text-slate-400">Niv {lvl}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
              <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                Capacités Magicien (liste par niveau)
              </p>
              <p className="text-xs text-slate-300 leading-relaxed">
                {Array.from({ length: level }, (_, i) => i + 1)
                  .flatMap((lvl) => (WIZARD_FEATURES_BY_LEVEL?.[lvl] ?? []))
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </p>
            </div>
          </div>
        )}

        {/* Options Clerc */}
        {isCleric && (
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 space-y-4">
            <div className="flex items-end justify-between gap-4">
              <h3 className="text-sm font-semibold text-slate-200">Options de Clerc (SRD)</h3>
              <p className="text-xs text-slate-500">
                Niveau {level} · ASI :{" "}
                <span className="text-slate-200 font-semibold">
                  {clericAsiPointsUsed}/{clericAsiPointsAllowed}
                </span>
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
                  Domaine divin (niv 1)
                </label>
                <select
                  value={clericDomain}
                  onChange={(e) => setClericDomain(e.target.value)}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Choisir…</option>
                  {(CLERIC_DOMAINS_SRD ?? []).map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-slate-500">
                  Sorts préparés = mod SAG + niveau (min 1). Les sorts de domaine sont <span className="text-slate-300 font-semibold">toujours préparés</span>.
                </p>
              </div>

              <div>
                <p className="text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
                  Conduit divin & emplacements
                </p>
                {clericSpellSlotsRow ? (
                  <p className="text-xs text-slate-300">
                    {Object.entries(clericSpellSlotsRow)
                      .map(([sl, n]) => `Niv ${sl}: ${n}`)
                      .join(" · ")}
                  </p>
                ) : (
                  <p className="text-xs text-slate-500 italic">—</p>
                )}
                <p className="mt-1 text-[11px] text-slate-500">
                  Conduit divin : {clericChannelDivinityMax ? `${clericChannelDivinityMax}/repos (à partir du niv 2)` : "— (débloqué au niv 2)"}.
                </p>
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">
                Améliorations de caractéristiques (ASI)
              </p>
              <p className="text-[11px] text-slate-500 mb-2">
                Paliers Clerc : {(CLERIC_ASI_LEVELS ?? []).join(", ") || "—"}.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
                {ABILITIES.map((ab) => (
                  <div key={`clr-asi-${ab}`} className="rounded-lg border border-slate-800 bg-slate-950/40 p-2">
                    <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                      {ab}
                    </div>
                    <select
                      value={clericAsiBonuses[ab]}
                      onChange={(e) => setClericAsiBonus(ab, e.target.value)}
                      disabled={clericAsiPointsAllowed === 0}
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100 outline-none focus:border-blue-500 disabled:opacity-40"
                    >
                      <option value={0}>+0</option>
                      <option value={1}>+1</option>
                      <option value={2}>+2</option>
                    </select>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                <div className="flex items-end justify-between gap-4 mb-2">
                  <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    Sorts mineurs connus
                  </p>
                  <p className="text-[11px] text-slate-500">
                    <span className="text-slate-200 font-semibold">{clericCantrips.length}</span>/{clericCantripLimit}
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto">
                  {(clericAvailableSpells.cantrips ?? []).map((s) => {
                    const checked = clericCantrips.includes(s.name);
                    const disabled = !checked && clericCantrips.length >= clericCantripLimit;
                    return (
                      <label
                        key={`clr-cantrip-${s.name}`}
                        className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${
                          checked
                            ? "border-indigo-600/60 bg-indigo-950/30 text-indigo-100"
                            : "border-slate-800 bg-slate-950/40 text-slate-200"
                        } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:border-slate-600"}`}
                      >
                        <input
                          type="checkbox"
                          className="accent-indigo-500"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleClericCantrip(s.name)}
                        />
                        <span>{s.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 lg:col-span-2">
                <div className="flex items-end justify-between gap-4 mb-2">
                  <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    Sorts préparés (lancables)
                  </p>
                  <p className="text-[11px] text-slate-500">
                    <span className="text-slate-200 font-semibold">{clericPrepared.length}</span>/{clericPreparedLimit} (SAG + niveau)
                  </p>
                </div>
                <p className="text-[11px] text-slate-500 mb-2">
                  Les sorts de domaine (à droite) sont toujours préparés et ne comptent pas dans ce quota.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-56 overflow-y-auto">
                  {(clericAvailableSpells.leveled ?? []).map((s) => {
                    const checked = clericPrepared.includes(s.name);
                    const disabled = !checked && clericPrepared.length >= clericPreparedLimit;
                    return (
                      <label
                        key={`clr-prep-${s.name}`}
                        className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
                          checked
                            ? "border-blue-600/60 bg-blue-950/30 text-blue-100"
                            : "border-slate-800 bg-slate-950/40 text-slate-200"
                        } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:border-slate-600"}`}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-blue-500"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleClericPrepared(s.name)}
                        />
                        <div className="flex-1 flex items-center justify-between gap-2">
                          <span>{s.name}</span>
                          <span className="text-[10px] text-slate-400">Niv {s.level}</span>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                  Sorts de domaine (toujours préparés)
                </p>
                {clericDomain ? (
                  <p className="text-xs text-slate-300 leading-relaxed">
                    {(clericDomainSpells ?? []).length ? clericDomainSpells.join(" · ") : "—"}
                  </p>
                ) : (
                  <p className="text-xs text-slate-500 italic">Choisissez un domaine pour voir les sorts.</p>
                )}
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                  Capacités Clerc (liste par niveau)
                </p>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {Array.from({ length: level }, (_, i) => i + 1)
                    .flatMap((lvl) => (CLERIC_FEATURES_BY_LEVEL?.[lvl] ?? []))
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </p>
                {clericDomain && (
                  <p className="text-[11px] text-slate-500 mt-2">
                    Domaine {clericDomain} :{" "}
                    {Array.from({ length: level }, (_, i) => i + 1)
                      .flatMap((lvl) => (CLERIC_DOMAIN_FEATURES_BY_LEVEL?.[clericDomain]?.[lvl] ?? []))
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Options Roublard */}
        {isRogue && (
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 space-y-4">
            <div className="flex items-end justify-between gap-4">
              <h3 className="text-sm font-semibold text-slate-200">Options de Roublard (SRD)</h3>
              <p className="text-xs text-slate-500">
                Niveau {level} · ASI :{" "}
                <span className="text-slate-200 font-semibold">
                  {rogueAsiPointsUsed}/{rogueAsiPointsAllowed}
                </span>
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
                  Archétype (niv 3)
                </label>
                <select
                  value={rogueArchetype}
                  onChange={(e) => setRogueArchetype(e.target.value)}
                  disabled={level < 3}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-40"
                >
                  <option value="">Choisir…</option>
                  {(ROGUE_ARCHETYPES_SRD ?? []).map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-slate-500">
                  Attaque sournoise (niveau {level}) :{" "}
                  <span className="font-semibold text-slate-200">{rogueSneakDice ?? "—"}</span>{" "}
                  (1/ tour).
                </p>
              </div>

              <div>
                <p className="text-xs font-semibold text-slate-300 mb-1 uppercase tracking-wider">
                  Expertise
                </p>
                <p className="text-[11px] text-slate-500">
                  Choix :{" "}
                  <span className="text-slate-200 font-semibold">
                    {rogueExpertiseUsedCount}/{rogueExpertiseAllowedCount}
                  </span>{" "}
                  (niv 1: 2, niv 6: +2). Inclut option “Outils de voleur”.
                </p>
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                  {rogueExpertiseOptions.map((s) => {
                    const checked = rogueExpertiseSkills.includes(s);
                    const disabled = !checked && rogueExpertiseUsedCount >= rogueExpertiseAllowedCount;
                    return (
                      <label
                        key={`rog-exp-${s}`}
                        className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${
                          checked
                            ? "border-emerald-600/60 bg-emerald-950/25 text-emerald-100"
                            : "border-slate-800 bg-slate-950/40 text-slate-200"
                        } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:border-slate-600"}`}
                      >
                        <input
                          type="checkbox"
                          className="accent-emerald-500"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleRogueExpertiseSkill(s)}
                        />
                        <span>{s}</span>
                      </label>
                    );
                  })}
                  <label
                    className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${
                      rogueExpertiseThievesTools
                        ? "border-emerald-600/60 bg-emerald-950/25 text-emerald-100"
                        : "border-slate-800 bg-slate-950/40 text-slate-200"
                    } ${
                      !rogueExpertiseThievesTools &&
                      rogueExpertiseUsedCount >= rogueExpertiseAllowedCount
                        ? "opacity-40 cursor-not-allowed"
                        : "cursor-pointer hover:border-slate-600"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="accent-emerald-500"
                      checked={rogueExpertiseThievesTools}
                      disabled={!rogueExpertiseThievesTools && rogueExpertiseUsedCount >= rogueExpertiseAllowedCount}
                      onChange={toggleRogueExpertiseThievesTools}
                    />
                    <span>Outils de voleur</span>
                  </label>
                </div>
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold text-slate-300 mb-2 uppercase tracking-wider">
                Améliorations de caractéristiques (ASI)
              </p>
              <p className="text-[11px] text-slate-500 mb-2">
                Paliers Roublard : {(ROGUE_ASI_LEVELS ?? []).join(", ") || "—"}.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
                {ABILITIES.map((ab) => (
                  <div key={`rog-asi-${ab}`} className="rounded-lg border border-slate-800 bg-slate-950/40 p-2">
                    <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                      {ab}
                    </div>
                    <select
                      value={rogueAsiBonuses[ab]}
                      onChange={(e) => setRogueAsiBonus(ab, e.target.value)}
                      disabled={rogueAsiPointsAllowed === 0}
                      className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100 outline-none focus:border-blue-500 disabled:opacity-40"
                    >
                      <option value={0}>+0</option>
                      <option value={1}>+1</option>
                      <option value={2}>+2</option>
                    </select>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
              <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                Capacités Roublard (liste par niveau)
              </p>
              <p className="text-xs text-slate-300 leading-relaxed">
                {Array.from({ length: level }, (_, i) => i + 1)
                  .flatMap((lvl) => (ROGUE_FEATURES_BY_LEVEL?.[lvl] ?? []))
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </p>
              {rogueArchetype && level >= 3 && (
                <p className="text-[11px] text-slate-500 mt-2">
                  Archétype {rogueArchetype} :{" "}
                  {Array.from({ length: level }, (_, i) => i + 1)
                    .flatMap((lvl) => (ROGUE_ARCHETYPE_FEATURES_BY_LEVEL?.[rogueArchetype]?.[lvl] ?? []))
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </p>
              )}
            </div>

            {/* Escroc arcanique */}
            {isArcaneTrickster && (
              <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 space-y-3">
                <div className="flex items-end justify-between gap-4">
                  <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    Escroc arcanique — Incantation
                  </p>
                  {arcaneTricksterSlotsRow ? (
                    <p className="text-[11px] text-slate-500">
                      Slots:{" "}
                      {Object.entries(arcaneTricksterSlotsRow).map(([sl, n]) => `Niv ${sl}: ${n}`).join(" · ")}
                    </p>
                  ) : (
                    <p className="text-[11px] text-slate-500">Slots: —</p>
                  )}
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3">
                    <div className="flex items-end justify-between gap-4 mb-2">
                      <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Tours de magie</p>
                      <p className="text-[11px] text-slate-500">
                        <span className="text-slate-200 font-semibold">{arcaneTricksterCantrips.length}</span>/
                        {arcaneTricksterMeta?.cantrips ?? 0}
                      </p>
                    </div>
                    <p className="text-[11px] text-slate-500 mb-2">
                      <span className="text-slate-200 font-semibold">Main de mage</span> est requise.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto">
                      {(arcaneTricksterAllowedWizardSpells.cantrips ?? []).map((s) => {
                        const checked = arcaneTricksterCantrips.includes(s.name);
                        const disabled = !checked && arcaneTricksterCantrips.length >= (arcaneTricksterMeta?.cantrips ?? 0);
                        const isMageHand = normalizeFrLocal(s.name) === normalizeFrLocal("Main de mage");
                        return (
                          <label
                            key={`at-cantrip-${s.name}`}
                            className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${
                              checked
                                ? "border-indigo-600/60 bg-indigo-950/30 text-indigo-100"
                                : "border-slate-800 bg-slate-950/40 text-slate-200"
                            } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:border-slate-600"}`}
                          >
                            <input
                              type="checkbox"
                              className="accent-indigo-500"
                              checked={checked}
                              disabled={disabled || (checked && isMageHand)}
                              onChange={() => toggleArcaneTricksterCantrip(s.name)}
                            />
                            <span className={isMageHand ? "font-semibold" : ""}>{s.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-3">
                    <div className="flex items-end justify-between gap-4 mb-2">
                      <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Sorts connus (niv 1+)</p>
                      <p className="text-[11px] text-slate-500">
                        <span className="text-slate-200 font-semibold">{arcaneTricksterSpells.length}</span>/
                        {arcaneTricksterMeta?.spells ?? 0}
                      </p>
                    </div>
                    <p className="text-[11px] text-slate-500 mb-2">
                      Écoles autorisées : {ARCANE_TRICKSTER_ALLOWED_SCHOOLS.join(", ")}. Exceptions niveaux {ARCANE_TRICKSTER_ANY_SCHOOL_SPELL_LEVELS.join(", ")}.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto">
                      {(arcaneTricksterAllowedWizardSpells.leveled ?? []).map((s) => {
                        const checked = arcaneTricksterSpells.includes(s.name);
                        const disabled = !checked && arcaneTricksterSpells.length >= (arcaneTricksterMeta?.spells ?? 0);
                        return (
                          <label
                            key={`at-spell-${s.name}`}
                            className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
                              checked
                                ? "border-blue-600/60 bg-blue-950/30 text-blue-100"
                                : "border-slate-800 bg-slate-950/40 text-slate-200"
                            } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:border-slate-600"}`}
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5 accent-blue-500"
                              checked={checked}
                              disabled={disabled}
                              onChange={() => toggleArcaneTricksterSpell(s.name)}
                            />
                            <div className="flex-1 flex items-center justify-between gap-2">
                              <span>{s.name}</span>
                              <span className="text-[10px] text-slate-400">Niv {s.level}</span>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Choix de compétences */}
        {availableSkillChoices && (
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-end justify-between gap-4 mb-3">
              <h3 className="text-sm font-semibold text-slate-200">
                Compétences (choisissez {availableSkillChoices.count})
              </h3>
              <p className="text-xs text-slate-500">
                Sélection : <span className="text-slate-200 font-semibold">{selectedSkills.length}</span>/{availableSkillChoices.count}
              </p>
            </div>

            {bgSkills.length > 0 && (
              <p className="text-xs text-slate-400 mb-3">
                Historique ({background || "—"}) : compétences fixes —{" "}
                <span className="text-slate-200">{bgSkills.join(", ")}</span>
              </p>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
              {availableSkillChoices.options.map((skill) => {
                const checked = selectedSkills.includes(skill);
                const disabled = !checked && selectedSkills.length >= availableSkillChoices.count;
                const abilityKey = SKILLS_DB?.[skill];
                const abilityMod = abilityKey ? modifiers[abilityKey] ?? 0 : 0;
                const isProficient = finalSkillProficiencies.includes(skill);
                const totalBonus = abilityMod + (isProficient ? proficiencyBonus : 0);
                const bonusStr = totalBonus >= 0 ? `+${totalBonus}` : `${totalBonus}`;
                return (
                  <label
                    key={skill}
                    className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                      checked
                        ? "border-emerald-600/60 bg-emerald-950/30 text-emerald-100"
                        : "border-slate-800 bg-slate-950/40 text-slate-200"
                    } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:border-slate-600"}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggleSkill(skill)}
                      className="accent-emerald-500"
                    />
                    <div className="flex-1 flex items-center justify-between gap-2">
                      <span>{skill}</span>
                      <span className="text-[11px] tabular-nums text-slate-300 flex items-center gap-1">
                        {isProficient && (
                          <span className="text-amber-400" aria-label="Compétence maîtrisée">
                            ★
                          </span>
                        )}
                        <span>{bonusStr}</span>
                      </span>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {/* Magie (section générique) — masquée pour Magicien/Clerc (UI dédiée) */}
        {casterSpells && !isWizard && !isCleric && !isRogue && (
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-end justify-between gap-4 mb-3">
              <h3 className="text-sm font-semibold text-slate-200">
                Magie
              </h3>
              {className === "Barde" ? (
                (() => {
                  const prog = BARD_SPELL_PROGRESS_LOCAL[level] || BARD_SPELL_PROGRESS_LOCAL[1];
                  const cantripsKnown = selectedSpells.filter((s) => s.level === 0).length;
                  const leveledKnown = selectedSpells.filter((s) => s.level >= 1).length;
                  return (
                <p className="text-xs text-slate-500">
                  Niv {level} Barde —{" "}
                  <span className="text-slate-200 font-semibold">
                    {cantripsKnown}
                  </span>
                  /{prog.cantrips} sorts mineurs ·{" "}
                  <span className="text-slate-200 font-semibold">
                    {leveledKnown}
                  </span>
                  /{prog.spells} sorts de niveau {prog.maxSpellLevel} ou moins
                </p>
                  );
                })()
              ) : (
                <p className="text-xs text-slate-500">
                  Sélection :{" "}
                  <span className="text-slate-200 font-semibold">
                    {selectedSpells.length}
                  </span>
                  /8
                </p>
              )}
            </div>
            <p className="text-xs text-slate-400 mb-3">
              Sorts affichés : uniquement <span className="text-slate-200">niveau 0</span> et <span className="text-slate-200">niveau 1</span>.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {casterSpells.map((s) => {
                const checked = selectedSpells.some((sp) => sp.name === s.name);
                const disabled =
                  !checked &&
                  className !== "Barde" &&
                  selectedSpells.length >= 8;
                const line =
                  s.damage
                    ? `${s.damage}${s.damageType ? ` ${s.damageType}` : ""}`
                    : s.effect
                    ? s.effect
                    : "—";
                return (
                  <label
                    key={s.name}
                    className={`flex items-start gap-2 rounded-md border px-3 py-2 ${
                      checked
                        ? "border-indigo-600/60 bg-indigo-950/30"
                        : "border-slate-800 bg-slate-950/40"
                    } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:border-slate-600"}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggleSpell(s.name)}
                      className="mt-1 accent-indigo-500"
                    />
                    <div className="flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-200">{s.name}</span>
                        <span className="text-[11px] rounded-full border border-slate-700 px-2 py-0.5 text-slate-300">
                          Niv {s.level}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">{line}</p>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={
              !name.trim() ||
              !raceObj ||
              !classObj ||
              !bgObj ||
              !maxHp ||
              !alignment ||
              !description.trim() ||
              !ideals.trim() ||
              !bonds.trim() ||
              !flaws.trim()
            }
            className="rounded-md bg-emerald-600 px-6 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Sauvegarder le personnage
          </button>
        </div>
      </form>
    </div>
  );
}
