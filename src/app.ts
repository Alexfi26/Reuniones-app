import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AuditService } from './audit/auditService.js';
import { ConsentManager } from './consent/consentManager.js';
import { CalendarService, type MeetingChange, type SyncReport } from './calendar/calendarService.js';
import { GoogleCalendarSource } from './calendar/googleCalendar.js';
import { MicrosoftCalendarSource } from './calendar/microsoftCalendar.js';
import { authorizeWithLoopback, type FetchLike, type OAuthProviderConfig, type TokenSet } from './auth/oauth.js';
import { TokenManager } from './auth/tokenManager.js';
import { AppError, AuthError } from './core/errors.js';
import type { Provider } from './core/types.js';
import { GoogleDocsService } from './google/googleDocs.js';
import { GoogleDriveService } from './google/googleDrive.js';
import { AnthropicProvider, type LlmProvider } from './notes/llmProvider.js';
import { FileVault } from './privacy/fileVault.js';
import { PrivacyService } from './privacy/privacyService.js';
import { MacNotificationService, UnavailableNotificationService, type NotificationService } from './notifications/notificationService.js';
import { ProcessingPipeline } from './pipeline/processingPipeline.js';
import { RecordingManager } from './recording/recordingManager.js';
import { NativeHelperAudioCapture, UnsupportedAudioCapture, type AudioCaptureService } from './recording/audioCapture.js';
import { SettingsService, type AppSettings } from './settings/settingsService.js';
import { LocalStorageService, type MeetingRow, type RecordingRow } from './storage/localStorageService.js';
import { getOrCreateStorageKey, KeychainSecretStore, type SecretStore } from './security/secretStore.js';
import { OpenAITranscriptionProvider, WhisperCppProvider, type TranscriptionProvider } from './transcription/transcription.js';
import { deriveConsentStatus } from './consent/consentManager.js';

/** Configuración pública (sin secretos). Los secretos viven en el llavero de macOS. */
export interface AppConfig {
  dataDir: string;
  google: { clientId: string };
  microsoft: { clientId: string; tenant: string };
  helperPath: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = env.REUNIONES_DATA_DIR ?? defaultDataDir();
  const configPath = env.REUNIONES_CONFIG ?? join(dataDir, 'config.json');
  const fileConfig = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, 'utf8')) as Partial<AppConfig>) : {};
  return {
    dataDir,
    google: { clientId: fileConfig.google?.clientId ?? '' },
    microsoft: { clientId: fileConfig.microsoft?.clientId ?? '', tenant: fileConfig.microsoft?.tenant ?? 'common' },
    helperPath: fileConfig.helperPath ?? null,
  };
}

function defaultDataDir(): string {
  return process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'reuniones-app')
    : join(homedir(), '.local', 'share', 'reuniones-app');
}

export interface AppOverrides {
  secrets?: SecretStore;
  fetchImpl?: FetchLike;
  capture?: AudioCaptureService;
  notifications?: NotificationService;
  clock?: () => Date;
  dbPath?: string;
  transcriptionFor?: (settings: AppSettings) => Promise<TranscriptionProvider>;
  llm?: () => Promise<LlmProvider>;
  drive?: GoogleDriveService;
  docs?: GoogleDocsService;
}

/** Punto de composición: crea y conecta todos los servicios. Única fábrica de dependencias. */
export class App {
  readonly storage: LocalStorageService;
  readonly settings: SettingsService;
  readonly audit: AuditService;
  readonly consent: ConsentManager;
  readonly calendar: CalendarService;
  readonly recordings: RecordingManager;
  readonly pipeline: ProcessingPipeline;
  readonly privacy: PrivacyService;
  readonly notifications: NotificationService;
  readonly secrets: SecretStore;
  private readonly fetchImpl: FetchLike;
  private readonly clock: () => Date;
  private readonly attemptedStart = new Set<string>();
  private readonly tokenCache = new Map<string, TokenManager>();

