# Poke Multi-Labs

Painel **multi-conta** para o Poke Idle World — várias contas rodando **isoladas**
em uma única janela, com **workspaces** (conjuntos salvos de contas) e
**sync opcional na nuvem** (Supabase). Mesmo padrão do idle-labs.com / Rambox.

## Rodar (dev)

```powershell
cd C:\dev\poke-multi-labs
npm install        # Electron (~250 MB) + supabase-js
npm start
```

Abre 4 painéis por padrão (ou restaura a última sessão). Cada painel é uma
**conta independente** — faça login separado em cada.

## Gerar o .exe

```powershell
npm run dist       # electron-builder → dist\ (instalador NSIS)
```

## Funcionalidades

- **Multi-conta isolada:** cada painel = `WebContentsView` com `partition`
  própria (cookies/login separados). `backgroundThrottling:false` mantém o
  idle "tickando" sem foco.
- **Layouts:** Grade / Colunas / Linhas.
- **Por painel:** zoom (−/+), mute, remover.
- **Workspaces (offline):** salvar o conjunto atual com nome, abrir, excluir.
  Ficam em `%APPDATA%\poke-multi-labs\workspaces.json`. A última sessão é
  restaurada automaticamente (`state.json`).
- **Nuvem (opcional):** login por código no e-mail (OTP) → **Enviar** /
  **Baixar** workspaces. Sincroniza entre computadores.

## Backend (Supabase)

Reusa o projeto **`rxvvorjvbnyzkpziamhs`** (antigo vrum, zerado e reaproveitado).
Tabelas: `profiles`, `workspaces`, `workspace_contas` — todas com RLS por
`auth.uid()`. Config em `config.js` (a chave anon é pública por design).

### Falta configurar no painel do Supabase (lado do dono)
- **Auth → Email:** habilitar login por OTP (Email). Opcional: template com o
  código de 6 dígitos.
- (Futuro) **Google OAuth:** exige redirect URI e é mais chato no desktop; o
  OTP por e-mail já resolve o login sem redirect.

## Arquitetura

```
main.js        processo principal: janela, painéis (WebContentsView),
               layout, store local, cliente Supabase, IPC
preload.js     ponte segura (contextBridge) → window.ml
config.js      URL/chave Supabase, URL do jogo, limites
renderer/
  toolbar.html barra de 48px (layout, +conta, recarregar, Gerenciar)
  manage.html  modal: Painéis / Workspaces / Nuvem
```

O modal é uma janela separada de propósito: os painéis do jogo ficam **por
cima** do webContents da toolbar, então menus suspensos ali ficariam escondidos.

## Cuidado / ToS

Multi-conta (multiboxing) pode ferir as regras do jogo. Confirmar com os donos
do Poke Idle World (Victor/Gabriel) antes de distribuir pra comunidade.
