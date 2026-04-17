import { NextResponse } from "next/server";
import { logInteraction } from "@/lib/aiTraceLog";
import { withTerminalAiTiming } from "@/lib/aiTerminalTimingLog";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "arcee-ai/trinity-large-preview:free";
const GEMINI_MODEL = "gemini-3-flash-preview";

import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function truncate(s, n = 800) {
  const str = typeof s === "string" ? s : String(s ?? "");
  return str.length > n ? str.slice(0, n) + "…" : str;
}

function normFr(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
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
    const c = String(m?.content ?? "");
    if (
      t === "meta" &&
      /action impossible|vous ne possédez pas l'arme ou le sort/i.test(c)
    ) {
      return true;
    }
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
        if (m?.type === "auto-player-nudge") {
          return `[Consigne moteur — pas une réplique du PJ] : ${text}`;
        }
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
    if (p.hiddenFromOpponents === true) {
      lines.push(
        "Le PJ est **caché** (discrétion active, moteur) : les adversaires peuvent avoir du mal à le cibler ; utile pour se repositionner ou frapper à distance avant d'être révélé."
      );
    }
  }

  const actionCatalog =
    s.actionCatalog && typeof s.actionCatalog === "object"
      ? /** @type {Record<string, unknown>} */ (s.actionCatalog)
      : null;
  if (actionCatalog) {
    const fmtList = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .map((x) => {
          if (!x || typeof x !== "object") return null;
          const o = /** @type {Record<string, unknown>} */ (x);
          const label = typeof o.label === "string" ? o.label : String(o.key ?? "Action");
          const available = o.available === false ? "indisponible" : "disponible";
          const costObj = o.cost && typeof o.cost === "object" ? /** @type {Record<string, unknown>} */ (o.cost) : null;
          const cost = costObj
            ? Object.entries(costObj)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(", ")
            : "coût inconnu";
          const note = typeof o.note === "string" && o.note.trim() ? ` | note: ${o.note.trim()}` : "";
          return `- ${label} | coût: ${cost} | ${available}${note}`;
        })
        .filter(Boolean);

    const main = fmtList(actionCatalog.mainActionOptions);
    const move = fmtList(actionCatalog.movementOptions);
    const bonus = fmtList(actionCatalog.bonusActionOptions);
    lines.push("=== CATALOGUE D'ACTIONS DU TOUR (source moteur) ===");
    if (main.length) {
      lines.push("Actions principales:");
      lines.push(main.join("\n"));
    }
    if (move.length) {
      lines.push("Déplacement:");
      lines.push(move.join("\n"));
    }
    if (bonus.length) {
      lines.push("Actions bonus:");
      lines.push(bonus.join("\n"));
    }
    lines.push("Priorité stricte: choisis d'abord dans ce catalogue et respecte les actions marquées indisponibles.");
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
    lines.push(
      "Hostiles présents (état tactique moteur — PV, contact, discrétion ; ne pas ignorer pour choisir mêlée vs distance, Perception, ou cibles difficiles) :"
    );
    for (const h of hostileList) {
      if (!h || typeof h !== "object") continue;
      const o = /** @type {Record<string, unknown>} */ (h);
      const id = typeof o.id === "string" ? o.id : "?";
      const name = typeof o.name === "string" ? o.name : id;
      const meleePj = o.inMeleeWithPlayer === true ? "AU CONTACT du joueur" : "pas au contact du joueur (à distance selon le moteur)";
      const hpTxt =
        typeof o.hpCurrent === "number" && typeof o.hpMax === "number"
          ? ` PV ${o.hpCurrent}/${o.hpMax}.`
          : "";
      const hid = o.hiddenFromPlayer === true;
      const hideTxt = hid
        ? " — **Caché / camouflé** (moteur : cible non dégagée ; souvent désavantage ou jet de Perception pour localiser)."
        : "";
      const stTxt =
        hid &&
        typeof o.stealthPassiveVsPerception === "number" &&
        Number.isFinite(o.stealthPassiveVsPerception)
          ? ` Réf. Discrétion (repérage Perception) : ${o.stealthPassiveVsPerception}.`
          : "";
      const ew = Array.isArray(o.engagedWithIds) ? o.engagedWithIds.filter((x) => typeof x === "string" && x !== "player") : [];
      const extra =
        ew.length > 0
          ? ` ; au contact aussi de : ${ew.map((x) => idToName[x] || x).join(", ")}`
          : "";
      lines.push(`- ${name} [id=${id}] — ${meleePj}.${hpTxt}${hideTxt}${stTxt}${extra}`);
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
 * @param {Array<Record<string, unknown>>} [partyPcs]
 */
function formatPartyPcsForPrompt(partyPcs) {
  if (!Array.isArray(partyPcs) || partyPcs.length === 0) return "";
  const lines = partyPcs
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const o = /** @type {Record<string, unknown>} */ (row);
      const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : "PJ";
      const who = o.isLocal === true ? "toi (personnage que tu joues)" : "camarade PJ";
      const cls = typeof o.entityClass === "string" && o.entityClass.trim() ? o.entityClass : "?";
      const race = typeof o.race === "string" && o.race.trim() ? o.race : "?";
      const lvl = typeof o.level === "number" && Number.isFinite(o.level) ? o.level : "?";
      const hpC = typeof o.hpCurrent === "number" && Number.isFinite(o.hpCurrent) ? o.hpCurrent : "?";
      const hpM = typeof o.hpMax === "number" && Number.isFinite(o.hpMax) ? o.hpMax : "?";
      const ac = typeof o.ac === "number" && Number.isFinite(o.ac) ? o.ac : "?";
      const cid = typeof o.combatantId === "string" && o.combatantId.trim() ? o.combatantId.trim() : "";
      const tagUncon = o.unconscious === true ? " — **inconscient / 0 PV**" : "";
      const tagStab = o.stabilized === true ? " — stabilisé (jets contre la mort terminés)" : "";
      const idPart = cid ? ` [id=${cid}]` : "";
      return `- ${name}${idPart} (${who}) : ${race} ${cls} niv.${lvl}, PV ${hpC}/${hpM}, CA ${ac}${tagUncon}${tagStab}`;
    })
    .filter(Boolean);
  if (!lines.length) return "";
  return [
    `=== GROUPE — PERSONNAGES JOUEURS PRÉSENTS ===`,
    `Tu n'es pas seul au monde : voici les PJ de la partie (noms et état utiles pour coopérer, les aider, ou éviter de les ignorer).`,
    lines.join("\n"),
    ``,
  ].join("\n");
}

