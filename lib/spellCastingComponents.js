/**
 * Validation des composantes V/S/M (D&D 5e 2014) pour l’incantation.
 * Les composantes somatiques ne sont pas bloquées par l’occupation des mains (table simplifiée).
 */
import { SPELL_COMPONENTS_SRD2014 } from "@/data/spellComponentsSrd2014";
import { SPELLS } from "@/data/srd5";
import { collectEquippedItemNames, normalizeEquipmentState } from "@/lib/playerEquipment";

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** @typedef {{ verbal: boolean, somatic: boolean, material: boolean, materialCostly?: boolean, materialKeywords?: string[] }} SpellComponents */

/**
 * Composantes pour un sort (données SRD françaises + surcharge éventuelle dans SPELLS).
 * @param {string} spellName
 * @returns {SpellComponents}
 */
export function getSpellComponents(spellName) {
  const key = String(spellName ?? "").trim();
  const fromSpell = SPELLS?.[key]?.components;
  if (fromSpell && typeof fromSpell === "object") {
    return {
      verbal: !!fromSpell.verbal,
      somatic: !!fromSpell.somatic,
      material: !!fromSpell.material,
      materialCostly: !!fromSpell.materialCostly,
      materialKeywords: Array.isArray(fromSpell.materialKeywords) ? fromSpell.materialKeywords : undefined,
    };
  }
  const fromMap = SPELL_COMPONENTS_SRD2014[key];
  if (fromMap) return { ...fromMap };
  return { verbal: true, somatic: true, material: false };
}

/**
 * Affichage court type « V, S, M » (M* si matérielle coûteuse).
 */
export function formatSpellComponentsAbbrev(spellName) {
  const c = getSpellComponents(spellName);
  const parts = [];
  if (c.verbal) parts.push("V");
  if (c.somatic) parts.push("S");
  if (c.material) parts.push(c.materialCostly ? "M*" : "M");
  return parts.join(", ") || "—";
}

const SPEECH_BLOCK = /silence|silenci|baillon|bâillon|etouff|étouff|gag|sans vois|empêch.*parl|empech.*parl|ligot|bound|mouth/i;
const INCAP_NO_SPEECH = /inconscient|unconscious|incapacit|stunned|étourdi|paralys|paralyzed|petrif|pétrif/i;

function cannotSpeakFromConditions(conditions) {
  const arr = Array.isArray(conditions) ? conditions : [];
  const blob = norm(arr.join(" "));
  if (!blob) return false;
  if (SPEECH_BLOCK.test(blob)) return true;
  if (INCAP_NO_SPEECH.test(blob)) return true;
  return false;
}

function isFocusLikeItemName(name, entityClass) {
  const n = norm(name);
  if (!n) return false;
  const cls = norm(entityClass);
  if (/sacoche|composantes|component/.test(n)) return true;
  if (/focaliseur\s+druidique/.test(n) && cls.includes("druide")) return true;
  if (/focaliseur\s+arcanique|baguette|cristal/.test(n) && /magicien|ensorceleur|occultiste/.test(cls)) return true;
  if (/symbole\s+sacre|symbole\s+sacré/.test(n) && /clerc|paladin/.test(cls)) return true;
  if (/^baton$|^bâton$/.test(n) && /magicien|ensorceleur|occultiste|druide/.test(cls)) return true;
  if (/barde/.test(cls) && (/luth|flute|flûte|harpe|viol|tambour|instrument/.test(n) || /focaliseur/.test(n)))
    return true;
  if (/focaliseur|symbole\s+sacre|symbole\s+sacré|druidique|baguette|cristal/.test(n)) return true;
  return false;
}

function allCarriedItemNames(combatant) {
  const inv = Array.isArray(combatant?.inventory) ? combatant.inventory : [];
  const loot = Array.isArray(combatant?.lootItems) ? combatant.lootItems : [];
  const eq = combatant?.equipment ? [...collectEquippedItemNames(combatant.equipment)] : [];
  return [...inv.map(String), ...loot.map(String), ...eq].map((s) => s.trim()).filter(Boolean);
}

/** PNJ hostile sans inventaire ni emplacements d’équipement remplis : incantation innée (pas de V/S/M matériel). */
function shouldSkipGearChecksForNpc(combatant) {
  if (combatant?.type !== "hostile") return false;
  if (allCarriedItemNames(combatant).length > 0) return false;
  const e = normalizeEquipmentState(combatant?.equipment);
  return !e.mainHand && !e.offHand && !e.armor && !e.bottes && !e.cape && !e.tete && !e.gants;
}

function hasSimpleMaterialAccess(combatant, comps) {
  if (!comps.material || comps.materialCostly) return true;
  const items = allCarriedItemNames(combatant);
  const cls = combatant?.entityClass ?? "";
  return items.some((it) => isFocusLikeItemName(it, cls));
}

function costlyMaterialSatisfied(combatant, comps) {
  if (!comps.material || !comps.materialCostly) return true;
  const itemList = allCarriedItemNames(combatant);
  const kws = Array.isArray(comps.materialKeywords) && comps.materialKeywords.length
    ? comps.materialKeywords.map(norm)
    : ["diamant", "diamond", "perle", "pearl"];
  return kws.some(
    (kw) => kw && itemList.some((it) => norm(it).includes(kw))
  );
}

/**
 * @param {object} combatant — joueur ou entité (equipment, inventory, feats, conditions, entityClass…)
 * @param {string} spellName
 * @param {{ skipGearChecks?: boolean }} [options] — pour tests ou PNJ « innés » sans équipement
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateSpellCastingComponents(combatant, spellName, options = {}) {
  const comps = getSpellComponents(spellName);
  const skipGear =
    options.skipGearChecks === true || shouldSkipGearChecksForNpc(combatant);

  if (skipGear) {
    if (comps.verbal && cannotSpeakFromConditions(combatant?.conditions)) {
      return { ok: false, reason: "Composante verbale impossible (silence, bâillon ou état incompatible)." };
    }
    return { ok: true };
  }

  if (comps.verbal && cannotSpeakFromConditions(combatant?.conditions)) {
    return { ok: false, reason: "Composante verbale impossible : vous ne pouvez pas parler librement (silence, bâillon, inconscience…)." };
  }

  if (comps.material && comps.materialCostly) {
    if (!costlyMaterialSatisfied(combatant, comps)) {
      return {
        ok: false,
        reason:
          "Composante matérielle coûteuse : il manque l’objet précis (perle, diamant, etc.) dans votre inventaire — le focaliseur ne suffit pas.",
      };
    }
  } else if (comps.material && !hasSimpleMaterialAccess(combatant, comps)) {
    return {
      ok: false,
      reason:
        "Composante matérielle : il faut une sacoche à composantes ou un focaliseur d’incantation adapté à votre classe (objet possédé).",
    };
  }

  return { ok: true };
}
