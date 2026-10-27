// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "reuniones-capture",
    platforms: [.macOS("14.2")],
    targets: [
        .executableTarget(
            name: "reuniones-capture",
            path: "Sources/reuniones-capture"
        ),
    ]
)
