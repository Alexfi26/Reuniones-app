import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { AuditService } from '../audit/auditService.js';
import { AppError, NetworkError, RateLimitError } from '../core/errors.js';
import type { FileVault } from '../privacy/fileVault.js';
import { secureDelete } from '../privacy/fileVault.js';
import type { LocalStorageService, RecordingRow } from '../storage/localStorageService.js';
import type { SettingsService, AppSettings } from '../settings/settingsService.js';
import type { GoogleDriveService } from '../google/googleDrive.js';
import type { GoogleDocsService } from '../google/googleDocs.js';
import { buildMeetingDocument, documentName } from '../google/documentBuilder.js';
import { buildNotesPrompt, parseNotes, validateNotes, type MeetingContext, type MeetingNotes } from '../notes/meetingNotes.js';
import type { LlmProvider } from '../notes/llmProvider.js';
import type { Transcript, TranscriptionProvider } from '../transcription/transcription.js';
import type { RenderedDocument } from '../google/googleDocs.js';

/** Orden fijo de los pasos. Cada uno deja su resultado en la tabla jobs; reanudar nunca repite un paso terminado. */
export const PIPELINE_STEPS = ['transcribe', 'notes', 'review', 'document', 'retention'] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export type PipelineOutcome =
  | { status: 'completed'; documentUrl: string }
  | { status: 'awaiting_review' }
  | { status: 'pending_sync'; reason: string }
  | { status: 'failed'; reason: string };

export interface PipelineDeps {
  storage: LocalStorageService;
  vault: FileVault;
  audit: AuditService;
  settings: SettingsService;
  transcriptionFor: (settings: AppSettings) => Promise<TranscriptionProvider>;
  llm: () => Promise<LlmProvider>;
  drive: GoogleDriveService;
  docs: GoogleDocsService;
  audioDir: string;
  workDir: string;
  /** Datos de la reunión necesarios para el documento, resueltos por la capa de aplicación. */
  meetingContext: (recording: RecordingRow) => MeetingContext & { platformLabel: string; dateLocal: string };
  clock?: () => Date;
}

interface DocumentArtifact {
  docId: string;
  url: string;
  written: boolean;
}

/**
 * Procesa una grabación: transcripción → notas → revisión humana → Google Docs → retención.
 * Si una llamada de red falla, la grabación queda en pending_sync y se reanuda sin duplicar resultados.
 */
export class ProcessingPipeline {
  private readonly clock: () => Date;

