# Instalación y ejecución

## Requisitos

- macOS 14.2 o superior en Apple Silicon (para la captura de audio del sistema).
- Node.js 22.13 o superior (incluye `node:sqlite`). Con `brew install node@22`.
- Xcode Command Line Tools (`xcode-select --install`), necesarias para compilar el helper nativo
  y whisper.cpp.
- Para transcripción local: whisper.cpp y un modelo (`ggml-small.bin` o similar).

## 1. Dependencias

```bash
cd reuniones-app
npm install
npm run build
```

Las pruebas no necesitan credenciales ni macOS:

```bash
npm test
```

## 2. Configuración

La configuración pública va en `~/Library/Application Support/reuniones-app/config.json`
(o en la ruta de `REUNIONES_CONFIG`). Parte de `config/config.example.json`. **No contiene
secretos.**

```bash
mkdir -p "$HOME/Library/Application Support/reuniones-app"
cp config/config.example.json "$HOME/Library/Application Support/reuniones-app/config.json"
```

Edita los IDs de cliente de Google y Microsoft (ver `docs/GUIA_GOOGLE.md` y
`docs/GUIA_MICROSOFT.md`).

## 3. Secretos en el llavero

Los secretos nunca se escriben en ficheros. Se leen de stdin:

```bash
echo -n "CLAVE" | node dist/src/cli/main.js secrets set anthropic.apiKey
echo -n "CLAVE" | node dist/src/cli/main.js secrets set openai.apiKey        # solo si usas la nube para transcribir
echo -n "SECRETO" | node dist/src/cli/main.js secrets set google.clientSecret # si Google lo emitió
```

## 4. Preferencias de transcripción y procesamiento en la nube

- Local (recomendado para privacidad):
  ```bash
  node dist/src/cli/main.js settings set transcription '{"provider":"whisper_cpp","whisperBinaryPath":"/ruta/whisper-cli","whisperModelPath":"/ruta/ggml-small.bin"}'
  ```
- En la nube: primero lee `docs/PRIVACIDAD.md` y luego activa el reconocimiento explícito:
  ```bash
  node dist/src/cli/main.js settings set cloudProcessingAcknowledged true
  ```
  Sin ese paso, la app no envía audio ni texto a ningún proveedor.

## 5. Conectar cuentas y ejecutar

```bash
node dist/src/cli/main.js connect google --login-hint tu.correo@gmail.com
node dist/src/cli/main.js connect microsoft --login-hint tu.correo@empresa.com
node dist/src/cli/main.js sync
node dist/src/cli/main.js meetings --days 3
node dist/src/cli/main.js daemon          # ciclo automático: sincroniza, pregunta, graba, procesa
```

Para lanzar el demonio al iniciar sesión, crea un `LaunchAgent` en
`~/Library/LaunchAgents/es.reuniones-app.plist` que ejecute `node .../dist/src/cli/main.js daemon`
(la app pedirá confirmación en cada reunión de todos modos). La gestión de inicio automático
desde la interfaz gráfica no está implementada.

## 6. Ver la CLI

```bash
node dist/src/cli/main.js help
```
