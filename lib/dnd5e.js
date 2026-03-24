/**
 * Base de données D&D 5e (SRD)
 * Armes, propriétés, types de dégâts — source de vérité pour le moteur de jeu.
 */

// ---------------------------------------------------------------------------
// Types de dégâts
// ---------------------------------------------------------------------------
export const DAMAGE_TYPES = [
  "tranchant", "perforant", "contondant",
  "feu", "froid", "foudre", "acide", "poison", "nécrotique",
  "radiant", "force", "psychique", "tonnerre",
];

// ---------------------------------------------------------------------------
// Propriétés d'armes
// ---------------------------------------------------------------------------
export const WEAPON_PROPERTIES = {
  finesse:    "Utilise FOR ou DEX (au choix) pour attaque et dégâts",
  leger:      "Peut être utilisée pour l'attaque en main secondaire",
  lourd:      "Les petites créatures ont désavantage",
  portee:     "Allonge de 3m supplémentaires",
  chargement: "Une seule attaque par action",
  lancer:     "Peut être lancée comme arme de jet",
  a_deux_mains: "Requiert deux mains",
  polyvalent: "Peut être utilisée à une ou deux mains (dé différent)",
  munitions:  "Requiert des munitions",
};

// ---------------------------------------------------------------------------
// Armes simples de mêlée
// ---------------------------------------------------------------------------
export const SIMPLE_MELEE = [
  { id: "massue",          name: "Massue",          damageDice: "1d4",  damageType: "contondant", properties: ["leger"],                  cost: "1 pc",   weight: 2  },
  { id: "dague",           name: "Dague",            damageDice: "1d4",  damageType: "perforant",  properties: ["finesse","leger","lancer"], cost: "2 po",   weight: 0.5 },
  { id: "hachette",        name: "Hachette",         damageDice: "1d6",  damageType: "tranchant",  properties: ["leger","lancer"],          cost: "5 po",   weight: 1  },
  { id: "marteau_leger",   name: "Marteau léger",    damageDice: "1d4",  damageType: "contondant", properties: ["leger","lancer"],          cost: "2 po",   weight: 1  },
  { id: "masse_darmes",    name: "Masse d'armes",    damageDice: "1d6",  damageType: "contondant", properties: [],                         cost: "5 po",   weight: 2  },
  { id: "batonsec",        name: "Bâton",            damageDice: "1d6",  damageType: "contondant", properties: ["polyvalent"],  versatile: "1d8", cost: "2 pc", weight: 2 },
  { id: "faucille",        name: "Faucille",         damageDice: "1d4",  damageType: "tranchant",  properties: ["leger"],                  cost: "1 po",   weight: 1  },
  { id: "lance",           name: "Lance",            damageDice: "1d6",  damageType: "perforant",  properties: ["lancer","polyvalent"], versatile: "1d8", cost: "1 po", weight: 1.5 },
  { id: "javeline",        name: "Javeline",         damageDice: "1d6",  damageType: "perforant",  properties: ["lancer"],                 cost: "5 pc",   weight: 1  },
  { id: "gourdin",         name: "Gourdin",          damageDice: "1d4",  damageType: "contondant", properties: ["leger"],                  cost: "1 pc",   weight: 1  },
];

// ---------------------------------------------------------------------------
// Armes simples à distance
// ---------------------------------------------------------------------------
export const SIMPLE_RANGED = [
  { id: "arbalete_legere", name: "Arbalète légère",  damageDice: "1d8",  damageType: "perforant",  properties: ["munitions","chargement","a_deux_mains"], range: "24/96m",  cost: "25 po",  weight: 2.5 },
  { id: "arc_court",       name: "Arc court",        damageDice: "1d6",  damageType: "perforant",  properties: ["munitions","a_deux_mains"],               range: "24/96m",  cost: "25 po",  weight: 1   },
  { id: "dard",            name: "Dard",             damageDice: "1d4",  damageType: "perforant",  properties: ["finesse","lancer"],                       range: "6/18m",   cost: "5 pc",   weight: 0.1 },
  { id: "fronde",          name: "Fronde",           damageDice: "1d4",  damageType: "contondant", properties: ["munitions"],                              range: "9/36m",   cost: "1 pc",   weight: 0   },
];

