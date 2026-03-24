import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import { logInteraction } from "@/lib/aiTraceLog";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "arcee-ai/trinity-large-preview:free";
const GEMINI_MODEL = "gemini-3-flash-preview";

const GM_ARBITER_SYSTEM = `Tu es un ARBITRE DE SCÈNE D&D (mécaniques uniquement).
Tu ne racontes rien. Tu produis uniquement du JSON valide en analysant les regles qu'on te fournis.

RÔLE (ORDRE DE LECTURE) :
1) Lis **currentRoomSecrets** : y a-t-il une règle mécanique explicite encore applicable (jet, conséquence, transition imposée par le texte) ?
2) Lis **mémoire_de_scène** : cette règle a-t-elle déjà été jouée / notée ? Si oui, ne la rejoue pas.
3) Lis **messages** et **sourceAction** uniquement pour le contexte (ex. piège déjà déclenché) — pas pour ré-inventer des déplacements.

IMPORTANT — OÙ EN EST LE JOUEUR :
- Le moteur a **déjà** appliqué l’entrée dans le lieu : **currentRoomId** est la salle où se trouve le PJ **maintenant**.
- **Tu ne gères pas la navigation** (aller / revenir / sortir) : c’est l’arbitre d’intention en amont. **Ne complète jamais** un déplacement avec sceneUpdate, ne « confirme » jamais un retour arrière, ne rajoute pas une transition parce que sourceAction parle de « revenir » ou « salle précédente ».

QUAND RIEN À FAIRE :
- Si les secrets ne prescrivent **aucune** mécanique à exécuter à l’instant (pas de jet demandé, pas de conséquence de lieu déclenchable), ou si tout ce qui était prescrit figure déjà dans la mémoire de scène : **resolution="no_roll_needed"**, rollRequest=null, entityUpdates=null, sceneUpdate=null, gameMode=null.
- Les suggestions optionnelles du MJ dans les secrets (« vous pouvez ajouter des rencontres… ») **ne sont pas** des ordres : ne spawne pas de créatures ni ne changes de salle sans règle mécanique claire et obligatoire.

SCENEUPDATE (TRÈS RESTREINT) :
- **sceneUpdate doit rester null** sauf si **currentRoomSecrets** impose **explicitement** une transition de lieu comme **conséquence mécanique** d’une règle du lieu (ex. texte du lieu qui dit de passer à une autre salle après un jet ou un événement). 
- **Interdit** : utiliser sceneUpdate pour simuler le joueur qui « revient », « sort », « avance » — c’est déjà réglé ailleurs. **Interdit** avec resolution "no_roll_needed" ou "request_roll" : sceneUpdate=null toujours.

OBJECTIF :
- Lire les règles du lieu (secrets) fournies dans le contexte, à chaque appel.
- Si un jet secret moteur est requis, demander ce jet.
- Une fois le résultat du jet fourni, décider les conséquences mécaniques.

FORMAT UNIQUE :
{
  "resolution": "no_roll_needed" | "request_roll" | "apply_consequences",
  "reason": "texte court",
  "rollRequest": null | {
    "kind": "gm_secret",
    "roll": "1d100",
    "reason": "..."
  } | {
    "kind": "player_check",
    "stat": "FOR"|"DEX"|"CON"|"INT"|"SAG"|"CHA",
    "skill": "Perception",
    "dc": 10,
    "reason": "...",
    "returnToArbiter": true
  },
  "entityUpdates": null | [
    { "action": "spawn"|"update"|"kill"|"remove", "id": "id", "templateId": "goblin", "type": "hostile", "visible": true, "lootItems": ["18 pa"] }
  ],
  "sceneUpdate": null | { "hasChanged": true, "targetRoomId": "room_intro" },
  "gameMode": null | "combat" | "exploration",
  "engineEvent": null | { "kind": "scene_rule_resolution", "details": "..." },
  "roomMemoryAppend": null | "phrase courte factuelle (mécanique) pour mémoriser cet événement dans cette salle"
}

RÈGLES :
- Le contexte inclut "mémoire_de_scène" : ce qui s'est déjà produit mécaniquement lors de visites précédentes dans **cette** salle (piège déclenché, embuscade jouée, etc.).
- Si cette mémoire couvre déjà un événement à usage unique décrit dans currentRoomSecrets (ex. piège déjà subi), ne redemande PAS de jet et ne réapplique PAS les mêmes dégâts/effets : resolution="no_roll_needed", rollRequest=null, entityUpdates=null, sceneUpdate=null. Tu peux omettre roomMemoryAppend.
- Lorsque tu appliques des conséquences **nouvelles** (apply_consequences), renvoie souvent roomMemoryAppend (une phrase) pour les prochains passages ; sinon le moteur utilisera "reason" comme secours.
- Sans résultat de jet et si les secrets exigent un jet : resolution="request_roll".
- IMPORTANT — deux types de jets :
  - Jet **MJ / secret** (ex: d100 embuscade) : rollRequest.kind="gm_secret", uniquement notation "XdY" (ex: "1d100"), sans bonus de personnage.
  - Jet **joueur** (ex: Perception DD 10 pour un piège, sauvegarde visible) : rollRequest.kind="player_check",
    stat + skill + dc + returnToArbiter=true. Le moteur fera lancer le d20 au joueur puis te renverra rollResult.
- Ne demande JAMAIS un "1d20+bonus" dans roll : le bonus est calculé par le moteur pour un player_check.
- Si rollResult est fourni : resolution="apply_consequences" (ou "no_roll_needed" si rien à faire).
- Tu ne détermines JAMAIS l'intention du joueur (déplacement, action, cible, etc.).
- Tu n'es PAS l'arbitre de navigation globale : l'entrée dans la salle est déjà décidée en amont.
- N'utilise sceneUpdate QUE si une règle explicite de currentRoomSecrets impose une transition comme conséquence mécanique (pas pour la navigation du joueur).
- Si aucune règle explicite n'impose d'action, renvoie "no_roll_needed" et sceneUpdate=null.
- Avec "no_roll_needed" ou "request_roll" : sceneUpdate=null **obligatoire** (le moteur gère déjà la carte).
- Si la liste "entities" fournie dans le contexte n'est pas vide, la salle a déjà un état de jeu (vivants, morts, cadavres).
  Tu ne dois PAS utiliser entityUpdates avec action "spawn" pour "réinitialiser" ou recréer une rencontre par défaut.
  Exception : currentRoomSecrets décrit explicitement l'arrivée d'une créature ou d'un événement qui ajoute quelque chose de nouveau.
- Ne décide jamais de narration.
- Ne renvoie jamais de texte hors JSON.`;

