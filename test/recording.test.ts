import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { makeTestApp, seedGoogleAccount, type TestApp } from './helpers.js';
import { fakeGoogleFetch, fakeGoogleSource, newGoogleState } from './fakeGoogle.js';
import { AppError, ConsentRequiredError, PermissionError } from '../src/core/errors.js';

const MEET = 'https://meet.google.com/abc-defg-hij';

async function setupWithMeeting(now = '2026-10-27T09:55:00Z'): Promise<{ t: TestApp; key: string }> {
  const google = newGoogleState([{ id: 'primary', name: 'Principal' }]);
  google.events.primary = [{ id: 'm1', summary: 'Comité', start: '2026-10-27T10:00:00Z', end: '2026-10-27T11:00:00Z', hangoutLink: MEET }];
  const t = makeTestApp({ now, fetchImpl: fakeGoogleFetch(google) });
  await seedGoogleAccount(t);
  await t.app.sync();
  const meeting = t.app.storage.listMeetings()[0]!;
  return { t, key: meeting.meeting_key };
}

describe('grabación: reglas de autorización y consentimiento', () => {
  test('no graba sin autorización explícita de esa reunión', async () => {
    const { t, key } = await setupWithMeeting();
    await assert.rejects(t.app.recordings.start(key, { consentConfirmed: true }), PermissionError);
    assert.equal(t.capture.started.length, 0, 'no debe tocar el micrófono');
  });

  test('no graba si el usuario no confirma el consentimiento de los participantes', async () => {
    const { t, key } = await setupWithMeeting();
    t.app.consent.decide(key, 'record');
    await assert.rejects(t.app.recordings.start(key, { consentConfirmed: false }), ConsentRequiredError);
    assert.equal(t.capture.started.length, 0);
  });

  test('una negativa impide cualquier captura', async () => {
    const { t, key } = await setupWithMeeting();
    t.app.consent.decide(key, 'decline');
    await assert.rejects(t.app.recordings.start(key, { consentConfirmed: true }), PermissionError);
    assert.equal(t.capture.started.length, 0);
  });

  test('sin respuesta no se graba cuando la reunión ya ha terminado', async () => {
    const { t, key } = await setupWithMeeting('2026-10-27T11:30:00Z');
    await assert.rejects(t.app.recordings.start(key, { consentConfirmed: true }), PermissionError);
    assert.throws(() => t.app.consent.decide(key, 'record'), (error: unknown) => error instanceof AppError && error.code === 'meeting_ended');
  });

  test('autorizar tras el inicio graba desde ese momento; nunca de forma retroactiva', async () => {
    const { t, key } = await setupWithMeeting('2026-10-27T10:05:00Z');
    t.app.consent.decide(key, 'record');
    const { recording } = await t.app.recordings.start(key, { consentConfirmed: true });
    assert.equal(recording.state, 'recording');
    assert.ok(Date.parse(recording.started_at!) >= Date.parse('2026-10-27T10:05:00Z'));
  });

  test('una autorización no se hereda: si la reunión cambia de hora, la nueva ocurrencia vuelve a estar pendiente', async () => {
    const { t, key } = await setupWithMeeting();
    t.app.consent.decide(key, 'record');
    const google = newGoogleState([{ id: 'primary', name: 'Principal' }]);
    google.events.primary = [{ id: 'm1', summary: 'Comité', start: '2026-10-28T10:00:00Z', end: '2026-10-28T11:00:00Z', hangoutLink: MEET }];
    t.clock.set('2026-10-27T12:00:00Z');
    t.app.calendar['deps'].sources.google = fakeGoogleSource(google);
    await t.app.sync();
    const next = t.app.storage.listMeetings({ from: '2026-10-28T00:00:00Z' })[0]!;
    assert.notEqual(next.meeting_key, key);
    assert.equal(next.decision, null, 'la decisión anterior no debe heredarse');
    assert.equal(t.app.consent.status(next.meeting_key), 'pending');
  });
});

