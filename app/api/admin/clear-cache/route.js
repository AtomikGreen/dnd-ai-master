/**
 * Admin local : purge tous les Context Caches Gemini du projet et réinitialise le cache MJ en mémoire.
 * GET http://localhost:3000/api/admin/clear-cache
 */
import { GoogleAICacheManager } from "@google/generative-ai/server";
import { NextResponse } from "next/server";
import { resetNarratorCache } from "@/app/api/chat/route";

/**
 * Liste puis supprime tous les cached contents (pagination nextPageToken).
 * @param {GoogleAICacheManager} manager
 */
async function deleteAllCachedContents(manager) {
  const deleted = [];
  const errors = [];
  let pageToken;

  for (;;) {
    const listParams = pageToken ? { pageToken } : undefined;
    const res = await manager.list(listParams);
    const items =
      res?.cachedContents ??
      res?.cached_contents ??
      [];

    for (const item of items) {
      const name = item?.name;
      if (!name) continue;
      try {
        await manager.delete(name);
        deleted.push(name);
      } catch (e) {
        errors.push({ name, message: String(e?.message ?? e) });
      }
    }

    pageToken = res?.nextPageToken ?? res?.next_page_token;
    if (!pageToken) break;
  }

  return { deleted, errors };
}

export async function GET() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey?.trim()) {
    return NextResponse.json(
      { ok: false, error: "GEMINI_API_KEY manquant." },
      { status: 503 }
    );
  }

  try {
    const manager = new GoogleAICacheManager(apiKey);
    const { deleted, errors } = await deleteAllCachedContents(manager);
    resetNarratorCache();

    return NextResponse.json({
      ok: errors.length === 0,
      message:
        deleted.length === 0
          ? "Aucun cache Gemini à supprimer. Promesse narrateur réinitialisée."
          : `${deleted.length} cache(s) supprimé(s). Promesse narrateur réinitialisée.`,
      deletedCount: deleted.length,
      deleted,
      errors,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: String(e?.message ?? e),
      },
      { status: 500 }
    );
  }
}
