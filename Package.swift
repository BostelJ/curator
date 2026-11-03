// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Curator",
    platforms: [.macOS(.v13)],
    targets: [.executableTarget(name: "Curator", path: "Sources/Curator")]
)
