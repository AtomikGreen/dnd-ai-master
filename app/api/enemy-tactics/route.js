import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { logInteraction } from "@/lib/aiTraceLog";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "arcee-ai/trinity-large-preview:free";
const GEMINI_MODEL = "gemini-3-flash-preview";

function parseTacticalResponse(raw) {
  try {
    const parsed = JSON.parse(raw);
    const actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
    return {
      thought_process: typeof parsed?.thought_process === "string" ? parsed.thought_process : "",
      actions: actions
        .map((a) => ({
          type: typeof a?.type === "string" ? a.type : "action",
          name: typeof a?.name === "string" ? a.name : "",
          target: typeof a?.target === "string" ? a.target : "player",
        }))
        .filter((a) => a.name),
    };
  } catch {
    return {
      thought_process: "",
      actions: [],
    };
  }
}

function hasSurprisedNoActionMarker(enemy) {
  if (enemy?.surprised === true) return true;
  const features = Array.isArray(enemy?.features) ? enemy.features : [];
  const text = features
    .map((f) => String(f ?? "").toLowerCase())
    .join(" | ");
  if (!text) return false;
  return (
    text.includes("surpris") ||
    text.includes("surprise") ||
    text.includes("pas d'action au 1er round") ||
    text.includes("pas d action au 1er round") ||
    text.includes("no action first round")
  );
}

function buildEnemySystemPrompt() {
  return [
    "Tu es une IA tactique de combat pour D&D 5e.",
    "Tu contrôles UNE créature ennemie pendant SON tour.",
    "Réponds en JSON brut uniquement.",
    "",
    "Format obligatoire:",
    '{ "thought_process": "court raisonnement tactique", "actions": [ { "type": "action|bonus_action|movement", "name": "nom exact de l arme/capacité", "target": "id_cible" } ] }',
    "",
    "Règles:",
    "- Utilise en priorité les noms exacts des armes/capacités disponibles.",
    "- Tu peux renvoyer PLUSIEURS entrées dans actions, dans l'ordre logique du tour D&D 5e :",
    "  1) bonus_action avec name=\"Se désengager\" si tu veux fuir sans provoquer d'attaque d'opportunité (optionnel),",
    "  2) action avec le nom de l'arme/capacité pour attaquer (optionnel),",
    "  3) movement avec « S'approcher » si tu es à distance et dois entrer en mêlée avant une attaque au corps à corps,",
    "  4) movement avec « S'éloigner » ou « Fuir » pour quitter le contact après l'attaque (le moteur appliquera l'ordre : désengagement → attaque → fuite).",
    "- Une action offensive principale maximum (type=action) pour l'attaque.",
    "- Le mouvement : « S'approcher » ou « S'éloigner » / « Fuir » selon le cas.",
    "- Tu reçois battleState.engagedWith : tableau des IDs des créatures actuellement à portée de mêlée avec cette ennemie (ex. [\"player\"]).",
    "- Si ton tableau d'actions inclut des déplacements (movement) qui quittent le contact, prends en compte les attaques d'opportunité de l'adversaire au contact, sauf si tu as utilisé « Se désengager » (bonus_action ou action) avant.",
    "- battleState.playerCanOpportunityAttack (bool) indique si le joueur peut encore réagir avec une attaque d'opportunité (réaction disponible).",
    "- battleState.resources décrit les types de ressources de tour encore disponibles pour la créature (action, bonus_action, movement, reaction) : respecte l'ordre logique D&D.",
    "- Si battleState.inMelee est true, la créature est au contact du joueur. Si false, elle est à distance (engagedWith peut quand même lister d'autres IDs).",
    "- Si en mêlée et tu attaques puis fuis sans t'être désengagé : inclus l'attaque puis movement \"S'éloigner\" — le moteur appliquera l'ordre des actions et l'AoO si applicable.",
    "- Si en mêlée et tu veux fuir sans AoO : bonus_action \"Se désengager\" puis movement \"S'éloigner\".",
    "- Si aucune attaque pertinente n'est possible, propose movement ou bonus_action.",
    "- Si enemy.surprised === true, retourne actions: [].",
    "- Compatibilité: si enemy.features contient un marqueur de surprise (ex: \"Surpris (pas d'action au 1er round)\"), retourne aussi actions: [].",
    "- Ne raconte pas le résultat des dés.",
  ].join("\n");
}

/**
 * Snapshot ennemi riche pour la tactique (HP, CA, stats, armes, attaques par défaut).
 */
function buildEnrichedEnemyPayload(enemy) {
  if (!enemy || typeof enemy !== "object") return {};
  const weapons = Array.isArray(enemy.weapons) ? enemy.weapons : [];
  const defaultAttack =
    typeof enemy.attackBonus === "number" ||
    enemy.damageDice ||
    typeof enemy.damageBonus === "number"
      ? {
          attackBonus: enemy.attackBonus ?? null,
          damageDice: enemy.damageDice ?? null,
          damageBonus: enemy.damageBonus ?? null,
        }
      : null;
  return {
    id: enemy.id,
    name: enemy.name,
    type: enemy.type,
    surprised: enemy.surprised === true,
    hp: enemy.hp ?? null,
    ac: enemy.ac ?? null,
    stats: enemy.stats ?? null,
    attackBonus: enemy.attackBonus ?? null,
    damageDice: enemy.damageDice ?? null,
    damageBonus: enemy.damageBonus ?? null,
    defaultAttack,
    weapons,
    features: Array.isArray(enemy.features) ? enemy.features : [],
    description: typeof enemy.description === "string" ? enemy.description : "",
    visible: enemy.visible,
    isAlive: enemy.isAlive,
  };
}

export async function POST(request) {
  try {
    const body = await request.json();
    const {
      provider = "openrouter",
      enemy = null,
      players = [],
      battleState = {},
    } = body ?? {};

    const systemInstruction = buildEnemySystemPrompt();
    const enrichedEnemy = buildEnrichedEnemyPayload(enemy);
    const userPayload = {
      enemy: enrichedEnemy,
      players,
      battleState,
      instruction: "Décide le tour de cette créature et retourne le JSON demandé.",
    };

    if (provider === "gemini") {
      const model = genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        systemInstruction,
        generationConfig: { responseMimeType: "application/json" },
      });
      const result = await model.generateContent(JSON.stringify(userPayload));
      const raw = result.response.text() || "";
      const parsed = parseTacticalResponse(raw);
      if (hasSurprisedNoActionMarker(enemy)) {
        parsed.actions = [];
      }
      await logInteraction("GM_TACTICIAN", "gemini", userPayload, systemInstruction, raw, parsed);
      return NextResponse.json(parsed);
    }

    const res = await fetch(OPENROUTER_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "DnD Enemy Tactics",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `Erreur OpenRouter (${res.status})`);
    }

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content ?? "";
    const parsed = parseTacticalResponse(raw);
    if (hasSurprisedNoActionMarker(enemy)) {
      parsed.actions = [];
    }
    await logInteraction("GM_TACTICIAN", "openrouter", userPayload, systemInstruction, raw, parsed);
    return NextResponse.json(parsed);
  } catch (error) {
    return NextResponse.json(
      { error: "Enemy tactics generation failed", details: error?.message ?? String(error) },
      { status: 500 }
    );
  }
}
