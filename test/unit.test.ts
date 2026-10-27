import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findMeetingLinks, parseMeetingUrl } from '../src/core/meetingDetector.js';
import { decrypt, encrypt } from '../src/security/crypto.js';
import { parseWav, splitWavChunks, buildWavHeader } from '../src/transcription/transcription.js';
import { deriveConsentStatus } from '../src/consent/consentManager.js';
import { buildDecisionScript, parseDecisionOutput } from '../src/notifications/notificationService.js';
import { parseNotes, renderNotesMarkdown, validateNotes } from '../src/notes/meetingNotes.js';
import { buildMeetingDocument, documentName } from '../src/google/documentBuilder.js';
import { layout, TABLE_PLACEHOLDER } from '../src/google/googleDocs.js';
import { validateSettings, DEFAULT_SETTINGS } from '../src/settings/settingsService.js';
import { mapGoogleEvent } from '../src/calendar/googleCalendar.js';
import { mapGraphEvent, graphDateToIso } from '../src/calendar/microsoftCalendar.js';
import { KEY } from './helpers.js';
import { randomBytes } from 'node:crypto';

describe('detección de enlaces de reunión', () => {
  test('acepta códigos de Google Meet válidos', () => {
    const link = parseMeetingUrl('https://meet.google.com/abc-defg-hij');
    assert.deepEqual(link, { platform: 'google_meet', url: 'https://meet.google.com/abc-defg-hij', canonicalId: 'abc-defg-hij' });
  });

  test('rechaza Meet sin HTTPS, con código incorrecto o con otro host', () => {
    assert.equal(parseMeetingUrl('http://meet.google.com/abc-defg-hij'), null);
    assert.equal(parseMeetingUrl('https://meet.google.com/abc'), null);
    assert.equal(parseMeetingUrl('https://meet.google.com.evil.example/abc-defg-hij'), null);
    assert.equal(parseMeetingUrl('https://evil.example/?u=meet.google.com/abc-defg-hij'), null);
  });

  test('reconoce enlaces de Teams meetup-join y teams.live.com/meet', () => {
    const thread = '19:meeting_abc@thread.v2';
    const encoded = `https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(thread)}/0?context=%7B%7D`;
    assert.equal(parseMeetingUrl(encoded)?.canonicalId, thread);
    assert.equal(parseMeetingUrl('https://teams.live.com/meet/9876543210')?.platform, 'microsoft_teams');
  });

  test('extrae enlaces únicos de un texto libre', () => {
    const text = 'Únete: https://meet.google.com/abc-defg-hij y de nuevo https://meet.google.com/abc-defg-hij. Web: https://example.com';
    const links = findMeetingLinks(text);
    assert.equal(links.length, 1);
    assert.equal(links[0]?.canonicalId, 'abc-defg-hij');
  });
});

describe('configuración', () => {
  test('valores por defecto son válidos', () => {
    assert.doesNotThrow(() => validateSettings(DEFAULT_SETTINGS));
  });

  test('rechaza rangos fuera de límite y la exportación de audio a Drive', () => {
    assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, leadMinutes: 999 }), /leadMinutes/);
    assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, exportAudioToDrive: true }), /exportAudioToDrive/);
  });
});

describe('cifrado AES-256-GCM', () => {
  test('descifra lo cifrado y detecta manipulación', () => {
    const plain = randomBytes(1024);
    const sealed = encrypt(KEY, plain);
    assert.deepEqual(decrypt(KEY, sealed), plain);
    sealed[sealed.length - 1] ^= 0xff;
    assert.throws(() => decrypt(KEY, sealed));
  });
});

describe('WAV', () => {
  test('lee la cabecera y trocea sin perder muestras', () => {
    const data = Buffer.alloc(16_000 * 2 * 5, 1);
    const wav = Buffer.concat([buildWavHeader(data.length, 16_000, 1, 16), data]);
    const info = parseWav(wav);
    assert.equal(info.sampleRate, 16_000);
    assert.equal(info.dataLength, data.length);
    const chunks = splitWavChunks(wav, 2);
    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks.map((c) => c.startMs), [0, 2000, 4000]);
    const total = chunks.reduce((sum, c) => sum + c.wav.length - 44, 0);
    assert.equal(total, data.length);
  });

  test('rechaza ficheros que no son WAV', () => {
    assert.throws(() => parseWav(Buffer.from('no es audio')), /WAV válido/);
  });
});

