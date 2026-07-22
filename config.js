// Configuracao do Poke Multi-Labs.
// A chave anon do Supabase e PUBLICA por design (RLS protege os dados).
module.exports = {
  GAME_URL: 'https://poke.idleworld.online',
  SUPABASE_URL: 'https://rxvvorjvbnyzkpziamhs.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ4dnZvcmp2Ym55emtwemlhbWhzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1NjEyNTksImV4cCI6MjA5NTEzNzI1OX0.hoUpXGuqup7frpAp9rdnJFSQ0PtYI-mcGWECgeLudCA',
  // Regra OFICIAL do Poke Idle World: no maximo 4 contas simultaneas por IP.
  // A ferramenta respeita isso (nao burla o limite; so facilita o que ja e permitido).
  MAX_PANELS: 4,
  START_PANELS: 1,

  // Tiers de assinatura (enforcement vem na Fase 3 - licenciamento):
  FREE_PANELS: 1,   // sem assinar: 1 tela
  PAID_PANELS: 4,   // assinante (R$7/mes): ate 4 telas

  // Flags do Chrome: enxuga overhead e MANTEM o idle rodando nas telas
  // escondidas/ocluidas (idle game precisa progredir mesmo sem foco).
  CHROME_FLAGS: [
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync',
    // carrega a mini-extensao "Vperts Bridge" (captura o WS -> localStorage.__vperts)
    '--load-extension=C:/dev/pokemon/labs/vperts-ext',
    '--disable-component-update', '--disable-default-apps', '--disable-breakpad',
    // CalculateNativeWinOcclusion: impede o Chromium de marcar a janela-filha
    // reparented como OCCLUDED/HIDDEN quando o host perde o foco (alt-tab). Sem
    // isso, o jogo dispara visibilitychange e trava a UI = "inclicavel ao voltar".
    '--disable-features=Translate,ChromeWhatsNewUI,MediaRouter,OptimizationHints,InterestFeedContentSuggestions,CalculateNativeWinOcclusion',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
    // enxuga mais: sem audio (4x a mesma musica), sem logging/crash-monitor/telemetria
    '--mute-audio', '--disable-logging', '--disable-hang-monitor',
    '--metrics-recording-only', '--disable-client-side-phishing-detection'
  ]
}
