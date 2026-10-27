import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Decision, Platform, Provider } from '../core/types.js';

/** Migraciones secuenciales; PRAGMA user_version indica cuántas se han aplicado. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
    label TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE calendars (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    calendar_id TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (account_id, calendar_id)
  );

  CREATE TABLE meetings (
    meeting_key TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    canonical_id TEXT NOT NULL,
    join_url TEXT NOT NULL,
    title TEXT NOT NULL,
    start_utc TEXT NOT NULL,
    end_utc TEXT NOT NULL,
    organizer TEXT,
    cancelled INTEGER NOT NULL DEFAULT 0,
    superseded INTEGER NOT NULL DEFAULT 0,
    decision TEXT CHECK (decision IN ('record', 'decline')),
    decided_at TEXT,
    snooze_until TEXT,
    prompted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE events (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    calendar_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    title TEXT NOT NULL,
    start_utc TEXT NOT NULL,
    end_utc TEXT NOT NULL,
    cancelled INTEGER NOT NULL DEFAULT 0,
    organizer TEXT,
    meeting_key TEXT REFERENCES meetings(meeting_key),
    seen_at TEXT NOT NULL,
    PRIMARY KEY (account_id, calendar_id, external_id)
  );
  CREATE INDEX events_start ON events(start_utc);

  CREATE TABLE recordings (
    id TEXT PRIMARY KEY,
    meeting_key TEXT NOT NULL REFERENCES meetings(meeting_key),
    state TEXT NOT NULL,
    consent_confirmed_at TEXT,
    started_at TEXT,
    stopped_at TEXT,
    audio_path TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX recordings_meeting ON recordings(meeting_key);

  CREATE TABLE jobs (
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    step TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    artifact BLOB,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (recording_id, step)
  );

  CREATE TABLE documents (
    recording_id TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
    folder_id TEXT NOT NULL,
    drive_file_id TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    meeting_key TEXT,
    detail TEXT NOT NULL
  );
  `,
];

export interface MeetingRow {
  meeting_key: string;
  platform: Platform;
  canonical_id: string;
  join_url: string;
  title: string;
  start_utc: string;
  end_utc: string;
  organizer: string | null;
  cancelled: number;
  superseded: number;
  decision: Decision | null;
  decided_at: string | null;
  snooze_until: string | null;
  prompted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  account_id: string;
  calendar_id: string;
  external_id: string;
  provider: Provider;
  title: string;
  start_utc: string;
  end_utc: string;
  cancelled: number;
  organizer: string | null;
  meeting_key: string | null;
  seen_at: string;
}

export interface AccountRow {
  id: string;
  provider: Provider;
  label: string;
  enabled: number;
  created_at: string;
}

export interface RecordingRow {
  id: string;
  meeting_key: string;
  state: string;
  consent_confirmed_at: string | null;
  started_at: string | null;
  stopped_at: string | null;
  audio_path: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobRow {
  recording_id: string;
  step: string;
  status: string;
  attempts: number;
  last_error: string | null;
  artifact: Uint8Array | null;
  updated_at: string;
}

export interface DocumentRow {
  recording_id: string;
  folder_id: string;
  drive_file_id: string;
  url: string;
  created_at: string;
}

/**
 * Única puerta a SQLite. Expone operaciones tipadas; ningún otro módulo escribe SQL.
 * Los artefactos sensibles (transcripciones, notas) se guardan cifrados por quien los produce.
 */
