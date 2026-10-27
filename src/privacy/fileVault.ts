import { existsSync } from 'node:fs';
import { open, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { decrypt, encrypt } from '../security/crypto.js';

/**
 * Almacén de audio cifrado (AES-256-GCM). Cada fichero sellado es iv|tag|cuerpo.
 * El borrado sobrescribe el contenido antes de desvincularlo. En SSD con cifrado de hardware
 * esto no garantiza destrucción física; la política de privacidad lo indica.
 */
export class FileVault {
  constructor(private readonly key: Buffer) {}

  /** Cifra plainPath en encryptedPath y elimina el original de forma segura. */
  async seal(plainPath: string, encryptedPath: string): Promise<void> {
    const plaintext = await readFile(plainPath);
    await writeFile(encryptedPath, encrypt(this.key, plaintext), { mode: 0o600 });
    await secureDelete(plainPath);
  }

  /** Devuelve el contenido descifrado en memoria. Úsalo solo para procesar y descartar de inmediato. */
  async open(encryptedPath: string): Promise<Buffer> {
    return decrypt(this.key, await readFile(encryptedPath));
  }

  /** Cifra artefactos pequeños (transcripciones, notas) para guardarlos en SQLite. */
  sealJson(value: unknown): Buffer {
    return encrypt(this.key, Buffer.from(JSON.stringify(value), 'utf8'));
  }

  openJson<T>(payload: Uint8Array): T {
    return JSON.parse(decrypt(this.key, Buffer.from(payload)).toString('utf8')) as T;
  }
}

/** Sobrescribe con ceros y elimina el fichero. No hace nada si no existe. */
export async function secureDelete(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const { size } = await stat(path);
  const handle = await open(path, 'r+');
  try {
    const zeros = Buffer.alloc(Math.min(Math.max(size, 1), 1024 * 1024));
    for (let offset = 0; offset < size; offset += zeros.length) {
      await handle.write(zeros, 0, Math.min(zeros.length, size - offset), offset);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await truncate(path, 0);
  await rm(path, { force: true });
}
