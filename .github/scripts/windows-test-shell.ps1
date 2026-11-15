param([Parameter(Mandatory = $true, Position = 0)][string]$StepPath)

$ErrorActionPreference = 'Stop'
# GitHub's elevated Windows token may default newly created files to the
# Administrators owner. Keep HCC's current-user ownership policy: adjust only
# this shell's default owner before it launches the step and its children.
# No token privilege/group, existing file, ACL, or machine setting is changed.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class HccCiTokenOwner {
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int length, out int needed);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr token, int kind, IntPtr data, int length);
  static IntPtr Read(IntPtr token, int kind) {
    int needed;
    GetTokenInformation(token, kind, IntPtr.Zero, 0, out needed);
    if (needed < 4 || needed > 65536) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr data = Marshal.AllocHGlobal(needed);
    if (!GetTokenInformation(token, kind, data, needed, out needed)) {
      int error = Marshal.GetLastWin32Error();
      Marshal.FreeHGlobal(data);
      throw new Win32Exception(error);
    }
    return data;
  }
  public static object Inspect() {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr user = IntPtr.Zero, owner = IntPtr.Zero, elevation = IntPtr.Zero;
    try {
      user = Read(token, 1); owner = Read(token, 4); elevation = Read(token, 20);
      return new {
        userSid = new SecurityIdentifier(Marshal.ReadIntPtr(user)).Value,
        ownerSid = new SecurityIdentifier(Marshal.ReadIntPtr(owner)).Value,
        elevated = Marshal.ReadInt32(elevation) != 0
      };
    } finally {
      foreach (IntPtr data in new[] {user, owner, elevation}) if (data != IntPtr.Zero) Marshal.FreeHGlobal(data);
      CloseHandle(token);
    }
  }
  public static void UseCurrentUserOwner() {
    IntPtr token;
    // TOKEN_QUERY | TOKEN_ADJUST_DEFAULT. The existing TokenUser is always an
    // eligible TokenOwner; changing privileges or enabling elevation is unnecessary.
    if (!OpenProcessToken(GetCurrentProcess(), 0x0008 | 0x0080, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
    IntPtr user = IntPtr.Zero, owner = IntPtr.Zero;
    try {
      user = Read(token, 1);
      owner = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(owner, Marshal.ReadIntPtr(user));
      if (!SetTokenInformation(token, 4, owner, IntPtr.Size)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      if (owner != IntPtr.Zero) Marshal.FreeHGlobal(owner);
      if (user != IntPtr.Zero) Marshal.FreeHGlobal(user);
      CloseHandle(token);
    }
  }
}
'@

$ownerLogRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$ownerLogDirectory = Join-Path $ownerLogRoot 'hcc-windows-token-owner'
[System.IO.Directory]::CreateDirectory($ownerLogDirectory) | Out-Null
$ownerLogPath = Join-Path $ownerLogDirectory "token-owner-$PID.json"
$ownerReceipt = [ordered]@{ before = [HccCiTokenOwner]::Inspect(); after = $null; adjusted = $false; verified = $false }
$ownerReceipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ownerLogPath -Encoding UTF8
Write-Output ('[hcc-token-owner] before ' + ($ownerReceipt.before | ConvertTo-Json -Compress))
try {
  if ($ownerReceipt.before.ownerSid -ne $ownerReceipt.before.userSid) {
    [HccCiTokenOwner]::UseCurrentUserOwner()
    $ownerReceipt.adjusted = $true
  }
  $ownerReceipt.after = [HccCiTokenOwner]::Inspect()
  if ($ownerReceipt.after.ownerSid -ne $ownerReceipt.after.userSid -or $ownerReceipt.after.userSid -ne $ownerReceipt.before.userSid) {
    throw 'The Windows test shell could not establish current-user default ownership.'
  }
  $ownerReceipt.verified = $true
} finally {
  $ownerReceipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ownerLogPath -Encoding UTF8
}
Write-Output ('[hcc-token-owner] verified ' + ($ownerReceipt | ConvertTo-Json -Depth 4 -Compress))

$global:LASTEXITCODE = 0
& $StepPath
exit $LASTEXITCODE
