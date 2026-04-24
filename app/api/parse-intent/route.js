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
import { withTerminalAiTiming } from "@/lib/aiTerminalTimingLog";
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
  "intent": null | { "type": "move"|"attack"|"move_and_attack"|"disengage"|"spell"|"dodge"|"second_wind"|"use_item"|"stabilize"|"short_rest"|"end_short_rest"|"long_rest"|"wait"|"wait_until_recover_1hp"|"end_turn"|"loot", "targetId": "" | null, "targetIds": ["id1","id2","id3"], "weapon": "" },
  "rollRequest": null | { "kind": "check"|"save"|"attack"|"gm_secret", "stat": "FOR"|"DEX"|"CON"|"INT"|"SAG"|"CHA", "skill": "Athlétisme", "dc": <nombre>, "raison": "...", "roll": "1d100", "audience": "single"|"global"|"selected", "rollTargetEntityIds": ["id_entité_pj", "..."] },
  "sceneUpdate": null | { "hasChanged": true, "targetRoomId": "..." }
}

MODE (entrée) = combat ou exploration : fixé par le moteur ; tu n’inventes pas le mode, tu appliques les règles du mode courant.

unclear_input : message vide de sens en jeu, spam/métajeu/hors cadre, incohérent, aucune intention D&D raisonnable. Sinon ne pas l’utiliser : action risquée mais claire → requires_roll ou impossible ; maladroite mais compréhensible → interpréter. Une courte relance de dialogue ou de clarification n'est PAS unclear_input si l'historique récent montre qu'un PNJ vient de parler juste avant (ex: "hein ?", "pardon ?", "comment ça ?", "si quoi ?", "de quoi tu parles ?", "qui ça ?").

PAROLE RP vs DESCRIPTION D'ACTION (obligatoire) :
- Si le joueur "parle en personnage" (question, réplique, provocation, promesse, exclamation, discours direct/indirect), traite cela comme une intention sociale, pas comme une action physique implicite.
- Le champ reason doit indiquer clairement qu'il s'agit d'une prise de parole RP / d'une question adressée à un interlocuteur (ex: "Le joueur interpelle les occupants et demande où sont les gobelins.").
- Ne force PAS automatiquement trivial_success/rollRequest=null pour ces cas : choisis la résolution selon l'enjeu réel (trivial_success si sans enjeu, requires_roll si issue sociale incertaine, impossible si hors sens), afin de laisser la décision mécanique au pipeline arbitre/moteur.
- N'invente jamais une attaque, un déplacement, un sort, une fouille ou une interaction technique uniquement parce que le ton est agressif : il faut une intention d'action explicite.

RÈGLE ANTI-CHAÎNE (1 SEULE action majeure par tour) :
- Si le message enchaîne plusieurs actions majeures différentes (ex: « j’attaque X puis je pars vers Y puis je fouille Z »), ne traite que la PREMIÈRE dans l’ordre du texte.
- EXCEPTION OBLIGATOIRE — NAVIGATION + AUTRE CHOSE DANS LE MÊME MESSAGE : si le joueur combine une réaction sociale courte (main sur l’épaule, remerciement, promesse à un PNJ, etc.) ET une formulation claire de départ / trajet / prise de direction vers une zone couverte par les sorties autorisées (voir liste d’indices ci-dessous), tu dois prioriser le changement de lieu pour ce tour : "trivial_success" et sceneUpdate avec "hasChanged": true et "targetRoomId" égal à l’id exact d’une sortie autorisée. Ne réduis pas le message entier au seul geste social : si la partie « je pars / direction / chemin » est présente et matche une sortie, le sceneUpdate est requis.
- Si la première proposition du message est déjà une navigation vers une sortie autorisée, utilise sceneUpdate et ignore la suite (autres actions).
- Si la première proposition est sociale mais une clause suivante (souvent après « puis », « et », virgule ou phrase suivante) exprime le départ vers l’ouest/nord/etc. ou « vers les collines / la piste / rattraper » en cohérence avec une sortie listée, applique l’EXCEPTION ci-dessus.
- EXCEPTION À L’EXCEPTION (priorité plus haute) — SEUIL DE PORTE / PASSAGE SANS TRAVERSÉE : si le message décrit un déplacement **le long d’un couloir / passage** vers une porte ou un seuil **et en même temps** une action **au seuil sans entrer** dans la pièce derrière (écouter à la porte, coller ou tendre l’oreille, épier, regarder par l’entrebâillement ou le trou de la serrure, « percevoir des bruits derrière », inspecter le chambranle/loquet depuis l’extérieur), alors **sceneUpdate = null** : le groupe **reste** dans currentRoomId. Ce n’est **pas** un changement de salle ; l’arbitre de scène gérera Perception ou la fiction au seuil. Exemple : « je suis le couloir ouest et j’écoute à la porte sombre » = suivre le couloir jusqu’à la porte puis écouter, **sans** targetRoomId de la salle au-delà.
- FRANCHISSEMENT EXPLICITE (seul cas sceneUpdate vers l’id de sortie) : formulations du type « j’entre », « je passe / traverse / franchis », « nous empruntons la porte », « j’ouvre et j’avance », « je pousse la porte et je vais dedans », « on va dans [la pièce] » quand c’est clairement la pièce **derrière** l’issue. Seules ces intentions (ou équivalent sans ambiguïté) déclenchent trivial_success + sceneUpdate vers la sortie correspondante.