function truncate(s, n = 1000) {
  const str = typeof s === "string" ? s : String(s ?? "");
  return str.length > n ? str.slice(0, n) + "…" : str;
}

function normalizeMessagesForPrompt(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((m) => {
      if (!m || typeof m !== "object") return null;
      const role = m.role === "user" ? "user" : "assistant";
      const content = String(m.content ?? "").trim();
      if (!content) return null;
      return {
        role,
        type: m.type ?? null,
        content,
      };
    })
    .filter(Boolean);
}

const ABILITY_STATS = ["FOR", "DEX", "CON", "INT", "SAG", "CHA"];

/** Corrige les anciennes réponses LLM (ex: roll "1d20+2" pour Perception) → player_check. */
function normalizeGmArbiterRollRequest(rr, currentRoomSecrets) {
  if (!rr || typeof rr !== "object") return rr;
  if (rr.kind === "player_check") return rr;

  const roll = String(rr.roll ?? "").trim();
  const reason = String(rr.reason ?? "");
  const secrets = String(currentRoomSecrets ?? "");
  const pureXdY = /^(\d+)d(\d+)$/i.test(roll);

  if (rr.kind === "gm_secret" && pureXdY) {
    return {
      kind: "gm_secret",
      roll,
      reason:
        reason ||
        (rr.reason == null || rr.reason === "" ? "Jet secret MJ" : String(rr.reason).trim()),
      returnToArbiter: false,
    };
  }

  if (pureXdY) {
    return {
      kind: "gm_secret",
      roll,
      reason:
        reason ||
        (rr.reason == null || rr.reason === "" ? "Jet secret MJ" : String(rr.reason).trim()),
      returnToArbiter: false,
    };
  }

  const dcMatch =
    reason.match(/\bDD\s*(\d+)/i) ||
    reason.match(/\bDC\s*(\d+)/i) ||
    secrets.match(/\bDD\s*(\d+)/i) ||
    secrets.match(/\bDC\s*(\d+)/i);
  const dc = dcMatch ? Number(dcMatch[1]) : NaN;
  if (!Number.isFinite(dc)) {
    const baseRoll = roll.replace(/\s*[\+\-].*$/i, "").trim() || "1d100";
    if (/^(\d+)d(\d+)$/i.test(baseRoll)) {
      return {
        kind: "gm_secret",
        roll: baseRoll,
        reason: reason || "Jet MJ (normalisé)",
        returnToArbiter: false,
      };
    }
    return {
      kind: "gm_secret",
      roll: "1d100",
      reason: reason || "Jet MJ (secours)",
      returnToArbiter: false,
    };
  }

  let stat = "SAG";
  let skill = "Perception";
  if (/investigation/i.test(reason) || /investigation/i.test(secrets)) {
    stat = "INT";
    skill = "Investigation";
  } else if (/discr[eé]tion|furtivit[eé]|stealth/i.test(reason)) {
    stat = "DEX";
    skill = "Discrétion";
  } else if (/athl[eé]tisme/i.test(reason)) {
    stat = "FOR";
    skill = "Athlétisme";
  } else if (/acrobat/i.test(reason)) {
    stat = "DEX";
    skill = "Acrobaties";
  }

  return {
    kind: "player_check",
    stat,
    skill,
    dc,
    reason: reason || `Test (DD ${dc})`,
    returnToArbiter: true,
  };
}

