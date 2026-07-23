# focuswatch.ps1 — FOCO AO CLICAR + REFOCO AO VOLTAR PRO APP.
# Roda em loop (spawnado 1x). Dois papeis:
#  1) Botao esquerdo pressionado sobre um painel -> da foco de teclado aquele Chrome
#     (resolve "so a conta em foco digita": qualquer painel clicado passa a digitar).
#  2) Quando o app VOLTA a ser a janela de primeiro plano (alt-tab de volta), reativa
#     a janela visivel -> conserta o "menu do jogo fica inclicavel ao voltar".
#
# Uso: powershell -File focuswatch.ps1 <hwnds.json>
# O host reescreve o hwnds.json ({host, hwnds:[...], active}) a cada mudanca de layout.

param([string]$File)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class F {
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO gti);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
    public int cbSize; public int flags;
    public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture;
    public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret; public RECT rcCaret;
  }
}
"@

$psTid = [F]::GetCurrentThreadId()

# ===== DIAGNOSTICO (temporario): dump do estado de input do Windows =====
$DiagFile = Join-Path $env:USERPROFILE '.poke-multi-labs\focusdiag.log'
function GtiStr($tid){
  $g = New-Object 'F+GUITHREADINFO'; $g.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($g)
  if([F]::GetGUIThreadInfo($tid,[ref]$g)){
    return ("active=0x{0:X} focus=0x{1:X} capture=0x{2:X}" -f $g.hwndActive.ToInt64(), $g.hwndFocus.ToInt64(), $g.hwndCapture.ToInt64())
  }
  return "gti-fail(tid=$tid)"
}
function Diag($tag, $hostH, $activeH){
  try {
    $fg = [F]::GetForegroundWindow()
    $hpid=0; $htid=[F]::GetWindowThreadProcessId($hostH,[ref]$hpid)
    $line = "[$tag] fg=0x{0:X} | FG-thread {1} | host-thread {2}" -f $fg.ToInt64(), (GtiStr 0), (GtiStr $htid)
    if($activeH -ne [IntPtr]::Zero){
      $cpid=0; $ctid=[F]::GetWindowThreadProcessId($activeH,[ref]$cpid)
      $line += " | game=0x{0:X} enabled={1} visible={2} | game-thread {3}" -f $activeH.ToInt64(), [F]::IsWindowEnabled($activeH), [F]::IsWindowVisible($activeH), (GtiStr $ctid)
    }
    Add-Content -LiteralPath $DiagFile -Value $line
  } catch { try { Add-Content -LiteralPath $DiagFile -Value "diag-err: $($_.Exception.Message)" } catch {} }
}

# foca o HOST (mimica o clique na sidebar que destrava). Usado na VOLTA do alt-tab:
# focar o child cross-process deixa o input em limbo (mouse+teclado mortos ate clicar
# no host). Focando o host, o clique seguinte no painel volta a funcionar normal.
function FocusHost($hostH){
  $hpid = 0; $hostTid = [F]::GetWindowThreadProcessId($hostH, [ref]$hpid)
  [void][F]::SetForegroundWindow($hostH)
  [void][F]::AttachThreadInput($psTid, $hostTid, $true)
  [void][F]::SetFocus($hostH)
  [void][F]::AttachThreadInput($psTid, $hostTid, $false)
}

# O NUCLEO DO FIX: a janela do jogo e um Chrome de OUTRO processo reparented como
# FILHO do host. Filho nao recebe WM_ACTIVATE/WM_ACTIVATEAPP do Windows, entao o
# Chromium do jogo nunca sabe que voltou a ser ativo (foreground pertence ao Electron)
# e ignora o input. Um clique real dispara esse ciclo (o "piscar"); aqui a gente
# forca as mesmas mensagens de ativacao direto na janela do jogo.
$WM_ACTIVATE=0x0006; $WM_NCACTIVATE=0x0086; $WM_ACTIVATEAPP=0x001C
$WA_ACTIVE=1; $WA_CLICKACTIVE=2
function ActivateGame($gameH, $hostTid){
  if($gameH -eq [IntPtr]::Zero){ return }
  [void][F]::PostMessage($gameH, $WM_ACTIVATEAPP, [IntPtr]$WA_ACTIVE, [IntPtr]([int64]$hostTid))
  [void][F]::PostMessage($gameH, $WM_NCACTIVATE, [IntPtr]$WA_ACTIVE, [IntPtr]::Zero)
  [void][F]::PostMessage($gameH, $WM_ACTIVATE,   [IntPtr]$WA_CLICKACTIVE, [IntPtr]::Zero)
}

