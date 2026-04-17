/**
 * Composantes d'incantation D&D 5e (SRD 2014 / PHB) pour les sorts du fichier `SPELLS` (noms français).
 * — V : verbal · S : somatique · M : matérielle (sans coût en po sauf si materialCostly).
 * materialCostly : le focaliseur ne remplace pas — il faut l’objet précis (vérification souple via materialKeywords + inventaire).
 */
export const SPELL_COMPONENTS_SRD2014 = {
  // Tours de magie
  Amis: { verbal: true, somatic: true, material: false },
  "Aspersion acide": { verbal: true, somatic: true, material: false },
  Assistance: { verbal: true, somatic: true, material: false },
  "Bouffée de poison": { verbal: true, somatic: true, material: false },
  "Contact glacial": { verbal: true, somatic: true, material: false },
  "Coup au but": { verbal: false, somatic: true, material: false },
  "Explosion occulte": { verbal: true, somatic: true, material: false },
  "Flamme sacrée": { verbal: true, somatic: true, material: false },
  "Illusion mineure": { verbal: false, somatic: true, material: true },
  Lumière: { verbal: true, somatic: false, material: true },
  "Lumières dansantes": { verbal: true, somatic: true, material: true },
  "Main de mage": { verbal: true, somatic: true, material: false },
  Message: { verbal: true, somatic: true, material: true },
  "Moquerie cruelle": { verbal: true, somatic: false, material: false },
  Prestidigitation: { verbal: true, somatic: true, material: false },
  Réparation: { verbal: true, somatic: true, material: true },
  "Trait de feu": { verbal: true, somatic: true, material: false },

  // Niveau 1
  "Détection de la magie": { verbal: true, somatic: true, material: false },
  Déguisement: { verbal: true, somatic: true, material: false },
  Identification: {
    verbal: true,
    somatic: true,
    material: true,
    materialCostly: true,
    materialKeywords: ["perle", "pearl"],
  },
  "Image silencieuse": { verbal: true, somatic: true, material: true },
  "Lueurs féeriques": { verbal: true, somatic: false, material: false },
  "Armure de mage": { verbal: true, somatic: true, material: true },
  Bénédiction: { verbal: true, somatic: true, material: true },
  Bouclier: { verbal: true, somatic: true, material: false },
  "Charme-personne": { verbal: true, somatic: true, material: false },
  Injonction: { verbal: true, somatic: false, material: false },
  "Mains brûlantes": { verbal: true, somatic: true, material: false },
  Maléfice: { verbal: true, somatic: true, material: true },
  "Mot de guérison": { verbal: true, somatic: false, material: false },
  "Projectile magique": { verbal: true, somatic: true, material: false },
  Soins: { verbal: true, somatic: true, material: false },
  Sommeil: { verbal: true, somatic: true, material: true },

  // Niveau 2
  "Arme spirituelle": { verbal: true, somatic: true, material: false },
  "Cécité/Surdité": { verbal: true, somatic: false, material: false },
  "Croissance d'épines": { verbal: true, somatic: true, material: true },
  "Fou rire de Tasha": { verbal: true, somatic: true, material: true },
  Fracasse: { verbal: true, somatic: true, material: true },
  Invisibilité: { verbal: true, somatic: true, material: true },
  Lévitation: { verbal: true, somatic: true, material: true },
  "Pas brumeux": { verbal: true, somatic: false, material: false },
  "Rayon ardent": { verbal: true, somatic: true, material: false },
  "Toile d'araignée": { verbal: true, somatic: true, material: true },

  // Niveau 3
  "Animation des morts": { verbal: true, somatic: true, material: true },
  "Boule de feu": { verbal: true, somatic: true, material: true },
  Contresort: { verbal: false, somatic: true, material: false },
  "Dissipation de la magie": { verbal: true, somatic: true, material: false },
  Éclair: { verbal: true, somatic: true, material: true },
  "Esprits gardiens": { verbal: true, somatic: true, material: true },
  Hâte: { verbal: true, somatic: true, material: true },
  "Mots de guérison de groupe": { verbal: true, somatic: false, material: false },
  Peur: { verbal: true, somatic: true, material: true },
  Revigorer: {
    verbal: true,
    somatic: true,
    material: true,
    materialCostly: true,
    materialKeywords: ["diamant", "diamond"],
  },
  Vol: { verbal: true, somatic: true, material: true },

  // Niveau 4
  Bannissement: { verbal: true, somatic: true, material: true },
  "Invisibilité suprême": { verbal: true, somatic: true, material: false },
  Métamorphose: { verbal: true, somatic: true, material: true },
  "Mur de feu": { verbal: true, somatic: true, material: true },
  "Porte dimensionnelle": { verbal: true, somatic: false, material: false },

  // Niveau 5
  "Animation des objets": { verbal: true, somatic: true, material: false },
  "Cône de froid": { verbal: true, somatic: true, material: true },
  "Domination de personne": { verbal: true, somatic: true, material: false },
  "Mur de force": { verbal: true, somatic: true, material: true },
  "Rappel à la vie": {
    verbal: true,
    somatic: true,
    material: true,
    materialCostly: true,
    materialKeywords: ["diamant", "diamond"],
  },

  // Niveau 6
  "Chaîne d'éclairs": { verbal: true, somatic: true, material: true },
  Désintégration: { verbal: true, somatic: true, material: true },
  Guérison: { verbal: true, somatic: true, material: false },

  // Niveau 7
  "Cage de force": { verbal: true, somatic: true, material: true },
  "Doigt de mort": { verbal: true, somatic: true, material: false },
  Résurrection: {
    verbal: true,
    somatic: true,
    material: true,
    materialCostly: true,
    materialKeywords: ["diamant", "diamond"],
  },

  // Niveau 8
  Clone: {
    verbal: true,
    somatic: true,
    material: true,
    materialCostly: true,
    materialKeywords: ["diamant", "diamond", "récipient", "recipient"],
  },
  "Explosion solaire": { verbal: true, somatic: true, material: true },
  "Tremblement de terre": { verbal: true, somatic: true, material: true },

  // Niveau 9
  "Arrêt du temps": { verbal: true, somatic: false, material: false },
  "Essaim de météores": { verbal: true, somatic: true, material: false },
  "Mot de pouvoir mortel": { verbal: true, somatic: false, material: false },
  Souhait: { verbal: true, somatic: false, material: false },
};
