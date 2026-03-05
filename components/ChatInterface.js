"use client";

import { useEffect, useRef, useState } from "react";
import { useGame } from "@/context/GameContext";
import { playBip } from "@/lib/sounds";

export default function ChatInterface() {
  const { messages, addMessage } = useGame();
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState(null);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const bottomRef = useRef(null);
  const countdownRef = useRef(null);

  // Décompte affiché quand le quota est dépassé (429)
  useEffect(() => {
    if (retryCountdown <= 0) return;
    countdownRef.current = setInterval(() => {
      setRetryCountdown((s) => {
        if (s <= 1) {
          clearInterval(countdownRef.current);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(countdownRef.current);
  }, [retryCountdown]);

  // Scroll automatique vers le bas à chaque nouveau message ou pendant la frappe
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || isTyping || retryCountdown > 0) return;

    // 1. Ajoute le message utilisateur à l'état local immédiatement
    const updatedMessages = [...messages, { id: Date.now(), role: "user", content: trimmed }];
    addMessage("user", trimmed);
    setInput("");
    setIsTyping(true);
    setError(null);

    try {
      // 2. Appel à la route API avec l'historique complet (nouveau message inclus)
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: updatedMessages }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 429 && data.retryAfter) {
          setRetryCountdown(data.retryAfter);
        }
        throw new Error(data.error ?? `Erreur serveur (${res.status})`);
      }

      const { reply } = await res.json();

      // 3. Ajoute la réponse de l'IA à l'état et joue le bip
      addMessage("ai", reply);
      playBip();
    } catch (err) {
      setError(err.message ?? "Une erreur inattendue s'est produite.");
    } finally {
      setIsTyping(false);
    }
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

        {/* Indicateur "Le MJ réfléchit…" pendant le fetch */}
        {isTyping && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-tl-sm bg-slate-700 px-4 py-3 shadow">
              <p className="mb-1 text-xs font-semibold text-slate-400">Maître du Jeu</p>
              <div className="flex items-center gap-2">
                <div className="flex gap-1">
                  <span className="h-2 w-2 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
                  <span className="h-2 w-2 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]" />
                  <span className="h-2 w-2 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]" />
                </div>
                <span className="text-xs text-slate-500 italic">Le MJ réfléchit…</span>
              </div>
            </div>
          </div>
        )}

        {/* Bannière quota dépassé avec countdown */}
        {retryCountdown > 0 && (
          <div className="flex justify-center">
            <div className="flex items-center gap-3 rounded-lg border border-amber-700 bg-amber-950 px-4 py-2 text-xs text-amber-300">
              <span>⏳</span>
              <span>
                Quota API dépassé — réessayez dans{" "}
                <span className="font-bold tabular-nums">{retryCountdown}s</span>
              </span>
            </div>
          </div>
        )}

        {/* Bannière erreur générique */}
        {error && retryCountdown === 0 && (
          <div className="flex justify-center">
            <div className="flex items-center gap-2 rounded-lg border border-red-800 bg-red-950 px-4 py-2 text-xs text-red-300">
              <span>⚠</span>
              <span>{error}</span>
              <button
                onClick={() => setError(null)}
                className="ml-1 text-red-400 hover:text-red-200 transition-colors"
                aria-label="Fermer"
              >
                ✕
              </button>
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
          placeholder={
            retryCountdown > 0
              ? `Quota dépassé — réessayez dans ${retryCountdown}s…`
              : isTyping
              ? "Le Maître du Jeu répond…"
              : "Décrivez votre action… (Entrée pour envoyer)"
          }
          disabled={isTyping || retryCountdown > 0}
          className="flex-1 rounded-md border border-slate-600 bg-slate-800 px-4 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || isTyping || retryCountdown > 0}
          className="rounded-md bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 active:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Envoyer
        </button>
      </div>
    </div>
  );
}
