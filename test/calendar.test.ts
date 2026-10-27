import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, seedGoogleAccount, type TestApp } from './helpers.js';
import { fakeGoogleFetch, newGoogleState, type FakeGoogleState } from './fakeGoogle.js';

const MEET = 'https://meet.google.com/abc-defg-hij';
const TEAMS_ID = '19%3ameeting_x%40thread.v2';

function setup(): { t: TestApp; google: FakeGoogleState } {
  const google = newGoogleState([
    { id: 'primary', name: 'Principal' },
    { id: 'work', name: 'Trabajo' },
  ]);
  const t = makeTestApp({ now: '2026-10-27T09:00:00Z', fetchImpl: fakeGoogleFetch(google) });
  return { t, google };
}

describe('sincronización de calendarios (Google, fake de la API)', () => {
  test('crea reuniones, deduplica la misma reunión en dos calendarios y detecta cancelaciones', async () => {
    const { t, google } = setup();
    await seedGoogleAccount(t);
    const meeting = { id: 'm1', summary: 'Revisión', start: '2026-10-27T10:00:00Z', end: '2026-10-27T11:00:00Z', hangoutLink: MEET };
    google.events.primary = [meeting, { id: 'm2', summary: 'Teams', start: '2026-10-27T12:00:00Z', end: '2026-10-27T13:00:00Z', location: `https://teams.microsoft.com/l/meetup-join/${TEAMS_ID}/0` }];
    google.events.work = [{ ...meeting, id: 'copy-of-m1' }];

    const first = await t.app.sync();
    assert.equal(first.errors.length, 0);
    assert.equal(t.app.storage.listMeetings().length, 2, 'la reunión duplicada debe colapsar en una');
    assert.equal(first.changes.filter((c) => c.kind === 'new').length, 2);
    const shared = t.app.storage.listMeetings().find((m) => m.platform === 'google_meet')!;
    assert.equal(t.app.storage.eventsForMeeting(shared.meeting_key).length, 2);

    // Cambio de horario en ambos calendarios: la reunión antigua queda sustituida.
    const moved = { ...meeting, start: '2026-10-27T15:00:00Z', end: '2026-10-27T16:00:00Z' };
    google.events.primary = [moved, google.events.primary[1]!];
    google.events.work = [{ ...moved, id: 'copy-of-m1' }];
    const second = await t.app.sync();
    assert.ok(second.changes.some((c) => c.kind === 'rescheduled'), 'debe avisar del cambio de horario');
    const old = t.app.storage.getMeeting(shared.meeting_key)!;
    assert.equal(old.superseded, 1);

    // Cancelación del evento de Teams.
    google.events.primary = [moved, { ...google.events.primary[1]!, status: 'cancelled' }];
    const third = await t.app.sync();
    assert.ok(third.changes.some((c) => c.kind === 'cancelled'));
    const teams = t.app.storage.listMeetings().find((m) => m.platform === 'microsoft_teams')!;
    assert.equal(teams.cancelled, 1);
  });

  test('un calendario que falla no altera los datos de los demás', async () => {
    const { t, google } = setup();
    await seedGoogleAccount(t);
    google.events.primary = [{ id: 'a', summary: 'A', start: '2026-10-27T10:00:00Z', end: '2026-10-27T11:00:00Z', hangoutLink: MEET }];
    google.events.work = [{ id: 'b', summary: 'B', start: '2026-10-27T11:30:00Z', end: '2026-10-27T12:00:00Z', hangoutLink: 'https://meet.google.com/bbb-cccc-ddd' }];
    await t.app.sync();
    const before = t.app.storage.listMeetings().length;

    google.failingCalendars.add('work');
    const report = await t.app.sync();
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]?.code, 'google_calendar');
    assert.equal(t.app.storage.listMeetings().length, before, 'un error de red no debe borrar reuniones');
  });

  test('un evento retirado del calendario se marca como eliminado', async () => {
    const { t, google } = setup();
    await seedGoogleAccount(t);
    google.events.primary = [{ id: 'x', summary: 'X', start: '2026-10-27T10:00:00Z', end: '2026-10-27T11:00:00Z', hangoutLink: MEET }];
    await t.app.sync();
    google.events.primary = [];
    const report = await t.app.sync();
    assert.ok(report.changes.some((c) => c.kind === 'removed'));
    assert.equal(t.app.storage.listMeetings()[0]?.superseded, 1);
  });

  test('sin cuentas conectadas la sincronización no hace peticiones', async () => {
    const { t, google } = setup();
    const report = await t.app.sync();
    assert.equal(report.eventsSeen, 0);
    assert.equal(google.tokenRequests, 0);
  });
});
