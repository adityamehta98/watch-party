param([Parameter(Mandatory = $true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$executablePath = [IO.Path]::GetFullPath($Executable)
if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) { throw 'Executable is missing' }
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class WatchPartyShellIcon {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern void SHChangeNotify(uint change, uint flags, string first, IntPtr second);
    public static void Refresh(string executable) {
        // An item-only notification leaves Explorer's old executable icon cached.
        // Invalidate through the shell API, without deleting caches or restarting Explorer.
        SHChangeNotify(0x08000000, 0x1000, null, IntPtr.Zero); // ASSOCCHANGED | FLUSH
        SHChangeNotify(0x2000, 0x1005, executable, IntPtr.Zero); // UPDATEITEM, PATHW | FLUSH
        SHChangeNotify(0x1000, 0x1005, Path.GetDirectoryName(executable), IntPtr.Zero); // UPDATEDIR
    }
}
"@
[WatchPartyShellIcon]::Refresh($executablePath)
Write-Output 'Refreshed the executable icon in Windows Explorer.'
