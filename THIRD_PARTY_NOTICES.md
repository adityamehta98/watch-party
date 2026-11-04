# Third-party software

Watch Party's own source is under the MIT license in `LICENSE`. Third-party
components keep their own licenses; the application's license does not replace
them.

Windows packages include the full Node.js license and bundled dependency notices
in `LICENSES/Node-LICENSE.txt`. The Node executable is modified by injecting the
application as a single executable application and changing the Windows subsystem;
its upstream Authenticode signature is removed during this process.

The server bundles `ws`, `qrcode`, `dijkstrajs`, and `pngjs` (MIT). The browser uses
the light build of `hls.js` (Apache-2.0). Windows builds copy the complete license
and notice files found in each shipped npm package into `LICENSES/`, and record
the versions actually bundled in `BUILD-MANIFEST.json`. The HLS license is also
embedded as `public/vendor/hls.LICENSE.txt`. Build-only tools and the QR command
line's dependencies are not part of the executable bundle.

FFmpeg is a separate executable, invoked as a child process. The currently cached
Windows builds enable GPL components and version 3 (`--enable-gpl
--enable-version3`), including x264/x265; their license is GPL version 3 or later.
See `bin/FFMPEG-LICENSE.txt` and the exact version, configure flags, and binary
hashes in `BUILD-MANIFEST.json`. FFmpeg also includes many linked third-party
libraries with their own notices and source requirements.

**FFmpeg redistribution remains an open release requirement.** The existing
cache does not include complete corresponding source, all linked-library notices,
or an original download receipt. A GPL text or a generic upstream link alone does
not supply the complete matching source. Before publishing binaries, retain and
provide the matching FFmpeg and linked-library source, patches, build scripts,
license notices, and a source-delivery method satisfying the applicable licenses.
The generated manifest records the evidence available locally and does not claim
that this requirement is fulfilled. Do not describe a binary release as MIT-only.

References: [FFmpeg legal guidance](https://ffmpeg.org/legal.html),
[FFmpeg build variants](https://github.com/BtbN/FFmpeg-Builds),
[GPL version 3](https://www.gnu.org/licenses/gpl-3.0.html), and
[Node.js license](https://github.com/nodejs/node/blob/main/LICENSE).

Codec patents, trademarks, media rights, and the terms of streaming services are
separate from these open-source copyright licenses. This notice does not grant
rights to any movie, subtitle, service, or trademark.
