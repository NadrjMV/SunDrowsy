# SunDrowsy — App Nativo (Windows)

Wrapper em Electron do mesmo site (`index.html`, `admin.html`) rodando como app de
desktop de verdade — sem aba de navegador, sem o Chrome throttling a câmera/JS em
segundo plano, e com um **dot flutuante** sempre visível na tela mostrando o status
de fadiga em tempo real (verde = ativo, amarelo = atenção, vermelho = fadiga,
pulsando).

Não duplica o código do site: carrega os arquivos direto da pasta pai
(`../index.html`, `../style.css`, `../src/*.js`, `../assets/*`) em desenvolvimento,
e do pacote de instalação quando compilado.

## Rodar em desenvolvimento

```bash
cd "App Nativo"
npm install
npm start
```

Abre a janela principal (o app normal) + o dot flutuante no canto superior direito
da tela. Clicar no dot traz a janela principal de volta pro topo.

## Gerar instalador (.exe) para distribuir

```bash
npm run dist
```

Gera o instalador NSIS em `App Nativo/dist/`. O instalador empacota os arquivos do
site (index.html, admin.html, style.css, assets, src) dentro do próprio app —
não depende mais desta pasta do projeto depois de instalado.

A instalação agora é **por máquina** (`perMachine: true`): o instalador pede
elevação (UAC) uma vez. Isso é necessário pro watchdog (ver abaixo) rodar como
SYSTEM — sem isso, uma conta padrão de vigia conseguiria simplesmente apagar a
tarefa agendada.

## App obrigatório: auto-start, watchdog e trava de saída

Como o app é obrigatório pra quem está de vigia, três mecanismos garantem que ele
não fica desligado por conta própria:

1. **Auto-start** — `app.setLoginItemSettings({ openAtLogin: true })` em `main.js`
   registra o app pra abrir junto com o Windows (por usuário).
2. **Watchdog** (`build/installer.nsh`) — na instalação, cria uma Tarefa Agendada
   do Windows (`SunDrowsyWatchdog`, roda a cada 1 minuto como `SYSTEM`) que checa
   via `tasklist` se `SunDrowsy.exe` está rodando; se alguém matar o processo pelo
   Gerenciador de Tarefas, ele volta sozinho dentro de ~1 minuto. **Importante**:
   isso não impede o "Finalizar Tarefa" (nada no espaço do usuário consegue) — só
   torna inútil tentar, porque o app sempre volta.
3. **"Sair" exige senha de supervisor** — no menu do dot (clique direito), "Sair"
   não encerra direto: abre a janela principal e pede a mesma senha de supervisor
   usada na calibração (`settings/globalConfig.calibrationPassword`). Sem a senha
   certa, não fecha.

Tudo isso gera log de auditoria no Firestore (mesma coleção dos alarmes,
`logs/{uid}/logs`): `APP_OPEN`, `LOGIN`, `LOGOUT`, `APP_QUIT`,
`APP_CLOSE_ATTEMPT_DENIED` (tentou sair e errou/cancelou a senha) e
`APP_KILLED_UNEXPECTEDLY` (a execução anterior não encerrou de forma normal —
provável kill pelo Gerenciador de Tarefas, crash ou queda de energia; detectado via
`session-state.json` em `app.getPath('userData')`).

**Como testar o watchdog** (não dá pra automatizar isso num ambiente sem instalar
de verdade — testar manualmente):
1. `npm run dist`, instale o `.exe` gerado (aceite o UAC).
2. Confirme a tarefa: `schtasks /query /tn "SunDrowsyWatchdog"`.
3. Abra o app, depois mate o processo pelo Gerenciador de Tarefas
   (`SunDrowsy.exe`).
4. Espere até 1 minuto — o app deve reabrir sozinho.
5. Tente `schtasks /delete /tn "SunDrowsyWatchdog" /f` logado como usuário padrão
   (sem admin) — deve pedir elevação/falhar.

## Estrutura

- `main.js` — processo principal: cria a janela do app e a janela do dot, libera
  permissão de câmera automaticamente (sem popup travando), faz a ponte de
  status (IPC) entre as duas janelas, registra auto-start e controla o fluxo de
  saída (senha de supervisor) e a detecção de fechamento indevido.
- `preload.js` — expõe `window.electronAPI` de forma segura (contextIsolation)
  pras páginas web usarem sem ter acesso direto ao Node.
- `dot.html` — a janela pequena, sem moldura, sempre no topo, arrastável.
- `build/installer.nsh` — script NSIS customizado: instala/remove o watchdog
  (Tarefa Agendada) junto com o app.
- `src/detector.js` (na pasta pai) tem uma linha adicional que chama
  `window.electronAPI?.reportStatus(...)` a cada mudança de status — não afeta em
  nada a versão rodando no navegador (o `?.` faz isso ser um no-op lá).

## Observação sobre a câmera

A resolução pedida (`ideal 1080x720`, `max 1920x1080`) já é a mesma usada no
navegador — o ganho real do app nativo é não ter a aba pausada/throttled quando
perde o foco, que é o que causava travamentos no Chrome.
