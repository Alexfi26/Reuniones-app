# Fase 1 — Análisis técnico

Fecha de verificación: octubre de 2026. Este documento separa lo **verificado** (con fuente
consultada), lo **supuesto** (pendiente de confirmar en la documentación oficial) y lo
**no posible** con las APIs públicas.

## 1. Captura de audio en macOS

| Fuente de audio | Mecanismo | Permiso de macOS | Requisito | Estado |
|---|---|---|---|---|
| Micrófono | AVFoundation / AVAudioEngine | Micrófono (TCC) | macOS 10.14+ | Estándar, consulta de estado oficial disponible |
| Audio del sistema (voces remotas) | **Core Audio process tap** (`AudioHardwareCreateProcessTap`) dentro de un dispositivo agregado | «Grabación de audio del sistema» (TCC, distinto de la grabación de pantalla) | macOS 14.2+ | Verificado en foros de desarrolladores de Apple |
| Audio del sistema, alternativa | ScreenCaptureKit con `capturesAudio` | **Grabación de pantalla** (aunque solo se quiera audio) | macOS 12.3+ | Verificado; más invasivo en permisos |

Hallazgos verificados:

- El tap de Core Audio necesita un dispositivo agregado para entregar buffers. Sin él no hay audio.
- **No existe una API oficial para consultar ni solicitar el estado del permiso de audio del
  sistema**, a diferencia del micrófono. La app debe detectar el fallo al intentar capturar
  (buffers vacíos o error) y comunicarlo al usuario.
- ScreenCaptureKit obliga a pedir permiso de grabación de pantalla. Es menos deseable para
  una herramienta que solo necesita audio.
- Un tap de Core Audio ve el audio de cualquier proceso que suene en la salida. Eso incluye
  audio que no pertenece a la reunión. La app debe documentarlo al usuario.
- **Decisión:** la captura se implementa con un helper nativo en Swift (micrófono por
  AVAudioEngine, audio del sistema por tap de Core Audio). La app Node solo habla con él por
  un protocolo JSON (ver `docs/CAPTURA_AUDIO.md`). El helper **no está incluido en esta
  versión**: requiere compilarse y validarse en un Mac.

No se intenta capturar audio de Meet o Teams desde fuera del proceso del navegador ni de la
aplicación de escritorio, ni eludir protecciones del sistema.

## 2. Google Calendar

- Scopes mínimos elegidos: `calendar.calendarlist.readonly` (listar calendarios) y
  `calendar.events.readonly` (leer eventos). No se piden permisos de escritura.
- Con `singleEvents=true` se expanden las recurrencias; cada ocurrencia tiene identificador e
  inicio propios, lo que permite autorizar cada reunión por separado.
- Con `showDeleted=true` llegan las cancelaciones (`status: cancelled`).
- El enlace de Meet está en `conferenceData.entryPoints` (tipo `video`) o en `hangoutLink`.

## 3. Google Drive y Google Docs

Verificado en la documentación de scopes de Google Docs:

- `drive.file` es el scope recomendado y no sensible. Da acceso solo a los ficheros que la app
  crea o que el usuario abre con el selector de Google.
- El scope `documents` completo es sensible. **No se necesita** si se usa `drive.file` para
  ficheros creados por la app.
- Un documento nativo de Google Docs se crea con Drive `files.create` y el tipo MIME
  `application/vnd.google-apps.document` indicando `parents`. Así se ubica directamente en la
  carpeta. Después se escribe el contenido con la API de Docs `documents.batchUpdate`.

**Limitación importante (requisito 10 del prompt):** con `drive.file`, la app **no puede
listar ni reutilizar** una carpeta llamada «reuniones grabadas» creada a mano por el usuario.
Opciones:

1. (Implementada) La app crea la carpeta y la identifica por ID. Si el usuario ya tiene una
   carpeta con ese nombre, puede indicar su ID en la configuración (`driveFolderId`); la app
   la usará solo si es accesible con `drive.file`, y si no lo es, lo indica sin duplicarla.
2. (Pendiente) Selector de Google (Google Picker) para que el usuario elija la carpeta existente.
3. Scope `drive.readonly` o `drive`: amplía permisos y no se recomienda.

