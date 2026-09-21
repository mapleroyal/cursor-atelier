import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WINDOWS_CURSOR_ROLES } from "./windows-cursor-theme.js";

const CURSOR_SLOTS = Object.keys(WINDOWS_CURSOR_ROLES);
const SNAPSHOT_NAMES = [...CURSOR_SLOTS, "", "Scheme Source"];
export function validateWindowsCursorSnapshot(snapshot) {
  const registryValue = ({ kind, value }) => {
    switch (kind) {
      case "String":
      case "ExpandString":
        return typeof value === "string";
      case "DWord":
        return (
          Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
        );
      case "QWord":
        return Number.isSafeInteger(value);
      case "MultiString":
        return (
          Array.isArray(value) &&
          value.every((part) => typeof part === "string")
        );
      case "Binary":
      case "None":
        return (
          Array.isArray(value) &&
          value.every(
            (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
          )
        );
      default:
        return false;
    }
  };
  if (
    snapshot?.kind !== "windows" ||
    !Number.isInteger(snapshot.session) ||
    snapshot.session < 1 ||
    !Number.isInteger(snapshot.cursorSize) ||
    snapshot.cursorSize < 16 ||
    snapshot.cursorSize > 256 ||
    !Array.isArray(snapshot.values) ||
    snapshot.values.length !== SNAPSHOT_NAMES.length ||
    SNAPSHOT_NAMES.some((name) => {
      const entries = snapshot.values.filter((entry) => entry?.name === name);
      if (entries.length !== 1 || typeof entries[0].exists !== "boolean") {
        return true;
      }
      const entry = entries[0];
      return entry.exists
        ? !registryValue(entry)
        : entry.kind !== null || entry.value !== null;
    }) ||
    CURSOR_SLOTS.some(
      (slot) =>
        !Number.isInteger(snapshot.sizes?.[slot]) ||
        snapshot.sizes[slot] < 1 ||
        snapshot.sizes[slot] > 256,
    ) ||
    ["Arrow", "IBeam", "Hand"].some(
      (slot) =>
        typeof snapshot.fingerprints?.[slot] !== "string" ||
        !/^[1-9]\d{0,3}:[1-9]\d{0,3}:\d{1,4}:\d{1,4}:[A-Za-z0-9+/]{43}=$/.test(
          snapshot.fingerprints[slot],
        ),
    )
  ) {
    throw new TypeError(
      "The original Windows cursor snapshot is invalid; the desktop was not changed.",
    );
  }
}

const NATIVE = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class AtelierCursor {
  [StructLayout(LayoutKind.Sequential)] public struct IconInfo { public bool Icon; public uint X; public uint Y; public IntPtr Mask; public IntPtr Color; }
  [DllImport("user32.dll", SetLastError=true)] static extern bool SystemParametersInfoW(uint action, uint param, IntPtr data, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadImageW(IntPtr instance, string file, uint type, int x, int y, uint flags);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr LoadCursorW(IntPtr instance, IntPtr id);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetSystemCursor(IntPtr cursor, uint id);
  [DllImport("user32.dll")] static extern bool DestroyCursor(IntPtr cursor);
  [DllImport("user32.dll", SetLastError=true)] static extern bool GetIconInfo(IntPtr cursor, out IconInfo info);
  [DllImport("user32.dll", SetLastError=true)] static extern bool DrawIconEx(IntPtr dc, int x, int y, IntPtr icon, int width, int height, uint frame, IntPtr brush, uint flags);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  public static bool Interactive { get { return Environment.UserInteractive && Process.GetCurrentProcess().SessionId != 0; } }
  public static int Session { get { return Process.GetCurrentProcess().SessionId; } }
  public static int Size { get { return GetSystemMetrics(13); } }
  static Exception Error(string operation) { int code=Marshal.GetLastWin32Error(); return new Win32Exception(code, operation + " (Win32 error " + code + ")"); }
  public static void Reload() { if (!SystemParametersInfoW(0x57, 0, IntPtr.Zero, 2)) throw Error("Could not reload the Windows cursor scheme."); }
  static IntPtr Open(string file, int size) {
    IntPtr handle = LoadImageW(IntPtr.Zero, file, 2, size, size, 0x10);
    if (handle == IntPtr.Zero) throw Error("Windows could not decode " + file);
    return handle;
  }
  public static void Validate(string file, int size) { IntPtr handle=Open(file,size); DestroyCursor(handle); }
  public static void Apply(string file, uint id, int size) {
    IntPtr handle=Open(file,size);
    if (!SetSystemCursor(handle,id)) { var error=Error("Could not replace Windows cursor " + id); DestroyCursor(handle); throw error; }
  }
  static string Fingerprint(IntPtr handle) {
    if (handle == IntPtr.Zero) throw Error("The Windows cursor handle is unavailable.");
    IconInfo info;
    if (!GetIconInfo(handle,out info)) throw Error("Could not inspect the Windows cursor.");
    try {
      int width,height;
      using (Bitmap bitmap=Image.FromHbitmap(info.Color != IntPtr.Zero ? info.Color : info.Mask)) { width=bitmap.Width; height=info.Color != IntPtr.Zero ? bitmap.Height : bitmap.Height/2; }
      if (width<1 || height<1 || width>1024 || height>1024) throw new InvalidOperationException("Unexpected Windows cursor geometry.");
      byte[] bytes=new byte[width*height*4*2];
      for (int pass=0;pass<2;pass++) {
        using (Bitmap bitmap=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
          using (Graphics graphics=Graphics.FromImage(bitmap)) {
            graphics.Clear(pass==0 ? Color.Black : Color.White);
            IntPtr dc=graphics.GetHdc();
            try { if (!DrawIconEx(dc,0,0,handle,width,height,0,IntPtr.Zero,3)) throw Error("Could not render the Windows cursor."); }
            finally { graphics.ReleaseHdc(dc); }
          }
          BitmapData data=bitmap.LockBits(new Rectangle(0,0,width,height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
          try { for (int y=0;y<height;y++) Marshal.Copy(IntPtr.Add(data.Scan0,y*data.Stride),bytes,pass*width*height*4+y*width*4,width*4); }
          finally { bitmap.UnlockBits(data); }
        }
      }
      using (SHA256 digest=SHA256.Create()) { return width+":"+height+":"+info.X+":"+info.Y+":"+Convert.ToBase64String(digest.ComputeHash(bytes)); }
    } finally { if(info.Mask!=IntPtr.Zero) DeleteObject(info.Mask); if(info.Color!=IntPtr.Zero) DeleteObject(info.Color); }
  }
  public static string Current(int id) { return Fingerprint(LoadCursorW(IntPtr.Zero,new IntPtr(id))); }
  public static string File(string file,int size) { IntPtr handle=Open(file,size); try { return Fingerprint(handle); } finally { DestroyCursor(handle); } }
}
`;

const POWERSHELL = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
try {
  $request=[Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('NATIVE_SOURCE'))) -ReferencedAssemblies System.Drawing
  $ids=[ordered]@{Arrow=32512;Help=32651;AppStarting=32650;Wait=32514;Crosshair=32515;IBeam=32513;No=32648;SizeNS=32645;SizeWE=32644;SizeNWSE=32642;SizeNESW=32643;SizeAll=32646;UpArrow=32516;Hand=32649}
  $names=@($ids.Keys)+@('','Scheme Source')
  $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Control Panel\Cursors',$request.operation -in @('apply','restore'))
  if ($null -eq $key) { throw 'The Windows cursor settings are unavailable.' }
  function Read-Values {
    $existing=@($key.GetValueNames())
    $values=@()
    foreach($name in $names) {
      $exists=$existing -contains $name
      $kind=$null; $value=$null
      if($exists) { $kind=$key.GetValueKind($name).ToString(); $value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
      $values+=@{name=$name;exists=$exists;kind=$kind;value=$value}
    }
    return ,$values
  }
  function Fingerprints {
    $result=@{}
    if([AtelierCursor]::Interactive) { foreach($slot in @('Arrow','IBeam','Hand')) { $result[$slot]=[AtelierCursor]::Current($ids[$slot]) } }
    return $result
  }
  function Cursor-Sizes {
    $result=@{}
    foreach($slot in $ids.Keys) { $result[$slot]=[int]([AtelierCursor]::Current($ids[$slot]).Split(':')[0]) }
    return $result
  }
  function Assert-Interactive { if(-not [AtelierCursor]::Interactive) { throw 'Cursor changes require an interactive Windows desktop session.' } }
  function Assert-Files {
    if(@($request.theme.files.PSObject.Properties).Count -ne $ids.Count -or $request.theme.size -lt 1 -or $request.theme.size -gt 256) { throw 'Invalid Windows cursor theme.' }
    foreach($slot in $ids.Keys) {
      $file=[string]$request.theme.files.$slot
      if(-not [IO.Path]::IsPathRooted($file) -or [IO.Path]::GetExtension($file) -notin @('.cur','.ani')) { throw 'Invalid Windows cursor file.' }
      [AtelierCursor]::Validate($file,0)
    }
  }
  function Matches-Theme {
    if(-not [AtelierCursor]::Interactive) { return $false }
    foreach($slot in $ids.Keys) {
      if([string]$key.GetValue($slot) -ine [string]$request.theme.files.$slot) { return $false }
    }
    foreach($slot in @('Arrow','IBeam','Hand')) {
      if([AtelierCursor]::Current($ids[$slot]) -cne [AtelierCursor]::File($request.theme.files.$slot,0)) { return $false }
    }
    return $true
  }
  switch($request.operation) {
    'read' { $result=@{kind='windows';supported=[AtelierCursor]::Interactive;session=[AtelierCursor]::Session;cursorSize=[AtelierCursor]::Size;values=(Read-Values)} }
    'capture' { Assert-Interactive; $result=@{kind='windows';session=[AtelierCursor]::Session;cursorSize=[AtelierCursor]::Size;values=(Read-Values);fingerprints=(Fingerprints);sizes=(Cursor-Sizes)} }
    'matches' { Assert-Files; $result=@{matches=(Matches-Theme)} }
    'apply' {
      Assert-Interactive; Assert-Files
      foreach($slot in $ids.Keys) { $key.SetValue($slot,[string]$request.theme.files.$slot,[Microsoft.Win32.RegistryValueKind]::String) }
      $key.SetValue('','',[Microsoft.Win32.RegistryValueKind]::String)
      $key.SetValue('Scheme Source',0,[Microsoft.Win32.RegistryValueKind]::DWord)
      $key.Flush()
      [AtelierCursor]::Reload()
      # Explicit file dimensions preserve per-theme size without overwriting
      # Windows Accessibility preferences. The saved scheme survives logoff.
      foreach($slot in $ids.Keys) { [AtelierCursor]::Apply($request.theme.files.$slot,$ids[$slot],0) }
      if(-not (Matches-Theme)) { throw 'The applied Windows cursor images could not be verified.' }
      $result=@{applied=$true}
    }
    'restore' {
      Assert-Interactive
      if($request.snapshot.kind -ne 'windows' -or @($request.snapshot.values).Count -ne $names.Count) { throw 'Invalid original Windows cursor snapshot.' }
      foreach($name in $names) {
        $saved=@($request.snapshot.values | Where-Object {$_.name -ceq $name})
        if($saved.Count -ne 1) { throw 'Invalid Windows cursor snapshot values.' }
        $entry=$saved[0]
        if($entry.exists) {
          $kind=[Microsoft.Win32.RegistryValueKind]::$($entry.kind)
          $value=switch($entry.kind) {
            'DWord' { [int]$entry.value }
            'QWord' { [long]$entry.value }
            'Binary' { ,([byte[]]$entry.value) }
            'None' { ,([byte[]]$entry.value) }
            'MultiString' { ,([string[]]$entry.value) }
            default { [string]$entry.value }
          }
          $key.SetValue($name,$value,$kind)
        } else { $key.DeleteValue($name,$false) }
      }
      $key.Flush(); [AtelierCursor]::Reload()
      if($request.snapshot.cursorSize -eq [AtelierCursor]::Size) {
        foreach($slot in $ids.Keys) {
          $file=[string]$key.GetValue($slot)
          $size=[int]$request.snapshot.sizes.$slot
          if($file -and $size -ge 1 -and $size -le 256 -and $key.GetValueKind($slot).ToString() -in @('String','ExpandString')) { [AtelierCursor]::Apply([Environment]::ExpandEnvironmentVariables($file),$ids[$slot],$size) }
        }
      }
      $actual=Read-Values
      foreach($entry in $request.snapshot.values) {
        $current=@($actual | Where-Object {$_.name -ceq $entry.name})[0]
        if($current.exists -ne $entry.exists -or $current.kind -ne $entry.kind -or (ConvertTo-Json -InputObject $current.value -Compress -Depth 4) -cne (ConvertTo-Json -InputObject $entry.value -Compress -Depth 4)) { throw 'The restored Windows cursor settings could not be verified.' }
      }
      # In the same desktop geometry, also attest the actual saved cursor pixels.
      if($request.snapshot.session -eq [AtelierCursor]::Session -and $request.snapshot.cursorSize -eq [AtelierCursor]::Size) {
        foreach($slot in @('Arrow','IBeam','Hand')) { if($request.snapshot.fingerprints.$slot -cne [AtelierCursor]::Current($ids[$slot])) { throw "The original $slot cursor image could not be restored." } }
      }
      $result=@{restored=$true}
    }
    'open-settings' { Start-Process explorer.exe -ArgumentList 'ms-settings:startupapps'; $result=@{opened=$true} }
    default { throw 'Unknown Windows cursor desktop operation.' }
  }
  $key.Dispose()
  $result | ConvertTo-Json -Depth 12 -Compress
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;

export function runWindowsCursorCommand(
  command,
  arguments_,
  options = {},
  input,
) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      arguments_,
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        ...options,
      },
      (cause, stdout, stderr) => {
        if (!cause) {
          return resolve(stdout.trim());
        }
        const error = new Error(String(stderr || cause.message).trim(), {
          cause,
        });
        error.code = "WINDOWS_CURSOR_ERROR";
        reject(error);
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

export function createWindowsCursorDesktop({
  runCommand = runWindowsCursorCommand,
} = {}) {
  let session = null;
  async function invoke(request) {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cursor-atelier-native-"),
    );
    const scriptPath = path.join(directory, "desktop.ps1");
    try {
      await fs.writeFile(
        scriptPath,
        `\ufeff${POWERSHELL.replace("NATIVE_SOURCE", Buffer.from(NATIVE).toString("base64"))}`,
      );
      const powershell = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      return JSON.parse(
        await runCommand(
          powershell,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
          ],
          {},
          JSON.stringify(request),
        ),
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  const checkTheme = (theme) => {
    if (
      !theme ||
      !Number.isInteger(theme.size) ||
      theme.size < 1 ||
      theme.size > 256 ||
      Object.keys(theme.files ?? {}).length !==
        Object.keys(WINDOWS_CURSOR_ROLES).length ||
      Object.keys(WINDOWS_CURSOR_ROLES).some(
        (slot) => !path.isAbsolute(theme.files[slot] ?? ""),
      )
    ) {
      throw new TypeError("Invalid Windows cursor theme.");
    }
  };
  return {
    kind: "windows",
    get session() {
      return session;
    },
    async read() {
      const result = await invoke({ operation: "read" });
      session = result.session;
      return result;
    },
    async requireSupported() {
      if (!(await this.read()).supported) {
        const error = new Error(
          "Cursor changes require an interactive Windows desktop session.",
        );
        error.code = "WINDOWS_DESKTOP_UNAVAILABLE";
        throw error;
      }
    },
    async capture() {
      const result = await invoke({ operation: "capture" });
      validateWindowsCursorSnapshot(result);
      session = result.session;
      return result;
    },
    async apply(theme) {
      checkTheme(theme);
      return invoke({ operation: "apply", theme });
    },
    async restore(snapshot) {
      validateWindowsCursorSnapshot(snapshot);
      return invoke({ operation: "restore", snapshot });
    },
    async matches(theme) {
      checkTheme(theme);
      return (await invoke({ operation: "matches", theme })).matches === true;
    },
    async openSettings() {
      return invoke({ operation: "open-settings" });
    },
  };
}
