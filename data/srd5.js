// ==============================================================================
// BASE DE DONNÉES SRD 5.1 (Règles 2014) - Création de Personnage Niveau 1
// ==============================================================================

// 1. CALCULATEUR UNIVERSEL
export const CALCULATE_MODIFIER = (score) => Math.floor((score - 10) / 2);

// 2. LISTE DES COMPÉTENCES (SKILLS) ET LEUR STATISTIQUE ASSOCIÉE
export const SKILLS_DB = {
  "Acrobaties": "DEX", "Arcanes": "INT", "Athlétisme": "FOR", 
  "Discrétion": "DEX", "Dressage": "SAG", "Escamotage": "DEX", 
  "Histoire": "INT", "Intimidation": "CHA", "Investigation": "INT", 
  "Médecine": "SAG", "Nature": "INT", "Perception": "SAG", 
  "Perspicacité": "SAG", "Persuasion": "CHA", "Religion": "INT", 
  "Représentation": "CHA", "Survie": "SAG", "Tromperie": "CHA"
};

// 3. TOUTES LES RACES DU SRD 5.1 (Avec Sous-races)
export const RACES = {
  "Nain des Collines": {
    name: "Nain des Collines", speed: 25, size: "Moyenne",
    statBonuses: { CON: 2, SAG: 1 },
    features: ["Vision dans le noir (60ft)", "Résistance naine (Avantage/Résistance au poison)", "Ténacité naine (+1 PV max)"],
    proficiencies: ["Haches d'armes", "Haches à main", "Marteaux légers", "Marteaux de guerre", "Outils d'artisan"],
    languages: ["Commun", "Nain"]
  },
  "Nain des Montagnes": {
    name: "Nain des Montagnes", speed: 25, size: "Moyenne",
    statBonuses: { CON: 2, FOR: 2 },
    features: ["Vision dans le noir (60ft)", "Résistance naine (Avantage/Résistance au poison)"],
    proficiencies: ["Haches d'armes", "Haches à main", "Marteaux légers", "Marteaux de guerre", "Armures légères", "Armures intermédiaires"],
    languages: ["Commun", "Nain"]
  },
  "Haut-Elfe": {
    name: "Haut-Elfe", speed: 30, size: "Moyenne",
    statBonuses: { DEX: 2, INT: 1 },
    features: ["Vision dans le noir (60ft)", "Sens aiguisés", "Ascendance fée", "Transe", "Tour de magie supplémentaire"],
    proficiencies: ["Épées longues", "Épées courtes", "Arcs courts", "Arcs longs", "Perception"],
    languages: ["Commun", "Elfique"],
    extraLanguageSlots: 1
  },
  "Elfe des Bois": {
    name: "Elfe des Bois", speed: 35, size: "Moyenne",
    statBonuses: { DEX: 2, SAG: 1 },
    features: ["Vision dans le noir (60ft)", "Sens aiguisés", "Ascendance fée", "Transe", "Cachette naturelle"],
    proficiencies: ["Épées longues", "Épées courtes", "Arcs courts", "Arcs longs", "Perception"],
    languages: ["Commun", "Elfique"]
  },
  "Halfelin Pied-Léger": {
    name: "Halfelin Pied-Léger", speed: 25, size: "Petite",
    statBonuses: { DEX: 2, CHA: 1 },
    features: ["Chanceux", "Brave", "Agilité halfeline", "Discrétion naturelle"],
    proficiencies: [],
    languages: ["Commun", "Halfelin"]
  },
  "Humain (Standard)": {
    name: "Humain", speed: 30, size: "Moyenne",
    statBonuses: { FOR: 1, DEX: 1, CON: 1, INT: 1, SAG: 1, CHA: 1 },
    features: [],
    proficiencies: [],
    languages: ["Commun"],
    // PHB 2014 : un humain parle le commun + une langue de son choix
    extraLanguageSlots: 1
  },
  "Drakéide": {
    name: "Drakéide", speed: 30, size: "Moyenne",
    statBonuses: { FOR: 2, CHA: 1 },
    features: ["Ascendance draconique", "Souffle destructeur", "Résistance aux dégâts"],
    proficiencies: [],
    languages: ["Commun", "Draconique"]
  },
  "Gnome de la Forêt": {
    name: "Gnome de la Forêt", speed: 25, size: "Petite",
    statBonuses: { INT: 2, DEX: 1 },
    features: ["Vision dans le noir (60ft)", "Ruse gnomique", "Illusionniste inné", "Communication avec les petits animaux"],
    proficiencies: [],
    languages: ["Commun", "Gnome"]
  },
  "Demi-Elfe": {
    name: "Demi-Elfe", speed: 30, size: "Moyenne",
    statBonuses: { CHA: 2, DEX: 1, INT: 1 }, 
    features: ["Vision dans le noir (60ft)", "Ascendance fée", "Polyvalence (2 compétences bonus)"],
    proficiencies: [],
    languages: ["Commun", "Elfique"],
    // PHB 2014 : demi‑elfe = commun, elfique + 1 langue au choix
    extraLanguageSlots: 1
  },
  "Demi-Orc": {
    name: "Demi-Orc", speed: 30, size: "Moyenne",
    statBonuses: { FOR: 2, CON: 1 },
    features: ["Vision dans le noir (60ft)", "Menaçant (Maîtrise Intimidation)", "Endurance implacable", "Attaques sauvages"],
    proficiencies: ["Intimidation"],
    languages: ["Commun", "Orc"]
  },
  "Tieffelin": {
    name: "Tieffelin", speed: 30, size: "Moyenne",
    statBonuses: { CHA: 2, INT: 1 },
    features: ["Vision dans le noir (60ft)", "Résistance infernale (Feu)", "Ascendance infernale"],
    proficiencies: [],
    languages: ["Commun", "Infernal"]
  }
};

// 4. TOUTES LES CLASSES DU SRD 5.1
export const CLASSES = {
  "Barbare": {
    name: "Barbare", hitDice: 12,
    primaryStats: ["FOR", "CON"], savingThrows: ["FOR", "CON"],
    proficiencies: ["Armures légères", "Armures intermédiaires", "Boucliers", "Armes courantes", "Armes martiales"],
    skillChoices: { count: 2, options: ["Dressage", "Athlétisme", "Intimidation", "Nature", "Perception", "Survie"] },
    features: ["Rage", "Défense sans armure"]
  },
  "Barde": {
    name: "Barde", hitDice: 8,
    primaryStats: ["CHA"], savingThrows: ["DEX", "CHA"],
    proficiencies: ["Armures légères", "Armes courantes", "Arbalètes de poing", "Épées longues", "Rapières", "Épées courtes"],
    skillChoices: { count: 3, options: Object.keys(SKILLS_DB) }, 
    features: ["Incantation", "Inspiration bardique (d6)"]
  },
  "Clerc": {
    name: "Clerc", hitDice: 8,
    primaryStats: ["SAG"], savingThrows: ["SAG", "CHA"],
    proficiencies: ["Armures légères", "Armures intermédiaires", "Boucliers", "Armes courantes"],
    skillChoices: { count: 2, options: ["Histoire", "Perspicacité", "Médecine", "Persuasion", "Religion"] },
    features: ["Incantation", "Domaine divin"]
  },
  "Druide": {
    name: "Druide", hitDice: 8,
    primaryStats: ["SAG"], savingThrows: ["INT", "SAG"],
    proficiencies: ["Armures légères (non métalliques)", "Boucliers (non métalliques)", "Armes spécifiques de druide"],
    skillChoices: { count: 2, options: ["Arcanes", "Dressage", "Perspicacité", "Médecine", "Nature", "Perception", "Religion", "Survie"] },
    features: ["Druidique", "Incantation"]
  },
  "Guerrier": {
    name: "Guerrier", hitDice: 10,
    primaryStats: ["FOR", "DEX"], savingThrows: ["FOR", "CON"],
    proficiencies: ["Toutes les armures", "Boucliers", "Armes courantes", "Armes martiales"],
    skillChoices: { count: 2, options: ["Acrobaties", "Dressage", "Athlétisme", "Histoire", "Perspicacité", "Intimidation", "Perception", "Survie"] },
    features: ["Style de combat", "Second souffle"]
  },
  "Moine": {
    name: "Moine", hitDice: 8,
    primaryStats: ["DEX", "SAG"], savingThrows: ["FOR", "DEX"],
    proficiencies: ["Armes courantes", "Épées courtes"],
    skillChoices: { count: 2, options: ["Acrobaties", "Athlétisme", "Histoire", "Perspicacité", "Religion", "Discrétion"] },
    features: ["Défense sans armure", "Arts martiaux"]
  },
  "Paladin": {
    name: "Paladin", hitDice: 10,
    primaryStats: ["FOR", "CHA"], savingThrows: ["SAG", "CHA"], 
    proficiencies: ["Toutes les armures", "Boucliers", "Armes courantes", "Armes martiales"],
    skillChoices: { count: 2, options: ["Athlétisme", "Perspicacité", "Intimidation", "Médecine", "Persuasion", "Religion"] },
    features: ["Sens divin", "Imposition des mains"]
  },
  "Rôdeur": {
    name: "Rôdeur", hitDice: 10,
    primaryStats: ["DEX", "SAG"], savingThrows: ["FOR", "DEX"],
    proficiencies: ["Armures légères", "Armures intermédiaires", "Boucliers", "Armes courantes", "Armes martiales"],
    skillChoices: { count: 3, options: ["Dressage", "Athlétisme", "Perspicacité", "Investigation", "Nature", "Perception", "Discrétion", "Survie"] },
    features: ["Ennemi juré", "Explorateur-né"]
  },
  "Roublard": {
    name: "Roublard", hitDice: 8,
    primaryStats: ["DEX"], savingThrows: ["DEX", "INT"],
    proficiencies: ["Armures légères", "Armes courantes", "Outils de voleur", "Épées longues", "Rapières", "Épées courtes"],
    skillChoices: { count: 4, options: ["Acrobaties", "Athlétisme", "Tromperie", "Perspicacité", "Intimidation", "Investigation", "Perception", "Représentation", "Persuasion", "Escamotage", "Discrétion"] },
    features: ["Expertise", "Attaque sournoise (1d6)", "Jargon des voleurs"]
  },
  "Ensorceleur": {
    name: "Ensorceleur", hitDice: 6,
    primaryStats: ["CHA"], savingThrows: ["CON", "CHA"],
    proficiencies: ["Dagues", "Fléchettes", "Frondes", "Bâtons", "Arbalètes légères"],
    skillChoices: { count: 2, options: ["Arcanes", "Tromperie", "Perspicacité", "Intimidation", "Persuasion", "Religion"] },
    features: ["Incantation", "Origine ensorcelante"]
  },
  "Occultiste": {
    name: "Occultiste", hitDice: 8,
    primaryStats: ["CHA"], savingThrows: ["SAG", "CHA"],
    proficiencies: ["Armures légères", "Armes courantes"],
    skillChoices: { count: 2, options: ["Arcanes", "Tromperie", "Histoire", "Intimidation", "Investigation", "Nature", "Religion"] },
    features: ["Patron d'outreterre", "Magie de pacte"]
  },
  "Magicien": {
    name: "Magicien", hitDice: 6,
    primaryStats: ["INT"], savingThrows: ["INT", "SAG"],
    proficiencies: ["Dagues", "Fléchettes", "Frondes", "Bâtons", "Arbalètes légères"],
    skillChoices: { count: 2, options: ["Arcanes", "Histoire", "Perspicacité", "Investigation", "Médecine", "Religion"] },
    features: ["Incantation", "Restauration arcanique"]
  }
};

