"use client";

import ChatInterface from "@/components/ChatInterface";

export default function Home() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-900 text-white">

      {/* Colonne Gauche — Fiche Personnage (20%) */}
      <aside className="flex w-1/5 flex-col gap-4 border-r border-slate-700 p-4">
        <h2 className="text-lg font-bold tracking-wide text-slate-200">Fiche Personnage</h2>

        {/* Stats */}
        <div className="rounded-md border border-slate-700 bg-slate-800 p-3">
          <h3 className="mb-2 text-sm font-semibold uppercase text-slate-400">Stats</h3>
          <ul className="space-y-1 text-sm text-slate-300">
            <li className="flex justify-between"><span>FOR</span><span>16</span></li>
            <li className="flex justify-between"><span>DEX</span><span>12</span></li>
            <li className="flex justify-between"><span>CON</span><span>14</span></li>
            <li className="flex justify-between"><span>INT</span><span>10</span></li>
            <li className="flex justify-between"><span>SAG</span><span>8</span></li>
            <li className="flex justify-between"><span>CHA</span><span>13</span></li>
          </ul>
        </div>

        {/* Inventaire */}
        <div className="flex-1 rounded-md border border-slate-700 bg-slate-800 p-3">
          <h3 className="mb-2 text-sm font-semibold uppercase text-slate-400">Inventaire</h3>
          <ul className="space-y-1 text-sm text-slate-300">
            <li>⚔️ Épée longue</li>
            <li>🛡️ Bouclier en bois</li>
            <li>🧪 Potion de soin ×2</li>
            <li>🗝️ Clé rouillée</li>
          </ul>
        </div>
      </aside>

      {/* Colonne Centre — Chat Log + Input (60%) */}
      <main className="flex w-3/5 flex-col border-r border-slate-700">
        <ChatInterface />
      </main>

      {/* Colonne Droite — État du Jeu (20%) */}
      <aside className="flex w-1/5 flex-col gap-4 p-4">
        <h2 className="text-lg font-bold tracking-wide text-slate-200">État du Jeu</h2>

        {/* Image de scène */}
        <div className="aspect-video w-full rounded-md border border-slate-700 bg-slate-800 flex items-center justify-center text-slate-500 text-sm">
          [ Image de scène ]
        </div>

        {/* Liste des PNJ */}
        <div className="flex-1 rounded-md border border-slate-700 bg-slate-800 p-3">
          <h3 className="mb-2 text-sm font-semibold uppercase text-slate-400">PNJ présents</h3>
          <ul className="space-y-2 text-sm">
            <li className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-green-400"></span>
              <span className="text-slate-300">Aldric le Garde</span>
            </li>
            <li className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-red-400"></span>
              <span className="text-slate-300">Ombre Silencieuse</span>
            </li>
            <li className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-yellow-400"></span>
              <span className="text-slate-300">Marchande Lira</span>
            </li>
          </ul>
        </div>
      </aside>

    </div>
  );
}
