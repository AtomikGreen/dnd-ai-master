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
import { slimMessagesForArbiterPrompt } from "@/lib/slimMessagesForArbiterPrompt";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "arcee-ai/trinity-large-preview:free";
const GEMINI_MODEL = "gemini-3-flash-preview";

const ARBITER_SYSTEM = `Arbitre logique D&D 5e : aucune narration, uniquement un objet JSON.

ROLE : Tu traduis les intentions informelles du joueur en actions D&D formelles.

Sortie obligatoire :
{
  "resolution": "combat_intent" | "requires_roll" | "trivial_success" | "impossible" | "unclear_input",
  "reason": "texte court",
  "intent": null | { "type": "move"|"attack"|"move_and_attack"|"disengage"|"spell"|"dodge"|"second_wind"|"short_rest"|"long_rest"|"end_turn"|"loot", "targetId": "", "weapon": "" },
  "rollRequest": null | { "kind": "check"|"save"|"attack"|"gm_secret", "stat": "FOR"|"DEX"|"CON"|"INT"|"SAG"|"CHA", "skill": "Athlétisme", "dc": <nombre>, "raison": "...", "roll": "1d100" },
  "sceneUpdate": null | { "hasChanged": true, "targetRoomId": "..." }
}

MODE (entrée) = combat ou exploration : fixé par le moteur ; tu n’inventes pas le mode, tu appliques les règles du mode courant.

unclear_input : message vide de sens en jeu, spam/métajeu/hors cadre, incohérent, aucune intention D&D raisonnable. Sinon ne pas l’utiliser : action risquée mais claire → requires_roll ou impossible ; maladroite mais compréhensible → interpréter. Une courte relance de dialogue ou de clarification n'est PAS unclear_input si l'historique récent montre qu'un PNJ vient de parler juste avant (ex: "hein ?", "pardon ?", "comment ça ?", "si quoi ?", "de quoi tu parles ?", "qui ça ?").

RÈGLE ANTI-CHAÎNE (1 SEULE action majeure par tour) :
- Si le message du joueur décrit plusieurs actions distinctes/étapes (ex: “je fais X puis je part vers Y puis je frappe Z...”), traite UNIQUEMENT la PREMIÈRE action D&D clairement formulée dans l’ordre d’apparition.
- Ignore le reste pour ce tour : ne renvoie qu’une seule résolution et un seul intent (ou sceneUpdate si c’est une navigation).
- Si la première action correspond à une navigation (direction/entrée vers une sortie autorisée), privilégie la scèneUpdate associée et ignore les autres actions mentionnées après.

Exploration : trivial_success (sans enjeu) / impossible / requires_roll + rollRequest si conséquence incertaine. DC PHB : 5 très facile, 10 facile, 15 moyen, 20 difficile, 25 très difficile, 30 quasi impossible ; un DC explicite dans le contexte prime. intent=null sauf capacité déclarée. Capacités/repos : "second souffle" -> combat_intent + type second_wind ; "repos court", "courte pause pour souffler/se ressourcer" -> combat_intent + type short_rest ; "repos long", "dormir 8h/se reposer pour la nuit" -> combat_intent + type long_rest. Ne confonds jamais "courte pause/repos court" avec second_wind. Loot/fouille corps → trivial_success. Déplacement vers sortie listée → trivial_success + sceneUpdate(targetRoomId) ; matcher direction ou description aux sorties autorisées ; ne pas inventer de sortie. SÉMANTIQUE DE NAVIGATION À RESPECTER STRICTEMENT : "je me dirige vers", "je vais vers", "je m'approche de", "je me rapproche de", "je marche jusqu'à" une porte / issue / sortie = seulement s'en approcher, jamais l'ouvrir, la franchir, la crocheter ni la forcer. "j'ouvre", "je pousse la porte", "je tente la porte", "j'essaie d'ouvrir", "je crochette", "je force", "j'enfonce" = interaction avec la porte ; si le verrou ou la résistance créent une incertitude, alors seulement requires_roll ou impossible. "j'entre", "je passe", "je franchis", "je traverse", "je vais dedans", "j'y vais" = franchissement / passage vers l'autre salle, mais seulement si l'historique récent montre que le personnage est déjà au seuil ou qu'une seule issue immédiate cohérente est en train d'être suivie ; sinon interpréter "j'y vais" comme trop ambigu plutôt que comme une nouvelle action technique. N'infère jamais de crochetage ou de forçage uniquement parce que les secrets mentionnent une serrure, une clef, un verrou ou un DD : il faut une intention explicite du joueur d'ouvrir malgré l'obstacle ou d'interagir avec la serrure. Si le joueur dit juste "j'avance / j'explore / je continue" et que plusieurs sorties sont possibles sans précision unique, ne choisis jamais à sa place : renvoie unclear_input avec une reason factuelle et procédurale (destinée au moteur/narrateur, pas au joueur) qui résume brièvement l'ambiguïté. Quand le joueur parle à un PNJ présent ou lui pose une question, ce n'est presque jamais un jet joueur : par défaut renvoie trivial_success (ou impossible si la demande n'a aucun sens), avec intent=null et rollRequest=null. Une réplique très courte qui réagit au dernier message d'un PNJ doit être interprétée à la lumière de l'historique récent comme une demande de précision ou une continuation de dialogue, même si elle n'exprime pas une intention complète toute seule. Exemples : "Heu si quoi ?", "Comment ça ?", "Pardon ?", "Qui ça ?", "De quoi tu parles ?" → trivial_success, pas unclear_input, si le dernier message assistant contient une réplique PNJ ou une phrase inachevée. Pour ces questions sociales, ton reason doit rester procédural et neutre : décris que le joueur demande une précision, relance la dernière réplique, ou interroge un PNJ / des villageois sur tel sujet ; ne décide pas toi-même du contenu vrai de la réponse. N'invente jamais un skillcheck pour un PNJ, les skillcheck sont pour les joueurs ; si l'incertitude porte sur ce que le PNJ sait, croit, ose dire ou se rappelle, ne demande pas de check/save joueur. Pièges/patrouilles/d100 imposés par le lieu : ne pas utiliser gm_secret ici (l’arbitre de scène et les secrets s’en occupent) ; si besoin, requires_roll avec check/save joueur. [SceneEntered] = navigation déjà traitée, pas de jet MJ ici.

Combat : intent parmi move, attack, move_and_attack, disengage, spell, dodge, second_wind, short_rest, long_rest, end_turn, loot ; playerMeleeTargets distingue attack vs move_and_attack ; disengage/dodge/end_turn/second_wind/short_rest/long_rest : targetId peut être "". rollRequest=null et sceneUpdate=null. RÈGLE IMPÉRATIVE : en combat, si l'intention du joueur est d'attaquer, de lancer un sort offensif, de se déplacer pour frapper, ou plus généralement d'accomplir une action de combat standard résolue par le moteur, tu dois répondre "combat_intent" avec intent renseigné, JAMAIS "requires_roll". Le jet d'attaque ou les dégâts seront gérés ensuite par le moteur client ; toi tu ne demandes pas un skillcheck, tu décris seulement l'intention de combat structurée. "requires_roll" en combat est réservé aux cas exceptionnellement hors grammaire de combat standard.

Fiabilité : clé intent (pas actionIntent). Jamais de string à la place d’un objet. Utiliser type/stat/dc (pas action/ability/difficultyClass). JSON seul, sans markdown.`;

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
    `Historique (ancien → récent, résumé si long) :`,
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
        "short_rest",
        "long_rest",
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

