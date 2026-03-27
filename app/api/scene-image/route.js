import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { logInteraction } from "@/lib/aiTraceLog";

/** Modèle image Gemini (Nano Banana / API image). Surcharge possible via GEMINI_IMAGE_MODEL. */
const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image-preview";

/** Modèle pour synthétiser le prompt visuel (texte) — aligné sur la stack image du projet. */
const DEFAULT_GEMINI_SCENE_PROMPT_MODEL =
  process.env.GEMINI_SCENE_PROMPT_MODEL?.trim() || "gemini-3.1-flash-image-preview";

const MODEL_ALLOWLIST = new Set([DEFAULT_GEMINI_IMAGE_MODEL, "gemini-2.5-flash-image"]);

function resolveModel(requested) {
  const fromEnv = process.env.GEMINI_IMAGE_MODEL?.trim();
  if (fromEnv) return fromEnv;
  if (typeof requested === "string" && MODEL_ALLOWLIST.has(requested)) return requested;
  return DEFAULT_GEMINI_IMAGE_MODEL;
}

const VISUAL_SYNTH_SYSTEM = [
  "Tu es un directeur artistique et ingénieur de prompt pour génération d'image fantasy/JDR.",
  "Ton rôle : transformer un contexte de scène en un prompt visuel unique, clair, fidèle, efficace, sans contradiction.",
  "",
  "RÈGLES :",
  "- Le champ 'location' décrit le décor visible réel : c'est la vérité principale pour l'environnement.",
  "- Le champ 'gmNarration' décrit la mise en scène immédiate récente : utilise-le pour l'action, l'ambiance et la pose.",
  "- Le champ 'imageTrigger.focus' indique ce qu'il faut montrer en priorité dans l'image.",
  "- Le champ 'imageTrigger.engineEvent' est la vérité mécanique. S'il indique une cible touchée, morte ou encore vivante, respecte-le.",
  "- Le champ 'eventFocusTarget' décrit la cible importante du moment. Si elle est morte ou à 0 PV, elle peut apparaître comme corps, victime, ou silhouette vaincue même si elle n'est pas dans presentNPCs.",
  "- presentNPCs décrit les personnages actuellement visibles et encore présents dans la scène. N'invente jamais d'autres humanoïdes.",
  "- Si presentNPCs est vide, l'image ne doit contenir que le héros joueur, sauf éventuel corps/victime explicitement indiqué par eventFocusTarget.",
  "- Si presentNPCs contient des entrées, seuls le héros joueur + ces entrées peuvent apparaître, plus éventuellement un corps/victime explicitement indiqué par eventFocusTarget.",
  "- Pour le héros joueur, utilise prioritairement characterName, race, characterClass, level, description et visibleGear.",
  "- Décris la composition, l'échelle du plan, la lumière, les matières, et l'action centrale. Sois concret, visuel et compact.",
  "- N'invente ni village, ni forge, ni compagnon, ni foule, ni voyage si le décor actuel ne les montre pas.",
  "- N'utilise pas de guillemets autour des noms dans le prompt final.",
  "- Rédige le prompt final entièrement en FRANÇAIS.",
  "- Retourne uniquement le prompt final, sans commentaire, sans JSON, sans introduction.",
].join("\n");

const IMAGE_PROMPT_STYLE_SUFFIX =
  "illustration dark fantasy de jeu de role, peinture numerique, art conceptuel, eclairage cinematographique, tres detaille, haute qualite";

/**
 * Garde-fous ajoutés au prompt envoyé au modèle image (synthèse ou fallback).
 * @param {unknown} vc
 * @returns {string[]}
 */
function buildCompositionGuards(vc) {
  if (!vc || typeof vc !== "object") return [];
  const o = /** @type {Record<string, unknown>} */ (vc);
  const npcs = Array.isArray(o.presentNPCs) ? o.presentNPCs : [];
  const sf = o.sceneForImage;
  const onlyPlayer =
    sf && typeof sf === "object" && typeof sf.onlyPlayerCharacterInFrame === "boolean"
      ? /** @type {boolean} */ (sf.onlyPlayerCharacterInFrame)
      : npcs.length === 0;
  const guards = [];
  if (onlyPlayer) {
    guards.push(
      "COMPOSITION CRITIQUE : un seul humanoide vivant dans le cadre, le heros joueur. Aucun compagnon, aucun soldat, aucune foule, aucun PNJ d'arriere-plan non liste."
    );
  } else {
    guards.push(
      `COMPOSITION CRITIQUE : seuls le heros joueur et les ${npcs.length} personnage(s) listes dans presentNPCs peuvent apparaitre comme personnages vivants. Aucun extra non nomme.`
    );
  }
  guards.push(
    "DECOR CRITIQUE : le champ location definit le lieu visible reel. Ne remplace jamais ce decor par un autre lieu mentionne seulement dans le contexte narratif."
  );
  return guards;
}

