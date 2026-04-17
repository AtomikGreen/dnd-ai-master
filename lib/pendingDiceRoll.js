/**
 * Construction de jets en attente (pendingRoll) avec libellés cohérents.
 * Les modificateurs (totalBonus) s'ajoutent aux résultats naturels des dés, pas aux faces.
 */

/**
 * Sépare la partie dés d'une notation simple "XdY±N" (sans répétition "xN").
 * @returns {{ diceNotation: string, flatBonus: number }}
 */
export function splitDiceNotationAndFlatBonus(notation) {
  const raw = String(notation ?? "1d4").trim();
  if (!raw) return { diceNotation: "1d4", flatBonus: 0 };

  /** Ex. « 1d4+1 x3 » ou « 1d4+1 ×3 » (Projectile magique) → 3d4 + 3 */
  const repeatMatch = raw.match(/^(.+?)\s+[x×]\s*(\d+)\s*$/i);
  if (repeatMatch) {
    const base = repeatMatch[1].trim();
    const times = parseInt(repeatMatch[2], 10);
    if (Number.isFinite(times) && times >= 1 && times <= 20) {
      const inner = splitDiceNotationAndFlatBonus(base);
      const { count, sides } = parseXdYDiceNotation(inner.diceNotation);
      const flat = Number(inner.flatBonus) || 0;
      return {
        diceNotation: `${count * times}d${sides}`,
        flatBonus: flat * times,
      };
    }
  }

  const withMod = raw.match(/^(\d*)d(\d+)([+-]\d+)$/i);
  if (withMod) {
    const count = withMod[1] === "" ? 1 : parseInt(withMod[1], 10);
    const sides = parseInt(withMod[2], 10);
    const mod = parseInt(withMod[3], 10);
    if (!Number.isFinite(count) || !Number.isFinite(sides) || count <= 0 || sides <= 0) {
      return { diceNotation: "1d4", flatBonus: 0 };
    }
    return { diceNotation: `${count}d${sides}`, flatBonus: mod };
  }

  const m = raw.match(/^(\d+)d(\d+)$/i) ?? raw.match(/^d(\d+)$/i);
  if (!m) return { diceNotation: "1d4", flatBonus: 0 };
  const count = m.length === 2 ? 1 : parseInt(m[1], 10);
  const sides = m.length === 2 ? parseInt(m[1], 10) : parseInt(m[2], 10);
  if (!Number.isFinite(count) || !Number.isFinite(sides) || count <= 0 || sides <= 0) {
    return { diceNotation: "1d4", flatBonus: 0 };
  }
  return { diceNotation: `${count}d${sides}`, flatBonus: 0 };
}

/** Parse "XdY" → { count, sides } */
export function parseXdYDiceNotation(diceNotation) {
  const m = /^(\d+)d(\d+)$/i.exec(String(diceNotation ?? "").trim());
  if (!m) return { count: 1, sides: 20 };
  return { count: parseInt(m[1], 10), sides: parseInt(m[2], 10) };
}

/** Coup critique 5e : on double les dés de dégâts (ex. 1d8 → 2d8, 2d6 → 4d6). */
export function doubleWeaponDiceNotationDiceOnly(diceNotation) {
  const { count, sides } = parseXdYDiceNotation(diceNotation);
  return `${count * 2}d${sides}`;
}

/**
 * Aplatit la notation brute (ex. « 1d4+1 x3 » → jet « 3d4 », bonus +3) pour stockage cohérent sur pendingRoll.roll.
 */
export function normalizePendingDamageRollNotation(rawRoll, totalBonus = 0) {
  const split = splitDiceNotationAndFlatBonus(String(rawRoll ?? "").trim() || "1d4");
  return {
    roll: split.diceNotation,
    totalBonus: (Number(totalBonus) || 0) + (Number(split.flatBonus) || 0),
  };
}

/**
 * Pour UI / validation : supporte les anciens pendingRoll non normalisés (notation encore brute).
 */
export function getPendingRollDiceDescriptor(piece) {
  const raw = String(piece?.roll ?? "").trim();
  const split = splitDiceNotationAndFlatBonus(raw || "1d20");
  const { count, sides } = parseXdYDiceNotation(split.diceNotation);
  const mergedBonus = (Number(piece?.totalBonus) || 0) + (Number(split.flatBonus) || 0);
  return {
    rollNotation: split.diceNotation,
    diceCount: count,
    diceSides: sides,
    displayTotalBonus: mergedBonus,
  };
}

/**
 * @param {{
 *   kind?: string,
 *   roll: string,
 *   totalBonus?: number,
 *   stat?: string,
 *   skill?: string|null,
 *   raison?: string,
 *   weaponName?: string|null,
 *   targetId?: string|null,
 *   engineContext?: object,
 * }} opts
 */
export function buildPendingDiceRoll(opts) {
  const {
    kind = "damage_roll",
    roll: rawRoll,
    totalBonus: rawBonus = 0,
    stat = "Dégâts",
    skill = null,
    raison = "",
    weaponName = null,
    targetId = null,
    engineContext = {},
  } = opts ?? {};
  const norm = normalizePendingDamageRollNotation(rawRoll, rawBonus);
  return {
    kind,
    id: `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    roll: norm.roll,
    totalBonus: norm.totalBonus,
    stat,
    skill,
    raison: String(raison ?? ""),
    weaponName: weaponName ?? null,
    targetId: targetId ?? null,
    engineContext: engineContext && typeof engineContext === "object" ? engineContext : {},
  };
}