INDICES DE DÉPART / CHANGEMENT DE LIEU (exploration, à croiser avec « Sorties autorisées » du contexte) :
- Formulations typiques : « je prends la direction de », « je pars vers », « je me mets en route », « je quitte [le village / la forge / les lieux] », « sans attendre vers », « en direction de l’ouest / du nord », « je pars à leur suite », « je rattrape », « je longe la piste », « je suis le chemin vers » (départ réel vers une **autre zone**).
- **Ne confonds pas** « je suis le couloir [direction] » / « j’avance dans le couloir » + action au **seuil** d’une porte (voir règle SEUIL ci-dessus) avec un départ vers la roomId derrière cette porte.
- Dès qu’une intention de **franchissement explicite** correspond à une sortie autorisée, renseigne sceneUpdate avec le targetRoomId de cette sortie. Si le message est ambigu entre « jusqu’à la porte » et « dans la pièce », **ne** fais **pas** sceneUpdate ; préfère trivial_success sans sceneUpdate ou unclear_input factuel. Une seule sortie : choisis-la par correspondance direction/description ; ne pas inventer d’id.

Exploration : trivial_success (sans enjeu) / impossible / requires_roll + rollRequest si conséquence incertaine. DC PHB : 5 très facile, 10 facile, 15 moyen, 20 difficile, 25 très difficile, 30 quasi impossible ; un DC explicite dans le contexte prime. intent=null sauf capacité déclarée.