// ==============================================================================
// 4b. GUERRIER (SRD 2014) — PROGRESSION / OPTIONS (niveau 1–20)
// ==============================================================================

export const FIGHTING_STYLES_FIGHTER = [
  "Archerie",
  "Arme à deux mains",
  "Combat à deux armes",
  "Défense",
  "Duel",
  "Protection",
];

export const FIGHTER_ARCHETYPES_SRD = [
  "Champion",
  "Maître de guerre",
  "Chevalier occulte",
];

// Paliers ASI spécifiques au Guerrier (PHB 2014)
export const FIGHTER_ASI_LEVELS = [4, 6, 8, 12, 14, 16, 19];

// Progression SRD : liste des capacités par niveau (texte court).
export const FIGHTER_FEATURES_BY_LEVEL = {
  1: ["Style de combat", "Second souffle"],
  2: ["Fougue (Action Surge)"],
  3: ["Archétype martial"],
  4: ["Amélioration de caractéristiques"],
  5: ["Attaque supplémentaire"],
  6: ["Amélioration de caractéristiques"],
  7: ["Capacité d'archétype (niv 7)"],
  8: ["Amélioration de caractéristiques"],
  9: ["Inflexible (Indomptable)"],
  10: ["Capacité d'archétype (niv 10)", "Style de combat supplémentaire"],
  11: ["Attaque supplémentaire (2)"],
  12: ["Amélioration de caractéristiques"],
  13: ["Inflexible (2)"],
  14: ["Amélioration de caractéristiques"],
  15: ["Capacité d'archétype (niv 15)"],
  16: ["Amélioration de caractéristiques"],
  17: ["Fougue (2)", "Inflexible (3)"],
  18: ["Capacité d'archétype (niv 18)"],
  19: ["Amélioration de caractéristiques"],
  20: ["Attaque supplémentaire (3)"],
};

// Champion (SRD) — résumés
export const FIGHTER_CHAMPION_FEATURES_BY_LEVEL = {
  3: ["Critique amélioré (19–20)"],
  7: ["Athlète accompli"],
  10: ["Style de combat supplémentaire"],
  15: ["Critique supérieur (18–20)"],
  18: ["Survivant"],
};

// ==============================================================================
// 4c. MAGICIEN (SRD 2014) — PROGRESSION / OPTIONS (niveau 1–20)
// ==============================================================================

export const ARCANE_TRADITIONS_SRD = [
  "Abjuration",
  "Divination",
  "Enchantement",
  "Évocation",
  "Illusion",
  "Invocation",
  "Nécromancie",
  "Transmutation",
];

export const WIZARD_ASI_LEVELS = [4, 8, 12, 16, 19];

export const WIZARD_FEATURES_BY_LEVEL = {
  1: ["Incantation", "Restauration arcanique"],
  2: ["Tradition arcanique"],
  3: [],
  4: ["Amélioration de caractéristiques"],
  5: [],
  6: ["Capacité de la tradition arcanique (niv 6)"],
  7: [],
  8: ["Amélioration de caractéristiques"],
  9: [],
  10: ["Capacité de la tradition arcanique (niv 10)"],
  11: [],
  12: ["Amélioration de caractéristiques"],
  13: [],
  14: ["Capacité de la tradition arcanique (niv 14)"],
  15: [],
  16: ["Amélioration de caractéristiques"],
  17: [],
  18: ["Maîtrise des sorts"],
  19: ["Amélioration de caractéristiques"],
  20: ["Sorts de prédilection"],
};

export const WIZARD_CANTRIPS_KNOWN_BY_LEVEL = {
  1: 3,
  2: 3,
  3: 3,
  4: 4,
  5: 4,
  6: 4,
  7: 4,
  8: 4,
  9: 4,
  10: 5,
  11: 5,
  12: 5,
  13: 5,
  14: 5,
  15: 5,
  16: 5,
  17: 5,
  18: 5,
  19: 5,
  20: 5,
};

// Emplacements de sorts du Magicien (PHB 2014), niveaux 1–20
// Forme: { [niveauPerso]: { [niveauSort]: nEmplacements } }
export const WIZARD_SLOTS_BY_LEVEL = {
  1:  { 1: 2 },
  2:  { 1: 3 },
  3:  { 1: 4, 2: 2 },
  4:  { 1: 4, 2: 3 },
  5:  { 1: 4, 2: 3, 3: 2 },
  6:  { 1: 4, 2: 3, 3: 3 },
  7:  { 1: 4, 2: 3, 3: 3, 4: 1 },
  8:  { 1: 4, 2: 3, 3: 3, 4: 2 },
  9:  { 1: 4, 2: 3, 3: 3, 4: 3, 5: 1 },
  10: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2 },
  11: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1 },
  12: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1 },
  13: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1 },
  14: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1 },
  15: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1 },
  16: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1 },
  17: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 2, 6: 1, 7: 1, 8: 1, 9: 1 },
  18: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 1, 7: 1, 8: 1, 9: 1 },
  19: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2, 7: 1, 8: 1, 9: 1 },
  20: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2, 7: 2, 8: 1, 9: 1 },
};

// ==============================================================================
// 4d. CLERC (SRD 2014) — PROGRESSION / DOMAINES (niveau 1–20)
// ==============================================================================

export const CLERIC_DOMAINS_SRD = [
  "Duperie",
  "Guerre",
  "Lumière",
  "Nature",
  "Savoir",
  "Tempête",
  "Vie",
];

export const CLERIC_ASI_LEVELS = [4, 8, 12, 16, 19];