export class LocalStorageService {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      if (existsSync(path)) chmodSync(path, 0o600);
    }
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ---- settings -------------------------------------------------------------

  getSetting<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  // ---- accounts and calendars ----------------------------------------------

  upsertAccount(row: AccountRow): void {
    this.db
      .prepare(
        `INSERT INTO accounts (id, provider, label, enabled, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, enabled = excluded.enabled`,
      )
      .run(row.id, row.provider, row.label, row.enabled, row.created_at);
  }

  listAccounts(): AccountRow[] {
    return this.db.prepare('SELECT * FROM accounts ORDER BY created_at').all() as unknown as AccountRow[];
  }

  getAccount(id: string): AccountRow | null {
    return (this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as unknown as AccountRow) ?? null;
  }

  deleteAccount(id: string): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  }

  replaceCalendars(accountId: string, calendars: { calendarId: string; name: string }[]): void {
    this.transaction(() => {
      const existing = this.db
        .prepare('SELECT calendar_id, enabled FROM calendars WHERE account_id = ?')
        .all(accountId) as { calendar_id: string; enabled: number }[];
      const enabledById = new Map(existing.map((row) => [row.calendar_id, row.enabled]));
      this.db.prepare('DELETE FROM calendars WHERE account_id = ?').run(accountId);
      const insert = this.db.prepare('INSERT INTO calendars (account_id, calendar_id, name, enabled) VALUES (?, ?, ?, ?)');
      for (const calendar of calendars) {
        insert.run(accountId, calendar.calendarId, calendar.name, enabledById.get(calendar.calendarId) ?? 1);
      }
    });
  }

  listCalendars(accountId: string): { calendar_id: string; name: string; enabled: number }[] {
    return this.db
      .prepare('SELECT calendar_id, name, enabled FROM calendars WHERE account_id = ? ORDER BY name')
      .all(accountId) as { calendar_id: string; name: string; enabled: number }[];
  }

  // ---- events and meetings --------------------------------------------------

  getEvent(accountId: string, calendarId: string, externalId: string): EventRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM events WHERE account_id = ? AND calendar_id = ? AND external_id = ?')
        .get(accountId, calendarId, externalId) as unknown as EventRow | undefined) ?? null
    );
  }

  upsertEvent(row: EventRow): void {
    this.db
      .prepare(
        `INSERT INTO events (account_id, calendar_id, external_id, provider, title, start_utc, end_utc,
                             cancelled, organizer, meeting_key, seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, calendar_id, external_id) DO UPDATE SET
           title = excluded.title, start_utc = excluded.start_utc, end_utc = excluded.end_utc,
           cancelled = excluded.cancelled, organizer = excluded.organizer,
           meeting_key = excluded.meeting_key, seen_at = excluded.seen_at`,
      )
      .run(
        row.account_id,
        row.calendar_id,
        row.external_id,
        row.provider,
        row.title,
        row.start_utc,
        row.end_utc,
        row.cancelled,
        row.organizer,
        row.meeting_key,
        row.seen_at,
      );
  }

  /** Elimina eventos de una cuenta/calendario dentro de una ventana que ya no aparecen en el proveedor. */
  deleteEventsNotSeen(accountId: string, calendarId: string, from: string, to: string, seenAt: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM events WHERE account_id = ? AND calendar_id = ?
         AND start_utc >= ? AND start_utc < ? AND seen_at <> ?`,
      )
      .run(accountId, calendarId, from, to, seenAt);
    return Number(result.changes);
  }

  listEventsBetween(from: string, to: string): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE end_utc > ? AND start_utc < ? ORDER BY start_utc')
      .all(from, to) as unknown as EventRow[];
  }

  eventsForMeeting(meetingKey: string): EventRow[] {
    return this.db.prepare('SELECT * FROM events WHERE meeting_key = ?').all(meetingKey) as unknown as EventRow[];
  }

  upsertMeeting(row: MeetingRow): void {
    this.db
      .prepare(
        `INSERT INTO meetings (meeting_key, platform, canonical_id, join_url, title, start_utc, end_utc, organizer,
                               cancelled, superseded, decision, decided_at, snooze_until, prompted_at,
                               created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(meeting_key) DO UPDATE SET
           title = excluded.title, join_url = excluded.join_url, end_utc = excluded.end_utc,
           organizer = excluded.organizer, cancelled = excluded.cancelled, superseded = excluded.superseded,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.meeting_key,
        row.platform,
        row.canonical_id,
        row.join_url,
        row.title,
        row.start_utc,
        row.end_utc,
        row.organizer,
        row.cancelled,
        row.superseded,
        row.decision,
        row.decided_at,
        row.snooze_until,
        row.prompted_at,
        row.created_at,
        row.updated_at,
      );
  }

  getMeeting(meetingKey: string): MeetingRow | null {
    return (
      (this.db.prepare('SELECT * FROM meetings WHERE meeting_key = ?').get(meetingKey) as unknown as MeetingRow | undefined) ??
      null
    );
  }

  listMeetings(filter: { from?: string; to?: string } = {}): MeetingRow[] {
    return this.db
      .prepare('SELECT * FROM meetings WHERE (? IS NULL OR end_utc > ?) AND (? IS NULL OR start_utc < ?) ORDER BY start_utc')
      .all(filter.from ?? null, filter.from ?? null, filter.to ?? null, filter.to ?? null) as unknown as MeetingRow[];
  }

  updateMeetingDecision(meetingKey: string, decision: Decision | null, decidedAt: string | null, snoozeUntil: string | null): void {
    this.db
      .prepare('UPDATE meetings SET decision = ?, decided_at = ?, snooze_until = ?, updated_at = ? WHERE meeting_key = ?')
      .run(decision, decidedAt, snoozeUntil, decidedAt ?? new Date().toISOString(), meetingKey);
  }

  findActiveMeetingsByLink(platform: string, canonicalId: string, excludeKey: string): MeetingRow[] {
    return this.db
      .prepare(
        `SELECT * FROM meetings WHERE platform = ? AND canonical_id = ? AND meeting_key <> ?
         AND superseded = 0 AND cancelled = 0`,
      )
      .all(platform, canonicalId, excludeKey) as unknown as MeetingRow[];
  }

  markPrompted(meetingKey: string, at: string | null): void {
    this.db.prepare('UPDATE meetings SET prompted_at = ? WHERE meeting_key = ?').run(at, meetingKey);
  }

  // ---- recordings, jobs and documents ---------------------------------------

  insertRecording(row: RecordingRow): void {
    this.db
      .prepare(
        `INSERT INTO recordings (id, meeting_key, state, consent_confirmed_at, started_at, stopped_at, audio_path,
                                 error_code, error_message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.meeting_key,
        row.state,
        row.consent_confirmed_at,
        row.started_at,
        row.stopped_at,
        row.audio_path,
        row.error_code,
        row.error_message,
        row.created_at,
        row.updated_at,
      );
  }

  updateRecording(row: RecordingRow): void {
    this.db
      .prepare(
        `UPDATE recordings SET state = ?, consent_confirmed_at = ?, started_at = ?, stopped_at = ?, audio_path = ?,
                               error_code = ?, error_message = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        row.state,
        row.consent_confirmed_at,
        row.started_at,
        row.stopped_at,
        row.audio_path,
        row.error_code,
        row.error_message,
        row.updated_at,
        row.id,
      );
  }

  getRecording(id: string): RecordingRow | null {
    return (this.db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as unknown as RecordingRow | undefined) ?? null;
  }

  listRecordings(states?: string[]): RecordingRow[] {
    if (!states || states.length === 0) {
      return this.db.prepare('SELECT * FROM recordings ORDER BY created_at DESC').all() as unknown as RecordingRow[];
    }
    const placeholders = states.map(() => '?').join(', ');
    return this.db
      .prepare(`SELECT * FROM recordings WHERE state IN (${placeholders}) ORDER BY created_at DESC`)
      .all(...states) as unknown as RecordingRow[];
  }

  getJob(recordingId: string, step: string): JobRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM jobs WHERE recording_id = ? AND step = ?')
        .get(recordingId, step) as unknown as JobRow | undefined) ?? null
    );
  }

  listJobs(recordingId: string): JobRow[] {
    return this.db.prepare('SELECT * FROM jobs WHERE recording_id = ?').all(recordingId) as unknown as JobRow[];
  }

  saveJob(row: JobRow): void {
    this.db
      .prepare(
        `INSERT INTO jobs (recording_id, step, status, attempts, last_error, artifact, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(recording_id, step) DO UPDATE SET
           status = excluded.status, attempts = excluded.attempts, last_error = excluded.last_error,
           artifact = excluded.artifact, updated_at = excluded.updated_at`,
      )
      .run(row.recording_id, row.step, row.status, row.attempts, row.last_error, row.artifact, row.updated_at);
  }

  deleteRecording(id: string): void {
    this.db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
  }

  getDocument(recordingId: string): DocumentRow | null {
    return (
      (this.db.prepare('SELECT * FROM documents WHERE recording_id = ?').get(recordingId) as unknown as DocumentRow | undefined) ??
      null
    );
  }

  listDocuments(): DocumentRow[] {
    return this.db.prepare('SELECT * FROM documents ORDER BY created_at DESC').all() as unknown as DocumentRow[];
  }

  saveDocument(row: DocumentRow): void {
    this.db
      .prepare(
        `INSERT INTO documents (recording_id, folder_id, drive_file_id, url, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(recording_id) DO NOTHING`,
      )
      .run(row.recording_id, row.folder_id, row.drive_file_id, row.url, row.created_at);
  }

  // ---- audit ----------------------------------------------------------------

  insertAudit(at: string, type: string, meetingKey: string | null, detail: string): void {
    this.db
      .prepare('INSERT INTO audit_log (at, type, meeting_key, detail) VALUES (?, ?, ?, ?)')
      .run(at, type, meetingKey, detail);
  }

  listAudit(limit: number): { at: string; type: string; meeting_key: string | null; detail: string }[] {
    return this.db
      .prepare('SELECT at, type, meeting_key, detail FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(limit) as { at: string; type: string; meeting_key: string | null; detail: string }[];
  }

  // ---- migrations -----------------------------------------------------------

  private migrate(): void {
    const { user_version: current } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version]!);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }
}
