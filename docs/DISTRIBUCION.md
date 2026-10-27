# Generar una versión distribuible para Apple Silicon

**Estado:** procedimiento preparado, **no ejecutado**. Requiere un Mac, un certificado de
*Developer ID Application* y el helper nativo compilado.

## 1. Compilar el helper

1. Crea el proyecto Swift `reuniones-capture` (ver `docs/CAPTURA_AUDIO.md`) y compílalo para
   `arm64` con Xcode o `swift build -c release --arch arm64`.
2. Verifica el protocolo con `reuniones-capture permissions`.

## 2. Empaquetar el runtime

Opción A (recomendada para uso personal): **Node.js portable** + carpeta de la app.

```bash
npm ci --omit=dev        # tras npm run build
```

Copia `dist/`, `node_modules/`, `package.json`, el helper y un lanzador en una carpeta `.app`:

```
Reuniones.app/Contents/
  Info.plist              (NSMicrophoneUsageDescription, CFBundleIdentifier es.reuniones-app)
  MacOS/reuniones          (script que ejecuta el node embebido con dist/src/cli/main.js)
  MacOS/reuniones-capture  (helper compilado)
  Resources/app/           (dist, node_modules, config.example.json)
```

Opción B (futura): empaquetar la interfaz Tauri con un sidecar de Node. No está implementada.

## 3. Firmar

```bash
codesign --force --options runtime --timestamp \
  --sign "Developer ID Application: TU NOMBRE (TEAMID)" \
  Reuniones.app/Contents/MacOS/reuniones-capture
codesign --force --deep --options runtime --timestamp \
  --sign "Developer ID Application: TU NOMBRE (TEAMID)" Reuniones.app
codesign --verify --deep --strict --verbose=2 Reuniones.app
```

El binario de Node embebido también debe firmarse con el *entitlement* de JIT si el runtime lo
exige.

## 4. Notarizar y grapar

```bash
ditto -c -k --keepParent Reuniones.app Reuniones.zip
xcrun notarytool submit Reuniones.zip --keychain-profile "perfil-notarizacion" --wait
xcrun stapler staple Reuniones.app
spctl --assess --type execute --verbose Reuniones.app
```

## 5. Comprobaciones antes de distribuir

- [ ] `npm test` en el mismo commit.
- [ ] `docs/PRUEBAS_MANUALES.md` completado.
- [ ] Ningún secreto en el paquete: `grep -R "sk-\|clientSecret" Reuniones.app` no devuelve valores.
- [ ] `config.json` no incluido; el usuario crea el suyo.
- [ ] Instalar en un Mac limpio y completar `docs/INSTALACION.md`.
