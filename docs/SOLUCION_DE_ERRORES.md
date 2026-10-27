# Solución de errores frecuentes

Cada error de la CLI muestra su código y una acción. Esta tabla amplía esas acciones.

| Código | Mensaje típico | Qué hacer |
|---|---|---|
| `keychain` | «No se pudo guardar/leer en el llavero» | Ajustes → Llavero: permite el acceso a la app. Ejecuta desde una sesión con el llavero desbloqueado. En Linux este error es normal: el llavero solo existe en macOS. |
| `config_missing` | «Falta el client ID…» | Completa `config.json` con los IDs de `config/config.example.json`. |
| `auth` | «La autorización… no se completó» / «invalid_grant» | Reconecta la cuenta con `connect`. Si el tenant de Microsoft exige consentimiento de admin, pídelo. |
| `insufficient_permissions` | «rechazó el acceso» | Reconecta y acepta todos los permisos. Revisa los scopes de la guía. |
| `network` | «No se pudo contactar…» | La operación queda en `pending_sync`. Ejecuta `reuniones pending` cuando vuelva la red. |
| `rate_limit` | «ha limitado las peticiones» | Espera unos minutos; el demonio reintenta. |
| `google_calendar` / `microsoft_graph` (HTTP 5xx) | «respondió con HTTP…» | Es temporal. El resto de cuentas se sincroniza igual. |
| `ambiguous_folder` | «Hay N carpetas llamadas igual» | Elige una y configúrala: `settings set driveFolderId '"ID"'`. |
| `destination_inaccessible` | «La carpeta… no es accesible» | Con `drive.file` solo se ve lo creado por la app. Deja que la app cree la carpeta o usa el ID de una carpeta que sí tenga acceso. |
| `drive_unconfirmed` / `docs_unconfirmed` | «no confirmó…» | No se guarda el enlace. Ejecuta `reuniones pending`; si persiste, revisa el documento en Drive. |
| `consent_required` | «Falta confirmar…» | Confirma el consentimiento con `--consent-confirmed` o en la ventana del demonio. |
| `permission` (micrófono) | «macOS no permite… el micrófono» | Ajustes → Privacidad y seguridad → Micrófono → activa la app. |
| `capture_unsupported` | «solo está disponible en macOS 14.2+…» | Configura `helperPath` con el helper compilado (ver `docs/CAPTURA_AUDIO.md`). |
| `capture_error` / `capture_timeout` | «El helper de captura…» | Revisa permisos de micrófono y de audio del sistema. Reinicia la grabación. |
| `transcription_not_configured` | «whisper.cpp o el modelo no están instalados» | Ajusta `transcription.whisperBinaryPath` y `whisperModelPath`. |
| `cloud_not_acknowledged` | «El procesamiento en la nube no está autorizado» | Lee `docs/PRIVACIDAD.md` y activa `cloudProcessingAcknowledged`, o usa la transcripción local. |
| `secret_missing` | «Falta la clave de API…» | `echo -n "CLAVE" \| reuniones secrets set <nombre>`. |
| `notes_invalid` | «El JSON de las notas no es válido» | `notes export`, corrige el JSON y `notes import`. Después `notes approve`. |
| `audio_missing` | «El archivo de audio ya no existe» | Si la retención lo borró, el documento ya se creó o la grabación no se puede reprocesar. Revisa `history`. |
| `invalid_settings` | «Configuración no válida» | Corrige el rango indicado. `exportAudioToDrive` no está disponible en esta versión. |
| `confirmation_required` | «requiere confirmación explícita» | Repite el comando con `--yes`. |

## Diagnóstico

```bash
node dist/src/cli/main.js audit --limit 50     # eventos técnicos, sin contenido
node dist/src/cli/main.js recordings           # estados y último error
node dist/src/cli/main.js accounts            # cuentas conectadas y su estado
```

Si el problema no está aquí, adjunta la salida de `audit` (no contiene audio ni texto), sin
copiar `config.json` si tiene IDs que no quieras compartir.
