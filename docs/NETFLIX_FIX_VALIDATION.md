# Netflix and session fixes — validation

Installed extension version: **1.17.14**. Minimum playback-compatible version: **1.17.8**.

The complete regression suite passed: **350 tests, zero failures**. Results are in `build/cache/prime-history-all-tests.log`. Fixed-folder installation and precise first-install steps are in [EXTENSION_INSTALLATION.md](EXTENSION_INSTALLATION.md). Tests verify temporary-profile file replacement, stale-message handling, source consent, integrity checks, rollback, interrupted-update recovery, permission expansion and server download transport. Native installer dialogs/URI registration and live Chrome/Brave approval are not exercised by those simulations. Real store delivery remains untested until a store item exists.

Prime's reported false rows used `/addons`, `/movie`, and a detail-page video with the generic Prime landing-page title. History validation now rejects these entries on record/import/load, removing the three false saved rows. The service and catalog scripts detect visible Prime ad countdowns before a main-video duration exists, ignore browse previews and trailer metadata, and avoid overwriting the show's timestamp during ad breaks. Hidden ad controls do not suppress normal playback. Tests also retain genuine short named content; duration alone does not identify an ad. These are simulated player/DOM tests, not a live signed-in Prime ad session.

Netflix opens inside Watch Party by default, including when joining or resuming a saved episode. The separate-tab option appears after the embedded player fails. The host fetches public Netflix title data for saved entries, matches the exact episode ID, and adds its artwork and episode label without changing the saved position. The current Akka entry was verified against Netflix's public title and image servers.

The previously missing images were reproduced against the live public Netflix page: its component used `webLoggedOutDetailPage_data` instead of `data`. The parser now searches the bounded component JSON for the exact series ID, checks each episode ID, and reuses that verified response for other episodes of the same series. Continue watching groups by the saved series ID and picks the most recently watched episode, retaining all individual progress. Hiding or completing that episode does not expose older episodes. Akka episodes 1–5 were checked live and resolved with one network lookup in about 1.3 seconds.

A Netflix series leaves Continue watching within five minutes of its verified final episode, capped at half the runtime for short episodes, matching anime. The final episode is identified only from complete, unpaginated season and episode lists; a later season prevents the previous finale from completing the series. Unknown finality stays visible. The saved timestamps remain intact. Older metadata is refreshed to add the final-episode marker, and subsequent lookups refresh after six hours so new seasons can be recognized.

Dismissal hides the current card, not future viewing. Selecting the same local movie, Netflix title, YouTube video or catalog title again restores its card while retaining progress and Netflix artwork. Old imports and ordinary playback reports cannot undo a dismissal. Continue watching, the player, library durations and side panel use `h:mm:ss` for hour-long media and `m:ss` below an hour.

## Join and control latency

The reported delay matched two stacked play/pause debounces: 350 ms in the service script plus 700 ms in the party page. The service now coalesces brief blips for 80 ms and the party forwards that confirmed action immediately. Seeking, buffering, ads and remote-command echo guards remain active. The room still broadcasts controls on receipt; it does not wait for a status or heartbeat interval.

After profile unlock, page changes are checked every 250 ms rather than every second. The party's Home recovery wait is 250 ms instead of 3 seconds, and the native navigation guard waits 250 ms instead of 1.5 seconds. Both independently recheck sign-in/PIN state and keep the existing service document. New host titles are published after a 250 ms confirmation instead of 1.2 seconds.

Twelve additional regression cases run the production content script, MAIN bridge, background report routing, RemoteMedia adapter, party control forwarding, Room and SyncPlayer together. The controlled clocks advance with simulated playback. In separate-tab and embedded cases, PIN recovery reaches the requested route within one second and play/pause reaches the other player within 100 ms with instantaneous transport. With 50 ms on each client/server network leg, pause reaches the guest within 200 ms. Other cases retain seek/buffering/blip suppression, reject command echoes, publish loaded titles within 750 ms, and wait if a PIN gate reappears. Five new latency assertions failed on the previous implementation before changing its timers. Logs: `build/cache/netflix-latency-before.log` and `build/cache/netflix-latency-after.log`.

