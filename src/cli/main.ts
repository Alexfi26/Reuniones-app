#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { App, formatLocal, loadConfig } from '../app.js';
import { deriveConsentStatus, type UserChoice } from '../consent/consentManager.js';
import { describeStatus } from '../notifications/notificationService.js';
import { AppError } from '../core/errors.js';
import type { Provider } from '../core/types.js';
import type { AppSettings } from '../settings/settingsService.js';
import { KeychainSecretStore } from '../security/secretStore.js';
import type { MeetingRow } from '../storage/localStorageService.js';

const USAGE = `Uso: reuniones <comando>

Cuentas
  connect google|microsoft [--login-hint <correo>]   Conectar una cuenta (OAuth 2.0)
  accounts                                           Listar cuentas conectadas
  disconnect <cuenta> --yes                          Desconectar y borrar tokens locales

Calendario y decisiones
  sync                                               Sincronizar calendarios ahora
  meetings [--days N]                                Próximas reuniones y su estado
  decide <reunión> record|decline|later              Registrar la autorización de una reunión
  prompt                                             Mostrar las ventanas de autorización pendientes

Grabación y procesamiento
  record start <reunión> --consent-confirmed         Iniciar captura (requiere autorización)
  record stop <grabación>                            Detener la captura de inmediato
  recordings                                         Listar grabaciones
  process <grabación>                                Procesar (transcribir, generar notas)
  pending                                            Reintentar grabaciones pendientes de red
  notes show|export|import|approve <grabación> [f]   Revisar y aprobar las notas
  history                                            Documentos creados en Google Docs

Sistema
  daemon [--once]                                    Ejecutar en segundo plano el ciclo automático
  settings show | settings set <clave> <json>        Ver o cambiar preferencias
  secrets set <nombre>                               Guardar un secreto en el llavero (valor por stdin)
  forget <grabación> --yes                           Borrar audio y artefactos de una grabación
  audit [--limit N]                                  Registro técnico (sin contenido sensible)
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return 0;
  }
  const config = loadConfig();
  const app = await App.open(config);
  try {
    return await dispatch(app, command, rest);
  } finally {
    app.close();
  }
}

async function dispatch(app: App, command: string, args: string[]): Promise<number> {
  switch (command) {
    case 'connect': {
      const provider = args[0] as Provider;
      if (provider !== 'google' && provider !== 'microsoft') throw usageError('Indica google o microsoft.');
      const hint = flag(args, '--login-hint');
      const account = await app.connect(provider, {
        loginHint: hint,
        onAuthorizationUrl: (url) => {
          console.log('Abre esta dirección en tu navegador para autorizar la cuenta:\n' + url);
        },
      });
      console.log(`Cuenta conectada: ${account.label} (${account.accountId})`);
      return 0;
    }
    case 'accounts': {
      const accounts = app.storage.listAccounts();
      if (accounts.length === 0) console.log('No hay cuentas conectadas.');
      for (const a of accounts) console.log(`${a.id}\t${a.provider}\t${a.label}\t${a.enabled ? 'activa' : 'desactivada'}`);
      return 0;
    }
    case 'disconnect':
      await app.disconnect(requireArg(args[0], 'cuenta'), args.includes('--yes'));
      console.log('Cuenta desconectada y tokens locales eliminados.');
      console.log('Revoca también el acceso en la cuenta del proveedor si ya no la usarás.');
      return 0;
    case 'sync': {
      const report = await app.sync();
      console.log(`Eventos revisados: ${report.eventsSeen}. Cambios: ${report.changes.length}.`);
      for (const change of report.changes) console.log(`  ${change.kind}: ${change.title}`);
      for (const error of report.errors) console.log(`  Error (${error.code}): ${error.message} ${error.action ?? ''}`);
      return report.errors.length > 0 ? 1 : 0;
    }
    case 'meetings':
      printMeetings(app, Number(flag(args, '--days') ?? 7));
      return 0;
    case 'decide': {
      const meeting = resolveMeeting(app, requireArg(args[0], 'reunión'));
      const choice = requireArg(args[1], 'record|decline|later') as UserChoice;
      if (!['record', 'decline', 'later'].includes(choice)) throw usageError('La decisión debe ser record, decline o later.');
      const status = app.consent.decide(meeting.meeting_key, choice, 10);
      console.log(`${meeting.title}: ${describeStatus(status)}`);
      return 0;
    }
    case 'prompt': {
      const results = await app.promptDueMeetings();
      if (results.length === 0) console.log('No hay reuniones pendientes de autorización en este momento.');
      for (const r of results) console.log(`${r.meetingKey}: ${r.result}`);
      return 0;
    }
    case 'record':
      return recordCommand(app, args);
    case 'recordings':
      for (const r of app.storage.listRecordings()) {
        console.log(`${r.id}\t${r.state}\t${r.started_at ?? ''}\t${r.error_message ?? ''}`);
      }
      return 0;
    case 'process': {
      const outcome = await app.pipeline.run(requireArg(args[0], 'grabación'));
      console.log(JSON.stringify(outcome, null, 2));
      return outcome.status === 'failed' ? 1 : 0;
    }
    case 'pending': {
      for (const message of await app.processPending()) console.log(message);
      return 0;
    }
    case 'notes':
      return notesCommand(app, args);
    case 'history':
      for (const d of app.storage.listDocuments()) console.log(`${d.created_at}\t${d.url}`);
      return 0;
    case 'settings':
      return settingsCommand(app, args);
    case 'secrets': {
      if (args[0] !== 'set') throw usageError('Uso: reuniones secrets set <nombre>  (el valor se lee de stdin)');
      const name = requireArg(args[1], 'nombre');
      const value = readFileSync(0, 'utf8').trim();
      if (!value) throw usageError('No se recibió ningún valor por stdin.');
      await new KeychainSecretStore().set(name, value);
      console.log(`Secreto «${name}» guardado en el llavero.`);
      return 0;
    }
    case 'forget': {
      if (!args.includes('--yes')) throw usageError('Eliminar datos requiere --yes.');
      const result = await app.privacy.deleteRecordingData(requireArg(args[0], 'grabación'), true);
      console.log('Audio y artefactos locales eliminados.');
      if (result.documentUrl) console.log(`El documento de Google Docs NO se ha borrado: ${result.documentUrl}`);
      return 0;
    }
    case 'audit': {
      for (const row of app.audit.recent(Number(flag(args, '--limit') ?? 50))) {
        console.log(`${row.at}\t${row.type}\t${row.meetingKey ?? '-'}\t${row.detail}`);
      }
      return 0;
    }
    case 'daemon':
      return daemon(app, args.includes('--once'));
    default:
      throw usageError(`Comando desconocido: ${command}.`);
  }
}

async function recordCommand(app: App, args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === 'start') {
    const meeting = resolveMeeting(app, requireArg(args[1], 'reunión'));
    const { recording, warnings } = await app.recordings.start(meeting.meeting_key, { consentConfirmed: args.includes('--consent-confirmed') });
    console.log(`Grabación activa: ${recording.id}`);
    for (const w of warnings) console.log(`Aviso: ${w}`);
    return 0;
  }
  if (sub === 'stop') {
    const row = await app.recordings.stop(requireArg(args[1], 'grabación'), 'user');
    console.log(`Grabación detenida. Estado: ${row.state}`);
    return 0;
  }
  throw usageError('Uso: reuniones record start|stop ...');
}

async function notesCommand(app: App, args: string[]): Promise<number> {
  const [sub, recordingId, file] = args;
  const id = requireArg(recordingId, 'grabación');
  if (sub === 'show') {
    const notes = app.pipeline.getNotes(id);
    console.log(notes ? JSON.stringify(notes, null, 2) : 'Todavía no hay notas para esta grabación.');
    return 0;
  }
  if (sub === 'export') {
    const notes = app.pipeline.getNotes(id);
    if (!notes) throw new AppError('notes_missing', 'No hay notas que exportar.', 'Espera a que terminen de generarse.');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(requireArg(file, 'fichero'), JSON.stringify(notes, null, 2), { mode: 0o600 });
    console.log('Notas exportadas. Edítalas y vuelve a importarlas con «reuniones notes import».');
    return 0;
  }
  if (sub === 'import') {
    app.pipeline.importNotes(id, JSON.parse(readFileSync(requireArg(file, 'fichero'), 'utf8')));
    console.log('Notas validadas e importadas. Revísalas y apruébalas con «reuniones notes approve».');
    return 0;
  }
  if (sub === 'approve') {
    const outcome = await app.pipeline.approve(id);
    console.log(JSON.stringify(outcome, null, 2));
    return outcome.status === 'failed' ? 1 : 0;
  }
  throw usageError('Uso: reuniones notes show|export|import|approve <grabación> [fichero]');
}

function settingsCommand(app: App, args: string[]): number {
  if (args[0] === 'show') {
    console.log(JSON.stringify(app.settings.get(), null, 2));
    return 0;
  }
  if (args[0] === 'set') {
    const key = requireArg(args[1], 'clave');
    const value = JSON.parse(requireArg(args[2], 'valor (JSON)')) as unknown;
    const current = app.settings.get() as unknown as Record<string, unknown>;
    if (!(key in current)) throw usageError(`Clave desconocida: ${key}.`);
    app.settings.update({ [key]: value } as Partial<AppSettings>);
    console.log(`${key} actualizado.`);
    return 0;
  }
  throw usageError('Uso: reuniones settings show | settings set <clave> <json>');
}

function printMeetings(app: App, days: number): void {
  const now = new Date();
  const to = new Date(now.getTime() + days * 86_400_000).toISOString();
  const meetings = app.storage.listMeetings({ from: now.toISOString(), to });
  if (meetings.length === 0) {
    console.log('No hay reuniones con enlace de Meet o Teams en el periodo indicado.');
    return;
  }
  let currentDay = '';
  for (const meeting of meetings) {
    const day = new Date(meeting.start_utc).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    if (day !== currentDay) {
      console.log(`\n${day}`);
      currentDay = day;
    }
    const status = describeStatus(deriveConsentStatus(meeting, now));
    const platform = meeting.platform === 'google_meet' ? 'Meet' : 'Teams';
    console.log(`  ${formatLocal(meeting.start_utc)}  [${platform}]  ${meeting.title}  — ${status}  (id ${shortId(meeting.meeting_key)})`);
  }
}

function resolveMeeting(app: App, idOrKey: string): MeetingRow {
  const all = app.storage.listMeetings();
  const match = all.find((m) => m.meeting_key === idOrKey || shortId(m.meeting_key) === idOrKey);
  if (!match) throw new AppError('not_found', 'No se encontró esa reunión.', 'Consulta los identificadores con «reuniones meetings».');
  return match;
}

function shortId(meetingKey: string): string {
  return createHash('sha256').update(meetingKey).digest('hex').slice(0, 8);
}

async function daemon(app: App, once: boolean): Promise<number> {
  const stop = { requested: false };
  process.once('SIGINT', () => (stop.requested = true));
  process.once('SIGTERM', () => (stop.requested = true));
  await app.recordings.recoverInterrupted();
  let lastSync = 0;
  do {
    const settings = app.settings.get();
    const syncDue = Date.now() - lastSync >= settings.syncIntervalMinutes * 60_000;
    try {
      if (syncDue) {
        await app.sync();
        lastSync = Date.now();
      }
      await app.promptDueMeetings();
      await app.startAuthorizedMeetings();
      await app.recordings.tick();
      for (const message of await app.processPending()) console.log(`${new Date().toISOString()} ${message}`);
    } catch (error) {
      console.error(`${new Date().toISOString()} ${error instanceof AppError ? error.message : 'Error inesperado en el ciclo.'}`);
    }
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  } while (!stop.requested);
  return 0;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) throw usageError(`Falta el argumento: ${name}.`);
  return value;
}

function usageError(message: string): AppError {
  return new AppError('usage', message, 'Ejecuta «reuniones help» para ver los comandos.');
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof AppError) {
      console.error(`Error (${error.code}): ${error.message}`);
      if (error.action) console.error(`Qué hacer: ${error.action}`);
    } else {
      console.error('Error inesperado. Revisa el registro técnico con «reuniones audit».');
    }
    process.exit(1);
  });

