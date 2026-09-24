// --- ATUALIZAÇÃO DOS ARQUIVOS DO SITE (sem instalador) ---
// O instalador .exe não é assinado, e o Controle de Aplicativo Inteligente do Windows
// pode bloquear o OTA completo (electron-updater). Só que quase toda mudança é no site
// (index.html, style.css, src/*.js, assets) — então baixamos só esses arquivos do
// Firebase Hosting e servimos a partir de userData, sem rodar executável nenhum.
//
// Segurança: o manifest.json (lista de arquivos + sha256) vem assinado com Ed25519.
// A chave privada fica só na máquina de quem publica (ver scripts/prepare-web.js); aqui
// vai só a pública. Toda abertura do app re-verifica assinatura + hash de cada arquivo
// da pasta baixada — userData é gravável pelo usuário, então um vigia editando o JS
// local faz o app cair de volta pros arquivos do instalador (Program Files).
//
// Compatibilidade: o manifest carrega a versão do app nativo com que foi publicado
// (appVersion). Só aplicamos se for IGUAL à versão instalada — site feito pra um
// main.js/preload.js mais novo espera o instalador novo chegar.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE_URL = 'https://sundrowsy-db163.web.app/web/';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAm/162/bAojrl8opN/eyUS6iwAqlpzeVIy1b7wMdq9U4=
-----END PUBLIC KEY-----`;
const SAFE_PATH = /^(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._\- ]+(\/[A-Za-z0-9._\- ]+)*$/;

let bundledDir = null;
let liveRoot = null;
let appVersion = null;
let active = null;        // { dir, manifest|null } — o que está sendo servido agora
let staged = null;        // { dir, manifest } — baixado e verificado, esperando aplicar
let checking = false;

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function verifySignature(manifestBuf, sigB64) {
    try {
        return crypto.verify(null, manifestBuf, PUBLIC_KEY, Buffer.from(sigB64.trim(), 'base64'));
    } catch (e) {
        return false;
    }
}

function parseManifest(manifestBuf) {
    const m = JSON.parse(manifestBuf.toString('utf8'));
    if (!m || typeof m.buildId !== 'string' || !/^[A-Za-z0-9-]+$/.test(m.buildId)) throw new Error('buildId inválido');
    if (typeof m.publishedAt !== 'string' || typeof m.appVersion !== 'string') throw new Error('manifest incompleto');
    if (!m.files || typeof m.files !== 'object') throw new Error('manifest sem arquivos');
    for (const [rel, info] of Object.entries(m.files)) {
        if (!SAFE_PATH.test(rel)) throw new Error(`caminho inválido no manifest: ${rel}`);
        if (!info || !/^[0-9a-f]{64}$/.test(info.sha256)) throw new Error(`hash inválido: ${rel}`);
    }
    if (!m.files['index.html']) throw new Error('manifest sem index.html');
    return m;
}

function fileHash(dir, rel) {
    try { return sha256(fs.readFileSync(path.join(dir, rel))); } catch (e) { return null; }
}

// Confere uma pasta baixada inteira: assinatura, versão do app e hash de cada arquivo.
function verifyLiveDir(dir) {
    const manifestBuf = fs.readFileSync(path.join(dir, 'manifest.json'));
    const sig = fs.readFileSync(path.join(dir, 'manifest.sig'), 'utf8');
    if (!verifySignature(manifestBuf, sig)) throw new Error('assinatura inválida');
    const m = parseManifest(manifestBuf);
    if (m.appVersion !== appVersion) throw new Error(`feito pro app ${m.appVersion}, instalado ${appVersion}`);
    for (const [rel, info] of Object.entries(m.files)) {
        if (fileHash(dir, rel) !== info.sha256) throw new Error(`arquivo alterado ou faltando: ${rel}`);
    }
    return m;
}

function readState() {
    try { return JSON.parse(fs.readFileSync(path.join(liveRoot, 'state.json'), 'utf8')); } catch (e) { return {}; }
}

function writeState(state) {
    fs.writeFileSync(path.join(liveRoot, 'state.json'), JSON.stringify(state));
}

// Chamado uma vez ao abrir o app: decide de onde servir o site.
function init(opts) {
    bundledDir = opts.bundledDir;
    liveRoot = path.join(opts.userDataDir, 'web-live');
    appVersion = opts.appVersion;
    active = { dir: bundledDir, manifest: null };

    try {
        fs.mkdirSync(liveRoot, { recursive: true });
        const { current } = readState();
        if (current && /^[A-Za-z0-9-]+$/.test(current)) {
            const dir = path.join(liveRoot, current);
            active = { dir, manifest: verifyLiveDir(dir) };
            console.log(`Site: usando atualização ${current}`);
        }
    } catch (err) {
        console.error('Site: atualização baixada descartada, usando a do instalador:', err.message);
        active = { dir: bundledDir, manifest: null };
    }

    // Limpa pastas antigas/temporárias (nunca a que vai ser servida)
    try {
        for (const name of fs.readdirSync(liveRoot)) {
            const full = path.join(liveRoot, name);
            if (name === 'state.json' || full === active.dir) continue;
            fs.rmSync(full, { recursive: true, force: true });
        }
    } catch (e) {}

    return active.dir;
}

function getActiveDir() {
    return active ? active.dir : bundledDir;
}

async function fetchBuf(url) {
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
    return Buffer.from(await res.arrayBuffer());
}

// Busca manifest novo; se houver mudança, baixa pra uma pasta nova e deixa "staged".
// Retorna true quando uma atualização nova ficou pronta.
async function checkForUpdate() {
    if (checking || !liveRoot) return false;
    checking = true;
    try {
        const manifestBuf = await fetchBuf(BASE_URL + 'manifest.json');
        const sig = (await fetchBuf(BASE_URL + 'manifest.sig')).toString('utf8');
        if (!verifySignature(manifestBuf, sig)) throw new Error('assinatura do manifest remoto inválida');
        const m = parseManifest(manifestBuf);

        if (m.appVersion !== appVersion) return false; // espera o instalador compatível
        const current = staged || active;
        if (current.manifest && m.publishedAt <= current.manifest.publishedAt) return false; // nada novo (ou rollback)

        // Mesmo conteúdo do que já está sendo servido? (ex.: instalador recém-instalado)
        const changed = Object.entries(m.files).filter(([rel, info]) => fileHash(current.dir, rel) !== info.sha256);
        if (changed.length === 0 && !current.manifest) return false;

        const finalDir = path.join(liveRoot, m.buildId);
        if (finalDir === active.dir) return false;
        const tmpDir = finalDir + '.tmp';
        fs.rmSync(tmpDir, { recursive: true, force: true });

        for (const [rel, info] of Object.entries(m.files)) {
            const dest = path.join(tmpDir, rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            if (fileHash(current.dir, rel) === info.sha256) {
                fs.copyFileSync(path.join(current.dir, rel), dest);
            } else {
                const url = BASE_URL + m.buildId + '/' + rel.split('/').map(encodeURIComponent).join('/');
                const buf = await fetchBuf(url);
                if (sha256(buf) !== info.sha256) throw new Error(`hash não confere ao baixar ${rel}`);
                fs.writeFileSync(dest, buf);
            }
        }
        fs.writeFileSync(path.join(tmpDir, 'manifest.json'), manifestBuf);
        fs.writeFileSync(path.join(tmpDir, 'manifest.sig'), sig);
        verifyLiveDir(tmpDir);

        fs.rmSync(finalDir, { recursive: true, force: true });
        fs.renameSync(tmpDir, finalDir);
        if (staged && staged.dir !== active.dir) fs.rmSync(staged.dir, { recursive: true, force: true });
        staged = { dir: finalDir, manifest: m };
        writeState({ current: m.buildId }); // próxima abertura já usa essa
        console.log(`Site: atualização ${m.buildId} baixada (${changed.length} arquivo(s) novo(s))`);
        return true;
    } catch (err) {
        console.error('Site: falha ao checar/baixar atualização:', err.message);
        return false;
    } finally {
        checking = false;
    }
}

function hasStagedUpdate() {
    return !!staged && staged.dir !== active.dir;
}

// Passa a servir a atualização baixada (quem chama recarrega as janelas).
function applyStaged() {
    if (!hasStagedUpdate()) return false;
    active = staged;
    staged = null;
    return true;
}

module.exports = { init, getActiveDir, checkForUpdate, hasStagedUpdate, applyStaged };
