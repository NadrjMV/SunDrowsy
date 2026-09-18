// Prepara a pasta que vai pro Firebase Hosting (ota-release/) com os arquivos da
// versão recém-compilada pelo electron-builder (dist/), e apaga o que tinha antes —
// assim cada "npm run release" só deixa a versão mais nova disponível pra atualizar,
// sem versões antigas acumulando no Hosting.
const fs = require('fs');
const path = require('path');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const OTA_DIR = path.join(__dirname, '..', 'ota-release');

function clearDir(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(dir, { recursive: true });
}

function main() {
    if (!fs.existsSync(DIST_DIR)) {
        console.error('Pasta dist/ não encontrada. Rode "npm run dist" antes.');
        process.exit(1);
    }

    clearDir(OTA_DIR);

    const files = fs.readdirSync(DIST_DIR);
    const toCopy = files.filter(f =>
        f === 'latest.yml' || f.endsWith('.exe') || f.endsWith('.exe.blockmap')
    );

    if (toCopy.length === 0) {
        console.error('Nenhum arquivo de release encontrado em dist/ (latest.yml / .exe). Build falhou?');
        process.exit(1);
    }

    for (const file of toCopy) {
        fs.copyFileSync(path.join(DIST_DIR, file), path.join(OTA_DIR, file));
        console.log(`  copiado: ${file}`);
    }

    console.log(`\nOTA preparado em ota-release/ (${toCopy.length} arquivo(s)). Versões antigas removidas.`);
}

main();
