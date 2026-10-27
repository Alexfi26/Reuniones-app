import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditService } from '../audit/auditService.js';
import type { ConsentManager } from '../consent/consentManager.js';
import { deriveConsentStatus } from '../consent/consentManager.js';
import { AppError, ConsentRequiredError, PermissionError } from '../core/errors.js';
import type { FileVault } from '../privacy/fileVault.js';
import type { LocalStorageService, RecordingRow } from '../storage/localStorageService.js';
import type { MeetingChange } from '../calendar/calendarService.js';
import type { NotificationService } from '../notifications/notificationService.js';
import type { AudioCaptureService, CaptureSession, CaptureSource } from './audioCapture.js';

export type RecordingState = 'recording' | 'audio_ready' | 'failed';
export type StopReason = 'user' | 'meeting_ended' | 'meeting_changed' | 'app_shutdown';

export interface StartResult {
  recording: RecordingRow;
  /** Limitaciones reales de esta sesión (p. ej. audio del sistema no disponible). */
  warnings: string[];
}

export interface RecordingManagerDeps {
  storage: LocalStorageService;
  consent: ConsentManager;
  capture: AudioCaptureService;
  vault: FileVault;
  audit: AuditService;
  notifications: NotificationService;
  audioDir: string;
  clock?: () => Date;
}

/**
 * Único responsable de iniciar y detener la captura. Antes de tocar cualquier dispositivo exige:
 * autorización explícita de esta reunión, confirmación de consentimiento y permisos de macOS.
 */
export class RecordingManager {
  private readonly sessions = new Map<string, CaptureSession>();
  private readonly clock: () => Date;

