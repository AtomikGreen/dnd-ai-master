"use client";

import React, { useCallback, useMemo, useState } from "react";
import { CAMPAIGN_CONTEXT } from "../data/campaign";
import type { Message, SessionParticipantProfile } from "@/context/GameContext";

export type CampaignMenuMultiplayer = {
  sessionId: string | null;
  participants: number;
  connected: boolean;
  onCreate: () => void | Promise<void>;
  onLeave: () => void | Promise<void>;
  joinInput: string;
  setJoinInput: (v: string) => void;
  onJoin: () => void | Promise<void>;
  joining: boolean;
  error: string | null;
  /** Profils participant (pour afficher les persos au lobby). */
  participantProfiles?: SessionParticipantProfile[];
  /** Nom du personnage actuellement sélectionné sur ce client. */
  meCharacterName?: string | null;
};

type CampaignMenuProps = {
  onStart: () => void;
  onBack?: () => void;
  messages?: Message[];
  multiplayer?: CampaignMenuMultiplayer;
};

/** Messages moteur / UI technique — pas d’aperçu « salon » (évite d’afficher les logs [DEBUG][ENGINE_RX], etc.). */
function isMessageEligibleForLobbyPreview(m: Message): boolean {
  const t = m.type;
  const id = String(m?.id ?? "").trim();
  if (id.startsWith("initiative-order-")) return false;
  if (
    t === "debug" ||
    t === "scene-image-pending" ||
    t === "turn-divider" ||
    t === "turn-end" ||
    t === "combat-detail" ||
    t === "retry-action" ||
    t === "continue"
  ) {
    return false;
  }
  const c = typeof m.content === "string" ? m.content.trim() : "";
  if (!c) return false;
  if (c.startsWith("[DEBUG]") || c.includes("[ENGINE_RX]")) return false;
  return true;
}

