const { app, BrowserWindow, ipcMain, session, screen, Menu } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const loudness = require('loudness');
const { autoUpdater } = require('electron-updater');

// --- ATUALIZAÇÃO AUTOMÁTICA (OTA) ---
// Busca por versão nova no Firebase Hosting (ver package.json > build.publish e
// "npm run release" na pasta App Nativo). Baixa sozinho em segundo plano; a troca de
// verdade só acontece quando o app fecha (autoInstallOnAppQuit) ou quando alguém
// escolhe "Reiniciar e atualizar" no menu do dot — nunca no meio de um monitoramento.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
let updateReady = false;

function initAutoUpdater() {
    if (!app.isPackaged) return; // não faz sentido checar update rodando em dev

    autoUpdater.on('update-downloaded', () => {
        updateReady = true;
    });
    autoUpdater.on('error', (err) => {
        console.error('Erro no auto-updater:', err.message);
    });

    const check = () => autoUpdater.checkForUpdates().catch((err) => console.error('Erro ao checar atualização:', err.message));
    check();
    // O app fica rodando por dias (é um monitoramento contínuo) — checa de novo
    // periodicamente, não só na abertura.
    setInterval(check, 4 * 60 * 60 * 1000); // a cada 4h
}

// Volume mínimo garantido antes de tocar um alerta de fadiga. Se o volume do
// Windows estiver mais baixo que isso, sobe pra esse valor (nunca abaixa).
const MIN_ALERT_VOLUME = 65;

// Em dev, os arquivos do site ficam na pasta pai do projeto.
// Empacotado (instalado), o electron-builder copia tudo pra resources/web (ver package.json > extraResources).
const basePath = app.isPackaged
    ? path.join(process.resourcesPath, 'web')
    : path.join(__dirname, '..');

const MIME_TYPES = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

let mainWindow = null;
let dotWindow = null;
let isQuitting = false;
let isMainWindowVisible = true;
let lastStatus = { level: 'idle', label: 'Ocioso' };
let volumeSnapshot = null; // guarda volume/mudo de antes do alarme, pra poder restaurar

// --- ESTADO DA SESSÃO / DETECÇÃO DE FECHAMENTO INDEVIDO ---
// App é obrigatório: um vigia não pode simplesmente encerrar o processo (Gerenciador
// de Tarefas, etc.) sem deixar rastro. Guardamos um "batimento" num arquivo local;
// se na próxima abertura o último batimento não tiver sido marcado como "saída
// limpa", é sinal de que o processo morreu de forma anormal (kill/crash/queda de
// energia) — reportamos isso pro app.js registrar no Firestore.
const STATE_FILE = path.join(app.getPath('userData'), 'session-state.json');
let sessionInfo = { uid: null, userName: null, role: null };
let pendingCrashReport = null;
let heartbeatInterval = null;

function readStateFile() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    } catch {
        return null;
    }
}

function writeStateFile(cleanExit) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            ...sessionInfo,
            lastHeartbeat: Date.now(),
            cleanExit,
        }));
    } catch (err) {
        console.error('Não foi possível gravar o arquivo de estado:', err.message);
    }
}

function checkPreviousSessionCrash() {
    const previous = readStateFile();
    if (previous && previous.cleanExit === false && previous.uid) {
        pendingCrashReport = previous;
    }
}

function startHeartbeat() {
    writeStateFile(false);
    heartbeatInterval = setInterval(() => writeStateFile(false), 20000);
}
// Porta FIXA (não aleatória): o Firebase Auth guarda a sessão de login por origem
// (protocolo+host+porta). Se a porta mudasse a cada abertura do app, a "origem"
// mudaria junto e o login salvo seria perdido toda vez — era exatamente esse o
// motivo de precisar logar de novo.
const SERVER_PORT = 53217;
let serverPort = null;

