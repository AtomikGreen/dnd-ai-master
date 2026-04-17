/**
 * Même logique que `commitPlayerInitiativeRoll` / finalisation d'initiative :
 * l'id du PJ dans `combatOrder` peut être l'id de fiche (`player.id`), l'id d'entité
 * contrôlée (`controller === "player"`), ou `"player"` — pas toujours la chaîne `"player"`.
 * La mêlée et l'UI initiative doivent utiliser exactement le même id.
 */
export function resolveLocalPlayerCombatantId(opts: {
  player: { id?: string | number | null } | null;
  entities: { id: string; controller?: string; isAlive?: boolean }[] | null | undefined;
  multiplayerSessionId: string | null | undefined;
  clientId: string | null | undefined;
}): string {
  const { player, entities, multiplayerSessionId, clientId } = opts;
  if (multiplayerSessionId && clientId) {
    return `mp-player-${String(clientId).trim()}`;
  }
  const sheetId =
    player?.id != null && String(player.id).trim() ? String(player.id).trim() : null;
  const required: string[] = [];
  for (const e of entities ?? []) {
    if (!e || e.isAlive === false) continue;
    if (e.controller === "player") required.push(e.id);
  }
  if (required.length === 1) return required[0];
  if (required.length > 1) {
    if (sheetId && required.includes(sheetId)) return sheetId;
    return required[0];
  }
  if (sheetId) return sheetId;
  return "player";
}
