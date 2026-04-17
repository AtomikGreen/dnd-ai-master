/**
 * Avantage / désavantage pour jets PJ (hors attaque — voir computeAttackRollAdvDis).
 * S'appuie sur le pending roll (engineContext / rollMode) et sur l'état du personnage.
 */

import { normalizeCombatantConditions } from "@/lib/combatAdvantage";

/** @param {string[]} arr @param {string} key */
function hasCond(arr, key) {
  const k = String(key ?? "").toLowerCase().trim();
  return arr.some((x) => String(x).toLowerCase().trim() === k);
}

/**
 * Sauvegarde de caractéristique (D&D 5e — sous-ensemble utile au moteur).
 * @param {string} saveStat ex. "DEX", "CON"
 * @param {unknown} conditionsSource entité ou { conditions: string[] }
 */
export function computeSavingThrowAdvDis(saveStat, conditionsSource) {
  const conditions = normalizeCombatantConditions(
    conditionsSource && typeof conditionsSource === "object" && Array.isArray(conditionsSource.conditions)
      ? conditionsSource
      : { conditions: Array.isArray(conditionsSource) ? conditionsSource : [] }
  );
  let adv = false;
  let dis = false;
  /** @type {string[]} */
  const reasonsAdv = [];
  /** @type {string[]} */
  const reasonsDis = [];

  const stat = String(saveStat ?? "").toUpperCase().trim();

  if (hasCond(conditions, "blinded") && stat === "DEX") {
    dis = true;
    reasonsDis.push("aveuglé (jet de DEX)");
  }
  if (hasCond(conditions, "restrained") && stat === "DEX") {
    dis = true;
    reasonsDis.push("entravé (jet de DEX)");
  }

  if (adv && dis) {
    return {
      adv: false,
      dis: false,
      mode: "cancelled",
      label: "avantage et désavantage s'annulent",
    };
  }
  if (adv) {
    return { adv: true, dis: false, mode: "advantage", label: reasonsAdv.join(" ; ") || "avantage" };
  }
  if (dis) {
    return { adv: false, dis: true, mode: "disadvantage", label: reasonsDis.join(" ; ") || "désavantage" };
  }
  return { adv: false, dis: false, mode: "normal", label: "" };
}

/**
 * @param {Record<string, any> | null | undefined} roll pendingRoll
 * @param {Record<string, any> | null | undefined} player
 */
export function resolvePendingRollAdvDis(roll, player) {
  if (!roll || typeof roll !== "object") {
    return { adv: false, dis: false, mode: "normal", label: "" };
  }
  const ec =
    roll.engineContext && typeof roll.engineContext === "object" ? roll.engineContext : {};

  if (roll.rollMode === "advantage") {
    return {
      adv: true,
      dis: false,
      mode: "advantage",
      label: String(roll.advDisReason ?? ec.advDisReason ?? "avantage"),
    };
  }
  if (roll.rollMode === "disadvantage") {
    return {
      adv: false,
      dis: true,
      mode: "disadvantage",
      label: String(roll.advDisReason ?? ec.advDisReason ?? "désavantage"),
    };
  }
  if (roll.rollMode === "cancelled") {
    return {
      adv: true,
      dis: true,
      mode: "cancelled",
      label: String(roll.advDisReason ?? ec.advDisReason ?? "annulation"),
    };
  }

  if (ec.advantage === true) {
    return { adv: true, dis: false, mode: "advantage", label: String(ec.advDisReason ?? "avantage") };
  }
  if (ec.disadvantage === true) {
    return { adv: false, dis: true, mode: "disadvantage", label: String(ec.advDisReason ?? "désavantage") };
  }

  const conds = normalizeCombatantConditions({ conditions: player?.conditions });

  if (roll.kind === "death_save") {
    // Règle maison optionnelle : l'empoisonnement pénalise le jet contre la mort (affichage + mécanique).
    if (hasCond(conds, "poisoned")) {
      return { adv: false, dis: true, mode: "disadvantage", label: "empoisonné" };
    }
    return { adv: false, dis: false, mode: "normal", label: "" };
  }

  if (roll.kind === "check" || roll.kind === "save") {
    if (hasCond(conds, "poisoned")) {
      return { adv: false, dis: true, mode: "disadvantage", label: "empoisonné" };
    }
    if (hasCond(conds, "blinded")) {
      const sk = String(roll.skill ?? "").toLowerCase();
      if (
        sk === "perception" ||
        sk === "investigation" ||
        (typeof roll.raison === "string" && /vue|voir|regard|visuel/i.test(roll.raison))
      ) {
        return { adv: false, dis: true, mode: "disadvantage", label: "aveuglé (test visuel)" };
      }
    }
  }

  return { adv: false, dis: false, mode: "normal", label: "" };
}
