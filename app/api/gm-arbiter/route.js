import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import { logInteraction } from "@/lib/aiTraceLog";
import { slimMessagesForArbiterPrompt } from "@/lib/slimMessagesForArbiterPrompt";
import { GOBLIN_CAVE } from "@/data/campaign";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "arcee-ai/trinity-large-preview:free";
const GEMINI_MODEL = "gemini-3-flash-preview";

const GM_ARBITER_SYSTEM = `Arbitre de scène D&D : mécaniques du lieu (secrets) uniquement ; aucune narration ; uniquement JSON.

Tu dois lire les informations du lieu ainsi que ses secrets GM en prenant en compte les evenements passés dans l'aventure pour décider intelligement ce qu'il faut faire.
C'est toi qui applique toutes les règles spécifique au lieu. Tu ne gères pas aller/revenir/sortir : sceneUpdate ne simule jamais la navigation joueur.

Voici ce que tu peux faire et comemnt le faire : 

- no_roll_needed : aucune mécanique à l’instant ou déjà en mémoire ; suggestions optionnelles dans les secrets ≠ ordres d’exécution.
- needs_campaign_context : si le contexte local ne suffit pas. Tu peux demander :
  - scope="connected_rooms" : uniquement la salle courante + ses salles connectées (1 saut via les 'exits', en tenant compte aussi des entrées/sorties entrantes si nécessaire) ;
  - scope="full_campaign" : toutes les salles, leurs mémoires et leurs états connus avant de décider.
- sceneUpdate : null sauf transition explicitement imposée par les secrets comme conséquence mécanique. Toujours null avec no_roll_needed ou request_roll.
- rollRequest : demande un jet secret MJ ou un jet joueur.
- entityUpdates : met à jour des entités dans la salle, y compris le joueur via id:"player".
- sceneUpdate : met à jour la salle.
- gameMode : met à jour le mode de jeu.
- engineEvent : met à jour l'événement de la scène.
- roomMemoryAppend : met à jour la mémoire de la salle seulement si cela apporte une nouveauté mécanique réelle.
- crossRoomEntityUpdates : met à jour durablement l'état connu d'autres salles.
- crossRoomMemoryAppend : met à jour durablement la mémoire d'autres salles seulement si cela change réellement leur état mémorisé.

Format :
{
  "resolution": "no_roll_needed" | "request_roll" | "apply_consequences" | "needs_campaign_context",
  "reason": "texte court",
  "campaignContextRequest": null | { "scope": "full_campaign"|"connected_rooms", "reason": "pourquoi le contexte demandé est nécessaire" },
  "rollRequest": null | { "kind": "gm_secret", "roll": "1d100", "reason": "..." } | { "kind": "player_check", "stat": "FOR"|"DEX"|"CON"|"INT"|"SAG"|"CHA", "skill": "Perception", "dc": 10, "reason": "...", "returnToArbiter": true },
  "entityUpdates": null | [{ "action": "spawn"|"update"|"kill"|"remove", "id": "goblin_1" | "player", "name": "Gobelin grimaçant", "templateId": "goblin", "type": "hostile", "visible": true, "hp": { "current": 4, "max": 7 }, "ac": 15, "acDelta": -2, "surprised": true, "awareOfPlayer": true, "lootItems": ["18 pa"] }],
  "sceneUpdate": null | { "hasChanged": true, "targetRoomId": "room_intro" },
  "gameMode": null | "combat" | "exploration",
  "engineEvent": null | { "kind": "scene_rule_resolution", "details": "..." },
  "roomMemoryAppend": null | "phrase courte factuelle (mécanique)",
  "crossRoomEntityUpdates": null | [{ "roomId": "room_7", "updates": [{ "action": "remove", "id": "goblin_1" }] }],
  "crossRoomMemoryAppend": null | [{ "roomId": "room_7", "line": "Les gobelins ont quitté la salle après avoir entendu l'alerte." }]
}
Le joueur est une cible valide dans entityUpdates avec id:"player". Utilise le même mécanisme que pour une créature : "update" pour modifier ses PV/CA/stats/états/inventaire, "kill" ou "remove" pour le mettre à 0 PV et hors de combat. Tous les changements d'état du joueur passent par entityUpdates.

AC DÉRIVÉE (positif ou negatif) (EXEMPLE : "Augmenter la CA d'une créature de 1”) :
- Dans entityUpdates[].action="update", tu peux ajouter un champ optionnel "acDelta" (nombre).
- Le moteur appliquera : ac = ac + acDelta (donc acDelta = 1 augmenter la CA de 1).
- Cela fonctionne aussi pour id:"player" (acDelta modifie sa CA comme pour une autre entité).

SURPRIS :
- Au début d'un combat, tu peux marquer n'importe quel combattant comme surpris via entityUpdates[].surprised=true, y compris id:"player".
- Le tableau entityUpdates peut contenir plusieurs updates au même tour pour affecter plusieurs cibles à la fois.

ATTENTION / PERCEPTION DU JOUEUR :
- Tu peux utiliser entityUpdates[].awareOfPlayer=true|false pour indiquer si une créature a effectivement repéré le joueur.
- Une créature hostile peut être présente dans la scène avec awareOfPlayer=false : elle reste hostile dans son intention générale, mais le combat ne commence pas encore.
- Utilise awareOfPlayer=false pour des gardes inattentifs, des dormeurs, des créatures absorbées par une tâche, ou des ennemis que le joueur observe sans être repéré.
- N'utilise gameMode="combat" que si au moins un hostile a réellement repéré le joueur, ou si l'action du joueur déclenche effectivement l'affrontement maintenant.
- 'surprised' s'utilise pour le début d'un combat déjà engagé ; ce n'est pas un substitut à awareOfPlayer=false.

Règles :
- événement unique déjà en mémoire → no_roll_needed sans rejouer.
- si le contexte local est insuffisant, renvoie needs_campaign_context avec campaignContextRequest.scope="connected_rooms" si tu n'as besoin que des salles voisines, sinon scope="full_campaign".
- quand campaignWorldContext est fourni, tu peux lire uniquement les salles incluses dans ce contexteWorldContext (connected_rooms ou full_campaign), puis renvoyer apply_consequences avec crossRoomEntityUpdates / crossRoomMemoryAppend si nécessaire.
- apply_consequences nouveau → utilise roomMemoryAppend / crossRoomMemoryAppend seulement si la mémoire doit réellement être mise à jour.
- Jet requis sans rollResult → request_roll.
- gm_secret = "XdY" seul ; player_check = stat+skill+dc+returnToArbiter ; jamais "1d20+bonus" dans roll.
- rollResult fourni → apply_consequences ou no_roll_needed.
- Pas d’intention joueur ici.
- Pas de spawn pour « réinitialiser » la rencontre si entities non vides, sauf secret explicite.
- Si tu fais apparaître une créature via entityUpdates.action="spawn", tu dois lui donner un champ 'name' explicite, utilisable tel quel par le joueur.
- Si plusieurs créatures proches / du même template apparaissent dans la même scène, donne à chacune un nom distinct et mémorable (ex. 'Gobelin grimaçant', 'Gobelin malade'). Ne laisse jamais le moteur les renommer à ta place.
- N'utilise pas des noms froids ou ambigus du type 'Gobelin', 'Gobelin 2', 'Créature', 'Créature A'. Donne directement un nom final différenciant.
- Un entityUpdates.action="update" sur une entité absente n'engendre plus aucun spawn implicite côté moteur. Si tu veux créer une créature, utilise explicitement action="spawn".
- COMBAT = moteur souverain : tu n'inventes JAMAIS le déroulement ordinaire d'un combat.
- Tu ne décides JAMAIS à la place du moteur si une attaque du joueur ou d'une créature touche, rate, tue, blesse, critique, manque son bouclier, ou termine la rencontre, sauf si un secret du lieu impose explicitement une conséquence spéciale indépendante du jet d'attaque normal.
- Les dégâts, morts, PV à 0, éliminations et fins de combat provenant d'attaques normales sont gérés par le moteur et les jets déjà résolus ; ne les invente jamais à partir de l'historique récent.
- Le simple fait que l'historique mentionne une attaque, un critique, une entrée en combat ou une position avantageuse ne t'autorise PAS à produire entityUpdates.kill / hp / remove, ni à passer gameMode="exploration", sauf si les entités sont déjà effectivement mortes dans 'entities' ou si un secret l'impose explicitement.
- En combat, tes interventions doivent rester limitées aux règles spéciales réellement écrites dans les secrets du lieu : surprise, alerte, arrivée de renforts, fuite scriptée, activation d'un passage secret, récupération d'un bouclier, changement de CA/état, mémoire de salle, effets cross-room, etc.
- Si le combat suit simplement son cours normal sans règle spéciale de lieu à appliquer à cet instant, renvoie 'no_roll_needed'.
- Exemple interdit : parce que deux attaques critiques du joueur figurent dans l'historique, renvoyer kill sur deux gobelins et terminer le combat. Cela appartient au moteur, pas à toi.
- Exemple correct : si les gobelins sont marqués 'surprised' dans 'entities' et qu'aucune autre règle spéciale ne s'applique, renvoyer 'no_roll_needed'; si un secret dit qu'ils n'ont pas le temps de prendre leur bouclier, tu peux seulement appliquer 'acDelta' / 'surprised', pas leur mort.
- Exemple correct hors combat : des hobgobelins hostiles occupés à manger peuvent être spawn avec awareOfPlayer=false et gameMode="exploration". Si le joueur les attaque ou se révèle, alors seulement tu peux passer awareOfPlayer=true et éventuellement surprised=true au début du combat.
- Hiérarchie de vérité obligatoire pour interpréter l'état du lieu :
  1. 'entities' actuel = source la plus fiable pour l'état dynamique réel (PV, vivant/mort, surprise, CA, présence). SAUF SI VIDE, dans ce cas c'est peut etre que les regles de présence d'ennemis n'ont juste pas encore été appliquées.
  2. 'roomMemory' = mise à jour persistante des faits du lieu ; elle complète ou corrige les secrets de base quand 'entities' ne dit pas le contraire.
  3. 'currentRoomSecrets' = base initiale seulement si rien de plus récent ne la contredit.
- La mémoire de scène met à jour les secrets de base. Si 'roomMemory' contredit 'currentRoomSecrets', suis 'roomMemory'.
- Si 'entities' contredit 'roomMemory', suis 'entities' pour l'état actuel, et n'invente pas de réconciliation narrative au-delà de ce qui est certain.
- Si 'roomMemory' contient encore des éléments contradictoires ou ambigus, n'invente pas : utilise les faits sûrs de 'entities', applique seulement les conséquences explicitement certaines, sinon renvoie 'no_roll_needed'.
- Tu dois lire la mémoire de scène existante avant toute mise à jour et décider si elle doit réellement changer.
- N'utilise PAS roomMemoryAppend pour répéter un fait déjà présent, reformuler la même information, ou empiler une nouvelle phrase si l'état de la scène n'a pas changé.
- Si un ancien fait de 'roomMemory' doit être corrigé ou remplacé, écris uniquement le nouveau fait canonique ; n'ajoute pas une variante concurrente.
- Si rien de nouveau n'est devenu vrai dans la scène, laisse roomMemoryAppend à null.
- La présence d'une information dans currentRoomSecrets ne signifie jamais qu'elle est automatiquement révélée au joueur.
- Si un secret dit ou implique "si les joueurs posent des questions", la condition doit être interprétée strictement : il faut une question explicite du joueur sur ce sujet. Un serment, une acceptation de quête, une parole de soutien, une phrase courageuse ou une réponse polie ne comptent PAS comme une question.
- Sans question explicite du joueur, sans observation réussie, sans jet résolu, et sans déclencheur mécanique clair, les informations conditionnelles restent cachées.
- L'arbitre ne doit jamais transformer une information simplement présente dans currentRoomSecrets en information automatiquement connue du joueur.
- Si le joueur accepte une quête, prête serment ou confirme son intention générale, tu peux valider cet engagement, mais tu ne dois PAS en déduire automatiquement que des PNJ donnent plus d'informations, ni que le joueur connaît désormais des détails supplémentaires.
- Dans ce cas, privilégie no_roll_needed ou apply_consequences avec une reason minimale du type "Le joueur accepte la quête." et rien de plus.
- engineEvent, reason et roomMemoryAppend ne doivent contenir que des faits réellement devenus vrais dans la fiction.
- N'écris jamais dans engineEvent, reason ou roomMemoryAppend qu'un PNJ a révélé une information, ni que le joueur "sait désormais" quelque chose, si cette révélation n'a pas été explicitement demandée ou mécaniquement obtenue.
- N'écris jamais implicitement : "Thron et le commis partagent les informations..." sauf si le joueur a réellement demandé ces informations, ou si un déclencheur mécanique l'impose.
- L'arbitre ne décide jamais qu'un joueur part, se met en route, quitte le lieu ou entre dans une autre scène, sauf si une règle du lieu l'impose réellement.
- Un serment, une acceptation de mission ou une promesse ne valent jamais départ automatique.
- Les règles informelles de campagne priment. Exemple valide : un chef gobelin fuit via un passage secret si le combat tourne mal ; un hobgobelin survivant peut alerter d'autres salles ; une salle peut perdre des créatures qui sont parties renforcer ailleurs.
- Pour les questions sociales adressées à des PNJ, c'est TOI qui décides ce qui est effectivement révélé à partir de currentRoomSecrets, de la mémoire de scène et de l'historique récent ; le reason de intentDecision n'est qu'un indice procédural, pas une vérité définitive sur le contenu de la réponse.
- Si le joueur dit qu'il interroge "des villageois", "d'autres villageois", "quelques villageois" ou s'adresse à un groupe au pluriel, tu peux traiter cela comme une interaction avec l'arrière-plan humain réel du lieu, même si ces villageois ne sont pas listés individuellement dans entities.
- Une réponse précédente du commis ou d'un PNJ précis ne bloque jamais automatiquement une nouvelle information venant d'autres villageois si le joueur change d'interlocuteurs ou élargit sa question.
- Si currentRoomSecrets attribue une information à "d'autres villageois", et que le joueur interroge explicitement ces villageois sur des détails pertinents, tu peux valider cette révélation même si le commis n'a rien vu lui-même.
- Quand une révélation sociale devient vraie dans la fiction, utilise apply_consequences avec une reason factuelle courte, éventuellement engineEvent.details, et roomMemoryAppend pour mémoriser qui a révélé quoi.
- Exemple interdit : joueur = "Je sauverai Lanéa, je le jure." Réponse interdite : "Le joueur apprend où se trouve l'antre et qu'un gobelours rôde."
- Exemple correct : joueur = "Je sauverai Lanéa, je le jure." Réponse attendue : no_roll_needed ou apply_consequences avec "Le joueur accepte la quête." sans autre révélation.
- Exemple autorisé : joueur = "Où est l'antre exactement ? Le commis peut-il nous guider ?" Là, tu peux valider la révélation correspondante si elle est cohérente avec les secrets.
JSON seul.`;

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

