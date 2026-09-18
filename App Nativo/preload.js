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
});