/**
 * Prompt auto-joueur : uniquement ce qu'un PJ pourrait percevoir.
 * Jamais secrets MJ, encounterEntities, règles d'embuscade, DD, etc.
 */
function buildAutoPlayerSystemPrompt(player, entities, gameMode, battleSnapshot, partyPcs = []) {
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

  const allWeapons = Array.isArray(player?.weapons)
    ? player.weapons.map((w) => (typeof w?.name === "string" ? w.name.trim() : "")).filter(Boolean)
    : [];
  const mainHand = String(player?.equipment?.mainHand ?? "").trim();
  const offHand = String(player?.equipment?.offHand ?? "").trim();
  const hasAnyEquippedHand = !!mainHand || !!offHand;
  const equippedWeaponList = hasAnyEquippedHand
    ? allWeapons.filter((name) => {
        const wn = normFr(name);
        return (mainHand && normFr(mainHand) === wn) || (offHand && normFr(offHand) === wn);
      })
    : allWeapons;
  const weaponList = equippedWeaponList;
  const unequippedWeaponList = allWeapons.filter((name) => !weaponList.includes(name));
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
    `Nom: ${player?.name ?? "Inconnu"}`,
    `Race: ${player?.race ?? "Inconnue"}, Classe: ${player?.entityClass ?? "Inconnue"}, Niveau: ${player?.level ?? "?"}.`,
    `Alignement: ${player?.alignment ?? "Non spécifié"}.`,
    `HP: ${player?.hp?.current ?? "?"}/${player?.hp?.max ?? "?"}, CA: ${
      player?.ac ?? "?"
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
    formatPartyPcsForPrompt(partyPcs),
    `=== REPOS, SOINS DE GROUPE & CAMARADES À TERRE (D&D 5e — à utiliser quand c'est pertinent) ===`,
    `- **Repos court** : environ 1 h, hors danger immédiat ; récupère des PV (dés de vie) et certaines ressources. Tu peux le proposer si le groupe est en sécurité (pas de combat en cours).`,
    `- **Repos long** : 8 h, lieu sûr et calme ; récupération complète des PV et emplacements de sorts, etc. À proposer quand la situation le permet (nuit, campement, etc.).`,
    `- **Camarade à 0 PV** (inconscient) : tu peux tenter de **stabiliser** un allié (action en combat : test de **Médecine** DD 10, ou **trousse de soins** qui consomme une utilisation), ou de **soigner** : sort, **potion**, objet, ou autre moyen légitime sur ta fiche.`,
    `- **Allié stabilisé à 0 PV** : sans soin magique, la récupération peut être **lente** ; à la table de cette campagne, on peut **narrer** qu'un PJ stabilisé regagne **1 PV** après **1d4 heures** de surveillance — tu peux **patienter**, monter la garde, ou chercher des soins plutôt que de presser le groupe à partir tout de suite.`,
    `- **Priorité** : si un allié est à terre ou critique, considère **stabiliser / soigner** (mécaniques réelles : Médecine, trousse, sort, potion) avant d'ignorer la situation. Évite le rôleplay « je me mets devant lui comme bouclier » : le moteur ne donne pas de règle de protection par simple déplacement narratif — ça gaspille souvent le mouvement sans rien changer au combat.`,
    ``,
    weaponLines
      ? [
          `=== ARMES ET TIRS (noms EXACTS reconnus par le jeu) ===`,
          `Tu dois utiliser ces libellés tels quels (orthographe incluse) quand tu annonces une attaque ou un tir.`,
          `IMPORTANT: n'utilise QUE des armes actuellement équipées en main principale/secondaire :`,
          weaponLines,
          unequippedWeaponList.length > 0
            ? `Interdit (non équipées pour l'instant): ${unequippedWeaponList.join(", ")}.`
            : ``,
          ``,
        ].join("\n")
      : ``,
    isCombat && weaponLines
      ? [
          `=== COMBAT — ANNONCER UNE ATTAQUE (CRITIQUE) ===`,
          `Pour frapper ou tirer sur une créature, cite OBLIGATOIREMENT le nom d'UNE arme listée ci-dessus (ex: « épée longue », « arbalète légère »).`,
          `Interdiction stricte: ne propose jamais une arme non équipée (même si elle est dans l'inventaire).`,
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
    `- **Autres PJ (multijoueur)** : INTERDIT de t'adresser par la parole à un autre personnage joueur (celui d'un autre humain à la table) : pas de « Hé, [nom du camarade]… », pas de questions à son intention, pas de dialogue en supposant qu'il répondra. Chaque PJ est joué par son joueur. Tu incarnes uniquement ton personnage : tu peux agir pour aider/soigner un camarade ou décrire ton attitude, mais sans inventer une conversation entre personnages joueurs.`,
    `- INTERDIT de décrire le décor, les résultats, ou les conséquences (rôle du MJ uniquement).`,
    `- INTERDIT de faire des jets, de résoudre une action, ou d'affirmer "ce qui se passe".`,
    `- INTERDIT de demander un jet de dé, un d100, ou d'invoquer des mécaniques/règles cachées du MJ (tu n'y as pas accès).`,
    `- Interagis seulement avec les entités visibles listées plus haut.`,
    isCombat
      ? [
          `- MODE COMBAT : tu es en situation de danger ; priorité au combat utile : **attaquer** un hostile visible (arme nommée), **te rapprocher pour être en mêlée avec un ennemi** si tu es à distance, **Aider** un allié au contact d'un ennemi (action Aider), **stabiliser/soigner** un allié à 0 PV si tu peux. Évite de « protéger » un camarade uniquement par du déplacement théâtral (« je me poste devant lui ») : ce n'est en général **pas** une action mécanique de couverture ici et ça mène souvent à **perdre le mouvement puis terminer le tour sans avoir menacé l'ennemi**.`,
          `- INTERDIT de gaspiller tout le tour sur un simple repositionnement « bouclier humain » sans attaque, sans Aider, sans soin — si tu n'as plus de ressources utiles, **termine le tour** plutôt que de décrire un déplacement vide.`,
          `- La section « ÉTAT DU MOTEUR » indique pour chaque hostile : PV, contact avec toi, et s'il est caché ; sers-toi-en pour mêlée vs distance, Perception, et cibles difficiles.`,
          ``,
          `=== COMBAT — ACTIONS POSSIBLES (CONCEPTS D&D) ===`,
          `Tu ne fais PAS de jets : tu annonces seulement UNE intention ("Je ..."). Le moteur résout la mécanique.`,
          `Chaque tour, choisis au plus UNE de ces intentions :`,
          `- Attaquer : frapper/tirer avec UNE arme (nom EXACT dans ta liste). Exemple: "Je frappe le gobelin avec mon Épée longue."`,
          `- Lancer un sort : uniquement si ton personnage a vraiment un sort pertinent (sinon n'invente pas). Exemple: "Je lance [Nom du sort] sur [cible visible]."`,
          `- Foncer (Dash) : courir / s'éloigner / se rapprocher rapidement. Exemple: "Je fonce pour me mettre à couvert."`,
          `- Se désengager (Disengage) : quitter un contact sans attaque d'opportunité. Exemple: "Je me désengage et recule."`,
          `- Esquiver (Dodge) : se défendre. Exemple: "Je me mets en garde et j'esquive."`,
          `- Aider (Help) : aider un allié (rare si aucun allié visible). Exemple: "J'aide [allié] contre [ennemi]."`,
          `- Se cacher (Hide) : tenter de se dissimuler. Exemple: "Je me cache derrière un rocher."`,
          `- Chercher (Search) : observer/fouiller. Exemple: "Je scrute les fourrés à la recherche d'une menace."`,
          `- Utiliser un objet : ex. boire une potion (si tu en as). Exemple: "Je bois une potion de soin."`,
          `- Se tenir prêt (Ready) : préparer une réaction conditionnelle. Exemple: "Je me tiens prêt: si le gobelin avance, je tire."`,
          `- Repos court (Short Rest) : seulement hors danger immédiat et hors combat actif. Exemple: "Je prends un repos court pour récupérer."`,
          `- Repos long (Long Rest) : seulement hors danger immédiat, hors combat actif, et quand c'est narrativement plausible. Exemple: "Je prends un repos long pour la nuit."`,
          `- Stabiliser un allié à 0 PV : action — test de Médecine ou trousse de soins (voir section REPOS & SOINS).`,
          `- Soigner un allié : sort, potion, objet — si tu en as un sur ta fiche.`,
          ``,
          `Déplacement : tu peux dire "je m'approche", "je recule", "je me mets à couvert", etc. Le moteur gère la distance. Mais ne combine pas déplacement + attaque dans la même phrase (une seule intention).`,
          `Action bonus : n'annonce une action bonus que si ton personnage a réellement une capacité qui le justifie. Sinon, n'en parle pas.`,
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
    `- Les intentions "repos court" et "repos long" sont autorisées si le contexte s'y prête ; annonce-les explicitement en une phrase simple.`,
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
      provider = "gemini",
      battleSnapshot = null,
      partyPcs = [],
    } = body;

    const rawHistory = Array.isArray(historyBody) && historyBody.length
      ? historyBody
      : Array.isArray(messagesBody)
        ? messagesBody
        : [];

    const playerDisplayName = String(player?.name ?? "Joueur").trim() || "Joueur";
    const recentChatScript = formatRecentChatScript(rawHistory, playerDisplayName);

    const basePrompt = buildAutoPlayerSystemPrompt(
      player,
      entities,
      gameMode,
      battleSnapshot,
      Array.isArray(partyPcs) ? partyPcs : []
    );
    const systemPrompt =
      `${basePrompt}\n\n` +
      `=== HISTORIQUE RÉCENT DU CHAT ===\n` +
      `${recentChatScript}\n\n` +
      `Tu dois lire ce fil dans l'ordre : il contient les dernières réponses du Maître du Jeu et tes actions. ` +
      `Ne répète pas une question à laquelle le MJ a déjà répondu.`;

    if (provider === "gemini") {
      const textRaw = (
        await withTerminalAiTiming(
          {
            routePath: "/api/auto-player",
            agentLabel: "Auto-joueur",
            provider: "Gemini",
            model: GEMINI_MODEL,
          },
          async () => {
            const model = genAI.getGenerativeModel({
              model: GEMINI_MODEL,
              systemInstruction: systemPrompt,
              generationConfig: { temperature: 0.9 },
            });
            const result = await model.generateContent(ZERO_SHOT_USER_PROMPT);
            return (result.response.text() || "").trim();
          }
        )
      ).trim();
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
          partyPcsCount: Array.isArray(partyPcs) ? partyPcs.length : 0,
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

    const textRaw = await withTerminalAiTiming(
      {
        routePath: "/api/auto-player",
        agentLabel: "Auto-joueur",
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
        return data.choices?.[0]?.message?.content &&
          typeof data.choices[0].message.content === "string"
          ? data.choices[0].message.content.trim()
          : "";
      }
    );
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
        partyPcsCount: Array.isArray(partyPcs) ? partyPcs.length : 0,
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