These are deterministic application-delay bounds, not measured Netflix loading or internet latency. Netflix's router/DRM startup, buffering, browser scheduling and the network still add time. The user's two-PC report confirms the earlier join fix works; this faster release still needs that real-device timing check.

## Follow-up: host playing while guest stays on Home

The reported screenshots showed a loaded, paused Netflix episode while the room still said the host was picking something. Two publication failures were reproduced: the authentication selector matched `spinner` as a PIN element, and the room-follow logic excluded paused titles. A third failure marked an attempted title publication as complete before its delayed status check, preventing retry after a transient report loss.

The earlier join tests supplied a destination directly to the guest. The new tests execute the production content script, background status routing, RemoteMedia adapter, room selection and SyncPlayer engine together. The host must publish its own title before the guest can recover after PIN entry. The paused-title cases failed before the fix and now pass for separate tabs and embedded theater frames, with and without a spinner. Playing-host cases, invisible cached PIN forms and transient report recovery are also covered.

## Verified

- Independent simulated host and guest service documents execute the production content script and Netflix bridge. Tests cover PIN gates at `/watch`, `/profiles` and `/browse`, login delays of 2, 10 and 60 seconds, both native title links and SPA navigation, title changes during PIN entry, rejected foreign navigation, synchronization to the host timestamp, and absence of repeated PIN reloads for another minute.
- The theater wrapper preserves the Netflix iframe during recovery and same-service title changes. A `/watch` URL with a PIN gate does not count as reaching playback. Browse previews cannot replace room playback.
- In a real browser, the production overlay remained inside the fullscreen player and retained a typed draft through 61 simulated native-control focus changes. Typing continued afterward. Clicking outside released focus while keeping chat open. The overlay rendered all ten room reactions.
- The installed app shows camera and microphone controls on Home, all ten reactions, a connected private player, and the existing anime watch history.
- Update tests cover a visible prompt for compatible older versions, hiding it for current or newer copies, a managed update that launches the existing helper and asks for one reload, and ordinary page reloads finishing an update after the files are in place.
- Server tests cover inactive solo and group sessions staying online, manual Stop server disconnecting guests while preserving the host connection, and closing the app shutting down sharing. The server ignores the former inactivity deadline even when its old environment variable is set.
- History tests cover Netflix progress surviving Home, process restart and cache cleanup; exact title/timestamp resume; importing earlier extension progress; and rejection of stale, preview and unauthorized reports.

## Live Netflix check on two PCs

Real Netflix accounts, its current page router and DRM playback were not available in two independent extension-enabled browser sessions here. The simulated tests do not certify that external behavior.

1. On both PCs, use **Update extension** to enable Watch Party Sync **1.17.14** if the browser already uses the fixed folder. Otherwise follow [EXTENSION_INSTALLATION.md](EXTENSION_INSTALLATION.md) once and disable any older copy loaded from another folder. Reload Watch Party and Netflix, and allow Netflix site access if it was restricted to localhost. The manual ZIP fallback remains `public/ext/watch-party-sync.zip`.
2. On PC 1, start sharing and load a Netflix movie. Pause while waiting for the guest. Confirm Watch Party leaves the picking state and shows the selected title before the guest unlocks its profile. Repeat once with the host playing.
3. On PC 2, join through the invite, open Netflix, select the profile and enter its PIN. After unlock, confirm the guest reaches the same `/watch/<id>` title as PC 1 and catches up to the host timestamp. Wait at least a minute to check for delayed PIN redirects.
4. In fullscreen, open chat, type, leave the mouse still until Netflix's controls fade, and continue typing. Click outside chat and check that Netflix then receives keyboard focus.
5. Return Home with camera or mic enabled. Confirm the top-bar buttons can turn each off. Confirm ten reactions are offered in both anime and Netflix.

Previously saved Watch Party extension progress is imported when available. A viewing session that was never recorded cannot be reconstructed. Watch history stays separate from the generated caches cleared on app shutdown.
