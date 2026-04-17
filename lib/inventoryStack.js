/**
 * Inventaire : empilement (quantités) et pièces (po/pa/pc).
 * Ex. deux "Cimeterre" → une ligne "Cimeterre x2" ; "16 po" + "12 po" → "28 po".
 */

function normKey(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

const CURRENCY_RE = /^(\d+)\s*(po|pa|pc)\s*$/i;
/** "3x Foo" ou "Foo x3" / "Foo ×3" */
const STACK_SUFFIX_RE = /^(.+?)\s*[x×]\s*(\d+)\s*$/i;
const STACK_PREFIX_RE = /^(\d+)\s*[x×]\s*(.+)\s*$/i;

/**
 * @param {string[]} items
 * @returns {string[]}
 */
export function stackInventory(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const lines = items.map((x) => String(x ?? "").trim()).filter(Boolean);
  const currency = { po: 0, pa: 0, pc: 0 };
  /** @type {Map<string, { display: string, qty: number }>} */
  const stacks = new Map();

  for (const line of lines) {
    const cur = line.match(CURRENCY_RE);
    if (cur) {
      const n = Math.max(0, parseInt(cur[1], 10) || 0);
      const u = cur[2].toLowerCase();
      if (u === "po") currency.po += n;
      else if (u === "pa") currency.pa += n;
      else if (u === "pc") currency.pc += n;
      continue;
    }

    let displayName = line;
    let qty = 1;
    let m = line.match(STACK_SUFFIX_RE);
    if (m) {
      displayName = m[1].trim();
      qty = Math.max(1, parseInt(m[2], 10) || 1);
    } else {
      m = line.match(STACK_PREFIX_RE);
      if (m) {
        qty = Math.max(1, parseInt(m[1], 10) || 1);
        displayName = m[2].trim();
      }
    }

    const key = normKey(displayName);
    if (!key) continue;
    const prev = stacks.get(key);
    if (prev) {
      prev.qty += qty;
    } else {
      stacks.set(key, { display: displayName, qty });
    }
  }

  const out = [];
  for (const u of ["po", "pa", "pc"]) {
    const n = currency[u];
    if (n > 0) out.push(`${n} ${u}`);
  }

  for (const { display, qty } of stacks.values()) {
    if (qty <= 1) out.push(display);
    else out.push(`${display} x${qty}`);
  }

  return out;
}

/**
 * Retire une unité d'un article (nom flou). Retourne null si absent.
 * @param {string[]} items
 * @param {string} itemNameCanon ex. "Potion de soins"
 * @returns {string[]|null}
 */
export function removeOneStackedItem(items, itemNameCanon) {
  if (!Array.isArray(items) || !String(itemNameCanon ?? "").trim()) return null;
  const needle = normKey(itemNameCanon);
  if (!needle) return null;

  const lines = items.map((x) => String(x ?? "").trim()).filter(Boolean);
  const next = [];
  let removed = false;

  for (const line of lines) {
    if (removed) {
      next.push(line);
      continue;
    }
    const cur = line.match(CURRENCY_RE);
    if (cur) {
      next.push(line);
      continue;
    }

    let displayName = line;
    let qty = 1;
    let m = line.match(STACK_SUFFIX_RE);
    if (m) {
      displayName = m[1].trim();
      qty = Math.max(1, parseInt(m[2], 10) || 1);
    } else {
      m = line.match(STACK_PREFIX_RE);
      if (m) {
        qty = Math.max(1, parseInt(m[1], 10) || 1);
        displayName = m[2].trim();
      }
    }

    if (normKey(displayName) !== needle) {
      next.push(line);
      continue;
    }

    removed = true;
    if (qty > 1) {
      const newQty = qty - 1;
      if (newQty <= 1) next.push(displayName);
      else next.push(`${displayName} x${newQty}`);
    }
  }

  if (!removed) return null;
  return stackInventory(next);
}

/**
 * @param {string[]} items
 * @param {string} itemNameCanon
 */
export function inventoryHasStackedItem(items, itemNameCanon) {
  if (!Array.isArray(items) || !String(itemNameCanon ?? "").trim()) return false;
  const needle = normKey(itemNameCanon);
  if (!needle) return false;
  for (const line of items) {
    const cur = String(line ?? "").trim();
    if (!cur) continue;
    if (CURRENCY_RE.test(cur)) continue;
    let displayName = cur;
    let m = cur.match(STACK_SUFFIX_RE);
    if (m) displayName = m[1].trim();
    else {
      m = cur.match(STACK_PREFIX_RE);
      if (m) displayName = m[2].trim();
    }
    if (normKey(displayName) === needle) return true;
  }
  return false;
}