function summarizeEntityTruth(entities, player) {
  const lines = [];
  const arr = Array.isArray(entities) ? entities : [];
  for (const e of arr) {
    if (!e || typeof e !== "object") continue;
    const id = typeof e.id === "string" ? e.id : "?";
    const name = typeof e.name === "string" ? e.name : id;
    const alive =
      e.isAlive === false || (typeof e?.hp?.current === "number" && e.hp.current <= 0)
        ? "mort"
        : "vivant";
    const surprised = e.surprised === true ? "surpris" : "non_surpris_ou_indetermine";
    const awareness = e.awareOfPlayer === false ? "joueur_non_repere" : "joueur_repere_ou_indetermine";
    const ac = typeof e.ac === "number" ? e.ac : "?";
    const hpCurrent = typeof e?.hp?.current === "number" ? e.hp.current : "?";
    const hpMax = typeof e?.hp?.max === "number" ? e.hp.max : "?";
    lines.push(`- ${name} [${id}] | ${alive} | surprise=${surprised} | perception_joueur=${awareness} | PV=${hpCurrent}/${hpMax} | CA=${ac}`);
  }
  if (player && typeof player === "object") {
    const alive =
      player.isAlive === false || (typeof player?.hp?.current === "number" && player.hp.current <= 0)
        ? "mort"
        : "vivant";
    const surprised = player.surprised === true ? "surpris" : "non_surpris_ou_indetermine";
    const ac = typeof player.ac === "number" ? player.ac : "?";
    const hpCurrent = typeof player?.hp?.current === "number" ? player.hp.current : "?";
    const hpMax = typeof player?.hp?.max === "number" ? player.hp.max : "?";
    lines.push(`- Joueur [player] | ${alive} | surprise=${surprised} | PV=${hpCurrent}/${hpMax} | CA=${ac}`);
  }
  return lines.length ? lines.join("\n") : "(aucune entité)";
}

