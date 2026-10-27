# Captura de audio y permisos de macOS

## Estado

**No incluido en esta versión.** La app sí implementa el lado Node: el contrato, la gestión de
permisos, el sellado cifrado y la máquina de estados. El helper nativo en Swift es el siguiente
entregable y debe compilarse y probarse en un Mac Apple Silicon.

## Qué captura cada fuente

| Fuente | API | Permiso de macOS | Notas |
|---|---|---|---|
| Tu voz | AVAudioEngine (entrada) | Micrófono | Se pide al primer uso |
| Voces remotas | Core Audio process tap + dispositivo agregado | Grabación de audio del sistema | macOS 14.2+; sin API oficial para comprobar el estado |
| Alternativa | ScreenCaptureKit | Grabación de pantalla | Solo si el tap no sirve; más invasivo |

El helper debe escribir **WAV mono 16 kHz PCM de 16 bits**: es el formato que consumen
whisper.cpp y el troceado para la API de OpenAI.

**Duplicación de tu voz (requisito del prompt):** el micrófono capta tu voz y el tap del sistema
capta solo lo que suena en la salida. Tu voz solo aparece en el sistema si la reunión te la
devuelve (eco). Para evitarlo, el helper debe mezclar ambas fuentes en un único canal con
supresión de eco, o usar auriculares. **Es un riesgo a validar en las pruebas manuales**
(`docs/PRUEBAS_MANUALES.md`, caso 6); no está resuelto por código en esta versión.

## Protocolo con la app

Un único binario, `reuniones-capture`:

```
reuniones-capture permissions
  → {"event":"permissions","microphone":"granted|denied|undetermined","systemAudio":"granted|denied|undetermined"}

reuniones-capture record --out /ruta/reunion.wav --sources microphone,system
  → {"event":"started"}                                  (cuando la captura ya corre)
  → {"event":"problem","code":"device_disconnected","message":"..."}   (opcional, en cualquier momento)
  ← {"cmd":"stop"}                                       (por stdin)
  → {"event":"finished","path":"/ruta/reunion.wav","durationMs":1234567}
  → {"event":"error","message":"..."}                    (en cualquier fallo)
```

Códigos de `problem`: `device_disconnected`, `system_audio_unavailable`, `microphone_denied`,
`write_error`. Cualquier otro se trata como `unknown`.

## Configuración de la app

En `config.json`:

```json
{ "helperPath": "/Applications/Reuniones.app/Contents/MacOS/reuniones-capture" }
```

Sin `helperPath`, la app usa `UnsupportedAudioCapture`: no inicia grabaciones y lo indica
claramente.

## Permisos y su gestión

1. **Micrófono**: la primera captura muestra el aviso de macOS. Si lo rechazas, actívalo en
   *Ajustes del Sistema → Privacidad y seguridad → Micrófono*.
2. **Grabación de audio del sistema**: aparece al iniciar el tap. Se gestiona en *Privacidad y
   seguridad*. La app no puede saber si está concedido; si el audio llega vacío, lo indicará.
3. **Llavero**: la app pide acceso a sus propios elementos. Si macOS lo solicita, acepta solo
   para esta app.

## Requisitos de empaquetado (para el helper)

- `Info.plist` con `NSMicrophoneUsageDescription` y, si se usa, la descripción de captura de
  audio del sistema.
- Firma con *Developer ID* y notarización para distribuir fuera de la App Store (ver
  `docs/DISTRIBUCION.md`).

## Lo que no hace la app

- No se une a la reunión como participante invisible ni oculta la grabación.
- No captura procesos de Meet o Teams mediante inyección ni técnicas que eludan permisos.
- No graba si el permiso de micrófono está denegado: lo indica y no abre el dispositivo.
