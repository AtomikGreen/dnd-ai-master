import { buildPendingDiceRoll, getPendingRollDiceDescriptor } from "@/lib/pendingDiceRoll";
import {
  isWeaponDamageRollIdResolved,
  markWeaponDamageRollIdResolved,
} from "@/lib/weaponDamageRollDedupe";

function manualDiceFromInputs(manualNatOverride, manualDiceNats) {
  if (Array.isArray(manualDiceNats) && manualDiceNats.length > 0) {
    const rolls = manualDiceNats.map((n) => Math.trunc(Number(n)));
    if (rolls.some((n) => !Number.isFinite(n))) return null;
    const diceSum = rolls.reduce((a, b) => a + b, 0);
    return { diceSum, rolls };
  }
  if (manualNatOverride != null && Number.isFinite(manualNatOverride)) {
    const v = Math.trunc(manualNatOverride);
    return { diceSum: v, rolls: [v] };
  }
  return null;
}

function formatHealRollDetail(rollNotation, rolls, flatBonus, manual = false, bonusStyle = "spell") {
  const seq = Array.isArray(rolls) ? rolls : [];
  const diceSum = seq.reduce((a, b) => a + Number(b || 0), 0);
  const bonus = Number.isFinite(flatBonus) ? Math.trunc(flatBonus) : 0;
  const total = Math.max(0, diceSum + bonus);
  const bonusPart =
    bonus === 0
      ? ""
      : bonus > 0
        ? bonusStyle === "item"
          ? ` + ${bonus} (fixe)`
          : ` + bonus d'incantation ${bonus}`
        : bonusStyle === "item"
          ? ` ${bonus} (fixe)`
          : ` - malus d'incantation ${Math.abs(bonus)}`;
  return `${rollNotation} [${seq.join("+")}]${bonusPart} = **${total} soins**${manual ? " (manuel)" : ""}`;
}

