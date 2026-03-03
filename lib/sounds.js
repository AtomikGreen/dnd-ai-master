import { Howl } from "howler";

// Bip de notification généré comme data URI WAV (440 Hz, 100 ms, mono 8-bit 8 kHz)
// Évite d'avoir besoin d'un fichier audio externe.
const BIP_WAV = (() => {
  const sampleRate = 8000;
  const duration = 0.12; // secondes
  const freq = 520; // Hz
  const numSamples = Math.floor(sampleRate * duration);

  // En-tête WAV PCM 8-bit mono
  const buffer = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);        // taille chunk fmt
  view.setUint16(20, 1, true);         // PCM
  view.setUint16(22, 1, true);         // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // byte rate
  view.setUint16(32, 1, true);          // block align
  view.setUint16(34, 8, true);          // 8 bits
  writeStr(36, "data");
  view.setUint32(40, numSamples, true);

  for (let i = 0; i < numSamples; i++) {
    // Enveloppe pour éviter les clics (fade in/out sur 10%)
    const t = i / sampleRate;
    const fadeLen = numSamples * 0.1;
    const env =
      i < fadeLen
        ? i / fadeLen
        : i > numSamples - fadeLen
        ? (numSamples - i) / fadeLen
        : 1;
    const sample = Math.round(128 + 100 * env * Math.sin(2 * Math.PI * freq * t));
    view.setUint8(44 + i, sample);
  }

  // Convertit en base64 data URI
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return "data:audio/wav;base64," + btoa(binary);
})();

const bipSound = new Howl({
  src: [BIP_WAV],
  format: ["wav"],
  volume: 0.4,
});

/** Joue un bip de notification. */
export function playBip() {
  bipSound.play();
}
