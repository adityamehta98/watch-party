# Privacy and local storage

## Runtime locations

In a source checkout, private settings, history and cache live under `app/`.
In a portable release, paths are relative to the executable. Custom cache
locations are preserved.

Watch Party is hosted on the owner's PC. This describes the current source, not a
promise about third-party sites or a substitute for a publisher-specific policy.

## What is shared

The app starts as a private player. Guest pages, media and WebSocket connections
are unavailable until the host chooses **People → Start server**. Tailscale,
router mappings, tunnels and the webcam relay start only when sharing is enabled.
**Stop server** disconnects guests and returns to private playback. Sharing
stays on while the app is open, including during inactivity. Closing all host
windows shuts down the app and its sharing setup. A Tailscale connection that was already
running before sharing is left connected when sharing stops.

For Netflix cards, the host requests public title details by Netflix video ID. These requests do not use Netflix account credentials, cookies, or viewing timestamps. The saved card retains the public artwork URL and episode label with its existing progress.

The host and admitted viewers receive room names, chat, reactions, playback state,
watch history and media the host makes available. Saved playback history is shared
with admitted viewers by design. Camera/microphone sharing starts through the
device's permission flow and the controls you activate. Participants can see and
hear streams you share.

The host necessarily receives network addresses. Depending on relay settings,
peer-to-peer camera connections can expose participants' network addresses to one
another. Cloudflare TURN, Tailscale, tunnels and streaming providers receive the
network requests needed for the features you enable.

## Cookies and device storage

| Storage | Purpose | Retention |
|---|---|---|
| `wp_k`, `wp_kt` cookies | Access to this room's app shell; the theater variant is partitioned | Browser session; browser session-restore rules can retain it |
| `wp_s`, `wp_st` cookies | Signed browser session, admission and reconnect binding | Browser session; media requires a live admitted session |
| Browser local storage | Name/client ID, volume, subtitles, layout and local playback preferences | Until cleared in browser/site settings |
| Browser session storage | Temporary extension reconnect guard | Tab/browser session |
| Service worker Cache Storage | A fixed list of app scripts, styles, icons and the HLS library | Replaced on app-shell version changes or when site data is cleared |
| `watch-history.json` | Anime episode metadata and observed playback positions, titles and canonical streaming links | Preserved across shutdown and cache cleanup |
| Host `cache/` | Prepared local media, captions, metadata, certificates and diagnostics | Generated playback/session data is cleared on app shutdown; certificates and unrelated files remain |
| Room memory | Live chat, reactions, participants, private per-viewer notifications and synchronization diagnostics | Bounded live buffers; room/server lifetime |

Authentication cookies are HttpOnly, SameSite-scoped, and Secure on HTTPS.
Partitioned theater cookies use Secure and SameSite=None. Public HTTP mode cannot
protect bearer links or cookies in transit; use trusted HTTPS for remote guests.
Host API tokens and configuration are local files, not an encrypted secret vault.
Protect the PC, backups and filesystem permissions.

Room HTML, messages, history, credentials, playlists and media are outside the
service-worker cache allowlist. Authenticated proxy responses use private,
no-store caching. These headers do not delete already cached copies or media
explicitly prepared on the host.

## Streaming sites and third parties

The optional Windows extension file updater installs under `%LOCALAPPDATA%\WatchParty` after explicit approval. Its state records installation/automatic-file-update consent and approved update origins, without storing room keys. A per-user `watchparty-sync` URI handler accepts update requests from the app; any new origin needs approval before a download. It sends the current party access key only to that party's origin to fetch its update metadata and archive. TLS validation remains enabled, and room keys are not written to updater state. Permission expansion needs another approval. Extension files are replaced in the fixed `SyncExtension` folder; obsolete code is removed and browser playback/login data is not modified. The helper and its preferences persist across party shutdown; they are installed software, separate from generated session caches.

The extension does not request a cookies or browser-history API permission and
does not intentionally copy login cookies/passwords into Watch Party. Streaming
sites retain their own login, cookies, storage, DRM and terms. The extension can
access controlled page content and playback through broad host permissions;
that is a substantial trust grant, not proof it is unable to access page data.

Known-service playback URLs are redacted before sharing, and common secret query
parameters are removed from custom-site URLs. Do not put secrets in custom URLs:
a custom parameter name the application does not recognize may still be shared.

YouTube loads Google's iframe API when you choose a YouTube video and uses its
privacy-enhanced embed host. This still contacts Google and is not a claim of no
third-party processing. Search, artwork, captions and source resolution contact
the configured providers. No advertising analytics or sale-of-data service is
implemented in the reviewed source.

## Deployment responsibilities

The host/publisher must assess applicable privacy, cookie and content-rights rules,
give users clear disclosures, handle deletion requests, and obtain consent where
required. Necessary authentication cookies and optional tracking are different
purposes; a blanket cookie-free or consent-exempt claim would be inaccurate.

[ICO storage exceptions](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-the-exceptions/)
and [Chrome Web Store user-data requirements](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
describe relevant disclosure obligations. Jurisdiction, audience and distribution
model still require assessment before a public launch.

Notification histories are private to the viewer's server-bound session and live only in host-process memory (at most 1,000 recent notices across the room). The host-only clear command clears every viewer's notification history. Closing the panel does not clear it; stopping the host process does. No unread badge or notification count is generated. Picture brightness is local and does not change device hardware settings. Standard Unicode emoji use the local catalog and device font where available. When a device lacks a usable color glyph, the picker/chat loads a static Google Noto image from fonts.gstatic.com; Google receives your IP and asset path. No search text or optional analytics is sent to Google. The local catalog and initial emoji page prepare during browser idle time; missing initial glyph images may therefore load from Google before the picker is opened. This does not preload animated stickers or call GIPHY.

GIF search is optional and uses the host's GIPHY beta API key. Only the host can
change it; GIPHY requires direct browser requests, so this public client key is
available to admitted viewers and the extension. Do not reuse a secret credential
from another service. Opening the GIF tab sends a trending request; searches run
only when Search/Enter is pressed. GIPHY receives your IP and search terms; GIF
images load directly from GIPHY's media hosts (including when receiving a GIF).
No GIPHY response, GIF image, search term or key is added to offline shell caches.
The key is saved in the host's config.json; sent GIF URLs stay in live room chat
only, and no optional GIPHY analytics calls or persistent GIF favorites are added.

The separate Google Noto Stickers tab searches bundled metadata locally. Opening
it loads visible sticker images directly from fonts.gstatic.com; Google receives
your IP and requested asset paths. It needs an internet connection, but no API key
or GIPHY quota. GIPHY HTTP 429 automatically selects this tab and suppresses new
GIPHY attempts for up to one hour in that picker (a changed key can be used sooner).
The app does not send sticker search words or optional analytics to Google.
Attachment drafts stay on your device until Send, and can be removed before sending.
