import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { makeTestApp, seedGoogleAccount, type TestApp } from './helpers.js';
import { fakeGoogleFetch, newGoogleState } from './fakeGoogle.js';
import { NetworkError, AppError } from '../src/core/errors.js';
import type { GoogleDriveService } from '../src/google/googleDrive.js';
import type { GoogleDocsService, RenderedDocument } from '../src/google/googleDocs.js';
import type { Transcript, TranscriptionProvider } from '../src/transcription/transcription.js';
import type { LlmProvider } from '../src/notes/llmProvider.js';

const MEET = 'https://meet.google.com/abc-defg-hij';
const VALID_NOTES = {
  general: { objective: 'Revisar el presupuesto', participants: ['Ana'] },
  executiveSummary: 'Se revisó el presupuesto trimestral.',
  topics: [{ title: 'Presupuesto', points: ['Partida de marketing revisada.'] }],
  decisions: [],
  tasks: [{ task: 'Enviar cifras', owner: null, dueDate: null, status: 'pendiente' }],
  openQuestions: ['¿Cuándo se cierra el trimestre?'],
  risksAndOpportunities: [],
  transcriptionIssues: [],
};

/** Drive simulado: cuenta creaciones para comprobar que no se duplican documentos. */
class FakeDrive {
  folders = 0;
  creates = 0;
  documents = new Map<string, { id: string; url: string }>();
  async ensureFolder(): Promise<{ id: string; name: string; created: boolean }> {
    this.folders++;
    return { id: 'folder-1', name: 'reuniones grabadas', created: this.folders === 1 };
  }
  async findDocumentByJobKey(_folderId: string, jobKey: string) {
    return this.documents.get(jobKey) ?? null;
  }
  async createDocument({ jobKey }: { jobKey: string }) {
    this.creates++;
    const doc = { id: `doc-${this.creates}`, url: `https://docs.google.com/document/d/doc-${this.creates}/edit` };
    this.documents.set(jobKey, doc);
    return doc;
  }
}

/** Docs simulado: puede fallar una vez por red en la escritura. */
class FakeDocs {
  writes: { documentId: string; content: RenderedDocument }[] = [];
  failNextWriteWithNetwork = false;
  async writeDocument(documentId: string, content: RenderedDocument): Promise<void> {
    if (this.failNextWriteWithNetwork) {
      this.failNextWriteWithNetwork = false;
      throw new NetworkError('Sin conexión durante la escritura.');
    }
    this.writes.push({ documentId, content });
  }
  async verifyContains(): Promise<void> {
    return;
  }
}

class FakeTranscription implements TranscriptionProvider {
  readonly id = 'whisper_cpp' as const;
  calls = 0;
  async transcribe(): Promise<Transcript> {
    this.calls++;
    return {
      provider: 'whisper_cpp',
      language: 'es',
      segments: [
        { startMs: 0, endMs: 2000, text: 'Hola, revisemos el presupuesto.', speaker: null },
        { startMs: 2000, endMs: 4000, text: 'Enviaré las cifras.', speaker: null },
      ],
    };
  }
}

class FakeLlm implements LlmProvider {
  readonly id = 'fake';
  calls = 0;
  constructor(private readonly reply: string) {}
  async complete(): Promise<string> {
    this.calls++;
    return this.reply;
  }
}

interface Harness {
  t: TestApp;
  drive: FakeDrive;
  docs: FakeDocs;
  transcription: FakeTranscription;
  llm: FakeLlm;
  recordingId: string;
}

async function harness(llmReply = JSON.stringify(VALID_NOTES)): Promise<Harness> {
  const google = newGoogleState([{ id: 'primary', name: 'Principal' }]);
  google.events.primary = [{ id: 'm1', summary: 'Presupuesto', start: '2026-10-27T10:00:00Z', end: '2026-10-27T11:00:00Z', hangoutLink: MEET }];
  const drive = new FakeDrive();
  const docs = new FakeDocs();
  const transcription = new FakeTranscription();
  const llm = new FakeLlm(llmReply);
  const t = makeTestApp({
    now: '2026-10-27T10:05:00Z',
    fetchImpl: fakeGoogleFetch(google),
    drive: drive as unknown as GoogleDriveService,
    docs: docs as unknown as GoogleDocsService,
    transcriptionFor: async () => transcription,
    llm: async () => llm,
  });
  await seedGoogleAccount(t);
  await t.app.sync();
  const key = t.app.storage.listMeetings()[0]!.meeting_key;
  t.app.consent.decide(key, 'record');
  const { recording } = await t.app.recordings.start(key, { consentConfirmed: true });
  await t.app.recordings.stop(recording.id, 'user');
  return { t, drive, docs, transcription, llm, recordingId: recording.id };
}

