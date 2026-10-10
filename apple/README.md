# Safari Web Extension

The Safari build reuses the audited scripts in `extension/`; this folder contains only Safari-specific overrides. Run:

```text
npm run build:safari
```

That creates `public/ext/watch-party-safari-source.zip`. On a Mac with Xcode installed:

1. Extract the ZIP.
2. Run `xcrun safari-web-extension-converter watch-party-safari`.
3. Open the generated Xcode project, choose your Apple development team and unique bundle identifiers.
4. Enable the iOS app and extension targets, then run on an iPhone/iPad or archive for TestFlight/App Store Connect.
5. Put the resulting `https://testflight.apple.com/...` or `https://apps.apple.com/...` link in **Room → Apple devices**.

Do not commit signing certificates, provisioning profiles, App Store Connect keys, team IDs, or generated Xcode user data. Apple requires a signed containing app for installation; the source ZIP itself cannot be installed as an iPad extension.

On iPhone/iPad, Safari opens the streaming site in a normal top-level tab. The extension popup provides party controls, while the party tab keeps chat and room presence connected. This avoids embedded-player sandbox detection and retains the scoped custom-site ad rules.
