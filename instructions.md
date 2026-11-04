# Anime playback troubleshooting: AniList, MegaPlay, and iPad

## The source URL issue

AniList identifies a series; its website URL is not a video source. An episode
selection needs the numeric AniList ID, episode number, and language. For example,
AniList ID `114121`, episode `1`, dub maps to:

`https://megaplay.buzz/stream/ani/114121/1/dub`

If the AniList mapping is unavailable, try the matching numeric MyAnimeList ID:

`https://megaplay.buzz/stream/mal/<malId>/<episode>/<sub-or-dub>`

These are provider player pages, not HLS manifests. Never assign them, an AniList
webpage, or the provider homepage to Watch Party's native video element.

### Symptoms we encountered

- The provider player worked while Watch Party stalled or buffered repeatedly.
- Playback appeared to start only after changing browser tabs.
- A resumed episode fetched the opening segments instead of the saved position.
- Missing source metadata was accidentally converted into the provider homepage.

### The working resolution path

Implemented in `server/anime.js`:

1. Fetch the episode's MegaPlay player page.
2. Read `data-id` from the element with ID `megaplay-player`. This is the source
   lookup ID; do not substitute the AniList ID or `data-realid`.
3. Request `https://megaplay.buzz/stream/getSourcesNew?id=<data-id>` with the episode
   page as Referer and `X-Requested-With: XMLHttpRequest`.
4. Decode the provider's `enc` metadata envelope when present, then extract the
   actual CDN video URL. `parseSource` handles the provider's public AES-CBC format
   and retains captions plus intro/outro ranges. The current format constants live
   in that module; provider changes can require updating them.
5. Proxy the CDN manifest and its child playlists, segments, keys, and init data
   through Watch Party's signed `/anime/` routes. Preserve Range requests.
6. For sources using `https://megaplay.buzz/` as Referer, use the server HTTP
   client's normal User-Agent and omit Origin. The earlier spoofed Chrome headers
   plus Origin caused upstream 403 responses.

Do not restore the extra `megavid.buzz` video-proxy hop: it stalled even when the
provider's own player and actual CDN worked. Do not hardcode an observed CDN
hostname or save expiring stream URLs in history. Resolve a fresh source each time.
If resolution fails, retain the current selection and show a retryable error;
keep Watch Party's playback controls instead of switching to an iframe.

## Loading, resume, and synchronization

- HLS initial loading uses the current shared resume timestamp when its manifest
  arrives. Do not capture an initial zero before the room's state has arrived.
- Before a manifest is parsed, a fatal network retry must call `loadSource` again.
  `startLoad` alone only restarts segment loading. Retries must remain bounded.
- While the decoder is buffering, automatic drift correction must not repeatedly
  seek toward an advancing room clock. Explicit user timeline commands still apply.
- The startup animation waits for the accepted episode and then fades once. Rapid
  progress callbacks must not keep resetting the fade's deadline.
- Returning home saves settled anime progress, stops playback, and invalidates
  pending episode resolution so a late response cannot reopen the player.

## Shared history and episode controls

Continue watching and watched episode indicators are shared with admitted room
members, including guest invite links on iPad. Unapproved clients receive no history.
The host alone can hide cards or manually mark episodes watched/unwatched.
History is stored in `watch-history.json` on the host PC; keep that file when
updating or moving the app. It contains metadata and timestamps, not stream URLs.

One connected viewer reports progress and drives automatic episode skipping: an
eligible host first, otherwise the first admitted playback controller by client ID.
This prevents multiple devices from issuing competing automatic skips. Other
viewers with playback permission can use manual Skip Intro / Next Episode / Skip
Credits controls. The bottom skip icon is a shared automatic-skipping toggle on
every device; changing it never immediately advances the episode. Manual Next
episode stays at the top. The preference is stored with room settings, and any
viewer with playback permission can change it for everyone. Only the elected
viewer executes automatic skips. Streaming-service extension skipping remains a
separate host preference.

