# win32.ps1 — encaixa (reparent) janelas do Chrome no host e as posiciona.
# DOIS modos:
#   -server : fica VIVO, compila o Add-Type UMA vez e atende comandos (1 JSON por
#             linha no stdin -> 1 JSON por linha no stdout). Mata a latencia de
#             ~1s por troca (spawn+recompilacao) que travava as trocas de tela.
#   (sem)   : modo antigo one-shot (le stdin inteiro, faz uma vez) — fallback.
# Comandos (JSON):
#   { hostHwnd, topPx, leftPx, mode, solo, hwnds:[...] | profiles:[...] } -> {hwnds:[...]}
#   { refocus:true, hostHwnd, focusHwnd }                                 -> {ok:true}
# mode: 'grid' | 'columns' (lado a lado) | 'rows' (empilhado). solo: indice (-1=todas).

param([switch]$server)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

function Log($m){ [Console]::Error.WriteLine($m) }

$script:psTid = [W]::GetCurrentThreadId()
$GWL_STYLE=-16; $WS_CHILD=0x40000000; $WS_POPUP=-2147483648
$WS_CAPTION=0x00C00000; $WS_THICKFRAME=0x00040000; $WS_BORDER=0x00800000
$SWP_FRAMECHANGED=0x0020; $SWP_NOZORDER=0x0004; $SWP_SHOWWINDOW=0x0040; $SWP_HIDEWINDOW=0x0080

# FOCO DE TECLADO cross-process: SetFocus so vale se a thread chamadora (este PS)
# estiver anexada as filas do host E do child. Anexa temporario, foca, desanexa.
function FocusChild($wh, $childTid){
  [void][W]::SetForegroundWindow($script:hostH)
  [void][W]::AttachThreadInput($script:psTid,$script:hostTid,$true)
  [void][W]::AttachThreadInput($script:psTid,$childTid,$true)
  [void][W]::SetFocus($wh)
  [void][W]::AttachThreadInput($script:psTid,$childTid,$false)
  [void][W]::AttachThreadInput($script:psTid,$script:hostTid,$false)
}

# faz UM comando e devolve um hashtable (que vira JSON)
function DoWork($cfg){
  $script:hostH = [IntPtr]([int64]$cfg.hostHwnd)
  $hpid = 0
  $script:hostTid = [W]::GetWindowThreadProcessId($script:hostH, [ref]$hpid)

  # modo REFOCUS: so devolve foco/ativacao a janela visivel (volta do alt-tab)
  if (($cfg.PSObject.Properties.Name -contains 'refocus') -and $cfg.refocus) {
    $target = [IntPtr]([int64]$cfg.focusHwnd)
    if ($target -ne [IntPtr]::Zero) {
      $cpid = 0; $ctid = [W]::GetWindowThreadProcessId($target, [ref]$cpid)
      FocusChild $target $ctid
    }
    return @{ ok = $true }
  }

  # area util
  $r = New-Object 'W+RECT'; [void][W]::GetClientRect($script:hostH, [ref]$r)
  $top=[int]$cfg.topPx; $left=[int]$cfg.leftPx
  $ax=$left; $ay=$top; $aw=($r.Right-$r.Left)-$left; $ah=($r.Bottom-$r.Top)-$top

  # resolve handles (por hwnd direto, ou descobre pelo perfil)
  $handles=@()
  if($cfg.PSObject.Properties.Name -contains 'hwnds' -and $cfg.hwnds){
    foreach($h in $cfg.hwnds){ $handles += [IntPtr]([int64]$h) }
  } else {
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

  if($mode -eq 'columns'){ $cols=$n; $rows=1 }
  elseif($mode -eq 'rows'){ $cols=1; $rows=$n }
  else { $cols=[math]::Ceiling([math]::Sqrt($n)); $rows=[math]::Ceiling($n/$cols) }
  if($cols -lt 1){$cols=1}; if($rows -lt 1){$rows=1}
  $cw=[math]::Floor($aw/$cols); $ch=[math]::Floor($ah/$rows)

  $placed=@()
  $i=0
  foreach($wh in $handles){
    if($wh -eq [IntPtr]::Zero){ $i++; continue }
    $style=[int][W]::GetWindowLong($wh,$GWL_STYLE)
    $style=$style -band (-bnot $WS_CAPTION) -band (-bnot $WS_THICKFRAME) -band (-bnot $WS_BORDER) -band (-bnot $WS_POPUP)
    $style=$style -bor $WS_CHILD
    [void][W]::SetWindowLong($wh,$GWL_STYLE,$style)
    [void][W]::SetParent($wh,$script:hostH)

    # childTid so pra passar ao FocusChild (que faz attach TEMPORARIO da thread do PS).
    # NAO fazer AttachThreadInput host<->child PERMANENTE aqui: grudar as filas de
    # input pra sempre trava TODO input (mouse+teclado) do painel ao voltar do alt-tab
    # (a fila compartilhada fica sem "janela ativa"; so destrava clicando no host).
    # FocusChild ja entrega o foco de teclado sem esse efeito colateral.
    $childTid = 0
    try {
      $cpid = 0
      $childTid = [W]::GetWindowThreadProcessId($wh, [ref]$cpid)
    } catch { Log ("gettid fail: " + $_.Exception.Message) }

    if($solo -ge 0){
      if($i -eq $solo){
        [void][W]::SetWindowPos($wh,[IntPtr]::Zero,$ax,$ay,$aw,$ah,($SWP_FRAMECHANGED -bor $SWP_NOZORDER -bor $SWP_SHOWWINDOW))
        FocusChild $wh $childTid
      } else {
        [void][W]::SetWindowPos($wh,[IntPtr]::Zero,0,0,0,0,($SWP_NOZORDER -bor $SWP_HIDEWINDOW))
      }
    } else {
      $cx=$ax + ($i % $cols)*$cw
      $cy=$ay + [math]::Floor($i/$cols)*$ch
      [void][W]::SetWindowPos($wh,[IntPtr]::Zero,[int]$cx,[int]$cy,[int]$cw,[int]$ch,($SWP_FRAMECHANGED -bor $SWP_NOZORDER -bor $SWP_SHOWWINDOW))
      if($n -eq 1){ FocusChild $wh $childTid }
    }
    $placed += $wh.ToInt64().ToString()
    $i++
  }
  return @{ hwnds = @($placed) }
}

if($server){
  # SERVIDOR: 1 comando por linha no stdin -> 1 resposta por linha no stdout
  $line = [Console]::In.ReadLine()
  while($line -ne $null){
    if($line.Trim().Length -gt 0){
      try { $cfg = $line | ConvertFrom-Json; $res = DoWork $cfg }
      catch { $res = @{ error = "$($_.Exception.Message)" } }
      [Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
      [Console]::Out.Flush()
    }
    $line = [Console]::In.ReadLine()
  }
} else {
  # ONE-SHOT (fallback)
  $ErrorActionPreference = 'Stop'
  $cfg = ([Console]::In.ReadToEnd()) | ConvertFrom-Json
  (DoWork $cfg) | ConvertTo-Json -Compress
}