  constructor(
    readonly config: AppConfig,
    vault: FileVault,
    overrides: AppOverrides = {},
  ) {
    this.clock = overrides.clock ?? (() => new Date());
    this.fetchImpl = overrides.fetchImpl ?? fetch;
    this.secrets = overrides.secrets ?? new KeychainSecretStore();
    const dataDir = config.dataDir;
    mkdirSync(join(dataDir, 'audio'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dataDir, 'tmp'), { recursive: true, mode: 0o700 });
    this.storage = new LocalStorageService(overrides.dbPath ?? join(dataDir, 'reuniones.sqlite'));
    this.settings = new SettingsService(this.storage);
    this.audit = new AuditService(this.storage, this.clock);
    this.consent = new ConsentManager(this.storage, this.audit, this.clock);
    this.notifications = overrides.notifications ?? (process.platform === 'darwin' ? new MacNotificationService() : new UnavailableNotificationService());
    const capture = overrides.capture ?? (config.helperPath ? new NativeHelperAudioCapture(config.helperPath) : new UnsupportedAudioCapture());

    this.calendar = new CalendarService({
      storage: this.storage,
      settings: this.settings,
      audit: this.audit,
      clock: this.clock,
      sources: {
        google: new GoogleCalendarSource((id) => this.tokens('google', id).getAccessToken(), this.fetchImpl),
        microsoft: new MicrosoftCalendarSource((id) => this.tokens('microsoft', id).getAccessToken(), this.fetchImpl),
      },
      onChange: (change) => this.onMeetingChange(change),
    });
    this.recordings = new RecordingManager({
      storage: this.storage,
      consent: this.consent,
      capture,
      vault,
      audit: this.audit,
      notifications: this.notifications,
      audioDir: join(dataDir, 'audio'),
      clock: this.clock,
    });
    this.privacy = new PrivacyService(this.storage, this.settings, this.audit, this.clock);
    this.pipeline = new ProcessingPipeline({
      storage: this.storage,
      vault,
      audit: this.audit,
      settings: this.settings,
      audioDir: join(dataDir, 'audio'),
      workDir: join(dataDir, 'tmp'),
      clock: this.clock,
      transcriptionFor: overrides.transcriptionFor ?? ((settings) => this.transcriptionProvider(settings)),
      llm: overrides.llm ?? (() => this.llmProvider()),
      drive: overrides.drive ?? new GoogleDriveService(() => this.googleToken(), this.fetchImpl),
      docs: overrides.docs ?? new GoogleDocsService(() => this.googleToken(), this.fetchImpl),
      meetingContext: (recording) => this.meetingContext(recording),
    });
  }

  static async open(config: AppConfig, overrides: AppOverrides = {}): Promise<App> {
    const secrets = overrides.secrets ?? new KeychainSecretStore();
    const vault = new FileVault(await getOrCreateStorageKey(secrets));
    return new App(config, vault, { ...overrides, secrets });
  }

  close(): void {
    this.storage.close();
  }

  // ---- cuentas --------------------------------------------------------------

  async connect(provider: Provider, options: { loginHint?: string; onAuthorizationUrl: (url: string) => void | Promise<void> }): Promise<{ accountId: string; label: string }> {
    const oauth = this.oauthConfig(provider);
    const clientSecret = await this.secrets.get(`${provider}.clientSecret`);
    const tokens = await authorizeWithLoopback(oauth, {
      fetchImpl: this.fetchImpl,
      onAuthorizationUrl: options.onAuthorizationUrl,
      loginHint: options.loginHint,
      clientSecret,
    });
    const profile = await this.fetchProfile(provider, tokens);
    const accountId = `${provider}:${profile.subject}`;
    await new TokenManager(accountId, provider, oauth, this.secrets, this.fetchImpl).saveRefreshToken(tokens);
    this.storage.upsertAccount({ id: accountId, provider, label: profile.label, enabled: 1, created_at: this.clock().toISOString() });
    this.audit.record('account.connected', null, { provider });
    return { accountId, label: profile.label };
  }

  async disconnect(accountId: string, confirmed: boolean): Promise<void> {
    const account = this.storage.getAccount(accountId);
    if (!account) throw new AppError('not_found', 'No se encontró la cuenta.', 'Revisa las cuentas con «reuniones accounts».');
    await this.privacy.disconnectAccount(accountId, this.tokens(account.provider, accountId), confirmed);
  }

  // ---- ciclos de uso --------------------------------------------------------

  async sync(): Promise<SyncReport> {
    return this.calendar.sync();
  }

  /** Muestra las ventanas de autorización de las reuniones que empiezan dentro del margen configurado. */
  async promptDueMeetings(): Promise<{ meetingKey: string; result: string }[]> {
    const { leadMinutes, promptTimeoutSeconds } = this.settings.get();
    const results: { meetingKey: string; result: string }[] = [];
    for (const meeting of this.consent.pendingPrompts(leadMinutes)) {
      this.consent.markPrompted(meeting.meeting_key);
      const choice = await this.notifications.askDecision({
        title: meeting.title,
        platform: meeting.platform,
        startLocal: formatLocal(meeting.start_utc),
        durationMinutes: Math.round((Date.parse(meeting.end_utc) - Date.parse(meeting.start_utc)) / 60_000),
        organizer: meeting.organizer,
        timeoutSeconds: promptTimeoutSeconds,
      });
      if (choice === 'no_response') {
        results.push({ meetingKey: meeting.meeting_key, result: 'no_response' });
        continue;
      }
      this.consent.decide(meeting.meeting_key, choice);
      results.push({ meetingKey: meeting.meeting_key, result: choice });
    }
    return results;
  }

