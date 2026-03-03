"use client";

import { createContext, useContext, useState } from "react";

// ---------------------------------------------------------------------------
// Données factices chargées au démarrage
// ---------------------------------------------------------------------------

const INITIAL_PLAYER = {
  nom: "Thorin Pied-de-Pierre",
  classe: "Guerrier",
  hp: { current: 28, max: 40 },
};

const INITIAL_MESSAGES = [
  {
    id: 1,
    role: "ai",
    content:
      "Bienvenue, aventurier. Vous vous réveillez dans une taverne sombre. Une silhouette encapuchonnée vous observe depuis le coin de la salle. Que faites-vous ?",
  },
  {
    id: 2,
    role: "user",
    content: "Je m'approche prudemment de la silhouette, la main sur la garde de mon épée.",
  },
  {
    id: 3,
    role: "ai",
    content:
      "La silhouette lève une main apaisante. Une voix douce murmure : « Je ne vous veux aucun mal, Thorin. J'ai une proposition… et peu de temps. »",
  },
];

// ---------------------------------------------------------------------------
// Création du contexte
// ---------------------------------------------------------------------------

const GameContext = createContext(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function GameProvider({ children }) {
  const [player, setPlayer] = useState(INITIAL_PLAYER);
  const [messages, setMessages] = useState(INITIAL_MESSAGES);

  /** Ajoute un message à la liste. role: 'user' | 'ai' */
  function addMessage(role, content) {
    setMessages((prev) => [
      ...prev,
      { id: Date.now(), role, content },
    ]);
  }

  /** Met à jour un ou plusieurs champs du joueur */
  function updatePlayer(patch) {
    setPlayer((prev) => ({ ...prev, ...patch }));
  }

  /** Met à jour les HP (current seulement, clampé entre 0 et max) */
  function setHp(value) {
    setPlayer((prev) => ({
      ...prev,
      hp: {
        ...prev.hp,
        current: Math.max(0, Math.min(value, prev.hp.max)),
      },
    }));
  }

  return (
    <GameContext.Provider value={{ player, messages, addMessage, updatePlayer, setHp }}>
      {children}
    </GameContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook utilitaire
// ---------------------------------------------------------------------------

export function useGame() {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error("useGame doit être utilisé à l'intérieur d'un <GameProvider>.");
  return ctx;
}
