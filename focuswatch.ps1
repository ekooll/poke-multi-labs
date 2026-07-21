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
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@

$psTid = [F]::GetCurrentThreadId()

# da foco de teclado/ativacao a $target (amarra as filas host<->child)
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

  # (2) voltou pro app? (foreground passou a ser o host) -> reativa a janela visivel
  $fg = [F]::GetForegroundWindow()
  if (($fg -eq $hostH) -and ($prevFg -ne $hostH)) {
    if ($cfg.active) { FocusPane $hostH ([IntPtr]([int64]$cfg.active)) }
  }
  $prevFg = $fg

  # (1) clicando num painel -> foca aquele painel
  if (([F]::GetAsyncKeyState($VK_LBUTTON) -band 0x8000) -ne 0) {
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
}
