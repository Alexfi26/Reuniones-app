import { AppError, NetworkError, RateLimitError } from '../core/errors.js';

export type DocBlock =
  | { kind: 'title' | 'heading1' | 'heading2' | 'paragraph' | 'bullet'; text: string }
  | { kind: 'table' };

export interface DocTable {
  headers: string[];
  rows: string[][];
}

export interface RenderedDocument {
  blocks: DocBlock[];
  table: DocTable;
}

export const TABLE_PLACEHOLDER = '[[TABLA]]';

interface DocsElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: { elements?: { textRun?: { content?: string } }[] };
  table?: { tableRows: { tableCells: { content: DocsElement[] }[] }[] };
}

interface DocsDocument {
  documentId: string;
  title: string;
  body: { content: DocsElement[] };
}

/**
 * Google Docs API v1. Escribe el contenido en lotes ordenados y verifica la respuesta.
 * Los índices se calculan con longitudes UTF-16, que es la unidad que usa Docs.
 * Pendiente de validación contra la API real (ver docs/PRUEBAS_MANUALES.md).
 */
export class GoogleDocsService {
  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = 'https://docs.googleapis.com/v1',
  ) {}

  /** Reemplaza todo el contenido del documento. Es seguro repetirlo: borra antes de escribir. */
  async writeDocument(documentId: string, content: RenderedDocument): Promise<void> {
    await this.clearBody(documentId);

    const { text, styles } = layout(content.blocks);
    const requests: object[] = [{ insertText: { location: { index: 1 }, text } }];
    for (const style of styles) requests.push(style);
    await this.batch(documentId, requests);

    if (!content.blocks.some((block) => block.kind === 'table')) return;

    const placeholder = await this.findTableAnchor(documentId);
    if (placeholder === null) throw new AppError('docs_layout', 'No se encontró el marcador de la tabla de tareas.', 'Reintenta la creación del documento.');
    const { headers, rows } = content.table;
    await this.batch(documentId, [
      { deleteContentRange: { range: { startIndex: placeholder, endIndex: placeholder + TABLE_PLACEHOLDER.length } } },
      { insertTable: { rows: rows.length + 1, columns: headers.length, location: { index: placeholder } } },
    ]);

    const table = await this.findTable(documentId, placeholder);
    if (!table) throw new AppError('docs_layout', 'No se pudo localizar la tabla de tareas tras crearla.', 'Reintenta la creación del documento.');
    const cellValues: { row: number; col: number; text: string }[] = [
      ...headers.map((text, col) => ({ row: 0, col, text })),
      ...rows.flatMap((cells, r) => cells.map((text, col) => ({ row: r + 1, col, text }))),
    ];
    // Se insertan de atrás hacia delante para que los índices previos no cambien.
    const fills = cellValues
      .filter((cell) => cell.text.length > 0)
      .map((cell) => ({ ...cell, index: table.cellStart(cell.row, cell.col) }))
      .sort((a, b) => b.index - a.index)
      .map((cell) => ({ insertText: { location: { index: cell.index }, text: cell.text } }));
    if (fills.length > 0) await this.batch(documentId, fills);
  }

  /** Comprueba que el documento devuelto por la API contiene el texto esperado. */
  async verifyContains(documentId: string, marker: string): Promise<void> {
    const doc = await this.get(documentId);
    const text = flattenText(doc.body.content);
    if (!text.includes(marker)) {
      throw new AppError('docs_unconfirmed', 'Google Docs no confirmó el contenido escrito.', 'Reintenta el procesamiento; el enlace no se guardará como correcto.');
    }
  }

  private async clearBody(documentId: string): Promise<void> {
    const doc = await this.get(documentId);
    const end = doc.body.content.at(-1)?.endIndex ?? 1;
    if (end - 1 > 1) {
      await this.batch(documentId, [{ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1 } } }]);
    }
  }

  private async findTableAnchor(documentId: string): Promise<number | null> {
    const doc = await this.get(documentId);
    for (const element of doc.body.content) {
      const text = (element.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? '').join('').trim();
      if (text === TABLE_PLACEHOLDER && element.startIndex !== undefined) return element.startIndex;
    }
    return null;
  }

  private async findTable(documentId: string, afterIndex: number): Promise<{ cellStart(row: number, col: number): number } | null> {
    const doc = await this.get(documentId);
    const element = doc.body.content.find((e) => e.table && (e.startIndex ?? 0) >= afterIndex);
    if (!element?.table) return null;
    const rows = element.table.tableRows;
    return {
      cellStart(row: number, col: number): number {
        const cell = rows[row]?.tableCells[col];
        const start = cell?.content[0]?.startIndex;
        if (start === undefined) throw new AppError('docs_layout', 'Celda de tabla inesperada.', 'Reintenta la creación del documento.');
        return start;
      },
    };
  }

  private async get(documentId: string): Promise<DocsDocument> {
    return this.call<DocsDocument>(`${this.baseUrl}/documents/${encodeURIComponent(documentId)}`, { method: 'GET' });
  }

  private async batch(documentId: string, requests: object[]): Promise<void> {
    await this.call(`${this.baseUrl}/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    });
  }

  private async call<T>(url: string, init: RequestInit): Promise<T> {
    const token = await this.getToken();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      });
    } catch (error) {
      throw new NetworkError(`No se pudo contactar con Google Docs: ${(error as Error).message}`);
    }
    if (response.status === 429) throw new RateLimitError('Google Docs');
    if (response.status >= 500) throw new NetworkError('Google Docs no está disponible en este momento.');
    if (!response.ok) throw new AppError('docs_failed', `Google Docs respondió con HTTP ${response.status}.`, 'Reintenta más tarde; el documento se reescribirá.');
    return (await response.json()) as T;
  }
}

/** Convierte bloques en texto plano y peticiones de estilo con índices calculados. */
export function layout(blocks: DocBlock[]): { text: string; styles: object[] } {
  let text = '';
  const styles: object[] = [];
  let index = 1;
  for (const block of blocks) {
    const content = block.kind === 'table' ? TABLE_PLACEHOLDER : block.text;
    const range = { startIndex: index, endIndex: index + content.length + 1 };
    if (block.kind === 'title') styles.push(paragraphStyle(range, 'TITLE'));
    if (block.kind === 'heading1') styles.push(paragraphStyle(range, 'HEADING_1'));
    if (block.kind === 'heading2') styles.push(paragraphStyle(range, 'HEADING_2'));
    if (block.kind === 'bullet') styles.push({ createParagraphBullets: { range, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });
    text += `${content}\n`;
    index += content.length + 1;
  }
  return { text, styles };
}

function paragraphStyle(range: { startIndex: number; endIndex: number }, namedStyleType: string): object {
  return { updateParagraphStyle: { range, paragraphStyle: { namedStyleType }, fields: 'namedStyleType' } };
}

function flattenText(content: DocsElement[]): string {
  return content
    .flatMap((element) => (element.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? ''))
    .join('');
}
