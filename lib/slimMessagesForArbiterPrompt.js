/**
 * Réduit le volume token de l'historique envoyé aux arbitres (parse-intent, gm-arbiter).
 *
 * Objectif : garder juste le contexte utile (typiquement les messages `user`),
 * tout en respectant la forme attendue : { role, type?, content }.
 */
const DEFAULT_SKIP_TYPES = new Set(["debug", "intent-error", "retry-action", "meta", "turn-divider"]);

export function slimMessagesForArbiterPrompt(normalizedMessages, options = {}) {
  const maxTurns = options.maxTurns ?? 20;
  const maxChars = options.maxCharsPerMessage ?? 420;
  const skipTypes = options.skipTypes ?? DEFAULT_SKIP_TYPES;

  // Par défaut : on ne garde que l'utilisateur. On peut toutefois conserver
  // certains messages assistant (ex: dés) et/ou la narration GM (type null).
  const keepAssistantTypes = options.keepAssistantTypes ?? ["dice"];
  const keepAssistantNull = options.keepAssistantNull === true;
  const keepAssistantTypesSet = new Set(
    Array.isArray(keepAssistantTypes) ? keepAssistantTypes.map((s) => String(s)) : []
  );

  if (!Array.isArray(normalizedMessages)) return [];

  const filtered = normalizedMessages.filter((m) => {
    if (!m || typeof m !== "object") return false;
    const role = m.role;
    const t = m.type ?? null;

    // On ignore explicitement les gros types (debug/meta/erreurs) s'ils sont fournis.
    if (t != null && skipTypes.has(String(t))) return false;

    if (role === "user") return true;
    if (role === "assistant") {
      // Par défaut : on ne garde pas la narration IA (souvent type null) pour économiser des tokens.
      if (t == null) return keepAssistantNull;
      return keepAssistantTypesSet.has(String(t));
    }
    return false;
  });

  const tail = filtered.length > maxTurns ? filtered.slice(-maxTurns) : filtered;

  return tail.map((m) => {
    const c = String(m.content ?? "");
    const content = c.length > maxChars ? c.slice(0, maxChars) + "…" : c;
    return { role: m.role, type: m.type ?? null, content };
  });
}
