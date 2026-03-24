/**
 * Route API du narrateur MJ : Gemini (SDK + Context Caching optionnel) ou OpenRouter.
 * La construction détaillée du prompt vit dans {@link ./gmNarratorPrompt.js} (séparation statique / dynamique).
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAICacheManager } from "@google/generative-ai/server";
import { NextResponse } from "next/server";
import { BESTIARY } from "@/data/bestiary";
import { assignSpawnAdjectiveName, isGenericOrColdSpawnName } from "@/lib/spawnDisplayNames";
import { CAMPAIGN_CONTEXT, GOBLIN_CAVE } from "@/data/campaign";
import { logInteraction } from "@/lib/aiTraceLog";
import {
  buildDynamicContext,
  composeFullNarratorSystemInstruction,
  getStaticSystemRules,
} from "./gmNarratorPrompt.js";

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const cacheManager = new GoogleAICacheManager(process.env.GEMINI_API_KEY);

const OPENROUTER_BASE  = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "arcee-ai/trinity-large-preview:free";
const GEMINI_MODEL     = "gemini-3-flash-preview";
const NARRATOR_CACHE_TTL_SECONDS = 3 * 60 * 60;
const NARRATOR_CACHE_DISPLAY_NAME = "dnd-gm-system-prompt-v1";
let narratorCachePromise = null;
/** Active le Context Caching : seul getStaticSystemRules() est stocké côté API ; le tour courant passe en JSON (dynamicContext). */
const USE_GEMINI_CACHE = process.env.USE_GEMINI_CACHE === "true";

// ---------------------------------------------------------------------------
// Messages visibles pour le narrateur (exclut debug / méta bruitée)
// ---------------------------------------------------------------------------
function filterMessagesForNarratorModel(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  return arr.filter((m) => {
    if (!m || typeof m !== "object") return false;
    if (m.role !== "user" && m.role !== "ai") return false;
    const type = String(m.type ?? "").toLowerCase();
    if (type === "debug" || type === "continue" || type === "campaign-context") return false;
    const content = String(m.content ?? "").trim();
    if (!content) return false;
    if (/^\[DEBUG]/i.test(content)) return false;
    if (/^\[(continue|sceneentered|jet secret résolu)\]/i.test(content)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Formatage historique pour Gemini (SDK natif)
// ---------------------------------------------------------------------------
function formatHistoryForGemini(messages) {
  const filtered = filterMessagesForNarratorModel(messages);
  if (filtered.length === 0) return { history: [], userMessage: "" };

  const all = filtered.map((msg) => ({
    role: msg.role === "user" ? "user" : "model",
    parts: [{ text: msg.content }],
  }));

  const last = all[all.length - 1];
  if (last.role !== "user") return { history: [], userMessage: "" };

  const userMessage = last.parts[0].text;
  let history = all.slice(0, -1);

  while (history.length > 0 && history[0].role === "model") {
    history = history.slice(1);
  }

  const alternating = [];
  for (const msg of history) {
    if (alternating.length > 0 && alternating[alternating.length - 1].role === msg.role) {
      alternating[alternating.length - 1] = msg;
    } else {
      alternating.push(msg);
    }
  }

  return { history: alternating, userMessage };
}

// ---------------------------------------------------------------------------
// Formatage messages pour OpenRouter (format OpenAI)
// ---------------------------------------------------------------------------
function buildOpenRouterMessages(messages, systemInstruction) {
  const result = [{ role: "system", content: systemInstruction }];
  for (const msg of messages) {
    result.push({
      role: msg.role === "user" ? "user" : "assistant",
      content: msg.content,
    });
  }
  return result;
}

function truncateText(s, n = 800) {
  const str = typeof s === "string" ? s : String(s ?? "");
  return str.length > n ? str.slice(0, n) + "…" : str;
}

function previewMessages(msgs, maxMsgs = 10) {
  const arr = Array.isArray(msgs) ? msgs : [];
  const sliced = arr.slice(Math.max(0, arr.length - maxMsgs));
  return sliced.map((m) => ({
    role: m.role,
    content: truncateText(m.content, 1200),
  }));
}

function buildRecentChatForNarrator(messages, maxMsgs = 12) {
  const filtered = filterMessagesForNarratorModel(messages);
  const tail = filtered.slice(-maxMsgs);
  return tail.map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    type: m.type ?? null,
    content: truncateText(m.content, 500),
  }));
}

function isGeminiCacheTooSmallError(error) {
  const msg = String(error?.message ?? "");
  return /Cached content is too small|min_total_token_count/i.test(msg);
}

async function getNarratorCache() {
  if (!USE_GEMINI_CACHE) return null;
  if (!narratorCachePromise) {
    narratorCachePromise = cacheManager.create({
      model: `models/${GEMINI_MODEL}`,
      displayName: NARRATOR_CACHE_DISPLAY_NAME,
      systemInstruction: {
        parts: [{ text: getStaticSystemRules() }],
      },
      ttlSeconds: NARRATOR_CACHE_TTL_SECONDS,
    }).catch((error) => {
      narratorCachePromise = null;
      throw error;
    });
  }
  return narratorCachePromise;
}

/**
 * Réinitialise la promesse de cache narrateur (après purge côté API via /api/admin/clear-cache).
 * Au prochain message avec USE_GEMINI_CACHE, un nouveau CachedContent sera créé.
 */
export function resetNarratorCache() {
  narratorCachePromise = null;
}

// ---------------------------------------------------------------------------
// Parsing de la réponse JSON
// ---------------------------------------------------------------------------

/** Normalise combatOrder (clés JSON instables côté IA → format UI). */
function normalizeCombatOrderFromAi(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const entry of raw) {
    if (entry == null || typeof entry !== "object") continue;
    const id = String(entry.id ?? entry.entityId ?? entry.entity_id ?? "").trim();
    let ini = entry.initiative ?? entry.value ?? entry.score ?? 0;
    if (typeof ini === "string") {
      const n = parseFloat(String(ini).replace(",", "."));
      ini = Number.isFinite(n) ? n : 0;
    }
    if (typeof ini !== "number" || !Number.isFinite(ini)) ini = 0;
    if (!id) continue;
    const name =
      typeof entry.name === "string" && entry.name.trim()
        ? entry.name.trim()
        : id === "player"
          ? "Joueur"
          : id;
    out.push({ id, name, initiative: ini });
  }
  return out.length ? out : null;
}

