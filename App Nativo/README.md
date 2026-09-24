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

## Atualização automática (OTA)

Existem **dois tipos de atualização**, e os apps instalados checam os dois ao abrir e
a cada 4h:

| | Atualização do site | Atualização completa (instalador) |
|---|---|---|
| O que muda | `index.html`, `admin.html`, `style.css`, `alert.mp3`, `assets/`, `src/` | qualquer coisa, inclusive `main.js`, `preload.js`, `dot.html`, watchdog, Electron |
| Como chega | `web-updater.js` baixa só os arquivos alterados (KB) | `electron-updater` baixa o `.exe` inteiro (~84 MB) |
| Controle de Aplicativo Inteligente do Windows | **não afeta** (nenhum executável roda) | **pode bloquear** — o `.exe` não é assinado |
| Quando entra | ao reabrir o app, ou "Atualizar agora (recarrega a tela)" no menu do dot | ao fechar o app, ou "Reiniciar e atualizar" no menu do dot |
| Comando | `npm run release:web` | `npm run release` |

**Regra prática:** mudou só coisa da pasta pai (o site)? `npm run release:web`, **sem
mexer no `version`**. Mudou algo desta pasta `App Nativo` (main.js, preload.js,
dot.html, installer.nsh, dependências)? Aí sim sobe o `version` e roda
`npm run release`.

> Por que não subir o `version` à toa: a atualização do site só é aplicada em apps
> com **exatamente a mesma versão** com que foi publicada. Se você lançar a 1.0.4 e
> algum PC ficar preso na 1.0.3 (instalador barrado pelo Windows), esse PC para de
> receber atualizações do site até conseguir instalar a 1.0.4.

### Onde fica cada coisa

A URL `https://sundrowsy-db163.web.app/` fica gravada em cada instalação
(`resources/app-update.yml` e `web-updater.js`), então **não pode mudar**. O plano
Spark do Firebase **proíbe `.exe` no Hosting**, então:

- **Firebase Hosting** (`ota-release/`):
  - `latest.yml` — o que o `electron-updater` consulta; aponta com URL absoluta pro
    instalador no GitHub.
  - `web/manifest.json` + `web/manifest.sig` — lista de arquivos do site com sha256,
    assinada; `web/<buildId>/…` — os arquivos em si.
- **GitHub Releases** (`dist_github/`) — o instalador `SunDrowsy-Setup-<versão>.exe`
  + `.blockmap`, anexados na release `v<versão>` de `NadrjMV/SunDrowsy`.

### Publicar só o site (o caso comum)

```bash
npm run release:web
```

Faz `prepare-web` (monta e **assina** `ota-release/web/`) → `firebase deploy`. Não
precisa de commit antes (mas commite depois, pra o git refletir o que está no ar).
Se o `ota-release/latest.yml` não existir localmente, o script baixa o que está no ar
pra o deploy não apagá-lo.

### Publicar uma versão nova do app (instalador)

1. Suba o `version` no `package.json` (e no `package-lock.json`).
2. Commit **e push** (a tag da GitHub Release é criada em cima do `main` remoto).
3. Rode (precisa do `gh` e do `firebase` CLI logados, e da chave de assinatura):

```bash
npm run release
```

Faz `dist` → `prepare-ota` (monta `ota-release/` e `dist_github/`) → `prepare-web`
→ `publish-github` (cria a release no GitHub) → `firebase deploy --only hosting`. O
GitHub vem antes do Firebase de propósito: o `latest.yml` nunca fica no ar apontando
pra um instalador que ainda não existe.

`ota-release/`, `dist*/`, `scripts/` e os arquivos do Firebase ficam fora do
`app.asar` (ver `build.files`) — se não, o instalador anterior é empacotado dentro do
novo e o tamanho dobra.

### Segurança da atualização do site

Baixar código e rodar no app é, por definição, uma porta de entrada — então:

- O `manifest.json` é **assinado com Ed25519**. O app só aceita se a assinatura bater
  com a chave pública embutida em `web-updater.js`. Senha do Firebase ou do GitHub
  **não basta** pra publicar algo que os apps aceitem.
- Cada arquivo é conferido por sha256 ao baixar **e a cada abertura do app**. Se
  alguém editar os arquivos baixados (ficam em `%APPDATA%\sundrowsy-native\web-live`,
  gravável pelo usuário), o app descarta e volta pros arquivos do instalador (em
  Program Files, que usuário comum não consegue alterar).
- Manifest com data mais antiga que a atual é recusado (não dá pra "voltar" o app pra
  uma versão velha reenviando um manifest antigo).
- Só são aceitos caminhos simples (sem `..`); nada é executado fora da página.

### ⚠️ Cuidados com a chave de assinatura

A chave privada fica em **`%USERPROFILE%\.sundrowsy\web-update-key.pem`** (fora do
projeto de propósito — nunca vai pro git nem pro instalador). O `prepare-web` também
aceita outro caminho via variável `SUNDROWSY_WEB_KEY`.

- **Faça backup** da pasta `.sundrowsy` num lugar seguro (gerenciador de senhas,
  pendrive guardado). Se perder: não dá mais pra publicar atualização do site até sair
  um instalador novo com outra chave (gerar par novo + trocar a `PUBLIC_KEY` em
  `web-updater.js` + `npm run release`) — e PCs que não conseguirem instalar esse
  instalador ficam sem atualização do site.
- **Nunca compartilhe, commite ou mande esse arquivo** (e-mail, WhatsApp, drive
  compartilhado). Quem tiver ele consegue publicar código que roda no app de todos os
  vigias — desde que também tenha acesso ao Firebase pra fazer o deploy.
- Se desconfiar que vazou: gere uma chave nova, troque a `PUBLIC_KEY`, publique um
  instalador novo e, até ele chegar em todos, fique de olho no Firebase Hosting
  (histórico de deploys no console).
- Trocou de PC pra publicar? Copie a pasta `.sundrowsy` pro novo usuário.
- O script confere se a chave privada bate com a pública embutida antes de publicar —
  se aparecer "A chave privada NÃO corresponde", você está com a chave errada.

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
- `web-updater.js` — atualização só dos arquivos do site, sem instalador (ver
  "Atualização automática").
- `scripts/prepare-ota.js` / `scripts/prepare-web.js` — montam o que vai pro
  Firebase/GitHub no release.
- `build/installer.nsh` — script NSIS customizado: instala/remove o watchdog
  (Tarefa Agendada) junto com o app.
- `src/detector.js` (na pasta pai) tem uma linha adicional que chama
  `window.electronAPI?.reportStatus(...)` a cada mudança de status — não afeta em
  nada a versão rodando no navegador (o `?.` faz isso ser um no-op lá).

## Observação sobre a câmera

A resolução pedida (`ideal 1080x720`, `max 1920x1080`) já é a mesma usada no
navegador — o ganho real do app nativo é não ter a aba pausada/throttled quando
perde o foco, que é o que causava travamentos no Chrome.
