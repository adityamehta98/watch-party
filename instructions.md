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
Credits controls. Next episode is also available in the bottom control bar.

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
