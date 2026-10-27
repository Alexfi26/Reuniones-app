import AVFoundation
import Foundation

// Uso:
//   reuniones-capture permissions
//   reuniones-capture record --out <ruta.wav> --sources microphone,system

let arguments = Array(CommandLine.arguments.dropFirst())
guard let command = arguments.first else { fail("Uso: reuniones-capture permissions | record --out <ruta> --sources <lista>") }

switch command {
case "permissions":
    printPermissions()
    exit(0)
case "record":
    runRecord(Array(arguments.dropFirst()))
default:
    fail("Comando desconocido: \(command)")
}

func printPermissions() {
    let microphone: String
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: microphone = "granted"
    case .denied, .restricted: microphone = "denied"
    case .notDetermined: microphone = "undetermined"
    @unknown default: microphone = "undetermined"
    }
    // macOS no ofrece API para consultar el permiso de audio del sistema: se informa como no determinado.
    emit(["event": "permissions", "microphone": microphone, "systemAudio": "undetermined"])
}

func optionValue(_ name: String, in args: [String]) -> String? {
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return args[index + 1]
}

func runRecord(_ args: [String]) {
    guard let outPath = optionValue("--out", in: args) else { fail("Falta --out <ruta>") }
    let sources = (optionValue("--sources", in: args) ?? "microphone").split(separator: ",").map(String.init)
    let useMic = sources.contains("microphone")
    let useSystem = sources.contains("system")
    guard useMic || useSystem else { fail("--sources debe incluir microphone y/o system") }

    if useMic {
        let semaphore = DispatchSemaphore(value: 0)
        // Si ya hay decisión, no se muestra de nuevo el aviso de macOS.
        AVCaptureDevice.requestAccess(for: .audio) { _ in semaphore.signal() }
        semaphore.wait()
        if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
            fail("Micrófono no autorizado. Ajustes del Sistema > Privacidad y seguridad > Micrófono.")
        }
    }

    let writer: WavWriter
    do {
        writer = try WavWriter(path: outPath)
    } catch {
        fail("No se pudo crear el fichero de salida: \(error.localizedDescription)")
    }

    let mic = MicrophoneSource()
    let system = SystemAudioSource()
    let problems: (String, String) -> Void = { code, message in
        emit(["event": "problem", "code": code, "message": message])
    }
    mic.onProblem = problems
    system.onProblem = problems

    do {
        if useMic { try mic.start() }
        if useSystem { try system.start() }
    } catch let error as CaptureError {
        mic.stop()
        system.stop()
        writer.discard()
        fail(error.message)
    } catch {
        mic.stop()
        system.stop()
        writer.discard()
        fail(error.localizedDescription)
    }

    // Mezcla: cada tick (100 ms) vuelca lo disponible de ambas fuentes y las suma con recorte.
    let mixer = DispatchQueue(label: "reuniones.mixer")
    let timer = DispatchSource.makeTimerSource(queue: mixer)
    timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
    timer.setEventHandler {
        writer.append(mixed(mic: useMic ? mic.queue.drainAll() : [], system: useSystem ? system.queue.drainAll() : []))
    }
    timer.resume()

    // Parada: el proceso Node escribe {"cmd":"stop"} por stdin, o cierra stdin.
    let stopSignal = DispatchSemaphore(value: 0)
    Thread.detachNewThread {
        while let line = readLine() {
            if line.contains("\"stop\"") { break }
        }
        stopSignal.signal()
    }
    emit(["event": "started"])
    stopSignal.wait()

    timer.cancel()
    mixer.sync {
        writer.append(mixed(mic: useMic ? mic.queue.drainAll() : [], system: useSystem ? system.queue.drainAll() : []))
    }
    mic.stop()
    system.stop()
    let durationMs = writer.close()
    emit(["event": "finished", "path": outPath, "durationMs": durationMs])
    exit(0)
}

/// Suma dos fuentes con recorte. Si una fuente no tiene muestras en este tick, cuenta como silencio.
func mixed(mic: [Int16], system: [Int16]) -> [Int16] {
    let count = max(mic.count, system.count)
    var out = [Int16](repeating: 0, count: count)
    for i in 0..<count {
        let a = i < mic.count ? Int32(mic[i]) : 0
        let b = i < system.count ? Int32(system[i]) : 0
        out[i] = Int16(clamping: a + b)
    }
    return out
}

/// WAV PCM 16 bits mono 16 kHz. La cabecera se escribe al cerrar con el tamaño real.
final class WavWriter {
    private let handle: FileHandle
    private let path: String
    private var dataBytes: UInt32 = 0

    init(path: String) throws {
        self.path = path
        FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600])
        handle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
        handle.write(Data(count: 44))
    }

    func append(_ samples: [Int16]) {
        guard !samples.isEmpty else { return }
        let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
        handle.write(data)
        dataBytes += UInt32(data.count)
    }

    /// Escribe la cabecera definitiva y devuelve la duración en milisegundos.
    func close() -> Int {
        handle.seek(toFileOffset: 0)
        handle.write(header(dataLength: dataBytes))
        handle.closeFile()
        return Int(Double(dataBytes / 2) / 16_000.0 * 1000.0)
    }

    func discard() {
        handle.closeFile()
        try? FileManager.default.removeItem(atPath: path)
    }

    private func header(dataLength: UInt32) -> Data {
        var h = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { h.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { h.append(contentsOf: $0) } }
        h.append(contentsOf: Array("RIFF".utf8)); u32(36 + dataLength)
        h.append(contentsOf: Array("WAVE".utf8))
        h.append(contentsOf: Array("fmt ".utf8)); u32(16)
        u16(1); u16(1)                      // PCM, mono
        u32(16_000); u32(32_000)            // sample rate, byte rate
        u16(2); u16(16)                     // block align, bits
        h.append(contentsOf: Array("data".utf8)); u32(dataLength)
        return h
    }
}