export const CLERIC_FEATURES_BY_LEVEL = {
  1: ["Incantation", "Domaine divin"],
  2: ["Conduit divin (1/repos)", "Capacité de domaine divin (niv 2)"],
  3: [],
  4: ["Amélioration de caractéristiques"],
  5: ["Destruction des morts-vivants (FP 1/2)"],
  6: ["Conduit divin (2/repos)", "Capacité de domaine divin (niv 6)"],
  7: [],
  8: ["Amélioration de caractéristiques", "Capacité de domaine divin (niv 8)", "Destruction des morts-vivants (FP 1)"],
  9: [],
  10: ["Intervention divine"],
  11: ["Destruction des morts-vivants (FP 2)"],
  12: ["Amélioration de caractéristiques"],
  13: [],
  14: ["Destruction des morts-vivants (FP 3)"],
  15: [],
  16: ["Amélioration de caractéristiques"],
  17: ["Destruction des morts-vivants (FP 4)", "Capacité de domaine divin (niv 17)"],
  18: ["Conduit divin (3/repos)"],
  19: ["Amélioration de caractéristiques"],
  20: ["Intervention divine supérieure"],
};

export const CLERIC_CANTRIPS_KNOWN_BY_LEVEL = {
  1: 3,
  2: 3,
  3: 3,
  4: 4,
  5: 4,
  6: 4,
  7: 4,
  8: 4,
  9: 4,
  10: 5,
  11: 5,
  12: 5,
  13: 5,
  14: 5,
  15: 5,
  16: 5,
  17: 5,
  18: 5,
  19: 5,
  20: 5,
};

// Emplacements de sorts du Clerc (PHB 2014), niveaux 1–20
// (progression de lanceur complet, identique au Magicien)
export const CLERIC_SLOTS_BY_LEVEL = {
  ...WIZARD_SLOTS_BY_LEVEL,
};

// Sorts de domaine (SRD) — toujours préparés, ne comptent pas dans le quota quotidien.
// Mapping: domaine -> { clericLevel: [spells...] }
export const CLERIC_DOMAIN_SPELLS = {
  "Duperie": {
    1: ["Charme-personne", "Déguisement"],
    3: ["Image miroir", "Passage sans trace"],
    5: ["Clignotement", "Dissipation de la magie"],
    7: ["Métamorphose", "Porte dimensionnelle"],
    9: ["Domination de personne", "Modification de mémoire"],
  },
  "Guerre": {
    1: ["Bouclier de la foi", "Faveur divine"],
    3: ["Arme magique", "Arme spirituelle"],
    5: ["Aura du croisé", "Esprits gardiens"],
    7: ["Liberté de mouvement", "Peau de pierre"],
    9: ["Colonne de flamme", "Immobilisation de monstre"],
  },
  "Lumière": {
    1: ["Lueurs féeriques", "Mains brûlantes"],
    3: ["Rayon ardent", "Sphère de feu"],
    5: ["Boule de feu", "Lumière du jour"],
    7: ["Gardien de la foi", "Mur de feu"],
    9: ["Colonne de flamme", "Scrutation"],
  },
  "Nature": {
    1: ["Amitié avec les animaux", "Communication avec les animaux"],
    3: ["Croissance d'épines", "Peau d'écorce"],
    5: ["Croissance végétale", "Mur de vent"],
    7: ["Domination de bête", "Liane avide"],
    9: ["Fléau d'insectes", "Passage par les arbres"],
  },
  "Savoir": {
    1: ["Identification", "Injonction"],
    3: ["Augure", "Suggestion"],
    5: ["Antidétection", "Communication avec les morts"],
    7: ["Confusion", "Œil magique"],
    9: ["Mythes et légendes", "Scrutation"],
  },
  "Tempête": {
    1: ["Nappe de brouillard", "Vague tonnante"],
    3: ["Bourrasque", "Fracasse"],
    5: ["Appel de la foudre", "Tempête de neige"],
    7: ["Contrôle de l'eau", "Tempête de grêle"],
    9: ["Fléau d'insectes", "Vague destructrice"],
  },
  "Vie": {
    1: ["Bénédiction", "Soins"],
    3: ["Arme spirituelle", "Restauration partielle"],
    5: ["Lueur d'espoir", "Retour à la vie"],
    7: ["Gardien de la foi", "Protection contre la mort"],
    9: ["Rappel à la vie", "Soins de groupe"],
  },
};

export function clericDomainSpellsForLevel(domain, level) {
  const d = CLERIC_DOMAIN_SPELLS?.[domain] ?? null;
  if (!d) return [];
  const out = [];
  const thresholds = [1, 3, 5, 7, 9];
  for (const t of thresholds) {
    if (level >= t && Array.isArray(d[t])) out.push(...d[t]);
  }
  return out;
}

// Résumé des capacités de domaines (texte court, UI/prompt)
export const CLERIC_DOMAIN_FEATURES_BY_LEVEL = {
  "Duperie": {
    1: ["Bénédiction de l'escroc"],
    2: ["Conduit divin : Invocation de réplique"],
    6: ["Conduit divin : Linceul d'ombre"],
    8: ["Frappe divine (poison)"],
    17: ["Réplique améliorée"],
  },
  "Guerre": {
    1: ["Maîtrises supplémentaires (armes de guerre, armures lourdes)", "Prêtre de guerre"],
    2: ["Conduit divin : Frappe guidée"],
    6: ["Conduit divin : Bénédiction du dieu de la guerre"],
    8: ["Frappe divine"],
    17: ["Avatar de bataille"],
  },
  "Lumière": {
    1: ["Sort mineur supplémentaire : Lumière", "Illumination protectrice"],
    2: ["Conduit divin : Radiance de l'aube"],
    6: ["Illumination améliorée"],
    8: ["Incantation puissante"],
    17: ["Halo de lumière"],
  },
  "Nature": {
    1: ["Acolyte de la nature", "Maîtrise supplémentaire (armures lourdes)"],
    2: ["Conduit divin : Charme des animaux et des plantes"],
    6: ["Atténuation des éléments"],
    8: ["Frappe divine (froid/feu/foudre)"],
    17: ["Maître de la nature"],
  },
  "Savoir": {
    1: ["Bénédictions du savoir"],
    2: ["Conduit divin : Savoir ancestral"],
    6: ["Conduit divin : Lecture des pensées"],
    8: ["Incantation puissante"],
    17: ["Visions du passé"],
  },
  "Tempête": {
    1: ["Maîtrises supplémentaires (armes de guerre, armures lourdes)", "Fureur de l'ouragan"],
    2: ["Conduit divin : Fureur destructrice"],
    6: ["Frappe de l'éclair"],
    8: ["Frappe divine (tonnerre)"],
    17: ["Enfant de la tempête"],
  },
  "Vie": {
    1: ["Maîtrise supplémentaire (armures lourdes)", "Disciple de la vie"],
    2: ["Conduit divin : Préservation de la vie"],
    6: ["Guérisseur béni"],
    8: ["Frappe divine (radiant)"],
    17: ["Guérison suprême"],
  },
};

// ==============================================================================
// 4e. ROUBLARD (SRD 2014) — PROGRESSION / OPTIONS (niveau 1–20)
// ==============================================================================

export const ROGUE_ARCHETYPES_SRD = ["Voleur", "Assassin", "Escroc arcanique"];

export const ROGUE_ASI_LEVELS = [4, 8, 10, 12, 16, 19];

// Attaque sournoise (d6) par niveau (PHB 2014)
export const ROGUE_SNEAK_ATTACK_DICE_BY_LEVEL = {
  1: "1d6",
  2: "1d6",
  3: "2d6",
  4: "2d6",
  5: "3d6",
  6: "3d6",
  7: "4d6",
  8: "4d6",
  9: "5d6",
  10: "5d6",
  11: "6d6",
  12: "6d6",
  13: "7d6",
  14: "7d6",
  15: "8d6",
  16: "8d6",
  17: "9d6",
  18: "9d6",
  19: "10d6",
  20: "10d6",
};

export const ROGUE_FEATURES_BY_LEVEL = {
  1: ["Expertise", "Attaque sournoise", "Jargon des voleurs"],
  2: ["Ruse"],
  3: ["Archétype de roublard"],
  4: ["Amélioration de caractéristiques"],
  5: ["Esquive instinctive"],
  6: ["Expertise (2)"],
  7: ["Esquive totale"],
  8: ["Amélioration de caractéristiques"],
  9: ["Capacité d'archétype (niv 9)"],
  10: ["Amélioration de caractéristiques"],
  11: ["Savoir-faire"],
  12: ["Amélioration de caractéristiques"],
  13: ["Capacité d'archétype (niv 13)"],
  14: ["Perception aveugle"],
  15: ["Esprit fuyant"],
  16: ["Amélioration de caractéristiques"],
  17: ["Capacité d'archétype (niv 17)"],
  18: ["Insaisissable"],
  19: ["Amélioration de caractéristiques"],
  20: ["Coup de chance"],
};

