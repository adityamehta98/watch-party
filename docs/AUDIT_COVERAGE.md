# Audit coverage inventory

All tracked first-party files were inventoried. Source review concentrated on
trust boundaries, data flow, credentials, network/filesystem access and provably
unreachable code. JavaScript syntax, behavior and focused security invariants
are checked by tests. Inventory does not prove the absence of every defect.
Swift compile/device verification is unavailable on this Windows host.

| File | Physical lines | Review scope |
|---|---:|---|
| PRIVACY.md | 71 | Documentation/data/license consistency |
| SECURITY_AUDIT.md | 120 | Documentation/data/license consistency |
| THIRD_PARTY_NOTICES.md | 42 | Documentation/data/license consistency |
| apple/WatchPartyKit/Tests/WatchPartyKitTests/NativeSecurityTests.swift | 28 | Extension/native permissions, IPC, storage and URL flow |
| build/package-notices.js | 61 | Build, provenance, license and dependency inputs |
| build/prepare-tools.ps1 | 65 | Build, provenance, license and dependency inputs |
| extension/LICENSE | 21 | Extension/native permissions, IPC, storage and URL flow |
| server/sessions.js | 23 | Server trust, admission, proxy, storage and abuse paths |
| server/upstream.js | 110 | Server trust, admission, proxy, storage and abuse paths |
| test/security-browser-audit.test.js | 48 | Regression assertions and audit cases |
| test/security-extension-audit.test.js | 155 | Regression assertions and audit cases |
| test/security-packaging-audit.test.js | 54 | Regression assertions and audit cases |
| test/security-server-audit.test.js | 70 | Regression assertions and audit cases |
| test/volume-gestures.test.js | 33 | Regression assertions and audit cases |
| .github/workflows/safari-package.yml | 32 | Build, provenance, license and dependency inputs |
| .gitignore | 49 | Documentation/data/license consistency |
| LICENSE | 21 | Documentation/data/license consistency |
| README.md | 703 | Documentation/data/license consistency |
| apple/README.md | 41 | Extension/native permissions, IPC, storage and URL flow |
| apple/SafariWebExtension/manifest.json | 58 | Extension/native permissions, IPC, storage and URL flow |
| apple/SafariWebExtension/safari-background.js | 2 | Extension/native permissions, IPC, storage and URL flow |
| apple/WatchPartyKit/ExampleApp/WatchPartyCompanionApp.swift | 7 | Extension/native permissions, IPC, storage and URL flow |
| apple/WatchPartyKit/Package.swift | 12 | Extension/native permissions, IPC, storage and URL flow |
| apple/WatchPartyKit/README.md | 23 | Extension/native permissions, IPC, storage and URL flow |
| apple/WatchPartyKit/Sources/WatchPartyKit/ApplePlayer.swift | 93 | Extension/native permissions, IPC, storage and URL flow |
| apple/WatchPartyKit/Sources/WatchPartyKit/CompanionView.swift | 71 | Extension/native permissions, IPC, storage and URL flow |
| apple/WatchPartyKit/Sources/WatchPartyKit/Models.swift | 94 | Extension/native permissions, IPC, storage and URL flow |
| apple/WatchPartyKit/Sources/WatchPartyKit/RoomClient.swift | 137 | Extension/native permissions, IPC, storage and URL flow |
| apple/WatchPartyKit/Sources/WatchPartyKit/SharePlay.swift | 54 | Extension/native permissions, IPC, storage and URL flow |
| apple/WatchPartyKit/Tests/WatchPartyKitTests/WatchPartyKitTests.swift | 26 | Extension/native permissions, IPC, storage and URL flow |
| benchmark/README.md | 13 | Documentation/data/license consistency |
| benchmark/results.json | 39 | Documentation/data/license consistency |
| benchmark/sync-benchmark.js | 127 | Documentation/data/license consistency |
| bin/README.txt | 3 | Documentation/data/license consistency |
| build.bat | 93 | Build, provenance, license and dependency inputs |
| build/build-extensions.js | 4 | Build, provenance, license and dependency inputs |
| build/build-safari-extension.js | 111 | Build, provenance, license and dependency inputs |
| build/build-safari-xcode.js | 44 | Build, provenance, license and dependency inputs |
| build/build-windows.js | 106 | Build, provenance, license and dependency inputs |
| build/import-anime-captions.py | 84 | Build, provenance, license and dependency inputs |
| config.example.json | 36 | Documentation/data/license consistency |
| extension/ad-domains.js | 20 | Extension/native permissions, IPC, storage and URL flow |
| extension/background.js | 510 | Extension/native permissions, IPC, storage and URL flow |
| extension/catalog-launch.js | 248 | Extension/native permissions, IPC, storage and URL flow |
| extension/custom-clean.js | 135 | Extension/native permissions, IPC, storage and URL flow |
| extension/manifest.json | 61 | Extension/native permissions, IPC, storage and URL flow |
| extension/netflix-main.js | 34 | Extension/native permissions, IPC, storage and URL flow |
| extension/party.js | 57 | Extension/native permissions, IPC, storage and URL flow |
| extension/playback-history.js | 74 | Extension/native permissions, IPC, storage and URL flow |
| extension/service.js | 814 | Extension/native permissions, IPC, storage and URL flow |
| extension/services.js | 63 | Extension/native permissions, IPC, storage and URL flow |
| extension/sidebar.css | 87 | Extension/native permissions, IPC, storage and URL flow |
| extension/sidebar.html | 77 | Extension/native permissions, IPC, storage and URL flow |
| extension/sidebar.js | 215 | Extension/native permissions, IPC, storage and URL flow |
| extension/theater.css | 24 | Extension/native permissions, IPC, storage and URL flow |
| extension/theater.html | 20 | Extension/native permissions, IPC, storage and URL flow |
| extension/theater.js | 219 | Extension/native permissions, IPC, storage and URL flow |
| instructions.md | 185 | Documentation/data/license consistency |
| package-lock.json | 867 | Build, provenance, license and dependency inputs |
| package.json | 28 | Build, provenance, license and dependency inputs |
| public/css/app.css | 1440 | Browser data flow, DOM escaping, events, cache and dead paths |
| public/index.html | 400 | Browser data flow, DOM escaping, events, cache and dead paths |
| public/js/anime-resume.js | 33 | Browser data flow, DOM escaping, events, cache and dead paths |
| public/js/app.js | 3498 | Browser data flow, DOM escaping, events, cache and dead paths |
| public/js/camera-gallery.js | 80 | Browser data flow, DOM escaping, events, cache and dead paths |
| public/js/camera-layout.js | 40 | Browser data flow, DOM escaping, events, cache and dead paths |
| public/js/capabilities.js | 49 | Browser data flow, DOM escaping, events, cache and dead paths |
| public/js/file-playback.js | 133 | Browser data flow, DOM escaping, events, cache and dead paths |
| public/js/fullscreen.js | 91 | Browser data flow, DOM escaping, events, cache and dead paths |
| public/js/media.js | 375 | Browser data flow, DOM escaping, events, cache and dead paths |
| public/js/net.js | 78 | Browser data flow, DOM escaping, events, cache and dead paths |
| public/js/platform.js | 23 | Browser data flow, DOM escaping, events, cache and dead paths |
| public/js/player-menu.js | 72 | Browser data flow, DOM escaping, events, cache and dead paths |
| public/js/player.js | 448 | Browser data flow, DOM escaping, events, cache and dead paths |
| public/js/rtc.js | 120 | Browser data flow, DOM escaping, events, cache and dead paths |
| public/js/subtitles.js | 136 | Browser data flow, DOM escaping, events, cache and dead paths |
| public/js/sync.js | 16 | Browser data flow, DOM escaping, events, cache and dead paths |
| public/js/visuals.js | 41 | Browser data flow, DOM escaping, events, cache and dead paths |
| public/sw.js | 39 | Browser data flow, DOM escaping, events, cache and dead paths |
| refresh.bat | 62 | Build, provenance, license and dependency inputs |
| server/anime-history.js | 134 | Server trust, admission, proxy, storage and abuse paths |
| server/anime.js | 152 | Server trust, admission, proxy, storage and abuse paths |
| server/assets.js | 36 | Server trust, admission, proxy, storage and abuse paths |
| server/captions.js | 72 | Server trust, admission, proxy, storage and abuse paths |
| server/catalog.js | 229 | Server trust, admission, proxy, storage and abuse paths |
| server/cert.js | 88 | Server trust, admission, proxy, storage and abuse paths |
| server/free-media.js | 170 | Server trust, admission, proxy, storage and abuse paths |
| server/guard.js | 76 | Server trust, admission, proxy, storage and abuse paths |
| server/index.js | 914 | Server trust, admission, proxy, storage and abuse paths |
| server/library.js | 878 | Server trust, admission, proxy, storage and abuse paths |
| server/media.js | 71 | Server trust, admission, proxy, storage and abuse paths |
| server/pwa.js | 27 | Server trust, admission, proxy, storage and abuse paths |
| server/remote-media.js | 102 | Server trust, admission, proxy, storage and abuse paths |
| server/room.js | 1029 | Server trust, admission, proxy, storage and abuse paths |
| server/services.js | 70 | Server trust, admission, proxy, storage and abuse paths |
| server/settings.js | 23 | Server trust, admission, proxy, storage and abuse paths |
| server/subtitle-search.js | 142 | Server trust, admission, proxy, storage and abuse paths |
| server/tailscale.js | 188 | Server trust, admission, proxy, storage and abuse paths |
| server/tools.js | 134 | Server trust, admission, proxy, storage and abuse paths |
| server/tunnel.js | 67 | Server trust, admission, proxy, storage and abuse paths |
| server/turn.js | 335 | Server trust, admission, proxy, storage and abuse paths |
| server/upnp.js | 205 | Server trust, admission, proxy, storage and abuse paths |
| server/youtube.js | 73 | Server trust, admission, proxy, storage and abuse paths |
| test/anime-history.test.js | 295 | Regression assertions and audit cases |
| test/anime-resume.test.js | 40 | Regression assertions and audit cases |
| test/anime-source.test.js | 68 | Regression assertions and audit cases |
| test/anime-startup.test.js | 182 | Regression assertions and audit cases |
| test/camera-layout.test.js | 126 | Regression assertions and audit cases |
| test/captions.test.js | 66 | Regression assertions and audit cases |
| test/catalog-autoplay.test.js | 302 | Regression assertions and audit cases |
| test/catalog-launch.test.js | 126 | Regression assertions and audit cases |
| test/episode-navigation.test.js | 56 | Regression assertions and audit cases |
| test/home-navigation.test.js | 26 | Regression assertions and audit cases |
| test/ipad-anime.test.js | 124 | Regression assertions and audit cases |
| test/mobile-controls.test.js | 92 | Regression assertions and audit cases |
| test/playback-history.test.js | 39 | Regression assertions and audit cases |
| test/player-menu.test.js | 108 | Regression assertions and audit cases |
| test/player.test.js | 427 | Regression assertions and audit cases |
| test/regression.test.js | 1126 | Regression assertions and audit cases |
| test/subtitle-search.test.js | 119 | Regression assertions and audit cases |
| test/theater-load.test.js | 112 | Regression assertions and audit cases |
