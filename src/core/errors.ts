/** Error base con un código estable y un mensaje accionable en español. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly action?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NetworkError extends AppError {
  constructor(message: string) {
    super('network', message, 'Revisa la conexión a Internet. La operación se reintentará automáticamente.');
  }
}

export class AuthError extends AppError {
  constructor(message: string, action = 'Vuelve a conectar la cuenta desde Configuración.') {
    super('auth', message, action);
  }
}

export class ConsentRequiredError extends AppError {
  constructor(message: string) {
    super('consent_required', message, 'Confirma el consentimiento de los participantes antes de grabar.');
  }
}

export class PermissionError extends AppError {
  constructor(message: string, action: string) {
    super('permission', message, action);
  }
}

export class RateLimitError extends AppError {
  constructor(provider: string) {
    super('rate_limit', `${provider} ha limitado las peticiones.`, 'Espera unos minutos; el sistema reintentará.');
  }
}
