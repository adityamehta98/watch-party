# Native Apple companion

`WatchPartyKit` is a small Swift package for the containing iOS/iPadOS/macOS app. It provides:

- an ephemeral WebSocket room client compatible with `server/room.js`;
- native HLS playback through `AVPlayer` with the same server-clock timeline;
- `AVPlayerViewController` Picture in Picture and system AirPlay routing;
- a SharePlay activity that hands the invite to FaceTime participants while the Watch Party server remains the playback authority;
- a SwiftUI companion screen and a Safari fallback for DRM streaming services.

The package intentionally does not persist invite URLs or room keys. Its `URLSession` is ephemeral, has no URL cache, and does not bypass TLS validation.

## Add it to the generated containing app

1. Generate the Xcode project using `npm run build:safari:xcode -- --bundle-id …`.
2. In Xcode, add `apple/WatchPartyKit` as a local package dependency to the iOS/macOS containing app target (not the Web Extension target).
3. Use `ExampleApp/WatchPartyCompanionApp.swift` as the SwiftUI app entry, or present `WatchPartyCompanionView()` from the generated app's root view.
4. Add the **Group Activities** capability for SharePlay.
5. Under **Background Modes**, enable **Audio, AirPlay, and Picture in Picture**.
6. Add a local-network usage description if the companion will connect directly to a host on the same LAN. Do not add a global App Transport Security exception; use trusted HTTPS for remote native playback.
7. Test on a real iPhone/iPad. The package's unit tests run on macOS CI, but signing, PiP, AirPlay route discovery, SharePlay, and extension permissions require Apple hardware/account validation.

For Netflix, Prime Video and other DRM services, the native player deliberately shows **Continue in Safari**. The signed Safari Web Extension controls each subscriber's own playback; the companion never captures, proxies, or decrypts DRM video.