/** Extrait actionIntent (Command pattern — intentions combat côté moteur). */
function normalizeActionIntentFromAi(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = raw.type ?? raw.actionType ?? raw.intentType;
  const allowed = new Set([
    "move",
    "attack",
    "move_and_attack",
    "disengage",
    "spell",
    "second_wind",
    "end_turn",
    "loot",
  ]);
  if (!type || !allowed.has(String(type))) return null;
  const targetId = String(raw.targetId ?? raw.target ?? raw.entityId ?? raw.entity_id ?? "").trim() || null;
  const itemName = String(
    raw.itemName ?? raw.weaponName ?? raw.weapon ?? raw.spellName ?? raw.spell ?? ""
  ).trim() || null;
  return { type: String(type), targetId, itemName };
}

function normalizeSkillKeyForAbility(skill) {
  const raw = String(skill ?? "").trim();
  if (!raw) return "";
  // enlever les parenthèses éventuelles puis normaliser sans accents
  const base = raw.replace(/\(.+?\)/g, "").trim();
  const noAccents = base.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return noAccents.toLowerCase().replace(/[^a-z]/g, "");
}

function inferStatFromSkillFr(skill) {
  // Correspondance D&D 5e, en stat keys moteur (FOR/DEX/CON/INT/SAG/CHA).
  const SKILL_TO_STAT = {
    // STR
    athletisme: "FOR",
    // DEX
    acrobatie: "DEX",
    escamotage: "DEX",
    discretion: "DEX",
    // CON
    // (peu fréquent en skill check d'exploration côté moteur)
    // INT
    arcanes: "INT",
    arcane: "INT",
    histoire: "INT",
    investigation: "INT",
    nature: "INT",
    religion: "INT",
    // WIS
    perception: "SAG",
    intuition: "SAG",
    medecine: "SAG",
    medicine: "SAG",
    survie: "SAG",
    // CHA
    intimidation: "CHA",
    tromperie: "CHA",
    deception: "CHA",
    persuasion: "CHA",
    representation: "CHA",
    performance: "CHA",
  };

  const key = normalizeSkillKeyForAbility(skill);
  return SKILL_TO_STAT[key] ?? null;
}

