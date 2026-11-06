# Watch Party

Watch local movies and anime together with synchronized playback, chat, reactions and cameras. Guests join in a browser; supported streaming services use the optional Chromium extension.

## Run on Windows

Double-click **refresh.bat**, or open **WatchParty.exe** directly. Run **build.bat** after changing the source. It builds a fresh release, installs its companion files into app/, and starts the root executable.

Existing settings, watch history, caches and tools are migrated from the old root layout on the first build. They are preserved across later builds. To update a portable download, keep its complete folder together and use its refresh.bat.

## Development

Use a supported Node security release listed in package.json, with npm on PATH.

```powershell
npm ci --ignore-scripts
npm test
npm start
```

Source runs share app/config.json, app/watch-history.json and app/cache/ with the locally installed executable. Do not run both servers at the same time. A legacy root config.json remains supported until build.bat migrates it.

## Folder layout

| Path | Contents |
| --- | --- |
| app/ | Tools, extension, private settings/history and caches; ignored by Git |
| server/ | Host server and media delivery |
| public/ | Web player and chat |
| extension/ | Chromium extension source |
| test/ | Regression tests |
| benchmark/ | Sync simulation and FFmpeg compatibility checks |
| build/ | Packaging, installer and analysis configuration |
| build/cache/ | Downloaded build tools and temporary assembly files; ignored |
| build/output/WatchParty/ | Clean portable release; ignored |
| docs/ | Guides, sample configuration, privacy and third-party notices |

Keep package.json, package-lock.json, README.md, LICENSE and the two Windows scripts at the root.

## Documentation

- [Full feature and hosting guide](docs/GUIDE.md)
- [Anime, mobile playback and troubleshooting](docs/instructions.md)
- [Sample configuration](docs/config.example.json)
- [FFmpeg setup](docs/FFMPEG.md)
- [Privacy and stored data](docs/PRIVACY.md)
- [Third-party notices](docs/THIRD_PARTY_NOTICES.md)
- [Validation scope](docs/AUDIT_COVERAGE.md)
- [Sync benchmark](benchmark/README.md)

Local settings, credentials, caches and binaries are excluded from commits. No media rights are granted by the application. See the [MIT license](LICENSE) and third-party notices before redistribution.
