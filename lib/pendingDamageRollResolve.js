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
    setHp,
    applyDamageToPlayer,
    playerHpRef,
    updatePlayer,
    spendSpellSlot,
    spendSpellSlotForCombatant,
    hasResource,
    consumeResource,
    setTurnResourcesSynced,
    gameMode,
    stampPendingRollForActor,
    clientId,
    setPendingRoll,
    pendingRollRef,
    multiplayerSessionId,
    patchParticipantProfileHp,
    getParticipantProfileByCombatantId,
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
    setSneakAttackExplicitArmed,
    setSneakAttackUsedThisTurn,
    safeJson,
  } = deps;

  if (!roll || roll.kind !== "damage_roll") return false;
  const ctx = roll.engineContext;
  if (!ctx || typeof ctx !== "object") {
    pendingRollRef.current = null;
    setPendingRoll(null);
    return true;
  }

  const stage = ctx.stage;
  const entPool = getEntities();

  if (stage === "item_heal" || stage === "spell_heal") {
    const targetId = String(ctx.targetId ?? roll.targetId ?? "").trim();
    const target = entPool.find((e) => e?.id === targetId) ?? null;
    const targetMpProfile =
      typeof getParticipantProfileByCombatantId === "function"
        ? getParticipantProfileByCombatantId(targetId)
        : null;
    const targetMpHpCurrent =
      typeof targetMpProfile?.hpCurrent === "number" && Number.isFinite(targetMpProfile.hpCurrent)
        ? Math.trunc(targetMpProfile.hpCurrent)
        : typeof targetMpProfile?.playerSnapshot?.hp?.current === "number" &&
            Number.isFinite(targetMpProfile.playerSnapshot.hp.current)
          ? Math.trunc(targetMpProfile.playerSnapshot.hp.current)
          : null;
    const targetMpHpMax =
      typeof targetMpProfile?.hpMax === "number" && Number.isFinite(targetMpProfile.hpMax)
        ? Math.max(1, Math.trunc(targetMpProfile.hpMax))
        : typeof targetMpProfile?.playerSnapshot?.hp?.max === "number" &&
            Number.isFinite(targetMpProfile.playerSnapshot.hp.max)
          ? Math.max(1, Math.trunc(targetMpProfile.playerSnapshot.hp.max))
          : null;
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
    const baseTotal = typeof r.total === "number" && Number.isFinite(r.total) ? r.total : diceSum;
    const heal = Math.max(1, baseTotal + healBonus);
    const actorName = String(player?.name ?? "Vous").trim() || "Vous";
    const targetName = String(ctx.targetName ?? target?.name ?? targetId ?? "allié").trim() || "allié";
    const isLocalPlayerTarget =
      targetId === String(player?.id ?? "").trim() ||
      targetId === `mp-player-${String(clientId ?? "").trim()}`;
    const localPlayerHpCurrent =
      typeof playerHpRef?.current === "number"
        ? Math.trunc(playerHpRef.current)
        : typeof player?.hp?.current === "number"
          ? Math.trunc(player.hp.current)
          : null;
    const localPlayerHpMax =
      typeof player?.hp?.max === "number" && Number.isFinite(player.hp.max)
        ? Math.max(1, Math.trunc(player.hp.max))
        : null;
    const hpBefore =
      targetMpHpCurrent != null
        ? targetMpHpCurrent
        : typeof target?.hp?.current === "number"
        ? target.hp.current
        : isLocalPlayerTarget && localPlayerHpCurrent != null
          ? localPlayerHpCurrent
          : typeof ctx.targetHpCurrent === "number"
            ? Math.trunc(ctx.targetHpCurrent)
            : 0;
    const hpMax =
      targetMpHpMax != null
        ? targetMpHpMax
        : typeof target?.hp?.max === "number"
        ? Math.max(1, target.hp.max)
        : isLocalPlayerTarget && localPlayerHpMax != null
          ? localPlayerHpMax
          : typeof ctx.targetHpMax === "number"
            ? Math.max(1, Math.trunc(ctx.targetHpMax))
            : Math.max(1, hpBefore + heal);
    const hpAfter = Math.min(hpMax, hpBefore + heal);

    if (stage === "spell_heal") {
      const resourceKind =
        typeof ctx.resourceKind === "string" && ctx.resourceKind.trim() ? ctx.resourceKind.trim() : "bonus";
      const spellLevel =
        typeof ctx.spellLevel === "number" && Number.isFinite(ctx.spellLevel) ? Math.trunc(ctx.spellLevel) : 1;
      if (!hasResource || !consumeResource || !setTurnResourcesSynced || !spendSpellSlot || !updatePlayer) {
        pendingRollRef.current = null;
        setPendingRoll(null);
        addMessage("ai", "⚠ Résolution du sort de soin indisponible.", "intent-error", makeMsgId());
        return true;
      }
      const turnResources = typeof getTurnResources === "function" ? getTurnResources() : null;
      if (!hasResource(turnResources, gameMode, resourceKind)) {
        pendingRollRef.current = null;
        setPendingRoll(null);
        addMessage("ai", "⚠ Ressource de tour indisponible pour lancer ce sort.", undefined, makeMsgId());
        return true;
      }
      const casterCombatantId = String(ctx.casterCombatantId ?? "").trim();
      const slotResult =
        casterCombatantId && typeof spendSpellSlotForCombatant === "function"
          ? spendSpellSlotForCombatant(casterCombatantId, spellLevel)
          : spendSpellSlot(player, updatePlayer, spellLevel);
      if (!slotResult.ok) {
        pendingRollRef.current = null;
        setPendingRoll(null);
        addMessage("ai", "⚠ Emplacement de sort indisponible pour ce soin.", undefined, makeMsgId());
        return true;
      }
      consumeResource(setTurnResourcesSynced, gameMode, resourceKind);
    }

    if (target && target.hp) {
      applyEntityUpdates([
        {
          id: target.id,
          action: "update",
          hp: { current: hpAfter, max: hpMax },
          deathState: { stable: false, unconscious: false, dead: false, autoRecoverAtMinute: null },
        },
      ]);
    } else if (
      targetId.startsWith("mp-player-") &&
      typeof patchParticipantProfileHp === "function" &&
      multiplayerSessionId
    ) {
      const cid = targetId.slice("mp-player-".length).trim();
      if (cid) {
        void patchParticipantProfileHp(cid, hpAfter);
      }
    } else if (targetId === String(player?.id ?? "").trim()) {
      if (typeof setHp === "function") setHp(hpAfter);
      if (playerHpRef && typeof playerHpRef === "object") playerHpRef.current = hpAfter;
      if (typeof updatePlayer === "function") {
        updatePlayer({
          hp: { current: hpAfter, max: hpMax },
          deathState: { stable: false, unconscious: false, dead: false, autoRecoverAtMinute: null },
        });
      }
    }

    const healDetail =
      manualHeal != null
        ? formatDmgRoll(rollNotation, manualHeal.rolls, healBonus, false)
        : formatDiceNotationDetail(
            r,
            `${rollNotation}${healBonus ? (healBonus >= 0 ? `+${healBonus}` : `${healBonus}`) : ""}`
          );
    pendingRollRef.current = null;
    setPendingRoll(null);
    addMessage(
      "ai",
      `🎲 ${ctx.spellName ?? ctx.itemName ?? "Soin"} — ${healDetail} = **${heal} PV** → **${targetName}** : **${hpAfter}/${hpMax} HP**.`,
      "dice",
      makeMsgId()
    );
    return true;
  }

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
        setSneakAttackExplicitArmed(false);
        if (sctx?.sneakExplicitRequest) {
          addMessage(
            "ai",
            "⚠ Attaque sournoise : il faut l'avantage à l'attaque, ou un allié au contact de la cible (sans désavantage).",
            undefined,
            makeMsgId()
          );
        }
      } else if (!sctx.finesseOrRanged) {
        setSneakAttackArmed(false);
        setSneakAttackExplicitArmed(false);
        if (sctx?.sneakExplicitRequest) {
          addMessage(
            "ai",
            "⚠ Attaque sournoise : arme non éligible (finesse ou à distance requise).",
            undefined,
            makeMsgId()
          );
        }
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
    ensureCombatState(nextEntities);

    setSneakAttackUsedThisTurn(true);
    setSneakAttackArmed(false);
    setSneakAttackExplicitArmed(false);

    const weapon = parent?.weaponSnapshot;
    const weaponName = weapon?.name ?? "Arme";
    const targetName = parent?.targetName ?? target.name;
    const atkBreakdown = parent?.atkBreakdown ?? "";
    const nat = parent?.nat;
    const totalDmg = (ctx.weaponDamageSoFar ?? 0) + sneakDamage;

    const totalDamageDetail = `Total = **${Math.max(0, totalDmg)} dégâts**`;
    const atkLine =
      nat === 20
        ? `🎲 Attaque (${weaponName} → ${targetName}) — Nat **20** 💥 CRITIQUE ! ${atkBreakdown} — Touché ! ${combinedDetail} (${totalDamageDetail}).`
        : `🎲 Attaque (${weaponName} → ${targetName}) — ${atkBreakdown} — Touché ! ${combinedDetail} (${totalDamageDetail}).`;

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

    const casterCombatantId = String(ctx.casterCombatantId ?? "").trim();
    const slotResult =
      casterCombatantId && typeof spendSpellSlotForCombatant === "function"
        ? spendSpellSlotForCombatant(casterCombatantId, spellLevel)
        : spendSpellSlot(player, updatePlayer, spellLevel);
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
    const localClientId = String(clientId ?? "").trim();
    const isLocalPlayerTarget =
      String(targetId ?? "").trim() === "player" ||
      String(targetId ?? "").trim() === String(player?.id ?? "").trim() ||
      (localClientId && String(targetId ?? "").trim() === `mp-player-${localClientId}`);
    const spellName = ctx.spellName ?? "Sort";
    if ((!target || !target.hp) && !isLocalPlayerTarget) {
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
    const saveDamageOnSuccessMode =
      String(ctx.saveDamageOnSuccessMode ?? "").trim().toLowerCase() === "none" ? "none" : "half";
    const finalDmg =
      succeeded && saveDamageOnSuccessMode === "none" ? 0 : succeeded ? Math.floor(baseDmg / 2) : baseDmg;

    let dmgDetail = formatDiceNotationDetail(
      r,
      `${rollNotation}${dmgBonus ? (dmgBonus >= 0 ? `+${dmgBonus}` : `${dmgBonus}`) : ""}`
    );
    if (succeeded && saveDamageOnSuccessMode !== "none") dmgDetail += " → moitié dégâts";

    let myUpdates = [];
    if (target && target.type !== "hostile") {
      myUpdates.push({ id: target.id, action: "update", type: "hostile" });
    }

    let hpBefore = target?.hp?.current ?? null;
    let hpAfter = hpBefore;

    if (isLocalPlayerTarget) {
      const localBefore =
        typeof playerHpRef?.current === "number"
          ? Math.trunc(playerHpRef.current)
          : typeof player?.hp?.current === "number"
            ? Math.trunc(player.hp.current)
            : 0;
      hpBefore = localBefore;
      if (finalDmg > 0) {
        if (typeof applyDamageToPlayer === "function") {
          const dr = applyDamageToPlayer(finalDmg, { critical: false });
          hpAfter = dr?.hpAfter ?? Math.max(0, localBefore - finalDmg);
        } else {
          hpAfter = Math.max(0, localBefore - finalDmg);
          if (typeof setHp === "function") setHp(hpAfter);
          if (playerHpRef && typeof playerHpRef === "object") playerHpRef.current = hpAfter;
          if (typeof updatePlayer === "function") {
            updatePlayer({ hp: { current: hpAfter, max: player?.hp?.max ?? Math.max(1, hpAfter) } });
          }
        }
      }
    } else if (target?.hp && finalDmg > 0) {
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
    ensureCombatState(nextEntities);

    const saveLine = ctx.saveLine ?? "";
    const outcome = succeeded
      ? saveDamageOnSuccessMode === "none"
        ? "✔ Réussite — aucun dégât."
        : "✔ Réussite — dégâts réduits."
      : "✖ Échec — dégâts complets.";
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
        targetId: target?.id ?? String(targetId ?? "player"),
        saveType: ctx.saveType,
        nat: ctx.saveNat,
        total: ctx.saveTotal,
        dc: ctx.saveDc,
        succeeded,
        damage: finalDmg,
        targetHpBefore: hpBefore,
        targetHpAfter: hpAfter,
        targetHpMax: target?.hp?.max ?? player?.hp?.max ?? null,
        targetIsAlive: hpAfter === null ? true : hpAfter > 0,
        slotLevelUsed: ctx.slotResult?.usedLevel,
      },
    });
    return true;
  }

  return false;
}
