import type { AuditService } from '../audit/auditService.js';
import { AppError } from '../core/errors.js';
import type { LocalStorageService, MeetingRow } from '../storage/localStorageService.js';

/**
 * Estados de autorización de una reunión concreta. La autorización pertenece a esa ocurrencia:
 * si la reunión cambia de hora, la clave cambia y la decisión anterior no se hereda.
 */
export type ConsentStatus = 'pending' | 'snoozed' | 'authorized' | 'declined' | 'no_response' | 'cancelled' | 'superseded';

export type UserChoice = 'record' | 'decline' | 'later';

export function deriveConsentStatus(meeting: MeetingRow, now: Date): ConsentStatus {
  if (meeting.superseded) return 'superseded';
  if (meeting.cancelled) return 'cancelled';
  if (meeting.decision === 'record') return 'authorized';
  if (meeting.decision === 'decline') return 'declined';
  if (now.getTime() >= Date.parse(meeting.end_utc)) return 'no_response';
  if (meeting.snooze_until && Date.parse(meeting.snooze_until) > now.getTime()) return 'snoozed';
  return 'pending';
}

export class ConsentManager {
  constructor(
    private readonly storage: LocalStorageService,
    private readonly audit: AuditService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  status(meetingKey: string): ConsentStatus {
    return deriveConsentStatus(this.requireMeeting(meetingKey), this.clock());
  }

  /**
   * Registra la respuesta del usuario para una reunión.
   * «Sí» solo se acepta si la reunión no ha terminado ni está cancelada o sustituida.
   */
  decide(meetingKey: string, choice: UserChoice, snoozeMinutes = 10): ConsentStatus {
    const now = this.clock();
    const meeting = this.requireMeeting(meetingKey);
    const status = deriveConsentStatus(meeting, now);
    if (status === 'cancelled' || status === 'superseded') {
      throw new AppError('meeting_inactive', 'La reunión fue cancelada o cambió de horario.', 'Revisa el calendario; la decisión debe tomarse sobre el evento actual.');
    }
    if (choice === 'record') {
      if (status === 'no_response') {
        throw new AppError('meeting_ended', 'La reunión ya terminó. No se graba de forma retroactiva.', 'Autoriza grabaciones antes de que empiece la reunión.');
      }
      this.storage.updateMeetingDecision(meetingKey, 'record', now.toISOString(), null);
      this.audit.record('consent.authorized', meetingKey, { scope: 'single_occurrence' });
    } else if (choice === 'decline') {
      this.storage.updateMeetingDecision(meetingKey, 'decline', now.toISOString(), null);
      this.audit.record('consent.declined', meetingKey, {});
    } else {
      const snoozeUntil = new Date(now.getTime() + snoozeMinutes * 60_000).toISOString();
      this.storage.updateMeetingDecision(meetingKey, null, null, snoozeUntil);
      this.storage.markPrompted(meetingKey, null);
      this.audit.record('consent.postponed', meetingKey, { minutes: snoozeMinutes });
    }
    return this.status(meetingKey);
  }

  /** Reuniones que deben mostrar la ventana de autorización ahora. */
  pendingPrompts(leadMinutes: number): MeetingRow[] {
    const now = this.clock();
    const horizon = new Date(now.getTime() + leadMinutes * 60_000).toISOString();
    return this.storage
      .listMeetings({ from: now.toISOString(), to: horizon })
      .filter((meeting) => meeting.prompted_at === null && deriveConsentStatus(meeting, now) === 'pending');
  }

  markPrompted(meetingKey: string): void {
    this.storage.markPrompted(meetingKey, this.clock().toISOString());
  }

  private requireMeeting(meetingKey: string): MeetingRow {
    const meeting = this.storage.getMeeting(meetingKey);
    if (!meeting) throw new AppError('not_found', 'No se encontró la reunión indicada.', 'Sincroniza los calendarios e inténtalo de nuevo.');
    return meeting;
  }
}
