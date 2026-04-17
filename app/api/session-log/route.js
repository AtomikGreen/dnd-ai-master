import { NextResponse } from "next/server";

/**
 * Logs côté serveur (terminal `npm run dev`) pour debug multijoueur / auto-joueur.
 * Sécurité : désactivé en production sauf ENABLE_SESSION_LOG=1.
 */
export async function POST(req) {
  const allowProd = process.env.ENABLE_SESSION_LOG === "1";
  if (process.env.NODE_ENV === "production" && !allowProd) {
    return NextResponse.json({ ok: false, error: "disabled" }, { status: 403 });
  }

  let body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "no-session";
  const tag = typeof body.tag === "string" ? body.tag.trim() : "client";
  const message = typeof body.message === "string" ? body.message : String(body.message ?? "");
  const at = typeof body.at === "string" ? body.at : new Date().toISOString();
  const meta = body.meta;
  const href = typeof body.href === "string" ? body.href : "";

  const metaStr =
    meta !== undefined && meta !== null
      ? typeof meta === "object"
        ? JSON.stringify(meta)
        : String(meta)
      : "";

  // Une ligne lisible dans le terminal
  console.log(
    `[session-log][${sessionId}][${tag}] ${at} ${message}${metaStr ? ` | ${metaStr}` : ""}${
      href ? ` | ${href}` : ""
    }`
  );

  return NextResponse.json({ ok: true });
}
