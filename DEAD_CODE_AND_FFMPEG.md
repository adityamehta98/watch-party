# Safari removal and FFmpeg compatibility review

Baseline: bc49c3d. Original media files were read, not modified. Private per-file
results are kept under ignored cache/ and must not be uploaded with a release.

## Removed and retained

Removed the apple/ tree (Safari extension and native companion), Safari ZIP,
Xcode packaging, Safari-only workflow, signed-install URL configuration/API/UI,
Safari extension message branches and obsolete tests. Chromium packaging now
lives in build/build-extensions.js. Old safariExtensionUrl settings are discarded
on configuration migration. Removed unused export declarations without deleting
the internally used functions/constants.

Kept Safari/iPad browser detection, native HLS delivery, Apple playback tuning,
WebKit fullscreen and the home-screen web app. Streaming-service synchronization
still uses the Chromium extension on computers. Safari/mobile service pages offer
a manual clock and external service link; anime/local web playback remains native.
Extension version is 1.15.2; service-worker shell version is 20.

Current application source (JS/CSS/HTML, comments and blank lines included):
14946 physical lines, 821.29 KiB with LF line endings. Tests,
validation tools, docs, archives, dependencies and binaries are excluded.

## Knip results

Ran pinned Knip 6.44.1 before and after removal (npm exec, equivalent to npx).
Reproduce with npm run audit:unused. knip.json declares the actual server,
browser, service-worker, extension-script, build, benchmark and test entry points.
The extension scripts are injected dynamically; they are intentional entry points,
not blanket ignored files. hls.js (vendored browser asset), esbuild (computed
require path), and postject (child-process CLI path) are dependency exceptions,
with actual bundle/license packaging separately verified by tests.

The final report has no unused files, unused dependencies, or unresolved imports
within that configured JavaScript scope. It still reports the following exports:

| File | Reported exports | Resolution |
|---|---|---|
| server/tools.js | findBin | Live CommonJS namespace/property calls in server/index.js and server/room.js |
| server/youtube.js | search | Live CommonJS namespace/property calls in server/index.js and server/room.js |
| server/anime.js | search, poster, embedSources, resolveStream, init, signedPath, parseProxyPath, fetchUpstream, rewriteM3u8, toVtt, Readable | Live CommonJS namespace/property calls in server/index.js and server/room.js |
| public/js/player-menu.js | playerMenuState | Public test seam imported by data-URL VM tests; also used internally |
| public/js/platform.js | detectPlatform | Public test seam imported by data-URL VM tests; also used internally |
| public/js/media.js | REQUIRED_EXT_VERSION | Read by packaging and imported by data-URL VM tests |

These findings are retained, not silently suppressed. Knip exits 1 because it
reports them. It does not prove the absence of unused CSS, non-exported functions,
reflection/dynamic-call paths, or defects. See https://knip.dev/guides/configuring-project-files.

## FFmpeg features actually required

| Area | Required by current app |
|---|---|
| Programs | ffprobe metadata inspection; ffmpeg preparation and encoder self-tests |
| Input support | MKV/MP4/MOV/WebM/AVI/TS/MTS/M2TS/WMV through broad video/audio decoders; do not restrict decoders to the current library |
| Output | MP4/MOV faststart and HEVC hvc1 tags; fragmented MP4/HLS; WebVTT; null output for encoder probes |
| Video encoding | H264 and HEVC, 8/10 bit, HDR metadata; working hardware encoders and libx264/libx265 CPU fallback |
| Audio | AAC and Windows aac_mf; audio copy, stereo/5.1 downmix, multi-track selection; decoding AAC/AC3/EAC3/DTS/TrueHD and other supported inputs |
| Filters | aresample, bwdif deinterlacing, pixel-format conversion; lavfi color/anullsrc for startup self-tests |
| Bitstream filters | dovi_rpu, hevc_mp4toannexb, extract_extradata, aac_adtstoasc |
| Protocols | Local file access, progress pipe, and concatf for assembling fragmented output |
| Subtitles | Extract text subtitles to WebVTT; retain supported input subtitle decoders |

This is the direct feature inventory from server/library.js and server/tools.js,
not a whitelist for pruning every other decoder. Windows does not use Apple's
VideoToolbox encoder; the portable discovery code is retained for other hosts.
Browser cameras/microphones use WebRTC, not FFmpeg capture devices.

