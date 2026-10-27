import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { AppError } from '../core/errors.js';

/** Almacén de credenciales. Nunca se escriben secretos en SQLite, logs ni ficheros de configuración. */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

const SERVICE = 'es.reuniones-app';

/**
 * Llavero de macOS mediante la herramienta oficial `security`.
 * El valor viaja por stdin del modo interactivo de `security`, no como argumento de proceso.
 * Pendiente de validación en un Mac real (ver docs/PRUEBAS_MANUALES.md).
 */
export class KeychainSecretStore implements SecretStore {
  constructor(private readonly service = SERVICE, private readonly binary = '/usr/bin/security') {}

  async get(name: string): Promise<string | null> {
    const result = await run(this.binary, ['find-generic-password', '-s', this.service, '-a', name, '-w']);
    if (result.code === 44) return null; // errSecItemNotFound
    if (result.code !== 0) throw keychainError('leer', result.stderr);
    return result.stdout.replace(/\n$/, '');
  }

  async set(name: string, value: string): Promise<void> {
    const command = `add-generic-password -U -s ${quote(this.service)} -a ${quote(name)} -w ${quote(value)}\n`;
    const result = await run(this.binary, ['-i'], command);
    if (result.code !== 0) throw keychainError('guardar', result.stderr);
  }

  async delete(name: string): Promise<void> {
    const result = await run(this.binary, ['delete-generic-password', '-s', this.service, '-a', name]);
    if (result.code !== 0 && result.code !== 44) throw keychainError('borrar', result.stderr);
  }
}

/** Implementación en memoria para pruebas. No persiste nada. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async set(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }

  async delete(name: string): Promise<void> {
    this.values.delete(name);
  }
}

/** Clave de cifrado local: se genera una vez y vive solo en el llavero. */
export async function getOrCreateStorageKey(store: SecretStore): Promise<Buffer> {
  const existing = await store.get('storage.aes256.key');
  if (existing) return Buffer.from(existing, 'base64');
  const key = randomBytes(32);
  await store.set('storage.aes256.key', key.toString('base64'));
  return key;
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function keychainError(action: string, stderr: string): AppError {
  return new AppError(
    'keychain',
    `No se pudo ${action} en el llavero de macOS.`,
    `Revisa el acceso del llavero para esta app. Detalle: ${stderr.trim().slice(0, 200)}`,
  );
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => reject(new AppError('keychain', `No se encontró la herramienta del llavero: ${error.message}`, 'Esta función requiere macOS.')));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}