export default function CampaignMenu({ onStart, onBack, messages = [], multiplayer: mp }: CampaignMenuProps) {
  const [copied, setCopied] = useState(false);
  const canStart = !!mp?.sessionId;

  const shareUrl = useMemo(() => {
    if (typeof window === "undefined" || !mp?.sessionId) return "";
    const u = new URL(window.location.href);
    u.searchParams.set("session", mp.sessionId);
    return u.toString();
  }, [mp?.sessionId]);

  const lobbyPreview = useMemo(() => {
    if (!mp?.sessionId || mp.connected !== true) return null;
    if (!Array.isArray(messages) || messages.length === 0) return null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || !isMessageEligibleForLobbyPreview(m)) continue;
      const text = typeof m.content === "string" ? m.content.trim() : "";
      if (!text) continue;
      return text.length > 420 ? `${text.slice(0, 417)}…` : text;
    }
    return null;
  }, [messages]);

  const handleCopyLink = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }, [shareUrl]);

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-3xl">
        <div className="mb-4">
          <button
            type="button"
            onClick={() => onBack?.()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs font-semibold text-slate-200 hover:border-slate-600 hover:bg-slate-900/70 transition-colors"
          >
            ← Retour
          </button>
        </div>

        <div className="text-center mb-10">
          <h1 className="text-4xl sm:text-5xl font-black tracking-tight">
            The AI Dungeon Master
          </h1>
          <p className="mt-3 text-sm sm:text-base text-slate-400">
            Une aventure sombre, guidée par un MJ artificiel.
          </p>
        </div>

        <div className="group rounded-2xl border border-slate-800 bg-gradient-to-b from-slate-900/60 to-slate-950/40 p-6 shadow-xl shadow-black/40 transition-all hover:-translate-y-0.5 hover:border-slate-600 hover:shadow-2xl">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-widest text-slate-500">
                Campagne
              </p>
              <h2 className="mt-1 text-2xl sm:text-3xl font-extrabold text-slate-100">
                {CAMPAIGN_CONTEXT.title}
              </h2>
            </div>

            <div className="flex items-center gap-2">
              <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-xs font-semibold text-slate-200">
                Niveau 1
              </span>
              <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-xs font-semibold text-slate-200">
                1-4 Joueurs
              </span>
            </div>
          </div>

          <p className="mt-4 text-sm leading-relaxed text-slate-300">
            {CAMPAIGN_CONTEXT.setting}
          </p>

          <div className="mt-6 flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
            <div className="text-xs text-slate-500">
              Survolez la carte pour sentir l&apos;orage approcher.
            </div>
            <button
              type="button"
              onClick={() => onStart?.()}
              disabled={!canStart}
              className={`rounded-xl px-6 py-3 text-sm font-bold transition-colors shadow-lg shadow-blue-900/30 ${
                canStart
                  ? "bg-blue-600 text-white hover:bg-blue-500 active:bg-blue-700"
                  : "bg-slate-700/60 text-slate-300 cursor-not-allowed"
              }`}
            >
              Démarrer l&apos;Aventure
            </button>
            {!canStart ? (
              <p className="text-xs text-amber-200 mt-2">
                Rejoignez ou créez une session multijoueur pour démarrer.
              </p>
            ) : null}
          </div>
        </div>

        {mp ? (
          <div className="mt-6 rounded-2xl border border-emerald-900/80 bg-slate-900/50 p-5 shadow-lg shadow-black/30">
            <p className="text-xs uppercase tracking-widest text-emerald-500/90">Multijoueur</p>
            <p className="mt-1 text-sm text-slate-300">
              Créez un salon sans lancer la partie, partagez le lien, puis démarrez quand tout le monde est prêt.
              Tous les joueurs ont les mêmes droits.
            </p>
            {mp.sessionId ? (
              <div className="mt-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span className="rounded border border-slate-700 bg-slate-950/60 px-2 py-1 font-mono text-slate-200">
                    {mp.sessionId}
                  </span>
                  <span>
                    {mp.participants} joueur{mp.participants > 1 ? "s" : ""} ·{" "}
                    {mp.connected ? "connecté au salon" : "connexion…"}
                  </span>
                </div>

                {mp.meCharacterName ? (
                  <p className="mt-2 text-sm text-slate-300">
                    Votre personnage :{" "}
                    <span className="font-semibold text-slate-100">{mp.meCharacterName}</span>
                  </p>
                ) : null}

                {Array.isArray(mp.participantProfiles) && mp.participantProfiles.length > 0 ? (
                  <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                    <p className="text-[11px] text-slate-400 uppercase tracking-wider">Personnages dans le salon</p>
                    <div className="mt-2 space-y-1">
                      {mp.participantProfiles
                        .filter((p) => p && p.connected !== false)
                        .map((p) => (
                          <div key={p.clientId} className="flex items-center justify-between gap-3 text-xs">
                            <span className="truncate text-slate-200">{p.name}</span>
                            <span className="shrink-0 text-[10px] text-slate-500 font-mono">
                              {p.entityClass ?? "—"}
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                ) : null}
                {shareUrl ? (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input
                      readOnly
                      className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-xs text-slate-200 font-mono"
                      value={shareUrl}
                      aria-label="Lien de session"
                    />
                    <button
                      type="button"
                      onClick={handleCopyLink}
                      className="shrink-0 rounded-lg border border-emerald-700 bg-emerald-950/50 px-4 py-2 text-xs font-bold text-emerald-100 hover:bg-emerald-900/70"
                    >
                      {copied ? "Copié" : "Copier le lien"}
                    </button>
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => mp.onLeave?.()}
                  disabled={mp.joining}
                  className="text-xs font-semibold text-amber-200/90 underline-offset-2 hover:underline disabled:opacity-50"
                >
                  Quitter la session
                </button>
              </div>
            ) : (
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                <button
                  type="button"
                  onClick={() => mp.onCreate?.()}
                  disabled={mp.joining}
                  className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-600 disabled:opacity-50"
                >
                  Créer une session (lien)
                </button>
                <div className="flex flex-1 flex-col gap-1 min-w-[200px]">
                  <label className="text-[10px] uppercase tracking-wide text-slate-500">
                    Rejoindre une session
                  </label>
                  <div className="flex gap-2">
                    <input
                      className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-xs text-slate-100 font-mono"
                      value={mp.joinInput}
                      onChange={(e) => mp.setJoinInput?.(e.target.value)}
                      placeholder="identifiant ou lien"
                      disabled={mp.joining}
                    />
                    <button
                      type="button"
                      onClick={() => mp.onJoin?.()}
                      disabled={mp.joining || !mp.joinInput.trim()}
                      className="shrink-0 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-xs font-bold text-slate-100 hover:bg-slate-700 disabled:opacity-50"
                    >
                      Rejoindre
                    </button>
                  </div>
                </div>
              </div>
            )}
            {mp.error ? <p className="mt-3 text-xs text-amber-300">{mp.error}</p> : null}
          </div>
        ) : null}

        {lobbyPreview ? (
          <div className="mt-6 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
            <p className="text-[10px] uppercase tracking-widest text-slate-500">Salon</p>
            <p className="mt-2 text-sm text-slate-300 whitespace-pre-wrap">{lobbyPreview}</p>
          </div>
        ) : null}

        <div className="mt-8 text-center text-xs text-slate-600">
          Tip: vous pouvez activer le mode debug en jeu pour voir les logs moteur.
        </div>
      </div>
    </div>
  );
}
