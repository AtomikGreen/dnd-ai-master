/**
 * Envoie une ligne de log au terminal du serveur Next (via POST /api/session-log).
 * Activer avec NEXT_PUBLIC_DEBUG_SESSION_LOG=1 dans .env.local puis redémarrer le dev server.
 *
 * @param {{ sessionId?: string | null, tag?: string, message: string, meta?: unknown }} opts
 */
export function sessionTerminalLog(opts) {
  if (typeof window === "undefined") return;
  if (process.env.NEXT_PUBLIC_DEBUG_SESSION_LOG !== "1") return;

  const sessionId = opts.sessionId != null ? String(opts.sessionId).trim() : "";
  const tag = opts.tag != null ? String(opts.tag).trim() : "client";
  const message = String(opts.message ?? "");
  const payload = {
    sessionId: sessionId || "no-session",
    tag,
    message,
    meta: opts.meta ?? null,
    at: new Date().toISOString(),
    href: typeof window.location?.href === "string" ? window.location.href : "",
  };

  void fetch("/api/session-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {});
}