function normalizeEntityNameForMatch(v) {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function entityIdsEqualCaseInsensitive(a, b) {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

/** Repère l'id tel qu'il existe dans le pool (casse / variante) pour que `applyEntityUpdates` matche. */
function canonicalEntityIdFromPool(entPool, id) {
  const want = String(id ?? "").trim();
  if (!want) return want;
  const pool = Array.isArray(entPool) ? entPool : [];
  const hit = pool.find((e) => e && entityIdsEqualCaseInsensitive(e.id, want));
  return hit && hit.id != null ? String(hit.id).trim() : want;
}

/**
 * Toutes les fiches à mettre à jour (doublons logiques, casse d'id, PNJ sans `hp` sur un clone).
 */
function collectHealTargetEntityIdsForApply(entPool, target) {
  const pool = Array.isArray(entPool) ? entPool : [];
  if (!target || !target.id) return [];
  const nameNorm = normalizeEntityNameForMatch(target.name);
  const ids = new Set();
  const canon = canonicalEntityIdFromPool(pool, target.id);
  if (canon) ids.add(canon);
  for (const e of pool) {
    if (!e) continue;
    const eid = String(e.id ?? "").trim();
    if (!eid) continue;
    if (entityIdsEqualCaseInsensitive(eid, target.id)) {
      ids.add(eid);
      continue;
    }
    if (nameNorm && normalizeEntityNameForMatch(e.name) === nameNorm) {
      ids.add(eid);
    }
  }
  return Array.from(ids).filter(Boolean);
}

/** Soins : inclure PNJ à 0 PV (isAlive parfois false) tant que pas mort au sens deathState. */
function entityEligibleForHealSceneLookup(e) {
  if (!e) return false;
  if (e.deathState && typeof e.deathState === "object" && e.deathState.dead === true) return false;
  return true;
}

/** Aligné sur `findLivingTarget` dans ChatInterface : PJ multijoueur souvent absent de `entities`. */
function normalizeFrHeal(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[\u2019\u2018]/g, "'")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Résout une cible de soin depuis le pool d'entités + profils multijoueur (mp-player-*).
 * @param {string|null|undefined} targetId
 * @param {unknown[]} entPool
 * @param {{ localCombatantId?: string, player?: unknown, multiplayerParticipantProfiles?: unknown[] }} opts
 */
export function resolveHealTargetEntityFromPool(targetId, entPool, opts) {
  const {
    localCombatantId = "player",
    player = null,
    multiplayerParticipantProfiles = null,
  } = opts ?? {};
  if (targetId == null || targetId === "") return null;
  const sid = String(targetId).trim();
  if (!sid) return null;
  const sidNorm = normalizeFrHeal(sid);
  const pool = Array.isArray(entPool) ? entPool : [];

  const fromScene =
    pool.find(
      (e) => e && String(e.id ?? "").trim() === sid && entityEligibleForHealSceneLookup(e)
    ) ??
    pool.find(
      (e) =>
        e &&
        entityIdsEqualCaseInsensitive(e.id, sid) &&
        entityEligibleForHealSceneLookup(e)
    ) ??
    null;
  if (fromScene) return fromScene;

  const fromSceneByName =
    pool.find(
      (e) =>
        e &&
        entityEligibleForHealSceneLookup(e) &&
        normalizeFrHeal(String(e?.name ?? "")) === sidNorm
    ) ??
    pool.find((e) => {
      if (!e || !entityEligibleForHealSceneLookup(e)) return false;
      const n = normalizeFrHeal(String(e?.name ?? ""));
      return !!n && !!sidNorm && (n.includes(sidNorm) || sidNorm.includes(n));
    }) ??
    null;
  if (fromSceneByName) return fromSceneByName;

  const mpPrefix = "mp-player-";
  if (!sid.startsWith(mpPrefix)) return null;
  const cid = sid.slice(mpPrefix.length).trim();
  if (!cid) return null;

  if (String(localCombatantId ?? "").trim() === sid && player) {
    const dead = player?.deathState?.dead === true;
    if (dead) return null;
    return {
      ...player,
      id: sid,
      name: player.name ?? "Vous",
      type: player.type ?? "friendly",
      controller: "player",
      visible: player.visible !== false,
      isAlive: true,
      hp: player.hp ?? null,
    };
  }

  const profs = Array.isArray(multiplayerParticipantProfiles) ? multiplayerParticipantProfiles : [];
  const prof = profs.find((p) => String(p?.clientId ?? "").trim() === cid) ?? null;
  if (!prof || prof.connected === false) return null;
  const sheet = prof?.playerSnapshot && typeof prof.playerSnapshot === "object" ? prof.playerSnapshot : null;
  const cur =
    typeof prof.hpCurrent === "number" && Number.isFinite(prof.hpCurrent)
      ? Math.trunc(prof.hpCurrent)
      : typeof sheet?.hp?.current === "number" && Number.isFinite(sheet.hp.current)
        ? Math.trunc(sheet.hp.current)
        : null;
  const max =
    typeof prof.hpMax === "number" && Number.isFinite(prof.hpMax)
      ? Math.trunc(prof.hpMax)
      : typeof sheet?.hp?.max === "number" && Number.isFinite(sheet.hp.max)
        ? Math.trunc(sheet.hp.max)
        : cur != null
          ? Math.max(1, cur)
          : null;
  const dead = sheet?.deathState?.dead === true;
  if (dead) return null;
  let hp = cur != null && max != null ? { current: cur, max } : sheet?.hp ?? null;
  if (hp && typeof hp.current === "number" && (hp.max == null || !Number.isFinite(hp.max))) {
    hp = { ...hp, max: Math.max(1, Math.trunc(hp.current)) };
  }

  return {
    id: sid,
    name: String(prof.name ?? sheet?.name ?? "Joueur").trim() || "Joueur",
    type: "friendly",
    controller: "player",
    visible: true,
    isAlive: true,
    hp,
  };
}

async function patchRemoteMpParticipantHpIfNeeded(target, hpNext, deps) {
  const { patchParticipantProfileHp, multiplayerSessionId, clientId } = deps;
  if (!target?.id || typeof patchParticipantProfileHp !== "function" || !multiplayerSessionId) return;
  const sid = String(target.id).trim();
  const mpPrefix = "mp-player-";
  if (!sid.startsWith(mpPrefix)) return;
  const remoteCid = sid.slice(mpPrefix.length).trim();
  const me = String(clientId ?? "").trim();
  if (!remoteCid || remoteCid === me) return;
  await patchParticipantProfileHp(remoteCid, hpNext);
}

/**
 * Résolution des jets `kind: "damage_roll"` (dégâts PJ demandés au joueur).
 * Les modificateurs (totalBonus) s'ajoutent aux résultats naturels des dés.
 *
 * @returns {Promise<boolean>} true si ce jet a été entièrement géré ici.
 */
export async function resolvePendingDamageRollStage(deps) {
  const {
    roll,
    manualNatOverride,
    manualDiceNats,
    getEntities,
    getTurnResources,
    player,
    updatePlayer,
    spendSpellSlot,
    hasResource,
    consumeResource,
    setTurnResourcesSynced,
    gameMode,
    consumeInventoryItemByName,
    stampPendingRollForActor,
    clientId,
    setPendingRoll,
    pendingRollRef,
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
    syncEntitiesImmediate,
    safeJson,
    localCombatantId = "player",
    multiplayerParticipantProfiles = null,
    patchParticipantProfileHp,
    multiplayerSessionId = null,
  } = deps;

  const mpHealSyncDeps = {
    patchParticipantProfileHp,
    multiplayerSessionId,
    clientId,
  };

  if (!roll || roll.kind !== "damage_roll") return false;
  const ctx = roll.engineContext;
  if (!ctx || typeof ctx !== "object") {
    pendingRollRef.current = null;
    setPendingRoll(null);
    return true;
  }

  const stage = ctx.stage;
  const entPool = getEntities();

  if (stage === "weapon_attack_followup") {
    const rid = typeof roll?.id === "string" && roll.id.trim() ? roll.id.trim() : "";
    if (rid) {
      if (isWeaponDamageRollIdResolved(rid)) {
        pendingRollRef.current = null;
        setPendingRoll(null);
        return true;
      }
      markWeaponDamageRollIdResolved(rid);
    }
    const targetId = ctx.targetId ?? roll.targetId;
    const target = entPool.find((e) => e?.id === targetId) ?? null;
    if (!target || !target.hp) {
      pendingRollRef.current = null;
      setPendingRoll(null);
      addMessage("ai", "⚠ Cible introuvable pour les dégâts.", "intent-error", makeMsgId());
      return true;
    }
    const weapon = ctx.weaponSnapshot;
    const hpBeforeDamage = target.hp?.current ?? null;
    const dmgDesc = getPendingRollDiceDescriptor(roll);
    const rollNotation = dmgDesc.rollNotation;
    const dmgBonus = dmgDesc.displayTotalBonus;

    const manualDmg = manualDiceFromInputs(manualNatOverride, manualDiceNats);
    let r;
    let diceSum;
    if (manualDmg) {
      diceSum = manualDmg.diceSum;
      r = { rolls: manualDmg.rolls, total: manualDmg.diceSum };
    } else {
      r = rollDiceDetailed(rollNotation);
      diceSum = (r.rolls || []).reduce((a, b) => a + b, 0);
    }
    const weaponDmg = Math.max(1, diceSum + dmgBonus);

    const dmgDetail =
      manualDmg != null
        ? formatDmgRoll(rollNotation, manualDmg.rolls, dmgBonus, false)
        : formatDmgRoll(rollNotation, r.rolls, dmgBonus, false);

    let myUpdates = [];
    if (target.type !== "hostile") {
      myUpdates.push({ id: target.id, action: "update", type: "hostile" });
    }
    const newHp = Math.max(0, target.hp.current - weaponDmg);
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

    myUpdates = markSceneHostilesAware(entPool, myUpdates);
    const nextEntities = myUpdates.length ? applyUpdatesLocally(entPool, myUpdates) : entPool;
    if (myUpdates.length) applyEntityUpdates(myUpdates);
    if (typeof syncEntitiesImmediate === "function") {
      syncEntitiesImmediate(nextEntities);
    }
    ensureCombatState(nextEntities);

    const sctx = ctx.sneakAttackContext;
    if (
      sctx?.enabled &&
      player?.entityClass === "Roublard" &&
      sctx.sneakAttackArmed &&
      !sctx.sneakAttackUsedThisTurn
    ) {
      if (!sctx.sneakEligibleFromRules) {
        setSneakAttackArmed(false);
        addMessage(
          "ai",
          "⚠ Attaque sournoise : il faut l'avantage à l'attaque, ou un allié au contact de la cible (sans désavantage).",
          undefined,
          makeMsgId()
        );
      } else if (!sctx.finesseOrRanged) {
        setSneakAttackArmed(false);
        addMessage(
          "ai",
          "⚠ Attaque sournoise : arme non éligible (finesse ou à distance requise).",
          undefined,
          makeMsgId()
        );
      } else {
        const sneakPending = stampPendingRollForActor(
          buildPendingDiceRoll({
            roll: sctx.sneakDice,
            totalBonus: 0,
            stat: "Dégâts",
            skill: "Attaque sournoise",
            raison: `Attaque sournoise (${sctx.sneakDice} → ${target.name})`,
            targetId: target.id,
            engineContext: {
              stage: "weapon_sneak_followup",
              parentAttackCtx: ctx,
              dmgDetailWeapon: dmgDetail,
              weaponDamageSoFar: weaponDmg,
              sneakDice: sctx.sneakDice,
            },
          }),
          player,
          clientId
        );
        pendingRollRef.current = sneakPending;
        setPendingRoll(sneakPending);
        return true;
      }
    }

    const hpAfter =
      target.hp
        ? myUpdates.some((u) => u.action === "kill" && u.id === target.id)
          ? 0
          : myUpdates.find((u) => u.action === "update" && u.id === target.id)?.hp?.current ?? target.hp.current
        : null;

    const atkBreakdown = ctx.atkBreakdown ?? "";
    const nat = ctx.nat;
    const weaponName = weapon?.name ?? "Arme";
    const targetName = ctx.targetName ?? target.name;
    const atkLine =
      ctx.crit && nat !== 20
        ? `🎲 Attaque (${weaponName} → ${targetName}) — Coup critique ${atkBreakdown} — Touché ! ${dmgDetail}.`
        : ctx.crit
          ? `🎲 Attaque (${weaponName} → ${targetName}) — Nat **20** 💥 CRITIQUE ! ${atkBreakdown} — Touché ! ${dmgDetail}.`
          : `🎲 Attaque (${weaponName} → ${targetName}) — ${atkBreakdown} — Touché ! ${dmgDetail}.`;

    addMessage(
      "ai",
      `[DEBUG] Résolution attaque joueur (moteur)\n` +
        safeJson({
          targetId: target.id,
          targetName: target.name,
          targetAc: target.ac,
          hpBefore: target.hp?.current ?? null,
          hpMax: target.hp?.max ?? null,
          weapon: ctx.weaponDebug ?? null,
          nat,
          total: ctx.atkTotal,
          hit: true,
          crit: !!ctx.crit,
          dmg: weaponDmg,
          sneak: null,
          hpAfter,
        }),
      "debug",
      makeMsgId()
    );

    pendingRollRef.current = null;
    setPendingRoll(null);
    await callApi(atkLine, "dice", false, {
      skipSessionLock: true,
      skipAutoPlayerTurn: true,
      entities: nextEntities,
      engineEvent: {
        kind: "attack_resolution",
        targetId: target.id,
        targetName: target.name,
        hit: true,
        crit: !!ctx.crit,
        damage: weaponDmg,
        sneakAttackApplied: false,
        sneakAttackDice: null,
        sneakAttackDamage: 0,
        targetHpBefore: hpBeforeDamage,
        targetHpAfter: hpAfter,
        targetHpMax: target.hp?.max ?? null,
        targetIsAlive: hpAfter === null ? true : hpAfter > 0,
      },
    });
    return true;
  }

  if (stage === "weapon_sneak_followup") {
    const parent = ctx.parentAttackCtx;
    const targetId = parent?.targetId ?? roll.targetId;
    const target = entPool.find((e) => e?.id === targetId) ?? null;
    if (!target || !target.hp) {
      pendingRollRef.current = null;
      setPendingRoll(null);
      addMessage("ai", "⚠ Cible introuvable pour l'attaque sournoise.", "intent-error", makeMsgId());
      return true;
    }

    const sneakDice = String(ctx.sneakDice ?? roll.roll ?? "1d6").trim();
    let sneakRoll;
    let sneakDamage;
    const manualSneak = manualDiceFromInputs(manualNatOverride, manualDiceNats);
    if (manualSneak) {
      sneakDamage = Math.max(0, manualSneak.diceSum);
      sneakRoll = { rolls: manualSneak.rolls, total: manualSneak.diceSum };
    } else {
      sneakRoll = rollDiceDetailed(sneakDice);
      sneakDamage = Math.max(0, sneakRoll.total);
    }

    const dmgDetailSneak =
      manualSneak != null
        ? `${sneakDice} [${manualSneak.rolls.join("+")}] = **${sneakDamage} dégâts** (manuel)`
        : `${sneakDice} [${(sneakRoll.rolls || []).join("+")}] = **${sneakDamage} dégâts**`;

    const combinedDetail = `${ctx.dmgDetailWeapon} + Attaque sournoise ${dmgDetailSneak}`;

    const hpBeforeSneak = target.hp?.current ?? null;

    let myUpdates = [];
    const newHp = Math.max(0, target.hp.current - sneakDamage);
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

    myUpdates = markSceneHostilesAware(entPool, myUpdates);
    const nextEntities = myUpdates.length ? applyUpdatesLocally(entPool, myUpdates) : entPool;
    if (myUpdates.length) applyEntityUpdates(myUpdates);
    if (typeof syncEntitiesImmediate === "function") {
      syncEntitiesImmediate(nextEntities);
    }
    ensureCombatState(nextEntities);

    setSneakAttackUsedThisTurn(true);
    setSneakAttackArmed(false);

    const weapon = parent?.weaponSnapshot;
    const weaponName = weapon?.name ?? "Arme";
    const targetName = parent?.targetName ?? target.name;
    const atkBreakdown = parent?.atkBreakdown ?? "";
    const nat = parent?.nat;
    const totalDmg = (ctx.weaponDamageSoFar ?? 0) + sneakDamage;

    const atkLine =
      nat === 20
        ? `🎲 Attaque (${weaponName} → ${targetName}) — Nat **20** 💥 CRITIQUE ! ${atkBreakdown} — Touché ! ${combinedDetail}.`
        : `🎲 Attaque (${weaponName} → ${targetName}) — ${atkBreakdown} — Touché ! ${combinedDetail}.`;

    const hpAfter =
      target.hp
        ? myUpdates.some((u) => u.action === "kill" && u.id === target.id)
          ? 0
          : myUpdates.find((u) => u.action === "update" && u.id === target.id)?.hp?.current ?? target.hp.current
        : null;

    addMessage(
      "ai",
      `[DEBUG] Résolution attaque joueur (moteur) + sournoise\n` +
        safeJson({
          targetId: target.id,
          sneakDamage,
          totalDmg,
          hpAfter,
        }),
      "debug",
      makeMsgId()
    );

    pendingRollRef.current = null;
    setPendingRoll(null);
    await callApi(atkLine, "dice", false, {
      skipSessionLock: true,
      skipAutoPlayerTurn: true,
      entities: nextEntities,
      engineEvent: {
        kind: "attack_resolution",
        targetId: target.id,
        targetName: target.name,
        hit: true,
        crit: !!parent?.crit,
        damage: totalDmg,
        sneakAttackApplied: true,
        sneakAttackDice: sneakDice,
        sneakAttackDamage: sneakDamage,
        targetHpBefore: hpBeforeSneak,
        targetHpAfter: hpAfter,
        targetHpMax: target.hp?.max ?? null,
        targetIsAlive: hpAfter === null ? true : hpAfter > 0,
      },
    });
    return true;
  }

  if (stage === "spell_auto_hit") {
    const targetId = ctx.targetId ?? roll.targetId;
    const target = entPool.find((e) => e?.id === targetId) ?? null;
    const spellName = ctx.spellName ?? roll.weaponName ?? "Sort";
    const spellLevel =
      typeof ctx.spellLevel === "number" && Number.isFinite(ctx.spellLevel) ? ctx.spellLevel : 0;
    const resourceKind =
      typeof ctx.resourceKind === "string" && ctx.resourceKind.trim()
        ? ctx.resourceKind.trim()
        : "action";
    const turnResources = typeof getTurnResources === "function" ? getTurnResources() : null;

    if (!target || !target.hp) {
      pendingRollRef.current = null;
      setPendingRoll(null);
      addMessage("ai", "⚠ Cible introuvable pour les dégâts du sort.", "intent-error", makeMsgId());
      return true;
    }

    if (
      !hasResource ||
      !consumeResource ||
      !setTurnResourcesSynced ||
      !spendSpellSlot ||
      !updatePlayer
    ) {
      pendingRollRef.current = null;
      setPendingRoll(null);
      addMessage("ai", "⚠ Résolution du sort (touche auto) indisponible.", "intent-error", makeMsgId());
      return true;
    }

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
        `⚠ Vous avez déjà utilisé votre **${label}** ce tour-ci — impossible de lancer ${spellName} maintenant.`,
        undefined,
        makeMsgId()
      );
      return true;
    }

    const slotResult = spendSpellSlot(player, updatePlayer, spellLevel);
    if (!slotResult.ok) {
      pendingRollRef.current = null;
      setPendingRoll(null);
      addMessage(
        "ai",
        `⚠ Vous n'avez plus d'emplacements de sort disponibles pour lancer ${spellName}.`,
        undefined,
        makeMsgId()
      );
      return true;
    }

    consumeResource(setTurnResourcesSynced, gameMode, resourceKind);

    const dmgDescSpell = getPendingRollDiceDescriptor(roll);
    const rollNotation = dmgDescSpell.rollNotation;
    const dmgBonus = dmgDescSpell.displayTotalBonus;

    const manualSpell = manualDiceFromInputs(manualNatOverride, manualDiceNats);
    let r;
    let diceSum;
    if (manualSpell) {
      diceSum = manualSpell.diceSum;
      r = { rolls: manualSpell.rolls, total: manualSpell.diceSum };
    } else {
      r = rollDiceDetailed(rollNotation);
      diceSum = (r.rolls || []).reduce((a, b) => a + b, 0);
    }
    const baseTotal =
      typeof r.total === "number" && Number.isFinite(r.total) ? r.total : diceSum;
    const dmg = Math.max(1, baseTotal + dmgBonus);

    const dmgDetail =
      manualSpell != null
        ? formatDmgRoll(rollNotation, manualSpell.rolls, dmgBonus, false)
        : formatDiceNotationDetail(
            r,
            `${rollNotation}${dmgBonus ? (dmgBonus >= 0 ? `+${dmgBonus}` : `${dmgBonus}`) : ""}`
          );

    const hpBeforeSpell = target.hp?.current ?? null;

    let myUpdates = [];
    if (target.type !== "hostile") {
      myUpdates.push({ id: target.id, action: "update", type: "hostile" });
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

    myUpdates = markSceneHostilesAware(entPool, myUpdates);
    const nextEntities = myUpdates.length ? applyUpdatesLocally(entPool, myUpdates) : entPool;
    if (myUpdates.length) applyEntityUpdates(myUpdates);
    if (typeof syncEntitiesImmediate === "function") {
      syncEntitiesImmediate(nextEntities);
    }
    ensureCombatState(nextEntities);

    const targetName = target.name ?? "cible";
    const dtype = ctx.spellDamageType ? String(ctx.spellDamageType) : "";
    const content = `🎲 ${spellName} → **${targetName}** — ${dmgDetail}${dtype ? ` (${dtype})` : ""}.`;

    const hpBefore = hpBeforeSpell;
    const hpAfter =
      target.hp
        ? myUpdates.some((u) => u.action === "kill" && u.id === target.id)
          ? 0
          : myUpdates.find((u) => u.action === "update" && u.id === target.id)?.hp?.current ?? target.hp.current
        : null;

    addMessage(
      "ai",
      `[DEBUG] Résolution sort (touche auto) ${spellName}\n` +
        safeJson({
          targetId: target.id,
          targetName: target.name,
          damage: dmg,
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
        kind: "spell_auto_hit_resolution",
        spellName,
        targetId: target.id,
        damage: dmg,
        targetHpBefore: hpBefore,
        targetHpAfter: hpAfter,
        targetHpMax: target.hp?.max ?? null,
        targetIsAlive: hpAfter === null ? true : hpAfter > 0,
        slotLevelUsed: slotResult.usedLevel,
        spellDamageType: dtype || null,
      },
    });
    return true;
  }

  if (stage === "spell_heal_followup") {
    const targetId = ctx.targetId ?? roll.targetId;
    const spellName = ctx.spellName ?? roll.weaponName ?? "Sort";
    const spellLevel =
      typeof ctx.spellLevel === "number" && Number.isFinite(ctx.spellLevel) ? ctx.spellLevel : 0;
    const resourceKind =
      typeof ctx.resourceKind === "string" && ctx.resourceKind.trim()
        ? ctx.resourceKind.trim()
        : "action";
    const turnResources = typeof getTurnResources === "function" ? getTurnResources() : null;
    const targetNameHint = String(ctx.targetName ?? "").trim();
    const selfId = String(localCombatantId ?? "").trim();
    const tidRaw = String(targetId ?? "").trim();
    const isSelfTarget =
      !tidRaw ||
      tidRaw === "player" ||
      tidRaw === player?.id ||
      (!!selfId && tidRaw === selfId);
    const target = !isSelfTarget
      ? resolveHealTargetEntityFromPool(targetId, entPool, {
          localCombatantId,
          player,
          multiplayerParticipantProfiles,
        })
      : null;

    if (
      !hasResource ||
      !consumeResource ||
      !setTurnResourcesSynced ||
      !spendSpellSlot ||
      !updatePlayer
    ) {
      pendingRollRef.current = null;
      setPendingRoll(null);
      addMessage("ai", "⚠ Résolution du sort de soin indisponible.", "intent-error", makeMsgId());
      return true;
    }

    if (!isSelfTarget && !target) {
      pendingRollRef.current = null;
      setPendingRoll(null);
      addMessage("ai", "⚠ Cible introuvable pour les soins du sort.", "intent-error", makeMsgId());
      return true;
    }

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
        `⚠ Vous avez déjà utilisé votre **${label}** ce tour-ci — impossible de lancer ${spellName} maintenant.`,
        undefined,
        makeMsgId()
      );
      return true;
    }

    const slotResult = spendSpellSlot(player, updatePlayer, spellLevel);
    if (!slotResult.ok) {
      pendingRollRef.current = null;
      setPendingRoll(null);
      addMessage(
        "ai",
        `⚠ Vous n'avez plus d'emplacements de sort disponibles pour lancer ${spellName}.`,
        undefined,
        makeMsgId()
      );
      return true;
    }

    consumeResource(setTurnResourcesSynced, gameMode, resourceKind);

    const healDesc = getPendingRollDiceDescriptor(roll);
    const rollNotation = healDesc.rollNotation;
    const healBonus = healDesc.displayTotalBonus;
    const manualHeal = manualDiceFromInputs(manualNatOverride, manualDiceNats);
    let r;
    let diceSum;
    if (manualHeal) {
      diceSum = manualHeal.diceSum;
      r = { rolls: manualHeal.rolls, total: manualHeal.diceSum };
    } else {
      r = rollDiceDetailed(rollNotation);
      diceSum = (r.rolls || []).reduce((a, b) => a + b, 0);
    }
    const heal = Math.max(1, diceSum + healBonus);
    const healDetail =
      manualHeal != null
        ? formatHealRollDetail(rollNotation, manualHeal.rolls, healBonus, true)
        : formatHealRollDetail(rollNotation, r.rolls, healBonus, false);

    if (isSelfTarget) {
      const hpCur = typeof player?.hp?.current === "number" ? player.hp.current : 0;
      const hpMax = typeof player?.hp?.max === "number" ? player.hp.max : Math.max(1, hpCur + heal);
      const hpNext = Math.min(hpMax, hpCur + heal);
      updatePlayer({ hp: { ...player?.hp, current: hpNext, max: hpMax } });
      pendingRollRef.current = null;
      setPendingRoll(null);
      await callApi(
        `✨ ${spellName} — ${healDetail} = **+${heal} PV** → ${player?.name ?? "Vous"} : **${hpNext}/${hpMax} PV**.`,
        "dice",
        false,
        {
          skipSessionLock: true,
          skipAutoPlayerTurn: true,
          engineEvent: {
            kind: "spell_heal_resolution",
            spellName,
            targetId: player?.id ?? "player",
            targetName: player?.name ?? "Vous",
            heal,
            targetHpBefore: hpCur,
            targetHpAfter: hpNext,
            targetHpMax: hpMax,
            slotLevelUsed: slotResult.usedLevel,
          },
        }
      );
      return true;
    }

    const hpCur = typeof target?.hp?.current === "number" ? target.hp.current : 0;
    const hpMax = typeof target?.hp?.max === "number" ? target.hp.max : Math.max(1, hpCur + heal);
    const hpNext = Math.min(hpMax, hpCur + heal);
    const uniqueTargetIds = collectHealTargetEntityIdsForApply(entPool, target);
    const updates = uniqueTargetIds
      .map((id) => {
        const ent = entPool.find((e) => entityIdsEqualCaseInsensitive(e?.id, id));
        const cur = typeof ent?.hp?.current === "number" ? ent.hp.current : hpCur;
        const max = typeof ent?.hp?.max === "number" ? ent.hp.max : hpMax;
        return { id, action: "update", hp: { current: Math.min(max, cur + heal), max } };
      })
      .filter((u) => u && u.id);
    const nextEntities = applyUpdatesLocally(entPool, updates);
    applyEntityUpdates(updates);
    if (typeof syncEntitiesImmediate === "function") {
      syncEntitiesImmediate(nextEntities);
    }
    await patchRemoteMpParticipantHpIfNeeded(target, hpNext, mpHealSyncDeps);

    pendingRollRef.current = null;
    setPendingRoll(null);
    await callApi(
      `✨ ${spellName} → **${target?.name ?? targetNameHint ?? "cible"}** — ${healDetail} = **+${heal} PV** → **${hpNext}/${hpMax} PV**.`,
      "dice",
      false,
      {
        skipSessionLock: true,
        skipAutoPlayerTurn: true,
        entities: nextEntities,
        engineEvent: {
          kind: "spell_heal_resolution",
          spellName,
          targetId: target.id,
          targetName: target?.name ?? targetNameHint ?? "cible",
          heal,
          targetHpBefore: hpCur,
          targetHpAfter: hpNext,
          targetHpMax: hpMax,
          slotLevelUsed: slotResult.usedLevel,
        },
      }
    );
    return true;
  }

  if (stage === "item_heal_followup") {
    const targetId = ctx.targetId ?? roll.targetId;
    const itemName = ctx.itemName ?? roll.weaponName ?? "Potion de soins";
    const resourceKind =
      typeof ctx.resourceKind === "string" && ctx.resourceKind.trim()
        ? ctx.resourceKind.trim()
        : "action";
    const turnResources = typeof getTurnResources === "function" ? getTurnResources() : null;
    const targetNameHint = String(ctx.targetName ?? "").trim();
    const selfId = String(localCombatantId ?? "").trim();
    const tidRaw = String(targetId ?? "").trim();
    const isSelfTarget =
      !tidRaw ||
      tidRaw === "player" ||
      tidRaw === player?.id ||
      (!!selfId && tidRaw === selfId);
    const target = !isSelfTarget
      ? resolveHealTargetEntityFromPool(targetId, entPool, {
          localCombatantId,
          player,
          multiplayerParticipantProfiles,
        })
      : null;

    if (!hasResource || !consumeResource || !setTurnResourcesSynced || !consumeInventoryItemByName) {
      pendingRollRef.current = null;
      setPendingRoll(null);
      addMessage("ai", "⚠ Résolution de la potion indisponible.", "intent-error", makeMsgId());
      return true;
    }

    if (!isSelfTarget && !target) {
      pendingRollRef.current = null;
      setPendingRoll(null);
      addMessage("ai", "⚠ Cible introuvable pour la potion de soin.", "intent-error", makeMsgId());
      return true;
    }

    if (gameMode === "combat" && !hasResource(turnResources, gameMode, resourceKind)) {
      pendingRollRef.current = null;
      setPendingRoll(null);
      addMessage("ai", "⚠ Vous avez déjà utilisé votre **Action** ce tour-ci.", undefined, makeMsgId());
      return true;
    }

    if (!consumeInventoryItemByName(itemName)) {
      pendingRollRef.current = null;
      setPendingRoll(null);
      addMessage("ai", `⚠ Vous n'avez plus **${itemName}** dans votre inventaire.`, "intent-error", makeMsgId());
      return true;
    }

    if (gameMode === "combat") {
      consumeResource(setTurnResourcesSynced, gameMode, resourceKind);
    }

    const healDesc = getPendingRollDiceDescriptor(roll);
    const rollNotation = healDesc.rollNotation;
    const healBonus = healDesc.displayTotalBonus;
    const manualHeal = manualDiceFromInputs(manualNatOverride, manualDiceNats);
    let r;
    let diceSum;
    if (manualHeal) {
      diceSum = manualHeal.diceSum;
      r = { rolls: manualHeal.rolls, total: manualHeal.diceSum };
    } else {
      r = rollDiceDetailed(rollNotation);
      diceSum = (r.rolls || []).reduce((a, b) => a + b, 0);
    }
    const heal = Math.max(1, diceSum + healBonus);
    const healDetail =
      manualHeal != null
        ? formatHealRollDetail(rollNotation, manualHeal.rolls, healBonus, true, "item")
        : formatHealRollDetail(rollNotation, r.rolls, healBonus, false, "item");
    const giverName = player?.name ?? "Vous";

    if (isSelfTarget) {
      const hpCur = typeof player?.hp?.current === "number" ? player.hp.current : 0;
      const hpMax = typeof player?.hp?.max === "number" ? player.hp.max : Math.max(1, hpCur + heal);
      const hpNext = Math.min(hpMax, hpCur + heal);
      updatePlayer({ hp: { ...player?.hp, current: hpNext, max: hpMax } });
      pendingRollRef.current = null;
      setPendingRoll(null);
      await callApi(
        `🧪 ${giverName} utilise ${itemName} — ${healDetail} = **+${heal} PV** → ${hpNext}/${hpMax} PV.`,
        "dice",
        false,
        { skipSessionLock: true, skipAutoPlayerTurn: true }
      );
      return true;
    }

    const hpCur = typeof target?.hp?.current === "number" ? target.hp.current : 0;
    const hpMax = typeof target?.hp?.max === "number" ? target.hp.max : Math.max(1, hpCur + heal);
    const hpNext = Math.min(hpMax, hpCur + heal);
    const uniqueTargetIds = collectHealTargetEntityIdsForApply(entPool, target);
    const updates = uniqueTargetIds
      .map((id) => {
        const ent = entPool.find((e) => entityIdsEqualCaseInsensitive(e?.id, id));
        const cur = typeof ent?.hp?.current === "number" ? ent.hp.current : hpCur;
        const max = typeof ent?.hp?.max === "number" ? ent.hp.max : hpMax;
        return { id, action: "update", hp: { current: Math.min(max, cur + heal), max } };
      })
      .filter((u) => u && u.id);
    const nextEntities = applyUpdatesLocally(entPool, updates);
    applyEntityUpdates(updates);
    if (typeof syncEntitiesImmediate === "function") {
      syncEntitiesImmediate(nextEntities);
    }
    await patchRemoteMpParticipantHpIfNeeded(target, hpNext, mpHealSyncDeps);

    pendingRollRef.current = null;
    setPendingRoll(null);
    await callApi(
      `🧪 ${giverName} fait boire ${itemName} à **${target?.name ?? targetNameHint ?? "cible"}** — ${healDetail} = **+${heal} PV** → **${hpNext}/${hpMax} PV**.`,
      "dice",
      false,
      {
        skipSessionLock: true,
        skipAutoPlayerTurn: true,
        entities: nextEntities,
        engineEvent: {
          kind: "item_heal_resolution",
          itemName,
          targetId: target.id,
          targetName: target?.name ?? targetNameHint ?? "cible",
          heal,
          targetHpBefore: hpCur,
          targetHpAfter: hpNext,
          targetHpMax: hpMax,
        },
      }
    );
    return true;
  }

  if (stage === "spell_attack_followup") {
    const targetId = ctx.targetId ?? roll.targetId;
    const target = entPool.find((e) => e?.id === targetId) ?? null;
    const spellName = ctx.spellName ?? roll.weaponName ?? "Sort";
    if (!target || !target.hp) {
      pendingRollRef.current = null;
      setPendingRoll(null);
      addMessage("ai", "⚠ Cible introuvable pour les dégâts du sort.", "intent-error", makeMsgId());
      return true;
    }

    const dmgDescAtkSpell = getPendingRollDiceDescriptor(roll);
    const rollNotation = dmgDescAtkSpell.rollNotation;
    const dmgBonus = dmgDescAtkSpell.displayTotalBonus;

    const manualAtkSpell = manualDiceFromInputs(manualNatOverride, manualDiceNats);
    let r;
    let diceSum;
    if (manualAtkSpell) {
      diceSum = manualAtkSpell.diceSum;
      r = { rolls: manualAtkSpell.rolls, total: manualAtkSpell.diceSum };
    } else {
      r = rollDiceDetailed(rollNotation);
      diceSum = (r.rolls || []).reduce((a, b) => a + b, 0);
    }
    const dmg = Math.max(1, diceSum + dmgBonus);

    const dmgDetail =
      manualAtkSpell != null
        ? formatDmgRoll(rollNotation, manualAtkSpell.rolls, dmgBonus, false)
        : formatDiceNotationDetail(r, `${rollNotation}${dmgBonus ? (dmgBonus >= 0 ? `+${dmgBonus}` : `${dmgBonus}`) : ""}`);

    const hpBeforeSpell = target.hp?.current ?? null;

    let myUpdates = [];
    if (target.type !== "hostile") {
      myUpdates.push({ id: target.id, action: "update", type: "hostile" });
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

    myUpdates = markSceneHostilesAware(entPool, myUpdates);
    const nextEntities = myUpdates.length ? applyUpdatesLocally(entPool, myUpdates) : entPool;
    if (myUpdates.length) applyEntityUpdates(myUpdates);
    if (typeof syncEntitiesImmediate === "function") {
      syncEntitiesImmediate(nextEntities);
    }
    ensureCombatState(nextEntities);

    const nat = ctx.nat;
    const atkBonusVal = ctx.spellAtkBonus ?? 0;
    const total = ctx.spellAtkTotal ?? nat + atkBonusVal;
    const bonus = fmtMod(atkBonusVal);
    const targetName = target.name ?? "cible";

    let content;
    if (ctx.crit && nat !== 20) {
      content = `🎲 Attaque de sort (${spellName} → ${targetName}) — Coup critique ${nat} ${bonus} = **${total}** — Touché ! ${dmgDetail}.`;
    } else if (ctx.crit) {
      content = `🎲 Attaque de sort (${spellName} → ${targetName}) — Nat **20** 💥 COUP CRITIQUE ! ${nat} ${bonus} = **${total}** — Touché ! ${dmgDetail}.`;
    } else {
      content = `🎲 Attaque de sort (${spellName} → ${targetName}) — Nat ${nat} ${bonus} = **${total}** — Touché ! ${dmgDetail}.`;
    }

    const hpBefore = hpBeforeSpell;
    const hpAfter =
      target.hp
        ? myUpdates.some((u) => u.action === "kill" && u.id === target.id)
          ? 0
          : myUpdates.find((u) => u.action === "update" && u.id === target.id)?.hp?.current ?? target.hp.current
        : null;

    addMessage(
      "ai",
      `[DEBUG] Résolution attaque de sort (moteur) ${spellName}\n` +
        safeJson({
          targetId: target.id,
          targetName: target.name,
          nat,
          total,
          hit: true,
          crit: !!ctx.crit,
          damage: dmg,
          hpBefore,
          hpAfter,
          slotLevelUsed: ctx.slotResult?.usedLevel,
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
        spellName,
        targetId: target.id,
        nat,
        total,
        hit: true,
        crit: !!ctx.crit,
        damage: dmg,
        targetHpBefore: hpBefore,
        targetHpAfter: hpAfter,
        targetHpMax: target.hp?.max ?? null,
        targetIsAlive: hpAfter === null ? true : hpAfter > 0,
        slotLevelUsed: ctx.slotResult?.usedLevel,
      },
    });
    return true;
  }

  if (stage === "spell_save_followup") {
    const targetId = ctx.targetId ?? roll.targetId;
    const target = entPool.find((e) => e?.id === targetId) ?? null;
    const spellName = ctx.spellName ?? "Sort";
    if (!target || !target.hp) {
      pendingRollRef.current = null;
      setPendingRoll(null);
      addMessage("ai", "⚠ Cible introuvable pour les dégâts du sort.", "intent-error", makeMsgId());
      return true;
    }

    const dmgDescSave = getPendingRollDiceDescriptor(roll);
    const rollNotation = dmgDescSave.rollNotation;
    const dmgBonus = dmgDescSave.displayTotalBonus;

    const manualSaveDmg = manualDiceFromInputs(manualNatOverride, manualDiceNats);
    let r;
    let diceSum;
    if (manualSaveDmg) {
      diceSum = manualSaveDmg.diceSum;
      r = { rolls: manualSaveDmg.rolls, total: manualSaveDmg.diceSum };
    } else {
      r = rollDiceDetailed(rollNotation);
      diceSum = (r.rolls || []).reduce((a, b) => a + b, 0);
    }
    const baseDmg = Math.max(0, diceSum + dmgBonus);
    const succeeded = !!ctx.saveSucceeded;
    const finalDmg = succeeded ? Math.floor(baseDmg / 2) : baseDmg;

    let dmgDetail = formatDiceNotationDetail(r, `${rollNotation}${dmgBonus ? (dmgBonus >= 0 ? `+${dmgBonus}` : `${dmgBonus}`) : ""}`);
    if (succeeded) dmgDetail += " → moitié dégâts";

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

    myUpdates = markSceneHostilesAware(entPool, myUpdates);
    const nextEntities = myUpdates.length ? applyUpdatesLocally(entPool, myUpdates) : entPool;
    if (myUpdates.length) applyEntityUpdates(myUpdates);
    if (typeof syncEntitiesImmediate === "function") {
      syncEntitiesImmediate(nextEntities);
    }
    ensureCombatState(nextEntities);

    const saveLine = ctx.saveLine ?? "";
    const outcome = succeeded ? "✔ Réussite — dégâts réduits." : "✖ Échec — dégâts complets.";
    const dmgLine =
      finalDmg > 0
        ? `${dmgDetail} = **${finalDmg} dégâts ${ctx.spellDamageType ?? ""}**`
        : "Aucun dégât.";
    const content = `${saveLine}\n${outcome} ${dmgLine}.`;

    pendingRollRef.current = null;
    setPendingRoll(null);
    await callApi(content, "dice", false, {
      skipSessionLock: true,
      skipAutoPlayerTurn: true,
      entities: nextEntities,
      engineEvent: {
        kind: "spell_save_resolution",
        spellName,
        targetId: target.id,
        saveType: ctx.saveType,
        nat: ctx.saveNat,
        total: ctx.saveTotal,
        dc: ctx.saveDc,
        succeeded,
        damage: finalDmg,
        targetHpBefore: hpBefore,
        targetHpAfter: hpAfter,
        targetHpMax: target.hp?.max ?? null,
        targetIsAlive: hpAfter === null ? true : hpAfter > 0,
        slotLevelUsed: ctx.slotResult?.usedLevel,
      },
    });
    return true;
  }

  return false;
}
