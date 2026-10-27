# Procedimiento de validación manual

Ejecutar en un Mac Apple Silicon con macOS 14.2+, con una cuenta de prueba de Google y otra de
Microsoft, y una reunión de prueba con un segundo participante. Marca cada caso como
**OK**, **FALLO** (con la salida) o **NO APLICA** (con el motivo). No cierres un caso sin
evidencia.

## Antes de empezar

- [ ] `npm test` pasa (54 pruebas).
- [ ] `config.json` tiene los IDs de cliente reales. No hay secretos en el fichero.
- [ ] `reuniones secrets set anthropic.apiKey` y, si aplica, `openai.apiKey`.

## Casos

| # | Criterio (prompt, sección 15) | Procedimiento | Resultado esperado |
|---|---|---|---|
| 1 | Detecta eventos de Google y Microsoft | `connect` ambas cuentas → `sync` → `meetings --days 3` | Eventos de los dos calendarios listados por día |
| 2 | Identifica enlaces válidos de Meet y Teams | Crea una reunión con Meet y otra con Teams en Outlook y Calendar | Ambas aparecen con `[Meet]` y `[Teams]`; un evento sin enlace no aparece |
| 3 | Autorización individual por reunión | Dos reuniones consecutivas → `prompt` | Una ventana por reunión; autorizar una no autoriza la otra |
| 4 | No graba si rechaza o no responde | Responde «No grabar» en una; deja caducar la otra (`promptTimeoutSeconds`) → `start` | `record start` falla en ambas; no hay audio nuevo en `audio/` |
| 5 | No inicia captura antes de consentimiento | `record start <id>` sin `--consent-confirmed`; en el demonio, responde «Cancelar» en la confirmación | Error de consentimiento; el micrófono no se abre (sin indicador de micrófono en la barra de menús) |
| 6 | Audio inteligible de participantes | Graba 3 min con un participante remoto hablando → `record stop` → `process` → revisa la transcripción | Voces remotas presentes; **si hay eco de la propia voz, anotarlo** |
| 7 | Detener manualmente | `record start` → `record stop <id>` | Estado `audio_ready`; el WAV en claro ya no existe |
| 8 | Transcripción razonablemente precisa | Compara 2 minutos de la transcripción con lo dicho | Errores de palabras puntuales; sin frases inventadas |
| 9 | Notas estructuradas sin inventar | Revisa `notes show <id>`: cada tarea sin dueño debe decir «No definido» | Ninguna tarea, nombre o fecha que no se dijera en la reunión |
| 10 | Crea o reutiliza «reuniones grabadas» | Primera ejecución crea la carpeta; segunda reutiliza (ver `settings show` → `driveFolderId`) | Una sola carpeta en Drive |
| 11 | Documentos nativos en esa carpeta | Abre el enlace del documento en Drive | Google Docs nativo dentro de la carpeta; nombre `AAAA-MM-DD - Título - Notas` |
| 12 | Registra el enlace | `history` | Enlace presente y abre el documento |
| 13 | Recupera procesos sin duplicar | Corta la red durante `notes approve` → restablece → `pending` | Un único documento; sin nueva transcripción |
| 14 | Protege credenciales y datos | `ls -l` de `audio/` (700/600); `sqlite3` sobre la base: no hay tokens ni texto de transcripción en claro; Llavero: tokens presentes | Ningún secreto en texto plano |
| 15 | Funciona tras reiniciar | Cierra la CLI con una grabación en curso y vuelve a abrir → `daemon --once` | La grabación interrumpida queda `audio_ready` con el audio parcial |
| 16 | Errores de red y autenticación | Desconecta Wi-Fi durante `sync` y revoca el acceso en Google | Mensajes en español con acción; sin pérdida de datos |
| 17 | Revocar y eliminar datos | `disconnect <cuenta> --yes` y `forget <grabación> --yes` | Tokens borrados del llavero; audio y artefactos eliminados; el documento de Drive sigue y se indica |

## Casos de error del prompt (sección 12)

- [ ] Calendario desconectado → `disconnect` y `sync` → error claro.
- [ ] Token OAuth expirado → revocar en el proveedor y `sync` → «vuelve a conectar».
- [ ] Evento cancelado durante la grabación → cancelar la reunión → la captura se detiene y se
      procesa lo grabado (`meeting_changed`).
- [ ] Micrófono sin permiso → denegar en Ajustes → `record start` → error con ruta de Ajustes.
- [ ] Audio del sistema no disponible → denegar grabación de audio del sistema → aviso y
      grabación solo de micrófono.
- [ ] Dispositivo desconectado durante la grabación → desconectar auriculares → aviso
      `device_disconnected` y notificación.
- [ ] Fallo de transcripción → `transcription.whisperBinaryPath` mal configurado → estado `failed` y el
      audio se conserva.
- [ ] Servicio de IA no disponible → clave inválida → error `auth`; el audio y la transcripción
      se conservan.
- [ ] Error al crear Google Docs → revocar `drive.file` → error; no se guarda enlace.
- [ ] Carpeta inaccesible → `driveFolderId` de otra cuenta → `destination_inaccessible`.
- [ ] Falta de espacio en disco → llenar el disco de prueba → error de escritura sin pérdida del
      WAV original.

## Criterio de aceptación global

La versión se considera aceptada cuando los casos 1–17 están en **OK** y los casos de error,
en **OK** o **NO APLICA** con motivo. Los casos marcados como **NO APLICA** deben quedar
registrados en `docs/LIMITACIONES.md`.
