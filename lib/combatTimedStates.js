const COMBAT_TIMED_STATE_IDS = Object.freeze({
  BOUCLIER: "bouclier",
});

const AC_BONUS_BY_STATE_ID = Object.freeze({
  [COMBAT_TIMED_STATE_IDS.BOUCLIER]: 5,
});

function toPositiveInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.trunc(n));
}

function normalizeCombatTimedStates(states) {
  if (!Array.isArray(states)) return [];
  const byId = new Map();
  for (const entry of states) {
    if (!entry || typeof entry !== "object") continue;
    const stateId = String(entry.stateId ?? "").trim();
    if (!stateId) continue;
    const rounds = toPositiveInt(entry.rounds, 0);
    if (rounds <= 0) continue;
    const prev = byId.get(stateId);
    if (!prev || rounds > prev.rounds) {
      byId.set(stateId, { stateId, rounds });
    }
  }
  return [...byId.values()];
}

function decrementCombatTimedStatesOneTick(states) {
  const current = normalizeCombatTimedStates(states);
  const next = current
    .map((entry) => ({ stateId: entry.stateId, rounds: toPositiveInt(entry.rounds, 0) - 1 }))
    .filter((entry) => entry.rounds > 0);
  return normalizeCombatTimedStates(next);
}

function getAcBonusFromCombatTimedStates(states) {
  const current = normalizeCombatTimedStates(states);
  let total = 0;
  for (const entry of current) {
    total += AC_BONUS_BY_STATE_ID[entry.stateId] ?? 0;
  }
  return total;
}

function upsertCombatTimedState(states, stateId, rounds) {
  const sid = String(stateId ?? "").trim();
  const nextRounds = toPositiveInt(rounds, 0);
  if (!sid || nextRounds <= 0) return normalizeCombatTimedStates(states);
  const current = normalizeCombatTimedStates(states).filter((entry) => entry.stateId !== sid);
  current.push({ stateId: sid, rounds: nextRounds });
  return normalizeCombatTimedStates(current);
}

export {
  COMBAT_TIMED_STATE_IDS,
  decrementCombatTimedStatesOneTick,
  getAcBonusFromCombatTimedStates,
  normalizeCombatTimedStates,
  upsertCombatTimedState,
};
