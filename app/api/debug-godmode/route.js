import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import { logInteraction } from "@/lib/aiTraceLog";
import { GOBLIN_CAVE } from "@/data/campaign";
import { BESTIARY } from "@/data/bestiary";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "arcee-ai/trinity-large-preview:free";
const GEMINI_MODEL = "gemini-3-flash-preview";

const CUSTOM_DEBUG_TEMPLATES = {
  lanea: {
    id: "lanea",
    name: "Lanéa",
    type: "npc",
    race: "Humaine",
    entityClass: "Villageoise",
    hp: { current: 4, max: 4 },
    ac: 10,
    stats: { FOR: 10, DEX: 11, CON: 10, INT: 10, SAG: 10, CHA: 11 },
    attackBonus: 0,
    damageDice: "1d4",
    damageBonus: 0,
    description: "Jeune villageoise captive des gobelins, vive et lucide malgre la peur.",
  },
  thron: {
    id: "thron",
    name: "Thron",
    type: "npc",
    race: "Humain",
    entityClass: "Forgeron",
    hp: { current: 9, max: 9 },
    ac: 11,
    stats: { FOR: 14, DEX: 10, CON: 13, INT: 11, SAG: 12, CHA: 12 },
    attackBonus: 2,
    damageDice: "1d4",
    damageBonus: 0,
    description: "Forgeron robuste du village de Fial, inquiet pour sa fille.",
  },
  commis_meunier: {
    id: "commis_meunier",
    name: "Commis du meunier",
    type: "npc",
    race: "Humain",
    entityClass: "Villageois",
    hp: { current: 4, max: 4 },
    ac: 10,
    stats: { FOR: 10, DEX: 10, CON: 10, INT: 10, SAG: 11, CHA: 10 },
    attackBonus: 1,
    damageDice: "1d4",
    damageBonus: 0,
    description: "Jeune homme nerveux qui a assiste a l'enlevement.",
  },
};

const DEBUG_TEMPLATE_CATALOG = {
  ...BESTIARY,
  ...CUSTOM_DEBUG_TEMPLATES,
};

