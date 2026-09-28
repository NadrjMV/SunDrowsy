// --- LOG DE ERROS / TRAVAMENTOS ---
// Registra erros, travamentos da interface e congelamentos da imagem pra dar pra
// descobrir DEPOIS onde o app travou (o vigia normalmente só percebe "congelou").
//
// Pra onde vai:
//  - Painel admin (Auditoria > "Erro / travamento"): todo warn/error sobe sozinho pro
//    Firestore (logs/{uid}/logs, type APP_ERROR) junto com o "rastro" — as últimas
//    entradas antes do problema, pra saber COMO travou. Se estiver sem internet ou
//    deslogado, fica numa fila (localStorage) e sobe assim que der.
//  - App nativo (Electron 1.0.4+): arquivo em %APPDATA%/SunDrowsy/logs/ (menu do dot >
//    "Abrir pasta de logs"). O main.js também registra "Não está respondendo" do
//    Windows, crash da tela/GPU e console.error — e repassa pra cá pra subir pro admin.
//  - Sempre: últimas entradas no localStorage (sd_error_log). No console do navegador,
//    rode sdDumpLogs() pra ver a lista.

const LS_KEY = 'sd_error_log';
const LS_QUEUE_KEY = 'sd_error_upload_queue';
const MAX_ENTRIES = 300;

// Quantas entradas anteriores vão junto com cada erro pro admin (o "como travou").
const TRAIL_SIZE = 25;
// Limites pra um erro repetido em loop não encher o Firestore (custo de escrita):
// a mesma mensagem sobe no máximo 1x a cada 10 min, e no máximo 30 envios por hora.
const DEDUPE_MS = 10 * 60 * 1000;
const MAX_UPLOADS_PER_HOUR = 30;
const MAX_QUEUE = 50;

function describe(value) {
    if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
}

function truncate(text, max) {
    if (!text) return text;
    return text.length > max ? `${text.slice(0, max)}… (+${text.length - max})` : text;
}

function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}
function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage cheio/bloqueado */ }
}

// Guarda as últimas entradas também em memória: o rastro precisa existir mesmo se o
// localStorage estiver bloqueado.
let memoryLog = readJson(LS_KEY).slice(-TRAIL_SIZE);

function record(entry) {
    memoryLog.push(entry);
    if (memoryLog.length > MAX_ENTRIES) memoryLog = memoryLog.slice(-MAX_ENTRIES);
    const list = readJson(LS_KEY);
    list.push(entry);
    writeJson(LS_KEY, list.slice(-MAX_ENTRIES));
}

// --- ENVIO PRO ADMIN ---
// O envio em si é feito pelo app.js (setErrorUploader), que sabe quem está logado e
// tem acesso ao Firestore — assim este módulo não depende do Firebase ter carregado
// (se o Firebase falhar, o log local continua funcionando).
let uploader = null;
let flushing = false;
const lastUploadByKey = new Map();
let uploadTimestamps = [];

function queueForUpload(entry) {
    const key = `${entry.source}|${entry.message.slice(0, 120)}`;
    const now = Date.now();
    if (now - (lastUploadByKey.get(key) || 0) < DEDUPE_MS) return;
    uploadTimestamps = uploadTimestamps.filter(t => now - t < 60 * 60 * 1000);
    if (uploadTimestamps.length >= MAX_UPLOADS_PER_HOUR) return;
    lastUploadByKey.set(key, now);
    uploadTimestamps.push(now);

    const trail = memoryLog.slice(-TRAIL_SIZE - 1, -1) // entradas ANTES desta
        .map(e => `${e.ts.slice(11, 19)} ${e.level.toUpperCase()} [${e.source}] ${truncate(e.message, 200)}`)
        .join('\n');

    const queue = readJson(LS_QUEUE_KEY);
    queue.push({
        // id fixo: se um envio "falhar" por timeout mas chegar depois, o reenvio
        // sobrescreve o mesmo documento em vez de duplicar no admin.
        id: `${Date.parse(entry.ts)}-${Math.random().toString(36).slice(2, 8)}`,
        ts: entry.ts,
        severity: entry.level,
        source: entry.source,
        message: truncate(entry.message, 500),
        details: truncate(entry.extra || '', 3000),
        trail,
    });
    writeJson(LS_QUEUE_KEY, queue.slice(-MAX_QUEUE));
    flushUploads();
}

export async function flushUploads() {
    if (!uploader || flushing) return;
    flushing = true;
    try {
        let queue = readJson(LS_QUEUE_KEY);
        while (queue.length) {
            const ok = await uploader(queue[0]).catch(() => false);
            if (!ok) break; // sem usuário logado / sem internet: tenta de novo depois
            queue = readJson(LS_QUEUE_KEY);
            queue.shift();
            writeJson(LS_QUEUE_KEY, queue);
        }
    } finally {
        flushing = false;
    }
}

// fn(item) => Promise<boolean>: true se enviou, false pra manter na fila.
export function setErrorUploader(fn) {
    uploader = fn;
    flushUploads();
}

// level: 'info' | 'warn' | 'error'. "source" diz de onde veio (AUTH, CAMERA, MEDIAPIPE, UI...).
// fromMain: entrada que veio do processo principal do app nativo (já está no arquivo).
export function logEvent(level, source, message, extra, { fromMain = false, ts } = {}) {
    const entry = {
        ts: ts || new Date().toISOString(),
        level,
        source,
        message: describe(message),
    };
    if (extra !== undefined && extra !== null && extra !== '') entry.extra = describe(extra);

    // Eco no console como "log" (não error/warn), pra o main.js não gravar em dobro
    // o que já chega pelo IPC.
    console.log(`[SD-LOG] ${level.toUpperCase()} [${source}] ${entry.message}`, extra ?? '');

    record(entry);
    if (!fromMain) {
        try { window.electronAPI?.logEvent?.(entry); } catch { /* app nativo antigo, sem IPC de log */ }
    }
    if (level === 'warn' || level === 'error') queueForUpload(entry);
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

    // Eventos do processo principal (travamento da janela, crash, console.error...).
    // Chegam também os que aconteceram enquanto esta tela estava travada/morta.
    try {
        window.electronAPI?.onMainLog?.((entry) => {
            if (!entry) return;
            logEvent(entry.level || 'info', entry.source || 'MAIN', entry.message || '', entry.extra, { fromMain: true, ts: entry.ts });
        });
    } catch { /* app nativo antigo */ }

    window.addEventListener('online', () => flushUploads());

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
        const list = readJson(LS_KEY);
        console.table(list);
        return list;
    };
    window.sdClearLogs = () => { try { localStorage.removeItem(LS_KEY); } catch {} };
}
