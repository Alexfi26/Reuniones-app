import { AppError, AuthError, NetworkError, RateLimitError } from '../core/errors.js';

export interface LlmProvider {
  readonly id: string;
  complete(input: { system: string; user: string; maxTokens: number }): Promise<string>;
}

/** Anthropic Messages API (POST /v1/messages). Requiere consentimiento de envío de datos a terceros. */
export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.anthropic.com',
  ) {}

  async complete(input: { system: string; user: string; maxTokens: number }): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: input.maxTokens,
          system: input.system,
          messages: [{ role: 'user', content: input.user }],
        }),
      });
    } catch (error) {
      throw new NetworkError(`No se pudo contactar con el servicio de IA: ${(error as Error).message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError('La clave de API del modelo de lenguaje no es válida o no tiene permisos.', 'Actualiza la clave en Configuración.');
    }
    if (response.status === 429) throw new RateLimitError('El servicio de IA');
    if (response.status >= 500) throw new NetworkError('El servicio de IA no está disponible en este momento.');
    if (!response.ok) throw new AppError('ai_failed', `El servicio de IA devolvió HTTP ${response.status}.`, 'Reintenta más tarde; la transcripción se conserva.');

    const json = (await response.json()) as { content?: { type: string; text?: string }[] };
    const text = (json.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');
    if (!text) throw new AppError('ai_failed', 'El servicio de IA devolvió una respuesta vacía.', 'Reintenta la generación de notas.');
    return text;
  }
}
