/**
 * Métadonnées d'affichage pour les sorts (données SRD / srd5.js + composantes externes).
 * Centralise le lien temps d'incantation → ressource de tour consommée.
 */

export function resourceKindForCastingTime(castingTime) {
  const t = String(castingTime ?? "").toLowerCase();
  if (t.includes("bonus")) return "bonus";
  if (t.includes("réaction") || t.includes("reaction")) return "reaction";
  return "action";
}

export function spellConsumesLabelFr(kind) {
  if (kind === "bonus") return "Consomme : action bonus";
  if (kind === "reaction") return "Consomme : réaction";
  return "Consomme : action";
}

export function spellRangeCategoryLine(spell) {
  const r = String(spell?.range ?? "").trim();
  if (!r) return null;
  const rl = r.toLowerCase();
  if (/vous|moi|personnel|^perso\b|^soi\b|^self\b/i.test(rl))
    return `Portée : personnelle (${r})`;
  if (/contact|touche/i.test(rl)) return `Portée : au contact (${r})`;
  if (
    /cône|cone|ligne|sphère|sphere|cube|cylindre|rayon|radius|émis|emis|carré|carre/i.test(rl)
  )
    return `Portée / zone : ${r}`;
  return `Portée : ${r}`;
}

export function spellAttackOrSaveSummary(spell) {
  if (spell?.save) return `Sauvegarde : ${spell.save}`;
  const a = String(spell?.attack ?? "").trim();
  if (/touche auto|auto/i.test(a)) return `Résolution : touche automatique (pas de d20)`;
  if (/corps/i.test(a) && /distance/i.test(a))
    return `Attaque : sort au contact ou à distance`;
  if (/corps/i.test(a)) return `Attaque : sort au contact`;
  if (/distance/i.test(a)) return `Attaque : sort à distance`;
  if (spell?.damage && !spell?.save) return `Dégâts : selon effet (zone ou cible)`;
  return null;
}

export function spellDamageSummary(spell) {
  if (!spell?.damage) return null;
  const dt = spell.damageType ? ` ${spell.damageType}` : "";
  return `Dégâts : ${spell.damage}${dt}`;
}

export function spellDescriptionText(spell) {
  const d = String(spell?.description ?? "").trim();
  if (d) return d;
  return String(spell?.effect ?? "").trim();
}

export function spellDurationLine(spell) {
  const d = String(spell?.duration ?? "").trim();
  return d ? `Durée : ${d}` : null;
}

export function spellCastingTimeLine(spell) {
  const c = String(spell?.castingTime ?? "").trim();
  return c ? `Temps d'incantation : ${c}` : null;
}