const GODMODE_SYSTEM = `Tu es l'interpreteur God Mode d'un moteur D&D.

Tu ne racontes pas la partie. Tu traduis une demande de developpeur en JSON STRICT de mutations de state.

Reponds UNIQUEMENT avec un objet JSON valide au format exact :
{
  "summary": "phrase courte obligatoire",
  "narration": "phrase courte optionnelle pour confirmer l'action",
  "teleport": null | { "targetRoomId": "room_4" },
  "entityUpdates": null | [
    {
      "action": "spawn" | "update" | "kill" | "remove",
      "id": "entity_id_ou_player",
      "templateId": "goblin",
      "name": "Nom visible",
      "type": "hostile" | "npc" | "player",
      "visible": true,
      "hp": { "current": 7, "max": 7 },
      "ac": 15,
      "acDelta": -2,
      "awareOfPlayer": true,
      "surprised": false,
      "description": "texte court",
      "inventory": ["objet"],
      "lootItems": ["butin"]
    }
  ],
  "playerPatch": null | {
    "hpCurrent": 13,
    "hpMax": 13,
    "hitDiceRemaining": 1,
    "hitDiceTotal": 1,
    "spellSlotsSet": { "1": { "max": 4, "remaining": 3 } },
    "inventorySet": ["objet"],
    "inventoryAdd": ["objet"],
    "inventoryRemove": ["objet"]
  },
  "roomMemoryOps": null | [
    { "roomId": "current" | "room_3", "mode": "append" | "replace" | "clear", "text": "memoire mecanique" }
  ],
  "chatHistoryPatch": null | {
    "clearAll": true,
    "removeLast": 3,
    "removeIds": ["msg_1"],
    "removeRoles": ["user" | "ai"],
    "removeTypes": ["debug" | "meta" | "meta-reply" | "dice" | "enemy-turn" | "combat-detail" | "scene-image" | "scene-image-pending" | "continue" | "retry-action" | "campaign-context"]
  },
  "combatPatch": null | {
    "gameMode": "combat" | "exploration",
    "clearCombat": true,
    "combatTurnIndex": 0,
    "combatOrder": [
      { "id": "player", "initiative": 14 },
      { "id": "goblin_1", "initiative": 11 }
    ]
  }
}

Regles obligatoires :
- Utilise uniquement les room ids, entity ids et template ids fournis dans le contexte.
- Si la demande est ambigue, refuse proprement : summary explique le refus, et toutes les sections de mutation restent null.
- Si le dev demande de tuer/soigner/deplacer une entite existante, privilegie entityUpdates sur cette id existante.
- "Remets mes PV a X" -> playerPatch.
- Des de vie (PJ) : TOUJOURS playerPatch.hitDiceRemaining (et optionnellement hitDiceTotal). Jamais roomMemoryOps pour simuler des des de vie ou des PV. La ligne "player:" du contexte indique des de vie restants/total (des X) : utilise ces nombres pour "rendre 1 de" -> min(total, restants+1), ou "remettre tous les des" -> hitDiceRemaining = hitDiceTotal.
- Emplacements de sort (PJ) : utiliser playerPatch.spellSlotsSet pour consommer/rendre des slots (ex: niveau 1). Ne pas utiliser roomMemoryOps pour simuler cette depense.
- "Passe en combat" sans ordre explicite -> combatPatch.gameMode="combat" avec combatOrder=null.
- "Sors du combat" -> combatPatch.gameMode="exploration" et clearCombat=true.
- "Teleporte-moi" -> teleport uniquement. N'invente pas un sceneUpdate normal de joueur.
- "Ajoute Lanéa / un gobelin / Gandelme" -> entityUpdates.action="spawn" avec templateId si disponible et un name final clair.
- La memoire de salle peut cibler la salle courante OU n'importe quelle autre salle par roomId explicite.
- Pour une memoire de salle, ecris un fait mecanique concis et canonique, pas une narration.
- Si le dev demande de supprimer des messages du chat, utilise chatHistoryPatch. "efface tout l'historique" -> clearAll=true. "supprime les 3 derniers messages" -> removeLast=3. Si la demande cible seulement des messages IA/debug, utilise removeRoles/removeTypes si pertinent.
- Ne touche jamais a autre chose que ce qui est explicitement demande.
- Multijoueur : les PJ dans l ordre d initiative ont souvent un id "mp-player-<clientId>". Pour soigner/revivre un PJ, privilegie "playerPatch" (hpCurrent, etc.) OU "entityUpdates" avec exactement l id de l ordre de combat (jamais inventer un id).
- En multijoueur hors combat, les PJ du groupe sont listés dans "PJ du groupe (multijoueur)". Pour cibler "Thorin", "Elyndra", etc., utilise l id exact de cette section dans entityUpdates.
- N'invente pas de commandes unsupported. Pas de markdown. JSON seul.`;

function nowIso() {
  return new Date().toISOString();
}

function elapsedMsSince(t0) {
  return Date.now() - t0;
}

function truncate(s, n = 500) {
  const str = typeof s === "string" ? s : String(s ?? "");
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

function toPlainString(value) {
  return String(value ?? "").trim();
}

function slugify(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function stripCodeFences(raw) {
  const trimmed = String(raw ?? "").trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return null;
  const out = value.map((item) => toPlainString(item)).filter(Boolean);
  return out.length ? out : [];
}

function normalizeHp(value) {
  if (!value || typeof value !== "object") return null;
  const current =
    typeof value.current === "number" && Number.isFinite(value.current)
      ? Math.max(0, Math.trunc(value.current))
      : null;
  const max =
    typeof value.max === "number" && Number.isFinite(value.max)
      ? Math.max(1, Math.trunc(value.max))
      : null;
  if (current == null && max == null) return null;
  if (current == null) return { current: Math.min(max, max), max };
  if (max == null) return { current, max: Math.max(1, current) };
  return { current, max: Math.max(max, current) };
}

function normalizeSpellSlotsShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const [lvl, row] of Object.entries(value)) {
    const key = String(lvl ?? "").trim();
    if (!/^\d+$/.test(key)) continue;
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const maxRaw = Number((row).max);
    const remRaw = Number((row).remaining);
    const max = Number.isFinite(maxRaw) ? Math.max(0, Math.trunc(maxRaw)) : null;
    const remaining = Number.isFinite(remRaw) ? Math.max(0, Math.trunc(remRaw)) : null;
    if (max == null && remaining == null) continue;
    const safeMax = max == null ? Math.max(remaining ?? 0, 0) : max;
    const safeRemaining =
      remaining == null ? safeMax : Math.max(0, Math.min(remaining, Math.max(0, safeMax)));
    out[key] = { max: safeMax, remaining: safeRemaining };
  }
  return Object.keys(out).length ? out : null;
}

