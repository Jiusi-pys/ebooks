// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "ShufangCore",
    platforms: [.macOS(.v13), .iOS(.v17)],
    products: [.library(name: "ShufangCore", targets: ["ShufangCore"])],
    targets: [
        .target(name: "ShufangCore", path: "Shufang/Core"),
        .testTarget(name: "ShufangCoreTests", dependencies: ["ShufangCore"], path: "ShufangTests")
    ]
)