# da foco de teclado/ativacao a $target (amarra as filas host<->child) — usado no CLIQUE
function FocusPane($hostH, $target){
  if($target -eq [IntPtr]::Zero){ return }
  $hpid = 0; $hostTid = [F]::GetWindowThreadProcessId($hostH, [ref]$hpid)
  $cpid = 0; $ctid = [F]::GetWindowThreadProcessId($target, [ref]$cpid)
  [void][F]::SetForegroundWindow($hostH)
  [void][F]::AttachThreadInput($psTid, $hostTid, $true)
  [void][F]::AttachThreadInput($psTid, $ctid, $true)
  [void][F]::SetFocus($target)
  [void][F]::AttachThreadInput($psTid, $ctid, $false)
  [void][F]::AttachThreadInput($psTid, $hostTid, $false)
}

$VK_LBUTTON = 0x01
$prevFg = [IntPtr]::Zero

while ($true) {
  Start-Sleep -Milliseconds 90

  try { $cfg = Get-Content -Raw -LiteralPath $File | ConvertFrom-Json } catch { continue }
  if (-not $cfg.host) { continue }
  $hostH = [IntPtr]([int64]$cfg.host)

  # (2) voltou pro app? (foreground passou a ser o host) -> foca o HOST (nao o child).
  # Focar o child aqui trava mouse+teclado do painel ate clicar na sidebar; focar o
  # host destrava e o clique seguinte no jogo funciona normal.
  $fg = [F]::GetForegroundWindow()
  if (($fg -eq $hostH) -and ($prevFg -ne $hostH)) {
    $activeH = if ($cfg.active) { [IntPtr]([int64]$cfg.active) } else { [IntPtr]::Zero }
    Diag 'RETORNO-antes' $hostH $activeH
    $hpid = 0; $htid = [F]::GetWindowThreadProcessId($hostH, [ref]$hpid)
    FocusHost $hostH
    ActivateGame $activeH $htid
    Diag 'RETORNO-depois' $hostH $activeH
  }
  $prevFg = $fg

  # (1) clicando num painel -> foca aquele painel
  $mouseDown = (([F]::GetAsyncKeyState($VK_LBUTTON) -band 0x8000) -ne 0)
  if ($mouseDown) {
    # DIAG: na BORDA de cada clique (subida), dump do estado ANTES de qualquer FocusPane
    if (-not $script:prevMouse) {
      $activeH = if ($cfg.active) { [IntPtr]([int64]$cfg.active) } else { [IntPtr]::Zero }
      Diag 'CLIQUE' $hostH $activeH
    }
    if ($cfg.hwnds) {
      $p = New-Object 'F+POINT'
      if ([F]::GetCursorPos([ref]$p)) {
        $wh = [F]::WindowFromPoint($p)
        if ($wh -ne [IntPtr]::Zero) {
          $known = @{}
          foreach ($h in $cfg.hwnds) { $known[[int64]$h] = $true }
          $target = [IntPtr]::Zero
          $cur = $wh
          for ($k = 0; $k -lt 10 -and $cur -ne [IntPtr]::Zero; $k++) {
            if ($known.ContainsKey($cur.ToInt64())) { $target = $cur; break }
            $cur = [F]::GetParent($cur)
          }
          if ($target -ne [IntPtr]::Zero) { FocusPane $hostH $target }
        }
      }
    }
  }
  $script:prevMouse = $mouseDown
}
