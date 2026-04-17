import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { logInteraction } from "@/lib/aiTraceLog";
import { withTerminalAiTiming } from "@/lib/aiTerminalTimingLog";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "arcee-ai/trinity-large-preview:free";
const GEMINI_MODEL = "gemini-3-flash-preview";

/** Narration publique : aucun chiffre mécanique (le détail chiffré est affiché à part pour le joueur cible). */
const NARRATE_DRAMA_ONLY_SYSTEM = [
  "Tu es le Maître du Jeu d'une partie de Donjons & Dragons 5e.",
  "Tu reçois un objet JSON avec : enemyName, weaponName, outcome, targetName.",
  "outcome vaut exactement l'un de : fumble | miss | hit | critical_hit.",
  "Écris 2 à 4 phrases immersives en français.",
  "CONTRAINTE CRITIQUE : décris l'action du gobelin (ou de la créature) en 3e personne uniquement (ex: « Le gobelin... », « La créature... »).",
  "INTERDIT : commencer les phrases par « Tu »/« Vous » en parlant à la créature, ou utiliser « ton/ta » comme sujet de la créature.",
  "CONTRAINTE CRITIQUE : la cible du coup est le personnage dont le nom est targetName. Jamais un autre gobelin.",
  "INTERDIT : mentionner l'ennemi (enemyName) comme cible (ex: « l'épaule du gobelin ... »). Ne mentionne enemyName que comme attaquant.",
  "Décris le geste, la tension et la réaction sensible du personnage joueur.",
  "INTERDIT ABSOLU : tout chiffre (pas de d20, pas de total d'attaque, pas de CA, pas de dégâts numériques, pas de PV restants ou perdus, pas de « 3 dégâts », pas de « 10 points de vie »).",
  "INTERDIT : « JSON », « moteur », « API », « jet », « DD », « CA ».",
  "Si hit ou critical_hit : tu peux dire que le coup blesse ou fait très mal, sans quantifier.",
  'Réponds uniquement en JSON : {"narrative":"..."}',
].join("\n");

/** Créature / PNJ qui attaque une autre créature (pas le PJ). Même contraintes sans prose « joueur ». */
const NARRATE_DRAMA_CREATURE_VS_CREATURE = [
  "Tu es le Maître du Jeu d'une partie de Donjons & Dragons 5e.",
  "Tu reçois un objet JSON : enemyName (attaquant), targetName (défenseur), weaponName, outcome.",
  "outcome vaut exactement l'un de : fumble | miss | hit | critical_hit.",
  "Écris 2 à 4 phrases immersives en français, en 3e personne uniquement.",
  "Les deux noms sont des créatures ou PNJ sur le champ de bataille ; décris l'échange (attaque, parade, esquive, impact) sans invoquer de personnage joueur ni « héros ».",
  "INTERDIT : inventer des chiffres ou statistiques ; pas de « JSON », « moteur », « API », « jet », « DD », « CA ».",
  "Si hit ou critical_hit : tu peux dire que le coup blesse ou assomme un instant, sans quantifier les dégâts.",
  'Réponds uniquement en JSON : {"narrative":"..."}',
].join("\n");

/** Ancien mode (réécriture d'une ligne mécanique complète) — conservé si narrationContext absent. */
const NARRATE_SYSTEM = [
  "Tu es le Maître du Jeu d'une partie de Donjons & Dragons 5e.",
  "On te donne un résumé mécanique DÉJÀ RÉSOLU (jets, dégâts, PV) pour l'action d'un ennemi ou d'un allié en combat.",
  "Réécris-le en 2 à 4 phrases immersives en français, en 3e personne neutre.",
  "CONTRAINTE : lorsque l'ennemi attaque, la cible est le personnage joueur (le héros), et l'ennemi est bien l'acteur de l'action.",
  "INTERDIT de modifier les chiffres (jets, dégâts, PV restants). Ne mentionne pas « JSON », « moteur » ou « API ».",
  'Réponds uniquement en JSON : {"narrative":"..."}',
].join("\n");