function normalizeCheckOrSaveIntentToRollRequestFromAi(rawActionIntent) {
  if (!rawActionIntent || typeof rawActionIntent !== "object") return null;
  const type = rawActionIntent.type ?? rawActionIntent.actionType ?? rawActionIntent.intentType;
  // Le moteur attend rollRequest.kind="check" ou "save".
  // Certains MJ renvoient (à tort) actionIntent.type="skill_check".
  // On convertit aussi ce cas pour éviter de perdre le jet.
  let kind = null;
  if (type === "check" || type === "save") {
    kind = String(type);
  } else if (type === "skill_check" || type === "skill-check" || type === "skillcheck") {
    kind = "check";
  }
  if (!kind) return null;

  const skill = typeof rawActionIntent.skill === "string" ? rawActionIntent.skill.trim() : null;
  const difficultyClass =
    typeof rawActionIntent.difficultyClass === "number"
      ? rawActionIntent.difficultyClass
      : rawActionIntent.difficulty != null
        ? Number(rawActionIntent.difficulty)
      : rawActionIntent.dc != null
        ? Number(rawActionIntent.dc)
        : rawActionIntent.DC != null
          ? Number(rawActionIntent.DC)
          : null;

  const dc = Number.isFinite(difficultyClass) ? difficultyClass : null;
  if (dc == null) return null;

  const reason = String(
    rawActionIntent.raison ?? rawActionIntent.reason ?? rawActionIntent.actionDescription ?? "Jet de compétence"
  ).trim();

  // Stat: obligatoire côté moteur (ChatInterface check/save). Inférer à partir du skill si absent.
  const statFromAi = typeof rawActionIntent.stat === "string" ? rawActionIntent.stat.trim() : null;
  const attributeFromAi = typeof rawActionIntent.attribute === "string" ? rawActionIntent.attribute.trim() : null;
  const abilityFromAi = typeof rawActionIntent.ability === "string" ? rawActionIntent.ability.trim() : null;
  const inferredStat = statFromAi || attributeFromAi || abilityFromAi || (skill ? inferStatFromSkillFr(skill) : null);
  if (!inferredStat) return null;

  const out = {
    kind,
    stat: inferredStat,
    dc,
    raison: reason,
  };
  if (skill) out.skill = skill;
  if (rawActionIntent.targetId != null) out.targetId = rawActionIntent.targetId;
  if (rawActionIntent.weaponName != null) out.weaponName = rawActionIntent.weaponName;

  return out;
}

