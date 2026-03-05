import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Convertit l'historique du GameContext vers le format attendu par l'API Gemini.
 * - rôle "user" → "user"
 * - rôle "ai"   → "model"
 *
 * Contraintes Gemini :
 *   1. L'historique doit commencer par un message "user".
 *   2. Les rôles doivent alterner strictement (user → model → user → …).
 *   3. Le dernier message utilisateur est transmis via sendMessage(), pas dans history.
 */
function formatHistory(messages) {
  if (!messages || messages.length === 0) {
    return { history: [], userMessage: "" };
  }

  // Conversion des rôles
  const all = messages.map((msg) => ({
    role: msg.role === "user" ? "user" : "model",
    parts: [{ text: msg.content }],
  }));

  // Extrait le dernier message (doit être "user") pour sendMessage()
  const last = all[all.length - 1];
  if (last.role !== "user") {
    // Ne devrait pas arriver, mais on sécurise
    return { history: [], userMessage: "" };
  }
  const userMessage = last.parts[0].text;

  // Historique = tout sauf le dernier message utilisateur
  let history = all.slice(0, -1);

  // Règle 1 : l'historique doit commencer par "user" — on supprime les
  // éventuels messages "model" en tête (ex: message d'accueil de l'IA).
  while (history.length > 0 && history[0].role === "model") {
    history = history.slice(1);
  }

  // Règle 2 : les rôles doivent alterner. On retire les doublons consécutifs
  // en gardant le dernier de chaque groupe, ce qui préserve le sens.
  const alternating = [];
  for (const msg of history) {
    if (alternating.length > 0 && alternating[alternating.length - 1].role === msg.role) {
      alternating[alternating.length - 1] = msg; // écrase le doublon
    } else {
      alternating.push(msg);
    }
  }

  return { history: alternating, userMessage };
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { messages } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { error: "Le tableau 'messages' est requis et ne doit pas être vide." },
        { status: 400 }
      );
    }

    const model = genAI.getGenerativeModel({
      model: "gemini-3-flash-preview",
      systemInstruction:
        "Tu es le Maître du Jeu d'un jeu de rôle médiéval-fantastique. " +
        "Réponds de manière immersive et narrative, en quelques phrases maximum. " +
        "Tu peux décrire des lieux, des personnages non-joueurs et des événements. " +
        "Reste cohérent avec le contexte établi dans l'historique de la conversation.",
    });

    const { history, userMessage } = formatHistory(messages);

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(userMessage);
    const text = result.response.text();

    return NextResponse.json({ reply: text });
  } catch (error) {
    console.error("[/api/chat] Erreur Gemini :", error);

    // Détection du 429 : on extrait le délai de retry depuis le message d'erreur
    if (error.status === 429) {
      const retryMatch = error.message?.match(/retryDelay[^\d]*(\d+)s/);
      const retrySeconds = retryMatch ? parseInt(retryMatch[1], 10) : 60;

      return NextResponse.json(
        {
          error: "Quota API dépassé. Veuillez patienter avant de réessayer.",
          retryAfter: retrySeconds,
        },
        { status: 429 }
      );
    }

    return NextResponse.json(
      { error: "Erreur lors de la communication avec Gemini.", details: error.message },
      { status: 500 }
    );
  }
}
