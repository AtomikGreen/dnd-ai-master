/**
 * Nom affiché pour un combattant : toujours dérivé de la fiche entité / joueur
 * (source de vérité), pas du libellé figé dans combatOrder (jet d'init, cache, IA).
 */
export function resolveCombatantDisplayName(
  entry: { id: string; name?: string },
  entities: { id: string; name?: string }[],
  playerNom?: string | null
): string {
  if (entry.id === "player") {
    const n = typeof playerNom === "string" ? playerNom.trim() : "";
    if (n) return n;
    const fallback = typeof entry.name === "string" ? entry.name.trim() : "";
    return fallback || "Joueur";
  }
  const ent = entities.find((e) => e.id === entry.id);
  const fromEntity = typeof ent?.name === "string" ? ent.name.trim() : "";
  if (fromEntity) return fromEntity;
  const fallback = typeof entry.name === "string" ? entry.name.trim() : "";
  return fallback || entry.id;
}
