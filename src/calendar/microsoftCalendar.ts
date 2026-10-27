import { AppError, NetworkError, RateLimitError } from '../core/errors.js';
import { findMeetingLinks, pickPrimaryLink } from '../core/meetingDetector.js';
import type { CalendarEvent, TimeWindow } from '../core/types.js';
import type { FetchLike } from '../auth/oauth.js';
import type { AccessTokenGetter, CalendarInfo, CalendarSource } from './calendarSource.js';

/**
 * Microsoft Graph (v1.0). Permiso delegado: Calendars.Read.
 * calendarView expande las recurrencias y devuelve una entrada por ocurrencia.
 */
export class MicrosoftCalendarSource implements CalendarSource {
  readonly provider = 'microsoft' as const;

  constructor(
    private readonly getToken: AccessTokenGetter,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://graph.microsoft.com/v1.0',
  ) {}

  async listCalendars(accountId: string): Promise<CalendarInfo[]> {
    const url = new URL(`${this.baseUrl}/me/calendars`);
    url.searchParams.set('$select', 'id,name');
    const items = await this.collect<GraphCalendar>(accountId, url.toString());
    return items.map((item) => ({ calendarId: item.id, name: item.name }));
  }

  async listEvents(accountId: string, calendarId: string, window: TimeWindow): Promise<CalendarEvent[]> {
    const url = new URL(`${this.baseUrl}/me/calendars/${encodeURIComponent(calendarId)}/calendarView`);
    url.searchParams.set('startDateTime', window.from.toISOString());
    url.searchParams.set('endDateTime', window.to.toISOString());
    url.searchParams.set('$select', 'id,subject,start,end,isCancelled,organizer,isOnlineMeeting,onlineMeeting,onlineMeetingUrl,location');
    url.searchParams.set('$top', '100');
    const items = await this.collect<GraphEvent>(accountId, url.toString(), { Prefer: 'outlook.timezone="UTC"' });
    return items.flatMap((item) => {
      const event = mapGraphEvent(item, accountId, calendarId);
      return event ? [event] : [];
    });
  }

  private async collect<T>(accountId: string, firstUrl: string, headers: Record<string, string> = {}): Promise<T[]> {
    const results: T[] = [];
    let next: string | undefined = firstUrl;
    while (next) {
      const json: GraphPage<T> = await this.request<GraphPage<T>>(accountId, next, headers);
      results.push(...json.value);
      next = json['@odata.nextLink'];
    }
    return results;
  }

  private async request<T>(accountId: string, url: string, headers: Record<string, string>): Promise<T> {
    const token = await this.getToken(accountId);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { ...headers, authorization: `Bearer ${token}` } });
    } catch (error) {
      throw new NetworkError(`No se pudo consultar Microsoft Graph: ${(error as Error).message}`);
    }
    if (response.status === 429) throw new RateLimitError('Microsoft Graph');
    if (response.status === 401 || response.status === 403) {
      throw new AppError('insufficient_permissions', 'Microsoft Graph rechazó el acceso al calendario.', 'Vuelve a conectar la cuenta de Microsoft y acepta Calendars.Read.');
    }
    if (!response.ok) throw new AppError('microsoft_graph', `Microsoft Graph respondió con HTTP ${response.status}.`, 'Se reintentará en la siguiente sincronización.');
    return (await response.json()) as T;
  }
}

interface GraphPage<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

interface GraphCalendar {
  id: string;
  name: string;
}

interface GraphEvent {
  id: string;
  subject?: string;
  isCancelled?: boolean;
  start?: { dateTime: string; timeZone?: string };
  end?: { dateTime: string; timeZone?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  onlineMeeting?: { joinUrl?: string } | null;
  onlineMeetingUrl?: string | null;
  location?: { displayName?: string };
}

/** Graph devuelve fechas UTC sin desfase cuando se pide outlook.timezone="UTC"; se normalizan a ISO. */
export function graphDateToIso(dateTime: string): string {
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(dateTime);
  const normalized = dateTime.replace(/(\.\d{3})\d+/, '$1');
  return new Date(hasOffset ? normalized : `${normalized}Z`).toISOString();
}

/** Exportado para pruebas. Ignora eventos sin hora de inicio. */
export function mapGraphEvent(item: GraphEvent, accountId: string, calendarId: string): CalendarEvent | null {
  if (!item.start?.dateTime || !item.end?.dateTime) return null;
  const candidates = [item.onlineMeeting?.joinUrl ?? '', item.onlineMeetingUrl ?? '', item.location?.displayName ?? ''].join(' ');
  const link = pickPrimaryLink(findMeetingLinks(candidates));
  return {
    provider: 'microsoft',
    accountId,
    calendarId,
    externalId: item.id,
    title: item.subject?.trim() || '(sin título)',
    startUtc: graphDateToIso(item.start.dateTime),
    endUtc: graphDateToIso(item.end.dateTime),
    cancelled: item.isCancelled === true,
    organizer: item.organizer?.emailAddress?.name ?? item.organizer?.emailAddress?.address ?? null,
    meetingLink: link,
  };
}