function normalizeStatFromFreeText(raw) {
  const t = String(raw ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (!t) return null;
  if (/\b(str|strength|force)\b/.test(t)) return "FOR";
  if (/\b(dex|dexterity|desterite|dexterite)\b/.test(t)) return "DEX";
  if (/\b(con|constitution)\b/.test(t)) return "CON";
  if (/\b(int|intelligence)\b/.test(t)) return "INT";
  if (/\b(wis|wisdom|sagesse)\b/.test(t)) return "SAG";
  if (/\b(cha|charisma|charisme)\b/.test(t)) return "CHA";
  return null;
}

function normalizeTextualCheckOrSaveToRollRequest(rawActionIntent) {
  if (typeof rawActionIntent !== "string") return null;
  const text = rawActionIntent.trim();
  if (!text) return null;

  const low = text.toLowerCase();
  const kind =
    /\bsave\b|saving throw|jet de sauvegarde/.test(low)
      ? "save"
      : /\bcheck\b|jet/.test(low)
        ? "check"
        : null;
  if (!kind) return null;

  const dcMatch = text.match(/\bDC\s*[:=]?\s*(\d{1,2})\b/i) || text.match(/\bDD\s*[:=]?\s*(\d{1,2})\b/i);
  const dc = dcMatch ? Number(dcMatch[1]) : null;
  if (!Number.isFinite(dc)) return null;

  const stat = normalizeStatFromFreeText(text);
  if (!stat) return null;

  return {
    kind,
    stat,
    dc,
    raison: text,
  };
}

function normalizeRollRequestFromLooseAi(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kindRaw = String(raw.kind ?? raw.type ?? "check").trim().toLowerCase();
  const kind =
    kindRaw === "save" || kindRaw === "saving_throw" || kindRaw === "saving-throw"
      ? "save"
      : kindRaw === "gm_secret"
        ? "gm_secret"
        : kindRaw === "attack"
          ? "attack"
          : "check";

  if (kind === "gm_secret") {
    const roll = String(raw.roll ?? "").trim();
    const reason = String(raw.reason ?? raw.raison ?? "Jet secret MJ").trim();
    if (!roll) return null;
    return { kind: "gm_secret", roll, reason };
  }

  const statRaw = raw.stat ?? raw.attribute ?? raw.ability ?? null;
  const stat = normalizeStatFromFreeText(statRaw) ?? (typeof statRaw === "string" ? statRaw.trim() : null);
  const dcRaw = raw.dc ?? raw.DC ?? raw.difficultyClass ?? null;
  const dcNum = dcRaw == null ? null : Number(dcRaw);
  const dc = Number.isFinite(dcNum) ? dcNum : null;
  const skill = typeof raw.skill === "string" ? raw.skill.trim() : null;
  const reason = String(raw.raison ?? raw.reason ?? raw.actionDescription ?? "Jet de compétence").trim();

  if (!stat) return null;
  if ((kind === "check" || kind === "save") && dc == null) return null;

  const out = { kind, stat, raison: reason };
  if (dc != null) out.dc = dc;
  if (skill) out.skill = skill;
  if (raw.targetId != null) out.targetId = raw.targetId;
  if (raw.weaponName != null) out.weaponName = raw.weaponName;
  return out;
}

/** Nom bestaire pour un spawn (templateId ou heuristique sur id). */
function templateNameForSpawnUpdate(update) {
  const tid =
    typeof update?.templateId === "string" && update.templateId.trim()
      ? update.templateId.trim()
      : null;
  if (tid && BESTIARY[tid]?.name) return String(BESTIARY[tid].name).trim();
  const id = String(update?.id ?? "");
  for (const key of Object.keys(BESTIARY)) {
    if (id.toLowerCase().includes(key.toLowerCase()) && BESTIARY[key]?.name) {
      return String(BESTIARY[key].name).trim();
    }
  }
  return "";
}

/**
 * Filet serveur : spawns sans name distinct ou avec le seul nom du template (ex. plusieurs « Gobelin »).
 * Aligné sur le moteur client (GameContext.applyEntityUpdates).
 */
function normalizeSpawnNamesInEntityUpdates(entityUpdates, existingEntities = []) {
  if (!Array.isArray(entityUpdates) || entityUpdates.length === 0) return entityUpdates;
  const usedByBase = {};
  let virtualEntities = [...(existingEntities || [])];
  return entityUpdates.map((u) => {
    if (!u || u.action !== "spawn") return u;
    const templateBaseName = templateNameForSpawnUpdate(u);
    const providedName = typeof u.name === "string" ? u.name.trim() : "";
    const nameMissingOrGeneric =
      !providedName ||
      (!!templateBaseName && isGenericOrColdSpawnName(templateBaseName, providedName));
    if (!nameMissingOrGeneric) return u;
    const base = templateBaseName || providedName || "Créature";
    const key = base.toLowerCase();
    if (!usedByBase[key]) usedByBase[key] = new Set();
    const name = assignSpawnAdjectiveName(base, virtualEntities, usedByBase[key]);
    virtualEntities = [...virtualEntities, { name }];
    return { ...u, name };
  });
}

function tryParseJsonLenient(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}

  // Cas fréquent: une accolade fermante en trop en fin de payload.
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== "}") continue;
    const candidate = text.slice(0, i).trim();
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  // Cas fallback: extraire le premier objet JSON top-level équilibré.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {}
      }
    }
  }
  return null;
}

