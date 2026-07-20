# popupwatch.ps1 — acha popups do Chrome dos NOSSOS perfis (ex: login do Google)
# que estao soltos por cima, e traz cada um pra frente + centraliza (uma vez).
# Entrada (stdin): { known: ["hwnd int64", ...] }  -> ja tratados, nao mexer
# Saida (stdout): { popups: ["hwnd", ...] }  -> todos os popups atuais

$ErrorActionPreference = 'SilentlyContinue'
$cfg = ([Console]::In.ReadToEnd()) | ConvertFrom-Json
$known = @{}
if($cfg.known){ foreach($k in $cfg.known){ $known[[string]$k] = $true } }

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WP {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static List<IntPtr> Find(uint[] pids){
    var set = new HashSet<uint>(pids);
    var res = new List<IntPtr>();
    EnumWindows((h,l)=>{
      if(!IsWindowVisible(h)) return true;
      if(GetParent(h) != IntPtr.Zero) return true;         // so janelas de topo (popup solto)
      uint p; GetWindowThreadProcessId(h, out p);
      if(!set.Contains(p)) return true;
      int len = GetWindowTextLength(h);
      if(len == 0) return true;
      var sb = new System.Text.StringBuilder(len+1);
      GetWindowText(h, sb, sb.Capacity);
      if(sb.ToString().Contains("Poke Idle")) return true;  // ignora a janela principal do jogo
      res.Add(h);
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
"@

$ourPids = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like '*poke-multi-labs*' } | ForEach-Object { [uint32]$_.ProcessId })
if($ourPids.Count -eq 0){ '{"popups":[]}'; return }

Add-Type -AssemblyName System.Windows.Forms
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$HWND_TOPMOST=[IntPtr](-1); $HWND_NOTOPMOST=[IntPtr](-2)
$SWP_NOSIZE=0x0001; $SWP_NOMOVE=0x0002; $SWP_SHOWWINDOW=0x0040

$cur = @()
foreach($h in [WP]::Find([uint32[]]$ourPids)){
  $id = $h.ToInt64().ToString()
  $cur += $id
  if(-not $known.ContainsKey($id)){
    $r = New-Object 'WP+RECT'; [void][WP]::GetWindowRect($h,[ref]$r)
    $w = $r.Right-$r.Left; $ht = $r.Bottom-$r.Top
    $x = $wa.X + [int](($wa.Width - $w)/2)
    $y = $wa.Y + [int](($wa.Height - $ht)/2)
    [void][WP]::SetWindowPos($h,$HWND_TOPMOST,$x,$y,0,0,($SWP_NOSIZE -bor $SWP_SHOWWINDOW))
    [void][WP]::SetWindowPos($h,$HWND_NOTOPMOST,0,0,0,0,($SWP_NOSIZE -bor $SWP_NOMOVE))
    [void][WP]::BringWindowToTop($h)
    [void][WP]::SetForegroundWindow($h)
  }
}
@{ popups = $cur } | ConvertTo-Json -Compress
