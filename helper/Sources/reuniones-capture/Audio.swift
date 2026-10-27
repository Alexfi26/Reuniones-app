import AVFoundation
import CoreAudio

/// Formato de salida común: WAV mono 16 kHz, PCM 16 bits (lo que consumen whisper.cpp y la API de OpenAI).
let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!

/// Cola thread-safe de muestras ya convertidas a 16 kHz mono.
final class SampleQueue {
    private var samples: [Int16] = []
    private let lock = NSLock()

    func append(_ new: [Int16]) {
        lock.lock()
        samples.append(contentsOf: new)
        lock.unlock()
    }

    func drainAll() -> [Int16] {
        lock.lock()
        defer { lock.unlock() }
        let out = samples
        samples.removeAll(keepingCapacity: true)
        return out
    }
}

/// Convierte un buffer del dispositivo al formato de salida. El conversor es estado: uno por fuente.
func convert(_ buffer: AVAudioPCMBuffer, using converter: AVAudioConverter) -> [Int16] {
    let ratio = targetFormat.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
    guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return [] }
    var supplied = false
    var error: NSError?
    let status = converter.convert(to: out, error: &error) { _, inputStatus in
        if supplied {
            inputStatus.pointee = .noDataNow
            return nil
        }
        supplied = true
        inputStatus.pointee = .haveData
        return buffer
    }
    guard status != .error, let channel = out.int16ChannelData else { return [] }
    return Array(UnsafeBufferPointer(start: channel[0], count: Int(out.frameLength)))
}

/// Micrófono por AVAudioEngine (permiso TCC de micrófono).
final class MicrophoneSource {
    private let engine = AVAudioEngine()
    let queue = SampleQueue()
    var onProblem: ((String, String) -> Void)?
    private var configObserver: NSObjectProtocol?

    func start() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, let converter = AVAudioConverter(from: format, to: targetFormat) else {
            throw CaptureError("El micrófono no devuelve audio. Revisa el dispositivo de entrada.")
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [queue] buffer, _ in
            queue.append(convert(buffer, using: converter))
        }
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
            self?.onProblem?("device_disconnected", "Cambió o se desconectó el micrófono durante la grabación.")
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        if let observer = configObserver { NotificationCenter.default.removeObserver(observer) }
    }
}

/// Audio del sistema (voces remotas) con un Core Audio process tap sobre la salida por defecto.
/// Requiere macOS 14.2+ y el permiso «Grabación de audio del sistema». No hay API para consultar ese permiso.
final class SystemAudioSource {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    let queue = SampleQueue()
    var onProblem: ((String, String) -> Void)?

    func start() throws {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.uuid = UUID()
        description.muteBehavior = .unmuted
        description.isPrivate = true

        var status = AudioHardwareCreateProcessTap(description, &tapID)
        guard status == noErr else {
            throw CaptureError("No se pudo crear el tap de audio del sistema (código \(status)). Activa «Grabación de audio del sistema» para esta app.")
        }

        var asbd = try tapStreamDescription()
        guard
            let tapFormat = AVAudioFormat(streamDescription: &asbd),
            let converter = AVAudioConverter(from: tapFormat, to: targetFormat)
        else { throw CaptureError("Formato de audio del sistema no soportado.") }

        let outputUID = try defaultOutputDeviceUID()
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "reuniones-capture-tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: description.uuid.uuidString,
            ]],
        ]
        status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
        guard status == noErr else { throw CaptureError("No se pudo crear el dispositivo agregado del tap (código \(status)).") }

        let queue = self.queue
        status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, nil) { _, inputData, _, _, _ in
            guard let buffer = AVAudioPCMBuffer(pcmFormat: tapFormat, bufferListNoCopy: inputData, deallocator: nil) else { return }
            queue.append(convert(buffer, using: converter))
        }
        guard status == noErr, procID != nil else { throw CaptureError("No se pudo registrar la lectura del audio del sistema (código \(status)).") }

        status = AudioDeviceStart(aggregateID, procID)
        guard status == noErr else { throw CaptureError("No se pudo iniciar la lectura del audio del sistema (código \(status)).") }
    }

    func stop() {
        if let procID {
            AudioDeviceStop(aggregateID, procID)
            AudioDeviceDestroyIOProcID(aggregateID, procID)
        }
        if aggregateID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregateID) }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
        procID = nil
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        tapID = AudioObjectID(kAudioObjectUnknown)
    }

    private func tapStreamDescription() throws -> AudioStreamBasicDescription {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &asbd)
        guard status == noErr else { throw CaptureError("No se pudo leer el formato del tap (código \(status)).") }
        return asbd
    }

    private func defaultOutputDeviceUID() throws -> String {
        var deviceAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var deviceID = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &deviceAddress, 0, nil, &size, &deviceID)
        guard status == noErr else { throw CaptureError("No se encontró la salida de audio por defecto.") }

        var uidAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var uid: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        status = AudioObjectGetPropertyData(deviceID, &uidAddress, 0, nil, &size, &uid)
        guard status == noErr, let value = uid else { throw CaptureError("No se pudo leer el identificador de la salida de audio.") }
        return value.takeRetainedValue() as String
    }
}