export const ROGUE_ARCHETYPE_FEATURES_BY_LEVEL = {
  Voleur: {
    3: ["Mains lestes", "Monte-en-l'air"],
    9: ["Discrétion suprême"],
    13: ["Utilisation d'objets magiques"],
    17: ["Réflexes de voleur"],
  },
  Assassin: {
    3: ["Maîtrises supplémentaires (déguisement, empoisonneur)", "Assassinat"],
    9: ["Expert en infiltration"],
    13: ["Imposteur"],
    17: ["Frappe meurtrière"],
  },
  "Escroc arcanique": {
    3: ["Incantation (Escroc arcanique)", "Escamotage et main de mage"],
    9: ["Embuscade magique"],
    13: ["Escroc polyvalent"],
    17: ["Voleur de sort"],
  },
};

// Escroc arcanique (Arcane Trickster) — progression des sorts connus / slots
// Table PHB 2014 (emplacements 1–4)
export const ARCANE_TRICKSTER_SLOTS_BY_LEVEL = {
  3: { 1: 2 },
  4: { 1: 3 },
  5: { 1: 3 },
  6: { 1: 3 },
  7: { 1: 4, 2: 2 },
  8: { 1: 4, 2: 2 },
  9: { 1: 4, 2: 2 },
  10: { 1: 4, 2: 3 },
  11: { 1: 4, 2: 3 },
  12: { 1: 4, 2: 3 },
  13: { 1: 4, 2: 3, 3: 2 },
  14: { 1: 4, 2: 3, 3: 2 },
  15: { 1: 4, 2: 3, 3: 2 },
  16: { 1: 4, 2: 3, 3: 3 },
  17: { 1: 4, 2: 3, 3: 3 },
  18: { 1: 4, 2: 3, 3: 3 },
  19: { 1: 4, 2: 3, 3: 3, 4: 1 },
  20: { 1: 4, 2: 3, 3: 3, 4: 1 },
};

// PHB 2014: tours de magie connus + sorts connus (niveau 1+) + niveau max de sort
export const ARCANE_TRICKSTER_SPELLS_KNOWN_BY_LEVEL = {
  3: { cantrips: 3, spells: 3, maxSpellLevel: 1 },
  4: { cantrips: 3, spells: 4, maxSpellLevel: 1 },
  5: { cantrips: 3, spells: 4, maxSpellLevel: 1 },
  6: { cantrips: 3, spells: 4, maxSpellLevel: 1 },
  7: { cantrips: 3, spells: 5, maxSpellLevel: 2 },
  8: { cantrips: 3, spells: 6, maxSpellLevel: 2 },
  9: { cantrips: 3, spells: 6, maxSpellLevel: 2 },
  10: { cantrips: 4, spells: 7, maxSpellLevel: 2 },
  11: { cantrips: 4, spells: 8, maxSpellLevel: 2 },
  12: { cantrips: 4, spells: 8, maxSpellLevel: 2 },
  13: { cantrips: 4, spells: 9, maxSpellLevel: 3 },
  14: { cantrips: 4, spells: 10, maxSpellLevel: 3 },
  15: { cantrips: 4, spells: 10, maxSpellLevel: 3 },
  16: { cantrips: 4, spells: 11, maxSpellLevel: 3 },
  17: { cantrips: 4, spells: 11, maxSpellLevel: 3 },
  18: { cantrips: 4, spells: 11, maxSpellLevel: 3 },
  19: { cantrips: 4, spells: 12, maxSpellLevel: 4 },
  20: { cantrips: 4, spells: 13, maxSpellLevel: 4 },
};

export const ARCANE_TRICKSTER_ALLOWED_SCHOOLS = ["Illusion", "Enchantement"];

// Niveaux où un sort connu peut être "hors école" (PHB 2014) : 3 (1), 8, 14, 20
export const ARCANE_TRICKSTER_ANY_SCHOOL_SPELL_LEVELS = [3, 8, 14, 20];

// Maître de guerre (SRD) — manœuvres et dés
export const BATTLEMASTER_MANEUVERS_SRD = [
  "Attaque menaçante",
  "Attaque précise",
  "Balayage",
  "Croc-en-jambe",
  "Désarmement",
  "Diversion",
  "Feinte",
  "Fente",
  "Instruction",
  "Jeu de jambes défensif",
  "Manœuvre tactique",
  "Parade",
  "Provocation",
  "Regain",
  "Repousser",
  "Riposte",
];

export const BATTLEMASTER_DICE_BY_LEVEL = {
  3:  { die: "d8",  dice: 4, maneuversKnown: 3 },
  7:  { die: "d8",  dice: 5, maneuversKnown: 5 },
  10: { die: "d10", dice: 5, maneuversKnown: 7 },
  15: { die: "d10", dice: 6, maneuversKnown: 9 },
  18: { die: "d12", dice: 6, maneuversKnown: 9 },
};

// Chevalier occulte (SRD) — table d'emplacements (niv 1–4)
// N.B. L'EK suit une progression de demi-caster très limitée (PHB) et choisit ses sorts dans la liste Magicien,
// avec restrictions d'école. On stocke surtout pour la création/affichage.
export const ELDRITCH_KNIGHT_SPELLS_KNOWN_BY_LEVEL = {
  3:  { cantrips: 2, spells: 3, maxSpellLevel: 1 },
  4:  { cantrips: 2, spells: 4, maxSpellLevel: 1 },
  5:  { cantrips: 2, spells: 4, maxSpellLevel: 1 },
  6:  { cantrips: 2, spells: 4, maxSpellLevel: 1 },
  7:  { cantrips: 2, spells: 5, maxSpellLevel: 2 },
  8:  { cantrips: 2, spells: 6, maxSpellLevel: 2 },
  9:  { cantrips: 2, spells: 6, maxSpellLevel: 2 },
  10: { cantrips: 3, spells: 7, maxSpellLevel: 2 },
  11: { cantrips: 3, spells: 8, maxSpellLevel: 2 },
  12: { cantrips: 3, spells: 8, maxSpellLevel: 2 },
  13: { cantrips: 3, spells: 9, maxSpellLevel: 3 },
  14: { cantrips: 3, spells: 10, maxSpellLevel: 3 },
  15: { cantrips: 3, spells: 10, maxSpellLevel: 3 },
  16: { cantrips: 3, spells: 11, maxSpellLevel: 3 },
  17: { cantrips: 3, spells: 11, maxSpellLevel: 4 },
  18: { cantrips: 3, spells: 11, maxSpellLevel: 4 },
  19: { cantrips: 3, spells: 12, maxSpellLevel: 4 },
  20: { cantrips: 3, spells: 13, maxSpellLevel: 4 },
};

export const ELDRITCH_KNIGHT_SLOTS_BY_LEVEL = {
  3:  { 1: 2 },
  4:  { 1: 3 },
  5:  { 1: 3 },
  6:  { 1: 3 },
  7:  { 1: 4, 2: 2 },
  8:  { 1: 4, 2: 2 },
  9:  { 1: 4, 2: 2 },
  10: { 1: 4, 2: 3 },
  11: { 1: 4, 2: 3 },
  12: { 1: 4, 2: 3 },
  13: { 1: 4, 2: 3 },
  14: { 1: 4, 2: 3 },
  15: { 1: 4, 2: 3 },
  16: { 1: 4, 2: 3 },
  17: { 1: 4, 2: 3, 3: 1 },
  18: { 1: 4, 2: 3, 3: 1 },
  19: { 1: 4, 2: 3, 3: 2 },
  20: { 1: 4, 2: 3, 3: 2 },
};

// 5. HISTORIQUES (BACKGROUNDS) STANDARDS
export const BACKGROUNDS = {
  // Langues : on encode uniquement les "langues de votre choix" via extraLanguages.
  // (Les historiques qui donnent 0 langue supplémentaire n'ont pas ce champ.)
  "Acolyte": {
    name: "Acolyte",
    skills: ["Perspicacité", "Religion"],
    features: ["Abri du fidèle"],
    // PHB : 2 langues supplémentaires au choix
    extraLanguages: 2,
  },
  "Criminel": {
    name: "Criminel",
    skills: ["Tromperie", "Discrétion"],
    features: ["Accès au réseau criminel"],
  },
  "Héros du Peuple": {
    name: "Héros du Peuple",
    skills: ["Dressage", "Survie"],
    features: ["Hospitalité rustique"],
  },
  "Noble": {
    name: "Noble",
    skills: ["Histoire", "Persuasion"],
    features: ["Privilège de la noblesse"],
    // PHB : 1 langue supplémentaire au choix
    extraLanguages: 1,
  },
  "Sage": {
    name: "Sage",
    skills: ["Arcanes", "Histoire"],
    features: ["Chercheur"],
    // PHB : 2 langues supplémentaires au choix
    extraLanguages: 2,
  },
  "Soldat": {
    name: "Soldat",
    skills: ["Athlétisme", "Intimidation"],
    features: ["Grade militaire"],
  },
  "Charlatan": {
    name: "Charlatan",
    skills: ["Tromperie", "Escamotage"],
    features: ["Fausse identité"],
  },
  "Ermite": {
    name: "Ermite",
    skills: ["Médecine", "Religion"],
    features: ["Découverte"],
    // PHB : 1 langue supplémentaire au choix
    extraLanguages: 1,
  },
  "Marin": {
    name: "Marin",
    skills: ["Athlétisme", "Perception"],
    features: ["Passage en mer"],
  },
  "Artisan de guilde": {
    name: "Artisan",
    skills: ["Perspicacité", "Persuasion"],
    features: ["Membre de la guilde"],
    // PHB : 1 langue supplémentaire au choix
    extraLanguages: 1,
  },
  "Artiste": {
    name: "Artiste",
    skills: ["Acrobaties", "Représentation"],
    features: ["À la demande générale"],
  },
  "Sauvageon": {
    name: "Sauvageon",
    skills: ["Athlétisme", "Survie"],
    features: ["Nomade"],
    // Outlander : 1 langue supplémentaire au choix
    extraLanguages: 1,
  },
};

