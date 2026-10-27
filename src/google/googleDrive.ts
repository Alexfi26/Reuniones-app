import { AppError, NetworkError, RateLimitError } from '../core/errors.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';

export interface DriveFolder {
  id: string;
  name: string;
  created: boolean;
}

export interface DriveDocument {
  id: string;
  url: string;
}

export class AmbiguousFolderError extends AppError {
  constructor(readonly candidates: { id: string; name: string }[]) {
    super(
      'ambiguous_folder',
      `Hay ${candidates.length} carpetas llamadas igual en Drive.`,
      'Elige la correcta: ejecuta «reuniones config --drive-folder <ID>» con uno de estos IDs: ' + candidates.map((c) => c.id).join(', '),
    );
  }
}

export class DestinationInaccessibleError extends AppError {
  constructor(message: string) {
    super('destination_inaccessible', message, 'Con el permiso drive.file la app solo ve carpetas que ella creó. Deja que la app cree «reuniones grabadas» o usa Google Picker para elegir una existente.');
  }
}

/**
 * Google Drive API v3 con el scope drive.file: la app solo accede a ficheros que ella crea o que
 * el usuario abre con el selector de Google. No puede listar carpetas creadas a mano por el usuario.
 */
export class GoogleDriveService {
  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = 'https://www.googleapis.com/drive/v3',
  ) {}

  async ensureFolder(options: { folderId: string | null; name: string }): Promise<DriveFolder> {
    if (options.folderId) {
      const folder = await this.getFile(options.folderId);
      if (!folder || folder.mimeType !== FOLDER_MIME || folder.trashed) {
        throw new DestinationInaccessibleError('La carpeta de destino configurada no existe, está en la papelera o no es accesible con los permisos de la app.');
      }
      return { id: folder.id, name: folder.name, created: false };
    }

    const query = `name = '${escapeQuery(options.name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const matches = await this.list(query);
    if (matches.length > 1) throw new AmbiguousFolderError(matches.map((m) => ({ id: m.id, name: m.name })));
    if (matches.length === 1) return { id: matches[0]!.id, name: matches[0]!.name, created: false };

    const created = await this.json<DriveFile>(`${this.baseUrl}/files?fields=id,name`, {
      method: 'POST',
      body: JSON.stringify({ name: options.name, mimeType: FOLDER_MIME }),
    });
    return { id: created.id, name: created.name, created: true };
  }

  /** Busca un documento creado en un intento anterior (idempotencia por clave de trabajo en appProperties). */
  async findDocumentByJobKey(folderId: string, jobKey: string): Promise<DriveDocument | null> {
    const query = `'${escapeQuery(folderId)}' in parents and appProperties has { key='jobKey' and value='${escapeQuery(jobKey)}' } and trashed = false`;
    const [match] = await this.list(query, 'id,name,webViewLink');
    return match ? { id: match.id, url: match.webViewLink ?? documentUrl(match.id) } : null;
  }

  /** Crea un Google Doc nativo dentro de la carpeta indicada. */
  async createDocument(options: { folderId: string; name: string; jobKey: string }): Promise<DriveDocument> {
    const created = await this.json<DriveFile>(`${this.baseUrl}/files?fields=id,name,webViewLink`, {
      method: 'POST',
      body: JSON.stringify({
        name: options.name,
        mimeType: DOC_MIME,
        parents: [options.folderId],
        appProperties: { jobKey: options.jobKey },
      }),
    });
    if (!created.id) throw new AppError('drive_unconfirmed', 'Drive no confirmó la creación del documento.', 'Reintenta el procesamiento; no se guardará el enlace.');
    return { id: created.id, url: created.webViewLink ?? documentUrl(created.id) };
  }

  private async getFile(id: string): Promise<(DriveFile & { mimeType: string; trashed: boolean }) | null> {
    const url = `${this.baseUrl}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,trashed`;
    const response = await this.raw(url, { method: 'GET' });
    if (response.status === 404) return null;
    return this.parse<DriveFile & { mimeType: string; trashed: boolean }>(response);
  }

  private async list(query: string, fields = 'files(id,name,webViewLink)'): Promise<(DriveFile & { webViewLink?: string })[]> {
    const url = new URL(`${this.baseUrl}/files`);
    url.searchParams.set('q', query);
    url.searchParams.set('fields', fields);
    url.searchParams.set('pageSize', '10');
    const json = await this.json<{ files?: DriveFile[] }>(url.toString(), { method: 'GET' });
    return json.files ?? [];
  }

  private async json<T>(url: string, init: RequestInit): Promise<T> {
    return this.parse<T>(await this.raw(url, init));
  }

  private async raw(url: string, init: RequestInit): Promise<Response> {
    const token = await this.getToken();
    const headers = { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    try {
      return await this.fetchImpl(url, { ...init, headers });
    } catch (error) {
      throw new NetworkError(`No se pudo contactar con Google Drive: ${(error as Error).message}`);
    }
  }

  private async parse<T>(response: Response): Promise<T> {
    if (response.status === 429) throw new RateLimitError('Google Drive');
    if (response.status >= 500) throw new NetworkError('Google Drive no está disponible en este momento.');
    if (response.status === 403 || response.status === 401) {
      throw new AppError('insufficient_permissions', 'Google Drive rechazó la operación.', 'Vuelve a conectar Google y acepta el acceso a Drive.');
    }
    if (!response.ok) throw new AppError('drive_failed', `Google Drive respondió con HTTP ${response.status}.`, 'Reintenta más tarde.');
    return (await response.json()) as T;
  }
}

interface DriveFile {
  id: string;
  name: string;
  webViewLink?: string;
  mimeType?: string;
  trashed?: boolean;
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function documentUrl(id: string): string {
  return `https://docs.google.com/document/d/${id}/edit`;
}