  constructor(private readonly deps: RecordingManagerDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  activeRecording(): RecordingRow | null {
    return this.deps.storage.listRecordings(['recording'])[0] ?? null;
  }

  async start(meetingKey: string, options: { consentConfirmed: boolean }): Promise<StartResult> {
    const now = this.clock();
    const meeting = this.deps.storage.getMeeting(meetingKey);
    if (!meeting) throw new AppError('not_found', 'No se encontró la reunión.', 'Sincroniza los calendarios.');
    if (!options.consentConfirmed) {
      throw new ConsentRequiredError('Falta confirmar que los participantes han sido informados y han dado su consentimiento.');
    }

    const status = deriveConsentStatus(meeting, now);
    if (status !== 'authorized') {
      throw new PermissionError(
        `La grabación de esta reunión no está autorizada (estado: ${status}).`,
        'Autoriza la grabación de esta reunión antes de que empiece. No se graba sin autorización.',
      );
    }
    if (now.getTime() >= Date.parse(meeting.end_utc)) {
      throw new PermissionError('La reunión ya terminó. No se graba de forma retroactiva.', 'Solo se pueden iniciar grabaciones durante la reunión autorizada.');
    }
    if (this.activeRecording()) {
      throw new AppError('already_recording', 'Ya hay una grabación activa.', 'Detén la grabación actual antes de iniciar otra.');
    }

    const permissions = await this.deps.capture.checkPermissions();
    if (permissions.microphone === 'unsupported' && permissions.systemAudio === 'unsupported') {
      throw new AppError('capture_unsupported', 'La captura de audio no está disponible en esta plataforma.', 'Usa macOS 14.2 o superior con el helper nativo.');
    }
    if (permissions.microphone === 'denied') {
      throw new PermissionError('macOS no permite a la aplicación usar el micrófono.', 'Ajustes del Sistema > Privacidad y seguridad > Micrófono: activa la aplicación.');
    }

    const warnings: string[] = [];
    const sources: CaptureSource[] = [];
    if (permissions.microphone === 'granted' || permissions.microphone === 'undetermined') sources.push('microphone');
    if (permissions.systemAudio === 'granted' || permissions.systemAudio === 'undetermined') {
      sources.push('system');
    } else {
      warnings.push('El audio del sistema (voces remotas) no está disponible: solo se capturará el micrófono.');
    }
    if (sources.length === 0) {
      throw new PermissionError('No hay ninguna fuente de audio disponible.', 'Revisa los permisos de micrófono y de grabación de audio del sistema.');
    }

    const id = randomUUID();
    const iso = now.toISOString();
    const outputPath = join(this.deps.audioDir, `${id}.wav`);
    const row: RecordingRow = {
      id,
      meeting_key: meetingKey,
      state: 'recording',
      consent_confirmed_at: iso,
      started_at: iso,
      stopped_at: null,
      audio_path: null,
      error_code: null,
      error_message: null,
      created_at: iso,
      updated_at: iso,
    };
    this.deps.storage.insertRecording(row);

    try {
      const session = await this.deps.capture.start({ outputPath, sources });
      this.sessions.set(id, session);
      session.onProblem((problem) => {
        this.patch(id, { error_code: problem.code, error_message: problem.message });
        this.deps.audit.record('capture.problem', meetingKey, { code: problem.code });
        void this.deps.notifications.notify('Problema con la grabación', problem.message);
      });
    } catch (error) {
      this.patch(id, { state: 'failed', error_code: errorCode(error), error_message: (error as Error).message });
      throw error;
    }

    this.deps.audit.record('recording.started', meetingKey, {
      microphone: permissions.microphone,
      systemAudio: sources.includes('system') ? 'capturing' : permissions.systemAudio,
    });
    return { recording: this.require(id), warnings };
  }

  /** Detiene la captura, sella el audio cifrado y deja la grabación lista para procesar. */
  async stop(recordingId: string, reason: StopReason = 'user'): Promise<RecordingRow> {
    const row = this.require(recordingId);
    if (row.state !== 'recording') return row;
    const session = this.sessions.get(recordingId);
    this.sessions.delete(recordingId);
    if (!session) {
      // Sin sesión en memoria (reinicio de la app): se conserva lo que haya quedado en disco.
      return this.recoverPartial(row, 'session_lost');
    }
    try {
      const result = await session.stop();
      const encryptedPath = `${result.path}.enc`;
      await this.deps.vault.seal(result.path, encryptedPath);
      const now = this.clock().toISOString();
      this.patch(recordingId, { state: 'audio_ready', stopped_at: now, audio_path: encryptedPath });
      this.deps.audit.record('recording.stopped', row.meeting_key, { reason, durationMs: result.durationMs });
    } catch (error) {
      this.patch(recordingId, { state: 'failed', error_code: errorCode(error), error_message: (error as Error).message });
      throw error;
    }
    return this.require(recordingId);
  }

  /** Eventos de calendario: si la reunión se cancela o cambia de hora, la captura se detiene. */
  async onMeetingChange(change: MeetingChange): Promise<void> {
    const active = this.activeRecording();
    if (!active || active.meeting_key !== change.meetingKey) return;
    if (change.kind === 'new') return;
    await this.stop(active.id, 'meeting_changed');
  }

  /** Llamada periódica del daemon: detiene las grabaciones cuya reunión ya terminó. */
  async tick(): Promise<void> {
    const active = this.activeRecording();
    if (!active) return;
    const meeting = this.deps.storage.getMeeting(active.meeting_key);
    if (meeting && this.clock().getTime() >= Date.parse(meeting.end_utc)) {
      await this.stop(active.id, 'meeting_ended');
    }
  }

  /** Al arrancar: cualquier grabación que quedó abierta por un cierre inesperado se sella con lo que exista. */
  async recoverInterrupted(): Promise<RecordingRow[]> {
    const interrupted = this.deps.storage.listRecordings(['recording']);
    const recovered: RecordingRow[] = [];
    for (const row of interrupted) {
      recovered.push(await this.recoverPartial(row, 'app_restarted'));
    }
    return recovered;
  }

  private async recoverPartial(row: RecordingRow, reason: string): Promise<RecordingRow> {
    const plainPath = join(this.deps.audioDir, `${row.id}.wav`);
    const now = this.clock().toISOString();
    if (existsSync(plainPath)) {
      await this.deps.vault.seal(plainPath, `${plainPath}.enc`);
      this.patch(row.id, { state: 'audio_ready', stopped_at: now, audio_path: `${plainPath}.enc`, error_code: reason, error_message: 'Grabación interrumpida: se conserva el audio parcial.' });
    } else {
      this.patch(row.id, { state: 'failed', stopped_at: now, error_code: reason, error_message: 'La grabación se interrumpió y no quedó audio.' });
    }
    this.deps.audit.record('recording.recovered', row.meeting_key, { reason });
    return this.require(row.id);
  }

  private patch(id: string, changes: Partial<RecordingRow>): void {
    const current = this.require(id);
    this.deps.storage.updateRecording({ ...current, ...changes, updated_at: this.clock().toISOString() });
  }

  private require(id: string): RecordingRow {
    const row = this.deps.storage.getRecording(id);
    if (!row) throw new AppError('not_found', 'No se encontró la grabación.', 'Revisa el historial.');
    return row;
  }
}

function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : 'unexpected';
}