describe('pipeline de procesamiento', () => {
  test('transcribe, genera notas, espera revisión y solo crea el documento tras aprobar', async () => {
    const h = await harness();
    const first = await h.t.app.pipeline.run(h.recordingId);
    assert.equal(first.status, 'awaiting_review');
    assert.equal(h.docs.writes.length, 0, 'no debe escribir en Docs antes de la aprobación');

    const done = await h.t.app.pipeline.approve(h.recordingId);
    assert.equal(done.status, 'completed');
    assert.equal(h.drive.creates, 1);
    const written = h.docs.writes[0]!.content.blocks.map((b) => ('text' in b ? b.text : b.kind));
    assert.ok(written.includes('Resumen ejecutivo'));
    assert.ok(written.includes('Transcripción'));
    assert.equal(h.t.app.storage.getDocument(h.recordingId)?.url, 'https://docs.google.com/document/d/doc-1/edit');
    assert.equal(h.t.app.storage.getRecording(h.recordingId)?.state, 'completed');
  });

  test('retención por defecto: el audio se elimina solo después de publicar con éxito', async () => {
    const h = await harness();
    const audio = h.t.app.storage.getRecording(h.recordingId)!.audio_path!;
    await h.t.app.pipeline.run(h.recordingId);
    assert.ok(existsSync(audio), 'el audio debe conservarse hasta que las notas estén publicadas');
    await h.t.app.pipeline.approve(h.recordingId);
    assert.equal(existsSync(audio), false);
    assert.equal(h.t.app.storage.getRecording(h.recordingId)?.audio_path, null);
  });

  test('un corte de red al escribir queda pendiente y se reanuda sin duplicar el documento ni repetir la transcripción', async () => {
    const h = await harness();
    await h.t.app.pipeline.run(h.recordingId);
    h.docs.failNextWriteWithNetwork = true;
    const interrupted = await h.t.app.pipeline.approve(h.recordingId);
    assert.equal(interrupted.status, 'pending_sync');
    assert.equal(h.t.app.storage.getRecording(h.recordingId)?.state, 'pending_sync');

    const resumed = await h.t.app.pipeline.retryPending();
    assert.equal(resumed[0]?.outcome.status, 'completed');
    assert.equal(h.drive.creates, 1, 'no debe crearse un segundo documento');
    assert.equal(h.transcription.calls, 1, 'la transcripción ya guardada no se repite');
    assert.equal(h.llm.calls, 1, 'las notas ya guardadas no se regeneran');
  });

  test('notas con formato inválido fallan de forma explícita y se pueden corregir e importar', async () => {
    const h = await harness('{"executiveSummary": "incompleto"}');
    const outcome = await h.t.app.pipeline.run(h.recordingId);
    assert.equal(outcome.status, 'failed');
    assert.equal(h.t.app.storage.getRecording(h.recordingId)?.error_code, 'notes_invalid');
    assert.ok(existsSync(h.t.app.storage.getRecording(h.recordingId)!.audio_path!), 'el audio se conserva');

    h.t.app.storage.updateRecording({ ...h.t.app.storage.getRecording(h.recordingId)!, state: 'audio_ready', error_code: null, error_message: null });
    h.t.app.pipeline.importNotes(h.recordingId, VALID_NOTES);
    const reviewed = await h.t.app.pipeline.run(h.recordingId);
    assert.equal(reviewed.status, 'awaiting_review');
  });

  test('sin transcripción configurada no se inventa nada: error accionable', async () => {
    const t = makeTestApp({ now: '2026-10-27T10:05:00Z' });
    const error = await t.app.pipeline['deps'].transcriptionFor(t.app.settings.get()).catch((e: unknown) => e);
    assert.ok(error instanceof AppError);
    assert.equal((error as AppError).code, 'transcription_not_configured');
  });

  test('el envío a la nube requiere reconocimiento explícito de la política de datos', async () => {
    const t = makeTestApp({ now: '2026-10-27T10:05:00Z' });
    t.app.settings.update({ transcription: { provider: 'openai', whisperBinaryPath: null, whisperModelPath: null } });
    await assert.rejects(t.app['transcriptionProvider'](t.app.settings.get()), (e: unknown) => e instanceof AppError && e.code === 'cloud_not_acknowledged');
  });
});
