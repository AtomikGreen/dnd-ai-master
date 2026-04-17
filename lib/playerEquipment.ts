import { ARMORS, WEAPONS } from "@/data/srd5";

/** Emplacements d'équipement (hors harmonisation). */
export type PlayerEquipmentState = {
  /** Une seule armure de corps. */
  armor: string | null;
  /** Arme principale (ou arme à deux mains seule). */
  mainHand: string | null;
  /**
   * Main secondaire : autre arme ou « Bouclier ».
   * Un seul bouclier : la CA ne compte qu’une fois (+2).
   */
  offHand: string | null;
  bottes: string | null;
  cape: string | null;
  tete: string | null;
  gants: string | null;
  /** Objets magiques harmonisés (max 3 simultanés). */
  attunedItems: string[];
};

export const MAX_ATTUNED_ITEMS = 3;

export function emptyEquipment(): PlayerEquipmentState {
  return {
    armor: null,
    mainHand: null,
    offHand: null,
    bottes: null,
    cape: null,
    tete: null,
    gants: null,
    attunedItems: [],
  };
}

/** Noms d’objets actuellement portés / tenus / harmonisés (pour masquer le doublon dans l’affichage « sac »). */
export function collectEquippedItemNames(
  eq: PlayerEquipmentState | null | undefined
): Set<string> {
  const e = eq ? normalizeEquipmentState(eq) : emptyEquipment();
  const out = new Set<string>();
  const add = (x: string | null | undefined) => {
    const t = String(x ?? "").trim();
    if (t) out.add(t);
  };
  add(e.armor);
  add(e.mainHand);
  add(e.offHand);
  add(e.bottes);
  add(e.cape);
  add(e.tete);
  add(e.gants);
  for (const x of e.attunedItems ?? []) add(x);
  return out;
}

/**
 * Objets actuellement équipés / harmonisés, dans un ordre lisible (armure → mains → accessoires → harmonisations).
 * Les doublons (ex. même nom en emplacement et en harmonisation) n’apparaissent qu’une fois.
 */