function parseNarrative(raw) {
  try {
    const p = JSON.parse(raw);
    const n = typeof p?.narrative === "string" ? p.narrative.trim() : "";
    return n || null;
  } catch {
    return null;
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const {
      provider = "gemini",
      mechanicalLine = "",
      thoughtProcess = "",
      enemyName = "",
      narrationContext = null,
      targetName = "",
      /** false = attaque créature/PNJ contre une autre créature (pas le PJ). */
      targetsPlayer = true,
    } = body ?? {};

    const nc =
      narrationContext && typeof narrationContext === "object"
        ? {
            enemyName:
              typeof narrationContext.enemyName === "string"
                ? narrationContext.enemyName
                : String(enemyName ?? ""),
            weaponName:
              typeof narrationContext.weaponName === "string" ? narrationContext.weaponName : "",
            outcome:
              typeof narrationContext.outcome === "string" ? narrationContext.outcome : "miss",
          }
        : null;

    const userPayload = {
      mechanicalLine: typeof mechanicalLine === "string" ? mechanicalLine : String(mechanicalLine ?? ""),
      thoughtProcess: typeof thoughtProcess === "string" ? thoughtProcess : "",
      enemyName: typeof enemyName === "string" ? enemyName : "",
      narrationContext: nc,
    };

    const dramaMode = nc && nc.weaponName && ["fumble", "miss", "hit", "critical_hit"].includes(nc.outcome);
    const creatureVsCreature = dramaMode && targetsPlayer === false;
    const systemInstruction = dramaMode
      ? creatureVsCreature
        ? NARRATE_DRAMA_CREATURE_VS_CREATURE
        : NARRATE_DRAMA_ONLY_SYSTEM
      : NARRATE_SYSTEM;
    const userContent = dramaMode
      ? JSON.stringify({
          enemyName: nc.enemyName,
          weaponName: nc.weaponName,
          outcome: nc.outcome,
          targetName:
            typeof targetName === "string" && targetName.trim()
              ? targetName.trim()
              : creatureVsCreature
                ? "l'autre créature"
                : "le héros",
          targetsPlayer: !creatureVsCreature,
        })
      : JSON.stringify({
          mechanicalLine: userPayload.mechanicalLine,
          thoughtProcess: userPayload.thoughtProcess,
          enemyName: userPayload.enemyName,
        });
    const raw =
      provider === "gemini"
        ? await withTerminalAiTiming(
            {
              routePath: "/api/chat-combat",
              agentLabel: "Narration combat (GM)",
              provider: "Gemini",
              model: GEMINI_MODEL,
            },
            async () => {
              const model = genAI.getGenerativeModel({
                model: GEMINI_MODEL,
                systemInstruction,
                generationConfig: { responseMimeType: "application/json" },
              });
              const result = await model.generateContent(userContent);
              return result.response.text() || "";
            }
          )
        : await withTerminalAiTiming(
            {
              routePath: "/api/chat-combat",
              agentLabel: "Narration combat (GM)",
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
                  "X-Title": "DnD Chat Combat",
                },
                body: JSON.stringify({
                  model: OPENROUTER_MODEL,
                  messages: [
                    { role: "system", content: systemInstruction },
                    { role: "user", content: userContent },
                  ],
                }),
              });
              if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error?.message ?? `OpenRouter ${res.status}`);
              }
              const data = await res.json();
              return data?.choices?.[0]?.message?.content ?? "";
            }
          );

    const narrated = parseNarrative(raw);
    const tn =
      typeof targetName === "string" && targetName.trim() ? targetName.trim() : creatureVsCreature ? "l'autre créature" : "le héros";
    const dramaFallbacks = creatureVsCreature
      ? {
          fumble: nc
            ? `Le ${nc.enemyName} manque son geste avec ${nc.weaponName} ; ${tn} profite de l'ouverture pour se dégager.`
            : "L'attaque part de travers.",
          miss: nc
            ? `${tn} esquive ou pare l'assaut de ${nc.enemyName} (${nc.weaponName}).`
            : "Le coup ne trouve pas sa cible.",
          hit: nc
            ? `${nc.enemyName} porte un coup au ${nc.weaponName} ; ${tn} vacille sous l'impact.`
            : "Le coup porte.",
          critical_hit: nc
            ? `${nc.enemyName} assène un coup dévastateur avec ${nc.weaponName} ; ${tn} chancelle gravement.`
            : "Un coup particulièrement violent s'abat sur la cible.",
        }
      : {
          fumble: nc
            ? `Le ${nc.enemyName} tente de frapper au ${nc.weaponName}, mais le coup part dans le vide dans un mouvement maladroit ; ${tn} esquive de justesse.`
            : "L'attaque échoue de manière pitoyable.",
          miss: nc
            ? `Le ${nc.enemyName} attaque au ${nc.weaponName}, mais ${tn} parvient à esquiver ou à parer à temps.`
            : "Le coup ne trouve pas sa cible.",
          hit: nc
            ? `${tn} est touché par le ${nc.weaponName} du ${nc.enemyName} ; un impact le saisit.`
            : "Le coup porte.",
          critical_hit: nc
            ? `${tn} subit un coup brutal au ${nc.weaponName} ; l'impact le sonne un instant.`
            : "Un coup particulièrement violent vous atteint.",
        };
    const fallback = dramaMode
      ? dramaFallbacks[nc.outcome] || dramaFallbacks.miss
      : userPayload.mechanicalLine || "L'ennemi agit.";
    const narrative = narrated || fallback;
    const parsedResponse = { narrative, polished: !!narrated };

    await logInteraction("GM_CHAT_COMBAT", provider, userPayload, systemInstruction, raw, parsedResponse);

    return NextResponse.json(parsedResponse);
  } catch (error) {
    return NextResponse.json(
      { error: "chat-combat failed", details: error?.message ?? String(error) },
      { status: 500 }
    );
  }
}
