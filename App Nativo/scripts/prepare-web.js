// Monta o pacote de atualização SÓ DO SITE (ver web-updater.js) em ota-release/web/:
//   web/manifest.json   -> lista de arquivos + sha256, versão do app nativo, data
//   web/manifest.sig    -> assinatura Ed25519 do manifest.json
//   web/<buildId>/...   -> os arquivos em si
//
// Assina com a chave privada que fica FORA do projeto (nunca vai pro git nem pro
// instalador): %USERPROFILE%\.sundrowsy\web-update-key.pem, ou o caminho em
// SUNDROWSY_WEB_KEY. Confere se ela bate com a chave pública embutida no app antes de
// publicar — assinar com a chave errada faria todos os apps recusarem a atualização.
//
// Não mexe no latest.yml (OTA do instalador). Se ele não existir localmente (ex.:
// "npm run release:web" numa máquina que nunca rodou o release completo), baixa o que
// está no ar, pra o deploy não apagá-lo do Hosting.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { version } = require('../package.json');

const WEB_SRC = path.join(__dirname, '..', '..');
const OTA_DIR = path.join(__dirname, '..', 'ota-release');
const WEB_OUT = path.join(OTA_DIR, 'web');
const KEY_PATH = process.env.SUNDROWSY_WEB_KEY || path.join(os.homedir(), '.sundrowsy', 'web-update-key.pem');
const HOSTING_URL = 'https://sundrowsy-db163.web.app/';

// Mesmo conjunto que o instalador empacota (package.json > build.extraResources)
const ROOT_FILES = ['index.html', 'admin.html', 'style.css', 'alert.mp3'];
const ROOT_DIRS = ['assets', 'src'];

function walk(dir, rel, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), r, out);
        else out.push(r);
    }
}

function embeddedPublicKey() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'web-updater.js'), 'utf8');
    const m = src.match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/);
    if (!m) throw new Error('Chave pública não encontrada em web-updater.js');
    return m[0];
}

async function main() {
    if (!fs.existsSync(KEY_PATH)) {
        console.error(`Chave de assinatura não encontrada em ${KEY_PATH}.`);
        console.error('Restaure o backup da pasta .sundrowsy (ver README > Atualização do site).');
        process.exit(1);
    }
    const privateKey = crypto.createPrivateKey(fs.readFileSync(KEY_PATH));
    const derivedPub = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString().trim();
    if (derivedPub !== embeddedPublicKey().trim()) {
        console.error('A chave privada NÃO corresponde à chave pública embutida em web-updater.js. Abortando.');
        process.exit(1);
    }

    const files = [...ROOT_FILES];
    for (const d of ROOT_DIRS) walk(path.join(WEB_SRC, d), d, files);

    const entries = {};
    const contentHash = crypto.createHash('sha256');
    for (const rel of files.sort()) {
        const buf = fs.readFileSync(path.join(WEB_SRC, rel));
        const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        entries[rel] = { sha256, size: buf.length };
        contentHash.update(rel + ':' + sha256 + '\n');
    }

    const now = new Date();
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    const buildId = `${stamp}-${contentHash.digest('hex').slice(0, 8)}`;
    const manifest = { buildId, publishedAt: now.toISOString(), appVersion: version, files: entries };
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
    const sig = crypto.sign(null, manifestBuf, privateKey).toString('base64');

    fs.rmSync(WEB_OUT, { recursive: true, force: true });
    for (const rel of Object.keys(entries)) {
        const dest = path.join(WEB_OUT, buildId, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(WEB_SRC, rel), dest);
    }
    fs.writeFileSync(path.join(WEB_OUT, 'manifest.json'), manifestBuf);
    fs.writeFileSync(path.join(WEB_OUT, 'manifest.sig'), sig);

    const ymlPath = path.join(OTA_DIR, 'latest.yml');
    if (!fs.existsSync(ymlPath)) {
        const res = await fetch(HOSTING_URL + 'latest.yml', { cache: 'no-store' });
        const text = await res.text();
        if (!res.ok || !text.startsWith('version:')) {
            console.error('latest.yml não existe localmente e não foi possível baixar o que está no ar. Abortando.');
            process.exit(1);
        }
        fs.writeFileSync(ymlPath, text);
        console.log('  latest.yml baixado do Hosting (preservado no deploy)');
    }

    console.log(`Site ${buildId} preparado (${files.length} arquivos, app ${version}) em ota-release/web/`);
}

main().catch((err) => { console.error(err); process.exit(1); });
