import { readFileSync } from 'node:fs';
import { parseWav } from '../transcription/transcription.js';

/**
 * Comprueba una grabación sin escucharla: formato, duración y niveles.
 * Uso: node dist/src/tools/inspectWav.js <ruta.wav>
 * Un nivel de pico cercano a 0 dBFS indica señal; «silencio» indica que la fuente no llegó.
 */
export function inspectWav(path: string): string {
  const buffer = readFileSync(path);
  const info = parseWav(buffer);
  const bytesPerSample = info.bitsPerSample / 8;
  const samples = info.dataLength / bytesPerSample;
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const value = buffer.readInt16LE(info.dataOffset + i * bytesPerSample);
    const abs = Math.abs(value);
    if (abs > peak) peak = abs;
    sumSquares += value * value;
  }
  const rms = samples > 0 ? Math.sqrt(sumSquares / samples) / 32768 : 0;
  const peakDbfs = peak > 0 ? 20 * Math.log10(peak / 32768) : -Infinity;
  const durationS = samples / info.channels / info.sampleRate;
  const verdict = peak < 16 ? 'silencio (la fuente no llegó)' : 'señal presente';
  return [
    `formato: ${info.sampleRate} Hz, ${info.channels} canal(es), ${info.bitsPerSample} bits`,
    `duración: ${durationS.toFixed(1)} s`,
    `pico: ${Number.isFinite(peakDbfs) ? peakDbfs.toFixed(1) : '-inf'} dBFS`,
    `RMS: ${(20 * Math.log10(rms || 1e-9)).toFixed(1)} dBFS`,
    `resultado: ${verdict}`,
  ].join('\n');
}

if (process.argv[1]?.endsWith('inspectWav.js')) {
  const path = process.argv[2];
  if (!path) {
    console.error('Uso: inspectWav <ruta.wav>');
    process.exit(1);
  }
  console.log(inspectWav(path));
}
