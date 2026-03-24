import { NextResponse } from "next/server";
import { logInteraction } from "@/lib/aiTraceLog";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "arcee-ai/trinity-large-preview:free";
const GEMINI_MODEL = "gemini-3-flash-preview";

import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function truncate(s, n = 800) {
  const str = typeof s === "string" ? s : String(s ?? "");
  return str.length > n ? str.slice(0, n) + "…" : str;
}

const SKIP_MESSAGE_TYPES = new Set([
  "debug",
  "dice",
  "enemy-turn",
  "scene-image",
  "scene-image-pending",
  "meta",
  "meta-reply",
  "continue",
]);

/**
 * Derniers messages (MJ + joueur) en script lisible — inclut TOUJOURS la dernière réplique du MJ si présente.
 */
function formatRecentChatScript(rawMessages, playerName = "Joueur") {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return "(Aucun message récent.)";
  }
  const cleaned = rawMessages.filter((m) => {
    const t = m?.type;
    return !(t && SKIP_MESSAGE_TYPES.has(t));
  });
  const lines = cleaned
    .map((m) => {
      const text = truncate(String(m?.content ?? "").trim(), 1200);
      if (!text) return null;
      if (m?.role === "ai") {
        return `Maître du Jeu : ${text}`;
      }
      if (m?.role === "user") {
        return `Moi (${playerName}) : ${text}`;
      }
      return null;
    })
    .filter(Boolean);
  return lines.length ? lines.join("\n\n") : "(Aucun échange récent.)";
}

const ZERO_SHOT_USER_PROMPT = [
  "Voici la scène et la conversation en cours (rappel : section « HISTORIQUE RÉCENT DU CHAT » dans ton instruction système).",
  "Quelle est ta prochaine phrase ou action ?",
].join("\n");

/**
 * Texte d'état combat / mêlée (même esprit que l'API enemy-tactics / GM_TACTICIAN).
 * @param {unknown} snapshot
 * @returns {string}
 */
