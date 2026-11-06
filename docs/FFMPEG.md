# FFmpeg tools

Local builds install ffmpeg.exe, ffprobe.exe and their DLLs into app/bin/.
Portable releases keep the same bin/ folder beside WatchParty.exe. Keep the
complete tool folder together; a shared build requires its matching DLLs.

Run build.bat to obtain the pinned build tools and install the application.
refresh.bat starts the app or applies an already downloaded update; it does not
download FFmpeg. A source run also searches system FFmpeg locations when local
tools are absent. Do not copy tools into docs/.

Preserve the supplied FFmpeg license, manifest and corresponding-source
obligations when distributing a release. See THIRD_PARTY_NOTICES.md.
