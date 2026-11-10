# First Chrome Web Store publication

Status: local upload package and listing draft prepared; no store item has been created or submitted.

## Publisher account

Open the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole). Register using the Google account that should own Watch Party Sync. The account owner must accept Google's publisher agreement, pay the one-time registration fee shown there, and verify the contact email. Choose the publisher name on the account page. [Registration instructions](https://developer.chrome.com/docs/webstore/register), [account setup](https://developer.chrome.com/docs/webstore/set-up-account).

## Upload package

Run `npm run build:extension-store` to generate:

`build/output/extensions/watch-party-sync-chrome-store.zip`

This archive puts `manifest.json` at its root, preserves the packaged extension code, icons and license files, and checks the description length and version against the party page. The guest download at `public/ext/watch-party-sync.zip` intentionally contains a parent folder for manual extraction; use the dedicated store ZIP for the dashboard. [Google's package requirements](https://developer.chrome.com/docs/webstore/prepare).

## Listing draft

Name: **Watch Party Sync**

Summary: **Watch streaming videos together with synchronized playback, chat, reactions and party controls.**

Detailed description:

> Keep a Watch Party room beside your streaming video and follow the room's playback together. Watch Party Sync connects your browser to the Watch Party app running on the host's PC.
>
> Share play, pause and seek controls, chat, send reactions, and view the party panel next to the video. The host can open a supported streaming service or select a custom video site for the room. Saved playback progress helps you return to previously watched titles.
>
> Each viewer signs in to the streaming service with their own account and needs any subscription that service requires. This extension does not provide movies, subscriptions or a way around DRM. Streaming-service behavior and regional availability can vary.
>
> A running Watch Party host and a party invite are required. Local movies and the app's built-in web playback do not require this extension.
>
> This is an independent project, not affiliated with or endorsed by the streaming services it supports.

Language: English. Select the dashboard's entertainment category if available.

The store icon is `extension/icon128.png`. Capture at least one representative **1280 × 800** screenshot of the extension working with content you can publish. Do not use a PIN/login screen, real chat, private invite URL or a DRM movie frame. No publication screenshot has been prepared yet. [Listing assets](https://developer.chrome.com/docs/webstore/cws-dashboard-listing).

## Privacy form draft

Single purpose: **Synchronize a Watch Party room's streaming playback and keep its chat, reactions and controls beside the video.**

Permission explanations:

| Permission | Explanation |
| --- | --- |
| `storage` | Save device-local playback progress and temporary state needed to reconnect the party after an extension update. |
| `sidePanel` | Display the connected Watch Party room beside a streaming tab. |
| `scripting` | Inject packaged playback, navigation and overlay scripts into tabs and frames controlled by the current party. Netflix integration also uses a packaged script in the page's main world. |
| `webNavigation` | Detect navigation and inner player frames in party-controlled tabs, reconnect playback after redirects, and handle custom-site popups. |
| `declarativeNetRequestWithHostAccess` | Scope response-header changes to the Watch Party theater tab so selected sites can be embedded. Block configured advertising domains in the host-selected custom-site theater. |
| Host access, including `<all_urls>` | The app is self-hosted at user-specific party addresses and supports host-selected custom video sites. The extension needs access to these pages and their player frames. Broad access requires an accurate justification; review acceptance is not guaranteed. |

`management.getSelf()` is used only to distinguish an unpacked install from a store install. It needs no `management` permission, and none is requested. Store update checks use `runtime.requestUpdateCheck()` only after the page detects an old extension and the user clicks Update.

Data to disclose includes playback titles/URLs/timestamps and saved viewing progress; room names, chat and reactions relayed through the extension; and camera/microphone streams displayed when participants enable them. The extension does not request the cookies or browser-history API. Do not select a blanket "no data collected" statement: room data is sent to the host and other admitted viewers. Optional GIPHY requests send search terms and network information to GIPHY, and externally loaded GIF/sticker/emoji assets contact their providers. See [PRIVACY.md](PRIVACY.md) for the current implementation's retention and third-party details.

All packaged extension JavaScript is local. The theater embeds the separately hosted Watch Party app and selected streaming sites, which run their own page scripts. Describe that architecture in review notes and resolve the dashboard's remote-code declaration accurately; do not certify an unsupported answer. [Privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy).

A publisher-specific privacy policy still needs a public URL and the publisher's contact information. The repository's privacy notes describe the implementation; they do not supply the publisher identity or a hosted policy URL. Review the dashboard's declarations against the final policy before certifying them.

## Review and distribution

For sharing with friends, **Unlisted** allows installation by anyone who has the store link without advertising it in store search. It still goes through the same policy review as a public listing. Choose deferred publication so approval does not immediately release it. [Visibility](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution), [submission and deferred publishing](https://developer.chrome.com/docs/webstore/publish).

Before submission, complete the two-PC live Netflix check in [NETFLIX_FIX_VALIDATION.md](NETFLIX_FIX_VALIDATION.md). Automated tests simulate profile gates and playback; they do not certify Netflix's current live router or DRM behavior. Also test the update between two uploaded versions after a store item exists: the browser's real download/install behavior is not available from an unpublished unpacked build.

Once the approved store URL and extension ID exist, connect the app's initial Install button to that listing. Existing unpacked installations need a one-time switch to the store copy. Preserve required watch progress before removing a development copy: a different extension ID has separate browser storage. Normal later updates use **Update extension → Reload page**, without ZIPs or browser settings.

## Update behavior in 1.17.10

When the page detects an old extension, it shows **Your extension is old** and **Update extension**. A store copy asks the browser for an available update; it never downloads executable code from the party server. When ready, the page offers **Reload page**. That click applies the staged extension update and reconnects the affected party/service tabs, including the combined theater window. Saved progress is retained.

Unpacked Windows copies now have a native file updater and fixed AppData directory; see [EXTENSION_INSTALLATION.md](EXTENSION_INSTALLATION.md). The installer keeps its own executable beside the extension and registers a per-user `watchparty-sync` URI handler. It requires initial installation consent, approval for each new HTTPS party origin, and approval for permission expansion. It only downloads extension archives to its own fixed directory; it cannot accept a destination from a URI. This helper is a separate native component to describe in review notes and privacy disclosures. Store-installed copies continue to use only the browser's updater. No-update, throttled and offline responses stay visible as retries rather than being reported as successful installs.
