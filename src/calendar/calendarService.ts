import { randomUUID } from 'node:crypto';
import type { AppSettings, SettingsService } from '../settings/settingsService.js';
import type { LocalStorageService, MeetingRow } from '../storage/localStorageService.js';
import type { AuditService } from '../audit/auditService.js';
import { AppError } from '../core/errors.js';
import type { CalendarEvent, MeetingLink, Provider } from '../core/types.js';
import type { CalendarSource } from './calendarSource.js';

export type MeetingChangeKind = 'new' | 'rescheduled' | 'cancelled' | 'removed';

export interface MeetingChange {
  kind: MeetingChangeKind;
  meetingKey: string;
  title: string;
}

export interface SyncReport {
  syncedAt: string;
  eventsSeen: number;
  changes: MeetingChange[];
  errors: { accountId: string; code: string; message: string; action?: string }[];
}

export interface CalendarServiceDeps {
  storage: LocalStorageService;
  settings: SettingsService;
  sources: Partial<Record<Provider, CalendarSource>>;
  audit: AuditService;
  clock?: () => Date;
  onChange?: (change: MeetingChange) => void | Promise<void>;
}

/** Clave de reunión: plataforma + identificador del enlace + inicio. Dos calendarios con la misma reunión colapsan en una. */
export function meetingKeyFor(link: MeetingLink, startUtc: string): string {
  return `${link.platform}:${link.canonicalId}@${startUtc}`;
}

export function eventKeyFor(event: Pick<CalendarEvent, 'accountId' | 'calendarId' | 'externalId'>): string {
  return `${event.accountId}/${event.calendarId}/${event.externalId}`;
}

/**
 * Sincroniza eventos de todas las cuentas activas. Cada cuenta y calendario falla de forma aislada:
 * un error de red o de permisos no borra ni altera los datos de los demás.
 */
export class CalendarService {
  private readonly clock: () => Date;

