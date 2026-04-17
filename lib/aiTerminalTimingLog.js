/**
 * Logs terminal (serveur Next) : horodatage d’appel et de réponse pour chaque invocation modèle.
 * Préfixe stable `[IA_APPEL]` / `[IA_REPONSE]` pour filtrer dans les logs.
 */

function formatStamp() {
  const d = new Date();
  return {
    iso: d.toISOString(),
    /** Heure locale lisible (fuseau du process Node). */
    local: d.toLocaleString("fr-FR", {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  };
}

/**
 * @param {string} routePath ex. `/api/chat`
 * @param {string} agentLabel ex. `Narrateur MJ`
 * @param {{ provider?: string, model?: string, note?: string }} [opts]
 * @returns {{ startMs: number, startedIso: string, startedLocal: string }}
 */
export function logTerminalAiCallStart(routePath, agentLabel, opts = {}) {
  const { iso, local } = formatStamp();
  const bits = [
    opts.provider && `fournisseur=${opts.provider}`,
    opts.model && `modèle=${opts.model}`,
    opts.note && `note=${opts.note}`,
  ].filter(Boolean);
  const extra = bits.length ? ` | ${bits.join(" | ")}` : "";
  console.info(`[IA_APPEL] ${local} (${iso}) | ${agentLabel} | ${routePath}${extra}`);
  return { startMs: Date.now(), startedIso: iso, startedLocal: local };
}

/**
 * @param {string} routePath
 * @param {string} agentLabel
 * @param {{ startMs?: number, startedIso?: string, startedLocal?: string } | null | undefined} startCtx
 * @param {{ provider?: string, model?: string, ok?: boolean, status?: number, errorMessage?: string }} [opts]
 */
export function logTerminalAiCallEnd(routePath, agentLabel, startCtx, opts = {}) {
  const { iso, local } = formatStamp();
  const elapsed = startCtx?.startMs != null ? Date.now() - startCtx.startMs : null;
  const bits = [
    opts.provider && `fournisseur=${opts.provider}`,
    opts.model && `modèle=${opts.model}`,
    opts.note && `note=${opts.note}`,
    opts.ok !== undefined && `ok=${opts.ok}`,
    opts.status != null && `http=${opts.status}`,
    elapsed != null && `durée=${elapsed}ms`,
    opts.errorMessage && `erreur=${String(opts.errorMessage).slice(0, 240)}`,
  ].filter(Boolean);
  const depuis = startCtx?.startedIso ? ` | appelé à ${startCtx.startedIso}` : "";
  const extra = bits.length ? ` | ${bits.join(" | ")}` : "";
  console.info(`[IA_REPONSE] ${local} (${iso}) | ${agentLabel} | ${routePath}${depuis}${extra}`);
}

/**
 * Encadre un appel modèle : log début / fin (succès ou exception).
 * @template T
 * @param {{ routePath: string, agentLabel: string, provider: string, model: string, note?: string }} meta
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTerminalAiTiming(meta, fn) {
  const h = logTerminalAiCallStart(meta.routePath, meta.agentLabel, {
    provider: meta.provider,
    model: meta.model,
    note: meta.note,
  });
  try {
    const out = await fn();
    logTerminalAiCallEnd(meta.routePath, meta.agentLabel, h, {
      provider: meta.provider,
      model: meta.model,
      ok: true,
      status: 200,
    });
    return out;
  } catch (err) {
    logTerminalAiCallEnd(meta.routePath, meta.agentLabel, h, {
      provider: meta.provider,
      model: meta.model,
      ok: false,
      status: 500,
      errorMessage: String(err?.message ?? err),
    });
    throw err;
  }
}
