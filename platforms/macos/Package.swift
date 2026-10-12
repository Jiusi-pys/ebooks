// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ShufangMac",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "ShufangMacCore", targets: ["ShufangMacCore"]),
        .executable(name: "ShufangMac", targets: ["ShufangMac"]),
    ],
    targets: [
        .target(name: "ShufangMacCore"),
        .executableTarget(name: "ShufangMac", dependencies: ["ShufangMacCore"]),
        .testTarget(name: "ShufangMacCoreTests", dependencies: ["ShufangMacCore", "ShufangMac"]),
    ]
)
