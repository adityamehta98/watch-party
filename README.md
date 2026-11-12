# Watch Party

Watch local movies and anime together with synchronized playback, chat, reactions and cameras. Guests join in a browser; supported streaming services use the optional Chromium extension.

## Run on Windows

Double-click **refresh.bat**, or open **WatchParty.exe** directly. Run **build.bat** after changing the source. It builds a fresh release, installs its companion files into app/, and starts the root executable.

Existing settings, watch history, caches and tools are migrated from the old root layout on the first build. They are preserved across later builds. To update a portable download, keep its complete folder together and use its refresh.bat.

Watch Party opens as a private player and stays running until you close its window. In **People**, choose **Start server** to enable guest sharing and network setup, or **Stop server** to disconnect guests and keep watching privately. Sharing has no inactivity timeout. Closing all host windows shuts down sharing and the app, clears chat and generated playback caches, and preserves watch history.

## Live tools (optional, off by default)

The host can turn on three helpers in **Room settings -> Live tools -> Enable live tools**. Start captions from the CC menu. Options appear once; hover or focus an option for its explanation. Errors appear in notification history.

- **Live captions:** the playing audio is transcribed in rolling windows and streamed to every viewer over the existing WebSocket as WebVTT, so captions stay in sync and work when someone pauses, seeks or joins late. Works for library movies, anime and the Movies & TV catalog; streaming services play inside each viewer's own browser, so their audio is not available to transcribe.
- **Catch me up:** a late joiner requests a 3 to 4 sentence summary built from the captions up to the current moment. Response time depends on the provider.
- **Highlights:** finds notable moments from audio-energy spikes and chat/reaction spikes, then cuts short shareable clips with ffmpeg.

These need ffmpeg (already bundled) and a free transcription token. Nothing is sent anywhere until the host enables the feature, and if ffmpeg or the token is missing the feature simply stays unavailable.

Set the token as an environment variable before starting Watch Party (or add it to app/config.json):

| Provider | Free? | Set | Notes |
| --- | --- | --- | --- |
| Hugging Face (default) | Free account token | `WATCHPARTY_HF_TOKEN` (or `HF_TOKEN`) | Sign up at huggingface.co, create a token with Inference permission. |
| Groq | Free tier | `WATCHPARTY_STT_KEY` | Sign up at console.groq.com, create an API key. Fast and generous. |
| Any OpenAI-compatible | Varies | `WATCHPARTY_AI_PROVIDER=openai` + `WATCHPARTY_STT_KEY` | Point at your own endpoint with the env vars below. |

When both tokens are present, Groq is selected unless a provider is explicitly configured. English captions are the default: Groq uses multilingual Whisper Large V3 translation with automatic source-language detection, including Hindi and mixed-language dialogue. Hugging Face transcribes then translates timed segments. Provider credits and rate limits apply. For original-language captions set `captionOutput` to `original` in the host configuration, or `WATCHPARTY_CAPTION_OUTPUT=original`.

The same token powers "catch me up" unless overridden. Advanced overrides: `WATCHPARTY_AI_PROVIDER` (`hf` / `groq` / `openai`), `WATCHPARTY_STT_URL`, `WATCHPARTY_STT_MODEL`, `WATCHPARTY_STT_LANGUAGE` (original-language mode), `WATCHPARTY_LLM_KEY`, `WATCHPARTY_LLM_URL`, `WATCHPARTY_LLM_MODEL`. Groq English output requires a translation-capable model, not the transcription-only Turbo model.

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