  /**
   * Inicia la captura de las reuniones autorizadas que ya han empezado, tras la confirmación de consentimiento.
   * Una confirmación negativa o sin respuesta no inicia la captura y no se vuelve a intentar para esa reunión.
   */
  async startAuthorizedMeetings(): Promise<RecordingRow[]> {
    const now = this.clock();
    const started: RecordingRow[] = [];
    for (const meeting of this.storage.listMeetings({ from: now.toISOString() })) {
      if (Date.parse(meeting.start_utc) > now.getTime()) continue;
      if (deriveConsentStatus(meeting, now) !== 'authorized') continue;
      if (this.attemptedStart.has(meeting.meeting_key) || this.storage.listRecordings().some((r) => r.meeting_key === meeting.meeting_key)) continue;
      this.attemptedStart.add(meeting.meeting_key);
      const confirmed = await this.notifications.confirmConsent({
        title: meeting.title,
        platform: meeting.platform,
        startLocal: formatLocal(meeting.start_utc),
        durationMinutes: Math.round((Date.parse(meeting.end_utc) - Date.parse(meeting.start_utc)) / 60_000),
        organizer: meeting.organizer,
        timeoutSeconds: this.settings.get().promptTimeoutSeconds,
      });
      if (!confirmed) {
        this.audit.record('consent.capture_not_confirmed', meeting.meeting_key, {});
        continue;
      }
      try {
        const { recording, warnings } = await this.recordings.start(meeting.meeting_key, { consentConfirmed: true });
        await this.notifications.notify('Grabación activa', `${meeting.title}. ${warnings.join(' ')}`.trim());
        started.push(recording);
      } catch (error) {
        // Un fallo de permisos o de dispositivo se notifica y no interrumpe el resto del ciclo.
        const message = error instanceof AppError ? `${error.message} ${error.action ?? ''}` : 'Error inesperado al iniciar la grabación.';
        await this.notifications.notify('No se pudo grabar', message.trim());
      }
    }
    return started;
  }

  /** Procesa las grabaciones terminadas y reintenta las pendientes. Devuelve lo que requiere atención del usuario. */
  async processPending(): Promise<string[]> {
    const messages: string[] = [];
    for (const row of this.storage.listRecordings(['audio_ready'])) {
      const outcome = await this.pipeline.run(row.id);
      if (outcome.status === 'awaiting_review') messages.push(`Notas listas para revisar: ${row.id}`);
      if (outcome.status === 'completed') messages.push(`Documento creado: ${outcome.documentUrl}`);
      if (outcome.status === 'failed') messages.push(`Error en ${row.id}: ${outcome.reason}`);
    }
    for (const result of await this.pipeline.retryPending()) {
      if (result.outcome.status === 'completed') messages.push(`Documento creado: ${result.outcome.documentUrl}`);
    }
    return messages;
  }

  /** Un ciclo completo del demonio: sincronizar, preguntar, grabar, detener y procesar. */
  async cycle(): Promise<{ sync: SyncReport; prompts: number; started: number; messages: string[] }> {
    const sync = await this.sync();
    const prompts = await this.promptDueMeetings();
    const started = await this.startAuthorizedMeetings();
    await this.recordings.tick();
    await this.privacy.purgeExpiredAudio();
    const messages = await this.processPending();
    return { sync, prompts: prompts.length, started: started.length, messages };
  }

  meetingContext(recording: RecordingRow): ReturnType<typeof contextFor> {
    const meeting = this.storage.getMeeting(recording.meeting_key);
    if (!meeting) throw new AppError('not_found', 'No se encontró la reunión de la grabación.', 'Revisa el historial.');
    return contextFor(meeting, this.settings.get());
  }

  private async onMeetingChange(change: MeetingChange): Promise<void> {
    await this.recordings.onMeetingChange(change);
    this.audit.record('calendar.change_applied', change.meetingKey, { kind: change.kind });
  }

  // ---- proveedores ----------------------------------------------------------

  private async transcriptionProvider(settings: AppSettings): Promise<TranscriptionProvider> {
    if (settings.transcription.provider === 'openai') {
      if (!settings.cloudProcessingAcknowledged) throw cloudNotAcknowledged();
      const key = await this.secrets.get('openai.apiKey');
      if (!key) throw new AppError('secret_missing', 'Falta la clave de API de transcripción.', 'Guárdala con «reuniones secrets set openai.apiKey».');
      return new OpenAITranscriptionProvider(key, this.fetchImpl);
    }
    const { whisperBinaryPath, whisperModelPath } = settings.transcription;
    if (!whisperBinaryPath || !whisperModelPath) {
      throw new AppError('transcription_not_configured', 'La transcripción local no está configurada.', 'Indica transcription.whisperBinaryPath y transcription.whisperModelPath en Configuración.');
    }
    return new WhisperCppProvider(whisperBinaryPath, whisperModelPath, join(this.config.dataDir, 'tmp'));
  }

