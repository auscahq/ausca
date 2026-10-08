// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Ausca",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [.library(name: "Ausca", targets: ["Ausca"])],
    dependencies: [
        .package(url: "https://github.com/apple/swift-crypto.git", from: "4.5.1")
    ],
    targets: [
        .target(name: "Ausca", dependencies: [.product(name: "Crypto", package: "swift-crypto")], path: "swift/Sources/Ausca"),
        .testTarget(name: "AuscaTests", dependencies: ["Ausca"], path: "swift/Tests/AuscaTests")
    ]
)
