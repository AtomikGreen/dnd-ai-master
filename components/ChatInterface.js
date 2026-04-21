"use client";

import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from "react";
import { flushSync } from "react-dom";
import {
  useGame,
  skipRemotePendingRollApplyRef,
  normalizeTurnResourcesInput,
} from "@/context/GameContext";
import { playBip } from "@/lib/sounds";
import { ADVENTURING_GEAR, ARMORS, SPELLS, WEAPONS, ROGUE_SNEAK_ATTACK_DICE_BY_LEVEL } from "@/data/srd5";
import {
  inventoryHasStackedItem,
  removeOneStackedItem,
  stackInventory,
} from "@/lib/inventoryStack";
import { getWeaponCompendiumEntry, resolveAttackMode, getStrictSpellMeta } from "@/data/compendium";
import { GOBLIN_CAVE, getVisibleExitsForRoom } from "@/data/campaign";
import { BESTIARY } from "@/data/bestiary";
import SceneImage from "./SceneImage";
import { resolveCombatantDisplayName } from "@/lib/combatDisplayName";
import { resolveLocalPlayerCombatantId } from "@/lib/combatLocalPlayerId";
import { sessionTerminalLog } from "@/lib/sessionTerminalLog";
import { computeAttackRollAdvDis, normalizeCombatantConditions } from "@/lib/combatAdvantage";
import { computeSavingThrowAdvDis, resolvePendingRollAdvDis } from "@/lib/rollAdvDis";
import {
  buildPendingDiceRoll,
  splitDiceNotationAndFlatBonus,
  doubleWeaponDiceNotationDiceOnly,
  getPendingRollDiceDescriptor,
} from "@/lib/pendingDiceRoll";
import { resolvePendingDamageRollStage } from "@/lib/pendingDamageRollResolve";
import { computePlayerArmorClass, normalizeEquipmentState } from "@/lib/playerEquipment";
import { validateSpellCastingComponents } from "@/lib/spellCastingComponents";
import {
  COMBAT_TIMED_STATE_IDS,
  decrementCombatTimedStatesOneTick,
  getAcBonusFromCombatTimedStates,
  normalizeCombatTimedStates,
  upsertCombatTimedState,
} from "@/lib/combatTimedStates";
import { resourceKindForCastingTime } from "@/lib/spellDisplayMeta";

// En React 18 StrictMode (dev), le démontage/remontage réinitialise les useRef du composant
// alors qu'une résolution async `multiplayerPendingCommand` est encore en cours → deuxième
// `callApi` pour le même `cmdId` et doubles narrations GM. Ce Set survit au remontage.
const globalMultiplayerPendingCmdResolutionInFlight = new Set();

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function fmtMod(mod) {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

function spellComponentsBlockReasonForPlayer(player, spellName) {
  const v = validateSpellCastingComponents(player, spellName);
  return v.ok ? null : v.reason;
}

// Répare les "mojibake" courants (ex: "ðŸŽ²" => "🎲", "â€”" => "—") uniquement pour l'affichage.
// Important: on ne touche pas à la logique/routing à l'intérieur de l'API moteur, à part les regex de prefix dice.
function mojibakeScore(str) {
  const s = String(str ?? "");
  // Comptage très approximatif : on veut juste comparer "avant" vs "après".
  return (
    (s.match(/(?:Ã|Â|â|ðŸ|�)/g) ?? []).length +
    (s.match(/(?:â†|â€”|â€™|â€˜|â€œ|â€�|â€¦)/g) ?? []).length
  );
}

function repairMojibakeForDisplay(input) {
  if (typeof input !== "string") return input;
  // Passe 0 : fragments très courants (UTF-8 lu comme Latin-1 / Windows-1252), y compris dans l'historique déjà persisté.
  let s = input
    .replace(/âš[\s\u00a0]*/g, "⚠ ")
    .replace(/dÃ©jÃ\s*à/g, "déjà à")
    .replace(/dÃ©jÃ/g, "déjà")
    .replace(/déjÃ\s*utilis/g, "déjà utilis")
    .replace(/déjÃ\s*à/g, "déjà à")
    .replace(/déjÃ\s*dépens/g, "déjà dépens")
    .replace(/nâ€™/g, "n'")
    .replace(/dâ€™/g, "d'")
    .replace(/lâ€™/g, "l'")
    .replace(/sâ€™/g, "s'")
    .replace(/mâ€™/g, "m'")
    .replace(/tâ€™/g, "t'")
    .replace(/câ€™/g, "c'")
    .replace(/quâ€™/g, "qu'")
    .replace(/aujourdâ€™hui/g, "aujourd'hui")
    .replace(/â€"/g, "—")
    .replace(/â€“/g, "–")
    .replace(/â€¦/g, "…")
    .replace(/corps Ã\s+corps/g, "corps à corps")
    .replace(/finesse ou Ã\s+distance/g, "finesse ou à distance")
    .replace(/s'applique Ã\s+la/g, "s'applique à la");

  // Gate: évite toute conversion coûteuse si la chaîne ne ressemble pas à du mojibake.
  const looksMojibake = /(?:Ã|Â|â|ðŸ|�|â†|â€”|â€™|â€˜|â€œ|â€�|â€¦|š)/.test(s);
  if (!looksMojibake) return s;

  // Tentative générique "latin1 bytes -> utf8 string" (pattern classique des mojibake).
  try {
    const bytes = Uint8Array.from([...s].map((ch) => ch.charCodeAt(0) & 0xff));
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (!decoded.includes("\uFFFD") && mojibakeScore(decoded) < mojibakeScore(s)) {
      return decoded;
    }
  } catch {
    // No-op, on retombe sur mapping ciblé.
  }

  // Fallback mapping ciblé (utile si TextDecoder n'améliore pas).
  return s
    // Accents FR fréquents issus de "UTF-8 bytes interprétés en Latin-1"
    .replace(/Ã‰/g, "É")
    .replace(/Ã‡/g, "Ç")
    .replace(/Ã©/g, "é")
    .replace(/Ã¨/g, "è")
    .replace(/Ãª/g, "ê")
    .replace(/Ã«/g, "ë")
    .replace(/Ã®/g, "î")
    .replace(/Ã¯/g, "ï")
    .replace(/Ã´/g, "ô")
    .replace(/Ã³/g, "ó")
    .replace(/Ã¹/g, "ù")
    .replace(/Ã»/g, "û")
    .replace(/Ã¢/g, "â")
    .replace(/Ã£/g, "ã")
    .replace(/ðŸŽ²/g, "🎲")
    .replace(/â†’/g, "→")
    /** Même séquence avec apostrophe ASCII (affichage copié / encodage partiel). */
    .replace(/â\u2020'/g, "→")
    .replace(/â€”/g, "—")
    .replace(/â€“/g, "–")
    .replace(/â€™/g, "’")
    .replace(/â€˜/g, "‘")
    .replace(/â€œ/g, "“")
    .replace(/â€�/g, "”")
    .replace(/â€¦/g, "…")
    .replace(/â³/g, "⏳")
    .replace(/âœ¦/g, "🤖")
    .replace(/â¬¡/g, "↗")
    .replace(/ðŸ”§/g, "💬")
    .replace(/ðŸ¤–/g, "🤖")
    .replace(/ðŸ’€/g, "💀")
    .replace(/ðŸ’¥/g, "💥")
    .replace(/âœ”/g, "✅")
    .replace(/âœ–/g, "❌")
    .replace(/âœ•/g, "✕");
}

/**
 * Lance un dé selon la notation "XdY", "XdY+Z", "dY-Z", ou répétitions "base xN" (ex. Projectile magique : 1d4+1 x3).
 * Retourne { total, rolls, notation, flatBonus } — flatBonus = modificateurs fixes (+1 par missile, +3 sur 2d6+3, etc.)
 * pour l'affichage formatDmgRoll (évite d'afficher "1d4+1 [1] = 1" au lieu de 2).
 */
function rollDiceDetailed(notation) {
  const raw = String(notation ?? "1d4").trim();
  if (!raw) return { total: 1, rolls: [1], notation: "1d4", flatBonus: 0 };

  const repeatMatch = raw.match(/^(.+?)\s+[x×]\s*(\d+)\s*$/i);
  if (repeatMatch) {
    const base = repeatMatch[1].trim();
    const times = parseInt(repeatMatch[2], 10);
    if (Number.isFinite(times) && times >= 1 && times <= 20) {
      const allRolls = [];
      let grandTotal = 0;
      let flatBonusSum = 0;
      for (let i = 0; i < times; i++) {
        const r = rollDiceDetailed(base);
        grandTotal += r.total;
        allRolls.push(...(r.rolls || []));
        flatBonusSum += r.flatBonus ?? 0;
      }
      return { total: grandTotal, rolls: allRolls, notation: raw, flatBonus: flatBonusSum };
    }
  }

  const withMod = raw.match(/^(\d*)d(\d+)([+-]\d+)$/i);
  if (withMod) {
    const count = withMod[1] === "" ? 1 : parseInt(withMod[1], 10);
    const sides = parseInt(withMod[2], 10);
    const mod = parseInt(withMod[3], 10);
    if (!Number.isFinite(count) || !Number.isFinite(sides) || count <= 0 || sides <= 0) {
      return { total: 1, rolls: [1], notation: raw, flatBonus: 0 };
    }
    const rolls = [];
    for (let i = 0; i < count; i++) rolls.push(Math.floor(Math.random() * sides) + 1);
    const diceSum = rolls.reduce((a, b) => a + b, 0);
    const total = diceSum + mod;
    return { total, rolls, notation: raw, flatBonus: mod };
  }

  const m = raw.match(/^(\d+)d(\d+)$/i) ?? raw.match(/^d(\d+)$/i);
  if (!m) return { total: 1, rolls: [1], notation: raw || "1d4", flatBonus: 0 };
  const count = m.length === 2 ? 1 : parseInt(m[1], 10);
  const sides = m.length === 2 ? parseInt(m[1], 10) : parseInt(m[2], 10);
  if (!Number.isFinite(count) || !Number.isFinite(sides) || count <= 0 || sides <= 0) {
    return { total: 1, rolls: [1], notation: raw || "1d4", flatBonus: 0 };
  }
  const rolls = [];
  for (let i = 0; i < count; i++) rolls.push(Math.floor(Math.random() * sides) + 1);
  const total = rolls.reduce((a, b) => a + b, 0);
  return { total, rolls, notation: raw, flatBonus: 0 };
}

/** Retourne uniquement le total (wrapper simple). */
function rollDice(notation) {
  return rollDiceDetailed(notation).total;
}

/** Affichage texte des jets (dés + bonus fixe du sort), ex. "2d6+3 [4+3] +3". */
function formatDiceNotationDetail(r, dmgNotation) {
  const fb = r.flatBonus ?? 0;
  const rp = Array.isArray(r.rolls) && r.rolls.length ? `[${r.rolls.join("+")}]` : "";
  const fbPart = fb > 0 ? ` +${fb}` : fb < 0 ? ` ${fb}` : "";
  return `${dmgNotation} ${rp}${fbPart}`.trim();
}

/** IDs listés dans encounterEntities pour une salle (spawn scripté / embuscade). */
function encounterSpawnIdsForRoom(roomId) {
  if (!roomId || typeof roomId !== "string") return [];
  const room = GOBLIN_CAVE[roomId];
  if (!room || !Array.isArray(room.encounterEntities)) return [];
  return room.encounterEntities
    .map((entry) => (typeof entry === "string" ? entry : entry?.id))
    .filter((id) => typeof id === "string" && id.trim())
    .map((id) => id.trim());
}

/** Union des ids autorisés pour valider les spawns : salle courante uniquement (les entityUpdates s'y appliquent). */
function buildAllowedSpawnIdSet(baseRoomId) {
  const set = new Set();
  for (const id of encounterSpawnIdsForRoom(baseRoomId)) set.add(id);
  return set;
}

function looksLikeLootIntent(text) {
  const t = String(text ?? "").toLowerCase();
  return /(loot|looter|piller|pillage|fouiller|fouille|depouille|dépouille|ramasser|récupérer|recuperer|prendre sur le corps)/i.test(t);
}

function getEncounterBonusLootForRoom(roomId, entityId) {
  const room = roomId && GOBLIN_CAVE?.[roomId] ? GOBLIN_CAVE[roomId] : null;
  const entries = Array.isArray(room?.encounterEntities) ? room.encounterEntities : [];
  for (const entry of entries) {
    if (entry && typeof entry === "object" && String(entry.id ?? "") === String(entityId ?? "")) {
      const bonusLoot = typeof entry.bonusLoot === "string" ? entry.bonusLoot.trim() : "";
      return bonusLoot || null;
    }
  }
  return null;
}

function deriveLootItemsFromEntity(entity, roomId) {
  if (!entity || typeof entity !== "object") return [];
  const fromLootItems = Array.isArray(entity.lootItems)
    ? entity.lootItems.map((x) => String(x ?? "").trim()).filter(Boolean)
    : [];
  if (fromLootItems.length) return fromLootItems;

  const fromInventory = Array.isArray(entity.inventory)
    ? entity.inventory.map((x) => String(x ?? "").trim()).filter(Boolean)
    : [];
  if (fromInventory.length) return fromInventory;

  const fromWeapons = Array.isArray(entity.weapons)
    ? entity.weapons
        .map((w) => String(w?.name ?? "").trim())
        .filter(Boolean)
    : [];
  const roomBonusLoot = getEncounterBonusLootForRoom(roomId, entity.id);
  const fallback = roomBonusLoot ? [roomBonusLoot] : [];
  return [...fromWeapons, ...fallback];
}

function makeRuntimeSpawnIdFactory(baseEntities = [], draftUpdates = []) {
  const used = new Set(
    [
      ...(Array.isArray(baseEntities) ? baseEntities.map((e) => e?.id) : []),
      ...(Array.isArray(draftUpdates) ? draftUpdates.map((u) => u?.id) : []),
    ]
      .filter((id) => typeof id === "string" && id.trim())
      .map((id) => id.trim())
  );
  const counters = {};
  const toBase = (s) =>
    String(s ?? "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "spawn";
  return (hint) => {
    const base = toBase(hint);
    let n = Math.max(1, (counters[base] ?? 0) + 1);
    let candidate = `${base}_${n}`;
    while (used.has(candidate)) {
      n += 1;
      candidate = `${base}_${n}`;
    }
    counters[base] = n;
    used.add(candidate);
    return candidate;
  };
}

function isRangedWeaponName(name) {
  const meta = getWeaponCompendiumEntry(name);
  if (meta?.rangedOnly === true) return true;
  return /arc|arbal|fronde|sarbacane|filet/i.test(String(name ?? ""));
}

/** Mêlée vs distance pour avantage/désavantage (prone, CàC à distance, etc.). */
function classifyAttackMeleeRanged(chosenWeapon, tacticalAction) {
  if (tacticalAction?.kind === "spell") {
    const melee = chosenWeapon?.kind === "melee";
    return { isMeleeAttack: melee, isRangedAttack: !melee };
  }
  const ranged = chosenWeapon?.kind === "ranged" || isRangedWeaponName(chosenWeapon?.name ?? "");
  return { isMeleeAttack: !ranged, isRangedAttack: ranged };
}

/**
 * Voisin en mêlée hostile au sens D&D 5e (autre « camp », vivant, non neutralisé au sol).
 * @param {(id: string, pool: unknown) => string | null} controllerForCombatantIdFn
 */
function isHostileOpponentInMelee(attackerId, meleeNeighborId, entPool, controllerForCombatantIdFn) {
  if (!attackerId || !meleeNeighborId || meleeNeighborId === attackerId) return false;
  const a = controllerForCombatantIdFn(attackerId, entPool);
  const b = controllerForCombatantIdFn(meleeNeighborId, entPool);
  if (!a || !b || a === b) return false;
  const ent = Array.isArray(entPool) ? entPool.find((e) => e?.id === meleeNeighborId) : null;
  if (!ent || ent.isAlive === false) return false;
  const conds = normalizeCombatantConditions(ent);
  if (conds.includes("unconscious") || conds.includes("paralyzed")) return false;
  return true;
}

function editDistanceLeq2(a, b) {
  // Retourne une distance d'édition bornée (0..2) ou 3 si >2.
  const s = normalizeFr(a);
  const t = normalizeFr(b);
  if (!s || !t) return 3;
  if (s === t) return 0;
  const ls = s.length, lt = t.length;
  if (Math.abs(ls - lt) > 2) return 3;

  // DP Ã  bande limitée Â±2
  const max = 2;
  const prev = new Array(lt + 1).fill(0);
  const curr = new Array(lt + 1).fill(0);
  for (let j = 0; j <= lt; j++) prev[j] = j;
  for (let i = 1; i <= ls; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const from = Math.max(1, i - max);
    const to = Math.min(lt, i + max);
    // hors bande â†’ valeur haute
    for (let j = 1; j < from; j++) curr[j] = max + 1;
    for (let j = from; j <= to; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // del
        curr[j - 1] + 1,    // ins
        prev[j - 1] + cost  // sub
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    for (let j = to + 1; j <= lt; j++) curr[j] = max + 1;
    if (rowMin > max) return 3;
    for (let j = 0; j <= lt; j++) prev[j] = curr[j];
  }
  return prev[lt] <= 2 ? prev[lt] : 3;
}

function bestFuzzyMatch(query, choices) {
  const q = normalizeFr(query);
  if (!q) return null;
  let best = null;
  let bestDist = 3;
  for (const c of choices ?? []) {
    const d = editDistanceLeq2(q, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
      if (d === 0) break;
    }
  }
  return bestDist <= 2 ? best : null;
}

function fallbackNarrativeFromRollRequest(rr, baseEntities) {
  if (!rr) return "";
  const kind = String(rr.kind ?? "");
  if (kind === "attack") {
    const target = baseEntities?.find?.((e) => e?.id === rr.targetId) ?? null;
    const weapon = rr.weaponName ? `avec ${rr.weaponName}` : "à l'arme";
    const tgt = target?.name ? `sur ${target.name}` : "sur votre cible";
    return `Vous vous engagez ${weapon} ${tgt}, prêt à frapper.`;
  }
  if (kind === "damage_roll") {
    const r = String(rr?.raison ?? "").trim();
    return r ? `Vous préparez le jet — ${r}.` : "Vous préparez un jet de dégâts.";
  }
  if (kind === "check" || kind === "save") {
    const skill = rr.skill ? ` (${rr.skill})` : "";
    const stat = rr.stat ? ` ${rr.stat}` : "";
    return `Vous tentez l'action${skill} en vous fiant à${stat}.`;
  }
  return "Vous vous apprêtez à agir.";
}

function computeWeaponAttackParts(player, weaponName) {
  const w = (WEAPONS ?? {})[weaponName] ?? null;
  const pb = proficiencyBonusFromLevel(player?.level ?? 1);
  const forMod = abilityMod(player?.stats?.FOR ?? 10);
  const dexMod = abilityMod(player?.stats?.DEX ?? 10);

  let abilityKey = "FOR";
  let abilityModValue = forMod;
  const stat = String(w?.stat ?? "FOR");
  if (stat === "DEX") {
    abilityKey = "DEX";
    abilityModValue = dexMod;
  } else if (stat === "FINESSE") {
    if (dexMod >= forMod) {
      abilityKey = "DEX";
      abilityModValue = dexMod;
    } else {
      abilityKey = "FOR";
      abilityModValue = forMod;
    }
  }
  const props = Array.isArray(w?.properties) ? w.properties : [];
  const isRanged = props.some((p) => normalizeFr(p).includes("munitions"));
  const isTwoHanded = props.some((p) => normalizeFr(p).includes("deux mains"));

  const fighterStyle = player?.fighter?.fightingStyle ?? null;
  const archeryBonus = fighterStyle === "Archerie" && isRanged ? 2 : 0;
  const duelBonusDmg = fighterStyle === "Duel" && !isRanged && !isTwoHanded ? 2 : 0;

  const totalBonus = abilityModValue + pb + archeryBonus;
  return {
    pb,
    abilityKey,
    abilityModValue,
    totalBonus,
    weaponDb: w,
    style: { archeryBonus, duelBonusDmg },
  };
}

function effectivePlayerArmorClass(player) {
  return computePlayerArmorClass({
    stats: player?.stats ?? { FOR: 10, DEX: 10, CON: 10, INT: 10, SAG: 10, CHA: 10 },
    entityClass: player?.entityClass,
    equipment: player?.equipment,
    fighter: player?.fighter,
  });
}

/**
 * Formate un jet de dégâts pour le chat.
 * Ex: formatDmgRoll("1d6", [4], 1)  â†’ "1d6 [4] +1 = **5 dégâts**"
 * Ex: formatDmgRoll("1d6", [4,3], 1, true) â†’ "1d6 [4] + 1d6 [3] +1 = **8 dégâts**" (crit)
 */
/** Lecture seule : au moins un emplacement de sort de niveau ≥ spellLevel disponible. */
function combatantHasSpellSlotAtOrAbove(combatant, spellLevel) {
  if (!combatant?.spellSlots || spellLevel <= 0) return true;
  const slots = combatant.spellSlots;
  const levels = Object.keys(slots)
    .map((lvl) => parseInt(lvl, 10))
    .filter((lvl) => !Number.isNaN(lvl))
    .sort((a, b) => a - b);
  return levels.some((lvl) => {
    if (lvl < spellLevel) return false;
    const row = slots[lvl];
    const remaining = typeof row?.remaining === "number" ? row.remaining : row?.max ?? 0;
    return remaining > 0;
  });
}

function formatDmgRoll(notation, rolls1, bonus, isCrit = false, rolls2 = null) {
  const fmt = (rolls) => `${notation} [${rolls.join("+")}]`;
  const dice1Str = fmt(rolls1);
  const total1   = rolls1.reduce((a, b) => a + b, 0);

  let diceStr;
  let total;

  if (isCrit && rolls2) {
    const total2  = rolls2.reduce((a, b) => a + b, 0);
    diceStr = `${dice1Str} + ${fmt(rolls2)}`;
    total   = total1 + total2 + (bonus ?? 0);
  } else {
    diceStr = dice1Str;
    total   = total1 + (bonus ?? 0);
  }

  const bonusStr = bonus > 0 ? ` +${bonus}` : bonus < 0 ? ` ${bonus}` : "";
  return `${diceStr}${bonusStr} = **${Math.max(1, total)} dégâts**`;
}

/** Applique localement une liste d'EntityUpdate sur un tableau d'entités, sans toucher au state. */
function applyUpdatesLocally(entities, updates) {
  if (!updates?.length) return entities;
  let current = [...entities];
  const normalizeType = (t) => (t === "monster" ? "hostile" : t);
  const normalizeNameKey = (value) =>
    String(value ?? "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ");
  const toSafeIdBase = (s) =>
    String(s ?? "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "spawn";
  const usedIds = new Set(current.map((e) => e.id).filter(Boolean));
  const spawnCounters = {};
  const nextSpawnId = (baseHint) => {
    const base = toSafeIdBase(baseHint);
    const currentCount = spawnCounters[base] ?? 0;
    let n = Math.max(1, currentCount + 1);
    let candidate = `${base}_${n}`;
    while (usedIds.has(candidate)) {
      n += 1;
      candidate = `${base}_${n}`;
    }
    spawnCounters[base] = n;
    usedIds.add(candidate);
    return candidate;
  };
  const normalizeHpShape = (incomingHp, fallbackHp = null) => {
    if (incomingHp === null) return null;
    if (typeof incomingHp === "number" && Number.isFinite(incomingHp)) {
      const v = Math.max(0, Math.floor(incomingHp));
      return { current: v, max: v };
    }
    if (incomingHp && typeof incomingHp === "object") {
      const currRaw = incomingHp.current;
      const maxRaw = incomingHp.max;
      const fallbackCurrent =
        fallbackHp && typeof fallbackHp.current === "number" ? fallbackHp.current : 0;
      const fallbackMax =
        fallbackHp && typeof fallbackHp.max === "number" ? fallbackHp.max : Math.max(fallbackCurrent, 1);
      const currentVal =
        typeof currRaw === "number" && Number.isFinite(currRaw)
          ? Math.max(0, Math.floor(currRaw))
          : fallbackCurrent;
      const maxValRaw =
        typeof maxRaw === "number" && Number.isFinite(maxRaw)
          ? Math.max(1, Math.floor(maxRaw))
          : fallbackMax;
      return { current: currentVal, max: Math.max(maxValRaw, currentVal) };
    }
    return fallbackHp;
  };

  for (const upd of updates) {
    if (upd.action === "kill") {
      current = current.map((e) =>
        e.id === upd.id ? { ...e, isAlive: false, hp: e.hp ? { ...e.hp, current: 0 } : null } : e
      );
    } else if (upd.action === "update") {
      current = current.map((e) => {
        if (e.id !== upd.id) return e;
        const merged = {
          ...e,
          ...(upd.templateId !== undefined && { templateId: upd.templateId }),
          ...(upd.name !== undefined && { name: upd.name }),
          ...(upd.type !== undefined && { type: normalizeType(upd.type) ?? e.type }),
          ...(upd.race !== undefined && { race: upd.race }),
          ...(upd.entityClass !== undefined && { entityClass: upd.entityClass }),
          ...(upd.cr !== undefined && { cr: upd.cr }),
          ...(upd.visible !== undefined && { visible: upd.visible }),
          ...(upd.ac !== undefined && { ac: upd.ac }),
          ...(upd.stats !== undefined && { stats: upd.stats }),
          ...(upd.attackBonus !== undefined && { attackBonus: upd.attackBonus }),
          ...(upd.damageDice !== undefined && { damageDice: upd.damageDice }),
          ...(upd.damageBonus !== undefined && { damageBonus: upd.damageBonus }),
          ...(upd.weapons !== undefined && { weapons: upd.weapons }),
          ...(upd.features !== undefined && { features: upd.features }),
          ...(upd.description !== undefined && { description: upd.description }),
          ...(upd.stealthDc !== undefined && { stealthDc: upd.stealthDc }),
          ...(upd.lootItems !== undefined && { lootItems: upd.lootItems }),
          ...(upd.looted !== undefined && { looted: upd.looted }),
          ...(upd.surprised !== undefined && { surprised: !!upd.surprised }),
          ...(upd.awareOfPlayer !== undefined && { awareOfPlayer: !!upd.awareOfPlayer }),
          ...(upd.controller !== undefined && { controller: upd.controller }),
          ...(upd.combatTimedStates !== undefined && {
            combatTimedStates: normalizeCombatTimedStates(upd.combatTimedStates),
          }),
        };
        if (upd.hp !== undefined) {
          merged.hp = normalizeHpShape(upd.hp, e.hp ?? null);
          merged.isAlive = (merged.hp?.current ?? 0) > 0;
        }
        const nextType = normalizeType(upd.type) ?? merged.type;
        const inferredTemplateId =
          (typeof upd.templateId === "string" && upd.templateId.trim() ? upd.templateId.trim() : null) ??
          inferBestiaryTemplateIdForEntity({ ...merged, ...upd });
        const template = inferredTemplateId && BESTIARY?.[inferredTemplateId] ? BESTIARY[inferredTemplateId] : null;
        if (nextType === "hostile" && template) {
          if (!merged.templateId) merged.templateId = inferredTemplateId;
          if (!merged.race) merged.race = template.race ?? merged.race;
          if (!merged.entityClass || merged.entityClass === "Inconnu") {
            merged.entityClass = template.entityClass ?? merged.entityClass;
          }
          if (merged.cr == null) merged.cr = template.cr ?? merged.cr;
          if (merged.ac == null) merged.ac = template.ac ?? merged.ac;
          if (!merged.stats) merged.stats = template.stats ?? merged.stats;
          if (merged.attackBonus == null) merged.attackBonus = template.attackBonus ?? merged.attackBonus;
          if (!merged.damageDice) merged.damageDice = template.damageDice ?? merged.damageDice;
          if (merged.damageBonus == null) merged.damageBonus = template.damageBonus ?? merged.damageBonus;
          if (!Array.isArray(merged.weapons) || merged.weapons.length === 0) {
            merged.weapons = template.weapons ?? merged.weapons;
          }
          if (!Array.isArray(merged.features) || merged.features.length === 0) {
            merged.features = template.features ?? merged.features;
          }
          if (!Array.isArray(merged.selectedSpells) || merged.selectedSpells.length === 0) {
            merged.selectedSpells = template.selectedSpells ?? merged.selectedSpells;
          }
          if (!merged.spellSlots) merged.spellSlots = template.spellSlots ?? merged.spellSlots;
          if (merged.spellAttackBonus == null) {
            merged.spellAttackBonus = template.spellAttackBonus ?? merged.spellAttackBonus;
          }
          if (merged.spellSaveDc == null) {
            merged.spellSaveDc = template.spellSaveDc ?? merged.spellSaveDc;
          }
          if (!merged.description) merged.description = template.description ?? merged.description;
          if (merged.stealthDc == null) merged.stealthDc = template.stealthDc ?? merged.stealthDc;
        }
        return merged;
      });
    } else if (upd.action === "spawn") {
      const incomingId = typeof upd.id === "string" && upd.id.trim() ? upd.id.trim() : null;
      const templateId =
        (typeof upd.templateId === "string" && upd.templateId.trim() ? upd.templateId.trim() : null) ??
        (incomingId ? incomingId.replace(/_\d+$/g, "") : null);
      const template = templateId && BESTIARY?.[templateId] ? BESTIARY[templateId] : null;
      const providedName = typeof upd.name === "string" ? upd.name.trim() : "";
      const resolvedSpawnName = providedName || String(template?.name ?? "").trim() || incomingId || "";
      const logicalDuplicateIdx =
        resolvedSpawnName
          ? current.findIndex((e) =>
              normalizeNameKey(e?.name) === normalizeNameKey(resolvedSpawnName) &&
              normalizeType(e?.type) === (normalizeType(upd.type ?? template?.type) ?? "npc")
            )
          : -1;
      const resolvedId =
        incomingId ??
        nextSpawnId(String(templateId ?? upd.name ?? template?.name ?? upd.type ?? "spawn"));
      const idx = current.findIndex((e) => e.id === resolvedId);
      const mergeIdx = idx >= 0 ? idx : logicalDuplicateIdx;
      const nt = normalizeType(upd.type ?? template?.type) ?? "npc";
      // Anti-clone : id déjà présent → fusion type update (ne pas recréer une fiche)
      if (mergeIdx >= 0) {
        const ent = current[mergeIdx];
        current = current.map((e, i) =>
          i !== mergeIdx
            ? e
            : {
                ...e,
                ...(templateId !== undefined && { templateId }),
                ...(upd.name !== undefined && { name: upd.name }),
                ...(upd.race !== undefined && { race: upd.race }),
                ...(upd.entityClass !== undefined && { entityClass: upd.entityClass }),
                ...(upd.cr !== undefined && { cr: upd.cr }),
                ...(upd.visible !== undefined && { visible: upd.visible }),
                ...(upd.ac !== undefined && { ac: upd.ac }),
                ...(upd.stats !== undefined && { stats: upd.stats }),
                ...(upd.attackBonus !== undefined && { attackBonus: upd.attackBonus }),
                ...(upd.damageDice !== undefined && { damageDice: upd.damageDice }),
                ...(upd.damageBonus !== undefined && { damageBonus: upd.damageBonus }),
                ...(upd.weapons !== undefined && { weapons: upd.weapons }),
                ...(upd.features !== undefined && { features: upd.features }),
                ...(upd.selectedSpells !== undefined && { selectedSpells: upd.selectedSpells }),
                ...(upd.spellSlots !== undefined && { spellSlots: upd.spellSlots }),
                ...(upd.spellAttackBonus !== undefined && { spellAttackBonus: upd.spellAttackBonus }),
                ...(upd.spellSaveDc !== undefined && { spellSaveDc: upd.spellSaveDc }),
                ...(upd.description !== undefined && { description: upd.description }),
                ...(upd.stealthDc !== undefined && { stealthDc: upd.stealthDc }),
                ...(upd.lootItems !== undefined && { lootItems: upd.lootItems }),
                ...(upd.looted !== undefined && { looted: upd.looted }),
                ...(upd.surprised !== undefined && { surprised: !!upd.surprised }),
                ...(upd.awareOfPlayer !== undefined && { awareOfPlayer: !!upd.awareOfPlayer }),
                ...(upd.hp !== undefined && { hp: normalizeHpShape(upd.hp, ent.hp ?? null) }),
                ...(upd.controller !== undefined && { controller: upd.controller }),
                type: nt,
                name: resolvedSpawnName || e.name,
                isAlive: true,
              }
        );
      } else {
        const newE = {
          id: resolvedId, templateId: templateId ?? undefined, name: resolvedSpawnName || resolvedId, type: nt,
          race: upd.race ?? template?.race ?? "Inconnu",
          entityClass: upd.entityClass ?? template?.entityClass ?? "Inconnu",
          cr: upd.cr ?? template?.cr ?? 0,
          visible: upd.visible ?? true, isAlive: true,
          hp: normalizeHpShape(upd.hp ?? template?.hp ?? null, null),
          ac: upd.ac ?? template?.ac ?? null,
          stats: upd.stats ?? template?.stats ?? null,
          attackBonus: upd.attackBonus ?? template?.attackBonus ?? null,
          damageDice: upd.damageDice ?? template?.damageDice ?? null,
          damageBonus: upd.damageBonus ?? template?.damageBonus ?? null,
          weapons: upd.weapons ?? template?.weapons ?? null,
          features: upd.features ?? template?.features ?? null,
          selectedSpells: upd.selectedSpells ?? template?.selectedSpells ?? null,
          spellSlots: upd.spellSlots ?? template?.spellSlots ?? null,
          spellAttackBonus: upd.spellAttackBonus ?? template?.spellAttackBonus ?? null,
          spellSaveDc: upd.spellSaveDc ?? template?.spellSaveDc ?? null,
          description: upd.description ?? template?.description ?? "",
          stealthDc: upd.stealthDc ?? template?.stealthDc ?? null,
          lootItems:
            Array.isArray(upd.lootItems)
              ? upd.lootItems
              : Array.isArray(upd.inventory)
              ? upd.inventory.map((x) => String(x ?? "").trim()).filter(Boolean)
              : null,
          looted: upd.looted ?? false,
          surprised: upd.surprised ?? false,
          controller: upd.controller ?? "ai",
          awareOfPlayer:
            typeof upd.awareOfPlayer === "boolean"
              ? upd.awareOfPlayer
              : nt === "hostile",
        };
        current = [...current, newE];
      }
    }
  }
  return current;
}

function isPlayerEntityUpdate(update) {
  return typeof update?.id === "string" && update.id.trim() === "player";
}

function playerEntityUpdatesTouchHp(updates) {
  if (!Array.isArray(updates)) return false;
  return updates.some((update) => {
    if (!isPlayerEntityUpdate(update)) return false;
    if (update?.action === "kill" || update?.action === "remove") return true;
    return (update?.action === "update" || update?.action === "spawn") && update?.hp !== undefined;
  });
}

/** Remplace **texte** par <strong> dans un message. */
function BoldText({ text }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? <strong key={i} className="font-bold">{p}</strong> : p
      )}
    </>
  );
}

function safeJson(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

function isSubstantiveArbiterEngineEvent(event) {
  if (!event || typeof event !== "object") return false;
  const kind = String(event.kind ?? "").trim();
  const reason = typeof event.reason === "string" ? event.reason.trim() : "";
  const details = typeof event.details === "string" ? event.details.trim() : "";
  if (reason || details) return true;
  return kind !== "" && kind !== "scene_rule_resolution";
}

/** Fusion parse-intent → arbitre de scène : évite de garder scene_transition si l'arbitre a résolu. */
function mergeSceneArbiterIntentEngineEvent(
  resolved,
  engineEventBeforeArbiter,
  sceneUpdateSnapshot,
  options = null
) {
  const arbiterEngineEvent = resolved?.engineEvent ?? null;
  const intentNavigationJustApplied = options?.intentNavigationJustApplied === true;

  // Le PJ vient d'entrer via parse-intent ; l'arbitre ne doit pas écraser par une « impasse » lue
  // depuis la nouvelle salle (ex. « ouest » = mur ici alors que « ouest » était la sortie depuis l'ancienne pièce).
  if (
    intentNavigationJustApplied &&
    engineEventBeforeArbiter?.kind === "scene_transition" &&
    arbiterEngineEvent?.kind === "scene_rule_resolution"
  ) {
    return engineEventBeforeArbiter;
  }

  const shouldKeepOriginalEngineEvent =
    resolved?.arbiterResolution === "no_roll_needed" &&
    engineEventBeforeArbiter?.kind === "action_trivial_success" &&
    !sceneUpdateSnapshot?.hasChanged &&
    !isSubstantiveArbiterEngineEvent(arbiterEngineEvent);
  return shouldKeepOriginalEngineEvent ? engineEventBeforeArbiter : (arbiterEngineEvent ?? engineEventBeforeArbiter);
}

function rewriteDeathyToWounded(reply, engineEvent) {
  const hpAfter = engineEvent?.targetHpAfter;
  const hpMax = engineEvent?.targetHpMax;
  const name = engineEvent?.targetName ?? "La cible";

  const pct =
    typeof hpAfter === "number" && typeof hpMax === "number" && hpMax > 0
      ? hpAfter / hpMax
      : null;

  // On retire quelques formulations de mort/KO fréquentes.
  const cleaned = String(reply ?? "")
    // Important: ne pas supprimer l'infinitif "s'effondrer" dans des formulations
    // de type "refuse encore de s'effondrer".
    .replace(/(s['â€™]?(?:effondre\b|écroule\b|e?croule\b)[^.\n]*[.\n]?)/gi, "")
    .replace(/\b(meurt|mort|sans vie|inanimé|dernier souffle)\b[^.\n]*[.\n]?/gi, "")
    .trim();

  // On ne rajoute plus de phrase toute faite ("blessé mais debout"),
  // on se contente de retourner la narration nettoyée.
  return cleaned;
}

function sanitizeResolvedAttackNarrative(reply) {
  const text = String(reply ?? "").trim();
  if (!text) return text;
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) return text;
  const drift = /(apres avoir|après avoir|vous recuperez|vous récupérez|vous ramassez|vous pillez|vous lootez|vous reprenez votre marche|vous reprenez la marche|trois heures|heures de progression|vous arrivez|au pied d|porte de bois|vous quittez|vous entrez|vous continuez vers)/i;
  const kept = parts.filter((s) => !drift.test(s));
  if (kept.length === 0) return parts[0];
  return kept.join(" ");
}

function sanitizeAutoTravelAfterLootNarrative(reply) {
  const text = String(reply ?? "").trim();
  if (!text) return text;
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) return text;
  const travelOnly =
    /(vous reprenez votre marche|vous reprenez la marche|la marche se poursuit|reprend sa marche|reprend la marche|apres une progression|après une progression|apres une derniere heure|après une dernière heure|trois heures|heures de progression|le sentier debouche|le sentier débouche|la piste debouche|la piste débouche|vous arrivez|en vue de la grotte|au pied d|porte de bois|vous quittez|vous entrez|vous continuez vers|poursuivre sa progression)/i;
  const kept = parts.filter((s) => !travelOnly.test(s));
  if (kept.length === 0) return parts[0];
  return kept.join(" ");
}

function enforceDeathNarrative(reply, engineEvent) {
  const r = String(reply ?? "").trim();
  const targetName = engineEvent?.targetName || engineEvent?.targetId || "la cible";

  // Si l'IA a déjÃ  narré une mort/KO, ne rien faire.
  const deathy =
    /(s['â€™]?(?:effondre|écroule|e?croule)|meurt|mort|sans vie|inanim(?:e|ée)|dernier souffle|s['â€™]?affaisse)/i;
  if (deathy.test(r)) return r;

  // Si l'IA dit explicitement "reste debout" alors que le moteur dit KO/mort, corriger.
  const standing =
    /(reste\s+debout|se\s+redresse|se\s+maintient\s+sur\s+ses\s+jambes|tient\s+encore\s+debout)/i;
  let cleaned = r;
  if (standing.test(cleaned)) {
    cleaned = cleaned.replace(standing, "s'effondre au sol, inanimé");
    return cleaned;
  }

  // Sinon, ajouter une phrase courte et factuelle.
  return (cleaned ? `${cleaned}\n\n` : "") + `**${targetName}** s'effondre au sol, inanimé.`;
}

function makeMsgId() {
  // Assez unique pour éviter les collisions dans la même milliseconde
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// NOTE : On n'altère jamais le texte utilisateur. Les annonces de jets sont gérées par le prompt (IA doit ignorer).
// Transitions de lieu : `GOBLIN_CAVE` + `getVisibleExitsForRoom`, intention MJ / moteur — pas de scène « taverne » hardcodée.

// ---------------------------------------------------------------------------
// Skills D&D 5e (moteur) â€” bonus calculés côté client, pas par l'IA
// ---------------------------------------------------------------------------

const SKILL_TO_ABILITY = {
  Athletics: "FOR",
  Acrobatics: "DEX",
  "Sleight of Hand": "DEX",
  Stealth: "DEX",
  Arcana: "INT",
  History: "INT",
  Investigation: "INT",
  Nature: "INT",
  Religion: "INT",
  "Animal Handling": "SAG",
  Insight: "SAG",
  Medicine: "SAG",
  Perception: "SAG",
  Survival: "SAG",
  Deception: "CHA",
  Intimidation: "CHA",
  Performance: "CHA",
  Persuasion: "CHA",
};

const SKILL_ALIASES = {
  // FR â†’ EN
  Athlétisme: "Athletics",
  Acrobaties: "Acrobatics",
  Escamotage: "Sleight of Hand",
  Discrétion: "Stealth",
  Furtivité: "Stealth",
  Arcanes: "Arcana",
  Histoire: "History",
  Investigation: "Investigation",
  Nature: "Nature",
  Religion: "Religion",
  Dressage: "Animal Handling",
  Intuition: "Insight",
  Médecine: "Medicine",
  Medecine: "Medicine",
  Perception: "Perception",
  Survie: "Survival",
  Tromperie: "Deception",
  Intimidation: "Intimidation",
  Représentation: "Performance",
  Representation: "Performance",
  Persuasion: "Persuasion",
};

const UNARMED_PATTERNS = /\b(coup de pied|donne un coup de pied|mets un coup de pied|coup de botte|coup de poing|donne un coup de poing|je frappe|je le frappe|je le tape|coup de genou)\b/i;

function looksLikeUnarmedAttack(text) {
  return UNARMED_PATTERNS.test(String(text ?? ""));
}

/**
 * Texte d'arme renvoyé par le parseur : indique une attaque à mains nues explicite
 * (mot-clé ou phrase type « coup de poing »), pas une arme équipée.
 */
function isExplicitUnarmedWeaponIntentText(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  if (looksLikeUnarmedAttack(raw)) return true;
  const lower = raw.toLowerCase();
  if (
    /^(poing|pied|tête|tete|boule|mains?\s+nues?)$/i.test(lower.replace(/\s+/g, " ").trim()) ||
    /coup\s+de\s+(poing|pied|boule|tête|tete|genou)/i.test(lower)
  ) {
    return true;
  }
  const t = normalizeFr(raw).replace(/[^a-z0-9]/g, "");
  if (
    t === "poing" ||
    t === "pied" ||
    t === "tete" ||
    t === "coupdetete" ||
    t === "coudepoing" ||
    t === "coudepied" ||
    t === "mainnue" ||
    t === "mainsnues" ||
    t === "coudeboule"
  ) {
    return true;
  }
  return false;
}

function buildUnarmedWeapon(player, content) {
  const forScore = player?.stats?.FOR ?? 10;
  const strMod = abilityMod(forScore);
  const isKick = /\b(pied|botte|genou)\b/i.test(String(content ?? ""));
  return {
    name: isKick ? "Coup de pied" : "Coup de poing",
    attackBonus: strMod,
    damageDice: "1d1",
    damageBonus: 0,
  };
}

function normalizeSkillName(skill) {
  const raw = String(skill ?? "").trim();
  if (!raw) return null;
  // enlever parenthèses éventuelles
  const base = raw.replace(/\(.+?\)/g, "").trim();
  return SKILL_ALIASES[base] ?? base;
}

/**
 * Test de Médecine sur une autre créature (stabiliser, etc.) : D&D 5e impose le contact
 * (portée contact / même case qu’en mêlée dans ce moteur).
 */
function isMedicineCheckOnOtherCombatant(roll, localCombatantId, isMultiplayer) {
  if (!roll || roll.kind !== "check") return false;
  if (normalizeSkillName(roll.skill) !== "Medicine") return false;
  const tid = String(roll.targetId ?? "").trim();
  if (!tid) return false;
  const self = String(localCombatantId ?? "").trim();
  if (tid === self) return false;
  if (!isMultiplayer && tid === "player" && self === "player") return false;
  return true;
}

function abilityMod(score) {
  return Math.floor(((score ?? 10) - 10) / 2);
}

function proficiencyBonusFromLevel(level) {
  const lv = Math.max(1, parseInt(level ?? 1, 10) || 1);
  if (lv <= 4) return 2;
  if (lv <= 8) return 3;
  if (lv <= 12) return 4;
  if (lv <= 16) return 5;
  return 6;
}

function computeCheckBonus({ player, stat, skill }) {
  const prof = proficiencyBonusFromLevel(player?.level);

  const normSkill = normalizeSkillName(skill);
  const abilityKey =
    (normSkill && SKILL_TO_ABILITY[normSkill]) ? SKILL_TO_ABILITY[normSkill] : stat;

  const base = abilityMod(player?.stats?.[abilityKey]);
  const proficient = !!normSkill && Array.isArray(player?.skillProficiencies)
    ? player.skillProficiencies.includes(normSkill)
    : false;

  return base + (proficient ? prof : 0);
}

/** d20 avec avantage / désavantage (si les deux : annulation → un seul dé). */
function rollNatWithAdvDis(adv, dis) {
  const d1 = Math.floor(Math.random() * 20) + 1;
  if (!adv && !dis) return { nat: d1, nat1: d1, nat2: null, mode: "normal" };
  const d2 = Math.floor(Math.random() * 20) + 1;
  if (adv && dis) return { nat: d1, nat1: d1, nat2: d2, mode: "cancelled" };
  if (adv) return { nat: Math.max(d1, d2), nat1: d1, nat2: d2, mode: "advantage" };
  return { nat: Math.min(d1, d2), nat1: d1, nat2: d2, mode: "disadvantage" };
}

/** Suffixe lisible pour les bulles de jet (d20 avec avantage/désavantage). */
function formatAdvDisSuffixForD20(rollMeta) {
  if (!rollMeta || rollMeta.mode === "normal" || rollMeta.nat2 == null) return "";
  const detail = rollMeta.advDisDetail ? String(rollMeta.advDisDetail) : "";
  if (rollMeta.mode === "cancelled") {
    return ` (annulation : ${rollMeta.nat1}/${rollMeta.nat2}${detail ? ` — ${detail}` : ""})`;
  }
  return ` (${rollMeta.mode === "advantage" ? "avantage" : "désavantage"} : ${rollMeta.nat1}/${rollMeta.nat2}${
    detail ? ` — ${detail}` : ""
  })`;
}

function passivePerceptionFromPlayerSheet(p) {
  if (!p?.stats) return 10;
  return 10 + computeCheckBonus({ player: p, stat: "SAG", skill: "Perception" });
}

/** PP calculée (10 + Sag + maîtrise si Perception) quand le bestiaire ne fournit pas de valeur figée. */
function passivePerceptionComputedFromEntityStats(ent) {
  const wis = abilityMod(ent?.stats?.SAG ?? 10);
  let perceptionProf = false;
  if (Array.isArray(ent?.skillProficiencies)) {
    perceptionProf = ent.skillProficiencies.some((s) => normalizeSkillName(s) === "Perception");
  }
  if (!perceptionProf) {
    const feats = Array.isArray(ent?.features) ? ent.features.join(" ").toLowerCase() : "";
    perceptionProf =
      /(^|\b)(perception|perceptive|vigilance)\b|passive perception/i.test(feats);
  }
  const lv =
    typeof ent?.level === "number" && Number.isFinite(ent.level) ? Math.max(1, Math.min(20, ent.level)) : null;
  const pb =
    lv != null
      ? proficiencyBonusFromLevel(lv)
      : proficiencyBonusFromLevel(Math.max(1, Math.min(20, Math.ceil((ent?.cr ?? 0.25) * 4))));
  return 10 + wis + (perceptionProf ? pb : 0);
}

function passivePerceptionBaseFromEntityLike(ent) {
  const tid = inferBestiaryTemplateIdForEntity(ent);
  const raw = tid && BESTIARY?.[tid] ? BESTIARY[tid] : null;
  const pp = raw?.senses?.passivePerception;
  if (typeof pp === "number" && Number.isFinite(pp)) return { base: pp, fromStatBlock: true };
  return { base: passivePerceptionComputedFromEntityStats(ent), fromStatBlock: false };
}

/**
 * Avantage / désavantage sur la Perception passive (D&D 5e) : +5 / −5 sur le score passif.
 * Si la PP vient du bestiaire, on n’ajoute pas un second +5 pour « sens aiguisés » (déjà inclus dans la valeur MM).
 */
function passivePerceptionAdvDisModifierForPassiveScore(c, fromStatBlock) {
  const conds = normalizeCombatantConditions(c);
  let adv = false;
  let dis = false;
  if (conds.includes("blinded")) dis = true;
  if (conds.includes("poisoned")) dis = true;
  if (conds.includes("dim light") || conds.includes("pénombre") || conds.includes("penombre")) dis = true;
  if (conds.includes("perception advantage") || conds.includes("vigilant")) adv = true;

  if (!fromStatBlock) {
    const feats = Array.isArray(c?.features) ? c.features.join(" ").toLowerCase() : "";
    if (/keen (hearing|smell|sight)/.test(feats)) adv = true;
  }

  if (adv && dis) return 0;
  if (adv) return 5;
  if (dis) return -5;
  return 0;
}

function stealthBonusFromEntityForHide(ent) {
  const dex = abilityMod(ent?.stats?.DEX ?? 10);
  const feats = Array.isArray(ent?.features) ? ent.features.join(" ") : "";
  const stealthProf =
    /discrétion|furtivité|stealth|nimble escape|fuite agile|furtiv/i.test(feats);
  const pb = proficiencyBonusFromLevel(Math.max(1, Math.min(20, Math.ceil((ent?.cr ?? 0.25) * 4))));
  return dex + (stealthProf ? pb : 0);
}

function getCombatantKnownSpells(combatant) {
  return Array.isArray(combatant?.selectedSpells) ? combatant.selectedSpells.filter(Boolean) : [];
}

/** INT / SAG / CHA — même logique que le bonus d’attaque de sort (affichage du bandeau de jet). */
function spellcastingAbilityAbbrevForCombatant(combatant) {
  const classe = String(combatant?.entityClass ?? "").toLowerCase();
  if (classe.includes("magicien")) return "INT";
  if (
    classe.includes("clerc") ||
    classe.includes("druide") ||
    classe.includes("paladin") ||
    classe.includes("rôdeur") ||
    classe.includes("rodeur")
  ) {
    return "SAG";
  }
  return "CHA";
}

function computeSpellAttackBonus(combatant) {
  if (typeof combatant?.spellAttackBonus === "number" && Number.isFinite(combatant.spellAttackBonus)) {
    return combatant.spellAttackBonus;
  }
  const prof = proficiencyBonusFromLevel(combatant?.level);
  const key = spellcastingAbilityAbbrevForCombatant(combatant);
  const base = abilityMod(combatant?.stats?.[key]);
  return base + prof;
}

/** Explication du bonus d'attaque de sort (D&D 5e : carac + maîtrise). */
function formatSpellAttackBonusExplanation(combatant) {
  if (typeof combatant?.spellAttackBonus === "number" && Number.isFinite(combatant.spellAttackBonus)) {
    return `bonus de fiche ${fmtMod(combatant.spellAttackBonus)}`;
  }
  const prof = proficiencyBonusFromLevel(combatant?.level);
  const key = spellcastingAbilityAbbrevForCombatant(combatant);
  const base = abilityMod(combatant?.stats?.[key]);
  return `${key} ${fmtMod(base)} + maîtrise ${fmtMod(prof)}`;
}

/**
 * Avantage / désavantage pour un jet d'attaque PJ en attente (même logique que le bandeau et handleRoll).
 * @returns {{ mode: string, adv: boolean, dis: boolean, needsTwoD20: boolean, label: string }}
 */
function computePlayerAttackAdvDisForPendingRoll({
  pendingRoll,
  gameMode,
  player,
  entities,
  combatHiddenIds,
  localCombatantId,
  multiplayerSessionId,
  getMeleeWith,
  dodgeMap,
  controllerForCombatantId,
}) {
  const empty = { mode: "normal", adv: false, dis: false, needsTwoD20: false, label: "" };
  if (!pendingRoll || pendingRoll.kind !== "attack" || !pendingRoll.targetId || gameMode !== "combat") {
    return empty;
  }
  const spName = String(pendingRoll.weaponName ?? "");
  const isSpellAtk = !!(spName && SPELLS?.[spName]);
  const targetEnt = (entities ?? []).find((e) => e && e.id === pendingRoll.targetId) ?? null;
  if (!targetEnt) return empty;

  const hiddenSet = new Set(Array.isArray(combatHiddenIds) ? combatHiddenIds : []);
  const localPid = localCombatantId;
  const playerWasHidden =
    hiddenSet.has(localPid) || (!multiplayerSessionId && hiddenSet.has("player"));

  let isMelee = false;
  let isRanged = false;
  let spRangedInMelee = false;
  if (isSpellAtk) {
    const sp = SPELLS[spName];
    isMelee = /corps a corps|corps à corps/i.test(String(sp?.attack ?? ""));
    isRanged = !isMelee;
    if (isRanged) {
      spRangedInMelee = getMeleeWith(localPid).some((mid) =>
        isHostileOpponentInMelee(localPid, mid, entities ?? [], controllerForCombatantId)
      );
    }
  } else if (player?.weapons) {
    const weapon = player.weapons.find((w) => w.name === pendingRoll.weaponName);
    if (!weapon) return empty;
    const inMeleeWithTarget =
      !!pendingRoll.targetId && getMeleeWith(localPid).includes(String(pendingRoll.targetId));
    let modeW;
    if (pendingRoll.weaponAttackType === "melee" || pendingRoll.weaponAttackType === "ranged") {
      modeW = { attackType: pendingRoll.weaponAttackType };
    } else {
      modeW = resolveAttackMode(weapon, player, {
        inMeleeWithTarget,
        treatAsThrown:
          !!getWeaponCompendiumEntry(weapon)?.supportsThrown &&
          userContentSuggestsThrownWeaponAttack(pendingRoll.raison, weapon.name),
      });
    }
    isMelee = modeW.attackType === "melee";
    isRanged = modeW.attackType === "ranged";
    if (isRanged) {
      spRangedInMelee = getMeleeWith(localPid).some((mid) =>
        isHostileOpponentInMelee(localPid, mid, entities ?? [], controllerForCombatantId)
      );
    }
  } else {
    return empty;
  }

  const advRes = computeAttackRollAdvDis({
    attackerHidden: playerWasHidden,
    targetHidden: !!(pendingRoll.targetId && hiddenSet.has(String(pendingRoll.targetId))),
    attackerConditions: normalizeCombatantConditions({ conditions: player?.conditions }),
    targetConditions: normalizeCombatantConditions(targetEnt),
    isMeleeAttack: isMelee,
    isRangedAttack: isRanged,
    attackerRangedWeaponInMelee: spRangedInMelee,
    targetHasDodgeActive: !!(pendingRoll.targetId && dodgeMap?.[pendingRoll.targetId]),
  });

  const needsTwoD20 = advRes.mode === "advantage" || advRes.mode === "disadvantage";
  return {
    mode: advRes.mode,
    adv: !!advRes.adv,
    dis: !!advRes.dis,
    needsTwoD20,
    label: advRes.label ?? "",
  };
}

function computeSpellSaveDC(combatant) {
  if (typeof combatant?.spellSaveDc === "number" && Number.isFinite(combatant.spellSaveDc)) {
    return combatant.spellSaveDc;
  }
  const prof = proficiencyBonusFromLevel(combatant?.level);
  const classe = String(combatant?.entityClass ?? "").toLowerCase();
  let key = "CHA";
  if (classe.includes("magicien")) key = "INT";
  else if (classe.includes("clerc") || classe.includes("druide") || classe.includes("paladin") || classe.includes("rôdeur") || classe.includes("rodeur")) key = "SAG";
  const base = abilityMod(combatant?.stats?.[key]);
  return 8 + prof + base;
}

function computeEntitySaveBonus(entity, abilityKey) {
  const score = entity?.stats?.[abilityKey] ?? 10;
  return abilityMod(score);
}

function spendSpellSlot(player, updatePlayer, spellLevel) {
  if (!player || !player.spellSlots || spellLevel <= 0) {
    return { ok: true, usedLevel: null };
  }
  const slots = player.spellSlots;
  const levels = Object.keys(slots)
    .map((l) => parseInt(l, 10))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  const idx = levels.findIndex((lvl) => {
    if (lvl < spellLevel) return false;
    const row = slots[lvl];
    const remaining =
      typeof row?.remaining === "number" ? row.remaining : row?.max ?? 0;
    return remaining > 0;
  });
  if (idx === -1) {
    return { ok: false, usedLevel: null };
  }
  const useLevel = levels[idx];
  const row = slots[useLevel];
  const remaining =
    typeof row.remaining === "number" ? row.remaining : row.max ?? 0;
  const newSlots = {
    ...slots,
    [useLevel]: {
      ...row,
      remaining: Math.max(0, remaining - 1),
    },
  };
  updatePlayer({ spellSlots: newSlots });
  return { ok: true, usedLevel: useLevel };
}

function hasResource(turnResources, gameMode, kind) {
  if (gameMode !== "combat") return true;
  if (!turnResources) return false;
  if (kind === "action") return !!turnResources.action;
  if (kind === "bonus") return !!turnResources.bonus;
  if (kind === "reaction") return !!turnResources.reaction;
  if (kind === "movement") return !!turnResources.movement;
  return true;
}

function consumeResource(setTurnResources, gameMode, kind) {
  if (gameMode !== "combat") return;
  setTurnResources((prev) => {
    if (!prev) return prev;
    if (kind === "action" && prev.action) return { ...prev, action: false };
    if (kind === "bonus" && prev.bonus) return { ...prev, bonus: false };
    if (kind === "reaction" && prev.reaction) return { ...prev, reaction: false };
    if (kind === "movement" && prev.movement) return { ...prev, movement: false };
    return prev;
  });
}

// Mouvement "théâtre de l'esprit" : quand le joueur s'approche / rejoint la cible
// au contact, on consomme le déplacement (1 seule fois par tour).
function consumeMovementResource(setTurnResources) {
  consumeResource(setTurnResources, "combat", "movement");
}

/** Message mécanique après un déplacement sans cible (théâtre de l'esprit) — couvert / abri vs repositionnement simple. */
function combatMoveRepositionMessage(userContent) {
  const t = String(userContent ?? "").toLowerCase();
  const cover =
    /abri|à l'abri|a l'abri|couvert|arbre|rocher|mur|angle|obstacle|tire|flèche|fleche|ligne de vue|se cacher|derrière|derriere|épais|epais|fourr|buisson|roche/i.test(
      t
    );
  if (cover) {
    return "⚔️ Vous vous **déplacez** et gagnez un **couvert** (abri, obstacle, terrain) — **mouvement** dépensé pour ce tour.";
  }
  return "⚔️ Vous vous **déplacez** dans la zone de combat — **mouvement** dépensé pour ce tour.";
}

function stripDiacriticsForMatch(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function cloneMeleeStateShallow(m) {
  if (!m || typeof m !== "object") return {};
  const o = {};
  for (const [k, v] of Object.entries(m)) {
    o[k] = Array.isArray(v) ? [...v] : [];
  }
  return o;
}

function linkMeleePairInCopy(state, a, b) {
  if (!state || typeof state !== "object") return;
  if (!a || !b || String(a) === String(b)) return;
  const sa = String(a);
  const sb = String(b);
  const la = [...(Array.isArray(state[sa]) ? state[sa] : [])];
  const lb = [...(Array.isArray(state[sb]) ? state[sb] : [])];
  if (!la.includes(sb)) la.push(sb);
  if (!lb.includes(sa)) lb.push(sa);
  state[sa] = la;
  state[sb] = lb;
}

/** Voisins au corps à corps dans une copie du graphe (symétrique attendu). */
function neighborsInMeleeGraphCopy(state, id) {
  if (!state || typeof state !== "object") return [];
  const sid = String(id);
  const direct = Array.isArray(state[sid]) ? state[sid].map(String) : [];
  const rev = [];
  for (const [k, peers] of Object.entries(state)) {
    if (String(k) === sid) continue;
    if (Array.isArray(peers) && peers.some((p) => String(p) === sid)) rev.push(String(k));
  }
  return [...new Set([...direct, ...rev])];
}

/**
 * Debug chat : après un déplacement, liste les créatures du combat et leurs contacts au corps à corps.
 * @param {object} opts
 * @param {Record<string, string[]>} [opts.meleeStateSim] — graphe si l'état React n'est pas encore à jour
 */
function emitMeleeGraphDebugChat(opts) {
  const {
    label,
    moverId,
    moverName,
    getMeleeWith,
    entities,
    combatOrder,
    addMessage,
    makeMsgId,
    meleeStateSim,
    localCombatantIdForNames,
    localPlayerDisplayName,
  } = opts;
  const ents = Array.isArray(entities) ? entities : [];
  const co = Array.isArray(combatOrder) ? combatOrder : [];
  const nameForId = (id) => {
    const sid = String(id);
    const coEntry = co.find((c) => c && c.id != null && String(c.id) === sid);
    if (coEntry?.name) return String(coEntry.name);
    if (
      localCombatantIdForNames &&
      localPlayerDisplayName &&
      sid === String(localCombatantIdForNames)
    ) {
      return String(localPlayerDisplayName);
    }
    const e = ents.find((x) => x && String(x.id) === sid);
    return e?.name ? String(e.name) : sid;
  };
  const contactsFor = (id) => {
    if (meleeStateSim && typeof meleeStateSim === "object") {
      return neighborsInMeleeGraphCopy(meleeStateSim, id);
    }
    const g = typeof getMeleeWith === "function" ? getMeleeWith(id) : [];
    return Array.isArray(g) ? g.map(String) : [];
  };

  const idSet = new Set();
  for (const e of co) {
    if (e?.id) idSet.add(String(e.id));
  }
  for (const e of ents) {
    if (!e || e.visible === false || e.isAlive === false) continue;
    if (e.type === "hostile" || e.type === "npc" || e.controller === "player") idSet.add(String(e.id));
  }
  if (meleeStateSim && typeof meleeStateSim === "object") {
    for (const k of Object.keys(meleeStateSim)) idSet.add(String(k));
    for (const peers of Object.values(meleeStateSim)) {
      if (Array.isArray(peers)) for (const p of peers) if (p != null) idSet.add(String(p));
    }
  }

  const sortedIds = [...idSet].sort((a, b) => a.localeCompare(b));
  const creatures = sortedIds.map((id) => ({
    id,
    nom: nameForId(id),
    auContactDe: contactsFor(id).map((tid) => ({ id: tid, nom: nameForId(tid) })),
  }));

  addMessage(
    "ai",
    `[DEBUG] Déplacement — état du graphe de mêlée${label ? ` (${label})` : ""}` +
      (moverName || moverId ? `\nCréature qui se déplace : ${moverName ?? moverId}` : "") +
      `\n` +
      safeJson({
        listeDesCreatures: creatures,
      }),
    "debug",
    makeMsgId()
  );
}

/** Paires de combattants au contact (graphe de mêlée non orienté) — pour /api/enemy-tactics. */
function buildUndirectedMeleePairsForTactics(meleeGraph) {
  const seen = new Set();
  const out = [];
  if (!meleeGraph || typeof meleeGraph !== "object") return out;
  for (const [id, neighbors] of Object.entries(meleeGraph)) {
    const a = String(id ?? "").trim();
    if (!a || !Array.isArray(neighbors)) continue;
    for (const nb of neighbors) {
      const b = String(nb ?? "").trim();
      if (!b || a === b) continue;
      const key = a < b ? `${a}\0${b}` : `${b}\0${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([a, b]);
    }
  }
  return out;
}

/** Normalise actionIntent (API ou copie locale). */
function normalizeClientActionIntent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = raw.type ?? raw.actionType ?? raw.intentType;
  const allowed = new Set([
    "move",
    "attack",
    "move_and_attack",
    "disengage",
    "spell",
    "dodge",
    "second_wind",
    "use_item",
    "stabilize",
    "end_turn",
    "loot",
    "impossible",
  ]);
  if (!type || !allowed.has(String(type))) return null;
  const targetId = String(raw.targetId ?? raw.target ?? raw.entityId ?? raw.entity_id ?? "").trim() || null;
  const itemName =
    String(raw.itemName ?? raw.weaponName ?? raw.weapon ?? raw.spellName ?? raw.spell ?? "").trim() || null;
  return { type: String(type), targetId, itemName };
}

function combatantCanLaunchSpell(combatant, spellCanon) {
  if (!spellCanon || !SPELLS?.[spellCanon]) return false;
  const raw = normalizeFr(spellCanon);
  if (combatant?.entityClass === "Magicien") {
    const prep = getCombatantKnownSpells(combatant);
    return prep.some((s) => normalizeFr(s) === raw);
  }
  if (combatant?.entityClass === "Clerc") {
    const launch = getCombatantKnownSpells(combatant);
    const domain = combatant?.cleric?.domainSpells ?? [];
    const prep = combatant?.cleric?.preparedSpells ?? [];
    if (launch.some((s) => normalizeFr(s) === raw)) return true;
    if (domain.some((s) => normalizeFr(s) === raw)) return true;
    if (prep.some((s) => normalizeFr(s) === raw)) return true;
    return false;
  }
  const known = getCombatantKnownSpells(combatant);
  return known.some((s) => normalizeFr(s) === raw);
}

function playerCanLaunchSpell(player, spellCanon) {
  return combatantCanLaunchSpell(player, spellCanon);
}

/**
 * Après parse-intent : si une arme/sort est nommé(e), doit exister côté joueur (sinon blocage meta).
 * @returns {{ ok: true } | { ok: false, label: string }}
 */
/** Mains nues / coups naturels : pas d'exigence d'équipement. */
function isUnarmedStyleWeaponEntry(weapon) {
  const n = normalizeFr(String(weapon?.name ?? ""));
  return (
    n.includes("coup de poing") ||
    n.includes("coup de pied") ||
    n === "mains nues" ||
    n.includes("unarmed")
  );
}

/**
 * En combat, une attaque avec arme exige que l'arme soit en main principale ou secondaire
 * (sauf mains nues). Si aucune main n'est renseignée sur la fiche, on garde le comportement
 * historique (toute entrée de `player.weapons` est utilisable).
 */
function isWeaponEquippedForCombat(combatant, weapon) {
  if (!weapon?.name) return false;
  if (isUnarmedStyleWeaponEntry(weapon)) return true;
  const eq = normalizeEquipmentState(combatant?.equipment ?? null);
  const main = String(eq.mainHand ?? "").trim();
  const off = String(eq.offHand ?? "").trim();
  if (!main && !off) return true;
  const wn = normalizeFr(weapon.name);
  const handMatches = (h) => {
    const t = String(h ?? "").trim();
    return !!t && normalizeFr(t) === wn;
  };
  return handMatches(main) || handMatches(off);
}

function validateNamedWeaponOrSpellFromParser(apiIntent, player) {
  const w = String(apiIntent?.weapon ?? "").trim();
  const type = String(apiIntent?.type ?? "").trim();
  if (!w) return { ok: true };
  if (!["attack", "move_and_attack", "spell"].includes(type)) return { ok: true };

  if (type === "spell") {
    if (isExplicitUnarmedWeaponIntentText(w)) return { ok: true };
    const canon =
      canonicalizeSpellNameAgainstPlayer(player, w) ||
      (SPELLS?.[w] ? w : null) ||
      Object.keys(SPELLS ?? {}).find((k) => normalizeFr(k) === normalizeFr(w)) ||
      null;
    if (canon && SPELLS?.[canon] && playerCanLaunchSpell(player, canon)) return { ok: true };
    return { ok: false, label: w };
  }

  if (isExplicitUnarmedWeaponIntentText(w)) return { ok: true };
  if (canonicalizeWeaponNameAgainstPlayer(player, w)) return { ok: true };
  const nf = normalizeFr(w);
  const owned = player?.weapons ?? [];
  for (const ow of owned) {
    const on = normalizeFr(ow?.name ?? "");
    if (on && (nf === on || (nf.length >= 2 && (nf.includes(on) || on.includes(nf))))) {
      return { ok: true };
    }
  }
  return { ok: false, label: w };
}

/**
 * Attaque à distance avec arme de jet (lancer la dague, etc.) — pas une estocade au contact.
 * Évite de confondre avec « lancer un sort ».
 */
function userContentSuggestsThrownWeaponAttack(text, weaponName) {
  const raw = String(text ?? "");
  if (!raw.trim()) return false;
  const low = raw.toLowerCase();
  if (/\blancer\b[^.]{0,120}\b(le\s+|un\s+|mon\s+)?sort\b/i.test(low)) return false;
  if (/\b(sortilège|sortilege)\b/i.test(low)) return false;
  const thrownVerb =
    /\b(lance|lancer|lancé|lançant|lances)\b/i.test(raw) ||
    /\b(jette|jeter|jeté|jetée|jetant)\b/i.test(raw) ||
    /\b(throw|throws|toss|tossing|hurled|hurl)\b/i.test(raw);
  if (!thrownVerb) return false;
  const wn = normalizeFr(String(weaponName ?? ""));
  const lowAscii = stripDiacriticsForMatch(low);
  const mentionsWeapon =
    (wn.length >= 2 && lowAscii.includes(stripDiacriticsForMatch(wn))) ||
    /\b(dague|hachette|javeline|javelot|dard)\b/i.test(raw) ||
    /\b(marteau\s+léger|marteau\s+leger)\b/i.test(raw) ||
    /\bhache\s+d['']armes\b/i.test(raw) ||
    /\btrident\b/i.test(raw);
  return mentionsWeapon;
}

/** Engagement mêlée après toucher : uniquement attaque au contact, pas arme de jet lancée. */
function shouldEngageMeleeAfterWeaponHit(roll, weapon, playerEntity, localCombatantId, targetId, getMeleeWithFn) {
  if (!weapon || !targetId) return false;
  if (roll?.weaponAttackType === "ranged") return false;
  if (roll?.weaponAttackType === "melee") return true;
  const inM = getMeleeWithFn(localCombatantId).includes(String(targetId));
  const treatAsThrown =
    !!getWeaponCompendiumEntry(weapon)?.supportsThrown &&
    userContentSuggestsThrownWeaponAttack(String(roll?.raison ?? ""), weapon?.name);
  const mode = resolveAttackMode(weapon, playerEntity, { inMeleeWithTarget: inM, treatAsThrown });
  return mode.attackType === "melee";
}

/**
 * Résout arme ou sort pour une intention de combat (moteur client).
 * @returns {{ kind: "weapon", weapon: object } | { kind: "spell", spellName: string } | { kind: "error", message: string }}
 */
function resolveCombatItemForIntent(intentType, itemName, combatant, userContent) {
  if (intentType === "spell" && !String(itemName ?? "").trim()) {
    return { kind: "error", message: "Action impossible : précisez le nom du sort (itemName)." };
  }
  const knownSpells = getCombatantKnownSpells(combatant);
  let spellCanon = itemName ? canonicalizeSpellNameAgainstCombatant(combatant, itemName) : null;
  if (!spellCanon && itemName && knownSpells.length) {
    const raw = normalizeFr(itemName);
    for (const s of knownSpells) {
      const sl = normalizeFr(s);
      if (sl && (raw.includes(sl) || sl.includes(raw))) {
        spellCanon = s;
        break;
      }
    }
  }
  const bookHit = itemName && SPELLS?.[itemName] ? itemName : null;
  const treatAsSpell =
    intentType === "spell" ||
    (spellCanon && SPELLS?.[spellCanon]) ||
    (bookHit && SPELLS?.[bookHit]);

  if (treatAsSpell) {
    const finalName = spellCanon ?? bookHit;
    if (!finalName || !SPELLS?.[finalName]) {
      return { kind: "error", message: "Action impossible : sort inconnu." };
    }
    if (!combatantCanLaunchSpell(combatant, finalName)) {
      return {
        kind: "error",
        message: `Action impossible : **${finalName}** n'est pas parmi vos sorts lançables.`,
      };
    }
    return { kind: "spell", spellName: finalName };
  }

  const itemTrim = String(itemName ?? "").trim();
  /** Mains nues : uniquement si aucune arme nommée, ou mots-clés explicites dans itemName (pas via userContent seul). */
  const allowUnarmed =
    !itemTrim ||
    looksLikeUnarmedAttack(itemName) ||
    isExplicitUnarmedWeaponIntentText(itemName);

  let weapon = null;
  if (itemTrim) {
    weapon =
      combatant?.weapons?.find((w) => normalizeFr(w.name) === normalizeFr(itemName)) ?? null;
    if (!weapon) {
      const c = canonicalizeWeaponNameAgainstCombatant(combatant, itemName);
      if (c) {
        weapon = combatant?.weapons?.find((w) => normalizeFr(w.name) === normalizeFr(c)) ?? null;
      }
    }
  }
  if (!weapon && allowUnarmed) {
    weapon = buildUnarmedWeapon(combatant, itemTrim ? itemName : userContent);
  }
  if (!weapon) {
    const list = (combatant?.weapons ?? []).map((w) => w.name).join(", ");
    return {
      kind: "error",
      message: list
        ? `Action impossible : arme inconnue. Au choix : ${list}.`
        : "Action impossible : précisez une arme valide.",
    };
  }
  if (!isWeaponEquippedForCombat(combatant, weapon)) {
    return {
      kind: "error",
      message: `Action impossible : **${weapon.name}** n'est pas équipée (ni en main principale ni en main secondaire). Équipez-la sur la feuille de personnage ou utilisez une arme que vous tenez en main.`,
    };
  }
  return { kind: "weapon", weapon };
}

function resolveAdventuringConsumableByQuery(itemQuery) {
  const raw = String(itemQuery ?? "").trim();
  if (!raw) return null;
  const q = stripDiacriticsForMatch(raw).toLowerCase();
  for (const key of Object.keys(ADVENTURING_GEAR ?? {})) {
    const k = stripDiacriticsForMatch(key).toLowerCase();
    if (k === q || k.includes(q) || q.includes(k)) {
      const meta = ADVENTURING_GEAR[key];
      if (meta?.type === "Consommable") return { name: key, ...meta };
    }
  }
  return null;
}

function rollHealFromGearEffect(effectStr) {
  const m = String(effectStr ?? "").match(/(\d+d\d+(?:\s*\+\s*\d+)?)/i);
  if (!m) return 0;
  return rollDice(m[1].replace(/\s+/g, ""));
}

function extractDiceAndFlatBonusFromText(text, fallbackRoll = "1d4") {
  const raw = String(text ?? "");
  const match = raw.match(/(\d+d\d+(?:\s*[+-]\s*\d+)?)/i);
  const notation = match ? match[1].replace(/\s+/g, "") : fallbackRoll;
  const split = splitDiceNotationAndFlatBonus(notation);
  return {
    diceNotation: split?.diceNotation || fallbackRoll,
    flatBonus: Number(split?.flatBonus) || 0,
  };
}

/** Évite double bulle / double consommation quand parse-intent et la réponse MJ appliquent la même intention (ex. Esquiver, repositionnement sans cible). */
const SIMPLE_COMBAT_CONFIRM_DEDUPE_MS = 1500;
let lastSimpleCombatConfirm = { key: "", ts: 0 };
function shouldSkipDuplicateSimpleCombatConfirm(localCombatantId, kind) {
  const key = `${String(localCombatantId ?? "").trim()}:${kind}`;
  const now = Date.now();
  if (
    lastSimpleCombatConfirm.key === key &&
    now - lastSimpleCombatConfirm.ts < SIMPLE_COMBAT_CONFIRM_DEDUPE_MS
  ) {
    return true;
  }
  lastSimpleCombatConfirm = { key, ts: now };
  return false;
}

/** Évite double bulle « Action impossible : … » (même refus moteur enchaîné 2× : parse-intent + /api/chat, ou retry auto-joueur). */
const CLIENT_ACTION_ERROR_ECHO_DEDUPE_MS = 3200;
let lastClientActionErrorEcho = { norm: "", ts: 0 };
function shouldSkipDuplicateClientActionErrorEcho(content) {
  const raw = String(content ?? "").trim();
  if (!raw) return false;
  const norm = raw
    .toLowerCase()
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!/^action impossible\b/i.test(norm)) return false;
  const now = Date.now();
  if (
    lastClientActionErrorEcho.norm === norm &&
    now - lastClientActionErrorEcho.ts < CLIENT_ACTION_ERROR_ECHO_DEDUPE_MS
  ) {
    return true;
  }
  lastClientActionErrorEcho = { norm, ts: now };
  return false;
}

/**
 * Moteur d'intentions combat (Command pattern). Ne pas appeler l'IA en cas d'échec.
 * @returns {{ ok: false, userMessage: string } | { ok: true, pendingRoll: object|null, runSpellSave?: { spellName: string, target: object } }}
 */
function executeCombatActionIntent(intent, ctx) {
  const fail = (userMessage) => ({ ok: false, userMessage });
  const ACTION_CONSUMED_MESSAGE = "Action impossible : L'action de ce tour a déjà été consommée";
  const shouldEndTurnFromText = (t) => {
    const s = String(t ?? "").trim().toLowerCase();
    // L'autojoueur / certains clients peuvent envoyer "puis je termine mon tour"
    // dans le même message que l'action de combat principale ; le parseur ne renvoie
    // alors que l'action (ex: "move") et ignore "end_turn". On réconcilie ici.
    return /\b(fin\s+de\s+tou?r|termine\s+(mon|son)?\s*tou?r|fini\s+(mon|son)?\s*tou?r|je\s+termine\s+(mon|son)?\s*tou?r)\b/i.test(s);
  };
  const {
    postEntities,
    player,
    gameMode,
    setGameMode,
    turnResources,
    setTurnResources,
    setHp,
    updatePlayer,
    applyEntityUpdates,
    currentRoomId,
    playerHpRef,
    getMeleeWith,
    addMeleeMutual,
    clearMeleeFor,
    setHasDisengagedThisTurn,
    hasDisengagedThisTurn,
    consumeResource: consumeRes,
    addMessage,
    makeMsgId,
    userContent,
    parserMinimalNarration = false,
    localCombatantId = "player",
    dodgeActiveByCombatantIdRef = null,
    combatHiddenIds: combatHiddenIdsArg,
    meleeState: meleeStateArg,
    emitMeleeMoveDebug,
    messagesRef = { current: [] },
    multiplayerParticipantProfilesRef = { current: [] },
    multiplayerSessionId = null,
    clientId = "",
    patchParticipantProfileHp = null,
    combatEngagementSeqRef = { current: 0 },
    combatRoundInEngagementRef = { current: 0 },
    combatTurnIndexLiveRef = { current: 0 },
    multiplayerPendingCommandId: multiplayerPendingCommandIdFromCtx = null,
  } = ctx;

  const meleeStateSnapshot =
    meleeStateArg && typeof meleeStateArg === "object" && !Array.isArray(meleeStateArg) ? meleeStateArg : {};

  const emitMeleeEngagementDebug = (label, a, b) => {
    const sim = { ...meleeStateSnapshot };
    const link = (x, y) => {
      const cur = [...(Array.isArray(sim[x]) ? sim[x] : [])];
      if (!cur.includes(y)) cur.push(y);
      sim[x] = cur;
    };
    if (a && b) {
      link(a, b);
      link(b, a);
    }
    const pairs = Object.entries(sim).map(([id, peers]) => ({ id, peers: Array.isArray(peers) ? peers : [] }));
    addMessage(
      "ai",
      `[DEBUG] Mêlée — ${label}\n` +
        safeJson({
          liaison: { de: a, vers: b },
          grapheSimuleApresLiaison: pairs,
          note:
            "grapheSimuleApresLiaison = état précédent + cette liaison ; getMeleeWith peut être au tick React suivant.",
          getMeleeWithLocal: getMeleeWith(a),
          getMeleeWithCible: b ? getMeleeWith(b) : null,
        }),
      "debug",
      makeMsgId()
    );
  };

  const findLivingTarget = (id) => {
    if (!id) return null;
    // Autorise le ciblage d'une cible cachée (non visible) : la pénalité est gérée par
    // le désavantage d'attaque (`targetHidden`) au moment de la résolution du jet.
    return postEntities.find((e) => e.id === id && e.isAlive) ?? null;
  };

  const { type, targetId, itemName } = intent;
  let effectiveMode = gameMode;
  const canOpenCombatFromExploration =
    gameMode !== "combat" && ["attack", "spell", "move_and_attack"].includes(type);

  if (
    gameMode !== "combat" &&
    type !== "second_wind" &&
    type !== "use_item" &&
    type !== "stabilize" &&
    !canOpenCombatFromExploration
  ) {
    return fail("Action impossible : hors combat.");
  }

  if (type === "end_turn") {
    // Passer la main au prochain combattant : ne consomme aucune ressource
    // (c'est géré par `nextTurn()` côté client).
    return { ok: true, pendingRoll: null, endTurnRequested: true };
  }

  if (type === "second_wind") {
    // Trait : Second souffle (Action bonus 1/rest)
    if (!turnResources?.bonus) {
      return fail("Action impossible : vous n'avez plus d'**action bonus** disponible ce tour.");
    }
    if (player?.entityClass !== "Guerrier") {
      return fail("Action impossible : **Second souffle** est réservé au guerrier.");
    }
    const remaining = player?.fighter?.resources?.secondWind?.remaining ?? 0;
    if (remaining <= 0) {
      return fail("Action impossible : **Second souffle** n'est plus disponible (1/rest).");
    }
    // Comme une attaque/check : on propose le jet au joueur via le bouton de roll.
    return {
      ok: true,
      pendingRoll: {
        kind: "second_wind",
        roll: "1d10",
        raison: "Second souffle (1d10 + niveau)",
      },
    };
  }

  if (type === "use_item") {
    const itemQuery = String(itemName ?? "").trim();
    if (!itemQuery) {
      return fail("Action impossible : précisez l'objet (ex. potion de soins).");
    }
    const gear = resolveAdventuringConsumableByQuery(itemQuery);
    if (!gear || gear.type !== "Consommable") {
      return fail("Action impossible : cet objet ne peut pas être utilisé ainsi (ou est inconnu).");
    }
    const inv = Array.isArray(player?.inventory) ? player.inventory : [];
    if (!inventoryHasStackedItem(inv, gear.name)) {
      return fail(`Action impossible : vous n'avez pas **${gear.name}** dans votre inventaire.`);
    }

    if (gameMode === "combat") {
      if (!hasResource(turnResources, gameMode, "action")) {
        return fail("Action impossible : vous n'avez plus d'**action** disponible ce tour.");
      }
    }

    let tid = String(targetId ?? "").trim();
    if (!tid || tid === "player") tid = localCombatantId;

    const findPotionTargetEntity = (id) => {
      const e = postEntities.find((x) => x && String(x.id) === String(id) && x.visible !== false);
      if (!e || e.type === "hostile") return null;
      const hpCur = typeof e.hp?.current === "number" ? e.hp.current : null;
      if (e.isAlive === false && (hpCur == null || hpCur <= 0)) return null;
      return e;
    };
    const participantProfilesLive = multiplayerParticipantProfilesRef.current;
    const potionMpTargets = Array.isArray(participantProfilesLive)
      ? participantProfilesLive
          .map((p) => {
            const cid = String(p?.clientId ?? "").trim();
            if (!cid) return null;
            const snap = p?.playerSnapshot && typeof p.playerSnapshot === "object" ? p.playerSnapshot : null;
            const hp =
              typeof p?.hpCurrent === "number" && Number.isFinite(p.hpCurrent)
                ? Math.trunc(p.hpCurrent)
                : typeof snap?.hp?.current === "number" && Number.isFinite(snap.hp.current)
                  ? Math.trunc(snap.hp.current)
                  : null;
            const hpMax =
              typeof p?.hpMax === "number" && Number.isFinite(p.hpMax)
                ? Math.trunc(p.hpMax)
                : typeof snap?.hp?.max === "number" && Number.isFinite(snap.hp.max)
                  ? Math.trunc(snap.hp.max)
                  : null;
            const deathState = snap?.deathState && typeof snap.deathState === "object" ? snap.deathState : null;
            return {
              id: `mp-player-${cid}`,
              cid,
              name: String(p?.name ?? snap?.name ?? "").trim(),
              hp,
              hpMax,
              dead: deathState?.dead === true,
            };
          })
          .filter((x) => x && x.dead !== true)
      : [];

    const isSelf = tid === localCombatantId;
    const targetRefNorm = normalizeFr(tid);
    let targetEnt = null;
    let targetMp = null;
    if (!isSelf) {
      targetEnt =
        findPotionTargetEntity(tid) ??
        postEntities.find((e) => normalizeFr(String(e?.name ?? "")) === targetRefNorm) ??
        postEntities.find((e) => {
          const n = normalizeFr(String(e?.name ?? ""));
          return !!n && targetRefNorm && (n.includes(targetRefNorm) || targetRefNorm.includes(n));
        }) ??
        null;
      if (
        targetEnt &&
        (targetEnt.visible === false ||
          String(targetEnt.type ?? "").toLowerCase() === "hostile" ||
          targetEnt.isAlive === false)
      ) {
        targetEnt = null;
      }
      targetMp =
        potionMpTargets.find((p) => p.id === tid) ??
        potionMpTargets.find((p) => normalizeFr(String(p?.name ?? "")) === targetRefNorm) ??
        potionMpTargets.find((p) => {
          const n = normalizeFr(String(p?.name ?? ""));
          return !!n && targetRefNorm && (n.includes(targetRefNorm) || targetRefNorm.includes(n));
        }) ??
        null;
      if (!targetEnt && !targetMp) {
        return fail("Action impossible : cible introuvable ou non valide pour un soin.");
      }
      const resolvedTargetId = String(targetEnt?.id ?? targetMp?.id ?? tid).trim();
      if (gameMode === "combat") {
        const melee = getMeleeWith(localCombatantId);
        if (!Array.isArray(melee) || !melee.includes(resolvedTargetId)) {
          return fail(
            "Action impossible : en combat, la cible doit être **au contact** pour recevoir la potion."
          );
        }
      }
    }

    const removed = removeOneStackedItem(inv, gear.name);
    if (!removed) {
      return fail(`Action impossible : vous n'avez pas **${gear.name}**.`);
    }
    updatePlayer({ inventory: stackInventory(removed) });

    const giverName = player?.name ?? "Vous";
    const healDice = extractDiceAndFlatBonusFromText(gear.effect, "1d4");
    const effectiveTargetId = String(targetEnt?.id ?? targetMp?.id ?? tid).trim() || tid;
    const tgtName = targetEnt?.name ?? targetMp?.name ?? (isSelf ? giverName : tid);
    const healPending = buildPendingDiceRoll({
      kind: "damage_roll",
      roll: healDice.diceNotation,
      totalBonus: healDice.flatBonus,
      stat: "Soin",
      skill: gear.name,
      raison: `Soin (${gear.name} → ${isSelf ? "vous" : tgtName})`,
      targetId: effectiveTargetId,
      weaponName: gear.name,
      engineContext: {
        stage: "item_heal",
        itemName: gear.name,
        targetId: effectiveTargetId,
        targetName: tgtName,
        isSelf,
      },
    });

    consumeRes(setTurnResources, gameMode, "action");
    return { ok: true, pendingRoll: healPending };
  }

  if (type === "stabilize") {
    const rawTargetRef = String(targetId ?? "").trim();
    const downedAllies = postEntities.filter((e) => {
      if (!e || e.visible === false || String(e.type ?? "").toLowerCase() === "hostile") return false;
      const hp =
        typeof e?.hp?.current === "number" && Number.isFinite(e.hp.current)
          ? Math.trunc(e.hp.current)
          : null;
      return hp != null && hp <= 0;
    });
    const participantProfilesLive = multiplayerParticipantProfilesRef.current;
    const downedMpAllies = Array.isArray(participantProfilesLive)
      ? participantProfilesLive
          .map((p) => {
            const cid = String(p?.clientId ?? "").trim();
            if (!cid) return null;
            const snap = p?.playerSnapshot && typeof p.playerSnapshot === "object" ? p.playerSnapshot : null;
            const hp =
              typeof p?.hpCurrent === "number" && Number.isFinite(p.hpCurrent)
                ? Math.trunc(p.hpCurrent)
                : typeof snap?.hp?.current === "number" && Number.isFinite(snap.hp.current)
                  ? Math.trunc(snap.hp.current)
                  : null;
            const deathState = snap?.deathState && typeof snap.deathState === "object" ? snap.deathState : null;
            const dead = deathState?.dead === true;
            return {
              id: `mp-player-${cid}`,
              cid,
              name: String(p?.name ?? snap?.name ?? "").trim(),
              hp,
              deathState,
              dead,
            };
          })
          .filter((x) => x && x.hp != null && x.hp <= 0 && x.dead !== true)
      : [];
    const targetRefNorm = normalizeFr(rawTargetRef);
    const targetByRef =
      postEntities.find((e) => e && String(e.id ?? "").trim() === rawTargetRef) ??
      postEntities.find((e) => normalizeFr(String(e?.name ?? "")) === targetRefNorm) ??
      postEntities.find((e) => {
        const n = normalizeFr(String(e?.name ?? ""));
        return !!n && targetRefNorm && (n.includes(targetRefNorm) || targetRefNorm.includes(n));
      }) ??
      null;
    const mpTarget =
      downedMpAllies.find((p) => p.id === rawTargetRef) ??
      downedMpAllies.find((p) => normalizeFr(String(p?.name ?? "")) === targetRefNorm) ??
      downedMpAllies.find((p) => {
        const n = normalizeFr(String(p?.name ?? ""));
        return !!n && targetRefNorm && (n.includes(targetRefNorm) || targetRefNorm.includes(n));
      }) ??
      (downedMpAllies.length === 1 ? downedMpAllies[0] : null);
    const fallbackLocalTarget = downedAllies.length === 1 ? downedAllies[0] : null;
    const fallbackMpTarget = downedMpAllies.length === 1 ? downedMpAllies[0] : null;
    const preferMp =
      rawTargetRef.startsWith("mp-player-") ||
      (!!mpTarget && (!targetByRef || String(targetByRef?.id ?? "").trim() !== String(mpTarget.id ?? "").trim()));
    const target = !preferMp ? targetByRef ?? fallbackLocalTarget : targetByRef;
    const selectedMpTarget = preferMp ? mpTarget ?? fallbackMpTarget : mpTarget;
    if (!target && !selectedMpTarget) {
      return fail("Action impossible : précisez la cible à stabiliser.");
    }
    const tid = String(selectedMpTarget?.id ?? target?.id ?? "").trim();
    if (!tid) {
      return fail("Action impossible : cible de stabilisation introuvable.");
    }
    if (target && (target.visible === false || String(target.type ?? "").toLowerCase() === "hostile")) {
      return fail("Action impossible : cible de stabilisation introuvable.");
    }
    if (selectedMpTarget?.dead === true) {
      return fail(`Action impossible : **${selectedMpTarget?.name ?? "la cible"}** est morte.`);
    }
    const hpCur =
      typeof target?.hp?.current === "number" && Number.isFinite(target.hp.current)
        ? Math.trunc(target.hp.current)
        : typeof selectedMpTarget?.hp === "number" && Number.isFinite(selectedMpTarget.hp)
          ? Math.trunc(selectedMpTarget.hp)
          : null;
    if (hpCur == null || hpCur > 0) {
      return fail(`Action impossible : **${target?.name ?? selectedMpTarget?.name ?? "la cible"}** n'est pas à 0 PV.`);
    }
    const ds =
      (target?.deathState && typeof target.deathState === "object" ? target.deathState : null) ??
      (selectedMpTarget?.deathState && typeof selectedMpTarget.deathState === "object" ? selectedMpTarget.deathState : null);
    if (ds?.dead === true) {
      return fail(`Action impossible : **${target?.name ?? selectedMpTarget?.name ?? "la cible"}** est morte.`);
    }
    if (ds?.stable === true) {
      return fail(`Action impossible : **${target?.name ?? selectedMpTarget?.name ?? "la cible"}** est déjà stabilisée.`);
    }
    if (gameMode === "combat") {
      if (!turnResources?.action) {
        return fail(ACTION_CONSUMED_MESSAGE);
      }
      const melee = getMeleeWith(localCombatantId);
      if (!Array.isArray(melee) || !melee.includes(tid)) {
        return fail(
          "Action impossible : pour stabiliser en combat, vous devez être **au corps à corps** de la cible."
        );
      }
      consumeRes(setTurnResources, "combat", "action");
    }
    const pendingRoll = stampPendingRollForActor(
      {
        kind: "check",
        stat: "SAG",
        skill: "Médecine",
        dc: 10,
        raison: `Stabiliser ${target?.name ?? selectedMpTarget?.name ?? "allié"} à 0 PV (DD 10)`,
        totalBonus: computeCheckBonus({ player, stat: "SAG", skill: "Médecine" }),
        targetId: tid,
      },
      player
    );
    return { ok: true, pendingRoll };
  }

  if (type === "impossible") {
    // Intent impossible (décidé par l'IA d'après les règles + ressources fournies).
    return fail(
      "Action impossible : le parseur a classé cette intention comme **impossible** dans le contexte actuel (cible, portée, ressources ou règles de scène)."
    );
  }

  if (type === "loot") {
    if (!targetId) {
      return fail("Action impossible : aucune cible de loot indiquée.");
    }
    const corpse =
      postEntities.find((e) => e?.id === targetId && e?.visible !== false) ?? null;
    if (!corpse) {
      return fail("Action impossible : cible introuvable.");
    }
    const corpseHp = typeof corpse?.hp?.current === "number" ? corpse.hp.current : null;
    const corpseDead = corpse.isAlive === false || (corpseHp != null && corpseHp <= 0);
    if (!corpseDead) {
      return fail("Action impossible : cette cible n'est pas un corps à piller.");
    }
    if (corpse.looted === true) {
      return fail("Action impossible : ce corps a déjà été pillé.");
    }

    const finalLoot = deriveLootItemsFromEntity(corpse, currentRoomId).filter(Boolean);

    if (finalLoot.length === 0) {
      applyEntityUpdates?.([{ action: "update", id: corpse.id, looted: true, lootItems: [] }]);
      return fail("Action impossible : rien à récupérer sur ce corps.");
    }

    const currentInv = Array.isArray(player?.inventory) ? player.inventory : [];
    updatePlayer?.({ inventory: [...currentInv, ...finalLoot] });
    applyEntityUpdates?.([{ action: "update", id: corpse.id, looted: true, lootItems: [] }]);
    addMessage(
      "ai",
      `🧰 Butin récupéré sur ${corpse.name} : ${finalLoot.join(", ")}`,
      "event",
      makeMsgId()
    );
    return { ok: true, pendingRoll: null };
  }

  if (type === "disengage") {
    if (!turnResources?.action) {
      return fail(ACTION_CONSUMED_MESSAGE);
    }
    if (shouldSkipDuplicateSimpleCombatConfirm(localCombatantId, "disengage")) {
      return { ok: true, pendingRoll: null };
    }
    setHasDisengagedThisTurn(true);
    consumeRes(setTurnResources, "combat", "action");
    clearMeleeFor(localCombatantId);
    // Toujours confirmer : le flux parse-intent → processEngineIntent utilise parserMinimalNarration
    // et ne rappelle pas le MJ pour combat_intent, sinon le joueur ne voit aucune réponse (hors logs debug).
    const mpCmd = multiplayerPendingCommandIdFromCtx
      ? String(multiplayerPendingCommandIdFromCtx).trim()
      : "";
    const disengageMsgId = mpCmd ? `mp-engine-disengage:${mpCmd}` : makeMsgId();
    if (
      mpCmd &&
      Array.isArray(messagesRef?.current) &&
      messagesRef.current.some((m) => m && m.id === disengageMsgId)
    ) {
      return { ok: true, pendingRoll: null };
    }
    addMessage(
      "ai",
      "Vous vous désengagez et reculez prudemment (Action).",
      undefined,
      disengageMsgId
    );
    return { ok: true, pendingRoll: null };
  }

  if (type === "dodge") {
    if (!turnResources?.action) {
      return fail(ACTION_CONSUMED_MESSAGE);
    }
    if (shouldSkipDuplicateSimpleCombatConfirm(localCombatantId, "dodge")) {
      return { ok: true, pendingRoll: null };
    }
    consumeRes(setTurnResources, "combat", "action");
    if (dodgeActiveByCombatantIdRef?.current && localCombatantId) {
      dodgeActiveByCombatantIdRef.current[localCombatantId] = true;
    }
    addMessage(
      "ai",
      "Vous adoptez une posture défensive (Esquiver — Action).",
      "meta",
      makeMsgId()
    );
    return { ok: true, pendingRoll: null };
  }

  if (type === "move" && !targetId) {
    // Même intention que parse-intent puis réponse GM → une seule bulle / une seule conso (comme Esquiver / Désengager).
    if (shouldSkipDuplicateSimpleCombatConfirm(localCombatantId, "move_reposition")) {
      return { ok: true, pendingRoll: null };
    }
    if (!turnResources?.movement) {
      return fail(
        "Action impossible : vous n'avez plus de **mouvement** disponible ce tour pour ce personnage (repositionnement sans cible)."
      );
    }
    consumeMovementResource(setTurnResources);
    // Toujours confirmer la consommation du mouvement (le parseur peut aussi déclencher une narration MJ).
    addMessage("ai", combatMoveRepositionMessage(userContent), "dice", makeMsgId());
    emitMeleeMoveDebug?.({
      label: "PJ repositionnement (sans cible)",
      moverId: localCombatantId,
      moverName: player?.name ?? null,
      meleeStateSim: cloneMeleeStateShallow(meleeStateSnapshot),
    });
    return { ok: true, pendingRoll: null, endTurnRequested: shouldEndTurnFromText(userContent) };
  }

  if (!targetId) {
    return fail("Action impossible : aucune cible indiquée.");
  }
  let targetEnt = findLivingTarget(targetId);
  if (!targetEnt && type === "spell") {
    const targetRefNorm = normalizeFr(String(targetId ?? ""));
    const participantProfilesLive = multiplayerParticipantProfilesRef.current;
    const mpSpellTarget = Array.isArray(participantProfilesLive)
      ? participantProfilesLive.find((p) => {
          const cid = String(p?.clientId ?? "").trim();
          const pid = cid ? `mp-player-${cid}` : "";
          const snap = p?.playerSnapshot && typeof p.playerSnapshot === "object" ? p.playerSnapshot : null;
          const ds = snap?.deathState && typeof snap.deathState === "object" ? snap.deathState : null;
          const dead = ds?.dead === true;
          const pname = normalizeFr(String(p?.name ?? snap?.name ?? ""));
          const idMatch = pid && pid === String(targetId ?? "").trim();
          const nameMatch =
            !!pname &&
            !!targetRefNorm &&
            (pname === targetRefNorm || pname.includes(targetRefNorm) || targetRefNorm.includes(pname));
          return (idMatch || nameMatch) && !dead;
        }) ?? null
      : null;
    if (mpSpellTarget) {
      const cid = String(mpSpellTarget?.clientId ?? "").trim();
      const snap =
        mpSpellTarget?.playerSnapshot && typeof mpSpellTarget.playerSnapshot === "object"
          ? mpSpellTarget.playerSnapshot
          : null;
      const hpCur =
        typeof mpSpellTarget?.hpCurrent === "number" && Number.isFinite(mpSpellTarget.hpCurrent)
          ? Math.trunc(mpSpellTarget.hpCurrent)
          : typeof snap?.hp?.current === "number" && Number.isFinite(snap.hp.current)
            ? Math.trunc(snap.hp.current)
            : 0;
      const hpMax =
        typeof mpSpellTarget?.hpMax === "number" && Number.isFinite(mpSpellTarget.hpMax)
          ? Math.max(1, Math.trunc(mpSpellTarget.hpMax))
          : typeof snap?.hp?.max === "number" && Number.isFinite(snap.hp.max)
            ? Math.max(1, Math.trunc(snap.hp.max))
            : Math.max(1, hpCur);
      targetEnt = {
        id: cid ? `mp-player-${cid}` : String(targetId ?? "").trim(),
        name: String(mpSpellTarget?.name ?? snap?.name ?? "allié").trim() || "allié",
        type: "friendly",
        visible: true,
        isAlive: true,
        hp: { current: hpCur, max: hpMax },
        deathState:
          snap?.deathState && typeof snap.deathState === "object" ? snap.deathState : undefined,
      };
    }
  }
  if (!targetEnt) {
    return fail("Action impossible : cible introuvable, invisible ou hors combat.");
  }

  if (canOpenCombatFromExploration) {
    if (targetEnt.controller === "player") {
      return fail("Action impossible : hors combat.");
    }
    const targetAwareBeforeAttack = targetEnt.awareOfPlayer !== false;
    const awarenessUpdates = postEntities
      .filter((e) => e && e.isAlive && e.visible !== false && e.type === "hostile")
      .map((e) => ({
        id: e.id,
        action: "update",
        awareOfPlayer: true,
        // Si l'ennemi n'avait pas encore repéré le PJ, l'ouverture du combat
        // par une attaque le laisse surpris pour le premier round.
        ...(e.awareOfPlayer === false ? { surprised: true } : {}),
      }));
    if (targetEnt.type !== "hostile") {
      const existingTargetUpdateIdx = awarenessUpdates.findIndex((upd) => upd.id === targetEnt.id);
      const targetCombatUpdate = {
        id: targetEnt.id,
        action: "update",
        templateId: inferBestiaryTemplateIdForEntity(targetEnt) ?? undefined,
        type: "hostile",
        controller: "ai",
        awareOfPlayer: true,
        surprised: !targetAwareBeforeAttack,
      };
      if (existingTargetUpdateIdx >= 0) {
        awarenessUpdates[existingTargetUpdateIdx] = {
          ...awarenessUpdates[existingTargetUpdateIdx],
          ...targetCombatUpdate,
        };
      } else {
        awarenessUpdates.push(targetCombatUpdate);
      }
    }
    if (awarenessUpdates.length) {
      applyEntityUpdates?.(awarenessUpdates);
    }
    setGameMode?.("combat");
    // Ouverture de combat D&D 5e : on entre d'abord en initiative.
    // L'attaque déclarée ne se résout pas avant que l'ordre de tour soit établi.
    return { ok: true, pendingRoll: null };
  }

  const tryEngageMelee = () => {
    if (getMeleeWith(localCombatantId).includes(targetId)) return { ok: true };
    if (!turnResources?.movement) {
      return {
        ok: false,
        userMessage:
          "Action impossible : vous n'avez plus de **mouvement** disponible ce tour pour vous rapprocher au corps à corps. (En multijoueur, si le bandeau affiche encore du mouvement, attendez une synchro ou réessayez après le prochain flush.)",
      };
    }
    // Même situation que `move_reposition` : parse-intent + réponse MJ exécutent l'intention deux fois.
    // Après les garde-fous ci-dessus (pour ne pas « manger » un retry légitime si le 1er essai échoue).
    if (shouldSkipDuplicateSimpleCombatConfirm(localCombatantId, `engage_melee:${targetId}`)) {
      return { ok: true };
    }
    consumeMovementResource(setTurnResources);
    // Nouveau rapprochement : quitter tout contact précédent (alliés et ennemis), puis lier la nouvelle cible.
    clearMeleeFor(localCombatantId);
    addMeleeMutual(localCombatantId, targetId);
    emitMeleeEngagementDebug("rapprochement", localCombatantId, targetId);
    const simRapprochement = cloneMeleeStateShallow(meleeStateSnapshot);
    linkMeleePairInCopy(simRapprochement, localCombatantId, targetId);
    emitMeleeMoveDebug?.({
      label: "PJ rapprochement au contact",
      moverId: localCombatantId,
      moverName: player?.name ?? null,
      meleeStateSim: simRapprochement,
    });
    // Bulle combat : confirme la dépense de mouvement (théâtre D&D 5e — un seul « pas » de repositionnement au contact).
    addMessage(
      "ai",
      `⚔️ Vous vous rapprochez au corps à corps de **${targetEnt.name}** — mouvement utilisé pour ce tour.`,
      "dice",
      makeMsgId()
    );
    return { ok: true };
  };

  const buildPendingAfterItem = (resolved, opts = {}) => {
    const assumeInMeleeWithTarget = opts.assumeInMeleeWithTarget === true;
    if (resolved.kind === "error") return fail(resolved.message);
    if (!turnResources?.action) {
      return fail(ACTION_CONSUMED_MESSAGE);
    }

    if (resolved.kind === "spell") {
      const compErr = spellComponentsBlockReasonForPlayer(player, resolved.spellName);
      if (compErr) return fail(`Action impossible : ${compErr}`);
      const spellMeta = getSpellRuntimeMeta(resolved.spellName);
      const spell = spellMeta.raw;
      const resourceKind = resourceKindForCastingTime(spellMeta.castingTime);
      if (!hasResource(turnResources, effectiveMode, resourceKind)) {
        return fail(ACTION_CONSUMED_MESSAGE);
      }
      if (spellMeta.save) {
        return { ok: true, pendingRoll: null, runSpellSave: { spellName: resolved.spellName, target: targetEnt } };
      }
      const meleeWith = getMeleeWith(localCombatantId);
      const inMeleeWithTarget = meleeWith.includes(targetId) || assumeInMeleeWithTarget;
      const contactSpell = spell && spellRangeIsContact(spell);
      const rangedSpellLike =
        !contactSpell && meleeWith.length > 0 && !inMeleeWithTarget;
      if (!hasDisengagedThisTurn && rangedSpellLike) {
        return fail(
          "Action impossible : attaque à distance en mêlée — désengagez-vous ou rapprochez-vous de la cible visée."
        );
      }
      const dmgNotation = String(spell?.damage ?? "").trim();
      const healDice = extractDiceAndFlatBonusFromText(String(spell?.effect ?? ""), "1d4");
      const healLike =
        /soign|récup|regagne|rendre\s+des?\s+points?\s+de\s+vie/i.test(String(spell?.effect ?? "")) &&
        !dmgNotation &&
        !spellMeta.save;
      if (healLike) {
        const healBonus =
          healDice.flatBonus + abilityMod(player?.stats?.[spellcastingAbilityAbbrevForCombatant(player)]);
        return {
          ok: true,
          pendingRoll: buildPendingDiceRoll({
            kind: "damage_roll",
            roll: healDice.diceNotation,
            totalBonus: healBonus,
            stat: "Soin",
            skill: resolved.spellName,
            raison: `Soin (${resolved.spellName} → ${targetEnt.name})`,
            weaponName: resolved.spellName,
            targetId: targetEnt.id,
            engineContext: {
              stage: "spell_heal",
              spellName: resolved.spellName,
              targetId: targetEnt.id,
              targetName: targetEnt.name,
              spellLevel: typeof spell?.level === "number" ? spell.level : 0,
              resourceKind,
            },
          }),
        };
      }
      if (dmgNotation && spellRequiresAttackRoll(spell) === false) {
        return {
          ok: true,
          pendingRoll: buildPendingDiceRoll({
            kind: "damage_roll",
            roll: dmgNotation,
            totalBonus: 0,
            stat: "Dégâts",
            skill: resolved.spellName,
            raison: `Dégâts (${resolved.spellName} → ${targetEnt.name})`,
            weaponName: resolved.spellName,
            targetId: targetEnt.id,
            engineContext: {
              stage: "spell_auto_hit",
              spellName: resolved.spellName,
              targetId: targetEnt.id,
              dmgNotation,
              spellDamageType: spell.damageType ?? "",
              spellLevel: typeof spell.level === "number" ? spell.level : 0,
              resourceKind,
            },
          }),
        };
      }
      const pendingRoll = {
        kind: "attack",
        stat: spellcastingAbilityAbbrevForCombatant(player),
        totalBonus: computeSpellAttackBonus(player),
        raison: `Lancer ${resolved.spellName} sur ${targetEnt.name}`,
        targetId: targetEnt.id,
        weaponName: resolved.spellName,
      };
      return { ok: true, pendingRoll };
    }

    const weapon = resolved.weapon;
    const meleeWith = getMeleeWith(localCombatantId);
    const inMeleeWithTarget = meleeWith.includes(targetId) || assumeInMeleeWithTarget;
    const treatAsThrownWeapon =
      !!getWeaponCompendiumEntry(weapon)?.supportsThrown &&
      userContentSuggestsThrownWeaponAttack(userContent, weapon?.name);
    const attackMode = resolveAttackMode(weapon, player, {
      inMeleeWithTarget,
      treatAsThrown: treatAsThrownWeapon,
    });

    if (
      attackMode.attackType === "ranged" &&
      !hasDisengagedThisTurn &&
      inMeleeWithTarget &&
      !treatAsThrownWeapon
    ) {
      return fail(
        "Action impossible : attaque à distance au corps à corps — désengagez-vous ou utilisez une arme de mêlée."
      );
    }
    if (attackMode.attackType === "melee" && !inMeleeWithTarget) {
      return fail(
        "Action impossible : vous devez être au contact pour attaquer à la mêlée (déplacez-vous d'abord)."
      );
    }

    const pendingRoll = {
      kind: "attack",
      stat: attackMode.ability === "DEX" ? "DEX" : "FOR",
      totalBonus: weapon.attackBonus,
      raison: `Attaque (${weapon.name}) contre ${targetEnt.name}`,
      targetId: targetEnt.id,
      weaponName: weapon.name,
      weaponAttackType: attackMode.attackType,
    };
    return { ok: true, pendingRoll };
  };

  if (type === "move") {
    if (getMeleeWith(localCombatantId).includes(targetId)) {
      if (!parserMinimalNarration) {
        addMessage(
          "ai",
          `Vous êtes déjà au corps à corps de **${targetEnt.name}** (aucun mouvement dépensé).`,
          undefined,
          makeMsgId()
        );
      }
      return { ok: true, pendingRoll: null, endTurnRequested: shouldEndTurnFromText(userContent) };
    }
    const step = tryEngageMelee();
    if (!step.ok) return fail(step.userMessage);
    return { ok: true, pendingRoll: null, endTurnRequested: shouldEndTurnFromText(userContent) };
  }

  if (type === "attack" || type === "spell") {
    const resolved = resolveCombatItemForIntent(type, itemName, player, userContent);
    if (resolved.kind === "error") return fail(resolved.message);
    if (type === "spell" && resolved.kind === "spell") {
      const sm = getSpellRuntimeMeta(resolved.spellName);
      const sp = sm.raw;
      if (
        sp &&
        spellRangeIsContact(sp) &&
        targetId &&
        String(targetId).trim() !== String(localCombatantId).trim() &&
        !sm.save
      ) {
        if (!getMeleeWith(localCombatantId).includes(targetId)) {
          const step = tryEngageMelee();
          if (!step.ok) return fail(step.userMessage);
        }
      }
    }
    return buildPendingAfterItem(resolved);
  }

  if (type === "move_and_attack") {
    const resolved = resolveCombatItemForIntent("attack", itemName, player, userContent);
    if (resolved.kind === "error") return fail(resolved.message);

    /** Besoin de rejoindre la cible ce tour (mêlée / sort au contact uniquement) */
    const needsClosingStep = () => {
      if (getMeleeWith(localCombatantId).includes(targetId)) return false;
      if (resolved.kind === "weapon") {
        const modeAtDistance = resolveAttackMode(resolved.weapon, player, { inMeleeWithTarget: false });
        return modeAtDistance.attackType === "melee";
      }
      if (resolved.kind === "spell") {
        const spellMeta = getSpellRuntimeMeta(resolved.spellName);
        const sp = spellMeta.raw;
        if (spellMeta.save) return false;
        if (sp && !spellRequiresAttackRoll(sp)) return false;
        return /corps a corps|corps à corps/i.test(String(sp?.attack ?? ""));
      }
      return false;
    };

    let assumeInMeleeWithTarget = false;
    if (needsClosingStep()) {
      if (!turnResources?.movement) {
        return fail(
          "Action impossible : il faut du **mouvement** pour rejoindre la cible à la mêlée avant l'attaque, et vous n'en avez plus ce tour."
        );
      }
      if (!turnResources?.action) {
        return fail(ACTION_CONSUMED_MESSAGE);
      }
      // Même situation que `tryEngageMelee` / `move_reposition` : parse-intent puis JSON MJ
      // ré-exécutent l'intention ; `messagesRef` peut être en retard sur `addMessage` → doublon.
      const skipEngageMechanicsReplay = shouldSkipDuplicateSimpleCombatConfirm(
        localCombatantId,
        `move_and_attack_engage:${targetId}`
      );
      if (!skipEngageMechanicsReplay) {
        consumeMovementResource(setTurnResources);
        clearMeleeFor(localCombatantId);
        addMeleeMutual(localCombatantId, targetId);
        emitMeleeEngagementDebug("move_and_attack", localCombatantId, targetId);
        const simMa = cloneMeleeStateShallow(meleeStateSnapshot);
        linkMeleePairInCopy(simMa, localCombatantId, targetId);
        emitMeleeMoveDebug?.({
          label: "PJ déplacement puis attaque (mêlée)",
          moverId: localCombatantId,
          moverName: player?.name ?? null,
          meleeStateSim: simMa,
        });
      }
      assumeInMeleeWithTarget = true;

      // Bulle meta : une seule fois par double pipeline ; jamais sur le passage `parserMinimalNarration`
      // (sinon la 2e passe MJ n'afficherait rien si on réutilisait la même clé mécanique seule).
      if (!parserMinimalNarration) {
        const pjName = player?.name ?? "Votre personnage";
        const moveEngageMsgId =
          `combat-move-engage-${combatEngagementSeqRef.current}-` +
          `${combatRoundInEngagementRef.current}-${combatTurnIndexLiveRef.current}-` +
          `${String(localCombatantId ?? "").trim()}-${String(targetId ?? "").trim()}`;
        const moveEngageAlreadyLogged = Array.isArray(messagesRef.current)
          ? messagesRef.current.some((m) => String(m?.id ?? "").trim() === moveEngageMsgId)
          : false;
        if (
          !moveEngageAlreadyLogged &&
          !shouldSkipDuplicateSimpleCombatConfirm(
            localCombatantId,
            `move_and_attack_engage_msg:${targetId}`
          )
        ) {
          addMessage(
            "user",
            `${pjName} se déplace au corps à corps de ${targetEnt.name}.`,
            "player-utterance",
            moveEngageMsgId,
            undefined,
            pjName
          );
        }
      }
    }

    if (resolved.kind === "weapon") {
      const meleeWith = getMeleeWith(localCombatantId);
      const inMeleeWithTarget = meleeWith.includes(targetId) || assumeInMeleeWithTarget;
      const treatThrownMa =
        !!getWeaponCompendiumEntry(resolved.weapon)?.supportsThrown &&
        userContentSuggestsThrownWeaponAttack(userContent, resolved.weapon?.name);
      const modeAtCurrentPos = resolveAttackMode(resolved.weapon, player, {
        inMeleeWithTarget,
        treatAsThrown: treatThrownMa,
      });
      if (
        modeAtCurrentPos.attackType === "ranged" &&
        !hasDisengagedThisTurn &&
        inMeleeWithTarget &&
        !treatThrownMa
      ) {
        return fail(
          "Action impossible : attaque à distance au corps à corps — désengagez-vous ou utilisez une arme de mêlée."
        );
      }
    } else if (resolved.kind === "spell") {
      const spellMeta = getSpellRuntimeMeta(resolved.spellName);
      const sp = spellMeta.raw;
      const contactSpell = sp && spellRangeIsContact(sp);
      const meleeWith = getMeleeWith(localCombatantId);
      const inMeleeWithTarget = meleeWith.includes(targetId) || assumeInMeleeWithTarget;
      const rangedSpellLike =
        !contactSpell && !spellMeta.save && meleeWith.length > 0 && !inMeleeWithTarget;
      if (!hasDisengagedThisTurn && rangedSpellLike) {
        return fail(
          "Action impossible : attaque à distance en mêlée — désengagez-vous ou rapprochez-vous de la cible visée."
        );
      }
    }

    // Équivalent intent "attack" : pendingRoll / runSpellSave (getMeleeWith peut être stale juste après addMeleeMutual)
    return buildPendingAfterItem(resolved, { assumeInMeleeWithTarget });
  }

  return fail("Type d'intention non géré.");
}

function getSpellRuntimeMeta(spellName) {
  const strict = getStrictSpellMeta(spellName);
  const raw = SPELLS?.[spellName] ?? strict?.raw ?? null;
  return {
    raw,
    strict,
    save: strict?.saveAbility ?? raw?.save ?? null,
    castingTime: strict?.castingTime?.raw ?? raw?.castingTime ?? "",
    concentration:
      strict?.duration?.concentration ?? /concentration/i.test(String(raw?.duration ?? "")),
    attackType: strict?.attackType ?? null,
  };
}

/** True si le sort nécessite un jet d'attaque de sort (d20) ; false pour touche auto (ex. Projectile magique). */
function spellRequiresAttackRoll(spell) {
  if (!spell || typeof spell !== "object") return true;
  const atk = String(spell.attack ?? "").trim();
  if (!atk) return true;
  const low = atk.toLowerCase();
  if (/touche\s*auto|auto-?hit|touch\s*auto/.test(low)) return false;
  return true;
}

/** Sorts SRD « contact » (buff, soins, etc.) : la règle « sort à distance en mêlée » ne s'applique pas. */
function spellRangeIsContact(spell) {
  if (!spell || typeof spell !== "object") return false;
  const r = String(spell.range ?? "").trim().toLowerCase();
  if (!r) return false;
  return r === "contact" || /^contact\b/i.test(String(spell.range ?? ""));
}

function canonicalizeSpellNameAgainstCombatant(combatant, spellName) {
  const raw = normalizeFr(spellName);
  if (!raw) return null;
  const known = getCombatantKnownSpells(combatant);
  // match exact normalisé
  for (const s of known) {
    if (normalizeFr(s) === raw) return s;
  }
  // match fuzzy (tolère petites fautes: "fraccas" -> "Fracas")
  const fuzzy = bestFuzzyMatch(raw, known);
  return fuzzy ?? null;
}

function canonicalizeSpellNameAgainstPlayer(player, spellName) {
  return canonicalizeSpellNameAgainstCombatant(player, spellName);
}

function findKnownSpellInText(text, knownSpells) {
  const t = normalizeFr(text);
  for (const s of knownSpells ?? []) {
    const sl = normalizeFr(s);
    if (sl && t.includes(sl)) return s;
  }
  return null;
}

function findSpellInTextFromList(text, spellsList) {
  const t = normalizeFr(text);
  for (const s of spellsList ?? []) {
    const sl = normalizeFr(s);
    if (sl && t.includes(sl)) return s;
  }
  return null;
}

function findTargetFromText(text, currentEntities) {
  const t = String(text ?? "").toLowerCase();
  const candidates = (currentEntities ?? []).filter((e) => e && e.visible && e.isAlive && e.type !== "object");
  // match direct by name
  for (const e of candidates) {
    const nl = String(e.name ?? "").toLowerCase();
    if (nl && t.includes(nl)) return e;
  }
  // if exactly one visible hostile alive, auto-pick
  const hostiles = candidates.filter((e) => e.type === "hostile");
  if (hostiles.length === 1) return hostiles[0];
  return null;
}

function normalizeFr(s) {
  return String(s ?? "")
    .toLowerCase()
    // Unifier les apostrophes typographiques (’ ‘) → '
    .replace(/[\u2019\u2018]/g, "'")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function inferBestiaryTemplateIdForEntity(entityLike) {
  const templateAlias = {
    bugbear: "gobelours",
  };
  const normalizeTemplateId = (raw) => {
    const key = String(raw ?? "").trim().toLowerCase();
    if (!key) return "";
    const aliased = templateAlias[key] ?? key;
    return BESTIARY?.[aliased] ? aliased : "";
  };
  const explicitTemplateId =
    typeof entityLike?.templateId === "string" && entityLike.templateId.trim()
      ? entityLike.templateId.trim()
      : "";
  const explicitResolved = normalizeTemplateId(explicitTemplateId);
  if (explicitResolved) return explicitResolved;

  const rawId = String(entityLike?.id ?? "").trim().toLowerCase();
  if (rawId) {
    const withoutNumericSuffix = rawId.replace(/_\d+$/g, "");
    const idResolved = normalizeTemplateId(withoutNumericSuffix);
    if (idResolved) return idResolved;
    for (const token of withoutNumericSuffix.split("_").filter(Boolean)) {
      const tokenResolved = normalizeTemplateId(token);
      if (tokenResolved) return tokenResolved;
    }
  }

  const nameTokens = normalizeFr(entityLike?.name ?? "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
  for (const token of nameTokens) {
    const tokenResolved = normalizeTemplateId(token);
    if (tokenResolved) return tokenResolved;
  }

  return null;
}

function detectMentionedWeaponName(text) {
  const t = normalizeFr(text);
  const keys = Object.keys(WEAPONS ?? {});
  for (const name of keys) {
    const nl = normalizeFr(name);
    if (!nl) continue;
    if (t.includes(nl)) return name;
  }
  return null;
}

function canonicalizeWeaponNameAgainstCombatant(combatant, weaponName) {
  const raw = normalizeFr(weaponName);
  if (!raw) return null;
  const ownedNames = (combatant?.weapons ?? []).map((w) => w?.name).filter(Boolean);
  // match exact normalisé
  for (const name of ownedNames) {
    if (normalizeFr(name) === raw) return name;
  }
  // match fuzzy (ex: "repiere" -> "Rapière")
  const fuzzy = bestFuzzyMatch(raw, ownedNames);
  return fuzzy ?? null;
}

function canonicalizeWeaponNameAgainstPlayer(player, weaponName) {
  return canonicalizeWeaponNameAgainstCombatant(player, weaponName);
}

async function resolveSpellCastNow({
  text,
  player,
  entities,
  gameMode,
  turnResources,
  setTurnResources,
  updatePlayer,
  applyEntityUpdates,
  replaceEntities,
  ensureCombatState,
  debugMode,
  debugNextRoll,
  setDebugNextRoll,
  addMessage,
  makeMsgId,
  callApi,
}) {
  const prepared = Array.isArray(player?.selectedSpells) ? player.selectedSpells : [];
  const spellbook =
    player?.entityClass === "Magicien" && Array.isArray(player?.wizard?.spellbook)
      ? player.wizard.spellbook
      : null;
  const isCleric = player?.entityClass === "Clerc";
  const allClericSpells = isCleric
    ? Object.entries(SPELLS ?? {})
        .filter(([, s]) => Array.isArray(s?.classes) && s.classes.includes("Clerc"))
        .map(([name]) => name)
    : null;

  // 1) Si Magicien : reconnaître aussi les sorts du grimoire pour pouvoir afficher un message
  // "pas préparé" au lieu de ne rien faire.
  const spellFromPrepared = findKnownSpellInText(text, prepared);
  const spellFromBook = spellbook ? findSpellInTextFromList(text, spellbook) : null;
  const spellFromAnyCleric = allClericSpells ? findSpellInTextFromList(text, allClericSpells) : null;
  const spellName = spellFromPrepared ?? spellFromBook ?? spellFromAnyCleric;
  if (!spellName) return false;

  if (player?.entityClass === "Magicien" && spellbook && spellFromBook && !spellFromPrepared) {
    // Afficher le message du joueur tel quel
    addMessage("user", text, undefined, makeMsgId(), undefined, player?.name ?? "Joueur");
    addMessage(
      "ai",
      `âš  **${spellFromBook}** est bien dans votre grimoire, mais il nâ€™est **pas préparé**. Préparez-le (INT + niveau) avant de pouvoir le lancer.`,
      undefined,
      makeMsgId()
    );
    return true;
  }

  if (isCleric && spellFromAnyCleric && !spellFromPrepared) {
    // Afficher le message du joueur tel quel
    addMessage("user", text, undefined, makeMsgId(), undefined, player?.name ?? "Joueur");
    addMessage(
      "ai",
      `âš  **${spellFromAnyCleric}** est un sort de Clerc, mais il nâ€™est **pas préparé**. Préparez-le (SAG + niveau) ou choisissez un autre sort.`,
      undefined,
      makeMsgId()
    );
    return true;
  }

  const target = findTargetFromText(text, entities);
  if (!target) return false;

  const spellMeta = getSpellRuntimeMeta(spellName);
  const spell = spellMeta.raw;
  if (!spell) return false;

  const compErrEarly = spellComponentsBlockReasonForPlayer(player, spellName);
  if (compErrEarly) {
    addMessage("user", text, undefined, makeMsgId(), undefined, player?.name ?? "Joueur");
    addMessage("ai", `⚠️ ${compErrEarly}`, undefined, makeMsgId());
    return true;
  }

  // Afficher le message du joueur tel quel, même si la résolution est 100% moteur.
  // (Sinon l'action "disparaît" visuellement car callApi n'est appelé que sur le message ðŸŽ².)
  addMessage("user", text, undefined, makeMsgId(), undefined, player?.name ?? "Joueur");

  // Ressource (Action/Bonus/Réaction) selon castingTime
  const resourceKind = resourceKindForCastingTime(spellMeta.castingTime);
  // Important : un sort offensif est traité comme une action de combat, même si le mode
  // n'était pas encore officiellement "combat" au moment du cast.
  if (!hasResource(turnResources, "combat", resourceKind)) {
    const label = resourceKind === "bonus" ? "Action bonus" : resourceKind === "reaction" ? "Réaction" : "Action";
    addMessage(
      "ai",
      `âš  Vous avez déjÃ  utilisé votre **${label}** ce tour-ci â€” impossible de lancer ${spellName} maintenant.`,
      undefined,
      makeMsgId()
    );
    return true; // handled (blocked)
  }

  // Emplacements de sorts
  const spellLevel = spell?.level ?? 0;
  const slotResult = spendSpellSlot(player, updatePlayer, spellLevel);
  if (!slotResult.ok) {
    addMessage(
      "ai",
      `âš  Vous n'avez plus d'emplacements de sort disponibles pour lancer ${spellName}.`,
      undefined,
      makeMsgId()
    );
    return true; // handled (blocked)
  }

  const dc = computeSpellSaveDC(player);

  // Sort Ã  sauvegarde (ex: Fracasse) : le joueur ne lance RIEN, le moteur résout tout.
  if (spellMeta.save) {
    const saveKey = spellMeta.save;
    const nat = debugNextRoll ?? (Math.floor(Math.random() * 20) + 1);
    if (debugNextRoll !== null) setDebugNextRoll(null);
    const saveBonus = computeEntitySaveBonus(target, saveKey);
    const total = nat + saveBonus;
    const succeeded = total >= dc;

    const dmgNotation = String(spell.damage ?? "1d6");
    const r = rollDiceDetailed(dmgNotation);
    const baseDmg = Math.max(0, r.total);
    const finalDmg = succeeded ? Math.floor(baseDmg / 2) : baseDmg;

    let myUpdates = [];
    if (target.type !== "hostile") myUpdates.push({ id: target.id, action: "update", type: "hostile" });

    const hpBefore = target.hp?.current ?? null;
    let hpAfter = hpBefore;
    if (target.hp && finalDmg > 0) {
      const newHp = Math.max(0, target.hp.current - finalDmg);
      hpAfter = newHp;
      if (newHp <= 0) {
        myUpdates.push({ id: target.id, action: "kill" });
      } else {
        myUpdates.push({ id: target.id, action: "update", hp: { current: newHp, max: target.hp.max } });
      }
    }

    myUpdates = markSceneHostilesAware(entities, myUpdates);
    const nextEntities = myUpdates.length ? applyUpdatesLocally(entities, myUpdates) : entities;
    if (myUpdates.length) applyEntityUpdates(myUpdates);
    ensureCombatState(nextEntities);

    // Consommer la ressource (Action/Bonus/Réaction) comme en combat
    consumeResource(setTurnResourcesSynced, "combat", resourceKind);

    // Message moteur (ðŸŽ² réservé au moteur)
    const bonusStr = fmtMod(saveBonus);
    const saveLine =
      nat === 20
        ? `Nat **20** ðŸ’¥ (réussite automatique)`
        : nat === 1
        ? `Nat **1** ðŸ’€ (échec automatique)`
        : `Nat ${nat} ${bonusStr} = **${total}** vs DD ${dc}`;
    const outcome = succeeded ? "âœ” Réussite â€” dégâts réduits." : "âœ– Ã‰chec â€” dégâts complets.";
    const dmgDetail = `${formatDiceNotationDetail(r, dmgNotation)}${succeeded ? " â†’ moitié dégâts" : ""}`;
    const dmgLine = finalDmg > 0 ? `${dmgDetail} = **${finalDmg} dégâts ${spell.damageType ?? ""}**` : "Aucun dégât.";
    const hpDebug = debugMode && target.hp ? ` (PV: ${hpBefore} â†’ ${hpAfter}/${target.hp.max})` : "";

    const diceContent =
      `ðŸŽ² Jet de sauvegarde (${saveKey} pour ${spellName} â†’ ${target.name}) â€” ${saveLine}\n` +
      `${outcome} ${dmgLine}.${hpDebug}`;

    addMessage(
      "ai",
      `[DEBUG] Résolution sort auto (save) ${spellName}\n` +
        safeJson({
          targetId: target.id,
          targetName: target.name,
          saveType: saveKey,
          nat,
          saveBonus,
          total,
          dc,
          succeeded,
          damage: finalDmg,
          hpBefore,
          hpAfter,
          slotLevelUsed: slotResult.usedLevel,
        }),
      "debug",
      makeMsgId()
    );

    await callApi(diceContent, "dice", false, {
      entities: nextEntities,
      engineEvent: {
        kind: "spell_save_resolution",
        spellName,
        targetId: target.id,
        saveType: saveKey,
        nat,
        total,
        dc,
        succeeded,
        damage: finalDmg,
        targetHpBefore: hpBefore,
        targetHpAfter: hpAfter,
        targetHpMax: target.hp?.max ?? null,
        targetIsAlive: hpAfter === null ? true : hpAfter > 0,
        slotLevelUsed: slotResult.usedLevel,
      },
    });
    return true;
  }

  // Sorts Ã  jet d'attaque (optionnel) : pas implémenté ici (on laisse la voie rollRequest existante)
  return false;
}

/** Attache le PJ et le client concernés par un jet (session partagée). */
function stampPendingRollForActor(roll, actingPlayer, submitterClientId) {
  if (!roll || typeof roll !== "object") return roll;
  const pid =
    actingPlayer?.id != null && String(actingPlayer.id).trim()
      ? String(actingPlayer.id).trim()
      : null;
  const sidFromPid =
    pid && /^mp-player-/i.test(pid) ? String(pid).replace(/^mp-player-/i, "").trim() : null;
  const sid =
    submitterClientId != null && String(submitterClientId).trim()
      ? String(submitterClientId).trim()
      : sidFromPid;
  const out = { ...roll };
  if (pid) out.forPlayerId = pid;
  if (sid) out.forClientId = sid;
  if (actingPlayer?.name && String(actingPlayer.name).trim())
    out.forPlayerName = String(actingPlayer.name).trim();
  return out;
}

/**
 * Anti double bulle « jet de sauvegarde contre la mort » : les refs React repartent à zéro
 * au remontage (Strict Mode) ou deux effets peuvent appeler `preparePlayerTurnStartState`
 * dans le même segment — une clé module survit au cycle de vie du composant.
 */
const emittedDeathSavePromptKeys = new Set();

/**
 * Un seul `nextTurn()` par segment pour les passages auto (PJ stabilisé, filet MP).
 * Évite double avance d’initiative / double tour ennemi quand le propriétaire et un autre client réagissent au même slot.
 */
const scheduledStableCombatTurnAdvanceKeys = new Set();

function scheduleStableCombatTurnAdvance(skipKey, runNextTurn) {
  const k = String(skipKey ?? "").trim();
  if (!k || typeof runNextTurn !== "function") return;
  if (scheduledStableCombatTurnAdvanceKeys.has(k)) return;
  scheduledStableCombatTurnAdvanceKeys.add(k);
  // setTimeout(0) et non queueMicrotask : sinon `nextTurn` peut s'exécuter avant la fin de
  // `runEnemyTurnsUntilPlayer` (le `await preparePlayerTurnStartState` n'a pas encore rendu la main),
  // alors `enemyTurnLoopInProgressRef` est encore true → sortie immédiate, initiative figée.
  setTimeout(async () => {
    scheduledStableCombatTurnAdvanceKeys.delete(k);
    try {
      await runNextTurn();
    } catch {
      /* ignore */
    }
  }, 0);
}

/**
 * Journal déjà une bulle « lancez le jet de sauvegarde contre la mort » sans bulle de résultat (dice) après.
 * Évite un doublon après F5 / sync Firestore : le message est dans le journal mais les refs module sont vides.
 */
function hasUnresolvedDeathSavePromptInMessages(messagesArr, playerName) {
  if (!Array.isArray(messagesArr) || messagesArr.length === 0) return false;
  const name = String(playerName ?? "").trim();
  const promptNeedle = "lancez maintenant";
  const promptNeedle2 = "jet de sauvegarde contre la mort";
  let lastPromptIdx = -1;
  for (let i = messagesArr.length - 1; i >= 0; i--) {
    const m = messagesArr[i];
    if (!m || m.role !== "ai") continue;
    const c = String(m.content ?? "");
    const low = c.toLowerCase();
    if (!low.includes(promptNeedle) || !low.includes(promptNeedle2)) continue;
    if (!c.includes("0 PV")) continue;
    if (name && !c.includes(name) && !/Vous êtes/i.test(c)) continue;
    lastPromptIdx = i;
    break;
  }
  if (lastPromptIdx < 0) return false;
  for (let j = lastPromptIdx + 1; j < messagesArr.length; j++) {
    const m = messagesArr[j];
    if (!m || m.role !== "ai") continue;
    const c = String(m.content ?? "");
    const t = m.type ?? null;
    if (
      t === "dice" &&
      /sauvegarde contre la mort/i.test(c) &&
      !/lancez maintenant/i.test(c)
    ) {
      return false;
    }
  }
  return true;
}

function pendingRollTargetsLocalPlayer(
  roll,
  localPlayer,
  localClientId,
  inMultiplayerSession,
  multiplayerSessionId = null,
  participantProfiles = null
) {
  if (!roll || typeof roll !== "object") return false;
  const groupAud =
    roll.kind === "check" &&
    (roll.audience === "global" || roll.audience === "selected") &&
    roll.returnToArbiter === true;
  if (groupAud) {
    const me = localClientId != null && String(localClientId).trim() ? String(localClientId).trim() : "";
    const map = roll.globalRollsByClientId && typeof roll.globalRollsByClientId === "object" ? roll.globalRollsByClientId : {};
    if (me && map[me] != null) return false;
    if (inMultiplayerSession && me) {
      const expected = getGroupSkillCheckExpectedClientIds(
        multiplayerSessionId,
        participantProfiles,
        me,
        roll
      );
      if (Array.isArray(expected) && expected.length && !expected.includes(me)) return false;
    }
    return true;
  }
  const pid = roll.forPlayerId != null && String(roll.forPlayerId).trim() ? String(roll.forPlayerId).trim() : null;
  const cid = roll.forClientId != null && String(roll.forClientId).trim() ? String(roll.forClientId).trim() : null;
  if (!inMultiplayerSession) {
    if (!pid && !cid) return true;
    if (localPlayer?.id != null && pid === String(localPlayer.id)) return true;
    return false;
  }
  // Multijoueur : `forClientId` est la source de vérité (quel onglet doit lancer).
  // Ne pas exiger aussi un match sur `forPlayerId` : la fiche locale utilise souvent
  // `mp-player-<clientId>` alors que stampPendingRoll met encore l'id gabarit (`pre-*`).
  if (cid && localClientId) {
    return cid === localClientId;
  }
  if (!pid && !cid) return true;
  if (pid && localPlayer?.id != null && pid === String(localPlayer.id)) return true;
  return false;
}

function getConnectedParticipantClientIds(participantProfiles) {
  if (!Array.isArray(participantProfiles)) return [];
  const out = [];
  const seen = new Set();
  for (const p of participantProfiles) {
    if (!p || p.connected === false) continue;
    const cid = String(p?.clientId ?? "").trim();
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    out.push(cid);
  }
  return out;
}

function getGlobalSkillCheckExpectedClientIds(multiplayerSessionId, participantProfiles, fallbackClientId) {
  if (multiplayerSessionId && Array.isArray(participantProfiles)) {
    const c = getConnectedParticipantClientIds(participantProfiles);
    if (c.length) return c;
  }
  const f = String(fallbackClientId ?? "").trim();
  return f ? [f] : [];
}

const MP_PLAYER_ENTITY_ID_RE = /^mp-player-(.+)$/i;

/** Extrait le clientId Firestore depuis un id d'entité multijoueur `mp-player-<clientId>`. */
function clientIdFromMpPlayerEntityId(entityId) {
  const m = String(entityId ?? "").trim().match(MP_PLAYER_ENTITY_ID_RE);
  return m ? String(m[1]).trim() : "";
}

/**
 * Ids d'entité reconnus pour filtrer `rollTargetEntityIds` côté client.
 * Les fiches `mp-player-<clientId>` sont envoyées au parse-intent mais ne sont pas
 * toujours dans `entities` du moteur (elles sont surtout fusionnées à l'affichage) ;
 * sans les participants session, un jet « selected » pour deux PJ ne garde qu'un seul id.
 */
function buildEntityIdSetForMpRollTargetSanitize(baseEntities, multiplayerSessionId, participantProfilesLive) {
  const s = new Set(
    (Array.isArray(baseEntities) ? baseEntities : [])
      .map((e) => (e?.id != null ? String(e.id).trim() : ""))
      .filter(Boolean)
  );
  if (multiplayerSessionId && Array.isArray(participantProfilesLive)) {
    for (const p of participantProfilesLive) {
      const cid = String(p?.clientId ?? "").trim();
      if (cid) s.add(`mp-player-${cid}`);
    }
  }
  return s;
}

/**
 * ClientIds qui doivent lancer pour un jet de groupe (arbitre / parse-intent) :
 * `global` = tous les connectés ; `selected` = sous-ensemble dérivé de `roll.rollTargetEntityIds`.
 */
function getGroupSkillCheckExpectedClientIds(multiplayerSessionId, participantProfiles, fallbackClientId, roll) {
  if (!roll || typeof roll !== "object") {
    const f = String(fallbackClientId ?? "").trim();
    return f ? [f] : [];
  }
  const aud = String(roll.audience ?? "single").trim().toLowerCase();
  if (aud === "selected") {
    const raw = roll.rollTargetEntityIds;
    const ids = Array.isArray(raw)
      ? [...new Set(raw.map((x) => String(x ?? "").trim()).filter(Boolean))]
      : [];
    const fromEntities = [...new Set(ids.map(clientIdFromMpPlayerEntityId).filter(Boolean))];
    if (!fromEntities.length) {
      const f = String(fallbackClientId ?? "").trim();
      return f ? [f] : [];
    }
    // Liste explicite parse-intent / arbitre : ne pas réduire aux seuls onglets marqués « connectés »
    // dans participantProfiles (un 2e joueur peut être absent ou mal flaggé → un seul lanceur, UI bloquée).
    return fromEntities;
  }
  if (aud === "global") {
    return getGlobalSkillCheckExpectedClientIds(
      multiplayerSessionId,
      participantProfiles,
      fallbackClientId
    );
  }
  const f = String(fallbackClientId ?? "").trim();
  return f ? [f] : [];
}

/**
 * MP : jet de compétence groupe (`global` / `selected`) — chaque clientId attendu a déjà une entrée
 * dans `globalRollsByClientId`. Sert à ne plus bloquer la saisie ni afficher « lancez le dé » alors
 * que la suite est uniquement arbitre MJ + narration (latence API).
 */
function isGlobalOrSelectedGroupSkillAllRollsRecorded(
  pendingRoll,
  multiplayerSessionId,
  participantProfiles,
  clientId
) {
  if (!pendingRoll || typeof pendingRoll !== "object") return false;
  if (!multiplayerSessionId) return false;
  if (pendingRoll.kind !== "check") return false;
  const aud = String(pendingRoll.audience ?? "").trim().toLowerCase();
  if (aud !== "global" && aud !== "selected") return false;
  if (pendingRoll.returnToArbiter !== true) return false;
  const expected = getGroupSkillCheckExpectedClientIds(
    multiplayerSessionId,
    participantProfiles,
    clientId,
    pendingRoll
  );
  const map =
    pendingRoll.globalRollsByClientId && typeof pendingRoll.globalRollsByClientId === "object"
      ? pendingRoll.globalRollsByClientId
      : {};
  return expected.length > 0 && expected.every((eid) => map[eid] != null);
}

/** Libellé court pour le bandeau « jet en attente » (autre onglet) — jets de groupe / multi-PJ. */
function formatGroupSkillCheckWaitTitle(roll, entities, forPlayerNameFallback) {
  const aud = String(roll?.audience ?? "").trim().toLowerCase();
  if (!(roll?.kind === "check" && (aud === "global" || aud === "selected"))) {
    return forPlayerNameFallback || "un joueur";
  }
  if (aud === "selected" && Array.isArray(roll.rollTargetEntityIds) && roll.rollTargetEntityIds.length) {
    const names = roll.rollTargetEntityIds
      .map((eid) => {
        const id = String(eid ?? "").trim();
        const ent = Array.isArray(entities) ? entities.find((e) => e && String(e.id).trim() === id) : null;
        return ent?.name != null ? String(ent.name).trim() : "";
      })
      .filter(Boolean);
    if (names.length) return names.join(" · ");
    return "PJ sélectionnés";
  }
  return "tous les PJ connectés";
}

function buildGlobalPlayerCheckGroupRollOutcome({ roll, globalRollsByClientId, dc }) {
  const by = globalRollsByClientId && typeof globalRollsByClientId === "object" ? globalRollsByClientId : {};
  const entries = Object.entries(by).map(([clientId, v]) => ({
    clientId,
    nat: Math.trunc(Number(v?.nat)),
    total: Math.trunc(Number(v?.total)),
    success: typeof v?.success === "boolean" ? v.success : null,
    playerName: v?.playerName != null ? String(v.playerName) : null,
  }));
  const totals = entries.map((e) => e.total).filter((n) => Number.isFinite(n));
  const lowestTotal = totals.length ? Math.min(...totals) : null;
  const highestTotal = totals.length ? Math.max(...totals) : null;
  let successesCount = 0;
  let failuresCount = 0;
  for (const e of entries) {
    if (e.success === true) successesCount++;
    else if (e.success === false) failuresCount++;
  }
  return {
    kind: "player_check_group",
    stat: roll.stat ?? null,
    skill: roll.skill ?? null,
    dc,
    byClientId: by,
    summary: {
      lowestTotal,
      highestTotal,
      successesCount,
      failuresCount,
      rollsCount: entries.length,
      anyNat1: entries.some((e) => e.nat === 1),
      anyNat20: entries.some((e) => e.nat === 20),
    },
  };
}

function shouldRunGlobalArbiterFollowup({ multiplayerSessionId, clientId, hostClientId, expectedClientIds }) {
  if (!multiplayerSessionId) return true;
  const ids = Array.isArray(expectedClientIds)
    ? expectedClientIds.map((x) => String(x ?? "").trim()).filter(Boolean)
    : [];
  if (!ids.length) return true;
  const me = String(clientId ?? "").trim();
  const host = String(hostClientId ?? "").trim();
  if (host && ids.includes(host)) return me === host;
  const sorted = [...new Set(ids)].sort();
  return sorted[0] === me;
}

/**
 * Réflexion MJ / appels IA : délai max avant `AbortError` (parse-intent, /api/chat, etc.).
 */
const API_AI_THINKING_TIMEOUT_MS = 3 * 60 * 1000;
// parse-intent peut répondre juste après 3 min ; on garde une marge
// pour éviter les faux "Timeout (parse-intent)" côté client.
const PARSE_INTENT_TIMEOUT_MS = API_AI_THINKING_TIMEOUT_MS + 30000;

/**
 * Arbitre de scène seul : prompt très long (systeme + secrets + salles connectées + fiche joueur).
 * Délai client avant AbortError sur le fetch (aligné avec maxDuration route gm-arbiter, 15 min).
 */
const GM_ARBITER_FETCH_TIMEOUT_MS = 15 * 60 * 1000;

/** Hooks combat (début/fin de tour) : éviter de bloquer la boucle ennemie + flush MP sur Gemini lent. */
const GM_ARBITER_COMBAT_HOOK_FETCH_TIMEOUT_MS = 45_000;

/**
 * Multijoueur : plafond pour la résolution complète d’un `pendingCommand` (parse-intent,
 * gm-arbiter ×2 si jet secret, /api/chat, etc.). Doit rester ≥ somme des segments lents.
 */
const MP_PENDING_CALL_API_MS = Math.max(
  25 * 60 * 1000,
  API_AI_THINKING_TIMEOUT_MS + GM_ARBITER_FETCH_TIMEOUT_MS * 2 + 120000
);

// ---------------------------------------------------------------------------
// Composant principal
// ---------------------------------------------------------------------------

export default function ChatInterface() {
  const {
    messages, addMessage, appendSceneImagePendingSlot, updateMessage, removeMessagesByIds,
    player, setHp, setPlayer, updatePlayer,
    persistenceReady,
    worldTimeMinutes, setWorldTimeMinutes,
    pendingRoll, setPendingRoll,
    clientId,
    currentScene, setCurrentScene,
    currentSceneName,
    sceneVersion,
    currentRoomId, setCurrentRoomId,
    entities,
    getEntitiesSnapshot,
    applyEntityUpdates, replaceEntities,
    rememberRoomEntitiesSnapshot, takeEntitiesForRoom, getRoomMemory, appendRoomMemory, setRoomMemoryText,
    setGameMode, setCombatOrder,
    gameMode,
    combatOrder, combatTurnIndex, combatTurnWriteSeq, setCombatTurnIndex,
    awaitingPlayerInitiative,
    waitForGmNarrationForInitiative,
    setWaitForGmNarrationForInitiative,
    npcInitiativeDraft, commitPlayerInitiativeRoll,
    playerInitiativeRollsByEntityId,
    registerCombatNextTurn, nextTurn,
    hasDisengagedThisTurn, setHasDisengagedThisTurn,
    turnResourcesByCombatantId,
    setTurnResourcesForCombatant,
    meleeState,
    getMeleeWith, addMeleeMutual, removeFromMelee, clearMeleeFor, setReactionFor, hasReaction, initCombatReactions,
    combatHiddenIds, setCombatHiddenIds,
    combatStealthTotalByCombatantId,
    setCombatStealthTotalForCombatant,
    clearCombatStealthTotals,
    aiProvider, setAiProvider,
    autoPlayerEnabled, setAutoPlayerEnabled,
    autoRollEnabled, setAutoRollEnabled,
    multiplayerSessionId,
    multiplayerPendingCommand,
    multiplayerThinkingState,
    multiplayerParticipantProfiles,
    patchParticipantProfileHp,
    patchParticipantProfileInventory,
    patchParticipantProfilePlayerSnapshot,
    patchParticipantProfileDeathState,
    multiplayerHostClientId,
    setMultiplayerGameModeImmediate,
    flushMultiplayerSharedState,
    submitMultiplayerCommand,
    clearMultiplayerPendingCommand,
    tryAcquireMultiplayerCommandLease,
    releaseMultiplayerCommandLease,
    setMultiplayerThinkingState,
    acquireMultiplayerAutoPlayerIntentLock,
    releaseMultiplayerAutoPlayerIntentLock,
    acquireMultiplayerProcessingLock,
    releaseMultiplayerProcessingLock,
    debugForceUnblockProcessingPipeline,
    restartAdventure,
    debugMode, setDebugMode,
    setCurrentSceneName, setCurrentSceneImage,
    debugNextRoll, setDebugNextRoll,
    imageModel, setImageModel,
  } = useGame();

  const [input, setInput]               = useState("");
  const [debugInput, setDebugInput]     = useState("");
  const [isTyping, setIsTyping]         = useState(false);
  const [isAutoPlayerThinking, setIsAutoPlayerThinking] = useState(false);
  const [error, setError]               = useState(null);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const [movementGate, setMovementGate] = useState(null); // { text: string, hostileIds: string[] }
  const [opportunityAttackPrompt, setOpportunityAttackPrompt] = useState(null); // { reactorId, targetId, reactorName, targetName }
  /** Réaction *Bouclier* : toucher confirmé par l'ennemi — le PJ local peut lancer le sort avant les dégâts. */
  const [shieldReactionPrompt, setShieldReactionPrompt] = useState(null); // { defenderId, attackerName, weaponName, defenderName, atkTotal, baseAc }
  const [showActionsHelp, setShowActionsHelp] = useState(false);
  const [fullImageUrl, setFullImageUrl] = useState(null);
  const inputValueRef = useRef("");
  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);
  const [sceneImageTrigger, setSceneImageTrigger] = useState(null);
  const [shortRestState, setShortRestState] = useState(null); // { startedAtMinute: number, spentDice: number }
  const [arcaneRecoveryOpen, setArcaneRecoveryOpen] = useState(false);
  const [arcaneRecoveryPick, setArcaneRecoveryPick] = useState({}); // { [spellLevel]: number }
  const [latencyAvgMs, setLatencyAvgMs] = useState(null);
  const [latencyLastMs, setLatencyLastMs] = useState(null);
  const [sneakAttackArmed, setSneakAttackArmed] = useState(false);
  const [sneakAttackUsedThisTurn, setSneakAttackUsedThisTurn] = useState(false);
  const [failedRequestPayload, setFailedRequestPayload] = useState(null);
  const [flowBlocked, setFlowBlocked] = useState(false);
  const [isRetryingFailedRequest, setIsRetryingFailedRequest] = useState(false);
  const [initiativeSubmittedLocal, setInitiativeSubmittedLocal] = useState(false);
  const initiativeSubmittedLocalRef = useRef(initiativeSubmittedLocal);
  useEffect(() => {
    initiativeSubmittedLocalRef.current = initiativeSubmittedLocal;
  }, [initiativeSubmittedLocal]);
  const multiplayerParticipantProfilesRef = useRef(
    Array.isArray(multiplayerParticipantProfiles) ? multiplayerParticipantProfiles : []
  );
  useEffect(() => {
    multiplayerParticipantProfilesRef.current = Array.isArray(multiplayerParticipantProfiles)
      ? multiplayerParticipantProfiles
      : [];
  }, [multiplayerParticipantProfiles]);

  /** Primitive stable pour deps d'effets (évite taille / identité instable du tableau `profiles`). */
  const multiplayerParticipantProfilesRollGateKey = useMemo(() => {
    if (!Array.isArray(multiplayerParticipantProfiles)) return "";
    return multiplayerParticipantProfiles
      .map((p) => `${String(p?.clientId ?? "").trim()}:${p?.connected === false ? "0" : "1"}`)
      .filter(Boolean)
      .sort()
      .join("|");
  }, [multiplayerParticipantProfiles]);

  /** Aligné sur l'ordre d'initiative / clés `meleeState` (voir `resolveLocalPlayerCombatantId`). */
  const localCombatantId = useMemo(
    () => resolveLocalPlayerCombatantId({ player, entities, multiplayerSessionId, clientId }),
    [player, entities, multiplayerSessionId, clientId]
  );
  const localInitiativePid = localCombatantId;

  const hasLocalInitiativeRoll =
    !!playerInitiativeRollsByEntityId &&
    typeof playerInitiativeRollsByEntityId[localInitiativePid] === "number" &&
    Number.isFinite(playerInitiativeRollsByEntityId[localInitiativePid]);

  /** Ressources de tour persistées par id de combattant (session / Firestore). */
  const turnResources = useMemo(
    () => normalizeTurnResourcesInput(turnResourcesByCombatantId[localCombatantId]),
    [turnResourcesByCombatantId, localCombatantId]
  );

  const initiativePhaseActive =
    gameMode === "combat" &&
    (awaitingPlayerInitiative ||
      (Array.isArray(npcInitiativeDraft) && npcInitiativeDraft.length > 0)) &&
    (combatOrder?.length ?? 0) === 0;

  const lastNaturalPlayerInputRef = useRef("");
  const waitForGmNarrationForInitiativeLiveRef = useRef(false);
  useEffect(() => {
    waitForGmNarrationForInitiativeLiveRef.current = waitForGmNarrationForInitiative;
  }, [waitForGmNarrationForInitiative]);

  useEffect(() => {
    // Dès que le jet d'initiative n'est plus "en attente", on ré-affiche la fenêtre si besoin.
    if (!awaitingPlayerInitiative) {
      setInitiativeSubmittedLocal(false);
    }
  }, [awaitingPlayerInitiative]);

  const [useManualRollInput, setUseManualRollInput] = useState(false);
  const [manualRollNatInput, setManualRollNatInput] = useState("");
  /** Saisie « Mes dés » : un champ par dé (ex. 3d4 → 3 champs 1–4). */
  const [manualPerDieValues, setManualPerDieValues] = useState([]);
  const useManualRollInputRef = useRef(useManualRollInput);
  const manualRollNatInputRef = useRef(manualRollNatInput);
  const manualPerDieValuesRef = useRef(manualPerDieValues);
  useEffect(() => {
    useManualRollInputRef.current = useManualRollInput;
  }, [useManualRollInput]);
  useEffect(() => {
    manualRollNatInputRef.current = manualRollNatInput;
  }, [manualRollNatInput]);
  useEffect(() => {
    manualPerDieValuesRef.current = manualPerDieValues;
  }, [manualPerDieValues]);

  const [useManualInitiativeRollInput, setUseManualInitiativeRollInput] = useState(false);
  const [manualInitiativeNatInput, setManualInitiativeNatInput] = useState("");
  const useManualInitiativeRollInputRef = useRef(false);
  const manualInitiativeNatInputRef = useRef("");
  useEffect(() => {
    useManualInitiativeRollInputRef.current = useManualInitiativeRollInput;
  }, [useManualInitiativeRollInput]);
  useEffect(() => {
    manualInitiativeNatInputRef.current = manualInitiativeNatInput;
  }, [manualInitiativeNatInput]);

  /** Identité stable du jet en attente : la ref pendingRoll change souvent (MP / snapshot) sans être un nouveau jet. */
  const pendingRollStableKeyRef = useRef(null);
  const [pendingRollUiHiddenKey, setPendingRollUiHiddenKey] = useState(null);
  /** Anti-duplication : empêche deux appels /api/chat identiques en parallèle. */
  const naturalCallInFlightKeysRef = useRef(new Set());
  /**
   * Idempotence des replays "cachés" (MP pending command / reprise interne) :
   * évite un 2e parse-intent + narration du même texte sans nouvelle saisie joueur.
   */
  const recentHiddenNaturalReplayRef = useRef(new Map());
  /** MP : une seule résolution moteur par `pendingCommand.id` (Strict Mode / effets dupliqués). */
  const mpPendingCmdResolutionIdsRef = useRef(new Set());
  const runSceneEntryGmArbiterRef = useRef(async () => null);
  /** MP : évite double relance arbitre pour un même jet de groupe (effet hôte). */
  const globalSkillGroupArbiterResolvedIdsRef = useRef(new Set());
  function getPendingRollStableKey(roll) {
    if (!roll || typeof roll !== "object") return null;
    if (typeof roll.id === "string" && roll.id.trim()) return `id:${roll.id.trim()}`;
    const sel =
      roll.audience === "selected" && Array.isArray(roll.rollTargetEntityIds)
        ? [...new Set(roll.rollTargetEntityIds.map((x) => String(x ?? "").trim()).filter(Boolean))].sort().join(",")
        : "";
    return `k:${roll.kind ?? "roll"}|${roll.stat}|${String(roll.skill ?? "")}|${String(roll.targetId ?? "")}|${String(roll.weaponName ?? "")}|${String(roll.raison ?? "")}|${String(roll.forPlayerId ?? "")}|${String(roll.forClientId ?? "")}|${String(roll.audience ?? "")}|${sel}`;
  }

  useEffect(() => {
    const key = getPendingRollStableKey(pendingRoll);
    if (pendingRoll != null && key != null && key === pendingRollStableKeyRef.current) {
      return;
    }
    pendingRollStableKeyRef.current = key;

    // Nouveau pendingRoll (autre jet) => réinitialiser le mode manuel (sinon on réutilise une valeur précédente).
    if (!pendingRoll) {
      setPendingRollUiHiddenKey(null);
      setUseManualRollInput(false);
      setManualRollNatInput("");
      setManualPerDieValues([]);
      return;
    }
    setUseManualRollInput(false);
    setManualRollNatInput("");
    if (pendingRoll.kind === "damage_roll") {
      const { diceCount } = getPendingRollDiceDescriptor(pendingRoll);
      setManualPerDieValues(diceCount > 1 ? Array.from({ length: diceCount }, () => "") : []);
    } else {
      setManualPerDieValues([]);
    }
  }, [pendingRoll]);
  const [isGameOver, setIsGameOver] = useState(false);
  const isGameOverRef = useRef(false);
  useEffect(() => {
    isGameOverRef.current = isGameOver;
  }, [isGameOver]);
  const deathNarrationSentRef = useRef(false);
  const bottomRef   = useRef(null);
  const chatScrollContainerRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const onChatScroll = useCallback(() => {
    const el = chatScrollContainerRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const threshold = 120;
    stickToBottomRef.current = scrollHeight - scrollTop - clientHeight < threshold;
  }, []);
  const countdownRef = useRef(null);
  const turnResourcesRef = useRef(turnResources);
  const lastImageGenKeyRef = useRef(null);
  const narratorImageBudgetByRoomRef = useRef({});
  const latencyWindowRef = useRef([]); // number[] (ms)
  // Ref pour avoir toujours les HP à jour dans simulateEnemyTurns / preparePlayerTurnStartState.
  // useLayoutEffect : aligné sur le commit avant paint et avant les effets — sinon un tour PJ juste
  // après dégâts ennemis peut lire encore d'anciens PV (useEffect tardif) et sauter le death_save
  // jusqu'au prochain F5.
  const playerHpRef = useRef(player.hp.current);
  useLayoutEffect(() => {
    playerHpRef.current = player.hp.current;
  }, [player.hp.current]);
  useEffect(() => { turnResourcesRef.current = turnResources; }, [turnResources]);

  /** Esquive (D&D) : désavantage aux attaques contre ce combattant jusqu'au début de son prochain tour. */
  const dodgeActiveByCombatantIdRef = useRef({});
  const lastTurnIndexForDodgeClearRef = useRef(combatTurnIndex);
  useEffect(() => {
    if (gameMode !== "combat") {
      lastTurnIndexForDodgeClearRef.current = combatTurnIndex;
      return;
    }
    if (lastTurnIndexForDodgeClearRef.current === combatTurnIndex) return;
    lastTurnIndexForDodgeClearRef.current = combatTurnIndex;
    const activeId = combatOrder?.[combatTurnIndex]?.id;
    if (activeId && dodgeActiveByCombatantIdRef.current[activeId]) {
      delete dodgeActiveByCombatantIdRef.current[activeId];
    }
  }, [gameMode, combatTurnIndex, combatOrder]);

  // Setter : met le ref à jour avant le commit React pour que le même événement (DEBUG, auto-joueur)
  // voie les ressources consommées sans attendre le prochain rendu.
  const setTurnResourcesSynced = useCallback(
    (updater) => {
      const prevNorm = normalizeTurnResourcesInput(turnResourcesRef.current);
      const next = typeof updater === "function" ? updater(prevNorm) : updater;
      const normalized = normalizeTurnResourcesInput(next);
      turnResourcesRef.current = normalized;
      setTurnResourcesForCombatant(localCombatantId, () => normalized);
    },
    [localCombatantId, setTurnResourcesForCombatant]
  );
  const grantPlayerTurnResources = useCallback(() => {
    // Début de tour (hors surprise) : ressources usuelles D&D 5e — Action, action bonus, mouvement, réaction.
    setReactionFor(localCombatantId, true);
    setTurnResourcesSynced({
      action: true,
      bonus: true,
      reaction: true,
      movement: true,
    });
  }, [localCombatantId, setReactionFor, setTurnResourcesSynced]);
  const lockPlayerTurnResourcesForSurprise = useCallback(() => {
    setReactionFor(localCombatantId, false);
    setTurnResourcesSynced({
      action: false,
      bonus: false,
      reaction: false,
      movement: false,
    });
  }, [localCombatantId, setReactionFor, setTurnResourcesSynced]);
  const clearPlayerSurprisedState = useCallback(() => {
    if (player?.surprised !== true) return false;
    updatePlayer({ surprised: false });
    grantPlayerTurnResources();
    return true;
  }, [grantPlayerTurnResources, player?.surprised, updatePlayer]);
  // Ref pour suivre l'état courant du mode auto-joueur même Ã  l'intérieur des callbacks/timeout
  const autoPlayerEnabledRef = useRef(autoPlayerEnabled);
  useEffect(() => { autoPlayerEnabledRef.current = autoPlayerEnabled; }, [autoPlayerEnabled]);
  const autoRollEnabledRef = useRef(autoRollEnabled);
  useEffect(() => { autoRollEnabledRef.current = autoRollEnabled; }, [autoRollEnabled]);
  const flowBlockedRef = useRef(flowBlocked);
  useEffect(() => { flowBlockedRef.current = flowBlocked; }, [flowBlocked]);
  const failedRequestPayloadRef = useRef(failedRequestPayload);
  useEffect(() => { failedRequestPayloadRef.current = failedRequestPayload; }, [failedRequestPayload]);
  const opportunityAttackPromptResolverRef = useRef(null);
  const shieldReactionPromptResolverRef = useRef(null);
  const shortRestStateRef = useRef(shortRestState);
  useEffect(() => { shortRestStateRef.current = shortRestState; }, [shortRestState]);
  const recentLongRestApplyAtMsRef = useRef(0);
  // Snapshot MP / payload : `gameMode` peut repasser en `exploration` sans `finishShortRest` sur ce client.
  // Sans ça, `shortRestState` reste actif → "Le repos court est déjà en cours" alors que le bandeau repos est absent.
  useEffect(() => {
    if (gameMode === "short_rest") return;
    const hasLocalRestMarkers = shortRestState != null || shortRestStateRef.current != null;
    if (!hasLocalRestMarkers) return;
    shortRestStateRef.current = null;
    setShortRestState(null);
  }, [gameMode, shortRestState]);
  const processingRemoteCommandIdRef = useRef(null);
  const processingRemoteCommandSigRef = useRef("");
  const autoMultiplayerBusyRetryTimerRef = useRef(null);
  const autoMultiplayerBusyRetryCountRef = useRef(0);
  const autoPlayerCombatGraceTimerRef = useRef(null);
  const prevMultiplayerThinkingActiveRef = useRef(false);
  // Si le "pending command" Firestore est terminé, on doit aussi libérer le flag local.
  // Sinon le gate auto-joueur peut rester bloqué (multiplayer_resolution_busy) même
  // quand l'arbitre a déjà rendu la main.
  useEffect(() => {
    if (!multiplayerSessionId) return;
    if (multiplayerThinkingState?.active === true) return;
    if (multiplayerPendingCommand?.id) return;
    processingRemoteCommandIdRef.current = null;
    processingRemoteCommandSigRef.current = "";
  }, [multiplayerSessionId, multiplayerThinkingState?.active, multiplayerPendingCommand?.id]);
  useEffect(() => {
    const wasThinking = prevMultiplayerThinkingActiveRef.current === true;
    const isThinking = multiplayerThinkingState?.active === true;
    prevMultiplayerThinkingActiveRef.current = isThinking;
    if (!multiplayerSessionId) return;
    if (!wasThinking || isThinking) return;
    if (multiplayerPendingCommand?.id) return;
    // Le MJ vient juste d'arrêter de réfléchir : forcer une nouvelle fenêtre d'éligibilité
    // et relancer l'auto-joueur (la garde interne empêchera tout doublon dangereux).
    lastAutoAvailabilityKeyRef.current = null;
    if (!autoPlayerEnabledRef.current) return;
    queueMicrotask(() => {
      if (!autoPlayerEnabledRef.current) return;
      if (flowBlockedRef.current) return;
      if (rollResolutionInProgressRef.current) return;
      if (pendingRollRef.current) return;
      if (String(inputValueRef.current ?? "").trim()) return;
      void runAutoPlayerTurn(null);
    });
  }, [multiplayerSessionId, multiplayerThinkingState?.active, multiplayerPendingCommand?.id]);
  /** Auto-roll : réessai silencieux si le verrou session est pris par le MJ / un autre client. */
  const rollAutoRetryTimerRef = useRef(null);
  /** Délai pour réactiver l'application distante de `pendingRoll` après un jet (sync Firestore). */
  const rollSkipRemotePendingClearTimerRef = useRef(null);
  /** Anti-spam pour les messages « action en cours » (verrou session). */
  const lastSessionBusyNoticeAtRef = useRef(0);
  /** Anti-spam visuel pour les bulles "Un autre joueur..." dans le chat. */
  const lastSessionBusyChatRef = useRef({ t: 0, content: "" });
  const multiplayerPendingCommandIdRef = useRef(multiplayerPendingCommand?.id ?? null);
  useEffect(() => {
    multiplayerPendingCommandIdRef.current = multiplayerPendingCommand?.id ?? null;
  }, [multiplayerPendingCommand?.id]);
  const multiplayerPendingSubmitterRef = useRef(
    String(multiplayerPendingCommand?.submittedBy ?? "").trim() || null
  );
  useEffect(() => {
    multiplayerPendingSubmitterRef.current =
      String(multiplayerPendingCommand?.submittedBy ?? "").trim() || null;
  }, [multiplayerPendingCommand?.submittedBy]);
  const multiplayerPendingCommandRef = useRef(multiplayerPendingCommand);
  useEffect(() => {
    multiplayerPendingCommandRef.current = multiplayerPendingCommand;
  }, [multiplayerPendingCommand]);
  /** Garde anti-rejeu des commandes moteur techniques (ex: ENGINE_END_TURN). */
  const processedEngineCommandIdsRef = useRef(new Set());
  /** Évite de relancer parse-intent → MJ si la même commande Firestore réapparaît après résolution. */
  const lastFinishedMultiplayerCommandRef = useRef({
    id: "",
    submittedAtMs: 0,
    finishedAt: 0,
  });
  // Déduplication cross-client des commandes MP quasi simultanées (même texte / même contexte),
  // pour éviter deux parse-intent consécutifs sur la même intention auto.
  const lastFinishedMultiplayerCommandSigRef = useRef({
    sig: "",
    finishedAt: 0,
  });
  /**
   * Cache local prioritaire pour les états MP critiques (deathState/hp) afin d'éviter
   * les fenêtres stale entre patch Firestore et propagation complète des snapshots React.
   */
  const mpParticipantStateOverrideRef = useRef(new Map());
  /** Une seule résolution parse-intent par commande MP (évite double appel / double trace Gemini, ex. React Strict Mode). */
  const mpParseIntentInFlightRef = useRef(new Map());
  /** Single-flight local: évite les doubles parse-intent simultanés hors MP. */
  const localParseIntentInFlightRef = useRef(new Map());
  /** Déduplication large des requêtes naturelles (visible + replay caché) par fenêtre TTL. */
  const recentNaturalParserCallsRef = useRef(new Map());
  const multiplayerThinkingActiveRef = useRef(multiplayerThinkingState?.active === true);
  useEffect(() => {
    multiplayerThinkingActiveRef.current = multiplayerThinkingState?.active === true;
  }, [multiplayerThinkingState?.active]);
  const autoAwaitingServerResolutionRef = useRef(false);
  const autoRunSerialRef = useRef(0);
  /** Cooldown anti-boucle après échec de soumission MP d'une intention auto. */
  const autoSubmitBackoffUntilRef = useRef(0);
  useEffect(() => {
    if (!multiplayerSessionId) {
      autoAwaitingServerResolutionRef.current = false;
      return;
    }
    // Dès qu'il n'y a plus de `pendingCommand` partagé, la résolution de la commande
    // soumise par l'auto-joueur est terminée (callApi + clearMultiplayerPendingCommand).
    //
    // Ne PAS exiger en plus `thinkingState.active === false` : si le drapeau Firestore
    // « MJ réfléchit » reste coincé (quota, erreur réseau, désync), l'ancienne condition
    // laissait `autoAwaitingServerResolutionRef` à true indéfiniment → auto-joueur gelé
    // après un message pourtant résolu (voir gate `autoAwaitingServerResolution`).
    if (!multiplayerPendingCommand?.id) {
      autoAwaitingServerResolutionRef.current = false;
    }
  }, [multiplayerSessionId, multiplayerPendingCommand?.id]);

  async function acquireSessionLockOrReport(label, userFacingMessage = null) {
    const lockId = await acquireMultiplayerProcessingLock(label);
    if (lockId) return lockId;
    // Multi : si le verrou est déjà pris, on se contente de "silencer" la tentative.
    // On ne spamme plus le chat avec "Un autre joueur..." et on ne touche pas Firestore.
    return null;
  }

  useEffect(() => {
    if (!multiplayerSessionId || !multiplayerPendingCommand?.id) return;
    const cmdId = String(multiplayerPendingCommand.id).trim();
    if (!cmdId) return;

    const latest = multiplayerPendingCommandRef.current;
    if (!latest || String(latest.id).trim() !== cmdId) return;

    /** Une seule exécution moteur / parse-intent par commande : le garde-fou global est par onglet,
     * donc sans ceci chaque client lançait callApi → doublons MJ + coût API. */
    const submitterClient = String(latest?.submittedBy ?? "").trim();
    const localClient = String(clientId ?? "").trim();
    if (submitterClient && localClient && submitterClient !== localClient) {
      return;
    }

    const fin = lastFinishedMultiplayerCommandRef.current;
    // IMPORTANT: cmdId est déjà unique (makeMsgId). Si une commande terminée réapparaît via
    // un echo/stale snapshot Firestore, on doit la purger sans jamais la rejouer, même si
    // submittedAtMs varie (normalisation JSON, champ manquant, type string/number, etc.).
    const sameFinishedRecently =
      fin.id === cmdId &&
      Date.now() - fin.finishedAt < 180000;
    if (sameFinishedRecently) {
      void clearMultiplayerPendingCommand(cmdId);
      return;
    }

    const cmdUserText = String(latest?.userContent ?? "").trim().toLowerCase();
    const cmdMode = String(latest?.gameModeSnapshot ?? "").trim().toLowerCase();
    const cmdRoom = String(latest?.currentRoomIdSnapshot ?? "").trim().toLowerCase();
    const cmdSig = cmdUserText ? `${cmdMode}|${cmdRoom}|${cmdUserText}` : "";
    const sigRecent =
      cmdSig &&
      lastFinishedMultiplayerCommandSigRef.current.sig === cmdSig &&
      Date.now() - lastFinishedMultiplayerCommandSigRef.current.finishedAt < 120000;
    // En exploration, bloquer les doublons d'intention quasi simultanés même si cmdId diffère
    // (ex: deux auto-joueurs soumettent la même phrase à quelques ms d'intervalle).
    if (sigRecent && cmdMode === "exploration") {
      void clearMultiplayerPendingCommand(cmdId);
      return;
    }

    if (globalMultiplayerPendingCmdResolutionInFlight.has(cmdId)) {
      return;
    }
    globalMultiplayerPendingCmdResolutionInFlight.add(cmdId);

    if (mpPendingCmdResolutionIdsRef.current.has(cmdId)) {
      globalMultiplayerPendingCmdResolutionInFlight.delete(cmdId);
      return;
    }
    mpPendingCmdResolutionIdsRef.current.add(cmdId);

    const busy = processingRemoteCommandIdRef.current;
    if (busy && busy !== cmdId) {
      const inFlightSig = String(processingRemoteCommandSigRef.current ?? "");
      if (cmdSig && inFlightSig && cmdSig === inFlightSig && cmdMode === "exploration") {
        void clearMultiplayerPendingCommand(cmdId);
      }
      mpPendingCmdResolutionIdsRef.current.delete(cmdId);
      globalMultiplayerPendingCmdResolutionInFlight.delete(cmdId);
      return;
    }
    if (busy === cmdId) {
      return;
    }

    processingRemoteCommandIdRef.current = cmdId;
    processingRemoteCommandSigRef.current = cmdSig;

    const leaseAcquiredRef = { current: false };

    const finalizeMpPendingCommandResolution = async (id) => {
      try {
        setIsTyping(false);
      } catch {
        /* ignore */
      }
      try {
        setIsAutoPlayerThinking(false);
      } catch {
        /* ignore */
      }
      try {
        await releaseMultiplayerCommandLease(id);
      } catch {
        /* ignore */
      }
      try {
        await setMultiplayerThinkingState({
          active: false,
          actor: null,
          label: null,
        });
      } catch {
        /* quota / réseau */
      }
      try {
        await clearMultiplayerPendingCommand(id);
      } catch {
        /* ignore */
      }
    };

    (async () => {
      try {
        let outcome = "busy";
        while (outcome === "busy") {
          outcome = await tryAcquireMultiplayerCommandLease(cmdId);
          if (outcome === "busy") await new Promise((r) => setTimeout(r, 320));
        }
        // Sans ce nettoyage, un bail refusé / commande « gone » / snapshot incohérent laissait
        // thinkingState=pendingCommand bloqués → « Le MJ réfléchit… » sans fin ni trace GM.
        if (outcome !== "acquired") {
          await finalizeMpPendingCommandResolution(cmdId);
          return;
        }
        leaseAcquiredRef.current = true;

        const cmd = multiplayerPendingCommandRef.current;
        if (!cmd || String(cmd.id).trim() !== cmdId) {
          await finalizeMpPendingCommandResolution(cmdId);
          return;
        }

        try {
          const liveStateForCommand = gameStateRef.current ?? null;
          const liveEntitiesForCommand =
            liveStateForCommand?.entities ?? entities ?? [];
          // `submitMultiplayerCommand` met déjà thinkingState=gm dans la transaction Firestore.
          // skipSessionLock : le bail commandLease sérialise déjà ; un second verrou `processing`
          // sur le même doc peut faire échouer callApi immédiatement ou aggraver les courses.
          await Promise.race([
            callApi(cmd.userContent, cmd.msgType ?? null, cmd.isDebug === true, {
              hideUserMessage: true,
              preexistingUserMessage: true,
              forceIntentParser: true,
              skipSessionLock: true,
              multiplayerPendingCommandId: cmdId,
              actingPlayer: cmd.playerSnapshot ?? null,
              // IMPORTANT MP: toujours résoudre sur l'état live au moment du lease.
              // Les snapshots d'envoi (cmd.*Snapshot) peuvent être obsolètes si d'autres
              // transitions ont eu lieu entre-temps.
              gameMode:
                liveStateForCommand?.gameMode ??
                cmd.gameModeSnapshot ??
                undefined,
              currentRoomId:
                liveStateForCommand?.currentRoomId ??
                cmd.currentRoomIdSnapshot ??
                undefined,
              currentScene:
                liveStateForCommand?.currentScene ??
                cmd.currentSceneSnapshot ??
                undefined,
              currentSceneName:
                liveStateForCommand?.currentSceneName ??
                cmd.currentSceneNameSnapshot ??
                undefined,
              // IMPORTANT MP: ne jamais exécuter sur le snapshot soumis par le joueur
              // (potentiellement obsolète de quelques ticks). Utiliser l'état live du résolveur.
              entities: Array.isArray(liveEntitiesForCommand) ? liveEntitiesForCommand : undefined,
              turnResourcesSnapshot: cmd.turnResourcesSnapshot ?? undefined,
              commandSenderName: cmd.senderName,
              commandSubmitterClientId: cmd.submittedBy,
            }),
            new Promise((_, reject) => {
              setTimeout(
                () => reject(new Error("mp_pending_call_api_timeout")),
                MP_PENDING_CALL_API_MS
              );
            }),
          ]);
          lastFinishedMultiplayerCommandRef.current = {
            id: cmdId,
            submittedAtMs:
              typeof cmd.submittedAtMs === "number" && Number.isFinite(cmd.submittedAtMs)
                ? cmd.submittedAtMs
                : 0,
            finishedAt: Date.now(),
          };
          {
            const txt = String(cmd?.userContent ?? "").trim().toLowerCase();
            const mode = String(cmd?.gameModeSnapshot ?? "").trim().toLowerCase();
            const room = String(cmd?.currentRoomIdSnapshot ?? "").trim().toLowerCase();
            if (txt) {
              lastFinishedMultiplayerCommandSigRef.current = {
                sig: `${mode}|${room}|${txt}`,
                finishedAt: Date.now(),
              };
            }
          }
          await flushMultiplayerSharedState();
        } catch (e) {
          console.error("[multiplayer pending command] résolution échouée ou timeout", e);
        } finally {
          await finalizeMpPendingCommandResolution(cmdId);
        }
      } finally {
        mpPendingCmdResolutionIdsRef.current.delete(cmdId);
        globalMultiplayerPendingCmdResolutionInFlight.delete(cmdId);
        if (processingRemoteCommandIdRef.current === cmdId) {
          processingRemoteCommandIdRef.current = null;
          processingRemoteCommandSigRef.current = "";
        }
      }
    })();

    return () => {
      if (!leaseAcquiredRef.current && processingRemoteCommandIdRef.current === cmdId) {
        processingRemoteCommandIdRef.current = null;
        processingRemoteCommandSigRef.current = "";
      }
    };
  }, [
    clearMultiplayerPendingCommand,
    clientId,
    multiplayerPendingCommand?.id,
    multiplayerPendingCommand?.submittedBy,
    multiplayerSessionId,
    flushMultiplayerSharedState,
    releaseMultiplayerCommandLease,
    setMultiplayerThinkingState,
    tryAcquireMultiplayerCommandLease,
  ]);

  function formatWorldTimeLabel(totalMinutes) {
    const safeMinutes = Math.max(0, Math.trunc(Number(totalMinutes) || 0));
    const day = Math.floor(safeMinutes / 1440) + 1;
    const minutesInDay = safeMinutes % 1440;
    const hours = Math.floor(minutesInDay / 60);
    const minutes = minutesInDay % 60;
    return `Jour ${day}, ${String(hours).padStart(2, "0")}h${String(minutes).padStart(2, "0")}`;
  }

  function getPlayerDeathStateSnapshot(sourcePlayer = player) {
    const hpCurrent = sourcePlayer?.hp?.current ?? 0;
    const raw = sourcePlayer?.deathState ?? {};
    const dead = raw?.dead === true;
    return {
      successes: Math.max(0, Math.min(3, Math.trunc(Number(raw?.successes ?? 0) || 0))),
      failures: Math.max(0, Math.min(3, Math.trunc(Number(raw?.failures ?? 0) || 0))),
      stable: !dead && raw?.stable === true,
      unconscious: dead ? false : raw?.unconscious === true || hpCurrent <= 0,
      dead,
      autoRecoverAtMinute:
        typeof raw?.autoRecoverAtMinute === "number" && Number.isFinite(raw.autoRecoverAtMinute)
          ? Math.max(0, Math.trunc(raw.autoRecoverAtMinute))
          : null,
    };
  }

  function isPlayerDeadNow() {
    return isGameOverRef.current || getPlayerDeathStateSnapshot().dead === true;
  }

  function isPlayerAtZeroHpNow() {
    return (playerHpRef.current ?? player?.hp?.current ?? 0) <= 0;
  }

  function isPlayerUnconsciousNow() {
    const deathState = getPlayerDeathStateSnapshot();
    return deathState.unconscious === true && deathState.dead !== true;
  }

  function resetPlayerDeathState(overrides = {}) {
    const base = {
      successes: 0,
      failures: 0,
      stable: false,
      unconscious: false,
      dead: false,
      autoRecoverAtMinute: null,
    };
    return { ...base, ...overrides };
  }

  function updatePlayerDeathState(updater) {
    setPlayer((prev) => {
      if (!prev) return prev;
      const nextDeathState =
        typeof updater === "function"
          ? updater(getPlayerDeathStateSnapshot(prev), prev)
          : updater;
      return {
        ...prev,
        isAlive: nextDeathState?.dead !== true,
        deathState: nextDeathState,
      };
    });
  }

  function restorePlayerToConsciousness(nextHp) {
    setPlayer((prev) => {
      if (!prev?.hp) return prev;
      const clampedHp = Math.max(1, Math.min(nextHp, prev.hp.max));
      playerHpRef.current = clampedHp;
      return {
        ...prev,
        isAlive: true,
        hp: { ...prev.hp, current: clampedHp },
        deathState: resetPlayerDeathState(),
      };
    });
  }

  // Déduplication idempotente des secrets MJ.
  // But : ne pas rejouer deux fois le même gm_secret (ex: re-continue, retry, re-render),
  // y compris hors combat. (Ne pas ignorer "bêtement" juste parce qu'on est en combat.)
  const gmSecretExecutedKeysRef = useRef([]);
  function hasExecutedGmSecret(key) {
    return gmSecretExecutedKeysRef.current.includes(key);
  }
  function markExecutedGmSecret(key) {
    const arr = gmSecretExecutedKeysRef.current;
    if (arr.includes(key)) return;
    arr.push(key);
    // Limite mémoire : on garde les N derniers secrets.
    if (arr.length > 30) arr.splice(0, arr.length - 30);
  }

  function shouldHidePendingRollReason(roll) {
    return !!roll && roll.kind === "check" && roll.returnToArbiter === true;
  }

  function getPublicPendingRollTitle(roll) {
    if (!roll) return "Jet requis";
    let title;
    if (roll.kind === "death_save") title = "Jet de sauvegarde contre la mort";
    else if (roll.kind === "hit_die") title = "Dé de vie";
    else if (roll.kind === "damage_roll") {
      let r = String(roll.raison ?? "").trim();
      r = r.replace(/\s*—\s*touches automatiques\s*$/i, "").trim();
      title = r ? r : roll.skill ? `Dégâts (${roll.skill})` : "Jet de dégâts";
    } else {
      const isSpellAtk = roll.kind === "attack" && roll.weaponName && SPELLS?.[roll.weaponName];
      const groupTag =
        roll.kind === "check" && (roll.audience === "global" || roll.audience === "selected")
          ? roll.audience === "selected"
            ? "Jet multi-PJ — "
            : "Jet de groupe — "
          : "";
      const label = roll.skill
        ? `${groupTag}Jet de ${roll.skill}`
        : isSpellAtk
          ? `${groupTag}Attaque de sort (${roll.stat})`
          : `${groupTag}Jet de ${roll.stat}`;
      title = shouldHidePendingRollReason(roll)
        ? label
        : `${label} (${roll.raison ?? ""})`;
    }
    return repairMojibakeForDisplay(title);
  }

  const awaitingPlayerInitiativeRef = useRef(awaitingPlayerInitiative);
  useEffect(() => {
    awaitingPlayerInitiativeRef.current = awaitingPlayerInitiative;
  }, [awaitingPlayerInitiative]);

  // Debounce : une sync MP peut mettre awaitingPlayerInitiative à false une frame — ne pas fermer « Mes dés ».
  useEffect(() => {
    if (awaitingPlayerInitiative) return;
    const t = setTimeout(() => {
      if (!awaitingPlayerInitiativeRef.current) {
        setUseManualInitiativeRollInput(false);
        setManualInitiativeNatInput("");
      }
    }, 450);
    return () => clearTimeout(t);
  }, [awaitingPlayerInitiative]);

  /** Évite les closures stales (auto-joueur / setTimeout) sur le jet en attente */
  const pendingRollRef = useRef(pendingRoll);
  useEffect(() => {
    pendingRollRef.current = pendingRoll;
  }, [pendingRoll]);
  useEffect(() => {
    if (!persistenceReady) return;
    // En session MP, un refresh peut passer brièvement par gameMode="exploration"
    // avant d'appliquer le snapshot distant (combat en cours). Ne pas regénérer
    // localement les ressources ici, sinon on peut réinjecter action/bonus/reaction
    // à true juste avant la fusion distante.
    if (multiplayerSessionId) return;
    if (gameMode === "combat") return;
    grantPlayerTurnResources();
    if (player?.surprised === true) {
      updatePlayer({ surprised: false });
    }
  }, [persistenceReady, multiplayerSessionId, gameMode, grantPlayerTurnResources, player?.surprised, updatePlayer]);

  // Verrou : quand on résout un jet (et sa chaîne scène-arbitre / narration),
  // on évite que l'auto-joueur injecte une nouvelle intention au milieu.
  const rollResolutionInProgressRef = useRef(false);

  // Anti-boucle : mémoriser la dernière intention exacte envoyée au MJ
  const lastAutoPlayerIntentRef = useRef(null);

  // IMPORTANT : même source que `messages` pour l'auto-joueur / callApi, mais à jour
  // dès le commit (useLayoutEffect), pas après peinture — sinon setTimeout(0) peut
  // lancer runAutoPlayerTurn avec un historique sans la dernière narration MJ.
  const messagesRef = useRef(messages);
  useLayoutEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  /** Lignes factuelles pour /api/gm-arbiter (jets MJ déjà tirés, résolutions) — indépendant du mode debug UI. */
  const sceneArbiterMechanicalLogRef = useRef([]);
  function pushSceneArbiterMechanicalLog(line) {
    const s = String(line ?? "").trim();
    if (!s) return;
    const arr = sceneArbiterMechanicalLogRef.current;
    arr.push(s);
    if (arr.length > 40) arr.splice(0, arr.length - 40);
  }

  // Anti-répétition "pattern" (schéma similaire, pas forcément texte identique)
  const lastAutoRepeatPatternRef = useRef(null);

  // Garde-fou anti-boucle : limite les continuations MJ consécutives
  const gmContinueCountRef = useRef(0);

  /**
   * Latest State Pattern : copie synchrone du jeu à chaque rendu (pas de closure périmée).
   */
  const gameStateRef = useRef(null);
  gameStateRef.current = {
    player,
    currentRoomId,
    entities,
    currentScene,
    currentSceneName,
    gameMode,
    combatOrder,
    combatTurnIndex,
    combatTurnWriteSeq,
    combatHiddenIds,
    combatStealthTotalByCombatantId,
    turnResourcesByCombatantId,
    aiProvider,
    debugMode,
    worldTimeMinutes,
  };

  /**
   * Chaque début de tour d’initiative (même clé que le grant des ressources) : −1 sur chaque entrée
   * de `combatTimedStates` pour tous les combattants (pas de double tick sur l’entité mp-player locale).
   */
  const tickCombatTimedStatesForAllCombatants = useCallback(() => {
    const pl = gameStateRef.current?.player;
    const pool = Array.isArray(gameStateRef.current?.entities) ? gameStateRef.current.entities : [];
    const localMpId =
      multiplayerSessionId && clientId ? `mp-player-${String(clientId).trim()}` : null;

    if (pl) {
      const prev = normalizeCombatTimedStates(pl.combatTimedStates);
      const next = decrementCombatTimedStatesOneTick(pl.combatTimedStates);
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        updatePlayer({ combatTimedStates: next });
      }
    }

    const updates = [];
    for (const ent of pool) {
      if (!ent?.id) continue;
      if (localMpId && ent.id === localMpId) continue;
      const prev = normalizeCombatTimedStates(ent.combatTimedStates);
      const next = decrementCombatTimedStatesOneTick(ent.combatTimedStates);
      if (JSON.stringify(prev) === JSON.stringify(next)) continue;
      updates.push({ id: ent.id, action: "update", combatTimedStates: next });
    }
    if (updates.length) applyEntityUpdates(updates);
  }, [updatePlayer, applyEntityUpdates, multiplayerSessionId, clientId]);

  useEffect(() => {
    if (gameMode === "combat") return;
    const pl = gameStateRef.current?.player ?? player;
    if (pl && normalizeCombatTimedStates(pl.combatTimedStates).length > 0) {
      updatePlayer({ combatTimedStates: [] });
    }
    const pool = gameStateRef.current?.entities ?? entities ?? [];
    const clears = pool
      .filter((e) => e?.id && normalizeCombatTimedStates(e.combatTimedStates).length > 0)
      .map((e) => ({ id: e.id, action: "update", combatTimedStates: [] }));
    if (clears.length) applyEntityUpdates(clears);
  }, [gameMode, player, entities, updatePlayer, applyEntityUpdates]);

  const queueSceneImageTrigger = useCallback((trigger) => {
    if (!trigger || typeof trigger !== "object") return;
    const key = String(trigger.key ?? "").trim();
    if (!key) return;
    setSceneImageTrigger((prev) => {
      if (prev?.key === key) return prev;
      return { ...trigger, key };
    });
  }, []);

  const triggerSceneImageFromNarratorDecision = useCallback(
    (imageDecision, context = {}) => {
      if (!imageDecision || typeof imageDecision !== "object") return;
      if (imageDecision.shouldGenerate !== true) return;
      const engineEvent =
        context.engineEvent && typeof context.engineEvent === "object" ? context.engineEvent : null;
      const roomKey =
        String(
          engineEvent?.kind === "scene_transition"
            ? engineEvent?.targetRoomId ?? context.roomId ?? gameStateRef.current?.currentRoomId ?? currentRoomId ?? ""
            : context.roomId ?? gameStateRef.current?.currentRoomId ?? currentRoomId ?? ""
        ).trim() || "scene";
      const sceneBucket = narratorImageBudgetByRoomRef.current[roomKey] ?? {
        total: 0,
        sceneEntry: 0,
        combatEnd: 0,
      };
      const eventKind = String(engineEvent?.kind ?? "").trim();
      const remainingHostiles = (gameStateRef.current?.entities ?? entities).filter((entity) =>
        isHostileReadyForCombat(entity)
      ).length;
      const isSceneEntryImage = eventKind === "scene_transition";
      const isCombatEndImage =
        engineEvent?.targetIsAlive === false &&
        remainingHostiles === 0 &&
        (eventKind === "attack_resolution" ||
          eventKind === "spell_attack_resolution" ||
          eventKind === "spell_save_resolution" ||
          eventKind === "gm_secret_resolution");
      if (!isSceneEntryImage && !isCombatEndImage) return;
      if (sceneBucket.total >= 2) return;
      if (isSceneEntryImage && sceneBucket.sceneEntry >= 1) return;
      if (isCombatEndImage && sceneBucket.combatEnd >= 1) return;

      const reason = String(imageDecision.reason ?? "").trim() || "Moment visuellement marquant";
      const focus = String(imageDecision.focus ?? "").trim() || reason;
      const sceneKey =
        String(
          context.sceneName ?? gameStateRef.current?.currentSceneName ?? currentSceneName ?? ""
        ).trim() ||
        "scene";
      narratorImageBudgetByRoomRef.current[roomKey] = {
        total: sceneBucket.total + 1,
        sceneEntry: sceneBucket.sceneEntry + (isSceneEntryImage ? 1 : 0),
        combatEnd: sceneBucket.combatEnd + (isCombatEndImage ? 1 : 0),
      };
      queueSceneImageTrigger({
        key: `narrator:${roomKey}:${sceneKey}:${reason}:${focus}:${imageModel}`,
        kind: "narrator_decision",
        title: sceneKey,
        reason,
        focus,
        engineEvent: context.engineEvent ?? null,
      });
    },
    [currentRoomId, currentSceneName, imageModel, queueSceneImageTrigger, entities]
  );

  const getRuntimeCombatant = useCallback(
    (combatantId, entitiesOverride = null) => {
      if (!combatantId) return null;
      if (combatantId === "player") {
        const deathState = getPlayerDeathStateSnapshot(player);
        return player
          ? {
              ...player,
              id: "player",
              controller: "player",
              isAlive: deathState.dead !== true,
              hp: player.hp
                ? {
                    ...player.hp,
                    current: playerHpRef.current ?? player.hp.current,
                  }
                : player.hp,
            }
          : null;
      }
      const mpPrefix = "mp-player-";
      if (String(combatantId).startsWith(mpPrefix)) {
        const cid = String(combatantId).slice(mpPrefix.length).trim();
        if (!cid) return null;
        const localMpId =
          multiplayerSessionId && clientId ? `mp-player-${String(clientId).trim()}` : null;
        if (localMpId && String(combatantId) === localMpId && player) {
          const deathState = getPlayerDeathStateSnapshot(player);
          return {
            ...player,
            id: combatantId,
            controller: "player",
            isAlive: deathState.dead !== true,
            hp: player.hp
              ? {
                  ...player.hp,
                  current: playerHpRef.current ?? player.hp.current,
                }
              : player.hp,
          };
        }
        const prof = Array.isArray(multiplayerParticipantProfiles)
          ? multiplayerParticipantProfiles.find((p) => String(p?.clientId ?? "").trim() === cid)
          : null;
        if (!prof) return null;
        const cur = typeof prof.hpCurrent === "number" ? prof.hpCurrent : 0;
        const max =
          typeof prof.hpMax === "number" && prof.hpMax > 0 ? prof.hpMax : Math.max(1, cur || 1);
        const ac = typeof prof.ac === "number" && Number.isFinite(prof.ac) ? prof.ac : 10;
        const sheet = prof?.playerSnapshot && typeof prof.playerSnapshot === "object" ? prof.playerSnapshot : null;
        if (sheet) {
          const deathState = getPlayerDeathStateSnapshot({
            ...sheet,
            hp: {
              ...((sheet.hp && typeof sheet.hp === "object") ? sheet.hp : {}),
              current: cur,
              max,
            },
          });
          return {
            ...sheet,
            id: combatantId,
            name: prof.name ?? sheet.name ?? "Joueur",
            controller: "player",
            type: "player",
            hp: { current: cur, max },
            ac: Number.isFinite(ac) ? ac : Number(sheet?.ac ?? 10) || 10,
            isAlive: prof.connected !== false && deathState.dead !== true,
          };
        }
        return {
          id: combatantId,
          name: prof.name ?? "Joueur",
          hp: { current: cur, max },
          ac,
          controller: "player",
          type: "friendly",
          isAlive: prof.connected !== false,
        };
      }
      const pool = Array.isArray(entitiesOverride) ? entitiesOverride : entities;
      return pool.find((entity) => entity?.id === combatantId) ?? null;
    },
    [entities, multiplayerParticipantProfiles, player, multiplayerSessionId, clientId]
  );

  const getCombatantArmorClass = useCallback(
    (combatant) => {
      if (!combatant) return 10;
      let base = 10;
      if (combatant.id === "player") base = effectivePlayerArmorClass(player);
      else if (String(combatant.id ?? "").startsWith("mp-player-")) {
        base = Number(combatant?.ac ?? 10) || 10;
      } else {
        base = Number(combatant?.ac ?? 10) || 10;
      }
      const timedBonus = getAcBonusFromCombatTimedStates(combatant?.combatTimedStates);
      return base + timedBonus;
    },
    [player]
  );

  const getCombatantCurrentHp = useCallback((combatant) => {
    if (!combatant?.hp) return null;
    if (combatant.id === "player") {
      return playerHpRef.current ?? combatant.hp.current ?? null;
    }
    if (String(combatant.id ?? "").startsWith("mp-player-")) {
      const localMpId =
        multiplayerSessionId && clientId ? `mp-player-${String(clientId).trim()}` : null;
      if (localMpId && String(combatant.id) === localMpId) {
        return playerHpRef.current ?? combatant.hp.current ?? null;
      }
      return combatant.hp.current ?? null;
    }
    return combatant.hp.current ?? null;
  }, [multiplayerSessionId, clientId]);

  const updateCombatantSpellSlots = useCallback(
    (combatantId, updater) => {
      const combatant = getRuntimeCombatant(combatantId);
      if (!combatant) return null;
      const currentSlots = combatant?.spellSlots ?? null;
      const nextSlots = typeof updater === "function" ? updater(currentSlots) : updater;
      if (!nextSlots) return null;
      if (combatantId === "player") {
        updatePlayer({ spellSlots: nextSlots });
      } else {
        applyEntityUpdates([{ id: combatantId, action: "update", spellSlots: nextSlots }]);
      }
      return nextSlots;
    },
    [applyEntityUpdates, getRuntimeCombatant, updatePlayer]
  );

  const spendSpellSlotForCombatant = useCallback(
    (combatantId, spellLevel) => {
      const combatant = getRuntimeCombatant(combatantId);
      if (!combatant || !combatant.spellSlots || spellLevel <= 0) {
        return { ok: true, usedLevel: null };
      }
      const slots = combatant.spellSlots;
      const levels = Object.keys(slots)
        .map((lvl) => parseInt(lvl, 10))
        .filter((lvl) => !Number.isNaN(lvl))
        .sort((a, b) => a - b);
      const useLevel = levels.find((lvl) => {
        if (lvl < spellLevel) return false;
        const row = slots[lvl];
        const remaining = typeof row?.remaining === "number" ? row.remaining : row?.max ?? 0;
        return remaining > 0;
      });
      if (useLevel == null) return { ok: false, usedLevel: null };
      const row = slots[useLevel];
      const remaining = typeof row?.remaining === "number" ? row.remaining : row?.max ?? 0;
      updateCombatantSpellSlots(combatantId, {
        ...slots,
        [useLevel]: {
          ...row,
          remaining: Math.max(0, remaining - 1),
        },
      });
      return { ok: true, usedLevel: useLevel };
    },
    [getRuntimeCombatant, updateCombatantSpellSlots]
  );

  const applyHpToCombatant = useCallback(
    (combatant, nextHp) => {
      if (!combatant?.hp) return { hpAfter: null, maxHp: null };
      const maxHp = combatant.hp.max;
      const hpAfter = Math.max(0, Math.min(nextHp, maxHp));
      if (combatant.id === "player") {
        if (hpAfter > 0) {
          restorePlayerToConsciousness(hpAfter);
        } else {
          setPlayer((prev) => {
            if (!prev?.hp) return prev;
            playerHpRef.current = 0;
            return {
              ...prev,
              hp: { ...prev.hp, current: 0 },
            };
          });
        }
      } else if (String(combatant.id ?? "").startsWith("mp-player-")) {
        const cid = String(combatant.id).slice("mp-player-".length).trim();
        const localCid = String(clientId ?? "").trim();
        const isLocalMp = !!multiplayerSessionId && !!localCid && cid === localCid;
        if (isLocalMp) {
          const clamped = Math.max(0, Math.min(hpAfter, maxHp));
          playerHpRef.current = clamped;
          setHp(clamped);
        }
        if (cid) void patchParticipantProfileHp(cid, hpAfter);
        // Garder `entities` aligné sur le profil : sinon le payload partagé / getRuntimeCombatant
        // peut encore voir d'anciens PV pleins avant le prochain flush (dégâts multi-ennemis).
        if (multiplayerSessionId) {
          const pool = gameStateRef.current?.entities ?? entities ?? [];
          if (pool.some((e) => e?.id === combatant.id)) {
            flushSync(() => {
              applyEntityUpdates([
                {
                  id: combatant.id,
                  action: "update",
                  hp: { current: hpAfter, max: maxHp },
                },
              ]);
            });
          }
        }
      } else if (hpAfter <= 0) {
        flushSync(() => {
          applyEntityUpdates([{ id: combatant.id, action: "kill" }]);
        });
      } else {
        flushSync(() => {
          applyEntityUpdates([
            {
              id: combatant.id,
              action: "update",
              hp: { current: hpAfter, max: maxHp },
            },
          ]);
        });
      }
      return { hpAfter, maxHp };
    },
    [
      applyEntityUpdates,
      patchParticipantProfileHp,
      restorePlayerToConsciousness,
      setPlayer,
      setHp,
      clientId,
      multiplayerSessionId,
      entities,
    ]
  );

  function getPlayerConModifier(sourcePlayer = player) {
    const con = sourcePlayer?.stats?.CON;
    return typeof con === "number" ? Math.floor((con - 10) / 2) : 0;
  }

  function resetRemainingResourcesDeepLocal(value) {
    if (Array.isArray(value)) {
      return value.map((entry) => resetRemainingResourcesDeepLocal(entry));
    }
    if (!value || typeof value !== "object") return value;

    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const candidate = raw;
        if (typeof candidate.max === "number" && typeof candidate.remaining === "number") {
          out[key] = { ...candidate, remaining: candidate.max };
          continue;
        }
      }
      out[key] = resetRemainingResourcesDeepLocal(raw);
    }
    return out;
  }

  function restoreSpellSlotsToMax(spellSlots) {
    if (!spellSlots || typeof spellSlots !== "object") return spellSlots;
    const next = {};
    for (const [level, row] of Object.entries(spellSlots)) {
      if (!row || typeof row !== "object") {
        next[level] = row;
        continue;
      }
      const max = Number(row.max ?? 0);
      next[level] = {
        ...row,
        remaining: Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 0,
      };
    }
    return next;
  }

  function markPlayerDead(reason = "") {
    setPlayer((prev) => {
      if (!prev) return prev;
      playerHpRef.current = 0;
      return {
        ...prev,
        isAlive: false,
        hp: prev.hp ? { ...prev.hp, current: 0 } : prev.hp,
        deathState: resetPlayerDeathState({
          failures: 3,
          dead: true,
          unconscious: false,
        }),
      };
    });
    if (reason) {
      addMessage("ai", reason, "meta", makeMsgId());
    }
    setShortRestState(null);
    setMovementGate(null);
    setPendingRoll(null);
    pendingRollRef.current = null;
    setIsGameOver(true);
    isGameOverRef.current = true;
  }

  function bringPlayerToZeroHp() {
    setPlayer((prev) => {
      if (!prev?.hp) return prev;
      playerHpRef.current = 0;
      return {
        ...prev,
        isAlive: true,
        hp: { ...prev.hp, current: 0 },
        deathState: resetPlayerDeathState({
          unconscious: true,
        }),
      };
    });
  }

  function applyDamageToPlayer(damage, options = {}) {
    const numericDamage = Math.max(0, Math.trunc(Number(damage) || 0));
    const isCritical = options.critical === true;
    const hpBefore = playerHpRef.current ?? player?.hp?.current ?? 0;
    const hpMax = player?.hp?.max ?? 0;
    const deathStateBefore = getPlayerDeathStateSnapshot();

    if (numericDamage <= 0) {
      return {
        hpBefore,
        hpAfter: hpBefore,
        damage: 0,
        instantDeath: false,
        knockedUnconscious: false,
        deathFailuresApplied: 0,
        dead: deathStateBefore.dead === true,
      };
    }

    if (hpBefore > 0) {
      const hpAfter = Math.max(0, hpBefore - numericDamage);
      if (hpAfter > 0) {
        setHp(hpAfter);
        playerHpRef.current = hpAfter;
        return {
          hpBefore,
          hpAfter,
          damage: numericDamage,
          instantDeath: false,
          knockedUnconscious: false,
          deathFailuresApplied: 0,
          dead: false,
        };
      }
      const excessDamage = Math.max(0, numericDamage - hpBefore);
      if (excessDamage >= hpMax) {
        markPlayerDead("La violence du coup vous tue sur le coup.");
        return {
          hpBefore,
          hpAfter: 0,
          damage: numericDamage,
          instantDeath: true,
          knockedUnconscious: false,
          deathFailuresApplied: 0,
          dead: true,
        };
      }
      bringPlayerToZeroHp();
      return {
        hpBefore,
        hpAfter: 0,
        damage: numericDamage,
        instantDeath: false,
        knockedUnconscious: true,
        deathFailuresApplied: 0,
        dead: false,
      };
    }

    if (numericDamage >= hpMax) {
      markPlayerDead("Le coup achève votre corps inerte sur le coup.");
      return {
        hpBefore: 0,
        hpAfter: 0,
        damage: numericDamage,
        instantDeath: true,
        knockedUnconscious: false,
        deathFailuresApplied: 0,
        dead: true,
      };
    }

    const addedFailures = isCritical ? 2 : 1;
    let becameDead = false;
    updatePlayerDeathState((current) => {
      const nextFailures = Math.min(3, current.failures + addedFailures);
      becameDead = nextFailures >= 3;
      return resetPlayerDeathState({
        ...current,
        failures: nextFailures,
        unconscious: true,
        stable: false,
        dead: becameDead,
      });
    });
    if (becameDead) {
      setIsGameOver(true);
      isGameOverRef.current = true;
    }
    return {
      hpBefore: 0,
      hpAfter: 0,
      damage: numericDamage,
      instantDeath: false,
      knockedUnconscious: false,
      deathFailuresApplied: addedFailures,
      dead: becameDead,
    };
  }

  function applyDamageToCombatant(target, damage, options = {}) {
    if (!target?.hp) {
      return { hpBefore: null, hpAfter: null, damage: 0, dead: false, instantDeath: false };
    }
    if (target.id === "player") {
      return applyDamageToPlayer(damage, options);
    }
    const hpSnap = getCombatantCurrentHp(target);
    const hpBefore = hpSnap != null ? hpSnap : target.hp?.current ?? 0;
    const hpAfter = Math.max(0, hpBefore - Math.max(0, Math.trunc(Number(damage) || 0)));
    applyHpToCombatant(target, hpAfter);
    return {
      hpBefore,
      hpAfter,
      damage,
      dead: hpAfter <= 0,
      instantDeath: false,
    };
  }

  function advanceWorldClock(minutes) {
    const safeMinutes = Math.max(0, Math.trunc(Number(minutes) || 0));
    if (safeMinutes <= 0) return worldTimeMinutes;
    let nextValue = worldTimeMinutes;
    setWorldTimeMinutes((prev) => {
      nextValue = prev + safeMinutes;
      return nextValue;
    });
    return nextValue;
  }

  function restoreShortRestResources(sourcePlayer) {
    if (!sourcePlayer) return sourcePlayer;
    const next = JSON.parse(JSON.stringify(sourcePlayer));
    if (next.fighter?.resources) {
      next.fighter.resources = resetRemainingResourcesDeepLocal(next.fighter.resources);
    }
    if (next.cleric?.resources) {
      next.cleric.resources = resetRemainingResourcesDeepLocal(next.cleric.resources);
    }
    return next;
  }

  function restoreLongRestPlayer(sourcePlayer, nextMinute) {
    if (!sourcePlayer?.hp) return sourcePlayer;
    const next = JSON.parse(JSON.stringify(sourcePlayer));
    next.hp.current = next.hp.max;
    next.isAlive = true;
    next.hitDiceRemaining = Math.min(
      next.hitDiceTotal ?? next.level ?? 1,
      (next.hitDiceRemaining ?? 0) + Math.max(1, Math.floor((next.hitDiceTotal ?? next.level ?? 1) / 2))
    );
    if (next.spellSlots) {
      next.spellSlots = restoreSpellSlotsToMax(next.spellSlots);
    }
    if (next.fighter) next.fighter = resetRemainingResourcesDeepLocal(next.fighter);
    if (next.wizard) {
      next.wizard = resetRemainingResourcesDeepLocal(next.wizard);
      next.wizard.arcaneRecovery = { used: false };
    }
    if (next.cleric) next.cleric = resetRemainingResourcesDeepLocal(next.cleric);
    if (next.rogue) next.rogue = resetRemainingResourcesDeepLocal(next.rogue);
    next.deathState = resetPlayerDeathState();
    next.lastLongRestFinishedAtMinute = nextMinute;
    return next;
  }

  function finishShortRest(reason = "") {
    const modeNow = gameStateRef.current?.gameMode ?? gameMode;
    const hasRestState = !!shortRestStateRef.current || !!shortRestState;
    // Idempotence : en multi / double résolution parse-intent, la même fin de repos
    // peut être traitée 2x. Si le repos est déjà terminé, ne rien réémettre.
    if (modeNow !== "short_rest" && !hasRestState) {
      return false;
    }
    shortRestStateRef.current = null;
    setShortRestState(null);
    void setMultiplayerGameModeImmediate("exploration");
    pendingRollRef.current = null;
    setPendingRoll(null);
    if (reason) {
      addMessage("ai", reason, "meta", makeMsgId());
    }
    if (multiplayerSessionId) {
      // MP: propager immédiatement la fin de repos.
      void flushMultiplayerSharedState().catch(() => {});
    }
    return true;
  }

  function startShortRest() {
    if (shortRestStateRef.current) {
      addMessage("ai", "Le repos court est déjà en cours.", "meta", makeMsgId());
      return true;
    }
    if (gameMode === "combat") {
      addMessage("ai", "Impossible de prendre un repos court en plein combat.", "intent-error", makeMsgId());
      return true;
    }
    if (entities.some((e) => isHostileReadyForCombat(e))) {
      addMessage(
        "ai",
        "Impossible de prendre un repos court ici : un adversaire conscient de votre présence vous menace encore.",
        "intent-error",
        makeMsgId()
      );
      return true;
    }
    // `player` peut être stale sur 1 frame (MP / setState en chaîne). Pour les gardes repos,
    // utiliser la ref HP qui suit les dégâts immédiatement.
    const hpNow =
      typeof playerHpRef.current === "number" && Number.isFinite(playerHpRef.current)
        ? playerHpRef.current
        : (player?.hp?.current ?? 0);
    const deathStateNow = getPlayerDeathStateSnapshot();
    const isStableAtZero =
      hpNow <= 0 && deathStateNow.dead !== true && deathStateNow.stable === true;
    // D&D 5e : un personnage stabilisé à 0 PV peut rester au repos et récupérer 1 PV après 1d4 h.
    // On autorise donc le repos court pour faire avancer l'horloge (et déclencher l'auto-récupération
    // via l'effet basé sur autoRecoverAtMinute), mais on bloque toujours le cas "mort" ou "à 0 PV non stabilisé".
    if ((hpNow <= 0 && !isStableAtZero) || isPlayerDeadNow()) {
      if (debugMode) {
        addMessage(
          "ai",
          `[DEBUG] Repos court refusé (garde 0 PV)\n` +
            safeJson({
              hpNow,
              deathStateNow,
              playerName: player?.name ?? null,
              gameMode,
            }),
          "debug",
          makeMsgId()
        );
      }
      addMessage(
        "ai",
        "Impossible de prendre un repos court à 0 PV tant que vous n'êtes pas stabilisé, ou si vous êtes mort.",
        "intent-error",
        makeMsgId()
      );
      return true;
    }
    const nextMinute = advanceWorldClock(60);
    setPlayer((prev) => {
      if (!prev) return prev;
      const next = restoreShortRestResources(prev);
      return {
        ...next,
        deathState: getPlayerDeathStateSnapshot(next),
      };
    });
    void setMultiplayerGameModeImmediate("short_rest");
    const shortRestSeed = { startedAtMinute: nextMinute, spentDice: 0 };
    // Ref d'abord : évite la fenêtre de course où un 2e "attendre 1h" relance parse-intent
    // avant le prochain render React.
    shortRestStateRef.current = shortRestSeed;
    setShortRestState(shortRestSeed);
    pendingRollRef.current = null;
    setPendingRoll(null);
    addMessage(
      "ai",
      `Vous prenez un repos court d'une heure.`,
      "meta",
      makeMsgId()
    );
    if (debugMode) {
      addMessage("ai", `[DEBUG] Mode -> short_rest (UI repos court activée)`, "debug", makeMsgId());
    }
    if (multiplayerSessionId) {
      // MP: publier tout de suite gameMode=short_rest (et l'état lié) aux autres clients.
      void flushMultiplayerSharedState().catch(() => {});
    }
    return true;
  }

  // IMPORTANT MP:
  // Ne jamais reflusher automatiquement la session sur simple changement local de `gameMode`.
  // Sinon chaque client peut réécrire un état reçu via snapshot (echo), ce qui provoque
  // des oscillations visibles entre modes (ex: short_rest <-> exploration).
  //
  // La vérité MP doit venir des résolutions moteur (pending command / callApi / transitions
  // explicitement flushées), pas d'un effet UI passif déclenché sur chaque render.

  function startLongRest() {
    const nowMs = Date.now();
    // Idempotence MP : le même intent peut être rejoué quasi immédiatement.
    if (nowMs - (recentLongRestApplyAtMsRef.current || 0) < 4000) {
      return true;
    }
    if (gameMode === "combat") {
      addMessage("ai", "Impossible de prendre un repos long en plein combat.", "intent-error", makeMsgId());
      return true;
    }
    if ((player?.hp?.current ?? 0) <= 0 || isPlayerDeadNow()) {
      addMessage("ai", "Impossible de bénéficier d'un repos long à 0 PV ou mort.", "intent-error", makeMsgId());
      return true;
    }
    const lastLongRestMinute = player?.lastLongRestFinishedAtMinute;
    if (
      typeof lastLongRestMinute === "number" &&
      Number.isFinite(lastLongRestMinute) &&
      // Règle "1 repos long par 24h" : on compte depuis le DÉBUT du repos long.
      // Comme on stocke l'instant de FIN, on ajoute la durée fixe (8h) pour obtenir l'élapsé depuis le début.
      (worldTimeMinutes - lastLongRestMinute) + 8 * 60 < 24 * 60
    ) {
      const elapsedSinceStart = (worldTimeMinutes - lastLongRestMinute) + 8 * 60;
      const remaining = Math.max(0, 24 * 60 - elapsedSinceStart);
      const hours = Math.floor(remaining / 60);
      const minutes = remaining % 60;
      addMessage(
        "ai",
        `Vous avez déjà bénéficié d'un repos long récemment. Attendez encore ${hours}h${String(minutes).padStart(2, "0")} avant d'en profiter à nouveau.`,
        "intent-error",
        makeMsgId()
      );
      return true;
    }
    recentLongRestApplyAtMsRef.current = nowMs;
    const nextMinute = advanceWorldClock(8 * 60);
    const localRestoredSnapshot = restoreLongRestPlayer(player, nextMinute);
    setPlayer((prev) => {
      const next = restoreLongRestPlayer(prev, nextMinute);
      playerHpRef.current = next?.hp?.max ?? playerHpRef.current;
      return next;
    });
    if (multiplayerSessionId) {
      const localCid = String(clientId ?? "").trim();
      for (const prof of multiplayerParticipantProfiles) {
        const pid = String(prof?.clientId ?? "").trim();
        if (!pid) continue;
        const sourceSnapshot =
          pid === localCid
            ? localRestoredSnapshot ?? player
            : prof?.playerSnapshot && typeof prof.playerSnapshot === "object"
              ? prof.playerSnapshot
              : null;
        const restored = restoreLongRestPlayer(sourceSnapshot, nextMinute);
        if (!restored) continue;
        void patchParticipantProfilePlayerSnapshot(pid, restored);
      }
    }
    finishShortRest();
    if (multiplayerSessionId) {
      void flushMultiplayerSharedState().catch(() => {});
    }
    addMessage(
      "ai",
      `Vous prenez un repos long de huit heures. Vos PV sont entièrement restaurés, vous récupérez vos ressources de repos long et la moitié de vos dés de vie dépensés.`,
      "meta",
      makeMsgId()
    );
    return true;
  }

  function triggerHitDieRollFromShortRest(overrides = null) {
    if (gameMode !== "short_rest") {
      addMessage("ai", "Commencez d'abord par prendre un repos court.", "intent-error", makeMsgId());
      return true;
    }
    if (!shortRestStateRef.current) {
      const seed = { startedAtMinute: worldTimeMinutes, spentDice: 0 };
      shortRestStateRef.current = seed;
      setShortRestState(seed);
    }
    const submitterCidRaw =
      overrides?.commandSubmitterClientId != null &&
      String(overrides.commandSubmitterClientId).trim()
        ? String(overrides.commandSubmitterClientId).trim()
        : String(clientId ?? "").trim();
    const localCid = String(clientId ?? "").trim();
    const remoteProfile =
      multiplayerSessionId && submitterCidRaw && submitterCidRaw !== localCid
        ? multiplayerParticipantProfiles.find((p) => String(p?.clientId ?? "").trim() === submitterCidRaw) ?? null
        : null;
    const actorSnapshot =
      overrides?.actingPlayer ??
      (remoteProfile?.playerSnapshot && typeof remoteProfile.playerSnapshot === "object"
        ? remoteProfile.playerSnapshot
        : player);
    const remainingHitDice =
      typeof actorSnapshot?.hitDiceRemaining === "number" && Number.isFinite(actorSnapshot.hitDiceRemaining)
        ? Math.max(0, Math.trunc(actorSnapshot.hitDiceRemaining))
        : 0;
    if (remainingHitDice <= 0) {
      addMessage("ai", "Vous n'avez plus de dés de vie à dépenser pendant ce repos court.", "intent-error", makeMsgId());
      return true;
    }
    const actorHpCur =
      typeof actorSnapshot?.hp?.current === "number" && Number.isFinite(actorSnapshot.hp.current)
        ? actorSnapshot.hp.current
        : 0;
    const actorHpMax =
      typeof actorSnapshot?.hp?.max === "number" && Number.isFinite(actorSnapshot.hp.max)
        ? actorSnapshot.hp.max
        : actorHpCur;
    if (actorHpCur >= actorHpMax) {
      addMessage("ai", "Vous êtes déjà à vos PV maximum.", "intent-error", makeMsgId());
      return true;
    }
    const pendingHitDieRoll = stampPendingRollForActor(
      {
        kind: "hit_die",
        roll: actorSnapshot?.hitDie ?? player?.hitDie ?? "d8",
        stat: "CON",
        totalBonus: getPlayerConModifier(),
        raison: `Dé de vie (${player?.hitDie ?? "d8"}) pendant le repos court`,
        engineContext: {
          kind: "short_rest_hit_die",
          hitDie: actorSnapshot?.hitDie ?? player?.hitDie ?? "d8",
        },
      },
      actorSnapshot ?? player,
      submitterCidRaw || clientId
    );
    pendingRollRef.current = pendingHitDieRoll;
    setPendingRoll(pendingHitDieRoll);
    return true;
  }

  useEffect(() => {
    const deathState = getPlayerDeathStateSnapshot();
    const gm = gameStateRef.current?.gameMode ?? gameMode;
    if (
      deathState.dead === true ||
      deathState.stable !== true ||
      deathState.autoRecoverAtMinute == null ||
      (playerHpRef.current ?? player?.hp?.current ?? 0) > 0 ||
      worldTimeMinutes < deathState.autoRecoverAtMinute ||
      gm === "combat"
    ) {
      return;
    }
    restorePlayerToConsciousness(1);
    addMessage(
      "ai",
      `Temps (méthode naturelle) : au repos **hors combat**, vous regagnez **1 PV** (délai **1d4** h en jeu écoulé). Vous reprenez conscience. Horloge : **${formatWorldTimeLabel(worldTimeMinutes)}**.`,
      "meta",
      makeMsgId()
    );
  }, [addMessage, gameMode, player, restorePlayerToConsciousness, worldTimeMinutes]);

  // Réveil naturel des alliés stabilisés à 0 PV (même règle que le PJ) : 1 PV à autoRecoverAtMinute, hors combat.
  useEffect(() => {
    const gm = gameStateRef.current?.gameMode ?? gameMode;
    if (gm === "combat") return;
    const wakeUpdates = [];
    const wakingNames = [];
    for (const e of Array.isArray(entities) ? entities : []) {
      if (!e || e.type === "hostile") continue;
      const hp = typeof e?.hp?.current === "number" ? e.hp.current : null;
      if (hp == null || hp > 0) continue;
      const ds = e?.deathState && typeof e.deathState === "object" ? e.deathState : null;
      if (!ds || ds.dead === true || ds.stable !== true) continue;
      const autoAt =
        typeof ds.autoRecoverAtMinute === "number" && Number.isFinite(ds.autoRecoverAtMinute)
          ? Math.trunc(ds.autoRecoverAtMinute)
          : null;
      if (autoAt == null || worldTimeMinutes < autoAt) continue;
      wakeUpdates.push({
        action: "update",
        id: e.id,
        hp: { ...(e.hp ?? {}), current: 1 },
        deathState: { ...(ds ?? {}), stable: false, unconscious: false, dead: false, autoRecoverAtMinute: null },
        isAlive: true,
      });
      wakingNames.push(e.name ?? e.id);
    }
    if (wakeUpdates.length) {
      applyEntityUpdates(wakeUpdates);
      addMessage(
        "ai",
        `Temps (méthode naturelle) : ${wakingNames.join(", ")} regagne **1 PV** et reprend conscience.`,
        "meta",
        makeMsgId()
      );
    }
  }, [addMessage, entities, gameMode, worldTimeMinutes]);

  // Multijoueur : même réveil naturel, mais via `participantProfiles` (hpCurrent + playerSnapshot.deathState).
  useEffect(() => {
    const gm = gameStateRef.current?.gameMode ?? gameMode;
    if (gm === "combat") return;
    if (!multiplayerSessionId) return;
    if (!Array.isArray(multiplayerParticipantProfiles) || multiplayerParticipantProfiles.length === 0) return;
    const wake = [];
    for (const prof of multiplayerParticipantProfiles) {
      const cid = String(prof?.clientId ?? "").trim();
      if (!cid) continue;
      const hp = typeof prof?.hpCurrent === "number" && Number.isFinite(prof.hpCurrent) ? Math.trunc(prof.hpCurrent) : null;
      if (hp == null || hp > 0) continue;
      const snap = prof?.playerSnapshot && typeof prof.playerSnapshot === "object" ? prof.playerSnapshot : null;
      const ds = snap?.deathState && typeof snap.deathState === "object" ? snap.deathState : null;
      if (!ds || ds.dead === true || ds.stable !== true) continue;
      const autoAt =
        typeof ds.autoRecoverAtMinute === "number" && Number.isFinite(ds.autoRecoverAtMinute)
          ? Math.trunc(ds.autoRecoverAtMinute)
          : null;
      if (autoAt == null || worldTimeMinutes < autoAt) continue;
      wake.push({ cid, name: String(prof?.name ?? snap?.name ?? `Participant ${cid}`).trim() || `Participant ${cid}` });
    }
    if (wake.length === 0) return;
    for (const w of wake) {
      void patchParticipantProfileDeathState(
        w.cid,
        { stable: false, unconscious: false, dead: false, autoRecoverAtMinute: null },
        { hpCurrent: 1 }
      );
    }
    addMessage(
      "ai",
      `Temps (méthode naturelle) : ${wake.map((w) => w.name).join(", ")} regagne **1 PV** et reprend conscience.`,
      "meta",
      makeMsgId()
    );
  }, [
    addMessage,
    gameMode,
    worldTimeMinutes,
    multiplayerSessionId,
    multiplayerParticipantProfiles,
    patchParticipantProfileDeathState,
  ]);

  /**
   * Index de tour combat : mis à jour au rendu ET de façon synchrone via commitCombatTurnIndex.
   * Évite la course où await parse-intent reprend avant le re-render après setCombatTurnIndex
   * (ex. fin du tour ennemi → tour joueur alors que le closure voit encore l’ancien index).
   */
  const combatTurnIndexLiveRef = useRef(combatTurnIndex);
  combatTurnIndexLiveRef.current = combatTurnIndex;
  /** Incrémenté à chaque nouveau combat (passage d'ordre vide → non vide). */
  const combatEngagementSeqRef = useRef(0);
  /** Incrémenté quand l'index repasse au premier combattant après le dernier (fin de manche). */
  const combatRoundInEngagementRef = useRef(0);
  /** Anti-doublon : une seule restauration des ressources par segment (engagement|round|index|id). */
  const lastTurnResourcesGrantKeyRef = useRef(null);
  const prevCombatOrderLenForEngagementRef = useRef(0);
  /** Une entrée /api/enemy-tactics par tour ennemi (clé engagement + round + slot initiative + ennemi). */
  const tacticianTurnCacheRef = useRef(new Map());
  /** Un seul POST /api/enemy-tactics à la fois (évite courses : plusieurs fetch avant remplissage du cache). */
  const tacticianFetchTailRef = useRef(Promise.resolve());
  /** Promesses en cours par clé tacticien : deux appels concurrents avec la même clé partagent le même fetch. */
  const tacticianInFlightByKeyRef = useRef(new Map());
  /** Anti-rejeu robuste : tours ennemis déjà résolus pour (engagement, round, idx, enemyId). */
  const processedEnemyTurnKeysRef = useRef(new Set());

  function commitCombatTurnIndex(next) {
    const prev = combatTurnIndexLiveRef.current;
    const order = gameStateRef.current?.combatOrder ?? combatOrder;
    const len = Array.isArray(order) ? order.length : 0;
    // N'incrémenter la manche que lors d'un vrai passage au premier slot (wrap).
    // Si len===1, prev et next peuvent rester 0 : sans `prev !== next`, on effaçait
    // processedEnemyTurnKeys à chaque commit → le même PNJ rejouait /api/enemy-tactics.
    // À chaque nouvelle manche d'initiative (wrap dernier → premier), incrémenter la manche et
    // purger les clés anti-rejeu `engagement:ancienRound:*` — sinon un même PNJ garde une entrée
    // dans le set et son tour est ignoré (« gobelin sauté ») au tour suivant.
    if (len > 0 && prev !== next && prev === len - 1 && next === 0) {
      const seq = combatEngagementSeqRef.current;
      const roundBefore = combatRoundInEngagementRef.current;
      combatRoundInEngagementRef.current += 1;
      const prefixToDrop = `${seq}:${roundBefore}:`;
      processedEnemyTurnKeysRef.current = new Set(
        [...processedEnemyTurnKeysRef.current].filter((k) => !String(k).startsWith(prefixToDrop))
      );
    }
    combatTurnIndexLiveRef.current = next;
    setCombatTurnIndex(next, prev === next ? { bumpSeq: true } : undefined);
  }

  /** Index de tour aligné sur combatTurnIndexLiveRef (évite décalage closure / snapshot Firestore). */
  function clampedCombatTurnIndex() {
    // Même source que `isPlayerTurnNow` / `gameStateRef` : le state React peut être 1 frame en retard
    // après sync Firestore, ce qui fausse « c'est mon tour » pour l'auto-joueur / le placeholder.
    const order = gameStateRef.current?.combatOrder ?? combatOrder;
    const len = Array.isArray(order) ? order.length : 0;
    if (len <= 0) return 0;
    return Math.min(Math.max(0, combatTurnIndexLiveRef.current), len - 1);
  }

  function isPlayerDownNow() {
    return isPlayerDeadNow();
  }

  function isCombatantAliveForTurnOrder(combatantId, entitiesOverride = null) {
    if (!combatantId) return false;
    const pool = Array.isArray(entitiesOverride) ? entitiesOverride : entities;
    if (combatantId === "player") {
      return !isPlayerDeadNow();
    }
    const localPlayerCombatantId =
      typeof player?.id === "string" && String(player.id ?? "").trim() ? String(player.id).trim() : null;
    if (localPlayerCombatantId && String(combatantId).trim() === localPlayerCombatantId) {
      return !isPlayerDeadNow();
    }
    if (String(combatantId).startsWith("mp-player-")) {
      const localMpId =
        multiplayerSessionId && clientId ? `mp-player-${String(clientId ?? "").trim()}` : null;
      const isLocalMp =
        localMpId && String(combatantId ?? "").trim() === String(localMpId ?? "").trim();
      // Si c'est votre PJ à vous (dans l'ordre), on ne doit jamais le considérer "mort"
      // juste parce que les profils multijoueur n'ont pas encore été synchronisés.
      if (isLocalMp) return !isPlayerDeadNow();

      const cid = String(combatantId).slice("mp-player-".length);
      if (!Array.isArray(multiplayerParticipantProfiles) || multiplayerParticipantProfiles.length === 0) {
        return true;
      }
      const prof = multiplayerParticipantProfiles.find(
        (p) => String(p?.clientId ?? "").trim() === cid
      );
      if (!prof) return true;
      if (prof.connected === false) return false;
      // 0 PV : le PJ reste dans l'ordre (jets contre la mort au tour), pas exclu comme "mort".
      return true;
    }
    /** MP : entrée d'initiative = id de fiche locale — à 0 PV l'entité peut avoir isAlive false alors que le tour continue (jets de mort). */
    if (multiplayerSessionId) {
      const sheetId =
        player?.id != null && String(player.id).trim() ? String(player.id).trim() : null;
      if (sheetId && String(combatantId).trim() === sheetId) {
        return !isPlayerDeadNow();
      }
    }
    const combatant = pool.find((entity) => entity?.id === combatantId) ?? null;
    if (!combatant) return false;
    // Hostile encore dans la scène avec des PV : reste dans l'ordre d'initiative même si
    // `isAlive` a été mis à false pour un état narratif (ex. inconscient / assoupi) — sinon
    // `nextAliveTurnIndex` saute le slot sans jamais exécuter tacticien + fin de tour PNJ.
    if (String(combatant.type ?? "").toLowerCase() === "hostile") {
      const hpCur =
        combatant.hp && typeof combatant.hp.current === "number" && Number.isFinite(combatant.hp.current)
          ? combatant.hp.current
          : null;
      if (hpCur != null && hpCur > 0) {
        return combatant.isAlive !== false;
      }
    }
    return combatant.isAlive === true;
  }

  function hasLivingPlayerCombatant(currentEntities = null) {
    const order = gameStateRef.current?.combatOrder ?? combatOrder ?? [];
    if (Array.isArray(order) && order.length > 0) {
      for (const entry of order) {
        const id = String(entry?.id ?? "").trim();
        if (!id) continue;
        if (controllerForCombatantId(id, currentEntities ?? entities) !== "player") continue;
        if (isCombatantAliveForTurnOrder(id, currentEntities ?? entities)) return true;
      }
      return false;
    }
    if (!isPlayerDeadNow()) return true;
    const pool = Array.isArray(currentEntities) ? currentEntities : entities;
    return pool.some((combatant) => combatant?.isAlive === true && combatantControllerValue(combatant) === "player");
  }

  /**
   * Pour éviter les boucles infinies : on ne continue que si au moins un PJ vivant
   * existe DANS l'ordre d'initiative (pas seulement "quelqu'un" de vivant dans entities).
   */
  function hasAnyLivingPlayerCombatantInInitiativeOrder(order) {
    if (!Array.isArray(order) || order.length === 0) return false;
    const localAlive = !isPlayerDeadNow();
    const localPlayerCombatantId =
      typeof player?.id === "string" && String(player.id ?? "").trim() ? String(player.id).trim() : null;
    for (const entry of order) {
      const id = entry?.id;
      if (!id) continue;
      if (id === "player") {
        if (localAlive) return true;
        continue;
      }
      if (localPlayerCombatantId && String(id).trim() === localPlayerCombatantId) {
        if (localAlive) return true;
        continue;
      }
      if (String(id).startsWith("mp-player-")) {
        const localMpId =
          multiplayerSessionId && clientId ? `mp-player-${String(clientId ?? "").trim()}` : null;
        const isLocalMp =
          localMpId && String(id ?? "").trim() === String(localMpId ?? "").trim();
        if (isLocalMp) {
          if (localAlive) return true;
          continue;
        }

        if (!Array.isArray(multiplayerParticipantProfiles) || multiplayerParticipantProfiles.length === 0) continue;

        const cid = String(id).slice("mp-player-".length);
        const prof = multiplayerParticipantProfiles.find((p) => String(p?.clientId ?? "").trim() === cid) ?? null;
        if (prof && prof.connected !== false) return true;
      }
    }
    return false;
  }

  // "Contrôlable" côté CE client : on évite une boucle sans tour joueur valide pour cette instance.
  function hasAnyControllablePlayerCombatantInInitiativeOrder(order) {
    if (!Array.isArray(order) || order.length === 0) return false;
    for (const entry of order) {
      const id = entry?.id;
      if (!id) continue;
      if (isLocalPlayerCombatantId(id) && isCombatantAliveForTurnOrder(id)) return true;
    }
    return false;
  }

  function combatantControllerValue(combatant) {
    if (!combatant) return null;
    if (combatant.controller === "player" || combatant.controller === "ai") {
      return combatant.controller;
    }
    if (combatant.id === "player" || combatant.type === "player") return "player";
    return "ai";
  }

  function isLocalPlayerCombatantId(combatantId) {
    if (!combatantId) return false;
    if (String(combatantId).trim() === String(localCombatantId).trim()) return true;
    /** Ancien ordre solo / sauvegardes avec id fixe "player". */
    if (!multiplayerSessionId && combatantId === "player") return true;
    /** MP : l'ordre d'initiative peut référencer l'id de fiche (`player.id`) au lieu de `mp-player-<cid>`. */
    if (
      multiplayerSessionId &&
      player?.id != null &&
      String(combatantId).trim() === String(player.id).trim()
    ) {
      return true;
    }
    return false;
  }

  /**
   * Solo : `resolveLocalPlayerCombatantId` retombe sur l'id de fiche quand l'entité scène est à 0 PV,
   * mais l'ordre d'initiative peut garder l'ancien id d'entité — absent du pool sans être un PNJ.
   */
  function isSoloStalePlayerEntityIdAbsentFromPool(combatantId, entitiesOverride = null) {
    if (multiplayerSessionId || !player?.id || !combatantId) return false;
    const pool = Array.isArray(entitiesOverride) ? entitiesOverride : entities;
    const sheet = String(player.id).trim();
    const lc = String(localCombatantId).trim();
    if (!sheet || lc !== sheet) return false;
    const cid = String(combatantId).trim();
    if (cid === sheet || cid === "player") return false;
    if (pool.some((e) => e?.id === cid)) return false;
    const ord = gameStateRef.current?.combatOrder ?? combatOrder;
    return Array.isArray(ord) && ord.some((o) => o?.id === combatantId);
  }

  /** Deux ids désignent le même PJ local (MP) : `mp-player-*` vs id de fiche. */
  function mpLocalCombatantIdsEqual(a, b) {
    const na = String(a ?? "").trim();
    const nb = String(b ?? "").trim();
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (!multiplayerSessionId || !clientId) return false;
    const mp = `mp-player-${String(clientId).trim()}`;
    const sheet = player?.id != null && String(player.id).trim() ? String(player.id).trim() : null;
    const aliases = new Set([mp, sheet].filter(Boolean));
    return aliases.has(na) && aliases.has(nb);
  }

  /**
   * Début de tour : restaure action / bonus / mouvement / réaction pour le combattant actif
   * (PJ local, autres PJ en MP, hostiles). Le flag « surpris » fait partie de la clé pour
   * qu’un passage surprise → normal redonne bien les ressources sans attendre un autre index.
   */
  useEffect(() => {
    if (gameMode !== "combat") {
      lastTurnResourcesGrantKeyRef.current = null;
      return;
    }
    /** Évite un grant avant `applyPersistedPayload` : sinon carte vide → tout à true, puis clé figée. */
    if (!persistenceReady) return;
    const order = combatOrder ?? [];
    if (!order.length) return;
    const idx = Math.min(Math.max(0, combatTurnIndex), order.length - 1);
    const activeId = order[idx]?.id;
    if (!activeId) return;

    const pool = gameStateRef.current?.entities ?? entities;
    const rc = getRuntimeCombatant(activeId, pool);
    /** Même logique qu’ailleurs : id de fiche / `player` / `mp-player-*` peuvent coexister. */
    const isLocalPc = isLocalPlayerCombatantId(activeId);
    const surprised = isLocalPc
      ? player?.surprised === true || rc?.surprised === true
      : rc?.surprised === true;

    // Inclure combatTurnWriteSeq : un « bump » sur le même index (désync MP / même slot) doit
    // pouvoir redonner les ressources — sinon la clé reste figée et Elyndra reste sans Action.
    const key = `${combatEngagementSeqRef.current}|${combatRoundInEngagementRef.current}|${idx}|${activeId}|w:${combatTurnWriteSeq}|s:${
      surprised ? 1 : 0
    }`;
    if (lastTurnResourcesGrantKeyRef.current === key) return;

    tickCombatTimedStatesForAllCombatants();

    lastTurnResourcesGrantKeyRef.current = key;

    if (debugMode && gameMode === "combat") {
      try {
        // eslint-disable-next-line no-console
        console.debug(
          "[turn-resources grant]",
          JSON.stringify({
            key,
            activeId,
            idx,
            writeSeq: combatTurnWriteSeq,
            isLocalPc,
            surprised,
            localCombatantId,
          })
        );
      } catch {
        /* ignore */
      }
    }

    if (isLocalPc) {
      setHasDisengagedThisTurn(false);
      setSneakAttackArmed(false);
      setSneakAttackUsedThisTurn(false);
      if (surprised) {
        lockPlayerTurnResourcesForSurprise();
        return;
      }
      /** Toujours restaurer action/bonus/mouvement/réaction en début de tour PJ.
       * Ne pas se fier à la seule présence d'une clé dans `turnResourcesByCombatantId` :
       * après le tour précédent l'entrée peut être `{ action:false, ... }` — l'ancien garde
       * « si déjà stocké skip » empêchait alors tout grant et, avec `lastTurnResourcesGrantKeyRef`
       * déjà mis à ce `key`, le tour restait bloqué sans ressources. */
      grantPlayerTurnResources();
      return;
    }

    if (surprised) {
      setReactionFor(activeId, false);
      setTurnResourcesForCombatant(activeId, {
        action: false,
        bonus: false,
        reaction: false,
        movement: false,
      });
      return;
    }
    setReactionFor(activeId, true);
    setTurnResourcesForCombatant(activeId, {
      action: true,
      bonus: true,
      reaction: true,
      movement: true,
    });
  }, [
    gameMode,
    combatOrder,
    combatTurnIndex,
    combatTurnWriteSeq,
    entities,
    getRuntimeCombatant,
    grantPlayerTurnResources,
    lockPlayerTurnResourcesForSurprise,
    localCombatantId,
    multiplayerSessionId,
    persistenceReady,
    player?.surprised,
    setHasDisengagedThisTurn,
    setReactionFor,
    setSneakAttackArmed,
    setSneakAttackUsedThisTurn,
    setTurnResourcesForCombatant,
    debugMode,
    tickCombatTimedStatesForAllCombatants,
  ]);

  function controllerForCombatantId(combatantId, entitiesOverride = null) {
    if (!combatantId) return null;
    if (combatantId === "player") return "player";
    const localPlayerCombatantId =
      typeof player?.id === "string" && String(player.id ?? "").trim() ? String(player.id).trim() : null;
    if (localPlayerCombatantId && String(combatantId).trim() === localPlayerCombatantId) return "player";
    if (String(combatantId).startsWith("mp-player-")) {
      // IMPORTANT: tout `mp-player-*` est un combattant joueur (même s'il est contrôlé
      // par un autre client). Le distinguo "joueur local vs distant" se fait via
      // isLocalPlayerCombatantId().
      return "player";
    }
    const pool = Array.isArray(entitiesOverride) ? entitiesOverride : entities;
    const combatant = pool.find((entity) => entity?.id === combatantId) ?? null;
    if (!combatant) {
      if (isLocalPlayerCombatantId(combatantId)) return "player";
      if (isSoloStalePlayerEntityIdAbsentFromPool(combatantId, pool)) return "player";
      // Ordre d'initiative (MJ / sync MP / cache PNJ) peut référencer un id absent des entités
      // locales — sans ce repli, controller === null et le kickoff tour PNJ ne part jamais.
      return "ai";
    }
    return combatantControllerValue(combatant);
  }

  /**
   * Rattache une entrée d'initiative à une fiche hostile locale quand les ids divergent
   * (ex. brouillon `goblin_patrol_1` vs entité scène `goblin_aux_aguets`).
   */
  function resolveCombatOrderEntity(entry, pool, order) {
    if (!entry?.id || !Array.isArray(pool) || !Array.isArray(order)) return null;
    const direct = pool.find((e) => e.id === entry.id);
    if (direct) return direct;
    const eid = String(entry.id).trim();
    if (
      eid === "player" ||
      eid === String(localCombatantId ?? "").trim() ||
      eid.startsWith("mp-player-")
    ) {
      return null;
    }
    const poolHostiles = pool.filter((e) => e?.type === "hostile" && e.isAlive !== false);
    const claimedIds = new Set(
      order
        .map((o) => pool.find((x) => x.id === o?.id))
        .filter(Boolean)
        .map((e) => e.id)
    );
    const free = poolHostiles.filter((h) => !claimedIds.has(h.id)).sort((a, b) =>
      String(a.id).localeCompare(String(b.id), "fr")
    );
    const orphans = order.filter((o) => {
      if (!o?.id) return false;
      const oid = String(o.id).trim();
      if (oid === "player" || oid === String(localCombatantId ?? "").trim() || oid.startsWith("mp-player-")) {
        return false;
      }
      return !pool.find((e) => e.id === o.id);
    });
    const pos = orphans.findIndex((o) => String(o.id) === String(entry.id));
    if (pos >= 0 && pos < free.length) return free[pos];
    return null;
  }

  function passivePerceptionForHideTarget(c) {
    if (!c) return 10;
    /** Ordre d'initiative : id de fiche / entité, pas toujours la chaîne "player". */
    const isLocalPc = c.id === "player" || isLocalPlayerCombatantId(c.id);
    if (isLocalPc) {
      const base = passivePerceptionFromPlayerSheet(player);
      const conds =
        Array.isArray(c?.conditions) && c.conditions.length
          ? c.conditions
          : Array.isArray(player?.conditions)
            ? player.conditions
            : [];
      const feats =
        Array.isArray(c?.features) && c.features.length
          ? c.features
          : Array.isArray(player?.features)
            ? player.features
            : [];
      const forAdvDis = { conditions: conds, features: feats };
      return base + passivePerceptionAdvDisModifierForPassiveScore(forAdvDis, false);
    }
    /** Autre joueur en multijoueur : entité allégée ; PP depuis les stats si présentes. */
    if (String(c.id ?? "").startsWith("mp-player-")) {
      if (c.stats && typeof c.stats === "object" && c.stats.SAG != null) {
        const { base, fromStatBlock } = passivePerceptionBaseFromEntityLike(c);
        return base + passivePerceptionAdvDisModifierForPassiveScore(c, fromStatBlock);
      }
      return 10;
    }
    const { base, fromStatBlock } = passivePerceptionBaseFromEntityLike(c);
    return base + passivePerceptionAdvDisModifierForPassiveScore(c, fromStatBlock);
  }

  /**
   * Exploration : même logique que « se cacher » en combat — DD = Perception passive max des hostiles
   * présents (vivants, visibles), pas un DD arbitraire issu des secrets / du LLM.
   */
  function maxPassivePerceptionAmongHostilesForStealth(entPool) {
    const pool = Array.isArray(entPool) ? entPool : [];
    let maxPp = 0;
    let found = false;
    let oppName = null;
    for (const c of pool) {
      if (!c || c.isAlive === false) continue;
      if (c.visible === false) continue;
      if (String(c.type ?? "").toLowerCase() !== "hostile") continue;
      found = true;
      const pp = passivePerceptionForHideTarget(c);
      if (pp > maxPp) {
        maxPp = pp;
        oppName = c?.name ?? null;
      }
    }
    return { dc: found ? maxPp : null, found, oppName };
  }

  function maxOpposingPassivePerceptionForHide(hiderId) {
    const order = gameStateRef.current?.combatOrder ?? combatOrder;
    const entPool = gameStateRef.current?.entities ?? entities;
    let maxPp = 0;
    let found = false;
    let oppName = null;
    for (const entry of order ?? []) {
      const oid = entry?.id;
      if (!oid || oid === hiderId) continue;
      const hiderSide = controllerForCombatantId(hiderId, entPool) === "player" ? "player" : "ai";
      const otherSide = controllerForCombatantId(oid, entPool) === "player" ? "player" : "ai";
      if (otherSide === hiderSide) continue;
      const c = getRuntimeCombatant(oid);
      if (!c || c.isAlive === false) continue;
      found = true;
      const pp = passivePerceptionForHideTarget(c);
      if (pp > maxPp) {
        maxPp = pp;
        oppName = c?.name ?? null;
      }
    }
    return { dc: found ? maxPp : 10, found, oppName };
  }

  async function performCombatHideRoll({ combatantId, combatant, label }) {
    if ((getMeleeWith(combatantId) ?? []).length > 0) {
      const who = combatant?.name ?? player?.name ?? "le combattant";
      addMessage(
        "ai",
        `🚫 **Se cacher** (${label || "Discrétion"}) — impossible : ${who} est au corps à corps d’une autre créature.`,
        "meta",
        makeMsgId()
      );
      return;
    }
    const isLocalPc =
      combatantId === "player" ||
      (typeof player?.id === "string" && String(combatantId).trim() === String(player.id).trim()) ||
      (multiplayerSessionId && combatantId === `mp-player-${String(clientId ?? "").trim()}`);
    /** Aligné sur `combatHiddenIds` / jets d’attaque (`localCombatantId`). */
    const hiddenIdForState = isLocalPlayerCombatantId(combatantId) ? localCombatantId : combatantId;
    const stealthBonus = isLocalPc
      ? computeCheckBonus({ player, stat: "DEX", skill: "Stealth" })
      : stealthBonusFromEntityForHide(combatant);
    const { dc, oppName } = maxOpposingPassivePerceptionForHide(combatantId);
    const nat = debugNextRoll ?? (Math.floor(Math.random() * 20) + 1);
    if (debugNextRoll !== null) setDebugNextRoll(null);
    const total = nat + stealthBonus;
    const success = total >= dc;
    if (success) {
      setCombatHiddenIds((prev) => [...new Set([...prev, hiddenIdForState])]);
      setCombatStealthTotalForCombatant(hiddenIdForState, total);
    } else {
      setCombatHiddenIds((prev) => prev.filter((id) => id !== hiddenIdForState));
      setCombatStealthTotalForCombatant(hiddenIdForState, null);
    }
    const who = combatant?.name ?? player?.name ?? "le combattant";
    const vsLine = oppName ? ` (adversaire le plus attentif : ${oppName})` : "";
    addMessage(
      "ai",
      `🎲 **Se cacher** (${label || "Discrétion"}) — ${who} : jet de Discrétion **${nat}** ${fmtMod(stealthBonus)} = **${total}** (1d20 + mod Dextérité + maîtrise si Discrétion). ` +
        `Perception passive adverse max **${dc}**${vsLine} (10 + mod Sagesse + maîtrise si Perception ; ±5 avantage/désavantage sur le passif). ` +
        `→ ${
        success
          ? "**réussi** — ce total reste le **DD** jusqu’à découverte ou fin du camouflage (Perception active : jet ≥ ce total)."
          : "**échoué**"
      }`,
      "dice",
      makeMsgId()
    );
    addMessage(
      "ai",
      `[DEBUG] Hide (moteur)\n` + safeJson({ combatantId, hiddenIdForState, nat, stealthBonus, total, dc, success }),
      "debug",
      makeMsgId()
    );
    if (multiplayerSessionId) {
      await new Promise((r) => setTimeout(r, 0));
      await flushMultiplayerSharedState();
    }
  }

  function isPlayerTurnNow(snapshot = null) {
    const snap = snapshot ?? gameStateRef.current;
    const mode = snap?.gameMode ?? gameMode;
    if (mode !== "combat") return true;
    if (awaitingPlayerInitiativeRef.current) return false;
    const order = Array.isArray(snap?.combatOrder) ? snap.combatOrder : combatOrder;
    if (!order.length) return false;
    const idx = Math.min(Math.max(0, combatTurnIndexLiveRef.current), order.length - 1);
    const activeEntry = order[idx];
    if (!activeEntry?.id) return false;
    const isLocalPlayerTurn = isLocalPlayerCombatantId(activeEntry.id);
    if (!isLocalPlayerTurn) return false;
    return isCombatantAliveForTurnOrder(activeEntry.id, snap?.entities ?? null);
  }

  /** Évite un double nextTurn() si preparePlayerTurnStartState est invoqué 2× (boucle ennemis + effet sync). */
  const stableUnconsciousTurnSkipKeyRef = useRef(null);
  /** Une seule bulle « jet de mort » par segment (effet React + boucle tour + Strict Mode). */
  const deathSavePromptKeyRef = useRef(null);
  /** Début de tour déjà traité pour ce segment (empêche un death save en plein milieu du tour). */
  const playerTurnStartHandledKeyRef = useRef(null);

  /** Même logique que l'effet sur `combatOrder` : doit tourner avant tout calcul de clé (death save, tours ennemis). */
  function syncCombatEngagementSeqFromCombatOrderLen(len) {
    if (len > 0 && prevCombatOrderLenForEngagementRef.current === 0) {
      combatEngagementSeqRef.current += 1;
      combatRoundInEngagementRef.current = 0;
      tacticianTurnCacheRef.current.clear();
      tacticianInFlightByKeyRef.current.clear();
      tacticianFetchTailRef.current = Promise.resolve();
      processedEnemyTurnKeysRef.current.clear();
      lastTurnResourcesGrantKeyRef.current = null;
      scheduledStableCombatTurnAdvanceKeys.clear();
    }
    if (len === 0) {
      combatRoundInEngagementRef.current = 0;
      tacticianTurnCacheRef.current.clear();
      tacticianInFlightByKeyRef.current.clear();
      tacticianFetchTailRef.current = Promise.resolve();
      processedEnemyTurnKeysRef.current.clear();
      lastTurnResourcesGrantKeyRef.current = null;
      scheduledStableCombatTurnAdvanceKeys.clear();
    }
    prevCombatOrderLenForEngagementRef.current = len;
  }

  async function preparePlayerTurnStartState() {
    const orderKey = gameStateRef.current?.combatOrder ?? combatOrder;
    const len = Array.isArray(orderKey) ? orderKey.length : 0;
    syncCombatEngagementSeqFromCombatOrderLen(len);
    if (len <= 0) return false;
    const idxKey = Math.min(Math.max(0, combatTurnIndexLiveRef.current), len - 1);
    const activeIdKey = String(orderKey[idxKey]?.id ?? "").trim();
    // Ne jamais traiter le « début de tour PJ » si l'initiative pointe vers un ennemi ou un autre PJ (MP).
    // Sinon le message « lancez un jet contre la mort » peut partir pendant le tour adverse (index hors bornes ou ref/stale).
    if (!activeIdKey || !isLocalPlayerCombatantId(activeIdKey)) {
      return false;
    }

    const turnSegmentKey = `${combatEngagementSeqRef.current}:${combatRoundInEngagementRef.current}:${idxKey}:${activeIdKey}`;
    const hpCurrent = playerHpRef.current ?? player?.hp?.current ?? 0;
    const deathState = getPlayerDeathStateSnapshot();
    // Ne PAS poser `playerTurnStartHandledKeyRef` avant d'avoir vu les PV / l'état mort : sinon un premier
    // passage avec PV encore > 0 (closure stale) marque le segment « traité » et, une fois à 0 PV, on retourne
    // tôt sans jamais créer le pending death_save ni le message (bug « pas de jet tant qu'on ne F5 pas »).
    if (deathState.dead) {
      playerTurnStartHandledKeyRef.current = turnSegmentKey;
      return true;
    }
    if (hpCurrent > 0) {
      deathSavePromptKeyRef.current = null;
      return false;
    }

    if (deathState.stable) {
      const orderNow = gameStateRef.current?.combatOrder ?? combatOrder;
      const lenNow = Array.isArray(orderNow) ? orderNow.length : 0;
      const idxNow = lenNow > 0 ? Math.min(Math.max(0, combatTurnIndexLiveRef.current), lenNow - 1) : 0;
      const activeIdNow = orderNow[idxNow]?.id ?? "";
      const skipKey = `${combatEngagementSeqRef.current}:${combatRoundInEngagementRef.current}:${idxNow}:${activeIdNow}`;
      if (stableUnconsciousTurnSkipKeyRef.current === skipKey) {
        return true;
      }
      stableUnconsciousTurnSkipKeyRef.current = skipKey;
      const stableMsgId = multiplayerSessionId
        ? `mp-turn-skip-stable-${skipKey.replace(/:/g, "-")}`
        : null;
      addMessage(
        "ai",
        `${player?.name ?? "Vous"} êtes **inconscient(e)** et **stabilisé(e)** à 0 PV — aucune action, **passage de tour**.`,
        "turn-end",
        stableMsgId ?? makeMsgId()
      );
      addMessage("ai", "", "turn-divider", makeMsgId());
      // nextTurn() relance runEnemyTurnsUntilPlayer : si on est déjà dans cette boucle,
      // enemyTurnLoopInProgressRef bloque la réentrance — différer après la fin du tour courant.
      scheduleStableCombatTurnAdvance(skipKey, () => nextTurn());
      playerTurnStartHandledKeyRef.current = turnSegmentKey;
      return true;
    }

    if (pendingRollRef.current?.kind === "death_save") {
      playerTurnStartHandledKeyRef.current = turnSegmentKey;
      return true;
    }

    const dsPromptKey = `${combatEngagementSeqRef.current}:${combatRoundInEngagementRef.current}:${idxKey}:${activeIdKey}:ds`;
    const deathSavePromptMsgId = `death-save-prompt-${turnSegmentKey.replace(/:/g, "-")}`;

    const ensureDeathSavePendingRollOnly = () => {
      const deathSaveRollRestore = stampPendingRollForActor(
        {
          kind: "death_save",
          stat: "CON",
          totalBonus: computeCheckBonus({ player, stat: "CON", skill: null }),
          raison: "Jet de sauvegarde contre la mort",
          engineContext: { kind: "death_save" },
          roll: "1d20",
        },
        player,
        clientId
      );
      pendingRollRef.current = deathSaveRollRestore;
      setPendingRoll(deathSaveRollRestore);
    };

    // F5 / sync : la bulle est déjà dans le journal Firestore mais pendingRoll peut être null (flush retardé).
    if (hasUnresolvedDeathSavePromptInMessages(messagesRef.current, player?.name)) {
      if (pendingRollRef.current?.kind !== "death_save") {
        ensureDeathSavePendingRollOnly();
      }
      deathSavePromptKeyRef.current = dsPromptKey;
      emittedDeathSavePromptKeys.add(dsPromptKey);
      playerTurnStartHandledKeyRef.current = turnSegmentKey;
      return true;
    }

    if (messagesRef.current.some((m) => m && m.id === deathSavePromptMsgId)) {
      if (pendingRollRef.current?.kind !== "death_save") {
        ensureDeathSavePendingRollOnly();
      }
      deathSavePromptKeyRef.current = dsPromptKey;
      emittedDeathSavePromptKeys.add(dsPromptKey);
      playerTurnStartHandledKeyRef.current = turnSegmentKey;
      return true;
    }

    if (deathSavePromptKeyRef.current === dsPromptKey) {
      if (pendingRollRef.current?.kind !== "death_save") {
        ensureDeathSavePendingRollOnly();
      }
      playerTurnStartHandledKeyRef.current = turnSegmentKey;
      return true;
    }
    if (emittedDeathSavePromptKeys.has(dsPromptKey)) {
      if (pendingRollRef.current?.kind === "death_save") {
        deathSavePromptKeyRef.current = dsPromptKey;
        playerTurnStartHandledKeyRef.current = turnSegmentKey;
        return true;
      }
      const deathSaveRollRestore = stampPendingRollForActor(
        {
          kind: "death_save",
          stat: "CON",
          totalBonus: computeCheckBonus({ player, stat: "CON", skill: null }),
          raison: "Jet de sauvegarde contre la mort",
          engineContext: { kind: "death_save" },
          roll: "1d20",
        },
        player,
        clientId
      );
      pendingRollRef.current = deathSaveRollRestore;
      setPendingRoll(deathSaveRollRestore);
      deathSavePromptKeyRef.current = dsPromptKey;
      playerTurnStartHandledKeyRef.current = turnSegmentKey;
      return true;
    }
    // Réserver tout de suite la clé (évite double bulle si deux appels synchrones avant addMessage).
    emittedDeathSavePromptKeys.add(dsPromptKey);
    deathSavePromptKeyRef.current = dsPromptKey;

    const deathSaveRoll = stampPendingRollForActor(
      {
        kind: "death_save",
        stat: "CON",
        totalBonus: computeCheckBonus({ player, stat: "CON", skill: null }),
        raison: "Jet de sauvegarde contre la mort",
        engineContext: { kind: "death_save" },
        roll: "1d20",
      },
      player,
      clientId
    );
    pendingRollRef.current = deathSaveRoll;
    setPendingRoll(deathSaveRoll);
    addMessage(
      "ai",
      `🎲 ${player?.name ?? "Vous"} êtes à **0 PV**. Lancez maintenant un **jet de sauvegarde contre la mort**.`,
      "meta",
      deathSavePromptMsgId
    );
    if (multiplayerSessionId) {
      queueMicrotask(() => {
        void flushMultiplayerSharedState();
      });
    }
    playerTurnStartHandledKeyRef.current = turnSegmentKey;
    return true;
  }

  /**
   * Filet : si c'est le tour du PJ à 0 PV (jets contre la mort) mais qu'aucun pendingRoll
   * death_save n'est présent (ex. sync MP / nextTurn sans runEnemyTurnsUntilPlayer), on recrée le jet.
   * Efface aussi un pendingRoll mécanique invalide à 0 PV (ex. attaque) pour débloquer le jet de mort.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- garde-fou ciblé (tour + PV + état mort) ; éviter de relier toutes les fonctions du moteur
  useEffect(() => {
    if (gameMode !== "combat") {
      deathSavePromptKeyRef.current = null;
      emittedDeathSavePromptKeys.clear();
      return;
    }
    if (awaitingPlayerInitiative) return;
    if (isGameOverRef.current) return;
    // Pendant nextTurn / runEnemyTurnsUntilPlayer, l'index peut être incohérent une frame — ne pas spammer le jet de mort.
    if (enemyTurnLoopInProgressRef.current) return;
    if (!isPlayerTurnNow()) return;

    const hp = playerHpRef.current ?? player?.hp?.current ?? 0;
    const ds = getPlayerDeathStateSnapshot();
    if (hp > 0) return;
    if (ds.dead || ds.stable) return;

    const pr = pendingRollRef.current;
    if (
      pr &&
      pendingRollTargetsLocalPlayer(
        pr,
        player,
        clientId,
        !!multiplayerSessionId,
        multiplayerSessionId,
        multiplayerParticipantProfilesRef.current
      )
    ) {
      if (pr.kind === "death_save") return;
      pendingRollRef.current = null;
      setPendingRoll(null);
    }

    if (pendingRollRef.current?.kind === "death_save") return;
    void preparePlayerTurnStartState();
  }, [
    gameMode,
    combatTurnIndex,
    combatTurnWriteSeq,
    combatOrder,
    awaitingPlayerInitiative,
    player?.hp?.current,
    player?.deathState,
    pendingRoll,
    player,
    clientId,
    multiplayerSessionId,
    multiplayerParticipantProfilesRollGateKey,
    messages,
  ]);

  /** Filet anti-sync : un death_save ne doit exister que pendant le tour local du PJ concerné. */
  useEffect(() => {
    if (gameMode !== "combat") return;
    const pr = pendingRollRef.current;
    if (!pr || pr.kind !== "death_save") return;
    if (isPlayerTurnNow()) return;
    pendingRollRef.current = null;
    setPendingRoll(null);
    deathSavePromptKeyRef.current = null;
  }, [gameMode, combatTurnIndex, combatTurnWriteSeq, combatOrder, pendingRoll, player?.hp?.current, player?.deathState]);

  /** PJ stabilisé à 0 PV : même logique que la boucle ennemis si le tour arrive par sync (ex. multijoueur). */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- garde-fou tour stabilisé
  useEffect(() => {
    if (gameMode !== "combat") {
      stableUnconsciousTurnSkipKeyRef.current = null;
      return;
    }
    if (awaitingPlayerInitiative) return;
    if (isGameOverRef.current) return;
    if (enemyTurnLoopInProgressRef.current) return;
    if (!isPlayerTurnNow()) return;

    const hp = playerHpRef.current ?? player?.hp?.current ?? 0;
    const ds = getPlayerDeathStateSnapshot();
    if (hp > 0 || ds.dead || !ds.stable) return;

    void preparePlayerTurnStartState();
  }, [
    gameMode,
    combatTurnIndex,
    combatTurnWriteSeq,
    combatOrder,
    awaitingPlayerInitiative,
    player?.hp?.current,
    player?.deathState,
    player,
    clientId,
    multiplayerSessionId,
  ]);

  function insertSpawnedCombatantsIntoInitiative(spawnedEntities, options = {}) {
    const arrivals = (Array.isArray(spawnedEntities) ? spawnedEntities : []).filter((ent) =>
      isHostileReadyForCombat(ent)
    );
    if (arrivals.length === 0) return null;

    const currentOrder = Array.isArray(gameStateRef.current?.combatOrder)
      ? gameStateRef.current.combatOrder
      : combatOrder;
    if (!Array.isArray(currentOrder) || currentOrder.length === 0) return null;

    const existingIds = new Set(currentOrder.map((entry) => entry?.id).filter(Boolean));
    const newEntries = arrivals
      .filter((ent) => !existingIds.has(ent.id))
      .map((ent) => ({
        id: ent.id,
        name: ent.name,
        initiative: rollInitiativeD20() + dexModFromStats(ent.stats),
      }));

    if (newEntries.length === 0) return null;

    const merged = [...currentOrder, ...newEntries].sort((a, b) => b.initiative - a.initiative);
    const anchorId =
      typeof options.anchorActorId === "string" && options.anchorActorId.trim()
        ? options.anchorActorId.trim()
        : currentOrder[combatTurnIndexLiveRef.current]?.id ?? null;
    const anchorIndex = anchorId ? merged.findIndex((entry) => entry?.id === anchorId) : -1;

    setCombatOrder(merged);
    if (anchorIndex >= 0) {
      commitCombatTurnIndex(anchorIndex);
    }
    for (const entry of newEntries) {
      setReactionFor(entry.id, true);
    }

    const lines = newEntries.map((entry) => `[${entry.initiative}] ${entry.name}`);
    addMessage(
      "ai",
      `🎲 Renforts dans l'initiative\n${lines.join("\n")}`,
      "dice",
      makeMsgId()
    );

    gameStateRef.current = {
      ...gameStateRef.current,
      combatOrder: merged,
      combatTurnIndex: anchorIndex >= 0 ? anchorIndex : combatTurnIndexLiveRef.current,
    };
    return merged;
  }

  /**
   * Verrou anti-spam : > 0 tant qu'un callApi est en cours (y compris await fetch).
   * L'auto-joueur ne part pas tant qu'un tour MJ n'est pas terminé.
   */
  const apiProcessingDepthRef = useRef(0);
  /**
   * Après sceneUpdate.hasChanged, le client enchaîne avec [SceneEntered] en setTimeout(0).
   * Le callApi "parent" a déjà libéré apiProcessingDepthRef avant ce second appel :
   * on bloque l'auto-joueur jusqu'à la fin complète du traitement [SceneEntered].
   */
  const sceneEnteredPipelineDepthRef = useRef(0);
  /** Évite plusieurs POST /api/gm-arbiter en parallèle (Gemini lent + courses client). */
  const sceneArbiterQueueTailRef = useRef(Promise.resolve());

  async function fetchJsonWithTimeout(url, init, timeoutMs, label) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 60000));
    try {
      const res = await fetch(url, { ...(init ?? {}), signal: controller.signal });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    } catch (e) {
      const name = String(e?.name ?? "");
      if (name === "AbortError") {
        throw new Error(`Timeout ${label ? `(${label})` : ""}`.trim());
      }
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  function markFlowFailure(message, retryPayload = null) {
    const msg = String(message || "Échec réseau/API.");
    setFlowBlocked(true);
    setError(msg);
    if (retryPayload) setFailedRequestPayload(retryPayload);
    if (!failedRequestPayloadRef.current || retryPayload) {
      addMessage("ai", `Échec critique : ${msg}`, "retry-action", makeMsgId());
    }
  }

  function buildGodmodePlayerUpdate(playerPatch) {
    if (!playerPatch || typeof playerPatch !== "object") return null;
    const targetPlayerId =
      multiplayerSessionId && clientId ? `mp-player-${String(clientId).trim()}` : "player";
    const currentInv = Array.isArray(player?.inventory) ? player.inventory : [];
    let nextInventory = currentInv;
    let inventoryTouched = false;

    if (Array.isArray(playerPatch.inventorySet)) {
      nextInventory = playerPatch.inventorySet.map((item) => String(item ?? "").trim()).filter(Boolean);
      inventoryTouched = true;
    } else {
      if (Array.isArray(playerPatch.inventoryAdd) && playerPatch.inventoryAdd.length > 0) {
        nextInventory = [
          ...nextInventory,
          ...playerPatch.inventoryAdd.map((item) => String(item ?? "").trim()).filter(Boolean),
        ];
        inventoryTouched = true;
      }
      if (Array.isArray(playerPatch.inventoryRemove) && playerPatch.inventoryRemove.length > 0) {
        const removals = new Set(
          playerPatch.inventoryRemove.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean)
        );
        nextInventory = nextInventory.filter((item) => !removals.has(String(item ?? "").trim().toLowerCase()));
        inventoryTouched = true;
      }
    }

    let hp = null;
    const currentHpNow =
      typeof player?.hp?.current === "number" && Number.isFinite(player.hp.current)
        ? player.hp.current
        : 0;
    const maxHpNow =
      typeof player?.hp?.max === "number" && Number.isFinite(player.hp.max)
        ? player.hp.max
        : Math.max(1, currentHpNow);
    const hasHpCurrent =
      typeof playerPatch.hpCurrent === "number" && Number.isFinite(playerPatch.hpCurrent);
    const hasHpMax =
      typeof playerPatch.hpMax === "number" && Number.isFinite(playerPatch.hpMax);
    if (hasHpCurrent || hasHpMax) {
      const nextCurrent = hasHpCurrent ? Math.max(0, Math.trunc(playerPatch.hpCurrent)) : currentHpNow;
      const nextMax = hasHpMax ? Math.max(1, Math.trunc(playerPatch.hpMax)) : maxHpNow;
      hp = { current: Math.min(nextCurrent, Math.max(nextCurrent, nextMax)), max: Math.max(nextCurrent, nextMax) };
    }

    let hitDiceRemainingOut;
    let hitDiceTotalOut;
    if (typeof playerPatch.hitDiceRemaining === "number" && Number.isFinite(playerPatch.hitDiceRemaining)) {
      hitDiceRemainingOut = Math.max(0, Math.trunc(playerPatch.hitDiceRemaining));
    }
    if (typeof playerPatch.hitDiceTotal === "number" && Number.isFinite(playerPatch.hitDiceTotal)) {
      hitDiceTotalOut = Math.max(1, Math.trunc(playerPatch.hitDiceTotal));
    }
    const hitDiceTouched = hitDiceRemainingOut !== undefined || hitDiceTotalOut !== undefined;
    const hasSpellSlotsSet =
      playerPatch.spellSlotsSet &&
      typeof playerPatch.spellSlotsSet === "object" &&
      !Array.isArray(playerPatch.spellSlotsSet);

    if (!hp && !inventoryTouched && !hitDiceTouched && !hasSpellSlotsSet) return null;
    return {
      action: "update",
      id: targetPlayerId,
      ...(hp ? { hp } : {}),
      ...(inventoryTouched ? { inventory: stackInventory(nextInventory) } : {}),
      ...(hitDiceRemainingOut !== undefined ? { hitDiceRemaining: hitDiceRemainingOut } : {}),
      ...(hitDiceTotalOut !== undefined ? { hitDiceTotal: hitDiceTotalOut } : {}),
      ...(hasSpellSlotsSet ? { spellSlots: playerPatch.spellSlotsSet } : {}),
    };
  }

  function clearTransientFlowForGodmode() {
    setPendingRoll(null);
    pendingRollRef.current = null;
    setMovementGate(null);
    setWaitForGmNarrationForInitiative(false);
    waitForGmNarrationForInitiativeLiveRef.current = false;
    setFlowBlocked(false);
    setFailedRequestPayload(null);
    setError(null);
    setIsAutoPlayerThinking(false);
    flowBlockedRef.current = false;
    failedRequestPayloadRef.current = null;
    autoTurnInProgressRef.current = false;
    rollResolutionInProgressRef.current = false;
  }

  function resolveGodmodeChatMessageIds(chatHistoryPatch) {
    if (!chatHistoryPatch || typeof chatHistoryPatch !== "object") return [];
    const currentMessages = Array.isArray(messages) ? messages : [];
    const ids = new Set();

    if (chatHistoryPatch.clearAll === true) {
      for (const message of currentMessages) {
        if (message?.id) ids.add(message.id);
      }
    }

    if (
      typeof chatHistoryPatch.removeLast === "number" &&
      Number.isFinite(chatHistoryPatch.removeLast) &&
      chatHistoryPatch.removeLast > 0
    ) {
      const slice = currentMessages.slice(-Math.trunc(chatHistoryPatch.removeLast));
      for (const message of slice) {
        if (message?.id) ids.add(message.id);
      }
    }

    if (Array.isArray(chatHistoryPatch.removeIds)) {
      for (const id of chatHistoryPatch.removeIds) {
        const trimmed = String(id ?? "").trim();
        if (trimmed) ids.add(trimmed);
      }
    }

    const roleSet = new Set(
      Array.isArray(chatHistoryPatch.removeRoles)
        ? chatHistoryPatch.removeRoles.map((role) => String(role ?? "").trim()).filter(Boolean)
        : []
    );
    const typeSet = new Set(
      Array.isArray(chatHistoryPatch.removeTypes)
        ? chatHistoryPatch.removeTypes.map((type) => String(type ?? "").trim()).filter(Boolean)
        : []
    );
    if (roleSet.size > 0 || typeSet.size > 0) {
      for (const message of currentMessages) {
        if (!message?.id) continue;
        const roleMatch = roleSet.size > 0 && roleSet.has(String(message.role ?? "").trim());
        const typeMatch = typeSet.size > 0 && typeSet.has(String(message.type ?? "").trim());
        if (roleMatch || typeMatch) ids.add(message.id);
      }
    }

    return [...ids];
  }

  async function applyGodmodeResponse(pack, originalCommand) {
    const teleport = pack?.teleport && typeof pack.teleport === "object" ? pack.teleport : null;
    const roomMemoryOps = Array.isArray(pack?.roomMemoryOps) ? pack.roomMemoryOps : [];
    const chatHistoryPatch =
      pack?.chatHistoryPatch && typeof pack.chatHistoryPatch === "object" ? pack.chatHistoryPatch : null;
    const rawEntityUpdates = Array.isArray(pack?.entityUpdates) ? pack.entityUpdates : [];
    const playerUpdate = buildGodmodePlayerUpdate(pack?.playerPatch);
    const entityUpdatesForApply = playerUpdate ? [...rawEntityUpdates, playerUpdate] : rawEntityUpdates;
    if (multiplayerSessionId && Array.isArray(entityUpdatesForApply) && entityUpdatesForApply.length > 0) {
      const localCid = String(clientId ?? "").trim();
      for (const up of entityUpdatesForApply) {
        const uid = String(up?.id ?? "").trim();
        if (!uid.startsWith("mp-player-")) continue;
        const targetCid = uid.slice("mp-player-".length).trim();
        if (!targetCid || targetCid === localCid) continue;
        let hpCurrent = null;
        if (typeof up?.hp === "number" && Number.isFinite(up.hp)) {
          hpCurrent = Math.max(0, Math.trunc(up.hp));
        } else if (
          up?.hp &&
          typeof up.hp === "object" &&
          typeof up.hp.current === "number" &&
          Number.isFinite(up.hp.current)
        ) {
          hpCurrent = Math.max(0, Math.trunc(up.hp.current));
        }
        if (hpCurrent != null) {
          void patchParticipantProfileHp(targetCid, hpCurrent);
        }
      }
    }

    clearTransientFlowForGodmode();

    let nextRoomId = currentRoomId;
    let nextSceneName = currentSceneName;
    let nextScene = currentScene;
    let nextEntitiesForRef = entities;
    let nextGameMode = gameMode;
    let nextCombatOrder = combatOrder;
    let nextTurnIndex = combatTurnIndex;

    if (teleport?.targetRoomId && teleport.targetRoomId !== currentRoomId) {
      rememberRoomEntitiesSnapshot(currentRoomId, entities);
      nextRoomId = teleport.targetRoomId;
      nextSceneName =
        String(teleport.targetSceneName ?? "").trim() ||
        String(GOBLIN_CAVE[nextRoomId]?.title ?? "").trim() ||
        currentSceneName;
      nextScene =
        typeof teleport.targetSceneDescription === "string"
          ? teleport.targetSceneDescription
          : String(GOBLIN_CAVE[nextRoomId]?.description ?? currentScene);
      nextEntitiesForRef = nextRoomId === "scene_journey" ? [] : takeEntitiesForRoom(nextRoomId);

      setCurrentRoomId(nextRoomId);
      if (nextSceneName) setCurrentSceneName(nextSceneName);
      if (typeof nextScene === "string") setCurrentScene(nextScene);
      setCurrentSceneImage("/file.svg");
      replaceEntities(nextEntitiesForRef);
      nextGameMode = "exploration";
      nextCombatOrder = [];
      nextTurnIndex = 0;
    }

    if (entityUpdatesForApply.length > 0) {
      applyEntityUpdates(entityUpdatesForApply);
    }

    const localMpCombatantForGodmode =
      multiplayerSessionId && clientId ? `mp-player-${String(clientId).trim()}` : null;
    const godmodeRevivesLocalPlayer =
      (typeof pack?.playerPatch?.hpCurrent === "number" && pack.playerPatch.hpCurrent > 0) ||
      entityUpdatesForApply.some((u) => {
        if (!u || u.action !== "update" || !u.hp || typeof u.hp.current !== "number") return false;
        if (u.hp.current <= 0) return false;
        const id = String(u.id ?? "").trim();
        return (
          id === "player" ||
          (localMpCombatantForGodmode && id === localMpCombatantForGodmode) ||
          (typeof player?.id === "string" && id === String(player.id).trim())
        );
      });
    if (godmodeRevivesLocalPlayer) {
      setIsGameOver(false);
      isGameOverRef.current = false;
    }

    if (roomMemoryOps.length > 0) {
      const currentAliasRoomId = teleport?.targetRoomId ?? currentRoomId;
      for (const op of roomMemoryOps) {
        const rawRoomId = String(op?.roomId ?? "").trim();
        const roomId = rawRoomId === "current" ? currentAliasRoomId : rawRoomId;
        if (!roomId) continue;
        if (op?.mode === "clear") {
          setRoomMemoryText(roomId, "");
        } else if (op?.mode === "replace") {
          setRoomMemoryText(roomId, String(op?.text ?? ""));
        } else if (op?.mode === "append") {
          appendRoomMemory(roomId, String(op?.text ?? ""));
        }
      }
    }

    const chatMessageIdsToRemove = resolveGodmodeChatMessageIds(chatHistoryPatch);
    if (chatMessageIdsToRemove.length > 0) {
      removeMessagesByIds(chatMessageIdsToRemove);
    }

    const combatPatch = pack?.combatPatch && typeof pack.combatPatch === "object" ? pack.combatPatch : null;
    if (combatPatch?.clearCombat === true) {
      setCombatOrder([]);
      commitCombatTurnIndex(0);
      setGameMode("exploration", entities, { force: true });
      setCombatHiddenIds([]);
      clearCombatStealthTotals();
      nextCombatOrder = [];
      nextTurnIndex = 0;
      nextGameMode = "exploration";
    }
    if (combatPatch?.gameMode === "combat") {
      setGameMode("combat");
      nextGameMode = "combat";
    } else if (combatPatch?.gameMode === "exploration") {
      setGameMode("exploration", entities, { force: true });
      nextGameMode = "exploration";
    }
    if (Array.isArray(combatPatch?.combatOrder)) {
      const nextOrder = combatPatch.combatOrder
        .map((entry) => {
          const id = String(entry?.id ?? "").trim();
          if (!id) return null;
          return {
            id,
            name: resolveCombatantDisplayName(
              { id, name: id },
              gameStateRef.current?.entities ?? entities,
              player?.name ?? null
            ),
            initiative:
              typeof entry?.initiative === "number" && Number.isFinite(entry.initiative)
                ? Math.trunc(entry.initiative)
                : 0,
          };
        })
        .filter(Boolean);
      setCombatOrder(nextOrder);
      nextCombatOrder = nextOrder;
      if (nextOrder.length > 0) {
        const requestedIndex =
          typeof combatPatch?.combatTurnIndex === "number" && Number.isFinite(combatPatch.combatTurnIndex)
            ? Math.max(0, Math.min(nextOrder.length - 1, Math.trunc(combatPatch.combatTurnIndex)))
            : 0;
        commitCombatTurnIndex(requestedIndex);
        nextTurnIndex = requestedIndex;
      }
    } else if (
      typeof combatPatch?.combatTurnIndex === "number" &&
      Number.isFinite(combatPatch.combatTurnIndex) &&
      nextCombatOrder.length > 0
    ) {
      const requestedIndex = Math.max(
        0,
        Math.min(nextCombatOrder.length - 1, Math.trunc(combatPatch.combatTurnIndex))
      );
      commitCombatTurnIndex(requestedIndex);
      nextTurnIndex = requestedIndex;
    }

    const hpAfterPatch =
      playerUpdate?.hp?.current ??
      rawEntityUpdates.find((update) => String(update?.id ?? "").trim() === "player")?.hp?.current;
    if (typeof hpAfterPatch === "number" && hpAfterPatch > 0) {
      deathNarrationSentRef.current = false;
      setIsGameOver(false);
      isGameOverRef.current = false;
      playerHpRef.current = hpAfterPatch;
    }

    addMessage(
      "ai",
      String(pack?.narration ?? pack?.summary ?? "Commande godmode appliquée.").trim(),
      "meta-reply",
      makeMsgId()
    );
    addMessage(
      "ai",
      `[DEBUG] Godmode appliqué\n` +
        safeJson({
          command: originalCommand,
          summary: pack?.summary ?? null,
          teleport: teleport ?? null,
          entityUpdates: entityUpdatesForApply,
          roomMemoryOps,
          chatHistoryPatch,
          removedMessageIds: chatMessageIdsToRemove,
          combatPatch,
        }),
      "debug",
      makeMsgId()
    );

    gameStateRef.current = {
      ...gameStateRef.current,
      currentRoomId: nextRoomId,
      currentScene: nextScene,
      currentSceneName: nextSceneName,
      entities: nextEntitiesForRef,
      gameMode: nextGameMode,
      combatOrder: nextCombatOrder,
      combatTurnIndex: nextTurnIndex,
    };
    if (multiplayerSessionId) {
      try {
        await flushMultiplayerSharedState();
      } catch {
        /* ignore */
      }
    }
  }

  // Décompte quota 429
  useEffect(() => {
    if (retryCountdown <= 0) return;
    countdownRef.current = setInterval(() => {
      setRetryCountdown((s) => {
        if (s <= 1) { clearInterval(countdownRef.current); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(countdownRef.current);
  }, [retryCountdown]);

  const chatScrollAnchorKey = useMemo(() => {
    if (!messages?.length) return "0";
    const last = messages[messages.length - 1];
    return `${messages.length}:${String(last?.id ?? "")}`;
  }, [messages]);

  // Auto-scroll : uniquement si l'utilisateur est déjà près du bas (sinon lecture d'historique impossible).
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatScrollAnchorKey]);

  // ---------------------------------------------------------------------------
  // Génération d'image de scène (décision du narrateur)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (imageModel === "disabled") {
      lastImageGenKeyRef.current = null;
      return;
    }
    if (!sceneImageTrigger?.key) return;

    const key = sceneImageTrigger.key;
    if (lastImageGenKeyRef.current === key) return;
    lastImageGenKeyRef.current = key;

    const capturedKey = key;
    /** ID unique par tentative (évite clés React dupliquées si remontage Strict Mode / courses). */
    const pendingId = `scene-pending-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const roomFromMap =
      currentRoomId && GOBLIN_CAVE[currentRoomId] ? GOBLIN_CAVE[currentRoomId] : null;
    const locationDesc =
      (typeof roomFromMap?.description === "string" && roomFromMap.description.trim()) ||
      (typeof currentScene === "string" ? currentScene.trim() : "") ||
      "";

    const lastAiNarration =
      [...messages].reverse().find((m) => m.role === "ai" && !m.type)?.content ?? "";

    const sourceEngineEvent =
      sceneImageTrigger?.engineEvent && typeof sceneImageTrigger.engineEvent === "object"
        ? sceneImageTrigger.engineEvent
        : null;
    const eventFocusEntity =
      sourceEngineEvent && Array.isArray(entities)
        ? entities.find(
            (e) =>
              e &&
              ((sourceEngineEvent.targetId && e.id === sourceEngineEvent.targetId) ||
                (sourceEngineEvent.targetName && e.name === sourceEngineEvent.targetName))
          ) ?? null
        : null;

    const weaponNames = Array.isArray(player?.weapons)
      ? player.weapons.map((w) => w?.name).filter(Boolean)
      : [];
    const invItems = Array.isArray(player?.inventory) ? player.inventory.filter(Boolean) : [];
    const dedupeStringsPreserveOrder = (items) => {
      const seen = new Set();
      const out = [];
      for (const x of items) {
        const t = String(x ?? "").trim();
        if (!t) continue;
        const k = t.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(t);
      }
      return out;
    };
    const visibleGearParts = dedupeStringsPreserveOrder([...weaponNames, ...invItems]);
    const visibleGear =
      visibleGearParts.length > 0 ? visibleGearParts.join(", ") : "Non détaillé dans la fiche";

    const presentNPCs = (entities ?? [])
      .filter(
        (e) =>
          e &&
          e.visible !== false &&
          !e?.hidden &&
          e.isAlive &&
          e.type !== "object"
      )
      .map((e) => ({
        name: e.name ?? e.id ?? "Personnage",
        appearance: typeof e.description === "string" ? e.description : "",
        type: e.type ?? null,
      }));

    const visualContext = {
      sceneName: currentSceneName || null,
      location: locationDesc,
      narrativeFocus:
        String(sceneImageTrigger?.reason ?? "").trim() ||
        String(lastAiNarration || "").trim() ||
        null,
      gmNarration:
        typeof lastAiNarration === "string" && lastAiNarration.trim() ? lastAiNarration.trim() : null,
      /** Aide le serveur / les traces : priorité décor = location ; pas de PNJ inventés si liste vide. */
      sceneForImage: {
        onlyPlayerCharacterInFrame: presentNPCs.length === 0,
        listedNPCCount: presentNPCs.length,
      },
      imageTrigger: {
        kind: sceneImageTrigger?.kind ?? "scene",
        title: sceneImageTrigger?.title ?? currentSceneName ?? null,
        reason: sceneImageTrigger?.reason ?? null,
        focus: sceneImageTrigger?.focus ?? null,
        engineEvent:
          sourceEngineEvent
            ? {
                kind: sourceEngineEvent.kind ?? null,
                reason: sourceEngineEvent.reason ?? null,
                details: sourceEngineEvent.details ?? null,
                targetId: sourceEngineEvent.targetId ?? null,
                targetName: sourceEngineEvent.targetName ?? null,
                spellName: sourceEngineEvent.spellName ?? null,
                damage: sourceEngineEvent.damage ?? null,
                hit: sourceEngineEvent.hit ?? null,
                crit: sourceEngineEvent.crit ?? null,
                targetHpAfter: sourceEngineEvent.targetHpAfter ?? null,
                targetHpMax: sourceEngineEvent.targetHpMax ?? null,
                targetIsAlive: sourceEngineEvent.targetIsAlive ?? null,
              }
            : null,
      },
      eventFocusTarget:
        sourceEngineEvent?.targetName || eventFocusEntity
          ? {
              name: sourceEngineEvent?.targetName ?? eventFocusEntity?.name ?? null,
              appearance:
                typeof eventFocusEntity?.description === "string" && eventFocusEntity.description.trim()
                  ? eventFocusEntity.description.trim()
                  : null,
              type: eventFocusEntity?.type ?? null,
              isAlive:
                typeof sourceEngineEvent?.targetIsAlive === "boolean"
                  ? sourceEngineEvent.targetIsAlive
                  : eventFocusEntity?.isAlive ?? null,
              hpAfter:
                typeof sourceEngineEvent?.targetHpAfter === "number"
                  ? sourceEngineEvent.targetHpAfter
                  : eventFocusEntity?.hp?.current ?? null,
              hpMax:
                typeof sourceEngineEvent?.targetHpMax === "number"
                  ? sourceEngineEvent.targetHpMax
                  : eventFocusEntity?.hp?.max ?? null,
            }
          : null,
      playerInfo: {
        characterName:
          typeof player?.name === "string" && player.name.trim() ? player.name.trim() : null,
        race: typeof player?.race === "string" && player.race.trim() ? player.race.trim() : null,
        characterClass:
          typeof player?.entityClass === "string" && player.entityClass.trim()
            ? player.entityClass.trim()
            : null,
        level: typeof player?.level === "number" && Number.isFinite(player.level) ? player.level : null,
        description:
          typeof player?.description === "string" && player.description.trim()
            ? player.description.trim()
            : null,
        visibleGear,
      },
      presentNPCs,
    };

    const pendingLabel = "Le MJ peint une illustration...";
    const debugBlock =
      `[DEBUG] Contexte visuel envoyé à /api/scene-image (synthèse serveur → prompt image) :\n` +
      safeJson(visualContext);
    appendSceneImagePendingSlot(pendingId, pendingLabel, debugBlock);

    (async () => {
      try {
        const { res, data } = await fetchJsonWithTimeout(
          "/api/scene-image",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ visualContext, model: imageModel }),
          },
          API_AI_THINKING_TIMEOUT_MS,
          "scene-image"
        );
        if (!res.ok) {
          const msg = data?.details
            ? `${data.error || "Erreur API"} (${data.status || res.status}): ${data.details}`
            : data?.error || `Erreur API interne: ${res.status}`;
          throw new Error(msg);
        }
        if (!data?.url) throw new Error("Réponse invalide du serveur d'images.");

        // Afficher l'image dans le chat Ã  l'endroit de sa génération (message persisté)
        if (lastImageGenKeyRef.current !== capturedKey) {
          removeMessagesByIds([pendingId]);
          return;
        }

        updateMessage(pendingId, { content: data.url, type: "scene-image" });

        // Mettre Ã  jour la miniature bas-droite (page.tsx)
        setCurrentSceneImage(data.url);
      } catch (e) {
        if (lastImageGenKeyRef.current === capturedKey) {
          removeMessagesByIds([pendingId]);
          addMessage(
            "ai",
            `[DEBUG] Génération image échouée (${imageModel})\n${String(e?.message ?? e)}`,
            "debug",
            makeMsgId()
          );
          markFlowFailure(String(e?.message ?? e), {
            kind: "scene-image",
            visualContext,
            model: imageModel,
          });
        } else {
          removeMessagesByIds([pendingId]);
        }
      }
    })();
  }, [sceneImageTrigger, currentRoomId, currentSceneName, currentScene, imageModel, messages, entities, player, removeMessagesByIds, updateMessage, addMessage, appendSceneImagePendingSlot, setCurrentSceneImage]);

  // ---------------------------------------------------------------------------
  // Tours ennemis simulés côté client
  // ---------------------------------------------------------------------------
  async function generateEnemyTurn(enemy, context = {}) {
    const prevChain = tacticianFetchTailRef.current;
    let releaseChain;
    const nextGate = new Promise((r) => {
      releaseChain = r;
    });
    tacticianFetchTailRef.current = prevChain.then(() => nextGate);
    await prevChain;
    try {
      return await generateEnemyTurnInner(enemy, context);
    } finally {
      releaseChain();
    }
  }

  async function generateEnemyTurnInner(enemy, context = {}) {
    try {
      const pool = gameStateRef.current?.entities ?? entities;
      const order = gameStateRef.current?.combatOrder ?? combatOrder;
      const orderLen = Array.isArray(order) ? order.length : 0;
      const slotFromContext =
        typeof context?.tacticianSlotIndex === "number" && Number.isFinite(context.tacticianSlotIndex)
          ? Math.trunc(context.tacticianSlotIndex)
          : null;
      const slotIdx =
        orderLen > 0
          ? Math.min(
              Math.max(0, slotFromContext ?? combatTurnIndexLiveRef.current),
              orderLen - 1
            )
          : 0;
      /** Slot + engagement + round + writeSeq : évite cache obsolète après bump MP sur le même slot. */
      const turnWriteSeqForTactician =
        typeof gameStateRef.current?.combatTurnWriteSeq === "number" &&
        Number.isFinite(gameStateRef.current.combatTurnWriteSeq)
          ? Math.trunc(gameStateRef.current.combatTurnWriteSeq)
          : Math.trunc(combatTurnWriteSeq ?? 0);
      const tacticianKey = `${enemy?.id ?? "?"}|${combatEngagementSeqRef.current}|${combatRoundInEngagementRef.current}|slot:${slotIdx}|w:${turnWriteSeqForTactician}`;
      if (tacticianTurnCacheRef.current.has(tacticianKey)) {
        return tacticianTurnCacheRef.current.get(tacticianKey);
      }
      const inflight = tacticianInFlightByKeyRef.current;
      if (inflight.has(tacticianKey)) {
        return await inflight.get(tacticianKey);
      }
      let resolveTacticianShared;
      let rejectTacticianShared;
      const tacticianShared = new Promise((res, rej) => {
        resolveTacticianShared = res;
        rejectTacticianShared = rej;
      });
      inflight.set(tacticianKey, tacticianShared);

      let body;
      try {
      const engagedWithEnemy = getMeleeWith(enemy.id);
      const playerRows = [];
      const seenPlayerIds = new Set();

      const pushTacticianPlayerRow = (rawId, fallbackName) => {
        const id = String(rawId ?? "").trim();
        if (!id || seenPlayerIds.has(id)) return;
        if (controllerForCombatantId(id, pool) !== "player") return;
        seenPlayerIds.add(id);

        let combatant = getRuntimeCombatant(id, pool);
        if (!combatant && String(id).startsWith("mp-player-") && Array.isArray(multiplayerParticipantProfiles)) {
          const cid = String(id).slice("mp-player-".length);
          const prof = multiplayerParticipantProfiles.find(
            (p) => String(p?.clientId ?? "").trim() === String(cid).trim()
          );
          if (prof) {
            const sheet = prof?.playerSnapshot && typeof prof.playerSnapshot === "object" ? prof.playerSnapshot : null;
            const curP = typeof prof.hpCurrent === "number" ? prof.hpCurrent : 0;
            const maxP =
              typeof prof.hpMax === "number" && prof.hpMax > 0 ? prof.hpMax : Math.max(1, curP || 1);
            const deathSnap = sheet
              ? getPlayerDeathStateSnapshot({
                  ...sheet,
                  hp: {
                    ...((sheet.hp && typeof sheet.hp === "object") ? sheet.hp : {}),
                    current: curP,
                    max: maxP,
                  },
                })
              : null;
            combatant = {
              id,
              name: prof.name ?? fallbackName ?? id,
              hp:
                prof.hpCurrent != null && prof.hpMax != null
                  ? { current: curP, max: maxP }
                  : null,
              ac: prof.ac ?? null,
              isAlive: prof.connected !== false && (deathSnap ? deathSnap.dead !== true : true),
            };
          }
        }
        if (
          !combatant &&
          player &&
          (isLocalPlayerCombatantId(id) || isSoloStalePlayerEntityIdAbsentFromPool(id, pool))
        ) {
          const deathState = getPlayerDeathStateSnapshot(player);
          combatant = {
            ...player,
            id,
            controller: "player",
            isAlive: deathState.dead !== true,
            hp: player.hp
              ? {
                  ...player.hp,
                  current: playerHpRef.current ?? player.hp.current,
                }
              : player.hp,
          };
        }
        if (!combatant) return;

        const displayName = resolveCombatantDisplayName(
          { id, name: combatant.name ?? fallbackName },
          pool,
          player?.name ?? null
        );
        const inMelee = engagedWithEnemy.includes(id);
        const liveHp = getCombatantCurrentHp(combatant);
        const hpOut =
          combatant.hp && typeof combatant.hp === "object"
            ? {
                current: liveHp ?? combatant.hp.current,
                max: combatant.hp.max,
              }
            : null;

        const localMpIdForDeath =
          multiplayerSessionId && clientId ? `mp-player-${String(clientId).trim()}` : null;
        const srcForDeath =
          id === "player" || (localMpIdForDeath && id === localMpIdForDeath) ? player : combatant;
        const deathSnap = getPlayerDeathStateSnapshot(srcForDeath);
        let isAliveTactic = deathSnap.dead !== true;
        if (String(id).startsWith("mp-player-") && (!localMpIdForDeath || id !== localMpIdForDeath)) {
          const cidRem = String(id).slice("mp-player-".length);
          const profRem = Array.isArray(multiplayerParticipantProfiles)
            ? multiplayerParticipantProfiles.find(
                (p) => String(p?.clientId ?? "").trim() === String(cidRem).trim()
              )
            : null;
          if (profRem && profRem.connected === false) isAliveTactic = false;
        }

        playerRows.push({
          id,
          name: displayName,
          hp: hpOut,
          ac: getCombatantArmorClass(combatant),
          position: context?.playerPosition ?? "theater_of_mind",
          // Uniquement si CE PJ est au contact de CET ennemi (ne pas réutiliser context.distance : c'était global et marquait « melee » pour tout le monde).
          distance: inMelee ? "melee" : "unknown",
          inMeleeWithThisEnemy: inMelee,
          isAlive: isAliveTactic,
          unconsciousAt0Hp: deathSnap.unconscious === true && deathSnap.dead !== true,
        });
      };

      if (Array.isArray(order) && order.length > 0) {
        for (const entry of order) {
          pushTacticianPlayerRow(entry?.id, entry?.name);
        }
      }
      for (const ent of pool) {
        if (!ent?.id) continue;
        if (seenPlayerIds.has(ent.id)) continue;
        if (ent.type !== "friendly") continue;
        if (combatantControllerValue(ent) !== "player") continue;
        pushTacticianPlayerRow(ent.id, ent.name);
      }
      if (playerRows.length === 0 && player) {
        pushTacticianPlayerRow("player", player.name);
      }

      const meleePairsRaw = buildUndirectedMeleePairsForTactics(meleeState);
      const meleeEngagementsForPayload = meleePairsRaw.map(([a, b]) => ({
        combatantIdA: a,
        combatantIdB: b,
        label: `${resolveCombatantDisplayName({ id: a }, pool, player?.name ?? null)} ↔ ${resolveCombatantDisplayName({ id: b }, pool, player?.name ?? null)}`,
      }));

      const enemyTemplateId = inferBestiaryTemplateIdForEntity(enemy);
      const enemyTemplate = enemyTemplateId && BESTIARY?.[enemyTemplateId] ? BESTIARY[enemyTemplateId] : null;
      const enemyWeapons =
        Array.isArray(enemy.weapons) && enemy.weapons.length > 0
          ? enemy.weapons
          : Array.isArray(enemyTemplate?.weapons)
          ? enemyTemplate.weapons
          : [];
      const enemyKnownSpells = getCombatantKnownSpells(enemy);
      const enemyFeaturesText = (Array.isArray(enemy.features) ? enemy.features : [])
        .map((f) => String(f ?? "").toLowerCase())
        .join(" | ");
      const hasCunningEscape =
        enemyFeaturesText.includes("fuite agile") ||
        enemyFeaturesText.includes("nimble escape");
      const hasSpellSlotForLevel = (spellLevel) => {
        const level = Number(spellLevel ?? 0);
        if (!Number.isFinite(level) || level <= 0) return true;
        const slots = enemy?.spellSlots ?? {};
        return Object.entries(slots).some(([slotLevel, row]) => {
          const numericLevel = Number(slotLevel);
          if (!Number.isFinite(numericLevel) || numericLevel < level) return false;
          const remaining = Number(row?.remaining ?? row?.max ?? 0);
          return remaining > 0;
        });
      };
      const enemySpellOptions = enemyKnownSpells
        .map((spellName) => {
          const canonicalSpellName = canonicalizeSpellNameAgainstCombatant(enemy, spellName) ?? spellName;
          const spell = SPELLS?.[canonicalSpellName];
          if (!spell) return null;
          const castingTime = normalizeFr(spell.castingTime ?? "");
          const isActionSpell = castingTime.includes("action") && !castingTime.includes("reaction");
          const isOffensiveSpell =
            !!spell.save || !!spell.damage || /attaque|attack/i.test(String(spell.attack ?? ""));
          if (!isActionSpell || !isOffensiveSpell) return null;
          return {
            key: `spell_${normalizeFr(canonicalSpellName).replace(/[^a-z0-9]+/g, "_")}`,
            label: canonicalSpellName,
            cost: { action: 1 },
            available: hasSpellSlotForLevel(spell.level ?? 0),
            spellName: canonicalSpellName,
          };
        })
        .filter(Boolean);
      const effectiveAttackBonus = enemy.attackBonus ?? enemyTemplate?.attackBonus ?? null;
      const effectiveDamageDice = enemy.damageDice ?? enemyTemplate?.damageDice ?? null;
      const effectiveDamageBonus = enemy.damageBonus ?? enemyTemplate?.damageBonus ?? null;
      const hasWeaponAttackOption =
        enemyWeapons.length > 0 || effectiveAttackBonus != null || !!effectiveDamageDice;
      body = {
        provider: aiProvider,
        enemy: {
          id: enemy.id,
          name: enemy.name,
          type: enemy.type,
          entityClass: enemy.entityClass && enemy.entityClass !== "Inconnu"
            ? enemy.entityClass
            : enemyTemplate?.entityClass ?? enemy.entityClass ?? "",
          surprised: !!enemy.surprised,
          combatTimedStates: normalizeCombatTimedStates(enemy.combatTimedStates),
          hp: enemy.hp,
          ac: enemy.ac ?? null,
          stats: enemy.stats ?? enemyTemplate?.stats ?? null,
          attackBonus: effectiveAttackBonus,
          damageDice: effectiveDamageDice,
          damageBonus: effectiveDamageBonus,
          weapons: enemyWeapons,
          selectedSpells: getCombatantKnownSpells(enemy),
          spellAttackBonus: computeSpellAttackBonus(enemy),
          spellSaveDc: computeSpellSaveDC(enemy),
          features:
            Array.isArray(enemy.features) && enemy.features.length > 0
              ? enemy.features
              : Array.isArray(enemyTemplate?.features)
              ? enemyTemplate.features
              : [],
          description: enemy.description || enemyTemplate?.description || "",
          visible: enemy.visible,
          isAlive: enemy.isAlive,
        },
        players: playerRows,
        battleState: {
          gameMode,
          engagedWith: engagedWithEnemy,
          /** Toutes les paires au corps à corps sur le champ de bataille (graphe mêlée moteur). */
          meleeEngagements: meleeEngagementsForPayload,
          inMelee: engagedWithEnemy.some((tid) => controllerForCombatantId(tid, pool) === "player"),
          playerCanOpportunityAttack:
            hasReaction(localCombatantId) && !!turnResourcesRef.current?.reaction,
          resources: {
            action: true,
            bonus_action: true,
            movement: !!context?.movementOk,
            reaction: hasReaction(enemy.id),
          },
          actionCatalog: {
            mainActionOptions: [
              {
                key: "attack_weapon",
                label: "Attaquer (arme)",
                cost: { action: 1 },
                available: hasWeaponAttackOption,
                weaponNames: enemyWeapons
                  .map((w) => String(w?.name ?? "").trim())
                  .filter(Boolean),
              },
              ...enemySpellOptions,
              {
                key: "dash",
                label: "Foncer (Dash)",
                cost: { action: 1 },
                available: true,
              },
              {
                key: "disengage",
                label: "Se désengager (Disengage)",
                cost: { action: 1 },
                available: true,
              },
              {
                key: "dodge",
                label: "Esquiver (Dodge)",
                cost: { action: 1 },
                available: true,
              },
              {
                key: "hide",
                label: "Se cacher (Hide)",
                cost: { action: 1 },
                available: true,
              },
            ],
            bonusActionOptions: [
              {
                key: "bonus_disengage",
                label: "Se désengager (bonus)",
                cost: { bonus_action: 1 },
                available: hasCunningEscape,
                source: hasCunningEscape ? "Fuite agile / Nimble Escape" : null,
              },
              {
                key: "bonus_hide",
                label: "Se cacher (bonus)",
                cost: { bonus_action: 1 },
                available: hasCunningEscape,
                source: hasCunningEscape ? "Fuite agile / Nimble Escape" : null,
              },
            ],
            movementOptions: [
              {
                key: "move_approach",
                label: "S'approcher",
                cost: { movement: 1 },
                available: !!context?.movementOk,
              },
              {
                key: "move_away",
                label: "S'éloigner / Fuir",
                cost: { movement: 1 },
                available: !!context?.movementOk,
              },
            ],
          },
          roundContext: context?.roundContext ?? null,
        },
      };
      } catch (syncErr) {
        tacticianInFlightByKeyRef.current.delete(tacticianKey);
        rejectTacticianShared(syncErr);
        throw syncErr;
      }

      (async () => {
        try {
          const { res, data } = await fetchJsonWithTimeout(
            "/api/enemy-tactics",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
            API_AI_THINKING_TIMEOUT_MS,
            "enemy-tactics"
          );
          if (!res.ok) throw new Error(data?.details ?? data?.error ?? `Enemy tactics failed (${res.status})`);
          const orderAfter = gameStateRef.current?.combatOrder ?? combatOrder ?? [];
          const lenAfter = Array.isArray(orderAfter) ? orderAfter.length : 0;
          const idxLive =
            lenAfter > 0
              ? Math.min(Math.max(0, combatTurnIndexLiveRef.current), lenAfter - 1)
              : 0;
          const activeAfter = lenAfter > 0 ? orderAfter[idxLive]?.id : null;
          const occupantAtCommittedSlot =
            lenAfter > 0 && slotIdx >= 0 && slotIdx < lenAfter ? orderAfter[slotIdx]?.id : null;
          if (
            occupantAtCommittedSlot !== enemy?.id ||
            activeAfter !== enemy?.id ||
            idxLive !== slotIdx
          ) {
            if (gameStateRef.current?.debugMode) {
              addMessage(
                "ai",
                `[DEBUG] Réponse tacticien ignorée (tour plus actif pour cette créature : slot attendu ${slotIdx} occupé par ${occupantAtCommittedSlot ?? "?"}, curseur ${idxLive} → ${activeAfter ?? "?"}, ennemi ${enemy?.id}).`,
                "debug",
                makeMsgId()
              );
            }
            resolveTacticianShared({ actions: [] });
            return;
          }
          tacticianTurnCacheRef.current.set(tacticianKey, data);
          resolveTacticianShared(data);
        } catch (e) {
          rejectTacticianShared(e);
        } finally {
          tacticianInFlightByKeyRef.current.delete(tacticianKey);
        }
      })();

      return await tacticianShared;
    } catch (err) {
      markFlowFailure(
        `Enemy tactics indisponible: ${String(err?.message ?? err)}`,
        { kind: "enemy-tactics", enemyId: enemy?.id ?? null }
      );
      throw err;
    }
  }

  /** Arme de mêlée pour AoO : main principale équipée si possible, sinon première mêlée. */
  function pickPlayerMeleeOpportunityWeapon(combatant) {
    if (!combatant) return null;
    const weapons = Array.isArray(combatant.weapons) ? combatant.weapons : [];
    const eq = combatant.equipment && typeof combatant.equipment === "object" ? combatant.equipment : null;
    const mainRaw = eq?.mainHand ? String(eq.mainHand).trim() : "";
    const meleePool = weapons.filter(
      (w) => w && !isRangedWeaponName(w?.name ?? "") && w?.kind !== "ranged"
    );
    if (mainRaw && meleePool.length > 0) {
      const wanted = normalizeFr(mainRaw);
      const byName =
        meleePool.find((w) => normalizeFr(String(w?.name ?? "")) === wanted) ??
        meleePool.find((w) => {
          const wn = normalizeFr(String(w?.name ?? ""));
          return wn.includes(wanted) || wanted.includes(wn);
        });
      if (byName) return byName;
    }
    return meleePool[0] ?? weapons[0] ?? null;
  }

  /**
   * PJ (local ou distant) : mêmes jets / bloc combat-detail que resolveCombatantWeaponAttack.
   */
  async function resolvePlayerOpportunityAttack(reactor, target) {
    if (!reactor?.id || !target) {
      return { performed: false, targetAlive: target?.isAlive !== false };
    }
    const rid = String(reactor.id).trim();
    const trMap = gameStateRef.current?.turnResourcesByCombatantId ?? {};
    const tr = normalizeTurnResourcesInput(trMap[rid]);
    if (!tr.reaction || !hasReaction(rid)) {
      addMessage(
        "ai",
        `⚔️ **${reactor.name ?? "Combattant"}** ne peut pas effectuer d'attaque d'opportunité contre **${target.name}** (réaction indisponible).`,
        "enemy-turn",
        makeMsgId()
      );
      return { performed: false, targetAlive: target?.isAlive !== false };
    }
    const weapon = pickPlayerMeleeOpportunityWeapon(reactor);
    if (!weapon || isRangedWeaponName(weapon?.name ?? "") || weapon?.kind === "ranged") {
      addMessage(
        "ai",
        `⚔️ **${reactor.name ?? "Combattant"}** n'a pas d'arme de mêlée utilisable pour une attaque d'opportunité.`,
        "enemy-turn",
        makeMsgId()
      );
      return { performed: false, targetAlive: target?.isAlive !== false };
    }
    setTurnResourcesForCombatant(rid, (prev) => ({
      ...normalizeTurnResourcesInput(prev),
      reaction: false,
    }));
    setReactionFor(rid, false);
    if (isLocalPlayerCombatantId(rid)) {
      turnResourcesRef.current = normalizeTurnResourcesInput({
        ...turnResourcesRef.current,
        reaction: false,
      });
    }

    let atkResult;
    try {
      atkResult = await resolveCombatantWeaponAttack(
        reactor,
        target,
        weapon,
        " (attaque d'opportunité)",
        null,
        { type: "reaction", name: weapon.name, target: target.id }
      );
    } catch {
      atkResult = false;
    }
    const liveTarget = getRuntimeCombatant(target.id);
    return {
      performed: atkResult !== false,
      targetAlive: atkResult === "player_dead" ? false : liveTarget?.isAlive !== false,
    };
  }

  function pickCombatantOpportunityWeapon(combatant) {
    if (!combatant) return null;
    const templateId = inferBestiaryTemplateIdForEntity(combatant);
    const template = templateId && BESTIARY?.[templateId] ? BESTIARY[templateId] : null;
    const combatantWeapons = Array.isArray(combatant.weapons) && combatant.weapons.length > 0
      ? combatant.weapons
      : Array.isArray(template?.weapons)
      ? template.weapons
      : [];
    const meleeWeapon =
      combatantWeapons.find((weapon) => !isRangedWeaponName(weapon?.name ?? "") && weapon?.kind !== "ranged") ??
      null;
    if (meleeWeapon) return meleeWeapon;
    const fallbackAttackBonus = combatant.attackBonus ?? template?.attackBonus ?? null;
    const fallbackDamageDice = combatant.damageDice ?? template?.damageDice ?? null;
    const fallbackDamageBonus = combatant.damageBonus ?? template?.damageBonus ?? null;
    if (fallbackAttackBonus != null || fallbackDamageDice || fallbackDamageBonus != null) {
      return {
        name: "Attaque d'opportunité",
        attackBonus: fallbackAttackBonus ?? 0,
        damageDice: fallbackDamageDice ?? "1d4",
        damageBonus: fallbackDamageBonus ?? 0,
        kind: "melee",
      };
    }
    return null;
  }

  async function resolveEnemyOpportunityAttack(reactor, target) {
    if (!reactor || !target) return { performed: false, targetAlive: target?.isAlive !== false };
    if (!hasReaction(reactor.id)) {
      return { performed: false, targetAlive: target?.isAlive !== false };
    }
    const chosenWeapon = pickCombatantOpportunityWeapon(reactor);
    if (!chosenWeapon) {
      addMessage(
        "ai",
        `⚔️ ${reactor.name} ne peut pas profiter de l'ouverture pour porter une attaque d'opportunité.`,
        "enemy-turn",
        makeMsgId()
      );
      setReactionFor(reactor.id, false);
      return { performed: false, targetAlive: target?.isAlive !== false };
    }
    setReactionFor(reactor.id, false);
    const result = await resolveCombatantWeaponAttack(
      reactor,
      target,
      chosenWeapon,
      " (attaque d'opportunité)",
      null,
      { type: "reaction", name: chosenWeapon.name, target: target.id, skipShieldPrompt: true }
    );
    const liveTarget = getRuntimeCombatant(target.id);
    return {
      performed: true,
      targetAlive:
        result === "player_dead" ? false : liveTarget?.isAlive !== false,
    };
  }

  function promptPlayerOpportunityAttack(reactor, target) {
    return new Promise((resolve) => {
      opportunityAttackPromptResolverRef.current = resolve;
      setOpportunityAttackPrompt({
        reactorId: reactor?.id ?? "player",
        targetId: target?.id ?? "",
        reactorName: reactor?.name ?? player?.name ?? "Vous",
        targetName: target?.name ?? "la cible",
      });
    });
  }

  /** Si le PJ local actif tombe à 0 PV pendant son propre tour (ex. attaque d'opportunité), terminer son tour. */
  const autoEndTurnWhenDownedKeyRef = useRef(null);
  async function maybeAutoEndLocalTurnWhenDowned() {
    const gm = gameStateRef.current?.gameMode ?? gameMode;
    if (gm !== "combat") return false;
    const order = gameStateRef.current?.combatOrder ?? combatOrder;
    if (!Array.isArray(order) || order.length === 0) return false;
    const idx = clampedCombatTurnIndex();
    const activeId = order[idx]?.id ?? null;
    const localAliasActive =
      String(activeId ?? "").trim() === "player" &&
      (String(localCombatantId ?? "").trim() === "player" ||
        String(localCombatantId ?? "").trim().startsWith("mp-player-"));
    if (!activeId || (!isLocalPlayerCombatantId(activeId) && !localAliasActive)) return false;
    const hpNow =
      playerHpRef.current ??
      gameStateRef.current?.player?.hp?.current ??
      player?.hp?.current ??
      0;
    if (hpNow > 0) return false;
    // Stabilisé à 0 PV : `preparePlayerTurnStartState` + effet dédié gèdent déjà le message et nextTurn().
    if (getPlayerDeathStateSnapshot().stable) return false;
    // Début de tour à 0 PV : le flux normal doit proposer un death save, pas auto-skip.
    if (pendingRollRef.current?.kind === "death_save") return false;
    const dedupeKey = `${combatEngagementSeqRef.current}:${combatRoundInEngagementRef.current}:${idx}:${activeId}`;
    if (autoEndTurnWhenDownedKeyRef.current === dedupeKey) return true;
    autoEndTurnWhenDownedKeyRef.current = dedupeKey;
    addMessage("ai", `**${player?.name ?? "Vous"}** ne peut rien faire d'autre ce tour-ci.`, "turn-end", makeMsgId());
    addMessage("ai", "", "turn-divider", makeMsgId());
    queueMicrotask(() => {
      void nextTurn();
    });
    return true;
  }

  /** Filet : si le PJ local actif est à 0 PV au milieu de son tour (sans death save), forcer la fin de tour. */
  useEffect(() => {
    if (gameMode !== "combat") return;
    if (awaitingPlayerInitiative) return;
    if (enemyTurnLoopInProgressRef.current) return;
    if (isGameOverRef.current) return;
    const order = gameStateRef.current?.combatOrder ?? combatOrder;
    if (!Array.isArray(order) || order.length === 0) return;
    const idx = clampedCombatTurnIndex();
    const activeId = String(order[idx]?.id ?? "").trim();
    const localAliasActive =
      activeId === "player" &&
      (String(localCombatantId ?? "").trim() === "player" ||
        String(localCombatantId ?? "").trim().startsWith("mp-player-"));
    if (!activeId || (!isLocalPlayerCombatantId(activeId) && !localAliasActive)) return;
    if (pendingRollRef.current?.kind === "death_save") return;
    const hpNow =
      playerHpRef.current ??
      gameStateRef.current?.player?.hp?.current ??
      player?.hp?.current ??
      0;
    if (hpNow > 0) return;
    void maybeAutoEndLocalTurnWhenDowned();
  }, [gameMode, combatTurnIndex, combatOrder, awaitingPlayerInitiative, player?.hp?.current, pendingRoll]);

  async function settlePlayerOpportunityAttackPrompt(choice) {
    const prompt = opportunityAttackPrompt;
    const resolver = opportunityAttackPromptResolverRef.current;
    opportunityAttackPromptResolverRef.current = null;
    setOpportunityAttackPrompt(null);
    if (!prompt || typeof resolver !== "function") return;

    const target = getRuntimeCombatant(prompt.targetId);
    const reactor = getRuntimeCombatant(prompt.reactorId);
    if (choice === "attack" && target?.isAlive !== false && reactor) {
      const result = await resolvePlayerOpportunityAttack(reactor, target);
      resolver(result ?? { performed: false, targetAlive: target?.isAlive !== false });
      return;
    }

    addMessage(
      "ai",
      `⚔️ ${prompt.reactorName} laisse ${prompt.targetName} quitter le contact sans utiliser de réaction.`,
      "enemy-turn",
      makeMsgId()
    );
    resolver({ performed: false, targetAlive: target?.isAlive !== false });
  }

  const SHIELD_SPELL_NAME = "Bouclier";

  function defenderCanCastShieldReaction(target) {
    if (!target?.id) return { ok: false, reason: "" };
    const canon = canonicalizeSpellNameAgainstCombatant(target, SHIELD_SPELL_NAME);
    if (!canon || !SPELLS?.[canon]) return { ok: false, reason: "" };
    const spell = SPELLS[canon];
    const level = spell?.level ?? 1;
    if (!combatantHasSpellSlotAtOrAbove(target, level)) {
      return { ok: false, reason: "Pas d'emplacement de sort disponible pour Bouclier." };
    }
    const trMap = gameStateRef.current?.turnResourcesByCombatantId ?? turnResourcesByCombatantId ?? {};
    const tr = normalizeTurnResourcesInput(trMap[target.id]);
    if (!tr.reaction || !hasReaction(target.id)) {
      return { ok: false, reason: "Réaction indisponible." };
    }
    const compV = validateSpellCastingComponents(target, canon);
    if (!compV.ok) return { ok: false, reason: compV.reason };
    if (
      normalizeCombatTimedStates(target.combatTimedStates).some(
        (e) => e.stateId === COMBAT_TIMED_STATE_IDS.BOUCLIER
      )
    ) {
      return { ok: false, reason: "Bouclier déjà actif." };
    }
    return { ok: true, canon };
  }

  function promptPlayerShieldReaction(defender, attacker, chosenWeapon, atkTotal, baseAc) {
    return new Promise((resolve) => {
      shieldReactionPromptResolverRef.current = resolve;
      setShieldReactionPrompt({
        defenderId: defender?.id ?? "",
        attackerName: attacker?.name ?? "",
        weaponName: chosenWeapon?.name ?? "",
        defenderName: defender?.name ?? "Vous",
        atkTotal,
        baseAc,
      });
    });
  }

  function settlePlayerShieldReactionPrompt(choice) {
    const resolver = shieldReactionPromptResolverRef.current;
    shieldReactionPromptResolverRef.current = null;
    setShieldReactionPrompt(null);
    if (typeof resolver === "function") resolver(choice);
  }

  async function processOpportunityAttacksForLeavingCombatant(movingCombatantId, reactorIds = []) {
    for (const reactorId of Array.isArray(reactorIds) ? reactorIds : []) {
      const mover = getRuntimeCombatant(movingCombatantId);
      const reactor = getRuntimeCombatant(reactorId);
      if (!mover || mover.isAlive === false) {
        return false;
      }
      if (!reactor || reactor.isAlive === false) {
        continue;
      }

      let result = { performed: false, targetAlive: mover.isAlive !== false };
      if (reactor.id === "player" || controllerForCombatantId(reactor.id) === "player") {
        const rid = String(reactor.id ?? "").trim();
        const trMap = gameStateRef.current?.turnResourcesByCombatantId ?? turnResourcesByCombatantId ?? {};
        const tr = normalizeTurnResourcesInput(trMap[rid]);
        if (!tr.reaction || !hasReaction(rid)) {
          addMessage(
            "ai",
            `⚔️ **${reactor.name ?? "Combattant"}** ne peut pas effectuer d'attaque d'opportunité contre **${mover.name}** (réaction indisponible).`,
            "enemy-turn",
            makeMsgId()
          );
          await yieldCombatUiSync();
          continue;
        }
        if (isLocalPlayerCombatantId(rid)) {
          result = await promptPlayerOpportunityAttack(reactor, mover);
        } else {
          result = await resolvePlayerOpportunityAttack(reactor, mover);
        }
      } else if (hasReaction(reactor.id)) {
        result = await resolveEnemyOpportunityAttack(reactor, mover);
      }

      await yieldCombatUiSync();

      const liveMover = getRuntimeCombatant(movingCombatantId);
      if (result.targetAlive === false || liveMover?.isAlive === false) {
        await maybeAutoEndLocalTurnWhenDowned();
        return false;
      }
    }
    // Important avec la mêlée transitive : rompre le contact en une seule opération.
    clearMeleeFor(movingCombatantId);
    return true;
  }

  const ENEMY_TACTICAL_STEP_MS = 800;

  /** Laisse React peindre puis pousse le snapshot multijoueur — évite un seul « bloc » à la fin des tours ennemis. */
  async function yieldCombatUiSync() {
    // Ne jamais bloquer la boucle combat sur requestAnimationFrame :
    // en onglet/fenêtre arrière-plan, rAF peut être extrêmement ralenti.
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve(null);
      };
      const hardTimeout = setTimeout(finish, 120);
      try {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearTimeout(hardTimeout);
            finish();
          })
        );
      } catch {
        clearTimeout(hardTimeout);
        finish();
      }
    });
    if (multiplayerSessionId) {
      try {
        // Les écritures Firestore peuvent prendre longtemps ; ne pas figer le tour ennemi.
        await Promise.race([
          flushMultiplayerSharedState(),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
      } catch {
        /* ignore */
      }
    }
  }

  async function pauseEnemyTacticalStep() {
    await new Promise((r) => setTimeout(r, ENEMY_TACTICAL_STEP_MS));
    await yieldCombatUiSync();
  }

  /**
   * Bloc mécanique lisible pour une attaque automatique résolue côté moteur.
   */
  function buildAutoAttackCombatDetail({
    attacker,
    target,
    chosenWeapon,
    labelSuffix,
    nat,
    atkBonus,
    atkTotal,
    targetAc,
    comparisonAc = null,
    acSuffix = "",
    dice,
    lastDmgRoll,
    lastDmgTotal,
    currentHp,
    maxHp,
    rollMeta = null,
  }) {
    const acVs = comparisonAc != null ? comparisonAc : targetAc;
    const advDisNote =
      rollMeta?.nat2 != null && rollMeta.mode && rollMeta.mode !== "normal"
        ? rollMeta.mode === "cancelled"
          ? ` (annulation : ${rollMeta.nat1}/${rollMeta.nat2}${rollMeta.advDisDetail ? ` — ${rollMeta.advDisDetail}` : ""})`
          : ` (${rollMeta.mode === "advantage" ? "avantage" : "désavantage"} : ${rollMeta.nat1}/${rollMeta.nat2}${
              rollMeta.advDisDetail ? ` — ${rollMeta.advDisDetail}` : ""
            })`
        : "";
    const lines = [`**${attacker.name}** · ${chosenWeapon.name}${labelSuffix || ""} → **${target.name}**`];
    if (nat === 1) {
      lines.push(`Jet d'attaque : **échec automatique** (naturel 1 — fumble)${advDisNote}.`);
      return lines.join("\n");
    }
    if (nat === 20) {
      lines.push(`Jet d'attaque : **coup critique** (naturel 20)${advDisNote}.`);
      lines.push(`Total au toucher : **${atkTotal}** (contre CA ${targetAc}).`);
      if (lastDmgTotal > 0 && lastDmgRoll?.crit) {
        lines.push(
          formatDmgRoll(
            dice,
            lastDmgRoll.rolls1,
            chosenWeapon.damageBonus ?? 0,
            true,
            lastDmgRoll.rolls2
          )
        );
        lines.push(`PV de ${target.name} après le coup : **${currentHp}** / ${maxHp}.`);
      }
      return lines.join("\n");
    }
    lines.push(
      `Jet d'attaque : ${nat} ${fmtMod(atkBonus)} = **${atkTotal}** vs CA **${acVs}**${acSuffix}${advDisNote} — ${
        atkTotal >= acVs ? "**touche**" : "**raté**"
      }.`
    );
    if (atkTotal >= acVs && lastDmgTotal > 0 && lastDmgRoll && !lastDmgRoll.crit) {
      lines.push(formatDmgRoll(dice, lastDmgRoll.rolls, chosenWeapon.damageBonus ?? 0));
      lines.push(`PV de ${target.name} après le coup : **${currentHp}** / ${maxHp}.`);
    }
    return lines.join("\n");
  }

  async function resolveCombatantWeaponAttack(
    attacker,
    target,
    chosenWeapon,
    labelSuffix,
    tactical,
    tacticalAction = null
  ) {
    if (!attacker || !target || !chosenWeapon) return false;

    const hpPreAttack = getCombatantCurrentHp(target);
    if (hpPreAttack != null && hpPreAttack <= 0) return false;

    let currentHp = getCombatantCurrentHp(target);
    const entPool = gameStateRef.current?.entities ?? entities ?? [];
    const { isMeleeAttack, isRangedAttack } = classifyAttackMeleeRanged(chosenWeapon, tacticalAction);
    const meleeIds = attacker?.id ? getMeleeWith(attacker.id) : [];
    let attackerRangedWeaponInMelee = false;
    if (isRangedAttack && attacker?.id) {
      attackerRangedWeaponInMelee = meleeIds.some((mid) =>
        isHostileOpponentInMelee(attacker.id, mid, entPool, controllerForCombatantId)
      );
    }
    const targetHasDodge = !!(target?.id && dodgeActiveByCombatantIdRef.current?.[target.id]);

    const hiddenArr = gameStateRef.current?.combatHiddenIds ?? combatHiddenIds ?? [];
    const hidden = new Set(hiddenArr);
    const attackerHidden = !!(attacker?.id && hidden.has(attacker.id));
    const targetHidden = !!(target?.id && hidden.has(target.id));
    const advRes = computeAttackRollAdvDis({
      attackerHidden,
      targetHidden,
      attackerConditions: normalizeCombatantConditions(attacker),
      targetConditions: normalizeCombatantConditions(target),
      isMeleeAttack,
      isRangedAttack,
      attackerRangedWeaponInMelee,
      targetHasDodgeActive: targetHasDodge,
    });
    const rollMeta = rollNatWithAdvDis(advRes.adv, advRes.dis);
    rollMeta.advDisDetail = advRes.label || "";
    const nat = rollMeta.nat;
    const atkBonus = chosenWeapon.attackBonus ?? 0;
    const atkTotal = nat + atkBonus;
    const dmgBonus = chosenWeapon.damageBonus ?? 0;
    const dice = chosenWeapon.damageDice ?? "1d4";
    const targetAc = getCombatantArmorClass(target);
    let lastDmgRoll = null;
    let lastDmgTotal = 0;
    let targetDamageResult = null;

    let narrativeOutcome = "miss";
    if (nat === 1) narrativeOutcome = "fumble";
    else if (atkTotal >= targetAc) {
      const autoCritOnUnconsciousTarget =
        target.id === "player" &&
        isPlayerUnconsciousNow() &&
        !isRangedWeaponName(chosenWeapon.name);
      narrativeOutcome = nat === 20 || autoCritOnUnconsciousTarget ? "critical_hit" : "hit";
    }

    let comparisonAc = targetAc;
    let acSuffix = "";
    const entsForCtrl = gameStateRef.current?.entities ?? entities ?? [];
    const targetCtrl = controllerForCombatantId(target?.id, entsForCtrl);
    const attackerCtrl = controllerForCombatantId(attacker?.id, entsForCtrl);
    const attackerIsHostileToPlayer =
      attackerCtrl !== "player" && (attacker?.type === "hostile" || attackerCtrl === "ai");

    if (
      narrativeOutcome === "hit" &&
      !tacticalAction?.skipShieldPrompt &&
      targetCtrl === "player" &&
      attackerIsHostileToPlayer &&
      isLocalPlayerCombatantId(target?.id)
    ) {
      const liveTarget = getRuntimeCombatant(target.id) ?? target;
      const canShield = defenderCanCastShieldReaction(liveTarget);
      if (canShield.ok) {
        await yieldCombatUiSync();
        const choice = await promptPlayerShieldReaction(
          liveTarget,
          attacker,
          chosenWeapon,
          atkTotal,
          targetAc
        );
        await yieldCombatUiSync();
        if (choice === "shield") {
          const canon =
            canShield.canon ??
            canonicalizeSpellNameAgainstCombatant(liveTarget, SHIELD_SPELL_NAME) ??
            SHIELD_SPELL_NAME;
          const compV = validateSpellCastingComponents(liveTarget, canon);
          const slotResult = spendSpellSlotForCombatant(liveTarget.id, SPELLS[canon]?.level ?? 1);
          if (compV.ok && slotResult.ok) {
            setReactionFor(liveTarget.id, false);
            const orderLen = Math.max(
              1,
              (gameStateRef.current?.combatOrder ?? combatOrder ?? []).length
            );
            const nextStates = upsertCombatTimedState(
              liveTarget.combatTimedStates,
              COMBAT_TIMED_STATE_IDS.BOUCLIER,
              orderLen
            );
            applyEntityUpdates([
              { id: liveTarget.id, action: "update", combatTimedStates: nextStates },
            ]);
            const oldTimedAc = getAcBonusFromCombatTimedStates(liveTarget.combatTimedStates);
            const newTimedAc = getAcBonusFromCombatTimedStates(nextStates);
            comparisonAc = targetAc - oldTimedAc + newTimedAc;
            acSuffix = " (Bouclier +5)";
            addMessage(
              "ai",
              `🛡️ **${liveTarget.name ?? "Vous"}** lance *Bouclier* en réaction (+5 CA, ${orderLen} pas d’initiative restants).`,
              "enemy-turn",
              makeMsgId()
            );
            if (atkTotal < comparisonAc) {
              narrativeOutcome = "miss";
            }
          } else {
            addMessage(
              "ai",
              `🛡️ *Bouclier* ne peut pas être lancé : ${
                !compV.ok ? compV.reason : "emplacement de sort indisponible."
              }`,
              "enemy-turn",
              makeMsgId()
            );
          }
        }
      }
    }

    if (narrativeOutcome === "critical_hit") {
      const r1 = rollDiceDetailed(dice);
      const r2 = rollDiceDetailed(dice);
      const dmg = Math.max(1, r1.total + r2.total + dmgBonus);
      lastDmgRoll = { crit: true, rolls1: r1.rolls, rolls2: r2.rolls };
      lastDmgTotal = dmg;
      targetDamageResult = applyDamageToCombatant(target, dmg, { critical: true });
      currentHp = targetDamageResult.hpAfter;
    } else if (narrativeOutcome === "hit") {
      const r = rollDiceDetailed(dice);
      const dmg = Math.max(1, r.total + dmgBonus);
      lastDmgRoll = { crit: false, rolls: r.rolls };
      lastDmgTotal = dmg;
      targetDamageResult = applyDamageToCombatant(target, dmg, { critical: false });
      currentHp = targetDamageResult.hpAfter;
    }

    const combatDetailBlock = buildAutoAttackCombatDetail({
      attacker,
      target,
      chosenWeapon,
      labelSuffix,
      nat,
      atkBonus,
      atkTotal,
      targetAc,
      comparisonAc,
      acSuffix,
      dice,
      lastDmgRoll,
      lastDmgTotal,
      currentHp,
      maxHp: target?.hp?.max ?? null,
      rollMeta,
    });

    let narrativeText = "";
    const targetIsPlayerControlled =
      controllerForCombatantId(target?.id, gameStateRef.current?.entities ?? entities) === "player";
    const attackKilledTarget =
      (typeof currentHp === "number" && currentHp <= 0) || targetDamageResult?.dead === true;

    // Créature / allié PNJ ciblé (pas le PJ) : narration IA comme pour le coup fatal au héros,
    // sinon seule la ligne courte + debug restent et l'auto-joueur se bloque sur la bulle debug.
    if (!targetIsPlayerControlled) {
      try {
        const res = await fetch("/api/chat-combat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: aiProvider,
            thoughtProcess: tactical?.thought_process ?? "",
            enemyName: attacker.name,
            targetName: target?.name ?? "la cible",
            targetsPlayer: false,
            narrationContext: {
              enemyName: attacker.name,
              weaponName: chosenWeapon.name,
              outcome: narrativeOutcome,
            },
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && typeof data?.narrative === "string" && data.narrative.trim()) {
          narrativeText = data.narrative.trim();
        }
      } catch (err) {
        markFlowFailure(`Narration combat (créature vs créature) indisponible: ${String(err?.message ?? err)}`, {
          kind: "creatureAttackNarration",
        });
      }
    }

    if (targetIsPlayerControlled && attackKilledTarget) {
      try {
        const res = await fetch("/api/chat-combat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: aiProvider,
            thoughtProcess: tactical?.thought_process ?? "",
            enemyName: attacker.name,
            targetName: target?.name ?? "le héros",
            narrationContext: {
              enemyName: attacker.name,
              weaponName: chosenWeapon.name,
              outcome: narrativeOutcome,
            },
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.details ?? data?.error ?? `chat-combat failed (${res.status})`);
        }
        if (res.ok && typeof data?.narrative === "string" && data.narrative.trim()) {
          narrativeText = data.narrative.trim();
        }
      } catch (err) {
        markFlowFailure(
          `Narration combat indisponible: ${String(err?.message ?? err)}`,
          { kind: "nextTurn" }
        );
        throw err;
      }
      if (!narrativeText) {
        markFlowFailure(
          "Narration combat vide: impossible de poursuivre proprement.",
          { kind: "nextTurn" }
        );
        throw new Error("Narration combat vide");
      }
    }

    if (narrativeText) {
      addMessage("ai", narrativeText, "enemy-turn", makeMsgId());
    } else {
      const shortOutcome =
        narrativeOutcome === "critical_hit"
          ? `critique sur ${target.name}`
          : narrativeOutcome === "hit"
            ? `touche ${target.name}`
            : narrativeOutcome === "fumble"
              ? "commet un fumble"
              : `manque ${target.name}`;
      addMessage("ai", `⚔️ ${attacker.name} ${shortOutcome} avec ${chosenWeapon.name}.`, "enemy-turn", makeMsgId());
    }
    addMessage("ai", combatDetailBlock, "combat-detail", makeMsgId());
    addMessage(
      "ai",
      `[DEBUG] Résolution attaque auto (moteur)\n` +
        safeJson({
          attackerId: attacker.id,
          attackerName: attacker.name,
          targetId: target.id,
          targetName: target.name,
          tacticalThought: tactical?.thought_process ?? "",
          tacticalAction,
          weaponUsed: {
            name: chosenWeapon.name,
            attackBonus: chosenWeapon.attackBonus,
            damageDice: chosenWeapon.damageDice,
            damageBonus: chosenWeapon.damageBonus,
          },
          nat,
          atkBonus,
          atkTotal,
          targetAc,
          comparisonAc,
          acSuffix,
          damageDice: dice,
          damageBonus: dmgBonus,
          damageRoll: lastDmgRoll,
          damageTotal: lastDmgTotal,
          hpAfter: currentHp,
          hideAttack: { attackerHidden, targetHidden, rollMeta },
        }),
      "debug",
      makeMsgId()
    );
    if (attackerHidden) {
      setCombatHiddenIds((prev) => prev.filter((id) => id !== attacker.id));
      setCombatStealthTotalForCombatant(attacker.id, null);
      if (multiplayerSessionId) {
        await new Promise((r) => setTimeout(r, 0));
        await flushMultiplayerSharedState();
      }
    }
    if (target.id === "player" && targetDamageResult?.dead === true) {
      return "player_dead";
    }
    return true;
  }

  async function resolveCombatantSpellAgainstTarget(
    attacker,
    target,
    spellName,
    labelSuffix,
    tactical,
    tacticalAction = null
  ) {
    const canonicalSpellName = canonicalizeSpellNameAgainstCombatant(attacker, spellName) ?? spellName;
    const spell = SPELLS?.[canonicalSpellName];
    if (!attacker || !target || !spell) return false;

    const compV = validateSpellCastingComponents(attacker, canonicalSpellName);
    if (!compV.ok) {
      addMessage(
        "ai",
        `⚔️ ${attacker.name} ne peut pas lancer ${canonicalSpellName} : ${compV.reason}`,
        "enemy-turn",
        makeMsgId()
      );
      return false;
    }

    const slotResult = spendSpellSlotForCombatant(attacker.id, spell.level ?? 0);
    if (!slotResult.ok) return false;

    if (spell.save) {
      const dc = computeSpellSaveDC(attacker);
      if (target.id === "player") {
        const incomingPlayerSaveRoll = stampPendingRollForActor(
          {
            kind: "save",
            stat: spell.save,
            totalBonus: computeCheckBonus({ player, stat: spell.save, skill: null }),
            raison: `Sauvegarde contre ${canonicalSpellName} (${attacker.name})`,
            dc,
            targetId: "player",
            weaponName: canonicalSpellName,
            engineContext: {
              kind: "incoming_spell_save",
              attackerId: attacker.id,
              attackerName: attacker.name,
              spellName: canonicalSpellName,
              damageNotation: String(spell.damage ?? "1d6"),
              damageType: spell.damageType ?? null,
              slotLevelUsed: slotResult.usedLevel,
              tacticalThought: tactical?.thought_process ?? "",
              tacticalAction,
            },
          },
          player,
          clientId
        );
        addMessage(
          "ai",
          `⚔️ ${attacker.name} lance ${canonicalSpellName}${labelSuffix || ""} sur ${target.name}.`,
          "enemy-turn",
          makeMsgId()
        );
        pendingRollRef.current = incomingPlayerSaveRoll;
        setPendingRoll(incomingPlayerSaveRoll);
        return true;
      }
      const nat = Math.floor(Math.random() * 20) + 1;
      const saveBonus = computeEntitySaveBonus(target, spell.save);
      const total = nat + saveBonus;
      const succeeded = nat === 20 ? true : nat === 1 ? false : total >= dc;
      const r = rollDiceDetailed(String(spell.damage ?? "1d6"));
      const baseDmg = Math.max(0, r.total);
      const finalDmg = succeeded ? Math.floor(baseDmg / 2) : baseDmg;
      const hpBefore = getCombatantCurrentHp(target);
      const damageResult =
        hpBefore == null || finalDmg <= 0 ? null : applyDamageToCombatant(target, finalDmg, { critical: false });
      const hpAfter = damageResult ? damageResult.hpAfter : hpBefore;

      addMessage(
        "ai",
        `⚔️ ${attacker.name} lance ${canonicalSpellName}${labelSuffix || ""} sur ${target.name}.`,
        "enemy-turn",
        makeMsgId()
      );
      addMessage(
        "ai",
        `Sauvegarde ${spell.save} : nat ${nat} ${fmtMod(saveBonus)} = **${total}** vs DD **${dc}** — ${
          succeeded ? "réussite" : "échec"
        }. ${finalDmg > 0 ? `${finalDmg} dégâts ${spell.damageType ?? ""}.` : "Aucun dégât."}`,
        "combat-detail",
        makeMsgId()
      );
      addMessage(
        "ai",
        `[DEBUG] Résolution sort auto (save)\n` +
          safeJson({
            attackerId: attacker.id,
            attackerName: attacker.name,
            targetId: target.id,
            targetName: target.name,
            spellName: canonicalSpellName,
            tacticalThought: tactical?.thought_process ?? "",
            tacticalAction,
            nat,
            saveBonus,
            total,
            dc,
            succeeded,
            damage: finalDmg,
            hpBefore,
            hpAfter,
            slotLevelUsed: slotResult.usedLevel,
          }),
        "debug",
        makeMsgId()
      );
      if (target.id === "player" && damageResult?.dead === true) {
        return "player_dead";
      }
      return true;
    }

    const spellWeapon = {
      name: canonicalSpellName,
      attackBonus: computeSpellAttackBonus(attacker),
      damageDice: String(spell.damage ?? "1d6"),
      damageBonus: 0,
      kind: /corps a corps|corps à corps/i.test(String(spell.attack ?? "")) ? "melee" : "ranged",
    };
    return resolveCombatantWeaponAttack(attacker, target, spellWeapon, labelSuffix, tactical, {
      ...(tacticalAction ?? {}),
      kind: "spell",
      name: canonicalSpellName,
    });
  }

  async function simulateSingleEnemyTurn(enemy, opts = null) {
    await new Promise((r) => setTimeout(r, 400));
    await yieldCombatUiSync();
    if (isPlayerDeadNow() || !hasLivingPlayerCombatant(gameStateRef.current?.entities ?? entities)) return;

    const label = opts?.label ? ` (${opts.label})` : "";
    const fallbackPlayerTarget = getRuntimeCombatant("player");
    const entsForMelee = gameStateRef.current?.entities ?? entities ?? [];
    const firstAlivePlayerCombatantIdFromOrder = () => {
      const order = gameStateRef.current?.combatOrder ?? combatOrder ?? [];
      for (const entry of order) {
        if (!entry?.id) continue;
        if (controllerForCombatantId(entry.id, entsForMelee) !== "player") continue;
        const c = getRuntimeCombatant(entry.id, entsForMelee);
        if (c && c.isAlive !== false) return entry.id;
      }
      return "player";
    };

    // Surpris: l'ennemi perd ce tour, puis l'état est consommé tout de suite (MP : deux clients
    // peuvent rejouer la boucle — sans clear ici, le 2ᵉ lit encore surprised=true et duplique tout).
    if (enemy?.surprised === true) {
      const eid = String(enemy?.id ?? "").trim() || "unknown";
      const surprisedMsgId = `enemy-surprised-freeze:${combatEngagementSeqRef.current}:${combatRoundInEngagementRef.current}:${eid}`;
      if (!messagesRef.current.some((m) => m && m.id === surprisedMsgId)) {
        addMessage(
          "ai",
          `${enemy.name} est surpris et reste figé un instant${label}.`,
          "enemy-turn",
          surprisedMsgId
        );
      }
      applyEntityUpdates([{ id: eid, action: "update", surprised: false }]);
      await yieldCombatUiSync();
      if (multiplayerSessionId) {
        // Flush seulement après propagation locale de l'update ; sinon on peut publier
        // un snapshot encore `surprised:true` et figer l'ennemi sur les tours suivants.
        await flushMultiplayerSharedState().catch(() => {});
      }
      setReactionFor(eid, true);
      return;
    }

    // Attaque d'opportunité (joueur quitte la mêlée) : pas d'appel tactique, une seule frappe
    if (opts?.label === "attaque d'opportunité") {
      const enemyWeapons = Array.isArray(enemy.weapons) ? enemy.weapons : [];
      const isRangedWeapon = (w) => w?.kind === "ranged" || isRangedWeaponName(w?.name ?? "");
      let chosenWeapon =
        enemyWeapons.find((w) => !isRangedWeapon(w)) ?? enemyWeapons[0] ?? null;
      if (chosenWeapon && fallbackPlayerTarget) {
        const result = await resolveCombatantWeaponAttack(
          enemy,
          fallbackPlayerTarget,
          chosenWeapon,
          label,
          null,
          { type: "action", name: chosenWeapon.name, target: "player" }
        );
        if (result === "player_dead" || !hasLivingPlayerCombatant(gameStateRef.current?.entities ?? entities)) return;
      }
      await yieldCombatUiSync();
      return;
    }

    // Ressources de tour : restaurées au changement d’index (effet dédié, une fois par tour).

    const markEnemyMovementSpent = () => {
      setTurnResourcesForCombatant(enemy.id, (prev) => ({
        ...normalizeTurnResourcesInput(prev),
        movement: false,
      }));
    };

    // Ressource déplacement (théâtre de l'esprit) : 1 seule utilisation par tour ennemi.
    let enemyMovementAvailable = true;

    const tactical = await generateEnemyTurn(enemy, {
      playerPosition: "frontline",
      distance: getMeleeWith(enemy.id).some((tid) => controllerForCombatantId(tid) === "player")
        ? "melee"
        : "unknown",
      roundContext: opts?.label ?? null,
      movementOk: enemyMovementAvailable,
      ...(typeof opts?.tacticianSlotIndex === "number" && Number.isFinite(opts.tacticianSlotIndex)
        ? { tacticianSlotIndex: Math.trunc(opts.tacticianSlotIndex) }
        : {}),
    });

    const actions = Array.isArray(tactical?.actions) ? tactical.actions : [];
    const typeOf = (a) => String(a?.type ?? "").toLowerCase();
    const nameOf = (a) => String(a?.name ?? "");
    const isDisengageName = (n) => /d[ée]sengag/i.test(n);
    const isFleeNameStr = (n) =>
      /(éloigner|fuir|retirer|partir|recule|enfuir)/i.test(n) && !isDisengageName(n);
    const isApproachNameStr = (n) => /approcher|avance|rapproch/i.test(n);
    const isHideName = (n) => /cacher|hide|se\s+cacher/i.test(n);

    const enemyWeapons = Array.isArray(enemy.weapons) ? enemy.weapons : [];
    const isRangedWeapon = (w) => w?.kind === "ranged" || isRangedWeaponName(w?.name ?? "");

    let hasDisengaged = false;
    /** Économie d'action D&D : un tour ennemi ne peut pas dépenser l'action ou la bonus action deux fois. */
    let spentEnemyAction = false;
    let spentEnemyBonus = false;
    /**
     * addMeleeMutual/clearMeleeFor passent par setState React : getMeleeWith() reste
     * périmé dans la même boucle synchrone. On suit donc la mêlée localement pour que
     * « S'approcher » puis « Cimeterre » dans un même plan tactique fonctionne.
     */
    let effectiveInMeleeWithPlayer = getMeleeWith(enemy.id).some(
      (tid) => controllerForCombatantId(tid, entsForMelee) === "player"
    );
    /** Miroir synchrone des ids au contact de cet ennemi (getMeleeWith peut être périmé dans la boucle). */
    let localMeleeNeighbors = new Set(getMeleeWith(enemy.id));

    const pickOffensiveOptionForAction = (act, targetCombatant) => {
      const spellName = canonicalizeSpellNameAgainstCombatant(enemy, act?.name ?? "");
      if (spellName && SPELLS?.[spellName]) {
        return { kind: "spell", spellName, canAttack: !!targetCombatant };
      }
      let chosenWeapon = null;
      if (act?.name) {
        const wanted = normalizeFr(String(act.name));
        chosenWeapon =
          enemyWeapons.find((w) => normalizeFr(String(w?.name ?? "")) === wanted) ?? null;
      }
      if (!chosenWeapon && enemyWeapons.length > 0) {
        chosenWeapon = enemyWeapons[0];
      }
      const targetIdStr = targetCombatant?.id != null ? String(targetCombatant.id).trim() : "";
      const inMeleeWithTarget = targetIdStr && localMeleeNeighbors.has(targetIdStr);
      if (chosenWeapon && effectiveInMeleeWithPlayer && isRangedWeapon(chosenWeapon)) {
        chosenWeapon = enemyWeapons.find((w) => !isRangedWeapon(w)) ?? chosenWeapon;
      }
      let canAttack = !!chosenWeapon && !!targetCombatant;
      if (chosenWeapon && !inMeleeWithTarget && !isRangedWeapon(chosenWeapon)) {
        canAttack = false;
      }
      return { kind: "weapon", chosenWeapon, canAttack };
    };

    const enemyStillAlive = () => {
      const e = getRuntimeCombatant(enemy.id, gameStateRef.current?.entities ?? entsForMelee);
      return !!(e && e.isAlive !== false);
    };

    for (const act of actions) {
      const t = typeOf(act);
      const n = nameOf(act);
      if (!enemyStillAlive()) break;

      if ((t === "bonus_action" || t === "action") && isDisengageName(n)) {
        if (t === "bonus_action") {
          if (spentEnemyBonus) {
            await pauseEnemyTacticalStep();
            continue;
          }
          spentEnemyBonus = true;
        } else {
          if (spentEnemyAction) {
            await pauseEnemyTacticalStep();
            continue;
          }
          spentEnemyAction = true;
        }
        hasDisengaged = true;
        addMessage("ai", `⚔️ ${enemy.name} se désengage.`, "enemy-turn", makeMsgId());
        await pauseEnemyTacticalStep();
        continue;
      }

      if ((t === "bonus_action" || t === "action") && isHideName(n) && !isDisengageName(n)) {
        if (t === "bonus_action") {
          if (spentEnemyBonus) {
            await pauseEnemyTacticalStep();
            continue;
          }
          spentEnemyBonus = true;
        } else {
          if (spentEnemyAction) {
            await pauseEnemyTacticalStep();
            continue;
          }
          spentEnemyAction = true;
        }
        await performCombatHideRoll({
          combatantId: enemy.id,
          combatant: enemy,
          label: String(n || "Se cacher").trim() || "Se cacher",
        });
        if (!enemyStillAlive()) break;
        await pauseEnemyTacticalStep();
        continue;
      }

      if (t === "movement" && isApproachNameStr(n)) {
        if (!enemyMovementAvailable) {
          await pauseEnemyTacticalStep();
          continue;
        }
        const resolveApproachTargetIdFromAct = () => {
          const raw = typeof act?.targetId === "string" ? act.targetId.trim() : "";
          if (raw) {
            if (controllerForCombatantId(raw, entsForMelee) !== "player") {
              return firstAlivePlayerCombatantIdFromOrder();
            }
            const c = getRuntimeCombatant(raw, entsForMelee);
            if (c && c.isAlive !== false) return raw;
          }
          return firstAlivePlayerCombatantIdFromOrder();
        };
        const approachTargetId = resolveApproachTargetIdFromAct();
        const hiddenArrApproach = gameStateRef.current?.combatHiddenIds ?? combatHiddenIds ?? [];
        const hiddenSetApproach = new Set(
          (Array.isArray(hiddenArrApproach) ? hiddenArrApproach : [])
            .map((x) => String(x ?? "").trim())
            .filter(Boolean)
        );
        const approachTargetRt = getRuntimeCombatant(approachTargetId, entsForMelee);
        const cannotCloseOnHidden =
          hiddenSetApproach.has(approachTargetId) || approachTargetRt?.hidden === true;
        enemyMovementAvailable = false;
        markEnemyMovementSpent();

        const approachDisplayName = resolveCombatantDisplayName(
          { id: approachTargetId, name: approachTargetRt?.name },
          entsForMelee,
          player?.name ?? null
        );

        if (localMeleeNeighbors.has(approachTargetId)) {
          addMessage(
            "ai",
            `⚔️ ${enemy.name} reste au contact de ${approachDisplayName}.`,
            "enemy-turn",
            makeMsgId()
          );
          await pauseEnemyTacticalStep();
          continue;
        }

        if (cannotCloseOnHidden) {
          addMessage(
            "ai",
            `⚔️ ${enemy.name} ne parvient pas à engager au corps à corps : la cible n'est pas localisée (cachée / camouflée).`,
            "enemy-turn",
            makeMsgId()
          );
          emitMeleeGraphDebugChat({
            label: "ennemi mouvement (échec rapprochement — cible non localisée)",
            moverId: enemy.id,
            moverName: enemy.name,
            meleeStateSim: cloneMeleeStateShallow(meleeState),
            getMeleeWith,
            entities: entsForMelee,
            combatOrder: gameStateRef.current?.combatOrder ?? combatOrder,
            localCombatantIdForNames: localCombatantId,
            localPlayerDisplayName: player?.name ?? null,
            addMessage,
            makeMsgId,
          });
          await pauseEnemyTacticalStep();
          continue;
        }

        const prevPartners = [...localMeleeNeighbors];

        if (prevPartners.length === 0) {
          clearMeleeFor(enemy.id);
          addMeleeMutual(enemy.id, approachTargetId);
          localMeleeNeighbors = new Set([approachTargetId]);
          effectiveInMeleeWithPlayer =
            controllerForCombatantId(approachTargetId, entsForMelee) === "player";
          addMessage(
            "ai",
            `⚔️ ${enemy.name} se rapproche au corps à corps.`,
            "enemy-turn",
            makeMsgId()
          );
          const simEn = cloneMeleeStateShallow(meleeState);
          linkMeleePairInCopy(simEn, enemy.id, approachTargetId);
          emitMeleeGraphDebugChat({
            label: "ennemi rapprochement au contact",
            moverId: enemy.id,
            moverName: enemy.name,
            meleeStateSim: simEn,
            getMeleeWith,
            entities: entsForMelee,
            combatOrder: gameStateRef.current?.combatOrder ?? combatOrder,
            localCombatantIdForNames: localCombatantId,
            localPlayerDisplayName: player?.name ?? null,
            addMessage,
            makeMsgId,
          });
        } else {
          if (!hasDisengaged) {
            const moverSurvived = await processOpportunityAttacksForLeavingCombatant(
              enemy.id,
              prevPartners
            );
            if (!moverSurvived || !hasLivingPlayerCombatant(gameStateRef.current?.entities ?? entities)) {
              return;
            }
          } else {
            clearMeleeFor(enemy.id);
          }
          localMeleeNeighbors.clear();
          addMeleeMutual(enemy.id, approachTargetId);
          localMeleeNeighbors.add(approachTargetId);
          effectiveInMeleeWithPlayer =
            controllerForCombatantId(approachTargetId, entsForMelee) === "player";
          addMessage(
            "ai",
            `⚔️ ${enemy.name} se rapproche de ${approachDisplayName} au corps à corps.`,
            "enemy-turn",
            makeMsgId()
          );
          const simSw = cloneMeleeStateShallow(meleeState);
          linkMeleePairInCopy(simSw, enemy.id, approachTargetId);
          emitMeleeGraphDebugChat({
            label: "ennemi changement de cible au contact",
            moverId: enemy.id,
            moverName: enemy.name,
            meleeStateSim: simSw,
            getMeleeWith,
            entities: entsForMelee,
            combatOrder: gameStateRef.current?.combatOrder ?? combatOrder,
            localCombatantIdForNames: localCombatantId,
            localPlayerDisplayName: player?.name ?? null,
            addMessage,
            makeMsgId,
          });
        }
        await pauseEnemyTacticalStep();
        continue;
      }

      if (
        t === "action" &&
        !isDisengageName(n) &&
        !isFleeNameStr(n) &&
        !isApproachNameStr(n)
      ) {
        if (spentEnemyAction) {
          // Une seule action par tour (attaque ou sort offensif principal).
          continue;
        }
        const actTargetId = typeof act?.targetId === "string" ? act.targetId : null;
        const targetCombatant = actTargetId ? getRuntimeCombatant(actTargetId) : fallbackPlayerTarget;
        if (!targetCombatant || targetCombatant.isAlive === false) continue;

        const picked = pickOffensiveOptionForAction(act, targetCombatant);
        let ok = false;
        if (picked?.kind === "spell" && picked.spellName && targetCombatant) {
          ok = await resolveCombatantSpellAgainstTarget(
            enemy,
            targetCombatant,
            picked.spellName,
            label,
            tactical,
            act
          );
        } else if (picked?.canAttack && picked?.chosenWeapon && targetCombatant) {
          ok = await resolveCombatantWeaponAttack(
            enemy,
            targetCombatant,
            picked.chosenWeapon,
            label,
            tactical,
            act
          );
        }
        if (ok === "player_dead" || !hasLivingPlayerCombatant(gameStateRef.current?.entities ?? entities)) return;
        if (ok) spentEnemyAction = true;
        if (!enemyStillAlive()) break;
        await pauseEnemyTacticalStep();
        continue;
      }

      if (t === "movement" && isFleeNameStr(n)) {
        if (!enemyMovementAvailable) {
          await pauseEnemyTacticalStep();
          continue;
        }
        enemyMovementAvailable = false;
        markEnemyMovementSpent();
        const engagedReactors = getMeleeWith(enemy.id).filter((id) => {
          const combatant = getRuntimeCombatant(id);
          return combatant && combatant.isAlive !== false;
        });
        const inMelee = engagedReactors.length > 0;
        if (inMelee && !hasDisengaged) {
          const moverSurvived = await processOpportunityAttacksForLeavingCombatant(enemy.id, engagedReactors);
          await pauseEnemyTacticalStep();
          if (!moverSurvived || !hasLivingPlayerCombatant(gameStateRef.current?.entities ?? entities)) return;
        } else if (inMelee && hasDisengaged) {
          clearMeleeFor(enemy.id);
        }
        effectiveInMeleeWithPlayer = getMeleeWith(enemy.id).some(
          (tid) => controllerForCombatantId(tid, entsForMelee) === "player"
        );
        localMeleeNeighbors = new Set(getMeleeWith(enemy.id));
        if (inMelee) {
          const fleeMsg =
            hasDisengaged || engagedReactors.length > 0
              ? `⚔️ ${enemy.name} s'éloigne du corps à corps.`
              : `⚔️ ${enemy.name} s'éloigne du corps à corps sans être inquiété.`;
          addMessage("ai", fleeMsg, "enemy-turn", makeMsgId());
        } else {
          addMessage(
            "ai",
            `⚔️ ${enemy.name} s'éloigne (hors de portée de mêlée).`,
            "enemy-turn",
            makeMsgId()
          );
        }
        {
          const orderDbg = gameStateRef.current?.combatOrder ?? combatOrder;
          const entsDbg = gameStateRef.current?.entities ?? entities;
          setTimeout(() => {
            emitMeleeGraphDebugChat({
              label: "ennemi retrait / éloignement",
              moverId: enemy.id,
              moverName: enemy.name,
              getMeleeWith,
              entities: entsDbg,
              combatOrder: orderDbg,
              localCombatantIdForNames: localCombatantId,
              localPlayerDisplayName: player?.name ?? null,
              addMessage,
              makeMsgId,
            });
          }, 0);
        }
        await pauseEnemyTacticalStep();
        continue;
      }
    }

    // Si l'ennemi se désengage sans expliciter un mouvement de fuite,
    // on applique un pas de retrait implicite pour refléter l'intention tactique.
    if (enemyStillAlive() && hasDisengaged && effectiveInMeleeWithPlayer && enemyMovementAvailable) {
      enemyMovementAvailable = false;
      markEnemyMovementSpent();
      const engagedReactors = getMeleeWith(enemy.id).filter((id) => {
        const combatant = getRuntimeCombatant(id);
        return combatant && combatant.isAlive !== false;
      });
      if (engagedReactors.length > 0) clearMeleeFor(enemy.id);
      effectiveInMeleeWithPlayer = false;
      localMeleeNeighbors.clear();
      addMessage(
        "ai",
        `⚔️ ${enemy.name} se retire prudemment après s'être désengagé.`,
        "enemy-turn",
        makeMsgId()
      );
      {
        const orderDbg = gameStateRef.current?.combatOrder ?? combatOrder;
        const entsDbg = gameStateRef.current?.entities ?? entities;
        setTimeout(() => {
          emitMeleeGraphDebugChat({
            label: "ennemi retrait après désengagement",
            moverId: enemy.id,
            moverName: enemy.name,
            getMeleeWith,
            entities: entsDbg,
            combatOrder: orderDbg,
            localCombatantIdForNames: localCombatantId,
            localPlayerDisplayName: player?.name ?? null,
            addMessage,
            makeMsgId,
          });
        }, 0);
      }
      await pauseEnemyTacticalStep();
    }

    if (enemyWeapons.length === 0 && getCombatantKnownSpells(enemy).length === 0) {
      addMessage(
        "ai",
        `[DEBUG] Tour ennemi : aucune arme ou sort structuré pour ${enemy.name} (pas d'attaque résolue).`,
        "debug",
        makeMsgId()
      );
    }

    if (enemyStillAlive() && !spentEnemyAction && !hasDisengaged) {
      const inMelee = effectiveInMeleeWithPlayer;
      const fleeInPlan = actions.some((a) => typeOf(a) === "movement" && isFleeNameStr(nameOf(a)));
      const fbFromMelee =
        localMeleeNeighbors.size > 0 ? getRuntimeCombatant([...localMeleeNeighbors][0], entsForMelee) : null;
      if (inMelee && enemyWeapons.length > 0 && !fleeInPlan && fbFromMelee && fbFromMelee.isAlive !== false) {
        let chosenWeapon = enemyWeapons[0];
        if (isRangedWeapon(chosenWeapon)) {
          chosenWeapon = enemyWeapons.find((w) => !isRangedWeapon(w)) ?? chosenWeapon;
        }
        const canAttack = !(!inMelee && !isRangedWeapon(chosenWeapon));
        if (canAttack && chosenWeapon) {
          const result = await resolveCombatantWeaponAttack(
            enemy,
            fbFromMelee,
            chosenWeapon,
            label,
            tactical,
            { type: "action", name: chosenWeapon.name, target: "player", fallback: true }
          );
          if (result === "player_dead" || !hasLivingPlayerCombatant(gameStateRef.current?.entities ?? entities)) return;
          if (result) spentEnemyAction = true;
        }
      }
    }
  }

  function speedFtFromPlayerSpeed(speed) {
    const m = String(speed ?? "").match(/(\d+)/);
    return m ? Number(m[1]) : 30;
  }

  const MOVE_AWAY_PATTERNS =
    /(je\s+m['â€™]?éloigne|m['â€™]?éloigne|je\s+recule|recule|je\s+fuis|fuis|je\s+pars|pars|je\s+cours|cours|je\s+me\s+retire|me\s+retire|je\s+m['â€™]?en\s+vais|m['â€™]?en\s+vais|je\s+sors|je\s+quitte)/i;

  function isHostileReadyForCombat(entity) {
    return !!entity && entity.type === "hostile" && entity.isAlive && entity.awareOfPlayer !== false;
  }

  function hasAnyHostileAlive(currentEntities) {
    return currentEntities.some((e) => e.type === "hostile" && e.isAlive);
  }

  function hasAnyCombatReadyHostile(currentEntities) {
    return currentEntities.some((e) => isHostileReadyForCombat(e));
  }

  function markSceneHostilesAware(baseEntities, updates = [], options = {}) {
    const visibleOnly = options.visibleOnly !== false;
    const onlyIds = Array.isArray(options.onlyIds)
      ? new Set(options.onlyIds.map((id) => String(id ?? "").trim()).filter(Boolean))
      : null;
    const nextUpdates = Array.isArray(updates) ? [...updates] : [];
    const pendingById = new Map();
    for (const upd of nextUpdates) {
      if (!upd || typeof upd !== "object") continue;
      const id = typeof upd.id === "string" ? upd.id.trim() : "";
      if (!id) continue;
      pendingById.set(id, upd);
    }
    for (const ent of Array.isArray(baseEntities) ? baseEntities : []) {
      if (!isHostileReadyForCombat({ ...ent, awareOfPlayer: true })) continue;
      if (visibleOnly && ent.visible === false) continue;
      if (onlyIds && !onlyIds.has(ent.id)) continue;
      const existing = pendingById.get(ent.id);
      if (existing && existing.action === "update") {
        existing.awareOfPlayer = true;
        continue;
      }
      nextUpdates.push({ id: ent.id, action: "update", awareOfPlayer: true });
    }
    return nextUpdates;
  }

  function dexModFromStats(stats) {
    const dex = stats?.DEX;
    if (typeof dex !== "number") return 0;
    return Math.floor((dex - 10) / 2);
  }

  /**
   * Un combatOrder renvoyé par le MJ doit référencer chaque entité vivante contrôlée par un joueur.
   * Sinon (ex. seulement des hostiles), on ignore l'ordre : l'initiative est résolue par le moteur
   * (bouton + sync multijoueur), pas par le JSON du narrateur.
   */
  function combatOrderIncludesAllPlayerControlledCombatants(order, entities) {
    if (!Array.isArray(order) || order.length === 0) return false;
    const playerEnts = (entities ?? []).filter(
      (e) => e && e.isAlive !== false && e.controller === "player"
    );
    if (playerEnts.length === 0) return true;
    const orderIds = new Set(order.map((o) => o?.id).filter(Boolean));
    for (const ent of playerEnts) {
      if (orderIds.has(ent.id)) continue;
      if (playerEnts.length === 1 && orderIds.has("player")) continue;
      return false;
    }
    return true;
  }

  function ensureCombatState(currentEntities, maybeOrder = null, options = null) {
    const liveMode = gameStateRef.current?.gameMode ?? gameMode;
    const anyCombatReadyHostile = hasAnyCombatReadyHostile(currentEntities);
    if (!anyCombatReadyHostile) {
      const entLen = Array.isArray(currentEntities) ? currentEntities.length : 0;
      const orderLen =
        (Array.isArray(gameStateRef.current?.combatOrder) ? gameStateRef.current.combatOrder.length : 0) ||
        (combatOrder?.length ?? 0);
      // Après un jet joueur → arbitre (porte, obstacle…), la salle peut avoir entities=[] sans que le
      // combat soit terminé : ne pas traiter "aucune entité" comme "plus aucun hostile" et effacer l'initiative.
      const skipEmptyRoomCleanup =
        options?.skipEmptyRoomCombatCleanup === true &&
        entLen === 0 &&
        orderLen > 0 &&
        liveMode === "combat";
      if (skipEmptyRoomCleanup) {
        return;
      }
      if (liveMode === "combat") {
        addMessage("ai", "[DEBUG] Fin de combat (plus aucun hostile engagé) â†’ exploration", "debug", makeMsgId());
      }
      setGameMode("exploration", currentEntities, { force: true });
      setCombatOrder([]);
      commitCombatTurnIndex(0);
      setCombatHiddenIds([]);
      clearCombatStealthTotals();
      return;
    }

    // Hostiles conscients du joueur (ou déjà engagés) â†’ combat
    if (liveMode !== "combat") {
      if (!anyCombatReadyHostile) return;
      addMessage("ai", "[DEBUG] Hostiles engagés â†’ passage en COMBAT", "debug", makeMsgId());
      setGameMode("combat");
      // En entrant en combat, on active Bonus/Réaction (disponibles par défaut),
      // sans "rendre" une Action déjÃ  dépensée ce tour (ex: attaque qui déclenche le combat).
      setHasDisengagedThisTurn(false);
      setTurnResourcesForCombatant(localCombatantId, (prev) => ({
        action: normalizeTurnResourcesInput(prev).action,
        bonus: true,
        reaction: true,
        movement: true,
      }));
    }

    // Pas d'ordre dans la réponse MJ : GameContext prépare les jets PNJ + bouton « Lancer l'initiative »
  }

  function isCombatOver(currentEntities) {
    return !currentEntities.some((e) => isHostileReadyForCombat(e));
  }

  function nextAliveTurnIndex(order, idx, currentEntities) {
    if (!order?.length) return 0;
    let i = idx;
    for (let step = 0; step < order.length; step++) {
      i = (i + 1) % order.length;
      const entry = order[i];
      if (!entry) continue;
      if (!isCombatantAliveForTurnOrder(entry.id, currentEntities)) continue;
      return i;
    }
    return 0;
  }

  /**
   * Après une mort / compaction de l'ordre, l'ancien index peut désormais pointer vers
   * un autre combattant. On ré-ancre donc l'avance sur l'id du combattant qui vient
   * réellement d'agir, puis on cherche le prochain vivant depuis ce slot mis à jour.
   */
  function nextAliveTurnIndexFromActor(order, fallbackIdx, actorId, currentEntities) {
    if (!order?.length) return 0;
    const actorKey = String(actorId ?? "").trim();
    const actorIdx =
      actorKey
        ? order.findIndex((entry) => String(entry?.id ?? "").trim() === actorKey)
        : -1;
    const anchorIdx =
      actorIdx >= 0
        ? actorIdx
        : Math.min(Math.max(0, Number(fallbackIdx) || 0), order.length - 1);
    return nextAliveTurnIndex(order, anchorIdx, currentEntities);
  }

  const enemyTurnLoopInProgressRef = useRef(false);

  /**
   * Multijoueur : slot d’un autre client à 0 PV (stabilisé / mort pour le tour) ou déconnecté à 0 PV.
   * Programme un seul `nextTurn` partagé avec le client propriétaire via `scheduleStableCombatTurnAdvance`.
   */
  function tryScheduleRemoteMpDownPlayerTurnAdvance(entry, idx) {
    if (!multiplayerSessionId) return false;
    const id = String(entry?.id ?? "").trim();
    if (!id.startsWith("mp-player-") || isLocalPlayerCombatantId(id)) return false;
    const cid = id.slice("mp-player-".length);
    const prof = multiplayerParticipantProfiles.find(
      (p) => String(p?.clientId ?? "").trim() === cid
    );
    if (!prof) return false;
    const hpFromProf =
      typeof prof.hpCurrent === "number" && Number.isFinite(prof.hpCurrent) ? prof.hpCurrent : null;
    const hpSnap = prof.playerSnapshot?.hp?.current;
    const hpFromSnap =
      typeof hpSnap === "number" && Number.isFinite(hpSnap) ? hpSnap : null;
    const hp = hpFromProf !== null ? hpFromProf : hpFromSnap !== null ? hpFromSnap : null;
    if (hp === null || hp > 0) return false;

    const snap = prof.playerSnapshot && typeof prof.playerSnapshot === "object" ? prof.playerSnapshot : null;
    const ds = snap
      ? getPlayerDeathStateSnapshot(snap)
      : { dead: false, stable: false, unconscious: true };
    const disconnected = prof.connected === false;
    const canAuto = disconnected || ds.stable === true || ds.dead === true;
    if (!canAuto) return false;

    const skipKey = `${combatEngagementSeqRef.current}:${combatRoundInEngagementRef.current}:${idx}:${id}`;
    if (disconnected) {
      const offId = `mp-turn-skip-offline-${skipKey.replace(/:/g, "-")}`;
      if (!messagesRef.current.some((m) => m && m.id === offId)) {
        addMessage(
          "ai",
          `**${entry.name ?? id}** est hors ligne à 0 PV — passage de tour (synchronisation).`,
          "turn-end",
          offId
        );
        addMessage("ai", "", "turn-divider", makeMsgId());
      }
      scheduleStableCombatTurnAdvance(skipKey, () => nextTurn());
      return true;
    }

    scheduleStableCombatTurnAdvance(skipKey, () => nextTurn());
    return true;
  }

  /**
   * Solo : autre entité `controller: player` dans l’initiative (ex. 2ᵉ PJ) à 0 PV stabilisé ou mort côté entité.
   */
  function tryScheduleSoloAllyDownPlayerTurnAdvance(entry, idx, entPool) {
    if (multiplayerSessionId) return false;
    const id = String(entry?.id ?? "").trim();
    if (!id || isLocalPlayerCombatantId(id)) return false;
    const orderNow = gameStateRef.current?.combatOrder ?? combatOrder;
    const ent = resolveCombatOrderEntity(entry, entPool, orderNow);
    if (!ent || combatantControllerValue(ent) !== "player") return false;
    const hp = ent.hp?.current;
    if (typeof hp !== "number" || hp > 0) return false;
    const rawDs = ent.deathState && typeof ent.deathState === "object" ? ent.deathState : {};
    const stable = rawDs.stable === true;
    const dead = rawDs.dead === true;
    if (!stable && !dead) return false;
    const skipKey = `${combatEngagementSeqRef.current}:${combatRoundInEngagementRef.current}:${idx}:${id}`;
    const msgId = `solo-turn-skip-down-${skipKey.replace(/:/g, "-")}`;
    if (!messagesRef.current.some((m) => m && m.id === msgId)) {
      addMessage(
        "ai",
        `**${ent.name ?? id}** est **inconscient(e)**${
          stable ? " et **stabilisé(e)**" : ""
        } à 0 PV — aucune action, **passage de tour**.`,
        "turn-end",
        msgId
      );
      addMessage("ai", "", "turn-divider", makeMsgId());
    }
    scheduleStableCombatTurnAdvance(skipKey, () => nextTurn());
    return true;
  }

  /**
   * @param {object} [options]
   * @param {Array<{ id: string, name?: string, initiative?: number }>} [options.order] — ordre explicite (ex. juste après commit initiative, avant re-render React)
   * @param {number} [options.startIndex] — index de départ dans order (défaut : combatTurnIndex)
   * @param {boolean} [options.skipInitialAdvance] — true : le combattant à startIndex agit en premier (début de round / post-initiative). false : on avance d'abord comme après « Fin de tour ».
   */
  async function runEnemyTurnsUntilPlayer(options = {}) {
    const forceEntry = options.__forceEntry === true;
    if (!forceEntry && enemyTurnLoopInProgressRef.current) return;
    enemyTurnLoopInProgressRef.current = true;
    let sessionLockId = null;
    let enemyLoopOwnsMjThinking = false;
    /** Si false, on garde `enemyTurnLoopInProgressRef` à true (retry MP planifié sans relâcher la boucle). */
    let releaseEnemyLoopInFinally = true;
    try {
    let order = options.order ?? combatOrder;
    let idx =
      options.startIndex !== undefined && options.startIndex !== null
        ? options.startIndex
        : combatTurnIndexLiveRef.current;
    const skipInitialAdvance = options.skipInitialAdvance === true;

    // Exécute les tours ennemis selon l'ordre d'initiative jusqu'au tour du joueur.
    // Ne fait agir que les entités hostiles (type "hostile").
    let currentEntities = gameStateRef.current?.entities ?? entities;

    if (!hasLivingPlayerCombatant(currentEntities)) {
      return;
    }

    // Si combat terminé, sortir
    if (isCombatOver(currentEntities)) {
      setGameMode("exploration", currentEntities, { force: true });
      setCombatOrder([]);
      commitCombatTurnIndex(0);
      return;
    }

    if (!order?.length) return;

    // Sécurité : si aucun PJ vivant n'est dans l'ordre, on met le combat en pause
    // et on évite une boucle "ennemi→ennemi..." sans point d'arrêt joueur.
    if (
      !hasAnyLivingPlayerCombatantInInitiativeOrder(order) ||
      !hasAnyControllablePlayerCombatantInInitiativeOrder(order)
    ) {
      flowBlockedRef.current = true;
      setFlowBlocked(true);
      addMessage(
        "ai",
        "⚔️ Combat en PAUSE (aucun tour joueur valide dans l'ordre d'initiative).",
        "meta",
        makeMsgId()
      );
      return;
    }

    // Après « Fin de tour » : avancer au prochain vivant. Post-initiative / début de round : commencer sur startIndex.
    // IMPORTANT MP : ne pas commit l'index avant d'avoir le lock session, sinon ce client peut
    // incrémenter localement combatTurnWriteSeq puis perdre le lock ; les snapshots autoritaires
    // distants deviennent "stale" (writeSeq local > remote) et l'initiative se désynchronise.
    if (!skipInitialAdvance) {
      idx = nextAliveTurnIndex(order, idx, currentEntities);
      if (!multiplayerSessionId) {
        commitCombatTurnIndex(idx);
      }
    }

    // Multijoueur : une seule instance doit exécuter la boucle ennemis,
    // sinon deux clients peuvent déclencher deux fois /api/enemy-tactics.
    if (multiplayerSessionId) {
      sessionLockId = await acquireSessionLockOrReport("enemy-turn-loop");
      if (!sessionLockId) {
        const attempt =
          typeof options.__enemyLockAttempt === "number" && Number.isFinite(options.__enemyLockAttempt)
            ? options.__enemyLockAttempt
            : 0;
        if (attempt < 14) {
          releaseEnemyLoopInFinally = false;
          const delayMs = 320 + Math.min(attempt * 90, 1200);
          setTimeout(() => {
            void runEnemyTurnsUntilPlayerRef.current({
              ...options,
              __enemyLockAttempt: attempt + 1,
              startIndex: combatTurnIndexLiveRef.current,
              skipInitialAdvance: true,
              __forceEntry: true,
            });
          }, delayMs);
        }
        return;
      }
      // Ne jamais bloquer la boucle ennemie sur une écriture Firestore "thinkingState".
      // La fonction met déjà l'UI locale à jour immédiatement.
      enemyLoopOwnsMjThinking = true;
      void setMultiplayerThinkingState({
        active: true,
        actor: "gm",
        label: "Le MJ réfléchit…",
      });
      // Maintenant que ce client possède le lock, l'index local peut être commité sans créer
      // de divergence de writeSeq avec le snapshot partagé.
      if (!skipInitialAdvance) {
        commitCombatTurnIndex(idx);
      }
    }

    order = gameStateRef.current?.combatOrder ?? order;
    currentEntities = gameStateRef.current?.entities ?? entities;
    {
      const len = Array.isArray(order) ? order.length : 0;
      if (len <= 0) return;
      idx = Math.min(Math.max(0, idx), len - 1);
    }

    // Tant que ce n'est pas au joueur, faire agir le combattant courant et avancer
    for (let guard = 0; guard < 50; guard++) {
      currentEntities = gameStateRef.current?.entities ?? entities;
      if (!hasLivingPlayerCombatant(currentEntities)) {
        return;
      }
      order = gameStateRef.current?.combatOrder ?? order;
      const entry = order[idx];
      if (!entry) break;

      if (controllerForCombatantId(entry.id, currentEntities) === "player") {
        commitCombatTurnIndex(idx);
        // Tour d'un autre PJ (MP ou 2ᵉ fiche solo) : à 0 PV stabilisé, avancer une seule fois (évite initiative figée / double tour PNJ).
        if (!isLocalPlayerCombatantId(entry.id)) {
          if (tryScheduleRemoteMpDownPlayerTurnAdvance(entry, idx)) {
            return;
          }
          if (tryScheduleSoloAllyDownPlayerTurnAdvance(entry, idx, currentEntities)) {
            return;
          }
          return;
        }
        setHasDisengagedThisTurn(false);
        setSneakAttackArmed(false);
        setSneakAttackUsedThisTurn(false);
        const arbiterAtPlayerTurnStart = await runCombatTurnStartArbiter({
          actorId: "player",
          actorName: player?.name ?? "Vous",
          actorType: "player",
        });
        if (arbiterAtPlayerTurnStart?.awaitingPlayerRoll === true) {
          return;
        }
        if (await preparePlayerTurnStartState()) {
          return;
        }
        const livePlayerAtTurnStart = gameStateRef.current?.player ?? player;
        if (livePlayerAtTurnStart?.surprised === true) {
          lockPlayerTurnResourcesForSurprise();
          addMessage(
            "ai",
            `${player?.name ?? "Vous"} êtes surpris et perdez ce tour.`,
            "turn-end",
            makeMsgId()
          );
          addMessage("ai", "", "turn-divider", makeMsgId());
          // D&D 5e : la surprise ne dure qu'un tour — fin de ce segment = plus surpris.
          updatePlayer({ surprised: false });
          idx = nextAliveTurnIndexFromActor(order, idx, entry.id, currentEntities);
          commitCombatTurnIndex(idx);
          continue;
        }
        grantPlayerTurnResources();
        return;
      }

      const ent = resolveCombatOrderEntity(entry, currentEntities, order);
      if (ent && ent.isAlive && ent.type === "hostile") {
        // Synchroniser immédiatement le tour actif sur le combattant IA courant.
        // Sans cela, la boucle peut repartir depuis l'ancien index (souvent celui du joueur)
        // et faire rejouer le même ennemi en boucle.
        commitCombatTurnIndex(idx);
        const arbiterAtEnemyTurnStart = await runCombatTurnStartArbiter({
          actorId: ent.id,
          actorName: ent.name,
          actorType: ent.type ?? null,
        });
        if (arbiterAtEnemyTurnStart?.awaitingPlayerRoll === true) {
          return;
        }
        await yieldCombatUiSync();
        currentEntities = gameStateRef.current?.entities ?? entities;
        order = gameStateRef.current?.combatOrder ?? order;
        const liveEnemy = resolveCombatOrderEntity(entry, currentEntities, order);
        if (!liveEnemy || !liveEnemy.isAlive || liveEnemy.type !== "hostile") {
          // Ne pas `continue` sans avancer : sinon même index rejoué + journal « fin de tour » en boucle.
          idx = nextAliveTurnIndexFromActor(order, idx, entry.id, currentEntities);
          commitCombatTurnIndex(idx);
          continue;
        }
        const enemyStartsSurprised = liveEnemy.surprised === true;
        setReactionFor(liveEnemy.id, !enemyStartsSurprised);
        // Garde anti-rejeu robuste en multijoueur :
        // l'index peut changer (snapshot/ordre compacté) sans que le tour ennemi ait réellement avancé.
        // On verrouille donc par engagement + manche + id ennemi (pas par index).
        const turnWriteSeqForProcessed =
          typeof gameStateRef.current?.combatTurnWriteSeq === "number" &&
          Number.isFinite(gameStateRef.current.combatTurnWriteSeq)
            ? Math.trunc(gameStateRef.current.combatTurnWriteSeq)
            : Math.trunc(combatTurnWriteSeq ?? 0);
        const turnKey = `${combatEngagementSeqRef.current}:${combatRoundInEngagementRef.current}:${turnWriteSeqForProcessed}:${liveEnemy.id}`;
        if (processedEnemyTurnKeysRef.current.has(turnKey)) {
          // Snapshot stale / redéclenchement : ce tour a déjà été résolu, ne pas rejouer.
          if (debugMode) {
            const dbgId = `debug-processed-enemy-skip:${turnKey.replace(/:/g, "-")}`;
            if (!messagesRef.current.some((m) => m && m.id === dbgId)) {
              addMessage(
                "ai",
                `[DEBUG] Tour PNJ déjà enregistré (clé ${turnKey}) — avance d’initiative sans rejouer le tacticien.`,
                "debug",
                dbgId
              );
            }
          }
          // MP/resync : même si le tour a déjà été traité ailleurs, on doit garder un journal
          // local cohérent (sinon le PNJ "saute" sans trace visible côté client observateur).
          const endEid = String(entry?.id ?? liveEnemy?.id ?? "").trim() || "unknown";
          const turnEndMsgId = `npc-turn-end:${combatEngagementSeqRef.current}:${combatRoundInEngagementRef.current}:${turnWriteSeqForProcessed}:${endEid}`;
          const turnEndDivId = `npc-turn-end-div:${combatEngagementSeqRef.current}:${combatRoundInEngagementRef.current}:${turnWriteSeqForProcessed}:${endEid}`;
          if (!messagesRef.current.some((m) => m && m.id === turnEndMsgId)) {
            addMessage("ai", `**${liveEnemy.name}** met fin à son tour.`, "turn-end", turnEndMsgId);
          }
          if (!messagesRef.current.some((m) => m && m.id === turnEndDivId)) {
            addMessage("ai", "", "turn-divider", turnEndDivId);
          }
          currentEntities = gameStateRef.current?.entities ?? entities;
          order = gameStateRef.current?.combatOrder ?? order;
          idx = nextAliveTurnIndexFromActor(order, idx, liveEnemy.id, currentEntities);
          commitCombatTurnIndex(idx);
          continue;
        }
        // Si `simulateSingleEnemyTurn` lève (ex. tacticien indisponible), aucune clé « traité » :
        // le retry ou le prochain kickoff peut rejouer le slot complet (arbitre + tactique).
        await simulateSingleEnemyTurn(liveEnemy, { tacticianSlotIndex: idx });
        await yieldCombatUiSync();
        currentEntities = gameStateRef.current?.entities ?? entities;
        if (!hasLivingPlayerCombatant(currentEntities)) {
          return;
        }
        const arbiterAtEnemyTurnEnd = await runCombatTurnEndArbiter({
          actorId: liveEnemy.id,
          actorName: liveEnemy.name,
          actorType: liveEnemy.type ?? null,
        });
        if (arbiterAtEnemyTurnEnd?.awaitingPlayerRoll === true) {
          // Rare : fin de tour PNJ bloquée sur un jet — pas de clé « traité » pour permettre une reprise propre.
          return;
        }
        processedEnemyTurnKeysRef.current.add(turnKey);
        // Surprise consommée dans `simulateSingleEnemyTurn` (branche surpris) — ne pas dupliquer ici.
      }
      currentEntities = gameStateRef.current?.entities ?? entities;
      order = gameStateRef.current?.combatOrder ?? order;
      let entForTurnEnd = resolveCombatOrderEntity(entry, currentEntities, order);
      // Filet de sécurité surprise :
      // si le tour ennemi a été court-circuité (anti-rejeu / resync), on doit quand même
      // consommer l'état "surpris" et afficher le message associé une seule fois.
      if (
        entForTurnEnd &&
        String(entForTurnEnd.type ?? "").toLowerCase() === "hostile" &&
        entForTurnEnd.isAlive === true &&
        entForTurnEnd.surprised === true
      ) {
        const endEid = String(entry?.id ?? entForTurnEnd?.id ?? "").trim() || "unknown";
        const surprisedMsgId = `enemy-surprised-freeze:${combatEngagementSeqRef.current}:${combatRoundInEngagementRef.current}:${endEid}`;
        if (!messagesRef.current.some((m) => m && m.id === surprisedMsgId)) {
          addMessage(
            "ai",
            `${entForTurnEnd.name} est surpris et reste figé un instant.`,
            "enemy-turn",
            surprisedMsgId
          );
        }
        applyEntityUpdates([{ id: endEid, action: "update", surprised: false }]);
        await yieldCombatUiSync();
        if (multiplayerSessionId) {
          // Même contrainte ici : on flush après propagation locale pour ne pas repousser
          // un `surprised:true` périmé dans l'état partagé.
          await flushMultiplayerSharedState().catch(() => {});
        }
        setReactionFor(endEid, true);
        currentEntities = gameStateRef.current?.entities ?? entities;
        order = gameStateRef.current?.combatOrder ?? order;
        entForTurnEnd = resolveCombatOrderEntity(entry, currentEntities, order);
      }
      const turnWriteSeqForTurnEnd =
        typeof gameStateRef.current?.combatTurnWriteSeq === "number" &&
        Number.isFinite(gameStateRef.current.combatTurnWriteSeq)
          ? Math.trunc(gameStateRef.current.combatTurnWriteSeq)
          : Math.trunc(combatTurnWriteSeq ?? 0);
      let postedNpcTurnEnd = false;
      const endHostileHp =
        entForTurnEnd &&
        String(entForTurnEnd.type ?? "").toLowerCase() === "hostile" &&
        entForTurnEnd.hp &&
        typeof entForTurnEnd.hp.current === "number" &&
        Number.isFinite(entForTurnEnd.hp.current)
          ? entForTurnEnd.hp.current
          : null;
      const npcTurnEndNarrationOk =
        entForTurnEnd &&
        controllerForCombatantId(entry.id, currentEntities) !== "player" &&
        (entForTurnEnd.isAlive === true ||
          (endHostileHp != null && endHostileHp > 0));
      if (npcTurnEndNarrationOk) {
        const endEid = String(entry?.id ?? entForTurnEnd?.id ?? "").trim() || "unknown";
        const turnEndMsgId = `npc-turn-end:${combatEngagementSeqRef.current}:${combatRoundInEngagementRef.current}:${turnWriteSeqForTurnEnd}:${endEid}`;
        const turnEndDivId = `npc-turn-end-div:${combatEngagementSeqRef.current}:${combatRoundInEngagementRef.current}:${turnWriteSeqForTurnEnd}:${endEid}`;
        if (!messagesRef.current.some((m) => m && m.id === turnEndMsgId)) {
          addMessage("ai", `**${entForTurnEnd.name}** met fin à son tour.`, "turn-end", turnEndMsgId);
        }
        if (!messagesRef.current.some((m) => m && m.id === turnEndDivId)) {
          addMessage("ai", "", "turn-divider", turnEndDivId);
        }
        postedNpcTurnEnd = true;
      }

      // Avancer depuis l'index **de cette itération**, pas depuis combatTurnIndexLiveRef :
      // pendant les awaits (tactique, Firestore), la ref peut être réécrite par un snapshot
      // et faire rejouer le même combattant ou désynchroniser l'initiative affichée.
      idx = nextAliveTurnIndexFromActor(order, idx, entry.id, currentEntities);
      commitCombatTurnIndex(idx);

      // MP : pousser tout de suite attaque + fin de tour PNJ avant `runCombatTurnStartArbiter` du
      // prochain slot (Gemini peut prendre des minutes) — sinon l'autre client reste bloqué sur un
      // snapshot partiel et le debounce hôte peut écrire sans la bulle « met fin à son tour ».
      if (multiplayerSessionId && postedNpcTurnEnd) {
        try {
          await flushMultiplayerSharedState();
        } catch {
          /* ignore */
        }
      }

      // combat over ?
      if (isCombatOver(currentEntities)) {
        setGameMode("exploration", currentEntities, { force: true });
        setCombatOrder([]);
        commitCombatTurnIndex(0);
        return;
      }
    }

    // Ne pas remettre l'index à 0 ici : en fin de boucle normale l'index a déjà été avancé
    // (sinon on écrase le tour du PJ / du prochain combattant).
    } finally {
      if (enemyLoopOwnsMjThinking) {
        void setMultiplayerThinkingState({
          active: false,
          actor: null,
          label: null,
        });
      }
      if (releaseEnemyLoopInFinally) {
        enemyTurnLoopInProgressRef.current = false;
      }
      // IMPORTANT MP : cette boucle ennemie ajoute des messages via `addMessage(...)`
      // et applique des updates. Si on ne flush pas, un snapshot distant peut arriver
      // sans inclure ces nouveaux messages, et ils disparaissent "instantanément"
      // sur l'autre client (ou même sur le client qui agit).
      if (releaseEnemyLoopInFinally && multiplayerSessionId) {
        try {
          await flushMultiplayerSharedState();
        } catch {
          /* ignore */
        }
      }
    if (sessionLockId) {
      try {
        await releaseMultiplayerProcessingLock(sessionLockId);
      } catch {
        /* ignore */
      }
    }
    // L'effet death_save sort tant que `enemyTurnLoopInProgressRef` est true ; si les PV passent à 0
    // pendant la boucle, le prompt + pendingRoll peuvent ne jamais être posés. Rattrapage unique
    // après libération de la boucle (et après flush MP le cas échéant).
    if (releaseEnemyLoopInFinally) {
      queueMicrotask(() => {
        try {
          if ((gameStateRef.current?.gameMode ?? gameMode) !== "combat") return;
          if (awaitingPlayerInitiativeRef.current) return;
          if (isGameOverRef.current) return;
          if (enemyTurnLoopInProgressRef.current) return;
          if (!isPlayerTurnNow()) return;
          const liveP = gameStateRef.current?.player ?? null;
          const hp = playerHpRef.current ?? liveP?.hp?.current ?? 0;
          if (hp > 0) return;
          const ds = getPlayerDeathStateSnapshot(liveP ?? undefined);
          if (ds.dead || ds.stable) return;
          if (pendingRollRef.current?.kind === "death_save") return;
          void preparePlayerTurnStartState();
        } catch {
          /* ignore */
        }
      });
    }
    }
  }

  const runEnemyTurnsUntilPlayerRef = useRef(() => Promise.resolve());
  runEnemyTurnsUntilPlayerRef.current = runEnemyTurnsUntilPlayer;

  const handleCommitInitiativeRef = useRef(() => {});
  /** Évite plusieurs acquire lock / plusieurs bulles « session occupée » en même temps. */
  const initiativeCommitInFlightRef = useRef(false);
  const lastInitiativeLockBusyToastAtRef = useRef(0);

  async function handleCommitInitiative(silent = false) {
    // Garde anti-race : tant qu'on attend une vraie narration GM
    // (embuscade/entrée en combat), on ne déclenche pas le jet d'initiative côté UI.
    if (waitForGmNarrationForInitiativeLiveRef.current) {
      if (!silent) {
        addMessage(
          "ai",
          "Attendez la fin de la narration du MJ sur cette scène de combat avant de lancer l'initiative.",
          "meta",
          makeMsgId()
        );
      }
      return;
    }
    // Si aucun jet d'initiative n'est réellement requis, ne pas tenter de lock Firestore.
    if (!awaitingPlayerInitiativeRef.current) return;
    if (useManualInitiativeRollInputRef.current) {
      const raw = String(manualInitiativeNatInputRef.current ?? "").trim();
      const n = raw ? Number(raw) : NaN;
      if (!Number.isFinite(n) || n < 1 || n > 20) {
        if (!silent) {
          addMessage(
            "ai",
            "Indiquez le résultat de votre d20 pour l'initiative (entre 1 et 20) — mode « Mes dés ».",
            "intent-error",
            makeMsgId()
          );
        }
        return;
      }
    }
    // Garde-fou : si le combat est déjà initialisé, on ne doit pas re-finaliser
    // une nouvelle initiative (sinon on obtient plusieurs "Le combat commence !").
    const combatLen =
      (Array.isArray(gameStateRef.current?.combatOrder) ? gameStateRef.current.combatOrder.length : 0) ??
      0;
    if (combatLen > 0) return;

    if (initiativeCommitInFlightRef.current) return;
    initiativeCommitInFlightRef.current = true;
    try {
      const sessionLockId = await acquireSessionLockOrReport(
        "initiative",
        silent ? null : "Un autre joueur est déjà en train de résoudre une action de session."
      );
      if (!sessionLockId) {
        const ordAfterFail =
          (Array.isArray(gameStateRef.current?.combatOrder)
            ? gameStateRef.current.combatOrder.length
            : 0) ?? 0;
        if (ordAfterFail > 0) return;
        if (!silent) {
          const now = Date.now();
          if (now - lastInitiativeLockBusyToastAtRef.current < 4500) return;
          lastInitiativeLockBusyToastAtRef.current = now;
          addMessage(
            "ai",
            "L'initiative ne peut pas être enregistrée tout de suite (session occupée ou synchronisation en attente). Réessayez dans un instant.",
            multiplayerSessionId ? "meta" : "intent-error",
            makeMsgId()
          );
        }
        return;
      }
      setInitiativeSubmittedLocal(true);
      try {
        const hadManualInitiative = useManualInitiativeRollInputRef.current;
        const initiativeOpts = hadManualInitiative
          ? {
              manualNat: Math.trunc(
                Number(String(manualInitiativeNatInputRef.current ?? "").trim())
              ),
            }
          : undefined;
        const merged = commitPlayerInitiativeRoll(initiativeOpts);
        if (hadManualInitiative) {
          setUseManualInitiativeRollInput(false);
          setManualInitiativeNatInput("");
        }
        // Ne flusher qu'en attente d'autres jets : si l'ordre est déjà fusionné,
        // un flush ici pousse combatOrder + awaiting false sans les cartes chat
        // (initiative-order-*), et l'effet de finalisation distante ne s'exécute pas.
        if (multiplayerSessionId && !merged?.length) {
          await flushMultiplayerSharedState();
        }
    if (!merged?.length) {
      // Jet pas encore final car on attend les autres participants,
      // mais ton jet à déjà été stocké côté état partagé.
      // MP UX : éviter une bulle locale volatile ("flicker") qui peut disparaître
      // au snapshot suivant. Le feedback est déjà visible via le placeholder input.
      if (!multiplayerSessionId) {
        addMessage(
          "ai",
          "🎲 Initiative enregistrée. En attente des autres joueurs…",
          "meta",
          makeMsgId()
        );
      }
      return;
    }

    const initiativeMsgId = `initiative-order-${merged
      .map((e) => `${e.id}:${e.initiative}`)
      .sort()
      .join("|")}`;
    const rankLabel = (i) => (i === 0 ? "1er" : `${i + 1}e`);
    const participantNameEntities = Array.isArray(multiplayerParticipantProfiles)
      ? multiplayerParticipantProfiles
          .map((profile) => {
            const cid = String(profile?.clientId ?? "").trim();
            const pname = String(profile?.playerSnapshot?.name ?? profile?.name ?? "").trim();
            if (!cid || !pname) return null;
            return { id: `mp-player-${cid}`, name: pname };
          })
          .filter(Boolean)
      : [];
    const nameResolutionEntities = [...(Array.isArray(entities) ? entities : []), ...participantNameEntities];
    const orderText = merged
      .map(
        (entry, idx) =>
          `[${rankLabel(idx)}] ${resolveCombatantDisplayName(
            entry,
            nameResolutionEntities,
            player?.name
          )} (${entry.initiative})`
      )
      .join("\n");
    addMessage(
      "ai",
      `🎲 **Jet d'Initiative**\n\n${orderText}\n\n⚔️ Le combat commence !`,
      "dice",
      initiativeMsgId
    );
    // Le flush MP plus haut part avant ces bulles : sans second flush, les autres
    // clients reçoivent l'ordre de combat mais pas la carte « Jet d'Initiative »
    // (leur effet de finalisation distant ne s'exécute pas si awaitingPlayerInitiative
    // est déjà false au moment du snapshot).
    if (multiplayerSessionId) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushMultiplayerSharedState();
    }

    // PAUSE si aucun PJ vivant n'existe dans l'ordre.
    // (Sinon la boucle ennemi peut tourner sans jamais atteindre un tour joueur valide.)
    if (
      !hasAnyLivingPlayerCombatantInInitiativeOrder(merged) ||
      !hasAnyControllablePlayerCombatantInInitiativeOrder(merged)
    ) {
      flowBlockedRef.current = true;
      setFlowBlocked(true);
      addMessage(
        "ai",
        "⚔️ Combat en PAUSE : aucun personnage joueur vivant dans l'ordre d'initiative.",
        "meta",
        makeMsgId()
      );
      setInitiativeSubmittedLocal(false);
      return;
    }

    const playerStartsSurprised = player?.surprised === true;
    if (playerStartsSurprised) {
      setReactionFor(localCombatantId, false);
    }
    for (const entry of merged) {
      if (!entry?.id || entry.id === "player") continue;
      const combatant = entities.find((entity) => entity.id === entry.id);
      if (combatant?.surprised === true) {
        setReactionFor(entry.id, false);
      }
    }
    const first = merged[0];
    /** PJ local surpris en tête d'ordre : après ce segment, reprendre depuis ce slot (ennemis / autre PJ). */
    let postInitiativeSurprisedLocalHeadKickoffIdx = null;
    if (controllerForCombatantId(first?.id) === "player") {
      if (!isLocalPlayerCombatantId(first.id)) {
        return;
      }
      setHasDisengagedThisTurn(false);
      setSneakAttackArmed(false);
      setSneakAttackUsedThisTurn(false);
      // Ne pas utiliser setIsTyping ici : runCombatTurnStartArbiter est un hook mécanique
      // (surprise, CA, etc.) sans narration MJ — l’API peut être longue (ex. Gemini) et
      // bloquait handleSend / submitMultiplayerCommand en MP via isEngineResolvingNow.
      const arbiterAtPlayerTurnStart = await runCombatTurnStartArbiter({
        actorId: "player",
        actorName: player?.name ?? "Vous",
        actorType: "player",
      });
      if (arbiterAtPlayerTurnStart?.awaitingPlayerRoll === true) {
        return;
      }
      if (await preparePlayerTurnStartState()) {
        return;
      }
      const livePlayerAtTurnStart = gameStateRef.current?.player ?? player;
      if (livePlayerAtTurnStart?.surprised === true) {
        lockPlayerTurnResourcesForSurprise();
        addMessage(
          "ai",
          `${player?.name ?? "Vous"} êtes surpris et perdez ce tour.`,
          "turn-end",
          makeMsgId()
        );
        addMessage("ai", "", "turn-divider", makeMsgId());
        updatePlayer({ surprised: false });
        const entsSnap = gameStateRef.current?.entities ?? entities;
        postInitiativeSurprisedLocalHeadKickoffIdx = nextAliveTurnIndexFromActor(
          merged,
          0,
          first.id,
          entsSnap
        );
        commitCombatTurnIndex(postInitiativeSurprisedLocalHeadKickoffIdx);
      } else {
        grantPlayerTurnResources();
      }
    }
    if (postInitiativeSurprisedLocalHeadKickoffIdx != null) {
      setIsTyping(true);
      queueMicrotask(() => {
        runEnemyTurnsUntilPlayerRef
          .current({
            order: merged,
            startIndex: postInitiativeSurprisedLocalHeadKickoffIdx,
            skipInitialAdvance: true,
          })
          .catch(() => {})
          .finally(() => setIsTyping(false));
      });
    }
    if (first && controllerForCombatantId(first.id) !== "player") {
      setIsTyping(true);
      queueMicrotask(() => {
        runEnemyTurnsUntilPlayerRef
          .current({
            order: merged,
            startIndex: 0,
            skipInitialAdvance: true,
          })
          .catch(() => {})
          .finally(() => setIsTyping(false));
      });
    }
    } finally {
      await releaseMultiplayerProcessingLock(sessionLockId);
    }
    } finally {
      initiativeCommitInFlightRef.current = false;
    }
  }

  handleCommitInitiativeRef.current = handleCommitInitiative;

  useEffect(() => {
    const len = combatOrder?.length ?? 0;
    syncCombatEngagementSeqFromCombatOrderLen(len);
  }, [combatOrder]);

  const lastAiTurnKickoffKeyRef = useRef(null);
  /** Retries si le microtask voyait encore apiProcessing / pendingRoll : sans ça, poser lastKickoff avant le run figeait le combat. */
  const combatAiKickoffRetryTimerRef = useRef(null);

  function clearCombatAiKickoffRetryTimer() {
    if (combatAiKickoffRetryTimerRef.current != null) {
      clearTimeout(combatAiKickoffRetryTimerRef.current);
      combatAiKickoffRetryTimerRef.current = null;
    }
  }

  /**
   * Lance la boucle `runEnemyTurnsUntilPlayer` quand l’initiative pointe vers un hostile.
   * La clé `lastAiTurnKickoffKeyRef` n’est posée qu’au moment du run (pas avant le microtask).
   */
  function tryKickoffCombatAiTurn(reason = "effect", retryAttempt = 0) {
    const live = gameStateRef.current;
    const entPool = live?.entities ?? entities;
    if ((live?.gameMode ?? gameMode) !== "combat") {
      clearCombatAiKickoffRetryTimer();
      return;
    }
    if (flowBlockedRef.current) return;
    if (isGameOverRef.current) return;
    if (awaitingPlayerInitiativeRef.current) return;
    if (waitForGmNarrationForInitiativeLiveRef.current) return;
    if (sceneEnteredPipelineDepthRef.current > 0) return;

    const liveOrder = Array.isArray(live?.combatOrder) ? live.combatOrder : combatOrder;
    if (!liveOrder?.length) return;
    if (!hasLivingPlayerCombatant(entPool)) return;

    const turnIdxKick = Math.min(Math.max(0, combatTurnIndexLiveRef.current), liveOrder.length - 1);
    const activeEntry = liveOrder[turnIdxKick];
    if (!activeEntry) return;

    // Ne PAS inclure combatTurnWriteSeq ici : chaque bump de séquence recréait une « nouvelle » clé
    // pour le même slot (ex. gobelin surpris puis rejoué avec tacticien complet au kickoff suivant).
    const kickoffKey = `${combatEngagementSeqRef.current}:${combatRoundInEngagementRef.current}:${turnIdxKick}:${String(activeEntry.id ?? "").trim()}`;

    if (enemyTurnLoopInProgressRef.current) return;

    if (lastAiTurnKickoffKeyRef.current === kickoffKey) return;

    if (controllerForCombatantId(activeEntry.id, entPool) !== "ai") return;

    if (apiProcessingDepthRef.current > 0 || pendingRollRef.current) {
      if (retryAttempt < 28) {
        clearCombatAiKickoffRetryTimer();
        combatAiKickoffRetryTimerRef.current = setTimeout(() => {
          combatAiKickoffRetryTimerRef.current = null;
          tryKickoffCombatAiTurn(`${reason}-retry`, retryAttempt + 1);
        }, 220);
      }
      return;
    }

    clearCombatAiKickoffRetryTimer();
    lastAiTurnKickoffKeyRef.current = kickoffKey;
    setIsTyping(true);
    runEnemyTurnsUntilPlayerRef
      .current({
        order: liveOrder,
        startIndex: turnIdxKick,
        skipInitialAdvance: true,
      })
      .catch(() => {})
      .finally(() => setIsTyping(false));
  }

  function debugUnstickCombatTurnFlow() {
    clearCombatAiKickoffRetryTimer();
    lastAiTurnKickoffKeyRef.current = null;
    enemyTurnLoopInProgressRef.current = false;
    addMessage(
      "ai",
      "[DEBUG] Combat : verrous kickoff PNJ + boucle ennemis levés — nouvelle tentative automatique.",
      "debug",
      makeMsgId()
    );
    queueMicrotask(() => tryKickoffCombatAiTurn("debug-unstick", 0));
  }

  /** Debug : débloque verrous session (solo + MP), typing, jet en attente, file d’appels API — si le moteur reste coincé. */
  async function debugUnstickPlayerSession() {
    try {
      await debugForceUnblockProcessingPipeline();
    } catch {
      /* ignore */
    }
    skipRemotePendingRollApplyRef.current = false;
    try {
      setPendingRoll(null);
      pendingRollRef.current = null;
    } catch {
      /* ignore */
    }
    try {
      setMovementGate(null);
    } catch {
      /* ignore */
    }
    setWaitForGmNarrationForInitiative(false);
    waitForGmNarrationForInitiativeLiveRef.current = false;
    setFlowBlocked(false);
    setFailedRequestPayload(null);
    setError(null);
    setIsTyping(false);
    setIsAutoPlayerThinking(false);
    setIsRetryingFailedRequest(false);
    setRetryCountdown(0);
    flowBlockedRef.current = false;
    failedRequestPayloadRef.current = null;
    apiProcessingDepthRef.current = 0;
    sceneEnteredPipelineDepthRef.current = 0;
    rollResolutionInProgressRef.current = false;
    autoTurnInProgressRef.current = false;
    processingRemoteCommandIdRef.current = null;
    autoAwaitingServerResolutionRef.current = false;
    enemyTurnLoopInProgressRef.current = false;
    clearCombatAiKickoffRetryTimer();
    lastAiTurnKickoffKeyRef.current = null;
    naturalCallInFlightKeysRef.current.clear();
    mpPendingCmdResolutionIdsRef.current.clear();
    // Sortie de secours : si l'UI est restée en "combat" sans ordre, sans jet attendu
    // et sans résolution active, l'input reste bloqué sur !isMyTurn alors qu'aucun acteur
    // n'est réellement en train d'agir. On rend donc explicitement la main au joueur.
    if (
      (gameStateRef.current?.gameMode ?? gameMode) === "combat" &&
      ((gameStateRef.current?.combatOrder ?? combatOrder)?.length ?? 0) === 0 &&
      !pendingRollRef.current &&
      !awaitingPlayerInitiative &&
      !waitForGmNarrationForInitiativeLiveRef.current
    ) {
      try {
        setCombatOrder([]);
        setCombatTurnIndex(0);
        setCombatHiddenIds([]);
        clearCombatStealthTotals();
        setGameMode("exploration", gameStateRef.current?.entities ?? entities, { force: true });
      } catch {
        /* ignore */
      }
    }
    addMessage(
      "ai",
      "[DEBUG] Session débloquée : verrous processing, indicateur MJ, jet en attente et file API réinitialisés. Si le combat était fantôme sans ordre d'initiative, retour forcé en exploration. Réessaie ton action.",
      "debug",
      makeMsgId()
    );
    if (multiplayerSessionId) {
      queueMicrotask(() => {
        void flushMultiplayerSharedState().catch(() => {});
      });
    }
  }

  async function debugForceEnemyTurnNow() {
    clearCombatAiKickoffRetryTimer();
    lastAiTurnKickoffKeyRef.current = null;
    enemyTurnLoopInProgressRef.current = false;
    addMessage("ai", "[DEBUG] Combat : exécution forcée du tour PNJ (même slot d’initiative).", "debug", makeMsgId());
    try {
      setIsTyping(true);
      await runEnemyTurnsUntilPlayerRef.current({
        order: gameStateRef.current?.combatOrder ?? combatOrder,
        startIndex: combatTurnIndexLiveRef.current,
        skipInitialAdvance: true,
        __forceEntry: true,
      });
    } finally {
      setIsTyping(false);
    }
    if (multiplayerSessionId) {
      try {
        await flushMultiplayerSharedState();
      } catch {
        /* ignore */
      }
    }
  }

  function debugSkipCombatTurnSlot() {
    const order = gameStateRef.current?.combatOrder ?? combatOrder;
    if (!Array.isArray(order) || order.length === 0) return;
    const idx = clampedCombatTurnIndex();
    const entry = order[idx];
    if (!entry?.id) return;
    const entPool = gameStateRef.current?.entities ?? entities;
    const nextIdx = nextAliveTurnIndexFromActor(order, idx, entry.id, entPool);
    clearCombatAiKickoffRetryTimer();
    lastAiTurnKickoffKeyRef.current = null;
    enemyTurnLoopInProgressRef.current = false;
    commitCombatTurnIndex(nextIdx);
    const nextName = order[nextIdx]?.name ?? order[nextIdx]?.id ?? "?";
    addMessage(
      "ai",
      `[DEBUG] Combat : initiative avancée au slot **${nextIdx}** (${nextName}).`,
      "debug",
      makeMsgId()
    );
    if (multiplayerSessionId) {
      void flushMultiplayerSharedState().catch(() => {});
    }
    queueMicrotask(() => tryKickoffCombatAiTurn("debug-skip-slot", 0));
  }

  useEffect(() => {
    if (gameMode !== "combat") {
      lastAiTurnKickoffKeyRef.current = null;
      clearCombatAiKickoffRetryTimer();
      return;
    }
    if (flowBlockedRef.current) return;
    // Ne pas bloquer sur `isTyping` ici : après un callApi MJ, l’indicateur peut rester un court instant
    // alors que `apiProcessingDepth` est déjà 0 — le tour PNJ ne démarrait jamais (combat figé).
    if (enemyTurnLoopInProgressRef.current) return;
    if (isGameOverRef.current) return;
    if (awaitingPlayerInitiative) return;
    if (waitForGmNarrationForInitiative) return;
    if (sceneEnteredPipelineDepthRef.current > 0) return;
    if (!Array.isArray(combatOrder) || combatOrder.length === 0) return;
    if (!hasLivingPlayerCombatant(gameStateRef.current?.entities ?? entities)) return;

    const turnIdxKick = clampedCombatTurnIndex();
    const activeEntry = combatOrder[turnIdxKick];
    if (!activeEntry) return;

    const activeController = controllerForCombatantId(activeEntry.id);
    if (activeController !== "ai") {
      // Ne pas effacer lastAiTurnKickoffKeyRef : un snapshot Firestore peut réappliquer un
      // vieux combatTurnIndex (souvent 0) et relancer la boucle ennemie pour le même gobelin
      // alors que le journal affiche déjà « met fin à son tour ».
      return;
    }

    queueMicrotask(() => tryKickoffCombatAiTurn("effect", 0));
  }, [
    gameMode,
    combatOrder,
    combatTurnIndex,
    awaitingPlayerInitiative,
    waitForGmNarrationForInitiative,
    pendingRoll,
  ]);

  // Auto-joueur : dès que le brouillon d'initiative PNJ est prêt, lancer le d20 joueur (évite la course setTimeout vs useEffect)
  // Réservé au couple auto-joueur + auto-roll : sinon le joueur lance l'initiative à la main (ou « Mes dés »).
  useEffect(() => {
    if (!autoPlayerEnabled) return;
    if (!autoRollEnabled) return;
    if (useManualInitiativeRollInput) return;
    if (isPlayerDeadNow()) return;
    if (gameMode !== "combat") return;
    if ((combatOrder?.length ?? 0) > 0) return;
    if (!awaitingPlayerInitiative) return;
    if (!npcInitiativeDraft?.length) return;
    if (pendingRoll) return;
    if (waitForGmNarrationForInitiative) return;
    // Évite d’enchaîner initiative / arbitre pendant qu’un parse-intent ou callApi MJ est encore en cours
    // (sinon verrous session + isTyping mélangés avec l’ouverture de combat depuis l’exploration).
    if (apiProcessingDepthRef.current > 0) return;

    queueMicrotask(() => {
      if (!autoPlayerEnabledRef.current) return;
      if (!autoRollEnabledRef.current) return;
      if (useManualInitiativeRollInputRef.current) return;
      if (apiProcessingDepthRef.current > 0) return;
      handleCommitInitiativeRef.current(true);
    });
  }, [
    autoPlayerEnabled,
    autoRollEnabled,
    useManualInitiativeRollInput,
    gameMode,
    combatOrder,
    awaitingPlayerInitiative,
    npcInitiativeDraft,
    pendingRoll,
    isGameOver,
    player?.hp?.current,
    waitForGmNarrationForInitiative,
  ]);

  useEffect(() => {
    registerCombatNextTurn(async () => {
      await runEnemyTurnsUntilPlayerRef.current();
    });
    return () => registerCombatNextTurn(null);
  }, [registerCombatNextTurn]);

  /**
   * Résolution d'un sort avec jet de sauvegarde après executeCombatActionIntent (GM ou parseur).
   * @returns {{ exitCallApi: boolean, suppressReply: boolean }}
   */
  async function handleCombatIntentSpellSaveBranch(
    intentResult,
    postEntities,
    effGameModeForIntent,
    baseRoomId,
    baseScene
  ) {
    if (!intentResult?.runSpellSave) {
      return { exitCallApi: false, suppressReply: false };
    }
    const canonicalSpellName = intentResult.runSpellSave.spellName;
    const target = intentResult.runSpellSave.target;
    const compErr = spellComponentsBlockReasonForPlayer(player, canonicalSpellName);
    if (compErr) {
      addMessage("ai", `⚠️ ${compErr}`, undefined, makeMsgId());
      return { exitCallApi: false, suppressReply: true };
    }
    const spell = SPELLS?.[canonicalSpellName];
    if (!spell?.save || !target) {
      addMessage(
        "ai",
        `[DEBUG] actionIntent runSpellSave incohérent\n` + safeJson({ intentResult }),
        "debug",
        makeMsgId()
      );
      return { exitCallApi: false, suppressReply: true };
    }
    const resourceKind = resourceKindForCastingTime(spell.castingTime);
    if (!hasResource(turnResourcesRef.current, effGameModeForIntent, resourceKind)) {
      const label =
        resourceKind === "bonus"
          ? "Action bonus"
          : resourceKind === "reaction"
            ? "Réaction"
            : "Action";
      addMessage(
        "ai",
        `âš  Vous avez déjÃ  utilisé votre **${label}** ce tour-ci â€” impossible de lancer ${canonicalSpellName} maintenant.`,
        undefined,
        makeMsgId()
      );
      return { exitCallApi: false, suppressReply: true };
    }
    const slotResult = spendSpellSlot(player, updatePlayer, spell.level ?? 0);
    if (!slotResult.ok) {
      addMessage(
        "ai",
        `âš  Vous n'avez plus d'emplacements de sort disponibles pour lancer ${canonicalSpellName}.`,
        undefined,
        makeMsgId()
      );
      return { exitCallApi: false, suppressReply: true };
    }
    const dc = computeSpellSaveDC(player);
    const nat = debugNextRoll ?? (Math.floor(Math.random() * 20) + 1);
    if (debugNextRoll !== null) setDebugNextRoll(null);
    const saveBonus = computeEntitySaveBonus(target, spell.save);
    const total = nat + saveBonus;
    const succeeded = total >= dc;

    const dmgNotation = String(spell.damage ?? "1d6");
    const r = rollDiceDetailed(dmgNotation);
    const fullDmg = r.total;
    const baseDmg = Math.max(0, fullDmg);
    const finalDmg = succeeded ? Math.floor(baseDmg / 2) : baseDmg;

    let myUpdates = [];
    if (target.type !== "hostile") {
      myUpdates.push({ id: target.id, action: "update", type: "hostile" });
    }

    let hpBefore = target.hp?.current ?? null;
    let hpAfter = hpBefore;
    if (target.hp && finalDmg > 0) {
      const newHp = Math.max(0, target.hp.current - finalDmg);
      hpAfter = newHp;
      if (newHp <= 0) {
        myUpdates.push({ id: target.id, action: "kill" });
      } else {
        const idx = myUpdates.findIndex((u) => u.action === "update" && u.id === target.id);
        if (idx >= 0) {
          myUpdates[idx] = { ...myUpdates[idx], hp: { current: newHp, max: target.hp.max } };
        } else {
          myUpdates.push({
            id: target.id,
            action: "update",
            hp: { current: newHp, max: target.hp.max },
          });
        }
      }
    }

    myUpdates = markSceneHostilesAware(postEntities, myUpdates);
    const nextEntities = myUpdates.length
      ? applyUpdatesLocally(postEntities, myUpdates)
      : postEntities;
    if (myUpdates.length) applyEntityUpdates(myUpdates);
    ensureCombatState(nextEntities);

    consumeResource(setTurnResourcesSynced, effGameModeForIntent, resourceKind);

    addMessage(
      "ai",
      `[DEBUG] Résolution sort (save) ${canonicalSpellName} [actionIntent]\n` +
        safeJson({
          targetId: target.id,
          targetName: target.name,
          saveType: spell.save,
          nat,
          saveBonus,
          total,
          dc,
          succeeded,
          damage: finalDmg,
          hpBefore,
          hpAfter,
          slotLevelUsed: slotResult.usedLevel,
          resourceKind,
        }),
      "debug",
      makeMsgId()
    );

    const saveLabel = `${spell.save}`;
    const bonusStr = fmtMod(saveBonus);
    const saveLine =
      nat === 20
        ? `Nat **20** ðŸ’¥ (réussite automatique)`
        : nat === 1
          ? `Nat **1** ðŸ’€ (échec automatique)`
          : `Nat ${nat} ${bonusStr} = **${total}** vs DD ${dc}`;
    const outcome = succeeded
      ? "âœ” Réussite â€” dégâts réduits."
      : "âœ– Ã‰chec â€” dégâts complets.";
    let dmgDetail = formatDiceNotationDetail(r, dmgNotation);
    if (succeeded) {
      dmgDetail += " â†’ moitié dégâts";
    }
    const dmgLine =
      finalDmg > 0
        ? `${dmgDetail} = **${finalDmg} dégâts ${spell.damageType ?? ""}**`
        : "Aucun dégât.";

    const content =
      `ðŸŽ² Jet de sauvegarde (${saveLabel} pour ${canonicalSpellName} â†’ ${target.name}) â€” ${saveLine}\n` +
      `${outcome} ${dmgLine}.`;

    await callApi(content, "dice", false, {
      entities: nextEntities,
      currentRoomId: baseRoomId,
      currentScene: baseScene,
      currentSceneName,
      gameMode: effGameModeForIntent,
      engineEvent: {
        kind: "spell_save_resolution",
        spellName: canonicalSpellName,
        targetId: target.id,
        saveType: spell.save,
        nat,
        total,
        dc,
        succeeded,
        damage: finalDmg,
        targetHpBefore: hpBefore,
        targetHpAfter: hpAfter,
        targetHpMax: target.hp?.max ?? null,
        targetIsAlive: hpAfter === null ? true : hpAfter > 0,
        slotLevelUsed: slotResult.usedLevel,
      },
    });
    return { exitCallApi: true, suppressReply: true };
  }

  /**
   * Chaîne parse-intent → moteur combat (hors appel MJ).
   */
  async function processEngineIntent(
    apiIntent,
    postEntities,
    userTextForResolve,
    baseRoomId,
    baseScene,
    actingPlayerOverride = null,
    rollAttribution = null,
    meleeCombatantIdForResolve = null,
    turnResourcesOverrideForResolve = null,
    multiplayerPendingCommandIdForEngine = null
  ) {
    if (!apiIntent || typeof apiIntent !== "object") {
      addMessage("ai", "Intention non reconnue.", "intent-error", makeMsgId());
      return;
    }
    const combatPlayer = actingPlayerOverride ?? player;
    const namedCheck = validateNamedWeaponOrSpellFromParser(apiIntent, combatPlayer);
    if (!namedCheck.ok) {
      addMessage(
        "ai",
        `❌ Action impossible : vous ne possédez pas l'arme ou le sort '${namedCheck.label}'.`,
        "meta",
        makeMsgId()
      );
      return;
    }
    const actionIntentNorm = normalizeClientActionIntent({
      type: apiIntent.type,
      targetId: apiIntent.targetId || null,
      itemName: apiIntent.weapon || null,
    });
    if (!actionIntentNorm) {
      addMessage("ai", "Intention de combat non reconnue.", "intent-error", makeMsgId());
      return;
    }
    const meleeIdForCombat =
      typeof meleeCombatantIdForResolve === "string" && meleeCombatantIdForResolve.trim()
        ? meleeCombatantIdForResolve.trim()
        : localCombatantId;
    // Après await parse-intent, le closure React peut être périmé ; l’index « live » est tenu
    // à jour par commitCombatTurnIndex (sync) + chaque rendu.
    const live = gameStateRef.current;
    const effGameModeForIntent = live?.gameMode ?? gameMode;
    const effOrderForIntent = live?.combatOrder ?? combatOrder;
    const effTurnIdxForIntent = combatTurnIndexLiveRef.current;
    const isPlayerCombatTurn =
      effGameModeForIntent === "combat" &&
      effOrderForIntent.length > 0 &&
      controllerForCombatantId(
        effOrderForIntent[effTurnIdxForIntent]?.id,
        live?.entities ?? null
      ) === "player";

    if (effGameModeForIntent === "combat" && !isPlayerCombatTurn) {
      // En auto-joueur, l'intention peut arriver avec un léger décalage de tour :
      // on évite de spammer le chat joueur avec cette erreur non-actionnable.
      if (autoTurnInProgressRef.current) return;
      const activeSlot = effOrderForIntent[effTurnIdxForIntent];
      const activeIdForTurnMsg = String(activeSlot?.id ?? "").trim();
      const entPoolTurn = Array.isArray(live?.entities) ? live.entities : postEntities;
      const activeEntTurn =
        Array.isArray(entPoolTurn) && activeIdForTurnMsg
          ? entPoolTurn.find((e) => e && String(e.id) === activeIdForTurnMsg)
          : null;
      const activeLabelTurn =
        String(
          activeEntTurn?.name ??
            activeSlot?.name ??
            (activeIdForTurnMsg || "combattant actif")
        ).trim() || "combattant actif";
      const actingName = String(combatPlayer?.name ?? "Votre personnage").trim() || "Votre personnage";
      let msg = `Ce n'est pas le tour d'agir pour **${actingName}** : dans l'ordre d'initiative, c'est à **${activeLabelTurn}** d'agir.`;
      if (live?.debugMode) {
        msg += ` [DEBUG: index=${effTurnIdxForIntent}, actifId=${activeIdForTurnMsg || "?"}]`;
      }
      // MP : même raison que handleSend — "intent-error" est ignoré localement en session.
      addMessage("ai", msg, multiplayerSessionId ? "meta" : "intent-error", makeMsgId());
      return;
    }

    if (effGameModeForIntent === "combat" && effOrderForIntent.length > 0) {
      const activeId = effOrderForIntent[effTurnIdxForIntent]?.id;
      if (
        activeId &&
        meleeIdForCombat &&
        !mpLocalCombatantIdsEqual(activeId, meleeIdForCombat)
      ) {
        const entPoolSlot = Array.isArray(live?.entities) ? live.entities : postEntities;
        const aid = String(activeId ?? "").trim();
        const activeEntSlot =
          Array.isArray(entPoolSlot) && aid ? entPoolSlot.find((e) => e && String(e.id) === aid) : null;
        const activeLabelSlot =
          String(
            activeEntSlot?.name ??
              effOrderForIntent[effTurnIdxForIntent]?.name ??
              (aid || "combattant actif")
          ).trim() || "combattant actif";
        addMessage(
          "ai",
          `Ce n'est pas le tour du personnage que vous contrôlez ici : le slot actif est **${activeLabelSlot}**. Attendez votre place dans l'ordre d'initiative (ou utilisez la fiche du PJ dont c'est le tour).`,
          multiplayerSessionId ? "meta" : "intent-error",
          makeMsgId()
        );
        return;
      }
    }

    const trLiveForActingCombatant =
      multiplayerSessionId &&
      meleeIdForCombat &&
      turnResourcesByCombatantId &&
      typeof turnResourcesByCombatantId === "object"
        ? normalizeTurnResourcesInput(turnResourcesByCombatantId[meleeIdForCombat])
        : null;
    const trOverrideForResolve =
      multiplayerSessionId &&
      turnResourcesOverrideForResolve &&
      typeof turnResourcesOverrideForResolve === "object"
        ? normalizeTurnResourcesInput(turnResourcesOverrideForResolve)
        : null;
    /** MP : sur le client qui exécute sa propre commande, le snapshot `turnResources` de la commande peut être en retard sur l'état React — ne pas l'appliquer en ET avec le live (sinon mouvement « faux négatif »). */
    const actingIsLocalMpPuppet =
      !!multiplayerSessionId &&
      !!meleeIdForCombat &&
      mpLocalCombatantIdsEqual(meleeIdForCombat, localCombatantId);
    const trWork =
      multiplayerSessionId && (trLiveForActingCombatant || trOverrideForResolve)
        ? actingIsLocalMpPuppet && trLiveForActingCombatant
          ? normalizeTurnResourcesInput(turnResourcesRef.current)
          : {
              // Ne jamais "ré-accorder" une ressource déjà consommée côté état live.
              // Si le snapshot de commande est périmé (true) mais le live est false, on garde false.
              action:
                trLiveForActingCombatant && trOverrideForResolve
                  ? trLiveForActingCombatant.action && trOverrideForResolve.action
                  : (trLiveForActingCombatant ?? trOverrideForResolve)?.action ?? true,
              bonus:
                trLiveForActingCombatant && trOverrideForResolve
                  ? trLiveForActingCombatant.bonus && trOverrideForResolve.bonus
                  : (trLiveForActingCombatant ?? trOverrideForResolve)?.bonus ?? true,
              reaction:
                trLiveForActingCombatant && trOverrideForResolve
                  ? trLiveForActingCombatant.reaction && trOverrideForResolve.reaction
                  : (trLiveForActingCombatant ?? trOverrideForResolve)?.reaction ?? true,
              movement:
                trLiveForActingCombatant && trOverrideForResolve
                  ? trLiveForActingCombatant.movement && trOverrideForResolve.movement
                  : (trLiveForActingCombatant ?? trOverrideForResolve)?.movement ?? true,
            }
        : null;
    const setTrForResolve =
      trWork != null
        ? (fnOrObj) => {
            /** MP : appliquer tout de suite trWork + turnResourcesRef ; sinon le DEBUG même-tick
             * et l’auto-joueur voient encore le mouvement disponible (le setter React s’exécute après). */
            if (typeof fnOrObj === "function") {
              const prevNorm = normalizeTurnResourcesInput(trWork);
              const next = fnOrObj(prevNorm);
              if (next && typeof next === "object") {
                Object.assign(trWork, next);
                turnResourcesRef.current = normalizeTurnResourcesInput(next);
              }
              setTurnResourcesForCombatant(meleeIdForCombat, () =>
                normalizeTurnResourcesInput(trWork)
              );
            } else if (fnOrObj && typeof fnOrObj === "object") {
              const prevNorm = normalizeTurnResourcesInput(trWork);
              const merged = { ...prevNorm, ...fnOrObj };
              Object.assign(trWork, merged);
              turnResourcesRef.current = normalizeTurnResourcesInput(merged);
              setTurnResourcesForCombatant(meleeIdForCombat, () =>
                normalizeTurnResourcesInput(trWork)
              );
            }
          }
        : setTurnResourcesSynced;
    const emitMeleeMoveDebug = (payload) => {
      emitMeleeGraphDebugChat({
        ...payload,
        getMeleeWith,
        entities: postEntities,
        combatOrder: effOrderForIntent,
        localCombatantIdForNames: meleeIdForCombat,
        localPlayerDisplayName: combatPlayer?.name ?? null,
        addMessage,
        makeMsgId,
      });
    };
    if (effGameModeForIntent === "combat") {
      const intentType = String(actionIntentNorm?.type ?? "").trim();
      const intentTargetId = String(actionIntentNorm?.targetId ?? "").trim();
      const engagedNow = getMeleeWith(meleeIdForCombat).filter((id) => {
        const e = getRuntimeCombatant(id);
        return e && e.isAlive !== false;
      });
      const engagedSet = new Set(engagedNow);
      /** move sans targetId = déplacement « théâtre » (zone libre, abri, s’éloigner sans engager) → sortie de mêlée si besoin. */
      const isLeavingCurrentMelee =
        (intentType === "move" || intentType === "move_and_attack") &&
        ((intentType === "move" && !intentTargetId) ||
          (!!intentTargetId && !engagedSet.has(intentTargetId)));

      if (isLeavingCurrentMelee && engagedNow.length > 0) {
        const hostileEngaged = engagedNow.filter((id) => {
          const e = getRuntimeCombatant(id);
          return e && e.type === "hostile" && e.isAlive !== false;
        });
        if (hostileEngaged.length > 0 && !hasDisengagedThisTurn) {
          const moverSurvived = await processOpportunityAttacksForLeavingCombatant(
            meleeIdForCombat,
            hostileEngaged
          );
          if (!moverSurvived || (playerHpRef.current ?? combatPlayer?.hp?.current ?? 0) <= 0) {
            return;
          }
        }
        // Le déplacement vers une cible hors mêlée actuelle brise tous les liens de contact
        // restants (alliés inclus). Les OA ne concernent que les ennemis et sont traitées ci-dessus.
        clearMeleeFor(meleeIdForCombat);
      }
    }
    const turnResourcesForIntentExec = normalizeTurnResourcesInput(
      actingIsLocalMpPuppet ? turnResourcesRef.current : trWork ?? turnResourcesRef.current
    );
    const intentResult = executeCombatActionIntent(actionIntentNorm, {
      postEntities,
      player: combatPlayer,
      gameMode: effGameModeForIntent,
      setGameMode,
      turnResources: turnResourcesForIntentExec,
      setTurnResources: setTrForResolve,
      setHp,
      updatePlayer,
      applyEntityUpdates,
      currentRoomId,
      playerHpRef,
      getMeleeWith,
      addMeleeMutual,
      clearMeleeFor,
      setHasDisengagedThisTurn,
      hasDisengagedThisTurn,
      consumeResource,
      addMessage,
      makeMsgId,
      userContent: userTextForResolve,
      parserMinimalNarration: true,
      localCombatantId: meleeIdForCombat,
      dodgeActiveByCombatantIdRef,
      combatHiddenIds: gameStateRef.current?.combatHiddenIds ?? combatHiddenIds ?? [],
      meleeState,
      emitMeleeMoveDebug,
      messagesRef,
      multiplayerParticipantProfilesRef,
      multiplayerSessionId,
      clientId,
      patchParticipantProfileHp,
      combatEngagementSeqRef,
      combatRoundInEngagementRef,
      combatTurnIndexLiveRef,
      multiplayerPendingCommandId: multiplayerPendingCommandIdForEngine,
    });

    if (!intentResult.ok) {
      if (!shouldSkipDuplicateClientActionErrorEcho(intentResult.userMessage)) {
        addMessage("ai", intentResult.userMessage, multiplayerSessionId ? "meta" : "intent-error", makeMsgId());
      }
      return;
    }

    if (effGameModeForIntent === "combat") {
      addMessage(
        "ai",
        `[DEBUG][ENGINE_RX] Ressources tour après intention combat (moteur)\n` +
          safeJson({
            meleeCombatantId: meleeIdForCombat,
            localCombatantId,
            multiplayerSessionId: multiplayerSessionId ?? null,
            usedTrWorkOverride: trWork != null,
            intent: {
              type: actionIntentNorm?.type ?? null,
              targetId: actionIntentNorm?.targetId ?? null,
            },
            turnResourcesRefAfter: normalizeTurnResourcesInput(turnResourcesRef.current),
            mapEntryForMeleeId_mayLagOneFrame: turnResourcesByCombatantId?.[meleeIdForCombat] ?? null,
          }),
        "debug",
        makeMsgId()
      );
    }

    if (intentResult.endTurnRequested) {
      clearPlayerSurprisedState();
      addMessage(
        "ai",
        `**${combatPlayer?.name ?? "Vous"}** met fin à son tour.`,
        "turn-end",
        makeMsgId()
      );
      addMessage("ai", "", "turn-divider", makeMsgId());
      await nextTurn();
      return;
    }

    if (intentResult.runSpellSave) {
      await handleCombatIntentSpellSaveBranch(
        intentResult,
        postEntities,
        effGameModeForIntent,
        baseRoomId,
        baseScene
      );
      return;
    }

    if (intentResult.pendingRoll) {
      const stamped = stampPendingRollForActor(
        intentResult.pendingRoll,
        combatPlayer,
        rollAttribution?.submitterClientId ?? null
      );
      pendingRollRef.current = stamped;
      setPendingRoll(stamped);
    }
  }

  async function processArbiterDecision(
    apiDecision,
    baseEntities,
    userTextForResolve,
    baseRoomId,
    baseScene,
    baseGameModeForResolve,
    actingPlayerOverride = null,
    rollAttribution = null,
    meleeCombatantIdForResolve = null,
    turnResourcesOverrideForResolve = null,
    multiplayerPendingCommandIdForArbiter = null
  ) {
    if (!apiDecision || typeof apiDecision !== "object") {
      addMessage("ai", "Décision d'arbitrage invalide.", "intent-error", makeMsgId());
      return;
    }

    const resolution = String(apiDecision.resolution ?? "").trim();
    const effectiveActingPlayer = actingPlayerOverride ?? player ?? null;
    if (resolution === "unclear_input") {
      const reason =
        typeof apiDecision.reason === "string" && apiDecision.reason.trim()
          ? apiDecision.reason.trim()
          : null;
      await callApi("", "meta", false, {
        hideUserMessage: true,
        bypassIntentParser: true,
        skipAutoPlayerTurn: true,
        skipGmContinue: true,
        actingPlayer: effectiveActingPlayer,
        entities: baseEntities,
        currentRoomId: baseRoomId,
        currentScene: baseScene,
        gameMode: baseGameModeForResolve,
        engineEvent: {
          kind: "action_unclear",
          reason: reason ?? "L'intention du joueur reste trop vague pour être résolue telle quelle.",
          playerText: String(userTextForResolve ?? "").trim(),
          resolution: "unclear_input",
        },
      });
      return;
    }

    if (resolution === "combat_intent") {
      const intentType = String(apiDecision?.intent?.type ?? "").trim();
      if (intentType === "wait_until_recover_1hp") {
        const rawTargetRef = String(apiDecision?.intent?.targetId ?? "").trim();
        if (!rawTargetRef) {
          addMessage("ai", "Impossible d'attendre la récupération naturelle : cible manquante.", "meta", makeMsgId());
          return;
        }
        const worldNow = Math.max(0, Math.trunc(Number(worldTimeMinutes) || 0));
        const entityPool = Array.isArray(gameStateRef.current?.entities) ? gameStateRef.current.entities : entities;
        const targetRefNorm = normalizeFr(rawTargetRef);
        const target =
          entityPool.find((e) => String(e?.id ?? "").trim() === rawTargetRef) ??
          entityPool.find((e) => normalizeFr(String(e?.name ?? "")) === targetRefNorm) ??
          entityPool.find((e) => {
            const n = normalizeFr(String(e?.name ?? ""));
            return !!n && (n.includes(targetRefNorm) || targetRefNorm.includes(n));
          }) ??
          null;
        const resolvedTargetId = String(target?.id ?? rawTargetRef).trim();
        const isMpTarget = resolvedTargetId.startsWith("mp-player-");
        const targetCid = isMpTarget ? resolvedTargetId.slice("mp-player-".length).trim() : "";
        const participantProfilesLive = multiplayerParticipantProfilesRef.current;
        const prof =
          isMpTarget && targetCid && Array.isArray(participantProfilesLive)
            ? participantProfilesLive.find((p) => String(p?.clientId ?? "").trim() === targetCid) ?? null
            : Array.isArray(participantProfilesLive)
              ? participantProfilesLive.find((p) => {
                  const pname = normalizeFr(String(p?.name ?? p?.playerSnapshot?.name ?? ""));
                  return pname && (pname === targetRefNorm || pname.includes(targetRefNorm) || targetRefNorm.includes(pname));
                }) ?? null
            : null;
        const hotOverride = targetCid ? mpParticipantStateOverrideRef.current.get(targetCid) ?? null : null;

        let waitHours = rollDice("1d4");
        let waitMinutes = waitHours * 60;
        let targetName = String(target?.name ?? prof?.name ?? prof?.playerSnapshot?.name ?? "").trim();

        if (target) {
          const snap = prof?.playerSnapshot && typeof prof.playerSnapshot === "object" ? prof.playerSnapshot : null;
          targetName = targetName || String(target?.name ?? snap?.name ?? rawTargetRef).trim() || rawTargetRef;
          const hpFromEntity =
            typeof target?.hp?.current === "number" && Number.isFinite(target.hp.current)
              ? Math.trunc(target.hp.current)
              : null;
          const hpFromProfile =
            typeof hotOverride?.hpCurrent === "number" && Number.isFinite(hotOverride.hpCurrent)
              ? Math.trunc(hotOverride.hpCurrent)
              :
            typeof prof?.hpCurrent === "number" && Number.isFinite(prof.hpCurrent)
              ? Math.trunc(prof.hpCurrent)
              : typeof snap?.hp?.current === "number" && Number.isFinite(snap.hp.current)
                ? Math.trunc(snap.hp.current)
                : null;
          const dsFromEntity =
            target?.deathState && typeof target.deathState === "object" ? target.deathState : null;
          const dsFromProfile =
            hotOverride?.deathState && typeof hotOverride.deathState === "object"
              ? hotOverride.deathState
              :
            snap?.deathState && typeof snap.deathState === "object" ? snap.deathState : null;
          // Pour les cibles MP, la vérité métier est le participant profile (synchro Firestore).
          const hp =
            isMpTarget && hpFromProfile != null
              ? hpFromProfile
              : hpFromEntity != null
                ? hpFromEntity
                : hpFromProfile;
          const ds = isMpTarget ? dsFromProfile ?? dsFromEntity : dsFromEntity ?? dsFromProfile;
          if (
            String(target?.type ?? "").toLowerCase() === "hostile" ||
            hp == null ||
            hp > 0 ||
            !ds ||
            ds.dead === true ||
            ds.stable !== true
          ) {
            addMessage(
              "ai",
              `[DEBUG][WAIT_RECOVER_CHECK] refus cible non stabilisée\n` +
                safeJson({
                  targetId: resolvedTargetId,
                  isMpTarget,
                  hp,
                  deathState: ds ?? null,
                  hpFromEntity,
                  hpFromProfile,
                  deathStateFromEntity: dsFromEntity ?? null,
                  deathStateFromProfile: dsFromProfile ?? null,
                }),
              "debug",
              makeMsgId()
            );
            addMessage(
              "ai",
              `Impossible d'attendre la récupération naturelle de **${targetName}** : la créature ciblée n'est pas stabilisée à 0 PV.`,
              "meta",
              makeMsgId()
            );
            return;
          }
          const existingAutoAt =
            typeof ds.autoRecoverAtMinute === "number" && Number.isFinite(ds.autoRecoverAtMinute)
              ? Math.max(worldNow + 1, Math.trunc(ds.autoRecoverAtMinute))
              : null;
          const targetMinute = existingAutoAt ?? worldNow + waitMinutes;
          waitMinutes = Math.max(1, targetMinute - worldNow);
          waitHours = Math.max(1, Math.ceil(waitMinutes / 60));
          advanceWorldClock(waitMinutes);
          if (isMpTarget && targetCid) {
            await patchParticipantProfileDeathState(
              targetCid,
              { ...(ds ?? {}), stable: false, unconscious: false, dead: false, autoRecoverAtMinute: null },
              { hpCurrent: 1 }
            );
            mpParticipantStateOverrideRef.current.set(targetCid, {
              hpCurrent: 1,
              deathState: { ...(ds ?? {}), stable: false, unconscious: false, dead: false, autoRecoverAtMinute: null },
              updatedAtMs: Date.now(),
            });
          } else {
            applyEntityUpdates([
              {
                action: "update",
                id: resolvedTargetId,
                hp: { ...(target.hp ?? {}), current: 1 },
                deathState: { ...(ds ?? {}), stable: false, unconscious: false, dead: false, autoRecoverAtMinute: null },
                isAlive: true,
              },
            ]);
          }
        } else if (prof) {
          const snap = prof?.playerSnapshot && typeof prof.playerSnapshot === "object" ? prof.playerSnapshot : null;
          const recentStabilizeEvidence = Array.isArray(messagesRef.current)
            ? [...messagesRef.current]
                .reverse()
                .find((m) => {
                  if (m?.role !== "ai") return false;
                  const txt = normalizeFr(String(m?.content ?? ""));
                  const tn = normalizeFr(String(targetName ?? rawTargetRef ?? ""));
                  return txt.includes("stabilis") && (!!tn && txt.includes(tn));
                })
            : null;
          const hp =
            typeof hotOverride?.hpCurrent === "number" && Number.isFinite(hotOverride.hpCurrent)
              ? Math.trunc(hotOverride.hpCurrent)
              : typeof prof?.hpCurrent === "number" && Number.isFinite(prof.hpCurrent)
              ? Math.trunc(prof.hpCurrent)
              : typeof snap?.hp?.current === "number" && Number.isFinite(snap.hp.current)
                ? Math.trunc(snap.hp.current)
                : null;
          const ds =
            hotOverride?.deathState && typeof hotOverride.deathState === "object"
              ? hotOverride.deathState
              : snap?.deathState && typeof snap.deathState === "object"
                ? snap.deathState
                : null;
          targetName = String(prof?.name ?? snap?.name ?? rawTargetRef).trim() || rawTargetRef;
          let effectiveDs = ds;
          // Filet anti-lag multi-clients : si le chat confirme une stabilisation juste avant,
          // on force localement la bascule stable=true puis on pousse Firestore.
          if (
            hp != null &&
            hp <= 0 &&
            (!effectiveDs || effectiveDs.stable !== true) &&
            recentStabilizeEvidence
          ) {
            effectiveDs = {
              ...(effectiveDs && typeof effectiveDs === "object" ? effectiveDs : {}),
              stable: true,
              unconscious: true,
              dead: false,
            };
            if (targetCid) {
              await patchParticipantProfileDeathState(targetCid, effectiveDs, { hpCurrent: hp });
              mpParticipantStateOverrideRef.current.set(targetCid, {
                hpCurrent: hp,
                deathState: effectiveDs,
                updatedAtMs: Date.now(),
              });
            }
            addMessage(
              "ai",
              `[DEBUG][WAIT_RECOVER_RESYNC] stabilisation re-synchronisée depuis historique\n` +
                safeJson({
                  targetCid,
                  targetName,
                  hp,
                  evidenceMessage: String(recentStabilizeEvidence?.content ?? "").slice(0, 220),
                }),
              "debug",
              makeMsgId()
            );
          }
          if (hp == null || hp > 0 || !effectiveDs || effectiveDs.dead === true || effectiveDs.stable !== true) {
            addMessage(
              "ai",
              `[DEBUG][WAIT_RECOVER_CHECK][MP] refus cible non stabilisée\n` +
                safeJson({
                  targetCid,
                  targetName,
                  hp,
                  deathState: effectiveDs ?? null,
                  profileHpCurrent: prof?.hpCurrent ?? null,
                  snapshotDeathState: snap?.deathState ?? null,
                  overrideDeathState: hotOverride?.deathState ?? null,
                }),
              "debug",
              makeMsgId()
            );
            addMessage(
              "ai",
              `Impossible d'attendre la récupération naturelle de **${targetName}** : la créature ciblée n'est pas stabilisée à 0 PV.`,
              "meta",
              makeMsgId()
            );
            return;
          }
          const existingAutoAt =
            typeof effectiveDs.autoRecoverAtMinute === "number" && Number.isFinite(effectiveDs.autoRecoverAtMinute)
              ? Math.max(worldNow + 1, Math.trunc(effectiveDs.autoRecoverAtMinute))
              : null;
          const targetMinute = existingAutoAt ?? worldNow + waitMinutes;
          waitMinutes = Math.max(1, targetMinute - worldNow);
          waitHours = Math.max(1, Math.ceil(waitMinutes / 60));
          advanceWorldClock(waitMinutes);
          await patchParticipantProfileDeathState(
            targetCid,
            { ...(effectiveDs ?? {}), stable: false, unconscious: false, dead: false, autoRecoverAtMinute: null },
            { hpCurrent: 1 }
          );
          mpParticipantStateOverrideRef.current.set(targetCid, {
            hpCurrent: 1,
            deathState: { ...(effectiveDs ?? {}), stable: false, unconscious: false, dead: false, autoRecoverAtMinute: null },
            updatedAtMs: Date.now(),
          });
        } else {
          addMessage("ai", "Impossible d'attendre la récupération naturelle : cible introuvable.", "meta", makeMsgId());
          return;
        }

        addMessage(
          "ai",
          `Vous attendez **${waitHours} h** (1d4) : **${targetName}** regagne **1 PV** et reprend conscience.`,
          "meta",
          makeMsgId()
        );
        if (multiplayerSessionId) {
          void flushMultiplayerSharedState().catch(() => {});
        }
        return;
      }
      if (intentType === "wait") {
        const minsRaw = apiDecision?.intent?.weapon ?? "";
        const mins = Math.max(0, Math.min(24 * 60, Math.trunc(Number(minsRaw) || 0)));
        if (debugMode) {
          const down = (Array.isArray(gameStateRef.current?.entities) ? gameStateRef.current.entities : entities)
            .filter((e) => e && e.type !== "hostile" && typeof e?.hp?.current === "number" && e.hp.current <= 0);
          const downMp = Array.isArray(multiplayerParticipantProfiles)
            ? multiplayerParticipantProfiles
                .map((p) => {
                  const cid = String(p?.clientId ?? "").trim();
                  const hp = typeof p?.hpCurrent === "number" && Number.isFinite(p.hpCurrent) ? Math.trunc(p.hpCurrent) : null;
                  const snap = p?.playerSnapshot && typeof p.playerSnapshot === "object" ? p.playerSnapshot : null;
                  return {
                    clientId: cid || null,
                    name: p?.name ?? snap?.name ?? null,
                    hpCurrent: hp,
                    deathState: snap?.deathState ?? null,
                  };
                })
                .filter((p) => p.hpCurrent != null && p.hpCurrent <= 0)
            : [];
          addMessage(
            "ai",
            `[DEBUG] wait intent (passage du temps)\n` +
              safeJson({
                minutes: mins,
                worldTimeBefore: worldTimeMinutes,
                downedAllies: down.map((e) => ({
                  id: e.id,
                  name: e.name,
                  hp: e.hp?.current,
                  deathState: e.deathState ?? null,
                })),
                downedParticipants: downMp,
              }),
            "debug",
            makeMsgId()
          );
        }
        if (mins > 0) {
          advanceWorldClock(mins);
          addMessage("ai", `Vous attendez ${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}min.`, "meta", makeMsgId());
          if (multiplayerSessionId) {
            void flushMultiplayerSharedState().catch(() => {});
          }
        } else {
          addMessage("ai", "Vous attendez un moment.", "meta", makeMsgId());
        }
        return;
      }
      if (intentType === "short_rest") {
        startShortRest();
        return;
      }
      if (intentType === "end_short_rest") {
        const modeNow = gameStateRef.current?.gameMode ?? gameMode;
        if (modeNow === "short_rest") {
          finishShortRest("Le repos court prend fin.");
          return;
        }
        addMessage("ai", "Aucun repos court n'est en cours.", "meta", makeMsgId());
        return;
      }
      if (intentType === "long_rest") {
        startLongRest();
        return;
      }
      await processEngineIntent(
        apiDecision.intent,
        baseEntities,
        userTextForResolve,
        baseRoomId,
        baseScene,
        effectiveActingPlayer,
        rollAttribution,
        meleeCombatantIdForResolve,
        turnResourcesOverrideForResolve,
        multiplayerPendingCommandIdForArbiter
      );
      return;
    }

    if (resolution === "requires_roll") {
      const rr = apiDecision.rollRequest;
      if (!rr || typeof rr !== "object") {
        addMessage("ai", "Jet requis mais rollRequest manquant.", "intent-error", makeMsgId());
        return;
      }
      if (rr.kind === "gm_secret") {
        const rollNotation =
          typeof rr.roll === "string" && rr.roll.trim() ? rr.roll.trim() : "1d20";
        const r = rollDiceDetailed(rollNotation);
        addMessage(
          "ai",
          `[DEBUG] Intent → gm_secret (${rr.raison ?? "Jet secret"}) — ${rollNotation} [${r.rolls.join("+")}] = **${r.total}** → arbitre de scène`,
          "debug",
          makeMsgId()
        );
        try {
          const resolved = await runSceneEntryGmArbiter({
            roomId: baseRoomId,
            scene: baseScene,
            sceneName: currentSceneName,
            entitiesAtEntry: baseEntities,
            sourceAction: userTextForResolve,
            baseGameMode: baseGameModeForResolve,
            rollResultOverride: {
              kind: "gm_secret",
              notation: rollNotation,
              total: r.total,
              rolls: r.rolls,
            },
            intentDecision: {
              resolution: apiDecision.resolution,
              reason: apiDecision.reason ?? null,
              rollRequestSummary: { kind: "gm_secret", roll: rollNotation },
            },
            actingPlayerOverride: effectiveActingPlayer,
          });
          if (resolved?.awaitingPlayerRoll === true) return;
          await callApi(
            `[Jet secret résolu] ${rollNotation} = ${r.total}`,
            "dice",
            false,
            {
              hideUserMessage: true,
              bypassIntentParser: true,
              skipAutoPlayerTurn: true,
              skipGmContinue: true,
              actingPlayer: effectiveActingPlayer,
              entities: resolved?.nextEntities ?? baseEntities,
              currentRoomId: resolved?.nextRoomId ?? baseRoomId,
              currentScene: resolved?.nextScene ?? baseScene,
              currentSceneName: resolved?.nextSceneName ?? currentSceneName,
              gameMode: resolved?.nextGameMode ?? baseGameModeForResolve,
              engineEvent: resolved?.engineEvent ?? {
                kind: "gm_secret_resolution",
                roll: rollNotation,
                total: r.total,
                rolls: r.rolls,
                reason: rr.raison ?? "Jet secret MJ",
              },
            }
          );
        } catch (e) {
          addMessage(
            "ai",
            `[DEBUG] Erreur GM Arbitre (après jet secret intent): ${String(e?.message ?? e)}`,
            "debug",
            makeMsgId()
          );
          markFlowFailure(String(e?.message ?? e), {
            kind: "sceneArbiterAfterGmSecret",
            roomId: baseRoomId,
            scene: baseScene,
            sceneName: currentSceneName,
            entitiesAtEntry: baseEntities,
            sourceAction: userTextForResolve,
            baseGameMode: baseGameModeForResolve,
            rollResultOverride: {
              kind: "gm_secret",
              notation: rollNotation,
              total: r.total,
              rolls: r.rolls,
            },
            intentDecision: {
              resolution: apiDecision.resolution,
              reason: apiDecision.reason ?? null,
              rollRequestSummary: { kind: "gm_secret", roll: rollNotation },
            },
            diceFollowup: {
              userContent: `[Jet secret résolu] ${rollNotation} = ${r.total}`,
              engineEvent: {
                kind: "gm_secret_resolution",
                roll: rollNotation,
                total: r.total,
                rolls: r.rolls,
                reason: rr.raison ?? "Jet secret MJ",
              },
            },
          });
        }
        return;
      }
      if (!rr.stat) {
        addMessage("ai", "rollRequest invalide : stat manquant.", "intent-error", makeMsgId());
        return;
      }
      const skill = rr.skill ?? null;
      const computed = computeCheckBonus({ player: effectiveActingPlayer, stat: rr.stat, skill });
      const audienceRaw = String(rr?.audience ?? "single").trim().toLowerCase();
      let audience =
        audienceRaw === "global" ? "global" : audienceRaw === "selected" ? "selected" : "single";
      const rawTargets = Array.isArray(rr.rollTargetEntityIds) ? rr.rollTargetEntityIds : [];
      const entityIdSet = buildEntityIdSetForMpRollTargetSanitize(
        baseEntities,
        multiplayerSessionId,
        multiplayerParticipantProfilesRef.current
      );
      let rollTargetEntityIds = [
        ...new Set(rawTargets.map((x) => String(x ?? "").trim()).filter((id) => entityIdSet.has(id))),
      ];
      if (audience === "selected" && rollTargetEntityIds.length === 0) audience = "single";
      if ((audience === "global" || audience === "selected") && rr.kind !== "check") {
        audience = "single";
        rollTargetEntityIds = [];
      }
      let normalizedRoll = { ...rr, skill: skill ?? undefined, totalBonus: computed };
      delete normalizedRoll.audience;
      delete normalizedRoll.rollTargetEntityIds;
      // En exploration, après le d20 le moteur doit enchaîner avec l’arbitre de scène
      // (secrets du lieu : dégâts de piège, 1d6 de chute, etc.) — voir parse-intent « ne pas gérer les règles du lieu ».
      if (baseGameModeForResolve === "exploration") {
        normalizedRoll.returnToArbiter = true;
        normalizedRoll.sceneArbiterContext = {
          roomId: baseRoomId,
          scene: baseScene,
          sceneName: currentSceneName,
          sourceAction: userTextForResolve,
          baseGameMode: baseGameModeForResolve,
          intentDecision: {
            resolution,
            reason: apiDecision.reason ?? null,
            rollRequestSummary: {
              stat: rr.stat,
              skill: skill ?? null,
              dc: rr.dc ?? null,
              raison: rr.raison ?? null,
            },
          },
        };
      }
      const canIntentGroupRoll =
        rr.kind === "check" &&
        (audience === "global" || audience === "selected") &&
        normalizedRoll.returnToArbiter === true;
      if (canIntentGroupRoll) {
        const globalRaisonPrefix =
          audience === "global"
            ? "**Jet de groupe** — chaque joueur connecté lance ce test ; le MJ interprète l’ensemble des résultats. "
            : "**Jet multi-PJ** — les personnages désignés lancent chacun ce test ; le MJ interprète l’ensemble des résultats. ";
        const globalRollId = `intent_grp_${String(baseRoomId ?? "").trim() || "room"}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
        const raisonBase = String(rr.raison ?? "").trim() || "Action incertaine";
        normalizedRoll = {
          ...normalizedRoll,
          id: globalRollId,
          audience,
          ...(audience === "selected" ? { rollTargetEntityIds } : {}),
          globalRollsByClientId: {},
          raison: `${globalRaisonPrefix}${raisonBase}`,
        };
        pendingRollRef.current = normalizedRoll;
        setPendingRoll(normalizedRoll);
        addMessage(
          "ai",
          `[DEBUG] Arbiter → pendingRoll (groupe intent)\n` + safeJson(normalizedRoll),
          "debug",
          makeMsgId()
        );
        return;
      }
      const stamped = stampPendingRollForActor(
        normalizedRoll,
        effectiveActingPlayer,
        rollAttribution?.submitterClientId ?? null
      );
      pendingRollRef.current = stamped;
      setPendingRoll(stamped);
      addMessage(
        "ai",
        `[DEBUG] Arbiter → pendingRoll\n` + safeJson(normalizedRoll),
        "debug",
        makeMsgId()
      );
      return;
    }

    // En combat, "impossible" est presque toujours mécanique (ex. Action déjà dépensée) :
    // afficher la raison factuelle du parseur sans appeler le MJ (évite une longue narration).
    if (
      resolution === "impossible" &&
      baseGameModeForResolve === "combat" &&
      !(
        apiDecision.sceneUpdate?.hasChanged &&
        typeof apiDecision.sceneUpdate?.targetRoomId === "string"
      )
    ) {
      const rawReason =
        typeof apiDecision.reason === "string" && apiDecision.reason.trim()
          ? apiDecision.reason.trim()
          : "Vous ne pouvez pas faire cela : il ne vous reste pas la ressource nécessaire ce tour-ci (Action, action bonus, mouvement, etc.).";
      const line =
        /^action\s+impossible\b/i.test(rawReason) || /^impossible\s*:/i.test(rawReason)
          ? rawReason
          : `Action impossible : ${rawReason}`;
      addMessage("ai", line, multiplayerSessionId ? "meta" : "intent-error", makeMsgId());
      return;
    }

    if (resolution !== "trivial_success" && resolution !== "impossible") {
      addMessage(
        "ai",
        `Décision d'arbitrage non supportée : ${resolution || "(vide)"}.`,
        "intent-error",
        makeMsgId()
      );
      return;
    }

    let nextEntities = baseEntities;
    let nextRoomId = baseRoomId;
    let nextScene = baseScene;
    let nextSceneName = currentSceneName;
    let engineEvent = {
      kind: resolution === "impossible" ? "action_impossible" : "action_trivial_success",
      playerAction: userTextForResolve,
      reason: apiDecision.reason ?? null,
    };

    // Exploration : fouille/pillage explicite => appliquer mécaniquement le loot côté moteur.
    // Le narrateur raconte ensuite, mais l'inventaire et l'état des corps doivent être déjà corrects.
    if (resolution === "trivial_success" && looksLikeLootIntent(userTextForResolve)) {
      const deadVisibleEntities = (Array.isArray(nextEntities) ? nextEntities : []).filter((e) => {
        if (!e || e.visible === false) return false;
        const hpCur = typeof e?.hp?.current === "number" ? e.hp.current : null;
        return e.isAlive === false || (hpCur != null && hpCur <= 0);
      });
      const targets = deadVisibleEntities.filter((e) => e?.looted !== true);

      const invGains = [];
      const lootEntityUpdates = [];
      for (const corpse of targets) {
        if (!corpse?.id || corpse.looted === true) continue;
        const picked = deriveLootItemsFromEntity(corpse, baseRoomId);
        if (picked.length) invGains.push(...picked);
        lootEntityUpdates.push({ action: "update", id: corpse.id, looted: true, lootItems: [] });
      }

      if (lootEntityUpdates.length > 0) {
        applyEntityUpdates(lootEntityUpdates);
        nextEntities = applyUpdatesLocally(nextEntities, lootEntityUpdates);
      }
      if (invGains.length > 0) {
        const currentInv = Array.isArray(player?.inventory) ? player.inventory : [];
        updatePlayer({ inventory: [...currentInv, ...invGains] });
      }

      engineEvent = {
        kind: "loot_resolution",
        playerAction: userTextForResolve,
        reason: apiDecision.reason ?? null,
        lootedEntityIds: lootEntityUpdates.map((u) => u.id),
        inventoryGains: invGains,
      };
    }

    const sceneUpdate = apiDecision.sceneUpdate;
    let sceneUpdateSnapshot = null;
    if (sceneUpdate?.hasChanged && typeof sceneUpdate?.targetRoomId === "string") {
      const tid = sceneUpdate.targetRoomId.trim();
      const room = tid && GOBLIN_CAVE[tid] ? GOBLIN_CAVE[tid] : null;
      const baseTrim = String(baseRoomId ?? "").trim();
      if (room && tid !== baseTrim) {
        // Parse-intent ne fait qu'émettre une intention de transition.
        // La transition effective est décidée par le GM Arbitre.
        sceneUpdateSnapshot = { hasChanged: true, targetRoomId: tid };
      }
    }

    const explorationAfterIntent =
      (gameStateRef.current?.gameMode ?? baseGameModeForResolve) === "exploration";

    const engineEventBeforeArbiter = engineEvent;
    const hadIntentSceneTransition =
      engineEventBeforeArbiter?.kind === "scene_transition" &&
      sceneUpdateSnapshot?.hasChanged === true &&
      typeof sceneUpdateSnapshot?.targetRoomId === "string" &&
      String(sceneUpdateSnapshot.targetRoomId).trim();

    let skipSceneRulesResolvedPipeline = false;

    // En exploration, après parse-intent (trivial_success / impossible), on appelle TOUJOURS l'arbitre
    // de scène **avant** le narrateur (/api/chat) : pièges, secrets, spawns éventuels, jets lieu.
    // Ce n'est pas « après la narration » : la prose joueur vient juste après, si l'arbitre réussit.
    if (explorationAfterIntent) {
      try {
        const resolved = await runSceneEntryGmArbiter({
          roomId: nextRoomId,
          scene: nextScene,
          sceneName: nextSceneName,
          entitiesAtEntry: nextEntities,
          sourceAction: userTextForResolve,
          baseGameMode: gameStateRef.current?.gameMode ?? baseGameModeForResolve,
          arbiterTrigger: hadIntentSceneTransition
            ? { phase: "scene_entered", fromRoomId: baseRoomId }
            : null,
          transitionResolutionNote: hadIntentSceneTransition
            ? "Navigation parse-intent déjà appliquée : le PJ vient d'entrer dans la salle courante via la sortie correspondant au message joueur (direction ou description). Ne pas réinterpréter ce texte comme un nouveau déplacement partant de la salle actuelle."
            : null,
          intentDecision: {
            resolution: apiDecision.resolution,
            reason: apiDecision.reason ?? null,
            sceneUpdate: hadIntentSceneTransition ? null : sceneUpdate ?? null,
            parseIntentNavigationApplied: hadIntentSceneTransition ? true : undefined,
          },
            actingPlayerOverride: effectiveActingPlayer,
        });
        nextEntities = resolved?.nextEntities ?? nextEntities;
        nextRoomId = resolved?.nextRoomId ?? nextRoomId;
        nextScene = resolved?.nextScene ?? nextScene;
        nextSceneName = resolved?.nextSceneName ?? nextSceneName;
        engineEvent = mergeSceneArbiterIntentEngineEvent(
          resolved,
          engineEventBeforeArbiter,
          sceneUpdateSnapshot,
          { intentNavigationJustApplied: hadIntentSceneTransition }
        );
        if (resolved?.awaitingPlayerRoll === true) {
          return;
        }
        // Ne pas return ici sur no_roll_needed + raison « procédurale » : après jet secret MJ,
        // transition de salle ou reprise d'arbitre, il faut TOUJOURS un passage narrateur (/api/chat)
        // pour décrire le résultat au joueur. L'ancien early-return coupait la narration et laissait
        // « Le MJ réfléchit… » / MP bloqué sans bulle.
        skipSceneRulesResolvedPipeline = true;
      } catch (e) {
        const errMsg = String(e?.message ?? e) || "GM Arbitre (scène) indisponible.";
        if (debugMode) {
          addMessage(
            "ai",
            `[DEBUG] Erreur GM Arbitre de scène (après parse-intent): ${errMsg}`,
            "debug",
            makeMsgId()
          );
        }
        addMessage(
          "ai",
          "L'arbitrage des règles du lieu (étape IA avant la narration) a échoué. Le MJ raconte quand même la suite — pièges / effets secrets du lieu n'ont peut-être pas été appliqués.",
          "meta-reply",
          makeMsgId()
        );
        engineEvent = engineEventBeforeArbiter;
        skipSceneRulesResolvedPipeline = false;
        // Pas de markFlowFailure : évite de bloquer la saisie ; le narrateur /api/chat part ci-dessous.
      }
    }

    // Point unique de prose MJ après parse-intent : moteur + arbitre(s) ont fini (jets secrets, spawns, scènes).
    // Si une navigation a déjà été appliquée (sceneUpdate parse-intent), on n'envoie PAS le texte joueur brut
    // au narrateur pour éviter la double prose « je me déplace » puis « j'entre dans la salle ».
    // On force un trigger d'entrée de scène, afin de ne garder que la narration post-transition.
    const narratorInputAfterIntent = hadIntentSceneTransition ? "[SceneEntered]" : userTextForResolve;
    // skipSceneRulesResolvedPipeline évite un 2e /api/chat [SceneRulesResolved] si la réponse JSON reprend un sceneUpdate.
    await callApi(narratorInputAfterIntent, "meta", false, {
      hideUserMessage: true,
      bypassIntentParser: true,
      skipAutoPlayerTurn: true,
      skipGmContinue: true,
      skipSceneRulesResolvedPipeline,
      actingPlayer: effectiveActingPlayer,
      entities: nextEntities,
      currentRoomId: nextRoomId,
      currentScene: nextScene,
      currentSceneName: nextSceneName,
      gameMode: gameStateRef.current?.gameMode ?? baseGameModeForResolve,
      engineEvent,
    });
  }

  function buildLazyCampaignWorldContext({
    roomId,
    currentEntitiesSnapshot,
    trigger = null,
    scope = "full_campaign",
  }) {
    const effectiveRoomId = typeof roomId === "string" ? roomId.trim() : "";

    const allRooms = Object.entries(GOBLIN_CAVE ?? {}).map(([id, room]) => ({
      id,
      title: room?.title ?? "",
      description: room?.description ?? "",
      secrets: room?.secrets ?? "",
      exits: getVisibleExitsForRoom(id, getRoomMemory(id)),
      encounterEntities: Array.isArray(room?.encounterEntities) ? room.encounterEntities : [],
    }));

    let worldRooms = allRooms;

    if (scope === "connected_rooms" && effectiveRoomId && GOBLIN_CAVE?.[effectiveRoomId]) {
      const toExitId = (exitDef) => {
        if (typeof exitDef === "string") return exitDef;
        return String(exitDef?.id ?? "").trim();
      };

      const connectedIds = new Set([effectiveRoomId]);
      const outgoing = getVisibleExitsForRoom(effectiveRoomId, getRoomMemory(effectiveRoomId));
      for (const ex of outgoing) {
        const id = toExitId(ex);
        if (id) connectedIds.add(id);
      }

      // Entrantes : toute salle qui a une sortie vers effectiveRoomId.
      for (const [rid, rdef] of Object.entries(GOBLIN_CAVE ?? {})) {
        const exits = Array.isArray(rdef?.exits) ? rdef.exits : [];
        if (exits.some((ex) => toExitId(ex) === effectiveRoomId)) {
          connectedIds.add(rid);
        }
      }

      worldRooms = allRooms.filter((r) => connectedIds.has(r.id));
    }

    const roomStates = {};
    for (const { id } of worldRooms) {
      const entitiesForRoom =
        id === "scene_journey"
          ? []
          : id === effectiveRoomId
            ? Array.isArray(currentEntitiesSnapshot)
              ? currentEntitiesSnapshot
              : []
            : takeEntitiesForRoom(id);
      roomStates[id] = {
        roomMemory: getRoomMemory(id),
        entities: Array.isArray(entitiesForRoom) ? entitiesForRoom : [],
      };
    }

    return {
      requestedFromRoomId: effectiveRoomId || null,
      scope,
      trigger,
      rooms: worldRooms,
      roomStates,
    };
  }

  function applyCrossRoomConsequences({
    activeRoomId,
    activeEntities,
    crossRoomEntityUpdates,
    crossRoomMoves,
    crossRoomMemoryAppend,
  }) {
    let nextActiveEntities = Array.isArray(activeEntities) ? activeEntities : [];
    let activeEntitiesTouched = false;

    if (Array.isArray(crossRoomEntityUpdates)) {
      for (const entry of crossRoomEntityUpdates) {
        if (!entry || typeof entry !== "object") continue;
        const targetRoomId = String(entry.roomId ?? "").trim();
        const roomUpdates = Array.isArray(entry.updates) ? entry.updates : [];
        if (!targetRoomId || roomUpdates.length === 0) continue;

        if (targetRoomId === activeRoomId) {
          nextActiveEntities = applyUpdatesLocally(nextActiveEntities, roomUpdates);
          applyEntityUpdates(roomUpdates);
          activeEntitiesTouched = true;
          continue;
        }

        const existingSnapshot =
          targetRoomId === "scene_journey" ? [] : takeEntitiesForRoom(targetRoomId);
        const nextSnapshot = applyUpdatesLocally(existingSnapshot, roomUpdates);
        rememberRoomEntitiesSnapshot(targetRoomId, nextSnapshot);
      }
    }

    if (Array.isArray(crossRoomMoves)) {
      for (const move of crossRoomMoves) {
        if (!move || typeof move !== "object") continue;
        const entityId = String(move.entityId ?? "").trim();
        const fromRoomId = String(move.fromRoomId ?? "").trim();
        const toRoomId = String(move.toRoomId ?? "").trim();
        if (!entityId || !fromRoomId || !toRoomId || fromRoomId === toRoomId) continue;
        const patch =
          move.patch && typeof move.patch === "object" && !Array.isArray(move.patch) ? move.patch : null;

        const sourceEntities =
          fromRoomId === activeRoomId ? nextActiveEntities : fromRoomId === "scene_journey" ? [] : takeEntitiesForRoom(fromRoomId);
        const sourceList = Array.isArray(sourceEntities) ? sourceEntities : [];
        const baseEntity = sourceList.find((e) => e && String(e.id ?? "").trim() === entityId) ?? null;
        if (!baseEntity) continue;

        const movedEntity = {
          ...baseEntity,
          ...(patch ? patch : {}),
          id: entityId,
        };

        const sourceNext = sourceList.filter((e) => String(e?.id ?? "").trim() !== entityId);
        if (fromRoomId === activeRoomId) {
          nextActiveEntities = sourceNext;
          activeEntitiesTouched = true;
        } else {
          rememberRoomEntitiesSnapshot(fromRoomId, sourceNext);
        }

        const destEntities =
          toRoomId === activeRoomId ? nextActiveEntities : toRoomId === "scene_journey" ? [] : takeEntitiesForRoom(toRoomId);
        const destList = Array.isArray(destEntities) ? destEntities : [];
        const existingIdx = destList.findIndex((e) => String(e?.id ?? "").trim() === entityId);
        const destNext =
          existingIdx >= 0
            ? destList.map((e, idx) => (idx === existingIdx ? { ...e, ...movedEntity, id: entityId } : e))
            : [...destList, movedEntity];

        if (toRoomId === activeRoomId) {
          nextActiveEntities = destNext;
          activeEntitiesTouched = true;
        } else {
          rememberRoomEntitiesSnapshot(toRoomId, destNext);
        }
      }
    }

    if (activeEntitiesTouched) {
      replaceEntities(nextActiveEntities);
    }

    if (Array.isArray(crossRoomMemoryAppend)) {
      for (const entry of crossRoomMemoryAppend) {
        if (!entry || typeof entry !== "object") continue;
        const targetRoomId = String(entry.roomId ?? "").trim();
        const line = String(entry.line ?? "").trim();
        if (!targetRoomId || !line) continue;
        appendRoomMemory(targetRoomId, line);
      }
    }

    return nextActiveEntities;
  }

  /**
   * Lignes « [Canon moteur] » dans la mémoire de salle : jets et règles déjà consommés (dédup via mergeRoomMemoryText).
   * Réduit les doubles applications si l’arbitre omet roomMemoryAppend ou se trompe sur la chaîne de jets.
   */
  function appendCanonicalArbiterMechanicalMemoryForRoom(targetRoomId, opts) {
    const rid = String(targetRoomId ?? "").trim();
    if (!rid) return;
    const phase = opts?.phase === "after_player_roll_before_gm_secret" ? "after_player_roll_before_gm_secret" : "terminal";
    const finalDecision = opts?.finalDecision;
    const rollOutcome = opts?.rollOutcome;
    const appliedTimeAdvanceMinutes =
      typeof opts?.appliedTimeAdvanceMinutes === "number" && Number.isFinite(opts.appliedTimeAdvanceMinutes)
        ? Math.max(0, Math.trunc(opts.appliedTimeAdvanceMinutes))
        : 0;

    const res = String(finalDecision?.resolution ?? "").trim();
    if (phase === "terminal" && res !== "apply_consequences" && res !== "no_roll_needed") return;

    const memHasLine = (line) => {
      const t = String(line ?? "").trim().replace(/\s+/g, " ").slice(0, 400);
      if (!t) return true;
      return String(getRoomMemory(rid) ?? "").includes(t);
    };
    const push = (line) => {
      const t = String(line ?? "").trim().replace(/\s+/g, " ").slice(0, 400);
      if (!t || memHasLine(t)) return;
      appendRoomMemory(rid, t);
    };

    const ro = rollOutcome && typeof rollOutcome === "object" ? rollOutcome : null;
    if (ro && String(ro.kind ?? "").trim() === "gm_secret") {
      const notation = String(ro.notation ?? "").trim() || "?";
      const total = ro.total;
      push(
        `[Canon moteur] Jet secret MJ ${notation} déjà résolu (total ${total}) sur ce lieu — ne pas re-tirer le même jet pour le même segment.`
      );
    } else if (
      phase === "after_player_roll_before_gm_secret" &&
      ro &&
      String(ro.kind ?? "").trim() !== "gm_secret" &&
      (ro.nat != null || ro.total != null || ro.success != null)
    ) {
      const skill = String(ro.skill ?? "").trim();
      const stat = String(ro.stat ?? "").trim();
      const lab = skill || stat || "Jet joueur";
      const ok =
        ro.success === true ? "succès" : ro.success === false ? "échec" : "jet effectué";
      const dcPart =
        typeof ro.dc === "number" && Number.isFinite(ro.dc) ? ` DD ${Math.trunc(ro.dc)}` : "";
      push(
        `[Canon moteur] ${lab} : ${ok}${dcPart} (total ${ro.total ?? "?"}) — la chaîne de règles continue ; ne pas redemander ce jet pour la même action.`
      );
    }

    if (phase !== "terminal") return;

    if (
      ro &&
      String(ro.kind ?? "").trim() !== "gm_secret" &&
      (ro.nat != null || ro.total != null || ro.success != null)
    ) {
      const skill = String(ro.skill ?? "").trim();
      const stat = String(ro.stat ?? "").trim();
      const lab = skill || stat || "Jet joueur";
      const ok =
        ro.success === true ? "succès" : ro.success === false ? "échec" : "jet effectué";
      const dcPart =
        typeof ro.dc === "number" && Number.isFinite(ro.dc) ? ` DD ${Math.trunc(ro.dc)}` : "";
      push(
        `[Canon moteur] ${lab} : ${ok}${dcPart} (total ${ro.total ?? "?"}) — ne pas redemander ce jet pour la même action source.`
      );
    }

    if (res === "apply_consequences") {
      const ups = Array.isArray(finalDecision?.entityUpdates) ? finalDecision.entityUpdates : [];
      const spawns = ups.filter((u) => u?.action === "spawn");
      if (spawns.length > 0) {
        const hostile = spawns.filter(
          (u) => String(u?.type ?? "").toLowerCase() === "hostile"
        ).length;
        push(
          `[Canon moteur] Règle appliquée : ${spawns.length} apparition(s) dont ${hostile} hostile(s) — ne pas respawn l’équivalent sans changement de situation.`
        );
      }
    }

    if (appliedTimeAdvanceMinutes > 0) {
      push(`[Canon moteur] Temps monde avancé de ${appliedTimeAdvanceMinutes} min dans cette résolution.`);
    }
  }

  async function runSceneEntryGmArbiterInner({
    roomId,
    scene,
    sceneName,
    entitiesAtEntry,
    sourceAction,
    baseGameMode,
    rollResultOverride = null,
    intentDecision = null,
    arbiterTrigger = null,
    actingPlayerOverride = null,
    reentryDepth = 0,
    transitionResolutionNote = null,
  }) {
    const room = roomId && GOBLIN_CAVE[roomId] ? GOBLIN_CAVE[roomId] : null;
    const provider = gameStateRef.current?.aiProvider === "openrouter" ? "openrouter" : "gemini";
    // Toujours fournir un contexte "salle courante + salles connectées" à l'arbitre,
    // afin que CONNECTED_ROOM_MEMORY / CONNECTED_ROOM_ENTITY_STATE soient présents
    // sur tous les appels (initial + relances après jet).
    let campaignContextScope = "connected_rooms";
    let campaignWorldContext = buildLazyCampaignWorldContext({
      roomId,
      currentEntitiesSnapshot: entitiesAtEntry,
      trigger: arbiterTrigger ?? null,
      scope: campaignContextScope,
    });
    const effectiveActingPlayer = actingPlayerOverride ?? player ?? null;
    const postArbiter = async (rollResult = null, worldContextOverride = null) => {
      const visibleExitsForRoom = getVisibleExitsForRoom(roomId, getRoomMemory(roomId));
      const trig = arbiterTrigger ?? null;
      const transitionFromId =
        trig &&
        String(trig.phase ?? "").trim() === "scene_entered" &&
        String(trig.fromRoomId ?? "").trim()
          ? String(trig.fromRoomId).trim()
          : "";
      const body = {
        provider,
        currentRoomId: roomId,
        currentRoomTitle: room?.title ?? "",
        currentScene: scene ?? "",
        currentRoomSecrets: room?.secrets ?? "",
        worldTimeMinutes,
        worldTimeLabel: formatWorldTimeLabel(worldTimeMinutes),
        roomMemory: getRoomMemory(roomId),
        transitionFromRoomMemory: transitionFromId ? String(getRoomMemory(transitionFromId) ?? "").trim() : "",
        transitionResolutionNote: String(transitionResolutionNote ?? "").trim(),
        allowedExits: Array.isArray(visibleExitsForRoom) ? visibleExitsForRoom : [],
        entities: Array.isArray(entitiesAtEntry) ? entitiesAtEntry : [],
        player: effectiveActingPlayer,
        messages: [...messagesRef.current],
        arbiterMechanicalLog: [...sceneArbiterMechanicalLogRef.current],
        rollResult,
        sourceAction: sourceAction ?? "",
        intentDecision: intentDecision ?? null,
        arbiterTrigger: arbiterTrigger ?? null,
        campaignWorldContext: worldContextOverride ?? null,
      };
      const hookPhase = String(arbiterTrigger?.phase ?? "").trim();
      const arbiterFetchMs =
        hookPhase === "combat_turn_start" || hookPhase === "combat_turn_end"
          ? GM_ARBITER_COMBAT_HOOK_FETCH_TIMEOUT_MS
          : GM_ARBITER_FETCH_TIMEOUT_MS;
      const { res, data } = await fetchJsonWithTimeout(
        "/api/gm-arbiter",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        arbiterFetchMs,
        "gm-arbiter"
      );
      if (debugMode) {
        addMessage(
          "ai",
          `[DEBUG][ENGINE_RX] JSON reçu de /api/gm-arbiter\n` +
            safeJson({
              ok: res.ok,
              status: res.status,
              roomId,
              resolution: data?.resolution ?? null,
              reason: data?.reason ?? null,
              hasRollRequest: !!data?.rollRequest,
              hasSceneUpdate: !!data?.sceneUpdate,
              hasEntityUpdates: Array.isArray(data?.entityUpdates) && data.entityUpdates.length > 0,
              requestedCampaignContext: data?.resolution === "needs_campaign_context",
              hasCrossRoomEntityUpdates:
                Array.isArray(data?.crossRoomEntityUpdates) && data.crossRoomEntityUpdates.length > 0,
              hasCrossRoomMemoryAppend:
                Array.isArray(data?.crossRoomMemoryAppend) && data.crossRoomMemoryAppend.length > 0,
              timeAdvanceMinutes:
                typeof data?.timeAdvanceMinutes === "number" && Number.isFinite(data.timeAdvanceMinutes)
                  ? Math.trunc(data.timeAdvanceMinutes)
                  : null,
              arbiterTrigger: arbiterTrigger ?? null,
              rollResultSent: rollResult ?? null,
              roomMemoryAppend: data?.roomMemoryAppend ?? null,
            }),
          "debug",
          makeMsgId()
        );
      }
      if (!res.ok) throw new Error(String(data?.error ?? data?.details ?? "gm-arbiter error"));
      const rollSentParts =
        rollResult == null
          ? "aucun"
          : String(rollResult.kind ?? "").trim() === "gm_secret"
            ? `gm_secret ${rollResult.notation}=${rollResult.total}`
            : `jet_joueur ${String(rollResult.skill ?? rollResult.stat ?? "?")} total=${rollResult.total} succès=${
                rollResult.success === true ? "oui" : rollResult.success === false ? "non" : "?"
              }`;
      pushSceneArbiterMechanicalLog(
        `gm-arbiter réponse: resolution=${String(data?.resolution ?? "?")} rollRequest.kind=${data?.rollRequest?.kind ?? "—"} | rollResult fourni dans ce POST: ${rollSentParts}`
      );
      return data;
    };

    let finalDecision = await postArbiter(rollResultOverride, campaignWorldContext);
    let rollOutcome = rollResultOverride;

    const forceRequestRollFromInconsistentDecision = (decision) => {
      if (!decision || typeof decision !== "object") return decision;
      const hasRollRequest = !!decision.rollRequest && typeof decision.rollRequest === "object";
      const resolution = String(decision.resolution ?? "").trim();
      if (!hasRollRequest || resolution === "request_roll") return decision;
      const forced = { ...decision, resolution: "request_roll" };
      addMessage(
        "ai",
        `[DEBUG] GM Arbitre incohérent: rollRequest présent avec resolution="${resolution}". Normalisation moteur -> "request_roll".`,
        "debug",
        makeMsgId()
      );
      return forced;
    };
    finalDecision = forceRequestRollFromInconsistentDecision(finalDecision);

    for (let step = 0; step < 3; step++) {
      if (finalDecision?.resolution === "needs_campaign_context") {
        let requestedScope =
          finalDecision?.campaignContextRequest?.scope === "connected_rooms"
            ? "connected_rooms"
            : "full_campaign";

        // Après un jet secret MJ résolu, `full_campaign` injecte TOUTES les salles + secrets (buildLazyCampaignWorldContext)
        // dans le corps JSON → prompts énormes et appels Gemini passant de ~10s à plusieurs minutes.
        // Pour la résolution de rencontre / conséquences, le voisinage de la salle courante suffit.
        const postGmSecretRoll =
          rollOutcome && String(rollOutcome.kind ?? "").trim() === "gm_secret";
        if (postGmSecretRoll && requestedScope === "full_campaign") {
          requestedScope = "connected_rooms";
          addMessage(
            "ai",
            `[DEBUG] GM Arbitre : needs_campaign_context full_campaign ignoré après jet secret MJ → connected_rooms (évite prompt campagne complet).`,
            "debug",
            makeMsgId()
          );
        }

        if (!campaignWorldContext || campaignContextScope !== requestedScope) {
          campaignContextScope = requestedScope;
          campaignWorldContext = buildLazyCampaignWorldContext({
            roomId,
            currentEntitiesSnapshot: entitiesAtEntry,
            trigger: arbiterTrigger ?? null,
            scope: requestedScope,
          });
          addMessage(
            "ai",
            `[DEBUG] GM Arbitre → escalade contexte campagne (${requestedScope})\n` +
              safeJson({
                roomId,
                reason:
                  finalDecision?.campaignContextRequest?.reason ??
                  finalDecision?.reason ??
                  null,
                trigger: arbiterTrigger ?? null,
                roomsCount: Array.isArray(campaignWorldContext.rooms)
                  ? campaignWorldContext.rooms.length
                  : 0,
              }),
            "debug",
            makeMsgId()
          );
        }
        finalDecision = await postArbiter(rollOutcome, campaignWorldContext);
        finalDecision = forceRequestRollFromInconsistentDecision(finalDecision);
        continue;
      }

      if (finalDecision?.resolution !== "request_roll" || !finalDecision?.rollRequest) {
        break;
      }

      const rr = finalDecision.rollRequest;

      if (rr.kind === "player_check") {
        const stat = String(rr?.stat ?? "SAG").trim().toUpperCase();
        const statOk = ["FOR", "DEX", "CON", "INT", "SAG", "CHA"].includes(stat) ? stat : "SAG";
        const skillRaw = rr?.skill != null ? String(rr.skill).trim() : "";
        const skill = skillRaw || null;
        const audienceRaw = String(rr?.audience ?? "single").trim().toLowerCase();
        let audience =
          audienceRaw === "global" ? "global" : audienceRaw === "selected" ? "selected" : "single";
        const entSetGm = buildEntityIdSetForMpRollTargetSanitize(
          entitiesAtEntry,
          multiplayerSessionId,
          multiplayerParticipantProfilesRef.current
        );
        const rawTg = Array.isArray(rr.rollTargetEntityIds) ? rr.rollTargetEntityIds : [];
        let rollTargetEntityIdsGm = [
          ...new Set(rawTg.map((x) => String(x ?? "").trim()).filter((id) => entSetGm.has(id))),
        ];
        if (audience === "selected" && rollTargetEntityIdsGm.length === 0) audience = "single";
        let dc = Number(rr?.dc);
        const stealthLike =
          !!skill &&
          statOk === "DEX" &&
          /discr[eé]tion|stealth|furtivit[eé]/i.test(skill);
        let mechanicalStealthVsHostiles = false;
        let stealthOppName = null;
        if (stealthLike) {
          if ((audience === "global" || audience === "selected") && baseGameMode === "combat") {
            const ppInfo = maxPassivePerceptionAmongHostilesForStealth(entitiesAtEntry);
            if (ppInfo.found && ppInfo.dc != null && Number.isFinite(ppInfo.dc)) {
              dc = ppInfo.dc;
              mechanicalStealthVsHostiles = true;
              stealthOppName = ppInfo.oppName;
            }
          } else if (baseGameMode === "combat") {
            const hiderId =
              String(arbiterTrigger?.actorId ?? "").trim() ||
              String(localCombatantId ?? "").trim() ||
              (effectiveActingPlayer?.id != null ? String(effectiveActingPlayer.id).trim() : "");
            if (hiderId) {
              const pp = maxOpposingPassivePerceptionForHide(hiderId);
              dc = pp.dc;
              mechanicalStealthVsHostiles = true;
              stealthOppName = pp.oppName;
            }
          } else {
            const ppInfo = maxPassivePerceptionAmongHostilesForStealth(entitiesAtEntry);
            if (ppInfo.found && ppInfo.dc != null && Number.isFinite(ppInfo.dc)) {
              dc = ppInfo.dc;
              mechanicalStealthVsHostiles = true;
              stealthOppName = ppInfo.oppName;
            }
          }
        }
        if (!Number.isFinite(dc)) dc = 10;
        const computedBonus = computeCheckBonus({
          player: effectiveActingPlayer,
          stat: statOk,
          skill,
        });
        const baseRaison = String(rr?.reason ?? "Règle du lieu").trim();
        const raisonStealth =
          mechanicalStealthVsHostiles
            ? baseGameMode === "combat"
              ? `Discrétion vs Perception passive adverse (${stealthOppName ?? "ennemis"}) — **DD ${dc}**.${baseRaison ? ` ${baseRaison}` : ""}`
              : `Discrétion vs Perception passive adverse (${stealthOppName ?? "ennemis présents"}) — **DD ${dc}** (même règle qu’en combat).${baseRaison ? ` ${baseRaison}` : ""}`
            : baseRaison || "Règle du lieu";
        const globalRaisonPrefix =
          audience === "global"
            ? "**Jet de groupe** — chaque joueur connecté lance ce test ; le MJ interprète l’ensemble des résultats. "
            : audience === "selected"
              ? "**Jet multi-PJ** — les personnages désignés lancent chacun ce test ; le MJ interprète l’ensemble des résultats. "
              : "";
        const globalRollId = `arb_global_${String(roomId ?? "").trim() || "room"}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
        const pendingCore = {
          id: globalRollId,
          kind: "check",
          stat: statOk,
          skill,
          dc,
          raison: `${globalRaisonPrefix}${raisonStealth}`,
          totalBonus: computedBonus,
          audience,
          ...(audience === "selected" ? { rollTargetEntityIds: rollTargetEntityIdsGm } : {}),
          globalRollsByClientId: audience === "global" || audience === "selected" ? {} : undefined,
          returnToArbiter: true,
          sceneArbiterContext: {
            roomId,
            scene,
            sceneName,
            sourceAction,
            baseGameMode,
            intentDecision: intentDecision ?? null,
            arbiterTrigger: arbiterTrigger ?? null,
            // Toujours enchaîner le narrateur après résolution du jet (y compris entrée `scene_entered` :
            // sinon le 2ᵉ POST gm-arbiter applique la scène mais aucun callApi — pas de prose MJ).
            narrateAfterResolution: !mechanicalStealthVsHostiles,
          },
        };
        const pendingFromSceneArbiter =
          audience === "global" || audience === "selected"
            ? pendingCore
            : stampPendingRollForActor(pendingCore, effectiveActingPlayer, clientId);
        pendingRollRef.current = pendingFromSceneArbiter;
        setPendingRoll(pendingFromSceneArbiter);
        addMessage(
          "ai",
          `[DEBUG] GM Arbitre (scène) → en attente jet joueur\n` + safeJson(pendingFromSceneArbiter),
          "debug",
          makeMsgId()
        );
        return {
          awaitingPlayerRoll: true,
          nextEntities: Array.isArray(entitiesAtEntry) ? entitiesAtEntry : [],
          nextRoomId: roomId,
          nextScene: scene,
          nextSceneName: sceneName,
          nextGameMode: baseGameMode,
          engineEvent: null,
        };
      }

      const notation = String(rr.roll ?? "").trim() || "1d100";
      if (!/^(\d+)d(\d+)$/i.test(notation)) {
        addMessage(
          "ai",
          `[DEBUG] GM Arbitre : rollRequest gm_secret invalide (attendu XdY): ${notation}`,
          "debug",
          makeMsgId()
        );
        break;
      }
      const dice = rollDiceDetailed(notation);
      if (rollOutcome && String(rollOutcome.kind ?? "").trim() !== "gm_secret") {
        appendCanonicalArbiterMechanicalMemoryForRoom(roomId, {
          phase: "after_player_roll_before_gm_secret",
          rollOutcome,
        });
      }
      rollOutcome = {
        kind: "gm_secret",
        notation,
        total: dice.total,
        rolls: dice.rolls,
      };
      pushSceneArbiterMechanicalLog(
        `Jet secret MJ tiré (moteur): ${notation} → total ${dice.total} [${dice.rolls.join("+")}] — le prochain POST arbitre enverra ce jet comme rollResult.kind=gm_secret`
      );
      addMessage(
        "ai",
        `[DEBUG] GM Arbitre (scène) → jet secret ${notation} [${dice.rolls.join("+")}] = **${dice.total}** → 2e appel /api/gm-arbiter avec rollResult`,
        "debug",
        makeMsgId()
      );
      finalDecision = await postArbiter(rollOutcome, campaignWorldContext);
      finalDecision = forceRequestRollFromInconsistentDecision(finalDecision);
    }

    let nextEntities = Array.isArray(entitiesAtEntry) ? entitiesAtEntry : [];
    let nextRoomId = roomId;
    let nextScene = scene;
    let nextSceneName = sceneName;
    let nextGameMode = baseGameMode;
    // Les entityUpdates d'une même résolution d'arbitre s'appliquent toujours à la salle **courante**
    // (où se trouve le groupe). Ne pas les résoudre sur la salle cible d'un sceneUpdate : sinon des
    // rencontres « en chemin » ou avant le seuil se retrouvent dans la pièce d'arrivée par erreur.
    const entitiesBaseForPlannedUpdates = nextEntities;

    const plannedUpdatesRaw = Array.isArray(finalDecision?.entityUpdates) ? finalDecision.entityUpdates : [];
    const hookPhase = String(arbiterTrigger?.phase ?? "").trim();
    const plannedUpdates =
      hookPhase === "combat_turn_start" || hookPhase === "combat_turn_end"
        ? plannedUpdatesRaw.filter((u) => {
            if (!u || typeof u !== "object") return false;
            if (String(u.action ?? "update").trim() !== "update") return true;
            if (!Object.prototype.hasOwnProperty.call(u, "surprised")) return true;
            if (u.surprised !== true) return true;
            const uid = String(u.id ?? "").trim();
            if (!uid) return true;
            const cur = (Array.isArray(entitiesBaseForPlannedUpdates) ? entitiesBaseForPlannedUpdates : []).find(
              (e) => String(e?.id ?? "").trim() === uid
            );
            // Hooks de tour combat : ne jamais réarmer `surprised:true` une fois consommé.
            // Sinon un PNJ peut être re-surpris en boucle à chaque sync/tour joueur.
            if (cur && cur.isAlive === true && cur.surprised === false) {
              if (debugMode) {
                addMessage(
                  "ai",
                  `[DEBUG] GM Arbitre ignoré (hook combat) : réapplication interdite de surprised=true sur ${cur.name ?? uid}.`,
                  "debug",
                  makeMsgId()
                );
              }
              return false;
            }
            return true;
          })
        : plannedUpdatesRaw;
    const plannedEntitiesAfterLocalUpdates = plannedUpdates.length
      ? applyUpdatesLocally(entitiesBaseForPlannedUpdates, plannedUpdates)
      : entitiesBaseForPlannedUpdates;
    const willSpawnHostile = plannedUpdates.some((u) => {
      if (!u || typeof u !== "object") return false;
      if (u.action !== "spawn") return false;
      const t = String(u.type ?? "").trim().toLowerCase();
      return t === "hostile";
    });
    const willHaveCombatReadyHostiles = hasAnyCombatReadyHostile(plannedEntitiesAfterLocalUpdates);
    const willSwitchToCombat = finalDecision?.gameMode === "combat" && willHaveCombatReadyHostiles;
    const crossRoomEntityOps =
      Array.isArray(finalDecision?.crossRoomEntityUpdates) &&
      finalDecision.crossRoomEntityUpdates.length > 0;
    // Ne verrouiller l'initiative que si cet appel arbitre applique réellement des changements de scène.
    // Sinon un 2e passage (ex. même jet Investigation après spawns déjà posés) réarme wait sans nouveau
    // callApi narrateur → bandeau initiative masqué et saisie bloquée indéfiniment.
    const hasMechanicalSceneUpdates = plannedUpdates.length > 0 || crossRoomEntityOps;
    // Ordre strict demandé :
    // narration d'abord, puis bannière/jet d'initiative.
    // On verrouille donc l'initiative AVANT d'appliquer les conséquences de scène qui ouvrent le combat.
    if (
      hasMechanicalSceneUpdates &&
      (willSwitchToCombat || (willSpawnHostile && willHaveCombatReadyHostiles)) &&
      (combatOrder?.length ?? 0) === 0
    ) {
      waitForGmNarrationForInitiativeLiveRef.current = true;
      setWaitForGmNarrationForInitiative(true);
    }

    const updates = plannedUpdates;
    if (updates.length) {
      nextEntities = plannedEntitiesAfterLocalUpdates;
      applyEntityUpdates(updates);
      if ((nextGameMode === "combat" || gameStateRef.current?.gameMode === "combat") && combatOrder.length > 0) {
        const spawnedIds = updates
          .filter((u) => u && typeof u === "object" && u.action === "spawn")
          .map((u) => String(u.id ?? "").trim())
          .filter(Boolean);
        if (spawnedIds.length > 0) {
          const spawnedEntities = nextEntities.filter((ent) => spawnedIds.includes(ent.id));
          insertSpawnedCombatantsIntoInitiative(spawnedEntities, {
            anchorActorId: arbiterTrigger?.actorId ?? null,
          });
        }
      }
    }

    nextEntities = applyCrossRoomConsequences({
      activeRoomId: nextRoomId,
      activeEntities: nextEntities,
      crossRoomEntityUpdates: finalDecision?.crossRoomEntityUpdates ?? null,
      crossRoomMoves: finalDecision?.crossRoomMoves ?? null,
      crossRoomMemoryAppend: finalDecision?.crossRoomMemoryAppend ?? null,
    });

    const sUp = finalDecision?.sceneUpdate;
    const sceneEnteredWithoutExplicitTransitionIntent =
      arbiterTrigger?.phase === "scene_entered" &&
      !(intentDecision?.sceneUpdate?.hasChanged === true);
    const roomBeforeSceneUpdate = nextRoomId;
    if (
      !sceneEnteredWithoutExplicitTransitionIntent &&
      sUp?.hasChanged &&
      typeof sUp?.targetRoomId === "string"
    ) {
      const tid = sUp.targetRoomId.trim();
      const tRoom = tid && GOBLIN_CAVE[tid] ? GOBLIN_CAVE[tid] : null;
      if (tRoom) {
        const isSameRoomTransition = tid === nextRoomId;
        if (!isSameRoomTransition) {
          // IMPORTANT:
          // - `nextEntities` contient l'état le plus récent de la salle source (entityUpdates + cross-room déjà appliqués).
          // - on doit snapshot CET état côté salle source avant de changer de room.
          // Utiliser `sourceRoomEntitiesBeforeTransition` (pré-updates) perdait ces changements
          // et la logique ci-dessous pouvait ensuite "embarquer" les entités source dans la salle cible.
          rememberRoomEntitiesSnapshot(nextRoomId, nextEntities);
        }
        nextRoomId = tid;
        nextScene = tRoom.description ?? nextScene;
        nextSceneName = tRoom.title ?? nextSceneName;
        if (!isSameRoomTransition) {
          // Un sceneUpdate change de salle: les entités actives deviennent celles de la salle cible.
          // Garder `nextEntities` (salle source) ici provoque un "TP" visuel/métier des créatures.
          nextEntities = takeEntitiesForRoom(tid);
        }

        setCurrentRoomId(nextRoomId);
        if (nextSceneName) setCurrentSceneName(nextSceneName);
        if (nextScene) setCurrentScene(nextScene);
        if (!isSameRoomTransition) {
          replaceEntities(nextEntities);
        }
      }
    }

    let appliedTimeAdvanceMinutes = 0;
    let nextWorldTimeLabel = null;
    let resolvedWorldTimeMinutes =
      typeof gameStateRef.current?.worldTimeMinutes === "number" &&
      Number.isFinite(gameStateRef.current.worldTimeMinutes)
        ? gameStateRef.current.worldTimeMinutes
        : worldTimeMinutes;
    if (
      typeof finalDecision?.timeAdvanceMinutes === "number" &&
      Number.isFinite(finalDecision.timeAdvanceMinutes)
    ) {
      const clamped = Math.max(0, Math.min(1440, Math.trunc(finalDecision.timeAdvanceMinutes)));
      if (clamped > 0) {
        const nextMinute = advanceWorldClock(clamped);
        resolvedWorldTimeMinutes = nextMinute;
        appliedTimeAdvanceMinutes = clamped;
        nextWorldTimeLabel = formatWorldTimeLabel(nextMinute);
      }
    }

    // IMPORTANT: après un sceneUpdate (changement de salle), rappeler immédiatement l'arbitre
    // sur la NOUVELLE salle avant narration, afin qu'il puisse spawner/appliquer les règles
    // de la pièce d'arrivée (en se basant sur description+secrets+mémoires).
    if (
      reentryDepth < 1 &&
      nextRoomId &&
      roomBeforeSceneUpdate &&
      nextRoomId !== roomBeforeSceneUpdate
    ) {
      const priorResOut = String(finalDecision?.resolution ?? "").trim();
      const priorEngineDetailsRaw =
        typeof finalDecision?.engineEvent?.details === "string"
          ? finalDecision.engineEvent.details.trim()
          : "";
      const priorRoomMem =
        typeof finalDecision?.roomMemoryAppend === "string"
          ? finalDecision.roomMemoryAppend.trim()
          : "";
      // Sinon jamais exécuté : le return ci-dessous sautait l'append de fin de fonction.
      if (
        (priorResOut === "apply_consequences" || priorResOut === "no_roll_needed") &&
        priorRoomMem
      ) {
        appendRoomMemory(roomId, priorRoomMem.slice(0, 400));
      }

      if (roomBeforeSceneUpdate && nextRoomId !== roomBeforeSceneUpdate) {
        appendCanonicalArbiterMechanicalMemoryForRoom(roomBeforeSceneUpdate, {
          finalDecision,
          rollOutcome,
          appliedTimeAdvanceMinutes,
        });
      }

      let innerResult = null;
      try {
        innerResult = await runSceneEntryGmArbiterInner({
          roomId: nextRoomId,
          scene: nextScene,
          sceneName: nextSceneName,
          entitiesAtEntry: nextEntities,
          sourceAction: `[SceneEntered] ${nextRoomId}`,
          baseGameMode: nextGameMode,
          rollResultOverride: null,
          intentDecision: {
            resolution: "trivial_success",
            reason: `Entrée dans ${nextRoomId}`,
            sceneUpdate: null,
          },
          arbiterTrigger: {
            phase: "scene_entered",
            fromRoomId: roomBeforeSceneUpdate,
            toRoomId: nextRoomId,
          },
          reentryDepth: reentryDepth + 1,
          transitionResolutionNote:
            rollOutcome && String(rollOutcome.kind ?? "").trim() === "gm_secret"
              ? `Jet secret MJ déjà résolu pour le lieu d'origine avant cette entrée (notation ${String(
                  rollOutcome.notation ?? ""
                ).trim()}, résultat ${rollOutcome.total}).`
              : null,
        });
      } catch (e) {
        // Sécurité: si le 2e passage [SceneEntered] échoue, ne pas bloquer la résolution du jet.
        // On conserve la transition déjà validée par l'arbitre initial et on laisse la narration continuer.
        addMessage(
          "ai",
          `[DEBUG] GM Arbitre [SceneEntered] échoué après sceneUpdate; fallback sur la résolution déjà appliquée: ${String(
            e?.message ?? e
          )}`,
          "debug",
          makeMsgId()
        );
        innerResult = {
          nextEntities,
          nextRoomId,
          nextScene,
          nextSceneName,
          nextGameMode,
          arbiterResolution: priorResOut || "apply_consequences",
          engineEvent:
            finalDecision?.engineEvent && typeof finalDecision.engineEvent === "object"
              ? finalDecision.engineEvent
              : {
                  kind: "scene_rule_resolution",
                  details: priorEngineDetailsRaw || null,
                },
          shouldNarrateResolution: true,
          awaitingPlayerRoll: false,
        };
      }

      // Le second passage [SceneEntered] renvoie souvent no_roll_needed sans détails ; la narration
      // du joueur (ex. porte enfoncée) était pourtant dans la résolution précédente — on la conserve.
      const innerDetails =
        typeof innerResult?.engineEvent?.details === "string"
          ? innerResult.engineEvent.details.trim()
          : "";
      if (
        priorResOut === "apply_consequences" &&
        priorEngineDetailsRaw &&
        (!innerDetails || innerDetails.length < 40)
      ) {
        const baseEv =
          innerResult?.engineEvent && typeof innerResult.engineEvent === "object"
            ? innerResult.engineEvent
            : {};
        const mergedEngine = {
          ...baseEv,
          kind: "scene_rule_resolution",
          details: priorEngineDetailsRaw,
          roomId: innerResult.nextRoomId ?? baseEv.roomId,
        };
        return {
          ...innerResult,
          engineEvent: mergedEngine,
          shouldNarrateResolution: shouldNarrateArbiterOutcome({
            phase: baseEv.arbiterTrigger?.phase ?? null,
            resolution: innerResult.arbiterResolution,
            engineEvent: mergedEngine,
          }),
        };
      }

      return innerResult;
    }

    if (finalDecision?.gameMode === "combat" || finalDecision?.gameMode === "exploration") {
      // Faire confiance au mode renvoyé par l'arbitre : l'ancien test
      // `combat && !hasAnyCombatReadyHostile → exploration` laissait le jeu en exploration
      // alors que l'initiative / le tour ennemi avaient déjà commencé (awareness / sync en retard).
      nextGameMode = finalDecision.gameMode;
      setGameMode(nextGameMode);
    }
    const arbiterExplicitGameMode =
      finalDecision?.gameMode === "combat" || finalDecision?.gameMode === "exploration";
    const hadArbiterEntityUpdates =
      Array.isArray(finalDecision?.entityUpdates) && finalDecision.entityUpdates.length > 0;
    ensureCombatState(nextEntities, null, {
      skipEmptyRoomCombatCleanup:
        rollOutcome != null && !arbiterExplicitGameMode && !hadArbiterEntityUpdates,
    });

    gameStateRef.current = {
      ...gameStateRef.current,
      currentRoomId: nextRoomId,
      currentScene: nextScene,
      currentSceneName: nextSceneName,
      entities: nextEntities,
      gameMode: nextGameMode,
      worldTimeMinutes: resolvedWorldTimeMinutes,
    };

    const resOut = String(finalDecision?.resolution ?? "").trim();
    const explicitRoomMemory =
      typeof finalDecision?.roomMemoryAppend === "string"
        ? finalDecision.roomMemoryAppend.trim()
        : "";
    const arbiterDetails = explicitRoomMemory ? explicitRoomMemory.slice(0, 400) : "";
    const defaultEngineEventKind =
      arbiterTrigger?.phase === "scene_entered" ? "scene_transition" : "scene_rule_resolution";
    const resolvedEngineEventKind =
      typeof finalDecision?.engineEvent?.kind === "string" && finalDecision.engineEvent.kind.trim()
        ? finalDecision.engineEvent.kind.trim()
        : defaultEngineEventKind;
    const narratorSafeReason = narratorSafeArbiterReason(
      resolvedEngineEventKind,
      resOut,
      finalDecision?.reason ?? null,
      arbiterDetails
    );

    const engineEvent =
      finalDecision?.engineEvent && typeof finalDecision.engineEvent === "object"
        ? {
            ...finalDecision.engineEvent,
            kind: resolvedEngineEventKind,
            roomId: nextRoomId,
            reason: narratorSafeReason,
            details:
              typeof finalDecision.engineEvent.details === "string" &&
              finalDecision.engineEvent.details.trim()
                ? finalDecision.engineEvent.details.trim()
                : arbiterDetails || null,
            rollResult: rollOutcome,
            arbiterTrigger: arbiterTrigger ?? null,
            ...(appliedTimeAdvanceMinutes > 0
              ? {
                  timeAdvanceMinutes: appliedTimeAdvanceMinutes,
                  worldTimeLabel: nextWorldTimeLabel,
                }
              : {}),
          }
        : {
            kind: resolvedEngineEventKind,
            roomId: nextRoomId,
            reason: narratorSafeReason,
            details: arbiterDetails || null,
            rollResult: rollOutcome,
            arbiterTrigger: arbiterTrigger ?? null,
            ...(appliedTimeAdvanceMinutes > 0
              ? {
                  timeAdvanceMinutes: appliedTimeAdvanceMinutes,
                  worldTimeLabel: nextWorldTimeLabel,
                }
              : {}),
          };
    if (resOut === "apply_consequences" || resOut === "no_roll_needed") {
      const memLine = explicitRoomMemory ? explicitRoomMemory.slice(0, 400) : "";
      if (memLine) appendRoomMemory(roomId, memLine);
      appendCanonicalArbiterMechanicalMemoryForRoom(roomId, {
        finalDecision,
        rollOutcome,
        appliedTimeAdvanceMinutes,
      });
    }

    return {
      nextEntities,
      nextRoomId,
      nextScene,
      nextSceneName,
      nextGameMode,
      arbiterResolution: resOut,
      engineEvent,
      shouldNarrateResolution: shouldNarrateArbiterOutcome({
        phase: arbiterTrigger?.phase ?? null,
        resolution: resOut,
        engineEvent,
      }),
      awaitingPlayerRoll: false,
    };
  }

  async function runSceneEntryGmArbiter(params) {
    const prev = sceneArbiterQueueTailRef.current;
    let release;
    const next = new Promise((r) => {
      release = r;
    });
    sceneArbiterQueueTailRef.current = prev.then(() => next);
    await prev;
    try {
      return await runSceneEntryGmArbiterInner(params);
    } finally {
      release();
    }
  }
  runSceneEntryGmArbiterRef.current = runSceneEntryGmArbiter;

  /**
   * MP — jet de compétence arbitre `audience: global|selected` : une seule dépendance primitive (longueur stable),
   * évite l'erreur React « useEffect changed size between renders » (HMR / évolutions du tableau de deps).
   */
  const globalMpGroupArbiterTriggerKey = useMemo(() => {
    if (!multiplayerSessionId) return "";
    const pr = pendingRoll;
    if (!pr || typeof pr !== "object") return "";
    if (
      pr.kind !== "check" ||
      (pr.audience !== "global" && pr.audience !== "selected") ||
      pr.returnToArbiter !== true
    ) {
      return "";
    }
    const ctx = pr.sceneArbiterContext;
    if (!ctx || typeof ctx !== "object") return "";
    const expected = getGroupSkillCheckExpectedClientIds(
      multiplayerSessionId,
      multiplayerParticipantProfilesRef.current,
      clientId,
      pr
    );
    const map =
      pr.globalRollsByClientId && typeof pr.globalRollsByClientId === "object"
        ? pr.globalRollsByClientId
        : {};
    if (!expected.length || !expected.every((eid) => map[eid] != null)) return "";
    if (
      !shouldRunGlobalArbiterFollowup({
        multiplayerSessionId,
        clientId,
        hostClientId: multiplayerHostClientId,
        expectedClientIds: expected,
      })
    ) {
      return "";
    }
    const rid = String(pr.id ?? "").trim();
    if (!rid) return "";
    const rolloutSummary = expected
      .map((eid) => {
        const v = map[eid];
        if (v == null) return `${eid}:x`;
        const tot = typeof v.total === "number" && Number.isFinite(v.total) ? Math.trunc(v.total) : "";
        const ok = v.success === true ? "1" : v.success === false ? "0" : "?";
        return `${eid}:${tot}:${ok}`;
      })
      .join(";");
    return `${rid}|${rolloutSummary}|${debugMode ? "1" : "0"}|${String(gameMode ?? "")}`;
  }, [
    multiplayerSessionId,
    pendingRoll,
    multiplayerParticipantProfilesRollGateKey,
    clientId,
    multiplayerHostClientId,
    debugMode,
    gameMode,
  ]);

  useEffect(() => {
    if (!globalMpGroupArbiterTriggerKey) return;
    const pr = pendingRollRef.current;
    if (
      !pr ||
      pr.kind !== "check" ||
      (pr.audience !== "global" && pr.audience !== "selected") ||
      pr.returnToArbiter !== true
    ) {
      return;
    }
    const ctx = pr.sceneArbiterContext;
    if (!ctx || typeof ctx !== "object") return;
    const map =
      pr.globalRollsByClientId && typeof pr.globalRollsByClientId === "object"
        ? pr.globalRollsByClientId
        : {};
    const rid = String(pr.id ?? "").trim();
    if (!rid) return;
    if (globalSkillGroupArbiterResolvedIdsRef.current.has(rid)) return;
    globalSkillGroupArbiterResolvedIdsRef.current.add(rid);

    (async () => {
      try {
        setIsTyping(true);
        const rollOutcome = buildGlobalPlayerCheckGroupRollOutcome({
          roll: pr,
          globalRollsByClientId: map,
          dc: typeof pr.dc === "number" ? pr.dc : null,
        });
        const nextEntities = Array.isArray(gameStateRef.current?.entities)
          ? gameStateRef.current.entities
          : [];
        const skillLabel = pr.skill ? `${pr.skill} (groupe)` : String(pr.stat ?? "");
        const resolved = await runSceneEntryGmArbiterRef.current({
          roomId: ctx.roomId,
          scene: ctx.scene,
          sceneName: ctx.sceneName,
          entitiesAtEntry: nextEntities,
          sourceAction: ctx.sourceAction,
          baseGameMode: ctx.baseGameMode ?? gameStateRef.current?.gameMode ?? gameMode,
          rollResultOverride: rollOutcome,
          intentDecision: ctx.intentDecision ?? null,
          arbiterTrigger: ctx.arbiterTrigger ?? null,
        });
        if (resolved?.awaitingPlayerRoll === true) {
          globalSkillGroupArbiterResolvedIdsRef.current.delete(rid);
          setIsTyping(false);
          return;
        }
        pendingRollRef.current = null;
        setPendingRoll(null);
        const gmMode = gameStateRef.current?.gameMode ?? gameMode;
        const enrichedEngineEvent =
          resolved.engineEvent && typeof resolved.engineEvent === "object"
            ? {
                ...resolved.engineEvent,
                playerSkillRoll: {
                  skillLabel,
                  group: true,
                  summary: rollOutcome.summary,
                  byClientId: rollOutcome.byClientId,
                },
              }
            : {
                kind: "scene_rule_resolution",
                reason: resolved?.reason ?? null,
                playerSkillRoll: {
                  skillLabel,
                  group: true,
                  summary: rollOutcome.summary,
                  byClientId: rollOutcome.byClientId,
                },
              };
        if (ctx.narrateAfterResolution !== false) {
          await callApi(ctx.sourceAction ?? "", "meta", false, {
            skipSessionLock: true,
            hideUserMessage: true,
            bypassIntentParser: true,
            skipAutoPlayerTurn: true,
            skipGmContinue: true,
            entities: resolved.nextEntities,
            currentRoomId: resolved.nextRoomId,
            currentScene: resolved.nextScene,
            currentSceneName: resolved.nextSceneName,
            gameMode: resolved.nextGameMode ?? gmMode,
            engineEvent: enrichedEngineEvent,
          });
        } else if (debugMode) {
          const visibleReason = String(enrichedEngineEvent?.reason ?? "").trim();
          if (visibleReason) {
            addMessage("ai", visibleReason, "meta-reply", makeMsgId());
          }
          setIsTyping(false);
        } else {
          setIsTyping(false);
        }
      } catch (e) {
        globalSkillGroupArbiterResolvedIdsRef.current.delete(rid);
        setIsTyping(false);
        addMessage(
          "ai",
          `[DEBUG] Erreur GM Arbitre (jet de groupe) : ${String(e?.message ?? e)}`,
          "debug",
          makeMsgId()
        );
      } finally {
        if (multiplayerSessionId) {
          try {
            await flushMultiplayerSharedState();
          } catch {
            /* ignore */
          }
        }
      }
    })();
  }, [globalMpGroupArbiterTriggerKey]);

  function isPurelyProceduralNarratorReason(text) {
    const t = String(text ?? "").trim().toLowerCase();
    if (!t) return false;
    return (
      /(déjà\s+(répondu|traité|décrit|dit|annoncé|précisé|expliqué)|deja\s+(repondu|traite|decrit|dit|annonce|precise|explique)|sans\s+nouvelle\s+mécanique|aucune\s+nouvelle\s+mécanique)/i.test(
        t
      ) ||
      /aucun secret|aucun piège|aucun piege|aucune regle|aucune règle|n'est déclenché|n'est declenche|pas de piège|pas de piege/.test(t) ||
      (/le joueur se déplace|le personnage se déplace|se dirige vers|approche|sans la franchir/.test(t) &&
        !/découvre|decouvre|révèle|revele|ouvre|entre dans|apparait|apparaît|trouve|voit|aperçoit/.test(t))
    );
  }

  function narratorSafeArbiterReason(kind, resolution, reason, details) {
    const cleanReason = typeof reason === "string" && reason.trim() ? reason.trim() : null;
    const cleanDetails = typeof details === "string" && details.trim() ? details.trim() : null;
    if (!cleanReason) return null;
    if (kind === "scene_transition" && resolution === "no_roll_needed") {
      return cleanDetails ? cleanReason : null;
    }
    if (kind !== "scene_rule_resolution") return cleanReason;
    if (cleanDetails) return cleanReason;
    if (resolution === "no_roll_needed" && isPurelyProceduralNarratorReason(cleanReason)) return null;
    return cleanReason;
  }

function shouldNarrateArbiterOutcome({ phase = null, resolution = null, engineEvent = null }) {
    const cleanPhase = String(phase ?? "").trim();
    const cleanResolution = String(resolution ?? "").trim();
    const kind = String(engineEvent?.kind ?? "").trim();
    const details = typeof engineEvent?.details === "string" ? engineEvent.details.trim() : "";
    const reason = typeof engineEvent?.reason === "string" ? engineEvent.reason.trim() : "";

    if (kind === "gm_secret_resolution") return false;

    if (cleanPhase === "combat_turn_end") {
      return false;
    }

  if (cleanPhase === "combat_turn_start") {
    // Les hooks de début de tour combat sont mécaniques (états, auras, ajustements, etc.).
    // Narrer ici crée du bruit et des doublons visibles "avant/après" les fins de tour.
    // On conserve donc ces résolutions côté moteur, sans narration GM automatique.
    return false;
  }

    return !!details || !!reason;
  }

  async function runCombatTurnStartArbiter({
    actorId,
    actorName,
    actorType = null,
  }) {
    const latest = gameStateRef.current ?? {};
    const activeRoomId = latest.currentRoomId ?? currentRoomId;
    if (!activeRoomId || activeRoomId === "scene_journey") {
      return { awaitingPlayerRoll: false };
    }

    const activeScene = latest.currentScene ?? currentScene;
    const activeSceneName = latest.currentSceneName ?? currentSceneName;
    const activeEntities = Array.isArray(latest.entities) ? latest.entities : entities;
    const trigger = {
      phase: "combat_turn_start",
      actorId: actorId ?? null,
      actorName: actorName ?? null,
      actorType: actorType ?? null,
      turnIndex: combatTurnIndexLiveRef.current,
    };
    const sourceAction = `[COMBAT_TURN_START] ${actorName ?? actorId ?? "unknown"} (${actorId ?? "unknown"})`;

    try {
      const resolved = await runSceneEntryGmArbiter({
        roomId: activeRoomId,
        scene: activeScene,
        sceneName: activeSceneName,
        entitiesAtEntry: activeEntities,
        sourceAction,
        baseGameMode: "combat",
        intentDecision: {
          resolution: "combat_turn_start",
          reason: `Début de tour de ${actorName ?? actorId ?? "inconnu"}`,
        },
        arbiterTrigger: trigger,
      });
      if (resolved?.awaitingPlayerRoll === true) {
        return resolved;
      }
      const eventDetails =
        typeof resolved?.engineEvent?.details === "string" ? resolved.engineEvent.details.trim() : "";
      const eventReason =
        typeof resolved?.engineEvent?.reason === "string" ? resolved.engineEvent.reason.trim() : "";
      if (resolved?.shouldNarrateResolution === true && (eventDetails || eventReason)) {
        await callApi("", "meta", false, {
          hideUserMessage: true,
          bypassIntentParser: true,
          skipSessionLock: true,
          skipAutoPlayerTurn: true,
          skipGmContinue: true,
          entities: resolved?.nextEntities ?? activeEntities,
          currentRoomId: resolved?.nextRoomId ?? activeRoomId,
          currentScene: resolved?.nextScene ?? activeScene,
          currentSceneName: resolved?.nextSceneName ?? activeSceneName,
          gameMode: resolved?.nextGameMode ?? "combat",
          engineEvent: resolved?.engineEvent ?? null,
        });
      }
      const visibleReason = String(resolved?.engineEvent?.reason ?? resolved?.reason ?? "").trim();
      if (debugMode && visibleReason) {
        addMessage("ai", visibleReason, "meta-reply", makeMsgId());
      }
      return resolved;
    } catch (e) {
      addMessage(
        "ai",
        `[DEBUG] Erreur arbitre début de tour combat : ${String(e?.message ?? e)}`,
        "debug",
        makeMsgId()
      );
      return { awaitingPlayerRoll: false };
    }
  }

  async function runCombatTurnEndArbiter({
    actorId,
    actorName,
    actorType = null,
  }) {
    const latest = gameStateRef.current ?? {};
    const activeRoomId = latest.currentRoomId ?? currentRoomId;
    if (!activeRoomId || activeRoomId === "scene_journey") {
      return { awaitingPlayerRoll: false };
    }

    const activeScene = latest.currentScene ?? currentScene;
    const activeSceneName = latest.currentSceneName ?? currentSceneName;
    const activeEntities = Array.isArray(latest.entities) ? latest.entities : entities;
    const trigger = {
      phase: "combat_turn_end",
      actorId: actorId ?? null,
      actorName: actorName ?? null,
      actorType: actorType ?? null,
      turnIndex: combatTurnIndexLiveRef.current,
    };
    const sourceAction = `[COMBAT_TURN_END] ${actorName ?? actorId ?? "unknown"} (${actorId ?? "unknown"})`;

    try {
      const resolved = await runSceneEntryGmArbiter({
        roomId: activeRoomId,
        scene: activeScene,
        sceneName: activeSceneName,
        entitiesAtEntry: activeEntities,
        sourceAction,
        baseGameMode: "combat",
        intentDecision: {
          resolution: "combat_turn_end",
          reason: `Fin de tour de ${actorName ?? actorId ?? "inconnu"}`,
        },
        arbiterTrigger: trigger,
      });
      if (resolved?.awaitingPlayerRoll === true) {
        return resolved;
      }
      const eventDetails =
        typeof resolved?.engineEvent?.details === "string" ? resolved.engineEvent.details.trim() : "";
      const eventReason =
        typeof resolved?.engineEvent?.reason === "string" ? resolved.engineEvent.reason.trim() : "";
      if (resolved?.shouldNarrateResolution === true && (eventDetails || eventReason)) {
        await callApi("", "meta", false, {
          hideUserMessage: true,
          bypassIntentParser: true,
          skipSessionLock: true,
          skipAutoPlayerTurn: true,
          skipGmContinue: true,
          entities: resolved?.nextEntities ?? activeEntities,
          currentRoomId: resolved?.nextRoomId ?? activeRoomId,
          currentScene: resolved?.nextScene ?? activeScene,
          currentSceneName: resolved?.nextSceneName ?? activeSceneName,
          gameMode: resolved?.nextGameMode ?? "combat",
          engineEvent: resolved?.engineEvent ?? null,
        });
      }
      const visibleReason = String(resolved?.engineEvent?.reason ?? resolved?.reason ?? "").trim();
      if (debugMode && visibleReason) {
        addMessage("ai", visibleReason, "meta-reply", makeMsgId());
      }
      return resolved;
    } catch (e) {
      addMessage(
        "ai",
        `[DEBUG] Erreur arbitre fin de tour combat : ${String(e?.message ?? e)}`,
        "debug",
        makeMsgId()
      );
      return { awaitingPlayerRoll: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Appel API principal
  // ---------------------------------------------------------------------------
  async function callApi(userContent, msgType, isDebug = false, overrides = null) {
    if (flowBlockedRef.current && !overrides?.bypassFailureLock) return;
    let sessionLockId = null;
    const shouldAcquireSessionLock =
      !overrides?.skipSessionLock &&
      apiProcessingDepthRef.current === 0;
    const snap = gameStateRef.current;
    const actingPlayer = overrides?.actingPlayer ?? snap.player ?? player;
    const rollSubmitterClientId =
      overrides?.commandSubmitterClientId != null && String(overrides.commandSubmitterClientId).trim()
        ? String(overrides.commandSubmitterClientId).trim()
        : clientId ?? null;
    /** MP : mêlée / ressources du tour pour le joueur qui agit (soumetteur), pas l'onglet hôte qui exécute callApi. */
    const actingMeleeCombatantId =
      multiplayerSessionId && rollSubmitterClientId
        ? `mp-player-${String(rollSubmitterClientId).trim()}`
        : "player";
    /** MP : ressources du tour du soumetteur (snapshot), sinon état local du résolveur. */
    const normalizeTrSnap = (raw) => {
      if (!raw || typeof raw !== "object") return null;
      return {
        action: !!raw.action,
        bonus: !!raw.bonus,
        reaction: !!raw.reaction,
        movement:
          typeof raw.movement === "boolean" ? raw.movement : Number(raw.movement) > 0,
      };
    };
    const turnResourcesForResolve = normalizeTrSnap(overrides?.turnResourcesSnapshot);
    const baseEntities = overrides?.entities ?? snap.entities;
    const baseGameMode = overrides?.gameMode ?? snap.gameMode;
    const baseCombatOrder = snap.combatOrder ?? [];
    const engineEvent  = overrides?.engineEvent ?? null;
    const baseScene    = overrides?.currentScene ?? snap.currentScene;
    const baseRoomId   = overrides?.currentRoomId ?? snap.currentRoomId;
    // File d’attente client + verrou session : en principe les jets et le MJ sont sérialisés ; garde-fou
    // si un callApi « prose » fantôme passe encore (latence, skipSessionLock, autre onglet).
    // On coupe les scene_rule_resolution sans jet résolu ni rollResult moteur pendant un d20 en cours.
    if (
      rollResolutionInProgressRef.current &&
      msgType === "meta" &&
      engineEvent &&
      typeof engineEvent === "object" &&
      String(engineEvent.kind ?? "").trim() === "scene_rule_resolution" &&
      engineEvent.playerSkillRoll == null &&
      (engineEvent.rollResult === undefined || engineEvent.rollResult === null)
    ) {
      return;
    }
    const skipAutoPlayerTurn = overrides?.skipAutoPlayerTurn === true;
    const skipGmContinue = overrides?.skipGmContinue === true;
    const hideUserMessage = overrides?.hideUserMessage === true;
    const preexistingUserMessage = overrides?.preexistingUserMessage === true;
    /** Si true : la réponse /api/chat ne doit pas enchaîner arbitre → [SceneRulesResolved] (déjà fait dans processArbiterDecision après parse-intent). */
    const skipSceneRulesResolvedPipeline = overrides?.skipSceneRulesResolvedPipeline === true;
    const isNaturalCall = !msgType && !isDebug;
    const naturalNormText = String(userContent ?? "").trim().toLowerCase();
    const naturalSubmitterKey = String(rollSubmitterClientId ?? clientId ?? "").trim();
    const naturalParserReplayKey =
      isNaturalCall && naturalNormText
        ? `${naturalNormText}|${String(baseRoomId ?? "")}|${String(baseGameMode ?? "")}|${naturalSubmitterKey}`
        : null;
    let naturalCallKey = null;
    if (isNaturalCall && !hideUserMessage && !preexistingUserMessage) {
      if (naturalNormText) {
        naturalCallKey = `${naturalNormText}|${String(baseRoomId ?? "")}|${String(baseGameMode ?? "")}`;
        if (naturalCallInFlightKeysRef.current.has(naturalCallKey)) {
          addMessage(
            "ai",
            `[DEBUG] callApi dupliqué ignoré (in-flight): ${safeJson({
              roomId: baseRoomId,
              gameMode: baseGameMode,
              text: String(userContent ?? "").slice(0, 140),
            })}`,
            "debug",
            makeMsgId()
          );
          return;
        }
        naturalCallInFlightKeysRef.current.add(naturalCallKey);
      }
    }
    const bypassIntentParser = overrides?.bypassIntentParser === true;
    const forceIntentParser = overrides?.forceIntentParser === true;
    if (!msgType && !isDebug && !hideUserMessage) {
      lastNaturalPlayerInputRef.current = String(userContent ?? "");
    }
    if (isNaturalCall && hideUserMessage && preexistingUserMessage) {
      const now = Date.now();
      const priorAnyNaturalAt = naturalParserReplayKey
        ? recentNaturalParserCallsRef.current.get(naturalParserReplayKey) ?? 0
        : 0;
      if (naturalParserReplayKey && now - priorAnyNaturalAt < 90_000) {
        addMessage(
          "ai",
          `[DEBUG] Parse-intent dupliqué bloqué (replay caché): ${safeJson({
            roomId: baseRoomId,
            gameMode: baseGameMode,
            text: String(userContent ?? "").slice(0, 140),
          })}`,
          "debug",
          makeMsgId()
        );
        setIsTyping(false);
        await releaseMultiplayerProcessingLock(sessionLockId);
        if (naturalCallKey) naturalCallInFlightKeysRef.current.delete(naturalCallKey);
        return;
      }
      const replayKey =
        `${String(userContent ?? "").trim().toLowerCase()}|` +
        `${String(baseRoomId ?? "")}|${String(baseGameMode ?? "")}|` +
        `${String(clientId ?? "")}`;
      const prev = recentHiddenNaturalReplayRef.current.get(replayKey) ?? 0;
      if (now - prev < 90_000) {
        addMessage(
          "ai",
          `[DEBUG] Replay caché dupliqué ignoré: ${safeJson({
            roomId: baseRoomId,
            gameMode: baseGameMode,
            text: String(userContent ?? "").slice(0, 140),
          })}`,
          "debug",
          makeMsgId()
        );
        setIsTyping(false);
        await releaseMultiplayerProcessingLock(sessionLockId);
        if (naturalCallKey) naturalCallInFlightKeysRef.current.delete(naturalCallKey);
        return;
      }
      recentHiddenNaturalReplayRef.current.set(replayKey, now);
      if (recentHiddenNaturalReplayRef.current.size > 200) {
        const keep = new Map();
        const entries = Array.from(recentHiddenNaturalReplayRef.current.entries()).slice(-120);
        for (const [k, v] of entries) keep.set(k, v);
        recentHiddenNaturalReplayRef.current = keep;
      }
    }
    if (naturalParserReplayKey) {
      const now = Date.now();
      recentNaturalParserCallsRef.current.set(naturalParserReplayKey, now);
      if (recentNaturalParserCallsRef.current.size > 240) {
        const keep = new Map();
        const entries = Array.from(recentNaturalParserCallsRef.current.entries()).slice(-160);
        for (const [k, v] of entries) keep.set(k, v);
        recentNaturalParserCallsRef.current = keep;
      }
    }
    const userMsgId = makeMsgId();
    const effectiveUserType = hideUserMessage ? "debug" : msgType;
    const senderName = overrides?.commandSenderName ?? actingPlayer?.name ?? player?.name ?? "Joueur";
    const newMsg = {
      id: userMsgId,
      role: "user",
      content: userContent,
      ...(effectiveUserType && { type: effectiveUserType }),
      ...(senderName ? { senderName } : {}),
    };
    // Historique limité par \"scène\" : on ne garde que les derniers messages,
    // ce qui évite aux IA de rester bloquées dans une ancienne scène (ex: forge).
    const updatedMessages = preexistingUserMessage ? [...messagesRef.current] : [...messagesRef.current, newMsg];
    const limitedMessages =
      updatedMessages.length > 20 ? updatedMessages.slice(-20) : updatedMessages;

    if (shouldAcquireSessionLock) {
      sessionLockId = await acquireSessionLockOrReport(
        `callApi:${msgType ?? "user_text"}`,
        !hideUserMessage ? "Une autre action est déjà en cours de résolution dans cette session." : null
      );
      if (!sessionLockId) {
        if (naturalCallKey) naturalCallInFlightKeysRef.current.delete(naturalCallKey);
        return;
      }
    }

    if (!hideUserMessage && !preexistingUserMessage) {
      addMessage("user", userContent, effectiveUserType, userMsgId, undefined, senderName);
      messagesRef.current = [...messagesRef.current, newMsg];
    }
    const trimmedEngineCommand = String(userContent ?? "").trim();
    if (trimmedEngineCommand === "[ENGINE_END_TURN]") {
      const cmdId = String(overrides?.multiplayerPendingCommandId ?? "").trim();
      if (cmdId) {
        if (processedEngineCommandIdsRef.current.has(cmdId)) {
          setIsTyping(false);
          await releaseMultiplayerProcessingLock(sessionLockId);
          if (naturalCallKey) naturalCallInFlightKeysRef.current.delete(naturalCallKey);
          return;
        }
        processedEngineCommandIdsRef.current.add(cmdId);
        if (processedEngineCommandIdsRef.current.size > 200) {
          const fresh = new Set(Array.from(processedEngineCommandIdsRef.current).slice(-120));
          processedEngineCommandIdsRef.current = fresh;
        }
      }
      clearPlayerSurprisedState();
      const endName = overrides?.commandSenderName ?? actingPlayer?.name ?? player?.name ?? "Vous";
      const turnEndId = cmdId ? `mp-engine-end-turn:${cmdId}` : null;
      const turnDivId = cmdId ? `mp-engine-end-turn-div:${cmdId}` : null;
      if (!turnEndId || !messagesRef.current.some((m) => m && m.id === turnEndId)) {
        addMessage("ai", `**${endName}** met fin à son tour.`, "turn-end", turnEndId ?? makeMsgId());
      }
      if (!turnDivId || !messagesRef.current.some((m) => m && m.id === turnDivId)) {
        addMessage("ai", "", "turn-divider", turnDivId ?? makeMsgId());
      }
      await nextTurn();
      if (multiplayerSessionId) {
        try {
          await flushMultiplayerSharedState();
        } catch {
          /* ignore */
        }
      }
      setIsTyping(false);
      await releaseMultiplayerProcessingLock(sessionLockId);
      if (naturalCallKey) naturalCallInFlightKeysRef.current.delete(naturalCallKey);
      return;
    }
    addMessage(
      "ai",
      `[DEBUG][ENGINE_RX] Message à traiter\n` +
        safeJson({
          type: msgType ?? "user_text",
          isDebug: !!isDebug,
          bypassIntentParser: !!bypassIntentParser,
          roomId: baseRoomId,
          gameMode: baseGameMode,
          text: String(userContent ?? "").slice(0, 220),
        }),
      "debug",
      makeMsgId()
    );
    setIsTyping(true);
    if (!flowBlockedRef.current || overrides?.bypassFailureLock) {
      setError(null);
    }
    // Arbitre universel : tout texte libre joueur passe d'abord par /api/parse-intent
    // (sauf messages système / jets déjà résolus / récursions internes).
    const gameModeForParser =
      (overrides?.gameMode ?? baseGameMode) === "short_rest"
        ? "exploration"
        : (overrides?.gameMode ?? baseGameMode);
    const trimmedUserForParser = String(userContent ?? "").trim();
    const trivialParserInput =
      trimmedUserForParser === "" || /^[.\s]+$/.test(trimmedUserForParser);
    if (
      !msgType &&
      !isDebug &&
      (!hideUserMessage || forceIntentParser) &&
      !bypassIntentParser &&
      !trivialParserInput &&
      !engineEvent &&
      !awaitingPlayerInitiativeRef.current &&
      (!pendingRollRef.current || forceIntentParser === true) &&
      !movementGate
    ) {
      const mpCmdIdForParse = String(overrides?.multiplayerPendingCommandId ?? "").trim();
      const localParseKey = mpCmdIdForParse
        ? ""
        : [
            String(gameModeForParser ?? "").trim(),
            String(baseRoomId ?? "").trim(),
            String(trimmedUserForParser ?? "").trim(),
            String(actingMeleeCombatantId ?? "").trim(),
          ].join("|");
      /** En MP, une erreur parse-intent avant la fin du `useEffect` pending : libère Firestore tout de suite (sinon « MJ réfléchit… » peut rester coincé). */
      const releaseMpAfterParseIntentFailure = async () => {
        if (!multiplayerSessionId) return;
        if (mpCmdIdForParse) {
          try {
            await clearMultiplayerPendingCommand(mpCmdIdForParse);
          } catch {
            /* quota / réseau */
          }
        }
        try {
          await setMultiplayerThinkingState({
            active: false,
            actor: null,
            label: null,
            byClientId: null,
            autoPlayerIntentAtMs: null,
          });
        } catch {
          /* ignore */
        }
      };
      const runParseIntentOnce = async () => {
        apiProcessingDepthRef.current += 1;
        let parseIntentHttpReturned = false;
        try {
          const parseProvider = snap.aiProvider === "openrouter" ? "openrouter" : "gemini";
          const lootIntentAsked = looksLikeLootIntent(userContent);
          // Ne pas exposer au parseur les cibles mortes pour les attaques classiques,
          // mais les exposer quand le joueur exprime explicitement un pillage/loot.
          const parserEntitiesBase = (Array.isArray(baseEntities) ? baseEntities : []).filter((e) => {
            if (!e || typeof e !== "object") return false;
            if (e.type === "object") return false;
            if (e.visible === false) return false;
            const hpCur = typeof e?.hp?.current === "number" ? e.hp.current : null;
            const isDead = e.isAlive === false || (hpCur != null && hpCur <= 0);
            if (!lootIntentAsked && isDead) return false;
            return typeof e.id === "string" && !!e.id.trim();
          });
          // MP/exploration : le parse-intent doit voir les autres PJ (dont ceux à 0 PV) même s'ils
          // ne sont pas présents dans `entities` de scène, sinon il renvoie des intents vagues.
          const participantProfilesLive = multiplayerParticipantProfilesRef.current;
          const parserEntitiesWithParticipants =
            Array.isArray(participantProfilesLive) && participantProfilesLive.length > 0
              ? [
                  ...parserEntitiesBase,
                  ...participantProfilesLive
                    .map((p) => {
                      const cid = String(p?.clientId ?? "").trim();
                      if (!cid) return null;
                      const id = `mp-player-${cid}`;
                      const hotOverride = mpParticipantStateOverrideRef.current.get(cid) ?? null;
                      const hpCurrentRaw =
                        typeof hotOverride?.hpCurrent === "number" && Number.isFinite(hotOverride.hpCurrent)
                          ? Math.trunc(hotOverride.hpCurrent)
                          : 
                        typeof p?.hpCurrent === "number" && Number.isFinite(p.hpCurrent)
                          ? Math.trunc(p.hpCurrent)
                          : typeof p?.playerSnapshot?.hp?.current === "number" &&
                              Number.isFinite(p.playerSnapshot.hp.current)
                            ? Math.trunc(p.playerSnapshot.hp.current)
                            : null;
                      const hpMaxRaw =
                        typeof p?.hpMax === "number" && Number.isFinite(p.hpMax)
                          ? Math.trunc(p.hpMax)
                          : typeof p?.playerSnapshot?.hp?.max === "number" &&
                              Number.isFinite(p.playerSnapshot.hp.max)
                            ? Math.trunc(p.playerSnapshot.hp.max)
                            : null;
                      return {
                        id,
                        name: String(p?.name ?? p?.playerSnapshot?.name ?? id).trim() || id,
                        type: "friendly",
                        visible: p?.connected !== false,
                        isAlive: p?.playerSnapshot?.deathState?.dead !== true,
                        hp:
                          hpCurrentRaw != null
                            ? { current: hpCurrentRaw, max: hpMaxRaw != null ? hpMaxRaw : Math.max(1, hpCurrentRaw) }
                            : null,
                        deathState:
                          hotOverride?.deathState && typeof hotOverride.deathState === "object"
                            ? hotOverride.deathState
                            : p?.playerSnapshot?.deathState && typeof p.playerSnapshot.deathState === "object"
                            ? p.playerSnapshot.deathState
                            : null,
                      };
                    })
                    .filter(Boolean),
                ]
              : parserEntitiesBase;
          const parserEntities = Array.from(
            new Map(
              parserEntitiesWithParticipants
                .filter((e) => e && typeof e.id === "string" && e.id.trim())
                .map((e) => [String(e.id).trim(), e])
            ).values()
          );
          const parserRoom = baseRoomId && GOBLIN_CAVE[baseRoomId] ? GOBLIN_CAVE[baseRoomId] : null;
          const parserVisibleExits = getVisibleExitsForRoom(baseRoomId, getRoomMemory(baseRoomId));
          const parseBody = {
            text: userContent,
            messages: updatedMessages,
            gameMode: gameModeForParser,
            currentScene: baseScene,
            currentRoomId: baseRoomId,
            currentRoomSecrets: parserRoom?.secrets ?? "",
            allowedExits: Array.isArray(parserVisibleExits)
              ? parserVisibleExits
                  .map((exitDef) => {
                    const exitId =
                      typeof exitDef === "string"
                        ? exitDef
                        : String(exitDef?.id ?? "").trim();
                    const exitDesc =
                      exitDef && typeof exitDef === "object"
                        ? String(exitDef.description ?? "").trim()
                        : "";
                    const exitDirection =
                      exitDef && typeof exitDef === "object"
                        ? String(exitDef.direction ?? "").trim()
                        : "";
                    const room = GOBLIN_CAVE[exitId];
                    return room
                      ? {
                          id: room.id,
                          title: room.title ?? room.id,
                          description: exitDesc || (room.description ?? ""),
                          direction: exitDirection,
                        }
                      : null;
                  })
                  .filter(Boolean)
              : [],
            entities: parserEntities,
            playerWeapons: actingPlayer?.weapons ?? [],
            playerInventory: Array.isArray(actingPlayer?.inventory) ? actingPlayer.inventory : [],
            playerMeleeTargets: getMeleeWith(actingMeleeCombatantId),
            turnResources: (() => {
              const trFromActingMap =
                turnResourcesByCombatantId &&
                typeof turnResourcesByCombatantId === "object" &&
                actingMeleeCombatantId
                  ? turnResourcesByCombatantId[actingMeleeCombatantId]
                  : null;
              const tr = turnResourcesForResolve ?? trFromActingMap ?? turnResourcesRef.current;
              return {
                action: !!tr?.action,
                bonus: !!tr?.bonus,
                reaction: !!tr?.reaction,
                movement: !!tr?.movement,
              };
            })(),
            provider: parseProvider,
          };
          const { res, data } = await fetchJsonWithTimeout(
            "/api/parse-intent",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(parseBody),
            },
            PARSE_INTENT_TIMEOUT_MS,
            "parse-intent"
          );
          parseIntentHttpReturned = true;
          addMessage(
            "ai",
            `[DEBUG][ENGINE_RX] JSON reçu de /api/parse-intent\n` +
              safeJson({
                ok: res.ok,
                status: res.status,
                resolution: data?.resolution ?? null,
                reason: data?.reason ?? null,
                hasRollRequest: !!data?.rollRequest,
                hasSceneUpdate: !!data?.sceneUpdate,
              }),
            "debug",
            makeMsgId()
          );
          if (!res.ok) {
            const details = String(data.error ?? data.details ?? "Échec du parseur d'intention.");
            const withStatus =
              typeof res.status === "number" && res.status > 0
                ? `${details} (HTTP ${res.status})`
                : details;
            await releaseMpAfterParseIntentFailure();
            addMessage(
              "ai",
              withStatus,
              "intent-error",
              makeMsgId()
            );
            markFlowFailure(withStatus, {
              userContent,
              msgType,
              isDebug,
              overrides: {
                ...(overrides ?? {}),
                hideUserMessage: true,
                bypassFailureLock: true,
              },
            });
          } else {
            if (gameStateRef.current?.debugMode) {
              addMessage(
                "ai",
                `[DEBUG] Décision arbitre :\n${JSON.stringify(data, null, 2)}`,
                "debug",
                makeMsgId()
              );
            }
            await processArbiterDecision(
              data,
              baseEntities,
              userContent,
              baseRoomId,
              baseScene,
              gameModeForParser,
              actingPlayer,
              { submitterClientId: rollSubmitterClientId },
              actingMeleeCombatantId,
              turnResourcesForResolve,
              mpCmdIdForParse || null
            );
          }
        } catch (e) {
          const errMsg = String(e?.message ?? e);
          if (!/^Timeout\b/i.test(errMsg)) {
            console.error("Erreur parse-intent", e);
          }
          if (!parseIntentHttpReturned) {
            await releaseMpAfterParseIntentFailure();
          }
          const userFacing =
            errMsg && errMsg.length > 0
              ? `Erreur parse-intent : ${errMsg.length > 280 ? `${errMsg.slice(0, 280)}…` : errMsg}`
              : "Erreur réseau ou serveur (parse-intent).";
          addMessage(
            "ai",
            userFacing,
            "intent-error",
            makeMsgId()
          );
          markFlowFailure(
            `Erreur parse-intent: ${String(e?.message ?? e)}`,
            {
              kind: "callApi",
              userContent,
              msgType,
              isDebug,
              overrides: {
                ...(overrides ?? {}),
                hideUserMessage: true,
                bypassFailureLock: true,
              },
            }
          );
        } finally {
          setIsTyping(false);
          const depthAfterParse = Math.max(0, apiProcessingDepthRef.current - 1);
          apiProcessingDepthRef.current = depthAfterParse;
          await releaseMultiplayerProcessingLock(sessionLockId);
          if (multiplayerSessionId && depthAfterParse === 0) {
            // Laisser React appliquer setTurnResourcesForCombatant (sans flushSync interdit
            // dans les effets) avant que le flush lise turnResourcesByCombatantIdRef.
            await new Promise((r) => setTimeout(r, 0));
            try {
              await flushMultiplayerSharedState();
            } catch {
              /* ignore */
            }
          }
          if (mpCmdIdForParse) {
            mpParseIntentInFlightRef.current.delete(mpCmdIdForParse);
          }
          if (localParseKey) {
            localParseIntentInFlightRef.current.delete(localParseKey);
          }
        }
      };

      if (mpCmdIdForParse) {
        let p = mpParseIntentInFlightRef.current.get(mpCmdIdForParse);
        if (!p) {
          p = runParseIntentOnce();
          mpParseIntentInFlightRef.current.set(mpCmdIdForParse, p);
        }
        await p;
      } else if (localParseKey) {
        let p = localParseIntentInFlightRef.current.get(localParseKey);
        if (!p) {
          p = runParseIntentOnce();
          localParseIntentInFlightRef.current.set(localParseKey, p);
        }
        await p;
      } else {
        await runParseIntentOnce();
      }
      if (naturalCallKey) naturalCallInFlightKeysRef.current.delete(naturalCallKey);
      // Résolution entièrement via parse-intent (ex. move → bulle dice + conso mouvement) : on ne
      // passe jamais par le try /api/chat où scheduleAutoPlayerTurn relance l'auto-joueur. Avec
      // skipAutoPlayerTurn (appel depuis runAutoPlayerTurn), ce return laissait parfois le gate
      // sur une clé d'éligibilité inchangée — l'auto ne repartait pas après « couvert / mouvement ».
      if (
        skipAutoPlayerTurn &&
        autoPlayerEnabledRef.current &&
        (gameStateRef.current?.gameMode ?? baseGameMode) === "combat" &&
        isPlayerTurnNow() &&
        !pendingRollRef.current &&
        !rollResolutionInProgressRef.current &&
        !flowBlockedRef.current &&
        !awaitingPlayerInitiativeRef.current &&
        !waitForGmNarrationForInitiativeLiveRef.current
      ) {
        const scheduleAutoPlayerTurn = (cb) => {
          if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => cb());
            return;
          }
          setTimeout(() => cb(), 16);
        };
        scheduleAutoPlayerTurn(() => {
          if (!autoPlayerEnabledRef.current) return;
          if ((gameStateRef.current?.gameMode ?? null) !== "combat" || !isPlayerTurnNow()) return;
          void runAutoPlayerTurn(null);
        });
      }
      return;
    }

    // Si un jet arbitre est déjà en attente, ne pas envoyer un texte joueur « brut » au MJ :
    // sans parse-intent ni engineEvent, il invente l'issue du test (narration avant le d20).
    // Les commandes multijoueur passent par forceIntentParser pour repasser à l'arbitre.
    if (
      !msgType &&
      !isDebug &&
      !bypassIntentParser &&
      !engineEvent &&
      pendingRollRef.current &&
      forceIntentParser !== true
    ) {
      setIsTyping(false);
      await releaseMultiplayerProcessingLock(sessionLockId);
      if (naturalCallKey) naturalCallInFlightKeysRef.current.delete(naturalCallKey);
      return;
    }

    const requestBody = {
      messages: limitedMessages,
      player: actingPlayer,
      currentScene: baseScene,
      currentRoomId: baseRoomId,
      provider: snap.aiProvider,
      entities: baseEntities,
      gameMode: baseGameMode,
      engineEvent,
      debugMode: snap.debugMode,
    };

    const t0 = (typeof performance !== "undefined" && performance.now)
      ? performance.now()
      : Date.now();
    /** Portée élargie : le `finally` doit pouvoir débloquer le bandeau initiative après la narration (voir setTimeout ci-dessous). */
    let combatAwaitingInitiativeAfterResponse = false;
    /** Vrai seulement si une bulle de narration MJ a été ajoutée dans ce tour de callApi (évite de libérer l'initiative quand la narration est reportée / supprimée par sceneUpdate). */
    let gmCombatNarrationShownThisCall = false;
    try {
      apiProcessingDepthRef.current += 1;
      if (msgType === "dice") setFailedRequestPayload(null);
      // Flag : évite de rendre la main au joueur après une transition de scène
      // (la suite est rejouée automatiquement via [SceneEntered]).
      let sceneUpdateApplied = false;
      /** Après cette réponse : combat sans ordre d'initiative → pas de narration MJ auto / pas d'auto-joueur « exploration » */
      combatAwaitingInitiativeAfterResponse = false;
      gmCombatNarrationShownThisCall = false;
      // On tente jusqu'Ã  3 fois en cas d'erreur réseau/serveur avant d'abandonner.
      // Le message utilisateur n'est ajouté qu'une seule fois (au début de callApi).
      let lastError = null;
      let responseData = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const latest = gameStateRef.current;
          const effectiveRoomId =
            overrides?.currentRoomId ?? latest.currentRoomId ?? baseRoomId;
          const wtLive =
            typeof latest.worldTimeMinutes === "number" && Number.isFinite(latest.worldTimeMinutes)
              ? latest.worldTimeMinutes
              : worldTimeMinutes;
          const bodyToSend = {
            ...requestBody,
            player: actingPlayer,
            currentScene: overrides?.currentScene ?? latest.currentScene,
            currentRoomId: effectiveRoomId,
            entities: overrides?.entities ?? latest.entities,
            gameMode: overrides?.gameMode ?? latest.gameMode,
            provider: latest.aiProvider,
            debugMode: latest.debugMode,
            worldTimeMinutes: wtLive,
            worldTimeLabel: formatWorldTimeLabel(wtLive),
            roomMemory: getRoomMemory(effectiveRoomId),
            messages: limitedMessages,
            engineEvent,
          };
          const controller = new AbortController();
          const timeoutMs = API_AI_THINKING_TIMEOUT_MS;
          const t = setTimeout(() => controller.abort(), timeoutMs);
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(bodyToSend),
            signal: controller.signal,
          }).finally(() => clearTimeout(t));

          const data = await res.json().catch(() => ({}));
          addMessage(
            "ai",
            `[DEBUG][ENGINE_RX] JSON reçu de /api/chat\n` +
              safeJson({
                ok: res.ok,
                status: res.status,
                valid: data?.valid ?? null,
                hasReply: typeof data?.reply === "string" && data.reply.trim().length > 0,
                imageDecision: data?.imageDecision ?? null,
                hasRollRequest: !!data?.rollRequest,
                hasSceneUpdate: !!data?.sceneUpdate,
                hasEntityUpdates: Array.isArray(data?.entityUpdates) && data.entityUpdates.length > 0,
              }),
            "debug",
            makeMsgId()
          );

          if (!res.ok) {
            if (res.status === 429 && data.retryAfter) {
              setRetryCountdown(data.retryAfter);
            }
            // On propage avec le plus de détails possible
            throw new Error(data.details ?? data.error ?? `Erreur serveur (${res.status})`);
          }

          responseData = data;
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          // Tentatives 1 et 2 : on réessaie brièvement
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 300 * attempt));
            continue;
          }
        }
      }

      if (!responseData && lastError) {
        throw lastError;
      }
      setFlowBlocked(false);
      setFailedRequestPayload(null);

      // Latence (en incluant retries éventuels)
      const t1 = (typeof performance !== "undefined" && performance.now)
        ? performance.now()
        : Date.now();
      const latencyMs = Math.max(0, Math.round(t1 - t0));
      setLatencyLastMs(latencyMs);
      // moyenne glissante sur 20 dernières
      const win = latencyWindowRef.current ?? [];
      win.push(latencyMs);
      while (win.length > 20) win.shift();
      latencyWindowRef.current = win;
      const avg = Math.round(win.reduce((a, b) => a + b, 0) / win.length);
      setLatencyAvgMs(avg);
      addMessage(
        "ai",
        `[DEBUG] Latence IA (${aiProvider}) : ${latencyMs}ms (moyenne ${win.length} = ${avg}ms)`,
        "debug",
        makeMsgId()
      );

      const {
        valid,
        reply,
        imageDecision,
        rollRequest,
        actionIntent,
        gameMode: newGameMode,
        entityUpdates,
        combatOrder: newCombatOrder,
        playerHpUpdate,
        sceneUpdate,
        debugPrompt,
        gmContinue,
        formatRetryUsed,
        formatRetryReason,
        formatEmergencyUsed,
        narratorFallback,
      } = responseData;
      let imageDecisionEffective = imageDecision;
      const effectiveGameMode = newGameMode ?? baseGameMode;
      let actionIntentSafe = actionIntent;
      if (effectiveGameMode === "exploration" && typeof actionIntentSafe === "string") {
        actionIntentSafe = null;
      }

      let autoPlayerOverrides = null;

      // Pas de suppression « générique » (rollRequest, gm_secret, meta, etc.) sauf cas explicites plus bas.
      let suppressReplyForThisResponse = false;

      // Garde-fou narration: si le moteur sait que la cible est vivante, empêcher une "mort" narrée.
      let safeReply = reply;

      // Fallback robustesse: si l'IA "raconte" un lancement de sort mais oublie rollRequest,
      // on synthétise un rollRequest d'attaque de sort (l'IA a déjÃ  pris la décision dans la narrative).
      // Cela évite le cas "rien ne se passe" après une phrase du type "vous lancez Fracasse...".
      let rollRequestSafe = rollRequest;
      if (rollRequestSafe && typeof rollRequestSafe === "object") {
        rollRequestSafe = { ...rollRequestSafe };
        if (rollRequestSafe.kind === "player_attack") rollRequestSafe.kind = "attack";
        if (rollRequestSafe.weapon != null && rollRequestSafe.weaponName == null) {
          rollRequestSafe.weaponName =
            typeof rollRequestSafe.weapon === "string"
              ? rollRequestSafe.weapon
              : String(rollRequestSafe.weapon);
        }
      }
      const combatLikeForIntent =
        effectiveGameMode === "combat" &&
        actionIntentSafe != null &&
        typeof actionIntentSafe === "object";

      if (
        !isDebug &&
        isNaturalCall &&
        String(userContent ?? "").trim().length > 0 &&
        !rollRequestSafe &&
        msgType !== "dice" &&
        !combatLikeForIntent
      ) {
        const knownSpells = Array.isArray(player?.selectedSpells) ? player.selectedSpells : [];
        const spellFromUser = findKnownSpellInText(userContent, knownSpells);
        const spellFromReply = findKnownSpellInText(String(safeReply ?? ""), knownSpells);
        const canonicalSpellName = spellFromUser ?? spellFromReply ?? null;
        if (canonicalSpellName) {
          const spellMeta = getSpellRuntimeMeta(canonicalSpellName);
          const spellRaw = spellMeta?.raw ?? null;
          const isOffensiveSpell =
            !!spellRaw &&
            (spellMeta?.save === true ||
              spellRequiresAttackRoll(spellRaw) === true ||
              String(spellRaw?.damage ?? "").trim().length > 0);
          if (!isOffensiveSpell) {
            // Ex: Bouclier (réaction défensive) — ne jamais synthétiser un jet offensif.
            return;
          }
          const combined = `${userContent ?? ""} ${safeReply ?? ""}`;
          const target = findTargetFromText(combined, baseEntities);
          if (target) {
            rollRequestSafe = {
              kind: "attack",
              stat: spellcastingAbilityAbbrevForCombatant(player),
              totalBonus: computeSpellAttackBonus(player),
              raison: `Lancer ${canonicalSpellName} sur ${target.name}`,
              targetId: target.id,
              weaponName: canonicalSpellName,
            };
            addMessage(
              "ai",
              `[DEBUG] Fallback: rollRequest manquant â†’ synthèse moteur (sort)\n` +
                safeJson({ from: rollRequest, to: rollRequestSafe, userContent, reply: safeReply }),
              "debug",
              makeMsgId()
            );
          }
        }
      }
      // Filtre "anti-mort" retiré: on ne réécrit plus la narration du GM
      // selon targetIsAlive/targetHpAfter. La prose est laissée telle quelle.

      // Si le message est une attaque résolue par le moteur, on IGNORE les entityUpdates/HP venant de l'IA
      // (sinon double-application â†’ morts/HP incohérents).
      // Le moteur peut envoyer le préfixe emoji soit correctement ("🎲"), soit en mojibake ("ðŸŽ²").
      const isEngineResolvedAttack =
        msgType === "dice" &&
        /^(?:🎲|ðŸŽ²)\s*Attaque/i.test(String(userContent ?? ""));
      const safeEntityUpdates = isEngineResolvedAttack ? null : entityUpdates;
      const safePlayerHpUpdate =
        isEngineResolvedAttack || playerEntityUpdatesTouchHp(safeEntityUpdates) ? null : playerHpUpdate;
      let safeSceneUpdate = sceneUpdate;

      if (isEngineResolvedAttack) {
        // Interdit au narrateur de jouer à la place du joueur juste après un jet d'attaque:
        // pas de loot auto, pas d'auto-déplacement/transition de scène.
        safeReply = sanitizeResolvedAttackNarrative(safeReply);
        safeSceneUpdate = null;
        addMessage(
          "ai",
          `[DEBUG] Attaque résolue côté moteur â†’ ignore entityUpdates/playerHpUpdate/sceneUpdate de l'IA + nettoyage narration anti auto-pilot.\n` +
            `entityUpdates(IA)=${entityUpdates ? "présent" : "null"} | playerHpUpdate(IA)=${typeof playerHpUpdate === "number" ? playerHpUpdate : "null"} | sceneUpdate(IA)=${sceneUpdate?.hasChanged ? "présent" : "null"}`,
          "debug"
        );
      }

      // Heuristique anti-"kill" en exploration : si la narration dit clairement que la cible s'en va/disparaît,
      // on requalifie "kill" en "remove" pour éviter PV=0 incohérents.
      const leavingRegex =
        /(quitte|s['â€™]?en\s+va|s['â€™]?éloigne|se\s+retire|dispara(?:i|î)t|sort\s+par|fuit|prend\s+la\s+porte)/i;
      const isExplorationNow = (newGameMode ?? baseGameMode) === "exploration";
      let normalizedEntityUpdates = safeEntityUpdates;

      // 1) Interdire à l'IA de "spawner" librement de nouvelles créatures en plein milieu d'une scène.
      //    Exception : id ∈ encounterEntities de la salle courante (baseRoomId), ou spawn template/name.
      // Source de vérité pour les transitions: DERNIER vrai message joueur uniquement.
      // Ne jamais se baser sur un texte système (continue/dice/debug) ni sur la narration MJ.
      const allowedSpawnIds = buildAllowedSpawnIdSet(baseRoomId);

      if (Array.isArray(normalizedEntityUpdates) && normalizedEntityUpdates.length) {
        const nextSpawnId = makeRuntimeSpawnIdFactory(baseEntities, normalizedEntityUpdates);
        const sanitizeSpawnDrivenByTemplate = (spawnUpdate) => {
          if (!spawnUpdate || spawnUpdate.action !== "spawn") return spawnUpdate;
          const templateId = String(spawnUpdate.templateId ?? "").trim();
          if (!templateId || !BESTIARY?.[templateId]) return spawnUpdate;
          // Spawn piloté par template: le moteur initialise les stats de combat.
          const {
            attackBonus,
            damageDice,
            damageBonus,
            weapons,
            stats,
            features,
            selectedSpells,
            spellSlots,
            spellAttackBonus,
            spellSaveDc,
            race,
            entityClass,
            cr,
            description,
            stealthDc,
            ac,
            hp,
            ...safeSpawn
          } = spawnUpdate;
          return safeSpawn;
        };
        const prepared = normalizedEntityUpdates.map((u) => {
          if (u?.action !== "spawn") return u;
          const sid = typeof u?.id === "string" ? u.id.trim() : "";
          if (sid) {
            const lootHint = getEncounterBonusLootForRoom(baseRoomId, sid);
            if (!Array.isArray(u?.lootItems)) {
              const fromInventory = Array.isArray(u?.inventory)
                ? u.inventory.map((x) => String(x ?? "").trim()).filter(Boolean)
                : [];
              if (fromInventory.length) {
                return sanitizeSpawnDrivenByTemplate({ ...u, lootItems: fromInventory, looted: false });
              }
              if (lootHint)
                return sanitizeSpawnDrivenByTemplate({ ...u, lootItems: [lootHint], looted: false });
            }
            return sanitizeSpawnDrivenByTemplate(u);
          }
          const hint = u?.templateId ?? u?.name ?? u?.type ?? "spawn";
          const generatedId = nextSpawnId(hint);
          const lootHint = getEncounterBonusLootForRoom(baseRoomId, generatedId);
          const withId = { ...u, id: generatedId };
          if (!Array.isArray(withId?.lootItems)) {
            const fromInventory = Array.isArray(withId?.inventory)
              ? withId.inventory.map((x) => String(x ?? "").trim()).filter(Boolean)
              : [];
            if (fromInventory.length) {
              return sanitizeSpawnDrivenByTemplate({ ...withId, lootItems: fromInventory, looted: false });
            }
            if (lootHint)
              return sanitizeSpawnDrivenByTemplate({ ...withId, lootItems: [lootHint], looted: false });
          }
          return sanitizeSpawnDrivenByTemplate(withId);
        });
        const filtered = prepared.filter((u) => {
          if (u?.action !== "spawn") return true;
          const sid = typeof u?.id === "string" ? u.id.trim() : "";
          if (!sid) return false;
          const spawnType = String(u?.type ?? "").trim().toLowerCase();
          const isPlayerSpawn = spawnType === "player" || sid === "player";
          const templateId = String(u?.templateId ?? "").trim();
          const hasValidTemplate = !!templateId && !!BESTIARY?.[templateId];
          // Politique stricte : spawn non-joueur => templateId valide obligatoire.
          if (!isPlayerSpawn && !hasValidTemplate) return false;
          // Autoriser les ids explicitement prévus par la salle.
          if (allowedSpawnIds.has(sid)) return true;
          // Sinon, autoriser seulement un spawn piloté par template valide.
          if (hasValidTemplate) return true;
          // Joueur: garder le comportement existant.
          if (isPlayerSpawn) return true;
          return false;
        });
        if (filtered.length !== prepared.length) {
          addMessage(
            "ai",
            `[DEBUG] entityUpdates.spawn filtrés (autorise id ∈ encounterEntities OU spawn template/name)\n` +
              safeJson({
                from: prepared,
                to: filtered,
                baseRoomId,
                sceneTarget: safeSceneUpdate?.targetRoomId ?? null,
                allowedIds: [...allowedSpawnIds],
              }),
            "debug",
            makeMsgId()
          );
          normalizedEntityUpdates = filtered;
        } else {
          normalizedEntityUpdates = prepared;
        }
      }

      // 2) Heuristique anti-"kill" en exploration : si la narration dit clairement que la cible s'en va/disparaît,
      //    on requalifie "kill" en "remove" pour éviter PV=0 incohérents.
      if (isExplorationNow && Array.isArray(normalizedEntityUpdates) && leavingRegex.test(String(safeReply ?? ""))) {
        const hasKill = normalizedEntityUpdates.some((u) => u?.action === "kill");
        if (hasKill) {
          const fromUpdates = normalizedEntityUpdates;
          normalizedEntityUpdates = normalizedEntityUpdates.map((u) =>
            u?.action === "kill" ? { ...u, action: "remove" } : u
          );
          addMessage(
            "ai",
            `[DEBUG] Normalisation: killâ†’remove en exploration (départ de scène)\n` +
              safeJson({ from: fromUpdates, to: normalizedEntityUpdates }),
            "debug",
            makeMsgId()
          );
        }
      }

      // 3) Loot explicite du joueur: on applique mécaniquement le transfert d'inventaire côté moteur client.
      // Même si le MJ oublie actionIntent/format strict, le loot doit réellement fonctionner.
      const isExplicitLootFromPlayer = !msgType && looksLikeLootIntent(userContent);
      if (isExplicitLootFromPlayer) {
        safeSceneUpdate = null; // looter n'implique pas une transition de scène
        safeReply = sanitizeAutoTravelAfterLootNarrative(safeReply);

        const deadVisibleEntities = (Array.isArray(baseEntities) ? baseEntities : []).filter((e) => {
          if (!e || e.visible === false) return false;
          const hpCur = typeof e?.hp?.current === "number" ? e.hp.current : null;
          return e.isAlive === false || (hpCur != null && hpCur <= 0);
        });
        const idsMarkedLootedByAi = new Set(
          (Array.isArray(normalizedEntityUpdates) ? normalizedEntityUpdates : [])
            .filter((u) => u && typeof u === "object" && typeof u.id === "string" && u.looted === true)
            .map((u) => String(u.id))
        );
        const targets = idsMarkedLootedByAi.size
          ? deadVisibleEntities.filter((e) => idsMarkedLootedByAi.has(String(e.id)))
          : deadVisibleEntities.filter((e) => e.looted !== true);

        const invGains = [];
        const lootEntityUpdates = [];
        for (const corpse of targets) {
          if (!corpse?.id || corpse.looted === true) continue;
          const picked = deriveLootItemsFromEntity(corpse, baseRoomId);
          if (picked.length) invGains.push(...picked);
          lootEntityUpdates.push({ action: "update", id: corpse.id, looted: true, lootItems: [] });
        }
        if (lootEntityUpdates.length) {
          normalizedEntityUpdates = [...(normalizedEntityUpdates ?? []), ...lootEntityUpdates];
        }
        if (invGains.length) {
          const actingInv = Array.isArray(actingPlayer?.inventory) ? actingPlayer.inventory : [];
          const nextInv = stackInventory([...actingInv, ...invGains]);
          const submitter = String(rollSubmitterClientId ?? "").trim();
          const localCid = String(clientId ?? "").trim();
          if (!multiplayerSessionId || (submitter && submitter === localCid)) {
            updatePlayer({ inventory: nextInv });
          } else if (submitter) {
            void patchParticipantProfileInventory(submitter, nextInv);
          }
        }
      }

      // Multijoueur : `id:"player"` cible le PJ qui a soumis la commande (pas l'onglet qui tient le bail).
      // Inventaire / PV distants → profils Firestore ; même client → applyEntityUpdates via `mp-player-<cid>`.
      if (
        multiplayerSessionId &&
        rollSubmitterClientId &&
        Array.isArray(normalizedEntityUpdates) &&
        normalizedEntityUpdates.length > 0
      ) {
        const sub = String(rollSubmitterClientId).trim();
        const localCid = String(clientId ?? "").trim();
        const mpActing = sub ? `mp-player-${sub}` : "";
        if (mpActing) {
          normalizedEntityUpdates = normalizedEntityUpdates.map((u) => {
            if (!u || typeof u !== "object") return u;
            if (String(u.id ?? "").trim() !== "player") return u;
            let next = { ...u, id: mpActing };
            const hasInv = next.inventory !== undefined || next.lootItems !== undefined;
            if (hasInv) {
              const base = Array.isArray(actingPlayer?.inventory) ? actingPlayer.inventory : [];
              const nextInv = stackInventory(
                Array.isArray(next.inventory)
                  ? next.inventory.map((x) => String(x ?? "").trim()).filter(Boolean)
                  : Array.isArray(next.lootItems)
                    ? [...base, ...next.lootItems.map((x) => String(x ?? "").trim()).filter(Boolean)]
                    : [...base]
              );
              void patchParticipantProfileInventory(sub, nextInv);
              const { inventory: _inv, lootItems: _loot, ...rest } = next;
              next = { ...rest, id: mpActing };
            }
            if (next.hp !== undefined) {
              let cur = null;
              if (typeof next.hp === "number" && Number.isFinite(next.hp)) {
                cur = Math.max(0, Math.trunc(next.hp));
              } else if (
                next.hp &&
                typeof next.hp === "object" &&
                typeof next.hp.current === "number" &&
                Number.isFinite(next.hp.current)
              ) {
                cur = Math.max(0, Math.trunc(next.hp.current));
              }
              if (cur != null && sub !== localCid) {
                void patchParticipantProfileHp(sub, cur);
                const { hp, ...r2 } = next;
                next = { ...r2, id: mpActing };
              }
            }
            return next;
          });
        }
      }

      // NOTE: l'hostilité déclenchée par un déplacement est un choix de MJ contextuel.
      // On ne filtre pas côté moteur; c'est l'IA (prompt) qui doit décider au cas par cas
      // quelles entités deviennent hostiles et pourquoi.

      // Avertissement joueur seulement si la narration n’a pas pu être récupérée ; sinon bruit inutile
      // (les traces serveur gardent geminiGeneration / finishReason).
      if (formatRetryUsed === true && narratorFallback === true) {
        const reason = typeof formatRetryReason === "string" && formatRetryReason.trim()
          ? ` (${formatRetryReason.trim()})`
          : "";
        addMessage(
          "ai",
          `⚠ Réponse IA au format invalide détectée${reason}. La correction automatique n'a pas produit de JSON valide : un message de secours remplace le fragment illisible. Consulte les traces geminiGeneration (finishReason).`,
          "meta",
          makeMsgId()
        );
      } else if (formatRetryUsed === true && gameStateRef.current?.debugMode) {
        const reason = typeof formatRetryReason === "string" && formatRetryReason.trim()
          ? ` (${formatRetryReason.trim()})`
          : "";
        const detail =
          formatEmergencyUsed === true
            ? "Récupération OK après essai d'urgence (prompt minimal)."
            : "Récupération OK après retry format.";
        addMessage(
          "ai",
          `[DEBUG] Narrateur : 1er jet JSON invalide${reason}. ${detail}`,
          "debug",
          makeMsgId()
        );
      }

      if (debugPrompt?.systemInstruction) {
        const sys = String(debugPrompt.systemInstruction);
        const firstLines = sys.split("\n").slice(0, 4).join("\n");
        const truncated =
          firstLines + (sys.split("\n").length > 4 ? "\n..." : "");
        addMessage(
          "ai",
          `[DEBUG] Prompt envoyé Ã  l'IA (${debugPrompt.provider}${debugPrompt.model ? ` Â· ${debugPrompt.model}` : ""})\n\n` +
            truncated,
          "debug",
          makeMsgId()
        );
      }

      let pendingEntityUpdatesForNarrationOrder = null;
      if (!isDebug) {
        // Calculer les entités après mises Ã  jour (pour simulateEnemyTurns)
        const postEntities = applyUpdatesLocally(baseEntities, normalizedEntityUpdates);

        const acceptedGmCombatOrder =
          Array.isArray(newCombatOrder) &&
          newCombatOrder.length > 0 &&
          combatOrderIncludesAllPlayerControlledCombatants(newCombatOrder, postEntities)
            ? newCombatOrder
            : null;

        if (normalizedEntityUpdates?.length) pendingEntityUpdatesForNarrationOrder = normalizedEntityUpdates;
        // Source de vérité du mode: présence d'hostiles uniquement (pas gameMode renvoyé par le GM).
        if (acceptedGmCombatOrder) {
          setCombatOrder(acceptedGmCombatOrder);
          // Tour actif = premier de l'ordre d'initiative (aligné sur le moteur client)
          commitCombatTurnIndex(0);
        }
        if (typeof safePlayerHpUpdate === "number") {
          const currentPlayerHp = playerHpRef.current ?? player?.hp?.current ?? safePlayerHpUpdate;
          if (safePlayerHpUpdate < currentPlayerHp) {
            applyDamageToPlayer(currentPlayerHp - safePlayerHpUpdate, { critical: false });
          } else {
            setHp(safePlayerHpUpdate);
            playerHpRef.current = safePlayerHpUpdate;
          }
        }

        // --- Command pattern : actionIntent (combat, tour du joueur) ---
        const effGameModeForIntent = newGameMode ?? baseGameMode;
        const effOrderForIntent = acceptedGmCombatOrder ?? combatOrder;
        let effTurnIdxForIntent = combatTurnIndex;
        // Nouveau combatOrder dans ce JSON = ordre d'initiative frais : le tour commence à l'index 0 (plus haute init).
        if (acceptedGmCombatOrder?.length) effTurnIdxForIntent = 0;
        const isPlayerCombatTurn =
          effGameModeForIntent === "combat" &&
          effOrderForIntent.length > 0 &&
          controllerForCombatantId(effOrderForIntent[effTurnIdxForIntent]?.id, postEntities) === "player";
        const activeCombatantIdForIntent =
          effGameModeForIntent === "combat" && effOrderForIntent.length > 0
            ? String(effOrderForIntent[effTurnIdxForIntent]?.id ?? "").trim()
            : "";
        const actingCombatantIdForIntent = String(actingMeleeCombatantId ?? "").trim();
        const isActingCombatantTurn =
          !!activeCombatantIdForIntent &&
          !!actingCombatantIdForIntent &&
          mpLocalCombatantIdsEqual(activeCombatantIdForIntent, actingCombatantIdForIntent);
        const isCombatOpeningWithoutOrder =
          effGameModeForIntent === "combat" &&
          effOrderForIntent.length === 0 &&
          baseGameMode !== "combat";

        const actionIntentNorm = normalizeClientActionIntent(actionIntentSafe);

        if (
          !isDebug &&
          msgType !== "dice" &&
          actionIntentNorm &&
          ((isPlayerCombatTurn && isActingCombatantTurn) || isCombatOpeningWithoutOrder)
        ) {
          const turnResourcesForActingCombatant =
            actingMeleeCombatantId &&
            turnResourcesByCombatantId &&
            typeof turnResourcesByCombatantId === "object" &&
            turnResourcesByCombatantId[actingMeleeCombatantId]
              ? normalizeTurnResourcesInput(turnResourcesByCombatantId[actingMeleeCombatantId])
              : normalizeTurnResourcesInput(turnResourcesRef.current);
          const setTurnResourcesForActingCombatant = (fnOrObj) => {
            if (
              actingMeleeCombatantId &&
              !mpLocalCombatantIdsEqual(actingMeleeCombatantId, localCombatantId)
            ) {
              setTurnResourcesForCombatant(actingMeleeCombatantId, fnOrObj);
              return;
            }
            setTurnResourcesSynced(fnOrObj);
          };
          const emitMeleeMoveDebugGm = (payload) => {
            emitMeleeGraphDebugChat({
              ...payload,
              getMeleeWith,
              entities: postEntities,
              combatOrder: effOrderForIntent,
              localCombatantIdForNames: actingMeleeCombatantId,
              localPlayerDisplayName: actingPlayer?.name ?? null,
              addMessage,
              makeMsgId,
            });
          };
          const intentResult = executeCombatActionIntent(actionIntentNorm, {
            postEntities,
            player: actingPlayer,
            gameMode: effGameModeForIntent,
            setGameMode,
            turnResources: turnResourcesForActingCombatant,
            setTurnResources: setTurnResourcesForActingCombatant,
            setHp,
            updatePlayer,
            applyEntityUpdates,
            currentRoomId,
            playerHpRef,
            getMeleeWith,
            addMeleeMutual,
            clearMeleeFor,
            setHasDisengagedThisTurn,
            hasDisengagedThisTurn,
            consumeResource,
            addMessage,
            makeMsgId,
            userContent,
            localCombatantId: actingMeleeCombatantId,
            dodgeActiveByCombatantIdRef,
            combatHiddenIds: gameStateRef.current?.combatHiddenIds ?? combatHiddenIds ?? [],
            meleeState,
            emitMeleeMoveDebug: emitMeleeMoveDebugGm,
            messagesRef,
            multiplayerParticipantProfilesRef,
            multiplayerSessionId,
            clientId,
            patchParticipantProfileHp,
            combatEngagementSeqRef,
            combatRoundInEngagementRef,
            combatTurnIndexLiveRef,
          });

          if (!intentResult.ok) {
            if (!shouldSkipDuplicateClientActionErrorEcho(intentResult.userMessage)) {
              addMessage("ai", intentResult.userMessage, undefined, makeMsgId());
            }
            suppressReplyForThisResponse = true;
            rollRequestSafe = null;
          } else {
            rollRequestSafe = null;
            if (intentResult.runSpellSave) {
              const spellBranch = await handleCombatIntentSpellSaveBranch(
                intentResult,
                postEntities,
                effGameModeForIntent,
                baseRoomId,
                baseScene
              );
              if (spellBranch.suppressReply) suppressReplyForThisResponse = true;
              if (spellBranch.exitCallApi) return;
            }
            if (intentResult.pendingRoll) {
              const stamped = stampPendingRollForActor(
                intentResult.pendingRoll,
                actingPlayer,
                rollSubmitterClientId
              );
              pendingRollRef.current = stamped;
              setPendingRoll(stamped);
            }
          }
        }
        if (
          !isDebug &&
          msgType !== "dice" &&
          actionIntentNorm &&
          effGameModeForIntent === "combat" &&
          effOrderForIntent.length > 0 &&
          isPlayerCombatTurn &&
          !isActingCombatantTurn
        ) {
          addMessage(
            "ai",
            "Cette commande ne correspond pas au combattant actif au tour courant (soumetteur ≠ tour).",
            multiplayerSessionId ? "meta" : "intent-error",
            makeMsgId()
          );
          suppressReplyForThisResponse = true;
          rollRequestSafe = null;
        }

        // Ne jamais accepter un nouveau rollRequest en réponse Ã  un résultat de dé ðŸŽ²
        // (évite les doubles jets pour la même action).
        const ecKind =
          engineEvent && typeof engineEvent === "object"
            ? String(engineEvent.kind ?? "")
            : "";
        const engineDiceResolutionKind =
          ecKind === "attack_resolution" ||
          ecKind === "spell_attack_resolution" ||
          ecKind === "spell_save_resolution" ||
          ecKind === "spell_auto_hit_resolution" ||
          ecKind === "gm_secret_resolution" ||
          /** Jets de compétence / sauvegarde résolus dans handleRoll (Médecine stabiliser, etc.) */
          ecKind === "skill_resolution";
        const diceLineLooksResolved =
          /^(?:🎲|ðŸŽ²)/i.test(String(userContent ?? "").trim());
        const isDiceResult =
          msgType === "dice" &&
          (diceLineLooksResolved || engineDiceResolutionKind);
        let effectiveRollRequest = isDiceResult ? null : rollRequestSafe;
        if (
          msgType === "dice" &&
          (ecKind === "attack_resolution" ||
            ecKind === "spell_attack_resolution") &&
          engineEvent?.hit === false
        ) {
          effectiveRollRequest = null;
          pendingRollRef.current = null;
          setPendingRoll(null);
        }
        if (isDiceResult && rollRequest) {
          addMessage(
            "ai",
            `[DEBUG] rollRequest ignoré car message précédent = résultat ðŸŽ²\n` + safeJson({ rollRequest }),
            "debug",
            makeMsgId()
          );
        }

        // Valider les rollRequest d'attaque côté moteur (anti-hallucinations : arme/cible inexistantes)
        if (effectiveRollRequest) {
          if (effectiveRollRequest?.kind === "gm_secret") {
            const rawNotation =
              effectiveRollRequest.roll ?? effectiveRollRequest.dice ?? "1d20";
            const rollNotation =
              typeof rawNotation === "string" && rawNotation.trim()
                ? rawNotation.trim()
                : "1d20";
            const reason = effectiveRollRequest.reason ?? "Jet secret";
            const gmSecretKey = [
              baseRoomId ?? "",
              baseScene ?? "",
              reason,
              rollNotation,
              String(userContent ?? "").slice(0, 100),
            ].join("::");

            if (hasExecutedGmSecret(gmSecretKey)) {
              addMessage(
                "ai",
                `[DEBUG] gm_secret dédupliqué (déjà résolu) — ${rollNotation}\n` +
                  safeJson({
                    room: baseRoomId,
                    reason,
                    roll: rollNotation,
                  }),
                "debug",
                makeMsgId()
              );
              effectiveRollRequest = null;
              return;
            }
            markExecutedGmSecret(gmSecretKey);
            const r = rollDiceDetailed(rollNotation);
            addMessage(
              "ai",
              `[DEBUG] Jet secret (${reason}) — ${rollNotation} [${r.rolls.join("+")}] = **${r.total}**`,
              "debug",
              makeMsgId()
            );
            playBip();
            await callApi(
              `[Jet secret résolu] ${rollNotation} = ${r.total}`,
              "dice",
              false,
              {
                hideUserMessage: true,
                skipAutoPlayerTurn: true,
                skipGmContinue: true,
                entities: postEntities,
                currentRoomId: baseRoomId,
                currentScene: baseScene,
                currentSceneName,
                gameMode: newGameMode ?? baseGameMode,
                engineEvent: {
                  kind: "gm_secret_resolution",
                  roll: rollNotation,
                  total: r.total,
                  rolls: r.rolls,
                  reason: reason,
                },
              }
            );
            return;
          }

          // Magicien : blocage strict si sort non préparé (prepared-only)
          if (player?.entityClass === "Magicien" && effectiveRollRequest.weaponName) {
            const canonName = canonicalizeSpellNameAgainstPlayer(player, effectiveRollRequest.weaponName);
            const candidate = canonName ?? effectiveRollRequest.weaponName;
            const isSpell = !!SPELLS?.[candidate];
            if (isSpell) {
              const prepared = Array.isArray(player?.selectedSpells) ? player.selectedSpells : [];
              const raw = normalizeFr(candidate);
              const ok = prepared.some((s) => normalizeFr(s) === raw);
              if (!ok) {
                addMessage(
                  "ai",
                  `âš  Sort non préparé â€” vous ne pouvez pas lancer **${candidate}** tant qu'il n'est pas dans vos sorts préparés.`,
                  undefined,
                  makeMsgId()
                );
                addMessage(
                  "ai",
                  `[DEBUG] Sort Magicien bloqué (non préparé)\n` + safeJson({ weaponName: candidate, prepared }),
                  "debug",
                  makeMsgId()
                );
                suppressReplyForThisResponse = true;
                effectiveRollRequest = null;
              } else if (canonName) {
                effectiveRollRequest.weaponName = canonName;
              }
            }
          }

          // Détection souple des sorts (le nom peut être bruité, mal typé, ou le kind incorrect)
          const knownSpells = Array.isArray(player.selectedSpells) ? player.selectedSpells : [];
          let canonicalSpellName = null;
          let canonicalSpellIsOffensive = false;
          if (knownSpells.length) {
            // Canonicaliser d'abord le nom de sort si l'IA en fournit un
            if (effectiveRollRequest.weaponName) {
              const canon = canonicalizeSpellNameAgainstPlayer(player, effectiveRollRequest.weaponName);
              if (canon) effectiveRollRequest.weaponName = canon;
            }
            const rawName = normalizeFr(effectiveRollRequest.weaponName ?? "");
            const text    = normalizeFr(userContent ?? "");
            canonicalSpellName =
              knownSpells.find((s) => {
                const sl = normalizeFr(s);
                return (rawName && rawName.includes(sl)) || (sl && text.includes(sl));
              }) ?? null;
            if (canonicalSpellName) {
              effectiveRollRequest.weaponName = canonicalSpellName;
              const spell = SPELLS?.[canonicalSpellName];
              canonicalSpellIsOffensive =
                !!spell &&
                (!!spell.save ||
                  spellRequiresAttackRoll(spell) === true ||
                  String(spell?.damage ?? "").trim().length > 0);
            }
          }

          // Si on reconnaît un sort, on force le kind correct :
          // - sort Ã  save sur PNJ => on le traite comme une "attack" pour déclencher la résolution auto (sans jet joueur)
          // - kind:"spell" => "attack"
          if (canonicalSpellName && canonicalSpellIsOffensive) {
            const spell = SPELLS?.[canonicalSpellName];
            if (effectiveRollRequest.kind === "spell") {
              effectiveRollRequest.kind = "attack";
            }
            if (spell?.save && effectiveRollRequest.targetId && effectiveRollRequest.targetId !== "player") {
              effectiveRollRequest.kind = "attack";
            }
          }
          if (canonicalSpellName && !canonicalSpellIsOffensive) {
            addMessage(
              "ai",
              `⚠️ ${canonicalSpellName} est un sort défensif/utilitaire ; aucun jet offensif n'est lancé.`,
              undefined,
              makeMsgId()
            );
            suppressReplyForThisResponse = true;
            effectiveRollRequest = null;
          }

          const isAttack = effectiveRollRequest.kind === "attack";
          const isSpellAttack =
            isAttack && !!canonicalSpellName && canonicalSpellIsOffensive;

          // Normaliser le bonus pour les attaques de sort : mod d'incantation + PB
          if (isSpellAttack) {
            const bonus = computeSpellAttackBonus(player);
            effectiveRollRequest.totalBonus = bonus;
          }

          // En combat : une seule Action d'attaque par tour.
          const turnResourcesForActingCombatant =
            actingMeleeCombatantId &&
            turnResourcesByCombatantId &&
            typeof turnResourcesByCombatantId === "object" &&
            turnResourcesByCombatantId[actingMeleeCombatantId]
              ? normalizeTurnResourcesInput(turnResourcesByCombatantId[actingMeleeCombatantId])
              : normalizeTurnResourcesInput(turnResourcesRef.current);
          const turnResourcesForAttackGate =
            actingMeleeCombatantId && mpLocalCombatantIdsEqual(actingMeleeCombatantId, localCombatantId)
              ? normalizeTurnResourcesInput(turnResourcesRef.current)
              : turnResourcesForActingCombatant;
          const setTurnResourcesForActingCombatant = (fnOrObj) => {
            if (
              actingMeleeCombatantId &&
              !mpLocalCombatantIdsEqual(actingMeleeCombatantId, localCombatantId)
            ) {
              setTurnResourcesForCombatant(actingMeleeCombatantId, fnOrObj);
              return;
            }
            setTurnResourcesSynced(fnOrObj);
          };
          if (isAttack && gameMode === "combat" && !turnResourcesForAttackGate?.action) {
            addMessage(
              "ai",
              "⚠ Votre **Action** a déjà été utilisée ce tour-ci (y compris une attaque ratée, ex. arbalète). " +
                "Un simple déplacement (se mettre à l'abri, reculer) ne rend pas l'Action : il utilise le **mouvement**. " +
                "Terminez votre tour ou utilisez une action bonus/réaction si disponible.",
              undefined,
              makeMsgId()
            );
            // On ignore ce rollRequest pour ne pas ouvrir de bandeau de dé.
            return;
          }

          if (isAttack) {
            const isUnarmed = looksLikeUnarmedAttack(userContent);
            // Canonicaliser weaponName (casse/accents) pour matcher la fiche joueur
            if (effectiveRollRequest.weaponName) {
              const canon = canonicalizeWeaponNameAgainstPlayer(player, effectiveRollRequest.weaponName);
              if (canon) effectiveRollRequest.weaponName = canon;
            }
            const weaponDeclared = !!effectiveRollRequest.weaponName;
            const weaponNameNorm = normalizeFr(effectiveRollRequest.weaponName ?? "");
            const ownedWeaponNames = (player.weapons ?? []).map((w) => w.name);
            const isOwnedWeapon = weaponDeclared
              ? ownedWeaponNames.some((n) => normalizeFr(n) === weaponNameNorm)
              : false;
            const matchedWeaponForRoll =
              weaponDeclared && isOwnedWeapon
                ? (player.weapons ?? []).find((w) => normalizeFr(w?.name ?? "") === weaponNameNorm) ?? null
                : null;
            const isSrdWeapon = weaponDeclared
              ? Object.keys(WEAPONS ?? {}).some((n) => normalizeFr(n) === weaponNameNorm)
              : false;
            const weaponEquippedForRoll =
              !matchedWeaponForRoll ||
              isSpellAttack ||
              isUnarmed ||
              isWeaponEquippedForCombat(player, matchedWeaponForRoll);
            const weaponOk =
              isUnarmed ||
              isSpellAttack ||
              (isOwnedWeapon && weaponEquippedForRoll);
            const targetOk =
              !!effectiveRollRequest.targetId &&
              baseEntities.some((e) => e.id === effectiveRollRequest.targetId && e.visible && e.isAlive);

            // Sanity check cible : si le joueur vise clairement un élément de décor, refuser une cible créature non mentionnée
            const envKeywords = ["vin", "tonneau", "rideau", "cheminée", "poutre", "table", "sol", "mur", "plafond"];
            const mentionsEnv = envKeywords.some((k) => String(userContent ?? "").toLowerCase().includes(k));
            const targetEnt = baseEntities.find((e) => e.id === effectiveRollRequest.targetId) ?? null;
            const mentionsTargetName = targetEnt
              ? String(userContent ?? "").toLowerCase().includes(String(targetEnt.name ?? "").toLowerCase())
              : false;
            const looksLikeWrongTarget = mentionsEnv && targetEnt && targetEnt.type !== "object" && !mentionsTargetName;

            if (!weaponOk || !targetOk) {
              const weaponList = player.weapons.map((w) => w.name).join(", ");
              // Ne dire "vous n'avez pas cette arme" QUE si weaponName correspond clairement
              // Ã  une arme SRD connue mais absente de la fiche du joueur.
              const ownedButNotEquipped =
                weaponDeclared &&
                isOwnedWeapon &&
                matchedWeaponForRoll &&
                !isSpellAttack &&
                !isUnarmed &&
                !weaponEquippedForRoll;
              const showWeaponError =
                !weaponOk &&
                !isUnarmed &&
                weaponDeclared &&
                !isSpellAttack &&
                isSrdWeapon &&
                !isOwnedWeapon;
              addMessage(
                "ai",
                ownedButNotEquipped
                  ? `Action impossible : **${matchedWeaponForRoll.name}** n'est pas équipée (ni en main principale ni en main secondaire). Équipez-la ou utilisez une arme que vous tenez en main.`
                  : showWeaponError
                    ? `âš  Vous n'avez pas cette arme. Armes disponibles : ${weaponList}.`
                    : `âš  Cible d'attaque invalide (introuvable ou non visible).`,
                undefined,
                makeMsgId()
              );
              addMessage(
                "ai",
                `[DEBUG] rollRequest attack rejeté (weaponOk=${weaponOk}, isUnarmed=${isUnarmed}, targetOk=${targetOk})\n` +
                  safeJson({ rollRequest: effectiveRollRequest }),
                "debug",
                makeMsgId()
              );
              suppressReplyForThisResponse = true;
            } else if (looksLikeWrongTarget) {
              addMessage(
                "ai",
                `âš  Votre action vise un élément du décor. Précisez la cible (ex: \"le tonneau de vin\", \"les rideaux\", \"la cheminée\").`,
                undefined,
                makeMsgId()
              );
              addMessage(
                "ai",
                `[DEBUG] rollRequest attack rejeté (cible incohérente vs décor)\n` +
                  safeJson({ content: userContent, targetId: effectiveRollRequest.targetId, targetName: targetEnt?.name, targetType: targetEnt?.type }),
                "debug",
                makeMsgId()
              );
              suppressReplyForThisResponse = true;
            } else {
              // Règle moteur (ToM) : si engagé au corps Ã  corps et pas désengagé,
              // on bloque les attaques Ã  distance / sorts Ã  distance (sinon il faudrait gérer le désavantage).
              const weaponName = String(effectiveRollRequest.weaponName ?? "");
              const meleeWith = getMeleeWith(localCombatantId);
              const targetId = effectiveRollRequest.targetId;
              const inMeleeWithTarget = targetId && meleeWith.includes(targetId);
              const ownedWeaponForRollReq =
                !isSpellAttack && weaponDeclared && effectiveRollRequest.weaponName
                  ? player?.weapons?.find(
                      (w) => normalizeFr(w.name) === normalizeFr(String(effectiveRollRequest.weaponName))
                    )
                  : null;
              const thrownIntentGm =
                ownedWeaponForRollReq &&
                getWeaponCompendiumEntry(ownedWeaponForRollReq)?.supportsThrown &&
                userContentSuggestsThrownWeaponAttack(userContent, ownedWeaponForRollReq.name);
              const weaponCountsAsRangedHere =
                ownedWeaponForRollReq &&
                resolveAttackMode(ownedWeaponForRollReq, player, {
                  inMeleeWithTarget: !!inMeleeWithTarget,
                  treatAsThrown: !!thrownIntentGm,
                }).attackType === "ranged";
              const rangedLike =
                isRangedWeaponName(weaponName) ||
                /arc|arbal|fronde/i.test(weaponName) ||
                weaponCountsAsRangedHere ||
                (!!isSpellAttack && meleeWith.length > 0 && !inMeleeWithTarget);
              if (
                gameMode === "combat" &&
                !hasDisengagedThisTurn &&
                rangedLike &&
                inMeleeWithTarget &&
                !thrownIntentGm
              ) {
                addMessage(
                  "ai",
                  `âš  Vous êtes au **corps Ã  corps**. Tant que vous n'êtes pas **désengagé**, ` +
                    `vous ne pouvez pas effectuer d'attaque Ã  distance : attaquez l'ennemi au contact ou utilisez **Se désengager**.`,
                  undefined,
                  makeMsgId()
                );
                addMessage(
                  "ai",
                  `[DEBUG] Attaque Ã  distance bloquée car engagé au corps Ã  corps\n` +
                    safeJson({ meleeWith, rollRequest: effectiveRollRequest }),
                  "debug",
                  makeMsgId()
                );
                return;
              }

              // IMPORTANT : Sorts Ã  jet de sauvegarde (save) â†’ TOUT est résolu par le moteur
              // sans jet du joueur ni bouton "Lancer le dé".
              if (isSpellAttack) {
                const spell = SPELLS?.[canonicalSpellName];
                if (spell?.save) {
                  // Même logique que dans handleRoll, mais exécutée immédiatement ici.
                  const target = baseEntities.find((e) => e.id === effectiveRollRequest.targetId) ?? null;
                  if (!target) {
                    addMessage(
                      "ai",
                      `[DEBUG] Sort Ã  save ignoré (cible introuvable)\n` +
                        safeJson({ rollRequest: effectiveRollRequest }),
                      "debug",
                      makeMsgId()
                    );
                    return;
                  }

                  const compErrSpell = spellComponentsBlockReasonForPlayer(player, canonicalSpellName);
                  if (compErrSpell) {
                    addMessage("ai", `⚠️ ${compErrSpell}`, undefined, makeMsgId());
                    return;
                  }

                  const resourceKind = resourceKindForCastingTime(spell.castingTime);
                  const effGmRollReq = gameStateRef.current?.gameMode ?? gameMode;
                  if (!hasResource(turnResourcesForActingCombatant, effGmRollReq, resourceKind)) {
                    const label =
                      resourceKind === "bonus"
                        ? "Action bonus"
                        : resourceKind === "reaction"
                        ? "Réaction"
                        : "Action";
                    addMessage(
                      "ai",
                      `âš  Vous avez déjÃ  utilisé votre **${label}** ce tour-ci â€” impossible de lancer ${canonicalSpellName} maintenant.`,
                      undefined,
                      makeMsgId()
                    );
                    return;
                  }

                  const slotResult = spendSpellSlot(player, updatePlayer, spell.level ?? 0);
                  if (!slotResult.ok) {
                    addMessage(
                      "ai",
                      `âš  Vous n'avez plus d'emplacements de sort disponibles pour lancer ${canonicalSpellName}.`,
                      undefined,
                      makeMsgId()
                    );
                    return;
                  }

                  const dc = computeSpellSaveDC(player);
                  const nat = debugNextRoll ?? (Math.floor(Math.random() * 20) + 1);
                  if (debugNextRoll !== null) setDebugNextRoll(null);
                  const saveBonus = computeEntitySaveBonus(target, spell.save);
                  const total = nat + saveBonus;
                  const succeeded = total >= dc;

                  const dmgNotation = String(spell.damage ?? "1d6");
                  const r = rollDiceDetailed(dmgNotation);
                  const fullDmg = r.total;
                  const baseDmg = Math.max(0, fullDmg);
                  const finalDmg = succeeded ? Math.floor(baseDmg / 2) : baseDmg;

                  let myUpdates = [];
                  if (target.type !== "hostile") {
                    myUpdates.push({ id: target.id, action: "update", type: "hostile" });
                  }

                  let hpBefore = target.hp?.current ?? null;
                  let hpAfter = hpBefore;
                  if (target.hp && finalDmg > 0) {
                    const newHp = Math.max(0, target.hp.current - finalDmg);
                    hpAfter = newHp;
                    if (newHp <= 0) {
                      myUpdates.push({ id: target.id, action: "kill" });
                    } else {
                      const idx = myUpdates.findIndex((u) => u.action === "update" && u.id === target.id);
                      if (idx >= 0) {
                        myUpdates[idx] = { ...myUpdates[idx], hp: { current: newHp, max: target.hp.max } };
                      } else {
                        myUpdates.push({ id: target.id, action: "update", hp: { current: newHp, max: target.hp.max } });
                      }
                    }
                  }

                  myUpdates = markSceneHostilesAware(baseEntities, myUpdates);
                  const nextEntities = myUpdates.length ? applyUpdatesLocally(baseEntities, myUpdates) : baseEntities;
                  if (myUpdates.length) applyEntityUpdates(myUpdates);
                  ensureCombatState(nextEntities);

                  // Consommation de ressource : toujours traité comme une action de COMBAT
                  consumeResource(setTurnResourcesForActingCombatant, "combat", resourceKind);

                  addMessage(
                    "ai",
                    `[DEBUG] Résolution sort (save) ${canonicalSpellName}\n` +
                      safeJson({
                        targetId: target.id,
                        targetName: target.name,
                        saveType: spell.save,
                        nat,
                        saveBonus,
                        total,
                        dc,
                        succeeded,
                        damage: finalDmg,
                        hpBefore,
                        hpAfter,
                        slotLevelUsed: slotResult.usedLevel,
                        resourceKind,
                      }),
                    "debug",
                    makeMsgId()
                  );

                  const saveLabel = `${spell.save}`;
                  const bonusStr = fmtMod(saveBonus);
                  const saveLine =
                    nat === 20
                      ? `Nat **20** ðŸ’¥ (réussite automatique)`
                      : nat === 1
                      ? `Nat **1** ðŸ’€ (échec automatique)`
                      : `Nat ${nat} ${bonusStr} = **${total}** vs DD ${dc}`;
                  const outcome = succeeded ? "âœ” Réussite â€” dégâts réduits." : "âœ– Ã‰chec â€” dégâts complets.";
                  let dmgDetail = formatDiceNotationDetail(r, dmgNotation);
                  if (succeeded) {
                    dmgDetail += " â†’ moitié dégâts";
                  }
                  const dmgLine =
                    finalDmg > 0
                      ? `${dmgDetail} = **${finalDmg} dégâts ${spell.damageType ?? ""}**`
                      : "Aucun dégât.";

                  const content =
                    `ðŸŽ² Jet de sauvegarde (${saveLabel} pour ${canonicalSpellName} â†’ ${target.name}) â€” ${saveLine}\n` +
                    `${outcome} ${dmgLine}.`;

                  await callApi(content, "dice", false, {
                    entities: nextEntities,
                    engineEvent: {
                      kind: "spell_save_resolution",
                      spellName: canonicalSpellName,
                      targetId: target.id,
                      saveType: spell.save,
                      nat,
                      total,
                      dc,
                      succeeded,
                      damage: finalDmg,
                      targetHpBefore: hpBefore,
                      targetHpAfter: hpAfter,
                      targetHpMax: target.hp?.max ?? null,
                      targetIsAlive: hpAfter === null ? true : hpAfter > 0,
                      slotLevelUsed: slotResult.usedLevel,
                    },
                  });

                  return;
                }
                const compErrAtkRoll = spellComponentsBlockReasonForPlayer(player, canonicalSpellName);
                if (compErrAtkRoll) {
                  addMessage("ai", `⚠️ ${compErrAtkRoll}`, undefined, makeMsgId());
                  return;
                }
              }

              // Pas un sort Ã  save â†’ on ouvre un rollRequest d'attaque normal pour le joueur.
              const stampedAtk = stampPendingRollForActor(
                effectiveRollRequest,
                actingPlayer,
                rollSubmitterClientId
              );
              pendingRollRef.current = stampedAtk;
              setPendingRoll(stampedAtk);
            }
          } else {
            // Check/save: bonus calculé côté moteur (stats + maîtrise), pas par l'IA
            // IMPORTANT : on ne demande UN jet au joueur que pour SES propres jets (skill check, save du joueur).
            // Si l'IA demande un "save" pour une cible PNJ, on l'ignore : les sauvegardes PNJ sont résolues par le moteur
            // (ex : sort de Fracasse / Boule de feu â†’ save des créatures gérée côté sort, pas via bouton de dé du joueur).
            const kind = effectiveRollRequest.kind ?? "check";
            const targetId = effectiveRollRequest.targetId ?? null;

            // Toutes les sauvegardes NON ciblées sur le joueur sont considérées comme des saves PNJ
            // (par ex. Fracasse, Boule de feu, etc.) et sont résolues automatiquement par le moteur.
            if (kind === "save" && targetId !== "player") {
              addMessage(
                "ai",
                `[DEBUG] rollRequest save ignoré (sauvegarde non-joueur gérée automatiquement par le moteur, aucun jet demandé au joueur)\n` +
                  safeJson({ rollRequest: effectiveRollRequest }),
                "debug",
                makeMsgId()
              );
              // Pas de pendingRoll â†’ pas de bouton "Lancer le dé" pour ce cas.
              return;
            }

            // Protection : si l'IA renvoie un rollRequest incomplet (stat manquant),
            // on ne doit jamais afficher "Jet de undefined".
            if (!effectiveRollRequest.stat) {
              addMessage(
                "ai",
                `[DEBUG] rollRequest check/save ignoré (stat manquant)\n` +
                  safeJson({ rollRequest: effectiveRollRequest }),
                "debug",
                makeMsgId()
              );
              return;
            }

            const skill = effectiveRollRequest.skill ?? null;
            const computed = computeCheckBonus({ player: actingPlayer, stat: effectiveRollRequest.stat, skill });
            const normalizedRoll = stampPendingRollForActor(
              { ...effectiveRollRequest, skill: skill ?? undefined, totalBonus: computed },
              actingPlayer,
              rollSubmitterClientId
            );
            pendingRollRef.current = normalizedRoll;
            setPendingRoll(normalizedRoll);
            addMessage(
              "ai",
              `[DEBUG] rollRequest check/save normalisé (bonus moteur)\n` +
                safeJson({ from: effectiveRollRequest.totalBonus, to: computed, skill }),
              "debug",
              makeMsgId()
            );
          }
        }

        // Plus d'auto-simulation des ennemis ici : les ennemis jouent via le bouton "Fin de tour".
        // Mode combat piloté par le moteur : combat si au moins 1 hostile a repéré le joueur.
        ensureCombatState(postEntities, acceptedGmCombatOrder ?? null);

        {
          const hasHostileAfter = hasAnyCombatReadyHostile(postEntities);
          const gmSentRejectedOrder =
            Array.isArray(newCombatOrder) &&
            newCombatOrder.length > 0 &&
            acceptedGmCombatOrder == null;
          let effCombatOrder;
          if (!hasHostileAfter) {
            effCombatOrder = [];
          } else if (acceptedGmCombatOrder != null) {
            effCombatOrder = acceptedGmCombatOrder;
          } else if (gmSentRejectedOrder) {
            // MJ a listé seulement des ennemis (ou un ordre incomplet) : on n'écrase pas un ordre client déjà valide.
            effCombatOrder = baseCombatOrder.length > 0 ? baseCombatOrder : [];
          } else {
            effCombatOrder = baseCombatOrder;
          }
          let effGameMode = hasHostileAfter ? "combat" : "exploration";
          // Si on passe d'exploration -> combat (nouveaux hostiles) et que l'IA ne fournit pas
          // un combatOrder explicite (combatOrder: null/undefined), alors on considère que
          // l'initiative doit être "déclenchée" par l'UI/auto-joueur : on active donc le wait.
          // Cela évite le cas où baseCombatOrder contient encore des valeurs stales.
          const transitioningToCombat = baseGameMode !== "combat" && effGameMode === "combat";
          if (transitioningToCombat && !Array.isArray(acceptedGmCombatOrder)) {
            effCombatOrder = [];
          }
          combatAwaitingInitiativeAfterResponse =
            effGameMode === "combat" &&
            hasAnyCombatReadyHostile(postEntities) &&
            (!effCombatOrder || effCombatOrder.length === 0);
          if (combatAwaitingInitiativeAfterResponse) {
            // Attendre une vraie narration GM (pas juste un message vide/fallback)
            waitForGmNarrationForInitiativeLiveRef.current = true;
            setWaitForGmNarrationForInitiative(true);
          }
        }

        // Mise Ã  jour de scène demandée par l'IA (procédural)
        if (safeSceneUpdate?.hasChanged && (safeSceneUpdate.newSceneDescription || safeSceneUpdate.targetRoomId)) {
        let tid = safeSceneUpdate.targetRoomId;
        // Garde-fou UX/gameplay :
        // si le joueur n'a pas demandé explicitement d'entrer/franchir,
        // on évite que le moteur "déplace" la scène immédiatement (porte forcée != entrée).
        // Utiliser baseRoomId (la salle réellement envoyée au MJ) pour éviter
        // les validations erronées dues à un state React potentiellement stale.
        const visibleExits = getVisibleExitsForRoom(baseRoomId, getRoomMemory(baseRoomId));
        const allowedExits = Array.isArray(visibleExits)
          ? visibleExits
              .map((exitDef) =>
                typeof exitDef === "string" ? exitDef : String(exitDef?.id ?? "").trim()
              )
              .filter(Boolean)
          : [];
        const isValid =
          tid &&
          GOBLIN_CAVE[tid] &&
          (allowedExits.length === 0 || allowedExits.includes(tid));
        if (!isValid && tid) {
          addMessage(
            "ai",
            `[DEBUG] sceneUpdate ignoré — targetRoomId "${tid}" non accessible depuis la salle actuelle (exits: ${allowedExits.join(", ") || "aucun"})\n` +
              safeJson({
                baseRoomId,
                targetRoomId: tid,
                allowedExits,
                sceneUpdate: safeSceneUpdate,
              }),
            "debug",
            makeMsgId()
          );
        } else if (isValid) {
        // Réinitialiser les états liés au tour / engagement / jets en cours
        setMovementGate(null);
        clearMeleeFor(localCombatantId);
        setHasDisengagedThisTurn(false);
        // Si cette même réponse transporte un rollRequest valide (ex: arrivée devant une porte
        // + tentative de l'enfoncer), on ne doit PAS effacer le jet demandé.
        if (!effectiveRollRequest) {
          pendingRollRef.current = null;
          setPendingRoll(null);
        }

          const room = GOBLIN_CAVE[tid];
          const finalName = room?.title ?? safeSceneUpdate.newSceneName;
          const finalDesc = room?.description ?? safeSceneUpdate.newSceneDescription;

          let finalEntities = [];
          if (tid === "scene_journey") {
            // Sur le chemin (scene_journey), le commis ne suit pas et Thron reste Ã  la forge.
            // Par cohérence gameplay/IA, la scène ne doit contenir aucune entité.
            finalEntities = [];
          } else if (
            Array.isArray(safeSceneUpdate.newEntities) &&
            safeSceneUpdate.newEntities.length > 0 &&
            tid === baseRoomId
          ) {
            // IMPORTANT: n'utiliser `newEntities` que pour des ajustements intra-salle.
            // En changement de salle, cette payload peut contenir des entités de la salle quittée
            // (ex: cadavres hostiles), ce qui les "téléporte" visuellement à tort.
            finalEntities = safeSceneUpdate.newEntities;
          } else {
            finalEntities = takeEntitiesForRoom(tid);
          }

          const isAlreadyInTarget = !!(tid && tid === baseRoomId);

          if (!isAlreadyInTarget) {
            rememberRoomEntitiesSnapshot(baseRoomId, postEntities);
            if (tid && room) setCurrentRoomId(tid);
            if (finalName) setCurrentSceneName(finalName);
            if (finalDesc) setCurrentScene(finalDesc);
            // Changement de salle => repartir sans ancien ordre d'initiative.
            // Si la salle d'arrivée déclenche un combat, il sera recréé proprement.
            setCombatOrder([]);
            setGameMode("exploration", finalEntities, { force: true });
            setCombatHiddenIds([]);
            clearCombatStealthTotals();

            if (typeof safeSceneUpdate.newSceneImage === "string" && safeSceneUpdate.newSceneImage.trim()) {
              setCurrentSceneImage(safeSceneUpdate.newSceneImage.trim());
            }

            replaceEntities(finalEntities);
            addMessage(
              "ai",
              `[DEBUG] sceneUpdate appliqué\n` +
                safeJson({
                  fromRoomId: baseRoomId,
                  toRoomId: tid,
                  byGmSceneUpdate: true,
                }),
              "debug",
              makeMsgId()
            );
            // Sync immédiate du ref : le prochain fetch ([SceneEntered]) peut partir
            // avant le re-render React (setTimeout(0)).
            gameStateRef.current = {
              ...gameStateRef.current,
              currentRoomId: tid,
              entities: finalEntities,
              ...(finalDesc ? { currentScene: finalDesc } : {}),
              ...(finalName ? { currentSceneName: finalName } : {}),
            };
            autoPlayerOverrides = {
              entities: finalEntities,
              currentRoomId: tid,
              currentScene: finalDesc,
              currentSceneName: finalName,
            };
            sceneUpdateApplied = true;

            if (!skipSceneRulesResolvedPipeline) {
              // Important: on a déjà déclenché le pipeline de résolution de scène
              // (gm-arbiter -> [SceneRulesResolved]) via setTimeout.
              // Anti-faux-raccord : dès qu'on lance le pipeline
              // (gm-arbiter -> [SceneRulesResolved]) pour une entrée de scène,
              // on coupe la narration du `callApi` courant. Sinon tu vois
              // parfois un “GM narration” avant que les conséquences de l'arbitre
              // aient appliqué les spawns / règles.
              suppressReplyForThisResponse = true;

              addMessage(
                "ai",
                `[DEBUG] sceneUpdate appliqué â†’ ${finalName ?? safeSceneUpdate.newSceneName ?? "scène sans nom"}${tid ? ` (${tid})` : ""}`,
                "debug",
                makeMsgId()
              );

              sceneEnteredPipelineDepthRef.current += 1;
              setTimeout(() => {
                void Promise.resolve(
                  runSceneEntryGmArbiter({
                    roomId: tid,
                    scene: finalDesc,
                    sceneName: finalName,
                    entitiesAtEntry: finalEntities,
                    sourceAction: `[SceneEntered] ${tid}`,
                    baseGameMode: gameStateRef.current?.gameMode ?? baseGameMode,
                  })
                    .then((resolved) => {
                      if (resolved?.awaitingPlayerRoll === true) return;
                      return callApi("[SceneRulesResolved]", "meta", false, {
                        hideUserMessage: true,
                        bypassIntentParser: true,
                        skipAutoPlayerTurn: true,
                        skipGmContinue: true,
                        entities: resolved?.nextEntities ?? finalEntities,
                        currentRoomId: resolved?.nextRoomId ?? tid,
                        currentScene: resolved?.nextScene ?? finalDesc,
                        currentSceneName: resolved?.nextSceneName ?? finalName,
                        gameMode: resolved?.nextGameMode ?? (gameStateRef.current?.gameMode ?? baseGameMode),
                        engineEvent: resolved?.engineEvent ?? {
                          kind: "scene_rule_resolution",
                          roomId: tid,
                          reason: "Entrée dans le lieu.",
                        },
                      });
                    })
                    .catch((e) => {
                      addMessage(
                        "ai",
                        `[DEBUG] Erreur GM Arbitre de scène: ${String(e?.message ?? e)}`,
                        "debug",
                        makeMsgId()
                      );
                      markFlowFailure(String(e?.message ?? e), {
                        kind: "sceneEntered",
                        roomId: tid,
                        scene: finalDesc,
                        sceneName: finalName,
                        entitiesAtEntry: finalEntities,
                        sourceAction: userContent,
                        baseGameMode: gameStateRef.current?.gameMode ?? baseGameMode,
                      });
                    })
                ).finally(() => {
                  sceneEnteredPipelineDepthRef.current = Math.max(
                    0,
                    sceneEnteredPipelineDepthRef.current - 1
                  );
                });
              }, 0);
            } else {
              addMessage(
                "ai",
                `[DEBUG] sceneUpdate appliqué (arbitre déjà exécuté après parse-intent — pas de 2e chaîne [SceneRulesResolved])\n` +
                  safeJson({
                    fromRoomId: baseRoomId,
                    toRoomId: tid,
                  }),
                "debug",
                makeMsgId()
              );
            }
          } else {
            addMessage(
              "ai",
              `[DEBUG] sceneUpdate ignoré (déjà dans ${tid}).`,
              "debug",
              makeMsgId()
            );
          }
        }
        }
      }

      // Affichage de la narration IA (suppressions volontaires : intent/rollRequest invalides, sceneUpdate pipeline, etc.).
      let displayReply = suppressReplyForThisResponse
        ? ""
        : (String(safeReply ?? "").trim() ||
           fallbackNarrativeFromRollRequest(rollRequestSafe ?? rollRequest, baseEntities));

      // Filet de sécurité : si l'IA renvoie une réponse "vide",
      // on ajoute une courte réaction neutre si la narration n'a pas été volontairement masquée.
      if (!displayReply && !isDebug && !suppressReplyForThisResponse) {
        displayReply =
          "Un instant passe. Les regards se croisent, la tension flotte dans l'air en attendant la suite de la scèneâ€¦";
        addMessage(
          "ai",
          `[DEBUG] Réponse IA vide (valid:true, narrative manquante) â€” fallback narratif appliqué.\n` +
            safeJson({ reply, rollRequest, gameMode: newGameMode, entityUpdates }),
          "debug",
          makeMsgId()
        );
      }

      if (displayReply) {
        addMessage("ai", displayReply, isDebug ? "meta-reply" : undefined, makeMsgId());
        gmCombatNarrationShownThisCall = true;
      }

      triggerSceneImageFromNarratorDecision(imageDecisionEffective, {
        roomId: baseRoomId,
        sceneName: overrides?.currentSceneName ?? snap.currentSceneName ?? currentSceneName,
        engineEvent,
      });

      // Respect ordre souhaité par le moteur : narration d'abord (chat),
      // puis exécution des instructions (spawns / kills / updates).
      if (pendingEntityUpdatesForNarrationOrder?.length) {
        applyEntityUpdates(pendingEntityUpdatesForNarrationOrder);
        pendingEntityUpdatesForNarrationOrder = null;
      }
      // Ne pas débloquer `waitForGmNarrationForInitiative` ici : si on le fait dans le même batch React
      // que `setWait(true)` (lignes combat) + effet initiative, le dernier setState peut gagner et le
      // bandeau d'initiative apparaît avant que le joueur ait « vu » la narration. Le déblocage est
      // dans `finally` après `setIsTyping(false)`, via setTimeout(0), pour un tick après le rendu.
      playBip();

      // Un message de type "dice" peut être soit une demande de jet (rollRequest présent),
      // soit simplement la narration d'un jet déjÃ  résolu (aucun rollRequest).
      // Dans ce deuxième cas, on autorise le mode auto-joueur Ã  reprendre.
      const isDiceResolution = msgType === "dice" && !rollRequestSafe && !rollRequest;

      // Si le MJ demande de continuer : relancer l'API sans passer au joueur (garde-fou anti-boucle : max 5)
      let effectiveGmContinue = gmContinue === true && gmContinueCountRef.current < 5;

      // Si le joueur n'a donné aucune intention réelle (ex: "..."), on ne doit pas laisser le MJ
      // enchaîner automatiquement une continuation qui "interprète" à sa place.
      // On évite ainsi le cas où le MJ fait avancer la scène alors que le joueur n'a pas encore choisi.
      const trimmedUserContent = typeof userContent === "string" ? userContent.trim() : "";
      const isSystemContinuationCall =
        msgType === "continue" || trimmedUserContent === "[SceneEntered]";
      const isTrivialPlayerInput =
        msgType !== "continue" &&
        (trimmedUserContent === "" || /^[.\s]+$/.test(trimmedUserContent));

      if (isTrivialPlayerInput) {
        effectiveGmContinue = false;
        gmContinueCountRef.current = 0;
      } else if (effectiveGmContinue) {
        gmContinueCountRef.current += 1;
      } else if (gmContinue === false) {
        gmContinueCountRef.current = 0;
      }

      if (combatAwaitingInitiativeAfterResponse) {
        effectiveGmContinue = false;
      }
      if (!isSystemContinuationCall) {
        // Le MJ ne peut pas enclencher seul une continuation "en chaîne"
        // après un message joueur normal : évite les déplacements/progressions non demandés.
        effectiveGmContinue = false;
      }

      if (sceneUpdateApplied || skipGmContinue || skipAutoPlayerTurn) {
        // Ne jamais passer la main au joueur après une transition de scène
        // (y compris pendant [SceneEntered]).
      } else if (
        effectiveGmContinue &&
        !pendingRollRef.current &&
        !rollResolutionInProgressRef.current &&
        !flowBlockedRef.current
      ) {
        const overrides = autoPlayerOverrides ?? {
          entities: baseEntities,
          currentRoomId: baseRoomId,
          currentScene: baseScene,
          currentSceneName,
          gameMode: newGameMode ?? baseGameMode,
        };
        const continueMsg =
          "[Continue] Le joueur n'a rien à faire dans cette situation. Poursuis la narration en te référant aux secrets de la campagne pour la scène actuelle.";
        setTimeout(() => {
          callApi(continueMsg, "continue", false, overrides);
        }, 0);
      } else if (
        !pendingRollRef.current &&
        !rollResolutionInProgressRef.current &&
        autoPlayerEnabledRef.current &&
        !combatAwaitingInitiativeAfterResponse &&
        !flowBlockedRef.current
      ) {
        const overrides = autoPlayerOverrides;
        // Anti-race: éviter que l'auto-joueur parte avant que la dernière narration GM
        // soit "commit" dans `messagesRef.current` (useLayoutEffect).
        const scheduleAutoPlayerTurn = (cb) => {
          if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => cb());
            return;
          }
          // Fallback : une frame "typique" (si requestAnimationFrame indisponible)
          setTimeout(() => cb(), 16);
        };
        scheduleAutoPlayerTurn(() => {
          if (!autoPlayerEnabledRef.current) return;
          if ((gameStateRef.current?.gameMode ?? newGameMode ?? baseGameMode) === "combat" && !isPlayerTurnNow()) {
            return;
          }
          runAutoPlayerTurn(overrides);
        });
      }
    } catch (err) {
      // Latence même en cas d'échec (utile pour diagnostiquer)
      const t1 = (typeof performance !== "undefined" && performance.now)
        ? performance.now()
        : Date.now();
      const latencyMs = Math.max(0, Math.round(t1 - t0));
      setLatencyLastMs(latencyMs);
      const win = latencyWindowRef.current ?? [];
      win.push(latencyMs);
      while (win.length > 20) win.shift();
      latencyWindowRef.current = win;
      const avg = Math.round(win.reduce((a, b) => a + b, 0) / win.length);
      setLatencyAvgMs(avg);
      addMessage(
        "ai",
        `[DEBUG] Latence IA (${aiProvider}) (échec) : ${latencyMs}ms (moyenne ${win.length} = ${avg}ms)`,
        "debug",
        makeMsgId()
      );
      const details = err?.message ?? "Une erreur inattendue s'est produite.";
      markFlowFailure(details, {
        kind: "callApi",
        userContent,
        msgType,
        isDebug,
        overrides: {
          ...(overrides ?? {}),
          hideUserMessage: true,
          bypassFailureLock: true,
          entities: baseEntities,
          currentRoomId: baseRoomId,
          currentScene: baseScene,
          currentSceneName,
          gameMode: baseGameMode,
          engineEvent,
        },
      });
    } finally {
      if (naturalCallKey) {
        naturalCallInFlightKeysRef.current.delete(naturalCallKey);
      }
      const depthAfterMain = Math.max(0, apiProcessingDepthRef.current - 1);
      apiProcessingDepthRef.current = depthAfterMain;
      setIsTyping(false);
      // Après la fin du « MJ réfléchit » et un tour de rendu : libérer l'initiative seulement si une narration
      // a réellement été affichée. Sinon (sceneUpdate → pipeline [SceneRulesResolved], réponse supprimée),
      // on garde wait=true jusqu'au prochain callApi qui affiche la narration — sinon le jet d'initiative
      // passait avant le texte du MJ.
      // Libérer `wait` **avant** flush MP : sinon le snapshot Firestore part encore avec
      // waitForGmNarrationForInitiative=true (setTimeout(0) s'exécute après ce finally) et les
      // autres clients restent sur « Attendez la fin de la narration… » sans bandeau initiative.
      if (gmCombatNarrationShownThisCall && waitForGmNarrationForInitiativeLiveRef.current) {
        waitForGmNarrationForInitiativeLiveRef.current = false;
        setWaitForGmNarrationForInitiative(false);
      }
      await releaseMultiplayerProcessingLock(sessionLockId);
      if (multiplayerSessionId && depthAfterMain === 0) {
        try {
          await flushMultiplayerSharedState();
        } catch {
          /* ignore */
        }
      }
    }
  }

  async function retryFailedRequest() {
    if (!failedRequestPayload || isTyping || isRetryingFailedRequest) return;
    setIsRetryingFailedRequest(true);
    try {
      const k = failedRequestPayload.kind ?? "callApi";
      if (k === "nextTurn") {
        await nextTurn();
        setFlowBlocked(false);
        setError(null);
        setFailedRequestPayload(null);
        return;
      }
      if (k === "enemy-tactics") {
        const ord = gameStateRef.current?.combatOrder ?? combatOrder ?? [];
        const len = Array.isArray(ord) ? ord.length : 0;
        const curIdx =
          len > 0 ? Math.min(Math.max(0, combatTurnIndexLiveRef.current), len - 1) : 0;
        await runEnemyTurnsUntilPlayerRef.current({
          order: ord,
          startIndex: curIdx,
          skipInitialAdvance: true,
          __forceEntry: true,
        });
        setFlowBlocked(false);
        setError(null);
        setFailedRequestPayload(null);
        return;
      }
      if (k === "sceneEntered") {
        const resolved = await runSceneEntryGmArbiter({
          roomId: failedRequestPayload.roomId,
          scene: failedRequestPayload.scene,
          sceneName: failedRequestPayload.sceneName,
          entitiesAtEntry: failedRequestPayload.entitiesAtEntry,
          sourceAction: failedRequestPayload.sourceAction,
          baseGameMode: failedRequestPayload.baseGameMode,
          arbiterTrigger: { phase: "scene_entered_retry" },
        });
        if (resolved?.awaitingPlayerRoll !== true) {
          await callApi("[SceneRulesResolved]", "meta", false, {
            hideUserMessage: true,
            bypassIntentParser: true,
            skipAutoPlayerTurn: true,
            skipGmContinue: true,
            entities: resolved?.nextEntities ?? failedRequestPayload.entitiesAtEntry,
            currentRoomId: resolved?.nextRoomId ?? failedRequestPayload.roomId,
            currentScene: resolved?.nextScene ?? failedRequestPayload.scene,
            currentSceneName: resolved?.nextSceneName ?? failedRequestPayload.sceneName,
            gameMode: resolved?.nextGameMode ?? failedRequestPayload.baseGameMode,
            engineEvent: resolved?.engineEvent ?? {
              kind: "scene_rule_resolution",
              roomId: failedRequestPayload.roomId,
              reason: "Entrée dans le lieu.",
            },
            bypassFailureLock: true,
          });
        }
        setFlowBlocked(false);
        setError(null);
        setFailedRequestPayload(null);
        return;
      }
      if (k === "sceneArbiterAfterIntent") {
        const p = failedRequestPayload;
        const resolved = await runSceneEntryGmArbiter({
          roomId: p.roomId,
          scene: p.scene,
          sceneName: p.sceneName,
          entitiesAtEntry: p.entitiesAtEntry,
          sourceAction: p.userTextForResolve,
          baseGameMode: p.baseGameMode,
          intentDecision: p.intentDecision,
          actingPlayerOverride: p.actingPlayerOverride ?? null,
        });
        const mergedEngineEvent = mergeSceneArbiterIntentEngineEvent(
          resolved,
          p.engineEventBeforeArbiter,
          p.sceneUpdateSnapshot
        );
        if (resolved?.awaitingPlayerRoll === true) {
          setFlowBlocked(false);
          setError(null);
          setFailedRequestPayload(null);
          return;
        }
        const arbRes = String(resolved?.arbiterResolution ?? "").trim();
        const arbReason = String(resolved?.engineEvent?.reason ?? "").trim();
        if (
          arbRes === "no_roll_needed" &&
          /déjà\s+(répondu|traité|décrit|dit|annoncé|précisé|expliqué)|deja\s+(repondu|traite|decrit|dit|annonce|precise|explique)|sans\s+nouvelle\s+mécanique|aucune\s+nouvelle\s+mécanique/i.test(
            arbReason
          )
        ) {
          setFlowBlocked(false);
          setError(null);
          setFailedRequestPayload(null);
          return;
        }
        await callApi(p.userTextForResolve, "meta", false, {
          hideUserMessage: true,
          bypassIntentParser: true,
          skipAutoPlayerTurn: true,
          skipGmContinue: true,
          actingPlayer: p.actingPlayerOverride ?? player ?? null,
          entities: resolved?.nextEntities ?? p.entitiesAtEntry,
          currentRoomId: resolved?.nextRoomId ?? p.roomId,
          currentScene: resolved?.nextScene ?? p.scene,
          currentSceneName: resolved?.nextSceneName ?? p.sceneName,
          gameMode: gameStateRef.current?.gameMode ?? p.baseGameMode,
          engineEvent: mergedEngineEvent,
          bypassFailureLock: true,
        });
        setFlowBlocked(false);
        setError(null);
        setFailedRequestPayload(null);
        return;
      }
      if (k === "scene-image") {
        const vc = failedRequestPayload.visualContext ?? null;
        const mdl = failedRequestPayload.model ?? imageModel;
        if (vc && typeof vc === "object") {
          // Rejoue la génération d'image avec le même contexte.
          const pendingId = makeMsgId();
          const pendingLabel = "Le MJ peint une illustration...";
          const debugBlock =
            `[DEBUG] Retry image → /api/scene-image\n` + safeJson({ model: mdl });
          appendSceneImagePendingSlot(pendingId, pendingLabel, debugBlock);
          try {
            const { res, data } = await fetchJsonWithTimeout(
              "/api/scene-image",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ visualContext: vc, model: mdl }),
              },
              API_AI_THINKING_TIMEOUT_MS,
              "scene-image"
            );
            if (!res.ok) {
              const msg = data?.details
                ? `${data.error || "Erreur API"} (${data.status || res.status}): ${data.details}`
                : data?.error || `Erreur API interne: ${res.status}`;
              throw new Error(msg);
            }
            if (!data?.url) throw new Error("Réponse invalide du serveur d'images.");
            updateMessage(pendingId, { content: data.url, type: "scene-image" });
            setCurrentSceneImage(data.url);
          } finally {
            // En cas de succès, updateMessage remplace le pending slot ; sinon il reste (debug) et l'erreur générale s'affiche.
          }
        }
        setFlowBlocked(false);
        setError(null);
        setFailedRequestPayload(null);
        return;
      }
      if (k === "sceneArbiterAfterGmSecret") {
        const resolved = await runSceneEntryGmArbiter({
          roomId: failedRequestPayload.roomId,
          scene: failedRequestPayload.scene,
          sceneName: failedRequestPayload.sceneName,
          entitiesAtEntry: failedRequestPayload.entitiesAtEntry,
          sourceAction: failedRequestPayload.sourceAction,
          baseGameMode: failedRequestPayload.baseGameMode,
          rollResultOverride: failedRequestPayload.rollResultOverride ?? null,
          intentDecision: failedRequestPayload.intentDecision ?? null,
        });
        if (resolved?.awaitingPlayerRoll !== true) {
          await callApi(
            failedRequestPayload?.diceFollowup?.userContent ?? "[Jet secret résolu]",
            "dice",
            false,
            {
              hideUserMessage: true,
              bypassIntentParser: true,
              skipAutoPlayerTurn: true,
              skipGmContinue: true,
              entities: resolved?.nextEntities ?? failedRequestPayload.entitiesAtEntry,
              currentRoomId: resolved?.nextRoomId ?? failedRequestPayload.roomId,
              currentScene: resolved?.nextScene ?? failedRequestPayload.scene,
              currentSceneName: resolved?.nextSceneName ?? failedRequestPayload.sceneName,
              gameMode: resolved?.nextGameMode ?? failedRequestPayload.baseGameMode,
              engineEvent: resolved?.engineEvent ?? failedRequestPayload?.diceFollowup?.engineEvent ?? null,
              bypassFailureLock: true,
            }
          );
        }
        setFlowBlocked(false);
        setError(null);
        setFailedRequestPayload(null);
        return;
      }
      // Par défaut : rejouer le dernier callApi connu
      const { userContent, msgType: retryMsgType, isDebug: retryIsDebug, overrides } = failedRequestPayload;
      await callApi(userContent, retryMsgType, !!retryIsDebug, {
        ...(overrides ?? {}),
        bypassFailureLock: true,
      });
    } finally {
      setIsRetryingFailedRequest(false);
    }
  }

  // Game Over : uniquement si le personnage est réellement mort.
  useEffect(() => {
    const deathState = getPlayerDeathStateSnapshot();
    if (deathState.dead !== true) {
      deathNarrationSentRef.current = false;
      setIsGameOver(false);
      isGameOverRef.current = false;
      return;
    }
    if (deathNarrationSentRef.current) return;
    deathNarrationSentRef.current = true;
    setIsGameOver(true);
    setIsTyping(false);
    setIsAutoPlayerThinking(false);
    setPendingRoll(null);
    pendingRollRef.current = null;
    waitForGmNarrationForInitiativeLiveRef.current = false;
    setWaitForGmNarrationForInitiative(false);
    autoTurnInProgressRef.current = false;
    rollResolutionInProgressRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callApi stable pour cet usage ponctuel
  }, [player?.deathState, setPendingRoll]);

  const handleCheatReviveAfterGameOver = useCallback(() => {
    deathNarrationSentRef.current = false;
    setIsGameOver(false);
    isGameOverRef.current = false;

    if (player?.hp?.max) {
      restorePlayerToConsciousness(player.hp.max);
    }

    clearMeleeFor(localCombatantId);
    setHasDisengagedThisTurn(false);
    if (Array.isArray(combatOrder) && combatOrder.length > 0) {
      const localMpId = multiplayerSessionId && clientId ? `mp-player-${String(clientId ?? "").trim()}` : null;
      const playerIdx = combatOrder.findIndex(
        (entry) =>
          entry?.id === "player" || (!!localMpId && entry?.id === localMpId)
      );
      if (playerIdx >= 0) {
        commitCombatTurnIndex(playerIdx);
      }
      setGameMode("combat");
    }
    grantPlayerTurnResources();
    setPendingRoll(null);
    setMovementGate(null);
    setWaitForGmNarrationForInitiative(false);
    waitForGmNarrationForInitiativeLiveRef.current = false;
    setFlowBlocked(false);
    setFailedRequestPayload(null);
    setError(null);
    setIsTyping(false);
    setIsAutoPlayerThinking(false);
    flowBlockedRef.current = false;
    failedRequestPayloadRef.current = null;
    awaitingPlayerInitiativeRef.current = false;
    pendingRollRef.current = null;
    apiProcessingDepthRef.current = 0;
    sceneEnteredPipelineDepthRef.current = 0;
    rollResolutionInProgressRef.current = false;
    autoTurnInProgressRef.current = false;
    setShortRestState(null);

    addMessage(
      "ai",
      "Un second souffle improbable vous arrache aux ténèbres. Vous vous relevez et le combat reprend aussitôt.",
      "meta",
      makeMsgId()
    );
  }, [
    addMessage,
    clearMeleeFor,
    combatOrder,
    grantPlayerTurnResources,
    localCombatantId,
    restorePlayerToConsciousness,
    setError,
    setGameMode,
    setHasDisengagedThisTurn,
    setPendingRoll,
    setReactionFor,
  ]);

  // ---------------------------------------------------------------------------
  // Mode auto-joueur : génération d'un message joueur via l'IA
  // ---------------------------------------------------------------------------
  /**
   * Tant qu'un message joueur n'a pas reçu de réponse MJ « diégétique » après lui
   * (on ignore debug/dice/meta/etc.), l'auto-joueur ne doit pas en proposer un second :
   * sinon le modèle voit encore le tour joueur sans narration et enchaîne une autre question.
   */
  function awaitingGmReplyAfterLastUserMessage(messagesArr, gameModeHint = null) {
    if (!Array.isArray(messagesArr) || messagesArr.length === 0) return false;
    const nonNarrationAiTypes = new Set([
      "debug",
      "dice",
      "combat-detail",
      "scene-image",
      "scene-image-pending",
      "meta",
      "meta-reply",
      "continue",
      "campaign-context",
      "intent-error",
      "enemy-turn",
      "retry-action",
      "turn-end",
      "turn-divider",
    ]);
    let lastUserIdx = -1;
    for (let i = messagesArr.length - 1; i >= 0; i--) {
      if (messagesArr[i]?.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return false;
    let sawAnyAiAfterUser = false;
    for (let j = lastUserIdx + 1; j < messagesArr.length; j++) {
      const m = messagesArr[j];
      if (m?.role !== "ai") continue;
      sawAnyAiAfterUser = true;
      const t = m?.type;
      if (!t || !nonNarrationAiTypes.has(t)) {
        return false;
      }
    }
    // Aucune bulle MJ encore après le dernier joueur → toujours « en attente ».
    if (!sawAnyAiAfterUser) return true;
    // Dès qu'au moins une réponse IA existe après le dernier message joueur, considérer
    // la main rendue. Sinon, en exploration, une suite de réponses "meta/meta-reply"
    // peut bloquer indéfiniment l'auto-joueur.
    return false;
  }

  /** Refus moteur (parse-intent / processEngineIntent) — en MP la bulle est souvent type `meta`, pas `intent-error`. */
  function messageLooksLikeEngineIntentFailure(m) {
    if (!m || m.role !== "ai") return false;
    if (m.type === "intent-error") return true;
    const c = String(m.content ?? "");
    if (/action impossible/i.test(c)) return true;
    if (m.type === "meta" && /vous ne possédez pas l'arme ou le sort/i.test(c)) return true;
    return false;
  }

  /** Logs terminal serveur (voir NEXT_PUBLIC_DEBUG_SESSION_LOG) — throttle anti-spam. */
  const autoPlayerTerminalLogRef = useRef({ t: 0, key: "" });
  function logAutoPlayerTerminal(phase, reason, meta) {
    if (!autoPlayerEnabled) return;
    const k = `${phase}|${reason}`;
    const now = Date.now();
    // Certains motifs sont très verbeux mais peu utiles en prod (juste "en attente").
    // On les échantillonne beaucoup plus agressivement pour limiter les requêtes réseau.
    const veryNoisy =
      (phase === "gate" &&
        (reason === "autoAwaitingServerResolution" ||
          reason === "awaitingPlayerInitiative" ||
          reason === "typing_or_auto_thinking" ||
          reason === "awaiting_gm_after_last_user" ||
          reason === "not_my_turn")) ||
      (phase === "run" && reason === "awaiting_gm_after_last_user");
    const minIntervalMs = veryNoisy ? 20000 : 5000;
    if (autoPlayerTerminalLogRef.current.key === k && now - autoPlayerTerminalLogRef.current.t < minIntervalMs) {
      return;
    }
    autoPlayerTerminalLogRef.current = { t: now, key: k };
    sessionTerminalLog({
      sessionId: multiplayerSessionId,
      tag: `auto-player:${phase}`,
      message: reason,
      meta: meta ?? null,
    });
  }

  const autoTurnInProgressRef = useRef(false);
  const AUTO_PLAYER_DENIED_RETRY_MS = 6000;
  const lastAutoPlayerDeniedKeyRef = useRef({ key: "", ts: 0 });
  // Anti-enchaînement : l'auto-joueur ne doit pas proposer 2 actions successives
  // de suite sur le même tour joueur alors que l'état n'a pas changé.
  // IMPORTANT : on autorise une 2e exécution si les ressources (Action/Bonus/Réaction/Mouvement)
  // ont changé (ex: Action consommée -> Bonus disponible).
  const lastAutoPlayerActionByTurnKeyRef = useRef(null);

  async function runAutoPlayerTurn(overrides = null) {
    const myRunSerial = ++autoRunSerialRef.current;
    const isMultiplayerResolutionBusy = () => {
      if (!multiplayerSessionId) return false;
      const pid = multiplayerPendingCommandIdRef.current;
      const hasAnySessionPendingCommand = !!String(pid ?? "").trim();
      return (
        autoAwaitingServerResolutionRef.current ||
        hasAnySessionPendingCommand ||
        multiplayerThinkingActiveRef.current ||
        !!processingRemoteCommandIdRef.current
      );
    };
    // Ne pas mélanger isMultiplayerResolutionBusy avec shouldDropThisRun : une fois le fetch
    // auto-joueur terminé, la session peut être « occupée » par le MJ (autre message, ou la
    // même commande en cours de résolution) — jeter la réponse ici annule l’action sans erreur visible.
    const shouldDropThisRun = () =>
      myRunSerial !== autoRunSerialRef.current || !autoTurnInProgressRef.current;
    if (flowBlockedRef.current) {
      logAutoPlayerTerminal("run", "flowBlockedRef", {});
      return;
    }
    if (!autoPlayerEnabledRef.current) return;
    if (Date.now() < (autoSubmitBackoffUntilRef.current || 0)) {
      logAutoPlayerTerminal("run", "auto_submit_backoff", {
        waitMs: Math.max(0, autoSubmitBackoffUntilRef.current - Date.now()),
      });
      return;
    }
    if (autoTurnInProgressRef.current) {
      logAutoPlayerTerminal("run", "autoTurnInProgress", {});
      return;
    }
    if (rollResolutionInProgressRef.current) {
      logAutoPlayerTerminal("run", "rollResolutionInProgress", {});
      return;
    }
    if (isGameOverRef.current) {
      logAutoPlayerTerminal("run", "gameOver", {});
      return;
    }
    if ((gameStateRef.current?.player?.hp?.current ?? 1) <= 0) {
      logAutoPlayerTerminal("run", "player_hp_zero", {});
      return;
    }
    // Multijoueur : chaque client peut lancer l’auto-joueur pour son PJ ; l’intention part via
    // submitMultiplayerCommand : un seul client exécute callApi via le bail Firestore commandLease (useEffect pendingCommand).
    if (isMultiplayerResolutionBusy()) {
      logAutoPlayerTerminal("run", "multiplayer_resolution_busy", {
        autoAwaiting: autoAwaitingServerResolutionRef.current,
        pendingCmd: multiplayerPendingCommandIdRef.current,
        pendingSubmitter: multiplayerPendingSubmitterRef.current,
        thinking: multiplayerThinkingActiveRef.current,
        processingRemote: processingRemoteCommandIdRef.current,
      });
      // Stopper ici: on laisse les changements d'état réels (pending cleared / nouveau message)
      // relancer l'auto, au lieu d'un timer qui provoque des courses entre clients.
      autoSubmitBackoffUntilRef.current = Date.now() + 2000;
      return;
    }
    // Si on arrive ici, c'est que plus rien n'est "busy" : on repart à 0 sur les retries.
    autoMultiplayerBusyRetryCountRef.current = 0;

    // STOP : combat sans ordre d'initiative → pas d'action « exploration » via l'API auto-joueur
    const snapEarly = gameStateRef.current;
    const inCombatNoOrder =
      snapEarly?.gameMode === "combat" &&
      (!snapEarly.combatOrder || snapEarly.combatOrder.length === 0) &&
      hasAnyCombatReadyHostile(snapEarly?.entities ?? []);
    if (inCombatNoOrder) {
      if (awaitingPlayerInitiativeRef.current) {
        // Le jet d'initiative du PJ est un "jet joueur" : ne jamais le lancer via auto-joueur.
        // Il ne peut être auto-résolu QUE si Auto Roll est ON (et pas en mode « Mes dés » initiative).
        if (autoRollEnabledRef.current && !useManualInitiativeRollInputRef.current) {
          handleCommitInitiative(true);
        }
      }
      logAutoPlayerTerminal("run", "combat_no_order_yet", { awaitingInit: awaitingPlayerInitiativeRef.current });
      return;
    }
    if (pendingRollRef.current) {
      const pr = pendingRollRef.current;
      if (
        autoRollEnabledRef.current &&
          !useManualRollInputRef.current &&
        pendingRollTargetsLocalPlayer(
          pr,
          player,
          clientId,
          !!multiplayerSessionId,
          multiplayerSessionId,
          multiplayerParticipantProfilesRef.current
        )
      ) {
        void handleRoll();
      }
      logAutoPlayerTerminal("run", "pending_roll_wait_or_autoroll", {
        autoRoll: autoRollEnabledRef.current,
        manualInput: useManualRollInputRef.current,
      });
      return;
    }

    // Pas d'auto-joueur tant qu'un callApi MJ est en cours (fetch ou post-traitement sceneUpdate).
    if (apiProcessingDepthRef.current > 0) {
      logAutoPlayerTerminal("run", "apiProcessingDepth", { depth: apiProcessingDepthRef.current });
      return;
    }
    // sceneUpdate.hasChanged → [SceneEntered] planifié : ne pas parler avant la fin de ce tour MJ.
    if (sceneEnteredPipelineDepthRef.current > 0) {
      logAutoPlayerTerminal("run", "sceneEnteredPipelineDepth", {
        depth: sceneEnteredPipelineDepthRef.current,
      });
      return;
    }
    if (
      awaitingGmReplyAfterLastUserMessage(
        messagesRef.current,
        gameStateRef.current?.gameMode ?? gameMode ?? null
      )
    ) {
      logAutoPlayerTerminal("run", "awaiting_gm_after_last_user", {});
      return;
    }

    const snap0 = gameStateRef.current;
    if (!snap0) {
      logAutoPlayerTerminal("run", "no_game_state", {});
      return;
    }
    if (snap0.gameMode === "combat" && !isPlayerTurnNow(snap0)) {
      logAutoPlayerTerminal("run", "not_local_turn_isPlayerTurnNow", {
        mode: snap0.gameMode,
        turnIdx: combatTurnIndexLiveRef.current,
        activeId: snap0.combatOrder?.[combatTurnIndexLiveRef.current]?.id ?? null,
      });
      return;
    }
    // Toujours utiliser l'état courant (snap0.entities) :
    // les overrides peuvent contenir des entités "stales" (ex: gobelin déjà mort),
    // ce qui fait que l'auto-joueur cible des 0 PV.
    const effEntities = snap0.entities;
    const effRoomId = overrides?.currentRoomId ?? snap0.currentRoomId;
    const effScene = overrides?.currentScene ?? snap0.currentScene;
    const overridesForAutoCall = { ...(overrides ?? {}), skipAutoPlayerTurn: true };

    const trSnap0 = turnResourcesRef.current ?? turnResources;
    const resourcesSig =
      snap0.gameMode === "combat" && trSnap0
        ? `a:${!!trSnap0.action}|b:${!!trSnap0.bonus}|r:${!!trSnap0.reaction}|m:${!!trSnap0.movement}`
        : "na";

    const lastMsgForTurnKey = Array.isArray(messagesRef.current)
      ? messagesRef.current[messagesRef.current.length - 1]
      : null;
    const lastMsgIdForTurnKey = lastMsgForTurnKey?.id ?? `len:${messagesRef.current?.length ?? 0}`;
    const autoActKey =
      snap0.gameMode === "combat"
        ? `combat:player:${combatTurnIndexLiveRef.current}:${resourcesSig}:${lastMsgIdForTurnKey}`
        : `${snap0.gameMode ?? "exploration"}:${lastMsgIdForTurnKey}`;

    const lastMsg0 = Array.isArray(messagesRef.current) ? messagesRef.current[messagesRef.current.length - 1] : null;
    const lastMsgLooksLikeResolutionError = messageLooksLikeEngineIntentFailure(lastMsg0);
    const nowForDenied = Date.now();
    if (
      autoActKey &&
      lastAutoPlayerDeniedKeyRef.current.key === autoActKey &&
      nowForDenied - lastAutoPlayerDeniedKeyRef.current.ts < AUTO_PLAYER_DENIED_RETRY_MS
    ) {
      logAutoPlayerTerminal("run", "recent_denied_autoActKey", {
        autoActKey,
        waitMs: AUTO_PLAYER_DENIED_RETRY_MS - (nowForDenied - lastAutoPlayerDeniedKeyRef.current.ts),
      });
      return;
    }

    // Si on a déjà déclenché une intention auto sur le même segment (tour + ressources + dernier message chat),
    // on bloque — sauf erreur de résolution moteur (retry). En combat, inclure lastMsgId évite de rester
    // bloqué après un move : nouvelle bulle combat-detail/debug sans changement de ressources (MP / même tick).
    if (autoActKey && lastAutoPlayerActionByTurnKeyRef.current === autoActKey && !lastMsgLooksLikeResolutionError) {
      logAutoPlayerTerminal("run", "duplicate_autoActKey_no_retry", {
        autoActKey,
        lastMsgType: lastMsg0?.type ?? null,
      });
      return;
    }

    const dispatchAutoIntent = async (text) => {
      const content = String(text ?? "").trim();
      if (!content) return;
      if (shouldDropThisRun()) return;
      // Fin de tour : autorisée ici — l’auto-joueur est activé volontairement ; sinon le modèle
      // propose « Je termine mon tour » mais rien n’était envoyé au moteur (nextTurn jamais déclenché).
      if (multiplayerSessionId) {
        autoAwaitingServerResolutionRef.current = true;
        const liveSnap = gameStateRef.current ?? null;
        const livePlayer = liveSnap?.player ?? player ?? null;
        const mpAutoCmd = {
          id: makeMsgId(),
          userContent: content,
          msgType: null,
          isDebug: false,
          senderName: livePlayer?.name ?? "Joueur",
          playerSnapshot: livePlayer,
          gameModeSnapshot: liveSnap?.gameMode ?? null,
          currentRoomIdSnapshot: liveSnap?.currentRoomId ?? null,
          currentSceneSnapshot: liveSnap?.currentScene ?? null,
          currentSceneNameSnapshot: liveSnap?.currentSceneName ?? null,
          entitiesSnapshot: Array.isArray(liveSnap?.entities) ? liveSnap.entities : null,
          turnResourcesSnapshot: turnResourcesRef.current
            ? {
                action: !!turnResourcesRef.current.action,
                bonus: !!turnResourcesRef.current.bonus,
                reaction: !!turnResourcesRef.current.reaction,
                movement:
                  typeof turnResourcesRef.current.movement === "boolean"
                    ? turnResourcesRef.current.movement
                    : Number(turnResourcesRef.current.movement) > 0,
              }
            : null,
          // Doit être le clientId (onglet / session), pas l'id PJ — utilisé pour forClientId du pendingRoll.
          submittedBy: String(clientId ?? "").trim(),
          submittedAtMs: Date.now(),
        };
        let ok = await submitMultiplayerCommand(mpAutoCmd);
        if (!ok) {
          await new Promise((r) => setTimeout(r, 420));
          ok = await submitMultiplayerCommand(mpAutoCmd);
        }
        if (!ok) {
          autoAwaitingServerResolutionRef.current = false;
          if (autoActKey) {
            lastAutoPlayerDeniedKeyRef.current = { key: autoActKey, ts: Date.now() };
          }
          autoSubmitBackoffUntilRef.current = Date.now() + 5000;
          const now = Date.now();
          if (now - lastSessionBusyNoticeAtRef.current >= 4200) {
            lastSessionBusyNoticeAtRef.current = now;
            addMessage(
              "ai",
              "Une autre action est déjà en attente ou en cours de résolution dans cette session.",
              "intent-error",
              makeMsgId()
            );
          }
          try {
            await releaseMultiplayerAutoPlayerIntentLock();
          } catch {
            /* ignore */
          }
        } else if (autoActKey) {
          lastAutoPlayerActionByTurnKeyRef.current = autoActKey;
        }
        return;
      }
      await callApi(content, undefined, false, overridesForAutoCall);
      if (autoActKey) lastAutoPlayerActionByTurnKeyRef.current = autoActKey;
    };
    /** Historique API auto-joueur uniquement : consigne anti-boucle, pas un message joueur in-game. */
    const autoPlayerNudge = (content) => ({
      role: "user",
      type: "auto-player-nudge",
      content: String(content ?? "").trim(),
    });
    let intentErrorRetries = 0;

    autoTurnInProgressRef.current = true;
    try {
      setIsAutoPlayerThinking(true);
      // Verrou Firestore transactionnel : un seul client peut appeler /api/auto-player à la fois
      // (sinon deux PJs soumettent pendant le fetch et enchaînent deux réponses MJ).
      if (multiplayerSessionId) {
        const gotLock = await acquireMultiplayerAutoPlayerIntentLock();
        if (!gotLock) {
          if (autoActKey) {
            // Un autre client a gagné le lock pour ce même contexte:
            // on applique un cooldown local, sans bloquer définitivement ce key.
            lastAutoPlayerDeniedKeyRef.current = { key: autoActKey, ts: Date.now() };
          }
          autoSubmitBackoffUntilRef.current = Date.now() + 5000;
          logAutoPlayerTerminal("run", "mp_auto_player_lock_denied", {});
          return;
        }
      }
      logAutoPlayerTerminal("run", "fetch_auto_player_start", {
        gameMode: gameStateRef.current?.gameMode ?? null,
        roomId: effRoomId ?? null,
      });
      // IMPORTANT: pour l'auto-joueur, on retire les logs debug (latence/prompt/etc.)
      // sinon le modèle "voit" de l'information non-diégétique et peut boucler.
      const history = Array.isArray(messagesRef.current)
        ? messagesRef.current
            .filter((m) => {
              const t = m?.type;
              const c = String(m?.content ?? "");
              if (t === "meta" && /action impossible|vous ne possédez pas l'arme ou le sort/i.test(c)) {
                return true;
              }
              return !(
                t === "debug" ||
                t === "dice" ||
                t === "enemy-turn" ||
                t === "scene-image" ||
                t === "scene-image-pending" ||
                t === "meta" ||
                t === "meta-reply" ||
                t === "continue"
              );
            })
            .slice(-16)
        : [];

      const apSnap = () => gameStateRef.current;
      const buildBattleSnapshotForAutoPlayer = () => {
        const snap = gameStateRef.current;
        if (!snap) return null;
        const ents = snap.entities ?? [];
        const gMode = snap.gameMode === "combat" ? "combat" : "exploration";
        const co = Array.isArray(snap.combatOrder) ? snap.combatOrder : [];
        const hasOrder = gMode === "combat" && co.length > 0;
        const rawActiveEntry = hasOrder ? co[combatTurnIndex] : null;
        let activeEntry = rawActiveEntry;
        // Si l'entrée active pointe encore vers une créature morte (0 PV) à cause
        // d'un lag de state, on la corrige vers le prochain vivant.
        if (hasOrder && rawActiveEntry && controllerForCombatantId(rawActiveEntry.id, ents) !== "player") {
          const ent = ents.find((x) => x.id === rawActiveEntry.id);
          if (!ent || ent.isAlive !== true) {
            const startIdx = (combatTurnIndex - 1 + co.length) % co.length;
            const correctedIdx = nextAliveTurnIndex(co, startIdx, ents);
            activeEntry = co[correctedIdx] ?? rawActiveEntry;
          }
        }
        const isPlayerTurn =
          gMode !== "combat"
            ? true
            : awaitingPlayerInitiative
              ? false
              : !hasOrder
                ? false
                : controllerForCombatantId(activeEntry?.id, ents) === "player";
        const engagedIds = getMeleeWith(localCombatantId).filter((id) => {
          const ent = ents.find((e) => e.id === id);
          return !!ent && ent.isAlive && ent.type === "hostile";
        });
        const hiddenCombatIds = snap.combatHiddenIds ?? [];
        const hiddenCombatSet = new Set(
          (Array.isArray(hiddenCombatIds) ? hiddenCombatIds : [])
            .map((x) => String(x ?? "").trim())
            .filter(Boolean)
        );
        const stealthById =
          snap.combatStealthTotalByCombatantId && typeof snap.combatStealthTotalByCombatantId === "object"
            ? snap.combatStealthTotalByCombatantId
            : {};
        // Hostiles « visibles » côté liste + ceux en discrétion combat (pour tactique auto-joueur).
        const hostiles = ents.filter(
          (e) => e && e.visible !== false && e.isAlive && e.type === "hostile"
        );
        const deadHostiles = ents.filter(
          (e) =>
            e &&
            e.visible !== false &&
            !e?.hidden &&
            e.type === "hostile" &&
            e.isAlive === false &&
            (e.hp?.current ?? 0) <= 0
        );

        // Ressources réelles du tour (évite les attaques multiples si la state React est en retard)
        const trSnap = turnResourcesRef.current ?? turnResources;
        const secondWindRemaining = snap.player?.fighter?.resources?.secondWind?.remaining ?? 0;
        const secondWindAvailable = secondWindRemaining > 0;
        const playerWeaponNames = Array.isArray(snap.player?.weapons)
          ? snap.player.weapons
              .map((w) => String(w?.name ?? "").trim())
              .filter(Boolean)
          : [];
        const actionCatalog =
          gMode === "combat"
            ? {
                mainActionOptions: [
                  {
                    key: "attack",
                    label: "Attaquer",
                    cost: { action: 1 },
                    available: !!trSnap?.action,
                    note:
                      playerWeaponNames.length > 0
                        ? `Utiliser un nom exact d'arme: ${playerWeaponNames.join(", ")}`
                        : "Nommer une arme réellement possédée.",
                  },
                  {
                    key: "cast_spell_action",
                    label: "Lancer un sort (1 action)",
                    cost: { action: 1 },
                    available: !!trSnap?.action,
                  },
                  {
                    key: "dash",
                    label: "Foncer (Dash)",
                    cost: { action: 1 },
                    available: !!trSnap?.action,
                  },
                  {
                    key: "disengage",
                    label: "Se désengager (Disengage)",
                    cost: { action: 1 },
                    available: !!trSnap?.action,
                  },
                  {
                    key: "dodge",
                    label: "Esquiver (Dodge)",
                    cost: { action: 1 },
                    available: !!trSnap?.action,
                  },
                  {
                    key: "help",
                    label: "Aider (Help)",
                    cost: { action: 1 },
                    available: !!trSnap?.action,
                  },
                  {
                    key: "hide",
                    label: "Se cacher (Hide)",
                    cost: { action: 1 },
                    available: !!trSnap?.action,
                  },
                  {
                    key: "ready",
                    label: "Se tenir prêt (Ready)",
                    cost: { action: 1, reaction_later: 1 },
                    available: !!trSnap?.action,
                  },
                  {
                    key: "search",
                    label: "Chercher (Search)",
                    cost: { action: 1 },
                    available: !!trSnap?.action,
                  },
                  {
                    key: "use_object",
                    label: "Utiliser un objet",
                    cost: { action: 1 },
                    available: !!trSnap?.action,
                  },
                ],
                movementOptions: [
                  {
                    key: "move",
                    label: "Se déplacer",
                    cost: { movement: 1 },
                    available: !!trSnap?.movement,
                  },
                  {
                    key: "stand_up",
                    label: "Se relever",
                    cost: { movement: 0.5 },
                    available: !!trSnap?.movement,
                  },
                  {
                    key: "drop_prone",
                    label: "Se coucher à terre",
                    cost: { movement: 0 },
                    available: true,
                  },
                ],
                bonusActionOptions: [
                  {
                    key: "second_wind",
                    label: "Second souffle",
                    cost: { bonus: 1 },
                    available: !!trSnap?.bonus && secondWindAvailable,
                  },
                  {
                    key: "off_hand_attack",
                    label: "Attaque à deux armes (main secondaire)",
                    cost: { bonus: 1 },
                    available: !!trSnap?.bonus,
                  },
                  {
                    key: "bonus_spell",
                    label: "Sort en action bonus (si disponible)",
                    cost: { bonus: 1 },
                    available: !!trSnap?.bonus,
                  },
                ],
              }
            : null;
        return {
          gameMode: gMode,
          awaitingPlayerInitiative: !!awaitingPlayerInitiative,
          isPlayerTurn,
          // Ordre d'initiative uniquement sur les combattants encore vivants
          initiativeOrder: hasOrder
            ? co
                .filter((e) => {
                  if (!e || !e.id) return false;
                  if (e.id === "player") return true;
                  if (String(e.id).startsWith("mp-player-")) {
                    const rc = getRuntimeCombatant(e.id, ents);
                    return !!rc && rc.isAlive !== false;
                  }
                  const ent = ents.find((x) => x.id === e.id);
                  return !!ent && ent.isAlive === true;
                })
                .map((e) => ({
                  id: e.id,
                  name: resolveCombatantDisplayName(e, ents, snap.player?.name),
                }))
            : [],
          activeCombatantId: activeEntry?.id ?? null,
          player: {
            engagedWithHostileIds: engagedIds,
            inMelee: engagedIds.length > 0,
            hiddenFromOpponents: hiddenCombatSet.has(String(localCombatantId ?? "").trim()),
            reactionAvailable: hasReaction(localCombatantId),
            turnResources: {
              action: !!trSnap?.action,
              bonus: !!trSnap?.bonus,
              // Mouvement (1 seule fois par tour, distances non gérées)
              movement: !!trSnap?.movement,
              reaction: !!trSnap?.reaction,
              // Second souffle (trait) : disponibilite cote moteur (1/rest)
              secondWind: {
                available: secondWindAvailable,
                remaining: secondWindRemaining,
              },
            },
          },
          hostiles: hostiles.map((e) => {
            const id = e.id;
            const hpC = typeof e.hp?.current === "number" && Number.isFinite(e.hp.current) ? e.hp.current : null;
            const hpM = typeof e.hp?.max === "number" && Number.isFinite(e.hp.max) ? e.hp.max : null;
            const hiddenFromPlayer = hiddenCombatSet.has(id) || e.hidden === true;
            const stRaw = stealthById[id];
            const stealthPassiveVsPerception =
              typeof stRaw === "number" && Number.isFinite(stRaw) ? Math.trunc(stRaw) : null;
            return {
              id,
              name: e.name ?? e.id,
              hpCurrent: hpC,
              hpMax: hpM,
              inMeleeWithPlayer: engagedIds.includes(id),
              engagedWithIds: getMeleeWith(id),
              hiddenFromPlayer,
              stealthPassiveVsPerception,
            };
          }),
          // Explicite des 0 PV pour éviter que l'auto-joueur tente des actions sur des morts
          deadHostiles: deadHostiles.map((e) => ({
            id: e.id,
            name: e.name ?? e.id,
            hpCurrent: e.hp?.current ?? 0,
          })),
          actionCatalog,
        };
      };
      const buildPartyPcsPayload = () => {
        const snap = gameStateRef.current;
        const ents = snap?.entities ?? [];
        const p = snap?.player ?? player;
        const out = [];
        const lc = String(localCombatantId ?? "").trim() || "player";
        const myCid = String(clientId ?? "").trim();

        if (multiplayerSessionId && Array.isArray(multiplayerParticipantProfiles) && multiplayerParticipantProfiles.length > 0) {
          for (const prof of multiplayerParticipantProfiles) {
            if (prof && prof.connected === false) continue;
            const cid = String(prof?.clientId ?? "").trim();
            if (!cid) continue;
            const pid = `mp-player-${cid}`;
            const isLocal = cid === myCid;
            const snapPlayer =
              isLocal && p
                ? p
                : prof?.playerSnapshot && typeof prof.playerSnapshot === "object"
                  ? prof.playerSnapshot
                  : null;
            const hpC = isLocal
              ? typeof p?.hp?.current === "number"
                ? p.hp.current
                : null
              : typeof prof?.hpCurrent === "number"
                ? prof.hpCurrent
                : typeof snapPlayer?.hp?.current === "number"
                  ? snapPlayer.hp.current
                  : null;
            const hpM = isLocal
              ? typeof p?.hp?.max === "number"
                ? p.hp.max
                : null
              : typeof prof?.hpMax === "number"
                ? prof.hpMax
                : typeof snapPlayer?.hp?.max === "number"
                  ? snapPlayer.hp.max
                  : null;
            const ds = isLocal ? p?.deathState : snapPlayer?.deathState;
            const unconscious = typeof hpC === "number" && hpC <= 0 && ds?.dead !== true;
            const stabilized = ds?.stable === true;
            out.push({
              combatantId: pid,
              name: String(isLocal ? p?.name ?? prof?.name ?? "Joueur" : prof?.name ?? "Joueur").trim() || "Joueur",
              race: (isLocal ? p?.race : prof?.race) ?? null,
              entityClass: (isLocal ? p?.entityClass : prof?.entityClass) ?? null,
              level: (isLocal ? p?.level : prof?.level) ?? null,
              hpCurrent: hpC,
              hpMax: hpM,
              ac: isLocal
                ? typeof p?.ac === "number"
                  ? p.ac
                  : null
                : typeof prof?.ac === "number"
                  ? prof.ac
                  : typeof snapPlayer?.ac === "number"
                    ? snapPlayer.ac
                    : null,
              isLocal,
              unconscious,
              stabilized,
            });
          }
          if (out.length > 0) return out;
        }

        const baseId = p?.id && String(p.id).trim() ? String(p.id).trim() : lc === "player" ? "player" : lc;
        const hpCu = typeof p?.hp?.current === "number" ? p.hp.current : null;
        const ds0 = p?.deathState;
        out.push({
          combatantId: baseId,
          name: p?.name ?? "Joueur",
          race: p?.race ?? null,
          entityClass: p?.entityClass ?? null,
          level: p?.level ?? null,
          hpCurrent: hpCu,
          hpMax: typeof p?.hp?.max === "number" ? p.hp.max : null,
          ac: typeof p?.ac === "number" ? p.ac : null,
          isLocal: true,
          unconscious: typeof hpCu === "number" && hpCu <= 0 && ds0?.dead !== true,
          stabilized: ds0?.stable === true,
        });

        const seen = new Set(out.map((x) => x.combatantId));
        for (const e of ents) {
          if (!e || e.visible === false || e.type === "hostile") continue;
          const eid = String(e.id ?? "").trim();
          if (!eid || seen.has(eid)) continue;
          if (e.controller !== "player" && e.type !== "friendly") continue;
          if (eid === "player" || eid === lc) continue;
          const hpC = e.hp?.current;
          const hpM = e.hp?.max;
          out.push({
            combatantId: eid,
            name: String(e.name ?? eid),
            race: e.race ?? null,
            entityClass: e.entityClass ?? null,
            level: e.level ?? null,
            hpCurrent: typeof hpC === "number" ? hpC : null,
            hpMax: typeof hpM === "number" ? hpM : null,
            ac: typeof e.ac === "number" ? e.ac : null,
            isLocal: false,
            unconscious: typeof hpC === "number" && hpC <= 0 && e.isAlive !== false,
            stabilized: false,
          });
          seen.add(eid);
        }
        return out;
      };
      const partyPcsPayload = buildPartyPcsPayload();
      const battleSnapshot = buildBattleSnapshotForAutoPlayer();
      const payload = {
        player: apSnap().player,
        currentScene: effScene,
        currentRoomId: effRoomId,
        entities: effEntities,
        gameMode: apSnap().gameMode,
        history,
        provider: apSnap().aiProvider,
        battleSnapshot,
        partyPcs: partyPcsPayload,
      };
      const { res, data } = await fetchJsonWithTimeout(
        "/api/auto-player",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        API_AI_THINKING_TIMEOUT_MS,
        "auto-player"
      );

      if (!res.ok || !data?.content) {
        console.warn("[auto-joueur] Échec API:", data?.error ?? res.status);
        return;
      }
      if (shouldDropThisRun()) return;
      let autoContent = String(data.content || "").trim();
      // Si le mode auto a été coupé entre temps, on ne joue pas la réponse IA
      if (!autoPlayerEnabledRef.current) return;
      if (!autoContent) return;

      // Validation stricte de la forme + cohérence de scène.
      // Si l'auto-joueur envoie "Vous ..." ou mentionne la forge/Thron/commis alors qu'on est ailleurs,
      // on relance une fois avec un nudge.
      const normalizeForCheck = (t) =>
        String(t ?? "")
          .trim()
          .replace(/^["'“”‘’]+/, "");

      const isPlayerStartsWithJe = (t) => /^(Je\b|J')/i.test(normalizeForCheck(t));

      const playerHasForbiddenWords = (t) => {
        const nt = normalizeForCheck(t);
        const disallowNames = /Thron|commis|meunier/i;
        const disallowForge = /forge|seuil|porte de la forge/i;
        if ((effEntities?.length ?? 0) === 0) {
          // Sur une scène sans PNJ, l'auto-joueur ne doit mentionner ni les PNJ ni la forge.
          return disallowNames.test(nt) || disallowForge.test(nt);
        }
        if (effRoomId === "scene_journey") {
          // Même si par erreur des entités sont vides/partielles, scene_journey = en route, pas la forge.
          return disallowNames.test(nt) || disallowForge.test(nt);
        }
        return false;
      };

      const shouldRetryBecauseInvalid = !isPlayerStartsWithJe(autoContent) || playerHasForbiddenWords(autoContent);

      if (shouldRetryBecauseInvalid) {
        const reason = [];
        if (!isPlayerStartsWithJe(autoContent)) reason.push("format (doit commencer par 'Je')");
        if (playerHasForbiddenWords(autoContent)) reason.push("cohérence scène (forge/Thron/commis)");
        const retryUserNudge =
          `Ta réponse est invalide (${reason.join(", ")}). ` +
          `Réponds uniquement avec une action du personnage en exploration, ` +
          `en commençant par "Je ...". ` +
          `Si tu es en ${effRoomId}, ignore complètement la forge et ne mentionne pas Thron/commis. ` +
          `Fais avancer l'histoire (marcher/observer/agir) en restant dans la scène actuelle.`;

        const retryHistory = [
          ...(Array.isArray(history) ? history : []),
          autoPlayerNudge(retryUserNudge),
        ];

        const res2 = await fetch("/api/auto-player", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            player: apSnap().player,
            currentScene: effScene,
            currentRoomId: effRoomId,
            entities: effEntities,
            gameMode: apSnap().gameMode,
            history: retryHistory,
            provider: apSnap().aiProvider,
            battleSnapshot: buildBattleSnapshotForAutoPlayer(),
            partyPcs: partyPcsPayload,
          }),
        });
        const data2 = await res2.json().catch(() => ({}));
        if (!res2.ok || !data2?.content) return;
        if (shouldDropThisRun()) return;

        const autoContent2 = String(data2.content || "").trim();
        if (!autoContent2) return;

        // Dernier contrôle : si ça reste invalide, on laisse partir (évite boucle infinie).
        const stillInvalid =
          !isPlayerStartsWithJe(autoContent2) || playerHasForbiddenWords(autoContent2);
        if (stillInvalid) {
          console.warn("[auto-joueur] Validation encore échouée — envoi quand même.");
        }

        autoContent = autoContent2;
      }

      // Anti-répétition par schéma (ex: promettre + redemander une direction sans quitter).
      const computeAutoRepeatPattern = (text, roomId) => {
        const nt = String(text ?? "").toLowerCase();
        const hasPromise = /(ramener|ramèner|ram[ée]nerons|nous la ramener|nous la ram[èe]ner|sauver|sauverai)/i.test(nt);
        const hasDirectionRequest = /(montre|direction|où se trouve|où.*colline|où tu l'as|où.*vue|colline à|ouest)/i.test(nt);
        const hasExit = /(je (pars|sors|quitte)|quitte la forge|sortir|sentier|air frais|porte de la forge|marche|en route)/i.test(nt);

        if (roomId === "scene_village" && hasPromise && hasDirectionRequest && !hasExit) {
          return "forge_promise_direction_no_exit";
        }
        return null;
      };

      const repeatPattern = computeAutoRepeatPattern(autoContent, effRoomId);
      if (repeatPattern && lastAutoRepeatPatternRef.current === repeatPattern) {
        const retryUserNudge =
          "Tu as déjà promis de ramener ET demandé la direction. Maintenant, fais avancer : quitte la forge et pars immédiatement sur le sentier vers l'ouest. N'ajoute plus de promesses ni de nouvelles demandes au commis/Thron.";

        const retryHistory = [
          ...(Array.isArray(history) ? history : []),
          autoPlayerNudge(retryUserNudge),
        ];

        const res2 = await fetch("/api/auto-player", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            player: apSnap().player,
            currentScene: effScene,
            currentRoomId: effRoomId,
            entities: effEntities,
            gameMode: apSnap().gameMode,
            history: retryHistory,
            provider: apSnap().aiProvider,
            battleSnapshot: buildBattleSnapshotForAutoPlayer(),
            partyPcs: partyPcsPayload,
          }),
        });
        const data2 = await res2.json().catch(() => ({}));
        if (!res2.ok || !data2?.content) return;
        if (shouldDropThisRun()) return;

        const autoContent2 = String(data2.content || "").trim();
        if (!autoContent2) return;

        lastAutoRepeatPatternRef.current = computeAutoRepeatPattern(autoContent2, effRoomId);
        lastAutoPlayerIntentRef.current = autoContent2;
        await dispatchAutoIntent(autoContent2);
        return;
      }

      lastAutoRepeatPatternRef.current = repeatPattern;

      // Anti-boucle stricte : si le modèle répète exactement la même intention,
      // on relance une fois avec une consigne claire.
      if (lastAutoPlayerIntentRef.current && autoContent === lastAutoPlayerIntentRef.current) {
        const retryUserNudge =
          "Ne répète pas ton message précédent mot pour mot. Propose une action différente qui fait avancer l'histoire.";
        const retryHistory = [
          ...(Array.isArray(history) ? history : []),
          autoPlayerNudge(retryUserNudge),
        ];

        const res2 = await fetch("/api/auto-player", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            player: apSnap().player,
            currentScene: effScene,
            currentRoomId: effRoomId,
            entities: effEntities,
            gameMode: apSnap().gameMode,
            history: retryHistory,
            provider: apSnap().aiProvider,
            battleSnapshot: buildBattleSnapshotForAutoPlayer(),
            partyPcs: partyPcsPayload,
          }),
        });
        const data2 = await res2.json().catch(() => ({}));
        if (!res2.ok || !data2?.content) return;
        if (shouldDropThisRun()) return;

        const autoContent2 = String(data2.content || "").trim();
        if (!autoContent2) return;

        lastAutoPlayerIntentRef.current = autoContent2;
        await dispatchAutoIntent(autoContent2);
        return;
      }

      lastAutoPlayerIntentRef.current = autoContent;
      const beforeLen = Array.isArray(messagesRef.current) ? messagesRef.current.length : 0;
      await dispatchAutoIntent(autoContent);

      // Si l'action auto a été refusée par le moteur (intent-error, ou meta « Action impossible » en MP),
      // on relance l'auto-joueur une fois avec un nudge « légal ».
      const sliceNew = () =>
        Array.isArray(messagesRef.current) ? messagesRef.current.slice(beforeLen) : [];
      let lastAfter = sliceNew().slice(-1)[0];
      // Multijoueur : la bulle d'erreur arrive après résolution hôte — attendre un peu avant de décider.
      if (multiplayerSessionId && !messageLooksLikeEngineIntentFailure(lastAfter)) {
        for (let i = 0; i < 35; i++) {
          await new Promise((r) => setTimeout(r, 100));
          if (shouldDropThisRun()) return;
          const chunk = sliceNew();
          lastAfter = chunk[chunk.length - 1];
          if (messageLooksLikeEngineIntentFailure(lastAfter)) break;
          if (chunk.some((m) => m?.role === "user" && m.type !== "auto-player-nudge")) break;
        }
      }
      const after = sliceNew();
      lastAfter = after[after.length - 1];
      const snapAfter = gameStateRef.current ?? null;
      const orderAfter = Array.isArray(snapAfter?.combatOrder) ? snapAfter.combatOrder : [];
      const liveIdxAfter =
        orderAfter.length > 0
          ? Math.min(Math.max(0, combatTurnIndexLiveRef.current), orderAfter.length - 1)
          : 0;
      const activeIdAfter = orderAfter[liveIdxAfter]?.id ?? null;
      const localAutoPid = multiplayerSessionId && clientId ? `mp-player-${String(clientId ?? "").trim()}` : "player";
      const isStillLocalPlayerTurnForRetry = activeIdAfter === "player" || activeIdAfter === localAutoPid;
      if (
        intentErrorRetries < 1 &&
        messageLooksLikeEngineIntentFailure(lastAfter) &&
        autoPlayerEnabledRef.current &&
        snapAfter?.gameMode === "combat" &&
        isStillLocalPlayerTurnForRetry
      ) {
        intentErrorRetries += 1;
        // Permet au déclencheur useEffect de re-file runAutoPlayerTurn si besoin (clé d’éligibilité).
        lastAutoAvailabilityKeyRef.current = null;
        lastAutoPlayerActionByTurnKeyRef.current = null;
        const nudge =
          `Le moteur a refusé ton action (intent-error / action impossible). ` +
          `Tu dois proposer une action LEGALISTE : uniquement un déplacement (move) pour te rapprocher si tu as déjà utilisé ton Action, ` +
          `ou une Action bonus / Réaction si elles sont disponibles. ` +
          `Ne propose pas de move_and_attack/attack tant que tu n'as pas le droit. Commence par "Je ...".`;

        const retryHistory = [
          ...(Array.isArray(history) ? history : []),
          autoPlayerNudge(nudge),
        ];

        const battleSnapshotRetry = buildBattleSnapshotForAutoPlayer();
        const payload2 = {
          player: apSnap().player,
          currentScene: effScene,
          currentRoomId: effRoomId,
          entities: effEntities,
          gameMode: apSnap().gameMode,
          history: retryHistory,
          provider: apSnap().aiProvider,
          battleSnapshot: battleSnapshotRetry,
          partyPcs: partyPcsPayload,
        };

        const res2 = await fetch("/api/auto-player", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload2),
        });
        const data2 = await res2.json().catch(() => ({}));
        const autoContent2 = String(data2.content || "").trim();
        if (res2.ok && autoContent2) {
          if (shouldDropThisRun()) return;
          lastAutoPlayerIntentRef.current = autoContent2;
          await dispatchAutoIntent(autoContent2);
        }
      }
    } catch (err) {
      console.error("[auto-joueur]", err);
    } finally {
      autoTurnInProgressRef.current = false;
      setIsAutoPlayerThinking(false);
      if (multiplayerSessionId && !autoAwaitingServerResolutionRef.current) {
        try {
          await releaseMultiplayerAutoPlayerIntentLock();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Déclencheur : auto-joueur (/api/auto-player + intention) seulement quand handleSend
  // accepterait une action (tour / mode / pas de jet bloquant). Les jets : effet auto-roll séparé.
  const lastAutoAvailabilityKeyRef = useRef(null);
  // Réactiver l’auto-joueur dès que l’utilisateur rallume le mode (sinon la clé d’éligibilité
  // peut rester identique au dernier cycle et bloquer indéfiniment).
  useEffect(() => {
    if (autoPlayerEnabled) {
      lastAutoAvailabilityKeyRef.current = null;
    }
  }, [autoPlayerEnabled]);
  // Throttle logs/intent : évite de spammer /api/session-log quand c'est "pas ton tour".
  const lastNotMyTurnGateRef = useRef(null);
  useEffect(() => {
    /** Annule le timer de grâce combat MP + permet de replanifier après un blocage temporaire. */
    const clearCombatAutoGrace = () => {
      if (autoPlayerCombatGraceTimerRef.current) {
        clearTimeout(autoPlayerCombatGraceTimerRef.current);
        autoPlayerCombatGraceTimerRef.current = null;
      }
      lastAutoAvailabilityKeyRef.current = null;
    };
    /** Remplace un timer de grâce déjà planifié sans perdre la clé (évite deux appels). */
    const clearCombatGraceTimerOnly = () => {
      if (autoPlayerCombatGraceTimerRef.current) {
        clearTimeout(autoPlayerCombatGraceTimerRef.current);
        autoPlayerCombatGraceTimerRef.current = null;
      }
    };
    if (!autoPlayerEnabledRef.current) return;
    if (flowBlocked) {
      logAutoPlayerTerminal("gate", "flowBlocked", { flowBlocked: true });
      return;
    }
    if (flowBlockedRef.current) {
      logAutoPlayerTerminal("gate", "flowBlockedRef", {});
      return;
    }
    if (retryCountdown > 0) {
      logAutoPlayerTerminal("gate", "retryCountdown", { retryCountdown });
      return;
    }
    if (isTyping || isAutoPlayerThinking) {
      clearCombatAutoGrace();
      logAutoPlayerTerminal("gate", "typing_or_auto_thinking", { isTyping, isAutoPlayerThinking });
      return;
    }
    if (autoAwaitingServerResolutionRef.current) {
      logAutoPlayerTerminal("gate", "autoAwaitingServerResolution", {});
      return;
    }
    const mpPendingAny = !!String(multiplayerPendingCommand?.id ?? "").trim();
    if (multiplayerSessionId && (multiplayerThinkingState.active || mpPendingAny)) {
      clearCombatAutoGrace();
      logAutoPlayerTerminal("gate", "multiplayer_busy", {
        thinking: multiplayerThinkingState.active,
        pendingCommandId: multiplayerPendingCommand?.id ?? null,
        pendingAny: mpPendingAny,
      });
      return;
    }
    if (isGameOverRef.current) {
      logAutoPlayerTerminal("gate", "game_over", {});
      return;
    }
    if ((player?.hp?.current ?? 1) <= 0) {
      logAutoPlayerTerminal("gate", "player_dead_same_as_send", {});
      return;
    }
    const snapGate = gameStateRef.current ?? {};
    const gateMode = snapGate.gameMode ?? gameMode;
    const gateAwaitingInitiative =
      typeof snapGate.awaitingPlayerInitiative === "boolean"
        ? snapGate.awaitingPlayerInitiative
        : awaitingPlayerInitiative;

    if (gateAwaitingInitiative) {
      logAutoPlayerTerminal("gate", "awaitingPlayerInitiative", {});
      return;
    }
    if (waitForGmNarrationForInitiative) {
      clearCombatAutoGrace();
      logAutoPlayerTerminal("gate", "waitForGmNarrationForInitiative", {});
      return;
    }
    if (sceneEnteredPipelineDepthRef.current > 0) {
      logAutoPlayerTerminal("gate", "sceneEnteredPipeline", {
        depth: sceneEnteredPipelineDepthRef.current,
      });
      return;
    }
    if (apiProcessingDepthRef.current > 0) {
      clearCombatAutoGrace();
      logAutoPlayerTerminal("gate", "apiProcessing", { depth: apiProcessingDepthRef.current });
      return;
    }
    if (rollResolutionInProgressRef.current) {
      logAutoPlayerTerminal("gate", "rollResolutionInProgress", {});
      return;
    }

    // Même règle que handleSend : pas d'intention auto tant qu'un jet bloque la saisie (auto-roll est un autre effet).
    if (pendingRoll) {
      logAutoPlayerTerminal("gate", "pending_roll_same_as_send_blocked", {});
      return;
    }

    // STOP total auto-joueur tant que l'UI bloque la saisie joueur :
    // - attente jet d'initiative
    // - jet de dé en attente
    if (awaitingPlayerInitiative) {
      return;
    }
    if (pendingRoll) {
      return;
    }

    const trimmedInput = String(input ?? "").trim();
    if (trimmedInput) {
      logAutoPlayerTerminal("gate", "player_is_typing_manual_intent", {
        chars: trimmedInput.length,
      });
      return;
    }

    const gateOrder = Array.isArray(snapGate.combatOrder) ? snapGate.combatOrder : combatOrder;
    if (gateMode === "combat") {
      if (!Array.isArray(gateOrder) || gateOrder.length === 0) {
        logAutoPlayerTerminal("gate", "combat_no_order", { gameMode: gateMode });
        return;
      }
    } else if (gateMode !== "exploration" && gateMode !== "short_rest") {
      logAutoPlayerTerminal("gate", "unsupported_game_mode", { gameMode: gateMode });
      return;
    }

    const hasOrderForTurn = gateMode === "combat" && Array.isArray(gateOrder) && gateOrder.length > 0;
    const gateTurnIdx =
      hasOrderForTurn && gateOrder.length > 0
        ? Math.min(Math.max(0, combatTurnIndexLiveRef.current), gateOrder.length - 1)
        : 0;
    const activeEntryForTurn = hasOrderForTurn ? gateOrder[gateTurnIdx] : null;
    const isMyTurnForAuto =
      gateMode !== "combat"
        ? true
        : !hasOrderForTurn
          ? false
          : isLocalPlayerCombatantId(activeEntryForTurn?.id);

    if (!isMyTurnForAuto) {
      clearCombatAutoGrace();
      const activeIdKey = activeEntryForTurn?.id ?? null;
      const now = Date.now();
      const last = lastNotMyTurnGateRef.current;
      // Throttle global : évite de spammer la route /api/session-log
      // quand des clients différents tentent l'auto-joueur alors que ce n'est pas leur tour.
      if (last && now - last.ts < 4200) return;
      lastNotMyTurnGateRef.current = { activeId: activeIdKey, ts: now };
      logAutoPlayerTerminal("gate", "not_my_turn", {
        gameMode,
        hasOrderForTurn,
        awaitingPlayerInitiative: gateAwaitingInitiative,
        activeId: activeIdKey,
      });
      return;
    }

    const pendingKey = "none";

    if (awaitingGmReplyAfterLastUserMessage(messages, gameMode)) {
      clearCombatAutoGrace();
      logAutoPlayerTerminal("gate", "awaiting_gm_after_last_user", {});
      return;
    }

    const lastMsg = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null;
    const lastMsgId = lastMsg?.id ?? "";
    // Dernier message IA « utile » pour le garde : ignorer les bulles debug en fin de chaîne (logs moteur),
    // sinon après chaque attaque auto le dernier message est [DEBUG] et l'auto-joueur reste bloqué.
    let lastAiForGate = null;
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role !== "ai") continue;
        if (m.type === "debug") continue;
        lastAiForGate = m;
        break;
      }
    }
    // Pas d'auto-joueur « intention » tant que le dernier message n'est pas un vrai rendu MJ après mécanique.
    // Exception : en combat, sur le tour du PJ **local**, les bulles `dice` / `combat-detail` (initiative,
    // jets d'attaque, etc.) ne doivent pas bloquer — sinon l'auto-joueur ne part jamais après l'ordre d'initiative.
    if (lastAiForGate && lastAiForGate.role === "ai") {
      if (
        (lastAiForGate.type === "dice" || lastAiForGate.type === "combat-detail") &&
        !(gameMode === "combat" && isMyTurnForAuto)
      ) {
        clearCombatAutoGrace();
        logAutoPlayerTerminal("gate", "last_ai_message_blocks_intent", {
          lastType: lastAiForGate.type ?? null,
          hint: "attendre un message MJ hors dice/debug/combat-detail",
        });
        return;
      }
    }
    // Inclure les ressources du tour en combat : après un move (mouvement seul), le dernier message
    // peut rester la même bulle « dice » alors que l’action est encore disponible — sans ce terme,
    // la clé ne change pas, runAutoPlayerTurn peut tomber sur duplicate_autoActKey puis rester bloqué
    // (availability_key_unchanged sur les effets suivants).
    const trGate = gameMode === "combat" ? turnResourcesRef.current ?? turnResources : null;
    const resourcesSigForGate =
      gameMode === "combat" && trGate
        ? `a:${!!trGate.action}|b:${!!trGate.bonus}|r:${!!trGate.reaction}|m:${!!trGate.movement}`
        : "na";
    const availabilityKey =
      gateMode === "combat"
        ? `${gateMode}:${combatTurnWriteSeq}:${String(activeEntryForTurn?.id ?? "")}:${pendingKey}:${lastMsgId}:${resourcesSigForGate}`
        : `${gateMode}:${pendingKey}:${lastMsgId}`;
    if (availabilityKey === lastAutoAvailabilityKeyRef.current) {
      logAutoPlayerTerminal("gate", "availability_key_unchanged", { availabilityKey });
      return;
    }
    lastAutoAvailabilityKeyRef.current = availabilityKey;

    logAutoPlayerTerminal("gate", "queue_runAutoPlayerTurn", { availabilityKey });

    if (multiplayerSessionId && gateMode === "combat" && isMyTurnForAuto) {
      // En combat multi, laisser une courte fenêtre au joueur humain avant que l'auto-joueur
      // ne soumette une commande, sinon son clic "Envoyer" est très souvent battu à la course.
      clearCombatGraceTimerOnly();
      autoPlayerCombatGraceTimerRef.current = setTimeout(() => {
        autoPlayerCombatGraceTimerRef.current = null;
        if (String(inputValueRef.current ?? "").trim()) return;
        void runAutoPlayerTurn(null);
      }, 1800);
      return;
    }

    // microtask : laisse React finir le traitement courant
    queueMicrotask(() => {
      void runAutoPlayerTurn(null);
    });
  }, [
    autoPlayerEnabled,
    messages,
    gameMode,
    combatOrder,
    combatTurnIndex,
    combatTurnWriteSeq,
    pendingRoll,
    awaitingPlayerInitiative,
    waitForGmNarrationForInitiative,
    isTyping,
    isAutoPlayerThinking,
    multiplayerSessionId,
    multiplayerThinkingState.active,
    multiplayerPendingCommand?.id,
    multiplayerPendingCommand?.submittedBy,
    clientId,
    flowBlocked,
    retryCountdown,
    entities,
    player?.hp?.current,
    input,
    turnResources,
  ]);

  useEffect(() => {
    return () => {
      if (autoPlayerCombatGraceTimerRef.current) {
        clearTimeout(autoPlayerCombatGraceTimerRef.current);
        autoPlayerCombatGraceTimerRef.current = null;
      }
    };
  }, []);

  const lastAutoRollKeyRef = useRef(null);
  useEffect(() => {
    if (!autoRollEnabledRef.current) return;
    if (flowBlockedRef.current) return;
    if (rollResolutionInProgressRef.current) return;
    if (isTyping || isAutoPlayerThinking) return;
    if (isGameOverRef.current) return;

    const pending = pendingRollRef.current;
    if (!pending) {
      // Ne pas effacer lastAutoRollKeyRef : un snapshot Firestore peut réinjecter le même
      // `pendingRoll` après résolution (fenêtre après skipRemote) et relancer handleRoll une 2e fois.
      return;
    }
    if (
      !pendingRollTargetsLocalPlayer(
        pending,
        player,
        clientId,
        !!multiplayerSessionId,
        multiplayerSessionId,
        multiplayerParticipantProfilesRef.current
      )
    ) {
      lastAutoRollKeyRef.current = null;
      return;
    }
    const autoKey = `${pending.kind ?? ""}:${pending.stat ?? pending.skill ?? ""}:${pending.weaponName ?? ""}:${pending.targetId ?? ""}:${pending.id ?? ""}:${pending.roll ?? ""}:${pending.raison ?? ""}`;
    if (autoKey === lastAutoRollKeyRef.current) return;
    lastAutoRollKeyRef.current = autoKey;

    queueMicrotask(() => {
      if (!autoRollEnabledRef.current) return;
      if (!pendingRollRef.current) return;
      void handleRoll();
    });
  }, [
    pendingRoll,
    autoRollEnabled,
    autoPlayerEnabled,
    isTyping,
    isAutoPlayerThinking,
    player,
    clientId,
    multiplayerSessionId,
    multiplayerParticipantProfilesRollGateKey,
  ]);

  async function handleSend() {
    const trimmed = input.trim();
    // Le joueur humain reprend la main : annule l’appel auto-joueur en cours (fetch /api/auto-player)
    // pour éviter un second callApi en parallèle et un MJ « bloqué » sans message utilisateur affiché.
    if (trimmed && isAutoPlayerThinking && autoPlayerEnabledRef.current) {
      autoRunSerialRef.current += 1;
      autoTurnInProgressRef.current = false;
      setIsAutoPlayerThinking(false);
      if (multiplayerSessionId) {
        try {
          await releaseMultiplayerAutoPlayerIntentLock();
        } catch {
          /* ignore */
        }
      }
    }
    const mpThisClientHoldsAutoIntent =
      multiplayerThinkingState.active === true &&
      multiplayerThinkingState.actor === "auto-player" &&
      String(multiplayerThinkingState.byClientId ?? "").trim() === String(clientId ?? "").trim();
    const apiPipelineBusy = apiProcessingDepthRef.current > 0;
    const mpEngineBusy =
      !!multiplayerSessionId &&
      (!!multiplayerPendingCommand?.id ||
        isTyping ||
        apiPipelineBusy ||
        (multiplayerThinkingState.active === true && !mpThisClientHoldsAutoIntent));
    const isEngineResolvingNow = multiplayerSessionId ? mpEngineBusy : isTyping || apiPipelineBusy;
    if (isGameOver || (player?.hp?.current ?? 1) <= 0) return;
    // "Combat effectif" : déplacements au CaC, etc. (indépendant de « tour de parole »).
    const effectiveInCombat =
      gameMode === "combat" || hasAnyCombatReadyHostile(entities) || (combatOrder?.length ?? 0) > 0;
    // Tour de parole : même règle que l'UI (isInCombat = gameMode === "combat" seulement).
    // Sinon en exploration avec un vieil ordre d'initiative ou des hostiles sur la scène,
    // le joueur voit « Envoyer » actif mais handleSend / auto-joueur refusaient l'action.
    const co = gameStateRef.current?.combatOrder ?? combatOrder;
    const hasOrder = gameMode === "combat" && co.length > 0;
    const orderForGate = Array.isArray(combatOrder) && combatOrder.length > 0 ? combatOrder : co;
    const safeIdxSend =
      hasOrder && orderForGate.length > 0
        ? Math.min(Math.max(0, combatTurnIndex), orderForGate.length - 1)
        : 0;
    const activeIdForSend = hasOrder ? orderForGate[safeIdxSend]?.id ?? null : null;
    const isMyTurn =
      gameMode !== "combat"
        ? true
        : awaitingPlayerInitiative
          ? false
          : !hasOrder
            ? false
            : isLocalPlayerCombatantId(activeIdForSend);
    if (!trimmed || isEngineResolvingNow) {
      if (trimmed && multiplayerSessionId && isEngineResolvingNow) {
        const now = Date.now();
        if (now - lastSessionBusyNoticeAtRef.current >= 4200) {
          lastSessionBusyNoticeAtRef.current = now;
          addMessage(
            "ai",
            "Une résolution MJ ou une autre action est déjà en cours dans cette session. Patientez un instant.",
            "meta",
            makeMsgId()
          );
        }
      }
      return;
    }
    if (retryCountdown > 0 || flowBlocked) {
      addMessage(
        "ai",
        "Une résolution précédente est encore en échec/attente de reprise. Réessayez dans un instant.",
        "intent-error",
        makeMsgId()
      );
      return;
    }
    if (pendingRoll) {
      addMessage(
        "ai",
        "Un jet est en attente : résolvez d'abord ce jet avant d'envoyer une nouvelle action.",
        "intent-error",
        makeMsgId()
      );
      return;
    }
    if (!isMyTurn) {
      // En multijoueur, "intent-error" n'est pas affiché (filtre anti-flicker Firestore) :
      // utiliser "meta" pour que le joueur voie toujours pourquoi l'action est refusée.
      addMessage(
        "ai",
        "Ce n'est pas votre tour pour l'instant.",
        multiplayerSessionId ? "meta" : "intent-error",
        makeMsgId()
      );
      return;
    }

    if (multiplayerSessionId) {
      const liveSnap = gameStateRef.current ?? null;
      const mpCmd = {
        id: makeMsgId(),
        userContent: trimmed,
        // Message joueur normal : doit rester sans type pour passer par parse-intent
        // et utiliser le rendu utilisateur standard (bulle bleue).
        msgType: null,
        isDebug: false,
        senderName: liveSnap?.player?.name ?? player?.name ?? "Joueur",
        playerSnapshot: liveSnap?.player ?? player ?? null,
        gameModeSnapshot: liveSnap?.gameMode ?? gameMode ?? null,
        currentRoomIdSnapshot: liveSnap?.currentRoomId ?? currentRoomId ?? null,
        currentSceneSnapshot: liveSnap?.currentScene ?? currentScene ?? null,
        currentSceneNameSnapshot: liveSnap?.currentSceneName ?? currentSceneName ?? null,
        entitiesSnapshot: Array.isArray(liveSnap?.entities) ? liveSnap.entities : entities ?? null,
        turnResourcesSnapshot: turnResourcesRef.current
          ? {
              action: !!turnResourcesRef.current.action,
              bonus: !!turnResourcesRef.current.bonus,
              reaction: !!turnResourcesRef.current.reaction,
              movement:
                typeof turnResourcesRef.current.movement === "boolean"
                  ? turnResourcesRef.current.movement
                  : Number(turnResourcesRef.current.movement) > 0,
            }
          : null,
        // Doit être le clientId (onglet / session), pas l'id PJ — utilisé pour forClientId du pendingRoll.
        submittedBy: String(clientId ?? "").trim(),
        submittedAtMs: Date.now(),
      };
      let ok = await submitMultiplayerCommand(mpCmd);
      if (!ok) {
        await new Promise((r) => setTimeout(r, 420));
        ok = await submitMultiplayerCommand(mpCmd);
      }
      if (!ok) {
        addMessage(
          "ai",
          "Une autre action est déjà en attente ou en cours de résolution dans cette session.",
          "intent-error",
          makeMsgId()
        );
        try {
          await releaseMultiplayerAutoPlayerIntentLock();
        } catch {
          /* ignore */
        }
        return;
      }
      stickToBottomRef.current = true;
      setInput("");
      return;
    }

    stickToBottomRef.current = true;
    setInput("");

    await callApi(trimmed);
  }

  async function handleEndTurn() {
    if (isGameOver || (player?.hp?.current ?? 1) <= 0) return;
    if (isTyping || retryCountdown > 0 || pendingRoll || flowBlocked) return;
    if (gameMode !== "combat") return;
    const activeEntry = combatOrder.length ? combatOrder[clampedCombatTurnIndex()] : null;
    if (!activeEntry || !isLocalPlayerCombatantId(activeEntry.id)) return;

    if (multiplayerSessionId) {
      const liveSnap = gameStateRef.current ?? null;
      const livePlayer = liveSnap?.player ?? player ?? null;
      const mpCmd = {
        id: makeMsgId(),
        userContent: "[ENGINE_END_TURN]",
        msgType: "meta",
        isDebug: false,
        senderName: livePlayer?.name ?? "Joueur",
        playerSnapshot: livePlayer,
        gameModeSnapshot: liveSnap?.gameMode ?? null,
        currentRoomIdSnapshot: liveSnap?.currentRoomId ?? null,
        currentSceneSnapshot: liveSnap?.currentScene ?? null,
        currentSceneNameSnapshot: liveSnap?.currentSceneName ?? null,
        entitiesSnapshot: Array.isArray(liveSnap?.entities) ? liveSnap.entities : null,
        turnResourcesSnapshot: turnResourcesRef.current
          ? {
              action: !!turnResourcesRef.current.action,
              bonus: !!turnResourcesRef.current.bonus,
              reaction: !!turnResourcesRef.current.reaction,
              movement:
                typeof turnResourcesRef.current.movement === "boolean"
                  ? turnResourcesRef.current.movement
                  : Number(turnResourcesRef.current.movement) > 0,
            }
          : null,
        submittedBy: String(clientId ?? "").trim(),
        submittedAtMs: Date.now(),
      };
      let ok = await submitMultiplayerCommand(mpCmd);
      if (!ok) {
        await new Promise((r) => setTimeout(r, 420));
        ok = await submitMultiplayerCommand(mpCmd);
      }
      if (!ok) {
        addMessage(
          "ai",
          "Une autre action est déjà en attente ou en cours de résolution dans cette session.",
          "intent-error",
          makeMsgId()
        );
      }
      return;
    }

    setIsTyping(true);
    try {
      clearPlayerSurprisedState();
      addMessage(
        "ai",
        `**${player?.name ?? "Vous"}** met fin à son tour.`,
        "turn-end",
        makeMsgId()
      );
      addMessage("ai", "", "turn-divider", makeMsgId());
      // Boucle tour par tour (enregistrée sur le contexte comme nextTurn)
      await nextTurn();
    } finally {
      setIsTyping(false);
    }
  }

  async function handleSecondWind() {
    if (isTyping || retryCountdown > 0 || pendingRoll || flowBlocked) return;
    if (gameMode !== "combat") return;
    const activeEntry = combatOrder.length ? combatOrder[clampedCombatTurnIndex()] : null;
    if (!activeEntry || !isLocalPlayerCombatantId(activeEntry.id)) return;
    if (player?.entityClass !== "Guerrier") return;

    const remaining = player?.fighter?.resources?.secondWind?.remaining ?? 0;
    if (remaining <= 0) {
      addMessage("ai", "âš  Second souffle indisponible (déjÃ  utilisé).", undefined, makeMsgId());
      return;
    }
    if (!turnResourcesRef.current?.bonus) {
      addMessage("ai", "âš  Vous avez déjÃ  utilisé votre **Action bonus** ce tour-ci â€” impossible d'utiliser Second souffle.", undefined, makeMsgId());
      return;
    }
    if (player.hp.current >= player.hp.max) {
      addMessage("ai", "âš  Vous êtes déjÃ  Ã  vos PV maximum.", undefined, makeMsgId());
      return;
    }

    const secondWindRoll = {
      kind: "second_wind",
      roll: "1d10",
      raison: "Second souffle (1d10 + niveau)",
    };
    pendingRollRef.current = secondWindRoll;
    setPendingRoll(secondWindRoll);
    // Pas de message séparé ici : l’UI de jet en attente suffit ; un seul message dans le journal après le 1d10.
  }

  async function handleTurnUndead() {
    if (isTyping || retryCountdown > 0 || pendingRoll || flowBlocked) return;
    if (gameMode !== "combat") return;
    const activeEntry = combatOrder.length ? combatOrder[clampedCombatTurnIndex()] : null;
    if (!activeEntry || !isLocalPlayerCombatantId(activeEntry.id)) return;
    if (player?.entityClass !== "Clerc") return;

    const cd = player?.cleric?.resources?.channelDivinity ?? null;
    const remaining = cd?.remaining ?? 0;
    if (remaining <= 0) {
      addMessage("ai", "âš  Conduit divin indisponible (déjÃ  utilisé).", undefined, makeMsgId());
      return;
    }
    if (!turnResourcesRef.current?.action) {
      addMessage("ai", "âš  Vous avez déjÃ  utilisé votre **Action** ce tour-ci â€” impossible d'utiliser Conduit divin.", undefined, makeMsgId());
      return;
    }

    // CoÃ»t : Action
    consumeResource(setTurnResourcesSynced, "combat", "action");

    // Décrément ressource (repos courts/longs non gérés ici, mais l'usage est tracké)
    updatePlayer({
      cleric: {
        ...(player.cleric ?? {}),
        resources: {
          ...(player.cleric?.resources ?? {}),
          channelDivinity: {
            max: cd?.max ?? 1,
            remaining: Math.max(0, remaining - 1),
          },
        },
      },
    });

    addMessage(
      "ai",
      `ðŸ› Conduit divin â€” **Renvoi des morts-vivants** (Action).`,
      "meta-reply",
      makeMsgId()
    );
    addMessage(
      "ai",
      `[DEBUG] Conduit divin : Renvoi des morts-vivants (moteur)\n` +
        safeJson({
          remainingBefore: remaining,
          remainingAfter: Math.max(0, remaining - 1),
        }),
      "debug",
      makeMsgId()
    );

    // L'IA narre l'effet et la scène; le moteur n'a pas (encore) de tag "undead" sur les entités.
    await callApi("Conduit divin : Renvoi des morts-vivants.", "meta", false, {
      engineEvent: {
        kind: "channel_divinity_turn_undead_requested",
        remainingAfter: Math.max(0, remaining - 1),
      },
    });
  }

  async function handleCunningActionDash() {
    if (isTyping || retryCountdown > 0 || pendingRoll || flowBlocked) return;
    if (gameMode !== "combat") return;
    const activeEntry = combatOrder.length ? combatOrder[clampedCombatTurnIndex()] : null;
    if (!activeEntry || !isLocalPlayerCombatantId(activeEntry.id)) return;
    if (player?.entityClass !== "Roublard" || (player?.level ?? 1) < 2) return;
    if (!turnResourcesRef.current?.bonus) return;
    consumeResource(setTurnResourcesSynced, "combat", "bonus");
    addMessage("ai", "ðŸƒ Ruse â€” vous foncez (Action bonus).", "meta-reply", makeMsgId());
  }

  async function handleCunningActionHide() {
    if (isTyping || retryCountdown > 0 || pendingRoll || flowBlocked) return;
    if (gameMode !== "combat") return;
    const activeEntry = combatOrder.length ? combatOrder[clampedCombatTurnIndex()] : null;
    if (!activeEntry || !isLocalPlayerCombatantId(activeEntry.id)) return;
    if (player?.entityClass !== "Roublard" || (player?.level ?? 1) < 2) return;
    if (!turnResourcesRef.current?.bonus) return;
    if ((getMeleeWith(activeEntry.id) ?? []).length > 0) {
      addMessage(
        "ai",
        "🚫 Impossible de se cacher (Ruse) : vous êtes au corps à corps d’une autre créature.",
        "meta-reply",
        makeMsgId()
      );
      return;
    }
    consumeResource(setTurnResourcesSynced, "combat", "bonus");
    addMessage("ai", "ðŸ«¥ Ruse â€” vous tentez de vous cacher (Action bonus).", "meta-reply", makeMsgId());
    await performCombatHideRoll({
      combatantId: activeEntry.id,
      combatant: player,
      label: "Ruse — action bonus",
    });
    await callApi("Ruse : se cacher (action bonus).", "meta", false, {
      engineEvent: { kind: "cunning_action_hide" },
    });
  }

  async function handleCunningActionDisengage() {
    if (isTyping || retryCountdown > 0 || pendingRoll || flowBlocked) return;
    if (gameMode !== "combat") return;
    const activeEntry = combatOrder.length ? combatOrder[clampedCombatTurnIndex()] : null;
    if (!activeEntry || !isLocalPlayerCombatantId(activeEntry.id)) return;
    if (player?.entityClass !== "Roublard" || (player?.level ?? 1) < 2) return;
    if (!turnResourcesRef.current?.bonus) return;
    setHasDisengagedThisTurn(true);
    consumeResource(setTurnResourcesSynced, "combat", "bonus");
    addMessage("ai", "ðŸ›¡ï¸ Ruse â€” vous vous désengagez (Action bonus).", "meta-reply", makeMsgId());
  }

  const arcaneRecoveryBudget = Math.ceil((player?.level ?? 1) / 2);
  const arcaneRecoveryUsed = !!player?.wizard?.arcaneRecovery?.used;
  const arcaneRecoveryRecoverableEntries = [1, 2, 3, 4, 5]
    .map((lvl) => {
      const row = player?.spellSlots?.[lvl];
      if (!row) return null;
      const max = Number(row.max ?? 0) || 0;
      const remaining = Number(row.remaining ?? max) || 0;
      const missing = Math.max(0, max - remaining);
      if (missing <= 0) return null;
      const value = Number(arcaneRecoveryPick?.[lvl] ?? 0) || 0;
      return { lvl, max, remaining, missing, value };
    })
    .filter(Boolean);
  const arcaneRecoveryPlannedSpend = arcaneRecoveryRecoverableEntries.reduce(
    (sum, entry) => sum + Math.min(entry.value, entry.missing),
    0
  );
  const arcaneRecoveryBudgetLeft = Math.max(0, arcaneRecoveryBudget - arcaneRecoveryPlannedSpend);

  function applyArcaneRecovery() {
    if (player?.entityClass !== "Magicien") return;
    if (!player?.spellSlots) return;
    if (arcaneRecoveryUsed) return false;

    const current = player.spellSlots;
    let budgetLeft = arcaneRecoveryBudget;
    const nextSlots = { ...current };
    const applied = {};

    // Niveaux autorisés: 1..5 (interdit >=6)
    const levels = Object.keys(arcaneRecoveryPick)
      .map((k) => parseInt(k, 10))
      .filter((n) => !Number.isNaN(n) && n >= 1 && n <= 5)
      .sort((a, b) => a - b);

    for (const lvl of levels) {
      if (budgetLeft <= 0) break;
      const want = Math.max(0, Math.floor(Number(arcaneRecoveryPick[lvl]) || 0));
      if (want <= 0) continue;
      const row = current[lvl];
      if (!row) continue;
      const max = Number(row.max ?? 0) || 0;
      const remaining = Number(row.remaining ?? max) || 0;
      const missing = Math.max(0, max - remaining);
      if (missing <= 0) continue;

      const canTake = Math.min(want, missing, budgetLeft);
      if (canTake <= 0) continue;

      nextSlots[lvl] = { ...row, remaining: Math.min(max, remaining + canTake) };
      applied[lvl] = canTake;
      budgetLeft -= canTake;
    }

    if (Object.keys(applied).length === 0) {
      addMessage(
        "ai",
        "⚠ Restauration arcanique : aucune récupération appliquée (choisissez des emplacements dépensés).",
        undefined,
        makeMsgId()
      );
      return false;
    }

    updatePlayer({
      spellSlots: nextSlots,
      wizard: {
        ...(player.wizard ?? {}),
        arcaneRecovery: { used: true },
      },
    });

    addMessage(
      "ai",
      `🧪 Repos court — Restauration arcanique : vous récupérez ${Object.entries(applied)
        .map(([lvl, n]) => `${n} emplacement(s) niv ${lvl}`)
        .join(", ")}.`,
      "meta-reply",
      makeMsgId()
    );
    addMessage(
      "ai",
      `[DEBUG] Restauration arcanique (moteur)\n` +
        safeJson({
          budget: arcaneRecoveryBudget,
          applied,
          before: current,
          after: nextSlots,
        }),
      "debug",
      makeMsgId()
    );
    return true;
  }

  async function resolveMovementGate(choice) {
    const gate = movementGate;
    if (!gate) return;
    const hostileIds = gate.hostileIds ?? (gate.enemyId ? [gate.enemyId] : []);
    // Désengagement = Action
    if (choice === "disengage") {
      if (gameMode === "combat" && !turnResourcesRef.current?.action) {
        addMessage("ai", "Vous avez déjÃ  dépensé votre **Action** ce tour-ci â€” impossible de vous désengager maintenant.", undefined, makeMsgId());
        return;
      }
      setHasDisengagedThisTurn(true);
      consumeResource(setTurnResourcesSynced, "combat", "action");
      clearMeleeFor(localCombatantId);
      setMovementGate(null);
      setInput("");
      await callApi(gate.text);
      return;
    }

    // Partir quand même â†’ on simule une attaque d'opportunité immédiate (moteur), puis mouvement
    if (choice === "leave_anyway") {
      const moverSurvived = await processOpportunityAttacksForLeavingCombatant(localCombatantId, hostileIds);
      setMovementGate(null);
      setInput("");
      if (!moverSurvived || (playerHpRef.current ?? player?.hp?.current ?? 0) <= 0) {
        return;
      }
      {
        const orderDbg = gameStateRef.current?.combatOrder ?? combatOrder;
        const entsDbg = gameStateRef.current?.entities ?? entities;
        setTimeout(() => {
          emitMeleeGraphDebugChat({
            label: "PJ quitte le contact (après attaques d'opportunité)",
            moverId: localCombatantId,
            moverName: player?.name ?? null,
            getMeleeWith,
            entities: entsDbg,
            combatOrder: orderDbg,
            localCombatantIdForNames: localCombatantId,
            localPlayerDisplayName: player?.name ?? null,
            addMessage,
            makeMsgId,
          });
        }, 0);
      }
      await callApi(gate.text);
    }
  }

  async function handleRoll() {
    const roll = pendingRollRef.current != null ? pendingRollRef.current : pendingRoll;
    if (!roll || retryCountdown > 0 || flowBlocked) return;
    const rollStableKey = getPendingRollStableKey(roll);
    const unhideRollBannerIfSame = () => {
      if (!rollStableKey) return;
      setPendingRollUiHiddenKey((prev) => (prev === rollStableKey ? null : prev));
    };
    if (rollStableKey) setPendingRollUiHiddenKey(rollStableKey);
    const forMe = pendingRollTargetsLocalPlayer(
      roll,
      player,
      clientId,
      !!multiplayerSessionId,
      multiplayerSessionId,
      multiplayerParticipantProfilesRef.current
    );
    if (!forMe) return;
    if (roll.kind === "death_save" && !isPlayerTurnNow()) return;
    // En multi, `isTyping` peut rester true pendant que le serveur est en train de traiter
    ///relancer la commande. Comme on a déjà un `pendingRoll` valide pour nous,
    // on autorise le clic "Lancer le dé" même si l'indicateur "MJ réfléchit" est visible.
    if (!multiplayerSessionId && isTyping) return;

    const diceDesc = getPendingRollDiceDescriptor(roll);
    const rollNotation = diceDesc.rollNotation;
    const diceCount = diceDesc.diceCount;
    const diceSides = diceDesc.diceSides;

    const effGmRoll = gameStateRef.current?.gameMode ?? gameMode;
    const hiddenIdsRoll = gameStateRef.current?.combatHiddenIds ?? combatHiddenIds ?? [];
    const atkAdvCtxRoll =
      roll.kind === "attack"
        ? computePlayerAttackAdvDisForPendingRoll({
            pendingRoll: roll,
            gameMode: effGmRoll,
            player,
            entities: gameStateRef.current?.entities ?? entities ?? [],
            combatHiddenIds: hiddenIdsRoll,
            localCombatantId,
            multiplayerSessionId,
            getMeleeWith,
            dodgeMap: dodgeActiveByCombatantIdRef.current ?? {},
            controllerForCombatantId,
          })
        : null;

    let manualNatOverride = null;
    let manualDiceNats = null;
    if (useManualRollInputRef.current) {
      if (roll.kind === "attack" && atkAdvCtxRoll?.needsTwoD20) {
        const manualNatCandidate =
          String(manualRollNatInputRef.current ?? "").trim() !== ""
            ? Number(manualRollNatInputRef.current)
            : NaN;
        if (!Number.isInteger(manualNatCandidate) || manualNatCandidate < 1 || manualNatCandidate > 20) {
          addMessage(
            "ai",
            "Indiquez le résultat final du d20 (1–20) après avantage / désavantage.",
            "intent-error",
            makeMsgId()
          );
          unhideRollBannerIfSame();
          return;
        }
        manualNatOverride = Math.trunc(manualNatCandidate);
        // En mode manuel simplifié, le joueur fournit directement le résultat retenu.
        manualDiceNats = [manualNatOverride];
      } else if (roll.kind === "damage_roll" && diceCount > 1) {
        const cells = manualPerDieValuesRef.current;
        if (!Array.isArray(cells) || cells.length !== diceCount) {
          addMessage(
            "ai",
            `Indiquez le résultat de chaque dé (${diceCount} × d${diceSides}).`,
            "intent-error",
            makeMsgId()
          );
          unhideRollBannerIfSame();
          return;
        }
        const vals = [];
        for (let i = 0; i < diceCount; i++) {
          const n = Number(String(cells[i]).trim());
          if (!Number.isInteger(n) || n < 1 || n > diceSides) {
            addMessage(
              "ai",
              `Dé ${i + 1} : entier entre 1 et ${diceSides} requis.`,
              "intent-error",
              makeMsgId()
            );
            unhideRollBannerIfSame();
            return;
          }
          vals.push(n);
        }
        manualDiceNats = vals;
        manualNatOverride = vals.reduce((a, b) => a + b, 0);
      } else {
        const manualNatCandidate =
          String(manualRollNatInputRef.current ?? "").trim() !== ""
            ? Number(manualRollNatInputRef.current)
            : NaN;
        const inSumRange =
          Number.isFinite(manualNatCandidate) &&
          manualNatCandidate >= diceCount &&
          manualNatCandidate <= diceCount * diceSides;
        if (inSumRange) {
          manualNatOverride = Math.trunc(manualNatCandidate);
        }
        if (manualNatOverride == null) {
          addMessage(
            "ai",
            `Nat de dé invalide (attendu ${diceCount}d${diceSides}, somme ${diceCount}–${diceCount * diceSides}).`,
            "intent-error",
            makeMsgId()
          );
          unhideRollBannerIfSame();
          return;
        }
      }
      setUseManualRollInput(false);
      setManualRollNatInput("");
      setManualPerDieValues([]);
    }

    const sessionLockId = await acquireMultiplayerProcessingLock(`roll:${roll.kind ?? "unknown"}`);
    if (!sessionLockId) {
      unhideRollBannerIfSame();
      if (multiplayerSessionId && autoRollEnabledRef.current && pendingRollRef.current) {
        lastAutoRollKeyRef.current = null;
        if (rollAutoRetryTimerRef.current == null) {
          rollAutoRetryTimerRef.current = setTimeout(() => {
            rollAutoRetryTimerRef.current = null;
            if (
              autoRollEnabledRef.current &&
              pendingRollRef.current &&
              !flowBlockedRef.current &&
              !rollResolutionInProgressRef.current
            ) {
              void handleRoll();
            }
          }, 480);
        }
        return;
      }
      if (multiplayerSessionId) {
        const now = Date.now();
        if (now - lastSessionBusyNoticeAtRef.current < 4200) return;
        lastSessionBusyNoticeAtRef.current = now;
        addMessage(
          "ai",
          "Un autre jet ou une autre action est déjà en cours de résolution dans cette session.",
          "intent-error",
          makeMsgId()
        );
      }
      return;
    }
    if (
      isGameOver ||
      ((player?.hp?.current ?? 1) <= 0 && roll.kind !== "death_save" && roll.kind !== "hit_die")
    ) {
      await releaseMultiplayerProcessingLock(sessionLockId);
      unhideRollBannerIfSame();
      return;
    }
    rollResolutionInProgressRef.current = true;
    skipRemotePendingRollApplyRef.current = true;
    setIsTyping(true);
    // Drapeau avant l'await : si l'écriture Firestore échoue, on doit quand même débloquer le bandeau dans `finally`.
    let mpGmThinkingOwnedByThisRoll = !!multiplayerSessionId;
    if (multiplayerSessionId) {
      try {
        await setMultiplayerThinkingState({
          active: true,
          actor: "gm",
          label: "Le MJ réfléchit…",
        });
      } catch {
        /* ignore */
      }
    }
    try {
    addMessage(
      "ai",
      `[DEBUG][ENGINE_RX] Roll à traiter\n` +
        safeJson({
          kind: roll?.kind ?? null,
          stat: roll?.stat ?? null,
          skill: roll?.skill ?? null,
          dc: roll?.dc ?? null,
          reason: roll?.raison ?? null,
          returnToArbiter: roll?.returnToArbiter === true,
        }),
      "debug",
      makeMsgId()
    );

    if (roll.kind === "damage_roll") {
      const handled = await resolvePendingDamageRollStage({
        roll,
        manualNatOverride,
        manualDiceNats,
        getEntities: () => getEntitiesSnapshot(),
        getTurnResources: () => turnResourcesRef.current,
        player,
        setHp,
        playerHpRef,
        updatePlayer,
        spendSpellSlot,
        hasResource,
        consumeResource,
        setTurnResourcesSynced,
        gameMode: gameStateRef.current?.gameMode ?? gameMode,
        stampPendingRollForActor,
        clientId,
        setPendingRoll,
        pendingRollRef,
        multiplayerSessionId,
        patchParticipantProfileHp,
        applyEntityUpdates,
        applyUpdatesLocally,
        markSceneHostilesAware,
        ensureCombatState,
        addMessage,
        makeMsgId,
        callApi,
        rollDiceDetailed,
        formatDmgRoll,
        formatDiceNotationDetail,
        fmtMod,
        setSneakAttackArmed,
        setSneakAttackUsedThisTurn,
        safeJson,
      });
      if (handled) return;
    }

    if (roll.kind === "second_wind") {
      const remaining = player?.fighter?.resources?.secondWind?.remaining ?? 0;
      if (remaining <= 0) {
        pendingRollRef.current = null;
        setPendingRoll(null);
        addMessage("ai", "⚠️ Second souffle indisponible (déjà utilisé).", undefined, makeMsgId());
        return;
      }
      if (!turnResourcesRef.current?.bonus) {
        pendingRollRef.current = null;
        setPendingRoll(null);
        addMessage(
          "ai",
          "⚠️ Vous avez déjà utilisé votre **Action bonus** ce tour-ci — impossible d'utiliser Second souffle.",
          undefined,
          makeMsgId()
        );
        return;
      }
      if ((player?.hp?.current ?? 0) >= (player?.hp?.max ?? 0)) {
        pendingRollRef.current = null;
        setPendingRoll(null);
        addMessage("ai", "⚠️ Vous êtes déjà à vos PV maximum.", undefined, makeMsgId());
        return;
      }
      const hpBefore = player?.hp?.current ?? 0;
      let dieNat;
      if (manualNatOverride != null) {
        dieNat = manualNatOverride;
      } else if (debugNextRoll != null) {
        dieNat = debugNextRoll;
      } else {
        dieNat = rollDiceDetailed("1d10").total;
      }
      if (debugNextRoll !== null) setDebugNextRoll(null);
      const heal = Math.max(1, dieNat + (player.level ?? 1));
      const nextHp = Math.min(player.hp.max, hpBefore + heal);
      consumeResource(setTurnResourcesSynced, "combat", "bonus");
      setHp(nextHp);
      playerHpRef.current = nextHp;
      updatePlayer({
        fighter: {
          ...(player.fighter ?? {}),
          resources: {
            ...(player.fighter?.resources ?? {}),
            secondWind: { max: 1, remaining: remaining - 1 },
          },
        },
      });
      pendingRollRef.current = null;
      setPendingRoll(null);
      addMessage(
        "ai",
        `🩹 Second souffle — 1d10 [${dieNat}] + niveau (${player.level}) = **${heal} PV** → Vous : **${nextHp}/${player.hp.max} HP**`,
        "dice",
        makeMsgId()
      );
      addMessage(
        "ai",
        `[DEBUG] Second souffle (moteur)\n` +
          safeJson({
            die: dieNat,
            heal,
            hpBefore,
            hpAfter: nextHp,
            remainingBefore: remaining,
            remainingAfter: remaining - 1,
          }),
        "debug",
        makeMsgId()
      );
      return;
    }

    if (roll.kind === "hit_die") {
      const hitDieNotation = String(roll?.engineContext?.hitDie ?? player?.hitDie ?? "d8");
      const dieRoll =
        manualNatOverride != null
          ? { total: manualNatOverride, rolls: [manualNatOverride] }
          : rollDiceDetailed(hitDieNotation);
      const conMod = getPlayerConModifier();
      const heal = Math.max(0, dieRoll.total + conMod);
      // Snapshot unique : évite décalage chat / barre (ex. double passage du updater React).
      const maxHp = player?.hp?.max ?? 0;
      const currentHp = player?.hp?.current ?? 0;
      const prevHd = player?.hitDiceRemaining ?? 0;
      const remainingAfter = Math.max(0, prevHd - 1);
      const nextHp = Math.min(maxHp, currentHp + heal);
      setPlayer((prev) => {
        if (!prev?.hp) return prev;
        playerHpRef.current = nextHp;
        return {
          ...prev,
          hp: { ...prev.hp, current: nextHp },
          hitDiceRemaining: remainingAfter,
        };
      });
      setShortRestState((prev) =>
        prev ? { ...prev, spentDice: Math.max(0, (prev.spentDice ?? 0) + 1) } : prev
      );
      pendingRollRef.current = null;
      setPendingRoll(null);
      addMessage(
        "ai",
        `🎲 Repos court — ${hitDieNotation} [${dieRoll.rolls.join("+")}] ${conMod >= 0 ? "+" : "-"} CON ${Math.abs(conMod)} = **${heal} PV** → Vous : **${nextHp}/${maxHp || nextHp} HP**.`,
        "dice",
        makeMsgId()
      );
      // Le repos court ne se termine plus automatiquement :
      // c'est au joueur de décider quand reprendre l'aventure.
      return;
    }

    if (roll.kind === "death_save") {
      let deathRollMeta = null;
      let nat;
      if (manualNatOverride != null) {
        nat = manualNatOverride;
      } else if (debugNextRoll != null) {
        nat = debugNextRoll;
      } else {
        const advResDs = resolvePendingRollAdvDis(roll, player);
        deathRollMeta = rollNatWithAdvDis(advResDs.adv, advResDs.dis);
        deathRollMeta.advDisDetail = advResDs.label;
        nat = deathRollMeta.nat;
      }
      if (debugNextRoll !== null) setDebugNextRoll(null);
      const deathSaveBonus = Number(roll?.totalBonus ?? 0) || 0;
      const deathSaveTotal = nat + deathSaveBonus;
      const bonusStr = fmtMod(deathSaveBonus);
      const advDsSuffix = formatAdvDisSuffixForD20(deathRollMeta);
      /** D&D 5e : stabilisé à 0 PV, au repos — 1 PV après 1d4 heures (délai en minutes monde). */
      const stableHours = rollDice("1d4");
      let nextDeathState = getPlayerDeathStateSnapshot();
      let restoredHp = null;

      if (nat === 1) {
        nextDeathState = resetPlayerDeathState({
          ...nextDeathState,
          failures: Math.min(3, nextDeathState.failures + 2),
          unconscious: true,
          stable: false,
          dead: nextDeathState.failures + 2 >= 3,
        });
      } else if (nat === 20) {
        restoredHp = 1;
      } else if (deathSaveTotal >= 10) {
        nextDeathState = resetPlayerDeathState({
          ...nextDeathState,
          successes: Math.min(3, nextDeathState.successes + 1),
          unconscious: true,
          stable: nextDeathState.successes + 1 >= 3,
          autoRecoverAtMinute:
            nextDeathState.successes + 1 >= 3 ? worldTimeMinutes + stableHours * 60 : null,
        });
      } else {
        nextDeathState = resetPlayerDeathState({
          ...nextDeathState,
          failures: Math.min(3, nextDeathState.failures + 1),
          unconscious: true,
          stable: false,
          dead: nextDeathState.failures + 1 >= 3,
        });
      }

      pendingRollRef.current = null;
      setPendingRoll(null);
      deathSavePromptKeyRef.current = null;

      if (restoredHp != null) {
        restorePlayerToConsciousness(restoredHp);
        addMessage(
          "ai",
          `🎲 Jet de sauvegarde contre la mort — Nat **20**${advDsSuffix} ! Vous revenez à vous avec **1 PV** et pouvez agir normalement.`,
          "dice",
          makeMsgId()
        );
        return;
      }

      updatePlayerDeathState(nextDeathState);
      addMessage(
        "ai",
        `🎲 Jet de sauvegarde contre la mort — Nat ${nat} ${bonusStr} = **${deathSaveTotal}**${advDsSuffix} → ${
          deathSaveTotal >= 10
            ? `Succès (${nextDeathState.successes}/3)`
            : nat === 1
              ? `Échec critique (${nextDeathState.failures}/3)`
              : `Échec (${nextDeathState.failures}/3)`
        }.`,
        "dice",
        makeMsgId()
      );

      if (nextDeathState.dead) {
        markPlayerDead("Vos derniers sursauts s'éteignent. Vous mourez.");
        return;
      }

      if (nextDeathState.stable) {
        addMessage(
          "ai",
          `Vous êtes stabilisé à **0 PV**. Temps (méthode naturelle) : **1 PV** après **${stableHours}** h de repos en jeu (jet **1d4**), vers **${formatWorldTimeLabel(
            nextDeathState.autoRecoverAtMinute ?? worldTimeMinutes
          )}**. La reprise n'a lieu **que hors combat** (si l'heure est déjà passée, dès la fin du combat).`,
          "meta",
          makeMsgId()
        );
      }

      const orderDs = gameStateRef.current?.combatOrder ?? combatOrder;
      const turnIdxDs = combatTurnIndexLiveRef.current;
      const activeCombatEntryId = orderDs?.[turnIdxDs]?.id ?? null;
      if (gameMode === "combat" && activeCombatEntryId && isLocalPlayerCombatantId(activeCombatEntryId)) {
        const ski = `${combatEngagementSeqRef.current}:${combatRoundInEngagementRef.current}:${turnIdxDs}:${activeCombatEntryId}`;
        autoEndTurnWhenDownedKeyRef.current = ski;
        // Stabilisé : l’effet « PJ stabilisé » affiche la bulle longue + même clé de skip — pas de doublon « ne peut rien faire » / double nextTurn.
        if (!nextDeathState.stable) {
          addMessage(
            "ai",
            `**${player?.name ?? "Vous"}** ne peut rien faire d'autre ce tour-ci.`,
            "turn-end",
            makeMsgId()
          );
          addMessage("ai", "", "turn-divider", makeMsgId());
        }
        scheduleStableCombatTurnAdvance(ski, () => nextTurn());
      }
      return;
    }

    // -----------------------------------------------------------------------
    // Cas 1 : Attaque résolue par le moteur (anti-hallucinations)
    // -----------------------------------------------------------------------
    if (roll.kind === "attack" && roll.targetId) {
      const localPlayerCombatantIdForAttack = localCombatantId;
      const hiddenArrAtk = gameStateRef.current?.combatHiddenIds ?? combatHiddenIds ?? [];
      const hiddenAtk = new Set(hiddenArrAtk);
      const playerWasHiddenForAttack =
        hiddenAtk.has(localPlayerCombatantIdForAttack) ||
        (!multiplayerSessionId && hiddenAtk.has("player"));
      let target = getEntitiesSnapshot().find((e) => e.id === roll.targetId) ?? null;
      const knownSpells = Array.isArray(player.selectedSpells) ? player.selectedSpells : [];
      const isSpellAttack =
        !!roll.weaponName && knownSpells.includes(roll.weaponName);
      let weapon =
        player.weapons.find((w) => w.name === roll.weaponName) ?? null;
      const isUnarmed = looksLikeUnarmedAttack(roll.raison) || looksLikeUnarmedAttack(roll.stat);
      if (!weapon && isUnarmed) {
        weapon = buildUnarmedWeapon(player, roll.raison);
      }
      // helper global isRangedWeaponName()

      // Sorts : résolus côté moteur (jet d'attaque OU jet de sauvegarde + dégâts + slots)
      if (isSpellAttack) {
        const spellMeta = getSpellRuntimeMeta(roll.weaponName);
        const spell = spellMeta.raw;
        const spellLevel = spell?.level ?? 0;

        const effGm = gameStateRef.current?.gameMode ?? gameMode;
        const trNow = turnResourcesRef.current ?? turnResources;

        const resourceKind = resourceKindForCastingTime(spellMeta.castingTime);
        if (!hasResource(trNow, effGm, resourceKind)) {
          pendingRollRef.current = null;
          setPendingRoll(null);
          const label =
            resourceKind === "bonus"
              ? "Action bonus"
              : resourceKind === "reaction"
              ? "Réaction"
              : "Action";
          addMessage(
            "ai",
            `âš  Vous avez déjÃ  utilisé votre **${label}** ce tour-ci â€” impossible de lancer ${roll.weaponName} maintenant.`,
            undefined,
            makeMsgId()
          );
          return;
        }

        const compErrRoll = spellComponentsBlockReasonForPlayer(player, roll.weaponName);
        if (compErrRoll) {
          pendingRollRef.current = null;
          setPendingRoll(null);
          addMessage("ai", `⚠️ ${compErrRoll}`, undefined, makeMsgId());
          return;
        }

        // Vérifier les emplacements de sorts
        const slotResult = spendSpellSlot(player, updatePlayer, spellLevel);
        if (!slotResult.ok) {
          pendingRollRef.current = null;
          setPendingRoll(null);
          addMessage(
            "ai",
            `âš  Vous n'avez plus d'emplacements de sort disponibles pour lancer ${roll.weaponName}.`,
            undefined,
            makeMsgId()
          );
          return;
        }

        const dc = computeSpellSaveDC(player);

        // Cas 1: sort Ã  jet de sauvegarde (save property dans SPELLS)
        if (spellMeta.save && target) {
          const saveKey = spellMeta.save; // "CON", "DEX", "SAG", etc.
          let spellSaveNpcMeta = null;
          let nat;
          if (manualNatOverride != null) {
            nat = manualNatOverride;
          } else if (debugNextRoll != null) {
            nat = debugNextRoll;
          } else {
            const advResNpc = computeSavingThrowAdvDis(saveKey, target);
            spellSaveNpcMeta = rollNatWithAdvDis(advResNpc.adv, advResNpc.dis);
            spellSaveNpcMeta.advDisDetail = advResNpc.label;
            nat = spellSaveNpcMeta.nat;
          }
          if (debugNextRoll !== null) setDebugNextRoll(null);
          const saveBonus = computeEntitySaveBonus(target, saveKey);
          const total = nat + saveBonus;
          const succeeded = total >= dc;

          const dmgNotation = String(spell.damage ?? "1d6");
          const splitDmg = splitDiceNotationAndFlatBonus(dmgNotation);
          const saveLabel = `${spell.save}`;
          const bonusStr = fmtMod(saveBonus);
          const advNpcSuffix = formatAdvDisSuffixForD20(spellSaveNpcMeta);
          const natLine =
            nat === 20
              ? `Nat **20** ðŸ’¥ (réussite automatique)${advNpcSuffix}`
              : nat === 1
              ? `Nat **1** ðŸ’€ (échec automatique)${advNpcSuffix}`
              : `Nat ${nat} ${bonusStr} = **${total}** vs DD ${dc}${advNpcSuffix}`;
          const fullSaveLine =
            `ðŸŽ² Jet de sauvegarde (${saveLabel} pour ${roll.weaponName} â†’ ${target.name}) â€” ${natLine}`;

          consumeResource(setTurnResourcesSynced, effGm, resourceKind);

          const pendingDmg = stampPendingRollForActor(
            buildPendingDiceRoll({
              roll: splitDmg.diceNotation,
              totalBonus: splitDmg.flatBonus,
              stat: "Dégâts",
              skill: roll.weaponName,
              raison: `Dégâts (${roll.weaponName} → ${target.name}) — après sauvegarde`,
              weaponName: roll.weaponName,
              targetId: target.id,
              engineContext: {
                stage: "spell_save_followup",
                spellName: roll.weaponName,
                targetId: target.id,
                saveSucceeded: succeeded,
                saveLine: fullSaveLine,
                saveType: spell.save,
                saveNat: nat,
                saveTotal: total,
                saveDc: dc,
                spellDamageType: spell.damageType ?? "",
                dmgNotation,
                slotResult,
              },
            }),
            player,
            clientId
          );

          addMessage(
            "ai",
            `[DEBUG] Résolution sort (save) ${roll.weaponName} â€” dÃ©gÃ¢ts en attente\n` +
              safeJson({
                targetId: target.id,
                targetName: target.name,
                saveType: spell.save,
                nat,
                saveBonus,
                total,
                dc,
                succeeded,
                slotLevelUsed: slotResult.usedLevel,
              }),
            "debug",
            makeMsgId()
          );

          pendingRollRef.current = pendingDmg;
          setPendingRoll(pendingDmg);
          return;
        }

        // Cas 2: sort Ã  jet d'attaque (attaque de sort)
        const spellMelee = /corps a corps|corps à corps/i.test(String(spell?.attack ?? ""));
        const spellWpnClassify = { kind: spellMelee ? "melee" : "ranged" };
        const { isMeleeAttack: spMelee, isRangedAttack: spRanged } = classifyAttackMeleeRanged(
          spellWpnClassify,
          { kind: "spell" }
        );
        const entPoolAtk = getEntitiesSnapshot();
        let spRangedInMelee = false;
        if (spRanged) {
          spRangedInMelee = getMeleeWith(localPlayerCombatantIdForAttack).some((mid) =>
            isHostileOpponentInMelee(localPlayerCombatantIdForAttack, mid, entPoolAtk, controllerForCombatantId)
          );
        }
        const advResSpellAtk = computeAttackRollAdvDis({
          attackerHidden: playerWasHiddenForAttack,
          targetHidden: !!(roll.targetId && hiddenAtk.has(roll.targetId)),
          attackerConditions: normalizeCombatantConditions({ conditions: player?.conditions }),
          targetConditions: normalizeCombatantConditions(target),
          isMeleeAttack: spMelee,
          isRangedAttack: spRanged,
          attackerRangedWeaponInMelee: spRangedInMelee,
          targetHasDodgeActive: !!(roll.targetId && dodgeActiveByCombatantIdRef.current?.[roll.targetId]),
        });
        let nat;
        if (manualNatOverride != null) {
          nat = manualNatOverride;
        } else if (debugNextRoll != null) {
          nat = debugNextRoll;
        } else {
          const rSpellAtk = rollNatWithAdvDis(advResSpellAtk.adv, advResSpellAtk.dis);
          nat = rSpellAtk.nat;
        }
        if (debugNextRoll !== null) setDebugNextRoll(null);
        const total = nat + (roll.totalBonus ?? 0);
        const bonus = fmtMod(roll.totalBonus ?? 0);
        const ac = target?.ac ?? 10;

        let hit = false;
        let crit = false;
        if (nat === 1) {
          hit = false;
        } else if (nat === 20) {
          hit = true;
          crit = true;
        } else {
          hit = total >= ac;
        }

        let dmg = 0;
        let dmgDetail = "";
        let myUpdates = [];
        if (target && target.type !== "hostile") {
          myUpdates.push({ id: target.id, action: "update", type: "hostile" });
        }

        const dmgNotation = String(spell?.damage ?? "");
        if (hit && target && target.hp && dmgNotation) {
          const tFresh = getEntitiesSnapshot().find((e) => e.id === roll.targetId);
          if (tFresh) target = tFresh;
          const splitDmg = splitDiceNotationAndFlatBonus(dmgNotation);
          const diceOnly = splitDmg.diceNotation;
          const rollCritDice = crit ? doubleWeaponDiceNotationDiceOnly(diceOnly) : diceOnly;

          const entPoolSpell = getEntitiesSnapshot();
          myUpdates = markSceneHostilesAware(entPoolSpell, myUpdates);
          const nextEntities = myUpdates.length ? applyUpdatesLocally(entPoolSpell, myUpdates) : entPoolSpell;
          if (myUpdates.length) applyEntityUpdates(myUpdates);
          ensureCombatState(nextEntities);

          consumeResource(setTurnResourcesSynced, effGm, resourceKind);

          const pendingSpellDmg = stampPendingRollForActor(
            buildPendingDiceRoll({
              roll: rollCritDice,
              totalBonus: splitDmg.flatBonus,
              stat: "Dégâts",
              skill: roll.weaponName,
              raison: `Dégâts (${roll.weaponName} → ${target.name})`,
              weaponName: roll.weaponName,
              targetId: target.id,
              engineContext: {
                stage: "spell_attack_followup",
                spellName: roll.weaponName,
                targetId: target.id,
                nat,
                crit,
                spellAtkTotal: total,
                spellAtkBonus: roll.totalBonus ?? 0,
                dmgNotation,
                slotResult,
              },
            }),
            player,
            clientId
          );

          addMessage(
            "ai",
            `[DEBUG] Résolution attaque de sort (moteur) ${roll.weaponName} â€” dÃ©gÃ¢ts en attente\n` +
              safeJson({
                targetId: roll.targetId,
                targetName: target?.name ?? null,
                nat,
                total,
                hit,
                crit,
                spellAtkBonus: roll.totalBonus,
                slotLevelUsed: slotResult.usedLevel,
              }),
            "debug",
            makeMsgId()
          );

          pendingRollRef.current = pendingSpellDmg;
          setPendingRoll(pendingSpellDmg);

          if (playerWasHiddenForAttack) {
            setCombatHiddenIds((prev) =>
              prev.filter((id) => id !== localPlayerCombatantIdForAttack && id !== "player")
            );
            setCombatStealthTotalForCombatant(localPlayerCombatantIdForAttack, null);
            setCombatStealthTotalForCombatant("player", null);
            if (multiplayerSessionId) {
              await new Promise((r) => setTimeout(r, 0));
              await flushMultiplayerSharedState();
            }
          }
          return;
        }

        const entPoolSpellMiss = getEntitiesSnapshot();
        myUpdates = markSceneHostilesAware(entPoolSpellMiss, myUpdates);
        const nextEntities = myUpdates.length ? applyUpdatesLocally(entPoolSpellMiss, myUpdates) : entPoolSpellMiss;
        if (myUpdates.length) applyEntityUpdates(myUpdates);
        ensureCombatState(nextEntities);

        consumeResource(setTurnResourcesSynced, effGm, resourceKind);

        const hpBefore = target?.hp?.current ?? null;
        const hpAfter =
          target?.hp
            ? (myUpdates.some((u) => u.action === "kill" && u.id === target.id) ? 0 :
                (myUpdates.find((u) => u.action === "update" && u.id === target.id)?.hp?.current ?? target.hp.current))
            : null;

        let content;
        if (nat === 1) {
          content = `ðŸŽ² Attaque de sort (${roll.weaponName} â†’ ${target?.name ?? "cible"}) â€” Nat **1** ðŸ’€ FUMBLE CRITIQUE ! ${nat} ${bonus} = **${total}** â†’ Raté.`;
        } else if (nat === 20) {
          content = `ðŸŽ² Attaque de sort (${roll.weaponName} â†’ ${target?.name ?? "cible"}) â€” Nat **20** ðŸ’¥ COUP CRITIQUE ! ${nat} ${bonus} = **${total}** â†’ Touché ! ${dmgDetail}.`;
        } else if (hit) {
          content = `ðŸŽ² Attaque de sort (${roll.weaponName} â†’ ${target?.name ?? "cible"}) â€” Nat ${nat} ${bonus} = **${total}** â†’ Touché ! ${dmgDetail}.`;
        } else {
          content = `ðŸŽ² Attaque de sort (${roll.weaponName} â†’ ${target?.name ?? "cible"}) â€” Nat ${nat} ${bonus} = **${total}** â†’ Raté.`;
        }

        addMessage(
          "ai",
          `[DEBUG] Résolution attaque de sort (moteur) ${roll.weaponName}\n` +
            safeJson({
              targetId: roll.targetId,
              targetName: target?.name ?? null,
              nat,
              total,
              hit,
              crit,
              damage: hit ? dmg : 0,
              hpBefore,
              hpAfter,
              slotLevelUsed: slotResult.usedLevel,
            }),
          "debug",
          makeMsgId()
        );

        pendingRollRef.current = null;
        setPendingRoll(null);
        await callApi(content, "dice", false, {
          skipSessionLock: true,
          skipAutoPlayerTurn: true,
          entities: nextEntities,
          engineEvent: {
            kind: "spell_attack_resolution",
            spellName: roll.weaponName,
            targetId: roll.targetId,
            nat,
            total,
            hit,
            crit,
            damage: hit ? dmg : 0,
            targetHpBefore: hpBefore,
            targetHpAfter: hpAfter,
            targetHpMax: target?.hp?.max ?? null,
            targetIsAlive: hpAfter === null ? true : hpAfter > 0,
            slotLevelUsed: slotResult.usedLevel,
          },
        });
        if (playerWasHiddenForAttack) {
          setCombatHiddenIds((prev) =>
            prev.filter((id) => id !== localPlayerCombatantIdForAttack && id !== "player")
          );
          setCombatStealthTotalForCombatant(localPlayerCombatantIdForAttack, null);
          setCombatStealthTotalForCombatant("player", null);
          if (multiplayerSessionId) {
            await new Promise((r) => setTimeout(r, 0));
            await flushMultiplayerSharedState();
          }
        }
        return;
      }

      weapon = weapon ?? player.weapons[0] ?? null;

      // Si on ne peut pas résoudre proprement (pas de cible/arme/CA), on fallback en jet simple.
      if (!target || !weapon || target.ac === null) {
        const nat =
          manualNatOverride != null
            ? manualNatOverride
            : debugNextRoll != null
              ? debugNextRoll
              : Math.floor(Math.random() * 20) + 1;
        if (debugNextRoll !== null) setDebugNextRoll(null);
        const total = nat + roll.totalBonus;
        const bonus = fmtMod(roll.totalBonus);
        const publicTitle = getPublicPendingRollTitle(roll);
        const content =
          nat === 20
            ? `ðŸŽ² ${publicTitle} â€” Nat **20** ðŸ’¥ COUP CRITIQUE !`
            : nat === 1
            ? `ðŸŽ² ${publicTitle} â€” Nat **1** ðŸ’€ FUMBLE CRITIQUE !`
            : `ðŸŽ² ${publicTitle} â€” Nat ${nat} ${bonus} = **${total}**`;
        pendingRollRef.current = null;
        setPendingRoll(null);
        await callApi(content, "dice", false, { skipSessionLock: true, skipAutoPlayerTurn: true });
        return;
      }

      const entPoolWpn = getEntitiesSnapshot();
      const { isMeleeAttack: wMelee, isRangedAttack: wRanged } = classifyAttackMeleeRanged(weapon, null);
      let wRangedInMelee = false;
      if (wRanged) {
        wRangedInMelee = getMeleeWith(localPlayerCombatantIdForAttack).some((mid) =>
          isHostileOpponentInMelee(localPlayerCombatantIdForAttack, mid, entPoolWpn, controllerForCombatantId)
        );
      }
      const advResWpn = computeAttackRollAdvDis({
        attackerHidden: playerWasHiddenForAttack,
        targetHidden: !!(roll.targetId && hiddenAtk.has(roll.targetId)),
        attackerConditions: normalizeCombatantConditions({ conditions: player?.conditions }),
        targetConditions: normalizeCombatantConditions(target),
        isMeleeAttack: wMelee,
        isRangedAttack: wRanged,
        attackerRangedWeaponInMelee: wRangedInMelee,
        targetHasDodgeActive: !!(roll.targetId && dodgeActiveByCombatantIdRef.current?.[roll.targetId]),
      });
      /** D&D 5e : avantage OU allié au contact de la cible (proxy : autre PJ au CàC de la cible), sans désavantage. */
      let allyAdjacentForSneak = false;
      for (const pid of getMeleeWith(target.id) ?? []) {
        if (pid === localPlayerCombatantIdForAttack) continue;
        if (controllerForCombatantId(pid, entPoolWpn) === "player") {
          allyAdjacentForSneak = true;
          break;
        }
      }
      const sneakEligibleFromRules =
        advResWpn.adv === true || (allyAdjacentForSneak && advResWpn.dis !== true);
      let nat;
      if (manualNatOverride != null) {
        nat = manualNatOverride;
      } else if (debugNextRoll != null) {
        nat = debugNextRoll;
      } else {
        const rWpnAtk = rollNatWithAdvDis(advResWpn.adv, advResWpn.dis);
        nat = rWpnAtk.nat;
      }
      if (debugNextRoll !== null) setDebugNextRoll(null);
      const atkParts = computeWeaponAttackParts(player, weapon.name);
      const atkBonus = atkParts.totalBonus;
      const total = nat + atkBonus;
      const bonusStr = fmtMod(atkBonus);
      const ac = target.ac ?? 10;

      let hit = false;
      let crit = false;
      let dmg = 0;
      let dmgDetail = "";

      if (nat === 1) {
        hit = false;
      } else if (nat === 20) {
        hit = true;
        crit = true;
      } else {
        hit = total >= ac; // IMPORTANT: >= en D&D 5e
      }

      let myUpdates = [];
      if (target.type !== "hostile") {
        myUpdates.push({ id: target.id, action: "update", type: "hostile" });
      }

      if (hit && target.hp) {
        const tFreshW = getEntitiesSnapshot().find((e) => e.id === roll.targetId);
        if (tFreshW) target = tFreshW;
        const splitDmg = splitDiceNotationAndFlatBonus(weapon.damageDice ?? "1d4");
        const diceOnly = splitDmg.diceNotation;
        const dmgBonus =
          atkParts.abilityModValue + (atkParts?.style?.duelBonusDmg ?? 0) + (splitDmg.flatBonus ?? 0);
        const rollNotation = crit ? doubleWeaponDiceNotationDiceOnly(diceOnly) : diceOnly;

        const wdb = atkParts?.weaponDb ?? null;
        const props = Array.isArray(wdb?.properties) ? wdb.properties : [];
        const isRanged = props.some((p) => normalizeFr(p).includes("munitions"));
        const isFinesse = String(wdb?.stat ?? "") === "FINESSE";
        const finesseOrRanged = isRanged || isFinesse;

        const sneakAttackContext = {
          enabled: player?.entityClass === "Roublard",
          sneakAttackArmed,
          sneakAttackUsedThisTurn,
          sneakEligibleFromRules,
          sneakDice: ROGUE_SNEAK_ATTACK_DICE_BY_LEVEL?.[player.level ?? 1] ?? "1d6",
          finesseOrRanged,
        };

        const styleAtkStr = (atkParts?.style?.archeryBonus ?? 0) ? ` + Style ${fmtMod(atkParts.style.archeryBonus)}` : "";
        const atkBreakdown =
          `${nat} + ${atkParts.abilityKey} ${fmtMod(atkParts.abilityModValue)} + PB ${fmtMod(atkParts.pb)}` +
          `${styleAtkStr} = **${total}**`;

        const weaponAttackCtx = {
          stage: "weapon_attack_followup",
          targetId: target.id,
          targetName: target.name,
          nat,
          crit,
          atkTotal: total,
          atkBreakdown,
          weaponSnapshot: { ...weapon },
          weaponDebug: {
            name: weapon.name,
            atkBonus,
            parts: {
              ability: atkParts.abilityKey,
              abilityMod: atkParts.abilityModValue,
              pb: atkParts.pb,
              styleAtk: atkParts?.style?.archeryBonus ?? 0,
              styleDmg: atkParts?.style?.duelBonusDmg ?? 0,
            },
            damageDice: weapon.damageDice,
            damageBonus: dmgBonus,
          },
          sneakAttackContext,
        };

        const entPoolWpnHit = getEntitiesSnapshot();
        myUpdates = markSceneHostilesAware(entPoolWpnHit, myUpdates);
        const nextEntities = myUpdates.length ? applyUpdatesLocally(entPoolWpnHit, myUpdates) : entPoolWpnHit;
        if (myUpdates.length) applyEntityUpdates(myUpdates);
        ensureCombatState(nextEntities);

        if (shouldEngageMeleeAfterWeaponHit(roll, weapon, player, localCombatantId, target.id, getMeleeWith)) {
          addMeleeMutual(localCombatantId, target.id);
        }

        consumeResource(setTurnResourcesSynced, "combat", "action");

        const pendingDmg = stampPendingRollForActor(
          buildPendingDiceRoll({
            roll: rollNotation,
            totalBonus: dmgBonus,
            stat: "Dégâts",
            skill: weapon.name,
            raison: `Dégâts (${weapon.name} → ${target.name})`,
            weaponName: weapon.name,
            targetId: target.id,
            engineContext: weaponAttackCtx,
          }),
          player,
          clientId
        );

        addMessage(
          "ai",
          `[DEBUG] Résolution attaque joueur (moteur) â€” dÃ©gÃ¢ts en attente\n` +
            safeJson({
              targetId: target.id,
              targetName: target.name,
              targetAc: target.ac,
              hpBefore: target.hp?.current ?? null,
              hpMax: target.hp?.max ?? null,
              weapon: weaponAttackCtx.weaponDebug,
              nat,
              total,
              hit,
              crit,
              sneakAttackContext,
            }),
          "debug",
          makeMsgId()
        );

        addMessage(
          "ai",
          `[DEBUG][ENGINE_RX] Ressources tour après résolution attaque armes (moteur)\n` +
            safeJson({
              localCombatantId,
              turnResourcesRefAfter: normalizeTurnResourcesInput(turnResourcesRef.current),
              mapEntryForLocalId_mayLagOneFrame: turnResourcesByCombatantId?.[localCombatantId] ?? null,
            }),
          "debug",
          makeMsgId()
        );

        pendingRollRef.current = pendingDmg;
        setPendingRoll(pendingDmg);

        if (playerWasHiddenForAttack) {
          setCombatHiddenIds((prev) =>
            prev.filter((id) => id !== localPlayerCombatantIdForAttack && id !== "player")
          );
          setCombatStealthTotalForCombatant(localPlayerCombatantIdForAttack, null);
          setCombatStealthTotalForCombatant("player", null);
          if (multiplayerSessionId) {
            await new Promise((r) => setTimeout(r, 0));
            await flushMultiplayerSharedState();
          }
        }
        return;
      }

      const entPoolWpnMiss = getEntitiesSnapshot();
      myUpdates = markSceneHostilesAware(entPoolWpnMiss, myUpdates);
      const nextEntities = myUpdates.length ? applyUpdatesLocally(entPoolWpnMiss, myUpdates) : entPoolWpnMiss;
      if (myUpdates.length) applyEntityUpdates(myUpdates);
      ensureCombatState(nextEntities);

      addMessage(
        "ai",
        `[DEBUG] Résolution attaque joueur (moteur)\n` +
          safeJson({
            targetId: target.id,
            targetName: target.name,
            targetAc: target.ac,
            hpBefore: target.hp?.current ?? null,
            hpMax: target.hp?.max ?? null,
            weapon: {
              name: weapon.name,
              atkBonus,
              parts: {
                ability: atkParts.abilityKey,
                abilityMod: atkParts.abilityModValue,
                pb: atkParts.pb,
                styleAtk: atkParts?.style?.archeryBonus ?? 0,
                styleDmg: atkParts?.style?.duelBonusDmg ?? 0,
              },
              damageDice: weapon.damageDice,
              damageBonus: atkParts.abilityModValue + (atkParts?.style?.duelBonusDmg ?? 0),
            },
            nat,
            total,
            hit,
            crit,
            dmg,
            sneak: null,
            hpAfter: target.hp ? target.hp.current : null,
            appliedUpdate: myUpdates[0] ?? null,
          }),
        "debug",
        makeMsgId()
      );

      const styleAtkStr2 = (atkParts?.style?.archeryBonus ?? 0) ? ` + Style ${fmtMod(atkParts.style.archeryBonus)}` : "";
      const atkBreakdown =
        `${nat} + ${atkParts.abilityKey} ${fmtMod(atkParts.abilityModValue)} + PB ${fmtMod(atkParts.pb)}` +
        `${styleAtkStr2} = **${total}**`;
      let content;
      if (nat === 1) {
        content = `ðŸŽ² Attaque (${weapon.name} â†’ ${target.name}) â€” Nat **1** ðŸ’€ FUMBLE ! ${atkBreakdown} â†’ Raté.`;
      } else if (nat === 20) {
        content = `ðŸŽ² Attaque (${weapon.name} â†’ ${target.name}) â€” Nat **20** ðŸ’¥ CRITIQUE ! ${atkBreakdown} â†’ Touché ! ${dmgDetail}.`;
      } else if (hit) {
        content = `ðŸŽ² Attaque (${weapon.name} â†’ ${target.name}) â€” ${atkBreakdown} â†’ Touché ! ${dmgDetail}.`;
      } else {
        content = `ðŸŽ² Attaque (${weapon.name} â†’ ${target.name}) â€” ${atkBreakdown} â†’ Raté.`;
      }

      if (shouldEngageMeleeAfterWeaponHit(roll, weapon, player, localCombatantId, target.id, getMeleeWith)) {
        addMeleeMutual(localCombatantId, target.id);
      }

      consumeResource(setTurnResourcesSynced, "combat", "action");

      addMessage(
        "ai",
        `[DEBUG][ENGINE_RX] Ressources tour après résolution attaque armes (moteur)\n` +
          safeJson({
            localCombatantId,
            turnResourcesRefAfter: normalizeTurnResourcesInput(turnResourcesRef.current),
            mapEntryForLocalId_mayLagOneFrame: turnResourcesByCombatantId?.[localCombatantId] ?? null,
          }),
        "debug",
        makeMsgId()
      );

      pendingRollRef.current = null;
      setPendingRoll(null);
      const hpAfter =
        target.hp
          ? (myUpdates.some((u) => u.action === "kill" && u.id === target.id) ? 0 :
              (myUpdates.find((u) => u.action === "update" && u.id === target.id)?.hp?.current ?? target.hp.current))
          : null;

      await callApi(content, "dice", false, {
        skipSessionLock: true,
        skipAutoPlayerTurn: true,
        entities: nextEntities,
        engineEvent: {
          kind: "attack_resolution",
          targetId: target.id,
          targetName: target.name,
          hit,
          crit,
          damage: hit ? dmg : 0,
          sneakAttackApplied: false,
          sneakAttackDice: null,
          sneakAttackDamage: 0,
          targetHpBefore: target.hp?.current ?? null,
          targetHpAfter: hpAfter,
          targetHpMax: target.hp?.max ?? null,
          targetIsAlive: hpAfter === null ? true : hpAfter > 0,
        },
      });
      if (playerWasHiddenForAttack) {
        setCombatHiddenIds((prev) =>
          prev.filter((id) => id !== localPlayerCombatantIdForAttack && id !== "player")
        );
        setCombatStealthTotalForCombatant(localPlayerCombatantIdForAttack, null);
        setCombatStealthTotalForCombatant("player", null);
        if (multiplayerSessionId) {
          await new Promise((r) => setTimeout(r, 0));
          await flushMultiplayerSharedState();
        }
      }
      return;
    }

    // Jet de compétence en combat : une Action (évite plusieurs tests gratuits le même tour ; sync MP).
    const skipCombatActionForGlobalArbiter =
      roll.kind === "check" &&
      (roll.audience === "global" || roll.audience === "selected") &&
      roll.returnToArbiter === true &&
      roll.sceneArbiterContext;
    if (roll.kind === "check" && !skipCombatActionForGlobalArbiter) {
      const gm = gameStateRef.current?.gameMode ?? gameMode;
      const co = gameStateRef.current?.combatOrder ?? combatOrder;
      const idx = combatTurnIndexLiveRef.current;
      const activeId = co?.[idx]?.id;
      const isMyCombatTurn =
        gm === "combat" &&
        Array.isArray(co) &&
        co.length > 0 &&
        activeId &&
        isLocalPlayerCombatantId(activeId);
      if (isMyCombatTurn) {
        if (
          isMedicineCheckOnOtherCombatant(roll, localCombatantId, !!multiplayerSessionId)
        ) {
          const tid = String(roll.targetId ?? "").trim();
          const melee = getMeleeWith(localCombatantId);
          if (!Array.isArray(melee) || !melee.includes(tid)) {
            addMessage(
              "ai",
              "Action impossible : pour **stabiliser** ou intervenir en **Médecine** sur un allié, vous devez être **au corps à corps** de lui (contact).",
              multiplayerSessionId ? "meta" : "intent-error",
              makeMsgId()
            );
            unhideRollBannerIfSame();
            return;
          }
        }
        if (!turnResourcesRef.current?.action) {
          addMessage(
            "ai",
            "Vous n'avez plus d'action disponible pour ce tour.",
            "intent-error",
            makeMsgId()
          );
          pendingRollRef.current = null;
          setPendingRoll(null);
          await releaseMultiplayerProcessingLock(sessionLockId);
          return;
        }
        consumeResource(setTurnResourcesSynced, "combat", "action");
      }
    }

    // -----------------------------------------------------------------------
    // Cas 2 : Jet générique (compétence, etc.)
    // -----------------------------------------------------------------------
    let genericRollMeta = null;
    const rolledNat = (() => {
      if (manualNatOverride != null) return manualNatOverride;
      if (debugNextRoll != null) return debugNextRoll;
      const notation = rollNotation || "1d20";
      const isD20 = diceCount === 1 && diceSides === 20;
      if (!isD20) {
        const d = rollDiceDetailed(notation);
        return d.total;
      }
      const ec =
        roll?.engineContext && typeof roll.engineContext === "object" ? roll.engineContext : null;
      if (ec?.kind === "incoming_spell_save") {
        const advResIn = computeSavingThrowAdvDis(roll.stat ?? "DEX", { conditions: player?.conditions });
        genericRollMeta = rollNatWithAdvDis(advResIn.adv, advResIn.dis);
        genericRollMeta.advDisDetail = advResIn.label;
        return genericRollMeta.nat;
      }
      if (roll.kind === "check" || roll.kind === "save") {
        const advResGen = resolvePendingRollAdvDis(roll, player);
        genericRollMeta = rollNatWithAdvDis(advResGen.adv, advResGen.dis);
        genericRollMeta.advDisDetail = advResGen.label;
        return genericRollMeta.nat;
      }
      const d = rollDiceDetailed(notation);
      return d.total;
    })();
    const nat = Math.trunc(rolledNat);
    if (debugNextRoll !== null) setDebugNextRoll(null);
    const bonusForCheck =
      roll.kind === "check" &&
      (roll.audience === "global" || roll.audience === "selected") &&
      player
        ? computeCheckBonus({ player, stat: roll.stat, skill: roll.skill })
        : roll.totalBonus;
    const total = nat + bonusForCheck;
    const bonus = fmtMod(bonusForCheck);

    const dc = typeof roll.dc === "number" ? roll.dc : null;
    const success = dc != null ? total >= dc : null;

    let content;
    const publicTitle = getPublicPendingRollTitle(roll);
    if (nat === 20) {
      content = `ðŸŽ² ${publicTitle} â€” Nat **20** ðŸ’¥ COUP CRITIQUE !`;
    } else if (nat === 1) {
      content = `ðŸŽ² ${publicTitle} â€” Nat **1** ðŸ’€ FUMBLE CRITIQUE !`;
    } else if (dc != null) {
      content = `ðŸŽ² ${publicTitle} â€” Nat ${nat} ${bonus} = **${total}** vs DD ${dc}`;
    } else {
      content = `ðŸŽ² ${publicTitle} â€” Nat ${nat} ${bonus} = **${total}**`;
    }

    const advSuffixGeneric = formatAdvDisSuffixForD20(genericRollMeta);
    if (advSuffixGeneric) {
      content = `${content}${advSuffixGeneric}`;
    }

    const engineContext = roll?.engineContext && typeof roll.engineContext === "object"
      ? roll.engineContext
      : null;
    if (engineContext?.kind === "incoming_spell_save") {
      const dmgNotation = String(engineContext.damageNotation ?? "1d6");
      const r = rollDiceDetailed(dmgNotation);
      const baseDmg = Math.max(0, r.total);
      const finalDmg = success ? Math.floor(baseDmg / 2) : baseDmg;
      const hpBefore = playerHpRef.current;
      const damageResult = finalDmg > 0 ? applyDamageToPlayer(finalDmg, { critical: false }) : null;
      const hpAfter = damageResult ? damageResult.hpAfter : hpBefore;

      pendingRollRef.current = null;
      setPendingRoll(null);

      addMessage(
        "ai",
        `${content}\n${
          success ? "✔ Réussite — dégâts réduits." : "✖ Échec — dégâts complets."
        } ${finalDmg > 0 ? `${formatDiceNotationDetail(r, dmgNotation)} = **${finalDmg} dégâts ${engineContext.damageType ?? ""}**.` : "Aucun dégât."}`,
        "combat-detail",
        makeMsgId()
      );
      addMessage(
        "ai",
        `[DEBUG] Résolution sauvegarde joueur (moteur)\n` +
          safeJson({
            attackerId: engineContext.attackerId ?? null,
            attackerName: engineContext.attackerName ?? null,
            spellName: engineContext.spellName ?? roll.weaponName ?? null,
            nat,
            total,
            dc,
            success,
            damage: finalDmg,
            hpBefore,
            hpAfter,
            slotLevelUsed: engineContext.slotLevelUsed ?? null,
            tacticalThought: engineContext.tacticalThought ?? "",
            tacticalAction: engineContext.tacticalAction ?? null,
          }),
        "debug",
        makeMsgId()
      );
      return;
    }

    // Révélation côté moteur : par ex. Perception qui dépasse le stealthDc d'entités cachées
    let revealUpdates = [];
    const rollSkillNorm = normalizeSkillName(roll.skill);
    if (roll.kind === "check" && rollSkillNorm === "Perception") {
      for (const e of entities) {
        if (!e.visible && e.isAlive && typeof e.stealthDc === "number" && total >= e.stealthDc) {
          revealUpdates.push({ id: e.id, action: "update", visible: true });
        }
      }
    }

    /** En combat : Perception active vs total de Discrétion des adversaires cachés (moteur). */
    if (
      roll.kind === "check" &&
      rollSkillNorm === "Perception" &&
      (gameStateRef.current?.gameMode ?? gameMode) === "combat"
    ) {
      const observerId = localCombatantId;
      const obsSide = controllerForCombatantId(observerId);
      const hiddenIds = combatHiddenIds ?? [];
      const stealthMap = combatStealthTotalByCombatantId ?? {};
      const combatStealthRevealedIds = [];
      for (const hid of hiddenIds) {
        if (!hid || hid === observerId) continue;
        if (controllerForCombatantId(hid) === obsSide) continue;
        const dd = stealthMap[hid];
        if (typeof dd !== "number" || !Number.isFinite(dd)) continue;
        if (total >= dd) combatStealthRevealedIds.push(hid);
      }
      if (combatStealthRevealedIds.length) {
        const ddSnapshot = combatStealthRevealedIds.map((hid) => stealthMap[hid]);
        for (const hid of combatStealthRevealedIds) {
          setCombatStealthTotalForCombatant(hid, null);
        }
        setCombatHiddenIds((prev) => prev.filter((id) => !combatStealthRevealedIds.includes(id)));
        if (combatStealthRevealedIds.length === 1) {
          content = `${content}\n\n👁️ **Perception active** : vous repérez une créature cachée (jet ≥ **${ddSnapshot[0]}** au total de Discrétion).`;
        } else {
          content = `${content}\n\n👁️ **Perception active** : vous repérez **${combatStealthRevealedIds.length}** créatures cachées (jets ≥ Discrétion : ${ddSnapshot.join(", ")}).`;
        }
      }
    }

    /** En combat : jet Discrétion (ex. « je me cache » / arbitre) → même état caché que `performCombatHideRoll`. */
    if (
      roll.kind === "check" &&
      rollSkillNorm === "Stealth" &&
      (gameStateRef.current?.gameMode ?? gameMode) === "combat"
    ) {
      const co = gameStateRef.current?.combatOrder ?? combatOrder;
      const idxLive = combatTurnIndexLiveRef.current;
      const len = Array.isArray(co) ? co.length : 0;
      const activeId =
        len > 0 ? co[Math.min(Math.max(0, idxLive), len - 1)]?.id : null;
      if (activeId && isLocalPlayerCombatantId(activeId)) {
        const hiddenIdForState = isLocalPlayerCombatantId(activeId) ? localCombatantId : activeId;
        const inMelee = (getMeleeWith(activeId) ?? []).length > 0;
        if (success === true && !inMelee) {
          setCombatHiddenIds((prev) => [...new Set([...prev, hiddenIdForState])]);
          setCombatStealthTotalForCombatant(hiddenIdForState, total);
          content = `${content}\n\n🥷 **Caché** — ce total sert de **DD** jusqu’à découverte (Perception active adverse ≥ **${total}**).`;
          if (multiplayerSessionId) {
            await new Promise((r) => setTimeout(r, 0));
            await flushMultiplayerSharedState();
          }
        } else if (success === true && inMelee) {
          content = `${content}\n\n🚫 Vous restez **repéré** : impossible d’être caché au **corps à corps** d’une autre créature.`;
        } else if (success === false) {
          setCombatHiddenIds((prev) => prev.filter((id) => id !== hiddenIdForState));
          setCombatStealthTotalForCombatant(hiddenIdForState, null);
          if (String(hiddenIdForState).trim() !== "player") {
            setCombatStealthTotalForCombatant("player", null);
          }
          if (multiplayerSessionId) {
            await new Promise((r) => setTimeout(r, 0));
            await flushMultiplayerSharedState();
          }
        }
      }
    }

    const extraUpdates = [];

    // Stabilisation (Médecine) sur une autre créature à 0 PV : appliquer l'état stable + réveil naturel.
    // Sans cela, un jet de Médecine "réussi" ne changeait rien et attendre ne pouvait jamais rendre 1 PV à un allié.
    if (roll.kind === "check" && rollSkillNorm === "Medicine") {
      let tid = String(roll.targetId ?? "").trim();
      if (!tid) {
        const latestUserText =
          Array.isArray(messagesRef.current)
            ? [...messagesRef.current]
                .reverse()
                .find((m) => m?.role === "user" && String(m?.content ?? "").trim())
                ?.content ?? ""
            : "";
        const probeText = normalizeFr(
          `${String(latestUserText ?? "")} ${String(roll?.raison ?? "")}`.trim()
        );
        const downedLocal = (Array.isArray(entities) ? entities : []).filter((e) => {
          if (!e || String(e.type ?? "").toLowerCase() === "hostile") return false;
          const hp = typeof e?.hp?.current === "number" && Number.isFinite(e.hp.current) ? Math.trunc(e.hp.current) : null;
          return hp != null && hp <= 0;
        });
        const byLocalName =
          downedLocal.find((e) => {
            const n = normalizeFr(String(e?.name ?? ""));
            return !!n && (probeText.includes(n) || n.includes(probeText));
          }) ?? null;
        if (byLocalName?.id) {
          tid = String(byLocalName.id).trim();
        } else if (downedLocal.length === 1 && downedLocal[0]?.id) {
          // Cas fréquent post-combat : un seul allié à terre, mais roll.targetId absent.
          tid = String(downedLocal[0].id).trim();
        } else if (Array.isArray(multiplayerParticipantProfiles)) {
          const downedMp = multiplayerParticipantProfiles
            .map((p) => {
              const cid = String(p?.clientId ?? "").trim();
              const hp =
                typeof p?.hpCurrent === "number" && Number.isFinite(p.hpCurrent)
                  ? Math.trunc(p.hpCurrent)
                  : typeof p?.playerSnapshot?.hp?.current === "number" &&
                      Number.isFinite(p.playerSnapshot.hp.current)
                    ? Math.trunc(p.playerSnapshot.hp.current)
                    : null;
              const name = String(p?.name ?? p?.playerSnapshot?.name ?? "").trim();
              return { cid, hp, name };
            })
            .filter((x) => x.cid && x.hp != null && x.hp <= 0);
          const byMpName =
            downedMp.find((x) => {
              const n = normalizeFr(x.name);
              return !!n && (probeText.includes(n) || n.includes(probeText));
            }) ?? null;
          if (byMpName?.cid) {
            tid = `mp-player-${byMpName.cid}`;
          } else if (downedMp.length === 1) {
            tid = `mp-player-${downedMp[0].cid}`;
          }
        }
      }
      if (tid) {
        const target = (Array.isArray(entities) ? entities : []).find((e) => String(e?.id ?? "").trim() === tid);
        const mpTargetCid = tid.startsWith("mp-player-") ? tid.slice("mp-player-".length).trim() : "";
        const mpTargetProfile =
          mpTargetCid && Array.isArray(multiplayerParticipantProfiles)
            ? multiplayerParticipantProfiles.find(
                (p) => String(p?.clientId ?? "").trim() === mpTargetCid
              ) ?? null
            : null;
        const hpT = typeof target?.hp?.current === "number" ? target.hp.current : null;
        const hpMp =
          typeof mpTargetProfile?.hpCurrent === "number" && Number.isFinite(mpTargetProfile.hpCurrent)
            ? Math.trunc(mpTargetProfile.hpCurrent)
            : typeof mpTargetProfile?.playerSnapshot?.hp?.current === "number" &&
                Number.isFinite(mpTargetProfile.playerSnapshot.hp.current)
              ? Math.trunc(mpTargetProfile.playerSnapshot.hp.current)
              : null;
        const isDownButAlive = target && hpT != null && hpT <= 0 && target.isAlive !== false;
        const isMpDownButAlive = !!mpTargetProfile && hpMp != null && hpMp <= 0;
        const alreadyStable = !!(target?.deathState && typeof target.deathState === "object" && target.deathState.stable === true);
        const mpAlreadyStable = !!(
          mpTargetProfile?.playerSnapshot?.deathState &&
          typeof mpTargetProfile.playerSnapshot.deathState === "object" &&
          mpTargetProfile.playerSnapshot.deathState.stable === true
        );
        const dcMed = typeof dc === "number" ? dc : 10;
        const medSuccess = typeof success === "boolean" ? success : (Number.isFinite(total) ? total >= dcMed : false);
        if (isDownButAlive && !alreadyStable) {
          if (medSuccess) {
            const stableHours = rollDice("1d4");
            const autoRecoverAtMinute = worldTimeMinutes + stableHours * 60;
            extraUpdates.push({
              action: "update",
              id: tid,
              deathState: {
                ...(target.deathState && typeof target.deathState === "object" ? target.deathState : {}),
                unconscious: true,
                stable: true,
                dead: false,
                autoRecoverAtMinute,
              },
            });
            addMessage(
              "ai",
              `**${target.name ?? "Allié"}** est stabilisé(e) à **0 PV**. Reprise naturelle : **1 PV** après **${stableHours}** h de repos en jeu.`,
              "meta",
              makeMsgId()
            );
            addMessage(
              "ai",
              `[DEBUG][STABILIZE_APPLY][LOCAL] ${target.name ?? tid} => ` +
                safeJson({
                  targetId: tid,
                  hpCurrent: 0,
                  deathState: {
                    ...(target.deathState && typeof target.deathState === "object" ? target.deathState : {}),
                    unconscious: true,
                    stable: true,
                    dead: false,
                    autoRecoverAtMinute,
                  },
                  worldTimeMinutes,
                }),
              "debug",
              makeMsgId()
            );
          } else {
            addMessage(
              "ai",
              `La tentative de stabilisation échoue : **${target.name ?? "l'allié"}** reste inconscient(e) à **0 PV**.`,
              "meta",
              makeMsgId()
            );
          }
        }
        if (isMpDownButAlive && !mpAlreadyStable) {
          if (medSuccess) {
            const stableHours = rollDice("1d4");
            const autoRecoverAtMinute = worldTimeMinutes + stableHours * 60;
            const appliedDeathStatePatch = {
              unconscious: true,
              stable: true,
              dead: false,
              autoRecoverAtMinute,
            };
            await patchParticipantProfileDeathState(
              mpTargetCid,
              appliedDeathStatePatch,
              { hpCurrent: 0 }
            );
            mpParticipantStateOverrideRef.current.set(mpTargetCid, {
              hpCurrent: 0,
              deathState: appliedDeathStatePatch,
              updatedAtMs: Date.now(),
            });
            // Évite une fenêtre stale entre l'update Firestore et le prochain parse-intent :
            // on applique immédiatement le patch dans la ref locale source-de-vérité.
            const currentProfiles = Array.isArray(multiplayerParticipantProfilesRef.current)
              ? multiplayerParticipantProfilesRef.current
              : [];
            multiplayerParticipantProfilesRef.current = currentProfiles.map((p) => {
              if (String(p?.clientId ?? "").trim() !== mpTargetCid) return p;
              const snap =
                p?.playerSnapshot && typeof p.playerSnapshot === "object" ? p.playerSnapshot : {};
              const snapDs =
                snap?.deathState && typeof snap.deathState === "object" ? snap.deathState : {};
              return {
                ...p,
                hpCurrent: 0,
                playerSnapshot: {
                  ...snap,
                  hp:
                    snap?.hp && typeof snap.hp === "object"
                      ? { ...snap.hp, current: 0 }
                      : snap?.hp,
                  deathState: {
                    ...snapDs,
                    ...appliedDeathStatePatch,
                  },
                },
              };
            });
            if (multiplayerSessionId) {
              try {
                await flushMultiplayerSharedState();
              } catch {
                /* quota / réseau */
              }
            }
            const n = String(mpTargetProfile?.name ?? mpTargetProfile?.playerSnapshot?.name ?? "Allié").trim() || "Allié";
            addMessage(
              "ai",
              `**${n}** est stabilisé(e) à **0 PV**. Reprise naturelle : **1 PV** après **${stableHours}** h de repos en jeu.`,
              "meta",
              makeMsgId()
            );
            addMessage(
              "ai",
              `[DEBUG][STABILIZE_APPLY][MP] ${n} => ` +
                safeJson({
                  targetId: tid,
                  participantClientId: mpTargetCid,
                  hpCurrent: 0,
                  deathStatePatch: appliedDeathStatePatch,
                  worldTimeMinutes,
                }),
              "debug",
              makeMsgId()
            );
            const liveProfileAfter =
              (Array.isArray(multiplayerParticipantProfilesRef.current)
                ? multiplayerParticipantProfilesRef.current.find(
                    (p) => String(p?.clientId ?? "").trim() === String(mpTargetCid ?? "").trim()
                  ) ?? null
                : null) ?? null;
            const liveProfileSnap =
              liveProfileAfter?.playerSnapshot && typeof liveProfileAfter.playerSnapshot === "object"
                ? liveProfileAfter.playerSnapshot
                : null;
            const liveEntityAfter =
              (Array.isArray(gameStateRef.current?.entities)
                ? gameStateRef.current.entities.find((e) => String(e?.id ?? "").trim() === String(tid ?? "").trim()) ?? null
                : null) ?? null;
            addMessage(
              "ai",
              `[DEBUG][STABILIZE_APPLY][MP_FULL_STATE] ${n}\n` +
                safeJson({
                  targetId: tid,
                  participantClientId: mpTargetCid,
                  worldTimeMinutes,
                  profile: liveProfileAfter
                    ? {
                        clientId: liveProfileAfter.clientId ?? null,
                        hpCurrent: liveProfileAfter.hpCurrent ?? null,
                        hpMax: liveProfileAfter.hpMax ?? null,
                        deathState: liveProfileSnap?.deathState ?? null,
                        snapshotHp: liveProfileSnap?.hp ?? null,
                      }
                    : null,
                  entityInGameState: liveEntityAfter
                    ? {
                        id: liveEntityAfter.id ?? null,
                        hp: liveEntityAfter.hp ?? null,
                        deathState: liveEntityAfter.deathState ?? null,
                        isAlive: liveEntityAfter.isAlive ?? null,
                      }
                    : null,
                  overrideState: mpParticipantStateOverrideRef.current.get(String(mpTargetCid ?? "").trim()) ?? null,
                }),
              "debug",
              makeMsgId()
            );
          } else {
            const n = String(mpTargetProfile?.name ?? mpTargetProfile?.playerSnapshot?.name ?? "l'allié").trim() || "l'allié";
            addMessage(
              "ai",
              `La tentative de stabilisation échoue : **${n}** reste inconscient(e) à **0 PV**.`,
              "meta",
              makeMsgId()
            );
          }
        }
      }
    }

    const allUpdates = [...revealUpdates, ...extraUpdates];
    let nextEntities = allUpdates.length ? applyUpdatesLocally(entities, allUpdates) : entities;
    if (allUpdates.length) applyEntityUpdates(allUpdates);

    const nextRoomId = currentRoomId;
    const nextScene = currentScene;
    const nextSceneName = currentSceneName;
    ensureCombatState(nextEntities);

    if (
      roll.returnToArbiter === true &&
      roll.sceneArbiterContext &&
      typeof roll.sceneArbiterContext === "object"
    ) {
      const ctx = roll.sceneArbiterContext;
      const isGlobalGroup =
        roll.kind === "check" && (roll.audience === "global" || roll.audience === "selected");
      if (isGlobalGroup) {
        const myCid = String(clientId ?? "").trim();
        const prevMap =
          roll.globalRollsByClientId && typeof roll.globalRollsByClientId === "object"
            ? { ...roll.globalRollsByClientId }
            : {};
        if (myCid) {
          prevMap[myCid] = {
            nat,
            total,
            success,
            playerName: player?.name != null ? String(player.name).trim() : null,
          };
        }
        const expected = getGroupSkillCheckExpectedClientIds(
          multiplayerSessionId,
          multiplayerParticipantProfilesRef.current,
          clientId,
          roll
        );
        const allDone = expected.length > 0 && expected.every((eid) => prevMap[eid] != null);
        const diceMsgId = makeMsgId();
        addMessage("ai", content, "dice", diceMsgId);
        messagesRef.current = [
          ...messagesRef.current,
          { id: diceMsgId, role: "ai", content, type: "dice" },
        ];
        if (!allDone) {
          const nextPending = { ...roll, globalRollsByClientId: prevMap };
          pendingRollRef.current = nextPending;
          setPendingRoll(nextPending);
          if (multiplayerSessionId) {
            await new Promise((r) => setTimeout(r, 0));
            await flushMultiplayerSharedState();
          }
          return;
        }
        if (multiplayerSessionId) {
          pendingRollRef.current = { ...roll, globalRollsByClientId: prevMap };
          setPendingRoll(pendingRollRef.current);
          await new Promise((r) => setTimeout(r, 0));
          await flushMultiplayerSharedState();
          return;
        }
        pendingRollRef.current = null;
        setPendingRoll(null);
        const rollOutcome = buildGlobalPlayerCheckGroupRollOutcome({
          roll,
          globalRollsByClientId: prevMap,
          dc,
        });
        const skillLabelGroup = roll.skill ? `${roll.skill} (groupe)` : roll.stat;
        try {
          const resolved = await runSceneEntryGmArbiter({
            roomId: ctx.roomId,
            scene: ctx.scene,
            sceneName: ctx.sceneName,
            entitiesAtEntry: nextEntities,
            sourceAction: ctx.sourceAction,
            baseGameMode: ctx.baseGameMode ?? gameMode,
            rollResultOverride: rollOutcome,
            intentDecision: ctx.intentDecision ?? null,
            arbiterTrigger: ctx.arbiterTrigger ?? null,
          });
          if (resolved?.awaitingPlayerRoll === true) {
            return;
          }
          const gmMode = gameStateRef.current?.gameMode ?? gameMode;
          const enrichedEngineEvent =
            resolved.engineEvent && typeof resolved.engineEvent === "object"
              ? {
                  ...resolved.engineEvent,
                  playerSkillRoll: {
                    skillLabel: skillLabelGroup,
                    group: true,
                    summary: rollOutcome.summary,
                    byClientId: rollOutcome.byClientId,
                  },
                }
              : {
                  kind: "scene_rule_resolution",
                  reason: resolved?.reason ?? null,
                  playerSkillRoll: {
                    skillLabel: skillLabelGroup,
                    group: true,
                    summary: rollOutcome.summary,
                    byClientId: rollOutcome.byClientId,
                  },
                };
          if (ctx.narrateAfterResolution !== false) {
            await callApi(ctx.sourceAction ?? "", "meta", false, {
              skipSessionLock: true,
              hideUserMessage: true,
              bypassIntentParser: true,
              skipAutoPlayerTurn: true,
              skipGmContinue: true,
              entities: resolved.nextEntities,
              currentRoomId: resolved.nextRoomId,
              currentScene: resolved.nextScene,
              currentSceneName: resolved.nextSceneName,
              gameMode: resolved.nextGameMode ?? gmMode,
              engineEvent: enrichedEngineEvent,
            });
          } else {
            const visibleReason = String(enrichedEngineEvent?.reason ?? "").trim();
            if (debugMode && visibleReason) {
              addMessage("ai", visibleReason, "meta-reply", makeMsgId());
            }
          }
        } catch (e) {
          addMessage(
            "ai",
            `[DEBUG] Erreur GM Arbitre après jet joueur : ${String(e?.message ?? e)}`,
            "debug",
            makeMsgId()
          );
        }
        return;
      }

      pendingRollRef.current = null;
      setPendingRoll(null);
      const rollOutcome = {
        notation: "1d20",
        total,
        rolls: [nat],
        nat,
        dc,
        success,
        stat: roll.stat ?? null,
        skill: roll.skill ?? null,
      };
      const skillLabel = roll.skill ? `${roll.skill}` : roll.stat;
      const diceMsgId = makeMsgId();
      addMessage("ai", content, "dice", diceMsgId);
      messagesRef.current = [
        ...messagesRef.current,
        { id: diceMsgId, role: "ai", content, type: "dice" },
      ];
      try {
        const resolved = await runSceneEntryGmArbiter({
          roomId: ctx.roomId,
          scene: ctx.scene,
          sceneName: ctx.sceneName,
          entitiesAtEntry: nextEntities,
          sourceAction: ctx.sourceAction,
          baseGameMode: ctx.baseGameMode ?? gameMode,
          rollResultOverride: rollOutcome,
          intentDecision: ctx.intentDecision ?? null,
          arbiterTrigger: ctx.arbiterTrigger ?? null,
        });
        if (resolved?.awaitingPlayerRoll === true) {
          return;
        }
        const gmMode = gameStateRef.current?.gameMode ?? gameMode;
        const enrichedEngineEvent =
          resolved.engineEvent && typeof resolved.engineEvent === "object"
            ? {
                ...resolved.engineEvent,
                playerSkillRoll: {
                  skillLabel,
                  nat,
                  total,
                  dc,
                  success,
                },
              }
            : {
                kind: "scene_rule_resolution",
                reason: resolved?.reason ?? null,
                playerSkillRoll: {
                  skillLabel,
                  nat,
                  total,
                  dc,
                  success,
                },
              };
        if (ctx.narrateAfterResolution !== false) {
          await callApi(ctx.sourceAction ?? "", "meta", false, {
            skipSessionLock: true,
            hideUserMessage: true,
            bypassIntentParser: true,
            skipAutoPlayerTurn: true,
            skipGmContinue: true,
            entities: resolved.nextEntities,
            currentRoomId: resolved.nextRoomId,
            currentScene: resolved.nextScene,
            currentSceneName: resolved.nextSceneName,
            gameMode: resolved.nextGameMode ?? gmMode,
            engineEvent: enrichedEngineEvent,
          });
        } else {
          const visibleReason = String(enrichedEngineEvent?.reason ?? "").trim();
          if (debugMode && visibleReason) {
            addMessage("ai", visibleReason, "meta-reply", makeMsgId());
          }
        }
      } catch (e) {
        addMessage(
          "ai",
          `[DEBUG] Erreur GM Arbitre après jet joueur : ${String(e?.message ?? e)}`,
          "debug",
          makeMsgId()
        );
      }
      return;
    }

    pendingRollRef.current = null;
    setPendingRoll(null);
    await callApi(content, "dice", false, {
      skipSessionLock: true,
      skipAutoPlayerTurn: true,
      entities: nextEntities,
      currentRoomId: nextRoomId,
      currentScene: nextScene,
      currentSceneName: nextSceneName,
      gameMode,
      engineEvent: {
        kind: "skill_resolution",
        skill: roll.skill ?? roll.stat,
        stat: roll.stat ?? null,
        total,
        dc,
        success,
        targetId: roll.targetId ?? null,
        revealedEntityIds: revealUpdates.length ? revealUpdates.map((u) => u.id) : null,
      },
    });
    } finally {
      if (pendingRollRef.current) {
        unhideRollBannerIfSame();
      }
      rollResolutionInProgressRef.current = false;
      setIsTyping(false);
      if (multiplayerSessionId && mpGmThinkingOwnedByThisRoll) {
        try {
          await setMultiplayerThinkingState({
            active: false,
            actor: null,
            label: null,
          });
        } catch {
          /* ignore */
        }
      }
      await releaseMultiplayerProcessingLock(sessionLockId);
      if (multiplayerSessionId) {
        try {
          await flushMultiplayerSharedState();
        } catch {
          /* ignore */
        }
      }
      if (rollSkipRemotePendingClearTimerRef.current != null) {
        clearTimeout(rollSkipRemotePendingClearTimerRef.current);
        rollSkipRemotePendingClearTimerRef.current = null;
      }
      rollSkipRemotePendingClearTimerRef.current = setTimeout(() => {
        rollSkipRemotePendingClearTimerRef.current = null;
        skipRemotePendingRollApplyRef.current = false;
      }, 900);
    }
  }

  async function handleDebugSend() {
    const trimmed = debugInput.trim();
    if (!trimmed || isTyping) return;

    const debugPartyPcs =
      multiplayerSessionId && Array.isArray(multiplayerParticipantProfiles)
        ? multiplayerParticipantProfiles
            .filter((prof) => prof && prof.connected !== false)
            .map((prof) => {
              const cid = String(prof?.clientId ?? "").trim();
              if (!cid) return null;
              const pid = `mp-player-${cid}`;
              const isLocal = String(clientId ?? "").trim() === cid;
              const hpCurrent = isLocal
                ? typeof player?.hp?.current === "number"
                  ? player.hp.current
                  : null
                : typeof prof?.hpCurrent === "number"
                  ? prof.hpCurrent
                  : null;
              const hpMax = isLocal
                ? typeof player?.hp?.max === "number"
                  ? player.hp.max
                  : null
                : typeof prof?.hpMax === "number"
                  ? prof.hpMax
                  : null;
              return {
                combatantId: pid,
                clientId: cid,
                name: String(isLocal ? player?.name ?? prof?.name ?? "Joueur" : prof?.name ?? "Joueur").trim() || "Joueur",
                hpCurrent,
                hpMax,
                ac:
                  isLocal && typeof player?.ac === "number"
                    ? player.ac
                    : typeof prof?.ac === "number"
                      ? prof.ac
                      : null,
                isLocal,
              };
            })
            .filter(Boolean)
        : [];

    const requestBody = {
      command: trimmed,
      provider: aiProvider === "openrouter" ? "openrouter" : "gemini",
      debugMode: debugMode === true,
      currentRoomId,
      currentScene,
      currentSceneName,
      currentRoomMemory: getRoomMemory(currentRoomId),
      gameMode,
      player,
      entities,
      messages,
      combatOrder,
      combatTurnIndex,
      partyPcs: debugPartyPcs,
    };

    setDebugInput("");
    setIsTyping(true);
    setError(null);
    try {
      const { res, data } = await fetchJsonWithTimeout(
        "/api/debug-godmode",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        },
        PARSE_INTENT_TIMEOUT_MS,
        "debug-godmode"
      );

      if (!res.ok) {
        throw new Error(String(data?.details ?? data?.error ?? `Erreur HTTP ${res.status}`));
      }

      await applyGodmodeResponse(data, trimmed);
    } catch (e) {
      const msg = String(e?.message ?? e);
      setError(msg);
      addMessage("ai", `[DEBUG] Erreur godmode : ${msg}`, "debug", makeMsgId());
    } finally {
      setIsTyping(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }
  function handleDebugKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleDebugSend(); }
  }

  const isInCombat = gameMode === "combat";
  const coUi = gameStateRef.current?.combatOrder ?? combatOrder;
  const hasOrder = isInCombat && coUi.length > 0;
  const activeEntry = hasOrder ? coUi[clampedCombatTurnIndex()] : null;
  // Même règle que `page.tsx` (activeCombatantId) : index depuis le state partagé, pas seulement la ref live
  // (évite décalage UI initiative vs saisie après sync MP / fin de tour).
  const orderForTurnGate = Array.isArray(combatOrder) && combatOrder.length > 0 ? combatOrder : coUi;
  const safeTurnIdx =
    hasOrder && orderForTurnGate.length > 0
      ? Math.min(Math.max(0, combatTurnIndex), orderForTurnGate.length - 1)
      : 0;
  const activeIdForTurnGate = hasOrder ? orderForTurnGate[safeTurnIdx]?.id ?? null : null;
  // En combat : pas de message tant qu'il n'y a pas d'ordre, qu'on attend l'initiative du joueur, ou que ce n'est pas le tour du PJ.
  const isMyTurn =
    !isInCombat ||
    (awaitingPlayerInitiative
      ? false
      : !hasOrder
        ? false
        : isLocalPlayerCombatantId(activeIdForTurnGate));
  // Bandeau jaune « Jet requis » : bloquer saisie (humain + cohérence avec l’auto-joueur)
  const playerDeadOrOver =
    isGameOver || (typeof player?.hp?.current === "number" && player.hp.current <= 0);
  // Multijoueur : bloquer saisie si MJ ou autre client réserve l’auto-joueur ; ce client peut
  // toujours envoyer pour préempter sa propre réservation (fire-and-forget annule l’auto dans handleSend).
  const mpThisClientAutoIntentHeld =
    !!multiplayerSessionId &&
    multiplayerThinkingState.active === true &&
    multiplayerThinkingState.actor === "auto-player" &&
    String(multiplayerThinkingState.byClientId ?? "").trim() === String(clientId ?? "").trim();
  const isEngineResolving =
    multiplayerSessionId
      ? (!!multiplayerPendingCommand?.id ||
          isTyping ||
          (multiplayerThinkingState.active === true && !mpThisClientAutoIntentHeld))
      : isTyping;
  // "Le MJ réfléchit…" ne doit apparaître que quand le moteur est réellement en train de résoudre.
  // Si un joueur est attendu (tour joueur / jet requis / initiative), on masque cet indicateur.
  const activeControllerForTurn =
    activeIdForTurnGate != null
      ? controllerForCombatantId(activeIdForTurnGate, gameStateRef.current?.entities ?? entities)
      : null;
  const groupSkillAllRollsRecorded = isGlobalOrSelectedGroupSkillAllRollsRecorded(
    pendingRoll,
    multiplayerSessionId,
    multiplayerParticipantProfiles,
    clientId
  );
  const isAnyPlayerExpectedToAct =
    (!!pendingRoll && !groupSkillAllRollsRecorded) ||
    awaitingPlayerInitiative ||
    (isInCombat && hasOrder && activeControllerForTurn === "player");
  const showGmThinkingIndicator = multiplayerSessionId
    ? multiplayerThinkingState.active &&
      multiplayerThinkingState.actor === "gm" &&
      (!isAnyPlayerExpectedToAct || !!multiplayerPendingCommand?.id)
    : isTyping;
  const inputBlocked =
    isEngineResolving ||
    sceneEnteredPipelineDepthRef.current > 0 ||
    retryCountdown > 0 ||
    flowBlocked ||
    (!!pendingRoll && !groupSkillAllRollsRecorded) ||
    awaitingPlayerInitiative ||
    !isMyTurn ||
    playerDeadOrOver;

  // ---------------------------------------------------------------------------
  // Rendu
  // ---------------------------------------------------------------------------
  return (
    <div className="flex flex-col h-full">

      {/* Modal Repos court â€” Restauration arcanique */}
      {arcaneRecoveryOpen && player?.entityClass === "Magicien" && (
        <div
          className="fixed inset-0 z-[90] bg-black/70 flex items-center justify-center p-4"
          onClick={() => setArcaneRecoveryOpen(false)}
        >
          <div
            className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-700 px-5 py-3">
              <div>
                <p className="text-sm font-bold text-slate-100">
                  {repairMojibakeForDisplay("Repos court — Restauration arcanique")}
                </p>
                <p className="text-[11px] text-slate-400">
                  {`Budget: ${arcaneRecoveryBudget} (≤ moitié niveau, arrondi sup). Interdit de récupérer des emplacements ≥ niv 6.`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setArcaneRecoveryOpen(false)}
                className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-3">
              {arcaneRecoveryUsed ? (
                <p className="text-sm text-amber-300">
                  Restauration arcanique déjà utilisée aujourd'hui (1/jour).
                </p>
              ) : (
                <>
                  <p className="text-xs text-slate-300">
                    Choisis combien d'emplacements récupérer par niveau (1 à 5). Le total dépensé ne doit pas dépasser le budget.
                    {" "}
                    <span className="text-slate-400">Dépensé: {arcaneRecoveryPlannedSpend}/{arcaneRecoveryBudget} (reste {arcaneRecoveryBudgetLeft}).</span>
                  </p>
                  {arcaneRecoveryRecoverableEntries.length === 0 ? (
                    <p className="text-xs text-slate-400">
                      Aucun emplacement de sort (niveaux 1 à 5) n'est dépensé actuellement.
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {arcaneRecoveryRecoverableEntries.map((entry) => {
                      const { lvl, max, remaining, missing, value } = entry;
                      const maxSelectable = Math.min(missing, arcaneRecoveryBudgetLeft + value);
                      return (
                        <div key={`ar-${lvl}`} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-slate-200">Emplacements niv {lvl}</span>
                            <span className="text-[11px] text-slate-400 tabular-nums">
                              {remaining}/{max} (manque {missing})
                            </span>
                          </div>
                          <div className="mt-2 flex items-center gap-2">
                            <input
                              type="range"
                              min={0}
                              max={Math.max(0, maxSelectable)}
                              value={value}
                              onChange={(e) =>
                                setArcaneRecoveryPick((prev) => ({
                                  ...(prev ?? {}),
                                  [lvl]: Number(e.target.value) || 0,
                                }))
                              }
                              className="w-full accent-emerald-500"
                            />
                            <span className="w-8 text-right text-sm tabular-nums text-slate-100">{value}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  )}
                </>
              )}
            </div>

            <div className="border-t border-slate-700 px-5 py-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setArcaneRecoveryOpen(false)}
                className="rounded-md border border-slate-600 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800"
              >
                Annuler
              </button>
              <button
                type="button"
                disabled={arcaneRecoveryUsed || arcaneRecoveryPlannedSpend <= 0}
                onClick={() => {
                  const ok = applyArcaneRecovery();
                  if (ok) {
                    setArcaneRecoveryOpen(false);
                    setArcaneRecoveryPick({});
                  }
                }}
                className="rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Récupérer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* En-tête */}
      <div className="flex items-center justify-between border-b border-slate-700 px-4 py-2 shrink-0 gap-3">
        <span className="text-xs font-semibold uppercase tracking-widest text-slate-500 shrink-0">
          Journal de Jeu
        </span>

        {/* Toggles IA (MJ, images, auto-joueur) */}
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-md border border-slate-600 bg-slate-800/60 p-0.5 text-xs gap-0.5">
            <button
              onClick={() => setAiProvider("gemini")}
              className={`rounded px-2.5 py-1 font-medium transition-colors ${aiProvider === "gemini" ? "bg-blue-600 text-white shadow" : "text-slate-400 hover:text-slate-200"}`}
            >
              {repairMojibakeForDisplay("âœ¦ Gemini")}
            </button>
            <button
              onClick={() => setAiProvider("openrouter")}
              className={`rounded px-2.5 py-1 font-medium transition-colors ${aiProvider === "openrouter" ? "bg-purple-600 text-white shadow" : "text-slate-400 hover:text-slate-200"}`}
            >
              {repairMojibakeForDisplay("â¬¡ OpenRouter")}
            </button>
          </div>

          {/* Toggle génération d'image */}
          <button
            type="button"
            onClick={() =>
              setImageModel(
                imageModel === "gemini-3.1-flash-image-preview"
                  ? "disabled"
                  : "gemini-3.1-flash-image-preview"
              )
            }
            className={`flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              imageModel === "gemini-3.1-flash-image-preview"
                ? "border-indigo-500 bg-indigo-900/60 text-indigo-200 shadow"
                : "border-slate-700 bg-slate-900/60 text-slate-400 hover:border-slate-500 hover:text-slate-100"
            }`}
            title="Active ou désactive la génération d'image de scène via Gemini."
          >
            <span>{imageModel === "gemini-3.1-flash-image-preview" ? "Image ON" : "Image OFF"}</span>
          </button>

          {/* Toggle auto roll */}
          <button
            type="button"
            onClick={() => setAutoRollEnabled(!autoRollEnabled)}
            className={`flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              autoRollEnabled
                ? "border-sky-500 bg-sky-900/60 text-sky-200 shadow"
                : "border-slate-700 bg-slate-900/60 text-slate-400 hover:border-slate-500 hover:text-slate-100"
            }`}
            title="Lance automatiquement les jets d'attaque, sauvegardes, compétences, etc. Les jets de dégâts après un toucher restent manuels (bouton « Lancer le dé »)."
          >
            <span>{autoRollEnabled ? "Auto roll ON" : "Auto roll OFF"}</span>
          </button>

          {/* Toggle mode auto-joueur */}
          <button
            type="button"
            onClick={() => setAutoPlayerEnabled(!autoPlayerEnabled)}
            className={`flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              autoPlayerEnabled
                ? "border-emerald-500 bg-emerald-900/60 text-emerald-200 shadow"
                : "border-slate-700 bg-slate-900/60 text-slate-400 hover:border-slate-500 hover:text-slate-100"
            }`}
            title="Quand ce mode est activé, une IA joue automatiquement Ã  la place du joueur (utile pour les tests)."
          >
            <span>{autoPlayerEnabled ? "Auto-joueur ON" : "Auto-joueur OFF"}</span>
          </button>

          {autoPlayerEnabled && (
            <button
              type="button"
              onClick={runAutoPlayerTurn}
              className="shrink-0 rounded px-2.5 py-1 text-[11px] font-medium border border-emerald-500/70 text-emerald-300 bg-emerald-900/40 hover:bg-emerald-800/60 transition-colors"
              title="Forcer immédiatement un tour de l'auto-joueur (utile pour le debug)."
            >
              Tour auto
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button
            onClick={() => setDebugMode(!debugMode)}
            className={`shrink-0 rounded px-2.5 py-1 text-xs font-medium transition-colors ${debugMode ? "bg-teal-600 text-white shadow" : "text-slate-500 hover:bg-slate-700 hover:text-slate-200"}`}
          >
            {repairMojibakeForDisplay("ðŸ”§")} {debugMode ? "Debug ON" : "Debug"}
          </button>
          {debugMode && (
            <button
              type="button"
              onClick={() => void debugUnstickPlayerSession()}
              className="shrink-0 rounded px-2.5 py-1 text-[11px] font-medium border border-rose-700/70 bg-rose-950/50 text-rose-100 hover:bg-rose-900/45"
              title="Si « une autre action est en cours », le MJ reste bloqué ou le jet ne part plus : lève les verrous Firestore + réinitialise typing / jet en attente / file API (multijoueur inclus)."
            >
              Débloquer session
            </button>
          )}
          {debugMode && gameMode === "combat" && (
            <div className="flex flex-wrap items-center gap-1 border-l border-slate-700/80 pl-2">
              <button
                type="button"
                onClick={debugUnstickCombatTurnFlow}
                className="shrink-0 rounded px-2 py-1 text-[10px] font-medium border border-amber-700/60 bg-amber-950/40 text-amber-200 hover:bg-amber-900/50"
                title="Si l’initiative reste sur un PNJ sans action : réinitialise verrous kickoff + boucle ennemis et relance."
              >
                Débloquer PNJ
              </button>
              <button
                type="button"
                onClick={() => void debugForceEnemyTurnNow()}
                className="shrink-0 rounded px-2 py-1 text-[10px] font-medium border border-amber-700/60 bg-amber-950/40 text-amber-200 hover:bg-amber-900/50"
                title="Force runEnemyTurnsUntilPlayer sur le slot actuel (__forceEntry). Multijoueur : flush l’état après."
              >
                Forcer tour PNJ
              </button>
              <button
                type="button"
                onClick={debugSkipCombatTurnSlot}
                className="shrink-0 rounded px-2 py-1 text-[10px] font-medium border border-amber-700/60 bg-amber-950/40 text-amber-200 hover:bg-amber-900/50"
                title="Avance l’index d’initiative au prochain combattant vivant (débloque un slot coincé)."
              >
                Passer slot
              </button>
            </div>
          )}
          {/* Latence IA (moyenne glissante) — à droite du bouton Debug */}
          <div className="hidden md:flex items-center gap-2 text-[11px] text-slate-500 shrink-0 border-l border-slate-700/80 pl-2 ml-0.5">
            <span className="uppercase tracking-widest">Latence</span>
            <span className="tabular-nums text-slate-300">
              {typeof latencyAvgMs === "number"
                ? `${(latencyAvgMs / 1000).toFixed(2)}s`
                : repairMojibakeForDisplay("â€”")}
            </span>
            {typeof latencyLastMs === "number" && (
              <span className="tabular-nums text-slate-600">
                (dernier {(latencyLastMs / 1000).toFixed(2)}s)
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Zone de messages */}
      <div
        ref={chatScrollContainerRef}
        onScroll={onChatScroll}
        className="flex-1 overflow-y-auto p-4 space-y-3"
      >
        {messages.map((msg) => {
          // Message [Continue] : masqué (prompt système pour poursuite MJ)
          if (msg.type === "continue") return null;
          // Commande moteur technique : ne jamais afficher dans le chat joueur.
          if (String(msg?.content ?? "").trim() === "[ENGINE_END_TURN]") return null;

          // Contexte campagne (en-tête) — encadré gris, hors dialogue MJ
          if (msg.type === "campaign-context") {
            const boxTitle = msg.contextBox?.title?.trim() || "Contexte";
            return (
              <div key={msg.id} className="flex justify-center">
                <div className="w-full max-w-[780px] rounded-xl border border-slate-500/45 bg-slate-800/55 shadow-inner px-5 py-4 backdrop-blur-[2px]">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400 border-b border-slate-600/50 pb-2 mb-3">
                    {repairMojibakeForDisplay(boxTitle)}
                  </p>
                  <div className="text-sm text-slate-200/95 leading-relaxed whitespace-pre-wrap">
                    <BoldText text={repairMojibakeForDisplay(msg.content)} />
                  </div>
                </div>
              </div>
            );
          }

          // Créneau réservé pendant la génération (même position que l’image finale)
          if (msg.type === "scene-image-pending") {
            return (
              <div key={msg.id} className="flex justify-center">
                <div className="flex w-full max-w-[780px] flex-col items-center justify-center gap-3 rounded-xl border border-indigo-800/50 bg-gradient-to-b from-slate-900/90 to-slate-950/95 px-6 py-10 shadow-inner">
                  <div
                    className="h-10 w-10 animate-spin rounded-full border-2 border-indigo-400/40 border-t-indigo-200"
                    aria-hidden
                  />
                  <p className="text-center text-sm font-medium text-indigo-100/90">{msg.content}</p>
                  <p className="text-center text-[11px] text-slate-500">
                    L&apos;image apparaîtra ici dès qu&apos;elle sera prête.
                  </p>
                </div>
              </div>
            );
          }

          // Image générée â€” affichée dans le flux du chat, et cliquable (plein écran)
          if (msg.type === "scene-image") {
            return (
              <div key={msg.id} className="flex justify-center">
                <button
                  type="button"
                  onClick={() => setFullImageUrl(msg.content)}
                  className="w-full max-w-[780px] overflow-hidden rounded-xl border border-slate-700 bg-slate-900/40 hover:border-slate-500 transition"
                  title="Ouvrir en plein écran"
                >
                  <img
                    src={msg.content}
                    alt="Illustration générée"
                    className="w-full h-auto object-cover"
                  />
                </button>
              </div>
            );
          }

          // Logs debug : uniquement si le bouton Debug est activé (solo et multijoueur).
          if (msg.type === "debug") {
            if (!debugMode) return null;
            return (
              <div key={msg.id} className="flex justify-center">
                <div className="max-w-[95%] rounded-xl border border-slate-700 bg-slate-950/60 px-4 py-2 text-xs text-slate-300 shadow">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">debug</p>
                  <pre className="whitespace-pre-wrap break-words font-mono leading-relaxed">
                    {repairMojibakeForDisplay(msg.content).replace(/^\[DEBUG\]\s?/, "")}
                  </pre>
                </div>
              </div>
            );
          }

          // Tour ennemi â€” rouge, centré
          if (msg.type === "enemy-turn") {
            return (
              <div key={msg.id} className="flex justify-center">
                <div className="rounded-xl border border-red-600/50 bg-red-950/60 px-4 py-2.5 text-sm text-red-200 shadow">
                  <p className="text-center tracking-wide">
                    <BoldText text={repairMojibakeForDisplay(msg.content)} />
                  </p>
                </div>
              </div>
            );
          }

          // Détail mécanique d'une attaque contre le PJ — orange (solo : visible par vous ; multijoueur futur : filtrer par cible)
          if (msg.type === "combat-detail") {
            return (
              <div key={msg.id} className="flex justify-center">
                <div className="rounded-xl border border-red-600/50 bg-red-950/60 px-4 py-2.5 text-sm text-red-200 shadow">
                  <p className="text-center tracking-wide text-xs mb-1 text-red-200">
                    Pour vous — détail de combat
                  </p>
                  <p className="text-center leading-relaxed whitespace-pre-wrap">
                    <BoldText text={repairMojibakeForDisplay(msg.content)} />
                  </p>
                </div>
              </div>
            );
          }

          // Jet de dé joueur â€” doré, centré
          if (msg.type === "dice") {
            const repairedDice = repairMojibakeForDisplay(msg.content);
            const isInitiative = String(repairedDice ?? "").includes("Jet d'Initiative");
            const isAttackRoll = /^🎲\s*Attaque\b|ðŸŽ²\s*Attaque\b/i.test(String(repairedDice ?? "")) || String(repairedDice ?? "").includes("Attaque (");
            const isAllyMove = typeof repairedDice === "string" && repairedDice.trim().startsWith("Vous vous déplacez");
            const diceKind = isAttackRoll ? "ally-attack" : isAllyMove ? "ally-move" : isInitiative ? "initiative" : "other";
            return (
              <div key={msg.id} className="flex justify-center">
                {diceKind === "ally-attack" || diceKind === "ally-move" ? (
                  <div className="rounded-xl border border-green-600/50 bg-green-950/60 px-4 py-2.5 text-sm text-green-200 shadow">
                    <p className="text-center tracking-wide whitespace-pre-wrap">
                      <BoldText text={repairedDice} />
                    </p>
                  </div>
                ) : (
                  <div className="rounded-xl border border-yellow-500/60 bg-yellow-950/70 px-4 py-2.5 text-sm text-yellow-200 shadow">
                    <p className="text-center tracking-wide whitespace-pre-wrap">
                      <BoldText text={repairedDice} />
                    </p>
                  </div>
                )}
              </div>
            );
          }

          // Message hors-RP joueur â€” teal
          if (msg.type === "meta") {
            const repaired = repairMojibakeForDisplay(msg.content);
            const metaText = String(repaired ?? "").replace(/^\[HORS_JEU\]:\s*/, "");
            return (
              <div key={msg.id} className="flex justify-center">
                <div
                  className={
                    "max-w-[80%] rounded-xl border border-slate-600/60 bg-slate-700/40 px-4 py-2.5 text-sm text-slate-100 shadow"
                  }
                >
                  <p className="leading-relaxed whitespace-pre-wrap">
                    <BoldText text={metaText} />
                  </p>
                </div>
              </div>
            );
          }

          // Réponse IA hors-RP â€” indigo
          if (msg.type === "meta-reply") {
            const repaired = repairMojibakeForDisplay(msg.content);
            const cleaned = String(repaired ?? "").replace(/^💬\s*Vous\s*\(hors RP\)\s*/i, "");
            return (
              <div key={msg.id} className="flex justify-center">
                <div className="max-w-[80%] rounded-xl border border-orange-400/70 bg-orange-950/45 px-4 py-2.5 text-sm text-orange-100 shadow">
                  <p className="leading-relaxed whitespace-pre-wrap">{cleaned}</p>
                </div>
              </div>
            );
          }

          // Action de réessai narration IA (après échec réseau/API)
          if (msg.type === "retry-action") {
            return (
              <div key={msg.id} className="flex justify-center">
                <button
                  type="button"
                  onClick={retryFailedRequest}
                  disabled={!failedRequestPayload || isTyping || isRetryingFailedRequest}
                  className="rounded-xl border border-amber-500/60 bg-amber-950/60 px-3 py-2 text-sm text-amber-200 shadow hover:bg-amber-900/70 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Réessayer la dernière action échouée"
                >
                  <span className={`inline-block mr-2 ${isRetryingFailedRequest ? "animate-spin" : ""}`}>↻</span>
                  Réessayer
                </button>
              </div>
            );
          }

          // Fin de tour (moteur) — orange
          if (msg.type === "turn-end") {
            const repairedTurnEnd = repairMojibakeForDisplay(msg.content);
            const isPlayerTurnEnd = !!player?.name && String(repairedTurnEnd ?? "").includes(player.name);
            const boxClass = isPlayerTurnEnd
              ? "rounded-xl border border-green-600/50 bg-green-950/60"
              : "rounded-xl border border-red-600/50 bg-red-950/60";
            const textClass = isPlayerTurnEnd ? "text-green-200" : "text-red-200";
            return (
              <div key={msg.id} className="flex justify-center">
                <div className={`${boxClass} px-4 py-2.5 text-sm ${textClass} shadow`}>
                  <p className="text-center tracking-wide text-xs mb-1 opacity-90">Combat</p>
                  <p className="text-center leading-relaxed whitespace-pre-wrap">
                    <BoldText text={repairMojibakeForDisplay(msg.content)} />
                  </p>
                </div>
              </div>
            );
          }

          // Ligne de séparation entre tours — fine, neutre
          if (msg.type === "turn-divider") {
            return (
              <div key={msg.id} className="flex justify-center">
                <div className="w-full max-w-[780px] border-t border-slate-700/60 my-2" />
              </div>
            );
          }

          // Erreur moteur / parseur d'intention — ambre
          if (msg.type === "intent-error") {
            return (
              <div key={msg.id} className="flex justify-center">
                <div className="max-w-[80%] rounded-xl border border-slate-600/60 bg-slate-700/40 px-4 py-2.5 text-sm text-slate-100 shadow">
                  <p className="leading-relaxed">
                    <BoldText text={repairMojibakeForDisplay(msg.content)} />
                  </p>
                </div>
              </div>
            );
          }

          // Réplique / intention joueur en scène (multijoueur) — centré, vert
          if (msg.role === "user" && msg.type === "player-utterance") {
            const senderLabel =
              typeof msg.senderName === "string" && msg.senderName.trim()
                ? msg.senderName.trim()
                : "Vous";
            return (
              <div key={msg.id} className="flex justify-center">
                <div className="max-w-[80%] rounded-xl border border-green-600/50 bg-green-950/60 px-4 py-2.5 text-sm text-green-200 shadow">
                  <p className="text-center text-xs font-semibold text-green-300/90 mb-1">{senderLabel}</p>
                  <p className="text-center leading-relaxed whitespace-pre-wrap">
                    {repairMojibakeForDisplay(msg.content)}
                  </p>
                </div>
              </div>
            );
          }

          // Message joueur â€” droite, bleu
          if (msg.role === "user") {
            const senderLabel =
              typeof msg.senderName === "string" && msg.senderName.trim()
                ? msg.senderName.trim()
                : "Vous";
            return (
              <div key={msg.id} className="flex justify-end">
                <div className="max-w-[75%] rounded-2xl rounded-tr-sm bg-blue-600 px-4 py-2 text-sm text-white shadow">
                  <p className="mb-1 text-xs font-semibold text-blue-200">{senderLabel}</p>
                  <p className="leading-relaxed">{repairMojibakeForDisplay(msg.content)}</p>
                </div>
              </div>
            );
          }

          // Message IA â€” gauche, gris
          return (
            <div key={msg.id} className="flex justify-start">
              <div className="max-w-[75%] rounded-2xl rounded-tl-sm bg-slate-700 px-4 py-2 text-sm text-slate-100 shadow">
                <p className="mb-1 text-xs font-semibold text-slate-400">Maître du Jeu</p>
                <p className="leading-relaxed">{repairMojibakeForDisplay(msg.content)}</p>
              </div>
            </div>
          );
        })}

        {/* Indicateur "Le MJ réfléchitâ€¦" */}
        {showGmThinkingIndicator && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-tl-sm bg-slate-700 px-4 py-3 shadow">
              <p className="mb-1 text-xs font-semibold text-slate-400">Maître du Jeu</p>
              <div className="flex items-center gap-2">
                <div className="flex gap-1">
                  <span className="h-2 w-2 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
                  <span className="h-2 w-2 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]" />
                  <span className="h-2 w-2 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]" />
                </div>
                <span className="text-xs text-slate-500 italic">
                  {repairMojibakeForDisplay(
                    multiplayerSessionId
                      ? multiplayerThinkingState.label || "Le MJ réfléchit…"
                      : "Le MJ réfléchitâ€¦"
                  )}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Indicateur "L'IA joueur réfléchitâ€¦" (MP : local pendant /api/auto-player, sans pré-écrire Firestore) */}
        {(multiplayerSessionId
          ? isAutoPlayerThinking &&
            !isTyping &&
            !(multiplayerThinkingState.active === true && multiplayerThinkingState.actor === "gm")
          : isAutoPlayerThinking && !isTyping) && (
          <div className="flex justify-end">
            <div className="rounded-2xl rounded-tr-sm bg-sky-200 px-4 py-3 shadow">
              <p className="mb-1 text-xs font-semibold text-sky-700">IA joueur</p>
              <div className="flex items-center gap-2">
                <div className="flex gap-1">
                  <span className="h-2 w-2 rounded-full bg-sky-500 animate-bounce [animation-delay:0ms]" />
                  <span className="h-2 w-2 rounded-full bg-sky-500 animate-bounce [animation-delay:150ms]" />
                  <span className="h-2 w-2 rounded-full bg-sky-500 animate-bounce [animation-delay:300ms]" />
                </div>
                <span className="text-xs text-sky-700 italic">
                  {repairMojibakeForDisplay(
                    multiplayerSessionId
                      ? multiplayerThinkingState.label || "L'IA joueur réfléchit…"
                      : "L'IA joueur réfléchitâ€¦"
                  )}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Bannière quota */}
        {retryCountdown > 0 && (
          <div className="flex justify-center">
            <div className="flex items-center gap-3 rounded-lg border border-amber-700 bg-amber-950 px-4 py-2 text-xs text-amber-300">
              <span>{repairMojibakeForDisplay("â³")}</span>
              <span>
                {repairMojibakeForDisplay("Quota API dépassé â€” réessayez dans ")}
                <span className="font-bold tabular-nums">{retryCountdown}s</span>
              </span>
            </div>
          </div>
        )}

        {/* Images de scène : désormais injectées dans le flux du chat (type "scene-image") */}

        {/* Bannière erreur */}
        {error && retryCountdown === 0 && (
          <div className="flex justify-center">
            <div className="flex items-center gap-2 rounded-lg border border-red-800 bg-red-950 px-4 py-2 text-xs text-red-300">
              <span>⚠</span>
              <span>{repairMojibakeForDisplay(error)}</span>
              <button
                type="button"
                onClick={retryFailedRequest}
                disabled={!failedRequestPayload || isTyping || isRetryingFailedRequest}
                className="ml-1 rounded border border-amber-700/80 bg-amber-950/60 px-2 py-0.5 text-amber-200 hover:bg-amber-900/80 disabled:opacity-40 disabled:cursor-not-allowed"
                title="Relancer la dernière requête échouée"
              >
                <span className={`inline-block mr-1 ${isRetryingFailedRequest ? "animate-spin" : ""}`}>↻</span>
                Réessayer
              </button>
              <button
                onClick={() => {
                  setError(null);
                  setFlowBlocked(false);
                  setFailedRequestPayload(null);
                  setIsRetryingFailedRequest(false);
                }}
                className="ml-1 text-red-400 hover:text-red-200"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Bandeau jet : persistant jusqu'au lancer (plus masqué pendant « MJ réfléchit »). */}
      {pendingRoll &&
        !waitForGmNarrationForInitiative &&
        getPendingRollStableKey(pendingRoll) !== pendingRollUiHiddenKey &&
        !groupSkillAllRollsRecorded &&
        (() => {
        const forMe = pendingRollTargetsLocalPlayer(
          pendingRoll,
          player,
          clientId,
          !!multiplayerSessionId,
          multiplayerSessionId,
          multiplayerParticipantProfiles
        );
        const groupWaitTitle = formatGroupSkillCheckWaitTitle(
          pendingRoll,
          entities,
          pendingRoll.forPlayerName
        );
        const diceDesc = getPendingRollDiceDescriptor(pendingRoll);
        let rollNotation = diceDesc.rollNotation;
        let diceCount = diceDesc.diceCount;
        let diceSides = diceDesc.diceSides;
        let displayBonus = diceDesc.displayTotalBonus;

        const effGmBanner = gameStateRef.current?.gameMode ?? gameMode;
        const hiddenArrBanner = gameStateRef.current?.combatHiddenIds ?? combatHiddenIds ?? [];
        const atkAdvBanner =
          forMe && pendingRoll.kind === "attack"
            ? computePlayerAttackAdvDisForPendingRoll({
                pendingRoll,
                gameMode: effGmBanner,
                player,
                entities,
                combatHiddenIds: hiddenArrBanner,
                localCombatantId,
                multiplayerSessionId,
                getMeleeWith,
                dodgeMap: dodgeActiveByCombatantIdRef.current ?? {},
                controllerForCombatantId,
              })
            : null;

        let diceLabel = `${diceCount}d${diceSides}`;
        if (pendingRoll.kind === "attack" && atkAdvBanner?.needsTwoD20) {
          diceLabel =
            atkAdvBanner.mode === "advantage"
              ? "2d20 (avantage — un clic lance les deux, on garde le plus haut)"
              : "2d20 (désavantage — un clic lance les deux, on garde le plus bas)";
        } else if (pendingRoll.kind === "attack" && atkAdvBanner?.mode === "cancelled") {
          diceLabel = "1d20 (avantage et désavantage annulés)";
        } else if (pendingRoll.kind === "attack") {
          diceLabel = "1d20";
        }

        const spellNameBanner = String(pendingRoll.weaponName ?? "");
        const isSpellAtkBanner = !!(spellNameBanner && SPELLS?.[spellNameBanner]);
        const spellBonusLine =
          pendingRoll.kind === "attack" && isSpellAtkBanner
            ? formatSpellAttackBonusExplanation(player)
            : null;

        const natMin = diceCount;
        const natMax = diceCount * diceSides;
        const attackTwoD20Manual =
          pendingRoll.kind === "attack" && atkAdvBanner?.needsTwoD20 === true && useManualRollInput;
        const manualMulti =
          pendingRoll.kind === "damage_roll" && diceCount > 1 && useManualRollInput;
        const manualDiceCount = diceCount;
        const manualDiceSides = diceSides;
        const manualPerDieOk =
          manualMulti &&
          manualPerDieValues.length === manualDiceCount &&
          manualPerDieValues.every((cell) => {
            const n = Number(String(cell ?? "").trim());
            return Number.isInteger(n) && n >= 1 && n <= manualDiceSides;
          });
        const manualNatParsed =
          useManualRollInput && String(manualRollNatInput ?? "").trim()
            ? Number(manualRollNatInput)
            : NaN;
        const manualNatOk =
          useManualRollInput &&
          !manualMulti &&
          Number.isFinite(manualNatParsed) &&
          manualNatParsed >= natMin &&
          manualNatParsed <= natMax;
        const manualEntryOk = manualMulti ? manualPerDieOk : manualNatOk;

        let pendingAttackAdvDisHint = "";
        if (pendingRoll.kind === "attack" && atkAdvBanner && effGmBanner === "combat") {
          if (atkAdvBanner.mode === "disadvantage") {
            pendingAttackAdvDisHint = `Désavantage — ${atkAdvBanner.label}`;
          } else if (atkAdvBanner.mode === "advantage") {
            pendingAttackAdvDisHint = `Avantage — ${atkAdvBanner.label}`;
          } else if (atkAdvBanner.mode === "cancelled") {
            pendingAttackAdvDisHint = "Avantage et désavantage s'annulent — un seul d20.";
          }
        }

        const bannerTone =
          forMe && pendingRoll.kind === "attack" && atkAdvBanner
            ? atkAdvBanner.mode === "advantage"
              ? "border-t border-emerald-600/50 bg-emerald-950/45"
              : atkAdvBanner.mode === "disadvantage"
                ? "border-t border-rose-600/50 bg-rose-950/40"
                : atkAdvBanner.mode === "cancelled"
                  ? "border-t border-amber-600/45 bg-amber-950/35"
                  : "border-t border-yellow-600/40 bg-yellow-950/40"
            : forMe
              ? "border-t border-yellow-600/40 bg-yellow-950/40"
              : "border-t border-slate-600/40 bg-slate-900/50";

        const bannerTextTone =
          forMe && pendingRoll.kind === "attack" && atkAdvBanner?.mode === "advantage"
            ? "text-emerald-100"
            : forMe && pendingRoll.kind === "attack" && atkAdvBanner?.mode === "disadvantage"
              ? "text-rose-100"
              : forMe && pendingRoll.kind === "attack" && atkAdvBanner?.mode === "cancelled"
                ? "text-amber-100"
                : forMe
                  ? "text-yellow-200"
                  : "text-slate-300";

        const bannerAccentTone =
          forMe && pendingRoll.kind === "attack" && atkAdvBanner?.mode === "advantage"
            ? "text-emerald-300"
            : forMe && pendingRoll.kind === "attack" && atkAdvBanner?.mode === "disadvantage"
              ? "text-rose-300"
              : forMe && pendingRoll.kind === "attack" && atkAdvBanner?.mode === "cancelled"
                ? "text-amber-300"
                : forMe
                  ? "text-yellow-400"
                  : "text-slate-400";

        const rollCtaLabel =
          useManualRollInput
            ? "Valider"
            : pendingRoll.kind === "attack" && atkAdvBanner?.needsTwoD20
              ? "Lancer les 2d20"
              : "Lancer le dé";

        const bannerTitleTone = forMe
          ? atkAdvBanner?.mode === "advantage"
            ? "text-emerald-50"
            : atkAdvBanner?.mode === "disadvantage"
              ? "text-rose-50"
              : atkAdvBanner?.mode === "cancelled"
                ? "text-amber-50"
                : "text-yellow-100"
          : "text-slate-200";

        if (
          forMe &&
          autoRollEnabled &&
          !useManualRollInput &&
          pendingRoll?.kind !== "damage_roll"
        ) {
          return null;
        }
        return (
        <div
          className={`${bannerTone} px-4 py-3 flex items-center justify-between gap-4 shrink-0`}
        >
          <div className={`text-xs leading-relaxed ${bannerTextTone}`}>
            <p className={`font-semibold ${bannerTitleTone}`}>
              {repairMojibakeForDisplay("ðŸŽ²")}{" "}
              {forMe
                ? "Jet requis"
                : pendingRoll.kind === "check" &&
                    (pendingRoll.audience === "global" || pendingRoll.audience === "selected")
                  ? `Jet en attente — ${groupWaitTitle}`
                  : `Jet en attente (${pendingRoll.forPlayerName || "un joueur"})`}{" "}
              :{" "}
              {getPublicPendingRollTitle(pendingRoll).replace(/^Jet de\s+/i, "")}
            </p>
            {pendingRoll.kind !== "damage_roll" ? (
            <p className={bannerAccentTone}>
              <span className="font-medium">{diceLabel}</span>
              <span className="font-semibold"> {fmtMod(displayBonus)}</span>
              {spellBonusLine ? (
                <span className="block mt-0.5 text-[11px] leading-snug opacity-95">
                  = {spellBonusLine} (D&D 5e : mod. de carac. d&apos;incantation + bonus de maîtrise)
                </span>
              ) : (
                <span> ({pendingRoll.skill ?? pendingRoll.stat})</span>
              )}
              {manualMulti ? (
                <span className="block mt-1 text-[11px] opacity-90">
                  {`Une valeur par dé (1–${diceSides} chacun).`}
                  {displayBonus !== 0 ? ` Bonus fixe ${fmtMod(displayBonus)}.` : ""}
                </span>
              ) : null}
              {useManualRollInput && attackTwoD20Manual ? (
                <span className="block mt-1 text-[11px] opacity-90">
                  Mes dés : indiquez uniquement le résultat final retenu (d20, 1–20).
                </span>
              ) : null}
              {pendingAttackAdvDisHint ? (
                <span className="block mt-1 text-[11px] italic opacity-95">
                  {pendingAttackAdvDisHint}
                </span>
              ) : null}
            </p>
            ) : manualMulti ? (
              <p className={forMe ? "text-yellow-400" : "text-slate-400"}>
                <span className="block text-[11px] text-yellow-300/90">
                  Une valeur par dé (1–{diceSides} chacun).
                  {displayBonus !== 0 ? ` Bonus fixe ${fmtMod(displayBonus)}.` : ""}
                </span>
              </p>
            ) : null}
          </div>
          {forMe ? (
            <div className="flex items-center gap-3 shrink-0">
              <label
                className={`flex items-center gap-2 text-[11px] cursor-pointer select-none ${
                  forMe ? bannerTextTone : "text-slate-300"
                }`}
              >
                <input
                  type="checkbox"
                  checked={useManualRollInput}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setUseManualRollInput(checked);
                    if (checked) {
                      if (pendingRoll?.kind === "attack") {
                        const ctx = computePlayerAttackAdvDisForPendingRoll({
                          pendingRoll,
                          gameMode: gameStateRef.current?.gameMode ?? gameMode,
                          player,
                          entities,
                          combatHiddenIds: gameStateRef.current?.combatHiddenIds ?? combatHiddenIds ?? [],
                          localCombatantId,
                          multiplayerSessionId,
                          getMeleeWith,
                          dodgeMap: dodgeActiveByCombatantIdRef.current ?? {},
                          controllerForCombatantId,
                        });
                        // Avantage/désavantage manuel : une seule saisie (résultat final retenu).
                        setManualPerDieValues([]);
                        setManualRollNatInput("");
                      } else if (pendingRoll?.kind === "damage_roll") {
                        const dd = getPendingRollDiceDescriptor(pendingRoll);
                        if (dd.diceCount > 1) {
                          setManualPerDieValues(Array.from({ length: dd.diceCount }, () => ""));
                        } else {
                          setManualPerDieValues([]);
                          setManualRollNatInput("");
                        }
                      } else {
                        setManualPerDieValues([]);
                        setManualRollNatInput("");
                      }
                    } else {
                      setManualRollNatInput("");
                      setManualPerDieValues([]);
                    }
                  }}
                />
                Mes dés
              </label>
              {useManualRollInput && manualMulti && (
                <div className="flex flex-wrap items-center gap-1.5 max-w-[min(100%,22rem)] justify-end">
                  {manualPerDieValues.map((cell, idx) => (
                    <input
                      key={idx}
                      type="number"
                      inputMode="numeric"
                      value={cell}
                      min={1}
                      max={manualDiceSides}
                      aria-label={`Dé ${idx + 1}, d${manualDiceSides}`}
                      onChange={(e) => {
                        const next = [...manualPerDieValues];
                        next[idx] = e.target.value;
                        setManualPerDieValues(next);
                      }}
                      disabled={isTyping || retryCountdown > 0 || flowBlocked}
                      className="w-[3.25rem] rounded border border-yellow-400/50 bg-yellow-950/30 px-1.5 py-2 text-sm text-yellow-100 placeholder-yellow-500 outline-none focus:border-yellow-300 text-center"
                      placeholder={attackTwoD20Manual ? `d20-${idx + 1}` : `${idx + 1}`}
                    />
                  ))}
                </div>
              )}
              {useManualRollInput && !manualMulti && (
                <input
                  type="number"
                  inputMode="numeric"
                  value={manualRollNatInput}
                  min={natMin}
                  max={natMax}
                  onChange={(e) => setManualRollNatInput(e.target.value)}
                  disabled={isTyping || retryCountdown > 0 || flowBlocked}
                  className="w-20 rounded border border-yellow-400/50 bg-yellow-950/30 px-2 py-2 text-sm text-yellow-100 placeholder-yellow-400 outline-none focus:border-yellow-300"
                  placeholder={`${natMin}-${natMax}`}
                />
              )}
              <button
                onClick={handleRoll}
                disabled={
                  isTyping || retryCountdown > 0 || flowBlocked || (useManualRollInput && !manualEntryOk)
                }
                className="shrink-0 animate-pulse rounded-lg border border-yellow-400 bg-yellow-500 px-5 py-2 text-sm font-bold text-slate-900 shadow-lg hover:bg-yellow-400 active:bg-yellow-600 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {repairMojibakeForDisplay("ðŸŽ²")} {rollCtaLabel}
              </button>
            </div>
          ) : (
            <span className="shrink-0 text-[11px] text-slate-500 italic max-w-[200px] text-right">
              {pendingRoll.kind === "check" &&
              (pendingRoll.audience === "global" || pendingRoll.audience === "selected")
                ? "Chaque joueur concerné doit lancer depuis son onglet."
                : "Le joueur concerné doit lancer."}
            </span>
          )}
        </div>
        );
      })()}

      {/* Panneau God Mode */}
      {debugMode && (
        <div className="border-t border-teal-700/50 bg-teal-950/30 px-4 py-3 flex flex-col gap-3 shrink-0">
          <p className="text-xs font-semibold text-teal-400">
            {repairMojibakeForDisplay("ðŸ”§ Debug â€” God Mode moteur")}
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={debugInput}
              onChange={(e) => setDebugInput(e.target.value)}
              onKeyDown={handleDebugKeyDown}
              placeholder="Ex : Téléporte-moi en room_4, tue le gobelin ricanant, remets mes PV à 13…"
              disabled={isTyping}
              className="flex-1 rounded-md border border-teal-600/60 bg-teal-900/30 px-4 py-2 text-sm text-teal-100 placeholder-teal-700 outline-none focus:border-teal-400 disabled:opacity-50"
            />
            <button
              onClick={handleDebugSend}
              disabled={!debugInput.trim() || isTyping}
              className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-500 disabled:opacity-40"
            >
              Envoyer
            </button>
          </div>

        </div>
      )}

      {/* Plein écran image (depuis le chat) */}
      {fullImageUrl && (
        <div
          className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-6"
          onClick={() => setFullImageUrl(null)}
        >
          <div className="relative max-w-[95vw] max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setFullImageUrl(null)}
              className="absolute -top-3 -right-3 rounded-full border border-slate-600 bg-slate-900 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
            >
              Fermer
            </button>
            <img
              src={fullImageUrl}
              alt="Illustration plein écran"
              className="max-w-[95vw] max-h-[90vh] object-contain rounded-lg border border-slate-700"
            />
          </div>
        </div>
      )}
      
      {/* Ressources de tour (combat uniquement) */}
      {isInCombat && (
        <>
          <div className="border-t border-slate-700 bg-slate-900/70 px-4 py-2 flex items-center justify-between gap-4 text-[11px] text-slate-300 shrink-0">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-slate-400 font-semibold uppercase tracking-wider">
                Ressources de tour
              </span>
          {/* Action */}
          <div className="flex items-center gap-1">
            <span
              className={
                "h-2.5 w-2.5 rounded-full border border-emerald-500 " +
                (isInCombat && turnResources.action ? "bg-emerald-500" : "bg-transparent")
              }
              title="Action"
            />
            <span>Action</span>
          </div>
          {/* Action bonus */}
          <div className="flex items-center gap-1">
            <span
              className={
                "h-2.5 w-2.5 rounded-full border border-amber-500 " +
                (isInCombat && turnResources.bonus ? "bg-amber-500" : "bg-transparent")
              }
              title="Action bonus"
            />
            <span>Action bonus</span>
          </div>
          {/* Réaction */}
          <div className="flex items-center gap-1">
            <span
              className={
                "h-2.5 w-2.5 rounded-full border border-violet-500 " +
                (isInCombat && turnResources.reaction ? "bg-violet-500" : "bg-transparent")
              }
              title="Réaction"
            />
            <span>Réaction</span>
          </div>
          {/* Mouvement */}
          <div className="flex items-center gap-1">
            <span>Mouvement :</span>
            <span className="tabular-nums text-slate-100">{turnResources.movement ? "Oui" : "Non"}</span>
          </div>
        </div>
        {player?.entityClass === "Guerrier" && (
          <button
            type="button"
            onClick={handleSecondWind}
            disabled={
              inputBlocked ||
              !isMyTurn ||
              !turnResources.bonus ||
              (player?.fighter?.resources?.secondWind?.remaining ?? 0) <= 0 ||
              player.hp.current >= player.hp.max
            }
            className="rounded-full border border-amber-600/60 bg-amber-950/20 px-2.5 py-1 text-[10px] font-semibold text-amber-200 hover:bg-amber-950/40 hover:border-amber-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Second souffle (Action bonus) â€” 1d10 + niveau (1/rest)"
          >
            Second souffle
            <span className="ml-1 text-[10px] text-amber-300 tabular-nums">
              ({player?.fighter?.resources?.secondWind?.remaining ?? 0}/1)
            </span>
          </button>
        )}
        {player?.entityClass === "Roublard" && (
          <>
            <button
              type="button"
              onClick={() => setSneakAttackArmed((v) => !v)}
              disabled={inputBlocked || !isMyTurn || sneakAttackUsedThisTurn}
              className={
                "rounded-full border px-2.5 py-1 text-[10px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed " +
                (sneakAttackArmed
                  ? "border-emerald-500/70 bg-emerald-950/40 text-emerald-100 hover:bg-emerald-950/60"
                  : "border-slate-600 bg-slate-950/20 text-slate-200 hover:bg-slate-800 hover:border-slate-500")
              }
              title="Attaque sournoise (1/ tour) â€” s'applique Ã  la prochaine attaque touchée avec une arme finesse ou Ã  distance."
            >
              Attaque sournoise
              <span className="ml-1 text-[10px] text-emerald-200 tabular-nums">
                ({sneakAttackUsedThisTurn ? "0" : "1"}/1)
              </span>
            </button>

            {(player?.level ?? 1) >= 2 && (
              <>
                <button
                  type="button"
                  onClick={handleCunningActionDash}
                  disabled={inputBlocked || !isMyTurn || !turnResources.bonus}
                  className="rounded-full border border-amber-600/60 bg-amber-950/15 px-2.5 py-1 text-[10px] font-semibold text-amber-200 hover:bg-amber-950/30 hover:border-amber-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Ruse : Foncer (Action bonus)"
                >
                  Foncer (Ruse)
                </button>
                <button
                  type="button"
                  onClick={handleCunningActionHide}
                  disabled={inputBlocked || !isMyTurn || !turnResources.bonus}
                  className="rounded-full border border-amber-600/60 bg-amber-950/15 px-2.5 py-1 text-[10px] font-semibold text-amber-200 hover:bg-amber-950/30 hover:border-amber-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Ruse : Se cacher (Action bonus)"
                >
                  Se cacher (Ruse)
                </button>
                <button
                  type="button"
                  onClick={handleCunningActionDisengage}
                  disabled={inputBlocked || !isMyTurn || !turnResources.bonus}
                  className="rounded-full border border-amber-600/60 bg-amber-950/15 px-2.5 py-1 text-[10px] font-semibold text-amber-200 hover:bg-amber-950/30 hover:border-amber-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Ruse : Se désengager (Action bonus)"
                >
                  Désengager (Ruse)
                </button>
              </>
            )}
          </>
        )}
        {player?.entityClass === "Clerc" && (
          <button
            type="button"
            onClick={handleTurnUndead}
            disabled={
              inputBlocked ||
              !isMyTurn ||
              !turnResources.action ||
              (player?.cleric?.resources?.channelDivinity?.remaining ?? 0) <= 0
            }
            className="rounded-full border border-sky-600/60 bg-sky-950/20 px-2.5 py-1 text-[10px] font-semibold text-sky-200 hover:bg-sky-950/40 hover:border-sky-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Conduit divin : Renvoi des morts-vivants (Action) â€” 1/repos (puis 2 au niv 6, 3 au niv 18)"
          >
            Renvoi morts-vivants
            <span className="ml-1 text-[10px] text-sky-300 tabular-nums">
              ({player?.cleric?.resources?.channelDivinity?.remaining ?? 0}/{player?.cleric?.resources?.channelDivinity?.max ?? 0})
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowActionsHelp((v) => !v)}
          className="ml-auto rounded-full border border-slate-600 px-2.5 py-1 text-[10px] font-semibold text-slate-200 hover:bg-slate-800 hover:border-slate-500 transition-colors"
        >
          {showActionsHelp ? "Masquer" : "Voir plus"}
            </button>
          </div>

          {showActionsHelp && (
            <div className="border-t border-slate-800 bg-slate-900/80 px-4 py-2 text-[11px] text-slate-400 shrink-0">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span className="font-semibold text-slate-300">Actions possibles :</span>
                <span>Attaquer (Action)</span>
                <span>Lancer un sort (Action)</span>
                <span>Se désengager (Action)</span>
                <span>Se déplacer (Mouvement)</span>
                <span>Se cacher (Action)</span>
                <span>Esquiver (Action)</span>
                <span>Utiliser un objet (Action)</span>
                <span>Réaction (ex : attaque d&apos;opportunité)</span>
              </div>
            </div>
          )}
        </>
      )}

      {/* Barre d'input normale */}
      {movementGate && isMyTurn && gameMode === "combat" && (
        <div className="border-t border-slate-700 bg-slate-900/40 px-4 py-3 flex flex-wrap items-center gap-2 shrink-0">
          <div className="text-xs text-slate-300 flex-1 min-w-[220px]">
            <span className="font-semibold text-slate-200">Corps Ã  corps</span>{" "}
            â€” vous essayez de vous éloigner. Choisissez :
          </div>
          <button
            onClick={() => resolveMovementGate("disengage")}
            disabled={inputBlocked || (gameMode === "combat" && !turnResources.action)}
            className="rounded-md bg-amber-600 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Action: Se désengager pour partir sans attaque d'opportunité"
          >
            Se désengager (Action)
          </button>
          <button
            onClick={() => resolveMovementGate("leave_anyway")}
            disabled={inputBlocked}
            className="rounded-md bg-red-700 px-3 py-2 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Quitter la mêlée sans désengagement (attaque d'opportunité possible)"
          >
            Partir quand même (risque)
          </button>
          <button
            onClick={() => setMovementGate(null)}
            disabled={inputBlocked}
            className="rounded-md border border-slate-600 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Annuler
          </button>
        </div>
      )}

      {opportunityAttackPrompt && gameMode === "combat" && (
        <div className="border-t border-violet-700/60 bg-violet-950/40 px-4 py-3 flex flex-wrap items-center gap-2 shrink-0">
          <div className="text-xs text-violet-100 flex-1 min-w-[220px]">
            <span className="font-semibold text-violet-200">Réaction</span>
            {" — "}
            {opportunityAttackPrompt.targetName} quitte votre portée. Voulez-vous porter une attaque d&apos;opportunité ?
          </div>
          <button
            onClick={() => settlePlayerOpportunityAttackPrompt("attack")}
            disabled={playerDeadOrOver || !turnResourcesRef.current?.reaction || !hasReaction(localCombatantId)}
            className="rounded-md bg-violet-600 px-3 py-2 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Utiliser votre réaction pour faire une attaque d'opportunité"
          >
            Attaquer (Réaction)
          </button>
          <button
            onClick={() => settlePlayerOpportunityAttackPrompt("skip")}
            disabled={playerDeadOrOver}
            className="rounded-md border border-violet-500/50 px-3 py-2 text-xs font-semibold text-violet-100 hover:bg-violet-900/60 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Laisser passer
          </button>
        </div>
      )}

      {shieldReactionPrompt && gameMode === "combat" && (
        <div className="border-t border-sky-700/60 bg-sky-950/40 px-4 py-3 flex flex-wrap items-center gap-2 shrink-0">
          <div className="text-xs text-sky-100 flex-1 min-w-[220px]">
            <span className="font-semibold text-sky-200">Réaction</span>
            {" — "}
            <span className="font-medium text-sky-50">{shieldReactionPrompt.attackerName}</span> vous touche avec{" "}
            {shieldReactionPrompt.weaponName} (total <strong>{shieldReactionPrompt.atkTotal}</strong> vs votre CA{" "}
            <strong>{shieldReactionPrompt.baseAc}</strong>). Lancer <em>Bouclier</em> (+5 CA, 1 sort de niveau 1) avant
            les dégâts ?
          </div>
          <button
            type="button"
            onClick={() => settlePlayerShieldReactionPrompt("shield")}
            disabled={
              playerDeadOrOver ||
              !shieldReactionPrompt.defenderId ||
              !normalizeTurnResourcesInput(turnResourcesByCombatantId?.[shieldReactionPrompt.defenderId] ?? {})
                .reaction ||
              !hasReaction(shieldReactionPrompt.defenderId)
            }
            className="rounded-md bg-sky-600 px-3 py-2 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Consommer votre réaction et un emplacement de sort de niveau 1"
          >
            Bouclier (réaction)
          </button>
          <button
            type="button"
            onClick={() => settlePlayerShieldReactionPrompt("skip")}
            disabled={playerDeadOrOver}
            className="rounded-md border border-sky-500/50 px-3 py-2 text-xs font-semibold text-sky-100 hover:bg-sky-900/60 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Non
          </button>
        </div>
      )}

      {initiativePhaseActive && !hasLocalInitiativeRoll && !waitForGmNarrationForInitiative && (() => {
        const dexMod = Math.floor(((player?.stats?.DEX ?? 10) - 10) / 2);
        const manualIniParsed =
          useManualInitiativeRollInput && String(manualInitiativeNatInput ?? "").trim()
            ? Number(manualInitiativeNatInput)
            : NaN;
        const manualIniOk =
          useManualInitiativeRollInput &&
          Number.isFinite(manualIniParsed) &&
          manualIniParsed >= 1 &&
          manualIniParsed <= 20;
        return (
        <div className="border-t border-amber-800/50 bg-amber-950/40 px-4 py-3 flex flex-wrap items-center gap-3 shrink-0">
          <div className="text-xs text-amber-100 flex-1 min-w-[200px]">
            <span className="font-semibold text-amber-200">Initiative</span>
            {" — "}
            d20 {fmtMod(dexMod)} (DEX)
            <span className="block text-amber-400/90 mt-0.5">
              Lancez le dé en ligne ou entrez votre résultat physique ci-dessous.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <label className="flex items-center gap-2 text-[11px] text-amber-100 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={useManualInitiativeRollInput}
                onChange={(e) => {
                  setUseManualInitiativeRollInput(e.target.checked);
                  if (e.target.checked && !String(manualInitiativeNatInput ?? "").trim()) {
                    setManualInitiativeNatInput("");
                  }
                }}
              />
              Mes dés
            </label>
            {useManualInitiativeRollInput && (
              <input
                type="number"
                inputMode="numeric"
                value={manualInitiativeNatInput}
                min={1}
                max={20}
                onChange={(e) => setManualInitiativeNatInput(e.target.value)}
                disabled={isTyping || playerDeadOrOver || waitForGmNarrationForInitiative}
                className="w-20 rounded border border-amber-400/50 bg-amber-950/30 px-2 py-2 text-sm text-amber-100 placeholder-amber-500 outline-none focus:border-amber-300"
                placeholder="1-20"
              />
            )}
            <button
              type="button"
              onClick={() => handleCommitInitiative(false)}
              disabled={
                isTyping ||
                playerDeadOrOver ||
                waitForGmNarrationForInitiative ||
                (useManualInitiativeRollInput && !manualIniOk)
              }
              className="rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {useManualInitiativeRollInput ? "Valider l'initiative" : "Lancer l'initiative"}
            </button>
          </div>
        </div>
        );
      })()}

      {gameMode === "short_rest" && (
        <div className="border-t border-emerald-800/50 bg-emerald-950/40 px-4 py-3 flex flex-wrap items-center gap-3 shrink-0">
          <div className="text-xs text-emerald-100 flex-1 min-w-[220px]">
            <span className="font-semibold text-emerald-200">Repos court</span>
            {" — "}
            Vous êtes en pause. Il vous reste{" "}
            <span className="font-semibold text-emerald-200">
              {player?.hitDiceRemaining ?? 0}
            </span>{" "}
            dé(s) de vie.
            {player?.hp?.max != null && (
              <>
                {" "}
                PV actuels :{" "}
                <span className="font-semibold text-emerald-200">
                  {player?.hp?.current ?? 0}/{player.hp.max}
                </span>
                .
              </>
            )}
          </div>
          <button
            type="button"
            onClick={triggerHitDieRollFromShortRest}
            disabled={inputBlocked || (player?.hitDiceRemaining ?? 0) <= 0 || (player?.hp?.current ?? 0) >= (player?.hp?.max ?? 0)}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Lancer un dé de vie
          </button>
          {player?.entityClass === "Magicien" && (
            <button
              type="button"
              onClick={() => setArcaneRecoveryOpen(true)}
              disabled={inputBlocked || arcaneRecoveryUsed}
              className="rounded-md border border-violet-500/60 bg-violet-950/30 px-4 py-2 text-sm font-semibold text-violet-100 hover:bg-violet-900/40 disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                arcaneRecoveryUsed
                  ? "Restauration arcanique déjà utilisée aujourd'hui (1/jour)"
                  : "Restauration arcanique (1/jour) — choisir les emplacements à récupérer"
              }
            >
              Restauration arcanique
            </button>
          )}
          <button
            type="button"
            onClick={() => finishShortRest("Le repos court prend fin.")}
            disabled={inputBlocked}
            className="rounded-md border border-emerald-500/50 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-900/50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Reprendre l&apos;aventure
          </button>
        </div>
      )}

      <div className="border-t border-slate-700 p-4 flex gap-2 shrink-0">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            repairMojibakeForDisplay(
              retryCountdown > 0
                  ? `Quota dépassé â€” réessayez dans ${retryCountdown}sâ€¦`
                  : isTyping
                    ? "Le Maître du Jeu réfléchitâ€¦"
                    : isAutoPlayerThinking
                      ? "L'IA joueur réfléchitâ€¦"
                      : pendingRoll && !groupSkillAllRollsRecorded
                        ? "Lancez d'abord le dé demandé par le MJâ€¦"
                        : initiativePhaseActive
                          ? hasLocalInitiativeRoll
                            ? "Initiative envoyée. En attente des autres joueurs…"
                            : waitForGmNarrationForInitiative
                              ? "Attendez la fin de la narration du MJ sur le combat…"
                              : "Lancez d'abord votre initiative (bouton ci-dessus)â€¦"
                          : gameMode === "short_rest"
                            ? "Repos court : lancez un dé de vie ou reprenez l'aventureâ€¦"
                    : !isMyTurn
                      ? "Combat : ce n'est pas votre tour (attendez)..."
                      : "Décrivez votre actionâ€¦ (Entrée pour envoyer)"
            )
          }
          disabled={inputBlocked}
          className="flex-1 rounded-md border border-slate-600 bg-slate-800 px-4 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        />
        {isInCombat && (
          <button
            onClick={handleEndTurn}
            disabled={!isMyTurn || inputBlocked}
            className="rounded-md bg-slate-700 px-4 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-600 active:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Terminer votre tour (les ennemis jouent ensuite)"
          >
            Fin de tour
          </button>
        )}
        <button
          onClick={handleSend}
          disabled={!input.trim() || inputBlocked}
          className="rounded-md bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-500 active:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Envoyer
        </button>
      </div>

      {isGameOver && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center p-6 sm:p-10"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="game-over-title"
          aria-describedby="game-over-desc"
        >
          {/* Fond : vignette + bruit léger + dégradé */}
          <div
            className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_transparent_0%,_rgba(0,0,0,0.85)_55%,_#030203_100%)]"
            aria-hidden
          />
          <div
            className="absolute inset-0 bg-gradient-to-b from-red-950/25 via-black/80 to-black"
            aria-hidden
          />
          <div
            className="absolute inset-0 opacity-[0.07] bg-[url('data:image/svg+xml,%3Csvg viewBox=%220 0 256 256%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22n%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.9%22 numOctaves=%224%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23n)%22/%3E%3C/svg%3E')]"
            aria-hidden
          />

          <div className="game-over-panel-animate relative w-full max-w-lg">
            <div
              className="relative overflow-hidden rounded-3xl border border-red-900/40 bg-gradient-to-b from-zinc-900/95 via-zinc-950/98 to-black shadow-[0_0_0_1px_rgba(127,29,29,0.2),0_25px_80px_-12px_rgba(0,0,0,0.9),0_0_120px_-20px_rgba(185,28,28,0.35)] backdrop-blur-xl"
            >
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-red-500/60 to-transparent" />
              <div className="absolute -top-24 left-1/2 h-48 w-48 -translate-x-1/2 rounded-full bg-red-600/20 blur-3xl" aria-hidden />

              <div className="relative px-8 pb-10 pt-12 text-center sm:px-12 sm:pt-14">
                <p className="mb-2 font-serif text-xs uppercase tracking-[0.35em] text-red-400/90">
                  Fin du voyage
                </p>
                <h2
                  id="game-over-title"
                  className="bg-gradient-to-b from-rose-100 via-red-200 to-red-900/90 bg-clip-text font-serif text-4xl font-bold tracking-tight text-transparent drop-shadow-sm sm:text-5xl md:text-6xl"
                  style={{ WebkitTextFillColor: "transparent" }}
                >
                  Game Over
                </h2>
                <div className="mx-auto mt-6 mb-2 h-px w-24 bg-gradient-to-r from-transparent via-red-700/80 to-transparent" />
                <p
                  id="game-over-desc"
                  className="mx-auto max-w-sm text-sm leading-relaxed text-zinc-400 sm:text-base"
                >
                  Les ténèbres se sont refermées sur votre héros. Une page se tourne — mais une autre
                  aventure peut commencer.
                </p>

                <div className="mt-10 flex flex-col items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      deathNarrationSentRef.current = false;
                      setIsGameOver(false);
                      restartAdventure();
                    }}
                    className="group relative w-full max-w-xs overflow-hidden rounded-2xl bg-gradient-to-r from-red-700 via-red-600 to-rose-700 px-8 py-3.5 text-base font-semibold text-white shadow-lg shadow-red-950/50 transition hover:from-red-600 hover:via-rose-600 hover:to-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
                  >
                    <span className="relative z-10">Recommencer l&apos;aventure</span>
                    <span
                      className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent transition duration-700 group-hover:translate-x-full"
                      aria-hidden
                    />
                  </button>
                  <button
                    type="button"
                    onClick={handleCheatReviveAfterGameOver}
                    className="w-full max-w-xs rounded-2xl border border-red-900/35 bg-red-950/20 px-8 py-3.5 text-base font-semibold text-red-100/90 shadow-[0_0_0_1px_rgba(127,29,29,0.2)] transition hover:bg-red-950/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
                    title="Option triche : revive le personnage joueur (sans reset de progression)"
                  >
                    Revive (triche)
                  </button>
                  <p className="text-[11px] text-zinc-600">
                    Progression réinitialisée · personnage conservé · PV restaurés
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
