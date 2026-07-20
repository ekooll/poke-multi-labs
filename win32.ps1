# win32.ps1 — encaixa (reparent) janelas do Chrome no host e as posiciona.
# Entrada JSON (stdin):
#   { hostHwnd, topPx, leftPx, mode, solo, pids:[int...] }   (1a vez: descobre pelos pids)
#   { hostHwnd, topPx, leftPx, mode, solo, hwnds:["int64"...] } (relayout: usa handles)
# mode: 'grid' | 'columns' (lado a lado) | 'rows' (empilhado)
# solo: indice (0..n-1) pra mostrar SO essa em tela cheia; -1 = mostra todas
# Saida (stdout): JSON { hwnds:["int64",...] } na ordem. Debug -> stderr.

$ErrorActionPreference = 'Stop'
$cfg = ([Console]::In.ReadToEnd()) | ConvertFrom-Json

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

function Log($m){ [Console]::Error.WriteLine($m) }

$hostH = [IntPtr]([int64]$cfg.hostHwnd)
$GWL_STYLE=-16; $WS_CHILD=0x40000000; $WS_POPUP=-2147483648
$WS_CAPTION=0x00C00000; $WS_THICKFRAME=0x00040000; $WS_BORDER=0x00800000
$SWP_FRAMECHANGED=0x0020; $SWP_NOZORDER=0x0004; $SWP_SHOWWINDOW=0x0040; $SWP_HIDEWINDOW=0x0080

# area util
$r = New-Object 'W+RECT'; [void][W]::GetClientRect($hostH, [ref]$r)
$top=[int]$cfg.topPx; $left=[int]$cfg.leftPx
$ax=$left; $ay=$top; $aw=($r.Right-$r.Left)-$left; $ah=($r.Bottom-$r.Top)-$top

# resolve handles
$handles=@()
if($cfg.PSObject.Properties.Name -contains 'hwnds' -and $cfg.hwnds){
  foreach($h in $cfg.hwnds){ $handles += [IntPtr]([int64]$h) }
} else {
  # descobre a janela PELO PERFIL (imune a handoff do Chrome):
  # acha o processo chrome cujo command line tem o caminho do perfil e ja tem janela.
  foreach($prof in $cfg.profiles){
    $wh=[IntPtr]::Zero
    for($t=0;$t -lt 60;$t++){
      $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" |
               Where-Object { $_.CommandLine -like "*$prof*" }
      foreach($pr in $procs){
        try{ $pp=Get-Process -Id $pr.ProcessId -ErrorAction Stop
             if($pp.MainWindowHandle -ne [IntPtr]::Zero){ $wh=$pp.MainWindowHandle; break } }catch{}
      }
      if($wh -ne [IntPtr]::Zero){ break }
      Start-Sleep -Milliseconds 150
    }
    if($wh -eq [IntPtr]::Zero){ Log "profile $prof sem janela"; continue }
    $handles += $wh
  }
}

$n=$handles.Count
$solo=[int]$cfg.solo
$mode="$($cfg.mode)"

# calcula grade
if($mode -eq 'columns'){ $cols=$n; $rows=1 }
elseif($mode -eq 'rows'){ $cols=1; $rows=$n }
else { $cols=[math]::Ceiling([math]::Sqrt($n)); $rows=[math]::Ceiling($n/$cols) }
if($cols -lt 1){$cols=1}; if($rows -lt 1){$rows=1}
$cw=[math]::Floor($aw/$cols); $ch=[math]::Floor($ah/$rows)

$placed=@()
$i=0
foreach($wh in $handles){
  if($wh -eq [IntPtr]::Zero){ $i++; continue }
  # garante filho sem borda/titulo do SO
  $style=[int][W]::GetWindowLong($wh,$GWL_STYLE)
  $style=$style -band (-bnot $WS_CAPTION) -band (-bnot $WS_THICKFRAME) -band (-bnot $WS_BORDER) -band (-bnot $WS_POPUP)
  $style=$style -bor $WS_CHILD
  [void][W]::SetWindowLong($wh,$GWL_STYLE,$style)
  [void][W]::SetParent($wh,$hostH)

  if($solo -ge 0){
    if($i -eq $solo){
      [void][W]::SetWindowPos($wh,[IntPtr]::Zero,$ax,$ay,$aw,$ah,($SWP_FRAMECHANGED -bor $SWP_NOZORDER -bor $SWP_SHOWWINDOW))
    } else {
      [void][W]::SetWindowPos($wh,[IntPtr]::Zero,0,0,0,0,($SWP_NOZORDER -bor $SWP_HIDEWINDOW))
    }
  } else {
    $cx=$ax + ($i % $cols)*$cw
    $cy=$ay + [math]::Floor($i/$cols)*$ch
    [void][W]::SetWindowPos($wh,[IntPtr]::Zero,[int]$cx,[int]$cy,[int]$cw,[int]$ch,($SWP_FRAMECHANGED -bor $SWP_NOZORDER -bor $SWP_SHOWWINDOW))
  }
  $placed += $wh.ToInt64().ToString()
  $i++
}

@{ hwnds=$placed } | ConvertTo-Json -Compress