  constructor(private readonly deps: PipelineDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async run(recordingId: string): Promise<PipelineOutcome> {
    const recording = this.require(recordingId);
    if (recording.state === 'recording') {
      throw new AppError('still_recording', 'La grabación todavía está en curso.', 'Detén la grabación antes de procesarla.');
    }
    if (recording.state === 'completed') {
      return { status: 'completed', documentUrl: this.deps.storage.getDocument(recordingId)?.url ?? '' };
    }
    if (!recording.audio_path || !existsSync(recording.audio_path)) {
      this.setState(recordingId, 'failed', 'audio_missing', 'El archivo de audio ya no existe.');
      return { status: 'failed', reason: 'El archivo de audio ya no existe.' };
    }

    this.setState(recordingId, 'processing', null, null);
    for (const step of PIPELINE_STEPS) {
      if (this.isDone(recordingId, step)) continue;
      try {
        if (step === 'review') {
          this.setState(recordingId, 'awaiting_review', null, null);
          return { status: 'awaiting_review' };
        }
        await this.runStep(recordingId, step);
        this.markJob(recordingId, step, 'done', null);
      } catch (error) {
        const reason = (error as Error).message;
        const attempts = (this.deps.storage.getJob(recordingId, step)?.attempts ?? 0) + 1;
        if (error instanceof NetworkError || error instanceof RateLimitError) {
          this.markJob(recordingId, step, 'waiting', reason, attempts);
          this.setState(recordingId, 'pending_sync', null, reason);
          this.deps.audit.record('pipeline.pending_sync', recording.meeting_key, { step });
          return { status: 'pending_sync', reason };
        }
        this.markJob(recordingId, step, 'failed', reason, attempts);
        this.setState(recordingId, 'failed', errorCode(error), reason);
        this.deps.audit.record('pipeline.failed', recording.meeting_key, { step, code: errorCode(error) });
        return { status: 'failed', reason };
      }
    }
    const documentUrl = this.deps.storage.getDocument(recordingId)?.url ?? '';
    this.setState(recordingId, 'completed', null, null);
    this.deps.audit.record('pipeline.completed', recording.meeting_key, {});
    return { status: 'completed', documentUrl };
  }

  /** El usuario aprueba las notas tras revisarlas. Solo entonces se crea el documento. */
  async approve(recordingId: string): Promise<PipelineOutcome> {
    if (!this.getNotes(recordingId)) {
      throw new AppError('notes_missing', 'Todavía no hay notas que aprobar.', 'Espera a que termine la generación de notas.');
    }
    this.markJob(recordingId, 'review', 'done', null);
    return this.run(recordingId);
  }

  /** Sustituye las notas por una versión revisada (validada). La aprobación debe repetirse. */
  importNotes(recordingId: string, data: unknown): void {
    const notes = validateNotes(data);
    this.saveArtifact(recordingId, 'notes', notes);
    this.markJob(recordingId, 'notes', 'done', null);
    this.markJob(recordingId, 'review', 'pending', null);
  }

  getNotes(recordingId: string): MeetingNotes | null {
    return this.readArtifact<MeetingNotes>(recordingId, 'notes');
  }

  getTranscript(recordingId: string): Transcript | null {
    return this.readArtifact<Transcript>(recordingId, 'transcribe');
  }

  /** Reintenta todas las grabaciones que quedaron pendientes por red o por límites de uso. */
  async retryPending(): Promise<{ recordingId: string; outcome: PipelineOutcome }[]> {
    const results: { recordingId: string; outcome: PipelineOutcome }[] = [];
    for (const row of this.deps.storage.listRecordings(['pending_sync', 'processing'])) {
      results.push({ recordingId: row.id, outcome: await this.run(row.id) });
    }
    return results;
  }

  private async runStep(recordingId: string, step: PipelineStep): Promise<void> {
    switch (step) {
      case 'transcribe':
        await this.transcribe(recordingId);
        return;
      case 'notes':
        await this.generateNotes(recordingId);
        return;
      case 'document':
        await this.createDocument(recordingId);
        return;
      case 'retention':
        await this.applyRetention(recordingId);
        return;
      case 'review':
        return;
    }
  }

  private async transcribe(recordingId: string): Promise<void> {
    const recording = this.require(recordingId);
    const settings = this.deps.settings.get();
    const provider = await this.deps.transcriptionFor(settings);
    const wavPath = join(this.deps.workDir, `${recordingId}.wav`);
    await writeFile(wavPath, await this.deps.vault.open(recording.audio_path!), { mode: 0o600 });
    try {
      const transcript = await provider.transcribe(wavPath, { language: settings.language });
      this.saveArtifact(recordingId, 'transcribe', transcript);
    } finally {
      await secureDelete(wavPath);
    }
  }

  private async generateNotes(recordingId: string): Promise<void> {
    const recording = this.require(recordingId);
    const transcript = this.getTranscript(recordingId);
    if (!transcript) throw new AppError('transcript_missing', 'No hay transcripción para generar notas.', 'Repite el paso de transcripción.');
    const context = this.deps.meetingContext(recording);
    const text = transcript.segments.map((s) => `[${Math.floor(s.startMs / 1000)}s] ${s.text}`).join('\n');
    const { system, user } = buildNotesPrompt(context, text);
    const llm = await this.deps.llm();
    const raw = await llm.complete({ system, user, maxTokens: 4096 });
    const notes = parseNotes(raw);
    this.saveArtifact(recordingId, 'notes', notes);
    this.markJob(recordingId, 'review', 'pending', null);
  }

  private async createDocument(recordingId: string): Promise<void> {
    const recording = this.require(recordingId);
    const settings = this.deps.settings.get();
    const notes = this.getNotes(recordingId);
    if (!notes) throw new AppError('notes_missing', 'No hay notas aprobadas para publicar.', 'Revisa y aprueba las notas.');
    const transcript = this.getTranscript(recordingId);
    const context = this.deps.meetingContext(recording);

    const folder = await this.deps.drive.ensureFolder({ folderId: settings.driveFolderId, name: settings.driveFolderName });
    if (folder.id !== settings.driveFolderId) this.deps.settings.update({ driveFolderId: folder.id });

    const saved = this.readArtifact<DocumentArtifact>(recordingId, 'document');
    let doc: { id: string; url: string };
    if (saved) {
      doc = { id: saved.docId, url: saved.url };
    } else {
      const existing = await this.deps.drive.findDocumentByJobKey(folder.id, recordingId);
      doc = existing ?? (await this.deps.drive.createDocument({ folderId: folder.id, name: documentName(context.dateLocal, context.title), jobKey: recordingId }));
    }
    this.saveArtifact(recordingId, 'document', { docId: doc.id, url: doc.url, written: false } satisfies DocumentArtifact);

    const rendered: RenderedDocument = buildMeetingDocument(
      { title: context.title, dateLocal: context.dateLocal, startLocal: context.startLocal, endLocal: context.endLocal, platformLabel: context.platformLabel, organizer: context.organizer },
      notes,
      transcript,
      settings.includeTranscriptInDoc,
    );
    await this.deps.docs.writeDocument(doc.id, rendered);
    await this.deps.docs.verifyContains(doc.id, 'Resumen ejecutivo');
    this.saveArtifact(recordingId, 'document', { docId: doc.id, url: doc.url, written: true } satisfies DocumentArtifact);
    this.deps.storage.saveDocument({
      recording_id: recordingId,
      folder_id: folder.id,
      drive_file_id: doc.id,
      url: doc.url,
      created_at: this.clock().toISOString(),
    });
    this.deps.audit.record('document.created', recording.meeting_key, { folderCreated: folder.created });
  }

  private async applyRetention(recordingId: string): Promise<void> {
    const recording = this.require(recordingId);
    const { audioRetention } = this.deps.settings.get();
    if (audioRetention.mode !== 'delete_after_success' || !recording.audio_path) return;
    await secureDelete(recording.audio_path);
    this.deps.storage.updateRecording({ ...recording, audio_path: null, updated_at: this.clock().toISOString() });
    this.deps.audit.record('audio.deleted', recording.meeting_key, { reason: 'retention_after_success' });
  }

  private isDone(recordingId: string, step: PipelineStep): boolean {
    return this.deps.storage.getJob(recordingId, step)?.status === 'done';
  }

  private markJob(recordingId: string, step: string, status: string, lastError: string | null, attempts?: number): void {
    const current = this.deps.storage.getJob(recordingId, step);
    this.deps.storage.saveJob({
      recording_id: recordingId,
      step,
      status,
      attempts: attempts ?? current?.attempts ?? 0,
      last_error: lastError,
      artifact: current?.artifact ?? null,
      updated_at: this.clock().toISOString(),
    });
  }

  private saveArtifact(recordingId: string, step: string, value: unknown): void {
    const current = this.deps.storage.getJob(recordingId, step);
    this.deps.storage.saveJob({
      recording_id: recordingId,
      step,
      status: current?.status ?? 'in_progress',
      attempts: current?.attempts ?? 0,
      last_error: null,
      artifact: this.deps.vault.sealJson(value),
      updated_at: this.clock().toISOString(),
    });
  }

  private readArtifact<T>(recordingId: string, step: string): T | null {
    const row = this.deps.storage.getJob(recordingId, step);
    return row?.artifact ? this.deps.vault.openJson<T>(row.artifact) : null;
  }

  private setState(recordingId: string, state: RecordingRow['state'] | string, errorCode: string | null, errorMessage: string | null): void {
    const row = this.require(recordingId);
    this.deps.storage.updateRecording({
      ...row,
      state,
      error_code: errorCode,
      error_message: errorMessage,
      updated_at: this.clock().toISOString(),
    });
  }

  private require(recordingId: string): RecordingRow {
    const row = this.deps.storage.getRecording(recordingId);
    if (!row) throw new AppError('not_found', 'No se encontró la grabación.', 'Revisa el historial.');
    return row;
  }
}

function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : 'unexpected';
}