function parseResponse(raw, existingEntities = []) {
  try {
    const parsed = tryParseJsonLenient(raw);
    if (!parsed) throw new Error("Invalid JSON");
    let data = Array.isArray(parsed) ? parsed[0] : parsed;
    if (data === null || typeof data !== "object") {
      data = {};
    }
    const textContent =
      data.narrative ||
      data.narration ||
      data.reply ||
      data.message ||
      data.text ||
      data.dialogue ||
      "";
    const reply =
      typeof textContent === "string"
        ? textContent.trim()
        : JSON.stringify(textContent);
    if (reply === "") {
      console.warn("JSON PARSING WARNING: Missing narrative key. Raw data:", data);
    }

    return {
      valid: true,
      reply,
      rollRequest: null,
      actionIntent: null,
      gameMode: null,
      entityUpdates: null,
      combatOrder: null,
      playerHpUpdate: null,
      sceneUpdate: null,
      gmContinue: false,
    };
  } catch {
    return {
      valid: true,
      reply: raw,
      rollRequest: null,
      actionIntent: null,
      gameMode: null,
      entityUpdates: null,
      combatOrder: null,
      playerHpUpdate: null,
      sceneUpdate: null,
      gmContinue: false,
    };
  }
}

function buildFormatRetryInstruction(formatIssue, previousRaw) {
  const safeIssue = String(formatIssue ?? "format invalide").trim();
  const rawPreview = truncateText(String(previousRaw ?? ""), 1200);
  return (
    `[FORMAT INVALIDE DETECTE] ${safeIssue}\n` +
    `Ta réponse précédente ne respecte pas le contrat JSON du narrateur.\n` +
    `Respecte STRICTEMENT le format demandé: un objet JSON unique avec la clé "narrative".\n` +
    `Renvoie UNIQUEMENT le JSON final, sans markdown ni texte hors JSON.\n` +
    `Réponse invalide précédente (extrait):\n${rawPreview}`
  );
}