## Local results

- Probed all **117** files in the configured folder (about **587 GiB**, MP4/MKV).
- Attempted **351** short decode windows: opening, midpoint and near the end of
  every file, with all video/audio tracks mapped. **116 files passed** all windows.
- One existing file, private report ID **4749d58f1437**, produced no decodable
  frames at any sampled position on the unchanged baseline. Its metadata declares
  H264 but lacks a usable decoded pixel format. This is not proof of a missing
  decoder; H264 decoded in the other files. Source corruption/incompleteness is
  suspected, not conclusively diagnosed. The original file was left untouched.
- Video found: 41 H264 files and 76 HEVC files; audio includes AAC, AC3, EAC3,
  TrueHD and DTS, with stereo/5.1/7.1 tracks. HDR10 and Dolby Vision profiles 7/8
  were included. Bitmap PGS/DVD subtitle tracks are present; the current web
  player extracts text subtitles, not OCR of bitmap captions.
- **40/40 feature checks passed** after fixing the AAC transport-stream issue below.
  Generated fixtures exercise all ten file extensions accepted by the library,
  plus MPEG4, WMV/WMA, VP9/Opus, AV1, FLAC, PCM and interlaced input.
- Real preparation jobs exercised representative samples from each video/audio/
  HDR/Dolby Vision profile group, alternate audio selection, HLS and direct MP4,
  software H264/HEVC10, Intel Quick Sync H264/HEVC10, forced encoder failure with
  successful CPU fallback, stereo/surround audio, and SRT/ASS/WebVTT/mov_text
  extraction. Prepared MP4 and HLS outputs were decoded and inspected.

The two initial fixture-construction errors (unsupported six-channel WMA encoding
and a removed MPEG2 fixture flag) were corrected in the test harness. They were
not production failures.

### Compatibility fix discovered

AAC in transport streams uses ADTS framing. Copying it to fragmented MP4/HLS
failed with 'Malformed AAC bitstream detected' on the unchanged production command.
Adding **aac_adtstoasc** to the AAC copy path made the identical input succeed,
without re-encoding. This fix is in buildHlsArgs and has both a unit regression
and real FFmpeg preparation/decode coverage.

## Size decision and limits

**No FFmpeg binary, codec, filter or DLL was removed.** The shipped general-purpose
bundle remains intact. All seven DLLs are directly imported by both command-line
tools; deleting apparently unused device/filter DLLs breaks Windows loading.
A source rebuild could omit device capture and unrelated encoders, but no such
replacement has been built and validated here. Preserving broad input support,
GPU variants and CPU fallbacks takes precedence over a guessed size saving.

Re-run npm run test:ffmpeg against a candidate build using -- --bin PATH.
The command returns nonzero for any file/check failure and writes detailed private
results to cache/ffmpeg-compatibility.json. The current complete run remains
nonzero because of the one unreadable source, even though all feature checks pass.
The local feature-only rerun is cache/ffmpeg-feature-final.json; it reuses the
original content results rather than pretending the failed file passed.

Short samples are not full-movie corruption scans, physical iPad/browser rendering
tests or a guarantee about every future file. Nvidia/AMD hardware absent from this
host was not tested. DRM-protected, malformed or unsupported media cannot be made
universally playable by retaining codecs. Security updates and FFmpeg's matching
source/license redistribution requirements remain necessary; tests cannot prove
that future vulnerabilities do not exist.

## Final delivery checks

**194/194 JavaScript tests passed**, including the npm test command, retained iPad HLS/fullscreen tests, new Safari/mobile panel behavior, the AAC framing regression, and the rebuilt extension ZIP comparison. **build.bat succeeded** and installed the rebuilt executable. Local HTTP smoke checks confirmed the new service panel and a 404 for the retired Safari ZIP. Installed executable and all FFmpeg binary hashes match BUILD-MANIFEST.json.

Current executable: **84.48 MiB**; Windows folder: approximately **271.07 MiB**. FFmpeg remains **186.19 MiB** and its binary hashes are unchanged. Application source fell from 15,527 to **14,946 physical lines** (581 fewer); source-only Apple code was never embedded as a native executable component, so this removal is mainly source maintenance, not a large binary-size reduction.

Generated test media under cache/ffmpeg-validation is disposable; private JSON reports and logs are retained after cleanup. Original movies, playback history and prepared user media were not deleted.