// --- SERVIDOR LOCAL ---
// O Firebase Auth (signInWithPopup, usado no "Entrar com Google") não funciona
// carregando os arquivos direto do disco (file://) — exige http/https. Por isso
// servimos os mesmos arquivos por um servidorzinho local, só pra esse fim.
function startLocalServer(port) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            let reqPath = decodeURIComponent(req.url.split('?')[0]);
            if (reqPath === '/') reqPath = '/index.html';
            const filePath = path.normalize(path.join(basePath, reqPath));

            // Nunca serve nada fora da pasta do site (proteção básica de path traversal)
            if (!filePath.startsWith(path.normalize(basePath))) {
                res.writeHead(403); res.end('Forbidden'); return;
            }

            fs.readFile(filePath, (err, data) => {
                if (err) { res.writeHead(404); res.end('Not found'); return; }
                const ext = path.extname(filePath).toLowerCase();
                res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
                res.end(data);
            });
        });

        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => {
            serverPort = server.address().port;
            resolve(serverPort);
        });
    });
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 700,
        icon: path.join(__dirname, 'icon.ico'),
        backgroundColor: '#050505',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    Menu.setApplicationMenu(null);
    mainWindow.loadURL(`http://127.0.0.1:${serverPort}/index.html`);

    // Fechar a janela (X) NÃO encerra o app: minimiza pro dot flutuante (e some da
    // barra de tarefas), continua monitorando e mostra vermelho fixo no dot pra
    // avisar que a janela está fora de vista.
    mainWindow.on('close', (event) => {
        if (isQuitting) return;
        event.preventDefault();
        mainWindow.hide();
    });

    mainWindow.on('hide', () => {
        isMainWindowVisible = false;
        mainWindow.setSkipTaskbar(true);
        if (dotWindow) dotWindow.webContents.send('sundrowsy:status', { level: 'closed', label: 'App minimizado' });
    });

    mainWindow.on('show', () => {
        isMainWindowVisible = true;
        mainWindow.setSkipTaskbar(false);
        // Reenvia o último status real assim que a janela volta — sem isso o dot
        // podia ficar preso no vermelho até a próxima mudança de estado detectada.
        if (dotWindow) dotWindow.webContents.send('sundrowsy:status', lastStatus);
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

function createDotWindow() {
    const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
    const DOT_SIZE = 64;

    dotWindow = new BrowserWindow({
        width: DOT_SIZE,
        height: DOT_SIZE,
        x: screenW - DOT_SIZE - 24,
        y: 24,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        hasShadow: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    dotWindow.setAlwaysOnTop(true, 'screen-saver');
    dotWindow.loadFile(path.join(__dirname, 'dot.html'));

    // Clique direito no dot: abrir ou sair de verdade (já que fechar a janela principal
    // não encerra mais o app).
    dotWindow.webContents.on('context-menu', () => {
        const template = [
            { label: 'Abrir SunDrowsy', click: () => focusMainWindow() },
        ];
        if (updateReady) {
            template.push({ type: 'separator' });
            template.push({
                label: 'Reiniciar e atualizar',
                click: () => { writeStateFile(true); isQuitting = true; autoUpdater.quitAndInstall(); },
            });
        }
        template.push({ type: 'separator' });
        // "Sair" NÃO encerra direto: o app é obrigatório, então só quem souber a senha
        // de supervisor (validada na janela principal, ver 'sundrowsy:confirm-quit')
        // consegue de fato fechar. Isso também garante que toda saída legítima passa
        // pela tela principal, então o vigia não tem como sair sem deixar rastro.
        template.push({
            label: 'Sair (requer senha de supervisor)',
            click: () => {
                focusMainWindow();
                if (mainWindow) mainWindow.webContents.send('sundrowsy:request-quit');
            },
        });

        Menu.buildFromTemplate(template).popup({ window: dotWindow });
    });

    dotWindow.on('closed', () => { dotWindow = null; });
}

function focusMainWindow() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

// --- INSTÂNCIA ÚNICA ---
// Fechar o X só esconde a janela (o app continua rodando de verdade). Sem isso,
// clicar no atalho de novo abriria um SEGUNDO processo inteiro (segunda câmera,
// segundo worker, disputando recursos) — foi o que travou a tela na hora do login.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        focusMainWindow();
    });

    app.whenReady().then(async () => {
        // App obrigatório: precisa vir junto com o Windows, sem depender de alguém
        // clicar no atalho. (Isso cria um item por-usuário em Configurações > Apps de
        // Inicialização — um usuário padrão consegue desativar por ali; quem garante
        // que o app volta de qualquer forma é o watchdog instalado junto, ver
        // build/installer.nsh.)
        app.setLoginItemSettings({ openAtLogin: true, name: 'SunDrowsy' });

        // Detecta se a execução anterior foi encerrada sem passar pelo fluxo normal
        // de saída (Gerenciador de Tarefas, crash, queda de energia) ANTES de sobrescrever
        // o arquivo de estado com o heartbeat desta execução.
        checkPreviousSessionCrash();
        startHeartbeat();

        // Permite acesso à câmera/microfone sem o prompt padrão do Chromium travar o app.
        session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
            if (permission === 'media') return callback(true);
            callback(false);
        });

        try {
            await startLocalServer(SERVER_PORT);
        } catch (err) {
            // Porta fixa ocupada por outra coisa (raro): cai pra uma porta aleatória
            // só dessa vez, em vez de o app não abrir.
            console.error(`Porta ${SERVER_PORT} indisponível, usando porta aleatória:`, err.message);
            await startLocalServer(0);
        }

        createMainWindow();
        createDotWindow();
        initAutoUpdater();

        // Manda o relatório de fechamento indevido (se houver) assim que a página
        // terminar de carregar — o app.js decide o que fazer (logar no Firestore).
        mainWindow.webContents.on('did-finish-load', () => {
            if (pendingCrashReport) {
                mainWindow.webContents.send('sundrowsy:crash-report', pendingCrashReport);
                pendingCrashReport = null;
            }
        });

        app.on('activate', () => {
            if (!mainWindow) createMainWindow();
            else focusMainWindow();
        });
    });

    app.on('before-quit', () => {
        isQuitting = true;
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        writeStateFile(true);
    });

    app.on('window-all-closed', () => {
        // Não encerra: a janela principal só se "fecha" via hide() (ver mainWindow.on('close')).
        // O app só sai de verdade pelo menu do dot ("Sair").
    });

    // --- IPC: status de fadiga (enviado pela janela principal, repassado pro dot) ---
    // Sempre guardamos o último status (lastStatus), mesmo com a janela escondida, pra
    // poder restaurar o dot certinho assim que a janela reabrir (ver mainWindow.on('show')).
    ipcMain.on('sundrowsy:status', (_event, status) => {
        lastStatus = status;
        if (!isMainWindowVisible) return;
        if (dotWindow) dotWindow.webContents.send('sundrowsy:status', status);
    });

    // --- IPC: clicar no dot traz a janela principal de volta ---
    ipcMain.on('sundrowsy:focus-main', focusMainWindow);

    // --- IPC: quem está logado agora (pro arquivo de estado / detecção de crash) ---
    ipcMain.on('sundrowsy:session-info', (_event, info) => {
        sessionInfo = info || { uid: null, userName: null, role: null };
        writeStateFile(false);
    });

    // --- IPC: senha de supervisor confirmada na janela principal — agora sim sai ---
    ipcMain.on('sundrowsy:confirm-quit', () => {
        isQuitting = true;
        app.quit();
    });

    // --- IPC: garante que o alerta de fadiga vai ser ouvido ---
    // Chamado pelo app (audio-manager.js) bem antes de tocar o som do alarme.
    // Desmuta o Windows e garante um volume mínimo, guardando o estado original pra
    // dar pra restaurar depois (ver 'sundrowsy:restore-volume').
    ipcMain.handle('sundrowsy:ensure-audible', async () => {
        const result = { ok: true, wasMuted: false, volumeRaised: false };
        try {
            const muted = await loudness.getMuted();
            const volume = await loudness.getVolume();

            // Só tira o "retrato" da primeira vez (não sobrescreve se o alarme já
            // estiver tocando/repetindo e ensureAudible for chamado de novo).
            if (!volumeSnapshot) {
                volumeSnapshot = { muted, volume };
            }

            if (muted) {
                await loudness.setMuted(false);
                result.wasMuted = true;
            }
            if (volume < MIN_ALERT_VOLUME) {
                await loudness.setVolume(MIN_ALERT_VOLUME);
                result.volumeRaised = true;
            }
        } catch (err) {
            // Alguns ambientes (VMs, drivers de áudio incomuns) não suportam a API de volume.
            // Falha de forma silenciosa — o app ainda tenta tocar o som normalmente.
            console.error('Não foi possível verificar/ajustar o volume do sistema:', err);
            result.ok = false;
        }
        return result;
    });

    // --- IPC: restaura o volume/mudo de como estava antes do alarme ---
    // Chamado quando o alarme para (audio-manager.js > stopAlert).
    ipcMain.handle('sundrowsy:restore-volume', async () => {
        if (!volumeSnapshot) return { ok: true, restored: false };
        const snapshot = volumeSnapshot;
        volumeSnapshot = null;
        try {
            await loudness.setVolume(snapshot.volume);
            await loudness.setMuted(snapshot.muted);
            return { ok: true, restored: true };
        } catch (err) {
            console.error('Não foi possível restaurar o volume do sistema:', err);
            return { ok: false, restored: false };
        }
    });
}