function detectFormatIssue(raw) {
  const parsed = tryParseJsonLenient(raw);
  if (!parsed) return "JSON invalide ou non parseable";
  const data = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!data || typeof data !== "object") return "racine JSON invalide (objet requis)";
  const narrative = data.narrative ?? data.narration ?? data.reply ?? data.message ?? data.text ?? "";
  if (typeof narrative !== "string") return "narrative non-string";
  if (!narrative.trim()) return "narrative manquante ou vide";
  return null;
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------
export async function POST(request) {
  try {
    const body = await request.json();
    const {
      messages,
      player,
      currentScene,
      currentRoomId,
      provider = "openrouter",
      entities = [],
      gameMode = "exploration",
      engineEvent = null,
      debugMode = false,
    } = body;

    console.log(
      USE_GEMINI_CACHE
        ? "[Gemini] Mode Cache: ACTIF - Utilisation du contexte cache."
        : "[Gemini] Mode Cache: INACTIF - Envoi du prompt complet."
    );

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { error: "Le tableau 'messages' est requis et ne doit pas être vide." },
        { status: 400 }
      );
    }

    // Conserver l'ordre complet des messages pour que le narrateur garde tout le contexte.
    const limitedMessages = messages;

    const sceneStr = currentScene ?? "Environnement non spécifié.";

    // Contexte campagne : graphe (GOBLIN_CAVE) + prose globale (CAMPAIGN_CONTEXT), sans logique par id de salle.
    let campaignContext = null;
    const roomId = typeof currentRoomId === "string" ? currentRoomId.trim() : "";
    const currentRoom = roomId && GOBLIN_CAVE[roomId] ? GOBLIN_CAVE[roomId] : null;
    if (currentRoom) {
      const exits = Array.isArray(currentRoom.exits) ? currentRoom.exits : [];
      const allowedExits = exits
        .map((exitDef) => {
          const exitId =
            typeof exitDef === "string"
              ? exitDef
              : String(exitDef?.id ?? "").trim();
          const exitDesc =
            exitDef && typeof exitDef === "object"
              ? String(exitDef.description ?? "").trim()
              : "";
          const r = GOBLIN_CAVE[exitId];
          return r
            ? {
                id: r.id,
                title: r.title ?? r.id,
                description: exitDesc || (r.description ?? ""),
              }
            : null;
        })
        .filter(Boolean);
      campaignContext = {
        currentRoomSecrets: currentRoom.secrets ?? "",
        currentRoomTitle: currentRoom.title ?? roomId,
        allowedExits,
        encounterEntities: Array.isArray(currentRoom.encounterEntities)
          ? currentRoom.encounterEntities
          : [],
      };
    }
    const narratorCampaignContext = String(CAMPAIGN_CONTEXT?.narratorCampaignContext ?? "").trim();
    if (narratorCampaignContext) {
      campaignContext = campaignContext
        ? { ...campaignContext, narratorCampaignContext }
        : { narratorCampaignContext };
    }

    const dynamicContext = buildDynamicContext(
      player,
      sceneStr,
      entities,
      gameMode,
      engineEvent,
      campaignContext
    );
    const staticSystemRules = getStaticSystemRules();
    /** Même ordre que l’ancien prompt monolithique : faits de partie puis règles invariantes. */
    const systemInstruction = composeFullNarratorSystemInstruction(
      dynamicContext,
      staticSystemRules
    );

    // -----------------------------------------------------------------------
    // Chemin A : Google Gemini (SDK natif)
    // -----------------------------------------------------------------------
    if (provider === "gemini") {
      if (USE_GEMINI_CACHE) {
        try {
          const cache = await getNarratorCache();
          const model = genAI.getGenerativeModel({
            model: GEMINI_MODEL,
            cachedContent: cache.name,
            generationConfig: { responseMimeType: "application/json" },
          });

          const { userMessage } = formatHistoryForGemini(limitedMessages);
          const recentChat = buildRecentChatForNarrator(limitedMessages, 14);
          const dynamicInput = {
            dynamicContext,
            gameContext: {
              player,
              currentScene: sceneStr,
              currentRoomId: roomId || null,
              entities,
              gameMode,
              engineEvent,
              campaignContext,
            },
            playerMessage: userMessage,
            recentChat,
            recentChatInstruction:
              "Utilise recentChat pour comprendre le contexte et éviter les répétitions. Ne re-raconte pas un déplacement ou une arrivée déjà narrés si le joueur n'apporte pas d'élément nouveau.",
          };
          let formatRetryUsed = false;
          let formatRetryReason = null;
          const result = await model.generateContent(JSON.stringify(dynamicInput));
          let raw = result.response.text();
          let formatIssue = detectFormatIssue(raw);
          if (formatIssue) {
            formatRetryUsed = true;
            formatRetryReason = formatIssue;
            const retryInput = {
              ...dynamicInput,
              formatRetryInstruction: buildFormatRetryInstruction(formatIssue, raw),
            };
            const retryResult = await model.generateContent(JSON.stringify(retryInput));
            raw = retryResult.response.text();
          }

          const parsed = parseResponse(raw, entities);
          await logInteraction("GM", "gemini-cache", dynamicInput, staticSystemRules, raw, parsed);
          return NextResponse.json({
            ...parsed,
            formatRetryUsed,
            formatRetryReason,
            debugPrompt: {
              provider: "gemini",
              cacheMode: "active",
              cachedContent: cache.name,
              staticRulesPreview: truncateText(staticSystemRules, 1200),
              dynamicInputPreview: truncateText(JSON.stringify(dynamicInput), 2500),
            },
          });
        } catch (cacheErr) {
          if (!isGeminiCacheTooSmallError(cacheErr)) throw cacheErr;
          console.warn("[Gemini] Cache rejeté (prompt trop petit), fallback standard sans cache.");
        }
      }

      // Fallback dev / prompt-engineering : mode Gemini standard sans cache.
      const model = genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        systemInstruction,
        generationConfig: { responseMimeType: "application/json" },
      });
      const { history, userMessage } = formatHistoryForGemini(limitedMessages);
      const chat = model.startChat({ history });
      let formatRetryUsed = false;
      let formatRetryReason = null;
      const result = await chat.sendMessage(userMessage);
      let raw = result.response.text();
      const formatIssue = detectFormatIssue(raw);
      if (formatIssue) {
        formatRetryUsed = true;
        formatRetryReason = formatIssue;
        const retryMessage = buildFormatRetryInstruction(formatIssue, raw);
        const retryResult = await chat.sendMessage(retryMessage);
        raw = retryResult.response.text();
      }

      const parsed = parseResponse(raw, entities);
      const dynamicInputNoCache = {
        mode: "gemini-no-cache",
        dynamicContext,
        messagesOrdered: limitedMessages,
        gameContext: {
          player,
          currentScene: sceneStr,
          currentRoomId: roomId || null,
          entities,
          gameMode,
          engineEvent,
          campaignContext,
        },
        userMessage,
        history,
        systemInstruction,
      };
      await logInteraction("GM", "gemini", dynamicInputNoCache, staticSystemRules, raw, parsed);
      return NextResponse.json({
        ...parsed,
        formatRetryUsed,
        formatRetryReason,
        debugPrompt: {
          provider: "gemini",
          cacheMode: "inactive",
          systemInstruction,
          historyPreview: history?.slice?.(-10) ?? [],
          userMessagePreview: truncateText(userMessage, 2000),
        },
      });
    }

    // -----------------------------------------------------------------------
    // Chemin B : OpenRouter (format OpenAI)
    // -----------------------------------------------------------------------
    const openRouterMessages = buildOpenRouterMessages(
      filterMessagesForNarratorModel(limitedMessages),
      systemInstruction
    );

    const res = await fetch(OPENROUTER_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "DnD AI Master",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: openRouterMessages,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      if (res.status === 429) {
        return NextResponse.json(
          { error: "Quota API dépassé. Veuillez patienter avant de réessayer.", retryAfter: 60 },
          { status: 429 }
        );
      }
      throw new Error(errData.error?.message ?? `Erreur OpenRouter (${res.status})`);
    }

    let formatRetryUsed = false;
    let formatRetryReason = null;
    const data = await res.json();
    let raw  = data.choices?.[0]?.message?.content ?? "";
    const formatIssue = detectFormatIssue(raw);
    if (formatIssue) {
      formatRetryUsed = true;
      formatRetryReason = formatIssue;
      const retryMessages = [
        ...openRouterMessages,
        { role: "assistant", content: raw },
        { role: "user", content: buildFormatRetryInstruction(formatIssue, raw) },
      ];
      const retryRes = await fetch(OPENROUTER_BASE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "DnD AI Master",
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: retryMessages,
          response_format: { type: "json_object" },
        }),
      });
      if (retryRes.ok) {
        const retryData = await retryRes.json();
        raw = retryData.choices?.[0]?.message?.content ?? raw;
      }
    }

    // parseResponse est déjà blindé (fallback narration brute si JSON foireux)
    const safe = parseResponse(raw, entities);
    const dynamicInputOpenRouter = {
      mode: "openrouter",
      model: OPENROUTER_MODEL,
      messagesOrdered: limitedMessages,
      messages: openRouterMessages,
    };
    await logInteraction("GM", "openrouter", dynamicInputOpenRouter, staticSystemRules, raw, safe);
    return NextResponse.json({
      ...safe,
      formatRetryUsed,
      formatRetryReason,
      debugPrompt: {
        provider: "openrouter",
        model: OPENROUTER_MODEL,
        systemInstruction,
        messagesPreview: previewMessages(openRouterMessages, 12),
      },
    });

  } catch (error) {
    console.error("[/api/chat] Erreur :", error);

    if (error.status === 429) {
      const retryMatch = error.message?.match(/retryDelay[^\d]*(\d+)s/);
      const retrySeconds = retryMatch ? parseInt(retryMatch[1], 10) : 60;
      return NextResponse.json(
        { error: "Quota API dépassé. Veuillez patienter avant de réessayer.", retryAfter: retrySeconds },
        { status: 429 }
      );
    }

    return NextResponse.json(
      { error: "Erreur lors de la communication avec l'IA.", details: error.message },
      { status: 500 }
    );
  }
}