// 6. LISTE STANDARD + EXOTIQUES DES LANGUES DU SRD 5.1 (PHB 2014)
export const LANGUAGES = [
  "Commun",
  "Nain",
  "Elfique",
  "Géant",        // Giant
  "Gnome",        // Gnomish
  "Gobelin",      // Goblin
  "Halfelin",     // Halfling
  "Orc",          // Orc
  "Abyssal",      // Abyssal
  "Céleste",      // Celestial
  "Draconique",   // Draconic
  "Profond",      // Deep Speech (langage des profondeurs)
  "Infernal",     // Infernal
  "Primordial",   // Primordial (Auran/Aquan/Ignan/Terran)
  "Sylvestre",    // Sylvan
  "Souterrain",   // Undercommon
];

// 7. BASE DE DONNÉES DES ARMES OFFICIELLES (D&D 2014)
export const WEAPONS = {
  // --- ARMES COURANTES DE CORPS À CORPS ---
  "Bâton": { category: "Courante", damage: "1d6", damageType: "Contondant", properties: ["Polyvalente (1d8)"], stat: "FOR" },
  "Dague": { category: "Courante", damage: "1d4", damageType: "Perforant", properties: ["Finesse", "Légère", "Lancer (portée 6/18)"], stat: "FINESSE" },
  "Faucille": { category: "Courante", damage: "1d4", damageType: "Tranchant", properties: ["Légère"], stat: "FOR" },
  "Gourdin": { category: "Courante", damage: "1d4", damageType: "Contondant", properties: ["Légère"], stat: "FOR" },
  "Hachette": { category: "Courante", damage: "1d6", damageType: "Tranchant", properties: ["Légère", "Lancer (portée 6/18)"], stat: "FOR" },
  "Javelot": { category: "Courante", damage: "1d6", damageType: "Perforant", properties: ["Lancer (portée 9/36)"], stat: "FOR" },
  "Lance": { category: "Courante", damage: "1d6", damageType: "Perforant", properties: ["Lancer (portée 6/18)", "Polyvalente (1d8)"], stat: "FOR" },
  "Marteau léger": { category: "Courante", damage: "1d4", damageType: "Contondant", properties: ["Légère", "Lancer (portée 6/18)"], stat: "FOR" },
  "Masse d'armes": { category: "Courante", damage: "1d6", damageType: "Contondant", properties: [], stat: "FOR" },
  "Massue": { category: "Courante", damage: "1d8", damageType: "Contondant", properties: ["Deux mains"], stat: "FOR" },
  
  // --- ARMES COURANTES À DISTANCE ---
  "Arbalète légère": { category: "Courante", damage: "1d8", damageType: "Perforant", properties: ["Munitions (portée 24/96)", "Chargement", "Deux mains"], stat: "DEX" },
  "Arc court": { category: "Courante", damage: "1d6", damageType: "Perforant", properties: ["Munitions (portée 24/96)", "Deux mains"], stat: "DEX" },
  "Fléchette": { category: "Courante", damage: "1d4", damageType: "Perforant", properties: ["Finesse", "Lancer (portée 6/18)"], stat: "FINESSE" },
  "Fronde": { category: "Courante", damage: "1d4", damageType: "Contondant", properties: ["Munitions (portée 9/36)"], stat: "DEX" },

  // --- ARMES MARTIALES DE CORPS À CORPS ---
  "Cimeterre": { category: "Martiale", damage: "1d6", damageType: "Tranchant", properties: ["Finesse", "Légère"], stat: "FINESSE" },
  "Coutille": { category: "Martiale", damage: "1d10", damageType: "Tranchant", properties: ["Lourde", "Allonge", "Deux mains"], stat: "FOR" },
  "Épée à deux mains": { category: "Martiale", damage: "2d6", damageType: "Tranchant", properties: ["Lourde", "Deux mains"], stat: "FOR" },
  "Épée courte": { category: "Martiale", damage: "1d6", damageType: "Perforant", properties: ["Finesse", "Légère"], stat: "FINESSE" },
  "Épée longue": { category: "Martiale", damage: "1d8", damageType: "Tranchant", properties: ["Polyvalente (1d10)"], stat: "FOR" },
  "Fléau d'armes": { category: "Martiale", damage: "1d8", damageType: "Contondant", properties: [], stat: "FOR" },
  "Fouet": { category: "Martiale", damage: "1d4", damageType: "Tranchant", properties: ["Finesse", "Allonge"], stat: "FINESSE" },
  "Grande hache": { category: "Martiale", damage: "1d12", damageType: "Tranchant", properties: ["Lourde", "Deux mains"], stat: "FOR" },
  "Hache d'armes": { category: "Martiale", damage: "1d8", damageType: "Tranchant", properties: ["Polyvalente (1d10)"], stat: "FOR" },
  "Hallebarde": { category: "Martiale", damage: "1d10", damageType: "Tranchant", properties: ["Lourde", "Allonge", "Deux mains"], stat: "FOR" },
  "Lance d'arçon": { category: "Martiale", damage: "1d12", damageType: "Perforant", properties: ["Allonge", "Spécial"], stat: "FOR" },
  "Maillol": { category: "Martiale", damage: "2d6", damageType: "Contondant", properties: ["Lourde", "Deux mains"], stat: "FOR" },
  "Marteau de guerre": { category: "Martiale", damage: "1d8", damageType: "Contondant", properties: ["Polyvalente (1d10)"], stat: "FOR" },
  "Morgenstern": { category: "Martiale", damage: "1d8", damageType: "Perforant", properties: [], stat: "FOR" },
  "Pic de guerre": { category: "Martiale", damage: "1d8", damageType: "Perforant", properties: [], stat: "FOR" },
  "Pique": { category: "Martiale", damage: "1d10", damageType: "Perforant", properties: ["Lourde", "Allonge", "Deux mains"], stat: "FOR" },
  "Rapière": { category: "Martiale", damage: "1d8", damageType: "Perforant", properties: ["Finesse"], stat: "FINESSE" },
  "Trident": { category: "Martiale", damage: "1d6", damageType: "Perforant", properties: ["Lancer (portée 6/18)", "Polyvalente (1d8)"], stat: "FOR" },

  // --- ARMES MARTIALES À DISTANCE ---
  "Arbalète de poing": { category: "Martiale", damage: "1d6", damageType: "Perforant", properties: ["Munitions (portée 9/36)", "Légère", "Chargement"], stat: "DEX" },
  "Arbalète lourde": { category: "Martiale", damage: "1d10", damageType: "Perforant", properties: ["Munitions (portée 30/120)", "Lourde", "Chargement", "Deux mains"], stat: "DEX" },
  "Arc long": { category: "Martiale", damage: "1d8", damageType: "Perforant", properties: ["Munitions (portée 45/180)", "Lourde", "Deux mains"], stat: "DEX" },
  "Filet": { category: "Martiale", damage: "0", damageType: "Aucun", properties: ["Lancer (portée 1.5/4.5)", "Spécial"], stat: "DEX" },
  "Sarbacane": { category: "Martiale", damage: "1", damageType: "Perforant", properties: ["Munitions (portée 7.5/30)", "Chargement"], stat: "DEX" }
};

