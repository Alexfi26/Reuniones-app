import type { CalendarEvent, Provider, TimeWindow } from '../core/types.js';

export interface CalendarInfo {
  calendarId: string;
  name: string;
}

/** Contrato común para Google Calendar y Microsoft Graph. */
export interface CalendarSource {
  readonly provider: Provider;
  listCalendars(accountId: string): Promise<CalendarInfo[]>;
  listEvents(accountId: string, calendarId: string, window: TimeWindow): Promise<CalendarEvent[]>;
}

export type AccessTokenGetter = (accountId: string) => Promise<string>;
