import { jsonResponse } from './helpers.js';
import { GoogleCalendarSource } from '../src/calendar/googleCalendar.js';
import type { CalendarSource } from '../src/calendar/calendarSource.js';

export interface FakeCalendarEvent {
  id: string;
  summary: string;
  status?: 'confirmed' | 'cancelled';
  start: string;
  end: string;
  hangoutLink?: string;
  location?: string;
}

export interface FakeGoogleState {
  calendars: { id: string; name: string }[];
  events: Record<string, FakeCalendarEvent[]>;
  failingCalendars: Set<string>;
  tokenRequests: number;
}

export function newGoogleState(calendars: { id: string; name: string }[]): FakeGoogleState {
  return { calendars, events: {}, failingCalendars: new Set(), tokenRequests: 0 };
}

/** Simula los endpoints de Google que usa la app: token, userinfo, calendarList y events. */
export function fakeGoogleFetch(state: FakeGoogleState): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') {
      state.tokenRequests++;
      return jsonResponse({ access_token: `at-${state.tokenRequests}`, expires_in: 3600, refresh_token: 'refresh-token-test' });
    }
    if (url.hostname === 'openidconnect.googleapis.com') {
      return jsonResponse({ sub: 'user-1', email: 'ana@example.com' });
    }
    if (url.pathname === '/calendar/v3/users/me/calendarList') {
      return jsonResponse({ items: state.calendars.map((c) => ({ id: c.id, summary: c.name })) });
    }
    const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname);
    if (match) {
      const calendarId = decodeURIComponent(match[1]!);
      if (state.failingCalendars.has(calendarId)) return jsonResponse({ error: 'boom' }, 500);
      const items = (state.events[calendarId] ?? []).map((e) => ({
        id: e.id,
        summary: e.summary,
        status: e.status ?? 'confirmed',
        start: { dateTime: e.start },
        end: { dateTime: e.end },
        hangoutLink: e.hangoutLink,
        location: e.location,
        organizer: { email: 'org@example.com', displayName: 'Organizadora' },
      }));
      return jsonResponse({ items });
    }
    return jsonResponse({ error: 'not found' }, 404);
  }) as typeof fetch;
}

/** Fuente de calendario ya conectada a un estado simulado (para cambiar eventos entre sincronizaciones). */
export function fakeGoogleSource(state: FakeGoogleState): CalendarSource {
  return new GoogleCalendarSource(async () => 'token', fakeGoogleFetch(state));
}
