# Windows extension setup and updates

The installer always uses this folder in the current Windows account:

`%LOCALAPPDATA%\WatchParty\SyncExtension`

For example: `C:\Users\YourName\AppData\Local\WatchParty\SyncExtension`.
There is no folder picker in the installer. Do not move or rename this folder.
The helper lives beside it at `%LOCALAPPDATA%\WatchParty\ExtensionUpdater.exe`.

The first Windows installer is about 85 MiB because it currently reuses the app's standalone Node executable. The Node runtime accounts for about 98% of that file; it contains no movie downloads. The extension ZIP is about 120 KB, and later extension updates download only that ZIP. A substantially smaller first installer would require a separate native updater rather than this shared runtime.

## First setup

1. Choose Netflix or another streaming service in Watch Party.
2. On the host PC, click **Install extension files**. A guest clicks **Download Windows installer**, opens **WatchPartyExtensionSetup.exe** from the browser's Downloads list, and approves its installation window. Approve only the Watch Party app/host you trust. The installer copies itself and the extension into AppData; it does not run a guest movie server.
3. Open a new tab in the browser where you will watch. Paste `chrome://extensions` and press Enter. This address also works in Brave; its displayed address becomes `brave://extensions`. Edge users can use `edge://extensions`.
4. Turn on **Developer mode**: top right in Chrome/Brave, left side in Edge.
5. If you previously installed Watch Party Sync from Downloads or another folder, turn that old entry **off**. Keep its old entry if you need to retain its browser-local data; do not run two enabled copies.
6. Click **Load unpacked**. In the folder picker, paste `%LOCALAPPDATA%\WatchParty\SyncExtension` into its address bar and press Enter. Click **Select Folder**. Choose this exact folder, not its parent `WatchParty` folder. The app also has a **Copy folder** button; the host sees its fully expanded path.
7. Return to Watch Party and click **Reload page**. If a streaming service was already open, reload its page too. Check the extension details page if needed: the installed version for this release is **1.17.14**.

The initial browser step is required for an unpublished extension. The installer does not edit browser profiles, enable Developer mode, or force-install an extension. A future browser-store listing removes the Load unpacked step. The downloaded setup file can be deleted after installation; the helper and extension remain in AppData.

## Later updates

1. Open or reload Watch Party. If your active extension is older than the host's release, click **Update extension** in the top bar. The button is hidden when you're up to date. Chrome or Brave's extension reload arrow only reloads files already on disk.
2. If asked, allow the browser to open **Watch Party Sync updater**. The first time an update comes from a new party address, the helper names that address and asks permission to use it. Approve only a host you trust. A change to extension permissions requires approval too.
3. The helper downloads the package from that approved party address, checks its hash and contents, stages the files, and replaces the same `SyncExtension` directory. Obsolete files from the previous version are removed. It does not touch browser playback history, logins, cookies or another folder chosen through a URL.
4. When Watch Party says the update is ready, click **Reload page**. The extension restarts and refreshes its controlled party/player tabs. If you reload Watch Party after the new files have already arrived, it can finish that restart for you. With the browser already using `SyncExtension`, there is no new Windows installer download, ZIP extraction, folder selection or re-adding the extension.

For the host, a new Watch Party app release also refreshes the managed extension files on startup after the helper has been installed and automatic file updates approved. New permissions are not approved during startup. The update source must use trusted HTTPS; localhost HTTP is allowed on the same PC. Updates do not bypass certificate validation.

## If something does not connect

- **The details page shows the latest version but Watch Party says it is old:** reload the Watch Party page to replace a stale content-script connection. New versions verify the active extension worker and do not allow an older cached hello to overwrite it. Versions **1.17.8 and 1.17.9 remain playback-compatible** with this release; an optional updater improvement does not block Netflix.
- **Netflix needs site access:** open the extension's details in this browser. Under **Site access**, add `https://www.netflix.com` to its allowed sites. Access to `127.0.0.1` alone is insufficient. Reload Netflix and click **Check again** in Watch Party. The app does not silently broaden site permissions.
- **The updater is not installed or was cancelled:** use the Windows installer and first-setup steps above. **Download extension ZIP** remains available to both host and guests as a manual recovery option. A ZIP in Downloads does not update a different folder that the browser is already using.
- **Opening settings:** current extensions open their own details in their current browser/window. Older copies show **Copy extensions address** instead; paste it into this browser. Watch Party no longer launches another browser profile just to open settings.

SHA-256 checks protect against damaged or mismatched downloads, not an untrusted publisher. The helper trusts only sources the user approves and rejects downgrades, unsafe archive paths, installation junctions and unrelated contents in its fixed destination. No store update has been certified by these local tests.