/**
 * @param {string} corePrompt
 * @param {unknown} vc
 * @returns {string}
 */
function finalizeImagePrompt(corePrompt, vc) {
  const core = String(corePrompt ?? "").trim();
  const guards = buildCompositionGuards(vc);
  return [core, ...guards, IMAGE_PROMPT_STYLE_SUFFIX].filter(Boolean).join("\n\n");
}

/**
 * @param {unknown} vc
 * @returns {string}
 */
function fallbackPromptFromVisualContext(vc) {
  if (!vc || typeof vc !== "object") return "";
  const o = /** @type {Record<string, unknown>} */ (vc);
  const parts = [];
  const loc = typeof o.location === "string" ? o.location.trim() : "";
  const name = typeof o.sceneName === "string" ? o.sceneName.trim() : "";
  if (name) parts.push(`Scene : ${name}.`);
  if (loc) parts.push(`Decor visible : ${loc}`);
  const focus = typeof o.narrativeFocus === "string" ? o.narrativeFocus.trim() : "";
  const gmNarration = typeof o.gmNarration === "string" ? o.gmNarration.trim() : "";
  if (focus) {
    parts.push(`Focus narratif : ${focus}`);
  }
  if (gmNarration) {
    parts.push(`Narration MJ recente : ${gmNarration}`);
  }
  const pi = o.playerInfo;
  if (pi && typeof pi === "object") {
    const p = /** @type {Record<string, unknown>} */ (pi);
    const cn = typeof p.characterName === "string" ? p.characterName.trim() : "";
    const race = typeof p.race === "string" ? p.race.trim() : "";
    const cls = typeof p.characterClass === "string" ? p.characterClass.trim() : "";
    const lvl = typeof p.level === "number" && Number.isFinite(p.level) ? p.level : null;
    const identityBits = [
      cn && `nom : ${cn}`,
      race && `race : ${race}`,
      cls && `classe : ${cls}`,
      lvl != null && lvl > 0 && `niveau : ${lvl}`,
    ].filter(Boolean);
    if (identityBits.length) parts.push(`Hero joueur (${identityBits.join(", ")})`);
    const d = typeof p.description === "string" ? p.description.trim() : "";
    const g = typeof p.visibleGear === "string" ? p.visibleGear.trim() : "";
    if (d) parts.push(`Apparence du hero : ${d}`);
    if (g) parts.push(`Equipement visible du hero : ${g}`);
  }
  const eventFocusTarget =
    o.eventFocusTarget && typeof o.eventFocusTarget === "object"
      ? /** @type {Record<string, unknown>} */ (o.eventFocusTarget)
      : null;
  if (eventFocusTarget) {
    const nm = typeof eventFocusTarget.name === "string" ? eventFocusTarget.name.trim() : "";
    const ap = typeof eventFocusTarget.appearance === "string" ? eventFocusTarget.appearance.trim() : "";
    const alive =
      typeof eventFocusTarget.isAlive === "boolean"
        ? eventFocusTarget.isAlive
          ? "vivant"
          : "vaincu ou mort"
        : "";
    const hpAfter =
      typeof eventFocusTarget.hpAfter === "number" && typeof eventFocusTarget.hpMax === "number"
        ? `${eventFocusTarget.hpAfter}/${eventFocusTarget.hpMax} PV`
        : "";
    const bits = [nm, ap, alive, hpAfter].filter(Boolean);
    if (bits.length) {
      parts.push(`Cible visuelle importante de l'evenement : ${bits.join(" ; ")}`);
    }
  }
  const npcs = Array.isArray(o.presentNPCs) ? o.presentNPCs : [];
  for (const n of npcs) {
    if (!n || typeof n !== "object") continue;
    const rec = /** @type {Record<string, unknown>} */ (n);
    const nm = typeof rec.name === "string" ? rec.name : "";
    const ap = typeof rec.appearance === "string" ? rec.appearance : "";
    if (nm || ap) parts.push(`${nm || "Personnage"} : ${ap}`);
  }
  return parts.join("\n\n");
}

