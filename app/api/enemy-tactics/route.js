import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { logInteraction } from "@/lib/aiTraceLog";
import { withTerminalAiTiming } from "@/lib/aiTerminalTimingLog";

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
          targetId: typeof a?.targetId === "string" ? a.targetId : typeof a?.target === "string" ? a.target : "player",
          targetName: typeof a?.targetName === "string" ? a.targetName : "",
        }))
        .filter((a) => a.name && typeof a.targetId === "string"),
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
    text.includes("surpris (pas d'action au 1er round)") ||
    text.includes("surpris (pas d action au 1er round)") ||
    text.includes("état: surpris") ||
    text.includes("etat: surpris") ||
    text.includes("condition: surpris") ||
    text.includes("condition: surprise") ||
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
    '{ "thought_process": "court raisonnement tactique", "actions": [ { "type": "action|bonus_action|movement", "name": "nom exact de l arme/sort/capacité", "targetId": "id_cible", "targetName": "nom de la cible" } ] }',
    "",
    "Règles:",
    "- Utilise en priorité les noms exacts des armes, sorts ou capacités disponibles.",
    "- Tu peux renvoyer PLUSIEURS entrées dans actions, dans l'ordre logique du tour D&D 5e :",
    "  1) bonus_action avec name=\"Se désengager\" si tu veux fuir sans provoquer d'attaque d'opportunité (optionnel),",
    "  2) movement avec « S'approcher » si tu es à distance et veux engager une cible pour une attaque de mêlée,",
    "  3) action avec le nom exact de l'arme, du sort ou de la capacité offensive à utiliser (optionnel),",
    "  4) movement avec « S'éloigner » ou « Fuir » pour quitter le contact après l'attaque (le moteur appliquera l'ordre : désengagement → approche éventuelle → attaque → fuite).",
    "- Une action offensive principale maximum (type=action) pour l'attaque.",
    "- Le mouvement : « S'approcher » ou « S'éloigner » / « Fuir » selon le cas.",
    "- Tu reçois `players` : liste de TOUS les personnages joueurs / alliés encore dans le combat, chaque entrée a au minimum `id` (identifiant moteur EXACT), `name` (nom affiché), `hp`, `ac`, `distance` (melee|unknown), `isAlive`, et souvent `unconsciousAt0Hp` (true = à 0 PV, inconscient / jets de sauvegarde contre la mort, PAS mort définitif).",
    "- `isAlive` signifie « encore un combattant valide (pas mort définitif, pas déconnecté côté MJ) », y compris à 0 PV inconscient. Ne confonds pas avec « debout avec des PV ».",
    "- ANTI-FOCUS (priorité haute) : évite de cibler systématiquement le même PJ tour après tour si d'autres cibles valides existent.",
    "- Ne choisis PAS automatiquement la cible avec le moins de PV. La vulnérabilité (PV bas) n'est qu'un facteur parmi d'autres, pas une règle absolue.",
    "- Priorité tactique recommandée (ordre) : 1) cible légalement atteignable maintenant, 2) menace immédiate (au contact, lanceur dangereux, avantage tactique), 3) diversité de ciblage entre PJ, 4) vulnérabilité (PV/CA).",
    "- Diversité de ciblage : en cas d'options proches, alterne la cible entre les PJ au lieu de focus toujours le même nom.",
    "- Tu peux recevoir battleState.recentTargeting.lastOffensiveTargetId / lastOffensiveTargetName: c'est la cible offensive du tour précédent pour CET ennemi.",
    "- RÈGLE FORTE ANTI-FOCUS : si au moins 2 cibles valides (debout, atteignables) existent, n'attaque pas la même cible que battleState.recentTargeting.lastOffensiveTargetId deux tours d'affilée.",
    "- Exception unique à la règle anti-focus ci-dessus: n'autorise le même ciblage consécutif que si c'est la seule cible valide/atteignable maintenant.",
    "- Si un PJ est à 0 PV inconscient ET qu'au moins un autre PJ debout est attaquable, privilégie le PJ debout.",
    "- Ciblage à 0 PV : tant qu'il existe au moins un PJ ou allié **encore une menace utile** (debout, PV > 0, ou autre cible prioritaire selon la situation), attaque-le en priorité plutôt qu'un corps à terre.",
    "- Si **aucune** autre cible valide n'est disponible pour une action offensive (tous les adversaires au contact ou à portée sont à 0 PV, inconscients, ou tu ne peux atteindre personne d'autre), tu **peux et dois** cibler un PJ / allié à **0 PV** (inconscient) avec une attaque au corps à corps au contact si les règles D&D 5e le permettent (ex. coup de grâce à portée) — ne choisis pas « ne rien faire » par défaut dans ce cas.",
    "- Pour toute attaque ou sort ciblant un PJ ou un allié, `targetId` DOIT être l'un des `id` de cette liste (ex. \"player\", \"mp-player-abc123\", id d'entité alliée). Ne jamais inventer un id.",
    "- Tu reçois battleState.engagedWith : tableau des IDs des créatures actuellement à portée de mêlée avec cette ennemie (ex. [\"player\", \"mp-player-xyz\"]). C'est la source de vérité du contact.",
    "- Si ton tableau d'actions inclut des déplacements (movement) qui quittent le contact, prends en compte les attaques d'opportunité de l'adversaire au contact, sauf si tu as utilisé « Se désengager » (bonus_action ou action) avant.",
    "- battleState.playerCanOpportunityAttack (bool) indique si le joueur peut encore réagir avec une attaque d'opportunité (réaction disponible).",
    "- battleState.resources décrit les types de ressources de tour encore disponibles pour la créature (action, bonus_action, movement, reaction) : respecte l'ordre logique D&D.",
    "- battleState.actionCatalog liste les options autorisées et leur coût en ressources (mainActionOptions / bonusActionOptions / movementOptions). Priorité: respecte ce catalogue quand il est fourni.",
    "- N'utilise pas une action marquée available=false dans battleState.actionCatalog.",
    "- Si une action existe en version action et bonus_action (ex: Se désengager), préfère la version dont le coût est explicitement autorisé par battleState.actionCatalog.",
    "- Si battleState.inMelee est true, la créature est au contact d'au moins un combattant côté joueurs (voir engagedWith / players[].distance). Si false, elle est à distance et ne peut pas faire d'attaque de mêlée immédiate.",
    "- CONTRAINTE DURE (anti-erreur): n'émet JAMAIS une action avec une arme de mêlée (weapon.kind=\"melee\", ex. « Lame longue ») si la cible n'est pas dans battleState.engagedWith au moment de l'action.",
    "- Si battleState.engagedWith est vide (ou si targetId n'y figure pas), pour frapper avec une arme de mêlée tu dois d'abord inclure movement « S'approcher » vers cette cible dans le même tour; sinon choisis une attaque à distance (weapon.kind=\"ranged\", sort à portée) ou une action défensive.",
    "- Si aucune option ne permet une attaque légale ce tour (pas de contact, pas d'approche possible, pas d'arme à distance disponible), n'invente pas une attaque de mêlée: retourne uniquement movement/bonus_action défensif.",
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
    entityClass: enemy.entityClass ?? "",
    surprised: enemy.surprised === true,
    hp: enemy.hp ?? null,
    ac: enemy.ac ?? null,
    stats: enemy.stats ?? null,
    attackBonus: enemy.attackBonus ?? null,
    damageDice: enemy.damageDice ?? null,
    damageBonus: enemy.damageBonus ?? null,
    defaultAttack,
    weapons,
    selectedSpells: Array.isArray(enemy.selectedSpells) ? enemy.selectedSpells : [],
    spellAttackBonus:
      typeof enemy.spellAttackBonus === "number" ? enemy.spellAttackBonus : null,
    spellSaveDc:
      typeof enemy.spellSaveDc === "number" ? enemy.spellSaveDc : null,
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
      provider = "gemini",
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
      const raw = await withTerminalAiTiming(
        {
          routePath: "/api/enemy-tactics",
          agentLabel: "Tacticien ennemi (GM)",
          provider: "Gemini",
          model: GEMINI_MODEL,
        },
        async () => {
          const model = genAI.getGenerativeModel({
            model: GEMINI_MODEL,
            systemInstruction,
            generationConfig: { responseMimeType: "application/json" },
          });
          const result = await model.generateContent(JSON.stringify(userPayload));
          return result.response.text() || "";
        }
      );
      const parsed = parseTacticalResponse(raw);
      if (hasSurprisedNoActionMarker(enemy)) {
        parsed.actions = [];
      }
      await logInteraction("GM_TACTICIAN", "gemini", userPayload, systemInstruction, raw, parsed);
      return NextResponse.json(parsed);
    }

    const raw = await withTerminalAiTiming(
      {
        routePath: "/api/enemy-tactics",
        agentLabel: "Tacticien ennemi (GM)",
        provider: "OpenRouter",
        model: OPENROUTER_MODEL,
      },
      async () => {
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
        return data?.choices?.[0]?.message?.content ?? "";
      }
    );
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
