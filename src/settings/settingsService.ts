import type { LocalStorageService } from '../storage/localStorageService.js';
import { AppError } from '../core/errors.js';

export interface AppSettings {
  /** Cada cuántos minutos sincronizar calendarios en modo daemon. */
  syncIntervalMinutes: number;
  /** Ventana de consulta hacia el futuro, en días. */
  horizonDays: number;
  /** Con cuánta anticipación aparece la solicitud de autorización. */
  leadMinutes: number;
  /** Segundos que esperamos la respuesta a la ventana de autorización. */
  promptTimeoutSeconds: number;
  /** Idioma principal de las notas. */
  language: string;
  transcription: {
    provider: 'whisper_cpp' | 'openai';
    /** Ruta al binario de whisper.cpp y al modelo (solo modo local). */
    whisperBinaryPath: string | null;
    whisperModelPath: string | null;
  };
  /**
   * Debe ser true para enviar audio o transcripciones a un proveedor externo.
   * Lo activa el usuario tras leer la política de datos mostrada por la app.
   */
  cloudProcessingAcknowledged: boolean;
  llm: {
    provider: 'anthropic';
    model: string;
  };
  audioRetention: {
    mode: 'delete_after_success' | 'keep_days' | 'keep_forever';
    days: number;
  };
  includeTranscriptInDoc: boolean;
  /** Carpeta de Drive. Si es null, se busca o crea «reuniones grabadas». */
  driveFolderId: string | null;
  driveFolderName: string;
  /** Exportar audio a Drive. No implementado: se rechaza si se activa. */
  exportAudioToDrive: boolean;
  excludedEventKeys: string[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  syncIntervalMinutes: 5,
  horizonDays: 7,
  leadMinutes: 10,
  promptTimeoutSeconds: 90,
  language: 'es',
  transcription: { provider: 'whisper_cpp', whisperBinaryPath: null, whisperModelPath: null },
  cloudProcessingAcknowledged: false,
  llm: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  audioRetention: { mode: 'delete_after_success', days: 0 },
  includeTranscriptInDoc: true,
  driveFolderId: null,
  driveFolderName: 'reuniones grabadas',
  exportAudioToDrive: false,
  excludedEventKeys: [],
};

const SETTINGS_KEY = 'app_settings';

/** Gestiona preferencias persistidas en SQLite, validadas al leer y al escribir. */
export class SettingsService {
  constructor(private readonly storage: LocalStorageService) {}

  get(): AppSettings {
    const stored = this.storage.getSetting<Partial<AppSettings>>(SETTINGS_KEY) ?? {};
    return mergeSettings(DEFAULT_SETTINGS, stored);
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const next = validateSettings(mergeSettings(this.get(), patch));
    this.storage.setSetting(SETTINGS_KEY, next);
    return next;
  }
}

export function validateSettings(settings: AppSettings): AppSettings {
  const problems: string[] = [];
  if (!inRange(settings.syncIntervalMinutes, 1, 180)) problems.push('syncIntervalMinutes debe estar entre 1 y 180');
  if (!inRange(settings.horizonDays, 1, 30)) problems.push('horizonDays debe estar entre 1 y 30');
  if (!inRange(settings.leadMinutes, 0, 240)) problems.push('leadMinutes debe estar entre 0 y 240');
  if (!inRange(settings.promptTimeoutSeconds, 10, 600)) problems.push('promptTimeoutSeconds debe estar entre 10 y 600');
  if (settings.audioRetention.mode === 'keep_days' && !inRange(settings.audioRetention.days, 1, 365)) {
    problems.push('audioRetention.days debe estar entre 1 y 365 cuando el modo es keep_days');
  }
  if (settings.exportAudioToDrive) {
    problems.push('exportAudioToDrive todavía no está disponible en esta versión');
  }
  if (problems.length > 0) {
    throw new AppError('invalid_settings', `Configuración no válida: ${problems.join('; ')}.`, 'Corrige el valor indicado.');
  }
  return settings;
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    ...base,
    ...patch,
    transcription: { ...base.transcription, ...patch.transcription },
    llm: { ...base.llm, ...patch.llm },
    audioRetention: { ...base.audioRetention, ...patch.audioRetention },
  };
}
