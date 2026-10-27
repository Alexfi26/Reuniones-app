# Limitaciones reales y compatibilidad

## Estado de esta versión

| Área | Estado |
|---|---|
| Lógica de calendarios, deduplicación, cambios y cancelaciones | Implementada y probada con APIs simuladas |
| Autorización por reunión, consentimiento y reglas de no grabar | Implementada y probada |
| Captura de audio | Protocolo y gestión de permisos implementados; **helper nativo Swift no incluido** |
| Transcripción local y en la nube | Implementada; probada con binario y API simulados |
| Notas con modelo de lenguaje | Implementadas y validadas; probadas con respuesta simulada |
| Google Drive y Docs | Implementadas; **no probadas contra la API real** |
| Interfaz gráfica (Tauri + React) | **No implementada**. Se usa CLI y diálogos nativos de macOS |
| Empaquetado `.app` / `.dmg` firmado | **No implementado** (ver `docs/DISTRIBUCION.md`) |
| Inicio automático con macOS | Manual con LaunchAgent; sin gestión en la app |

## Captura de audio

- El audio del sistema requiere macOS 14.2+ y el permiso de grabación de audio del sistema. No
  hay API oficial para consultar su estado; la app lo infiere por los datos recibidos.
- El tap de Core Audio capta **todo** el audio que sale por la salida, no solo la reunión.
- Si la reunión devuelve tu propia voz, puede duplicarse. Usa auriculares y valida el caso 6.
- Sin el helper, la app no graba y lo indica.
- Un cambio de dispositivo de audio durante la reunión puede interrumpir la captura. El helper
  debe reportarlo como `problem`; la app lo registra y notifica.

## Google

- **Carpeta de Drive:** con `drive.file` no se puede listar una carpeta creada por el usuario.
  Hay que crearla con la app o indicar su ID y ser accesible. Ver `docs/GUIA_GOOGLE.md`.
- **Meet API:** no se usa en esta versión. Es una alternativa oficial si la organización tiene
  grabación o transcripción de Meet activadas y los permisos adecuados (ver
  `docs/ANALISIS_TECNICO.md`, sección 4).
- Los tokens de usuarios de prueba caducan a los 7 días.

## Microsoft

- **No hay captura de audio de Teams desde un tercero** en escritorio. La vía oficial es un
  bot de comunicaciones visible para los participantes; no está implementada.
- Sin el proveedor «Teams para empresas» en el calendario, las reuniones de Teams aparecen sin
  enlace y no se detectan.
- El permiso exacto de `calendarView` debe confirmarse antes de publicar.

## Transcripción y notas

- **Hablantes:** no se identifican. Los segmentos no llevan nombre. Las notas no atribuyen
  afirmaciones a personas concretas.
- **Idioma:** se configura (`language`). Con `auto`, el motor local detecta el idioma; la
  calidad depende del modelo.
- **Calidad:** la transcripción puede tener errores, sobre todo con ruido, solapamientos o
  nombres propios. El modelo marca posibles errores en «Posibles errores de transcripción»,
  pero no es una garantía.
- **Reuniones largas:** el audio se carga en memoria para cifrarlo y descifrarlo. Reuniones de
  varias horas pueden necesitar más memoria; el troceado en la nube es de 10 minutos.

## Datos y privacidad

- Los audios, transcripciones y notas están cifrados en el disco, pero **borrar** no garantiza
  la destrucción física en SSD con cifrado de hardware.
- El documento de Google Docs **no se borra** al eliminar datos locales. Hay que borrarlo en
  Drive.
- Si el usuario revoca la cuenta en el proveedor sin desconectarla en la app, los tokens
  locales dejan de funcionar y la app lo indicará.

## Compatibilidad

- Probado en código solo en Linux (entorno de desarrollo). **No probado en macOS en esta
  versión**: el llavero, `osascript`, la captura y los permisos deben validarse en un Mac.
- Apple Silicon: el código Node es independiente de arquitectura; el helper debe compilarse
  para `arm64`.
