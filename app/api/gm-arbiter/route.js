import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import { logInteraction } from "@/lib/aiTraceLog";
import { slimMessagesForArbiterPrompt } from "@/lib/slimMessagesForArbiterPrompt";
import { GOBLIN_CAVE } from "@/data/campaign";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "arcee-ai/trinity-large-preview:free";
const GEMINI_MODEL = "gemini-3-flash-preview";

function nowIso() {
  return new Date().toISOString();
}

function elapsedMsSince(t0) {
  return Date.now() - t0;
}

const GM_ARBITER_SYSTEM = `Arbitre de scène D&D : mécaniques du lieu (secrets) uniquement ; aucune narration ; uniquement JSON.

Tu dois lire les informations du lieu ainsi que ses secrets GM en prenant en compte les evenements passés dans l'aventure pour décider intelligement ce qu'il faut faire.
C'est toi qui applique toutes les règles spécifique au lieu. Tu ne gères pas aller/revenir/sortir : sceneUpdate ne simule jamais la navigation joueur.

Voici ce que tu peux faire et comemnt le faire : 

- no_roll_needed : aucune mécanique à l’instant ou déjà en mémoire ; suggestions optionnelles dans les secrets ≠ ordres d’exécution. C'est la sortie par défaut quand aucune règle spécifique de lieu n'est à appliquer : dans ce cas tu passes simplement la main au narrateur sans inventer de conséquence mécanique.
- needs_campaign_context : si le contexte local ne suffit pas. Tu peux demander :
  - scope="connected_rooms" : uniquement la salle courante + ses salles connectées (1 saut via les 'exits', en tenant compte aussi des entrées/sorties entrantes si nécessaire) ;
  - scope="full_campaign" : toutes les salles, leurs mémoires et leurs états connus avant de décider.
- sceneUpdate : null sauf transition explicitement imposée par les secrets comme conséquence mécanique. Toujours null avec no_roll_needed ou request_roll.
- rollRequest : demande un jet secret MJ ou un jet joueur.
- entityUpdates : met à jour des entités dans la salle, y compris le joueur via id:"player".
- sceneUpdate : met à jour la salle.
- gameMode : met à jour le mode de jeu.
- engineEvent : met à jour l'événement de la scène.
- timeAdvanceMinutes : avance l'horloge du monde (en minutes) quand un temps notable s'écoule dans la fiction.
- roomMemoryAppend : met à jour la mémoire de la salle seulement si cela apporte une nouveauté mécanique réelle.
- crossRoomEntityUpdates : met à jour durablement l'état connu d'autres salles.
- crossRoomMemoryAppend : met à jour durablement la mémoire d'autres salles seulement si cela change réellement leur état mémorisé.

COHÉRENCE OBLIGATOIRE resolution/rollRequest :
- Si un jet est nécessaire, renvoie exclusivement resolution="request_roll" avec rollRequest non-null.
- Si resolution est "apply_consequences", "no_roll_needed" ou "needs_campaign_context", rollRequest doit être null.
- Interdiction absolue de renvoyer "apply_consequences" avec un rollRequest dans la même réponse.

Format :
{
  "resolution": "no_roll_needed" | "request_roll" | "apply_consequences" | "needs_campaign_context",
  "reason": "texte court",
  "campaignContextRequest": null | { "scope": "full_campaign"|"connected_rooms", "reason": "pourquoi le contexte demandé est nécessaire" },
  "rollRequest": null | { "kind": "gm_secret", "roll": "1d100", "reason": "..." } | { "kind": "player_check", "stat": "FOR"|"DEX"|"CON"|"INT"|"SAG"|"CHA", "skill": "Perception", "dc": 10, "reason": "...", "returnToArbiter": true },
  "entityUpdates": null | [{ "action": "spawn"|"update"|"kill"|"remove", "id": "goblin_1" | "player", "name": "Gobelin grimaçant", "templateId": "goblin", "type": "hostile", "visible": true, "hp": { "current": 4, "max": 7 }, "ac": 15, "acDelta": -2, "surprised": true, "awareOfPlayer": true, "lootItems": ["18 pa"] }],
  "sceneUpdate": null | { "hasChanged": true, "targetRoomId": "room_intro" },
  "gameMode": null | "combat" | "exploration",
  "timeAdvanceMinutes": null | 0..1440,
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
- Si la fiction implique clairement un temps écoulé (trajet, attente, fouille longue, pause), tu peux renseigner timeAdvanceMinutes (entier en minutes). Sinon laisse null.
- CAS PAR DÉFAUT TRÈS FRÉQUENT : si aucune règle spécifique du lieu n'est à appliquer maintenant, renvoie simplement no_roll_needed avec une reason courte et factuelle, puis laisse le narrateur poursuivre. N'essaie pas de "faire quelque chose quand même".
- Quand tu hésites entre "aucun effet mécanique spécial" et "petite intervention arbitraire", choisis no_roll_needed.
- ANTI-DOGPILING / OBSTACLES RÉPÉTÉS : pour un même obstacle local (porte verrouillée, serrure, coffre, passage secret, mur, grille, etc.), si la même approche a déjà échoué récemment et qu'aucun fait concret n'a changé dans la fiction, ne redemande PAS simplement le même jet une nouvelle fois.
- Même obstacle + même méthode + même fiction = pas de nouveau request_roll. Préfère no_roll_needed (tentative stérile) ou apply_consequences (si l'échec produit un coût, un risque, du bruit, une usure, une perte de temps, une alerte, une serrure faussée, ou toute autre conséquence réelle).
- Un nouvel essai sur le même obstacle n'est légitime que si quelque chose a changé de manière concrète : autre méthode, autre outil, aide explicite d'un autre personnage, nouveau levier fictionnel, préparation spéciale, indice nouvellement obtenu, ou conséquence du précédent essai qui modifie la situation.
- FAIL FORWARD : un échec ne doit presque jamais signifier seulement "rien ne se passe". Si l'action était vraiment tentée, fais avancer la fiction avec un coût, un risque, une complication, une information partielle, ou une ouverture différente, tant que cela reste fidèle aux secrets du lieu.
- Quand un obstacle résiste, utilise roomMemoryAppend pour mémoriser les faits devenus vrais et utiles ensuite : tentative déjà ratée, vacarme causé, serrure faussée, porte fragilisée, gonds plus vulnérables que la serrure, temps perdu, discrétion compromise, etc.
- Si les joueurs semblent bloqués sur le même obstacle depuis plusieurs échanges ou plusieurs échecs mémorisés, n'invente pas une solution miraculeuse et ne donne pas gratuitement le secret complet ; en revanche, tu peux orienter la fiction vers une piste crédible réellement déductible du lieu via apply_consequences + engineEvent.details factuel court.
- Cette "aide" doit rester diégétique et concrète : signaler que le bois cède plus que la serrure, que le vacarme attire l'attention, qu'une autre issue paraît possible, qu'un outil manque, qu'un mécanisme semble usé, etc. Tu aides la fiction à avancer ; tu ne fais pas une liste de solutions au joueur.
- Exemple porte verrouillée : première tentative de crochetage -> request_roll. Si échec, tu peux mémoriser que la serrure a résisté ou s'est faussée. Si le joueur recommence immédiatement pareil, sans changement, réponse attendue : no_roll_needed ou apply_consequences factuel, PAS un second request_roll identique.
- Exemple porte verrouillée : après plusieurs tentatives vaines, une bonne sortie peut être apply_consequences avec un detail du type "La serrure refuse toujours de céder, mais les gonds et le bois semblent plus vulnérables que le mécanisme." Ce n'est pas un spoil gratuit : c'est un fait fictionnel désormais perceptible.
- si le contexte local est insuffisant, renvoie needs_campaign_context avec campaignContextRequest.scope="connected_rooms" si tu n'as besoin que des salles voisines, sinon scope="full_campaign".
- quand campaignWorldContext est fourni, tu peux lire uniquement les salles incluses dans ce contexteWorldContext (connected_rooms ou full_campaign), puis renvoyer apply_consequences avec crossRoomEntityUpdates / crossRoomMemoryAppend si nécessaire.
- apply_consequences nouveau → utilise roomMemoryAppend / crossRoomMemoryAppend seulement si la mémoire doit réellement être mise à jour.
- Jet requis sans rollResult → request_roll.
- gm_secret = "XdY" seul ; player_check = stat+skill+dc+returnToArbiter ; jamais "1d20+bonus" dans roll.
- rollResult fourni → apply_consequences ou no_roll_needed.
- Pas d’intention joueur ici.
- CONTRAINTE D'INTENTION : "sourceAction" (texte joueur) et "intentDecision" décrivent déjà ce que le joueur essaie de faire ; tu ne remplaces jamais cette action par une autre.
- Hiérarchie stricte pour l'action tentée : 1) texte du joueur / sourceAction, 2) intentDecision, 3) secrets du lieu, 4) inventaire / outils / capacités. Les niveaux 3 et 4 peuvent seulement autoriser, bloquer ou qualifier l'action tentée ; ils ne peuvent jamais en inventer une nouvelle.
- Tu ne transformes jamais une tentative de passage, d'entrée, d'approche, d'ouverture générale ou de déplacement en crochetage, forçage, désamorçage, fouille, soin, attaque, fuite, prise d'objet, ou toute autre sous-action technique non explicitement déclarée.
- Le fait que le joueur possède des outils de voleur, une clef, un sort, une arme, une compétence ou une autre ressource ne signifie JAMAIS qu'il choisit automatiquement de les utiliser.
- Les secrets du lieu décrivent ce qui serait possible SI le joueur choisissait explicitement cette méthode ; ils ne t'autorisent jamais à sélectionner cette méthode à sa place.
- Si "intentDecision" dit qu'une action est impossible à cause d'un obstacle (porte verrouillée, passage bloqué, vide, mur, etc.), tu ne requalifies jamais cela en "request_roll" pour une autre action technique, sauf si le texte du joueur ou "intentDecision" mentionne explicitement cette autre action.
- Exemple interdit : "sourceAction = J'entre dans la salle à l'ouest" et "intentDecision.reason = porte verrouillée" -> réponse interdite : "request_roll" pour crocheter la serrure parce que le joueur a des outils.
- Exemple correct : dans ce cas, conserve l'obstacle tel quel ; "no_roll_needed" ou "apply_consequences" factuel sur la porte verrouillée, sans inventer de tentative de crochetage.
- Exemple autorisé : "sourceAction = Je tente de crocheter la serrure" ou "sourceAction = j'essaie avec mes outils de voleur" -> alors seulement "request_roll" DEX DD 10 si les secrets l'autorisent.
- Pas de spawn pour « réinitialiser » la rencontre si entities non vides, sauf secret explicite.
- Si tu fais apparaître une créature via entityUpdates.action="spawn", tu dois lui donner un champ 'name' explicite, utilisable tel quel par le joueur.
- Si plusieurs créatures proches / du même template apparaissent dans la même scène, donne à chacune un nom distinct et mémorable (ex. 'Gobelin grimaçant', 'Gobelin malade'). Ne laisse jamais le moteur les renommer à ta place.
- N'utilise pas des noms froids ou ambigus du type 'Gobelin', 'Gobelin 2', 'Créature', 'Créature A'. Donne directement un nom final différenciant.
- Un entityUpdates.action="update" sur une entité absente n'engendre plus aucun spawn implicite côté moteur. Si tu veux créer une créature, utilise explicitement action="spawn".
- RELOCALISATION D'UN PNJ DÉJÀ CONNU : si la fiction dit qu'une créature déjà connue fuit, se replie, change de salle, rattrape le groupe ou réapparaît ailleurs, tu dois conserver son identité existante. Réutilise le MÊME id via update / crossRoomEntityUpdates, et au besoin remove depuis l'ancienne salle ; ne crée jamais un nouveau spawn avec un autre id pour le même personnage.
- Si une créature portant déjà le même nom existe dans entities, dans resume_etat_entites_verite, ou dans le contexte de campagne fourni, considère que c'est le même individu sauf secret explicite de doublon. Dans ce cas, interdiction de renvoyer action="spawn" avec un nouvel id.
- Exemple interdit : le Chef Gobelin Tremblant existe déjà comme goblin_chef, puis tu renvoies un spawn goblin_chief dans une autre salle. Exemple correct : update/crossRoomEntityUpdates sur goblin_chef pour refléter sa nouvelle position, sa visibilité ou son état.
- COMBAT = moteur souverain : tu n'inventes JAMAIS le déroulement ordinaire d'un combat.
- Tu ne décides JAMAIS à la place du moteur si une attaque du joueur ou d'une créature touche, rate, tue, blesse, critique, manque son bouclier, ou termine la rencontre, sauf si un secret du lieu impose explicitement une conséquence spéciale indépendante du jet d'attaque normal.
- Les dégâts, morts, PV à 0, éliminations et fins de combat provenant d'attaques normales sont gérés par le moteur et les jets déjà résolus ; ne les invente jamais à partir de l'historique récent.
- Le simple fait que l'historique mentionne une attaque, un critique, une entrée en combat ou une position avantageuse ne t'autorise PAS à produire entityUpdates.kill / hp / remove, ni à passer gameMode="exploration", sauf si les entités sont déjà effectivement mortes dans 'entities' ou si un secret l'impose explicitement.
- En combat, tes interventions doivent rester limitées aux règles spéciales réellement écrites dans les secrets du lieu : surprise, alerte, arrivée de renforts, fuite scriptée, activation d'un passage secret, récupération d'un bouclier, changement de CA/état, mémoire de salle, effets cross-room, etc.
- Si le combat suit simplement son cours normal sans règle spéciale de lieu à appliquer à cet instant, renvoie 'no_roll_needed'.
- Si arbiterTrigger.phase="combat_turn_end", c'est un simple marqueur de clôture de tour : tu ne déclenches PAS de cri d'alerte, PAS de récupération de bouclier, PAS de renforts, PAS de réaction volontaire, PAS d'action retardée. Sauf effet de fin de tour explicitement écrit dans les secrets, renvoie 'no_roll_needed'.
- Si arbiterTrigger.phase="combat_turn_start", c'est le bon moment pour évaluer une règle spéciale liée au combattant actif ou au début de son tour.
- Si l'acteur courant est marqué surprised=true dans entities, il ne peut pas volontairement crier, alerter, ramasser son bouclier, appeler des renforts, ouvrir un passage, ni accomplir d'autre action délibérée ce tour-ci. Dans ce cas, privilégie 'no_roll_needed' tant qu'aucun effet passif explicite du lieu ne s'applique.
- Cas particulier important : si arbiterTrigger.phase="combat_turn_end" et qu'aucune règle spéciale du lieu ne s'applique réellement à cette fin de tour, renvoie simplement 'no_roll_needed' avec engineEvent=null ou un engineEvent purement minimal, sans détails narratifs. Le moteur doit alors enchaîner le combat sans appeler le GM narrateur.
- À l'inverse, lors de combat_turn_start, si une règle spéciale produit un vrai événement visible dans la fiction (ex. un hobgobelin saisit enfin son bouclier, un survivant donne l'alerte, un passage s'ouvre, des renforts arrivent), utilise 'apply_consequences' et fournis un engineEvent factuel court pour autoriser la narration.
- N'utilise jamais dans reason, engineEvent.details, roomMemoryAppend ou crossRoomMemoryAppend des ids techniques ou numéros de salle destinés au moteur/joueur absent de la scène (ex. "room_7", "salle 10"). Préfère des formulations fictionnelles comme "les pièces voisines", "le dortoir au nord", "des chambrées proches", ou "les alentours".
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

    // Contrat strict: request_roll <-> rollRequest
    if (resolution === "request_roll" && !rollRequest) {
      return { ok: false, error: "resolution=request_roll exige rollRequest non-null." };
    }
    if (resolution !== "request_roll" && rollRequest) {
      return { ok: false, error: "rollRequest interdit si resolution n'est pas request_roll." };
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

    let timeAdvanceMinutes = null;
    if (data.timeAdvanceMinutes != null) {
      const rawTime = Number(data.timeAdvanceMinutes);
      if (!Number.isFinite(rawTime)) {
        return { ok: false, error: "timeAdvanceMinutes invalide." };
      }
      const t = Math.trunc(rawTime);
      if (t < 0 || t > 1440) {
        return { ok: false, error: "timeAdvanceMinutes hors bornes (0..1440)." };
      }
      timeAdvanceMinutes = t;
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
        timeAdvanceMinutes,
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
    const t0 = Date.now();
    const phaseTimestamps = {
      start: nowIso(),
    };
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
      worldTimeMinutes = null,
      worldTimeLabel = "",
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
      `worldTime: ${
        typeof worldTimeMinutes === "number" && Number.isFinite(worldTimeMinutes)
          ? `${Math.max(0, Math.trunc(worldTimeMinutes))} min (${String(worldTimeLabel ?? "").trim() || "sans libellé"})`
          : "(inconnu)"
      }`,
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
    const promptMetrics = {
      currentRoomIdChars: String(currentRoomId ?? "").length,
      currentSceneChars: String(currentScene ?? "").length,
      currentRoomSecretsChars: String(currentRoomSecrets ?? "").length,
      roomMemoryChars: roomMemoryBlock.length,
      normalizedMessagesCount: normalizedMessages.length,
      normalizedMessagesChars: normalizedMessages.reduce(
        (sum, m) => sum + String(m?.content ?? "").length,
        0
      ),
      allowedExitsCount: exitsArr.length,
      connectedRoomsCount: connectedRooms.length,
      entitiesCount: Array.isArray(entities) ? entities.length : 0,
      userContentChars: userContent.length,
      campaignWorldContextIncluded: hasCampaignWorldContext,
      campaignWorldContextChars: hasCampaignWorldContext
        ? JSON.stringify(campaignWorldContext).length
        : 0,
    };
    console.info("[/api/gm-arbiter] start", {
      provider,
      roomId: String(currentRoomId ?? ""),
      metrics: promptMetrics,
    });

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
    phaseTimestamps.afterModel = nowIso();
    console.info("[/api/gm-arbiter] after-model", {
      elapsedMs: elapsedMsSince(t0),
      provider,
      rawChars: String(rawOut ?? "").length,
    });

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
    const responsePayload = parsed.ok
      ? parsed.parsed
      : { error: parsed.error, raw: truncate(rawOut, 2000) };
    const responseStatus = parsed.ok ? 200 : 422;
    phaseTimestamps.responseSent = nowIso();
    console.info("[/api/gm-arbiter] response-sent", {
      elapsedMs: elapsedMsSince(t0),
      provider: traceProvider,
      status: responseStatus,
    });
    void logInteraction(
      "GM_ARBITER",
      traceProvider,
      requestForTrace,
      "",
      rawOut,
      parsed.ok ? parsed.parsed : { error: parsed.error, raw: truncate(rawOut, 800) },
      {
        promptMetrics,
        timing: {
          phases: phaseTimestamps,
          elapsedMs: {
            totalBeforeReturn: elapsedMsSince(t0),
            model: phaseTimestamps.afterModel
              ? new Date(phaseTimestamps.afterModel).getTime() - new Date(phaseTimestamps.start).getTime()
              : null,
          },
          note: "responseSent correspond au moment où la réponse est préparée et rendue au runtime serveur.",
        },
      }
    ).then(() => {
      console.info("[/api/gm-arbiter] after-log", {
        elapsedMs: elapsedMsSince(t0),
        provider: traceProvider,
        status: responseStatus,
      });
    });

    return NextResponse.json(responsePayload, { status: responseStatus });
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