describe('grabación: ciclo de vida', () => {
  test('inicia con micrófono y audio del sistema, sella el audio cifrado y borra el WAV en claro', async () => {
    const { t, key } = await setupWithMeeting();
    t.app.consent.decide(key, 'record');
    const { recording, warnings } = await t.app.recordings.start(key, { consentConfirmed: true });
    assert.deepEqual(t.capture.started[0]?.sources, ['microphone', 'system']);
    assert.equal(warnings.length, 0);

    const stopped = await t.app.recordings.stop(recording.id, 'user');
    assert.equal(stopped.state, 'audio_ready');
    assert.ok(stopped.audio_path?.endsWith('.wav.enc'));
    assert.ok(existsSync(stopped.audio_path!));
    assert.equal(existsSync(t.capture.stopped[0]!), false, 'el WAV en claro debe eliminarse');
  });

  test('sin audio del sistema avisa de la limitación y graba solo el micrófono', async () => {
    const { t, key } = await setupWithMeeting();
    t.capture.permissions = { microphone: 'granted', systemAudio: 'denied' };
    t.app.consent.decide(key, 'record');
    const { warnings } = await t.app.recordings.start(key, { consentConfirmed: true });
    assert.deepEqual(t.capture.started[0]?.sources, ['microphone']);
    assert.match(warnings[0] ?? '', /voces remotas/);
  });

  test('micrófono denegado: error accionable y ninguna captura', async () => {
    const { t, key } = await setupWithMeeting();
    t.capture.permissions = { microphone: 'denied', systemAudio: 'granted' };
    t.app.consent.decide(key, 'record');
    await assert.rejects(t.app.recordings.start(key, { consentConfirmed: true }), (e: unknown) => e instanceof PermissionError && /Micrófono/.test(e.action ?? ''));
    assert.equal(t.capture.started.length, 0);
  });

  test('si la reunión se cancela durante la grabación, la captura se detiene', async () => {
    const { t, key } = await setupWithMeeting('2026-10-27T10:05:00Z');
    t.app.consent.decide(key, 'record');
    const { recording } = await t.app.recordings.start(key, { consentConfirmed: true });

    await t.app.recordings.onMeetingChange({ kind: 'cancelled', meetingKey: key, title: 'Comité' });
    assert.equal(t.app.storage.getRecording(recording.id)?.state, 'audio_ready');
    assert.equal(t.app.storage.getRecording(recording.id)?.error_code ?? null, null);
    assert.ok(t.capture.stopped.length === 1);
  });

  test('tick detiene la grabación al terminar la reunión', async () => {
    const { t, key } = await setupWithMeeting('2026-10-27T10:05:00Z');
    t.app.consent.decide(key, 'record');
    const { recording } = await t.app.recordings.start(key, { consentConfirmed: true });
    t.clock.set('2026-10-27T11:00:30Z');
    await t.app.recordings.tick();
    assert.equal(t.app.storage.getRecording(recording.id)?.state, 'audio_ready');
  });

  test('un problema de captura se registra y se notifica sin detener silenciosamente nada', async () => {
    const { t, key } = await setupWithMeeting('2026-10-27T10:05:00Z');
    t.app.consent.decide(key, 'record');
    const { recording } = await t.app.recordings.start(key, { consentConfirmed: true });
    t.capture.emitProblem('El dispositivo de audio se desconectó.');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(t.app.storage.getRecording(recording.id)?.error_code, 'device_disconnected');
    assert.ok(t.notifications.messages.some((m) => m.includes('Problema con la grabación')));
  });

  test('una grabación interrumpida por un cierre se conserva como audio parcial', async () => {
    const { t, key } = await setupWithMeeting('2026-10-27T10:05:00Z');
    t.app.consent.decide(key, 'record');
    const { recording } = await t.app.recordings.start(key, { consentConfirmed: true });
    // Simula un reinicio: la sesión en memoria desaparece pero el WAV parcial sí está en disco.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(t.capture.started[0]!.outputPath, Buffer.alloc(100));
    const recovered = await t.app.recordings.recoverInterrupted();
    assert.equal(recovered[0]?.id, recording.id);
    assert.equal(recovered[0]?.state, 'audio_ready');
  });
});
