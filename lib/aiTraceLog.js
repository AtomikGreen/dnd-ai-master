import fs from "fs";
import path from "path";

/** Dossier des traces JSON (racine du projet). */
const AI_TRACES_DIR = path.join(process.cwd(), "logs", "ai_traces");

/**
 * @param {string} actor — ex. "GM", "AutoPlayer"
 */
function sanitizeActor(actor) {
  const s = String(actor ?? "unknown").trim() || "unknown";
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Enregistre une trace requête/réponse pour le débogage (Observabilité).
 * Les erreurs d’écriture sont absorbées pour ne pas casser l’API.
 *
 * @param {string} actor — "GM" | "AutoPlayer" | …
 * @param {string} provider
 * @param {unknown} dynamicInput
 * @param {string} staticRules
 * @param {string} aiResponse
 * @param {object|null} parsedResponse
 */
export async function logInteraction(actor, provider, dynamicInput, staticRules, aiResponse, parsedResponse) {
  try {
    await fs.promises.mkdir(AI_TRACES_DIR, { recursive: true });
    const staticRulesStr = typeof staticRules === "string" ? staticRules : "";
    /** ISO sans « : » pour tri chronologique dans l’explorateur (date avant l’acteur dans le nom). */
    const ts = new Date().toISOString().replace(/:/g, "-");
    const safeActor = sanitizeActor(actor);
    const filename = `trace_${ts}_${safeActor}.json`;
    const filepath = path.join(AI_TRACES_DIR, filename);

    const record = {
      date: new Date().toISOString(),
      actor,
      provider,
      dynamicInput: dynamicInput ?? null,
      staticRules: {
        applied: staticRulesStr.length > 0,
        lengthChars: staticRulesStr.length,
        full: staticRulesStr,
        preview:
          staticRulesStr.length > 4000
            ? `${staticRulesStr.slice(0, 4000)}…`
            : staticRulesStr,
      },
      aiResponse: typeof aiResponse === "string" ? aiResponse : String(aiResponse ?? ""),
      parsedResponse: parsedResponse ?? null,
    };

    await fs.promises.writeFile(filepath, JSON.stringify(record, null, 2), "utf8");
  } catch (err) {
    console.error("[aiTraceLog] logInteraction:", err);
  }
}
