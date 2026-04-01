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
 * @param {string} aiResponse — réponse finale (ex. après retry format narrateur)
 * @param {object|null} parsedResponse
 * @param {object} [traceExtras] — ex. { formatRetryUsed, formatRetryReason, firstAttemptRaw, geminiGeneration } pour le GM narrateur
 */
export async function logInteraction(actor, provider, dynamicInput, staticRules, aiResponse, parsedResponse, traceExtras) {
  try {
    const logStartedAt = new Date().toISOString();
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
      aiResponse: typeof aiResponse === "string" ? aiResponse : String(aiResponse ?? ""),
      parsedResponse: parsedResponse ?? null,
    };

    if (staticRulesStr.length > 0) {
      record.staticRules = {
        applied: true,
        lengthChars: staticRulesStr.length,
        full: staticRulesStr,
        preview: staticRulesStr.length > 4000 ? `${staticRulesStr.slice(0, 4000)}…` : undefined,
      };
    }

    if (traceExtras?.formatRetryUsed) {
      const first = traceExtras.firstAttemptRaw;
      record.formatRetry = {
        reason: traceExtras.formatRetryReason ?? null,
        /** Première sortie modèle avant correction (JSON invalide / narrative vide, etc.) */
        firstAiResponse: typeof first === "string" ? first : String(first ?? ""),
      };
    }

    if (traceExtras?.geminiGeneration && typeof traceExtras.geminiGeneration === "object") {
      record.geminiGeneration = traceExtras.geminiGeneration;
    }

    if (traceExtras?.promptMetrics && typeof traceExtras.promptMetrics === "object") {
      record.promptMetrics = traceExtras.promptMetrics;
    }

    if (traceExtras?.timing && typeof traceExtras.timing === "object") {
      record.timing = traceExtras.timing;
    }

    if (traceExtras && typeof traceExtras === "object") {
      const extraKeys = Object.keys(traceExtras).filter(
        (k) => !["formatRetryUsed", "formatRetryReason", "firstAttemptRaw", "geminiGeneration", "promptMetrics", "timing"].includes(k)
      );
      for (const key of extraKeys) {
        if (record[key] === undefined) {
          record[key] = traceExtras[key];
        }
      }
    }

    record.logLifecycle = {
      startedAt: logStartedAt,
      beforeWriteAt: new Date().toISOString(),
      note: "Trace écrite de façon asynchrone ; after-log exact est visible dans les logs serveur.",
    };

    await fs.promises.writeFile(filepath, JSON.stringify(record, null, 2), "utf8");
  } catch (err) {
    console.error("[aiTraceLog] logInteraction:", err);
  }
}
