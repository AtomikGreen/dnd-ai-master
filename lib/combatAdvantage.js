/**
 * Avantage / désavantage sur les jets d'attaque (D&D 5e 2014).
 * Annulation si les deux : un seul d20 (mode "cancelled" géré par rollNatWithAdvDis).
 */

/** @param {unknown} c */
export function normalizeCombatantConditions(c) {
  const raw = c && typeof c === "object" ? c.conditions : null;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => String(x ?? "").trim().toLowerCase())
    .filter(Boolean);
}

/** @param {string[]} arr @param {string} key */
function hasCond(arr, key) {
  const k = String(key ?? "").toLowerCase().trim();
  return arr.some((x) => String(x).toLowerCase().trim() === k);
}

/**
 * @param {object} opts
 * @param {boolean} [opts.attackerHidden] combatHiddenIds — avantage attaquant
 * @param {boolean} [opts.targetHidden]
 * @param {string[]} [opts.attackerConditions]
 * @param {string[]} [opts.targetConditions]
 * @param {boolean} [opts.isMeleeAttack]
 * @param {boolean} [opts.isRangedAttack]
 * @param {boolean} [opts.attackerRangedWeaponInMelee] arme à distance alors qu'un hostile est au CàC
 * @param {boolean} [opts.targetHasDodgeActive] cible a utilisé Esquive ce round (jusqu'au prochain tour)
 * @param {boolean} [opts.attackerRecklessAttack] barbare : avantage attaque de Force au corps à corps (désavantage défense : non modélisé ici)
 */
export function computeAttackRollAdvDis(opts = {}) {
  const {
    attackerHidden = false,
    targetHidden = false,
    attackerConditions = [],
    targetConditions = [],
    isMeleeAttack = false,
    isRangedAttack = false,
    attackerRangedWeaponInMelee = false,
    targetHasDodgeActive = false,
  } = opts;

  let adv = false;
  let dis = false;
  /** @type {string[]} */
  const reasonsAdv = [];
  /** @type {string[]} */
  const reasonsDis = [];

  const pushAdv = (r) => {
    adv = true;
    reasonsAdv.push(r);
  };
  const pushDis = (r) => {
    dis = true;
    reasonsDis.push(r);
  };

  if (attackerHidden) pushAdv("attaquant caché (Discrétion)");
  if (targetHidden) pushDis("cible cachée");

  if (hasCond(targetConditions, "prone")) {
    if (isMeleeAttack) pushAdv("cible à terre (mêlée)");
    if (isRangedAttack) pushDis("cible à terre (distance)");
  }
  if (hasCond(attackerConditions, "prone")) {
    pushDis("attaquant à terre");
  }

  if (hasCond(attackerConditions, "blinded")) pushDis("aveuglé");
  if (hasCond(targetConditions, "blinded")) pushAdv("cible aveuglée");

  if (hasCond(attackerConditions, "restrained")) pushDis("entravé");
  if (hasCond(targetConditions, "restrained")) pushAdv("cible entravée");

  if (hasCond(attackerConditions, "poisoned")) pushDis("empoisonné");

  if (hasCond(attackerConditions, "invisible")) pushAdv("attaquant invisible");
  if (hasCond(targetConditions, "invisible")) pushDis("cible invisible");

  if (hasCond(targetConditions, "paralyzed") || hasCond(targetConditions, "unconscious")) {
    pushAdv("cible neutralisée (paralysé/inconscient)");
  }
  if (hasCond(targetConditions, "petrified")) {
    pushAdv("cible pétrifiée");
  }

  if (targetHasDodgeActive) pushDis("Esquive (cible)");

  if (attackerRangedWeaponInMelee) pushDis("arme à distance au corps à corps");

  if (adv && dis) {
    return {
      adv: false,
      dis: false,
      mode: "cancelled",
      reasonsAdv,
      reasonsDis,
      label: "avantage et désavantage s'annulent",
    };
  }
  if (adv) {
    return {
      adv: true,
      dis: false,
      mode: "advantage",
      reasonsAdv,
      reasonsDis,
      label: reasonsAdv.join(" ; ") || "avantage",
    };
  }
  if (dis) {
    return {
      adv: false,
      dis: true,
      mode: "disadvantage",
      reasonsAdv,
      reasonsDis,
      label: reasonsDis.join(" ; ") || "désavantage",
    };
  }
  return {
    adv: false,
    dis: false,
    mode: "normal",
    reasonsAdv: [],
    reasonsDis: [],
    label: "",
  };
}
