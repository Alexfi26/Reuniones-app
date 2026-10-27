import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuthError, NetworkError } from '../core/errors.js';
import type { Provider } from '../core/types.js';

export interface OAuthProviderConfig {
  provider: Provider;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  /** Google: 127.0.0.1. Microsoft Entra: localhost (plataforma «móvil y escritorio»). */
  redirectHost: '127.0.0.1' | 'localhost';
  extraAuthParams?: Record<string, string>;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Instante de caducidad del access token, en ms desde epoch. */
  expiresAt: number;
  idToken: string | null;
}

export type FetchLike = typeof fetch;

export interface AuthorizeOptions {
  fetchImpl?: FetchLike;
  /** Recibe la URL de autorización (la CLI la abre en el navegador y la muestra). */
  onAuthorizationUrl: (url: string) => void | Promise<void>;
  loginHint?: string;
  timeoutMs?: number;
  clientSecret?: string | null;
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function createPkce(): Pkce {
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Flujo de autorización con código y PKCE. Abre un servidor HTTP efímero solo en loopback,
 * valida el parámetro state y cierra el servidor en cuanto recibe el código o expira.
 */
export async function authorizeWithLoopback(config: OAuthProviderConfig, options: AuthorizeOptions): Promise<TokenSet> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pkce = createPkce();
  const state = randomBytes(16).toString('base64url');
  const { server, redirectUri, codePromise } = await startCallbackServer(config.redirectHost, state, options.timeoutMs ?? 180_000);

  try {
    const authUrl = new URL(config.authorizeUrl);
    const params: Record<string, string> = {
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: config.scopes.join(' '),
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      ...config.extraAuthParams,
    };
    if (options.loginHint) params.login_hint = options.loginHint;
    for (const [key, value] of Object.entries(params)) authUrl.searchParams.set(key, value);

    await options.onAuthorizationUrl(authUrl.toString());
    const code = await codePromise;
    return await exchangeCode(config, fetchImpl, {
      code,
      verifier: pkce.verifier,
      redirectUri,
      clientSecret: options.clientSecret ?? null,
    });
  } finally {
    server.close();
  }
}

/** Obtiene un access token nuevo a partir del refresh token guardado en el llavero. */
export async function refreshAccessToken(
  config: OAuthProviderConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
  clientSecret: string | null = null,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (clientSecret) body.set('client_secret', clientSecret);
  const json = await postToken(config, fetchImpl, body);
  return toTokenSet(json, refreshToken);
}

async function exchangeCode(
  config: OAuthProviderConfig,
  fetchImpl: FetchLike,
  input: { code: string; verifier: string; redirectUri: string; clientSecret: string | null },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
  });
  if (input.clientSecret) body.set('client_secret', input.clientSecret);
  const json = await postToken(config, fetchImpl, body);
  return toTokenSet(json, null);
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

async function postToken(config: OAuthProviderConfig, fetchImpl: FetchLike, body: URLSearchParams): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetchImpl(config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (error) {
    throw new NetworkError(`No se pudo contactar con el servicio de autorización de ${config.provider}: ${(error as Error).message}`);
  }
  const json = (await response.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string };
  if (!response.ok || !json.access_token) {
    if (response.status >= 500) throw new NetworkError(`El servicio de autorización de ${config.provider} no está disponible.`);
    const reason = json.error_description ?? json.error ?? `HTTP ${response.status}`;
    throw new AuthError(`La autorización con ${config.provider} no se completó (${reason}).`);
  }
  return json;
}

function toTokenSet(json: TokenResponse, previousRefreshToken: string | null): TokenSet {
  const expiresInSeconds = json.expires_in ?? 3600;
  return {
    accessToken: json.access_token!,
    refreshToken: json.refresh_token ?? previousRefreshToken,
    // Margen de 60 s para no usar tokens a punto de caducar.
    expiresAt: Date.now() + Math.max(0, expiresInSeconds - 60) * 1000,
    idToken: json.id_token ?? null,
  };
}

interface CallbackServer {
  server: Server;
  redirectUri: string;
  codePromise: Promise<string>;
}

function startCallbackServer(host: '127.0.0.1' | 'localhost', expectedState: string, timeoutMs: number): Promise<CallbackServer> {
  return new Promise((resolveStart, rejectStart) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${host}`);
      if (url.pathname !== '/callback') {
        response.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const ok = !error && code && state === expectedState;
      response.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        ok
          ? '<!doctype html><meta charset="utf-8"><p>Autorización completada. Puedes cerrar esta ventana.</p>'
          : '<!doctype html><meta charset="utf-8"><p>La autorización no se completó. Vuelve a intentarlo desde la aplicación.</p>',
      );
      if (ok) resolveCode(code);
      else rejectCode(new AuthError(`Autorización cancelada o inválida${error ? `: ${error}` : ''}.`));
    });

    const timer = setTimeout(() => rejectCode(new AuthError('La autorización caducó sin respuesta.', 'Vuelve a intentarlo cuando estés listo.')), timeoutMs);
    codePromise.finally(() => clearTimeout(timer)).catch(() => undefined);

    server.once('error', rejectStart);
    server.listen(0, host, () => {
      const { port } = server.address() as AddressInfo;
      resolveStart({ server, redirectUri: `http://${host}:${port}/callback`, codePromise });
    });
  });
}
