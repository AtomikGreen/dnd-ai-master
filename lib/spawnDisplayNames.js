/**
 * Noms d'affichage pour plusieurs spawns du même type (évite "Gobelin A/B").
 * Utilisé par GameContext et la route /api/chat.
 */

export const HOSTILE_SPAWN_ADJECTIVES = [
  "borgne",
  "balafré",
  "teigneux",
  "boiteux",
  "hargneux",
  "chétif",
  "féroce",
  "cruel",
  "moqueur",
  "malade",
  "grimaçant",
  "rachitique",
];

function shuffleCopy(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * @param {string} base — ex. "Gobelin"
 * @param {Array<{ name?: string }>} existingEntities — entités déjà en scène
 * @param {Set<string>} usedAdjectivesInBatch — adjectifs déjà pris pour ce batch (même base)
 * @returns {string} ex. "Gobelin teigneux"
 */
export function assignSpawnAdjectiveName(base, existingEntities, usedAdjectivesInBatch) {
  const b = String(base || "Créature").trim() || "Créature";
  const existingLower = new Set(
    (existingEntities || [])
      .map((e) => String(e?.name ?? "").trim().toLowerCase())
      .filter(Boolean)
  );
  const order = shuffleCopy(HOSTILE_SPAWN_ADJECTIVES);
  for (const adj of order) {
    if (usedAdjectivesInBatch.has(adj)) continue;
    const full = `${b} ${adj}`.toLowerCase();
    if (existingLower.has(full)) continue;
    usedAdjectivesInBatch.add(adj);
    return `${b} ${adj}`;
  }
  let n = (usedAdjectivesInBatch?.size ?? 0) + existingLower.size + 1;
  for (let k = 0; k < 500; k++) {
    const fallback = `${b} (${n + k})`;
    if (!existingLower.has(fallback.toLowerCase())) {
      usedAdjectivesInBatch.add(`_${n + k}`);
      return fallback;
    }
  }
  return `${b} ${Date.now() % 100000}`;
}

/**
 * Détecte les noms "froids" à remplacer :
 * - identique au nom de base ("Gobelin")
 * - suffixe lettre/chiffre ("Gobelin A", "Gobelin 2", "Gobelin #3")
 */
export function isGenericOrColdSpawnName(base, providedName) {
  const b = String(base || "").trim();
  const p = String(providedName || "").trim();
  if (!p) return true;
  if (!b) return false;
  const bi = b.toLowerCase();
  const pi = p.toLowerCase();
  if (pi === bi) return true;
  const escaped = bi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const coldPattern = new RegExp(`^${escaped}\\s*(?:[a-z]|\\d+|#\\d+|\\(\\d+\\))$`, "i");
  return coldPattern.test(pi);
}
