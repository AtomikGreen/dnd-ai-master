/**
 * Résolution mécanique des sorts (buffs, sauvegardes sans dégâts, portée personnelle).
 */

/** Sauvegarde avec dégâts (ex. Flamme sacrée) vs sauvegarde purement mentale (ex. Injonction). */
export function spellHasDamageOnSave(spell) {
  if (!spell || typeof spell !== "object") return false;
  return String(spell.damage ?? "").trim().length > 0;
}

/**
 * Règle des dégâts en cas de sauvegarde réussie.
 * - "half" (défaut): moitié dégâts
 * - "none": aucun dégât
 */
export function spellSaveDamageOnSuccessMode(spell) {
  const raw = String(spell?.saveDamageOnSuccess ?? spell?.saveSuccessDamage ?? "")
    .trim()
    .toLowerCase();
  if (raw === "none" || raw === "aucun" || raw === "0" || raw === "zero") return "none";
  if (raw === "half" || raw === "moitie" || raw === "moitié" || raw === "demi") return "half";
  return "half";
}

/** Sorts à portée « sur soi » (Perso / Self) — cible forcée au lanceur. */
export function spellIsPersonalRange(spell) {
  const r = String(spell?.range ?? "").trim().toLowerCase();
  if (!r) return false;
  if (r === "perso" || r === "self" || r === "moi") return true;
  if (/^personnelle\b/i.test(String(spell?.range ?? ""))) return true;
  return false;
}

/** Sorts utilitaires gérés par le moteur (pas attaque / pas soin direct / pas dégâts auto). */
export function isEngineHandledUtilitySpell(spellName) {
  const n = String(spellName ?? "").trim();
  return (
    n === "Assistance" ||
    n === "Bénédiction" ||
    n === "Lumière" ||
    n === "Détection de la magie" ||
    n === "Main de mage"
  );
}

export const BUFF_GUIDANCE = "buff:guidance";
export const BUFF_GUIDANCE_EXPIRES_AT_PREFIX = "expires_at_min:";
export const BUFF_BLESS = "buff:bénédiction";
export const BUFF_LIGHT = "buff:lumière";
export const BUFF_DETECT_MAGIC = "buff:détection magie";

export const CONDITION_INJONCTION_SKIP = "Injonction (obéit) — perd son tour";

/** @param {string[]|undefined} conditions */
export function mergeConditions(conditions, add) {
  const arr = Array.isArray(conditions) ? [...conditions] : [];
  const toAdd = Array.isArray(add) ? add : [add];
  for (const c of toAdd) {
    const s = String(c ?? "").trim();
    if (!s) continue;
    if (!arr.includes(s)) arr.push(s);
  }
  return arr;
}

/** Retire la concentration précédente (une seule à la fois). */
export function replaceConcentration(conditions, spellName) {
  const arr = Array.isArray(conditions) ? [...conditions] : [];
  const filtered = arr.filter((c) => !String(c).startsWith("concentration:"));
  filtered.push(`concentration:${spellName}`);
  return filtered;
}

/** @param {string[]|undefined} conditions */
export function stripConcentrationCondition(conditions) {
  const arr = Array.isArray(conditions) ? [...conditions] : [];
  return arr.filter((c) => !String(c).startsWith("concentration:"));
}

/** @param {string[]|undefined} conditions */
export function getActiveConcentrationSpellName(conditions) {
  const arr = Array.isArray(conditions) ? conditions : [];
  const raw = arr.find((c) => String(c).startsWith("concentration:"));
  if (!raw) return null;
  const name = String(raw).slice("concentration:".length).trim();
  return name || null;
}

/** @param {string[]|undefined} conditions */
export function stripGuidanceBuff(conditions) {
  const arr = Array.isArray(conditions) ? [...conditions] : [];
  return arr.filter((c) => {
    const s = String(c);
    return !s.includes(BUFF_GUIDANCE) && !/assistance.*1d4/i.test(s);
  });
}

/** @param {string[]|undefined} conditions */
export function hasBlessBuff(conditions) {
  const arr = Array.isArray(conditions) ? conditions : [];
  return arr.some((c) => String(c).includes(BUFF_BLESS) || /bénédiction.*\+1d4/i.test(String(c)));
}

