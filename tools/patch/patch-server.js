#!/usr/bin/env node
/*
 * patch-server.js — repone el hook de stremio-seeds en server.js tras cada
 * actualización de Stremio, sin romper nunca la instalación.
 *
 * - Idempotente: si la línea ya existe, no toca nada (exit 0).
 * - Backup: server.js.bak (solo si no existe, para no apilar backups).
 * - Copia build/extensions/stremio-seeds/stremio-seeds.js junto a server.js
 *   si se encuentra el artefacto (si no, solo parchea la línea y avisa).
 * - Nunca deja server.js a medias: escribe a fichero temporal + rename.
 *
 * Uso:
 *   node tools/patch/patch-server.js [--server "C:\...\server.js"]
 *     [--src ".\build\extensions\stremio-seeds\stremio-seeds.js"]
 *     [--check] [--no-copy] [--no-backup]
 *
 * Env:
 *   STREMIO_DIR       carpeta con server.js (ej. "C:\Program Files\Stremio")
 *   STREMIO_SERVER_JS ruta directa a server.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const REQUIRE_LINE = "require('./extensions/stremio-seeds/stremio-seeds.js');";
const SEEDS_REL = path.join('extensions', 'stremio-seeds', 'stremio-seeds.js');
const CONFIG_REL = path.join('extensions', 'stremio-seeds', 'stremio-seeds.config');

function arg(name) {
    const i = process.argv.indexOf(name);
    return i !== -1 ? process.argv[i + 1] : null;
}
function hasFlag(name) {
    return process.argv.includes(name);
}

function findServerJs(explicit) {
    const candidates = [];
    if (explicit) candidates.push(explicit);
    if (process.env.STREMIO_SERVER_JS) candidates.push(process.env.STREMIO_SERVER_JS);
    if (process.env.STREMIO_DIR) candidates.push(path.join(process.env.STREMIO_DIR, 'server.js'));
    if (os.platform() === 'win32') {
        const pf = process.env.ProgramFiles || 'C:\\Program Files';
        const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        candidates.push(
            path.join(pf, 'Stremio', 'server.js'),
            path.join(pf86, 'Stremio', 'server.js'),
            path.join(local, 'Programs', 'Stremio', 'server.js'),
            path.join(local, 'Stremio', 'server.js')
        );
    } else if (os.platform() === 'darwin') {
        candidates.push('/Applications/Stremio.app/Contents/Resources/server.js');
    } else {
        candidates.push(
            '/opt/stremio/server.js',
            path.join(os.homedir(), '.stremio', 'server.js')
        );
    }
    for (const c of candidates) {
        try { if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch { /* next */ }
    }
    return null;
}

function defaultSrcJs(patchScriptDir) {
    // repo layout: tools/patch/patch-server.js -> ../../build/extensions/...
    const repoRoot = path.resolve(patchScriptDir, '..', '..');
    return path.join(repoRoot, 'build', 'extensions', 'stremio-seeds', 'stremio-seeds.js');
}
function defaultSrcConfig(patchScriptDir) {
    const repoRoot = path.resolve(patchScriptDir, '..', '..');
    return path.join(repoRoot, 'build', 'extensions', 'stremio-seeds', 'stremio-seeds.config');
}

function main() {
    const checkOnly = hasFlag('--check');
    const noCopy = hasFlag('--no-copy');
    const noBackup = hasFlag('--no-backup');
    const scriptDir = __dirname;
    const serverJs = findServerJs(arg('--server'));
    const srcJs = arg('--src') || defaultSrcJs(scriptDir);
    const srcConfig = arg('--src-config') || defaultSrcConfig(scriptDir);

    if (!serverJs) {
        console.error('patch-server: no se encontró server.js. Pasa --server "RUTA\\server.js" o define STREMIO_DIR.');
        process.exit(2);
    }
    console.log('patch-server: server.js =', serverJs);

    let content;
    try {
        content = fs.readFileSync(serverJs, 'utf-8');
    } catch (err) {
        console.error('patch-server: no se puede leer server.js:', err.message);
        process.exit(2);
    }

    const already = content.split('\n').some(l => l.trim() === REQUIRE_LINE);
    if (already) {
        console.log('patch-server: ya parcheado, no se toca nada.');
    } else if (checkOnly) {
        console.log('patch-server: PENDIENTE de parche (check).');
        process.exit(1);
    } else {
        if (!noBackup) {
            const bak = serverJs + '.bak';
            try {
                if (!fs.existsSync(bak)) {
                    fs.copyFileSync(serverJs, bak);
                    console.log('patch-server: backup en', bak);
                }
            } catch (err) {
                console.error('patch-server: no se pudo hacer backup, ABORTO para no romper Stremio:', err.message);
                process.exit(2);
            }
        }
        const tmp = serverJs + '.tmp-patch';
        try {
            fs.writeFileSync(tmp, REQUIRE_LINE + '\n' + content.replace(/^\uFEFF/, ''), 'utf-8');
            fs.renameSync(tmp, serverJs);
            console.log('patch-server: línea require insertada.');
        } catch (err) {
            try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
            console.error('patch-server: no se pudo escribir server.js:', err.message);
            process.exit(2);
        }
    }

    if (noCopy) return;

    // Copiar stremio-seeds.js junto a server.js (sin pisar la config del usuario).
    const destDir = path.join(path.dirname(serverJs), 'extensions', 'stremio-seeds');
    const destJs = path.join(destDir, 'stremio-seeds.js');
    const destConfig = path.join(destDir, 'stremio-seeds.config');
    try {
        fs.mkdirSync(destDir, { recursive: true });
    } catch (err) {
        console.error('patch-server: no se puede crear', destDir, '-', err.message);
        process.exit(2);
    }
    if (fs.existsSync(srcJs)) {
        try {
            if (checkOnly) {
                console.log('patch-server: (check) copiaría', srcJs, '->', destJs);
            } else {
                fs.copyFileSync(srcJs, destJs);
                console.log('patch-server: copiado', destJs);
            }
        } catch (err) {
            console.error('patch-server: no se pudo copiar stremio-seeds.js:', err.message);
            process.exit(2);
        }
    } else {
        console.log('patch-server: AVISO no hay artefacto en', srcJs, '(ejecuta npm run build primero). Solo se parcheó la línea.');
    }
    // La config del minipc tiene tus claves (QT_PASSWORD...): jamás sobrescribirla.
    if (!fs.existsSync(destConfig) && fs.existsSync(srcConfig) && !checkOnly) {
        try {
            fs.copyFileSync(srcConfig, destConfig);
            console.log('patch-server: config inicial copiada (no existía). Revísala con tus claves.');
        } catch (err) {
            console.error('patch-server: aviso, no se pudo copiar config inicial:', err.message);
        }
    } else {
        console.log('patch-server: config de usuario conservada:', destConfig);
    }
}

try {
    main();
} catch (err) {
    console.error('patch-server: error inesperado:', err && err.message);
    process.exit(2);
}
