# Netflix and session fixes — validation

Installed extension version: **1.17.10**. Minimum playback-compatible version: **1.17.8**.

The complete regression suite passed: **305 tests, zero failures**. Results are in `build/cache/extension-managed-all-tests.log`. Fixed-folder installation and precise first-install steps are in [EXTENSION_INSTALLATION.md](EXTENSION_INSTALLATION.md). Tests verify temporary-profile file replacement, stale-message handling, source consent, integrity checks, rollback, interrupted-update recovery, permission expansion and server download transport. Native installer dialogs/URI registration and live Chrome/Brave approval are not exercised by those simulations. Real store delivery remains untested until a store item exists.

## Follow-up: host playing while guest stays on Home

The reported screenshots showed a loaded, paused Netflix episode while the room still said the host was picking something. Two publication failures were reproduced: the authentication selector matched `spinner` as a PIN element, and the room-follow logic excluded paused titles. A third failure marked an attempted title publication as complete before its delayed status check, preventing retry after a transient report loss.

The earlier join tests supplied a destination directly to the guest. The new tests execute the production content script, background status routing, RemoteMedia adapter, room selection and SyncPlayer engine together. The host must publish its own title before the guest can recover after PIN entry. The paused-title cases failed before the fix and now pass for separate tabs and embedded theater frames, with and without a spinner. Playing-host cases, invisible cached PIN forms and transient report recovery are also covered.

## Verified

- Independent simulated host and guest service documents execute the production content script and Netflix bridge. Tests cover PIN gates at `/watch`, `/profiles` and `/browse`, login delays of 2, 10 and 60 seconds, both native title links and SPA navigation, title changes during PIN entry, rejected foreign navigation, synchronization to the host timestamp, and absence of repeated PIN reloads for another minute.
- The theater wrapper preserves the Netflix iframe during recovery and same-service title changes. A `/watch` URL with a PIN gate does not count as reaching playback. Browse previews cannot replace room playback.
- In a real browser, the production overlay remained inside the fullscreen player and retained a typed draft through 61 simulated native-control focus changes. Typing continued afterward. Clicking outside released focus while keeping chat open. The overlay rendered all ten room reactions.
- The installed app shows camera and microphone controls on Home, all ten reactions, a connected private player, and the existing anime watch history.
- Server tests cover solo sessions staying open, idle groups stopping sharing while preserving the host connection, active playback/cameras/microphones preventing idle stop, and closing the app shutting down active sharing. The five-minute boundary uses a controlled clock; server integration tests use shortened deadlines.
- History tests cover Netflix progress surviving Home, process restart and cache cleanup; exact title/timestamp resume; importing earlier extension progress; and rejection of stale, preview and unauthorized reports.

## Live Netflix check on two PCs

Real Netflix accounts, its current page router and DRM playback were not available in two independent extension-enabled browser sessions here. The simulated tests do not certify that external behavior.

1. On both PCs, follow [EXTENSION_INSTALLATION.md](EXTENSION_INSTALLATION.md) once and enable Watch Party Sync **1.17.10** from `%LOCALAPPDATA%\WatchParty\SyncExtension`. Disable the old copy if it came from another folder. Reload Watch Party and Netflix, and allow Netflix site access if it was restricted to localhost. The manual ZIP fallback remains `public/ext/watch-party-sync.zip`.
2. On PC 1, start sharing and load a Netflix movie. Pause while waiting for the guest. Confirm Watch Party leaves the picking state and shows the selected title before the guest unlocks its profile. Repeat once with the host playing.
3. On PC 2, join through the invite, open Netflix, select the profile and enter its PIN. After unlock, confirm the guest reaches the same `/watch/<id>` title as PC 1 and catches up to the host timestamp. Wait at least a minute to check for delayed PIN redirects.
4. In fullscreen, open chat, type, leave the mouse still until Netflix's controls fade, and continue typing. Click outside chat and check that Netflix then receives keyboard focus.
5. Return Home with camera or mic enabled. Confirm the top-bar buttons can turn each off. Confirm ten reactions are offered in both anime and Netflix.

Previously saved Watch Party extension progress is imported when available. A viewing session that was never recorded cannot be reconstructed. Watch history stays separate from the generated caches cleared on app shutdown.