function inferSpellSlotPatchFromCommand(command, playerSnapshot) {
  const cmd = toPlainString(command).toLowerCase();
  if (!cmd) return null;
  const levelMatch = cmd.match(/\b(?:niv(?:eau)?\.?\s*)(\d+)\b/) || cmd.match(/\blevel\s*(\d+)\b/);
  const level = levelMatch ? Math.max(1, Math.min(9, Math.trunc(Number(levelMatch[1]) || 0))) : null;
  if (!level) return null;
  const wantsConsume =
    /\b(retire|retirer|consomme|consommer|depense|dépenser|utilise|utiliser|use|spend)\b/.test(cmd);
  const wantsRestore =
    /\b(rend|rendre|ajoute|ajouter|restore|restaure|recupere|récupère)\b/.test(cmd);
  if (!wantsConsume && !wantsRestore) return null;
  const currentSlots = normalizeSpellSlotsShape(playerSnapshot?.spellSlots);
  if (!currentSlots) return null;
  const row = currentSlots[String(level)];
  if (!row || typeof row !== "object") return null;
  const max = Number(row.max ?? 0) || 0;
  const remaining = Number(row.remaining ?? max) || 0;
  const nextRemaining = wantsConsume
    ? Math.max(0, remaining - 1)
    : wantsRestore
      ? Math.min(max, remaining + 1)
      : remaining;
  if (nextRemaining === remaining) return null;
  return {
    spellSlotsSet: {
      ...currentSlots,
      [String(level)]: {
        max,
        remaining: nextRemaining,
      },
    },
    level,
    nextRemaining,
    action: wantsConsume ? "consume" : "restore",
  };
}

function buildRoomCatalog() {
  return Object.values(GOBLIN_CAVE)
    .filter((room) => room && typeof room === "object" && toPlainString(room.id))
    .map((room) => ({
      id: toPlainString(room.id),
      title: toPlainString(room.title),
      description: truncate(room.description, 220),
      exits: Array.isArray(room.exits)
        ? room.exits.map((exit) => ({
            id: toPlainString(exit?.id),
            direction: toPlainString(exit?.direction),
            description: truncate(exit?.description, 120),
          }))
        : [],
    }));
}

function buildTemplateCatalog() {
  return Object.entries(DEBUG_TEMPLATE_CATALOG).map(([templateId, template]) => ({
    templateId,
    name: toPlainString(template?.name || templateId),
    type: toPlainString(template?.type || "npc"),
    entityClass: toPlainString(template?.entityClass || ""),
    description: truncate(template?.description, 160),
  }));
}

function normalizeEntitiesForPrompt(entities) {
  if (!Array.isArray(entities)) return [];
  return entities
    .map((entity) => {
      if (!entity || typeof entity !== "object") return null;
      const id = toPlainString(entity.id);
      if (!id) return null;
      return {
        id,
        name: toPlainString(entity.name || id),
        type: toPlainString(entity.type || ""),
        hp:
          typeof entity?.hp?.current === "number" && typeof entity?.hp?.max === "number"
            ? `${entity.hp.current}/${entity.hp.max}`
            : "?",
        isAlive: entity.isAlive !== false,
        visible: entity.visible !== false,
      };
    })
    .filter(Boolean);
}

function normalizeMessagesForPrompt(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => {
      if (!message || typeof message !== "object") return null;
      const id = toPlainString(message.id);
      const role = message.role === "user" ? "user" : "ai";
      const type = toPlainString(message.type);
      const content = truncate(toPlainString(message.content), 220);
      if (!id || !content) return null;
      return { id, role, type: type || null, content };
    })
    .filter(Boolean)
    .slice(-40);
}

