import { NetworkError, RateLimitError, AppError } from '../core/errors.js';
import { findMeetingLinks, pickPrimaryLink } from '../core/meetingDetector.js';
import type { CalendarEvent, TimeWindow } from '../core/types.js';
import type { FetchLike } from '../auth/oauth.js';
import type { AccessTokenGetter, CalendarInfo, CalendarSource } from './calendarSource.js';

/** Google Calendar API v3. Scopes mínimos: calendar.calendarlist.readonly y calendar.events.readonly. */
export class GoogleCalendarSource implements CalendarSource {
  readonly provider = 'google' as const;

  constructor(
    private readonly getToken: AccessTokenGetter,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://www.googleapis.com/calendar/v3',
  ) {}

  async listCalendars(accountId: string): Promise<CalendarInfo[]> {
    const items = await this.collect<GoogleCalendarListItem>(accountId, `${this.baseUrl}/users/me/calendarList`, {});
    return items.map((item) => ({ calendarId: item.id, name: item.summary ?? item.id }));
  }

  async listEvents(accountId: string, calendarId: string, window: TimeWindow): Promise<CalendarEvent[]> {
    const path = `${this.baseUrl}/calendars/${encodeURIComponent(calendarId)}/events`;
    const items = await this.collect<GoogleEvent>(accountId, path, {
      timeMin: window.from.toISOString(),
      timeMax: window.to.toISOString(),
      singleEvents: 'true', // expande recurrencias: cada ocurrencia tiene su propia id e inicio
      showDeleted: 'true', // permite detectar cancelaciones
      orderBy: 'startTime',
      maxResults: '250',
    });
    return items.flatMap((item) => {
      const event = mapGoogleEvent(item, accountId, calendarId);
      return event ? [event] : [];
    });
  }

  private async collect<T extends { id: string }>(accountId: string, url: string, query: Record<string, string>): Promise<T[]> {
    const results: T[] = [];
    let pageToken: string | undefined;
    do {
      const target = new URL(url);
      for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
      if (pageToken) target.searchParams.set('pageToken', pageToken);
      const json = await this.request<{ items?: T[]; nextPageToken?: string }>(accountId, target.toString());
      results.push(...(json.items ?? []));
      pageToken = json.nextPageToken;
    } while (pageToken);
    return results;
  }

  private async request<T>(accountId: string, url: string): Promise<T> {
    const token = await this.getToken(accountId);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    } catch (error) {
      throw new NetworkError(`No se pudo consultar Google Calendar: ${(error as Error).message}`);
    }
    if (response.status === 429) throw new RateLimitError('Google Calendar');
    if (response.status === 401 || response.status === 403) {
      throw new AppError('insufficient_permissions', 'Google Calendar rechazó el acceso.', 'Vuelve a conectar la cuenta y acepta el permiso de calendario.');
    }
    if (!response.ok) throw new AppError('google_calendar', `Google Calendar respondió con HTTP ${response.status}.`, 'Se reintentará en la siguiente sincronización.');
    return (await response.json()) as T;
  }
}

interface GoogleCalendarListItem {
  id: string;
  summary?: string;
}

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  hangoutLink?: string;
  organizer?: { email?: string; displayName?: string };
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
}

/** Exportado para pruebas. Ignora eventos de día completo: no son reuniones con hora de inicio. */
export function mapGoogleEvent(item: GoogleEvent, accountId: string, calendarId: string): CalendarEvent | null {
  if (!item.start?.dateTime || !item.end?.dateTime) return null;
  const videoUris = (item.conferenceData?.entryPoints ?? [])
    .filter((entry) => entry.entryPointType === 'video' && entry.uri)
    .map((entry) => entry.uri as string);
  const candidates = [...videoUris, item.hangoutLink ?? '', item.location ?? '', item.description ?? ''].join(' ');
  const link = pickPrimaryLink(findMeetingLinks(candidates));
  return {
    provider: 'google',
    accountId,
    calendarId,
    externalId: item.id,
    title: item.summary?.trim() || '(sin título)',
    startUtc: new Date(item.start.dateTime).toISOString(),
    endUtc: new Date(item.end.dateTime).toISOString(),
    cancelled: item.status === 'cancelled',
    organizer: item.organizer?.displayName ?? item.organizer?.email ?? null,
    meetingLink: link,
  };
}
