import type { AuditService } from '../audit/auditService.js';
import { AppError } from '../core/errors.js';
import type { LocalStorageService } from '../storage/localStorageService.js';
import type { SettingsService } from '../settings/settingsService.js';
import { secureDelete } from './fileVault.js';
import type { TokenManager } from '../auth/tokenManager.js';

/** Política de conservación, borrado y revocación. Toda eliminación irreversible exige confirmación explícita. */
export class PrivacyService {
  constructor(
    private readonly storage: LocalStorageService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Aplica keep_days: borra audio de grabaciones terminadas más antiguas que el plazo configurado. */
  async purgeExpiredAudio(): Promise<number> {
    const { audioRetention } = this.settings.get();
    if (audioRetention.mode !== 'keep_days') return 0;
    const cutoff = this.clock().getTime() - audioRetention.days * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const recording of this.storage.listRecordings(['completed', 'failed'])) {
      if (!recording.audio_path || Date.parse(recording.updated_at) > cutoff) continue;
      await secureDelete(recording.audio_path);
      this.storage.updateRecording({ ...recording, audio_path: null, updated_at: this.clock().toISOString() });
      this.audit.record('audio.deleted', recording.meeting_key, { reason: 'retention_expired' });
      removed++;
    }
    return removed;
  }

  /**
   * Elimina del equipo el audio, los artefactos (transcripción y notas) y el registro local de una grabación.
   * El documento de Google Docs NO se borra: sigue en Drive y se indica su enlace para hacerlo manualmente.
   */
  async deleteRecordingData(recordingId: string, confirmed: boolean): Promise<{ documentUrl: string | null }> {
    if (!confirmed) {
      throw new AppError('confirmation_required', 'Eliminar una grabación requiere confirmación explícita.', 'Repite el comando con --yes.');
    }
    const recording = this.storage.getRecording(recordingId);
    if (!recording) throw new AppError('not_found', 'No se encontró la grabación.', 'Revisa el historial.');
    if (recording.state === 'recording') {
      throw new AppError('still_recording', 'La grabación está en curso.', 'Deténla antes de eliminar sus datos.');
    }
    if (recording.audio_path) await secureDelete(recording.audio_path);
    const documentUrl = this.storage.getDocument(recordingId)?.url ?? null;
    this.storage.deleteRecording(recordingId);
    this.audit.record('recording.deleted', recording.meeting_key, {});
    return { documentUrl };
  }

  /** Desconecta una cuenta: borra tokens locales y su calendario sincronizado. */
  async disconnectAccount(accountId: string, tokens: TokenManager, confirmed: boolean): Promise<void> {
    if (!confirmed) {
      throw new AppError('confirmation_required', 'Desconectar una cuenta requiere confirmación explícita.', 'Repite el comando con --yes.');
    }
    await tokens.revoke();
    this.storage.deleteAccount(accountId);
    this.audit.record('account.disconnected', null, {});
  }
}