JETS DE COMPÉTENCE — PLUSIEURS PJ (kind \"check\" uniquement) :
- \"audience\": \"single\" (défaut) = seul le PJ qui a écrit le message lance le jet.
- \"audience\": \"global\" = chaque joueur connecté doit lancer le même test (même DD, même compétence/carac) ; rollTargetEntityIds omis.
- \"audience\": \"selected\" = uniquement certains PJ : remplis \"rollTargetEntityIds\" avec les **id exacts** du bloc Entités (pour les fiches multijoueur : \"mp-player-…\"). Ex. « on fait tous les deux un backflip », « Elyndra et Thorin sautent » : requires_roll + Acrobaties + audience \"selected\" + rollTargetEntityIds listant chaque PJ concerné présent dans Entités. Si tu ne peux pas mapper les noms à des id listés, utilise \"global\" quand toute l’équipe présente doit tenter, sinon \"single\".

EXCEPTION OBLIGATOIRE : "stabiliser / aider / secourir un allié à 0 PV" doit retourner combat_intent (type "stabilize") MEME si MODE=exploration, avec rollRequest=null. Capacités/repos : "second souffle" -> combat_intent + type second_wind ; "repos court", "courte pause pour souffler/se ressourcer" -> combat_intent + type short_rest ; "repos long", "dormir 8h/se reposer pour la nuit" -> combat_intent + type long_rest ; "j'attends Xh / X minutes" sans mention de repos -> combat_intent + type wait (weapon contient les minutes à attendre). Si le joueur dit qu'il attend jusqu'à ce qu'un allié explicitement nommé reprenne connaissance / récupère 1 PV, renvoie combat_intent + type wait_until_recover_1hp avec targetId = id exact de cet allié (si identifiable dans Entités). Ne confonds jamais "courte pause/repos court" avec second_wind. Loot/fouille corps → trivial_success. **Franchissement** vers sortie listée (voir règles SEUIL / FRANCHISSEMENT ci-dessus) → trivial_success + sceneUpdate(targetRoomId) ; matcher direction ou description aux sorties autorisées ; ne pas inventer de sortie. SÉMANTIQUE DE NAVIGATION À RESPECTER STRICTEMENT : "je me dirige vers", "je vais vers", "je m'approche de", "je me rapproche de", "je marche jusqu'à" une porte / issue / sortie = seulement s'en approcher ou rester au seuil, jamais l'ouvrir, la franchir, la crocheter ni la forcer ; couplé à « écouter / épier / regarder par… » → **pas** de sceneUpdate. "j'ouvre", "je pousse la porte", "je tente la porte", "j'essaie d'ouvrir", "je crochette", "je force", "j'enfonce" = interaction avec la porte ; si le verrou ou la résistance créent une incertitude, alors seulement requires_roll ou impossible. "j'entre", "je passe", "je franchis", "je traverse", "je vais dedans", "j'y vais" = franchissement / passage vers l'autre salle, mais seulement si l'historique récent montre que le personnage est déjà au seuil ou qu'une seule issue immédiate cohérente est en train d'être suivie ; sinon interpréter "j'y vais" comme trop ambigu plutôt que comme une nouvelle action technique. N'infère jamais de crochetage ou de forçage uniquement parce que les secrets mentionnent une serrure, une clef, un verrou ou un DD : il faut une intention explicite du joueur d'ouvrir malgré l'obstacle ou d'interagir avec la serrure. Si le joueur dit juste "j'avance / j'explore / je continue" et que plusieurs sorties sont possibles sans précision unique, ne choisis jamais à sa place : renvoie unclear_input avec une reason factuelle et procédurale (destinée au moteur/narrateur, pas au joueur) qui résume brièvement l'ambiguïté. Quand le joueur parle à un PNJ présent ou lui pose une question, ce n'est presque jamais un jet joueur : par défaut renvoie trivial_success (ou impossible si la demande n'a aucun sens), avec intent=null et rollRequest=null. Même logique pour une parole RP adressée à un groupe/ennemi ("Où sont les gobelins ?", "Rendez-vous !", "Qui est là ?") : traiter comme prise de parole, pas comme action physique implicite. Une réplique très courte qui réagit au dernier message d'un PNJ doit être interprétée à la lumière de l'historique récent comme une demande de précision ou une continuation de dialogue, même si elle n'exprime pas une intention complète toute seule. Exemples : "Heu si quoi ?", "Comment ça ?", "Pardon ?", "Qui ça ?", "De quoi tu parles ?" → trivial_success, pas unclear_input, si le dernier message assistant contient une réplique PNJ ou une phrase inachevée. Pour ces questions sociales, ton reason doit rester procédural et neutre : décris que le joueur demande une précision, relance la dernière réplique, ou interroge un PNJ / des villageois sur tel sujet ; ne décide pas toi-même du contenu vrai de la réponse. N'invente jamais un skillcheck pour un PNJ, les skillcheck sont pour les joueurs ; si l'incertitude porte sur ce que le PNJ sait, croit, ose dire ou se rappelle, ne demande pas de check/save joueur. Pièges/patrouilles/d100 imposés par le lieu : ne pas utiliser gm_secret ici (l’arbitre de scène et les secrets s’en occupent) ; si besoin, requires_roll avec check/save joueur. [SceneEntered] = navigation déjà traitée, pas de jet MJ ici.

OBJET (exploration ou combat) : boire / utiliser une potion ou consommable listé dans l'inventaire joueur → resolution="combat_intent", intent.type="use_item", weapon = nom exact ou proche (ex. "Potion de soins"), targetId = id de la créature alliée si le joueur la cible explicitement, sinon "" pour soi-même. En combat, donner une potion à un allié n'est valide que si son id figure dans playerMeleeTargets (contact) ; sinon impossible avec reason courte.

MÉDECINE / STABILISATION (priorité haute) :
- Si l'intention est de stabiliser / aider / secourir un allié à 0 PV, tu dois répondre "resolution=combat_intent" avec "intent.type=stabilize" et "rollRequest=null".
- Interdiction de répondre "requires_roll" pour une stabilisation : le moteur déclenche lui-même le jet de Médecine.
- Cette règle s'applique en combat ET hors combat.
- En combat, le contact au corps à corps est requis (D&D 5e) ; si pas de contact, renvoie "impossible" (ou "combat_intent" type "move" pour s'approcher), jamais "requires_roll".

Combat : intent parmi move, attack, move_and_attack, disengage, spell, dodge, second_wind, use_item, stabilize, short_rest, end_short_rest, long_rest, wait_until_recover_1hp, end_turn, loot ; playerMeleeTargets distingue attack vs move_and_attack ; disengage/dodge/end_turn/second_wind/short_rest/long_rest : targetId peut être "" ou null. rollRequest=null et sceneUpdate=null.

SORTS MULTI-CIBLES (important) :
- Pour un sort visant plusieurs créatures (ex: Bénédiction), renseigne intent.targetIds avec les ids exacts des bénéficiaires (max 3 pour Bénédiction), dans l'ordre voulu.
- intent.targetId peut rester vide dans ce cas, ou contenir la cible principale.
- N'invente jamais d'id : utilise uniquement les ids présents dans Entités.

RESSOURCES DE TOUR (Action, bonus, mouvement, réaction) : tu ne reçois pas cet état dans le message joueur. Ne déduis jamais resolution="impossible" du seul fait qu'il « manquerait » une Action, du mouvement ou une action bonus : le moteur client vérifie et affiche les refus. Dès que l'intention de combat est claire, renvoie combat_intent (ou move / attack selon le schéma).

DÉPLACEMENT TACTIQUE (intent.type "move") — rapprochement vs repositionnement sans contact au corps à corps :
- targetId OBLIGATOIREMENT vide ("" ou null) si le joueur se déplace sans viser l'engagement au contact d'une créature précise : abri, couvert, obstacle, reculer, s'éloigner, prendre de la distance, se placer loin, contourner sans clore, fuir le contact. Même si une créature est nommée (« je m'éloigne du gobelin »), si l'intention est de s'éloigner ou de se repositionner sans aller au contact de cette créature, targetId reste vide. Le moteur déplace sans rapprochement forcé vers une créature.
- targetId = id EXACT d'une entrée de Entités seulement pour se rapprocher / avancer vers / aller au contact / rejoindre au corps à corps cette créature. Ne mets jamais un targetId de créature pour un déplacement qui vise à s'éloigner d'elle.

Le moteur consomme le mouvement. Ne pas utiliser trivial_success ni sceneUpdate pour le combat tactique. RÈGLE IMPÉRATIVE : en combat, si l'intention du joueur est d'attaquer, de lancer un sort offensif, de se déplacer pour frapper, ou plus généralement d'accomplir une action de combat standard résolue par le moteur, tu dois répondre "combat_intent" avec intent renseigné, JAMAIS "requires_roll". Le jet d'attaque ou les dégâts seront gérés ensuite par le moteur client ; toi tu ne demandes pas un skillcheck, tu décris seulement l'intention de combat structurée. "requires_roll" en combat est réservé aux cas exceptionnellement hors grammaire de combat standard.

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
    .map((e) => {
      const hpCurrent =
        typeof e?.hp?.current === "number" && Number.isFinite(e.hp.current)
          ? Math.trunc(e.hp.current)
          : null;
      const hpMax =
        typeof e?.hp?.max === "number" && Number.isFinite(e.hp.max)
          ? Math.trunc(e.hp.max)
          : null;
      const ds = e?.deathState && typeof e.deathState === "object" ? e.deathState : null;
      const conditions = Array.isArray(e?.conditions)
        ? e.conditions.map((x) => String(x ?? "").trim()).filter(Boolean)
        : [];
      return {
        id: String(e.id).trim(),
        name: String(e.name ?? e.id).trim(),
        type: String(e.type ?? "").trim() || null,
        visible: e.visible !== false,
        isAlive: e.isAlive !== false,
        hp:
          hpCurrent != null
            ? {
                current: hpCurrent,
                max: hpMax,
              }
            : null,
        deathState:
          ds != null
            ? {
                stable: ds.stable === true,
                unconscious: ds.unconscious === true,
                dead: ds.dead === true,
              }
            : null,
        conditions,
      };
    });
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
      const senderName = String(m.senderName ?? "").trim();
      const speaker =
        role === "assistant" ? "MJ" : senderName || "Joueur";
      return {
        role,
        speaker,
        type: m.type ?? null,
        content,
      };
    })
    .filter(Boolean);
}

