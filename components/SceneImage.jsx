import React, { useState, useEffect, useRef } from 'react';

export default function SceneImage({
  roomDescription,
  imageSubject,
  entitiesSummary,
  imageModel,
  onDebugPrompt,
  triggerId,
}) {
  const [imageUrl, setImageUrl] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(false);
  const lastTriggerRef = useRef(null);
  const lastPromptRef = useRef("");
  const lastDebugEmitKeyRef = useRef("");

  useEffect(() => {
    if (!triggerId) return;
    if (imageModel === "disabled") return;

    // Évite les doubles appels (StrictMode) et les régénérations inutiles
    if (lastTriggerRef.current === triggerId) {
      return;
    }
    lastTriggerRef.current = triggerId;

    const generateImage = async () => {
      setIsLoading(true);
      setError(false);

      const styleAnchor =
        "dark fantasy RPG illustration, Dungeons and Dragons party, detailed characters, dynamic action, cinematic lighting, high quality digital painting";

      const parts = [];
      if (roomDescription) {
        parts.push(`Environment: ${roomDescription}.`);
      }
      if (entitiesSummary) {
        parts.push(
          `Visible characters and creatures: ${entitiesSummary}. Show them clearly in the scene.`
        );
      }
      if (imageSubject) {
        parts.push(
          `Current action and focus: ${imageSubject}. The image must depict this moment.`
        );
      }
      parts.push(styleAnchor);

      const fullPrompt = parts.join(" ");
      lastPromptRef.current = fullPrompt;

      if (onDebugPrompt) {
        // N'émettre qu'une fois par (triggerId + modèle), même en StrictMode.
        const key = `${triggerId}::${imageModel ?? ""}`;
        if (lastDebugEmitKeyRef.current !== key) {
          lastDebugEmitKeyRef.current = key;
          onDebugPrompt(fullPrompt);
        }
      }
      // Log console pour faciliter le debug développeur
      // (ne s'affiche que dans la console du navigateur).
      // eslint-disable-next-line no-console
      console.debug("SceneImage prompt:", fullPrompt);

      try {
        const response = await fetch("/api/scene-image", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt: fullPrompt, model: imageModel }),
        });

        const data = await response.json().catch(() => null);

        if (!response.ok) {
          console.error("Erreur API /api/scene-image:", data || response.status);
          const message = data?.details
            ? `${data.error || "Erreur API"} (${data.status || response.status}): ${data.details}`
            : data?.error || `Erreur API interne: ${response.status}`;
          throw new Error(message);
        }

        if (!data?.url) {
          throw new Error("Réponse invalide du serveur d'images.");
        }

        setImageUrl(data.url);
        setIsLoading(false);
      } catch (err) {
        console.error("Erreur de génération d'image:", err);
        setError(true);
        setIsLoading(false);
      }
    };

    generateImage();

    // Cleanup de l'URL locale pour éviter les fuites de mémoire (si jamais on utilise encore des blob:)
    return () => {
      if (imageUrl && imageUrl.startsWith("blob:")) {
        URL.revokeObjectURL(imageUrl);
      }
    };
  }, [triggerId, imageModel]);

  // Si le debug est activé APRÈS la génération, on ré-émet le dernier prompt connu une seule fois.
  useEffect(() => {
    if (!onDebugPrompt) return;
    if (!triggerId) return;
    if (imageModel === "disabled") return;
    const fullPrompt = lastPromptRef.current;
    if (!fullPrompt) return;
    const key = `${triggerId}::${imageModel ?? ""}`;
    if (lastDebugEmitKeyRef.current === key) return;
    lastDebugEmitKeyRef.current = key;
    onDebugPrompt(fullPrompt);
  }, [onDebugPrompt, triggerId, imageModel]);

  if (!triggerId && !isLoading && !imageUrl) return null;

  return (
    <div className="w-full h-48 md:h-64 rounded-lg overflow-hidden border border-slate-700 bg-slate-900 relative shadow-inner mt-4">
      {isLoading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-800/80 backdrop-blur-sm z-10 text-amber-500">
          <svg className="animate-spin h-8 w-8 mb-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span className="text-sm font-serif italic text-amber-400">Le Maître du Jeu esquisse la scène...</span>
        </div>
      )}

      {error && !isLoading && (
        <div className="absolute inset-0 flex items-center justify-center text-red-400 text-sm">
          Le brouillard magique masque la vision... (Erreur du serveur d'images)
        </div>
      )}

      {imageUrl && !error && (
        <img 
          src={imageUrl} 
          alt="Illustration de la scène" 
          className={`w-full h-full object-cover transition-opacity duration-1000 ${isLoading ? 'opacity-0' : 'opacity-100'}`}
        />
      )}
      
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-slate-900 to-transparent pointer-events-none"></div>
    </div>
  );
}