function normalizePartyPcsForPrompt(partyPcs) {
  if (!Array.isArray(partyPcs)) return [];
  return partyPcs
    .map((pc) => {
      if (!pc || typeof pc !== "object") return null;
      const combatantId = toPlainString(pc.combatantId);
      if (!combatantId) return null;
      const hpCurrent =
        typeof pc.hpCurrent === "number" && Number.isFinite(pc.hpCurrent) ? Math.trunc(pc.hpCurrent) : null;
      const hpMax = typeof pc.hpMax === "number" && Number.isFinite(pc.hpMax) ? Math.trunc(pc.hpMax) : null;
      const ac = typeof pc.ac === "number" && Number.isFinite(pc.ac) ? Math.trunc(pc.ac) : null;
      return {
        combatantId,
        clientId: toPlainString(pc.clientId) || null,
        name: toPlainString(pc.name || combatantId),
        hp:
          hpCurrent != null && hpMax != null
            ? `${hpCurrent}/${hpMax}`
            : hpCurrent != null
              ? `${hpCurrent}/?`
              : "?",
        ac,
        isLocal: pc.isLocal === true,
      };
    })
    .filter(Boolean);
}

function buildUserContent(payload) {
  const roomCatalog = buildRoomCatalog();
  const templateCatalog = buildTemplateCatalog();
  const entityLines = payload.entities.length
    ? payload.entities
        .map(
          (entity) =>
            `- id="${entity.id}" | name="${entity.name}" | type="${entity.type}" | hp=${entity.hp} | visible=${entity.visible} | alive=${entity.isAlive}`
        )
        .join("\n")
    : "(aucune entite active)";
  const roomLines = roomCatalog
    .map(
      (room) =>
        `- ${room.id} | ${room.title || "(sans titre)"} | ${room.description}${
          room.exits.length
            ? ` | exits: ${room.exits
                .map((exit) => `${exit.direction || "?"}->${exit.id}`)
                .join(", ")}`
            : ""
        }`
    )
    .join("\n");
  const templateLines = templateCatalog
    .map(
      (tpl) =>
        `- ${tpl.templateId} | ${tpl.name} | type=${tpl.type} | class=${tpl.entityClass || "?"} | ${tpl.description}`
    )
    .join("\n");
  const combatLines = Array.isArray(payload.combatOrder) && payload.combatOrder.length
    ? payload.combatOrder
        .map((entry, idx) => {
          const active = idx === payload.combatTurnIndex ? " (actif)" : "";
          return `- [${idx}] ${toPlainString(entry?.id)} init=${entry?.initiative ?? "?"}${active}`;
        })
        .join("\n")
    : "(aucun ordre)";
  const messageLines = Array.isArray(payload.messages) && payload.messages.length
    ? payload.messages
        .map(
          (message) =>
            `- id="${message.id}" | role=${message.role}${message.type ? ` | type=${message.type}` : ""} | ${message.content}`
        )
        .join("\n")
    : "(aucun message recent)";
  const partyPcsLines = Array.isArray(payload.partyPcs) && payload.partyPcs.length
    ? payload.partyPcs
        .map(
          (pc) =>
            `- id="${pc.combatantId}" | name="${pc.name}" | hp=${pc.hp} | ac=${pc.ac ?? "?"}${
              pc.clientId ? ` | clientId=${pc.clientId}` : ""
            }${pc.isLocal ? " | local=true" : ""}`
        )
        .join("\n")
    : "(aucun PJ groupe fourni)";

  return [
    `Commande dev :`,
    `"""`,
    toPlainString(payload.command),
    `"""`,
    ``,
    `Etat courant :`,
    `- debugMode: ${!!payload.debugMode}`,
    `- roomId: ${toPlainString(payload.currentRoomId) || "(inconnu)"}`,
    `- roomTitle: ${toPlainString(payload.currentSceneName) || "(inconnu)"}`,
    `- gameMode: ${toPlainString(payload.gameMode) || "exploration"}`,
    `- roomMemory: ${truncate(payload.currentRoomMemory || "(vide)", 500)}`,
    `- player: ${toPlainString(payload.player?.name) || "Joueur"} | hp=${
      typeof payload.player?.hp?.current === "number" && typeof payload.player?.hp?.max === "number"
        ? `${payload.player.hp.current}/${payload.player.hp.max}`
        : "?"
    } | ac=${payload.player?.ac ?? "?"} | des de vie=${
      typeof payload.player?.hitDiceRemaining === "number" &&
      typeof payload.player?.hitDiceTotal === "number"
        ? `${payload.player.hitDiceRemaining}/${payload.player.hitDiceTotal}${
            payload.player?.hitDie ? ` (${String(payload.player.hitDie)})` : ""
          }`
        : "?"
    }`,
    ``,
    `Entites actives :`,
    entityLines,
    ``,
    `Ordre de combat actuel :`,
    combatLines,
    ``,
    `PJ du groupe (multijoueur) :`,
    partyPcsLines,
    ``,
    `Historique chat recent :`,
    messageLines,
    ``,
    `Salles autorisees :`,
    roomLines,
    ``,
    `Templates de spawn autorises :`,
    templateLines,
    ``,
    `Retourne un JSON strict conforme au contrat.`,
  ].join("\n");
}