// ---------------------------------------------------------------------------
// Armes de guerre de mêlée
// ---------------------------------------------------------------------------
export const MARTIAL_MELEE = [
  { id: "hache_de_guerre", name: "Hache de guerre",  damageDice: "1d8",  damageType: "tranchant",  properties: ["polyvalent"], versatile: "1d10",    cost: "10 po",  weight: 2   },
  { id: "fléau",           name: "Fléau",            damageDice: "1d8",  damageType: "contondant", properties: [],                                      cost: "10 po",  weight: 1   },
  { id: "épée_longue",     name: "Épée longue",      damageDice: "1d8",  damageType: "tranchant",  properties: ["polyvalent"], versatile: "1d10",    cost: "15 po",  weight: 1.5 },
  { id: "cimeterre",       name: "Cimeterre",        damageDice: "1d6",  damageType: "tranchant",  properties: ["finesse","leger"],                      cost: "25 po",  weight: 1   },
  { id: "épée_courte",     name: "Épée courte",      damageDice: "1d6",  damageType: "perforant",  properties: ["finesse","leger"],                      cost: "10 po",  weight: 0.5 },
  { id: "rapière",         name: "Rapière",          damageDice: "1d8",  damageType: "perforant",  properties: ["finesse"],                              cost: "25 po",  weight: 1   },
  { id: "hache_darmes",    name: "Hache d'armes",    damageDice: "1d6",  damageType: "tranchant",  properties: ["leger","lancer"],                       cost: "5 po",   weight: 1   },
  { id: "épée_à_deux_mains", name: "Épée à deux mains", damageDice: "2d6", damageType: "tranchant", properties: ["lourd","a_deux_mains"],                cost: "50 po",  weight: 3   },
  { id: "hache_à_deux_mains", name: "Hache à deux mains", damageDice: "1d12", damageType: "tranchant", properties: ["lourd","a_deux_mains"],             cost: "30 po",  weight: 3.5 },
  { id: "marteau_de_guerre", name: "Marteau de guerre", damageDice: "1d8", damageType: "contondant", properties: ["polyvalent"], versatile: "1d10",     cost: "15 po",  weight: 2   },
  { id: "pic_de_guerre",   name: "Pic de guerre",    damageDice: "1d8",  damageType: "perforant",  properties: [],                                      cost: "5 po",   weight: 1   },
  { id: "masse_dêtoile",   name: "Masse d'étoile",   damageDice: "1d8",  damageType: "perforant",  properties: [],                                      cost: "15 po",  weight: 2   },
  { id: "faux",            name: "Faux de guerre",   damageDice: "1d10", damageType: "tranchant",  properties: ["lourd","portee","a_deux_mains"],         cost: "20 po",  weight: 3   },
  { id: "lance_de_guerre", name: "Lance de guerre",  damageDice: "1d12", damageType: "perforant",  properties: ["lourd","portee","a_deux_mains"],         cost: "20 po",  weight: 3   },
  { id: "trident",         name: "Trident",          damageDice: "1d6",  damageType: "perforant",  properties: ["lancer","polyvalent"], versatile: "1d8", cost: "5 po",  weight: 2   },
  { id: "fouet",           name: "Fouet",            damageDice: "1d4",  damageType: "tranchant",  properties: ["finesse","portee"],                     cost: "2 po",   weight: 1.5 },
];

// ---------------------------------------------------------------------------
// Armes de guerre à distance
// ---------------------------------------------------------------------------
export const MARTIAL_RANGED = [
  { id: "arc_long",         name: "Arc long",          damageDice: "1d8",  damageType: "perforant", properties: ["munitions","lourd","a_deux_mains"],               range: "45/180m",  cost: "50 po",  weight: 1   },
  { id: "arbalete_lourde",  name: "Arbalète lourde",   damageDice: "1d10", damageType: "perforant", properties: ["munitions","lourd","chargement","a_deux_mains"],   range: "30/120m",  cost: "50 po",  weight: 9   },
  { id: "arbalete_main",    name: "Arbalète de poing", damageDice: "1d6",  damageType: "perforant", properties: ["munitions","leger","chargement"],                  range: "9/36m",    cost: "75 po",  weight: 1.5 },
];

