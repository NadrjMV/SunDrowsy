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

## Estrutura

- `main.js` — processo principal: cria a janela do app e a janela do dot, libera
  permissão de câmera automaticamente (sem popup travando), e faz a ponte de
  status (IPC) entre as duas janelas.
- `preload.js` — expõe `window.electronAPI` de forma segura (contextIsolation)
  pras páginas web usarem sem ter acesso direto ao Node.
- `dot.html` — a janela pequena, sem moldura, sempre no topo, arrastável.
- `src/detector.js` (na pasta pai) tem uma linha adicional que chama
  `window.electronAPI?.reportStatus(...)` a cada mudança de status — não afeta em
  nada a versão rodando no navegador (o `?.` faz isso ser um no-op lá).

## Observação sobre a câmera

A resolução pedida (`ideal 1080x720`, `max 1920x1080`) já é a mesma usada no
navegador — o ganho real do app nativo é não ter a aba pausada/throttled quando
perde o foco, que é o que causava travamentos no Chrome.
