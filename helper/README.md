# reuniones-capture (helper nativo de macOS)

Compilar en un Mac Apple Silicon con macOS 14.2+ y Xcode / Command Line Tools:

```bash
cd helper
swift build -c release --arch arm64
.build/release/reuniones-capture permissions
.build/release/reuniones-capture record --out /tmp/prueba.wav --sources microphone,system
# Hablar y reproducir algo; después, en la misma terminal, escribir {"cmd":"stop"} y Enter
```

Ver `docs/CAPTURA_AUDIO.md` para el protocolo y `docs/PRUEBAS_MANUALES.md` para la validación.

Estado: escrito sin compilar (el entorno de desarrollo era Linux). Pendiente de validación en macOS.
