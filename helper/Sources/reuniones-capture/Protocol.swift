import Foundation

/// Protocolo con la app Node: una línea JSON por evento en stdout. Ver docs/CAPTURA_AUDIO.md.
func emit(_ object: [String: Any]) {
    guard
        let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
        var line = String(data: data, encoding: .utf8)
    else { return }
    line += "\n"
    FileHandle.standardOutput.write(Data(line.utf8))
}

func fail(_ message: String) -> Never {
    emit(["event": "error", "message": message])
    exit(1)
}

struct CaptureError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}