function normalizeLoose(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function isExplicitDoorTraversalIntent(rawText) {
  const raw = String(rawText ?? "").trim();
  if (!raw) return false;
  return /(ouvre|ouvrir|j['’]ouvre|franchi|franchir|je\s+passe(?:\s+la\s+porte)?|passer\s+la\s+porte|je\s+rentre|je\s+rentre|j['’]entre|je\s+vais\s+dedans|j['’]y\s+vais|je\s+traverse)/i.test(raw);
}

function isApproachOnlyIntent(rawText) {
  const raw = String(rawText ?? "").trim();
  if (!raw) return false;
  const approachVerb =
    /(je\s+me\s+dirige(?:r)?|je\s+vais\s+vers|je\s+m['’]approche|je\s+me\s+rapproche|je\s+marche\s+vers|je\s+me\s+rends?\s+vers)/i;
  if (!approachVerb.test(raw)) return false;
  if (isExplicitDoorTraversalIntent(raw)) return false;
  if (/(crochet|crocheter|serrure|outils?\s+de\s+voleur|forcer|enfonc|défonc|deverrou|déverrou)/i.test(raw)) {
    return false;
  }
  return true;
}

function classifyRestIntent(rawText) {
  const raw = normalizeLoose(String(rawText ?? ""));
  if (!raw) return null;
  if (
    /\b(repos\s+court|short\s+rest|courte?\s+pause|petite?\s+pause|souffler\s+un\s+peu|me\s+ressourcer|recuperer\s+mes\s+forces)\b/.test(
      raw
    )
  ) {
    return "short_rest";
  }
  if (
    /\b(repos\s+long|long\s+rest|dormir|nuit\s+de\s+repos|pour\s+la\s+nuit|huit\s+heures?)\b/.test(
      raw
    )
  ) {
    return "long_rest";
  }
  return null;
}

function normalizeParsedRestIntent(rawText, parsedDecision) {
  if (!parsedDecision || typeof parsedDecision !== "object") return parsedDecision;
  const restType = classifyRestIntent(rawText);
  if (!restType) return parsedDecision;
  if (parsedDecision.sceneUpdate) return parsedDecision;
  return {
    resolution: "combat_intent",
    reason:
      restType === "short_rest"
        ? "Demande explicite de repos court"
        : "Demande explicite de repos long",
    intent: { type: restType, targetId: "", weapon: "" },
    rollRequest: null,
    sceneUpdate: null,
  };
}

function buildDeterministicFallback({
  text,
  gameMode,
  currentRoomSecrets,
  allowedExits,
}) {
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

  const restType = classifyRestIntent(raw);
  if (restType) {
    return {
      resolution: "combat_intent",
      reason:
        restType === "short_rest"
          ? "Demande explicite de repos court"
          : "Demande explicite de repos long",
      intent: { type: restType, targetId: "", weapon: "" },
      rollRequest: null,
      sceneUpdate: null,
    };
  }

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
    const selectedExit = pickExitFromText(raw, allowedExits);
    if (selectedExit && isApproachOnlyIntent(raw)) {
      const dir = String(selectedExit?.direction ?? "").trim();
      return {
        resolution: "trivial_success",
        reason: dir
          ? `Le joueur s'approche de la porte / sortie vers ${dir} sans tenter de l'ouvrir.`
          : "Le joueur s'approche d'une porte / sortie sans tenter de l'ouvrir.",
        intent: null,
        rollRequest: null,
        sceneUpdate: null,
      };
    }
    if (!selectedExit && allowedExits.length > 1) {
      const options = allowedExits
        .map((e) => {
          const dir = String(e?.direction ?? "").trim();
          const desc = String(e?.description ?? "").trim();
          if (dir && desc) return `${dir} (${desc})`;
          return dir || desc || String(e?.id ?? "").trim();
        })
        .filter(Boolean)
        .slice(0, 4);
      return {
        resolution: "unclear_input",
        reason:
          options.length > 0
            ? `Plusieurs chemins sont possibles: ${options.join(" ; ")}. Lequel choisissez-vous ?`
            : "Plusieurs chemins sont possibles. Lequel choisissez-vous ?",
        intent: null,
        rollRequest: null,
        sceneUpdate: null,
      };
    }
    const fallbackExit = !selectedExit && allowedExits.length === 1 ? allowedExits[0] : null;
    const finalExit = selectedExit ?? fallbackExit;
    if (finalExit?.id) {
      return {
        resolution: "trivial_success",
        reason: "Déplacement explicite vers une sortie autorisée",
        intent: null,
        rollRequest: null,
        sceneUpdate: { hasChanged: true, targetRoomId: finalExit.id },
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
    // Parse-intent : on garde surtout le joueur + la narration GM (si présente),
    // en limitant fortement l'historique pour éviter les prompts énormes.
    const normalizedMessages = slimMessagesForArbiterPrompt(normalizeMessagesForPrompt(messages), {
      maxTurns: 15,
      maxCharsPerMessage: 900,
      keepAssistantNull: true, // narration IA GM (type null)
      keepAssistantTypes: ["dice"],
    });
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
    if (parsed.ok) {
      parsed = {
        ok: true,
        parsed: normalizeParsedRestIntent(text, parsed.parsed),
      };
    }

    const traceProvider = provider === "gemini" ? "gemini" : "openrouter";
    // Log uniquement ce que le provider voit réellement (entrée) :
    // - Gemini: systemInstruction + userContent
    // - OpenRouter: messages[] (system + user)
    const requestForTrace =
      traceProvider === "gemini"
        ? {
            kind: "gemini",
            model: GEMINI_MODEL,
            systemInstruction: ARBITER_SYSTEM,
            userContent,
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.2,
            },
          }
        : {
            kind: "openrouter",
            model: OPENROUTER_MODEL,
            messages: [
              { role: "system", content: ARBITER_SYSTEM },
              { role: "user", content: userContent },
            ],
            temperature: 0.2,
            response_format: { type: "json_object" },
          };
    await logInteraction(
      "INTENT_PARSER",
      traceProvider,
      requestForTrace,
      "",
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