Los nombres duplicados se detectan entre las carpetas visibles para la app; si hay varias, la
app se detiene y pide el ID correcto.

## 4. Google Meet como alternativa oficial

Verificado parcialmente:

- La Meet REST API expone conferencias, participantes, grabaciones y transcripciones
  **después** de que la reunión termina.
- Las grabaciones se guardan en Drive y el acceso requiere el scope `drive.readonly`
  (clasificado como sensible en la página de la API de Meet).
- Según fuentes de terceros, el acceso a grabaciones y transcripciones requiere una edición
  de Google Workspace de pago. **No confirmado en la documentación oficial** durante esta fase.
- **Supuesto no verificado:** el scope exacto `meetings.space.readonly` para leer
  conferencias. Debe confirmarse en la página oficial de scopes antes de implementarlo.

Esta vía es la alternativa de respaldo recomendada cuando la captura local no es viable: la
transcripción oficial de la plataforma, si la organización la tiene activada y autorizada.

## 5. Microsoft Graph

- Eventos: `GET /me/calendars/{id}/calendarView` expande recurrencias. El enlace de Teams está
  en `onlineMeeting.joinUrl`; `onlineMeetingUrl` y la ubicación se revisan como respaldo.
- Fechas: con `Prefer: outlook.timezone="UTC"` las fechas llegan en UTC sin desfase.
- Permiso delegado indicado para leer calendarios: `Calendars.Read`.
  **No confirmado en la documentación oficial de `calendarView` durante esta búsqueda**;
  verificar en Microsoft Learn antes de publicar la aplicación.
- Requisito organizativo: si el usuario no tiene habilitado el proveedor «Teams para empresas»
  en su calendario de Outlook, `onlineMeeting` puede llegar vacío. Es un ajuste del
  administrador, no un permiso de la app.
- **No existe API pública para capturar el audio de una reunión de Teams desde un tercero** en
  escritorio. La vía oficial para audio en tiempo real es un bot que se une a la reunión
  mediante los servicios de comunicaciones de Microsoft (visible para los participantes), y
  no está implementada. La vía oficial para grabaciones es la grabación nativa de Teams, cuyo
  acceso por Graph requiere permisos adicionales de grabación.

## 6. Transcripción y modelos de lenguaje

- **Local:** whisper.cpp (`whisper-cli`) con `-oj` escribe un JSON con `transcription[].offsets`.
  Necesita WAV mono 16 kHz. Verificado en el código fuente del proyecto; **el formato de
  salida debe revalidarse con la versión instalada**.
- **Nube:** API de transcripción de OpenAI, `POST /v1/audio/transcriptions` con
  `response_format=verbose_json` (modelo `whisper-1`). Límite de 25 MB por petición, de modo
  que el audio se trocea en bloques de 10 minutos. **La política de retención y de no
  entrenamiento debe confirmarse en los términos vigentes antes de activarla.**
- **Notas:** Anthropic Messages API (`POST /v1/messages`, cabecera `anthropic-version:
  2023-06-01`). El modelo por defecto es `claude-sonnet-5-5`, configurable.
- **Diarización (identificar hablantes):** ni whisper.cpp básico ni la API de transcripción
  devuelven hablantes. La app no inventa nombres: los segmentos quedan sin hablante. Separar
  micrófono y audio del sistema permitiría distinguir «tú» de «la reunión», pero no
  identificar a cada participante remoto. Queda fuera de la primera versión.

## 7. Restricciones legales y de políticas

- Grabar conversaciones requiere, según jurisdicción, el consentimiento de todas las partes o
  el aviso previo. La app pide al usuario confirmar ese consentimiento antes de cada captura
  (ventana de confirmación), pero **no puede verificarlo por sí misma**.
- Google Meet y Microsoft Teams tienen políticas sobre grabación y pueden mostrar indicadores
  al participar. La app no oculta ni elude esos indicadores.
- Las políticas de la organización pueden prohibir grabar o enviar datos a terceros. Se
  recomienda revisarlas antes de usar la app en un entorno corporativo.