  constructor(private readonly deps: CalendarServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async sync(): Promise<SyncReport> {
    const now = this.clock();
    const settings = this.deps.settings.get();
    const window = {
      // Incluye reuniones que empezaron hace poco, para no perder una grabación en curso.
      from: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      to: new Date(now.getTime() + settings.horizonDays * 24 * 60 * 60 * 1000),
    };
    // Marca única por ejecución: distingue eventos vistos ahora de los retirados aunque el reloj no avance.
    const runStamp = randomUUID();
    const report: SyncReport = { syncedAt: now.toISOString(), eventsSeen: 0, changes: [], errors: [] };

    for (const account of this.deps.storage.listAccounts()) {
      if (!account.enabled) continue;
      const source = this.deps.sources[account.provider];
      if (!source) continue;
      try {
        const calendars = await source.listCalendars(account.id);
        this.deps.storage.replaceCalendars(account.id, calendars.map((c) => ({ calendarId: c.calendarId, name: c.name })));
        for (const calendar of this.deps.storage.listCalendars(account.id)) {
          if (!calendar.enabled) continue;
          const events = await source.listEvents(account.id, calendar.calendar_id, window);
          report.eventsSeen += events.length;
          await this.applyEvents(events, settings, runStamp, report);
          await this.removeUnseen(account.id, calendar.calendar_id, window, runStamp, report);
        }
      } catch (error) {
        report.errors.push(toErrorEntry(account.id, error));
        this.deps.audit.record('calendar.sync_error', null, { accountId: account.id, code: codeOf(error) });
      }
    }
    this.deps.audit.record('calendar.sync', null, { events: report.eventsSeen, changes: report.changes.length, errors: report.errors.length });
    return report;
  }

  private async applyEvents(events: CalendarEvent[], settings: AppSettings, runStamp: string, report: SyncReport): Promise<void> {
    const touched = new Set<string>();
    for (const event of events) {
      const previous = this.deps.storage.getEvent(event.accountId, event.calendarId, event.externalId);
      const excluded = settings.excludedEventKeys.includes(eventKeyFor(event));
      const key = event.meetingLink && !excluded ? meetingKeyFor(event.meetingLink, event.startUtc) : null;

      if (previous?.meeting_key && previous.meeting_key !== key) touched.add(previous.meeting_key);

      // La reunión debe existir antes que el evento que la referencia (clave foránea).
      if (key && event.meetingLink) {
        const existed = this.deps.storage.getMeeting(key) !== null;
        this.ensureMeeting(key, event, event.meetingLink);
        if (!existed && !event.cancelled) {
          await this.emit({ kind: 'new', meetingKey: key, title: event.title }, report);
        }
        touched.add(key);
      }

      this.deps.storage.upsertEvent({
        account_id: event.accountId,
        calendar_id: event.calendarId,
        external_id: event.externalId,
        provider: event.provider,
        title: event.title,
        start_utc: event.startUtc,
        end_utc: event.endUtc,
        cancelled: event.cancelled ? 1 : 0,
        organizer: event.organizer,
        meeting_key: key,
        seen_at: runStamp,
      });
    }
    for (const key of touched) await this.recompute(key, report);
  }

  private async removeUnseen(accountId: string, calendarId: string, window: { from: Date; to: Date }, runStamp: string, report: SyncReport): Promise<void> {
    const from = window.from.toISOString();
    const to = window.to.toISOString();
    const affected = this.deps.storage
      .listEventsBetween(from, to)
      .filter((row) => row.account_id === accountId && row.calendar_id === calendarId && row.seen_at !== runStamp)
      .map((row) => row.meeting_key)
      .filter((key): key is string => key !== null);
    this.deps.storage.deleteEventsNotSeen(accountId, calendarId, from, to, runStamp);
    for (const key of new Set(affected)) await this.recompute(key, report);
  }

  private ensureMeeting(key: string, event: CalendarEvent, link: MeetingLink): void {
    const now = this.clock().toISOString();
    const existing = this.deps.storage.getMeeting(key);
    const row: MeetingRow = {
      meeting_key: key,
      platform: link.platform,
      canonical_id: link.canonicalId,
      join_url: link.url,
      title: event.title,
      start_utc: event.startUtc,
      end_utc: event.endUtc,
      organizer: event.organizer,
      cancelled: 0,
      superseded: 0,
      decision: existing?.decision ?? null,
      decided_at: existing?.decided_at ?? null,
      snooze_until: existing?.snooze_until ?? null,
      prompted_at: existing?.prompted_at ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.deps.storage.upsertMeeting(row);
  }

  /** Recalcula cancelación y sustitución de una reunión a partir de sus eventos actuales. */
  private async recompute(key: string, report: SyncReport): Promise<void> {
    const meeting = this.deps.storage.getMeeting(key);
    if (!meeting) return;
    const events = this.deps.storage.eventsForMeeting(key);
    const active = events.filter((event) => event.cancelled === 0);
    const cancelled = events.length > 0 && active.length === 0;
    const superseded = events.length === 0;
    const now = this.clock().toISOString();

    if (superseded && meeting.superseded === 0) {
      // Si la misma reunión sigue activa con otra hora, es un cambio de horario; si no, fue retirada.
      const successors = this.deps.storage.findActiveMeetingsByLink(meeting.platform, meeting.canonical_id, key);
      const kind: MeetingChangeKind = successors.length > 0 ? 'rescheduled' : 'removed';
      await this.emit({ kind, meetingKey: key, title: meeting.title }, report);
    } else if (!superseded && cancelled && meeting.cancelled === 0) {
      await this.emit({ kind: 'cancelled', meetingKey: key, title: meeting.title }, report);
    }

    this.deps.storage.upsertMeeting({
      ...meeting,
      cancelled: cancelled ? 1 : 0,
      superseded: superseded ? 1 : 0,
      updated_at: now,
    });
  }

  private async emit(change: MeetingChange, report: SyncReport): Promise<void> {
    report.changes.push(change);
    this.deps.audit.record(`meeting.${change.kind}`, change.meetingKey, {});
    await this.deps.onChange?.(change);
  }
}

function codeOf(error: unknown): string {
  return error instanceof AppError ? error.code : 'unexpected';
}

function toErrorEntry(accountId: string, error: unknown): SyncReport['errors'][number] {
  if (error instanceof AppError) {
    return { accountId, code: error.code, message: error.message, action: error.action };
  }
  return { accountId, code: 'unexpected', message: 'Error inesperado durante la sincronización.' };
}
