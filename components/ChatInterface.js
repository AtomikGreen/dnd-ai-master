"use client";

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { useGame } from "@/context/GameContext";
import { playBip } from "@/lib/sounds";
import { ARMORS, SPELLS, WEAPONS, ROGUE_SNEAK_ATTACK_DICE_BY_LEVEL } from "@/data/srd5";
import { GOBLIN_CAVE, getVisibleExitsForRoom } from "@/data/campaign";
import { BESTIARY } from "@/data/bestiary";
import SceneImage from "./SceneImage";
import { resolveCombatantDisplayName } from "@/lib/combatDisplayName";

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function fmtMod(mod) {
  return mod >= 0 ? `+${mod}` : `${mod}`;
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
  const s = input;

  // Gate: évite toute conversion coûteuse si la chaîne ne ressemble pas à du mojibake.
  const looksMojibake = /(?:Ã|Â|â|ðŸ|�|â†|â€”|â€™|â€˜|â€œ|â€�|â€¦)/.test(s);
  if (!looksMojibake) return input;

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
 * Lance un dé selon la notation "XdY".
 * Retourne { total, rolls, notation } pour l'affichage détaillé.
 * Ex: rollDiceDetailed("2d6") â†’ { total: 9, rolls: [4, 5], notation: "2d6" }
 */
function rollDiceDetailed(notation) {
  const raw = String(notation ?? "1d4").trim();
  const m = raw.match(/^(\d+)d(\d+)$/i) ?? raw.match(/^d(\d+)$/i);
  if (!m) return { total: 1, rolls: [1], notation: raw || "1d4" };
  const count = m.length === 2 ? 1 : parseInt(m[1]);
  const sides = m.length === 2 ? parseInt(m[1]) : parseInt(m[2]);
  if (!Number.isFinite(count) || !Number.isFinite(sides) || count <= 0 || sides <= 0) {
    return { total: 1, rolls: [1], notation: raw || "1d4" };
  }
  const rolls = [];
  for (let i = 0; i < count; i++) rolls.push(Math.floor(Math.random() * sides) + 1);
  return { total: rolls.reduce((a, b) => a + b, 0), rolls, notation: raw };
}

/** Retourne uniquement le total (wrapper simple). */
function rollDice(notation) {
  return rollDiceDetailed(notation).total;
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

/** Union des ids autorisés : salle courante (MJ) + cible de sceneUpdate si présent (même tour JSON). */
function buildAllowedSpawnIdSet(baseRoomId, sceneUpdate) {
  const set = new Set();
  for (const id of encounterSpawnIdsForRoom(baseRoomId)) set.add(id);
  const transitionTid =
    sceneUpdate?.hasChanged && typeof sceneUpdate?.targetRoomId === "string"
      ? sceneUpdate.targetRoomId.trim()
      : null;
  if (transitionTid) {
    for (const id of encounterSpawnIdsForRoom(transitionTid)) set.add(id);
  }
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
  return /arc|arbal|fronde|sarbacane|filet/i.test(String(name ?? ""));
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
  const base = Number(player?.ac ?? 10) || 10;
  const style = player?.fighter?.fightingStyle ?? null;
  if (style !== "Défense") return base;
  // Défense : +1 CA si on porte une armure. On approxime en détectant une armure dans l'inventaire.
  const inv = Array.isArray(player?.inventory) ? player.inventory : [];
  const hasArmor = inv.some((item) => {
    const armor = ARMORS?.[item];
    if (!armor) return false;
    return String(armor.type ?? "").toLowerCase() !== "bouclier";
  });
  return base + (hasArmor ? 1 : 0);
}

/**
 * Formate un jet de dégâts pour le chat.
 * Ex: formatDmgRoll("1d6", [4], 1)  â†’ "1d6 [4] +1 = **5 dégâts**"
 * Ex: formatDmgRoll("1d6", [4,3], 1, true) â†’ "1d6 [4] + 1d6 [3] +1 = **8 dégâts**" (crit)
 */
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
    .replace(/(s['â€™]?(?:effondre|écroule|e?croule)[^.\n]*[.\n]?)/gi, "")
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

function detectSceneTransition(text) {
  const t = String(text ?? "").toLowerCase();
  const wantsExit =
    /\b(sors?|sortir|quitte|quitter|je\s*pars)\b/.test(t);
  if (!wantsExit) return null;
  return { to: "tavern_exterior" };
}

function buildExteriorScene() {
  return {
    scene:
      "Extérieur de la Taverne du Sanglier Borgne. " +
      "Une ruelle froide et humide sous un ciel bas. " +
      "Les pavés sont luisants de pluie, et l'air sent la suie et le crottin. " +
      "Des caisses vides et des poubelles s'entassent près du mur. " +
      "Aucune présence animale évidente â€” seulement le vent et le craquement des enseignes.",
    image: "/TaverneSanglierBorgne.jpg",
    entities: [
      {
        id: "porte_taverne",
        name: "Porte de la taverne",
        type: "object",
        race: "â€”",
        entityClass: "Décor",
        cr: 0,
        visible: true,
        isAlive: true,
        hp: null,
        ac: null,
        stats: null,
        attackBonus: null,
        damageDice: null,
        damageBonus: null,
        description: "Porte en bois sombre, ferrée, qui grince quand on la pousse.",
      },
      {
        id: "ruelle",
        name: "Ruelle",
        type: "object",
        race: "â€”",
        entityClass: "Lieu",
        cr: 0,
        visible: true,
        isAlive: true,
        hp: null,
        ac: null,
        stats: null,
        attackBonus: null,
        damageDice: null,
        damageBonus: null,
        description: "Ruelle humide, pavés glissants, coins d'ombre propices aux guetteurs.",
      },
      {
        id: "poubelles",
        name: "Poubelles",
        type: "object",
        race: "â€”",
        entityClass: "Décor",
        cr: 0,
        visible: true,
        isAlive: true,
        hp: { current: 6, max: 6 },
        ac: 10,
        stats: null,
        attackBonus: null,
        damageDice: null,
        damageBonus: null,
        description: "Tas de déchets et de caisses cassées, odeur âcre et rance.",
      },
      {
        id: "decombres",
        name: "Décombres",
        type: "object",
        race: "â€”",
        entityClass: "Décor",
        cr: 0,
        visible: true,
        isAlive: true,
        hp: { current: 8, max: 8 },
        ac: 10,
        stats: null,
        attackBonus: null,
        damageDice: null,
        damageBonus: null,
        description: "Tas de planches et de caisses brisées, un abri parfait pour quelque chose de discret.",
      },
      {
        id: "chat_gris",
        name: "Chat gris",
        type: "npc",
        race: "Chat",
        entityClass: "Animal errant",
        cr: 0,
        visible: false,
        isAlive: true,
        hp: { current: 2, max: 2 },
        ac: 12,
        stats: { FOR: 3, DEX: 15, CON: 10, INT: 2, SAG: 12, CHA: 7 },
        attackBonus: 0,
        damageDice: "1d1",
        damageBonus: 0,
        description: "Un chat gris discret, caché derrière les décombres. Il observe en silence.",
        stealthDc: 15,
      },
    ],
  };
}

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

function getCombatantKnownSpells(combatant) {
  return Array.isArray(combatant?.selectedSpells) ? combatant.selectedSpells.filter(Boolean) : [];
}

function computeSpellAttackBonus(combatant) {
  if (typeof combatant?.spellAttackBonus === "number" && Number.isFinite(combatant.spellAttackBonus)) {
    return combatant.spellAttackBonus;
  }
  const prof = proficiencyBonusFromLevel(combatant?.level);
  const classe = String(combatant?.entityClass ?? "").toLowerCase();
  let key = "CHA";
  if (classe.includes("magicien")) key = "INT";
  else if (classe.includes("clerc") || classe.includes("druide") || classe.includes("paladin") || classe.includes("rôdeur") || classe.includes("rodeur")) key = "SAG";
  // bardes / ensorceleurs / occultistes restent basés sur CHA
  const base = abilityMod(combatant?.stats?.[key]);
  return base + prof;
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
  if (!turnResources) return true;
  if (kind === "action") return !!turnResources.action;
  if (kind === "bonus") return !!turnResources.bonus;
  if (kind === "reaction") return !!turnResources.reaction;
  return true;
}

function consumeResource(setTurnResources, gameMode, kind) {
  if (gameMode !== "combat") return;
  setTurnResources((prev) => {
    if (!prev) return prev;
    if (kind === "action" && prev.action) return { ...prev, action: false };
    if (kind === "bonus" && prev.bonus) return { ...prev, bonus: false };
    if (kind === "reaction" && prev.reaction) return { ...prev, reaction: false };
    return prev;
  });
}

// Mouvement "théâtre de l'esprit" : quand le joueur s'approche / rejoint la cible
// au contact, on consomme le déplacement (1 seule fois par tour).
function consumeMovementResource(setTurnResources) {
  setTurnResources((prev) => {
    if (!prev) return prev;
    return { ...prev, movement: false };
  });
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
  return { kind: "weapon", weapon };
}

/**
 * Moteur d'intentions combat (Command pattern). Ne pas appeler l'IA en cas d'échec.
 * @returns {{ ok: false, userMessage: string } | { ok: true, pendingRoll: object|null, runSpellSave?: { spellName: string, target: object } }}
 */
function executeCombatActionIntent(intent, ctx) {
  const fail = (userMessage) => ({ ok: false, userMessage });
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
  } = ctx;

  const findLivingTarget = (id) => {
    if (!id) return null;
    return postEntities.find((e) => e.id === id && e.visible && e.isAlive) ?? null;
  };

  const { type, targetId, itemName } = intent;
  let effectiveMode = gameMode;
  const canOpenCombatFromExploration =
    gameMode !== "combat" && ["attack", "spell", "move_and_attack"].includes(type);

  if (gameMode !== "combat" && type !== "second_wind" && !canOpenCombatFromExploration) {
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
      return fail("Action impossible : vous n'avez pas la possibilité de faire ca.");
    }
    if (player?.entityClass !== "Guerrier") {
      return fail("Action impossible : vous n'avez pas la possibilité de faire ca.");
    }
    const remaining = player?.fighter?.resources?.secondWind?.remaining ?? 0;
    if (remaining <= 0) {
      return fail("Action impossible : vous n'avez pas la possibilité de faire ca.");
    }

    // Consomme la ressource : Action bonus
    consumeRes(setTurnResources, gameMode === "combat" ? "combat" : "exploration", "bonus");

    const r = rollDiceDetailed("1d10");
    const heal = Math.max(1, r.total + (player.level ?? 1));
    const hpBefore = player.hp?.current ?? 0;
    const hpAfter = Math.min(player.hp?.max ?? hpBefore, hpBefore + heal);

    setHp?.(hpAfter);
    if (playerHpRef?.current != null) playerHpRef.current = hpAfter;

    updatePlayer?.({
      fighter: {
        ...(player.fighter ?? {}),
        resources: {
          ...(player.fighter?.resources ?? {}),
          secondWind: { max: 1, remaining: remaining - 1 },
        },
      },
    });

    addMessage(
      "ai",
      `🌂 Second souffle — 1d10 [${r.rolls.join("+")}] + niveau (${player.level}) = **${heal} PV** → Vous : **${hpAfter}/${player.hp.max} HP**`,
      "dice",
      makeMsgId()
    );
    addMessage(
      "ai",
      `[DEBUG] Second souffle (moteur)\n` +
        safeJson({
          rolls: r.rolls,
          heal,
          hpBefore,
          hpAfter,
          remainingBefore: remaining,
          remainingAfter: remaining - 1,
        }),
      "debug",
      makeMsgId()
    );

    return { ok: true, pendingRoll: null };
  }

  if (type === "impossible") {
    // Intent impossible (décidé par l'IA d'après les règles + ressources fournies).
    // Le but est d'afficher un message d'erreur générique côté UI.
    return fail("Action impossible : vous n'avez pas la possibilité de faire ca.");
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
      return fail("Action impossible : vous n'avez plus d'action disponible.");
    }
    setHasDisengagedThisTurn(true);
    consumeRes(setTurnResources, "combat", "action");
    clearMeleeFor("player");
    if (!parserMinimalNarration) {
      addMessage(
        "ai",
        "Vous vous désengagez et reculez prudemment (Action).",
        undefined,
        makeMsgId()
      );
    }
    return { ok: true, pendingRoll: null };
  }

  if (type === "dodge") {
    if (!turnResources?.action) {
      return fail("Action impossible : vous n'avez plus d'action disponible.");
    }
    consumeRes(setTurnResources, "combat", "action");
    if (!parserMinimalNarration) {
      addMessage(
        "ai",
        "Vous adoptez une posture défensive (Esquiver — Action).",
        "meta",
        makeMsgId()
      );
    }
    return { ok: true, pendingRoll: null };
  }

  if (type === "move" && !targetId) {
    if (!turnResources?.movement) {
      return fail("Action impossible : vous n'avez pas la possibilité de faire ca.");
    }
    consumeMovementResource(setTurnResources);
    if (!parserMinimalNarration) {
      addMessage(
        "ai",
        "Vous vous déplacez pour vous repositionner dans la zone de combat.",
        "dice",
        makeMsgId()
      );
    }
    return { ok: true, pendingRoll: null };
  }

  if (!targetId) {
    return fail("Action impossible : aucune cible indiquée.");
  }
  const targetEnt = findLivingTarget(targetId);
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
    if (getMeleeWith("player").includes(targetId)) return { ok: true };
    if (!turnResources?.movement) {
      return {
        ok: false,
        userMessage: "Action impossible : vous n'avez pas la possibilité de faire ca.",
      };
    }
    consumeMovementResource(setTurnResources);
    addMeleeMutual("player", targetId);
    // Afficher le déplacement en "bulle combat" (style identique aux jets `dice`).
    addMessage("ai", "Vous vous déplacez au contact de la cible.", "dice", makeMsgId());
    return { ok: true };
  };

  const buildPendingAfterItem = (resolved, opts = {}) => {
    const assumeInMeleeWithTarget = opts.assumeInMeleeWithTarget === true;
    if (resolved.kind === "error") return fail(resolved.message);
    if (!turnResources?.action) {
      return fail("Action impossible : vous n'avez plus d'action disponible.");
    }

    if (resolved.kind === "spell") {
      const spell = SPELLS[resolved.spellName];
      const resourceKind = resourceForCastingTime(spell?.castingTime);
      if (!hasResource(turnResources, effectiveMode, resourceKind)) {
        const label =
          resourceKind === "bonus"
            ? "Action bonus"
            : resourceKind === "reaction"
              ? "Réaction"
              : "Action";
        return fail(`Action impossible : ressource ${label} déjà utilisée ce tour.`);
      }
      if (spell?.save) {
        return { ok: true, pendingRoll: null, runSpellSave: { spellName: resolved.spellName, target: targetEnt } };
      }
      const meleeWith = getMeleeWith("player");
      const inMeleeWithTarget = meleeWith.includes(targetId) || assumeInMeleeWithTarget;
      const rangedSpellLike = meleeWith.length > 0 && !inMeleeWithTarget;
      if (!hasDisengagedThisTurn && rangedSpellLike) {
        return fail(
          "Action impossible : attaque à distance en mêlée — désengagez-vous ou rapprochez-vous de la cible visée."
        );
      }
      const pendingRoll = {
        kind: "attack",
        stat: "CHA",
        totalBonus: computeSpellAttackBonus(player),
        raison: `Lancer ${resolved.spellName} sur ${targetEnt.name}`,
        targetId: targetEnt.id,
        weaponName: resolved.spellName,
      };
      return { ok: true, pendingRoll };
    }

    const weapon = resolved.weapon;
    const wn = String(weapon.name ?? "");
    const ranged = isRangedWeaponName(wn) || /arc|arbal|fronde/i.test(wn);
    const meleeWith = getMeleeWith("player");
    const inMeleeWithTarget = meleeWith.includes(targetId) || assumeInMeleeWithTarget;

    if (ranged && !hasDisengagedThisTurn && inMeleeWithTarget) {
      return fail(
        "Action impossible : attaque à distance au corps à corps — désengagez-vous ou utilisez une arme de mêlée."
      );
    }
    const meleeWeapon = !ranged;
    if (meleeWeapon && !inMeleeWithTarget) {
      return fail(
        "Action impossible : vous devez être au contact pour attaquer à la mêlée (déplacez-vous d'abord)."
      );
    }

    const pendingRoll = {
      kind: "attack",
      stat: "FOR",
      totalBonus: weapon.attackBonus,
      raison: `Attaque (${weapon.name}) contre ${targetEnt.name}`,
      targetId: targetEnt.id,
      weaponName: weapon.name,
    };
    return { ok: true, pendingRoll };
  };

  if (type === "move") {
    if (getMeleeWith("player").includes(targetId)) {
      if (!parserMinimalNarration) {
        addMessage("ai", "Vous êtes déjà au contact de cette cible.", undefined, makeMsgId());
      }
      return { ok: true, pendingRoll: null };
    }
    const step = tryEngageMelee();
    if (!step.ok) return fail(step.userMessage);
    return { ok: true, pendingRoll: null };
  }

  if (type === "attack" || type === "spell") {
    const resolved = resolveCombatItemForIntent(type, itemName, player, userContent);
    return buildPendingAfterItem(resolved);
  }

  if (type === "move_and_attack") {
    const resolved = resolveCombatItemForIntent("attack", itemName, player, userContent);
    if (resolved.kind === "error") return fail(resolved.message);

    /** Besoin de rejoindre la cible ce tour (mêlée / sort en jet d'attaque) */
    const needsClosingStep = () => {
      if (getMeleeWith("player").includes(targetId)) return false;
      if (resolved.kind === "weapon") {
        const wn = String(resolved.weapon.name ?? "");
        const ranged = isRangedWeaponName(wn) || /arc|arbal|fronde/i.test(wn);
        return !ranged;
      }
      if (resolved.kind === "spell") {
        const spell = SPELLS[resolved.spellName];
        return !spell?.save;
      }
      return false;
    };

    let assumeInMeleeWithTarget = false;
    if (needsClosingStep()) {
      if (!turnResources?.movement) {
        return fail("Action impossible : vous n'avez pas la possibilité de faire ca.");
      }
      if (!turnResources?.action) {
        return fail("Action impossible : vous n'avez plus d'action.");
      }
      consumeMovementResource(setTurnResources);
      addMeleeMutual("player", targetId);
      const pjName = player?.name ?? "Votre personnage";
      addMessage(
        "ai",
        `${pjName} se déplace au corps à corps de ${targetEnt.name}.`,
        "meta",
        makeMsgId()
      );
      assumeInMeleeWithTarget = true;
    }

    if (resolved.kind === "weapon") {
      const wn = String(resolved.weapon.name ?? "");
      const ranged = isRangedWeaponName(wn) || /arc|arbal|fronde/i.test(wn);
      const meleeWith = getMeleeWith("player");
      const inMeleeWithTarget = meleeWith.includes(targetId) || assumeInMeleeWithTarget;
      if (ranged && !hasDisengagedThisTurn && inMeleeWithTarget) {
        return fail(
          "Action impossible : attaque à distance au corps à corps — désengagez-vous ou utilisez une arme de mêlée."
        );
      }
    } else if (resolved.kind === "spell") {
      const spell = SPELLS[resolved.spellName];
      const meleeWith = getMeleeWith("player");
      const inMeleeWithTarget = meleeWith.includes(targetId) || assumeInMeleeWithTarget;
      if (!spell?.save && !hasDisengagedThisTurn && meleeWith.length > 0 && !inMeleeWithTarget) {
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

function resourceForCastingTime(castingTime) {
  const t = String(castingTime ?? "").toLowerCase();
  if (t.includes("bonus")) return "bonus";
  if (t.includes("réaction") || t.includes("reaction")) return "reaction";
  return "action";
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
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function inferBestiaryTemplateIdForEntity(entityLike) {
  const explicitTemplateId =
    typeof entityLike?.templateId === "string" && entityLike.templateId.trim()
      ? entityLike.templateId.trim()
      : "";
  if (explicitTemplateId && BESTIARY?.[explicitTemplateId]) return explicitTemplateId;

  const rawId = String(entityLike?.id ?? "").trim().toLowerCase();
  if (rawId) {
    const withoutNumericSuffix = rawId.replace(/_\d+$/g, "");
    if (BESTIARY?.[withoutNumericSuffix]) return withoutNumericSuffix;
    for (const token of withoutNumericSuffix.split("_").filter(Boolean)) {
      if (BESTIARY?.[token]) return token;
    }
  }

  const nameTokens = normalizeFr(entityLike?.name ?? "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
  for (const token of nameTokens) {
    if (BESTIARY?.[token]) return token;
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
    addMessage("user", text, undefined, makeMsgId());
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
    addMessage("user", text, undefined, makeMsgId());
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

  const spell = SPELLS?.[spellName];
  if (!spell) return false;

  // Afficher le message du joueur tel quel, même si la résolution est 100% moteur.
  // (Sinon l'action "disparaît" visuellement car callApi n'est appelé que sur le message ðŸŽ².)
  addMessage("user", text, undefined, makeMsgId());

  // Ressource (Action/Bonus/Réaction) selon castingTime
  const resourceKind = resourceForCastingTime(spell?.castingTime);
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
  if (spell?.save) {
    const saveKey = spell.save;
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
    consumeResource(setTurnResources, "combat", resourceKind);

    // Message moteur (ðŸŽ² réservé au moteur)
    const bonusStr = fmtMod(saveBonus);
    const saveLine =
      nat === 20
        ? `Nat **20** ðŸ’¥ (réussite automatique)`
        : nat === 1
        ? `Nat **1** ðŸ’€ (échec automatique)`
        : `Nat ${nat} ${bonusStr} = **${total}** vs DD ${dc}`;
    const outcome = succeeded ? "âœ” Réussite â€” dégâts réduits." : "âœ– Ã‰chec â€” dégâts complets.";
    const dmgDetail = `${dmgNotation} [${r.rolls.join("+")}]${succeeded ? " â†’ moitié dégâts" : ""}`;
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

// ---------------------------------------------------------------------------
// Composant principal
// ---------------------------------------------------------------------------

export default function ChatInterface() {
  const {
    messages, addMessage, appendSceneImagePendingSlot, updateMessage, removeMessagesByIds,
    player, setHp, setPlayer, updatePlayer,
    worldTimeMinutes, setWorldTimeMinutes,
    pendingRoll, setPendingRoll,
    currentScene, setCurrentScene,
    currentSceneName,
    sceneVersion,
    currentRoomId, setCurrentRoomId,
    entities,
    applyEntityUpdates, replaceEntities,
    rememberRoomEntitiesSnapshot, takeEntitiesForRoom, getRoomMemory, appendRoomMemory, setRoomMemoryText,
    setGameMode, setCombatOrder,
    gameMode,
    combatOrder, combatTurnIndex, setCombatTurnIndex,
    awaitingPlayerInitiative, npcInitiativeDraft, commitPlayerInitiativeRoll,
    registerCombatNextTurn, nextTurn,
    hasDisengagedThisTurn, setHasDisengagedThisTurn,
    turnResources, setTurnResources,
    getMeleeWith, addMeleeMutual, removeFromMelee, clearMeleeFor, setReactionFor, hasReaction, initCombatReactions,
    aiProvider, setAiProvider,
    autoPlayerEnabled, setAutoPlayerEnabled,
    autoRollEnabled, setAutoRollEnabled,
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
  const [apiLog, setApiLog]             = useState(null); // { sent, received }
  const [movementGate, setMovementGate] = useState(null); // { text: string, hostileIds: string[] }
  const [opportunityAttackPrompt, setOpportunityAttackPrompt] = useState(null); // { reactorId, targetId, reactorName, targetName }
  const [showActionsHelp, setShowActionsHelp] = useState(false);
  const [fullImageUrl, setFullImageUrl] = useState(null);
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
  const [waitForGmNarrationForInitiative, setWaitForGmNarrationForInitiative] = useState(false);
  const lastNaturalPlayerInputRef = useRef("");
  const waitForGmNarrationForInitiativeLiveRef = useRef(waitForGmNarrationForInitiative);
  useEffect(() => {
    waitForGmNarrationForInitiativeLiveRef.current = waitForGmNarrationForInitiative;
  }, [waitForGmNarrationForInitiative]);
  const [isGameOver, setIsGameOver] = useState(false);
  const isGameOverRef = useRef(false);
  useEffect(() => {
    isGameOverRef.current = isGameOver;
  }, [isGameOver]);
  const deathNarrationSentRef = useRef(false);
  const bottomRef   = useRef(null);
  const countdownRef = useRef(null);
  const turnResourcesRef = useRef(turnResources);
  const lastImageGenKeyRef = useRef(null);
  const narratorImageBudgetByRoomRef = useRef({});
  const latencyWindowRef = useRef([]); // number[] (ms)
  // Ref pour avoir toujours les HP Ã  jour dans simulateEnemyTurns (évite les stale closures)
  const playerHpRef = useRef(player.hp.current);
  useEffect(() => { playerHpRef.current = player.hp.current; }, [player.hp.current]);
  useEffect(() => { turnResourcesRef.current = turnResources; }, [turnResources]);
  // Setter "synchrone" : met aussi le ref à jour immédiatement
  // (important pour que l'auto-joueur reçoive les ressources ACTUELLES du tour).
  const setTurnResourcesSynced = useCallback(
    (updater) => {
      setTurnResources((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        turnResourcesRef.current = next;
        return next;
      });
    },
    [setTurnResources]
  );
  const grantPlayerTurnResources = useCallback(() => {
    setReactionFor("player", true);
    setTurnResourcesSynced({
      action: true,
      bonus: true,
      reaction: true,
      movement: true,
    });
  }, [setReactionFor, setTurnResourcesSynced]);
  const lockPlayerTurnResourcesForSurprise = useCallback(() => {
    setReactionFor("player", false);
    setTurnResourcesSynced({
      action: false,
      bonus: false,
      reaction: false,
      movement: false,
    });
  }, [setReactionFor, setTurnResourcesSynced]);
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
  const shortRestStateRef = useRef(shortRestState);
  useEffect(() => { shortRestStateRef.current = shortRestState; }, [shortRestState]);

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
    if (roll.kind === "death_save") return "Jet de sauvegarde contre la mort";
    if (roll.kind === "hit_die") return "Dé de vie";
    const label = roll.skill ? `Jet de ${roll.skill}` : `Jet de ${roll.stat}`;
    return shouldHidePendingRollReason(roll) ? label : `${label} (${roll.raison})`;
  }

  const awaitingPlayerInitiativeRef = useRef(awaitingPlayerInitiative);
  useEffect(() => {
    awaitingPlayerInitiativeRef.current = awaitingPlayerInitiative;
  }, [awaitingPlayerInitiative]);

  /** Évite les closures stales (auto-joueur / setTimeout) sur le jet en attente */
  const pendingRollRef = useRef(pendingRoll);
  useEffect(() => {
    pendingRollRef.current = pendingRoll;
  }, [pendingRoll]);
  useEffect(() => {
    if (gameMode === "combat") return;
    grantPlayerTurnResources();
    if (player?.surprised === true) {
      updatePlayer({ surprised: false });
    }
  }, [gameMode, grantPlayerTurnResources, player?.surprised, updatePlayer]);

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
    aiProvider,
    debugMode,
  };

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
      const pool = Array.isArray(entitiesOverride) ? entitiesOverride : entities;
      return pool.find((entity) => entity?.id === combatantId) ?? null;
    },
    [entities, player]
  );

  const getCombatantArmorClass = useCallback(
    (combatant) => {
      if (!combatant) return 10;
      if (combatant.id === "player") return effectivePlayerArmorClass(player);
      return Number(combatant?.ac ?? 10) || 10;
    },
    [player]
  );

  const getCombatantCurrentHp = useCallback((combatant) => {
    if (!combatant?.hp) return null;
    if (combatant.id === "player") {
      return playerHpRef.current ?? combatant.hp.current ?? null;
    }
    return combatant.hp.current ?? null;
  }, []);

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
      } else if (hpAfter <= 0) {
        applyEntityUpdates([{ id: combatant.id, action: "kill" }]);
      } else {
        applyEntityUpdates([
          {
            id: combatant.id,
            action: "update",
            hp: { current: hpAfter, max: maxHp },
          },
        ]);
      }
      return { hpAfter, maxHp };
    },
    [applyEntityUpdates, restorePlayerToConsciousness, setPlayer]
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
    const hpBefore = target.hp.current ?? 0;
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
    const nextValue = worldTimeMinutes + safeMinutes;
    setWorldTimeMinutes(nextValue);
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
    setShortRestState(null);
    setGameMode("exploration", entities, { force: true });
    pendingRollRef.current = null;
    setPendingRoll(null);
    if (reason) {
      addMessage("ai", reason, "meta", makeMsgId());
    }
  }

  function startShortRest() {
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
    if ((player?.hp?.current ?? 0) <= 0 || isPlayerDeadNow()) {
      addMessage("ai", "Impossible de prendre un repos court à 0 PV ou mort.", "intent-error", makeMsgId());
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
    setGameMode("short_rest", entities, { force: true });
    setShortRestState({ startedAtMinute: nextMinute, spentDice: 0 });
    pendingRollRef.current = null;
    setPendingRoll(null);
    addMessage(
      "ai",
      `Vous prenez un repos court d'une heure.`,
      "meta",
      makeMsgId()
    );
    return true;
  }

  function startLongRest() {
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
    const nextMinute = advanceWorldClock(8 * 60);
    setPlayer((prev) => {
      const next = restoreLongRestPlayer(prev, nextMinute);
      playerHpRef.current = next?.hp?.max ?? playerHpRef.current;
      return next;
    });
    finishShortRest();
    addMessage(
      "ai",
      `Vous prenez un repos long de huit heures. Vos PV sont entièrement restaurés, vous récupérez vos ressources de repos long et la moitié de vos dés de vie dépensés.`,
      "meta",
      makeMsgId()
    );
    return true;
  }

  function triggerHitDieRollFromShortRest() {
    if (gameMode !== "short_rest") {
      addMessage("ai", "Commencez d'abord par prendre un repos court.", "intent-error", makeMsgId());
      return true;
    }
    if (!shortRestStateRef.current) {
      const seed = { startedAtMinute: worldTimeMinutes, spentDice: 0 };
      shortRestStateRef.current = seed;
      setShortRestState(seed);
    }
    const remainingHitDice = player?.hitDiceRemaining ?? 0;
    if (remainingHitDice <= 0) {
      addMessage("ai", "Vous n'avez plus de dés de vie à dépenser pendant ce repos court.", "intent-error", makeMsgId());
      return true;
    }
    if ((player?.hp?.current ?? 0) >= (player?.hp?.max ?? 0)) {
      addMessage("ai", "Vous êtes déjà à vos PV maximum.", "intent-error", makeMsgId());
      return true;
    }
    const pendingHitDieRoll = {
      kind: "hit_die",
      stat: "CON",
      totalBonus: getPlayerConModifier(),
      raison: `Dé de vie (${player?.hitDie ?? "d8"}) pendant le repos court`,
      engineContext: {
        kind: "short_rest_hit_die",
        hitDie: player?.hitDie ?? "d8",
      },
    };
    pendingRollRef.current = pendingHitDieRoll;
    setPendingRoll(pendingHitDieRoll);
    return true;
  }

  function tryHandleNaturalLanguageRest(text, msgType, isDebug, overrides = null) {
    if (msgType || isDebug || overrides?.bypassIntentParser === true) return false;
    const raw = String(text ?? "").trim();
    if (!raw) return false;
    const normalized = normalizeFr(raw);

    if (shortRestStateRef.current) {
      if (
        /\b(j'?arrete|j'?arr[eê]te|ca suffit|ça suffit|fin du repos|termine le repos|stop rest|end rest)\b/.test(normalized)
      ) {
        finishShortRest("Le repos court prend fin.");
        return true;
      }
      if (
        /\b(de de vie|des de vie|hit die|hit dice|encore un|encore une|un autre|je depense|je lance|je roule)\b/.test(normalized)
      ) {
        return triggerHitDieRollFromShortRest();
      }
    }

    if (shortRestStateRef.current) {
      finishShortRest("Le repos court est interrompu.");
    }
    return false;
  }

  useEffect(() => {
    const deathState = getPlayerDeathStateSnapshot();
    if (
      deathState.dead === true ||
      deathState.stable !== true ||
      deathState.autoRecoverAtMinute == null ||
      (playerHpRef.current ?? player?.hp?.current ?? 0) > 0 ||
      worldTimeMinutes < deathState.autoRecoverAtMinute
    ) {
      return;
    }
    restorePlayerToConsciousness(1);
    addMessage(
      "ai",
      `Après plusieurs heures de repos involontaire, vous reprenez conscience avec **1 PV**. Horloge : **${formatWorldTimeLabel(worldTimeMinutes)}**.`,
      "meta",
      makeMsgId()
    );
  }, [addMessage, player, restorePlayerToConsciousness, worldTimeMinutes]);

  /**
   * Index de tour combat : mis à jour au rendu ET de façon synchrone via commitCombatTurnIndex.
   * Évite la course où await parse-intent reprend avant le re-render après setCombatTurnIndex
   * (ex. fin du tour ennemi → tour joueur alors que le closure voit encore l’ancien index).
   */
  const combatTurnIndexLiveRef = useRef(combatTurnIndex);
  combatTurnIndexLiveRef.current = combatTurnIndex;

  function commitCombatTurnIndex(next) {
    combatTurnIndexLiveRef.current = next;
    setCombatTurnIndex(next);
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
    const combatant = pool.find((entity) => entity?.id === combatantId) ?? null;
    return combatant?.isAlive === true;
  }

  function hasLivingPlayerCombatant(currentEntities = null) {
    if (!isPlayerDeadNow()) return true;
    const pool = Array.isArray(currentEntities) ? currentEntities : entities;
    return pool.some((combatant) =>
      combatant?.id !== "player" &&
      combatant?.isAlive === true &&
      combatantControllerValue(combatant) === "player"
    );
  }

  function combatantControllerValue(combatant) {
    if (!combatant) return null;
    if (combatant.controller === "player" || combatant.controller === "ai") {
      return combatant.controller;
    }
    if (combatant.id === "player" || combatant.type === "player") return "player";
    return "ai";
  }

  function controllerForCombatantId(combatantId, entitiesOverride = null) {
    if (!combatantId) return null;
    if (combatantId === "player") return "player";
    const pool = Array.isArray(entitiesOverride) ? entitiesOverride : entities;
    const combatant = pool.find((entity) => entity?.id === combatantId) ?? null;
    return combatantControllerValue(combatant);
  }

  function isPlayerTurnNow(snapshot = null) {
    const snap = snapshot ?? gameStateRef.current;
    const mode = snap?.gameMode ?? gameMode;
    if (mode !== "combat") return true;
    if (!hasLivingPlayerCombatant(snap?.entities ?? null)) return false;
    if (awaitingPlayerInitiativeRef.current) return false;
    const order = Array.isArray(snap?.combatOrder) ? snap.combatOrder : combatOrder;
    if (!order.length) return false;
    const activeEntry = order[combatTurnIndexLiveRef.current];
    return controllerForCombatantId(activeEntry?.id, snap?.entities ?? null) === "player";
  }

  async function preparePlayerTurnStartState() {
    const hpCurrent = playerHpRef.current ?? player?.hp?.current ?? 0;
    const deathState = getPlayerDeathStateSnapshot();
    if (deathState.dead) return true;
    if (hpCurrent > 0) return false;

    if (deathState.stable) {
      addMessage(
        "ai",
        `${player?.name ?? "Vous"} demeure inconscient mais stabilisé à **0 PV**.`,
        "turn-end",
        makeMsgId()
      );
      addMessage("ai", "", "turn-divider", makeMsgId());
      await nextTurn();
      return true;
    }

    const deathSaveRoll = {
      kind: "death_save",
      stat: "CON",
      totalBonus: 0,
      raison: "Jet de sauvegarde contre la mort",
      engineContext: { kind: "death_save" },
    };
    pendingRollRef.current = deathSaveRoll;
    setPendingRoll(deathSaveRoll);
    addMessage(
      "ai",
      `🎲 ${player?.name ?? "Vous"} êtes à **0 PV**. Lancez maintenant un **jet de sauvegarde contre la mort**.`,
      "meta",
      makeMsgId()
    );
    return true;
  }

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
  const PARSE_INTENT_TIMEOUT_MS = 120000;

  /**
   * Après sceneUpdate.hasChanged, le client enchaîne avec [SceneEntered] en setTimeout(0).
   * Le callApi "parent" a déjà libéré apiProcessingDepthRef avant ce second appel :
   * on bloque l'auto-joueur jusqu'à la fin complète du traitement [SceneEntered].
   */
  const sceneEnteredPipelineDepthRef = useRef(0);

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

    if (!hp && !inventoryTouched && !hitDiceTouched) return null;
    return {
      action: "update",
      id: "player",
      ...(hp ? { hp } : {}),
      ...(inventoryTouched ? { inventory: nextInventory } : {}),
      ...(hitDiceRemainingOut !== undefined ? { hitDiceRemaining: hitDiceRemainingOut } : {}),
      ...(hitDiceTotalOut !== undefined ? { hitDiceTotal: hitDiceTotalOut } : {}),
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

  function applyGodmodeResponse(pack, originalCommand) {
    const teleport = pack?.teleport && typeof pack.teleport === "object" ? pack.teleport : null;
    const roomMemoryOps = Array.isArray(pack?.roomMemoryOps) ? pack.roomMemoryOps : [];
    const chatHistoryPatch =
      pack?.chatHistoryPatch && typeof pack.chatHistoryPatch === "object" ? pack.chatHistoryPatch : null;
    const rawEntityUpdates = Array.isArray(pack?.entityUpdates) ? pack.entityUpdates : [];
    const playerUpdate = buildGodmodePlayerUpdate(pack?.playerPatch);
    const entityUpdatesForApply = playerUpdate ? [...rawEntityUpdates, playerUpdate] : rawEntityUpdates;

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

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping, isAutoPlayerThinking, pendingRoll]);

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
          120000,
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
    try {
      const enemyWeapons = Array.isArray(enemy.weapons) ? enemy.weapons : [];
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
      const hasWeaponAttackOption =
        enemyWeapons.length > 0 || enemy.attackBonus != null || !!enemy.damageDice;
      const body = {
        provider: aiProvider,
        enemy: {
          id: enemy.id,
          name: enemy.name,
          type: enemy.type,
          entityClass: enemy.entityClass ?? "",
          surprised: !!enemy.surprised,
          hp: enemy.hp,
          ac: enemy.ac ?? null,
          stats: enemy.stats ?? null,
          attackBonus: enemy.attackBonus ?? null,
          damageDice: enemy.damageDice ?? null,
          damageBonus: enemy.damageBonus ?? null,
          weapons: enemyWeapons,
          selectedSpells: getCombatantKnownSpells(enemy),
          spellAttackBonus: computeSpellAttackBonus(enemy),
          spellSaveDc: computeSpellSaveDC(enemy),
          features: Array.isArray(enemy.features) ? enemy.features : [],
          description: enemy.description ?? "",
          visible: enemy.visible,
          isAlive: enemy.isAlive,
        },
        players: [
          {
            id: "player",
            hp: { current: playerHpRef.current, max: player.hp.max },
            ac: effectivePlayerArmorClass(player),
            position: context?.playerPosition ?? "theater_of_mind",
            distance: context?.distance ?? "unknown",
          },
        ],
        battleState: {
          gameMode,
          engagedWith: getMeleeWith(enemy.id),
          inMelee: getMeleeWith(enemy.id).includes("player"),
          playerCanOpportunityAttack:
            hasReaction("player") && !!turnResourcesRef.current?.reaction,
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
      const { res, data } = await fetchJsonWithTimeout(
        "/api/enemy-tactics",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        60000,
        "enemy-tactics"
      );
      if (!res.ok) throw new Error(data?.details ?? data?.error ?? `Enemy tactics failed (${res.status})`);
      return data;
    } catch (err) {
      markFlowFailure(
        `Enemy tactics indisponible: ${String(err?.message ?? err)}`,
        { kind: "enemy-tactics", enemyId: enemy?.id ?? null }
      );
      throw err;
    }
  }

  async function resolvePlayerOpportunityAttack(target) {
    if (!turnResourcesRef.current?.reaction || !hasReaction("player")) {
      addMessage(
        "ai",
        "Vous ne pouvez pas effectuer d'attaque d'opportunité (réaction indisponible).",
        undefined,
        makeMsgId()
      );
      return { performed: false, targetAlive: target?.isAlive !== false };
    }
    const weapon = player?.weapons?.find((w) => !isRangedWeaponName(w?.name ?? "")) ?? player?.weapons?.[0];
    if (!weapon) {
      addMessage("ai", "Aucune arme de mêlée disponible pour l'attaque d'opportunité.", undefined, makeMsgId());
      return { performed: false, targetAlive: target?.isAlive !== false };
    }
    consumeResource(setTurnResources, "combat", "reaction");
    setReactionFor("player", false);
    const targetAc = target.ac ?? 10;
    const nat = Math.floor(Math.random() * 20) + 1;
    const atkBonus = weapon.attackBonus ?? 0;
    const atkTotal = nat + atkBonus;
    const dice = weapon.damageDice ?? "1d4";
    const dmgBonus = weapon.damageBonus ?? 0;
    let content;
    if (nat === 1) {
      content = `⚔️ Attaque d'opportunité (${weapon.name} → ${target.name}) — Nat 1 ! Fumble.`;
    } else if (nat === 20) {
      const r1 = rollDiceDetailed(dice);
      const r2 = rollDiceDetailed(dice);
      const dmg = Math.max(1, r1.total + r2.total + dmgBonus);
      const hpBefore = target.hp?.current ?? 0;
      const hpAfter = Math.max(0, hpBefore - dmg);
      applyEntityUpdates([{ id: target.id, action: "update", hp: { ...target.hp, current: hpAfter } }]);
      if (hpAfter <= 0) applyEntityUpdates([{ id: target.id, action: "kill" }]);
      content = `⚔️ Attaque d'opportunité (${weapon.name} → ${target.name}) — Nat 20 ! Critique. ${dmg} dégâts.`;
    } else if (atkTotal >= targetAc) {
      const r = rollDiceDetailed(dice);
      const dmg = Math.max(1, r.total + dmgBonus);
      const hpBefore = target.hp?.current ?? 0;
      const hpAfter = Math.max(0, hpBefore - dmg);
      applyEntityUpdates([{ id: target.id, action: "update", hp: { ...target.hp, current: hpAfter } }]);
      if (hpAfter <= 0) applyEntityUpdates([{ id: target.id, action: "kill" }]);
      content = `⚔️ Attaque d'opportunité (${weapon.name} → ${target.name}) — Touché ! ${dmg} dégâts.`;
    } else {
      content = `⚔️ Attaque d'opportunité (${weapon.name} → ${target.name}) — Raté.`;
    }
    addMessage("ai", content, "enemy-turn", makeMsgId());
    const liveTarget = getRuntimeCombatant(target.id);
    return { performed: true, targetAlive: liveTarget?.isAlive !== false };
  }

  function pickCombatantOpportunityWeapon(combatant) {
    if (!combatant) return null;
    const combatantWeapons = Array.isArray(combatant.weapons) ? combatant.weapons : [];
    const meleeWeapon =
      combatantWeapons.find((weapon) => !isRangedWeaponName(weapon?.name ?? "") && weapon?.kind !== "ranged") ??
      null;
    if (meleeWeapon) return meleeWeapon;
    if (combatant.attackBonus != null || combatant.damageDice || combatant.damageBonus != null) {
      return {
        name: "Attaque d'opportunité",
        attackBonus: combatant.attackBonus ?? 0,
        damageDice: combatant.damageDice ?? "1d4",
        damageBonus: combatant.damageBonus ?? 0,
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
      { type: "reaction", name: chosenWeapon.name, target: target.id }
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

  async function settlePlayerOpportunityAttackPrompt(choice) {
    const prompt = opportunityAttackPrompt;
    const resolver = opportunityAttackPromptResolverRef.current;
    opportunityAttackPromptResolverRef.current = null;
    setOpportunityAttackPrompt(null);
    if (!prompt || typeof resolver !== "function") return;

    const target = getRuntimeCombatant(prompt.targetId);
    if (choice === "attack" && target?.isAlive !== false) {
      const result = await resolvePlayerOpportunityAttack(target);
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

  async function processOpportunityAttacksForLeavingCombatant(movingCombatantId, reactorIds = []) {
    for (const reactorId of Array.isArray(reactorIds) ? reactorIds : []) {
      const mover = getRuntimeCombatant(movingCombatantId);
      const reactor = getRuntimeCombatant(reactorId);
      if (!mover || mover.isAlive === false) {
        if (reactorId) removeFromMelee(movingCombatantId, reactorId);
        return false;
      }
      if (!reactor || reactor.isAlive === false) {
        if (reactorId) removeFromMelee(movingCombatantId, reactorId);
        continue;
      }

      let result = { performed: false, targetAlive: mover.isAlive !== false };
      if (reactor.id === "player" || controllerForCombatantId(reactor.id) === "player") {
        if (!turnResourcesRef.current?.reaction || !hasReaction("player")) {
          addMessage(
            "ai",
            `⚔️ ${player?.name ?? "Vous"} ne pouvez pas effectuer d'attaque d'opportunité contre ${mover.name} (réaction indisponible).`,
            "enemy-turn",
            makeMsgId()
          );
        } else {
          result = await promptPlayerOpportunityAttack(reactor, mover);
        }
      } else if (hasReaction(reactor.id)) {
        result = await resolveEnemyOpportunityAttack(reactor, mover);
      }

      removeFromMelee(movingCombatantId, reactor.id);

      const liveMover = getRuntimeCombatant(movingCombatantId);
      if (result.targetAlive === false || liveMover?.isAlive === false) {
        return false;
      }
    }
    return true;
  }

  const ENEMY_TACTICAL_STEP_MS = 800;

  async function pauseEnemyTacticalStep() {
    await new Promise((r) => setTimeout(r, ENEMY_TACTICAL_STEP_MS));
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
    dice,
    lastDmgRoll,
    lastDmgTotal,
    currentHp,
    maxHp,
  }) {
    const lines = [`**${attacker.name}** · ${chosenWeapon.name}${labelSuffix || ""} → **${target.name}**`];
    if (nat === 1) {
      lines.push(`Jet d'attaque : **échec automatique** (naturel 1 — fumble).`);
      return lines.join("\n");
    }
    if (nat === 20) {
      lines.push(`Jet d'attaque : **coup critique** (naturel 20).`);
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
      `Jet d'attaque : ${nat} ${fmtMod(atkBonus)} = **${atkTotal}** vs CA **${targetAc}** — ${
        atkTotal >= targetAc ? "**touche**" : "**raté**"
      }.`
    );
    if (atkTotal >= targetAc && lastDmgTotal > 0 && lastDmgRoll && !lastDmgRoll.crit) {
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

    let currentHp = getCombatantCurrentHp(target);
    const nat = Math.floor(Math.random() * 20) + 1;
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
      dice,
      lastDmgRoll,
      lastDmgTotal,
      currentHp,
      maxHp: target?.hp?.max ?? null,
    });

    let narrativeText = "";
    if (target.id === "player") {
      try {
        const res = await fetch("/api/chat-combat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: aiProvider,
            thoughtProcess: tactical?.thought_process ?? "",
            enemyName: attacker.name,
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
      addMessage("ai", narrativeText, undefined, makeMsgId());
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
          damageDice: dice,
          damageBonus: dmgBonus,
          damageRoll: lastDmgRoll,
          damageTotal: lastDmgTotal,
          hpAfter: currentHp,
        }),
      "debug",
      makeMsgId()
    );
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

    const slotResult = spendSpellSlotForCombatant(attacker.id, spell.level ?? 0);
    if (!slotResult.ok) return false;

    if (spell.save) {
      const dc = computeSpellSaveDC(attacker);
      if (target.id === "player") {
        const incomingPlayerSaveRoll = {
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
        };
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
    if (isPlayerDeadNow() || !hasLivingPlayerCombatant(gameStateRef.current?.entities ?? entities)) return;

    const label = opts?.label ? ` (${opts.label})` : "";
    const playerTarget = getRuntimeCombatant("player");

    // Surpris: l'ennemi perd ce tour, puis l'état est consommé.
    if (enemy?.surprised === true) {
      addMessage(
        "ai",
        `${enemy.name} est surpris et reste figé un instant${label}.`,
        "enemy-turn",
        makeMsgId()
      );
      return;
    }

    // Attaque d'opportunité (joueur quitte la mêlée) : pas d'appel tactique, une seule frappe
    if (opts?.label === "attaque d'opportunité") {
      const enemyWeapons = Array.isArray(enemy.weapons) ? enemy.weapons : [];
      const isRangedWeapon = (w) => w?.kind === "ranged" || isRangedWeaponName(w?.name ?? "");
      let chosenWeapon =
        enemyWeapons.find((w) => !isRangedWeapon(w)) ?? enemyWeapons[0] ?? null;
      if (chosenWeapon && playerTarget) {
        const result = await resolveCombatantWeaponAttack(
          enemy,
          playerTarget,
          chosenWeapon,
          label,
          null,
          { type: "action", name: chosenWeapon.name, target: "player" }
        );
        if (result === "player_dead" || !hasLivingPlayerCombatant(gameStateRef.current?.entities ?? entities)) return;
      }
      return;
    }

    // Ressource déplacement (théâtre de l'esprit) : 1 seule utilisation par tour ennemi.
    let enemyMovementAvailable = true;

    const tactical = await generateEnemyTurn(enemy, {
      playerPosition: "frontline",
      distance: getMeleeWith(enemy.id).includes("player") ? "melee" : "unknown",
      roundContext: opts?.label ?? null,
      movementOk: enemyMovementAvailable,
    });

    const actions = Array.isArray(tactical?.actions) ? tactical.actions : [];
    const typeOf = (a) => String(a?.type ?? "").toLowerCase();
    const nameOf = (a) => String(a?.name ?? "");
    const isDisengageName = (n) => /d[ée]sengag/i.test(n);
    const isFleeNameStr = (n) =>
      /(éloigner|fuir|retirer|partir|recule|enfuir)/i.test(n) && !isDisengageName(n);
    const isApproachNameStr = (n) => /approcher|avance|rapproch/i.test(n);

    const enemyWeapons = Array.isArray(enemy.weapons) ? enemy.weapons : [];
    const isRangedWeapon = (w) => w?.kind === "ranged" || isRangedWeaponName(w?.name ?? "");

    let hasDisengaged = false;
    let attackPerformed = false;
    /**
     * addMeleeMutual/clearMeleeFor passent par setState React : getMeleeWith() reste
     * périmé dans la même boucle synchrone. On suit donc la mêlée localement pour que
     * « S'approcher » puis « Cimeterre » dans un même plan tactique fonctionne.
     */
    let effectiveInMeleeWithPlayer = getMeleeWith(enemy.id).includes("player");

    const pickOffensiveOptionForAction = (act) => {
      const spellName = canonicalizeSpellNameAgainstCombatant(enemy, act?.name ?? "");
      if (spellName && SPELLS?.[spellName]) {
        return { kind: "spell", spellName, canAttack: !!playerTarget };
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
      const inMelee = effectiveInMeleeWithPlayer;
      if (chosenWeapon && inMelee && isRangedWeapon(chosenWeapon)) {
        chosenWeapon = enemyWeapons.find((w) => !isRangedWeapon(w)) ?? chosenWeapon;
      }
      let canAttack = !!chosenWeapon && !!playerTarget;
      if (chosenWeapon && !inMelee && !isRangedWeapon(chosenWeapon)) {
        canAttack = false;
      }
      return { kind: "weapon", chosenWeapon, canAttack };
    };

    for (const act of actions) {
      const t = typeOf(act);
      const n = nameOf(act);

      if ((t === "bonus_action" || t === "action") && isDisengageName(n)) {
        hasDisengaged = true;
        addMessage("ai", `⚔️ ${enemy.name} se désengage.`, "enemy-turn", makeMsgId());
        await pauseEnemyTacticalStep();
        continue;
      }

      if (t === "movement" && isApproachNameStr(n)) {
        if (!enemyMovementAvailable) {
          await pauseEnemyTacticalStep();
          continue;
        }
        enemyMovementAvailable = false;
        if (!effectiveInMeleeWithPlayer) {
          addMeleeMutual(enemy.id, "player");
          effectiveInMeleeWithPlayer = true;
          addMessage(
            "ai",
            `⚔️ ${enemy.name} se rapproche au corps à corps.`,
            "enemy-turn",
            makeMsgId()
          );
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
        const picked = pickOffensiveOptionForAction(act);
        let ok = false;
        if (picked?.kind === "spell" && picked.spellName && playerTarget) {
          ok = await resolveCombatantSpellAgainstTarget(
            enemy,
            playerTarget,
            picked.spellName,
            label,
            tactical,
            act
          );
        } else if (picked?.canAttack && picked?.chosenWeapon && playerTarget) {
          ok = await resolveCombatantWeaponAttack(
            enemy,
            playerTarget,
            picked.chosenWeapon,
            label,
            tactical,
            act
          );
        }
        if (ok === "player_dead" || !hasLivingPlayerCombatant(gameStateRef.current?.entities ?? entities)) return;
        if (ok) attackPerformed = true;
        await pauseEnemyTacticalStep();
        continue;
      }

      if (t === "movement" && isFleeNameStr(n)) {
        if (!enemyMovementAvailable) {
          await pauseEnemyTacticalStep();
          continue;
        }
        enemyMovementAvailable = false;
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
          for (const reactorId of engagedReactors) {
            removeFromMelee(enemy.id, reactorId);
          }
        }
        effectiveInMeleeWithPlayer = getMeleeWith(enemy.id).includes("player");
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
        await pauseEnemyTacticalStep();
        continue;
      }
    }

    // Si l'ennemi se désengage sans expliciter un mouvement de fuite,
    // on applique un pas de retrait implicite pour refléter l'intention tactique.
    if (hasDisengaged && effectiveInMeleeWithPlayer && enemyMovementAvailable) {
      enemyMovementAvailable = false;
      const engagedReactors = getMeleeWith(enemy.id).filter((id) => {
        const combatant = getRuntimeCombatant(id);
        return combatant && combatant.isAlive !== false;
      });
      for (const reactorId of engagedReactors) {
        removeFromMelee(enemy.id, reactorId);
      }
      effectiveInMeleeWithPlayer = false;
      addMessage(
        "ai",
        `⚔️ ${enemy.name} se retire prudemment après s'être désengagé.`,
        "enemy-turn",
        makeMsgId()
      );
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

    if (!attackPerformed && !hasDisengaged) {
      const inMelee = effectiveInMeleeWithPlayer;
      const fleeInPlan = actions.some((a) => typeOf(a) === "movement" && isFleeNameStr(nameOf(a)));
      if (inMelee && enemyWeapons.length > 0 && !fleeInPlan && playerTarget) {
        let chosenWeapon = enemyWeapons[0];
        if (isRangedWeapon(chosenWeapon)) {
          chosenWeapon = enemyWeapons.find((w) => !isRangedWeapon(w)) ?? chosenWeapon;
        }
        const canAttack = !(!inMelee && !isRangedWeapon(chosenWeapon));
        if (canAttack && chosenWeapon) {
          const result = await resolveCombatantWeaponAttack(
            enemy,
            playerTarget,
            chosenWeapon,
            label,
            tactical,
            { type: "action", name: chosenWeapon.name, target: "player", fallback: true }
          );
          if (result === "player_dead" || !hasLivingPlayerCombatant(gameStateRef.current?.entities ?? entities)) return;
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

  // Garder le mouvement aligné avec la vitesse du joueur quand c'est Ã  son tour
  useEffect(() => {
    if (gameMode !== "combat") return;
    const entry = combatOrder?.[combatTurnIndex];
    if (!entry || controllerForCombatantId(entry.id) !== "player") return;
    setTurnResources((prev) => {
      if (!prev) {
        return {
          action: true,
          bonus: true,
          reaction: true,
          movement: true,
        };
      }
      return {
        ...prev,
        movement: true,
      };
    });
  }, [gameMode, combatOrder, combatTurnIndex, player.speed]);

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

  function ensureCombatState(currentEntities, maybeOrder = null) {
    const anyCombatReadyHostile = hasAnyCombatReadyHostile(currentEntities);
    if (!anyCombatReadyHostile) {
      if (gameMode === "combat") {
        addMessage("ai", "[DEBUG] Fin de combat (plus aucun hostile engagé) â†’ exploration", "debug", makeMsgId());
      }
      setGameMode("exploration", currentEntities);
      setCombatOrder([]);
      commitCombatTurnIndex(0);
      return;
    }

    // Hostiles conscients du joueur (ou déjà engagés) â†’ combat
    if (gameMode !== "combat") {
      if (!anyCombatReadyHostile) return;
      addMessage("ai", "[DEBUG] Hostiles engagés â†’ passage en COMBAT", "debug", makeMsgId());
      setGameMode("combat");
      // En entrant en combat, on active Bonus/Réaction (disponibles par défaut),
      // sans "rendre" une Action déjÃ  dépensée ce tour (ex: attaque qui déclenche le combat).
      setHasDisengagedThisTurn(false);
      setTurnResources((prev) => ({
        action: prev?.action ?? true,
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

  const enemyTurnLoopInProgressRef = useRef(false);

  /**
   * @param {object} [options]
   * @param {Array<{ id: string, name?: string, initiative?: number }>} [options.order] — ordre explicite (ex. juste après commit initiative, avant re-render React)
   * @param {number} [options.startIndex] — index de départ dans order (défaut : combatTurnIndex)
   * @param {boolean} [options.skipInitialAdvance] — true : le combattant à startIndex agit en premier (début de round / post-initiative). false : on avance d'abord comme après « Fin de tour ».
   */
  async function runEnemyTurnsUntilPlayer(options = {}) {
    if (enemyTurnLoopInProgressRef.current) return;
    enemyTurnLoopInProgressRef.current = true;
    try {
    let order = options.order ?? combatOrder;
    let idx =
      options.startIndex !== undefined && options.startIndex !== null
        ? options.startIndex
        : combatTurnIndex;
    const skipInitialAdvance = options.skipInitialAdvance === true;

    // Exécute les tours ennemis selon l'ordre d'initiative jusqu'au tour du joueur.
    // Ne fait agir que les entités hostiles (type "hostile").
    let currentEntities = gameStateRef.current?.entities ?? entities;

    if (!hasLivingPlayerCombatant(currentEntities)) {
      return;
    }

    // Si combat terminé, sortir
    if (isCombatOver(currentEntities)) {
      setGameMode("exploration", currentEntities);
      setCombatOrder([]);
      commitCombatTurnIndex(0);
      return;
    }

    if (!order?.length) return;

    // Après « Fin de tour » : avancer au prochain vivant. Post-initiative / début de round : commencer sur startIndex.
    if (!skipInitialAdvance) {
      idx = nextAliveTurnIndex(order, idx, currentEntities);
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
          return;
        }
        grantPlayerTurnResources();
        return;
      }

      const ent = currentEntities.find((e) => e.id === entry.id);
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
        currentEntities = gameStateRef.current?.entities ?? entities;
        const liveEnemy = currentEntities.find((e) => e.id === entry.id);
        if (!liveEnemy || !liveEnemy.isAlive || liveEnemy.type !== "hostile") {
          continue;
        }
        const enemyStartsSurprised = liveEnemy.surprised === true;
        setReactionFor(liveEnemy.id, !enemyStartsSurprised);
        await simulateSingleEnemyTurn(liveEnemy);
        currentEntities = gameStateRef.current?.entities ?? entities;
        if (!hasLivingPlayerCombatant(currentEntities)) {
          return;
        }
        if (enemyStartsSurprised) {
          applyEntityUpdates([{ id: liveEnemy.id, action: "update", surprised: false }]);
          setReactionFor(liveEnemy.id, true);
        }
      }
      if (ent && ent.isAlive && controllerForCombatantId(entry.id, currentEntities) !== "player") {
        addMessage(
          "ai",
          `**${ent.name}** met fin à son tour.`,
          "turn-end",
          makeMsgId()
        );
        addMessage("ai", "", "turn-divider", makeMsgId());
      }

      currentEntities = gameStateRef.current?.entities ?? entities;
      order = gameStateRef.current?.combatOrder ?? order;
      idx = combatTurnIndexLiveRef.current;
      // fin de tour → next
      idx = nextAliveTurnIndex(order, idx, currentEntities);

      // combat over ?
      if (isCombatOver(currentEntities)) {
        setGameMode("exploration", currentEntities);
        setCombatOrder([]);
        commitCombatTurnIndex(0);
        return;
      }
    }

    // fallback
    commitCombatTurnIndex(0);
    } finally {
      enemyTurnLoopInProgressRef.current = false;
    }
  }

  const runEnemyTurnsUntilPlayerRef = useRef(() => Promise.resolve());
  runEnemyTurnsUntilPlayerRef.current = runEnemyTurnsUntilPlayer;

  const handleCommitInitiativeRef = useRef(() => {});

  async function handleCommitInitiative() {
    // Garde anti-race : tant qu'on attend une vraie narration GM
    // (embuscade/entrée en combat), on ne déclenche pas le jet d'initiative côté UI.
    if (waitForGmNarrationForInitiativeLiveRef.current) return;
    const merged = commitPlayerInitiativeRoll();
    if (!merged?.length) return;

    const rankLabel = (i) => (i === 0 ? "1er" : `${i + 1}e`);
    const orderText = merged
      .map(
        (entry, idx) =>
          `[${rankLabel(idx)}] ${resolveCombatantDisplayName(entry, entities, player?.name)} (${entry.initiative})`
      )
      .join("\n");
    addMessage("ai", `🎲 **Jet d'Initiative**\n\n${orderText}\n\n⚔️ *Le combat commence !*`, "dice", makeMsgId());

    const playerStartsSurprised = player?.surprised === true;
    if (playerStartsSurprised) {
      setReactionFor("player", false);
    }
    for (const entry of merged) {
      if (!entry?.id || entry.id === "player") continue;
      const combatant = entities.find((entity) => entity.id === entry.id);
      if (combatant?.surprised === true) {
        setReactionFor(entry.id, false);
      }
    }
    const first = merged[0];
    if (controllerForCombatantId(first?.id) === "player") {
      setHasDisengagedThisTurn(false);
      setSneakAttackArmed(false);
      setSneakAttackUsedThisTurn(false);
      setIsTyping(true);
      try {
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
        } else {
          grantPlayerTurnResources();
        }
      } finally {
        setIsTyping(false);
      }
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
  }

  handleCommitInitiativeRef.current = handleCommitInitiative;

  const lastAiTurnKickoffKeyRef = useRef(null);
  useEffect(() => {
    if (gameMode !== "combat") {
      lastAiTurnKickoffKeyRef.current = null;
      return;
    }
    if (flowBlockedRef.current) return;
    if (isTyping || isAutoPlayerThinking) return;
    if (enemyTurnLoopInProgressRef.current) return;
    if (isGameOverRef.current) return;
    if (awaitingPlayerInitiative) return;
    if (waitForGmNarrationForInitiative) return;
    if (sceneEnteredPipelineDepthRef.current > 0) return;
    if (apiProcessingDepthRef.current > 0) return;
    if (pendingRollRef.current) return;
    if (!Array.isArray(combatOrder) || combatOrder.length === 0) return;
    if (!hasLivingPlayerCombatant(gameStateRef.current?.entities ?? entities)) return;

    const activeEntry = combatOrder[combatTurnIndex];
    if (!activeEntry) return;

    const activeController = controllerForCombatantId(activeEntry.id);
    if (activeController !== "ai") {
      lastAiTurnKickoffKeyRef.current = null;
      return;
    }

    const kickoffKey = `${combatTurnIndex}:${activeEntry.id}:${combatOrder.length}`;
    if (lastAiTurnKickoffKeyRef.current === kickoffKey) return;
    lastAiTurnKickoffKeyRef.current = kickoffKey;

    queueMicrotask(() => {
      const live = gameStateRef.current;
      if (!hasLivingPlayerCombatant(live?.entities ?? null)) return;
      const liveOrder = Array.isArray(live?.combatOrder) ? live.combatOrder : combatOrder;
      const liveEntry = liveOrder[combatTurnIndexLiveRef.current];
      if (!liveEntry) return;
      if (controllerForCombatantId(liveEntry.id, live?.entities ?? null) !== "ai") return;
      if (enemyTurnLoopInProgressRef.current) return;
      if (flowBlockedRef.current || isGameOverRef.current || pendingRollRef.current) return;
      if (sceneEnteredPipelineDepthRef.current > 0 || apiProcessingDepthRef.current > 0) return;
      setIsTyping(true);
      runEnemyTurnsUntilPlayerRef
        .current({
          order: liveOrder,
          startIndex: combatTurnIndexLiveRef.current,
          skipInitialAdvance: true,
        })
        .catch(() => {})
        .finally(() => setIsTyping(false));
    });
  }, [
    gameMode,
    combatOrder,
    combatTurnIndex,
    awaitingPlayerInitiative,
    waitForGmNarrationForInitiative,
    isTyping,
    isAutoPlayerThinking,
  ]);

  // Auto-joueur : dès que le brouillon d'initiative PNJ est prêt, lancer le d20 joueur (évite la course setTimeout vs useEffect)
  useEffect(() => {
    if (!autoPlayerEnabled) return;
    if (isPlayerDeadNow()) return;
    if (gameMode !== "combat") return;
    if ((combatOrder?.length ?? 0) > 0) return;
    if (!awaitingPlayerInitiative) return;
    if (!npcInitiativeDraft?.length) return;
    if (pendingRoll) return;
    if (waitForGmNarrationForInitiative) return;

    queueMicrotask(() => {
      if (!autoPlayerEnabledRef.current) return;
      handleCommitInitiativeRef.current();
    });
  }, [
    autoPlayerEnabled,
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
    const resourceKind = resourceForCastingTime(spell.castingTime);
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

    consumeResource(setTurnResources, effGameModeForIntent, resourceKind);

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
    let dmgDetail = `${dmgNotation} [${r.rolls.join("+")}]`;
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
  async function processEngineIntent(apiIntent, postEntities, userTextForResolve, baseRoomId, baseScene) {
    if (!apiIntent || typeof apiIntent !== "object") {
      addMessage("ai", "Intention non reconnue.", "intent-error", makeMsgId());
      return;
    }
    const namedCheck = validateNamedWeaponOrSpellFromParser(apiIntent, player);
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
      let msg = "Ce n'est pas votre tour d'agir.";
      if (live?.debugMode) {
        msg += ` [DEBUG: index=${effTurnIdxForIntent}, actif=${effOrderForIntent[effTurnIdxForIntent]?.id ?? "?"}]`;
      }
      addMessage("ai", msg, "intent-error", makeMsgId());
      return;
    }

    const intentResult = executeCombatActionIntent(actionIntentNorm, {
      postEntities,
      player,
      gameMode: effGameModeForIntent,
      setGameMode,
      turnResources: turnResourcesRef.current,
      setTurnResources: setTurnResourcesSynced,
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
    });

    if (!intentResult.ok) {
      addMessage("ai", intentResult.userMessage, "intent-error", makeMsgId());
      return;
    }

    if (intentResult.endTurnRequested) {
      clearPlayerSurprisedState();
      addMessage(
        "ai",
        `**${player?.name ?? "Vous"}** met fin à son tour.`,
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
      pendingRollRef.current = intentResult.pendingRoll;
      setPendingRoll(intentResult.pendingRoll);
    }
  }

  async function processArbiterDecision(apiDecision, baseEntities, userTextForResolve, baseRoomId, baseScene, baseGameModeForResolve) {
    if (!apiDecision || typeof apiDecision !== "object") {
      addMessage("ai", "Décision d'arbitrage invalide.", "intent-error", makeMsgId());
      return;
    }

    const resolution = String(apiDecision.resolution ?? "").trim();
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
      if (intentType === "short_rest") {
        startShortRest();
        return;
      }
      if (intentType === "long_rest") {
        startLongRest();
        return;
      }
      await processEngineIntent(apiDecision.intent, baseEntities, userTextForResolve, baseRoomId, baseScene);
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
            rollResultOverride: { notation: rollNotation, total: r.total, rolls: r.rolls },
            intentDecision: {
              resolution: apiDecision.resolution,
              reason: apiDecision.reason ?? null,
              rollRequestSummary: { kind: "gm_secret", roll: rollNotation },
            },
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
            rollResultOverride: { notation: rollNotation, total: r.total, rolls: r.rolls },
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
      const computed = computeCheckBonus({ player, stat: rr.stat, skill });
      const normalizedRoll = { ...rr, skill: skill ?? undefined, totalBonus: computed };
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
      pendingRollRef.current = normalizedRoll;
      setPendingRoll(normalizedRoll);
      addMessage(
        "ai",
        `[DEBUG] Arbiter → pendingRoll\n` + safeJson(normalizedRoll),
        "debug",
        makeMsgId()
      );
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
    if (sceneUpdate?.hasChanged && typeof sceneUpdate?.targetRoomId === "string") {
      const tid = sceneUpdate.targetRoomId.trim();
      const room = tid && GOBLIN_CAVE[tid] ? GOBLIN_CAVE[tid] : null;
      if (room) {
        rememberRoomEntitiesSnapshot(baseRoomId, nextEntities);
        nextRoomId = tid;
        nextScene = room.description ?? baseScene;
        nextSceneName = room.title ?? currentSceneName;
        nextEntities = tid === "scene_journey" ? [] : takeEntitiesForRoom(tid);
        setCurrentRoomId(tid);
        if (nextSceneName) setCurrentSceneName(nextSceneName);
        if (nextScene) setCurrentScene(nextScene);
        replaceEntities(nextEntities);
        gameStateRef.current = {
          ...gameStateRef.current,
          currentRoomId: nextRoomId,
          currentScene: nextScene,
          currentSceneName: nextSceneName,
          entities: nextEntities,
        };
        engineEvent = {
          kind: "scene_transition",
          fromRoomId: baseRoomId,
          targetRoomId: tid,
          playerAction: userTextForResolve,
          reason: apiDecision.reason ?? null,
        };
      }
    }

    const explorationAfterIntent =
      (gameStateRef.current?.gameMode ?? baseGameModeForResolve) === "exploration";

    if (explorationAfterIntent) {
      try {
        const resolved = await runSceneEntryGmArbiter({
          roomId: nextRoomId,
          scene: nextScene,
          sceneName: nextSceneName,
          entitiesAtEntry: nextEntities,
          sourceAction: userTextForResolve,
          baseGameMode: gameStateRef.current?.gameMode ?? baseGameModeForResolve,
          intentDecision: {
            resolution: apiDecision.resolution,
            reason: apiDecision.reason ?? null,
            sceneUpdate: sceneUpdate ?? null,
          },
        });
        nextEntities = resolved?.nextEntities ?? nextEntities;
        nextRoomId = resolved?.nextRoomId ?? nextRoomId;
        nextScene = resolved?.nextScene ?? nextScene;
        nextSceneName = resolved?.nextSceneName ?? nextSceneName;
        const arbiterEngineEvent = resolved?.engineEvent ?? null;
        const shouldKeepOriginalEngineEvent =
          resolved?.arbiterResolution === "no_roll_needed" &&
          engineEvent?.kind === "action_trivial_success" &&
          !sceneUpdate?.hasChanged &&
          !isSubstantiveArbiterEngineEvent(arbiterEngineEvent);
        engineEvent = shouldKeepOriginalEngineEvent ? engineEvent : (arbiterEngineEvent ?? engineEvent);
        if (resolved?.awaitingPlayerRoll === true) {
          return;
        }
      } catch (e) {
        addMessage(
          "ai",
          `[DEBUG] Erreur GM Arbitre de scène (après parse-intent): ${String(e?.message ?? e)}`,
          "debug",
          makeMsgId()
        );
      }
    }

    await callApi(userTextForResolve, "meta", false, {
      hideUserMessage: true,
      bypassIntentParser: true,
      skipAutoPlayerTurn: true,
      skipGmContinue: true,
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
    crossRoomMemoryAppend,
  }) {
    let nextActiveEntities = Array.isArray(activeEntities) ? activeEntities : [];

    if (Array.isArray(crossRoomEntityUpdates)) {
      for (const entry of crossRoomEntityUpdates) {
        if (!entry || typeof entry !== "object") continue;
        const targetRoomId = String(entry.roomId ?? "").trim();
        const roomUpdates = Array.isArray(entry.updates) ? entry.updates : [];
        if (!targetRoomId || roomUpdates.length === 0) continue;

        if (targetRoomId === activeRoomId) {
          nextActiveEntities = applyUpdatesLocally(nextActiveEntities, roomUpdates);
          applyEntityUpdates(roomUpdates);
          continue;
        }

        const existingSnapshot =
          targetRoomId === "scene_journey" ? [] : takeEntitiesForRoom(targetRoomId);
        const nextSnapshot = applyUpdatesLocally(existingSnapshot, roomUpdates);
        rememberRoomEntitiesSnapshot(targetRoomId, nextSnapshot);
      }
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

  async function runSceneEntryGmArbiter({
    roomId,
    scene,
    sceneName,
    entitiesAtEntry,
    sourceAction,
    baseGameMode,
    rollResultOverride = null,
    intentDecision = null,
    arbiterTrigger = null,
    reentryDepth = 0,
  }) {
    const room = roomId && GOBLIN_CAVE[roomId] ? GOBLIN_CAVE[roomId] : null;
    const provider = gameStateRef.current?.aiProvider === "gemini" ? "gemini" : "openrouter";
    let campaignWorldContext = null;
    let campaignContextScope = null;
    const postArbiter = async (rollResult = null, worldContextOverride = null) => {
      const visibleExitsForRoom = getVisibleExitsForRoom(roomId, getRoomMemory(roomId));
      const body = {
        provider,
        currentRoomId: roomId,
        currentRoomTitle: room?.title ?? "",
        currentScene: scene ?? "",
        currentRoomSecrets: room?.secrets ?? "",
        worldTimeMinutes,
        worldTimeLabel: formatWorldTimeLabel(worldTimeMinutes),
        roomMemory: getRoomMemory(roomId),
        allowedExits: Array.isArray(visibleExitsForRoom) ? visibleExitsForRoom : [],
        entities: Array.isArray(entitiesAtEntry) ? entitiesAtEntry : [],
        player: player ?? null,
        messages: [...messagesRef.current],
        rollResult,
        sourceAction: sourceAction ?? "",
        intentDecision: intentDecision ?? null,
        arbiterTrigger: arbiterTrigger ?? null,
        campaignWorldContext: worldContextOverride ?? null,
      };
      const { res, data } = await fetchJsonWithTimeout(
        "/api/gm-arbiter",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        60000,
        "gm-arbiter"
      );
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
      if (!res.ok) throw new Error(String(data?.error ?? data?.details ?? "gm-arbiter error"));
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
        const requestedScope =
          finalDecision?.campaignContextRequest?.scope === "connected_rooms"
            ? "connected_rooms"
            : "full_campaign";

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
        const dc = Number(rr?.dc);
        const computedBonus = computeCheckBonus({
          player,
          stat: statOk,
          skill,
        });
        const pendingFromSceneArbiter = {
          kind: "check",
          stat: statOk,
          skill,
          dc: Number.isFinite(dc) ? dc : null,
          raison: String(rr?.reason ?? "Règle du lieu"),
          totalBonus: computedBonus,
          returnToArbiter: true,
          sceneArbiterContext: {
            roomId,
            scene,
            sceneName,
            sourceAction,
            baseGameMode,
            intentDecision: intentDecision ?? null,
            arbiterTrigger: arbiterTrigger ?? null,
            narrateAfterResolution: arbiterTrigger == null,
          },
        };
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
      rollOutcome = { notation, total: dice.total, rolls: dice.rolls };
      addMessage(
        "ai",
        `[DEBUG] GM Arbitre (scène) → jet secret ${notation} [${dice.rolls.join("+")}] = **${dice.total}**`,
        "debug",
        makeMsgId()
      );
      finalDecision = await postArbiter(rollOutcome, campaignWorldContext);
      finalDecision = forceRequestRollFromInconsistentDecision(finalDecision);
    }

    let nextEntities = Array.isArray(entitiesAtEntry) ? entitiesAtEntry : [];
    const sourceRoomEntitiesBeforeTransition = nextEntities;
    let nextRoomId = roomId;
    let nextScene = scene;
    let nextSceneName = sceneName;
    let nextGameMode = baseGameMode;
    const pendingSceneUpdateTargetId =
      finalDecision?.sceneUpdate?.hasChanged && typeof finalDecision?.sceneUpdate?.targetRoomId === "string"
        ? finalDecision.sceneUpdate.targetRoomId.trim()
        : null;
    const updatesTargetFutureRoomBase =
      pendingSceneUpdateTargetId && pendingSceneUpdateTargetId !== roomId && pendingSceneUpdateTargetId !== nextRoomId;
    const entitiesBaseForPlannedUpdates = updatesTargetFutureRoomBase
      ? pendingSceneUpdateTargetId === "scene_journey"
        ? []
        : takeEntitiesForRoom(pendingSceneUpdateTargetId)
      : nextEntities;
    let targetRoomEntitiesFromCurrentDecision = null;

    const plannedUpdates = Array.isArray(finalDecision?.entityUpdates) ? finalDecision.entityUpdates : [];
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
    // Ordre strict demandé :
    // narration d'abord, puis bannière/jet d'initiative.
    // On verrouille donc l'initiative AVANT d'appliquer les conséquences de scène qui ouvrent le combat.
    if ((willSwitchToCombat || (willSpawnHostile && willHaveCombatReadyHostiles)) && (combatOrder?.length ?? 0) === 0) {
      waitForGmNarrationForInitiativeLiveRef.current = true;
      setWaitForGmNarrationForInitiative(true);
    }

    const updates = plannedUpdates;
    if (updates.length) {
      if (updatesTargetFutureRoomBase) {
        targetRoomEntitiesFromCurrentDecision = plannedEntitiesAfterLocalUpdates;
        rememberRoomEntitiesSnapshot(pendingSceneUpdateTargetId, targetRoomEntitiesFromCurrentDecision);
      } else {
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
    }

    nextEntities = applyCrossRoomConsequences({
      activeRoomId: nextRoomId,
      activeEntities: nextEntities,
      crossRoomEntityUpdates: finalDecision?.crossRoomEntityUpdates ?? null,
      crossRoomMemoryAppend: finalDecision?.crossRoomMemoryAppend ?? null,
    });

    const sUp = finalDecision?.sceneUpdate;
    const roomBeforeSceneUpdate = nextRoomId;
    if (sUp?.hasChanged && typeof sUp?.targetRoomId === "string") {
      const tid = sUp.targetRoomId.trim();
      const tRoom = tid && GOBLIN_CAVE[tid] ? GOBLIN_CAVE[tid] : null;
      if (tRoom) {
        const isSameRoomTransition = tid === nextRoomId;
        if (!isSameRoomTransition) {
          rememberRoomEntitiesSnapshot(nextRoomId, sourceRoomEntitiesBeforeTransition);
        }
        nextRoomId = tid;
        nextScene = tRoom.description ?? nextScene;
        nextSceneName = tRoom.title ?? nextSceneName;

        // Important: si l'arbitre de scène renvoie un sceneUpdate vers la même room
        // (cas fréquent juste après l'entrée), on ne doit PAS effacer les spawns
        // déjà appliqués via entityUpdates.
        if (!isSameRoomTransition) {
          nextEntities =
            tid === "scene_journey"
              ? []
              : targetRoomEntitiesFromCurrentDecision ?? takeEntitiesForRoom(tid);
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
    if (
      typeof finalDecision?.timeAdvanceMinutes === "number" &&
      Number.isFinite(finalDecision.timeAdvanceMinutes)
    ) {
      const clamped = Math.max(0, Math.min(1440, Math.trunc(finalDecision.timeAdvanceMinutes)));
      if (clamped > 0) {
        const nextMinute = advanceWorldClock(clamped);
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
      return await runSceneEntryGmArbiter({
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
      });
    }

    if (finalDecision?.gameMode === "combat" || finalDecision?.gameMode === "exploration") {
      nextGameMode =
        finalDecision.gameMode === "combat" && !hasAnyCombatReadyHostile(nextEntities)
          ? "exploration"
          : finalDecision.gameMode;
      setGameMode(nextGameMode);
    }
    ensureCombatState(nextEntities);

    gameStateRef.current = {
      ...gameStateRef.current,
      currentRoomId: nextRoomId,
      currentScene: nextScene,
      currentSceneName: nextSceneName,
      entities: nextEntities,
      gameMode: nextGameMode,
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

  function isPurelyProceduralNarratorReason(text) {
    const t = String(text ?? "").trim().toLowerCase();
    if (!t) return false;
    return (
      /aucun secret|aucun piège|aucun piege|aucune regle|aucune règle|n'est déclenché|n'est declenche|pas de piège|pas de piege/.test(t) ||
      (/le joueur se déplace|le personnage se déplace|se dirige vers|approche|sans la franchir/.test(t) &&
        !/découvre|decouvre|révèle|revele|ouvre|entre dans|apparait|apparaît|trouve|voit|aperçoit/.test(t))
    );
  }

  function narratorSafeArbiterReason(kind, resolution, reason, details) {
    const cleanReason = typeof reason === "string" && reason.trim() ? reason.trim() : null;
    const cleanDetails = typeof details === "string" && details.trim() ? details.trim() : null;
    if (!cleanReason) return null;
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
      if (cleanResolution !== "apply_consequences") return false;
      if (details) return true;
      return !!reason && !isPurelyProceduralNarratorReason(reason);
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
    const snap = gameStateRef.current;
    const baseEntities = overrides?.entities ?? snap.entities;
    const baseGameMode = overrides?.gameMode ?? snap.gameMode;
    const baseCombatOrder = snap.combatOrder ?? [];
    const engineEvent  = overrides?.engineEvent ?? null;
    const baseScene    = overrides?.currentScene ?? snap.currentScene;
    const baseRoomId   = overrides?.currentRoomId ?? snap.currentRoomId;
    const skipAutoPlayerTurn = overrides?.skipAutoPlayerTurn === true;
    const skipGmContinue = overrides?.skipGmContinue === true;
    const hideUserMessage = overrides?.hideUserMessage === true;
    const bypassIntentParser = overrides?.bypassIntentParser === true;
    const forceIntentParser = overrides?.forceIntentParser === true;
    if (!msgType && !isDebug && !hideUserMessage) {
      lastNaturalPlayerInputRef.current = String(userContent ?? "");
    }
    const userMsgId = makeMsgId();
    const effectiveUserType = hideUserMessage ? "debug" : msgType;
    const newMsg = { id: userMsgId, role: "user", content: userContent, ...(effectiveUserType && { type: effectiveUserType }) };
    // Historique limité par \"scène\" : on ne garde que les derniers messages,
    // ce qui évite aux IA de rester bloquées dans une ancienne scène (ex: forge).
    const updatedMessages = [...messagesRef.current, newMsg];
    const limitedMessages =
      updatedMessages.length > 20 ? updatedMessages.slice(-20) : updatedMessages;

    if (!hideUserMessage) {
      addMessage("user", userContent, effectiveUserType, userMsgId);
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
    if (tryHandleNaturalLanguageRest(userContent, msgType, isDebug, overrides)) {
      setIsTyping(false);
      return;
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
      !pendingRollRef.current &&
      !movementGate
    ) {
      apiProcessingDepthRef.current += 1;
      try {
        const parseProvider = snap.aiProvider === "gemini" ? "gemini" : "openrouter";
        const lootIntentAsked = looksLikeLootIntent(userContent);
        // Ne pas exposer au parseur les cibles mortes pour les attaques classiques,
        // mais les exposer quand le joueur exprime explicitement un pillage/loot.
        const parserEntities = (Array.isArray(baseEntities) ? baseEntities : []).filter((e) => {
          if (!e || typeof e !== "object") return false;
          if (e.type === "object") return false;
          if (e.visible === false) return false;
          const hpCur = typeof e?.hp?.current === "number" ? e.hp.current : null;
          const isDead = e.isAlive === false || (hpCur != null && hpCur <= 0);
          if (!lootIntentAsked && isDead) return false;
          return typeof e.id === "string" && !!e.id.trim();
        });
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
          playerWeapons: snap.player?.weapons ?? [],
          playerMeleeTargets: getMeleeWith("player"),
          turnResources: {
            action: !!turnResourcesRef.current?.action,
            bonus: !!turnResourcesRef.current?.bonus,
            reaction: !!turnResourcesRef.current?.reaction,
            movement: !!turnResourcesRef.current?.movement,
          },
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
          addMessage(
            "ai",
            details,
            "intent-error",
            makeMsgId()
          );
          markFlowFailure(details, {
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
            gameModeForParser
          );
        }
      } catch (e) {
        const errMsg = String(e?.message ?? e);
        if (!/^Timeout\b/i.test(errMsg)) {
          console.error("Erreur parse-intent", e);
        }
        addMessage(
          "ai",
          "Erreur réseau ou serveur (parse-intent).",
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
        apiProcessingDepthRef.current = Math.max(0, apiProcessingDepthRef.current - 1);
      }
      return;
    }

    const requestBody = {
      messages: limitedMessages,
      player: snap.player,
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
    try {
      apiProcessingDepthRef.current += 1;
      if (msgType === "dice") setFailedRequestPayload(null);
      // Flag : évite de rendre la main au joueur après une transition de scène
      // (la suite est rejouée automatiquement via [SceneEntered]).
      let sceneUpdateApplied = false;
      /** Après cette réponse : combat sans ordre d'initiative → pas de narration MJ auto / pas d'auto-joueur « exploration » */
      let combatAwaitingInitiativeAfterResponse = false;
      // On tente jusqu'Ã  3 fois en cas d'erreur réseau/serveur avant d'abandonner.
      // Le message utilisateur n'est ajouté qu'une seule fois (au début de callApi).
      let lastError = null;
      let responseData = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const latest = gameStateRef.current;
          const effectiveRoomId =
            overrides?.currentRoomId ?? latest.currentRoomId ?? baseRoomId;
          const bodyToSend = {
            ...requestBody,
            player: latest.player,
            currentScene: overrides?.currentScene ?? latest.currentScene,
            currentRoomId: effectiveRoomId,
            entities: overrides?.entities ?? latest.entities,
            gameMode: overrides?.gameMode ?? latest.gameMode,
            provider: latest.aiProvider,
            debugMode: latest.debugMode,
            worldTimeMinutes,
            worldTimeLabel: formatWorldTimeLabel(worldTimeMinutes),
            roomMemory: getRoomMemory(effectiveRoomId),
            messages: limitedMessages,
            engineEvent,
          };
          const controller = new AbortController();
          const timeoutMs = 60000;
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
      const effectiveGameMode = newGameMode ?? baseGameMode;
      let actionIntentSafe = actionIntent;
      if (effectiveGameMode === "exploration" && typeof actionIntentSafe === "string") {
        actionIntentSafe = null;
      }

      let autoPlayerOverrides = null;

      // Permet de couper complètement la narration IA pour cette réponse
      // si le moteur invalide l'action (cible/arme/etc.).
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

      if (!isDebug && !rollRequestSafe && msgType !== "dice" && !combatLikeForIntent) {
        const knownSpells = Array.isArray(player?.selectedSpells) ? player.selectedSpells : [];
        const spellFromUser = findKnownSpellInText(userContent, knownSpells);
        const spellFromReply = findKnownSpellInText(String(safeReply ?? ""), knownSpells);
        const canonicalSpellName = spellFromUser ?? spellFromReply ?? null;
        if (canonicalSpellName) {
          const combined = `${userContent ?? ""} ${safeReply ?? ""}`;
          const target = findTargetFromText(combined, baseEntities);
          if (target) {
            rollRequestSafe = {
              kind: "attack",
              stat: "CHA",
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
      const engineSaysAlive =
        engineEvent?.targetIsAlive === true &&
        ["attack_resolution", "spell_save_resolution", "spell_attack_resolution"].includes(
          String(engineEvent?.kind ?? "")
        );
      if (engineSaysAlive) {
        const deathy = /(s['â€™]?(?:effondre|écroule|e?croule)|meurt|mort|sans vie|agonis(?:e|ant)|reste immobile|dernier souffle)/i;
        if (deathy.test(String(safeReply ?? ""))) {
          safeReply = rewriteDeathyToWounded(safeReply, engineEvent);
        }
      }

      const engineSaysDead =
        (engineEvent?.targetIsAlive === false ||
          engineEvent?.targetHpAfter === 0 ||
          (typeof engineEvent?.targetHpAfter === "number" && engineEvent?.targetHpAfter <= 0)) &&
        ["attack_resolution", "spell_save_resolution", "spell_attack_resolution"].includes(
          String(engineEvent?.kind ?? "")
        );
      if (engineSaysDead) {
        safeReply = enforceDeathNarrative(safeReply, engineEvent);
      }

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
      //    Exception : id ∈ encounterEntities de la salle courante (baseRoomId) OU de la salle cible du
      //    sceneUpdate du même tour (ex: embuscade sur scene_journey alors que le MJ envoie encore scene_village).
      // Source de vérité pour les transitions: DERNIER vrai message joueur uniquement.
      // Ne jamais se baser sur un texte système (continue/dice/debug) ni sur la narration MJ.
      const allowedSpawnIds = buildAllowedSpawnIdSet(baseRoomId, safeSceneUpdate);

      if (Array.isArray(normalizedEntityUpdates) && normalizedEntityUpdates.length) {
        const nextSpawnId = makeRuntimeSpawnIdFactory(baseEntities, normalizedEntityUpdates);
        const prepared = normalizedEntityUpdates.map((u) => {
          if (u?.action !== "spawn") return u;
          const sid = typeof u?.id === "string" ? u.id.trim() : "";
          const tid = typeof safeSceneUpdate?.targetRoomId === "string" ? safeSceneUpdate.targetRoomId : null;
          if (sid) {
            const lootHint =
              getEncounterBonusLootForRoom(baseRoomId, sid) ||
              (tid ? getEncounterBonusLootForRoom(tid, sid) : null);
            if (!Array.isArray(u?.lootItems)) {
              const fromInventory = Array.isArray(u?.inventory)
                ? u.inventory.map((x) => String(x ?? "").trim()).filter(Boolean)
                : [];
              if (fromInventory.length) {
                return { ...u, lootItems: fromInventory, looted: false };
              }
              if (lootHint) return { ...u, lootItems: [lootHint], looted: false };
            }
            return u;
          }
          const hint = u?.templateId ?? u?.name ?? u?.type ?? "spawn";
          const generatedId = nextSpawnId(hint);
          const lootHint =
            getEncounterBonusLootForRoom(baseRoomId, generatedId) ||
            (tid ? getEncounterBonusLootForRoom(tid, generatedId) : null);
          const withId = { ...u, id: generatedId };
          if (!Array.isArray(withId?.lootItems)) {
            const fromInventory = Array.isArray(withId?.inventory)
              ? withId.inventory.map((x) => String(x ?? "").trim()).filter(Boolean)
              : [];
            if (fromInventory.length) {
              return { ...withId, lootItems: fromInventory, looted: false };
            }
            if (lootHint) return { ...withId, lootItems: [lootHint], looted: false };
          }
          return withId;
        });
        const filtered = prepared.filter((u) => {
          if (u?.action !== "spawn") return true;
          const sid = typeof u?.id === "string" ? u.id.trim() : "";
          if (!sid) return false;
          // Politique permissive : id explicitement autorisé OU spawn basé template/name
          // (campagne texte brut, ids attribués côté moteur).
          if (allowedSpawnIds.has(sid)) return true;
          // Garde-fou: en exploration, ne pas autoriser un spawn "libre" (template/name)
          // sans demande explicite de transition par le joueur.
          if (typeof u?.templateId === "string" && u.templateId.trim()) return true;
          if (typeof u?.name === "string" && u.name.trim()) return true;
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
          const currentInv = Array.isArray(player?.inventory) ? player.inventory : [];
          updatePlayer({ inventory: [...currentInv, ...invGains] });
        }
      }

      // NOTE: l'hostilité déclenchée par un déplacement est un choix de MJ contextuel.
      // On ne filtre pas côté moteur; c'est l'IA (prompt) qui doit décider au cas par cas
      // quelles entités deviennent hostiles et pourquoi.

      // Logs: toujours enregistrés, affichés seulement quand Debug ON (filtrage UI)
      setApiLog({
        sent: {
          lastMessage: userContent,
          entityCount: baseEntities.length,
          gameMode: baseGameMode,
          provider: aiProvider,
          debugPrompt,
        },
        received: {
          reply: reply?.slice(0, 120) + (reply?.length > 120 ? "â€¦" : ""),
          rollRequest,
          actionIntent: actionIntentSafe,
          gameMode: newGameMode,
          entityUpdates,
          combatOrder: newCombatOrder,
          playerHpUpdate,
        },
      });

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

        if (normalizedEntityUpdates?.length) pendingEntityUpdatesForNarrationOrder = normalizedEntityUpdates;
        // Source de vérité du mode: présence d'hostiles uniquement (pas gameMode renvoyé par le GM).
        if (newCombatOrder) {
          setCombatOrder(newCombatOrder);
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
        const effOrderForIntent = newCombatOrder ?? combatOrder;
        let effTurnIdxForIntent = combatTurnIndex;
        // Nouveau combatOrder dans ce JSON = ordre d'initiative frais : le tour commence à l'index 0 (plus haute init).
        if (newCombatOrder?.length) effTurnIdxForIntent = 0;
        const isPlayerCombatTurn =
          effGameModeForIntent === "combat" &&
          effOrderForIntent.length > 0 &&
          controllerForCombatantId(effOrderForIntent[effTurnIdxForIntent]?.id, postEntities) === "player";
        const isCombatOpeningWithoutOrder =
          effGameModeForIntent === "combat" &&
          effOrderForIntent.length === 0 &&
          baseGameMode !== "combat";

        const actionIntentNorm = normalizeClientActionIntent(actionIntentSafe);

        if (
          !isDebug &&
          msgType !== "dice" &&
          actionIntentNorm &&
          (isPlayerCombatTurn || isCombatOpeningWithoutOrder)
        ) {
          const intentResult = executeCombatActionIntent(actionIntentNorm, {
            postEntities,
            player,
            gameMode: effGameModeForIntent,
            setGameMode,
            turnResources: turnResourcesRef.current,
            setTurnResources: setTurnResourcesSynced,
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
          });

          if (!intentResult.ok) {
            addMessage("ai", intentResult.userMessage, undefined, makeMsgId());
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
              pendingRollRef.current = intentResult.pendingRoll;
              setPendingRoll(intentResult.pendingRoll);
            }
          }
        }

        // Ne jamais accepter un nouveau rollRequest en réponse Ã  un résultat de dé ðŸŽ²
        // (évite les doubles jets pour la même action).
        const isDiceResult =
          msgType === "dice" && /^(?:🎲|ðŸŽ²)/i.test(String(userContent ?? ""));
        let effectiveRollRequest = isDiceResult ? null : rollRequestSafe;
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
            }
          }

          // Si on reconnaît un sort, on force le kind correct :
          // - sort Ã  save sur PNJ => on le traite comme une "attack" pour déclencher la résolution auto (sans jet joueur)
          // - kind:"spell" => "attack"
          if (canonicalSpellName) {
            const spell = SPELLS?.[canonicalSpellName];
            if (effectiveRollRequest.kind === "spell") {
              effectiveRollRequest.kind = "attack";
            }
            if (spell?.save && effectiveRollRequest.targetId && effectiveRollRequest.targetId !== "player") {
              effectiveRollRequest.kind = "attack";
            }
          }

          const isAttack = effectiveRollRequest.kind === "attack";
          const isSpellAttack =
            isAttack && !!canonicalSpellName;

          // Normaliser le bonus pour les attaques de sort : mod d'incantation + PB
          if (isSpellAttack) {
            const bonus = computeSpellAttackBonus(player);
            effectiveRollRequest.totalBonus = bonus;
          }

          // En combat : une seule Action d'attaque par tour.
          if (isAttack && gameMode === "combat" && !turnResourcesRef.current?.action) {
            addMessage(
              "ai",
              `âš  Vous avez déjÃ  utilisé votre **Action** ce tour-ci â€” impossible de lancer une nouvelle attaque. ` +
                `Terminez votre tour ou utilisez une action bonus/réaction si disponible.`,
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
            const isSrdWeapon = weaponDeclared
              ? Object.keys(WEAPONS ?? {}).some((n) => normalizeFr(n) === weaponNameNorm)
              : false;
            const weaponOk =
              isUnarmed ||
              isSpellAttack ||
              isOwnedWeapon;
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
              const showWeaponError =
                !weaponOk &&
                !isUnarmed &&
                weaponDeclared &&
                !isSpellAttack &&
                isSrdWeapon &&
                !isOwnedWeapon;
              addMessage(
                "ai",
                showWeaponError
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
              const meleeWith = getMeleeWith("player");
              const targetId = effectiveRollRequest.targetId;
              const inMeleeWithTarget = targetId && meleeWith.includes(targetId);
              const rangedLike =
                isRangedWeaponName(weaponName) ||
                /arc|arbal|fronde/i.test(weaponName) ||
                (!!isSpellAttack && meleeWith.length > 0 && !inMeleeWithTarget);
              if (gameMode === "combat" && !hasDisengagedThisTurn && rangedLike && inMeleeWithTarget) {
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

                  const resourceKind = resourceForCastingTime(spell.castingTime);
                  if (!hasResource(turnResourcesRef.current, gameMode, resourceKind)) {
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
                  consumeResource(setTurnResources, "combat", resourceKind);

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
                  let dmgDetail = `${dmgNotation} [${r.rolls.join("+")}]`;
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
              }

              // Pas un sort Ã  save â†’ on ouvre un rollRequest d'attaque normal pour le joueur.
              pendingRollRef.current = effectiveRollRequest;
              setPendingRoll(effectiveRollRequest);
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
            const computed = computeCheckBonus({ player, stat: effectiveRollRequest.stat, skill });
            const normalizedRoll = { ...effectiveRollRequest, skill: skill ?? undefined, totalBonus: computed };
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
        ensureCombatState(postEntities, newCombatOrder ?? null);

        {
          const hasHostileAfter = hasAnyCombatReadyHostile(postEntities);
          let effCombatOrder = hasHostileAfter
            ? (Array.isArray(newCombatOrder) ? newCombatOrder : baseCombatOrder)
            : [];
          let effGameMode = hasHostileAfter ? "combat" : "exploration";
          // Si on passe d'exploration -> combat (nouveaux hostiles) et que l'IA ne fournit pas
          // un combatOrder explicite (combatOrder: null/undefined), alors on considère que
          // l'initiative doit être "déclenchée" par l'UI/auto-joueur : on active donc le wait.
          // Cela évite le cas où baseCombatOrder contient encore des valeurs stales.
          const transitioningToCombat = baseGameMode !== "combat" && effGameMode === "combat";
          if (transitioningToCombat && !Array.isArray(newCombatOrder)) {
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
        clearMeleeFor("player");
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
          } else if (Array.isArray(safeSceneUpdate.newEntities) && safeSceneUpdate.newEntities.length > 0) {
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
                  sourceAction: userContent,
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
              `[DEBUG] sceneUpdate ignoré (déjà dans ${tid}).`,
              "debug",
              makeMsgId()
            );
          }
        }
        }
      }

      // Affichage de la narration IA (sauf si le moteur a invalidé l'action)
      // RÃˆGLE PROTOTYPE (STOP & ROLL côté UI) :
      // si un rollRequest est en attente (attaque/check/save joueur), on n'affiche JAMAIS une narration
      // potentiellement "résultat". On remplace par une narration d'intention déterministe.
      const isInternalGmSecretResolution =
        hideUserMessage === true &&
        msgType === "dice" &&
        engineEvent?.kind === "gm_secret_resolution";
      // Ne pas supprimer la narration gm_secret_resolution quand elle déclenche
      // un début de combat (spawns) : sinon tu perds l'introduction "arrivée des ennemis"
      // avant le jet d'initiative.
      if (isInternalGmSecretResolution && combatOrder.length > 0) {
        const hasSpawnUpdates = Array.isArray(entityUpdates)
          ? entityUpdates.some((u) => u && typeof u === "object" && u.action === "spawn")
          : false;
        if (!hasSpawnUpdates) {
          suppressReplyForThisResponse = true;
        }
      }
      const hasPendingRollRequest = !!rollRequestSafe && msgType !== "dice";
      // Règle stricte: dès qu'un jet est initialisé par le moteur (rollRequest),
      // on n'affiche aucune narration IA avant la résolution du dé.
      const suppressPreRollNarration = hasPendingRollRequest;
      let displayReply = suppressReplyForThisResponse
        ? ""
        : suppressPreRollNarration
          ? ""
          : (String(safeReply ?? "").trim() ||
             fallbackNarrativeFromRollRequest(rollRequestSafe ?? rollRequest, baseEntities));

      // Filet de sécurité : si l'IA renvoie une réponse "vide",
      // on ajoute une courte réaction neutre uniquement si on n'avait pas
      // explicitement demandé de supprimer la narration (gm_secret_resolution).
      if (!displayReply && !isDebug && !suppressReplyForThisResponse && !suppressPreRollNarration) {
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
      }

      triggerSceneImageFromNarratorDecision(imageDecision, {
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
      if (combatAwaitingInitiativeAfterResponse && displayReply) {
        // On débloque l'initiative uniquement si une narration a réellement été ajoutée au chat.
        // On retarde la libération (setTimeout 0) pour éviter que l'effet UI "commit initiative"
        // se déclenche avant que la narration GM apparaisse effectivement dans la liste des messages.
        setTimeout(() => {
          waitForGmNarrationForInitiativeLiveRef.current = false;
          setWaitForGmNarrationForInitiative(false);
        }, 0);
      }
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
      apiProcessingDepthRef.current = Math.max(0, apiProcessingDepthRef.current - 1);
      setIsTyping(false);
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
        const id = String(failedRequestPayload.enemyId ?? "").trim();
        const ent = (gameStateRef.current?.entities ?? entities ?? []).find((e) => e?.id === id);
        if (ent) {
          await simulateSingleEnemyTurn(ent);
        }
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
              120000,
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

    clearMeleeFor("player");
    setHasDisengagedThisTurn(false);
    if (Array.isArray(combatOrder) && combatOrder.length > 0) {
      const playerIdx = combatOrder.findIndex((entry) => entry?.id === "player");
      if (playerIdx >= 0) {
        commitCombatTurnIndex(playerIdx);
      }
      setGameMode("combat");
    }
    grantPlayerTurnResources();
    setReactionFor("player", true);
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
  const autoTurnInProgressRef = useRef(false);
  // Anti-enchaînement : l'auto-joueur ne doit pas proposer 2 actions successives
  // de suite sur le même tour joueur alors que l'état n'a pas changé.
  // IMPORTANT : on autorise une 2e exécution si les ressources (Action/Bonus/Réaction/Mouvement)
  // ont changé (ex: Action consommée -> Bonus disponible).
  const lastAutoPlayerActionByTurnKeyRef = useRef(null);

  async function runAutoPlayerTurn(overrides = null) {
    if (flowBlockedRef.current) return;
    if (!autoPlayerEnabledRef.current) return;
    if (autoTurnInProgressRef.current) return;
    if (rollResolutionInProgressRef.current) return;
    if (isGameOverRef.current) return;
    if ((gameStateRef.current?.player?.hp?.current ?? 1) <= 0) return;

    // STOP : combat sans ordre d'initiative → pas d'action « exploration » via l'API auto-joueur
    const snapEarly = gameStateRef.current;
    const inCombatNoOrder =
      snapEarly?.gameMode === "combat" &&
      (!snapEarly.combatOrder || snapEarly.combatOrder.length === 0) &&
      hasAnyCombatReadyHostile(snapEarly?.entities ?? []);
    if (inCombatNoOrder) {
      if (awaitingPlayerInitiativeRef.current) {
        // Le jet d'initiative du PJ est un "jet joueur" : ne jamais le lancer via auto-joueur.
        // Il ne peut être auto-résolu QUE si Auto Roll est ON.
        if (autoRollEnabledRef.current) handleCommitInitiative();
      }
      return;
    }
    if (pendingRollRef.current) {
      if (autoRollEnabledRef.current) {
        void handleRoll();
      }
      return;
    }

    // Pas d'auto-joueur tant qu'un callApi MJ est en cours (fetch ou post-traitement sceneUpdate).
    if (apiProcessingDepthRef.current > 0) return;
    // sceneUpdate.hasChanged → [SceneEntered] planifié : ne pas parler avant la fin de ce tour MJ.
    if (sceneEnteredPipelineDepthRef.current > 0) return;

    const snap0 = gameStateRef.current;
    if (!snap0) return;
    if (snap0.gameMode === "combat" && !isPlayerTurnNow(snap0)) return;
    // Toujours utiliser l'état courant (snap0.entities) :
    // les overrides peuvent contenir des entités "stales" (ex: gobelin déjà mort),
    // ce qui fait que l'auto-joueur cible des 0 PV.
    const effEntities = snap0.entities;
    const effRoomId = overrides?.currentRoomId ?? snap0.currentRoomId;
    const effScene = overrides?.currentScene ?? snap0.currentScene;
    const overridesForAutoCall = { ...(overrides ?? {}), skipAutoPlayerTurn: true };
    /** Historique API auto-joueur uniquement : consigne anti-boucle, pas un message joueur in-game. */
    const autoPlayerNudge = (content) => ({
      role: "user",
      type: "auto-player-nudge",
      content: String(content ?? "").trim(),
    });
    let intentErrorRetries = 0;

    const trSnap0 = turnResourcesRef.current ?? turnResources;
    const resourcesSig =
      snap0.gameMode === "combat" && trSnap0
        ? `a:${!!trSnap0.action}|b:${!!trSnap0.bonus}|r:${!!trSnap0.reaction}|m:${!!trSnap0.movement}`
        : "na";

    const autoActKey =
      snap0.gameMode === "combat"
        ? `combat:player:${combatTurnIndexLiveRef.current}:${resourcesSig}`
        : null;

    const lastMsg0 = Array.isArray(messagesRef.current) ? messagesRef.current[messagesRef.current.length - 1] : null;
    const lastMsgLooksLikeResolutionError =
      lastMsg0?.type === "intent-error" ||
      (lastMsg0?.type === "meta" && String(lastMsg0?.content ?? "").includes("❌ Action impossible"));

    // Si on a déjà déclenché une intention auto sur le même "tour joueur"
    // ET que les ressources n'ont pas changé, on bloque — sauf si on vient
    // de tomber sur une erreur de résolution (pour permettre un retry).
    if (autoActKey && lastAutoPlayerActionByTurnKeyRef.current === autoActKey && !lastMsgLooksLikeResolutionError) return;

    autoTurnInProgressRef.current = true;
    try {
      setIsAutoPlayerThinking(true);
      // IMPORTANT: pour l'auto-joueur, on retire les logs debug (latence/prompt/etc.)
      // sinon le modèle "voit" de l'information non-diégétique et peut boucler.
      const history = Array.isArray(messagesRef.current)
        ? messagesRef.current
            .filter((m) => {
              const t = m?.type;
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
        const engagedIds = getMeleeWith("player").filter((id) => {
          const ent = ents.find((e) => e.id === id);
          return !!ent && ent.isAlive && ent.type === "hostile";
        });
        const hostiles = ents.filter(
          (e) => e && e.visible !== false && !e?.hidden && e.isAlive && e.type === "hostile"
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
            reactionAvailable: hasReaction("player"),
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
          hostiles: hostiles.map((e) => ({
            id: e.id,
            name: e.name ?? e.id,
            inMeleeWithPlayer: engagedIds.includes(e.id),
            engagedWithIds: getMeleeWith(e.id),
          })),
          // Explicite des 0 PV pour éviter que l'auto-joueur tente des actions sur des morts
          deadHostiles: deadHostiles.map((e) => ({
            id: e.id,
            name: e.name ?? e.id,
            hpCurrent: e.hp?.current ?? 0,
          })),
          actionCatalog,
        };
      };
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
      };
      const { res, data } = await fetchJsonWithTimeout(
        "/api/auto-player",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        60000,
        "auto-player"
      );

      if (!res.ok || !data?.content) {
        console.warn("[auto-joueur] Échec API:", data?.error ?? res.status);
        return;
      }
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
          }),
        });
        const data2 = await res2.json().catch(() => ({}));
        if (!res2.ok || !data2?.content) return;

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
          }),
        });
        const data2 = await res2.json().catch(() => ({}));
        if (!res2.ok || !data2?.content) return;

        const autoContent2 = String(data2.content || "").trim();
        if (!autoContent2) return;

        lastAutoRepeatPatternRef.current = computeAutoRepeatPattern(autoContent2, effRoomId);
        lastAutoPlayerIntentRef.current = autoContent2;
        if (autoActKey) lastAutoPlayerActionByTurnKeyRef.current = autoActKey;
        await callApi(autoContent2, undefined, false, overridesForAutoCall);
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
          }),
        });
        const data2 = await res2.json().catch(() => ({}));
        if (!res2.ok || !data2?.content) return;

        const autoContent2 = String(data2.content || "").trim();
        if (!autoContent2) return;

        lastAutoPlayerIntentRef.current = autoContent2;
        if (autoActKey) lastAutoPlayerActionByTurnKeyRef.current = autoActKey;
        await callApi(autoContent2, undefined, false, overridesForAutoCall);
        return;
      }

      lastAutoPlayerIntentRef.current = autoContent;
      // Passer les overrides au MJ pour qu'il reçoive le bon lieu et les bonnes entités
      // (évite que le MJ parle de Thron/commis alors qu'on est sur scene_journey)
      const beforeLen = Array.isArray(messagesRef.current) ? messagesRef.current.length : 0;
      if (autoActKey) lastAutoPlayerActionByTurnKeyRef.current = autoActKey;
      await callApi(autoContent, undefined, false, overridesForAutoCall);

      // Si l'action auto a été refusée par le moteur (intent-error),
      // on relance l'auto-joueur une fois avec un nudge "légal".
      const after = Array.isArray(messagesRef.current)
        ? messagesRef.current.slice(beforeLen)
        : [];
      const lastAfter = after[after.length - 1];
      if (
        intentErrorRetries < 1 &&
        lastAfter?.type === "intent-error" &&
        autoPlayerEnabledRef.current &&
        gameStateRef.current?.gameMode === "combat" &&
        (gameStateRef.current?.combatOrder?.[combatTurnIndex]?.id ?? null) === "player"
      ) {
        intentErrorRetries += 1;
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
        };

        const res2 = await fetch("/api/auto-player", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload2),
        });
        const data2 = await res2.json().catch(() => ({}));
        const autoContent2 = String(data2.content || "").trim();
        if (res2.ok && autoContent2) {
          lastAutoPlayerIntentRef.current = autoContent2;
          if (autoActKey) lastAutoPlayerActionByTurnKeyRef.current = autoActKey;
          await callApi(autoContent2, undefined, false, overridesForAutoCall);
        }
      }
    } catch (err) {
      console.error("[auto-joueur]", err);
    } finally {
      autoTurnInProgressRef.current = false;
      setIsAutoPlayerThinking(false);
    }
  }

  // Déclencheur fiable : on appelle l'auto-joueur dès que l'UI du joueur est
  // "disponible" (tour player en combat, et/ou pendingRoll demandé par le moteur).
  const lastAutoAvailabilityKeyRef = useRef(null);
  useEffect(() => {
    if (!autoPlayerEnabledRef.current) return;
    if (flowBlockedRef.current) return;
    if (isTyping || isAutoPlayerThinking) return;
    if (isGameOverRef.current) return;
    if (awaitingPlayerInitiative) return;
    if (waitForGmNarrationForInitiative) return;
    if (sceneEnteredPipelineDepthRef.current > 0) return;
    if (apiProcessingDepthRef.current > 0) return;

    const pending = pendingRollRef.current;
    const pendingKey = pending
      ? `${pending.kind ?? ""}:${pending.stat ?? pending.skill ?? ""}:${pending.weaponName ?? ""}:${pending.targetId ?? ""}`
      : "none";

    if (gameMode === "combat") {
      if (!Array.isArray(combatOrder) || combatOrder.length === 0) return;
      const activeEntry = combatOrder[combatTurnIndex];
      if (!activeEntry || controllerForCombatantId(activeEntry.id) !== "player") return;
    } else if (gameMode !== "exploration" && gameMode !== "short_rest") {
      return;
    }

    const lastMsg = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null;
    const lastMsgId = lastMsg?.id ?? "";
    const availabilityKey = `${gameMode}:${combatTurnIndex}:${pendingKey}:${lastMsgId}`;
    if (availabilityKey === lastAutoAvailabilityKeyRef.current) return;
    lastAutoAvailabilityKeyRef.current = availabilityKey;

    // microtask : laisse React finir le traitement courant
    queueMicrotask(() => {
      void runAutoPlayerTurn(null);
    });
  }, [
    messages,
    gameMode,
    combatOrder,
    combatTurnIndex,
    pendingRoll,
    awaitingPlayerInitiative,
    waitForGmNarrationForInitiative,
    isTyping,
    isAutoPlayerThinking,
  ]);

  const lastAutoRollKeyRef = useRef(null);
  useEffect(() => {
    if (!autoRollEnabledRef.current) return;
    if (flowBlockedRef.current) return;
    if (rollResolutionInProgressRef.current) return;
    if (isTyping || isAutoPlayerThinking) return;
    if (isGameOverRef.current) return;

    const pending = pendingRollRef.current;
    if (!pending) {
      lastAutoRollKeyRef.current = null;
      return;
    }

    const autoKey = `${pending.kind ?? ""}:${pending.stat ?? pending.skill ?? ""}:${pending.weaponName ?? ""}:${pending.targetId ?? ""}:${pending.id ?? ""}:${pending.raison ?? ""}`;
    if (autoKey === lastAutoRollKeyRef.current) return;
    lastAutoRollKeyRef.current = autoKey;

    queueMicrotask(() => {
      if (!autoRollEnabledRef.current) return;
      if (!pendingRollRef.current) return;
      void handleRoll();
    });
  }, [pendingRoll, autoRollEnabled, autoPlayerEnabled, isTyping, isAutoPlayerThinking]);

  async function handleSend() {
    const trimmed = input.trim();
    if (isGameOver || (player?.hp?.current ?? 1) <= 0) return;
    // "Combat effectif" : parfois gameMode n'a pas encore été mis Ã  jour au moment
    // oÃ¹ le joueur enchaîne une action juste après une attaque qui a déclenché le combat.
    const effectiveInCombat =
      gameMode === "combat" || hasAnyCombatReadyHostile(entities) || (combatOrder?.length ?? 0) > 0;
    const hasOrder = effectiveInCombat && combatOrder.length > 0;
    const activeEntry = hasOrder ? combatOrder[combatTurnIndex] : null;
    const isMyTurn =
      !effectiveInCombat ||
      (awaitingPlayerInitiative
        ? false
        : !hasOrder
          ? false
          : controllerForCombatantId(activeEntry?.id) === "player");
    if (!trimmed || isTyping || retryCountdown > 0 || pendingRoll || flowBlocked || !isMyTurn) return;

    // Théâtre de l'esprit (moteur) : si engagé et tentative de s'éloigner sans Désengagement â†’ gate UX
    const hostilesInMelee = getMeleeWith("player").filter((id) => {
      const e = entities.find((x) => x.id === id);
      return e && e.type === "hostile" && e.isAlive;
    });
    if (
      effectiveInCombat &&
      hostilesInMelee.length > 0 &&
      !hasDisengagedThisTurn &&
      MOVE_AWAY_PATTERNS.test(trimmed)
    ) {
      setMovementGate({ text: trimmed, hostileIds: hostilesInMelee });
      addMessage(
        "ai",
        `Vous êtes au corps Ã  corps et vous tentez de vous éloigner. Choisissez : **Se désengager** (Action) ou **Partir quand même** (risque d'attaque d'opportunité).`,
        undefined,
        makeMsgId()
      );
      return;
    }

    setInput("");

    await callApi(trimmed);
  }

  async function handleEndTurn() {
    if (isGameOver || (player?.hp?.current ?? 1) <= 0) return;
    if (isTyping || retryCountdown > 0 || pendingRoll || flowBlocked) return;
    if (gameMode !== "combat") return;
    const activeEntry = combatOrder[combatTurnIndex];
    if (!activeEntry || controllerForCombatantId(activeEntry.id) !== "player") return;

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
    const activeEntry = combatOrder[combatTurnIndex];
    if (!activeEntry || controllerForCombatantId(activeEntry.id) !== "player") return;
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

    // CoÃ»t : Action bonus
    consumeResource(setTurnResources, "combat", "bonus");

    // Soin : 1d10 + niveau
    const r = rollDiceDetailed("1d10");
    const heal = Math.max(1, r.total + (player.level ?? 1));
    const nextHp = Math.min(player.hp.max, player.hp.current + heal);
    setHp(nextHp);
    playerHpRef.current = nextHp;

    // Décrément ressource (1/rest â€” repos non gérés ici, mais l'usage est tracké)
    updatePlayer({
      fighter: {
        ...(player.fighter ?? {}),
        resources: {
          ...(player.fighter?.resources ?? {}),
          secondWind: { max: 1, remaining: remaining - 1 },
        },
      },
    });

    addMessage(
      "ai",
      `ðŸŽ² Second souffle â€” 1d10 [${r.rolls.join("+")}] + niveau (${player.level}) = **${heal} PV** â†’ Vous : **${nextHp}/${player.hp.max} HP**`,
      "dice",
      makeMsgId()
    );
    addMessage(
      "ai",
      `[DEBUG] Second souffle (moteur)\n` +
        safeJson({
          rolls: r.rolls,
          heal,
          hpBefore: player.hp.current,
          hpAfter: nextHp,
          remainingBefore: remaining,
          remainingAfter: remaining - 1,
        }),
      "debug",
      makeMsgId()
    );
  }

  async function handleTurnUndead() {
    if (isTyping || retryCountdown > 0 || pendingRoll || flowBlocked) return;
    if (gameMode !== "combat") return;
    const activeEntry = combatOrder[combatTurnIndex];
    if (!activeEntry || controllerForCombatantId(activeEntry.id) !== "player") return;
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
    consumeResource(setTurnResources, "combat", "action");

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
    const activeEntry = combatOrder[combatTurnIndex];
    if (!activeEntry || controllerForCombatantId(activeEntry.id) !== "player") return;
    if (player?.entityClass !== "Roublard" || (player?.level ?? 1) < 2) return;
    if (!turnResourcesRef.current?.bonus) return;
    consumeResource(setTurnResources, "combat", "bonus");
    addMessage("ai", "ðŸƒ Ruse â€” vous foncez (Action bonus).", "meta-reply", makeMsgId());
  }

  async function handleCunningActionHide() {
    if (isTyping || retryCountdown > 0 || pendingRoll || flowBlocked) return;
    if (gameMode !== "combat") return;
    const activeEntry = combatOrder[combatTurnIndex];
    if (!activeEntry || controllerForCombatantId(activeEntry.id) !== "player") return;
    if (player?.entityClass !== "Roublard" || (player?.level ?? 1) < 2) return;
    if (!turnResourcesRef.current?.bonus) return;
    consumeResource(setTurnResources, "combat", "bonus");
    addMessage("ai", "ðŸ«¥ Ruse â€” vous tentez de vous cacher (Action bonus).", "meta-reply", makeMsgId());
    await callApi("Ruse : se cacher (action bonus).", "meta", false, {
      engineEvent: { kind: "cunning_action_hide" },
    });
  }

  async function handleCunningActionDisengage() {
    if (isTyping || retryCountdown > 0 || pendingRoll || flowBlocked) return;
    if (gameMode !== "combat") return;
    const activeEntry = combatOrder[combatTurnIndex];
    if (!activeEntry || controllerForCombatantId(activeEntry.id) !== "player") return;
    if (player?.entityClass !== "Roublard" || (player?.level ?? 1) < 2) return;
    if (!turnResourcesRef.current?.bonus) return;
    setHasDisengagedThisTurn(true);
    consumeResource(setTurnResources, "combat", "bonus");
    addMessage("ai", "ðŸ›¡ï¸ Ruse â€” vous vous désengagez (Action bonus).", "meta-reply", makeMsgId());
  }

  const arcaneRecoveryBudget = Math.ceil((player?.level ?? 1) / 2);
  const arcaneRecoveryUsed = !!player?.wizard?.arcaneRecovery?.used;

  function applyArcaneRecovery() {
    if (player?.entityClass !== "Magicien") return;
    if (!player?.spellSlots) return;
    if (arcaneRecoveryUsed) return;

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
        "âš  Restauration arcanique : aucune récupération appliquée (choisissez des emplacements dépensés).",
        undefined,
        makeMsgId()
      );
      return;
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
      `ðŸ§ª Repos court â€” **Restauration arcanique** : vous récupérez ${Object.entries(applied)
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
      consumeResource(setTurnResources, "combat", "action");
      for (const hostileId of hostileIds) {
        removeFromMelee("player", hostileId);
      }
      setMovementGate(null);
      setInput("");
      await callApi(gate.text);
      return;
    }

    // Partir quand même â†’ on simule une attaque d'opportunité immédiate (moteur), puis mouvement
    if (choice === "leave_anyway") {
      const moverSurvived = await processOpportunityAttacksForLeavingCombatant("player", hostileIds);
      setMovementGate(null);
      setInput("");
      if (!moverSurvived || (playerHpRef.current ?? player?.hp?.current ?? 0) <= 0) {
        return;
      }
      await callApi(gate.text);
    }
  }

  async function handleRoll() {
    const roll = pendingRollRef.current != null ? pendingRollRef.current : pendingRoll;
    if (!roll || isTyping || retryCountdown > 0 || flowBlocked) return;
    if (
      isGameOver ||
      ((player?.hp?.current ?? 1) <= 0 && roll.kind !== "death_save" && roll.kind !== "hit_die")
    ) {
      return;
    }
    rollResolutionInProgressRef.current = true;
    setIsTyping(true);
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

    if (roll.kind === "hit_die") {
      const hitDieNotation = String(roll?.engineContext?.hitDie ?? player?.hitDie ?? "d8");
      const dieRoll = rollDiceDetailed(hitDieNotation);
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
      if (!(remainingAfter > 0 && nextHp < maxHp)) {
        finishShortRest(
          remainingAfter > 0
            ? "Le repos court s'achève. Vous avez récupéré autant que nécessaire."
            : "Le repos court s'achève. Vous n'avez plus de dés de vie à dépenser."
        );
      }
      return;
    }

    if (roll.kind === "death_save") {
      const nat = debugNextRoll ?? (Math.floor(Math.random() * 20) + 1);
      if (debugNextRoll !== null) setDebugNextRoll(null);
      const stableHours = Math.floor(Math.random() * 4) + 1;
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
      } else if (nat >= 10) {
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

      if (restoredHp != null) {
        restorePlayerToConsciousness(restoredHp);
        addMessage(
          "ai",
          `🎲 Jet de sauvegarde contre la mort — Nat **20** ! Vous revenez à vous avec **1 PV** et pouvez agir normalement.`,
          "dice",
          makeMsgId()
        );
        return;
      }

      updatePlayerDeathState(nextDeathState);
      addMessage(
        "ai",
        `🎲 Jet de sauvegarde contre la mort — Nat ${nat} → ${
          nat >= 10
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
          `Vous êtes stabilisé à **0 PV**. Sans aide extérieure, vous récupérerez **1 PV** vers ${formatWorldTimeLabel(
            nextDeathState.autoRecoverAtMinute ?? worldTimeMinutes
          )}.`,
          "meta",
          makeMsgId()
        );
      }

      if (gameMode === "combat" && combatOrder?.[combatTurnIndex]?.id === "player") {
        addMessage("ai", `**${player?.name ?? "Vous"}** ne peut rien faire d'autre ce tour-ci.`, "turn-end", makeMsgId());
        addMessage("ai", "", "turn-divider", makeMsgId());
        await nextTurn();
      }
      return;
    }

    // -----------------------------------------------------------------------
    // Cas 1 : Attaque résolue par le moteur (anti-hallucinations)
    // -----------------------------------------------------------------------
    if (roll.kind === "attack" && roll.targetId) {
      const target = entities.find((e) => e.id === roll.targetId) ?? null;
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
        const spell = SPELLS?.[roll.weaponName];
        const spellLevel = spell?.level ?? 0;

        const resourceKind = resourceForCastingTime(spell?.castingTime);
        if (!hasResource(turnResources, gameMode, resourceKind)) {
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
        if (spell?.save && target) {
          const saveKey = spell.save; // "CON", "DEX", "SAG", etc.
          const nat = debugNextRoll ?? (Math.floor(Math.random() * 20) + 1);
          if (debugNextRoll !== null) setDebugNextRoll(null);
          const saveBonus = computeEntitySaveBonus(target, saveKey);
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

          let dmgDetail = `${dmgNotation} [${r.rolls.join("+")}]`;
          if (succeeded) {
            dmgDetail += " â†’ moitié dégâts";
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

          myUpdates = markSceneHostilesAware(entities, myUpdates);
          const nextEntities = myUpdates.length ? applyUpdatesLocally(entities, myUpdates) : entities;
          if (myUpdates.length) applyEntityUpdates(myUpdates);
          ensureCombatState(nextEntities);

          // Consomme la ressource appropriée (action / bonus / réaction)
          consumeResource(setTurnResources, gameMode, resourceKind);

          // Log debug détaillé
          addMessage(
            "ai",
            `[DEBUG] Résolution sort (save) ${roll.weaponName}\n` +
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

          const dmgLine =
            finalDmg > 0
              ? `${dmgDetail} = **${finalDmg} dégâts ${spell.damageType ?? ""}**`
              : "Aucun dégât.";

          const hpDebug = "";

          const content =
            `ðŸŽ² Jet de sauvegarde (${saveLabel} pour ${roll.weaponName} â†’ ${target.name}) â€” ${saveLine}\n` +
            `${outcome} ${dmgLine}.`;

          pendingRollRef.current = null;
          setPendingRoll(null);
          await callApi(content, "dice", false, {
            entities: nextEntities,
            engineEvent: {
              kind: "spell_save_resolution",
              spellName: roll.weaponName,
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

        // Cas 2: sort Ã  jet d'attaque (attaque de sort)
        const nat = debugNextRoll ?? (Math.floor(Math.random() * 20) + 1);
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
          const r1 = rollDiceDetailed(dmgNotation);
          if (crit) {
            const r2 = rollDiceDetailed(dmgNotation);
            dmg = Math.max(1, r1.total + r2.total);
            dmgDetail = formatDmgRoll(dmgNotation, r1.rolls, 0, true, r2.rolls);
          } else {
            dmg = Math.max(1, r1.total);
            dmgDetail = formatDmgRoll(dmgNotation, r1.rolls, 0);
          }

          const newHp = Math.max(0, target.hp.current - dmg);
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

        myUpdates = markSceneHostilesAware(entities, myUpdates);
        const nextEntities = myUpdates.length ? applyUpdatesLocally(entities, myUpdates) : entities;
        if (myUpdates.length) applyEntityUpdates(myUpdates);
        ensureCombatState(nextEntities);

        // Consomme la ressource appropriée (action / bonus / réaction)
        consumeResource(setTurnResources, gameMode, resourceKind);

        const hpBefore = target?.hp?.current ?? null;
        const hpAfter =
          target?.hp
            ? (myUpdates.some((u) => u.action === "kill" && u.id === target.id) ? 0 :
                (myUpdates.find((u) => u.action === "update" && u.id === target.id)?.hp?.current ?? target.hp.current))
            : null;

        const hpDebug = "";

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

        // Log debug détaillé
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
        return;
      }

      weapon = weapon ?? player.weapons[0] ?? null;

      // Si on ne peut pas résoudre proprement (pas de cible/arme/CA), on fallback en jet simple.
      if (!target || !weapon || target.ac === null) {
        const nat   = Math.floor(Math.random() * 20) + 1;
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
        await callApi(content, "dice");
        return;
      }

      const nat = debugNextRoll ?? (Math.floor(Math.random() * 20) + 1);
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
      let sneakApplied = false;
      let sneakDice = null;
      let sneakRoll = null;
      let sneakDamage = 0;

      if (nat === 1) {
        hit = false;
      } else if (nat === 20) {
        hit = true;
        crit = true;
      } else {
        hit = total >= ac; // IMPORTANT: >= en D&D 5e
      }

      // Dégâts (si touché)
      let myUpdates = [];
      // Toute attaque rend la cible hostile (au moins) â†’ participe au combat
      if (target.type !== "hostile") {
        myUpdates.push({ id: target.id, action: "update", type: "hostile" });
      }
      if (hit && target.hp) {
        const r1 = rollDiceDetailed(weapon.damageDice);
        const dmgBonus =
          atkParts.abilityModValue + (atkParts?.style?.duelBonusDmg ?? 0); // Duel (+2) si applicable
        if (crit) {
          const r2 = rollDiceDetailed(weapon.damageDice);
          dmg = Math.max(1, r1.total + r2.total + dmgBonus);
          dmgDetail = formatDmgRoll(weapon.damageDice, r1.rolls, dmgBonus, true, r2.rolls);
        } else {
          dmg = Math.max(1, r1.total + dmgBonus);
          dmgDetail = formatDmgRoll(weapon.damageDice, r1.rolls, dmgBonus);
        }

        // Attaque sournoise (Roublard) â€” déterministe via toggle (1/turn)
        if (player?.entityClass === "Roublard" && sneakAttackArmed && !sneakAttackUsedThisTurn) {
          const wdb = atkParts?.weaponDb ?? null;
          const props = Array.isArray(wdb?.properties) ? wdb.properties : [];
          const isRanged = props.some((p) => normalizeFr(p).includes("munitions"));
          const isFinesse = String(wdb?.stat ?? "") === "FINESSE";
          if (isRanged || isFinesse) {
            sneakDice = ROGUE_SNEAK_ATTACK_DICE_BY_LEVEL?.[player.level ?? 1] ?? "1d6";
            sneakRoll = rollDiceDetailed(String(sneakDice));
            sneakDamage = Math.max(0, sneakRoll.total);
            if (sneakDamage > 0) {
              dmg += sneakDamage;
              sneakApplied = true;
              dmgDetail =
                `${dmgDetail} + Attaque sournoise ${sneakDice} [${sneakRoll.rolls.join("+")}] = **${sneakDamage} dégâts**`;
            }
            setSneakAttackUsedThisTurn(true);
            setSneakAttackArmed(false);
          } else {
            setSneakAttackArmed(false);
            addMessage(
              "ai",
              "âš  Attaque sournoise : arme non éligible (finesse ou Ã  distance requise).",
              undefined,
              makeMsgId()
            );
          }
        }

        const newHp = Math.max(0, target.hp.current - dmg);
        if (newHp <= 0) {
          myUpdates.push({ id: target.id, action: "kill" });
        } else {
          // Si on a déjÃ  un update (type hostile), on le complète avec les HP
          const idx = myUpdates.findIndex((u) => u.action === "update" && u.id === target.id);
          if (idx >= 0) {
            myUpdates[idx] = { ...myUpdates[idx], hp: { current: newHp, max: target.hp.max } };
          } else {
            myUpdates.push({ id: target.id, action: "update", hp: { current: newHp, max: target.hp.max } });
          }
        }
      }

      // Appliquer au state local + snapshot pour l'API (anti race condition)
      myUpdates = markSceneHostilesAware(entities, myUpdates);
      const nextEntities = myUpdates.length ? applyUpdatesLocally(entities, myUpdates) : entities;
      if (myUpdates.length) applyEntityUpdates(myUpdates);
      // Assurer le mode combat côté moteur (hostiles présents => combat)
      ensureCombatState(nextEntities);

      // Log moteur (toujours enregistré, visible uniquement en debug)
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
            sneak: sneakApplied
              ? { dice: sneakDice, rolls: sneakRoll?.rolls ?? [], damage: sneakDamage }
              : null,
            hpAfter: target.hp ? Math.max(0, target.hp.current - dmg) : null,
            appliedUpdate: myUpdates[0] ?? null,
          }),
        "debug"
      );

      // Message visible joueur : pas de PV/CA divulgués, juste le jet + dégâts.
      // En debug : on ajoute les PV avant/après.
      const hpDebug = "";

      let content;
      const styleAtkStr = (atkParts?.style?.archeryBonus ?? 0) ? ` + Style ${fmtMod(atkParts.style.archeryBonus)}` : "";
      const atkBreakdown =
        `${nat} + ${atkParts.abilityKey} ${fmtMod(atkParts.abilityModValue)} + PB ${fmtMod(atkParts.pb)}` +
        `${styleAtkStr} = **${total}**`;
      if (nat === 1) {
        content = `ðŸŽ² Attaque (${weapon.name} â†’ ${target.name}) â€” Nat **1** ðŸ’€ FUMBLE ! ${atkBreakdown} â†’ Raté.`;
      } else if (nat === 20) {
        content = `ðŸŽ² Attaque (${weapon.name} â†’ ${target.name}) â€” Nat **20** ðŸ’¥ CRITIQUE ! ${atkBreakdown} â†’ Touché ! ${dmgDetail}.`;
      } else if (hit) {
        content = `ðŸŽ² Attaque (${weapon.name} â†’ ${target.name}) â€” ${atkBreakdown} â†’ Touché ! ${dmgDetail}.`;
      } else {
        content = `ðŸŽ² Attaque (${weapon.name} â†’ ${target.name}) â€” ${atkBreakdown} â†’ Raté.`;
      }

      // Théâtre de l'esprit (moteur) : une attaque de mêlée engage au corps Ã  corps
      if (!isRangedWeaponName(weapon.name)) {
        addMeleeMutual("player", target.id);
      }

      // Ressources (moteur) : Attaquer consomme l'Action
      consumeResource(setTurnResources, "combat", "action");

      pendingRollRef.current = null;
      setPendingRoll(null);
      const hpAfter =
        target.hp
          ? (myUpdates.some((u) => u.action === "kill" && u.id === target.id) ? 0 :
              (myUpdates.find((u) => u.action === "update" && u.id === target.id)?.hp?.current ?? target.hp.current))
          : null;

      await callApi(content, "dice", false, {
        entities: nextEntities,
        engineEvent: {
          kind: "attack_resolution",
          targetId: target.id,
          targetName: target.name,
          hit,
          crit,
          damage: hit ? dmg : 0,
          sneakAttackApplied: sneakApplied,
          sneakAttackDice: sneakApplied ? sneakDice : null,
          sneakAttackDamage: sneakApplied ? sneakDamage : 0,
          targetHpBefore: target.hp?.current ?? null,
          targetHpAfter: hpAfter,
          targetHpMax: target.hp?.max ?? null,
          targetIsAlive: hpAfter === null ? true : hpAfter > 0,
        },
      });
      return;
    }

    // -----------------------------------------------------------------------
    // Cas 2 : Jet générique (compétence, etc.)
    // -----------------------------------------------------------------------
    const nat   = debugNextRoll ?? (Math.floor(Math.random() * 20) + 1);
    if (debugNextRoll !== null) setDebugNextRoll(null);
    const total = nat + roll.totalBonus;
    const bonus = fmtMod(roll.totalBonus);

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
        } ${finalDmg > 0 ? `${dmgNotation} [${r.rolls.join("+")}] = **${finalDmg} dégâts ${engineContext.damageType ?? ""}**.` : "Aucun dégât."}`,
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
    if (roll.kind === "check" && roll.skill === "Perception") {
      for (const e of entities) {
        if (!e.visible && e.isAlive && typeof e.stealthDc === "number" && total >= e.stealthDc) {
          revealUpdates.push({ id: e.id, action: "update", visible: true });
        }
      }
    }

    // Règle moteur explicite pour scene_journey :
    // d100 embuscade (<= 80) => spawn gobelins + combat ; sinon transition room_intro.
    const skillNorm = normalizeFr(String(roll.skill ?? ""));
    const canResolveJourneyAmbush =
      currentRoomId === "scene_journey" &&
      roll.kind === "check" &&
      success === true &&
      (skillNorm.includes("perception") || skillNorm.includes("survie") || skillNorm.includes("survival"));
    const hasAliveHostile = (Array.isArray(entities) ? entities : []).some((e) => {
      if (!e || typeof e !== "object") return false;
      if (e.type !== "hostile") return false;
      const hpCur = typeof e?.hp?.current === "number" ? e.hp.current : null;
      return e.isAlive !== false && (hpCur == null || hpCur > 0);
    });

    let ambushTriggered = null;
    let ambushRoll = null;
    let spawnedHostileIds = [];
    let sceneTransitionTargetRoomId = null;
    let extraUpdates = [];

    if (canResolveJourneyAmbush && !hasAliveHostile) {
      ambushRoll = Math.floor(Math.random() * 100) + 1;
      ambushTriggered = ambushRoll <= 80;
      if (ambushTriggered) {
        const spawnCount = Math.random() <= 0.8 ? 3 : 2;
        for (let i = 0; i < spawnCount; i += 1) {
          const spawnId = `goblin_ambush_${i + 1}`;
          spawnedHostileIds.push(spawnId);
          extraUpdates.push({
            id: spawnId,
            action: "spawn",
            templateId: "goblin",
            type: "hostile",
            visible: true,
            surprised: nat === 20,
            lootItems: ["18 pa"],
          });
        }
      } else {
        sceneTransitionTargetRoomId = "room_intro";
      }
    }

    const allUpdates = [...revealUpdates, ...extraUpdates];
    let nextEntities = allUpdates.length ? applyUpdatesLocally(entities, allUpdates) : entities;
    if (allUpdates.length) applyEntityUpdates(allUpdates);

    let nextRoomId = currentRoomId;
    let nextScene = currentScene;
    let nextSceneName = currentSceneName;
    if (sceneTransitionTargetRoomId) {
      const targetRoom = GOBLIN_CAVE?.[sceneTransitionTargetRoomId] ?? null;
      if (targetRoom) {
        rememberRoomEntitiesSnapshot(currentRoomId, nextEntities);
        nextRoomId = targetRoom.id;
        nextScene = targetRoom.description ?? currentScene;
        nextSceneName = targetRoom.title ?? currentSceneName;
        nextEntities = takeEntitiesForRoom(nextRoomId);
        setCurrentRoomId(nextRoomId);
        if (nextSceneName) setCurrentSceneName(nextSceneName);
        if (nextScene) setCurrentScene(nextScene);
        replaceEntities(nextEntities);
        gameStateRef.current = {
          ...gameStateRef.current,
          currentRoomId: nextRoomId,
          currentScene: nextScene,
          currentSceneName: nextSceneName,
          entities: nextEntities,
        };
      }
    }
    ensureCombatState(nextEntities);

    if (
      roll.returnToArbiter === true &&
      roll.sceneArbiterContext &&
      typeof roll.sceneArbiterContext === "object"
    ) {
      const ctx = roll.sceneArbiterContext;
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
      entities: nextEntities,
      currentRoomId: nextRoomId,
      currentScene: nextScene,
      currentSceneName: nextSceneName,
      gameMode:
        ambushTriggered === true
          ? "combat"
          : sceneTransitionTargetRoomId
          ? "exploration"
          : gameMode,
      engineEvent: {
        kind: "skill_resolution",
        skill: roll.skill ?? roll.stat,
        stat: roll.stat ?? null,
        total,
        dc,
        success,
        targetId: roll.targetId ?? null,
        revealedEntityIds: revealUpdates.length ? revealUpdates.map((u) => u.id) : null,
        ambushRoll,
        ambushTriggered,
        spawnedHostileIds: spawnedHostileIds.length ? spawnedHostileIds : null,
        sceneTransitionTargetRoomId: sceneTransitionTargetRoomId ?? null,
      },
    });
    } finally {
      rollResolutionInProgressRef.current = false;
      setIsTyping(false);
    }
  }

  async function handleDebugSend() {
    const trimmed = debugInput.trim();
    if (!trimmed || isTyping) return;

    const requestBody = {
      command: trimmed,
      provider: aiProvider === "gemini" ? "gemini" : "openrouter",
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

      setApiLog({
        sent: {
          route: "/api/debug-godmode",
          command: trimmed,
          roomId: currentRoomId,
          gameMode,
          provider: requestBody.provider,
        },
        received: data,
      });

      if (!res.ok) {
        throw new Error(String(data?.details ?? data?.error ?? `Erreur HTTP ${res.status}`));
      }

      applyGodmodeResponse(data, trimmed);
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
  const hasOrder = isInCombat && combatOrder.length > 0;
  const activeEntry = hasOrder ? combatOrder[combatTurnIndex] : null;
  // En combat : pas de message tant qu'il n'y a pas d'ordre, qu'on attend l'initiative du joueur, ou que ce n'est pas le tour du PJ.
  const isMyTurn =
    !isInCombat ||
    (awaitingPlayerInitiative
      ? false
      : !hasOrder
        ? false
        : controllerForCombatantId(activeEntry?.id) === "player");
  // Bandeau jaune « Jet requis » : bloquer saisie (humain + cohérence avec l’auto-joueur)
  const playerDeadOrOver =
    isGameOver || (typeof player?.hp?.current === "number" && player.hp.current <= 0);
  const inputBlocked =
    isTyping ||
    isAutoPlayerThinking ||
    sceneEnteredPipelineDepthRef.current > 0 ||
    retryCountdown > 0 ||
    flowBlocked ||
    !!pendingRoll ||
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
                  {repairMojibakeForDisplay("Repos court â€” Restauration arcanique")}
                </p>
                <p className="text-[11px] text-slate-400">
                  {repairMojibakeForDisplay(
                    `Budget: ${arcaneRecoveryBudget} (â‰¤ moitié niveau, arrondi sup). Interdit de récupérer des emplacements â‰¥ niv 6.`
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setArcaneRecoveryOpen(false)}
                className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                {repairMojibakeForDisplay("âœ•")}
              </button>
            </div>

            <div className="p-5 space-y-3">
              {arcaneRecoveryUsed ? (
                <p className="text-sm text-amber-300">
                  {repairMojibakeForDisplay("Restauration arcanique déjÃ  utilisée aujourdâ€™hui (1/jour).")}
                </p>
              ) : (
                <>
                  <p className="text-xs text-slate-300">
                    {repairMojibakeForDisplay(
                      "Choisis combien dâ€™emplacements récupérer par niveau (1 Ã  5). Le total dépensé ne doit pas dépasser le budget."
                    )}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {[1, 2, 3, 4, 5].map((lvl) => {
                      const row = player?.spellSlots?.[lvl];
                      if (!row) return null;
                      const max = Number(row.max ?? 0) || 0;
                      const remaining = Number(row.remaining ?? max) || 0;
                      const missing = Math.max(0, max - remaining);
                      if (missing <= 0) return null;
                      const value = Number(arcaneRecoveryPick?.[lvl] ?? 0) || 0;
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
                              max={missing}
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
                disabled={arcaneRecoveryUsed}
                onClick={() => {
                  applyArcaneRecovery();
                  setArcaneRecoveryOpen(false);
                  setArcaneRecoveryPick({});
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
            title="Quand ce mode est activé, tous les jets joueur en attente (attaque, sauvegarde, compétence, etc.) sont lancés et résolus automatiquement par le moteur."
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

        {/* Repos court (Magicien) */}
        {player?.entityClass === "Magicien" && (
          <button
            type="button"
            onClick={() => setArcaneRecoveryOpen(true)}
            disabled={isTyping || retryCountdown > 0 || !!pendingRoll || flowBlocked}
            className="shrink-0 rounded px-2.5 py-1 text-xs font-medium transition-colors border border-emerald-700/60 bg-emerald-950/20 text-emerald-200 hover:bg-emerald-950/40 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Repos court : Restauration arcanique (1/jour)"
          >
            Repos court
          </button>
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={() => setDebugMode(!debugMode)}
            className={`shrink-0 rounded px-2.5 py-1 text-xs font-medium transition-colors ${debugMode ? "bg-teal-600 text-white shadow" : "text-slate-500 hover:bg-slate-700 hover:text-slate-200"}`}
          >
            {repairMojibakeForDisplay("ðŸ”§")} {debugMode ? "Debug ON" : "Debug"}
          </button>
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
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((msg) => {
          // Message [Continue] : masqué (prompt système pour poursuite MJ)
          if (msg.type === "continue") return null;

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

          // Logs debug : masqués tant que Debug OFF
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

          // Message joueur â€” droite, bleu
          if (msg.role === "user") {
            return (
              <div key={msg.id} className="flex justify-end">
                <div className="max-w-[75%] rounded-2xl rounded-tr-sm bg-blue-600 px-4 py-2 text-sm text-white shadow">
                  <p className="mb-1 text-xs font-semibold text-blue-200">Vous</p>
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
        {isTyping && (
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
                  {repairMojibakeForDisplay("Le MJ réfléchitâ€¦")}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Indicateur "L'IA joueur réfléchitâ€¦" */}
        {isAutoPlayerThinking && !isTyping && (
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
                  {repairMojibakeForDisplay("L'IA joueur réfléchitâ€¦")}
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

      {/* Bandeau jet de dé (ne pas spoiler pendant la narration MJ) */}
      {pendingRoll && !autoRollEnabled && !isTyping && !waitForGmNarrationForInitiative && (
        <div className="border-t border-yellow-600/40 bg-yellow-950/40 px-4 py-3 flex items-center justify-between gap-4 shrink-0">
          <div className="text-xs leading-relaxed text-yellow-200">
            <p className="font-semibold text-yellow-100">
              {repairMojibakeForDisplay("ðŸŽ²")} Jet requis : {getPublicPendingRollTitle(pendingRoll).replace(/^Jet de\s+/i, "")}
            </p>
            <p className="text-yellow-400">
              D20 {fmtMod(pendingRoll.totalBonus)} ({pendingRoll.skill ?? pendingRoll.stat})
            </p>
          </div>
          <button
            onClick={handleRoll}
            disabled={isTyping || retryCountdown > 0 || flowBlocked}
            className="shrink-0 animate-pulse rounded-lg border border-yellow-400 bg-yellow-500 px-5 py-2 text-sm font-bold text-slate-900 shadow-lg hover:bg-yellow-400 active:bg-yellow-600 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {repairMojibakeForDisplay("ðŸŽ²")} Lancer le dé
          </button>
        </div>
      )}

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

          {/* Forcer prochain D20 */}
          <div className="flex items-center gap-2 text-xs text-teal-200">
            <span className="text-teal-400 font-semibold">
              {repairMojibakeForDisplay("ðŸŽ²")} Forcer le prochain D20 :
            </span>
            <input
              type="number"
              min={1}
              max={20}
              value={debugNextRoll ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) { setDebugNextRoll(null); return; }
                const n = Math.max(1, Math.min(20, Number(v)));
                setDebugNextRoll(Number.isNaN(n) ? null : n);
              }}
              className="w-16 rounded border border-teal-600/60 bg-teal-900/30 px-2 py-1 text-xs text-teal-100 placeholder-teal-700 outline-none focus:border-teal-400"
              placeholder="1-20"
            />
            {debugNextRoll !== null && (
              <button
                onClick={() => setDebugNextRoll(null)}
                className="rounded border border-teal-600/60 px-2 py-0.5 text-[10px] text-teal-200 hover:bg-teal-800/60"
              >
                Réinitialiser
              </button>
            )}
          </div>

          {/* Log du dernier échange API */}
          {apiLog && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-teal-600 hover:text-teal-400 select-none">
                {repairMojibakeForDisplay("ðŸ“‹")} Dernier échange API (cliquer pour voir)
              </summary>
              <div className="mt-2 rounded border border-slate-700 bg-slate-900 p-2 text-xs font-mono text-slate-400 overflow-auto max-h-56 space-y-2">
                <div>
                  <p className="text-teal-600 font-semibold mb-1">
                    {repairMojibakeForDisplay("â†’ ENVOYÃ‰")}
                  </p>
                  <pre className="whitespace-pre-wrap">{JSON.stringify(apiLog.sent, null, 2)}</pre>
                </div>
                <div>
                  <p className="text-indigo-400 font-semibold mb-1">
                    {repairMojibakeForDisplay("â† REÃ‡U")}
                  </p>
                  <pre className="whitespace-pre-wrap">{JSON.stringify(apiLog.received, null, 2)}</pre>
                </div>
              </div>
            </details>
          )}
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
            disabled={playerDeadOrOver || !turnResourcesRef.current?.reaction || !hasReaction("player")}
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

      {gameMode === "combat" && awaitingPlayerInitiative && !isTyping && !waitForGmNarrationForInitiative && (
        <div className="border-t border-amber-800/50 bg-amber-950/40 px-4 py-3 flex flex-wrap items-center gap-3 shrink-0">
          <div className="text-xs text-amber-100 flex-1 min-w-[200px]">
            <span className="font-semibold text-amber-200">Initiative</span>
            {" - "}
            Cliquez pour lancer votre d20
          </div>
          <button
            type="button"
            onClick={handleCommitInitiative}
            disabled={isTyping || playerDeadOrOver || waitForGmNarrationForInitiative}
            className="rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-40"
          >
            Lancer l&apos;initiative
          </button>
        </div>
      )}

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
                      : pendingRoll
                        ? "Lancez d'abord le dé demandé par le MJâ€¦"
                        : awaitingPlayerInitiative
                          ? "Lancez d'abord votre initiative (bouton ci-dessus)â€¦"
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