describe('consentimiento por reunión', () => {
  const base = { meeting_key: 'k', platform: 'google_meet', canonical_id: 'x', join_url: 'u', title: 't', start_utc: '2026-10-27T10:00:00Z', end_utc: '2026-10-27T11:00:00Z', organizer: null, cancelled: 0, superseded: 0, decision: null, decided_at: null, snooze_until: null, prompted_at: null, created_at: '', updated_at: '' } as const;

  test('una reunión nueva está pendiente; tras su fin sin respuesta, sin respuesta', () => {
    assert.equal(deriveConsentStatus({ ...base }, new Date('2026-10-27T09:00:00Z')), 'pending');
    assert.equal(deriveConsentStatus({ ...base }, new Date('2026-10-27T11:30:00Z')), 'no_response');
  });

  test('la autorización solo vale para esa reunión y se respeta el rechazo', () => {
    assert.equal(deriveConsentStatus({ ...base, decision: 'record' }, new Date('2026-10-27T09:00:00Z')), 'authorized');
    assert.equal(deriveConsentStatus({ ...base, decision: 'decline' }, new Date('2026-10-27T09:00:00Z')), 'declined');
  });

  test('cancelación y sustitución tienen prioridad sobre la decisión', () => {
    assert.equal(deriveConsentStatus({ ...base, decision: 'record', cancelled: 1 }, new Date('2026-10-27T09:00:00Z')), 'cancelled');
    assert.equal(deriveConsentStatus({ ...base, decision: 'record', superseded: 1 }, new Date('2026-10-27T09:00:00Z')), 'superseded');
  });

  test('interpreta la respuesta de la ventana nativa; cancelar o expirar no es autorización', () => {
    assert.equal(parseDecisionOutput('button returned:Sí, grabar'), 'record');
    assert.equal(parseDecisionOutput('button returned:Recordar más tarde'), 'later');
    assert.equal(parseDecisionOutput('button returned:No grabar'), 'decline');
    assert.equal(parseDecisionOutput('gave up:true'), 'no_response');
    assert.equal(parseDecisionOutput(''), 'no_response');
  });

  test('escapa el texto del diálogo para AppleScript', () => {
    const script = buildDecisionScript('Reunión "A" \\ B', 60);
    assert.ok(script.includes('Reunión \\"A\\" \\\\ B'));
    assert.ok(script.includes('giving up after 60'));
  });
});

describe('notas inteligentes', () => {
  const valid = {
    general: { objective: null, participants: ['Ana'] },
    executiveSummary: 'Se revisó el presupuesto.',
    topics: [{ title: 'Presupuesto', points: ['Se revisó la partida de marketing.'] }],
    decisions: [],
    tasks: [{ task: 'Enviar cifras', owner: null, dueDate: null, status: 'pendiente' }],
    openQuestions: [],
    risksAndOpportunities: [{ type: 'riesgo', text: 'Retraso del proveedor.' }],
    transcriptionIssues: [],
  };

  test('acepta JSON válido aunque venga envuelto en texto', () => {
    const notes = parseNotes(`Aquí tienes:\n${JSON.stringify(valid)}\nFin.`);
    assert.equal(notes.tasks[0]?.owner, null);
  });

  test('rechaza campos ausentes o tipos de riesgo inventados', () => {
    assert.throws(() => validateNotes({ ...valid, executiveSummary: undefined }), /executiveSummary/);
    assert.throws(() => validateNotes({ ...valid, risksAndOpportunities: [{ type: 'magia', text: 'x' }] }), /Tipo de riesgo/);
    assert.throws(() => parseNotes('sin json'), /objeto JSON/);
  });

  test('marca como «No definido» responsables y fechas que no se mencionaron', () => {
    const md = renderNotesMarkdown(validateNotes(valid));
    assert.ok(md.includes('| Enviar cifras | No definido | No definido | pendiente |'));
    assert.ok(md.includes('[riesgo] Retraso del proveedor.'));
  });
});

