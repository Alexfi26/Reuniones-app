import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, AuthError, NetworkError, RateLimitError } from '../core/errors.js';

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  /** null: el motor no separa hablantes. Nunca se inventan nombres. */
  speaker: string | null;
}

export interface Transcript {
  provider: 'whisper_cpp' | 'openai';
  language: string | null;
  segments: TranscriptSegment[];
}

export interface TranscriptionProvider {
  readonly id: Transcript['provider'];
  /** Recibe un WAV mono 16 kHz PCM de 16 bits (formato del helper de captura). */
  transcribe(wavPath: string, options: { language: string }): Promise<Transcript>;
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
}

/** Lee la cabecera RIFF y localiza el bloque «data». Lanza error si el fichero no es un WAV PCM válido. */
export function parseWav(buffer: Buffer): WavInfo {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new AppError('invalid_audio', 'El fichero de audio no es un WAV válido.', 'Vuelve a grabar la reunión.');
  }
  let info: Partial<WavInfo> = {};
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      info = {
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      return {
        sampleRate: info.sampleRate ?? 0,
        channels: info.channels ?? 0,
        bitsPerSample: info.bitsPerSample ?? 0,
        dataOffset: body,
        dataLength: Math.min(size, buffer.length - body),
      };
    }
    offset = body + size + (size % 2);
  }
  throw new AppError('invalid_audio', 'El WAV no contiene datos de audio.', 'Vuelve a grabar la reunión.');
}

export function buildWavHeader(dataLength: number, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return header;
}

/** Divide el audio en trozos de duración fija (límite de 25 MB por petición en la API de OpenAI). */
export function splitWavChunks(buffer: Buffer, chunkSeconds: number): { startMs: number; wav: Buffer }[] {
  const info = parseWav(buffer);
  const bytesPerSecond = (info.sampleRate * info.channels * info.bitsPerSample) / 8;
  const chunkBytes = Math.floor(bytesPerSecond * chunkSeconds);
  const pcm = buffer.subarray(info.dataOffset, info.dataOffset + info.dataLength);
  const chunks: { startMs: number; wav: Buffer }[] = [];
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    const slice = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length));
    const header = buildWavHeader(slice.length, info.sampleRate, info.channels, info.bitsPerSample);
    chunks.push({ startMs: Math.round((offset / bytesPerSecond) * 1000), wav: Buffer.concat([header, slice]) });
  }
  return chunks;
}

/** whisper.cpp ejecutado en local: privacidad máxima, sin envío de datos a terceros. */
export class WhisperCppProvider implements TranscriptionProvider {
  readonly id = 'whisper_cpp' as const;

  constructor(
    private readonly binaryPath: string,
    private readonly modelPath: string,
    private readonly workDir: string,
  ) {}

  async transcribe(wavPath: string, options: { language: string }): Promise<Transcript> {
    if (!existsSync(this.binaryPath) || !existsSync(this.modelPath)) {
      throw new AppError(
        'transcription_not_configured',
        'whisper.cpp o el modelo no están instalados.',
        'Configura transcription.whisperBinaryPath y transcription.whisperModelPath en Configuración (ver docs/INSTALACION.md).',
      );
    }
    const dir = await mkdtemp(join(this.workDir, 'whisper-'));
    const outPrefix = join(dir, 'out');
    try {
      await runProcess(this.binaryPath, ['-m', this.modelPath, '-f', wavPath, '-l', options.language === 'auto' ? 'auto' : options.language, '-oj', '-of', outPrefix]);
      const json = JSON.parse(await readFile(`${outPrefix}.json`, 'utf8')) as WhisperJson;
      return {
        provider: 'whisper_cpp',
        language: json.result?.language ?? null,
        segments: (json.transcription ?? [])
          .map((segment) => ({
            startMs: segment.offsets.from,
            endMs: segment.offsets.to,
            text: segment.text.trim(),
            speaker: null,
          }))
          .filter((segment) => segment.text.length > 0),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: { offsets: { from: number; to: number }; text: string }[];
}

/**
 * API de transcripción de OpenAI. Solo se usa si el usuario ha reconocido el envío de audio a un tercero.
 * Las peticiones se trocean para respetar el límite de 25 MB; el audio no se usa para entrenar modelos
 * según la política de datos de la API (verificar la versión vigente antes de activarlo).
 */
export class OpenAITranscriptionProvider implements TranscriptionProvider {
  readonly id = 'openai' as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.openai.com/v1',
    private readonly chunkSeconds = 600,
  ) {}

  async transcribe(wavPath: string, options: { language: string }): Promise<Transcript> {
    const audio = await readFile(wavPath);
    const segments: TranscriptSegment[] = [];
    let language: string | null = null;
    for (const chunk of splitWavChunks(audio, this.chunkSeconds)) {
      const json = await this.requestChunk(chunk.wav, options.language);
      language ??= json.language ?? null;
      for (const segment of json.segments ?? []) {
        segments.push({
          startMs: chunk.startMs + Math.round(segment.start * 1000),
          endMs: chunk.startMs + Math.round(segment.end * 1000),
          text: segment.text.trim(),
          speaker: null,
        });
      }
    }
    return { provider: 'openai', language, segments: segments.filter((s) => s.text.length > 0) };
  }

  private async requestChunk(wav: Buffer, language: string): Promise<OpenAiVerboseJson> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'reunion.wav');
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    if (language !== 'auto') form.append('language', language);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
      });
    } catch (error) {
      throw new NetworkError(`No se pudo contactar con el servicio de transcripción: ${(error as Error).message}`);
    }
    if (response.status === 401) throw new AuthError('La clave de API de transcripción no es válida.', 'Actualiza la clave en Configuración.');
    if (response.status === 429) throw new RateLimitError('El servicio de transcripción');
    if (response.status >= 500) throw new NetworkError('El servicio de transcripción no está disponible.');
    if (!response.ok) throw new AppError('transcription_failed', `La transcripción falló (HTTP ${response.status}).`, 'Reintenta más tarde; el audio se conserva.');
    return (await response.json()) as OpenAiVerboseJson;
  }
}

interface OpenAiVerboseJson {
  language?: string;
  segments?: { start: number; end: number; text: string }[];
}

async function runProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => reject(new AppError('transcription_failed', `No se pudo ejecutar whisper.cpp: ${error.message}`, 'Revisa la ruta del binario.')));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new AppError('transcription_failed', `whisper.cpp terminó con código ${code}.`, 'Revisa el modelo y el audio. Detalle: ' + stderr.slice(-200)))));
  });
}

export async function writeTempWav(workDir: string, name: string, wav: Buffer): Promise<string> {
  const path = join(workDir, name);
  await writeFile(path, wav, { mode: 0o600 });
  return path;
}

export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((part) => String(part).padStart(2, '0')).join(':');
}
