import { spawn } from 'node:child_process';
import type { ConsentStatus, UserChoice } from '../consent/consentManager.js';
import type { Platform } from '../core/types.js';

export interface MeetingPromptInfo {
  title: string;
  platform: Platform;
  startLocal: string;
  durationMinutes: number;
  organizer: string | null;
  timeoutSeconds: number;
}

export type PromptResult = UserChoice | 'no_response';

export interface NotificationService {
  notify(title: string, body: string): Promise<void>;
  askDecision(info: MeetingPromptInfo): Promise<PromptResult>;
  /** Segunda confirmación justo antes de capturar: los participantes han sido informados. */
  confirmConsent(info: MeetingPromptInfo): Promise<boolean>;
}

const PLATFORM_LABEL: Record<Platform, string> = { google_meet: 'Google Meet', microsoft_teams: 'Microsoft Teams' };

/**
 * Ventana nativa de macOS mediante osascript (display dialog / display notification).
 * Si el usuario no responde antes del tiempo límite, el resultado es no_response y NO se graba.
 */
export class MacNotificationService implements NotificationService {
  constructor(private readonly runner: (script: string) => Promise<string> = runOsascript) {}

  async notify(title: string, body: string): Promise<void> {
    await this.runner(`display notification ${appleString(body)} with title ${appleString(title)}`);
  }

  async confirmConsent(info: MeetingPromptInfo): Promise<boolean> {
    const message = [
      `Vas a grabar «${info.title}».`,
      '',
      'Confirmo que los participantes han sido informados de la grabación y han dado su consentimiento según la ley aplicable y las normas de tu organización.',
    ].join('\n');
    const script = [
      `display dialog ${appleString(message)}`,
      'with title "Consentimiento de los participantes"',
      'buttons {"Cancelar", "Confirmar e iniciar"}',
      'default button "Cancelar"',
      `giving up after ${info.timeoutSeconds}`,
    ].join(' ');
    try {
      const output = await this.runner(script);
      return /button returned:Confirmar e iniciar/.test(output) && !/gave up:true/.test(output);
    } catch {
      return false;
    }
  }

  async askDecision(info: MeetingPromptInfo): Promise<PromptResult> {
    const message = [
      'Nueva reunión detectada',
      `Nombre: ${info.title}`,
      `Plataforma: ${PLATFORM_LABEL[info.platform]}`,
      `Inicio: ${info.startLocal}`,
      `Duración estimada: ${info.durationMinutes} min`,
      `Organizador: ${info.organizer ?? 'No disponible'}`,
      '',
      '¿Deseas grabar esta reunión y generar notas automáticamente?',
    ].join('\n');
    const script = buildDecisionScript(message, info.timeoutSeconds);
    try {
      const output = await this.runner(script);
      return parseDecisionOutput(output);
    } catch (error) {
      // Cancelar con Escape devuelve error -128: lo tratamos como «No grabar».
      if (/-128|User canceled/i.test(String(error))) return 'decline';
      return 'no_response';
    }
  }
}

/** Sin ventana nativa (Linux, pruebas): no se toma ninguna decisión automáticamente. */
export class UnavailableNotificationService implements NotificationService {
  async notify(): Promise<void> {
    return;
  }

  async askDecision(): Promise<PromptResult> {
    return 'no_response';
  }

  async confirmConsent(): Promise<boolean> {
    return false;
  }
}

export function buildDecisionScript(message: string, timeoutSeconds: number): string {
  const buttons = '{"No grabar", "Recordar más tarde", "Sí, grabar"}';
  return [
    `display dialog ${appleString(message)}`,
    'with title "Autorización de grabación"',
    `buttons ${buttons}`,
    'default button "No grabar"',
    `giving up after ${timeoutSeconds}`,
  ].join(' ');
}

const BUTTON_TO_CHOICE: Record<string, UserChoice> = {
  'Sí, grabar': 'record',
  'No grabar': 'decline',
  'Recordar más tarde': 'later',
};

/** La salida de osascript separa campos con comas, y una etiqueta puede contenerlas: se buscan las conocidas. */
export function parseDecisionOutput(output: string): PromptResult {
  if (/gave up:true/.test(output)) return 'no_response';
  for (const [label, choice] of Object.entries(BUTTON_TO_CHOICE)) {
    if (output.includes(`button returned:${label}`)) return choice;
  }
  return 'no_response';
}

export function describeStatus(status: ConsentStatus): string {
  const labels: Record<ConsentStatus, string> = {
    pending: 'Pendiente de decisión',
    snoozed: 'Pospuesta',
    authorized: 'Autorizada',
    declined: 'No grabar',
    no_response: 'Sin respuesta (no se grabará)',
    cancelled: 'Cancelada',
    superseded: 'Cambió de horario',
  };
  return labels[status];
}

function appleString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function runOsascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-e', script]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${code}: ${stderr}`))));
  });
}
