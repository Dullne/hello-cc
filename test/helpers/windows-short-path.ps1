param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class HccShortPath {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetShortPathNameW(string path, StringBuilder output, uint length);
    public static string Read(string path) {
        var output = new StringBuilder(32768);
        uint length = GetShortPathNameW(path, output, 32768);
        if (length == 0 || length >= 32768) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return output.ToString();
    }
}
'@
[Console]::Out.WriteLine([HccShortPath]::Read($Path))
