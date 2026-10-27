import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, type AppConfig, type AppOverrides } from '../src/app.js';
import { FileVault } from '../src/privacy/fileVault.js';
import { MemorySecretStore } from '../src/security/secretStore.js';
import { buildWavHeader } from '../src/transcription/transcription.js';
import type { AudioCaptureService, CaptureRequest, CapturePermissions, CaptureSession } from '../src/recording/audioCapture.js';
import type { MeetingPromptInfo, NotificationService, PromptResult } from '../src/notifications/notificationService.js';

export const KEY = Buffer.alloc(32, 7);

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'reuniones-test-'));
}

export function makeConfig(dataDir = tempDir()): AppConfig {
  return {
    dataDir,
    google: { clientId: 'test-google-client.apps.googleusercontent.com' },
    microsoft: { clientId: 'test-microsoft-client', tenant: 'common' },
    helperPath: null,
  };
}

/** Reloj controlable para pruebas deterministas. */
export class FakeClock {
  constructor(private current: Date) {}
  now = (): Date => new Date(this.current.getTime());
  set(iso: string): void {
    this.current = new Date(iso);
  }
}

export class FakeCapture implements AudioCaptureService {
  permissions: CapturePermissions = { microphone: 'granted', systemAudio: 'granted' };
  readonly started: CaptureRequest[] = [];
  readonly stopped: string[] = [];
  private problemHandler: ((p: { code: 'device_disconnected'; message: string }) => void) | null = null;

  async checkPermissions(): Promise<CapturePermissions> {
    return this.permissions;
  }

  async start(request: CaptureRequest): Promise<CaptureSession> {
    this.started.push(request);
    const handlers = this;
    return {
      onProblem: (handler) => {
        handlers.problemHandler = handler;
      },
      stop: async () => {
        handlers.stopped.push(request.outputPath);
        writeWav(request.outputPath, 16_000 * 2 * 3); // 3 s de silencio a 16 kHz
        return { path: request.outputPath, durationMs: 3000 };
      },
    };
  }

  emitProblem(message: string): void {
    this.problemHandler?.({ code: 'device_disconnected', message });
  }
}

export function writeWav(path: string, dataLength: number): void {
  const data = Buffer.alloc(dataLength, 0);
  writeFileSync(path, Buffer.concat([buildWavHeader(dataLength, 16_000, 1, 16), data]));
}

export class FakeNotifications implements NotificationService {
  readonly messages: string[] = [];
  readonly prompts: MeetingPromptInfo[] = [];
  decisions: PromptResult[] = [];
  consents: boolean[] = [];

  async notify(title: string, body: string): Promise<void> {
    this.messages.push(`${title}: ${body}`);
  }

  async askDecision(info: MeetingPromptInfo): Promise<PromptResult> {
    this.prompts.push(info);
    return this.decisions.shift() ?? 'no_response';
  }

  async confirmConsent(): Promise<boolean> {
    return this.consents.shift() ?? false;
  }
}

export interface TestApp {
  app: App;
  secrets: MemorySecretStore;
  capture: FakeCapture;
  notifications: FakeNotifications;
  clock: FakeClock;
  config: AppConfig;
}

export function makeTestApp(options: { now: string; fetchImpl?: typeof fetch } & AppOverrides): TestApp {
  const config = makeConfig();
  const clock = new FakeClock(new Date(options.now));
  const secrets = new MemorySecretStore();
  const capture = new FakeCapture();
  const notifications = new FakeNotifications();
  const vault = new FileVault(KEY);
  const app = new App(config, vault, {
    dbPath: ':memory:',
    secrets,
    capture,
    notifications,
    clock: clock.now,
    fetchImpl: options.fetchImpl,
    ...options,
  });
  return { app, secrets, capture, notifications, clock, config };
}

/** Cuenta de Google ya conectada (refresh token simulado en el llavero de pruebas). */
export async function seedGoogleAccount(t: TestApp, id = 'google:user-1', label = 'ana@example.com'): Promise<string> {
  t.app.storage.upsertAccount({ id, provider: 'google', label, enabled: 1, created_at: '2026-10-01T00:00:00Z' });
  await t.secrets.set(`google.refresh.${id}`, 'refresh-token-test');
  return id;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
