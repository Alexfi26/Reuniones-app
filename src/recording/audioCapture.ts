import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { AppError } from '../core/errors.js';

export type PermissionState = 'granted' | 'denied' | 'undetermined' | 'unsupported';

export interface CapturePermissions {
  microphone: PermissionState;
  systemAudio: PermissionState;
}

export type CaptureSource = 'microphone' | 'system';

export interface CaptureRequest {
  outputPath: string;
  sources: CaptureSource[];
}

export interface CaptureProblem {
  code: 'device_disconnected' | 'system_audio_unavailable' | 'microphone_denied' | 'write_error' | 'unknown';
  message: string;
}

export interface CaptureResult {
  path: string;
  durationMs: number;
}

export interface CaptureSession {
  stop(): Promise<CaptureResult>;
  onProblem(handler: (problem: CaptureProblem) => void): void;
}

export interface AudioCaptureService {
  checkPermissions(): Promise<CapturePermissions>;
  start(request: CaptureRequest): Promise<CaptureSession>;
}

/** En plataformas sin soporte devuelve un error claro en lugar de simular una grabación. */
export class UnsupportedAudioCapture implements AudioCaptureService {
  async checkPermissions(): Promise<CapturePermissions> {
    return { microphone: 'unsupported', systemAudio: 'unsupported' };
  }

  async start(): Promise<CaptureSession> {
    throw new AppError(
      'capture_unsupported',
      'La captura de audio solo está disponible en macOS 14.2 o superior con el helper nativo.',
      'Ejecuta la aplicación en un Mac Apple Silicon y compila el helper según docs/CAPTURA_AUDIO.md.',
    );
  }
}

interface HelperEvent {
  event: string;
  [key: string]: unknown;
}

/**
 * Adaptador del helper nativo de macOS (Swift: AVAudioEngine para micrófono y Core Audio
 * process tap para audio del sistema). Protocolo: JSON por línea en stdout; comandos por stdin.
 *   permissions → {"event":"permissions","microphone":"granted","systemAudio":"undetermined"}
 *   record --out <ruta> --sources mic,system → {"event":"started"} ... {"cmd":"stop"} → {"event":"finished","path","durationMs"}
 */
export class NativeHelperAudioCapture implements AudioCaptureService {
  constructor(
    private readonly helperPath: string,
    // Incluye el tiempo en que macOS muestra los avisos de permiso de micrófono y de audio del sistema.
    private readonly startupTimeoutMs = 120_000,
    private readonly stopTimeoutMs = 30_000,
  ) {}

  async checkPermissions(): Promise<CapturePermissions> {
    if (!existsSync(this.helperPath)) {
      return { microphone: 'unsupported', systemAudio: 'unsupported' };
    }
    const child = spawn(this.helperPath, ['permissions'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = readLines(child);
    const event = await nextEvent(lines, 'permissions', 5_000);
    return {
      microphone: toPermission(event.microphone),
      systemAudio: toPermission(event.systemAudio),
    };
  }

  async start(request: CaptureRequest): Promise<CaptureSession> {
    if (!existsSync(this.helperPath)) {
      throw new AppError('capture_unsupported', 'No se encontró el helper nativo de captura.', 'Compila el helper según docs/CAPTURA_AUDIO.md y configura su ruta.');
    }
    const args = ['record', '--out', request.outputPath, '--sources', request.sources.join(',')];
    const child = spawn(this.helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = readLines(child);
    const problemHandlers: ((problem: CaptureProblem) => void)[] = [];

    await nextEvent(lines, 'started', this.startupTimeoutMs);

    lines.on('event', (event: HelperEvent) => {
      if (event.event === 'problem') {
        const problem: CaptureProblem = {
          code: toProblemCode(event.code),
          message: typeof event.message === 'string' ? event.message : 'Problema durante la captura.',
        };
        for (const handler of problemHandlers) handler(problem);
      }
    });

    return {
      onProblem: (handler) => problemHandlers.push(handler),
      stop: async () => {
        child.stdin.write('{"cmd":"stop"}\n');
        const finished = await nextEvent(lines, 'finished', this.stopTimeoutMs);
        child.kill('SIGTERM');
        return { path: String(finished.path), durationMs: Number(finished.durationMs) };
      },
    };
  }
}

type LineEmitter = EventEmitter;

function readLines(child: ChildProcess): LineEmitter {
  const emitter: LineEmitter = new EventEmitter();
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        emitter.emit('event', JSON.parse(line) as HelperEvent);
      } catch {
        emitter.emit('event', { event: 'invalid' });
      }
    }
  });
  return emitter;
}

function nextEvent(emitter: LineEmitter, name: string, timeoutMs: number): Promise<HelperEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off('event', onEvent);
      reject(new AppError('capture_timeout', `El helper de captura no respondió (${name}).`, 'Reinicia la grabación y revisa los permisos del sistema.'));
    }, timeoutMs);
    const onEvent = (event: HelperEvent) => {
      if (event.event === 'error') {
        clearTimeout(timer);
        emitter.off('event', onEvent);
        reject(new AppError('capture_error', String(event.message ?? 'Error del helper de captura.'), 'Revisa los permisos de micrófono y de grabación de audio del sistema.'));
        return;
      }
      if (event.event === name) {
        clearTimeout(timer);
        emitter.off('event', onEvent);
        resolve(event);
      }
    };
    emitter.on('event', onEvent);
  });
}

function toPermission(value: unknown): PermissionState {
  return value === 'granted' || value === 'denied' || value === 'undetermined' ? value : 'unsupported';
}

function toProblemCode(value: unknown): CaptureProblem['code'] {
  const known: CaptureProblem['code'][] = ['device_disconnected', 'system_audio_unavailable', 'microphone_denied', 'write_error'];
  return known.includes(value as CaptureProblem['code']) ? (value as CaptureProblem['code']) : 'unknown';
}