The top previous/next controls are compact arrow buttons. The header episode
picker lists the known series episodes with watched and resume markers; an
equivalent picker appears inside the expanded/fullscreen stage. Selecting an
episode retains the current series and audio language and resolves a fresh stream.
The language and episode toolbar fades with the playback controls on every screen
size, reappears on touch or pointer activity, and stays available while paused,
using a menu, hovering with a mouse or navigating controls with a keyboard.

On narrow phone screens, the playback controls remain on one compact row.
Secondary controls (camera, microphone, lighting, battery saver, chat, and
10-second jumps) are in More controls. Reactions stay visible as static badges
when reduced motion or battery saver disables animation. Reaction delivery does
not rely on a phone clock being synchronized during connection startup.
Camera, Microphone, Ambient light and Battery saver appear as icon cards in More
controls, with short explanations, visible switches and gold On states. Toggles
stay open while their state changes; automatically paused lighting is labeled
Paused, with the reason. Floating cameras are marked Desktop only when unavailable.
System reduced-motion, data-saving, or low-memory
policies can pause ambient effects; the menu retains the controls and describes
the active policy. iPhone browsers may not expose a battery percentage, so the
manual battery-saver control remains available without automatic battery sensing.

Camera tiles form a horizontal strip at the top right of the player, with up to
four equally sized cameras visible. Left/right arrows appear with more than four
active cameras. Pin a camera to keep its exact slot while paging through the
others; pins apply only to your view and last while that camera remains connected.
If all four slots are pinned, unpin one to browse the remaining cameras. The strip
replaces old free-floating saved positions. On narrow screens it sits below the
anime controls. Layout tests and the local preview use synthetic participants and
never request camera or microphone access.

Intro/outro buttons depend on timing metadata supplied by the provider. Do not
guess an intro length when metadata is absent. Automatic next episode also runs at
the actual end of an episode when enabled, even without an outro range. A known
last episode must not advance past the series end.

Use Watch Party's fullscreen button. If the browser cannot fullscreen the stage
with its controls, Watch Party expands the stage within the page automatically.
The browser's separate video-only fullscreen or AirPlay interface cannot render
Watch Party's HTML controls.

## iPad buffering options

The CDN source and header fix already applies to every device: both native HLS and
hls.js request the same host proxy. The iPad is not sent through the old proxy.
For a remote iPad the path is CDN -> host PC -> iPad, so host upload speed,
Wi-Fi, and any tunnel can still constrain delivery.

On supported Apple mobile devices, open **Library -> Anime buffering on this device**:

- **Automatic:** keep native HLS first for compatibility and normal system media
  behavior. Safari/WebKit controls how far ahead it downloads; the website cannot
  force a particular buffer length. A 10-20 second buffer alone does not prove
  poor throughput if playback remains smooth.
- **More ahead:** try hls.js first for anime, with a 90-second forward target,
  180-second time ceiling, 64 MB size target, and 30 seconds behind. Prefer ordinary
  MediaSource when available; ManagedMediaSource may still be controlled or trimmed
  by the browser. These are targets, not guaranteed retained bytes or seconds.
  This uses more memory and may limit AirPlay. Native HLS remains the fallback
  when startup or decoding fails. Switching mode reloads at the shared timestamp.

The preference is local to that device and does not change other viewers or local
movie delivery. Older devices without media-source support keep native HLS.
If More ahead stalls or drains battery, return to Automatic. Test both Safari and
Brave on the actual iPad; desktop browser checks do not validate iPadOS behavior.

Other options, not implemented here: host-side segment prefetch/cache to reduce
repeat upstream waits, and lower-bitrate delivery when bandwidth is insufficient.
Neither can force native Safari to retain a larger decoded buffer. Prefetching
needs bounded storage/concurrency and authenticated cache handling; do not add
unbounded downloads or bypass signed proxy access checks.

Primary references:

