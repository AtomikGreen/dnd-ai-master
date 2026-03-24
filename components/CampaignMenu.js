import React from "react";
import { CAMPAIGN_CONTEXT } from "../data/campaign";

export default function CampaignMenu({ onStart, onBack }) {
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
              className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-blue-900/30 transition-colors hover:bg-blue-500 active:bg-blue-700"
            >
              Démarrer l&apos;Aventure
            </button>
          </div>
        </div>

        <div className="mt-8 text-center text-xs text-slate-600">
          Tip: vous pouvez activer le mode debug en jeu pour voir les logs moteur.
        </div>
      </div>
    </div>
  );
}