function parseModelJson(raw) {
  const cleaned = stripCodeFences(raw);
  if (!cleaned) return { ok: false, error: "Réponse vide." };
  try {
    const data = JSON.parse(cleaned);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "Objet JSON racine invalide." };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

function makeUniqueSpawnId(seed, usedIds) {
  const base = slugify(seed) || "spawn_debug";
  let candidate = base;
  let index = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}_${index}`;
    index += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function normalizeEntityUpdate(update, state, usedSpawnIds) {
  if (!update || typeof update !== "object") {
    throw new Error("entityUpdates contient une entrée invalide.");
  }
  const action = toPlainString(update.action);
  if (!["spawn", "update", "kill", "remove"].includes(action)) {
    throw new Error(`entityUpdates.action invalide: ${action || "(vide)"}`);
  }

  const existingIds = state.existingIds;
  const templateId = toPlainString(update.templateId);
  const template = templateId ? DEBUG_TEMPLATE_CATALOG[templateId] ?? null : null;
  if (templateId && !template) {
    throw new Error(`templateId inconnu: ${templateId}`);
  }

  let id = toPlainString(update.id);
  if (action === "spawn") {
    if (!id || existingIds.has(id) || usedSpawnIds.has(id)) {
      id = makeUniqueSpawnId(update.name || template?.name || templateId || "spawn", usedSpawnIds);
    } else {
      usedSpawnIds.add(id);
    }
  } else if (!id || (!existingIds.has(id) && id !== "player")) {
    throw new Error(`entityUpdates.id inconnu: ${id || "(vide)"}`);
  }

  const out = { action, id };

  if (templateId) out.templateId = templateId;
  const name = toPlainString(update.name);
  if (name) out.name = name;

  const type = toPlainString(update.type);
  if (type) {
    if (!["hostile", "npc", "player"].includes(type)) {
      throw new Error(`entityUpdates.type invalide: ${type}`);
    }
    out.type = type;
  }

  if (typeof update.visible === "boolean") out.visible = update.visible;
  if (typeof update.ac === "number" && Number.isFinite(update.ac)) out.ac = Math.trunc(update.ac);
  if (typeof update.acDelta === "number" && Number.isFinite(update.acDelta)) {
    out.acDelta = Math.trunc(update.acDelta);
  }
  if (typeof update.awareOfPlayer === "boolean") out.awareOfPlayer = update.awareOfPlayer;
  if (typeof update.surprised === "boolean") out.surprised = update.surprised;

  const hp = normalizeHp(update.hp);
  if (hp) out.hp = hp;

  const description = toPlainString(update.description);
  if (description) out.description = description;

  const inventory = normalizeStringArray(update.inventory);
  if (inventory) out.inventory = inventory;

  const lootItems = normalizeStringArray(update.lootItems);
  if (lootItems) out.lootItems = lootItems;

  return out;
}

function normalizePlayerPatch(value) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  if (typeof value.hpCurrent === "number" && Number.isFinite(value.hpCurrent)) {
    out.hpCurrent = Math.max(0, Math.trunc(value.hpCurrent));
  }
  if (typeof value.hpMax === "number" && Number.isFinite(value.hpMax)) {
    out.hpMax = Math.max(1, Math.trunc(value.hpMax));
  }
  const inventorySet = normalizeStringArray(value.inventorySet);
  const inventoryAdd = normalizeStringArray(value.inventoryAdd);
  const inventoryRemove = normalizeStringArray(value.inventoryRemove);
  if (inventorySet) out.inventorySet = inventorySet;
  if (inventoryAdd) out.inventoryAdd = inventoryAdd;
  if (inventoryRemove) out.inventoryRemove = inventoryRemove;
  if (typeof value.hitDiceRemaining === "number" && Number.isFinite(value.hitDiceRemaining)) {
    out.hitDiceRemaining = Math.max(0, Math.trunc(value.hitDiceRemaining));
  }
  if (typeof value.hitDiceTotal === "number" && Number.isFinite(value.hitDiceTotal)) {
    out.hitDiceTotal = Math.max(1, Math.trunc(value.hitDiceTotal));
  }
  const spellSlotsSet = normalizeSpellSlotsShape(value.spellSlotsSet);
  if (spellSlotsSet) out.spellSlotsSet = spellSlotsSet;
  return Object.keys(out).length ? out : null;
}

function normalizeRoomMemoryOps(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new Error("roomMemoryOps doit être un tableau.");
  const ops = value.map((op) => {
    if (!op || typeof op !== "object") {
      throw new Error("roomMemoryOps contient une entrée invalide.");
    }
    const roomIdRaw = toPlainString(op.roomId);
    const roomId = roomIdRaw === "current" ? "current" : roomIdRaw;
    if (!roomId || (roomId !== "current" && !GOBLIN_CAVE[roomId])) {
      throw new Error(`roomMemoryOps.roomId invalide: ${roomIdRaw || "(vide)"}`);
    }
    const mode = toPlainString(op.mode);
    if (!["append", "replace", "clear"].includes(mode)) {
      throw new Error(`roomMemoryOps.mode invalide: ${mode || "(vide)"}`);
    }
    const text = mode === "clear" ? "" : toPlainString(op.text);
    if (mode !== "clear" && !text) {
      throw new Error(`roomMemoryOps.text manquant pour ${mode}.`);
    }
    return { roomId, mode, ...(text ? { text: truncate(text, 400) } : {}) };
  });
  return ops.length ? ops : [];
}

function normalizeChatHistoryPatch(value, state) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  if (typeof value.clearAll === "boolean") out.clearAll = value.clearAll;
  if (typeof value.removeLast === "number" && Number.isFinite(value.removeLast)) {
    out.removeLast = Math.max(0, Math.trunc(value.removeLast));
  }
  const removeIds = normalizeStringArray(value.removeIds);
  if (removeIds) {
    const knownIds = new Set(state.messageIds);
    const filtered = removeIds.filter((id) => knownIds.has(id));
    if (filtered.length > 0) out.removeIds = filtered;
  }
  const removeRoles = normalizeStringArray(value.removeRoles);
  if (removeRoles) {
    const filtered = removeRoles.filter((role) => role === "user" || role === "ai");
    if (filtered.length > 0) out.removeRoles = filtered;
  }
  const allowedTypes = new Set([
    "debug",
    "meta",
    "meta-reply",
    "dice",
    "enemy-turn",
    "combat-detail",
    "scene-image",
    "scene-image-pending",
    "continue",
    "retry-action",
    "campaign-context",
  ]);
  const removeTypes = normalizeStringArray(value.removeTypes);
  if (removeTypes) {
    const filtered = removeTypes.filter((type) => allowedTypes.has(type));
    if (filtered.length > 0) out.removeTypes = filtered;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeCombatPatch(value, state) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  const mode = toPlainString(value.gameMode);
  if (mode) {
    if (!["combat", "exploration"].includes(mode)) {
      throw new Error(`combatPatch.gameMode invalide: ${mode}`);
    }
    out.gameMode = mode;
  }
  if (typeof value.clearCombat === "boolean") out.clearCombat = value.clearCombat;
  if (
    typeof value.combatTurnIndex === "number" &&
    Number.isFinite(value.combatTurnIndex) &&
    value.combatTurnIndex >= 0
  ) {
    out.combatTurnIndex = Math.trunc(value.combatTurnIndex);
  }

  if (value.combatOrder != null) {
    if (!Array.isArray(value.combatOrder)) {
      throw new Error("combatPatch.combatOrder doit être un tableau.");
    }
    const knownIds = new Set(["player", ...state.existingIds, ...state.spawnIds]);
    out.combatOrder = value.combatOrder.map((entry) => {
      if (!entry || typeof entry !== "object") {
        throw new Error("combatPatch.combatOrder contient une entrée invalide.");
      }
      const id = toPlainString(entry.id);
      if (!id || !knownIds.has(id)) {
        throw new Error(`combatPatch.combatOrder.id inconnu: ${id || "(vide)"}`);
      }
      const initiative =
        typeof entry.initiative === "number" && Number.isFinite(entry.initiative)
          ? Math.trunc(entry.initiative)
          : 0;
      return { id, initiative };
    });
  }

  return Object.keys(out).length ? out : null;
}

function normalizeTeleport(value) {
  if (!value || typeof value !== "object") return null;
  const targetRoomId = toPlainString(value.targetRoomId);
  if (!targetRoomId) return null;
  const room = GOBLIN_CAVE[targetRoomId];
  if (!room) throw new Error(`Salle inconnue: ${targetRoomId}`);
  return {
    targetRoomId,
    targetSceneName: toPlainString(room.title || room.id),
    targetSceneDescription: String(room.description ?? ""),
  };
}

function normalizeGodmodeResponse(data, payload) {
  const summary = toPlainString(data.summary);
  if (!summary) throw new Error("summary manquant.");
  const narration = toPlainString(data.narration);

  const existingIds = new Set(
    (Array.isArray(payload.entities) ? payload.entities : [])
      .map((entity) => toPlainString(entity?.id))
      .filter(Boolean)
  );
  if (Array.isArray(payload.combatOrder)) {
    for (const entry of payload.combatOrder) {
      const oid = toPlainString(entry?.id);
      if (oid) existingIds.add(oid);
    }
  }
  if (Array.isArray(payload.partyPcs)) {
    for (const pc of payload.partyPcs) {
      const pid = toPlainString(pc?.combatantId);
      if (pid) existingIds.add(pid);
    }
  }
  existingIds.add("player");
  const playerIdFromPayload =
    payload.player && typeof payload.player === "object"
      ? toPlainString(payload.player.id)
      : "";
  if (playerIdFromPayload) existingIds.add(playerIdFromPayload);

  const usedSpawnIds = new Set();
  const entityUpdates = Array.isArray(data.entityUpdates)
    ? data.entityUpdates.map((update) =>
        normalizeEntityUpdate(update, { existingIds }, usedSpawnIds)
      )
    : null;
  const spawnIds = [...usedSpawnIds];

  let playerPatch = normalizePlayerPatch(data.playerPatch);
  const hasSpellSlotMutation =
    !!playerPatch?.spellSlotsSet ||
    (Array.isArray(entityUpdates) &&
      entityUpdates.some((u) => u && typeof u === "object" && u.action === "update" && u.spellSlots));
  if (!hasSpellSlotMutation) {
    const inferred = inferSpellSlotPatchFromCommand(payload.command, payload.player);
    if (inferred?.spellSlotsSet) {
      playerPatch = {
        ...(playerPatch ?? {}),
        spellSlotsSet: inferred.spellSlotsSet,
      };
    }
  }
  const teleport = normalizeTeleport(data.teleport);
  const roomMemoryOps = normalizeRoomMemoryOps(data.roomMemoryOps);
  const chatHistoryPatch = normalizeChatHistoryPatch(data.chatHistoryPatch, {
    messageIds: (Array.isArray(payload.messages) ? payload.messages : []).map((message) => message.id),
  });
  const combatPatch = normalizeCombatPatch(data.combatPatch, {
    existingIds: [...existingIds],
    spawnIds,
  });

  return {
    summary,
    narration: narration || summary,
    teleport,
    entityUpdates,
    playerPatch,
    roomMemoryOps,
    chatHistoryPatch,
    combatPatch,
  };
}

async function generateGemini(userContent) {
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: GODMODE_SYSTEM,
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });
  const result = await model.generateContent(userContent);
  return (result.response.text() || "").trim();
}

async function generateOpenRouter(userContent) {
  const res = await fetch(OPENROUTER_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "DnD AI Godmode",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: GODMODE_SYSTEM },
        { role: "user", content: userContent },
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `Erreur OpenRouter (${res.status})`);
  }
  const data = await res.json();
  return typeof data?.choices?.[0]?.message?.content === "string"
    ? data.choices[0].message.content.trim()
    : "";
}

export async function POST(req) {
  const t0 = Date.now();
  const phaseTimestamps = { start: nowIso() };
  try {
    const body = await req.json();
    const command = toPlainString(body?.command);
    const provider = body?.provider === "openrouter" ? "openrouter" : "gemini";
    const payload = {
      command,
      debugMode: body?.debugMode === true,
      currentRoomId: toPlainString(body?.currentRoomId),
      currentSceneName: toPlainString(body?.currentSceneName),
      gameMode: toPlainString(body?.gameMode) || "exploration",
      currentRoomMemory: String(body?.currentRoomMemory ?? ""),
      player: body?.player && typeof body.player === "object" ? body.player : null,
      entities: normalizeEntitiesForPrompt(body?.entities),
      partyPcs: normalizePartyPcsForPrompt(body?.partyPcs),
      messages: normalizeMessagesForPrompt(body?.messages),
      combatOrder: Array.isArray(body?.combatOrder) ? body.combatOrder : [],
      combatTurnIndex:
        typeof body?.combatTurnIndex === "number" && Number.isFinite(body.combatTurnIndex)
          ? Math.max(0, Math.trunc(body.combatTurnIndex))
          : 0,
    };

    if (!payload.debugMode) {
      return NextResponse.json({ error: "Godmode désactivé." }, { status: 403 });
    }
    if (!command) {
      return NextResponse.json({ error: "Commande godmode vide." }, { status: 400 });
    }
    if (provider === "gemini" && !process.env.GEMINI_API_KEY) {
      return NextResponse.json({ error: "GEMINI_API_KEY manquant." }, { status: 500 });
    }
    if (provider !== "gemini" && !process.env.OPENROUTER_API_KEY) {
      return NextResponse.json({ error: "OPENROUTER_API_KEY manquant." }, { status: 500 });
    }

    const userContent = buildUserContent(payload);
    const promptMetrics = {
      userContentChars: userContent.length,
      roomCount: Object.keys(GOBLIN_CAVE ?? {}).length,
      templateCount: Object.keys(DEBUG_TEMPLATE_CATALOG ?? {}).length,
      entityCount: payload.entities.length,
    };
    console.info("[/api/debug-godmode] start", {
      provider,
      roomId: payload.currentRoomId,
      metrics: promptMetrics,
    });

    const rawOut =
      provider === "gemini"
        ? await generateGemini(userContent)
        : await generateOpenRouter(userContent);

    phaseTimestamps.afterModel = nowIso();
    console.info("[/api/debug-godmode] after-model", {
      elapsedMs: elapsedMsSince(t0),
      provider,
      rawChars: rawOut.length,
    });

    const parsed = parseModelJson(rawOut);
    if (!parsed.ok) {
      throw new Error(`JSON modèle invalide: ${parsed.error}`);
    }

    const normalized = normalizeGodmodeResponse(parsed.data, payload);
    phaseTimestamps.responseSent = nowIso();
    console.info("[/api/debug-godmode] response-sent", {
      elapsedMs: elapsedMsSince(t0),
      provider,
    });

    const traceProvider = provider === "gemini" ? "gemini" : "openrouter";
    const requestForTrace =
      traceProvider === "gemini"
        ? {
            kind: "gemini",
            model: GEMINI_MODEL,
            systemInstruction: GODMODE_SYSTEM,
            userContent,
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.1,
            },
          }
        : {
            kind: "openrouter",
            model: OPENROUTER_MODEL,
            messages: [
              { role: "system", content: GODMODE_SYSTEM },
              { role: "user", content: userContent },
            ],
            temperature: 0.1,
            response_format: { type: "json_object" },
          };

    void logInteraction(
      "DEBUG_GODMODE",
      traceProvider,
      requestForTrace,
      "",
      rawOut,
      normalized,
      {
        promptMetrics,
        timing: {
          ...phaseTimestamps,
          elapsedMs: elapsedMsSince(t0),
        },
      }
    ).then(() => {
      console.info("[/api/debug-godmode] after-log", {
        elapsedMs: elapsedMsSince(t0),
        provider,
      });
    });

    return NextResponse.json({
      ok: true,
      ...normalized,
      debugPrompt: {
        provider: traceProvider,
        model: traceProvider === "gemini" ? GEMINI_MODEL : OPENROUTER_MODEL,
        systemInstruction: truncate(GODMODE_SYSTEM, 1500),
        userContent: truncate(userContent, 2500),
      },
    });
  } catch (error) {
    console.error("[/api/debug-godmode]", error);
    return NextResponse.json(
      {
        error: "Erreur lors de l'interprétation godmode.",
        details: String(error?.message ?? error),
      },
      { status: 500 }
    );
  }
}