- [WebKit: Media Source Extensions and AirPlay](https://webkit.org/blog/15036/how-to-use-media-source-extensions-with-airplay/)
- [hls.js configuration API](https://github.com/video-dev/hls.js/blob/master/docs/API.md)

## Verification and rebuilding

Run the tests under `test/` explicitly (avoid recursively discovering cached copies):

```powershell
$testFiles = @(Get-ChildItem -LiteralPath test -Filter '*.test.js' | ForEach-Object FullName)
node --test @testFiles
```

Then run `build.bat`. It builds and installs `WatchParty.exe` and restarts the app.
Reload the laptop and iPad pages afterwards; source edits alone do not update the
already built executable.

Check an AniList selection and a MAL fallback, both audio languages, a saved
resume, startup without tab switching, intro/credits skips, next episode, and a
return home while a source request is pending. On an admitted iPad guest, verify
the shared shelf, manual controls, page-expanded fullscreen, both buffering modes,
and sustained playback. Repeat with the host browser closed to verify progress
reporting and automatic skipping transfer to an eligible guest.

Swipe up/down on the left half for picture brightness, or the right half for local volume; left/right still seeks.
Controls, menus, camera tiles and the home shelf are excluded. On devices that
block script volume changes (including iOS native video), use the hardware volume
buttons; the player shows that instruction instead of a false percentage.

See SECURITY_AUDIT.md and PRIVACY.md for the security/storage review and unresolved
release conditions. Extension 1.17.0 must be reloaded after installing this build.

Safari extension/native companion support has been removed. iPad/iPhone/Safari
web playback for anime, local movies and YouTube remains available. External
streaming-service sync uses the Chromium extension on computers; Safari/mobile
users can open the service separately and follow the room clock.

The notification bell silently records your own received notices with timestamps.
Closing the panel does not delete them. Only the host has Clear all, which clears
every viewer's history. History is in-memory (latest 1,000 notices across the room)
and disappears when the host executable closes. Popups never stack.

Chat emoji pickers support Unicode 18.0 with search, categories and skin tones.
Reactions retain their compact quick buttons. Newest
glyphs depend on the operating system font. Brightness dims only the picture
(20–100%), keeping controls and cameras unchanged; it does not change device
hardware brightness. iOS may still require hardware buttons for volume.

For free GIF chat, create a Web/API beta key at https://developers.giphy.com/dashboard/
and enter it in Room settings → GIPHY API key → Save GIF key. Open chat's emoji
picker and select GIFs for trending or search. Choosing a GIF adds a removable preview to the
message draft; press Send to share it. Use a standalone GIF link for an inline
preview. Free beta keys allow 100 API calls/hour across everyone using the key;
GIPHY enforces the allowance and the app never upgrades or purchases a plan.
The picker shows quota/network/key errors without retrying automatically. Only
the host can change the key, but it is browser-visible to admitted viewers because
GIPHY prohibits server proxies. Clearing the field and saving removes the key.
Some streaming-service pages restrict external image previews; their GIF link
remains clickable. Google's Tenor API closed on June 30, 2026.

Skin tone is a preference: neutral emoji stay visible, while hands/people use the
chosen tone where supported. GIF trending loads when its tab opens and recovers
if the host adds or changes the key while the picker is already on that tab.

GIPHY trending and every submitted search each use one API call, regardless of
how many results are returned. Typing alone does not call the API. Reopening the
same loaded results does not issue another request. GIF preview/Send use the
returned media URL, without another search API request. The quota applies across
viewers using your key. The quota label has been removed from the picker; the
small Powered By GIPHY mark remains because the API requires it.

Use Stickers for 881 animated Google Noto choices with no key or GIPHY search
allowance. A GIPHY quota error automatically opens this fallback and pauses GIF
requests for an hour in that picker. Sticker searches are local, and images load
from Google when displayed. An internet connection is still needed. The fallback
is an animated sticker catalog; arbitrary GIF searches still use GIPHY. Choosing
a GIF/sticker displays a removable preview before Send. Skin tone applies to
hands and people; Unicode smileys remain yellow. Emoji-only chat is shown larger.
