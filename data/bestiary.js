export const BESTIARY = {
  goblin: {
    id: "goblin",
    name: "Gobelin",
    type: "hostile",
    race: "Humanoïde (gobelinoïde), taille P",
    entityClass: "Guerrier gobelin",
    cr: 0.25,
    hp: { current: 7, max: 7 },
    ac: 15,
    stats: { FOR: 8, DEX: 14, CON: 10, INT: 10, SAG: 8, CHA: 8 },
    attackBonus: 4,
    damageDice: "1d6",
    damageBonus: 2,
    weapons: [
      {
        name: "Cimeterre",
        attackBonus: 4,
        damageDice: "1d6",
        damageBonus: 2,
        kind: "melee",
        reach: "1,50 m",
      },
      {
        name: "Arc court",
        attackBonus: 4,
        damageDice: "1d6",
        damageBonus: 2,
        kind: "ranged",
        range: "24/96 m",
      },
    ],
    stealthDc: 16,
    description:
      "Petit humanoïde malveillant, rapide et sournois, équipé d'un cimeterre et d'un arc court.",
    senses: {
      darkvision: "18 m",
      passivePerception: 9,
    },
    languages: ["commun", "gobelin"],
    features: [
      "Fuite agile: peut Se cacher ou Se désengager en action bonus.",
    ],
    actions: [
      "Cimeterre: +4 pour toucher, allonge 1,50 m, 1d6+2 dégâts tranchants.",
      "Arc court: +4 pour toucher, portée 24/96 m, 1d6+2 dégâts perforants.",
    ],
  },
};

