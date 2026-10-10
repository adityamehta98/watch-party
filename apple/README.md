# Safari Web Extension release

The Safari build reuses the audited code in `extension/`; `apple/SafariWebExtension/` contains only Safari-specific overrides. The generated package supports Safari on iPhone, iPad and Mac.

## Recommended: App Store Connect packager

Apple can package a Safari Web Extension in App Store Connect without a Mac or Xcode:

1. Run `npm run build:safari` on any supported development machine.
2. In App Store Connect, create the app record for iOS and macOS with a unique bundle identifier.
3. Open **Xcode Cloud → Safari Web Extension Packager → Upload** and upload `public/ext/watch-party-safari-source.zip`.
4. Resolve any compatibility warnings, then distribute the generated build through TestFlight.
5. Put the resulting `https://testflight.apple.com/...` link in **Room → Apple devices**. Replace it with the App Store link after review.

The repository's macOS CI repeats the source build, tests it, asks Apple's command-line packager to generate an unsigned iOS project, and publishes the source ZIP as a short-lived workflow artifact. It never receives signing credentials.

## Xcode path

On a Mac with current Xcode command-line tools:

```text
npm run build:safari:xcode -- --bundle-id com.yourcompany.WatchPartySync
```

Omit platform flags for iOS, iPadOS and macOS, or add `--ios-only` / `--macos-only`. The script uses Apple's current `safari-web-extension-packager` and falls back to its former name, `safari-web-extension-converter`, on older Xcode versions. The generated project is under `dist/apple/xcode` and is intentionally ignored by Git.

In Xcode, select your development team, verify the app and extension identifiers, run on a simulator, then on a registered device, and archive for App Store Connect. Apple requires a containing app; an extension ZIP cannot be installed directly on iPhone or iPad.

## Security and privacy checklist

- Never commit certificates, provisioning profiles, `.p8` App Store Connect keys, team IDs, exported archives, or a local signing configuration. The repository ignores all of them.
- Store App Store Connect credentials only in Apple's service or a protected local keychain. This project does not need GitHub signing secrets.
- The extension does not collect analytics or send browsing history to a developer service. Party state goes only to the host-selected Watch Party server.
- Broad website access exists for the host-selected **Custom site** feature. Ad rules are scoped to that selected tab/site; supported streaming-service scripts only control playback.
- Test permission prompts, private browsing behavior, background reconnection, custom-site ad blocking, and top-level-tab playback on real iPhone/iPad hardware before review.

Apple documentation: [packaging from Xcode](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari), [packaging in App Store Connect](https://developer.apple.com/documentation/safariservices/packaging-and-distributing-safari-web-extensions-with-app-store-connect), and [running on iOS](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension).

On iPhone and iPad, Safari opens a streaming site in a normal top-level tab. The extension popup provides party controls while the party tab keeps chat and room presence connected. This avoids embedded-player sandbox detection and retains the scoped custom-site ad rules.
