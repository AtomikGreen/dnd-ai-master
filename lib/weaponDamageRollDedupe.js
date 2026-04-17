/**
 * Idempotence des jets « dégâts d'arme » (weapon_attack_followup) :
 * - évite deux résolutions locales du même `pendingRoll.id` ;
 * - permet d'ignorer un `pendingRoll` obsolète réinjecté par un snapshot Firestore
 *   après que le client a déjà résolu et vidé le jet localement.
 */
const MAX_IDS = 120;
const resolvedIds = new Set();

function normId(rollId) {
  if (typeof rollId !== "string") return "";
  const t = rollId.trim();
  return t || "";
}

export function isWeaponDamageRollIdResolved(rollId) {
  const id = normId(rollId);
  return id !== "" && resolvedIds.has(id);
}

/** À appeler dès le début de la résolution moteur (avant await), pour bloquer replay distant/stale. */
export function markWeaponDamageRollIdResolved(rollId) {
  const id = normId(rollId);
  if (!id) return;
  resolvedIds.add(id);
  while (resolvedIds.size > MAX_IDS) {
    const first = resolvedIds.values().next().value;
    if (first == null) break;
    resolvedIds.delete(first);
  }
}
