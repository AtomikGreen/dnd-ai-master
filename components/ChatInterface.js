"use client";

import { useEffect, useRef, useState } from "react";
import { useGame } from "@/context/GameContext";
import { playBip } from "@/lib/sounds";

const AI_REPLY = "Ceci est une réponse simulée. Je ne suis pas encore connecté à Gemini.";
const REPLY_DELAY_MS = 1000;

export default function ChatInterface() {
  const { messages, addMessage } = useGame();
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const bottomRef = useRef(null);

  // Scroll automatique vers le bas à chaque nouveau message ou pendant la frappe
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || isTyping) return;

    addMessage("user", trimmed);
    setInput("");
    setIsTyping(true);

    setTimeout(() => {
      addMessage("ai", AI_REPLY);
      setIsTyping(false);
      playBip();
    }, REPLY_DELAY_MS);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Zone de messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((msg) =>
          msg.role === "user" ? (
            // Message joueur — aligné à droite, bleu
            <div key={msg.id} className="flex justify-end">
              <div className="max-w-[75%] rounded-2xl rounded-tr-sm bg-blue-600 px-4 py-2 text-sm text-white shadow">
                <p className="mb-1 text-xs font-semibold text-blue-200">Vous</p>
                <p className="leading-relaxed">{msg.content}</p>
              </div>
            </div>
          ) : (
            // Message IA — aligné à gauche, gris
            <div key={msg.id} className="flex justify-start">
              <div className="max-w-[75%] rounded-2xl rounded-tl-sm bg-slate-700 px-4 py-2 text-sm text-slate-100 shadow">
                <p className="mb-1 text-xs font-semibold text-slate-400">Maître du Jeu</p>
                <p className="leading-relaxed">{msg.content}</p>
              </div>
            </div>
          )
        )}

        {/* Indicateur "en train d'écrire…" */}
        {isTyping && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-tl-sm bg-slate-700 px-4 py-3 shadow">
              <p className="mb-1 text-xs font-semibold text-slate-400">Maître du Jeu</p>
              <div className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
                <span className="h-2 w-2 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]" />
                <span className="h-2 w-2 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}

        {/* Ancre de scroll */}
        <div ref={bottomRef} />
      </div>

      {/* Barre d'input */}
      <div className="border-t border-slate-700 p-4 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isTyping ? "Le Maître du Jeu répond…" : "Décrivez votre action… (Entrée pour envoyer)"}
          disabled={isTyping}
          className="flex-1 rounded-md border border-slate-600 bg-slate-800 px-4 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || isTyping}
          className="rounded-md bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 active:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Envoyer
        </button>
      </div>
    </div>
  );
}
