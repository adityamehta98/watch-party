# Validation scope

The source tree, packaged application and optional browser extension have separate checks.

- `npm test`: browser logic, server authorization, playback, media preparation and release notices.
- `npm run audit:unused`: pinned Knip analysis using `build/knip.json`.
- `npm run benchmark:sync`: deterministic sync simulation; results are under `benchmark/`.
- `npm run test:ffmpeg`: local media and fixture compatibility checks. Private paths and reports stay under `app/cache/`.
- `build.bat`: locked dependencies, Windows executable, extension package and bundled licenses.

These checks do not prove absence of bugs, security issues or media-rights restrictions.
The historical SECURITY_AUDIT.md and DEAD_CODE_AND_FFMPEG.md reports were removed; this document does not recreate their conclusions.

## Reviewed static-analysis flags

The current Knip run reports no unused files or dependencies. Its 17 export
candidates are retained after checking real call sites: server/anime.js is used
through the anime namespace in server/index.js and server/room.js; tools.findBin,
tools.IS_SEA and youtube.search are called by server/index.js. REQUIRED_EXT_VERSION,
detectPlatform and playerMenuState are used internally and by dynamic-import
tests. Knip exits nonzero for these flags; they are not suppressed wholesale.