function safeParseGmArbiterJson(raw) {
  const txt = String(raw ?? "").trim();
  if (!txt) return { ok: false, error: "Réponse vide." };
  try {
    const data = JSON.parse(txt);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "Objet JSON racine invalide." };
    }
    const resolution = String(data.resolution ?? "").trim();
    if (!["no_roll_needed", "request_roll", "apply_consequences"].includes(resolution)) {
      return { ok: false, error: "resolution invalide." };
    }
    let rollRequest = null;
    if (data.rollRequest != null) {
      if (typeof data.rollRequest !== "object" || Array.isArray(data.rollRequest)) {
        return { ok: false, error: "rollRequest invalide." };
      }
      const rawR = data.rollRequest;
      const kindIn = String(rawR.kind ?? "").trim();

      if (kindIn === "player_check") {
        const stat = String(rawR.stat ?? "").trim().toUpperCase();
        if (!ABILITY_STATS.includes(stat)) {
          return { ok: false, error: "rollRequest.stat invalide (player_check)." };
        }
        const dc = Number(rawR.dc);
        if (!Number.isFinite(dc)) {
          return { ok: false, error: "rollRequest.dc invalide (player_check)." };
        }
        rollRequest = {
          kind: "player_check",
          stat,
          skill: rawR.skill == null ? null : String(rawR.skill).trim(),
          dc,
          reason:
            rawR.reason == null || rawR.reason === ""
              ? `Test (${stat})`
              : String(rawR.reason).trim(),
          returnToArbiter: true,
        };
      } else {
        const roll = String(rawR.roll ?? "").trim();
        if (!roll) return { ok: false, error: "rollRequest.roll manquant (gm_secret)." };
        rollRequest = {
          kind: "gm_secret",
          roll,
          reason:
            rawR.reason == null || rawR.reason === ""
              ? "Jet secret MJ"
              : String(rawR.reason).trim(),
          returnToArbiter: false,
        };
      }
    }

    const entityUpdates = Array.isArray(data.entityUpdates) ? data.entityUpdates : null;
    let sceneUpdate = null;
    if (data.sceneUpdate != null) {
      if (typeof data.sceneUpdate !== "object" || Array.isArray(data.sceneUpdate)) {
        return { ok: false, error: "sceneUpdate invalide." };
      }
      const tid = String(data.sceneUpdate.targetRoomId ?? "").trim();
      if (!data.sceneUpdate.hasChanged || !tid) {
        return { ok: false, error: "sceneUpdate incomplet." };
      }
      sceneUpdate = { hasChanged: true, targetRoomId: tid };
    }

    let gameMode = null;
    if (data.gameMode != null) {
      const gm = String(data.gameMode).trim();
      if (!["combat", "exploration"].includes(gm)) {
        return { ok: false, error: "gameMode invalide." };
      }
      gameMode = gm;
    }

    const engineEvent =
      data.engineEvent && typeof data.engineEvent === "object" && !Array.isArray(data.engineEvent)
        ? data.engineEvent
        : null;

    let roomMemoryAppend = null;
    if (data.roomMemoryAppend != null && String(data.roomMemoryAppend).trim()) {
      const s = String(data.roomMemoryAppend).trim().slice(0, 400);
      if (s) roomMemoryAppend = s;
    }

    return {
      ok: true,
      parsed: {
        resolution,
        reason: String(data.reason ?? "").trim(),
        rollRequest,
        entityUpdates,
        sceneUpdate,
        gameMode,
        engineEvent,
        roomMemoryAppend,
      },
    };
  } catch {
    return { ok: false, error: "JSON invalide." };
  }
}

