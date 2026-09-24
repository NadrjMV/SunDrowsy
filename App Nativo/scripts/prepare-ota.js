// Prepara o OTA a partir da versão recém-compilada pelo electron-builder (dist/).
//
// O plano Spark do Firebase proíbe .exe no Hosting, então o release fica dividido:
//   - ota-release/  -> só o latest.yml, vai pro Firebase Hosting (é onde os apps
//                      instalados procuram atualização — URL fixa no app-update.yml).
//   - dist_github/  -> instalador + blockmap, anexados na GitHub Release v<versão>.
// O latest.yml aponta com URL absoluta pro .exe na GitHub Release.
// Os nomes trocam espaço por hífen porque o GitHub renomeia assets com espaço.
const fs = require('fs');
const path = require('path');
const { version } = require('../package.json');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const OTA_DIR = path.join(__dirname, '..', 'ota-release');
const GH_DIR = path.join(__dirname, '..', 'dist_github');
const GH_REPO = 'NadrjMV/SunDrowsy';

function clearDir(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(dir, { recursive: true });
}

function main() {
    const setupName = `SunDrowsy Setup ${version}.exe`;
    const assetName = `SunDrowsy-Setup-${version}.exe`;
    const setupPath = path.join(DIST_DIR, setupName);
    const ymlPath = path.join(DIST_DIR, 'latest.yml');

    if (!fs.existsSync(setupPath) || !fs.existsSync(ymlPath)) {
        console.error(`"${setupName}" ou latest.yml não encontrados em dist/. Rode "npm run dist" antes.`);
        process.exit(1);
    }

    clearDir(OTA_DIR);
    clearDir(GH_DIR);

    fs.copyFileSync(setupPath, path.join(GH_DIR, assetName));
    if (fs.existsSync(setupPath + '.blockmap')) {
        fs.copyFileSync(setupPath + '.blockmap', path.join(GH_DIR, assetName + '.blockmap'));
    }

    const assetUrl = `https://github.com/${GH_REPO}/releases/download/v${version}/${assetName}`;
    const yml = fs.readFileSync(ymlPath, 'utf8').split(setupName).join(assetUrl);
    fs.writeFileSync(path.join(OTA_DIR, 'latest.yml'), yml);

    console.log(`OTA v${version} preparado:`);
    console.log(`  ota-release/latest.yml -> ${assetUrl}`);
    console.log(`  dist_github/${assetName} (+ blockmap) pra GitHub Release`);
}

main();
