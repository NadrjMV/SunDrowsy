// --- LOG DE ERROS / TRAVAMENTOS ---
// Registra erros, travamentos da interface e congelamentos da imagem pra dar pra
// descobrir DEPOIS onde o app travou (o vigia normalmente só percebe "congelou").
//
// Pra onde vai:
//  - App nativo (Electron 1.0.4+): arquivo em %APPDATA%/SunDrowsy/logs/ (menu do dot >
//    "Abrir pasta de logs"). O main.js também grava sozinho console.error/warn,
//    "Não está respondendo" do Windows e crashes do processo da tela.
//  - Sempre: últimas entradas no localStorage (sd_error_log). No console do navegador,
//    rode sdDumpLogs() pra ver a lista.

const LS_KEY = 'sd_error_log';
const MAX_ENTRIES = 300;

function describe(value) {
    if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
}

// level: 'info' | 'warn' | 'error'. "source" diz de onde veio (AUTH, CAMERA, MEDIAPIPE, UI...).
export function logEvent(level, source, message, extra) {
    const entry = {
        ts: new Date().toISOString(),
        level,
        source,
        message: describe(message),
    };
    if (extra !== undefined) entry.extra = describe(extra);

    // Eco no console como "log" (não error/warn), pra o main.js não gravar em dobro
    // o que já chega pelo IPC.
    console.log(`[SD-LOG] ${level.toUpperCase()} [${source}] ${entry.message}`, extra ?? '');

    try {
        const list = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
        list.push(entry);
        localStorage.setItem(LS_KEY, JSON.stringify(list.slice(-MAX_ENTRIES)));
    } catch { /* storage cheio/bloqueado: segue só com o arquivo */ }

    try { window.electronAPI?.logEvent?.(entry); } catch { /* app nativo antigo, sem IPC de log */ }
}

let installed = false;

export function installErrorLogger() {
    if (installed) return;
    installed = true;

    window.addEventListener('error', (e) => {
        // Falha ao carregar <script>/<img> também cai aqui (sem e.error)
        const target = e.target && e.target !== window ? (e.target.src || e.target.href) : null;
        if (target) {
            logEvent('error', 'RECURSO', `Falha ao carregar ${target}`);
            return;
        }
        logEvent('error', 'JS', e.error || e.message, `${e.filename}:${e.lineno}:${e.colno}`);
    }, true);

    window.addEventListener('unhandledrejection', (e) => {
        logEvent('error', 'PROMISE', e.reason || 'Promise rejeitada sem motivo');
    });

    // Detector de congelamento da interface: um timer de 1s que atrasou muito significa
    // que a thread principal ficou presa (MediaPipe, WebGL, loop pesado...). Só mede com
    // a janela visível — escondida, o Chromium segura os timers de propósito.
    const TICK_MS = 1000;
    const FREEZE_MS = 2500;
    let last = performance.now();
    let lastVisible = !document.hidden;
    setInterval(() => {
        const now = performance.now();
        const visible = !document.hidden;
        const lag = now - last - TICK_MS;
        if (visible && lastVisible && lag > FREEZE_MS) {
            logEvent('warn', 'UI', `Interface travou por ~${Math.round(lag)}ms`);
        }
        last = now;
        lastVisible = visible;
    }, TICK_MS);

    window.sdDumpLogs = () => {
        try {
            const list = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
            console.table(list);
            return list;
        } catch { return []; }
    };
    window.sdClearLogs = () => { try { localStorage.removeItem(LS_KEY); } catch {} };
}
