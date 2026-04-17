import { SPELLS, WEAPONS } from "@/data/srd5";
import { getSpellComponents, formatSpellComponentsAbbrev } from "@/lib/spellCastingComponents";

function normalizeKey(input) {
  return String(input ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseWeaponProperties(rawProps = []) {
  const props = Array.isArray(rawProps) ? rawProps.map((p) => String(p ?? "")) : [];
  const normalized = props.map((p) => normalizeKey(p));
  const hasFinesse = normalized.some((p) => p.includes("finesse"));
  const hasThrown = normalized.some((p) => p.includes("lancer"));
  const hasAmmunition = normalized.some((p) => p.includes("munition"));
  const hasReach = normalized.some((p) => p.includes("allonge"));

  const rangeProp = props.find((p) => /port[ée]e/i.test(p)) ?? "";
  const m = rangeProp.match(/([0-9]+(?:[.,][0-9]+)?)\s*\/\s*([0-9]+(?:[.,][0-9]+)?)/i);
  const rangeMeters =
    m && m[1] && m[2]
      ? {
          normal: Number(String(m[1]).replace(",", ".")),
          long: Number(String(m[2]).replace(",", ".")),
        }
      : null;

  return {
    hasFinesse,
    hasThrown,
    hasAmmunition,
    hasReach,
    rangeMeters:
      rangeMeters &&
      Number.isFinite(rangeMeters.normal) &&
      Number.isFinite(rangeMeters.long)
        ? rangeMeters
        : null,
  };
}

function buildWeaponCompendium() {
  const entries = {};
  const aliases = {};
  Object.entries(WEAPONS ?? {}).forEach(([name, raw]) => {
    const id = normalizeKey(name);
    const parsed = parseWeaponProperties(raw?.properties ?? []);
    const looksRangedByName = /arc|arbal|fronde|sarbacane|filet|fl[eé]chette/i.test(name);
    const rangedOnly = parsed.hasAmmunition || looksRangedByName;
    const supportsThrown = parsed.hasThrown;
    const attackModes = rangedOnly ? ["ranged"] : supportsThrown ? ["melee", "ranged"] : ["melee"];
    entries[id] = {
      id,
      name,
      category: raw?.category ?? null,
      damage: raw?.damage ?? null,
      damageType: raw?.damageType ?? null,
      statHint: raw?.stat ?? null,
      properties: Array.isArray(raw?.properties) ? raw.properties : [],
      attackModes,
      rangedOnly,
      supportsThrown,
      hasFinesse: parsed.hasFinesse || String(raw?.stat ?? "").toUpperCase() === "FINESSE",
      rangeMeters: parsed.rangeMeters,
    };
    aliases[normalizeKey(name)] = id;
  });
  return { entries, aliases };
}

const builtWeapons = buildWeaponCompendium();
export const WEAPON_COMPENDIUM = builtWeapons.entries;
export const WEAPON_NAME_TO_ID = builtWeapons.aliases;

export function getWeaponIdByName(name) {
  const k = normalizeKey(name);
  return WEAPON_NAME_TO_ID[k] ?? null;
}

export function getWeaponCompendiumEntry(weaponLike) {
  if (!weaponLike) return null;
  const byId =
    typeof weaponLike?.weaponId === "string" && weaponLike.weaponId.trim()
      ? WEAPON_COMPENDIUM[normalizeKey(weaponLike.weaponId)]
      : null;
  if (byId) return byId;
  if (typeof weaponLike?.name === "string" && weaponLike.name.trim()) {
    const id = getWeaponIdByName(weaponLike.name);
    if (id) return WEAPON_COMPENDIUM[id] ?? null;
  }
  if (typeof weaponLike === "string") {
    const id = getWeaponIdByName(weaponLike);
    if (id) return WEAPON_COMPENDIUM[id] ?? null;
  }
  return null;
}

export function resolveAttackMode(weaponLike, attacker, context = {}) {
  const inMeleeWithTarget = context?.inMeleeWithTarget === true;
  /** Dague, hachette, etc. : à distance = jet (pas d'engagement) ; au contact, poignarder par défaut sauf si le joueur dit « lancer / jeter ». */
  const treatAsThrown = context?.treatAsThrown === true;
  const meta = getWeaponCompendiumEntry(weaponLike);
  const stats = attacker?.stats ?? {};
  const strMod = Math.floor(((stats?.FOR ?? 10) - 10) / 2);
  const dexMod = Math.floor(((stats?.DEX ?? 10) - 10) / 2);
  const chooseBest = dexMod >= strMod ? "DEX" : "FOR";

  // Fallback rétro-compat si l'arme n'est pas encore dans le compendium.
  if (!meta) {
    const n = String(weaponLike?.name ?? weaponLike ?? "");
    const rangedByName = /arc|arbal|fronde|sarbacane|filet/i.test(n);
    return {
      attackType: rangedByName ? "ranged" : "melee",
      ability: rangedByName ? "DEX" : "FOR",
      source: "fallback_name_heuristic",
    };
  }

  let attackType = "melee";
  if (meta.rangedOnly) {
    attackType = "ranged";
  } else if (meta.supportsThrown) {
    if (!inMeleeWithTarget) {
      attackType = "ranged";
    } else if (treatAsThrown) {
      attackType = "ranged";
    } else {
      attackType = "melee";
    }
  }

  let ability = "FOR";
  if (attackType === "ranged") {
    if (meta.rangedOnly) {
      ability = "DEX";
    } else if (meta.hasFinesse) {
      ability = chooseBest;
    } else if (meta.supportsThrown) {
      ability = "FOR";
    } else {
      ability = "DEX";
    }
  } else if (meta.hasFinesse) {
    ability = chooseBest;
  }

  return {
    attackType,
    ability,
    source: "weapon_compendium",
    weaponId: meta.id,
  };
}

function parseCastingTime(rawCastingTime) {
  const raw = String(rawCastingTime ?? "").trim();
  const lower = raw.toLowerCase();
  if (!raw) return { raw, actionType: "action" };
  if (lower.includes("bonus")) return { raw, actionType: "bonus_action" };
  if (lower.includes("réaction") || lower.includes("reaction")) return { raw, actionType: "reaction" };
  return { raw, actionType: "action" };
}

function parseDuration(rawDuration) {
  const raw = String(rawDuration ?? "").trim();
  const lower = raw.toLowerCase();
  return {
    raw,
    concentration: lower.includes("concentration"),
    instantaneous: lower.includes("instantan"),
  };
}

function parseRange(rawRange) {
  const raw = String(rawRange ?? "").trim();
  return { raw };
}

function strictifySpell(name, raw) {
  const saveAbility = typeof raw?.save === "string" ? raw.save : null;
  const attackRaw = typeof raw?.attack === "string" ? raw.attack : "";
  const attackType = /distance/i.test(attackRaw)
    ? "ranged_spell_attack"
    : /corps/i.test(attackRaw)
      ? "melee_spell_attack"
      : /touche auto/i.test(attackRaw)
        ? "auto_hit"
        : null;
  const comp = getSpellComponents(name);
  return {
    id: normalizeKey(name),
    name,
    level: Number.isFinite(Number(raw?.level)) ? Number(raw.level) : 0,
    school: raw?.school ?? null,
    castingTime: parseCastingTime(raw?.castingTime),
    range: parseRange(raw?.range),
    duration: parseDuration(raw?.duration),
    components: {
      verbal: comp.verbal,
      somatic: comp.somatic,
      material: comp.material,
      materialCostly: !!comp.materialCostly,
      raw: formatSpellComponentsAbbrev(name),
    },
    saveAbility,
    attackType,
    damage: raw?.damage
      ? {
          dice: String(raw.damage),
          damageType: raw?.damageType ?? null,
        }
      : null,
    classes: Array.isArray(raw?.classes) ? raw.classes : [],
    raw,
  };
}

export const SPELLS_STRICT = Object.fromEntries(
  Object.entries(SPELLS ?? {}).map(([name, raw]) => [name, strictifySpell(name, raw)])
);

export function getStrictSpellMeta(name) {
  const key = String(name ?? "").trim();
  if (!key) return null;
  return SPELLS_STRICT[key] ?? null;
}
