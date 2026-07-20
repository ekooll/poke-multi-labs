# focuswatch.ps1 — FOCO AO CLICAR.
# Roda em loop (spawnado 1x). Quando o botao esquerdo do mouse esta pressionado
# sobre um dos nossos paineis (Chrome reparented), da o foco de TECLADO aquele
# painel via AttachThreadInput + SetFocus. Resolve o "so a conta em foco digita":
# agora qualquer painel clicado passa a digitar (preco/chat do jogo).
#
# Uso: powershell -File focuswatch.ps1 <caminho-do-hwnds.json>
# O host reescreve o hwnds.json ({host, hwnds:[...]}) a cada mudanca de layout.

param([string]$File)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class F {
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@

$VK_LBUTTON = 0x01
while ($true) {
  Start-Sleep -Milliseconds 110
  # so age enquanto o botao esquerdo esta pressionado (= clicando num painel)
  if (([F]::GetAsyncKeyState($VK_LBUTTON) -band 0x8000) -eq 0) { continue }

  try { $cfg = Get-Content -Raw -LiteralPath $File | ConvertFrom-Json } catch { continue }
  if (-not $cfg.hwnds) { continue }

  $p = New-Object 'F+POINT'
  if (-not [F]::GetCursorPos([ref]$p)) { continue }
  $wh = [F]::WindowFromPoint($p)
  if ($wh -eq [IntPtr]::Zero) { continue }

  # tabela dos nossos paineis (hwnds top-level dos Chromes reparented)
  $known = @{}
  foreach ($h in $cfg.hwnds) { $known[[int64]$h] = $true }

  # sobe a arvore ate achar um dos nossos paineis
  $target = [IntPtr]::Zero
  $cur = $wh
  for ($k = 0; $k -lt 10 -and $cur -ne [IntPtr]::Zero; $k++) {
    if ($known.ContainsKey($cur.ToInt64())) { $target = $cur; break }
    $cur = [F]::GetParent($cur)
  }
  if ($target -eq [IntPtr]::Zero) { continue }   # clicou fora (sidebar) -> nao mexe

  $hostH = [IntPtr]([int64]$cfg.host)
  $hpid = 0; $hostTid = [F]::GetWindowThreadProcessId($hostH, [ref]$hpid)
  $cpid = 0; $ctid = [F]::GetWindowThreadProcessId($target, [ref]$cpid)
  $ps = [F]::GetCurrentThreadId()
  [void][F]::AttachThreadInput($ps, $hostTid, $true)
  [void][F]::AttachThreadInput($ps, $ctid, $true)
  [void][F]::SetFocus($target)
  [void][F]::AttachThreadInput($ps, $ctid, $false)
  [void][F]::AttachThreadInput($ps, $hostTid, $false)
}
