/**
 * États de combat à durée en « pas d'initiative » : à chaque début de tour d'un combattant,
 * le moteur décrémente `rounds` pour tous les combattants ; à 0 l'entrée est retirée.
 *
 * Ex. Bouclier : { stateId: "bouclier", rounds: N } avec N = taille de l'ordre pour ~1 round de table.
 */

export const COMBAT_TIMED_STATE_IDS = {
  BOUCLIER: "bouclier",
};

const AC_BONUS_BY_STATE_ID = {
  [COMBAT_TIMED_STATE_IDS.BOUCLIER]: 5,
};

/**
 * @param {unknown} raw
 * @returns {{ stateId: string, rounds: number }[]}
 */
export function normalizeCombatTimedStates(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const stateId = String(item.stateId ?? item.id ?? "").trim();
    const rounds = Math.trunc(Number(item.rounds));
    if (!stateId || !Number.isFinite(rounds) || rounds <= 0) continue;
    out.push({ stateId, rounds: Math.max(1, rounds) });
  }
  return out;
}

/**
 * @param {unknown} states
 * @returns {{ stateId: string, rounds: number }[]}
 */
export function decrementCombatTimedStatesOneTick(states) {
  return normalizeCombatTimedStates(states)
    .map((e) => ({ ...e, rounds: e.rounds - 1 }))
    .filter((e) => e.rounds > 0);
}

/**
 * @param {unknown} states
 * @returns {number}
 */
export function getAcBonusFromCombatTimedStates(states) {
  let bonus = 0;
  for (const e of normalizeCombatTimedStates(states)) {
    const add = AC_BONUS_BY_STATE_ID[e.stateId];
    if (typeof add === "number" && add > 0) bonus += add;
  }
  return bonus;
}

/**
 * @param {unknown} states
 * @param {string} stateId
 * @param {number} rounds
 * @returns {{ stateId: string, rounds: number }[]}
 */
export function upsertCombatTimedState(states, stateId, rounds) {
  const sid = String(stateId ?? "").trim();
  const r = Math.trunc(Number(rounds));
  const base = normalizeCombatTimedStates(states).filter((e) => e.stateId !== sid);
  if (!sid || !Number.isFinite(r) || r <= 0) return base;
  base.push({ stateId: sid, rounds: Math.max(1, r) });
  return base;
}

/**
 * @param {{ stateId: string, rounds: number }[]} states
 * @returns {string}
 */
export function formatCombatTimedStatesShort(states) {
  const n = normalizeCombatTimedStates(states);
  if (n.length === 0) return "";
  return n.map((e) => `${e.stateId} (${e.rounds})`).join(", ");
}