function normalizeRoomMemoryLine(line) {
  return String(line ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 400);
}

function normalizeRoomMemoryMatch(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isRoomAwarenessOrSurpriseLine(line) {
  const n = normalizeRoomMemoryMatch(line);
  const mentionsRoomActors =
    n.includes("gobelin") ||
    n.includes("gobelins") ||
    n.includes("garde") ||
    n.includes("gardes") ||
    n.includes("occupant") ||
    n.includes("occupants");
  const mentionsAwarenessOrSurprise =
    n.includes("surpris") ||
    n.includes("alerte") ||
    n.includes("vacarme") ||
    n.includes("intrus tente de forcer") ||
    n.includes("ne pourront pas etre surpris") ||
    n.includes("ne pourra pas etre surpris");
  return mentionsRoomActors && mentionsAwarenessOrSurprise;
}

function isRoomShieldReadinessLine(line) {
  const n = normalizeRoomMemoryMatch(line);
  const mentionsRoomActors =
    n.includes("gobelin") ||
    n.includes("gobelins") ||
    n.includes("garde") ||
    n.includes("gardes");
  return mentionsRoomActors && n.includes("bouclier");
}

function mergeRoomMemoryText(oldText, newLine) {
  const rawLines = String(oldText ?? "")
    .split("\n")
    .map((line) => normalizeRoomMemoryLine(line))
    .filter(Boolean);
  const incoming = newLine ? normalizeRoomMemoryLine(newLine) : "";
  const nextLines = [...rawLines];

  const pruneFamily = (predicate) => {
    for (let i = nextLines.length - 1; i >= 0; i -= 1) {
      if (predicate(nextLines[i])) nextLines.splice(i, 1);
    }
  };

  if (incoming) {
    if (isRoomAwarenessOrSurpriseLine(incoming)) {
      pruneFamily(isRoomAwarenessOrSurpriseLine);
    }
    if (isRoomShieldReadinessLine(incoming)) {
      pruneFamily(isRoomShieldReadinessLine);
    }
    if (!nextLines.includes(incoming)) {
      nextLines.push(incoming);
    }
  }

  return nextLines.join("\n");
}

function wouldChangeRoomMemory(oldText, candidateLine) {
  const normalized = normalizeRoomMemoryLine(candidateLine);
  if (!normalized) return false;
  return mergeRoomMemoryText(oldText, normalized) !== mergeRoomMemoryText(oldText);
}

function getRoomMemoryFromWorldContext(campaignWorldContext, roomId) {
  if (
    !campaignWorldContext ||
    typeof campaignWorldContext !== "object" ||
    Array.isArray(campaignWorldContext)
  ) {
    return "";
  }
  const states =
    campaignWorldContext.roomStates &&
    typeof campaignWorldContext.roomStates === "object" &&
    !Array.isArray(campaignWorldContext.roomStates)
      ? campaignWorldContext.roomStates
      : null;
  const state = states && roomId ? states[roomId] : null;
  return typeof state?.roomMemory === "string" ? state.roomMemory : "";
}

function normalizeEntityName(name) {
  return String(name ?? "").trim().toLowerCase();
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

function safeParseGmArbiterJson(raw, context = {}) {
  const txt = String(raw ?? "").trim();
  if (!txt) return { ok: false, error: "Réponse vide." };
  try {
    const data = JSON.parse(txt);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "Objet JSON racine invalide." };
    }
    const resolution = String(data.resolution ?? "").trim();
    if (!["no_roll_needed", "request_roll", "apply_consequences", "needs_campaign_context"].includes(resolution)) {
      return { ok: false, error: "resolution invalide." };
    }
    let campaignContextRequest = null;
    if (data.campaignContextRequest != null) {
      if (
        typeof data.campaignContextRequest !== "object" ||
        Array.isArray(data.campaignContextRequest)
      ) {
        return { ok: false, error: "campaignContextRequest invalide." };
      }
      const scope = String(data.campaignContextRequest.scope ?? "").trim();
      if (scope && scope !== "full_campaign" && scope !== "connected_rooms") {
        return { ok: false, error: "campaignContextRequest.scope invalide." };
      }
      campaignContextRequest = {
        scope: scope || "full_campaign",
        reason: String(data.campaignContextRequest.reason ?? "").trim(),
      };
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

    const existingEntityNames = new Set(
      (Array.isArray(context.entities) ? context.entities : [])
        .map((entity) => normalizeEntityName(entity?.name))
        .filter(Boolean)
    );
    const spawnNamesInBatch = new Set();

    const entityUpdates = Array.isArray(data.entityUpdates) ? data.entityUpdates : null;
    if (entityUpdates) {
      for (const update of entityUpdates) {
        if (!update || typeof update !== "object" || Array.isArray(update)) {
          return { ok: false, error: "entityUpdates invalide." };
        }
        const action = String(update.action ?? "").trim();
        if (action !== "spawn") continue;
        const name = String(update.name ?? "").trim();
        if (!name) {
          return { ok: false, error: "entityUpdates.spawn.name manquant." };
        }
        const lowered = normalizeEntityName(name);
        if (!lowered) {
          return { ok: false, error: "entityUpdates.spawn.name invalide." };
        }
        if (spawnNamesInBatch.has(lowered) || existingEntityNames.has(lowered)) {
          return { ok: false, error: "entityUpdates.spawn.name doit être distinct dans la scène." };
        }
        spawnNamesInBatch.add(lowered);
      }
    }

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

    const currentRoomMemory = String(context.currentRoomMemory ?? "");
    const campaignWorldContext = context.campaignWorldContext ?? null;

    let roomMemoryAppend = null;
    if (data.roomMemoryAppend != null && String(data.roomMemoryAppend).trim()) {
      const s = normalizeRoomMemoryLine(data.roomMemoryAppend);
      if (s && wouldChangeRoomMemory(currentRoomMemory, s)) roomMemoryAppend = s;
    }

    const crossRoomEntityUpdates = Array.isArray(data.crossRoomEntityUpdates)
      ? data.crossRoomEntityUpdates
          .map((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
            const roomId = String(entry.roomId ?? "").trim();
            const updates = Array.isArray(entry.updates) ? entry.updates : [];
            if (!roomId || updates.length === 0) return null;
            return { roomId, updates };
          })
          .filter(Boolean)
      : null;

    const crossRoomMemoryAppend = Array.isArray(data.crossRoomMemoryAppend)
      ? data.crossRoomMemoryAppend
          .map((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
            const roomId = String(entry.roomId ?? "").trim();
            const line = normalizeRoomMemoryLine(entry.line);
            if (!roomId || !line) return null;
            const oldText = getRoomMemoryFromWorldContext(campaignWorldContext, roomId);
            if (!wouldChangeRoomMemory(oldText, line)) return null;
            return { roomId, line };
          })
          .filter(Boolean)
      : null;

    return {
      ok: true,
      parsed: {
        resolution,
        reason: String(data.reason ?? "").trim(),
        campaignContextRequest,
        rollRequest,
        entityUpdates,
        sceneUpdate,
        gameMode,
        engineEvent,
        roomMemoryAppend,
        crossRoomEntityUpdates,
        crossRoomMemoryAppend,
      },
    };
  } catch {
    return { ok: false, error: "JSON invalide." };
  }
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
      intentDecision = null,
      arbiterTrigger = null,
      campaignWorldContext = null,
    } = body;
    const normalizedMessages = slimMessagesForArbiterPrompt(normalizeMessagesForPrompt(messages));
    const roomMemoryBlock = String(roomMemory ?? "").trim();
    const entityTruthSummary = summarizeEntityTruth(entities, player);
    const hasCampaignWorldContext =
      campaignWorldContext && typeof campaignWorldContext === "object" && !Array.isArray(campaignWorldContext);

    const connectedRoomIds = new Set();
    const exitsArr = Array.isArray(allowedExits) ? allowedExits : [];
    for (const ex of exitsArr) {
      const id =
        typeof ex === "string" ? ex.trim() : String(ex?.id ?? "").trim();
      if (id) connectedRoomIds.add(id);
    }
    // Inclure la salle courante elle-même pour contexte compact.
    if (String(currentRoomId ?? "").trim()) connectedRoomIds.add(String(currentRoomId).trim());
    const connectedRooms = [...connectedRoomIds]
      .map((id) => {
        const r = GOBLIN_CAVE?.[id];
        if (!r) return null;
        return {
          id: String(r.id ?? id),
          title: String(r.title ?? id),
          description: String(r.description ?? ""),
          secrets: String(r.secrets ?? ""),
        };
      })
      .filter(Boolean);

    const userContent = [
      `currentRoomId: ${String(currentRoomId ?? "").trim() || "(inconnu)"}`,
      `currentRoomTitle: ${String(currentRoomTitle ?? "").trim() || "(inconnu)"}`,
      `currentScene: ${String(currentScene ?? "").trim() || "(inconnue)"}`,
      "truthHierarchy: entities_actuel > memoire_de_scene > currentRoomSecrets",
      `currentRoomSecrets: ${String(currentRoomSecrets ?? "").trim() || "(aucun)"}`,
      `mémoire_de_scène: ${roomMemoryBlock || "(aucune)"}`,
      `resume_etat_entites_verite: ${entityTruthSummary}`,
      `allowedExits: ${JSON.stringify(Array.isArray(allowedExits) ? allowedExits : [])}`,
      `connectedRooms (1 saut via exits): ${JSON.stringify(connectedRooms)}`,
      `entities: ${JSON.stringify(Array.isArray(entities) ? entities : [])}`,
      `player: ${JSON.stringify(player ?? null)}`,
      `sourceAction: ${String(sourceAction ?? "").trim() || "(aucune)"}`,
      `intentDecision: ${JSON.stringify(intentDecision ?? null)}`,
      `arbiterTrigger: ${JSON.stringify(arbiterTrigger ?? null)}`,
      `rollResult: ${JSON.stringify(rollResult ?? null)}`,
      `messages (ancien→récent, résumé): ${JSON.stringify(normalizedMessages)}`,
      `campaignWorldContextIncluded: ${hasCampaignWorldContext ? "true" : "false"}`,
      hasCampaignWorldContext
        ? `campaignWorldContext: ${JSON.stringify(campaignWorldContext)}`
        : "campaignWorldContext: null",
      "Un seul objet JSON conforme.",
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

    let parsed = safeParseGmArbiterJson(rawOut, {
      currentRoomMemory: roomMemoryBlock,
      campaignWorldContext,
      entities,
    });

    if (parsed.ok && parsed.parsed?.resolution === "request_roll" && parsed.parsed.rollRequest) {
      parsed.parsed.rollRequest = normalizeGmArbiterRollRequest(
        parsed.parsed.rollRequest,
        currentRoomSecrets
      );
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
            systemInstruction: GM_ARBITER_SYSTEM,
            userContent,
            generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
          }
        : {
            kind: "openrouter",
            model: OPENROUTER_MODEL,
            messages: [
              { role: "system", content: GM_ARBITER_SYSTEM },
              { role: "user", content: userContent },
            ],
            temperature: 0.2,
            response_format: { type: "json_object" },
          };

    await logInteraction(
      "GM_ARBITER",
      traceProvider,
      requestForTrace,
      "",
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

