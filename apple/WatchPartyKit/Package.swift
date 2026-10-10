// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "WatchPartyKit",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [.library(name: "WatchPartyKit", targets: ["WatchPartyKit"])],
  targets: [
    .target(name: "WatchPartyKit"),
    .testTarget(name: "WatchPartyKitTests", dependencies: ["WatchPartyKit"]),
  ]
)