function formatBattleSnapshotForPrompt(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return "";
  const s = /** @type {Record<string, unknown>} */ (snapshot);
  const gm = s.gameMode === "combat" ? "COMBAT" : "EXPLORATION";
  const lines = [];
  lines.push("=== ÉTAT DU MOTEUR (combat & mêlée — source fiable, comme pour l'IA tactique ennemie) ===");
  lines.push(`Mode : ${gm}.`);

  if (s.gameMode !== "combat") {
    lines.push(
      "Hors combat structuré : dialogues et exploration sont pertinents ; pas de priorité « survie immédiate » imposée par le moteur."
    );
    return lines.join("\n");
  }

  if (s.awaitingPlayerInitiative === true) {
    lines.push(
      "Le moteur attend encore le jet d'initiative du joueur avant de poursuivre le combat structuré."
    );
  }

  lines.push(
    s.isPlayerTurn === true
      ? "C'est le tour du personnage joueur dans l'ordre d'initiative."
      : "Ce n'est PAS le tour du personnage joueur (tour d'un autre combattant) — en principe tu ne devrais pas jouer une action de tour PJ."
  );

  const order = Array.isArray(s.initiativeOrder) ? s.initiativeOrder : [];
  if (order.length > 0) {
    lines.push(
      `Ordre d'initiative : ${order
        .map((e) => {
          if (!e || typeof e !== "object") return "?";
          const o = /** @type {Record<string, unknown>} */ (e);
          const nm = typeof o.name === "string" ? o.name : "";
          const id = typeof o.id === "string" ? o.id : "";
          return nm && id ? `${nm}[${id}]` : nm || id || "?";
        })
        .join(" → ")}`
    );
  }
  if (typeof s.activeCombatantId === "string" && s.activeCombatantId) {
    lines.push(`Combattant actif (côté moteur) : ${s.activeCombatantId}.`);
  }

  const p = s.player && typeof s.player === "object" ? /** @type {Record<string, unknown>} */ (s.player) : null;
  const tr = p?.turnResources && typeof p.turnResources === "object" ? /** @type {Record<string, unknown>} */ (p.turnResources) : null;
  if (tr && s.isPlayerTurn === true) {
    const actionOk = !!tr.action;
    const bonusOk = !!tr.bonus;
    const movementOk = !!tr.movement;
    const reactionOk = !!tr.reaction;
    const secondWindOk = !!tr.secondWind?.available;
    const secondWindRemaining =
      typeof tr.secondWind?.remaining === "number" ? tr.secondWind.remaining : (secondWindOk ? 1 : 0);
    lines.push(
      `Ressources de tour du PJ : action=${actionOk ? "oui" : "non"}, action bonus=${bonusOk ? "oui" : "non"}, mouvement=${movementOk ? "oui" : "non"}, réaction (tour)=${reactionOk ? "oui" : "non"}, second souffle=${secondWindOk ? "oui" : "non"} (${secondWindRemaining}/1).`
    );
    if (!actionOk) {
      lines.push("RÈGLE: action principale (Action) indisponible → INTERDIT de déclarer une attaque principale qui consomme l'Action (évite move_and_attack/attack si ça implique une Action).");
    }
    if (!bonusOk) {
      lines.push("RÈGLE: Action bonus indisponible → INTERDIT les actions bonus.");
    }
    if (!reactionOk) {
      lines.push("RÈGLE: Réaction indisponible → INTERDIT les actions de réaction.");
    }
    if (!movementOk) {
      lines.push("RÈGLE: Mouvement indisponible → INTERDIT tout déplacement (move / move_and_attack).");
    }
    if (!secondWindOk) {
      lines.push("RÈGLE: Second souffle indisponible → INTERDIT de l'utiliser.");
    } else {
      lines.push("RÈGLE: Second souffle disponible → autorisé uniquement si tu as l'action bonus disponible (sinon, ne l'utilise pas).");
    }
  }
  if (p) {
    lines.push(`Réaction du PJ encore disponible ce round (AoO, etc.) : ${p.reactionAvailable ? "oui" : "non"}.`);
  }

  const hostileList = Array.isArray(s.hostiles) ? s.hostiles : [];
  const deadHostiles = Array.isArray(s.deadHostiles) ? s.deadHostiles : [];
  const idToName = {};
  for (const h of hostileList) {
    if (!h || typeof h !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (h);
    if (typeof o.id === "string" && typeof o.name === "string") idToName[o.id] = o.name;
  }
  for (const h of deadHostiles) {
    if (!h || typeof h !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (h);
    if (typeof o.id === "string" && typeof o.name === "string") idToName[o.id] = o.name;
  }

  if (hostileList.length > 0) {
    lines.push("Hostiles présents (vivants / visibles, côté moteur) :");
    for (const h of hostileList) {
      if (!h || typeof h !== "object") continue;
      const o = /** @type {Record<string, unknown>} */ (h);
      const id = typeof o.id === "string" ? o.id : "?";
      const name = typeof o.name === "string" ? o.name : id;
      const meleePj = o.inMeleeWithPlayer === true ? "AU CONTACT du joueur" : "pas au contact du joueur (à distance selon le moteur)";
      const ew = Array.isArray(o.engagedWithIds) ? o.engagedWithIds.filter((x) => typeof x === "string" && x !== "player") : [];
      const extra =
        ew.length > 0
          ? ` ; au contact aussi de : ${ew.map((x) => idToName[x] || x).join(", ")}`
          : "";
      lines.push(`- ${name} [id=${id}] — ${meleePj}${extra}`);
    }
  } else {
    lines.push("Aucun hostile listé dans ce snapshot.");
  }

  if (deadHostiles.length > 0) {
    lines.push("Hostiles déjà à 0 PV (morts, côté moteur) :");
    for (const d of deadHostiles) {
      if (!d || typeof d !== "object") continue;
      const o = /** @type {Record<string, unknown>} */ (d);
      const id = typeof o.id === "string" ? o.id : "?";
      const name = typeof o.name === "string" ? o.name : id;
      const hpCurrent = typeof o.hpCurrent === "number" ? o.hpCurrent : 0;
      lines.push(`- ${name} [id=${id}] — HP actuel=${hpCurrent}`);
    }
    lines.push("Interdiction: ne cible jamais ces créatures mortes.");
  }

  const eng = p && Array.isArray(p.engagedWithHostileIds) ? p.engagedWithHostileIds.filter((x) => typeof x === "string") : [];
  if (eng.length === 0) {
    lines.push("Mêlée côté joueur : le PJ n'est au corps à corps avec aucun hostile de la liste ci-dessus.");
  } else {
    lines.push(
      `Mêlée côté joueur : le PJ est au corps à corps avec : ${eng.map((id) => idToName[id] || id).join(", ")}.`
    );
  }

  lines.push(
    "Rappel : utilise ces lignes pour décider contact / distance, cible plausible, et priorité combat — ne les contredis pas."
  );

  return lines.join("\n");
}

/**
 * Prompt auto-joueur : uniquement ce qu'un PJ pourrait percevoir.
 * Jamais secrets MJ, encounterEntities, règles d'embuscade, DD, etc.
 */
function buildAutoPlayerSystemPrompt(player, entities, gameMode, battleSnapshot) {
  const stats = player?.stats ?? {};
  const langs = Array.isArray(player?.languages) ? player.languages : [];
  const skills = Array.isArray(player?.skillProficiencies)
    ? player.skillProficiencies
    : [];

  const entityLines = (Array.isArray(entities) ? entities : [])
    .filter((e) => e && e.visible)
    .map((e) => {
      const hpCur = typeof e?.hp?.current === "number" ? e.hp.current : null;
      const hpMax = typeof e?.hp?.max === "number" ? e.hp.max : null;
      const hpSuffix =
        hpCur != null && hpMax != null
          ? ` — HP: ${hpCur}/${hpMax}${e.type === "hostile" && hpCur <= 0 ? " (0 PV)" : ""}`
          : "";
      return `- ${e.name} (${e.type}) — ${e.description}${hpSuffix}`;
    })
    .join("\n");

  const weaponList = Array.isArray(player?.weapons)
    ? player.weapons.map((w) => (typeof w?.name === "string" ? w.name.trim() : "")).filter(Boolean)
    : [];
  const weaponLines =
    weaponList.length > 0
      ? weaponList.map((n) => `- ${n}`).join("\n")
      : null;

  const isCombat = gameMode === "combat";
  const battleBlock = formatBattleSnapshotForPrompt(battleSnapshot);

  return [
    `Tu es un JOUEUR unique dans une partie de Donjons & Dragons 5e.`,
    `Ton rôle : parler et agir À LA PLACE du personnage joueur humain.`,
    ``,
    `=== PERSONNAGE JOUEUR ===`,
    `Nom: ${player?.nom ?? "Inconnu"}`,
    `Race: ${player?.race ?? "Inconnue"}, Classe: ${player?.classe ?? "Inconnue"}, Niveau: ${player?.level ?? "?"}.`,
    `Alignement: ${player?.alignment ?? "Non spécifié"}.`,
    `HP: ${player?.hp?.current ?? "?"}/${player?.hp?.max ?? "?"}, CA: ${
      player?.armorClass ?? "?"
    }, Vitesse: ${player?.speed ?? "30 ft"}.`,
    `Stats: FOR ${stats.FOR ?? "?"}, DEX ${stats.DEX ?? "?"}, CON ${
      stats.CON ?? "?"
    }, INT ${stats.INT ?? "?"}, SAG ${stats.SAG ?? "?"}, CHA ${
      stats.CHA ?? "?"
    }.`,
    langs.length ? `Langues connues: ${langs.join(", ")}.` : ``,
    skills.length
      ? `Compétences maîtrisées: ${skills.join(", ")}.`
      : ``,
    player?.background
      ? `Historique: ${player.background}${
          player.backgroundFeature
            ? ` (${player.backgroundFeature})`
            : ""
        }.`
      : ``,
    player?.description
      ? `Description RP courte: ${truncate(player.description, 300)}`
      : ``,
    ``,
    weaponLines
      ? [
          `=== ARMES ET TIRS (noms EXACTS reconnus par le jeu) ===`,
          `Tu dois utiliser ces libellés tels quels (orthographe incluse) quand tu annonces une attaque ou un tir :`,
          weaponLines,
          ``,
        ].join("\n")
      : ``,
    isCombat && weaponLines
      ? [
          `=== COMBAT — ANNONCER UNE ATTAQUE (CRITIQUE) ===`,
          `Pour frapper ou tirer sur une créature, cite OBLIGATOIREMENT le nom d'UNE arme listée ci-dessus (ex: « épée longue », « arbalète légère »).`,
          `INTERDIT : « arme de corps à corps », « arme à distance », « mon arme », « ma lame », « mon épée » sans nom complet, « coup puissant » sans nom d'arme, ou toute catégorie générique — le moteur les rejette.`,
          `BON : « Je porte un coup d'épée longue au gobelin teigneux. » ou « Je tire à l'arbalète légère sur le gobelin chétif. » (adapte au nom exact de ta liste).`,
          `MAUVAIS : « ...avec mon arme de corps à corps. »`,
          ``,
        ].join("\n")
      : isCombat && !weaponLines
        ? [
            `=== COMBAT ===`,
            `Pour une attaque, nomme explicitement une arme ou un sort que possède réellement ton personnage sur sa fiche (pas de libellés génériques type « arme de corps à corps »).`,
            ``,
          ].join("\n")
        : ``,
    `=== CONTEXTE IMMÉDIAT (ÉTAT MOTEUR) ===`,
    `Mode de jeu: ${gameMode === "combat" ? "COMBAT" : "EXPLORATION"}.`,
    `Base-toi sur l'historique du chat pour savoir ce qui s'est passé.`,
    ``,
    `Entités visibles (ce que ton personnage voit sur place — tu ne peux interagir QU'avec elles):`,
    entityLines || "Aucune entité listée — tu es seul. INTERDIT de parler à, toucher ou mentionner Thron, le commis ou tout PNJ absent.",
    ``,
    battleBlock ? `${battleBlock}\n` : ``,
    `=== OBJECTIF ===`,
    `Tu joues UNIQUEMENT le personnage joueur. Tu proposes sa prochaine intention.`,
    ``,
    `=== RÈGLES STRICTES ===`,
    `- INTERDIT de jouer un PNJ ou de parler à sa place.`,
    `- INTERDIT de donner des informations au nom d'un PNJ (ex: direction, révélation, explication) si ce PNJ ne les a pas encore dites dans le dernier message MJ.`,
    `- Tu peux parler À un PNJ visible, mais jamais parler COMME lui.`,
    `- INTERDIT de décrire le décor, les résultats, ou les conséquences (rôle du MJ uniquement).`,
    `- INTERDIT de faire des jets, de résoudre une action, ou d'affirmer "ce qui se passe".`,
    `- INTERDIT de demander un jet de dé, un d100, ou d'invoquer des mécaniques/règles cachées du MJ (tu n'y as pas accès).`,
    `- Interagis seulement avec les entités visibles listées plus haut.`,
    isCombat
      ? [
          `- MODE COMBAT : tu es en situation de danger ; priorité au combat tactique (frapper avec une arme nommée, te rapprocher si tu es à distance et veux la mêlée, te désengager, intimider brièvement un adversaire). Évite les longues scènes sociales ou « calmes » tant que le mode moteur est COMBAT et qu'il reste des hostiles.`,
          `- La section « ÉTAT DU MOTEUR » indique qui est au corps à corps avec qui : sers-toi-en pour choisir une attaque de mêlée vs à distance (ex. arc si hors contact).`,
          `- Si tu penses qu'il n'y a rien de mieux à faire (ou aucune action légale pertinente), termine ton tour : écris une phrase du type "Je termine mon tour."`,
        ].join("\n")
      : ``,
    ``,
    `RÈGLE ANTI-BOUCLE (CRITIQUE) : Si un PNJ donne une réponse vague ou approximative (ex: « 4 ou 5 », « je ne sais pas », « peut-être »), tu DOIS ACCEPTER cette réponse comme définitive. Il est STRICTEMENT INTERDIT de poser deux fois la même question pour obtenir plus de précision. Dès que tu as une info, même floue, change d'action et fais avancer l'histoire.`,
    ``,
    `=== AVANCEMENT ===`,
    `- Une seule intention principale par message.`,
    `- Pas de chaînes d'actions: pas de "puis", "ensuite", "et après", ni liste d'ordres.`,
    `- INTERDIT de combiner deux types d'actions dans le même message (ex: "Second souffle" + déplacement, ou attaque + déplacement dans une même phrase). Choisis UN seul type d'action à la fois.`,
    `- Si tu hésites entre parler et agir, choisis UNE option pour ce message.`,
    `- Si une info a déjà été donnée récemment, n'insiste pas: avance l'action.`,
    `- Evite de répéter les mêmes actions/dialogues/informations. Ton but est de faire avancer l'histoire comme un vrai joueur humain de DND.`,
    `- Après une réponse PNJ floue ou « je ne sais pas », ne reformule pas la même demande : pivote vers une autre action (voir règle anti-boucle ci-dessus).`,
    ``,
    `=== FORMAT DE SORTIE ===`,
    `- Français.`,
    `- 1 phrase (2 max), courte, naturelle.`,
    `- Pas de méta, pas de JSON, pas de balises.`,
    ``,
    `=== EXEMPLES ===`,
    `BON: "Je demande au commis de me montrer précisément le départ du sentier."`,
    `BON: "Je quitte la forge et me mets en route vers la colline à l'ouest."`,
    `MAUVAIS: "Le commis pointe l'ouest et dit que..." (tu joues le PNJ)`,
    `MAUVAIS: "Je lui demande, puis je pars, puis je..." (plusieurs intentions)`,
  ].join("\n");
}

function formatHistoryForGeminiFromAiLog(aiMessages) {
  // On utilise l'historique (MJ + joueur) déjà sérialisé par le client,
  // mais Gemini impose que le PREMIER message de l'historique ait le rôle "user".
  // On tronque donc les éventuels messages de rôle "model" en tête, et on
  // isole toujours le DERNIER message "user" comme userMessage.
  if (!Array.isArray(aiMessages) || aiMessages.length === 0) {
    return { history: [], userMessage: "" };
  }

  const all = aiMessages.map((m) => ({
    role: m.role === "ai" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  // Chercher le premier message "user" pour que l'historique commence par lui.
  const firstUserIndex = all.findIndex((m) => m.role === "user");
  if (firstUserIndex === -1) {
    // Aucun "user" → on met tout dans un seul userMessage sans history.
    const joined = all.map((m) => m.parts[0]?.text ?? "").join("\n\n");
    return { history: [], userMessage: joined };
  }

  const trimmed = all.slice(firstUserIndex);

  // Dernier "user" de la séquence = véritable userMessage.
  const lastUserIndex = [...trimmed]
    .map((m, idx) => ({ role: m.role, idx }))
    .filter((x) => x.role === "user")
    .map((x) => x.idx)
    .pop();

  if (lastUserIndex == null) {
    const joined = trimmed.map((m) => m.parts[0]?.text ?? "").join("\n\n");
    return { history: [], userMessage: joined };
  }

  const history = trimmed.slice(0, lastUserIndex);
  const userMessage = trimmed[lastUserIndex]?.parts?.[0]?.text ?? "";

  return { history, userMessage };
}

export async function POST(request) {
  try {
    const body = await request.json();
    const {
      player,
      currentScene,
      currentRoomId,
      entities = [],
      gameMode = "exploration",
      history: historyBody = [],
      messages: messagesBody = [],
      provider = "openrouter",
      battleSnapshot = null,
    } = body;

    const rawHistory = Array.isArray(historyBody) && historyBody.length
      ? historyBody
      : Array.isArray(messagesBody)
        ? messagesBody
        : [];

    const playerDisplayName = String(player?.nom ?? "Joueur").trim() || "Joueur";
    const recentChatScript = formatRecentChatScript(rawHistory, playerDisplayName);

    const basePrompt = buildAutoPlayerSystemPrompt(
      player,
      entities,
      gameMode,
      battleSnapshot
    );
    const systemPrompt =
      `${basePrompt}\n\n` +
      `=== HISTORIQUE RÉCENT DU CHAT ===\n` +
      `${recentChatScript}\n\n` +
      `Tu dois lire ce fil dans l'ordre : il contient les dernières réponses du Maître du Jeu et tes actions. ` +
      `Ne répète pas une question à laquelle le MJ a déjà répondu.`;

    if (provider === "gemini") {
      const model = genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        systemInstruction: systemPrompt,
        generationConfig: { temperature: 0.9 },
      });
      const result = await model.generateContent(ZERO_SHOT_USER_PROMPT);
      const textRaw = (result.response.text() || "").trim();
      const contentOut = truncate(textRaw, 400);
      const parsedOut = { content: contentOut };
      await logInteraction(
        "AutoPlayer",
        "gemini",
        {
          mode: "gemini",
          zeroShotUser: ZERO_SHOT_USER_PROMPT,
          recentMessagesCount: rawHistory.length,
          messagesOrdered: rawHistory,
          recentChatScript,
          battleSnapshot: battleSnapshot ?? null,
        },
        systemPrompt,
        textRaw,
        parsedOut
      );
      return NextResponse.json({
        ...parsedOut,
        debugPrompt: {
          provider: "gemini",
          systemInstruction: truncate(systemPrompt, 2000),
          userMessagePreview: truncate(ZERO_SHOT_USER_PROMPT, 400),
          recentChatScriptPreview: truncate(recentChatScript, 800),
        },
      });
    }

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: ZERO_SHOT_USER_PROMPT },
    ];

    const res = await fetch(OPENROUTER_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "DnD AI Auto Player",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages,
        temperature: 0.9,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message ?? `Erreur OpenRouter (${res.status})`);
    }

    const data = await res.json();
    const textRaw =
      data.choices?.[0]?.message?.content &&
      typeof data.choices[0].message.content === "string"
        ? data.choices[0].message.content.trim()
        : "";
    const contentOut = truncate(textRaw, 400);
    const parsedOut = { content: contentOut };
    await logInteraction(
      "AutoPlayer",
      "openrouter",
      {
        mode: "openrouter",
        model: OPENROUTER_MODEL,
        messages,
        recentMessagesCount: rawHistory.length,
        messagesOrdered: rawHistory,
        recentChatScript,
        battleSnapshot: battleSnapshot ?? null,
      },
      systemPrompt,
      textRaw,
      parsedOut
    );
    return NextResponse.json({
      ...parsedOut,
      debugPrompt: {
        provider: "openrouter",
        model: OPENROUTER_MODEL,
        systemInstruction: truncate(systemPrompt, 2000),
        messagesPreview: messages.map((m) => ({
          role: m.role,
          content: truncate(m.content, 400),
        })),
      },
    });
  } catch (error) {
    console.error("[/api/auto-player] Erreur :", error);
    return NextResponse.json(
      { error: "Erreur lors de la génération du tour automatique.", details: error.message },
      { status: 500 }
    );
  }
}