/**
 * @param {unknown} visualContext
 * @param {string} apiKey
 * @returns {Promise<{ prompt: string; raw: string | null; usedSynth: boolean }>}
 */
async function synthesizeVisualPrompt(visualContext, apiKey) {
  const fallbackCore = fallbackPromptFromVisualContext(visualContext);
  const fallback = finalizeImagePrompt(fallbackCore, visualContext);
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: DEFAULT_GEMINI_SCENE_PROMPT_MODEL,
      systemInstruction: VISUAL_SYNTH_SYSTEM,
    });
    const payload =
      typeof visualContext === "object" && visualContext !== null
        ? JSON.stringify(visualContext, null, 2)
        : String(visualContext ?? "");
    const result = await model.generateContent(payload);
    const raw = (result.response.text() || "").trim();
    let prompt = raw.replace(/^["'`]+|["'`]+$/g, "").trim();
    if (prompt.length < 40) {
      return { prompt: fallback || finalizeImagePrompt(prompt, visualContext), raw, usedSynth: false };
    }
    return { prompt: finalizeImagePrompt(prompt, visualContext), raw, usedSynth: true };
  } catch (err) {
    console.warn("[scene-image] Synthèse prompt visuel échouée, fallback :", err?.message ?? err);
    return { prompt: fallback, raw: null, usedSynth: false };
  }
}

/**
 * Génère une image via l'API Gemini (generateContent + inlineData).
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const { prompt, model, visualContext } = body || {};

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY n'est pas configuré côté serveur." },
        { status: 500 }
      );
    }

    let imagePrompt = "";
    let synthRaw = /** @type {string | null} */ (null);
    let usedSynth = false;

    if (visualContext && typeof visualContext === "object") {
      const out = await synthesizeVisualPrompt(visualContext, apiKey);
      imagePrompt = out.prompt;
      synthRaw = out.raw;
      usedSynth = out.usedSynth;
    } else if (typeof prompt === "string" && prompt.trim()) {
      imagePrompt = prompt.trim();
    } else {
      return NextResponse.json(
        { error: "Fournis 'visualContext' (objet) ou 'prompt' (string)." },
        { status: 400 }
      );
    }

    if (!imagePrompt.trim()) {
      return NextResponse.json(
        { error: "Impossible de produire un prompt image (contexte vide)." },
        { status: 400 }
      );
    }

    const selectedModel = resolveModel(model);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent`;

    const controller = new AbortController();
    const timeoutMs = Number(process.env.IMAGE_GEN_TIMEOUT_MS ?? 120000);
    const t = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 120000);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: imagePrompt }],
          },
        ],
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(t));

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg =
        data?.error?.message ||
        data?.error?.status ||
        `Erreur API Gemini (${res.status})`;
      return NextResponse.json(
        { error: "Échec génération image Gemini.", details: msg },
        { status: res.status >= 400 ? res.status : 502 }
      );
    }

    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      const inline = part.inlineData || part.inline_data;
      if (inline?.data) {
        const mime = inline.mimeType || inline.mime_type || "image/png";
        const urlData = `data:${mime};base64,${inline.data}`;

        await logInteraction(
          "IMAGE_GEN",
          selectedModel,
          {
            visualContext: visualContext ?? null,
            promptSynthModel: DEFAULT_GEMINI_SCENE_PROMPT_MODEL,
            usedPromptSynthesizer: usedSynth,
            /** Prompt réellement envoyé au modèle image (après synthèse LLM ou fallback). */
            synthesizedImagePrompt: imagePrompt,
          },
          VISUAL_SYNTH_SYSTEM,
          synthRaw,
          {
            imageModel: selectedModel,
            synthesizedImagePrompt: imagePrompt,
            url:
              urlData.length > 512
                ? `${urlData.slice(0, 128)}… (tronqué, ${urlData.length} car.)`
                : urlData,
          }
        );

        return NextResponse.json({
          url: urlData,
          model: selectedModel,
          provider: "gemini",
          synthesizedImagePrompt: imagePrompt,
        });
      }
    }

    const blockReason = data?.promptFeedback?.blockReason;
    return NextResponse.json(
      {
        error: "Aucune image dans la réponse Gemini.",
        details: blockReason
          ? `Bloqué : ${blockReason}`
          : JSON.stringify(data?.candidates?.[0] ?? {}).slice(0, 500),
      },
      { status: 502 }
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: "Erreur lors de la génération d'image.",
        details: err?.message ?? String(err),
      },
      { status: 500 }
    );
  }
}
