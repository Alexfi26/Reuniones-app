export type Provider = 'google' | 'microsoft';
export type Platform = 'google_meet' | 'microsoft_teams';

/** Decisión del usuario para una reunión concreta. Nunca es permanente. */
export type Decision = 'record' | 'decline';

export interface MeetingLink {
  platform: Platform;
  url: string;
  /** Identificador estable del enlace (código de Meet o id de hilo de Teams). */
  canonicalId: string;
}

/** Evento normalizado, independiente del proveedor de calendario. */
export interface CalendarEvent {
  provider: Provider;
  accountId: string;
  calendarId: string;
  externalId: string;
  title: string;
  startUtc: string;
  endUtc: string;
  cancelled: boolean;
  organizer: string | null;
  meetingLink: MeetingLink | null;
}

export interface TimeWindow {
  from: Date;
  to: Date;
}
