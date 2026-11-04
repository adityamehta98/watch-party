# Security, size and rights audit

Scope: first-party server, browser player, extensions, Apple companion, build
scripts, locked dependencies, generated extension archives and the Windows package.
Baseline: `009b04c`. See [coverage inventory](docs/AUDIT_COVERAGE.md),
[privacy/storage details](PRIVACY.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

This is a source review with regression tests, not a certificate that every
vulnerability or legal risk has been eliminated. Third-party binaries were
identified and inspected, not exhaustively audited from source. Native Apple
changes could not be compiled or exercised on physical Apple hardware here.

## Why 83 MiB became 269.77 MiB

The earlier folder measurement included an 83.38 MiB application executable and
186.18 MiB of separate FFmpeg executables/libraries, plus small extension/docs
files. The app executable embeds Node, server dependencies and browser assets.
It did not grow from 83 to 269 MiB.

PE import inspection found that both supplied ffmpeg.exe and ffprobe.exe directly
import all seven shipped FFmpeg DLLs. Removing avdevice or another apparently
unused DLL breaks the Windows loader even if the app never calls that API.

Safe future size options are a reproducible minimal FFmpeg build retaining the
demuxers/decoders, H.264/AAC encoding, scaling, captions and HLS needed by the app,
or an optional FFmpeg download. Both require compatibility/license work; simply
deleting DLLs or stripping arbitrary codecs is not a verified optimization.
No automatic media cache was deleted from the user's machine.

## Findings and changes

| Severity / area | Evidence and remediation |
|---|---|
| High: guest identity/approval | Public client IDs were enough to recover approval or replace another connection. Reconnect identity now binds to a signed HttpOnly browser session and the same role; a guest cannot replace the host. Browser-assigned IDs follow server responses. |
| High: HTTP media approval | Possession of the shared invite key previously reached media while approval was pending. Media, HLS, captions and catalog/anime proxies now require a live admitted browser session for guests. Native Apple clients bootstrap and forward the scoped session cookie. |
| High: DNS rebinding / SSRF | Separate DNS validation and fetch, automatic redirects and IPv4-mapped IPv6 left gaps. A shared upstream transport pins validated DNS into the actual socket, checks every redirect and removes credentials on origin changes. |
| High: local-host classification | A hostname beginning with 127. could be treated as local. Localhost checks now require a real IPv4 loopback address, localhost or IPv6 loopback. |
| Runtime security | Windows builds now use checksum-verified Node 22.23.4, a security release, instead of 22.22.0; older or mismatched runtimes fail the build. |
| Extension scope | Theater ownership and header exceptions could survive navigation away. Ownership and session rules are cleared when that tab leaves the theater. Privileged messages validate sender ID, URL, frame, ownership and origin. |
| Credentials in URLs | Known-service URLs and common custom-site auth query parameters are stripped before forwarding/history storage. Client media/caption loading refuses external credential-bearing URLs. |
| Cache exposure | Authenticated proxy responses now use private, no-store, with unnecessary wildcard CORS removed. The offline shell remains a fixed code/icon allowlist. |
| Resource exhaustion | Pre-hello websocket flooding, bounded upstream text, bounded free-media cache, async catalog requests, TURN pending allocation/permission limits and UPnP response/retry limits were tightened. |
| Privacy / third parties | Removed synthetic YouTube CONSENT/SOCS cookies. YouTube uses the privacy-enhanced embed host. Closing a still-loading YouTube player cannot recreate playback after returning home. |
| Dead code | Removed the unreachable MegaPlay iframe adapter, host element, duplicate social dock, legacy styles/callbacks and unused inPip helper. Native source-only anime playback and Watch Party controls remain. Obsolete iframe-only tests were replaced by native transport/security tests. |
| Build/update supply chain | Pinned Node digest, verified new FFmpeg archive downloads, locked dependency installs without install scripts, extraction failure handling and companion-file installation were added. Existing FFmpeg cache provenance remains explicitly unknown. |
| Licenses | App MIT license, full Node notices, actual bundled npm notices, FFmpeg license, binary hashes and a build manifest now accompany the executable and updates. Extension ZIPs include the app license. |

## Residual risks and release conditions

1. **FFmpeg binary redistribution is not cleared.** The cached GPLv3+ build includes
   linked libraries but lacks complete matching corresponding source, patches,
   build scripts and all dependency notices. A generic source link or GPL text
   does not solve that. Obtain a reproducible, licensed source/binary distribution
   before publishing this Windows folder.
2. **Media rights remain unverified.** MegaPlay source extraction/proxying and
   downloadable subtitles do not establish copyright authorization. Provider
   access/embedding terms must also be reviewed. Free-media license metadata is
   a filter, not independent proof that an uploader owns the rights.
3. **Framing weakens service protections by design.** Watch-here compatibility
   still removes CSP/X-Frame-Options headers for controlled theater subframes.
   Navigation leakage is fixed, but that feature remains a deliberate security
   tradeoff. Normal top-level service tabs avoid this framing exception.
4. **Extension host permissions remain broad** because arbitrary custom sites
   are supported. MAIN-world bridges can be called by the controlled service page.
   Do not use unknown custom sites or treat the extension as a browser sandbox.
5. **A party-page marker is not server identity proof.** The extension supports
   user-selected HTTPS invite pages and trusts the site you join. An attacker
   controlling an HTTPS lookalike can implement the marker; open only trusted
   host invite links and review extension access.
6. **No legal compliance guarantee.** Cookie/storage disclosures, applicable consent,
   retention/deletion handling, store submissions, subscription-service terms,
   codec patents and copyright obligations depend on deployment and jurisdiction.
7. **Native Apple and physical-device testing remain outstanding.** Swift source
   and security assertions are included, but Windows cannot run Xcode/device tests.
   Locked FFmpeg/dependency advisories cannot substitute for a binary/source audit.

For copyright, see the [US Copyright Office's rights provisions](https://www.copyright.gov/title17/92chap1.html).
For distribution, see [FFmpeg licensing](https://ffmpeg.org/legal.html).
[Netflix's public-viewing policy](https://help.netflix.com/en/node/633853347904100)
illustrates why subscription access is not permission for public/commercial
screenings; each viewer should use their own authorized access and obey the
service's current terms. [Chrome's user-data policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
also requires disclosures even for locally processed user data.
[Node 22.23.4 release](https://nodejs.org/en/blog/release/v22.23.4/).

## Volume gesture

One-finger up/down over the picture adjusts this viewer's volume continuously;
left/right still seeks. Controls, camera tiles, menus and the home shelf are
excluded. Pinch zoom remains available. Platform-controlled volume is detected
and reports the device-button instruction rather than persisting a fictitious
percentage. [Apple documents this iOS limitation](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/Using_HTML5_Audio_Video/Device-SpecificConsiderations/Device-SpecificConsiderations.html).

## Verification

The new tests cover session signatures, approval isolation, host replacement,
private addresses, actual socket DNS pinning, redirects, credential stripping,
response caps, extension ownership, URL redaction, native source invariants,
binary/license packaging, offline cache boundaries and gesture directions.
The final test/build counts and package hashes are recorded with the delivered
commit and BUILD-MANIFEST.json. A clean test run does not close the residuals above.

## Final measurements

The rebuilt executable is 84.55 MiB; the complete Windows folder is approximately 271.14 MiB, including 186.19 MiB of FFmpeg tools/libraries. Added license texts account for some package growth.

| Current first-party source | Physical lines | Source KiB |
|---|---:|---:|
| Application | 15527 | 849.30 |
| Tests | 3848 | 221.00 |
| Build/benchmark scripts | 757 | 38.60 |
| Total | 20132 | 1108.91 |

Compared with initial tracked snapshot e5e8762: application 6885 physical lines and 381941 source bytes; all source 11352 lines.

Compared with audit baseline 009b04c: application 37 physical lines and 3445 source bytes; all source 433 lines.

Counts include comments and blank lines, with CRLF normalized to LF; application includes server, browser, extension and Apple companion. Dependencies, docs, generated archives, binaries and caches are excluded from source LOC. Tests and tools are separate from shipped application code.

Verification: **196/196 JavaScript tests passed**, including the rebuilt extension ZIP comparisons. **build.bat succeeded** using Node **22.23.4**; the installed executable and all nine installed FFmpeg binary hashes match BUILD-MANIFEST.json. The installed executable serves the host page and audited player assets successfully. Extension version: **1.15.1**. Native Apple tests require Xcode and were not run here.
