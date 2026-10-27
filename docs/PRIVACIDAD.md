# Política de datos, conservación y eliminación

## Qué se guarda y dónde

| Dato | Dónde | Protección | Cuánto tiempo |
|---|---|---|---|
| Audio de la reunión | `~/Library/Application Support/reuniones-app/audio/` | AES-256-GCM | Según `audioRetention` (por defecto: hasta publicar las notas) |
| Transcripción | SQLite (`jobs`) | AES-256-GCM | Mientras exista la grabación |
| Notas | SQLite (`jobs`) | AES-256-GCM | Mientras exista la grabación |
| Eventos de calendario | SQLite (`events`, `meetings`) | Sin cifrar; sin contenido de audio | Hasta la siguiente sincronización o desconexión |
| Tokens OAuth | Llavero de macOS | Gestionado por macOS | Hasta desconectar la cuenta |
| Clave de cifrado | Llavero de macOS | Gestionado por macOS | Mientras la app esté instalada |
| Registro técnico | SQLite (`audit_log`) | Sin contenido sensible | Indefinido; borrable |
| Documento final | Google Drive, carpeta «reuniones grabadas» | Controlado por Google | Lo decides tú |

Los títulos de reuniones aparecen en la base de datos local de calendario, pero **no** en el
registro técnico.

## Envío a terceros

Por defecto, **nada sale del equipo** salvo las llamadas a las APIs de Google y Microsoft para
leer el calendario y crear el documento.

Enviar audio a OpenAI (transcripción) o texto a Anthropic (notas) exige:

1. Haber elegido el proveedor en configuración.
2. Haber puesto `cloudProcessingAcknowledged` a `true`.
3. Tener una clave de API guardada en el llavero.

Sin estos tres requisitos, el proceso se detiene con un error explicativo.

Antes de activar la nube, revisa los términos del proveedor sobre retención y uso de datos
para entrenamiento. **No se usan las grabaciones para entrenar modelos propios.**

## Conservación

- `delete_after_success` (por defecto): el audio se borra de forma segura cuando el documento
  está publicado y verificado.
- `keep_days`: el audio de grabaciones terminadas se borra al cumplir el plazo (`days`); lo
  aplica el demonio.
- `keep_forever`: no se borra. No recomendado.
- Un audio cuyo procesamiento falló se conserva para reintentar.

## Eliminación

- `reuniones forget <grabación> --yes`: borra audio, transcripción y notas locales. El
  documento de Drive no se toca y se indica su enlace.
- `reuniones disconnect <cuenta> --yes`: borra tokens y el calendario sincronizado de la cuenta.
- Revocar el acceso en el proveedor (ver `docs/GUIA_MICROSOFT.md` y `docs/GUIA_GOOGLE.md`).

## Consentimiento

- La autorización (sí, no, más tarde) es por reunión y no se hereda.
- Antes de iniciar la captura, la app pide confirmar que los participantes han sido informados
  y han dado su consentimiento según la ley aplicable. **La app no puede verificar ese
  consentimiento**: la responsabilidad es del usuario. Si la confirmación no llega, no graba.
- La app no oculta la grabación y no evade indicadores de las plataformas.
