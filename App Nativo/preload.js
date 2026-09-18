const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    isElectron: true,
    // Chamado pelo detector.js a cada mudança de status (safe/warning/danger)
    reportStatus: (status) => ipcRenderer.send('sundrowsy:status', status),
    // Usado pelo dot.html para receber os status enviados acima
    onStatus: (callback) => {
        ipcRenderer.on('sundrowsy:status', (_event, status) => callback(status));
    },
    // Usado pelo dot.html ao ser clicado, pra trazer a janela principal de volta
    focusMain: () => ipcRenderer.send('sundrowsy:focus-main'),
    // Desmuta e garante um volume mínimo no Windows antes de tocar o alarme.
    // Retorna { ok, wasMuted, volumeRaised } — no navegador (sem Electron) isso não existe.
    ensureAudible: () => ipcRenderer.invoke('sundrowsy:ensure-audible'),
    // Restaura o volume/mudo de como estava antes do alarme (chamar ao parar o alarme).
    restoreVolume: () => ipcRenderer.invoke('sundrowsy:restore-volume'),

    // --- CONTROLE DE FECHAMENTO (app obrigatório) ---
    // Avisa o processo principal quem está logado agora (pra registrar no arquivo de
    // estado usado na detecção de "fechamento indevido" — ver main.js).
    reportSession: (info) => ipcRenderer.send('sundrowsy:session-info', info),
    // Disparado pelo processo principal quando alguém clica em "Sair" no menu do dot.
    // O app.js reage abrindo a tela principal + pedindo a senha de supervisor.
    onRequestQuit: (callback) => ipcRenderer.on('sundrowsy:request-quit', () => callback()),
    // Chamado só depois da senha de supervisor ser validada — de fato encerra o app.
    confirmQuit: () => ipcRenderer.send('sundrowsy:confirm-quit'),
    // Se a última execução foi finalizada de forma anormal (Gerenciador de Tarefas,
    // queda de energia, crash), o processo principal manda um relatório assim que a
    // janela principal termina de carregar.
    onCrashReport: (callback) => ipcRenderer.on('sundrowsy:crash-report', (_event, data) => callback(data)),
});