describe('documento de Google Docs', () => {
  const notes = validateNotes({
    general: { objective: 'Alinear el plan', participants: [] },
    executiveSummary: 'Resumen breve.',
    topics: [],
    decisions: [{ text: 'Aprobar el plan' }],
    tasks: [{ task: 'Redactar propuesta', owner: 'Luis', dueDate: '2026-11-03', status: 'pendiente' }],
    openQuestions: [],
    risksAndOpportunities: [],
    transcriptionIssues: [],
  });
  const context = { title: 'Revisión comercial', dateLocal: '2026-10-27', startLocal: '27 oct 2026, 10:00', endLocal: null, platformLabel: 'Google Meet', organizer: null };

  test('nombre con el formato AAAA-MM-DD - Nombre - Notas', () => {
    assert.equal(documentName('2026-10-27', 'Revisión comercial'), '2026-10-27 - Revisión comercial - Notas');
  });

  test('incluye las secciones acordadas y la transcripción solo si está habilitada', () => {
    const transcript = { provider: 'whisper_cpp' as const, language: 'es', segments: [{ startMs: 65000, endMs: 66000, text: 'Hola', speaker: null }] };
    const withTranscript = buildMeetingDocument(context, notes, transcript, true);
    const texts = withTranscript.blocks.map((b) => ('text' in b ? b.text : b.kind));
    for (const section of ['Información general', 'Resumen ejecutivo', 'Decisiones y acuerdos', 'Tareas y próximos pasos', 'Transcripción']) {
      assert.ok(texts.includes(section), `falta ${section}`);
    }
    assert.ok(texts.includes('[00:01:05] Hola'));
    const withoutTranscript = buildMeetingDocument(context, notes, transcript, false);
    assert.ok(!withoutTranscript.blocks.some((b) => 'text' in b && b.text === 'Transcripción'));
  });

  test('los rangos de estilo cubren exactamente cada párrafo (índices UTF-16)', () => {
    const { text, styles } = layout([
      { kind: 'title', text: 'Título ñ' },
      { kind: 'bullet', text: 'Punto 😀' },
      { kind: 'table' },
    ]);
    assert.equal(text, `Título ñ\nPunto 😀\n${TABLE_PLACEHOLDER}\n`);
    const ranges = styles.map((s) => Object.values(s as Record<string, { range: { startIndex: number; endIndex: number } }>)[0]!.range);
    assert.deepEqual(ranges[0], { startIndex: 1, endIndex: 1 + 'Título ñ'.length + 1 });
    assert.equal(text.slice(ranges[1]!.startIndex - 1, ranges[1]!.endIndex - 1), 'Punto 😀\n');
  });
});

describe('normalización de eventos de calendario', () => {
  test('Google: detecta Meet por hangoutLink y omite eventos de día completo', () => {
    const event = mapGoogleEvent(
      { id: 'e1', summary: 'Sync', start: { dateTime: '2026-10-27T10:00:00+02:00' }, end: { dateTime: '2026-10-27T10:30:00+02:00' }, hangoutLink: 'https://meet.google.com/abc-defg-hij', organizer: { email: 'o@x.com' } },
      'google:u', 'primary',
    );
    assert.equal(event?.startUtc, '2026-10-27T08:00:00.000Z');
    assert.equal(event?.meetingLink?.platform, 'google_meet');
    assert.equal(mapGoogleEvent({ id: 'e2', start: { date: '2026-10-27' }, end: { date: '2026-10-28' } } as never, 'a', 'c'), null);
  });

  test('Google: marca cancelados', () => {
    const event = mapGoogleEvent({ id: 'e3', status: 'cancelled', start: { dateTime: '2026-10-27T10:00:00Z' }, end: { dateTime: '2026-10-27T11:00:00Z' } }, 'a', 'c');
    assert.equal(event?.cancelled, true);
  });

  test('Graph: normaliza fechas UTC sin desfase y lee onlineMeeting.joinUrl', () => {
    assert.equal(graphDateToIso('2026-10-27T10:00:00.0000000'), '2026-10-27T10:00:00.000Z');
    const event = mapGraphEvent(
      { id: 'g1', subject: 'Comité', start: { dateTime: '2026-10-27T10:00:00.0000000' }, end: { dateTime: '2026-10-27T11:00:00.0000000' }, onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0' }, isCancelled: false },
      'microsoft:u', 'cal',
    );
    assert.equal(event?.meetingLink?.canonicalId, '19:meeting_x@thread.v2');
  });
});

describe('inspección de WAV', () => {
  test('distingue silencio de señal', async () => {
    const { inspectWav } = await import('../src/tools/inspectWav.js');
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = (await import('./helpers.js')).tempDir();
    const silent = join(dir, 'silent.wav');
    writeFileSync(silent, Buffer.concat([buildWavHeader(32000, 16000, 1, 16), Buffer.alloc(32000)]));
    assert.match(inspectWav(silent), /silencio/);
    const tone = Buffer.alloc(32000);
    for (let i = 0; i < 16000; i++) tone.writeInt16LE(8000, i * 2);
    const loud = join(dir, 'loud.wav');
    writeFileSync(loud, Buffer.concat([buildWavHeader(32000, 16000, 1, 16), tone]));
    assert.match(inspectWav(loud), /señal presente/);
  });
});
