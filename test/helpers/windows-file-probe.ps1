param([Parameter(Mandatory = $true)][string]$Path,
      [Parameter(Mandatory = $true)][string]$Target,
      [switch]$WaitForSignal)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class HccFileProbe {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle handle, uint code, byte[] input, int inputLength, IntPtr output, int outputLength, out int returned, IntPtr overlapped);
    public static SafeFileHandle Open(string path) {
        var handle = CreateFileW(path, 0x100, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return handle;
    }
    public static int SetJunction(SafeFileHandle handle, string target) {
        byte[] substitute = Encoding.Unicode.GetBytes("\\??\\" + target);
        byte[] display = Encoding.Unicode.GetBytes(target);
        byte[] data = new byte[16 + substitute.Length + 2 + display.Length + 2];
        Array.Copy(BitConverter.GetBytes(0xA0000003u), 0, data, 0, 4);
        Array.Copy(BitConverter.GetBytes((ushort)(data.Length - 8)), 0, data, 4, 2);
        Array.Copy(BitConverter.GetBytes((ushort)substitute.Length), 0, data, 10, 2);
        Array.Copy(BitConverter.GetBytes((ushort)(substitute.Length + 2)), 0, data, 12, 2);
        Array.Copy(BitConverter.GetBytes((ushort)display.Length), 0, data, 14, 2);
        Array.Copy(substitute, 0, data, 16, substitute.Length);
        Array.Copy(display, 0, data, 18 + substitute.Length, display.Length);
        int returned;
        return DeviceIoControl(handle, 0x900A4, data, data.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero) ? 0 : Marshal.GetLastWin32Error();
    }
}
'@
$probeHandle = [HccFileProbe]::Open($Path)
try {
    [Console]::Out.WriteLine('{"ready":true}')
    [Console]::Out.Flush()
    if ($WaitForSignal -and [Console]::ReadLine() -ne 'GO') { throw 'Missing probe authorization' }
    $probeError = [HccFileProbe]::SetJunction($probeHandle, $Target)
    [Console]::Out.WriteLine(('{"win32Error":' + $probeError + '}'))
} finally {
    $probeHandle.Dispose()
}