export function listEquippedItemsDisplayOrder(
  eq: PlayerEquipmentState | null | undefined
): string[] {
  const e = normalizeEquipmentState(eq);
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (x: string | null | undefined) => {
    const t = String(x ?? "").trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  push(e.armor);
  push(e.mainHand);
  push(e.offHand);
  push(e.tete);
  push(e.cape);
  push(e.gants);
  push(e.bottes);
  for (const x of e.attunedItems ?? []) push(x);
  return out;
}

/** Inventaire « sac » : tout ce qui est possédé mais non équipé (même chaîne exacte que dans `inventory`). */
export function inventoryExcludingEquipped(
  inventory: string[],
  equipment: PlayerEquipmentState | null | undefined
): string[] {
  const equipped = collectEquippedItemNames(equipment);
  return (Array.isArray(inventory) ? inventory : []).filter((raw) => {
    const item = String(raw ?? "").trim();
    if (!item) return false;
    return !equipped.has(item);
  });
}

export function normalizeEquipmentState(raw: unknown): PlayerEquipmentState {
  const e = emptyEquipment();
  if (!raw || typeof raw !== "object") return e;
  const o = raw as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  e.armor = s(o.armor);
  e.mainHand = s(o.mainHand);
  e.offHand = s(o.offHand);
  e.bottes = s(o.bottes);
  e.cape = s(o.cape);
  e.tete = s(o.tete);
  e.gants = s(o.gants);
  if (Array.isArray(o.attunedItems)) {
    e.attunedItems = o.attunedItems
      .map((x) => (typeof x === "string" ? x.trim() : ""))
      .filter(Boolean)
      .slice(0, MAX_ATTUNED_ITEMS);
  }
  return e;
}

function dexMod(dex: number): number {
  return Math.floor((dex - 10) / 2);
}

export function isBodyArmorName(name: string | null | undefined): boolean {
  if (!name || typeof name !== "string") return false;
  const a = ARMORS[name as keyof typeof ARMORS];
  if (!a) return false;
  return String((a as { type?: string }).type ?? "").toLowerCase() !== "bouclier";
}

export function isShieldName(name: string | null | undefined): boolean {
  return name === "Bouclier";
}

export function weaponUsesTwoHands(name: string | null | undefined): boolean {
  if (!name) return false;
  const w = WEAPONS[name as keyof typeof WEAPONS];
  if (!w) return false;
  const props = Array.isArray((w as { properties?: string[] }).properties)
    ? (w as { properties: string[] }).properties
    : [];
  return props.some((p) => String(p).includes("Deux mains"));
}

export function weaponIsLight(name: string | null | undefined): boolean {
  if (!name) return false;
  const w = WEAPONS[name as keyof typeof WEAPONS];
  if (!w) return false;
  const props = Array.isArray((w as { properties?: string[] }).properties)
    ? (w as { properties: string[] }).properties
    : [];
  return props.some((p) => String(p).toLowerCase().includes("légère"));
}

export function isWeaponName(name: string | null | undefined): boolean {
  if (!name) return false;
  return !!WEAPONS[name as keyof typeof WEAPONS];
}

/** Don Ambidextrie / Dual Wielder (armes non légères en double). */
export function hasDualWielderFeat(features: string[] | undefined, feats: string[] | undefined): boolean {
  const all = [...(features ?? []), ...(feats ?? [])];
  return all.some((f) => {
    const t = String(f).toLowerCase();
    return (
      t.includes("ambidextrie") ||
      t.includes("dual wielder") ||
      t.includes("maîtrise des armes de combat à deux armes")
    );
  });
}

export type PlayerArmorSource = {
  stats: { DEX: number; SAG?: number; CON?: number };
  entityClass?: string;
  equipment?: PlayerEquipmentState | null;
  fighter?: { fightingStyle?: string };
};

/**
 * CA calculée à partir de l’équipement porté et des caractéristiques.
 * Ne pas ajouter le bonus « Défense » en double : il est inclus ici si armure + style.
 */
export function computePlayerArmorClass(p: PlayerArmorSource): number {
  const eq = p.equipment ?? emptyEquipment();
  const dex = dexMod(Number(p.stats?.DEX ?? 10));
  const armorName = eq.armor;

  let ac = 10 + dex;

  if (armorName && isBodyArmorName(armorName)) {
    const armor = ARMORS[armorName as keyof typeof ARMORS];
    if (armor) {
      const mod = String((armor as { modifier?: string }).modifier ?? "");
      const base = Number((armor as { baseAC?: number }).baseAC ?? 10);
      if (mod === "DEX") ac = base + dex;
      else if (mod === "DEX_MAX_2") ac = base + Math.min(2, dex);
      else if (mod === "NONE") ac = base;
      else ac = base + dex;
    }
  } else if (String(p.entityClass ?? "") === "Moine") {
    const wis = dexMod(Number(p.stats?.SAG ?? 10));
    ac = 10 + dex + wis;
  } else if (String(p.entityClass ?? "") === "Barbare") {
    const con = dexMod(Number(p.stats?.CON ?? 10));
    ac = 10 + dex + con;
  }

  if (eq.offHand === "Bouclier") {
    ac += ARMORS.Bouclier.baseAC;
  }

  if (
    p.fighter?.fightingStyle === "Défense" &&
    armorName &&
    isBodyArmorName(armorName)
  ) {
    ac += 1;
  }

  return Math.max(0, Math.trunc(ac));
}

function inventoryHas(inv: string[], name: string): boolean {
  if (!name) return false;
  return inv.some((x) => String(x).trim() === name);
}

export type EquipSlot =
  | "armor"
  | "mainHand"
  | "offHand"
  | "bottes"
  | "cape"
  | "tete"
  | "gants";

export function validateEquipmentConfig(eq: PlayerEquipmentState, player: PlayerArmorSource & { features?: string[]; feats?: string[] }): { ok: boolean; reason?: string } {
  const mh = eq.mainHand;
  const oh = eq.offHand;
  const dual = hasDualWielderFeat(player.features, player.feats);

  if (mh && weaponUsesTwoHands(mh)) {
    if (oh) {
      return { ok: false, reason: "Une arme à deux mains occupe les deux mains : videz la main secondaire." };
    }
  }

  if (mh && weaponUsesTwoHands(mh) && oh === "Bouclier") {
    return { ok: false, reason: "Impossible de porter un bouclier avec une arme à deux mains." };
  }

  if (mh && isWeaponName(mh) && oh && isWeaponName(oh)) {
    if (!weaponIsLight(mh) && !weaponIsLight(oh) && !dual) {
      return {
        ok: false,
        reason:
          "Combat à deux armes : au moins une arme doit être « Légère », ou posséder le don Ambidextrie.",
      };
    }
  }

  const shieldCount = (oh === "Bouclier" ? 1 : 0) + (mh === "Bouclier" ? 1 : 0);
  if (shieldCount > 1) {
    return { ok: false, reason: "Un seul bouclier peut contribuer à la CA." };
  }

  return { ok: true };
}

/**
 * Tente d'équiper un objet depuis l'inventaire. Retourne le nouvel état d'équipement ou une erreur.
 */
export function tryEquipFromInventory(
  eq: PlayerEquipmentState,
  slot: EquipSlot | "attune",
  itemName: string | null,
  inventory: string[],
  player: PlayerArmorSource & { features?: string[]; feats?: string[] }
): { ok: boolean; equipment?: PlayerEquipmentState; reason?: string } {
  const next: PlayerEquipmentState = {
    ...eq,
    attunedItems: [...(eq.attunedItems ?? [])],
  };

  if (slot === "attune") {
    if (!itemName) {
      return { ok: false, reason: "Objet invalide." };
    }
    if (!inventoryHas(inventory, itemName)) {
      return { ok: false, reason: "Objet absent de l'inventaire." };
    }
    if (next.attunedItems.includes(itemName)) {
      return { ok: false, reason: "Déjà harmonisé." };
    }
    if (next.attunedItems.length >= MAX_ATTUNED_ITEMS) {
      return { ok: false, reason: `Maximum ${MAX_ATTUNED_ITEMS} objets harmonisés (règle D&D 5e).` };
    }
    next.attunedItems.push(itemName);
    return { ok: true, equipment: next };
  }

  if (itemName === null || itemName === "") {
    if (slot === "armor") next.armor = null;
    else if (slot === "mainHand") next.mainHand = null;
    else if (slot === "offHand") next.offHand = null;
    else if (slot === "bottes") next.bottes = null;
    else if (slot === "cape") next.cape = null;
    else if (slot === "tete") next.tete = null;
    else if (slot === "gants") next.gants = null;
    const v = validateEquipmentConfig(next, player);
    if (!v.ok) return { ok: false, reason: v.reason };
    return { ok: true, equipment: next };
  }

  const trimmed = itemName.trim();
  if (!inventoryHas(inventory, trimmed)) {
    return { ok: false, reason: "Objet absent de l'inventaire." };
  }

  if (slot === "armor") {
    if (!isBodyArmorName(trimmed)) {
      return { ok: false, reason: "Ce n'est pas une armure de corps (ou c'est un bouclier)." };
    }
    next.armor = trimmed;
  } else if (slot === "mainHand") {
    if (isShieldName(trimmed)) {
      return { ok: false, reason: "Le bouclier se porte en main secondaire." };
    }
    if (isBodyArmorName(trimmed)) {
      return { ok: false, reason: "Utilisez l'emplacement Armure pour une armure." };
    }
    if (!isWeaponName(trimmed)) {
      return { ok: false, reason: "Ce n'est pas une arme reconnue dans le SRD." };
    }
    next.mainHand = trimmed;
    if (weaponUsesTwoHands(trimmed)) {
      next.offHand = null;
    }
  } else if (slot === "offHand") {
    if (isBodyArmorName(trimmed)) {
      return { ok: false, reason: "Ce n'est pas un bouclier ni une arme de main." };
    }
    if (trimmed === "Bouclier") {
      next.offHand = "Bouclier";
      if (next.mainHand && weaponUsesTwoHands(next.mainHand)) {
        return { ok: false, reason: "Déséquipez l'arme à deux mains avant de prendre un bouclier." };
      }
    } else if (isWeaponName(trimmed)) {
      if (next.mainHand && weaponUsesTwoHands(next.mainHand)) {
        return { ok: false, reason: "Les deux mains sont prises par l'arme à deux mains." };
      }
      next.offHand = trimmed;
    } else {
      return { ok: false, reason: "Main secondaire : bouclier ou arme uniquement." };
    }
  } else if (slot === "bottes") {
    if (!itemLooksLikeBoots(trimmed)) {
      return { ok: false, reason: "Emplacement réservé aux bottes / chaussures." };
    }
    next.bottes = trimmed;
  } else if (slot === "cape") {
    if (!itemLooksLikeCloak(trimmed)) {
      return { ok: false, reason: "Emplacement réservé à une cape / manteau." };
    }
    next.cape = trimmed;
  } else if (slot === "tete") {
    if (!itemLooksLikeHeadwear(trimmed)) {
      return { ok: false, reason: "Emplacement réservé au couvre-chef (casque, chapeau, bandeau...)." };
    }
    next.tete = trimmed;
  } else if (slot === "gants") {
    if (!itemLooksLikeGloves(trimmed)) {
      return { ok: false, reason: "Emplacement réservé aux gants / gantelets." };
    }
    next.gants = trimmed;
  }

  const v = validateEquipmentConfig(next, player);
  if (!v.ok) return { ok: false, reason: v.reason };
  return { ok: true, equipment: next };
}

export function tryUnequipAttunement(eq: PlayerEquipmentState, itemName: string): PlayerEquipmentState {
  return {
    ...eq,
    attunedItems: (eq.attunedItems ?? []).filter((x) => x !== itemName),
  };
}

/** Objets de l’inventaire pouvant aller dans un emplacement (aperçu UI). */
export function inventoryCandidatesForSlot(inventory: string[], slot: EquipSlot): string[] {
  const inv = Array.isArray(inventory) ? inventory : [];
  return inv.filter((item) => {
    const t = String(item ?? "").trim();
    if (!t) return false;
    if (slot === "armor") return isBodyArmorName(t);
    if (slot === "mainHand") return isWeaponName(t) && !isShieldName(t);
    if (slot === "offHand") return isWeaponName(t) || isShieldName(t);
    if (slot === "bottes") return itemLooksLikeBoots(t);
    if (slot === "cape") return itemLooksLikeCloak(t);
    if (slot === "tete") return itemLooksLikeHeadwear(t);
    if (slot === "gants") return itemLooksLikeGloves(t);
    return false;
  });
}

function itemLooksLikeBoots(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("bottes") || n.includes("chaussures") || n.includes("souliers");
}

function itemLooksLikeCloak(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("cape") || n.includes("manteau") || n.includes("pèlerine");
}

function itemLooksLikeHeadwear(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes("casque") ||
    n.includes("chapeau") ||
    n.includes("bandeau") ||
    n.includes("couronne") ||
    n.includes("capuche")
  );
}