// 8. BASE DE DONNÉES DES ARMURES OFFICIELLES (D&D 2014)
export const ARMORS = {
  // --- ARMURES LÉGÈRES (CA = Base + Mod DEX) ---
  "Armure matelassée": { type: "Légère", baseAC: 11, stealthDisadvantage: true, modifier: "DEX", strengthReq: 0 },
  "Armure de cuir": { type: "Légère", baseAC: 11, stealthDisadvantage: false, modifier: "DEX", strengthReq: 0 },
  "Armure de cuir clouté": { type: "Légère", baseAC: 12, stealthDisadvantage: false, modifier: "DEX", strengthReq: 0 },
  
  // --- ARMURES INTERMÉDIAIRES (CA = Base + Mod DEX max 2) ---
  "Armure de peaux": { type: "Intermédiaire", baseAC: 12, stealthDisadvantage: false, modifier: "DEX_MAX_2", strengthReq: 0 },
  "Chemise de mailles": { type: "Intermédiaire", baseAC: 13, stealthDisadvantage: false, modifier: "DEX_MAX_2", strengthReq: 0 },
  "Armure d'écailles": { type: "Intermédiaire", baseAC: 14, stealthDisadvantage: true, modifier: "DEX_MAX_2", strengthReq: 0 },
  // Alias utilisé par les fiches existantes (ex: clerc prégénéré Aldéric).
  "Cotte d'écailles": { type: "Intermédiaire", baseAC: 14, stealthDisadvantage: true, modifier: "DEX_MAX_2", strengthReq: 0 },
  "Cuirasse": { type: "Intermédiaire", baseAC: 14, stealthDisadvantage: false, modifier: "DEX_MAX_2", strengthReq: 0 },
  "Demi-plate": { type: "Intermédiaire", baseAC: 15, stealthDisadvantage: true, modifier: "DEX_MAX_2", strengthReq: 0 },

  // --- ARMURES LOURDES (CA = Base, pas de DEX) ---
  "Broigne": { type: "Lourde", baseAC: 14, stealthDisadvantage: true, modifier: "NONE", strengthReq: 0 },
  "Cotte de mailles": { type: "Lourde", baseAC: 16, stealthDisadvantage: true, modifier: "NONE", strengthReq: 13 },
  "Clibanion": { type: "Lourde", baseAC: 17, stealthDisadvantage: true, modifier: "NONE", strengthReq: 15 },
  "Harnois": { type: "Lourde", baseAC: 18, stealthDisadvantage: true, modifier: "NONE", strengthReq: 15 },

  // --- BOUCLIER ---
  "Bouclier": { type: "Bouclier", baseAC: 2, stealthDisadvantage: false, modifier: "SHIELD", strengthReq: 0 }
};

// 9. ÉQUIPEMENT D'AVENTURIER ET PACKS (D&D 2014)
export const ADVENTURING_GEAR = {
  "Potion de soins": { type: "Consommable", effect: "Rend 2d4+2 PV" },
  "Outils de voleur": { type: "Outil", effect: "Permet de crocheter serrures et désamorcer pièges" },
  "Sacoche à composantes": { type: "Magie", effect: "Contient les composantes matérielles courantes (sans coût en po)" },
  "Focaliseur arcanique": { type: "Magie", effect: "Remplace composantes matérielles" },
  "Focaliseur druidique": { type: "Magie", effect: "Focaliseur pour les druides (mistletoe, totem, etc.)" },
  "Symbole sacré": { type: "Magie", effect: "Focaliseur pour Clercs et Paladins" }
};

// 10. ÉQUIPEMENT DE DÉPART DÉTERMINISTE PAR CLASSE
export const STARTING_EQUIPMENT = {
  "Barbare": { armor: "Aucune", shield: "Aucun", weapons: ["Grande hache", "Javelot", "Javelot", "Javelot", "Javelot"], items: ["Sac d'explorateur"] },
  "Barde": { armor: "Armure de cuir", shield: "Aucun", weapons: ["Rapière", "Dague"], items: ["Sac d'artiste", "Luth"] },
  "Clerc": { armor: "Cotte d'écailles", shield: "Bouclier", weapons: ["Masse d'armes", "Arbalète légère"], items: ["Sac de prêtre", "Symbole sacré"] },
  "Druide": { armor: "Armure de cuir", shield: "Bouclier", weapons: ["Cimeterre"], items: ["Sac d'explorateur", "Focaliseur druidique"] },
  "Guerrier": { armor: "Cotte de mailles", shield: "Bouclier", weapons: ["Épée longue", "Arbalète légère"], items: ["Sac d'explorateur"] },
  "Moine": { armor: "Aucune", shield: "Aucun", weapons: ["Épée courte", "Fléchette", "Fléchette", "Fléchette", "Fléchette"], items: ["Sac d'explorateur"] },
  "Paladin": { armor: "Cotte de mailles", shield: "Bouclier", weapons: ["Épée longue", "Javelot", "Javelot"], items: ["Sac de prêtre", "Symbole sacré"] },
  "Rôdeur": { armor: "Armure d'écailles", shield: "Aucun", weapons: ["Épée courte", "Épée courte", "Arc long"], items: ["Sac d'explorateur"] },
  "Roublard": { armor: "Armure de cuir", shield: "Aucun", weapons: ["Rapière", "Arc court", "Dague", "Dague"], items: ["Sac de cambrioleur", "Outils de voleur"] },
  "Ensorceleur": { armor: "Aucune", shield: "Aucun", weapons: ["Arbalète légère", "Dague", "Dague"], items: ["Sac d'explorateur", "Focaliseur arcanique"] },
  "Occultiste": { armor: "Armure de cuir", shield: "Aucun", weapons: ["Arbalète légère", "Dague", "Dague"], items: ["Sac d'érudit", "Focaliseur arcanique"] },
  "Magicien": { armor: "Aucune", shield: "Aucun", weapons: ["Bâton", "Dague"], items: ["Sac d'érudit", "Focaliseur arcanique", "Grimoire"] }
};

