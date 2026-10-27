# reuniones-app

Aplicación personal para macOS que convierte tus reuniones de **Google Meet** y **Microsoft
Teams** en documentación en **Google Docs**, con **autorización explícita antes de cada
grabación**.

> **Estado: versión 0.1 — núcleo funcional y probado con APIs simuladas. No validada en macOS
> ni contra las APIs reales.** Ver el estado por fase más abajo.

## Qué hace

1. Conecta Google y Microsoft por OAuth 2.0 con PKCE (cuentas independientes).
2. Sincroniza calendarios y detecta reuniones de Meet y Teams. Deduplica la misma reunión en
   dos calendarios, detecta cambios de hora y cancelaciones.
3. Antes de cada reunión pregunta: **Sí, grabar / No grabar / Recordar más tarde**. Sin
   respuesta, no graba. Una autorización vale solo para esa reunión.
4. Antes de capturar pide confirmar el consentimiento de los participantes.
5. Transcribe (local con whisper.cpp, o en la nube con aviso previo) y genera notas con
   validación estricta: lo que no se dijo queda como «No definido».
6. Revisas y apruebas las notas. Solo entonces crea el documento de Google Docs en
   «reuniones grabadas» y verifica su contenido.
7. Borra el audio al publicar, según la política configurada. Todo está cifrado en local.

## Inicio rápido

```bash
npm install && npm test          # sin credenciales ni macOS
npm run build
node dist/src/cli/main.js help
```

Sigue `docs/INSTALACION.md`, después `docs/GUIA_GOOGLE.md` y `docs/GUIA_MICROSOFT.md`.

## Documentación

| Documento | Contenido |
|---|---|
| `docs/ANALISIS_TECNICO.md` | Fase 1: viabilidad, APIs, permisos y puntos no verificados |
| `docs/ARQUITECTURA.md` | Fase 2: módulos, modelo de datos, máquinas de estado |
| `docs/INSTALACION.md` | Instalación, configuración y ejecución |
| `docs/GUIA_GOOGLE.md` | Google Cloud: Calendar, Drive y Docs |
| `docs/GUIA_MICROSOFT.md` | Microsoft Entra ID y Graph |
| `docs/CAPTURA_AUDIO.md` | Captura de audio, helper nativo y permisos de macOS |
| `docs/PRIVACIDAD.md` | Política de datos, conservación y eliminación |
| `docs/LIMITACIONES.md` | Limitaciones reales y compatibilidad |
| `docs/PRUEBAS_MANUALES.md` | Validación manual frente a los criterios de aceptación |
| `docs/SOLUCION_DE_ERRORES.md` | Errores frecuentes y qué hacer |
| `docs/DISTRIBUCION.md` | Empaquetado, firma y notarización (no ejecutado) |

## Estado por fase

| Fase | Estado | Detalle |
|---|---|---|
| 1. Análisis | Hecho | Con fuentes verificadas y puntos marcados como pendientes |
| 2. Diseño | Hecho | Módulos, datos y estados |
| 3. Base y configuración | Parcial | Persistencia SQLite y ajustes validados. **Interfaz gráfica Tauri + React no implementada**; CLI y diálogos nativos |
| 4. Calendarios y consentimiento | Hecho (probado con simulaciones) | Google y Microsoft; falta validar con cuentas reales |
| 5. Grabación | Parcial | Reglas, permisos y protocolo implementados. **Helper Swift no incluido** |
| 6. IA | Hecho (probado con simulaciones) | whisper.cpp, OpenAI y Anthropic; falta validar con servicios reales |
| 7. Drive y Docs | Hecho (probado con simulaciones) | Idempotencia y verificación; falta validar contra las APIs reales |
| 8. Seguridad y pruebas | Parcial | 54 pruebas automatizadas; validación manual pendiente (`docs/PRUEBAS_MANUALES.md`) |
| 9. Entrega | Parcial | Documentación completa; **empaquetado `.app` no ejecutado** |

## Pruebas

```bash
npm test
```

Incluye pruebas unitarias (detección de enlaces, cifrado, WAV, consentimiento, notas, documento),
de integración (sincronización con un servidor de Google simulado, reglas de grabación,
pipeline reanudable) y de adaptadores (OAuth por loopback real, protocolo del helper con un
script, whisper.cpp y OpenAI simulados, orden de peticiones de Google Docs).

## Estructura

```
src/
  app.ts                 composición de servicios y ciclo del demonio
  cli/main.ts            interfaz de línea de comandos
  core/                  tipos, errores, detección de enlaces
  auth/                  OAuth 2.0 PKCE y gestor de tokens
  calendar/              fuentes Google/Graph y sincronización
  consent/               autorización por reunión
  recording/             captura (helper) y ciclo de grabación
  transcription/         whisper.cpp, OpenAI, utilidades WAV
  notes/                 prompt, validación y proveedor LLM
  google/                Drive, Docs y construcción del documento
  pipeline/              procesamiento reanudable
  privacy/               cifrado de ficheros y política de borrado
  storage/               SQLite y migraciones
  security/              llavero de macOS y AES-GCM
  notifications/         diálogos nativos (osascript)
  settings/ audit/       preferencias validadas y registro técnico
test/                    pruebas (node:test)
config/config.example.json   configuración pública de ejemplo, sin secretos
```

## Seguridad en pocas líneas

- Ningún secreto en ficheros ni en el código: llavero de macOS.
- Audio y artefactos cifrados con AES-256-GCM; clave en el llavero.
- Sin envío a terceros salvo que actives la nube y guardes la clave de API.
- Los logs no contienen audio, transcripciones, títulos ni credenciales.
- Todo borrado irreversible exige `--yes`.

## Licencia

Sin licencia definida todavía: es un proyecto personal. Revisa las condiciones de cada API
que utilices.
