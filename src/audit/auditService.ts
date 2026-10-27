import type { LocalStorageService } from '../storage/localStorageService.js';

type Detail = Record<string, string | number | boolean | null>;

const FORBIDDEN_KEY = /token|secret|password|transcript|audio|title|text|body|content|email|organizer/i;

/**
 * Registro técnico. Solo acepta valores primitivos con claves no sensibles:
 * nunca se registran audio, transcripciones, credenciales ni títulos de reuniones.
 */
export class AuditService {
  constructor(
    private readonly storage: LocalStorageService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  record(type: string, meetingKey: string | null, detail: Detail): void {
    const safe: Detail = {};
    for (const [key, value] of Object.entries(detail)) {
      if (!FORBIDDEN_KEY.test(key)) safe[key] = value;
    }
    this.storage.insertAudit(this.clock().toISOString(), type, meetingKey, JSON.stringify(safe));
  }

  recent(limit = 50): { at: string; type: string; meetingKey: string | null; detail: string }[] {
    return this.storage.listAudit(limit).map((row) => ({
      at: row.at,
      type: row.type,
      meetingKey: row.meeting_key,
      detail: row.detail,
    }));
  }
}