// 11. BASE DE DONNÉES DES SORTS (Niveau 0 à 9 - SRD 2014)
// Structure déterministe intégrale pour la gestion magique.
export const SPELLS = {
  // --- TOURS DE MAGIE (NIVEAU 0) ---
  "Amis": { level: 0, school: "Enchantement", castingTime: "1 action", range: "Perso", duration: "Concentration, 1 min", effect: "Avantage aux tests de CHA contre une créature non-hostile pendant la durée (puis elle peut se méfier).", classes: ["Barde", "Ensorceleur", "Magicien", "Occultiste"] },
  "Aspersion acide": { level: 0, school: "Invocation", castingTime: "1 action", range: "18m", duration: "Instantanée", save: "DEX", damage: "1d6", damageType: "Acide", classes: ["Ensorceleur", "Magicien"] },
  "Assistance": { level: 0, school: "Divination", castingTime: "1 action", range: "Contact", duration: "Concentration, 1 min", attack: "Aucun", effect: "+1d4 au prochain jet de carac", classes: ["Clerc", "Druide"] },
  "Bouffée de poison": { level: 0, school: "Invocation", castingTime: "1 action", range: "3m", duration: "Instantanée", save: "CON", damage: "1d12", damageType: "Poison", classes: ["Druide", "Ensorceleur", "Magicien", "Occultiste"] },
  "Contact glacial": { level: 0, school: "Nécromancie", castingTime: "1 action", range: "36m", duration: "1 round", attack: "Sort distance", damage: "1d8", damageType: "Nécrotique", classes: ["Ensorceleur", "Magicien", "Occultiste"] },
  "Coup au but": { level: 0, school: "Divination", castingTime: "1 action", range: "9m", duration: "Concentration, 1 round", effect: "Avantage au prochain jet d'attaque", classes: ["Barde", "Ensorceleur", "Magicien", "Occultiste"] },
  "Explosion occulte": { level: 0, school: "Évocation", castingTime: "1 action", range: "36m", duration: "Instantanée", attack: "Sort distance", damage: "1d10", damageType: "Force", classes: ["Occultiste"] },
  "Flamme sacrée": { level: 0, school: "Évocation", castingTime: "1 action", range: "18m", duration: "Instantanée", save: "DEX", saveDamageOnSuccess: "none", damage: "1d8", damageType: "Radiant", classes: ["Clerc"] },
  "Illusion mineure": { level: 0, school: "Illusion", castingTime: "1 action", range: "9m", duration: "1 min", effect: "Crée une petite illusion simple (son OU image statique).", classes: ["Barde", "Ensorceleur", "Magicien", "Occultiste"] },
  "Lumière": { level: 0, school: "Évocation", castingTime: "1 action", range: "Contact", duration: "1 heure", attack: "Aucun", effect: "Objet brille sur 6m", classes: ["Barde", "Clerc", "Ensorceleur", "Magicien"] },
  "Lumières dansantes": { level: 0, school: "Évocation", castingTime: "1 action", range: "36m", duration: "Concentration, 1 min", effect: "Crée jusqu'à 4 lumières mobiles (faible lumière).", classes: ["Barde", "Ensorceleur", "Magicien"] },
  "Main de mage": { level: 0, school: "Invocation", castingTime: "1 action", range: "9m", duration: "1 min", attack: "Aucun", effect: "Main spectrale soulevant max 5kg", classes: ["Barde", "Ensorceleur", "Magicien", "Occultiste"] },
  "Message": { level: 0, school: "Transmutation", castingTime: "1 action", range: "36m", duration: "1 round", effect: "Chuchote un message à une cible; elle peut répondre.", classes: ["Barde", "Ensorceleur", "Magicien"] },
  "Moquerie cruelle": { level: 0, school: "Enchantement", castingTime: "1 action", range: "18m", duration: "Instantanée", save: "SAG", damage: "1d4", damageType: "Psychique", effect: "Désavantage à la prochaine attaque", classes: ["Barde"] },
  "Prestidigitation": { level: 0, school: "Transmutation", castingTime: "1 action", range: "3m", duration: "1 heure", effect: "Tours inoffensifs", classes: ["Barde", "Ensorceleur", "Magicien", "Occultiste"] },
  "Réparation": { level: 0, school: "Transmutation", castingTime: "1 minute", range: "Contact", duration: "Instantanée", effect: "Répare une petite fissure/déchirure/casse simple sur un objet.", classes: ["Barde", "Clerc", "Druide", "Ensorceleur", "Magicien"] },
  "Trait de feu": { level: 0, school: "Évocation", castingTime: "1 action", range: "36m", duration: "Instantanée", attack: "Sort distance", damage: "1d10", damageType: "Feu", classes: ["Ensorceleur", "Magicien"] },

  // --- SORTS DE NIVEAU 1 ---
  "Détection de la magie": { level: 1, school: "Divination", castingTime: "1 action", range: "Perso", duration: "Concentration, 10 min", attack: "Aucun", effect: "Détecte les auras magiques proches et leur école.", classes: ["Barde", "Clerc", "Druide", "Ensorceleur", "Magicien", "Occultiste", "Paladin", "Rôdeur"] },
  "Déguisement": { level: 1, school: "Illusion", castingTime: "1 action", range: "Perso", duration: "1 heure", effect: "Change l'apparence via illusion.", classes: ["Barde", "Ensorceleur", "Magicien", "Occultiste"] },
  "Identification": { level: 1, school: "Divination", castingTime: "1 minute", range: "Contact", duration: "Instantanée", effect: "Révèle les propriétés d'un objet magique ou d'un effet.", classes: ["Barde", "Magicien"] },
  "Image silencieuse": { level: 1, school: "Illusion", castingTime: "1 action", range: "18m", duration: "Concentration, 10 min", effect: "Crée une illusion visuelle simple (pas de son).", classes: ["Barde", "Ensorceleur", "Magicien"] },
  "Lueurs féeriques": { level: 1, school: "Évocation", castingTime: "1 action", range: "18m", duration: "Concentration, 1 min", save: "DEX", effect: "Illumine les créatures/objets; elles ne peuvent pas bénéficier d'invisibilité et donnent avantage.", classes: ["Barde", "Druide"] },
  "Armure de mage": { level: 1, school: "Abjuration", castingTime: "1 action", range: "Contact", duration: "8 heures", effect: "CA = 13 + Mod DEX", classes: ["Ensorceleur", "Magicien"] },
  "Bénédiction": { level: 1, school: "Enchantement", castingTime: "1 action", range: "9m", duration: "Concentration, 1 min", attack: "Aucun", effect: "+1d4 attaques/sauvegardes (3 cibles)", classes: ["Clerc", "Paladin"] },
  "Bouclier": { level: 1, school: "Abjuration", castingTime: "1 réaction", range: "Moi", duration: "1 round", effect: "+5 à la CA, annule Projectile Magique", classes: ["Ensorceleur", "Magicien"] },
  "Charme-personne": { level: 1, school: "Enchantement", castingTime: "1 action", range: "9m", duration: "1 heure", save: "SAG", effect: "Charme humanoïde", classes: ["Barde", "Druide", "Ensorceleur", "Magicien", "Occultiste"] },
  "Injonction": { level: 1, school: "Enchantement", castingTime: "1 action", range: "18m", duration: "1 round", save: "SAG", effect: "Cible obéit à un mot", classes: ["Clerc", "Paladin"] },
  "Mains brûlantes": { level: 1, school: "Évocation", castingTime: "1 action", range: "Cône 4.5m", duration: "Instantanée", save: "DEX", damage: "3d6", damageType: "Feu", classes: ["Ensorceleur", "Magicien"] },
  "Maléfice": { level: 1, school: "Enchantement", castingTime: "1 action bonus", range: "27m", duration: "Concentration, 1 heure", effect: "+1d6 nécrotique, désavantage tests carac", classes: ["Occultiste"] },
  "Mot de guérison": { level: 1, school: "Évocation", castingTime: "1 action bonus", range: "18m", duration: "Instantanée", effect: "Soigne 1d4 + Mod Sort", classes: ["Barde", "Clerc", "Druide"] },
  "Projectile magique": { level: 1, school: "Évocation", castingTime: "1 action", range: "36m", duration: "Instantanée", attack: "Touche auto", damage: "1d4+1 x3", damageType: "Force", classes: ["Ensorceleur", "Magicien"] },
  "Soins": { level: 1, school: "Évocation", castingTime: "1 action", range: "Contact", duration: "Instantanée", effect: "Soigne 1d8 + Mod Sort", classes: ["Barde", "Clerc", "Druide", "Paladin", "Rôdeur"] },
  "Sommeil": { level: 1, school: "Enchantement", castingTime: "1 action", range: "27m", duration: "1 min", effect: "Endort 5d8 PV de créatures", classes: ["Barde", "Ensorceleur", "Magicien"] },

  // --- SORTS DE NIVEAU 2 ---
  "Arme spirituelle": { level: 2, school: "Évocation", castingTime: "1 action bonus", range: "18m", duration: "1 min", attack: "Sort corps à corps", damage: "1d8", damageType: "Force", classes: ["Clerc"] },
  "Cécité/Surdité": { level: 2, school: "Nécromancie", castingTime: "1 action", range: "9m", duration: "1 min", save: "CON", effect: "Cible aveuglée ou assourdie", classes: ["Barde", "Clerc", "Ensorceleur", "Magicien"] },
  "Croissance d'épines": { level: 2, school: "Transmutation", castingTime: "1 action", range: "45m", duration: "Concentration, 10 min", effect: "Terrain difficile, 2d4 dégâts par 1.5m", classes: ["Druide", "Rôdeur"] },
  "Fou rire de Tasha": { level: 2, school: "Enchantement", castingTime: "1 action", range: "9m", duration: "Concentration, 1 min", save: "SAG", effect: "Cible tombe à terre en riant", classes: ["Barde", "Magicien"] },
  "Fracasse": { level: 2, school: "Évocation", castingTime: "1 action", range: "18m", duration: "Instantanée", save: "CON", damage: "3d8", damageType: "Tonnerre", classes: ["Barde", "Ensorceleur", "Magicien", "Occultiste"] },
  "Invisibilité": { level: 2, school: "Illusion", castingTime: "1 action", range: "Contact", duration: "Concentration, 1 heure", effect: "Cible invisible jusqu'à attaque/sort", classes: ["Barde", "Ensorceleur", "Magicien", "Occultiste"] },
  "Lévitation": { level: 2, school: "Transmutation", castingTime: "1 action", range: "18m", duration: "Concentration, 10 min", save: "CON", effect: "Cible flotte de 6m", classes: ["Ensorceleur", "Magicien"] },
  "Pas brumeux": { level: 2, school: "Invocation", castingTime: "1 action bonus", range: "Moi", duration: "Instantanée", effect: "Téléportation de 9m", classes: ["Ensorceleur", "Magicien", "Occultiste"] },
  "Rayon ardent": { level: 2, school: "Évocation", castingTime: "1 action", range: "36m", duration: "Instantanée", attack: "Sort distance (3 rayons)", damage: "2d6 par rayon", damageType: "Feu", classes: ["Ensorceleur", "Magicien"] },
  "Toile d'araignée": { level: 2, school: "Invocation", castingTime: "1 action", range: "18m", duration: "Concentration, 1 heure", save: "DEX", effect: "Zone entoilée, créatures entravées", classes: ["Ensorceleur", "Magicien"] },

  // --- SORTS DE NIVEAU 3 ---
  "Animation des morts": { level: 3, school: "Nécromancie", castingTime: "1 min", range: "3m", duration: "Instantanée", effect: "Crée un squelette ou zombie", classes: ["Clerc", "Magicien"] },
  "Boule de feu": { level: 3, school: "Évocation", castingTime: "1 action", range: "45m", duration: "Instantanée", save: "DEX", damage: "8d6", damageType: "Feu", classes: ["Ensorceleur", "Magicien"] },
  "Contresort": { level: 3, school: "Abjuration", castingTime: "1 réaction", range: "18m", duration: "Instantanée", effect: "Interrompt l'incantation d'un sort", classes: ["Ensorceleur", "Magicien", "Occultiste"] },
  "Dissipation de la magie": { level: 3, school: "Abjuration", castingTime: "1 action", range: "36m", duration: "Instantanée", effect: "Met fin à un sort sur une cible", classes: ["Barde", "Clerc", "Druide", "Ensorceleur", "Magicien", "Occultiste", "Paladin"] },
  "Éclair": { level: 3, school: "Évocation", castingTime: "1 action", range: "Moi (Ligne 30m)", duration: "Instantanée", save: "DEX", damage: "8d6", damageType: "Foudre", classes: ["Ensorceleur", "Magicien"] },
  "Esprits gardiens": { level: 3, school: "Invocation", castingTime: "1 action", range: "Moi (Sphère 4.5m)", duration: "Concentration, 10 min", save: "SAG", damage: "3d8", damageType: "Radiant", effect: "Divise vitesse ennemis par 2", classes: ["Clerc"] },
  "Hâte": { level: 3, school: "Transmutation", castingTime: "1 action", range: "9m", duration: "Concentration, 1 min", effect: "Vitesse x2, +2 CA, 1 action suppl.", classes: ["Ensorceleur", "Magicien"] },
  "Mots de guérison de groupe": { level: 3, school: "Évocation", castingTime: "1 action bonus", range: "18m", duration: "Instantanée", effect: "Soigne 1d4 + Mod Sort à 6 créatures", classes: ["Clerc"] },
  "Peur": { level: 3, school: "Illusion", castingTime: "1 action", range: "Cône 9m", duration: "Concentration, 1 min", save: "SAG", effect: "Cibles effrayées et lâchent leurs armes", classes: ["Barde", "Ensorceleur", "Magicien", "Occultiste"] },
  "Revigorer": { level: 3, school: "Nécromancie", castingTime: "1 action", range: "Contact", duration: "Instantanée", effect: "Ressuscite cible morte depuis < 1 min (1 PV)", classes: ["Clerc", "Paladin"] },
  "Vol": { level: 3, school: "Transmutation", castingTime: "1 action", range: "Contact", duration: "Concentration, 10 min", effect: "Vitesse de vol 18m", classes: ["Ensorceleur", "Magicien", "Occultiste"] },

  // --- SORTS DE NIVEAU 4 ---
  "Bannissement": { level: 4, school: "Abjuration", castingTime: "1 action", range: "18m", duration: "Concentration, 1 min", save: "CHA", effect: "Renvoie cible dans un autre plan", classes: ["Clerc", "Ensorceleur", "Magicien", "Paladin"] },
  "Invisibilité suprême": { level: 4, school: "Illusion", castingTime: "1 action", range: "Contact", duration: "Concentration, 1 min", effect: "L'invisibilité ne s'arrête pas à l'attaque", classes: ["Barde", "Ensorceleur", "Magicien"] },
  "Métamorphose": { level: 4, school: "Transmutation", castingTime: "1 action", range: "18m", duration: "Concentration, 1 heure", save: "SAG", effect: "Transforme cible en bête", classes: ["Barde", "Druide", "Ensorceleur", "Magicien"] },
  "Mur de feu": { level: 4, school: "Évocation", castingTime: "1 action", range: "36m", duration: "Concentration, 1 min", save: "DEX", damage: "5d8", damageType: "Feu", classes: ["Druide", "Ensorceleur", "Magicien"] },
  "Porte dimensionnelle": { level: 4, school: "Invocation", castingTime: "1 action", range: "150m", duration: "Instantanée", effect: "Téléportation avec un passager", classes: ["Barde", "Ensorceleur", "Magicien", "Occultiste"] },

  // --- SORTS DE NIVEAU 5 ---
  "Animation des objets": { level: 5, school: "Transmutation", castingTime: "1 action", range: "36m", duration: "Concentration, 1 min", effect: "Anime 10 petits objets pour attaquer", classes: ["Barde", "Ensorceleur", "Magicien"] },
  "Cône de froid": { level: 5, school: "Évocation", castingTime: "1 action", range: "Cône 18m", duration: "Instantanée", save: "CON", damage: "8d8", damageType: "Froid", classes: ["Ensorceleur", "Magicien"] },
  "Domination de personne": { level: 5, school: "Enchantement", castingTime: "1 action", range: "18m", duration: "Concentration, 1 min", save: "SAG", effect: "Contrôle télépathique d'un humanoïde", classes: ["Barde", "Ensorceleur", "Magicien"] },
  "Mur de force": { level: 5, school: "Évocation", castingTime: "1 action", range: "36m", duration: "Concentration, 10 min", effect: "Crée un mur invisible et indestructible", classes: ["Magicien"] },
  "Rappel à la vie": { level: 5, school: "Nécromancie", castingTime: "1 heure", range: "Contact", duration: "Instantanée", effect: "Ressuscite mort depuis < 10 jours", classes: ["Barde", "Clerc", "Paladin"] },

  // --- SORTS DE NIVEAU 6 ---
  "Chaîne d'éclairs": { level: 6, school: "Évocation", castingTime: "1 action", range: "45m", duration: "Instantanée", save: "DEX", damage: "10d8", damageType: "Foudre", effect: "Rebondit sur 3 autres cibles", classes: ["Ensorceleur", "Magicien"] },
  "Désintégration": { level: 6, school: "Transmutation", castingTime: "1 action", range: "18m", duration: "Instantanée", save: "DEX", damage: "10d6 + 40", damageType: "Force", effect: "Réduit en cendres si PV tombe à 0", classes: ["Ensorceleur", "Magicien"] },
  "Guérison": { level: 6, school: "Évocation", castingTime: "1 action", range: "18m", duration: "Instantanée", effect: "Soigne 70 PV", classes: ["Clerc", "Druide"] },

  // --- SORTS DE NIVEAU 7 ---
  "Cage de force": { level: 7, school: "Évocation", castingTime: "1 action", range: "30m", duration: "1 heure", effect: "Enferme la cible, téléportation bloque", classes: ["Barde", "Magicien", "Occultiste"] },
  "Doigt de mort": { level: 7, school: "Nécromancie", castingTime: "1 action", range: "18m", duration: "Instantanée", save: "CON", damage: "7d8 + 30", damageType: "Nécrotique", effect: "Relève en zombie si tué", classes: ["Ensorceleur", "Magicien", "Occultiste"] },
  "Résurrection": { level: 7, school: "Nécromancie", castingTime: "1 heure", range: "Contact", duration: "Instantanée", effect: "Ressuscite mort < 1 siècle", classes: ["Barde", "Clerc"] },

  // --- SORTS DE NIVEAU 8 ---
  "Clone": { level: 8, school: "Nécromancie", castingTime: "1 heure", range: "Contact", duration: "Instantanée", effect: "Crée réceptacle pour l'âme si mort", classes: ["Magicien"] },
  "Explosion solaire": { level: 8, school: "Évocation", castingTime: "1 action", range: "45m", duration: "Instantanée", save: "CON", damage: "12d6", damageType: "Radiant", effect: "Aveugle les cibles", classes: ["Druide", "Ensorceleur", "Magicien"] },
  "Tremblement de terre": { level: 8, school: "Évocation", castingTime: "1 action", range: "150m", duration: "Concentration, 1 min", save: "DEX", effect: "Destruction de bâtiments, sol se fissure", classes: ["Clerc", "Druide", "Ensorceleur"] },

  // --- SORTS DE NIVEAU 9 ---
  "Arrêt du temps": { level: 9, school: "Transmutation", castingTime: "1 action", range: "Moi", duration: "Instantanée", effect: "Joue 1d4 + 1 tours de suite", classes: ["Ensorceleur", "Magicien"] },
  "Essaim de météores": { level: 9, school: "Évocation", castingTime: "1 action", range: "1,5 km", duration: "Instantanée", save: "DEX", damage: "20d6 Feu + 20d6 Contondant", damageType: "Mixte", effect: "4 sphères de 12m de rayon", classes: ["Ensorceleur", "Magicien"] },
  "Mot de pouvoir mortel": { level: 9, school: "Enchantement", castingTime: "1 action", range: "18m", duration: "Instantanée", effect: "Mort instantanée si cible < 100 PV", classes: ["Barde", "Ensorceleur", "Magicien", "Occultiste"] },
  "Souhait": { level: 9, school: "Invocation", castingTime: "1 action", range: "Moi", duration: "Instantanée", effect: "Le sort le plus puissant, altère la réalité", classes: ["Ensorceleur", "Magicien"] }
};