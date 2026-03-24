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
  "Tu es un ingénieur de prompt pour Stable Diffusion expert en D&D. Ton but est de synthétiser les informations contextuelles fournies (Lieu, Personnages, Équipement, Action) en un prompt visuel unique, détaillé et cohérent.",
  "",
  "CONSIGNES :",
  "",
  "- Pour le héros joueur (objet playerInfo), utilise impérativement characterName, race, characterClass et level s'ils sont présents, en plus de description et visibleGear.",
  "- GÉOGRAPHIE : la ligne ou champ « location » / Environment décrit le décor et la direction du voyage (collines boisées, sentier vers l'ouest, montagne, etc.). C'est LA référence pour le paysage et la destination visuelle.",
  "- narrativeFocus peut résumer des événements passés (forge, village, PNJ) pour l'ambiance — ne les utilise PAS pour inventer des personnages dans l'image ni pour montrer « marche vers le village » si location parle d'un trajet en nature sauvage / collines.",
  "- PERSONNAGES : si presentNPCs est vide ou [], le cadre ne contient qu'UN seul humanoïde : le héros joueur. Aucun compagnon, aucun soldat générique, aucun PNJ non listé.",
  "- Si presentNPCs contient des entrées, seuls le héros + ces PNJ peuvent apparaître — pas d'extras.",
  "- Décris les personnages physiques en utilisant leurs descriptions fournies (race, barbe, vêtements, tablier).",
  "- Inclue l'équipement visible (cotte de mailles, hache, etc.).",
  "- Décris l'environnement et l'éclairage (cinématique, dark fantasy).",
  "- Utilise des mots-clés de style (digital painting, concept art, hyperdetailed).",
  "- Reste fidèle à la scène D&D. Ne génère que le prompt final, sans texte introductif.",
].join("\n");

const IMAGE_PROMPT_STYLE_SUFFIX =
  "dark fantasy RPG illustration, Dungeons and Dragons scene, cinematic lighting, digital painting, concept art, hyperdetailed, high quality";

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
      "CRITICAL — COMPOSITION: Exactly ONE humanoid in frame: the player hero (Hero appearance / gear). No adventuring party, no three companions, no generic soldiers, no crowd. presentNPCs is empty: do NOT paint forge NPCs, villagers, escorts, or anyone else from story text."
    );
  } else {
    guards.push(
      `CRITICAL — COMPOSITION: Only the player hero plus the ${npcs.length} NPC(s) listed in presentNPCs may appear. No extra unnamed companions.`
    );
  }
  guards.push(
    "CRITICAL — SETTING: The Environment / location field defines visible terrain and direction of travel (e.g. forested western hills, wilderness trail toward mountains). Long narrative text may mention a village or forge for backstory only — do NOT show marching toward a welcoming village as the main goal if location describes travel into wild hills/forest away from settlement. A village may appear small and distant in the background only when the story is leaving it."
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
  if (name) parts.push(`Scene title: ${name}.`);
  if (loc) parts.push(`Environment: ${loc}`);
  const focus = typeof o.narrativeFocus === "string" ? o.narrativeFocus.trim() : "";
  if (focus) {
    parts.push(
      `Story mood and recent beats (atmosphere only; do NOT add characters from this text unless they appear in presentNPCs; do NOT override Environment for destination): ${focus}`
    );
  }
  const pi = o.playerInfo;
  if (pi && typeof pi === "object") {
    const p = /** @type {Record<string, unknown>} */ (pi);
    const cn = typeof p.characterName === "string" ? p.characterName.trim() : "";
    const race = typeof p.race === "string" ? p.race.trim() : "";
    const cls = typeof p.characterClass === "string" ? p.characterClass.trim() : "";
    const lvl = typeof p.level === "number" && Number.isFinite(p.level) ? p.level : null;
    const identityBits = [
      cn && `name: ${cn}`,
      race && `race: ${race}`,
      cls && `class: ${cls}`,
      lvl != null && lvl > 0 && `level: ${lvl}`,
    ].filter(Boolean);
    if (identityBits.length) parts.push(`Player hero (${identityBits.join(", ")})`);
    const d = typeof p.description === "string" ? p.description.trim() : "";
    const g = typeof p.visibleGear === "string" ? p.visibleGear.trim() : "";
    if (d) parts.push(`Hero appearance: ${d}`);
    if (g) parts.push(`Hero visible gear: ${g}`);
  }
  const npcs = Array.isArray(o.presentNPCs) ? o.presentNPCs : [];
  for (const n of npcs) {
    if (!n || typeof n !== "object") continue;
    const rec = /** @type {Record<string, unknown>} */ (n);
    const nm = typeof rec.name === "string" ? rec.name : "";
    const ap = typeof rec.appearance === "string" ? rec.appearance : "";
    if (nm || ap) parts.push(`${nm || "Character"}: ${ap}`);
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
    });

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