function itemLooksLikeGloves(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("gant") || n.includes("mitaine");
}

/** À l'export du créateur : armure, bouclier, liste d'armes du pack. */
export function buildEquipmentFromStartingGear(opts: {
  armorName: string | null;
  shieldEquipped: boolean;
  weaponNames: string[];
}): PlayerEquipmentState {
  const e = emptyEquipment();
  const armor = opts.armorName && opts.armorName !== "Aucune" ? opts.armorName : null;
  if (armor && isBodyArmorName(armor)) e.armor = armor;

  const weapons = (opts.weaponNames ?? []).filter((w) => isWeaponName(w));
  if (weapons.length === 0) {
    if (opts.shieldEquipped) e.offHand = "Bouclier";
    return e;
  }

  const first = weapons[0]!;
  if (weaponUsesTwoHands(first)) {
    e.mainHand = first;
    return e;
  }

  e.mainHand = first;
  if (opts.shieldEquipped) {
    e.offHand = "Bouclier";
    return e;
  }
  if (weapons.length >= 2) {
    e.offHand = weapons[1]!;
  }
  return e;
}

/**
 * Rétrocompat : déduit un équipement raisonnable depuis inventaire + armes de fiche.
 */
export function inferEquipmentFromLegacy(player: {
  inventory?: string[];
  weapons?: { name?: string }[];
  equipment?: PlayerEquipmentState | null;
  stats?: { DEX: number };
  entityClass?: string;
  features?: string[];
  feats?: string[];
}): PlayerEquipmentState {
  if (player.equipment && typeof player.equipment === "object") {
    const normalized = normalizeEquipmentState(player.equipment);
    const hasSlot =
      !!normalized.armor ||
      !!normalized.mainHand ||
      !!normalized.offHand ||
      !!normalized.bottes ||
      !!normalized.cape ||
      !!normalized.tete ||
      !!normalized.gants ||
      (normalized.attunedItems?.length ?? 0) > 0;
    if (hasSlot) return normalized;
  }
  const inv = Array.isArray(player.inventory) ? player.inventory : [];
  const e = emptyEquipment();

  for (const item of inv) {
    if (isBodyArmorName(item)) {
      e.armor = item;
      break;
    }
  }

  const weaponNamesFromSheet = (player.weapons ?? [])
    .map((w) => String(w?.name ?? "").trim())
    .filter(Boolean);

  let main: string | null = null;

  for (const w of weaponNamesFromSheet) {
    if (inv.includes(w) && isWeaponName(w)) {
      main = w;
      break;
    }
  }
  if (!main) {
    const invWeapons = inv.filter((x) => isWeaponName(x));
    if (invWeapons.length) main = invWeapons[0]!;
  }

  if (main && weaponUsesTwoHands(main)) {
    e.mainHand = main;
    return e;
  }

  e.mainHand = main;
  if (inv.includes("Bouclier")) {
    e.offHand = "Bouclier";
  } else {
    const invWeapons = inv.filter((x) => isWeaponName(x) && x !== main);
    if (main && invWeapons.length) {
      e.offHand = invWeapons[0] ?? null;
    }
  }

  const ctx = {
    stats: player.stats ?? { DEX: 10 },
    entityClass: player.entityClass,
    features: player.features,
    feats: player.feats,
  };
  const v = validateEquipmentConfig(e, ctx);
  if (!v.ok) {
    if (e.offHand && e.offHand !== "Bouclier" && inv.includes("Bouclier")) {
      e.offHand = "Bouclier";
    } else if (!v.ok && e.offHand) {
      e.offHand = null;
    }
  }
  return e;
}