function normalizeForIntentPostProcess(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveDownedAllyTargetId(rawText, entities) {
  const pool = Array.isArray(entities) ? entities : [];
  const candidates = pool.filter((e) => {
    if (!e || String(e.type ?? "").toLowerCase() === "hostile") return false;
    const id = String(e.id ?? "").trim();
    if (!id) return false;
    const hp = typeof e?.hp?.current === "number" && Number.isFinite(e.hp.current) ? Math.trunc(e.hp.current) : null;
    if (hp == null || hp > 0) return false;
    const ds = e?.deathState && typeof e.deathState === "object" ? e.deathState : null;
    if (ds?.dead === true) return false;
    return true;
  });
  if (candidates.length === 0) return "";
  const t = normalizeForIntentPostProcess(rawText);
  if (t) {
    const named = candidates
      .map((e) => ({
        id: String(e.id ?? "").trim(),
        nameNorm: normalizeForIntentPostProcess(e.name ?? e.id),
      }))
      .filter((x) => x.id && x.nameNorm.length >= 3);
    const hit = named.find((x) => t.includes(x.nameNorm) || x.nameNorm.includes(t));
    if (hit?.id) return hit.id;
  }
  if (candidates.length === 1) {
    return String(candidates[0]?.id ?? "").trim();
  }
  return "";
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
  playerInventoryLines,
  turnResources: _turnResourcesUnused,
  messages,
}) {
  const entBlock =
    entities.length === 0
      ? "(Aucune entité fournie.)"
      : entities
          .map(
            (e) =>
              `- id: "${e.id}", name: "${e.name}", type: "${e.type ?? ""}", visible: ${e.visible}, isAlive: ${e.isAlive}, hp: ${e?.hp?.current ?? "?"}/${e?.hp?.max ?? "?"}, deathState: stable=${e?.deathState?.stable === true}, unconscious=${e?.deathState?.unconscious === true}, dead=${e?.deathState?.dead === true}, conditions: [${Array.isArray(e?.conditions) ? e.conditions.map((c) => `"${c}"`).join(", ") : ""}]`
          )
          .join("\n");
  const wBlock =
    weaponNames.length === 0
      ? "(Aucune liste fournie.)"
      : weaponNames.map((n) => `- ${n}`).join("\n");
  const meleeBlock =
    meleeTargetIds.length === 0
      ? "(Aucune créature au contact du joueur pour la mêlée.)"
      : meleeTargetIds.map((id) => `- "${id}"`).join("\n");
  const invLines = Array.isArray(playerInventoryLines) ? playerInventoryLines : [];
  const invBlock =
    invLines.length === 0
      ? "(Inventaire non fourni ou vide.)"
      : invLines.map((line) => `- ${line}`).join("\n");
  const exitsBlock =
    allowedExits.length === 0
      ? "(Aucune sortie autorisée fournie.)"
      : allowedExits
          .map(
            (e) =>
              `- id: "${e.id}", direction: "${e.direction || "(non précisée)"}", description: "${e.description || "(non précisée)"}"`
          )
          .join("\n");
  const trBlock =
    "Ressources de tour : non indiquées dans ce prompt — le moteur client valide Action / bonus / mouvement / réaction ; n'utilise pas resolution=\"impossible\" pour un manque de ressource supposé.";
  const combatMovementHint =
    gameMode === "combat"
      ? `COMBAT — DÉPLACEMENT (move) :
- Zone libre, abri, couvert, reculer, s'éloigner d'un adversaire (même nommé), prendre du champ : intent.type="move", targetId "" ou null. Ne pas remplir targetId avec l'id d'une créature si le joueur s'éloigne d'elle.
- Rapprochement / aller au contact d'une créature listée dans Entités : intent.type="move", targetId = id exact (une seule cible de mêlée).`
      : "";
  const historyBlock =
    messages.length === 0
      ? "(Aucun historique fourni.)"
      : messages
          .map((m) => {
            const speaker = String(m?.speaker ?? "").trim() || (m.role === "assistant" ? "MJ" : "Joueur");
            return `- ${speaker}${m.type ? ` [${m.type}]` : ""}: ${m.content}`;
          })
          .join("\n");

  return [
    `MODE: ${gameMode === "combat" ? "combat" : "exploration"}`,
    `currentRoomId: ${String(currentRoomId ?? "").trim() || "(inconnu)"}`,
    `currentScene: ${String(currentScene ?? "").trim() || "(inconnue)"}`,
    `currentRoomSecrets: ${String(currentRoomSecrets ?? "").trim() || "(aucun)"}`,
    trBlock,
    combatMovementHint,
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
    `Inventaire du PJ (lignes empilées) :`,
    invBlock,
    ``,
    `Créatures au contact du joueur (mêlée — alliés et ennemis, pour potion à un allié en combat) :`,
    meleeBlock,
    ``,
    `Armes / sorts connus côté joueur :`,
    wBlock,
    ``,
    `Sorties autorisées :`,
    exitsBlock,
    allowedExits.length > 0
      ? `Si le texte joueur exprime un **franchissement explicite** ou un départ sans ambiguïté vers une autre zone (et **pas** une action au seuil : écouter à la porte, épier, etc. — voir règles système SEUIL), resolution = trivial_success et sceneUpdate obligatoire avec hasChanged: true et targetRoomId = l’id de cette sortie. Si le message mélange couloir + écoute / observation à la porte fermée, sceneUpdate = null.`
      : ``,
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
        "end_short_rest",
        "long_rest",
        "wait",
        "stabilize",
        "wait_until_recover_1hp",
        "end_turn",
        "loot",
        "use_item",
      ]);
      if (!allowedTypes.has(type)) {
        return { ok: false, error: `intent.type invalide: ${type || "(vide)"}` };
      }
      intent = {
        type,
        targetId: data.intent.targetId == null ? "" : String(data.intent.targetId).trim(),
        targetIds: Array.isArray(data.intent.targetIds)
          ? [...new Set(data.intent.targetIds.map((x) => String(x ?? "").trim()).filter(Boolean))]
          : [],
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
        if (kindRoll === "check") {
          const audRaw = String(data.rollRequest.audience ?? "single").trim().toLowerCase();
          const audience =
            audRaw === "global" ? "global" : audRaw === "selected" ? "selected" : "single";
          const rawTids = data.rollRequest.rollTargetEntityIds;
          const rollTargetEntityIds =
            audience === "selected" && Array.isArray(rawTids)
              ? [...new Set(rawTids.map((x) => String(x ?? "").trim()).filter(Boolean))]
              : undefined;
          if (audience === "global") {
            rollRequest.audience = "global";
          } else if (audience === "selected" && rollTargetEntityIds?.length) {
            rollRequest.audience = "selected";
            rollRequest.rollTargetEntityIds = rollTargetEntityIds;
          }
        }
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

/** Filtre audience/rollTargetEntityIds sur les id réellement présents dans Entités. */
function sanitizeIntentRollRequestAgainstEntities(rollRequest, entList) {
  if (!rollRequest || rollRequest.kind !== "check") return rollRequest;
  const entityIds = new Set(
    (Array.isArray(entList) ? entList : [])
      .map((e) => (e && e.id != null ? String(e.id).trim() : ""))
      .filter(Boolean)
  );
  const aud = String(rollRequest.audience ?? "single").trim().toLowerCase();
  if (aud === "global") {
    const { rollTargetEntityIds: _t, ...rest } = rollRequest;
    return { ...rest, audience: "global" };
  }
  if (aud === "selected") {
    const raw = rollRequest.rollTargetEntityIds;
    const ids = Array.isArray(raw)
      ? [...new Set(raw.map((x) => String(x ?? "").trim()).filter((id) => entityIds.has(id)))]
      : [];
    if (!ids.length) {
      const { audience: _a, rollTargetEntityIds: _r, ...rest } = rollRequest;
      return rest;
    }
    return { ...rollRequest, audience: "selected", rollTargetEntityIds: ids };
  }
  const { audience: _a, rollTargetEntityIds: _r, ...rest } = rollRequest;
  return rest;
}

function sanitizeIntentTargetIdsAgainstEntities(intent, entList) {
  if (!intent || typeof intent !== "object") return intent;
  const rawTargetIds = Array.isArray(intent.targetIds) ? intent.targetIds : [];
  if (!rawTargetIds.length) return { ...intent, targetIds: [] };
  const entityIds = new Set(
    (Array.isArray(entList) ? entList : [])
      .map((e) => (e && e.id != null ? String(e.id).trim() : ""))
      .filter(Boolean)
  );
  const targetIds = [...new Set(rawTargetIds.map((x) => String(x ?? "").trim()).filter((id) => entityIds.has(id)))];
  return { ...intent, targetIds };
}

// Aucune heuristique locale basée sur des mots-clés utilisateur ici.
// Toute l'interprétation d'intention passe par le modèle parse-intent.

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      text,
      entities = [],
      playerWeapons = [],
      playerMeleeTargets = [],
      playerInventory = [],
      turnResources = null,
      provider = "gemini",
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

    // IMPORTANT: aucune interprétation déterministe locale du texte joueur.
    // L'intention est décidée uniquement par le modèle parse-intent.

    const entList = normalizeEntitiesForPrompt(entities);
    const weaponNames = normalizeWeaponList(playerWeapons);
    const meleeIds = normalizeMeleeTargetIds(playerMeleeTargets);
    const invLines = Array.isArray(playerInventory)
      ? playerInventory.map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];
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
      playerInventoryLines: invLines,
      turnResources,
      messages: normalizedMessages,
    });

    if (provider === "gemini" && !process.env.GEMINI_API_KEY) {
      return NextResponse.json({ error: "GEMINI_API_KEY manquant." }, { status: 500 });
    }
    if (provider !== "gemini" && !process.env.OPENROUTER_API_KEY) {
      return NextResponse.json({ error: "OPENROUTER_API_KEY manquant." }, { status: 500 });
    }

    const rawOut = await withTerminalAiTiming(
      {
        routePath: "/api/parse-intent",
        agentLabel: "Parseur d'intentions",
        provider: provider === "gemini" ? "Gemini" : "OpenRouter",
        model: provider === "gemini" ? GEMINI_MODEL : OPENROUTER_MODEL,
      },
      async () => {
        if (provider === "gemini") {
          const model = genAI.getGenerativeModel({
            model: GEMINI_MODEL,
            systemInstruction: ARBITER_SYSTEM,
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.2,
            },
          });
          const result = await model.generateContent(userContent);
          return (result.response.text() || "").trim();
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
        return typeof data?.choices?.[0]?.message?.content === "string"
          ? data.choices[0].message.content.trim()
          : "";
      }
    );

    const parsed = safeParseArbiterJson(rawOut);
    let parsedDecision = parsed.ok ? parsed.parsed : null;
    if (parsedDecision) {
      const skillNorm = normalizeForIntentPostProcess(parsedDecision?.rollRequest?.skill ?? "");
      const intentTypeNorm = normalizeForIntentPostProcess(parsedDecision?.intent?.type ?? "");
      const mentionsStabilizeInReason = /stabilis|secour|aide/.test(
        normalizeForIntentPostProcess(parsedDecision?.reason ?? "")
      );
      const isMedicineCheckFallback =
        parsedDecision.resolution === "requires_roll" &&
        (
          (parsedDecision.intent == null &&
            parsedDecision.rollRequest?.kind === "check" &&
            skillNorm === "medecine") ||
          intentTypeNorm === "stabilize" ||
          mentionsStabilizeInReason
        );
      if (isMedicineCheckFallback) {
        const source = `${String(text ?? "")} ${String(parsedDecision?.rollRequest?.raison ?? "")}`.trim();
        const targetId = resolveDownedAllyTargetId(source, entList);
        parsedDecision = {
          resolution: "combat_intent",
          reason:
            parsedDecision?.reason && String(parsedDecision.reason).trim()
              ? String(parsedDecision.reason).trim()
              : "Tentative de stabilisation d'un allié à 0 PV.",
          intent: {
            type: "stabilize",
            targetId: targetId || "",
            weapon: "Médecine",
          },
          rollRequest: null,
          sceneUpdate: null,
        };
      }
      if (parsedDecision?.rollRequest) {
        parsedDecision.rollRequest = sanitizeIntentRollRequestAgainstEntities(
          parsedDecision.rollRequest,
          entList
        );
      }
      if (parsedDecision?.intent) {
        parsedDecision.intent = sanitizeIntentTargetIdsAgainstEntities(parsedDecision.intent, entList);
      }
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
      parsed.ok ? parsedDecision : { error: parsed.error, raw: truncate(rawOut, 500) }
    );

    if (!parsed.ok) {
      return NextResponse.json(
        {
          resolution: "unclear_input",
          reason: "Réponse parse-intent invalide (sortie modèle non JSON/format incorrect).",
          intent: null,
          rollRequest: null,
          sceneUpdate: null,
        },
        { status: 200 }
      );
    }

    return NextResponse.json({
      ...parsedDecision,
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
