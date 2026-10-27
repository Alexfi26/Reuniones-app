# Fase 2 — Arquitectura, modelo de datos y estados

## Capas

```
┌─────────────────────────────────────────────────────────────┐
│ Interfaz: CLI (src/cli)  ·  Diálogos nativos de macOS       │
│ (osascript)  ·  Pendiente: app Tauri + React                │
├─────────────────────────────────────────────────────────────┤
│ Composición: App (src/app.ts)  — única fábrica de servicios  │
├───────────────┬───────────────┬──────────────┬──────────────┤
│ CalendarService│ ConsentManager│ RecordingMgr │ Pipeline     │
│ (sync, dedup) │ (estado por   │ (captura,    │ (transcribir,│
│               │  reunión)     │  permisos)   │  notas, Docs)│
├───────────────┴───────────────┴──────────────┴──────────────┤
│ Adaptadores: GoogleCalendar · MicrosoftCalendar · Drive ·    │
│ Docs · Anthropic · OpenAI · whisper.cpp · helper nativo      │
├─────────────────────────────────────────────────────────────┤
│ Infra: LocalStorage (SQLite) · FileVault (AES-256-GCM) ·     │
│ SecretStore (llavero de macOS) · AuditService · Settings     │
└─────────────────────────────────────────────────────────────┘
```

| Módulo del prompt | Implementación | Fichero |
|---|---|---|
| CalendarService | `CalendarService` | `src/calendar/calendarService.ts` |
| MeetingDetector | `parseMeetingUrl`, `findMeetingLinks` | `src/core/meetingDetector.ts` |
| ConsentManager | `ConsentManager`, `deriveConsentStatus` | `src/consent/consentManager.ts` |
| AudioCaptureService | `AudioCaptureService`, `NativeHelperAudioCapture` | `src/recording/audioCapture.ts` |
| RecordingManager | `RecordingManager` | `src/recording/recordingManager.ts` |
| TranscriptionService | `WhisperCppProvider`, `OpenAITranscriptionProvider` | `src/transcription/transcription.ts` |
| MeetingNotesService | `buildNotesPrompt`, `parseNotes`, `AnthropicProvider` | `src/notes/*` |
| GoogleAuthService | `authorizeWithLoopback`, `TokenManager` | `src/auth/*` |
| GoogleDriveService | `GoogleDriveService` | `src/google/googleDrive.ts` |
| GoogleDocsService | `GoogleDocsService`, `buildMeetingDocument` | `src/google/*` |
| LocalStorageService | `LocalStorageService` (única capa SQL) | `src/storage/localStorageService.ts` |
| NotificationService | `MacNotificationService` | `src/notifications/notificationService.ts` |
| PrivacyService | `PrivacyService`, `FileVault` | `src/privacy/*` |
| SettingsService | `SettingsService` (validado) | `src/settings/settingsService.ts` |
| AuditService | `AuditService` (filtra claves sensibles) | `src/audit/auditService.ts` |

Los módulos se comunican por interfaces pequeñas (`CalendarSource`, `AudioCaptureService`,
`TranscriptionProvider`, `LlmProvider`, `NotificationService`, `SecretStore`). Eso permite
probarlos con dobles y sustituir cada proveedor sin tocar la lógica de consentimiento.

## Modelo de datos (SQLite, migraciones versionadas)

- `accounts`, `calendars`: cuentas conectadas y calendarios seleccionables. **Sin tokens.**
- `events`: copia local de cada ocurrencia (clave: cuenta + calendario + id externo) con un
  enlace opcional a `meetings`.
- `meetings`: una fila por **reunión concreta** (clave `plataforma:id-enlace@inicio-UTC`).
  Guarda la decisión (`decision`, `decided_at`, `snooze_until`), `cancelled` y `superseded`.
- `recordings`: ciclo de vida de cada captura y ruta del audio cifrado.
- `jobs`: un registro por paso del pipeline (`transcribe`, `notes`, `review`, `document`,
  `retention`), con su resultado **cifrado** como artefacto.
- `documents`: enlace de Google Docs por grabación (`recording_id` es clave primaria: no
  puede haber dos documentos para la misma grabación).
- `audit_log`: eventos técnicos sin contenido.
- `settings`: preferencias validadas.

La clave de deduplicación de reuniones combina la plataforma, el identificador del enlace y el
inicio. Así, la misma reunión en dos calendarios produce una sola fila, y un cambio de hora
produce una reunión nueva **sin decisión heredada**.

## Máquinas de estado

### Autorización (ConsentManager)

```
pending ──record──▶ authorized
   │  ▲                 │
   │  └──later── snoozed
   ├──decline──▶ declined
   ├──fin de la reunión sin decisión──▶ no_response   (no se graba)
   ├──cancelación──▶ cancelled
   └──cambio de hora──▶ superseded  (la nueva ocurrencia empieza en pending)
```

«Autorizada» solo tiene efecto para esa ocurrencia. Iniciar una grabación exige además
`consentConfirmed`, es decir, la confirmación de consentimiento de los participantes, que la
app pide justo antes de capturar.

### Grabación (RecordingManager)

```
(start) ──checks──▶ recording ──stop──▶ audio_ready ──pipeline──▶ processing ─▶ awaiting_review
                       │                                                │             │
                       │ cancelación/cambio/fin de reunión: stop        │       approve │
                       ▼                                                ▼             ▼
                   audio_ready                      pending_sync (red)  completed ◀── document
                                                    failed (error)
```

Las comprobaciones de `start`, en orden: confirmación de consentimiento, estado `authorized`,
reunión no terminada, sin otra grabación activa, permisos de micrófono y de audio del sistema.
Si falla cualquiera, no se abre ningún dispositivo.

### Pipeline (ProcessingPipeline)

Pasos fijos: `transcribe → notes → review → document → retention`. Cada paso guarda su
resultado antes de marcarse como `done`. Reanudar nunca repite un paso terminado:

- La transcripción y las notas se guardan cifradas y no se regeneran.
- El documento se busca por `appProperties.jobKey` antes de crear otro. Así, un corte entre
  «crear» y «guardar el ID» no duplica el documento.
- La escritura en Docs empieza borrando el contenido, de modo que repetirla es seguro.
- El enlace solo se guarda cuando Drive confirma el fichero y Docs confirma el texto
  (`verifyContains`).

## Flujo de datos y cifrado

- Audio: captura en WAV temporal → sellado AES-256-GCM en `audio/<id>.wav.enc` → descifrado a
  un temporal solo durante la transcripción → borrado seguro del temporal.
- Artefactos (transcripción, notas, ID del documento): cifrados con la misma clave en SQLite.
- La clave AES vive en el llavero de macOS (`storage.aes256.key`), generada una vez.
- Tokens OAuth: solo en el llavero (`google.refresh.<cuenta>`). Los access tokens se mantienen en
  memoria.
- Logs y auditoría: nunca contienen audio, texto de transcripción, títulos ni credenciales.
