import { AuthError } from '../core/errors.js';
import type { Provider } from '../core/types.js';
import type { SecretStore } from '../security/secretStore.js';
import { refreshAccessToken, type FetchLike, type OAuthProviderConfig, type TokenSet } from './oauth.js';

/**
 * Gestiona el access token de una cuenta. El refresh token vive solo en el llavero.
 * Si el proveedor rechaza el refresh token, la cuenta queda marcada para reconexión.
 */
export class TokenManager {
  private cache: { accessToken: string; expiresAt: number } | null = null;

  constructor(
    private readonly accountId: string,
    private readonly provider: Provider,
    private readonly config: OAuthProviderConfig,
    private readonly secrets: SecretStore,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  static refreshSecretName(provider: Provider, accountId: string): string {
    return `${provider}.refresh.${accountId}`;
  }

  async saveRefreshToken(tokens: TokenSet): Promise<void> {
    if (!tokens.refreshToken) {
      throw new AuthError('El proveedor no devolvió un token de larga duración.', 'Vuelve a conectar la cuenta y acepta los permisos solicitados.');
    }
    await this.secrets.set(TokenManager.refreshSecretName(this.provider, this.accountId), tokens.refreshToken);
    this.cache = { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
  }

  async getAccessToken(): Promise<string> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.accessToken;
    const refreshToken = await this.secrets.get(TokenManager.refreshSecretName(this.provider, this.accountId));
    if (!refreshToken) {
      throw new AuthError(`No hay credenciales guardadas para esta cuenta de ${this.provider}.`);
    }
    const clientSecret = await this.secrets.get(`${this.provider}.clientSecret`);
    const fresh = await refreshAccessToken(this.config, refreshToken, this.fetchImpl, clientSecret);
    this.cache = { accessToken: fresh.accessToken, expiresAt: fresh.expiresAt };
    return fresh.accessToken;
  }

  async revoke(): Promise<void> {
    this.cache = null;
    await this.secrets.delete(TokenManager.refreshSecretName(this.provider, this.accountId));
  }
}