  private async llmProvider(): Promise<LlmProvider> {
    if (!this.settings.get().cloudProcessingAcknowledged) throw cloudNotAcknowledged();
    const key = await this.secrets.get('anthropic.apiKey');
    if (!key) throw new AppError('secret_missing', 'Falta la clave de API del modelo de lenguaje.', 'Guárdala con «reuniones secrets set anthropic.apiKey».');
    return new AnthropicProvider(key, this.settings.get().llm.model, this.fetchImpl);
  }

  private async googleToken(): Promise<string> {
    const account = this.storage.listAccounts().find((a) => a.provider === 'google' && a.enabled === 1);
    if (!account) throw new AppError('not_connected', 'No hay ninguna cuenta de Google conectada.', 'Conecta Google con «reuniones connect google».');
    return this.tokens('google', account.id).getAccessToken();
  }

  private tokens(provider: Provider, accountId: string): TokenManager {
    const key = `${provider}:${accountId}`;
    let manager = this.tokenCache.get(key);
    if (!manager) {
      manager = new TokenManager(accountId, provider, this.oauthConfig(provider), this.secrets, this.fetchImpl);
      this.tokenCache.set(key, manager);
    }
    return manager;
  }

  private oauthConfig(provider: Provider): OAuthProviderConfig {
    if (provider === 'google') {
      if (!this.config.google.clientId) {
        throw new AppError('config_missing', 'Falta el client ID de Google.', 'Añádelo en config.json (ver docs/GUIA_GOOGLE.md).');
      }
      return {
        provider,
        clientId: this.config.google.clientId,
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        redirectHost: '127.0.0.1',
        scopes: [
          'openid',
          'email',
          'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
          'https://www.googleapis.com/auth/calendar.events.readonly',
          'https://www.googleapis.com/auth/drive.file',
        ],
        extraAuthParams: { access_type: 'offline', prompt: 'consent' },
      };
    }
    if (!this.config.microsoft.clientId) {
      throw new AppError('config_missing', 'Falta el client ID de Microsoft.', 'Añádelo en config.json (ver docs/GUIA_MICROSOFT.md).');
    }
    const base = `https://login.microsoftonline.com/${encodeURIComponent(this.config.microsoft.tenant)}/oauth2/v2.0`;
    return {
      provider,
      clientId: this.config.microsoft.clientId,
      authorizeUrl: `${base}/authorize`,
      tokenUrl: `${base}/token`,
      redirectHost: 'localhost',
      scopes: ['openid', 'offline_access', 'User.Read', 'Calendars.Read'],
    };
  }

  private async fetchProfile(provider: Provider, tokens: TokenSet): Promise<{ subject: string; label: string }> {
    const url = provider === 'google' ? 'https://openidconnect.googleapis.com/v1/userinfo' : 'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName';
    const response = await this.fetchImpl(url, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
    if (!response.ok) throw new AuthError('No se pudo leer el perfil de la cuenta conectada.');
    const json = (await response.json()) as { sub?: string; email?: string; id?: string; mail?: string; userPrincipalName?: string };
    if (provider === 'google') return { subject: json.sub!, label: json.email ?? json.sub! };
    return { subject: json.id!, label: json.mail ?? json.userPrincipalName ?? json.id! };
  }
}

function contextFor(meeting: MeetingRow, settings: AppSettings) {
  const start = new Date(meeting.start_utc);
  return {
    title: meeting.title,
    platform: meeting.platform,
    startLocal: formatLocal(meeting.start_utc),
    endLocal: formatLocal(meeting.end_utc),
    organizer: meeting.organizer,
    durationMinutes: Math.round((Date.parse(meeting.end_utc) - start.getTime()) / 60_000),
    language: settings.language,
    dateLocal: start.toLocaleDateString('sv-SE'),
    platformLabel: meeting.platform === 'google_meet' ? 'Google Meet' : 'Microsoft Teams',
  };
}

export function formatLocal(iso: string): string {
  return new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
}

function cloudNotAcknowledged(): AppError {
  return new AppError(
    'cloud_not_acknowledged',
    'El procesamiento en la nube no está autorizado.',
    'Lee la política de datos y activa cloudProcessingAcknowledged en Configuración, o usa la transcripción local.',
  );
}