function buildDeterministicFallback({ currentRoomId, currentRoomSecrets, rollResult }) {
  const secrets = String(currentRoomSecrets ?? "");
  if (currentRoomId !== "scene_journey" || !/embuscade/i.test(secrets)) return null;

  const hasRoll = rollResult && typeof rollResult.total === "number";
  if (!hasRoll) {
    return {
      resolution: "request_roll",
      reason: "Règle d'embuscade du lieu.",
      rollRequest: {
        kind: "gm_secret",
        roll: "1d100",
        reason: "Déterminer si l'embuscade a lieu",
        returnToArbiter: false,
      },
      entityUpdates: null,
      sceneUpdate: null,
      gameMode: null,
      engineEvent: null,
    };
  }

  const total = Number(rollResult.total);
  if (total <= 80) {
    const spawnCount = total <= 64 ? 3 : 2; // approx 80% => 3 gobelins
    const updates = Array.from({ length: spawnCount }).map((_, i) => ({
      action: "spawn",
      id: `goblin_ambush_${i + 1}`,
      templateId: "goblin",
      type: "hostile",
      visible: true,
      lootItems: ["18 pa"],
    }));
    return {
      resolution: "apply_consequences",
      reason: "Embuscade déclenchée.",
      rollRequest: null,
      entityUpdates: updates,
      sceneUpdate: null,
      gameMode: "combat",
      engineEvent: {
        kind: "scene_rule_resolution",
        details: "Embuscade gobeline déclenchée.",
      },
    };
  }

  return {
    resolution: "apply_consequences",
    reason: "Pas d'embuscade, progression vers l'entrée.",
    rollRequest: null,
    entityUpdates: null,
    sceneUpdate: { hasChanged: true, targetRoomId: "room_intro" },
    gameMode: "exploration",
    engineEvent: {
      kind: "scene_rule_resolution",
      details: "Pas d'embuscade.",
    },
  };
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      provider = "openrouter",
      currentRoomId = "",
      currentRoomTitle = "",
      currentScene = "",
      currentRoomSecrets = "",
      allowedExits = [],
      entities = [],
      player = null,
      rollResult = null,
      sourceAction = "",
      messages = [],
      roomMemory = "",
    } = body;
    const normalizedMessages = normalizeMessagesForPrompt(messages);
    const roomMemoryBlock = String(roomMemory ?? "").trim();

    const userContent = [
      `currentRoomId: ${String(currentRoomId ?? "").trim() || "(inconnu)"}`,
      `currentRoomTitle: ${String(currentRoomTitle ?? "").trim() || "(inconnu)"}`,
      `currentScene: ${String(currentScene ?? "").trim() || "(inconnue)"}`,
      `mémoire_de_scène (événements déjà résolus ici — ne pas rejouer les mêmes mécaniques) : ${
        roomMemoryBlock || "(aucune — première visite ou rien de noté)"
      }`,
      `currentRoomSecrets: ${String(currentRoomSecrets ?? "").trim() || "(aucun)"}`,
      `allowedExits: ${JSON.stringify(Array.isArray(allowedExits) ? allowedExits : [])}`,
      `entities: ${JSON.stringify(Array.isArray(entities) ? entities : [])}`,
      `player: ${JSON.stringify(player ?? null)}`,
      `sourceAction: ${String(sourceAction ?? "").trim() || "(aucune)"}`,
      `rollResult: ${JSON.stringify(rollResult ?? null)}`,
      `messages (ordered): ${JSON.stringify(normalizedMessages)}`,
      "Réponds avec un seul objet JSON conforme.",
    ].join("\n");

    let rawOut = "";
    if (provider === "gemini") {
      if (!process.env.GEMINI_API_KEY) {
        return NextResponse.json({ error: "GEMINI_API_KEY manquant." }, { status: 500 });
      }
      const model = genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        systemInstruction: GM_ARBITER_SYSTEM,
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      });
      const result = await model.generateContent(userContent);
      rawOut = (result.response.text() || "").trim();
    } else {
      if (!process.env.OPENROUTER_API_KEY) {
        return NextResponse.json({ error: "OPENROUTER_API_KEY manquant." }, { status: 500 });
      }
      const res = await fetch(OPENROUTER_BASE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "DnD AI Scene Arbiter",
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: [
            { role: "system", content: GM_ARBITER_SYSTEM },
            { role: "user", content: userContent },
          ],
          temperature: 0.2,
          response_format: { type: "json_object" },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message ?? `Erreur OpenRouter (${res.status})`);
      }
      const data = await res.json();
      rawOut =
        typeof data?.choices?.[0]?.message?.content === "string"
          ? data.choices[0].message.content.trim()
          : "";
    }

    let parsed = safeParseGmArbiterJson(rawOut);
    if (!parsed.ok) {
      const fb = buildDeterministicFallback({
        currentRoomId,
        currentRoomSecrets,
        rollResult,
      });
      if (fb) parsed = { ok: true, parsed: fb };
    }

    if (parsed.ok) sanitizeGmArbiterParsed(parsed.parsed);

    if (parsed.ok && parsed.parsed?.resolution === "request_roll" && parsed.parsed.rollRequest) {
      parsed.parsed.rollRequest = normalizeGmArbiterRollRequest(
        parsed.parsed.rollRequest,
        currentRoomSecrets
      );
    }

    await logInteraction(
      "GM_ARBITER",
      provider === "gemini" ? "gemini" : "openrouter",
      {
        currentRoomId,
        currentRoomTitle,
        currentScene: String(currentScene ?? ""),
        currentRoomSecrets: String(currentRoomSecrets ?? ""),
        sourceAction: String(sourceAction ?? ""),
        allowedExits: Array.isArray(allowedExits) ? allowedExits : [],
        entities: Array.isArray(entities) ? entities : [],
        player,
        messages: normalizedMessages,
        rollResult,
        roomMemory: roomMemoryBlock,
        userContent,
        systemInstruction: GM_ARBITER_SYSTEM,
      },
      GM_ARBITER_SYSTEM,
      rawOut,
      parsed.ok ? parsed.parsed : { error: parsed.error, raw: truncate(rawOut, 800) }
    );

    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error, raw: truncate(rawOut, 2000) }, { status: 422 });
    }

    return NextResponse.json(parsed.parsed);
  } catch (error) {
    return NextResponse.json(
      {
        error: "Erreur lors de l'arbitrage de scène.",
        details: String(error?.message ?? error),
      },
      { status: 500 }
    );
  }
}

