param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [string]$Image
)
$ErrorActionPreference = 'Stop'
if (-not $Image) { $Image = Join-Path (Split-Path -Parent $PSScriptRoot) 'public\icon-512.png' }
# Use Windows resource APIs before SEA injection; no extra packaging dependency is needed.
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.IO;
using System.ComponentModel;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class WatchPartyIcon {
    delegate bool Names(IntPtr module, IntPtr type, IntPtr name, IntPtr param);
    delegate bool Languages(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr param);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool EnumResourceNames(IntPtr module, IntPtr type, Names callback, IntPtr param);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, Languages callback, IntPtr param);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool EndUpdateResource(IntPtr update, bool discard);
    sealed class Resource {
        public int Type; public object Name; public ushort Language;
    }
    static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static void Apply(string executable, string image) {
        var old = new List<Resource>();
        IntPtr module = LoadLibraryEx(executable, IntPtr.Zero, 2); // LOAD_LIBRARY_AS_DATAFILE; never execute target code.
        if (module == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            foreach (int type in new[] { 3, 14 }) { // RT_ICON and RT_GROUP_ICON only; preserve all other resources.
                var names = new List<object>();
                bool found = EnumResourceNames(module, (IntPtr)type, delegate(IntPtr m, IntPtr t, IntPtr n, IntPtr p) {
                    names.Add(n.ToInt64() <= 65535 ? (object)(int)n : Marshal.PtrToStringUni(n)); return true;
                }, IntPtr.Zero);
                if (!found && Marshal.GetLastWin32Error() != 1813) Check(false); // ERROR_RESOURCE_TYPE_NOT_FOUND
                foreach (object name in names) {
                    IntPtr n = name is string ? Marshal.StringToHGlobalUni((string)name) : (IntPtr)(int)name;
                    try {
                        Check(EnumResourceLanguages(module, (IntPtr)type, n, delegate(IntPtr m, IntPtr t, IntPtr id, ushort language, IntPtr p) {
                            old.Add(new Resource { Type = type, Name = name, Language = language }); return true;
                        }, IntPtr.Zero));
                    } finally { if (name is string) Marshal.FreeHGlobal(n); }
                }
            }
        } finally { FreeLibrary(module); }
        int[] sizes = { 16, 24, 32, 48, 64, 128, 256 };
        var images = new List<byte[]>();
        using (var source = Image.FromFile(image)) foreach (int size in sizes) {
            using (var bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb))
            using (var graphics = Graphics.FromImage(bitmap))
            using (var png = new MemoryStream()) {
                graphics.CompositingMode = CompositingMode.SourceCopy;
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.DrawImage(source, 0, 0, size, size);
                bitmap.Save(png, ImageFormat.Png); images.Add(png.ToArray());
            }
        }
        IntPtr update = BeginUpdateResource(executable, false);
        if (update == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        bool commit = false;
        try {
            foreach (Resource r in old) {
                IntPtr name = r.Name is string ? Marshal.StringToHGlobalUni((string)r.Name) : (IntPtr)(int)r.Name;
                try { Check(UpdateResource(update, (IntPtr)r.Type, name, r.Language, null, 0)); }
                finally { if (r.Name is string) Marshal.FreeHGlobal(name); }
            }
            using (var group = new MemoryStream()) using (var writer = new BinaryWriter(group)) {
                writer.Write((ushort)0); writer.Write((ushort)1); writer.Write((ushort)sizes.Length);
                for (int i = 0; i < sizes.Length; i++) {
                    byte dimension = (byte)(sizes[i] == 256 ? 0 : sizes[i]);
                    writer.Write(dimension); writer.Write(dimension); writer.Write((ushort)0);
                    writer.Write((ushort)1); writer.Write((ushort)32);
                    writer.Write((uint)images[i].Length); writer.Write((ushort)(i + 1));
                    Check(UpdateResource(update, (IntPtr)3, (IntPtr)(i + 1), 0, images[i], (uint)images[i].Length));
                }
                byte[] data = group.ToArray();
                Check(UpdateResource(update, (IntPtr)14, (IntPtr)1, 0, data, (uint)data.Length));
            }
            commit = true;
        } finally { Check(EndUpdateResource(update, !commit)); }
    }
}
"@
[WatchPartyIcon]::Apply([IO.Path]::GetFullPath($Executable), [IO.Path]::GetFullPath($Image))
Write-Output 'Embedded Watch Party icon (16, 24, 32, 48, 64, 128 and 256 pixels).'