function parseGuidanceExpiryMinute(rawCondition) {
  const s = String(rawCondition ?? "");
  const m = s.match(/expires_at_min:(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.trunc(n));
}

export function makeTimedGuidanceBuff(expiresAtMinute) {
  const safeMinute = Math.max(0, Math.trunc(Number(expiresAtMinute) || 0));
  return `${BUFF_GUIDANCE}|${BUFF_GUIDANCE_EXPIRES_AT_PREFIX}${safeMinute}`;
}

/** @param {string[]|undefined} conditions */
export function hasGuidanceBuff(conditions, worldMinute = null) {
  const arr = Array.isArray(conditions) ? conditions : [];
  return arr.some((c) => {
    const s = String(c);
    if (!(s.includes(BUFF_GUIDANCE) || /assistance.*\+1d4/i.test(s))) return false;
    if (worldMinute == null) return true;
    const exp = parseGuidanceExpiryMinute(s);
    if (exp == null) return true;
    return Math.trunc(Number(worldMinute) || 0) < exp;
  });
}

/** @param {string[]|undefined} conditions */
export function stripExpiredGuidanceBuff(conditions, worldMinute) {
  const arr = Array.isArray(conditions) ? [...conditions] : [];
  const now = Math.max(0, Math.trunc(Number(worldMinute) || 0));
  return arr.filter((c) => {
    const s = String(c);
    if (!s.includes(BUFF_GUIDANCE) && !/assistance.*\+1d4/i.test(s)) return true;
    const exp = parseGuidanceExpiryMinute(s);
    if (exp == null) return true;
    return now < exp;
  });
}

/** @param {string[]|undefined} conditions */
export function stripBlessBuff(conditions) {
  const arr = Array.isArray(conditions) ? [...conditions] : [];
  return arr.filter((c) => {
    const s = String(c);
    return !s.includes(BUFF_BLESS) && !/bénédiction.*\+1d4/i.test(s);
  });
}

/** @param {string[]|undefined} conditions */
export function stripDetectMagicBuff(conditions) {
  const arr = Array.isArray(conditions) ? [...conditions] : [];
  return arr.filter((c) => {
    const s = String(c);
    return !s.includes(BUFF_DETECT_MAGIC) && !/détection.*magie|detection.*magie/i.test(s);
  });
}

function normalizeSpellKey(spellName) {
  return String(spellName ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

const CONCENTRATION_EFFECT_STRIPPERS = {
  assistance: stripGuidanceBuff,
  benediction: stripBlessBuff,
  "detection de la magie": stripDetectMagicBuff,
};

/** Retire les effets mécaniques connus liés à un sort de concentration donné. */
export function stripConcentrationBoundEffectsForSpell(conditions, spellName) {
  const arr = Array.isArray(conditions) ? conditions : [];
  const key = normalizeSpellKey(spellName);
  const stripper = CONCENTRATION_EFFECT_STRIPPERS[key];
  return stripper ? stripper(arr) : arr;
}

/** @param {string[]|undefined} conditions */
export function shouldSkipTurnForCommand(conditions) {
  const arr = Array.isArray(conditions) ? conditions : [];
  return arr.some((c) => {
    const s = String(c);
    return s.includes(CONDITION_INJONCTION_SKIP) || (/injonction/i.test(s) && /perd son tour/i.test(s));
  });
}

/** @param {string[]|undefined} conditions */
export function stripCommandSkipTurn(conditions) {
  const arr = Array.isArray(conditions) ? [...conditions] : [];
  return arr.filter((c) => {
    const s = String(c);
    return !s.includes(CONDITION_INJONCTION_SKIP) && !(/injonction/i.test(s) && /perd son tour/i.test(s));
  });
}

/**
 * Jusqu'à 3 cibles alliées pour Bénédiction : le lanceur, la cible principale, puis d'autres alliés vivants.
 * @param {object[]} entities
 */
export function pickBlessTargetEntities(casterId, primaryTarget, entities, limit = 3) {
  return pickBlessTargetEntitiesWithLimit(casterId, primaryTarget, entities, limit);
}

/**
 * Déduit la limite de cibles voulue pour Bénédiction depuis le texte joueur.
 * Défaut D&D : jusqu'à 3 cibles.
 */
export function inferBlessTargetLimitFromText(text) {
  const t = String(text ?? "").toLowerCase();
  if (!t) return 3;
  if (
    /\b(uniquement|seulement|juste)\s+(moi|moi-même)\b/i.test(t) ||
    /\b(sur|pour)\s+moi\b/i.test(t) ||
    /\bune?\s+seule?\s+cible\b/i.test(t) ||
    /\b1\s*cible\b/i.test(t)
  ) {
    return 1;
  }
  if (/\bnous\s+deux\b/i.test(t) || /\bdeux\s+cibles?\b/i.test(t) || /\b2\s*cibles?\b/i.test(t)) {
    return 2;
  }
  if (/\bnous\s+trois\b/i.test(t) || /\btrois\s+cibles?\b/i.test(t) || /\b3\s*cibles?\b/i.test(t)) {
    return 3;
  }
  return 3;
}

export function pickBlessTargetEntitiesWithLimit(casterId, primaryTarget, entities, limit = 3) {
  const pool = Array.isArray(entities) ? entities : [];
  const out = [];
  const maxTargets = Math.max(1, Math.min(3, Math.trunc(Number(limit) || 3)));
  const push = (e) => {
    if (!e || e.isAlive === false || e.visible === false) return;
    if (String(e.type ?? "").toLowerCase() === "hostile") return;
    if (out.some((x) => x.id === e.id)) return;
    out.push(e);
  };
  push(pool.find((e) => e && String(e.id) === String(casterId)));
  push(primaryTarget);
  for (const e of pool) {
    if (out.length >= maxTargets) break;
    push(e);
  }
  return out.slice(0, maxTargets);
}