// ---------------------------------------------------------------------------
// Sorts offensifs courants (simplifié)
// ---------------------------------------------------------------------------
export const ATTACK_SPELLS = [
  { id: "trait_de_feu",     name: "Trait de feu",      damageDice: "1d10", damageType: "feu",        type: "sort", level: 0, rollToHit: true,  description: "Tour de magie, portée 36m" },
  { id: "rayon_de_givre",   name: "Rayon de givre",    damageDice: "1d8",  damageType: "froid",       type: "sort", level: 0, rollToHit: true,  description: "Tour de magie, ralentit la cible" },
  { id: "flamme_sacrée",    name: "Flamme sacrée",     damageDice: "1d8",  damageType: "radiant",     type: "sort", level: 0, rollToHit: false, savingThrow: "DEX", description: "Tour de magie, jet de sauvegarde DEX" },
  { id: "trait_venimeux",   name: "Trait venimeux",    damageDice: "1d6",  damageType: "poison",      type: "sort", level: 0, rollToHit: true,  description: "Tour de magie, portée 9m" },
  { id: "décharge_occulte", name: "Décharge occulte",  damageDice: "1d10", damageType: "force",       type: "sort", level: 0, rollToHit: true,  description: "Tour de magie du sorcier" },
  { id: "missile_magique",  name: "Missile magique",   damageDice: "1d4",  damageBonus: 1, damageType: "force", count: 3, type: "sort", level: 1, rollToHit: false, description: "3 missiles automatiques, niv 1" },
  { id: "mains_brûlantes",  name: "Mains brûlantes",   damageDice: "3d6",  damageType: "feu",         type: "sort", level: 1, rollToHit: false, savingThrow: "DEX", description: "Cône 4.5m, jet DEX, niv 1" },
  { id: "vague_tonnerre",   name: "Vague de tonnerre", damageDice: "2d8",  damageType: "tonnerre",    type: "sort", level: 1, rollToHit: false, savingThrow: "CON", description: "Cube 4.5m, repousse, niv 1" },
  { id: "enchevêtrement",   name: "Boule de feu",      damageDice: "8d6",  damageType: "feu",         type: "sort", level: 3, rollToHit: false, savingThrow: "DEX", description: "Sphère r6m, niv 3" },
];

// ---------------------------------------------------------------------------
// Index global de toutes les armes
// ---------------------------------------------------------------------------
export const ALL_WEAPONS = [
  ...SIMPLE_MELEE,
  ...SIMPLE_RANGED,
  ...MARTIAL_MELEE,
  ...MARTIAL_RANGED,
];

/** Retrouve une arme par son id ou son nom (insensible à la casse). */
export function findWeapon(query) {
  const q = query?.toLowerCase().trim() ?? "";
  return ALL_WEAPONS.find(
    (w) => w.id === q || w.name.toLowerCase() === q || w.name.toLowerCase().includes(q)
  ) ?? null;
}

/** Calcule le modificateur D&D 5e d'une caractéristique (valeur → mod). */
export function abilityMod(score) {
  return Math.floor((score - 10) / 2);
}

/** Bonus de maîtrise selon le niveau ou le CR. */
export function proficiencyBonus(levelOrCR) {
  if (levelOrCR <= 0) return 2;
  if (levelOrCR <= 4)  return 2;
  if (levelOrCR <= 8)  return 3;
  if (levelOrCR <= 12) return 4;
  if (levelOrCR <= 16) return 5;
  return 6;
}

/**
 * Génère un résumé textuel d'une arme pour le system prompt.
 * Ex: "Épée longue (1d8 tranchant, polyvalent 1d10)"
 */
export function weaponSummary(weapon) {
  if (!weapon) return "arme inconnue";
  const props = weapon.properties?.join(", ") ?? "";
  const versatile = weapon.versatile ? `, polyvalent ${weapon.versatile}` : "";
  return `${weapon.name} (${weapon.damageDice} ${weapon.damageType}${versatile}${props ? ", " + props : ""})`;
}
