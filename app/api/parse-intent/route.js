/**
 * Agent Arbitre universel : combat + exploration, sans narration.
 * POST {
 *   text, gameMode, currentScene, currentRoomId, currentRoomSecrets?,
 *   allowedExits?, entities, playerWeapons, playerMeleeTargets?, turnResources?, provider?
 * }
 * Réponses resolution incl. "unclear_input" (message joueur inutilisable / hors cadre).
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import { logInteraction } from "@/lib/aiTraceLog";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "arcee-ai/trinity-large-preview:free";
const GEMINI_MODEL = "gemini-3-flash-preview";

const ARBITER_SYSTEM = `Tu es l'ARBITRE logique d'un jeu D&D 5e. Tu ne racontes rien. Tu ne produis QUE du JSON.

MISSION :
- En COMBAT : traduire le texte du joueur en intention tactique structurée.
- En EXPLORATION : décider si l'action est triviale, impossible, ou nécessite un jet.
- Tu ne renvoies JAMAIS de narration.

FORMAT DE SORTIE UNIQUE :
{
  "resolution": "combat_intent" | "requires_roll" | "trivial_success" | "impossible" | "unclear_input",
  "reason": "texte court",
  "intent": null | { "type": "move"|"attack"|"move_and_attack"|"disengage"|"spell"|"dodge"|"second_wind"|"end_turn"|"loot", "targetId": "", "weapon": "" },
  "rollRequest": null | { "kind": "check"|"save"|"attack"|"gm_secret", "stat": "FOR"|"DEX"|"CON"|"INT"|"SAG"|"CHA", "skill": "Athlétisme", "dc": <nombre>, "raison": "...", "roll": "1d100" },
  "sceneUpdate": null | { "hasChanged": true, "targetRoomId": "..." }
}

IMPORTANT :
- Tu ne décides JAMAIS du mode combat/exploration : c'est déjà déterminé par le moteur.
- Tu utilises seulement MODE (fourni dans l'entrée) pour choisir les règles d'interprétation.

RÈGLE SPÉCIALE — TEXTE INUTILISABLE :
- Si le message du joueur est vide de sens en jeu, trop flou pour en déduire une action, incohérent avec la scène, manifestement hors personnage / hors cadre (métajeu abusif, spam, charabia, sujet réel hors aventure), ou absurde au point qu'aucune intention D&D raisonnable ne peut être extraite :
  → resolution="unclear_input", intent=null, rollRequest=null, sceneUpdate=null.
- Ne confonds pas avec une action risquée mais claire : dans ce cas utilise requires_roll ou impossible selon le cas.
- Ne confonds pas avec une formulation maladroite mais compréhensible : dans ce cas interprète l'action.

RÈGLES EXPLORATION :
- Action triviale ou sans conséquence : resolution="trivial_success", rollRequest=null.
- Action impossible : resolution="impossible", rollRequest=null.
- Action incertaine AVEC conséquence : resolution="requires_roll" et rollRequest obligatoire.
- Si l'action est incertaine SANS conséquence (pas de risque, pas de pression temporelle, simple répétition possible), utilise "trivial_success" (pas de jet).
- Détermination du DC (échelle D&D 5e) :
  - 5 très facile
  - 10 facile
  - 15 moyenne
  - 20 difficile
  - 25 très difficile
  - 30 presque impossible
- Tu dois determiner le DC en fonction de la difficulté de l'action et des informations fournies dans le contexte.
- Si une regle du contexte indique un DC explicite pour une action, ce DC est prioritaire.
- En exploration, intent DOIT être null, SAUF pour les capacités de classe explicitement déclarées par le joueur (ex: "Second souffle") : dans ce cas, renvoie resolution="combat_intent" avec intent.type="second_wind".
- Si le joueur veut fouiller/piller des corps (loot), utilise "trivial_success" (sans jet, intent=null, sceneUpdate=null).
- Si le joueur exprime explicitement un déplacement/entrée/transition vers un lieu autorisé, utilise resolution="trivial_success" et sceneUpdate avec targetRoomId.
- Pour les déplacements, utilise en priorité "Sorties autorisées" (id, direction, description du chemin).
- Si le joueur mentionne une direction (nord/sud/est/ouest...) correspondant à une sortie autorisée, fais sceneUpdate vers cette sortie.
- Si le joueur décrit un chemin correspondant à la description d'une sortie autorisée, choisis cette sortie.
- N'invente jamais une sortie non listée.
- Cas spécial entrée de lieu ([SceneEntered] dans le texte) :
  - Lis currentRoomSecrets et applique la règle du lieu.
  - Si un jet caché MJ est requis (ex: d100 embuscade), utilise resolution="requires_roll" avec rollRequest.kind="gm_secret", rollRequest.roll (ex: "1d100"), raison explicite, et rollRequest.stat="SAG" (placeholder technique).
  - Sinon, utilise "trivial_success".

RÈGLES COMBAT :
- Types autorisés : move, attack, move_and_attack, disengage, spell, dodge, second_wind, end_turn, loot.
- Utilise playerMeleeTargets pour distinguer attack vs move_and_attack.
- Si le joueur attaque une cible déjà au contact avec une arme de mêlée : attack.
- Si le joueur doit se rapprocher pour frapper au corps à corps : move_and_attack.
- Pour disengage/dodge/end_turn/second_wind, targetId peut être "".
- En combat, rollRequest doit être null et sceneUpdate doit être null.

RÈGLES DE FIABILITÉ :
- actionIntent n'existe PAS : utilise intent.
- N'utilise JAMAIS une string à la place d'un objet.
- N'utilise JAMAIS les clés action, ability, difficultyClass à la place de type, stat, dc.
- Réponds par un seul objet JSON valide, sans markdown, sans narration.`;

function truncate(s, n = 800) {
  const str = typeof s === "string" ? s : String(s ?? "");
  return str.length > n ? str.slice(0, n) + "…" : str;
}

function normalizeWeaponList(playerWeapons) {
  if (!Array.isArray(playerWeapons)) return [];
  return playerWeapons
    .map((w) => (typeof w === "string" ? w.trim() : String(w?.name ?? "").trim()))
    .filter(Boolean);
}

function normalizeEntitiesForPrompt(entities) {
  if (!Array.isArray(entities)) return [];
  return entities
    .filter((e) => e && e.id != null && String(e.id).trim() !== "")
    .map((e) => ({
      id: String(e.id).trim(),
      name: String(e.name ?? e.id).trim(),
      type: String(e.type ?? "").trim() || null,
      visible: e.visible !== false,
      isAlive: e.isAlive !== false,
    }));
}

function normalizeMeleeTargetIds(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => String(id ?? "").trim()).filter(Boolean);
}

function normalizeAllowedExits(exits) {
  if (!Array.isArray(exits)) return [];
  return exits
    .map((e) => {
      if (typeof e === "string" && e.trim()) {
        return { id: e.trim(), title: e.trim(), description: "", direction: "" };
      }
      return e;
    })
    .filter((e) => e && typeof e === "object" && String(e.id ?? "").trim())
    .map((e) => ({
      id: String(e.id).trim(),
      title: String(e.title ?? e.id).trim(),
      description: String(e.description ?? "").trim(),
      direction: String(e.direction ?? "").trim(),
    }));
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

function buildUserContent({
  text,
  gameMode,
  currentScene,
  currentRoomId,
  currentRoomSecrets,
  allowedExits,
  entities,
  weaponNames,
  meleeTargetIds,
  turnResources,
  messages,
}) {
  const entBlock =
    entities.length === 0
      ? "(Aucune entité fournie.)"
      : entities
          .map(
            (e) =>
              `- id: "${e.id}", name: "${e.name}", type: "${e.type ?? ""}", visible: ${e.visible}, isAlive: ${e.isAlive}`
          )
          .join("\n");
  const wBlock =
    weaponNames.length === 0
      ? "(Aucune liste fournie.)"
      : weaponNames.map((n) => `- ${n}`).join("\n");
  const meleeBlock =
    meleeTargetIds.length === 0
      ? "(Aucun ennemi au contact.)"
      : meleeTargetIds.map((id) => `- "${id}"`).join("\n");
  const exitsBlock =
    allowedExits.length === 0
      ? "(Aucune sortie autorisée fournie.)"
      : allowedExits
          .map(
            (e) =>
              `- id: "${e.id}", direction: "${e.direction || "(non précisée)"}", description: "${e.description || "(non précisée)"}"`
          )
          .join("\n");
  const tr = turnResources && typeof turnResources === "object" ? turnResources : null;
  const trBlock = tr
    ? `turnResources: action=${!!tr.action}, bonus=${!!tr.bonus}, reaction=${!!tr.reaction}, movement=${!!tr.movement}`
    : `turnResources: non fournis`;
  const historyBlock =
    messages.length === 0
      ? "(Aucun historique fourni.)"
      : messages
          .map((m) => `- ${m.role}${m.type ? ` [${m.type}]` : ""}: ${m.content}`)
          .join("\n");

  return [
    `MODE: ${gameMode === "combat" ? "combat" : "exploration"}`,
    `currentRoomId: ${String(currentRoomId ?? "").trim() || "(inconnu)"}`,
    `currentScene: ${String(currentScene ?? "").trim() || "(inconnue)"}`,
    `currentRoomSecrets: ${String(currentRoomSecrets ?? "").trim() || "(aucun)"}`,
    trBlock,
    ``,
    `Texte joueur :`,
    `"""`,
    String(text ?? "").trim(),
    `"""`,
    ``,
    `Historique chat ordonné (du plus ancien au plus récent) :`,
    historyBlock,
    ``,
    `Entités :`,
    entBlock,
    ``,
    `playerMeleeTargets :`,
    meleeBlock,
    ``,
    `Armes / sorts connus côté joueur :`,
    wBlock,
    ``,
    `Sorties autorisées :`,
    exitsBlock,
    ``,
    `Réponds par un seul objet JSON valide au format imposé.`,
  ].join("\n");
}

function safeParseArbiterJson(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { ok: false, error: "Réponse vide." };
  try {
    const data = JSON.parse(trimmed);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "Objet JSON racine invalide." };
    }
    const resolution = String(data.resolution ?? "").trim();
    const allowedResolutions = new Set([
      "combat_intent",
      "requires_roll",
      "trivial_success",
      "impossible",
      "unclear_input",
    ]);
    if (!allowedResolutions.has(resolution)) {
      return { ok: false, error: `resolution invalide: ${resolution || "(vide)"}` };
    }

    if (resolution === "unclear_input") {
      return {
        ok: true,
        parsed: {
          resolution: "unclear_input",
          reason:
            data.reason == null || data.reason === "" ? "" : String(data.reason).trim(),
          intent: null,
          rollRequest: null,
          sceneUpdate: null,
        },
      };
    }

    let intent = null;
    if (data.intent != null) {
      if (typeof data.intent !== "object" || Array.isArray(data.intent)) {
        return { ok: false, error: "intent doit être null ou un objet." };
      }
      const type = String(data.intent.type ?? "").trim();
      const allowedTypes = new Set([
        "move",
        "attack",
        "move_and_attack",
        "disengage",
        "spell",
        "dodge",
        "second_wind",
        "end_turn",
        "loot",
      ]);
      if (!allowedTypes.has(type)) {
        return { ok: false, error: `intent.type invalide: ${type || "(vide)"}` };
      }
      intent = {
        type,
        targetId: data.intent.targetId == null ? "" : String(data.intent.targetId).trim(),
        weapon: data.intent.weapon == null ? "" : String(data.intent.weapon).trim(),
      };
    }

    let rollRequest = null;
    if (data.rollRequest != null) {
      if (typeof data.rollRequest !== "object" || Array.isArray(data.rollRequest)) {
        return { ok: false, error: "rollRequest doit être null ou un objet." };
      }
      const kindRoll = String(data.rollRequest.kind ?? "").trim();
      if (!["check", "save", "attack", "gm_secret"].includes(kindRoll)) {
        return { ok: false, error: `rollRequest.kind invalide: ${kindRoll || "(vide)"}` };
      }
      const stat = String(data.rollRequest.stat ?? "").trim();
      const dc = data.rollRequest.dc;
      if (kindRoll === "gm_secret") {
        const rollNotation =
          data.rollRequest.roll == null || data.rollRequest.roll === ""
            ? "1d20"
            : String(data.rollRequest.roll).trim();
        rollRequest = {
          kind: kindRoll,
          stat: stat || "SAG",
          skill: null,
          dc: 0,
          raison:
            data.rollRequest.raison == null || data.rollRequest.raison === ""
              ? "Jet secret MJ"
              : String(data.rollRequest.raison).trim(),
          roll: rollNotation,
        };
      } else {
        if (!stat || typeof dc !== "number" || !Number.isFinite(dc)) {
          return { ok: false, error: "rollRequest incomplet (stat/dc requis)." };
        }
        rollRequest = {
          kind: kindRoll,
          stat,
          skill:
            data.rollRequest.skill == null || data.rollRequest.skill === ""
              ? null
              : String(data.rollRequest.skill).trim(),
          dc,
          raison:
            data.rollRequest.raison == null || data.rollRequest.raison === ""
              ? "Action incertaine"
              : String(data.rollRequest.raison).trim(),
        };
      }
    }

    let sceneUpdate = null;
    if (data.sceneUpdate != null) {
      if (typeof data.sceneUpdate !== "object" || Array.isArray(data.sceneUpdate)) {
        return { ok: false, error: "sceneUpdate doit être null ou un objet." };
      }
      const tid = String(data.sceneUpdate.targetRoomId ?? "").trim();
      if (!data.sceneUpdate.hasChanged || !tid) {
        return { ok: false, error: "sceneUpdate invalide (hasChanged/targetRoomId requis)." };
      }
      sceneUpdate = { hasChanged: true, targetRoomId: tid };
    }

    return {
      ok: true,
      parsed: {
        resolution,
        reason:
          data.reason == null || data.reason === "" ? "" : String(data.reason).trim(),
        intent,
        rollRequest,
        sceneUpdate,
      },
    };
  } catch {
    return { ok: false, error: "JSON invalide." };
  }
}

function tryExtractDcFromSecrets(secrets, regex) {
  const text = String(secrets ?? "");
  if (!text) return null;
  const match = text.match(regex);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function buildDeterministicFallback({
  text,
  gameMode,
  currentRoomSecrets,
  allowedExits,
}) {
  const normalizeLoose = (s) =>
    String(s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  const pickExitFromText = (rawText, exits) => {
    const t = normalizeLoose(rawText);
    if (!t || !Array.isArray(exits) || exits.length === 0) return null;

    // 1) mention explicite de l'id
    for (const ex of exits) {
      const id = String(ex?.id ?? "").trim();
      if (!id) continue;
      const idEscaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${idEscaped}\\b`, "i").test(rawText)) return ex;
    }

    // 2) mention explicite d'une direction
    const byDirection = exits.filter((ex) => {
      const dir = normalizeLoose(ex?.direction ?? "");
      return dir && new RegExp(`\\b${dir}\\b`, "i").test(t);
    });
    if (byDirection.length === 1) return byDirection[0];

    // 3) heuristique simple sur la description du chemin
    const byDescription = exits.filter((ex) => {
      const d = normalizeLoose(ex?.description ?? "");
      if (!d) return false;
      if (d.includes("porte") && /\bporte\b/i.test(t)) return true;
      if (
        (d.includes("couloir") || d.includes("galerie") || d.includes("passage")) &&
        /\b(couloir|galerie|passage)\b/i.test(t)
      ) {
        return true;
      }
      if ((d.includes("ombre") || d.includes("penombre")) && /\b(ombre|penombre)\b/i.test(t)) {
        return true;
      }
      return false;
    });
    if (byDescription.length === 1) return byDescription[0];

    return null;
  };

  const raw = String(text ?? "").trim();
  if (!raw) return null;

  // Capacités de classe : doivent toujours devenir une intention mécanique explicite.
  if (/(second\s+souffle|second\s+wind)/i.test(raw)) {
    return {
      resolution: "combat_intent",
      reason: "Second souffle explicite",
      intent: { type: "second_wind", targetId: "", weapon: "Second souffle" },
      rollRequest: null,
      sceneUpdate: null,
    };
  }

  if (gameMode === "combat") {
    const lower = raw.toLowerCase();
    if (/(fin\s+de\s+mon\s+tour|je\s+passe(?:r)?\s+mon\s+tour|j['’]attends)/i.test(lower)) {
      return {
        resolution: "combat_intent",
        reason: "Fin de tour explicite",
        intent: { type: "end_turn", targetId: "", weapon: "" },
        rollRequest: null,
        sceneUpdate: null,
      };
    }
    return null;
  }

  if (/(entre|j['’]?entre|je\s+rentre|je\s+passe\s+la\s+porte|je\s+pénètre|je\s+vais\s+dans|je\s+vais\s+vers|je\s+me\s+dirige|je\s+prends|je\s+m['’]?engage|je\s+continue|je\s+pars\s+vers)/i.test(raw)) {
    const selectedExit = pickExitFromText(raw, allowedExits) || allowedExits[0] || null;
    if (selectedExit?.id) {
      return {
        resolution: "trivial_success",
        reason: "Déplacement explicite vers une sortie autorisée",
        intent: null,
        rollRequest: null,
        sceneUpdate: { hasChanged: true, targetRoomId: selectedExit.id },
      };
    }
  }

  if (/(loot|looter|piller|pillage|fouiller|fouille|depouille|dépouille|ramasser|récupérer|recuperer|prendre sur le corps)/i.test(raw)) {
    return {
      resolution: "trivial_success",
      reason: "Fouille/pillage de corps",
      intent: null,
      rollRequest: null,
      sceneUpdate: null,
    };
  }

  if (/(enfonc|défonc|forcer?).*(porte)|porte.*(enfonc|défonc|forcer?)|coup d['’]épaule|coup de tête|avec ma tête/i.test(raw)) {
    const dc = tryExtractDcFromSecrets(currentRoomSecrets, /Force\s+DD\s+(\d+)/i) ?? 15;
    return {
      resolution: "requires_roll",
      reason: "Forcer une porte",
      intent: null,
      rollRequest: {
        kind: "check",
        stat: "FOR",
        skill: "Athlétisme",
        dc,
        raison: "Tenter d'enfoncer la porte",
      },
      sceneUpdate: null,
    };
  }

  if (/(crochet|crocheter|serrure|outils?\s+de\s+voleur)/i.test(raw)) {
    const dc = tryExtractDcFromSecrets(currentRoomSecrets, /Dextérité\s+DD\s+(\d+)/i) ?? 10;
    return {
      resolution: "requires_roll",
      reason: "Crocheter une serrure",
      intent: null,
      rollRequest: {
        kind: "check",
        stat: "DEX",
        skill: "Escamotage",
        dc,
        raison: "Crocheter la serrure",
      },
      sceneUpdate: null,
    };
  }

  if (/\[sceneentered\]/i.test(raw) && /embuscade/i.test(String(currentRoomSecrets ?? ""))) {
    return {
      resolution: "requires_roll",
      reason: "Application des règles du lieu à l'entrée (jet secret d'embuscade).",
      intent: null,
      rollRequest: {
        kind: "gm_secret",
        stat: "SAG",
        dc: 0,
        roll: "1d100",
        raison: "Règle d'embuscade du lieu",
      },
      sceneUpdate: null,
    };
  }

  return null;
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      text,
      entities = [],
      playerWeapons = [],
      playerMeleeTargets = [],
      turnResources = null,
      provider = "openrouter",
      gameMode = "exploration",
      currentScene = "",
      currentRoomId = "",
      currentRoomSecrets = "",
      allowedExits = [],
      messages = [],
    } = body;

    if (typeof text !== "string" || !String(text).trim()) {
      return NextResponse.json(
        { error: "Le champ 'text' (string non vide) est requis." },
        { status: 400 }
      );
    }

    const entList = normalizeEntitiesForPrompt(entities);
    const weaponNames = normalizeWeaponList(playerWeapons);
    const meleeIds = normalizeMeleeTargetIds(playerMeleeTargets);
    const exits = normalizeAllowedExits(allowedExits);
    const normalizedMessages = normalizeMessagesForPrompt(messages);
    const userContent = buildUserContent({
      text,
      gameMode,
      currentScene,
      currentRoomId,
      currentRoomSecrets,
      allowedExits: exits,
      entities: entList,
      weaponNames,
      meleeTargetIds: meleeIds,
      turnResources,
      messages: normalizedMessages,
    });

    let rawOut = "";

    if (provider === "gemini") {
      if (!process.env.GEMINI_API_KEY) {
        return NextResponse.json({ error: "GEMINI_API_KEY manquant." }, { status: 500 });
      }
      const model = genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        systemInstruction: ARBITER_SYSTEM,
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2,
        },
      });
      const result = await model.generateContent(userContent);
      rawOut = (result.response.text() || "").trim();
    } else {
      if (!process.env.OPENROUTER_API_KEY) {
        return NextResponse.json({ error: "OPENROUTER_API_KEY manquant." }, { status: 500 });
      }
      const messages = [
        { role: "system", content: ARBITER_SYSTEM },
        { role: "user", content: userContent },
      ];
      const res = await fetch(OPENROUTER_BASE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "DnD AI Arbiter",
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages,
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

    let parsed = safeParseArbiterJson(rawOut);
    if (!parsed.ok) {
      const fallback = buildDeterministicFallback({
        text,
        gameMode,
        currentRoomSecrets,
        allowedExits: exits,
      });
      if (fallback) {
        parsed = { ok: true, parsed: fallback };
      }
    }

    const traceProvider = provider === "gemini" ? "gemini" : "openrouter";
    const payload = {
      text: String(text ?? ""),
      gameMode,
      currentScene: String(currentScene ?? ""),
      currentRoomId,
      currentRoomSecrets: String(currentRoomSecrets ?? ""),
      allowedExits: exits,
      entities: entList,
      playerWeapons: weaponNames,
      playerMeleeTargets: meleeIds,
      turnResources: turnResources ?? null,
      messages: normalizedMessages,
      userContent,
      systemInstruction: ARBITER_SYSTEM,
    };
    await logInteraction(
      "INTENT_PARSER",
      traceProvider,
      payload,
      ARBITER_SYSTEM,
      rawOut,
      parsed.ok ? parsed.parsed : { error: parsed.error, raw: truncate(rawOut, 500) }
    );

    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error, raw: truncate(rawOut, 2000) },
        { status: 422 }
      );
    }

    return NextResponse.json({
      ...parsed.parsed,
      debugPrompt: {
        provider: provider === "gemini" ? "gemini" : "openrouter",
        model: provider === "gemini" ? GEMINI_MODEL : OPENROUTER_MODEL,
        systemInstruction: truncate(ARBITER_SYSTEM, 1500),
        userContent: truncate(userContent, 2500),
      },
    });
  } catch (error) {
    console.error("[/api/parse-intent]", error);
    return NextResponse.json(
      {
        error: "Erreur lors de l'arbitrage d'intention.",
        details: String(error?.message ?? error),
      },
      { status: 500 }
    );
  }
}
