const fs = require('fs');
const os = require('os');
const dotenv = require('dotenv');
const qt = require('./qbittorrentAPI');
const parseTorrent = require('parse-torrent');
const path = require('path');

dotenv.configDotenv({
    path: path.join(__dirname, 'stremio-seeds.config')
})

// Timestamped logger: Stremio's server output has no dates, this makes
// minipc troubleshooting possible without extra tooling.
function ts() { try { return new Date().toISOString(); } catch { return ''; } }
const log = (...a) => console.log(`[${ts()}]`, ...a);
const logWarn = (...a) => console.warn(`[${ts()}] WARN:`, ...a);
const logError = (...a) => console.error(`[${ts()}] ERROR:`, ...a);

const CURRENT_OS = os.platform();

const LINUX_DEFAULT_CACHE_DIR = path.join(os.homedir(), '.stremio-server', 'stremio-cache');
const LINUX_ALT_CACHE_DIRS = [
    path.join(os.homedir(), '.stremio', 'stremio-server', 'stremio-cache'),
    path.join(os.homedir(), 'stremio-cache'),
];
const WINDOWS_DEFAULT_CACHE_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'stremio', 'stremio-server', 'stremio-cache');
const MACOS_DEFAULT_CACHE_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'stremio-server', 'stremio-cache');
const RAW_CUSTOM_CACHE_DIR = (process.env.CACHE_DIR || '').trim().replace(/^["']|["']$/g, '');

function readStremioCacheRootFromSettings() {
    const candidates = [];
    if (CURRENT_OS === 'win32') {
        if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'stremio', 'stremio-server', 'server-settings.json'));
        candidates.push(path.join(os.homedir(), 'AppData', 'Roaming', 'stremio', 'stremio-server', 'server-settings.json'));
    } else if (CURRENT_OS === 'darwin') {
        candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'stremio-server', 'server-settings.json'));
    } else {
        candidates.push(path.join(os.homedir(), '.stremio-server', 'server-settings.json'));
        candidates.push(path.join(os.homedir(), '.stremio', 'stremio-server', 'server-settings.json'));
    }
    for (const file of candidates) {
        try {
            if (!fs.existsSync(file)) continue;
            const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
            const cacheRoot = (json.cacheRoot || json.cache_root || '').toString().trim();
            if (!cacheRoot) continue;
            const cleaned = cacheRoot.replace(/^["']|["']$/g, '');
            if (path.basename(cleaned) === 'stremio-cache') return cleaned;
            return path.join(cleaned, 'stremio-cache');
        } catch (err) {
            console.error('Could not read server-settings.json at', file, '-', err.message);
        }
    }
    return null;
}

function resolveCacheDir() {
    if (RAW_CUSTOM_CACHE_DIR) {
        let dir = RAW_CUSTOM_CACHE_DIR.replace(/[/\\]+$/, '');
        //Allow stremio-server folder
        const base = (CURRENT_OS === 'win32' ? dir.split('\\') : dir.split('/')).pop() || '';
        if (base.includes('stremio-server')) dir = path.join(dir, 'stremio-cache');
        return dir;
    }

    const fromSettings = readStremioCacheRootFromSettings();
    if (fromSettings) return fromSettings;

    if (CURRENT_OS === 'win32') return WINDOWS_DEFAULT_CACHE_DIR;
    if (CURRENT_OS === 'darwin') return MACOS_DEFAULT_CACHE_DIR;
    // linux: prefer the one that already exists, else default
    for (const alt of LINUX_ALT_CACHE_DIRS) {
        try { if (fs.existsSync(alt)) return alt; } catch { /* ignore */ }
    }
    return LINUX_DEFAULT_CACHE_DIR;
}

let CacheDir = resolveCacheDir();
CacheDir = CacheDir.replace(/[/\\]+$/, '');

//Allow stremio-server folder
if ((CURRENT_OS === 'win32' ? CacheDir.split('\\') : CacheDir.split('/')).pop()?.includes('stremio-server'))
    CacheDir = path.join(CacheDir, 'stremio-cache');

function ensureCacheDir(dir) {
    try {
        if (!dir) return false;
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return fs.existsSync(dir);
    } catch (err) {
        console.error('Cannot create/access cache dir:', dir, '-', err.message);
        return false;
    }
}

function safeListSubdirs(dir) {
    if (!ensureCacheDir(dir)) return [];
    try {
        return fs.readdirSync(dir).filter(_dir => {
            try {
                return fs.statSync(path.join(dir, _dir)).isDirectory();
            } catch {
                return false;
            }
        });
    } catch (err) {
        // Never crash stremio-server: a missing/locked cache dir must not kill server.js
        console.error('Cannot read cache dir (will retry next interval):', dir, '-', err.code || err.message);
        return [];
    }
}

ensureCacheDir(CacheDir);

const CUSTOM_CACHE_SIZE = process.env.CUSTOM_CACHE_SIZE;
let _CUSTOM_CACHE_SIZE;
if(CUSTOM_CACHE_SIZE) {
    let size = 0;
    if(CUSTOM_CACHE_SIZE?.match(/kb/i)) size = parseFloat(CUSTOM_CACHE_SIZE) * 1024; else
    if(CUSTOM_CACHE_SIZE?.match(/mb/i)) size = parseFloat(CUSTOM_CACHE_SIZE) * 1024 * 1024; else
    if(CUSTOM_CACHE_SIZE?.match(/gb/i)) size = parseFloat(CUSTOM_CACHE_SIZE) * 1024 * 1024 * 1024; else
    if(CUSTOM_CACHE_SIZE?.match(/tb/i)) size = parseFloat(CUSTOM_CACHE_SIZE) * 1024 * 1024 * 1024 * 1024; else
    size = parseInt(CUSTOM_CACHE_SIZE);
    _CUSTOM_CACHE_SIZE = size;
    if(size) {
        try {
            const configFile = path.join(CacheDir, '..', 'server-settings.json');
            if(fs.existsSync(configFile)) {
                try {
                    const _file = fs.readFileSync(configFile, 'utf-8');
                    const _json = JSON.parse(_file);
                    _json.cacheSize = size;
                    fs.writeFileSync(configFile, JSON.stringify(_json, null, 2));
                } catch (err) {
                    console.error('Could not update server-settings.json:', err.message);
                }
            }
            else {
                try {
                    const settings = {
                        cacheSize: size
                    };
                    ensureCacheDir(path.dirname(configFile));
                    fs.writeFileSync(configFile, JSON.stringify(settings, null, 2));
                } catch (err) {
                    console.error('Could not write server-settings.json:', err.message);
                }
            }
        } catch (err) {
            console.error('CUSTOM_CACHE_SIZE handling failed (non-fatal):', err.message);
        }
    }

}

if(!process.env.QT_HOST)  process.env.QT_HOST = 'http://127.0.0.1';
if(!process.env.QT_PORT)  process.env.QT_PORT = '6775';

const BASE_URL = process.env.QT_HOST + ':' + process.env.QT_PORT;
// README uses QT_USERNAME/QT_PASSWORD, keep backward compat with USERNAME/PASSWORD
const USERNAME = process.env.QT_USERNAME || process.env.USERNAME || 'admin';
const PASSWORD = process.env.QT_PASSWORD ?? process.env.PASSWORD ?? '';
let UPLOAD_LIMIT = process.env.UPLOAD_LIMIT; //bytes
if(UPLOAD_LIMIT?.match(/kb/i)) UPLOAD_LIMIT = parseInt(UPLOAD_LIMIT) * 1024; else
if(UPLOAD_LIMIT?.match(/mb/i)) UPLOAD_LIMIT = parseInt(UPLOAD_LIMIT) * 1024 * 1024; else
if(UPLOAD_LIMIT?.match(/gb/i)) UPLOAD_LIMIT = parseInt(UPLOAD_LIMIT) * 1024 * 1024 * 1024; else
UPLOAD_LIMIT = parseInt(UPLOAD_LIMIT);

let INTERVAL_CHECK = process.env.INTERVAL_CHECK;
if(INTERVAL_CHECK?.match(/sec/i)) INTERVAL_CHECK = parseFloat(INTERVAL_CHECK) * 1000; else
if(INTERVAL_CHECK?.match(/min/i)) INTERVAL_CHECK = parseFloat(INTERVAL_CHECK) * 60 * 1000; else
if(INTERVAL_CHECK?.match(/hour/i)) INTERVAL_CHECK = parseFloat(INTERVAL_CHECK) * 60 * 60 * 1000; else
if(INTERVAL_CHECK?.match(/day/i)) INTERVAL_CHECK = parseFloat(INTERVAL_CHECK) * 24 * 60 * 60 * 1000;

const START_SEED_PERCENT = process.env.START_SEED_PERCENT ? 0 < parseInt(process.env.START_SEED_PERCENT) <= 100 ? parseInt(process.env.START_SEED_PERCENT) : 90 : 90;
const RATIO_LIMIT = parseFloat(process.env.RATIO_LIMIT);
const BLOCK_DOWNLOAD = process.env.BLOCK_DOWNLOAD?.match(/true/i) ? true : false;
const SKIP_CHECKING = process.env.SKIP_CHECKING?.match(/true/i) ? true : false;
const INCLUDE_TRACKER = process.env.INCLUDE_STREMIO_TRACKER?.match(/true/i) ? true : false;
const KEEP_TORRENT_LOW_SEEDER = process.env.KEEP_TORRENT_LOW_SEEDER?.match(/true/i) ? true : false;
const CLEAN_CACHE_PERCENT = parseInt(process.env.CLEAN_CACHE_PERCENT) || 95;

// Validate config early with actionable warnings (non-fatal).
(function validateConfig() {
    if (!/^https?:\/\//i.test(process.env.QT_HOST || '')) logWarn(`QT_HOST=${process.env.QT_HOST} should start with http:// or https://`);
    const port = parseInt(process.env.QT_PORT, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) logWarn(`QT_PORT=${process.env.QT_PORT} is not a valid TCP port`);
    if (typeof INTERVAL_CHECK === 'string') {
        logWarn(`INTERVAL_CHECK=${process.env.INTERVAL_CHECK} not understood (use e.g. 30sec/5mins/1hour), periodic scan disabled`);
        INTERVAL_CHECK = undefined;
    }
    if (process.env.UPLOAD_LIMIT && !Number.isFinite(UPLOAD_LIMIT)) logWarn(`UPLOAD_LIMIT=${process.env.UPLOAD_LIMIT} not understood, no upload limit applied`);
    if (process.env.RATIO_LIMIT && !Number.isFinite(RATIO_LIMIT)) logWarn(`RATIO_LIMIT=${process.env.RATIO_LIMIT} not understood, no ratio limit applied`);
    if (!RAW_CUSTOM_CACHE_DIR) log('CACHE_DIR empty, autodetecting from server-settings.json / OS defaults');
    if (!process.env.QT_PASSWORD && !process.env.PASSWORD) logWarn('No QT_PASSWORD set, qBittorrent login may fail if WebUI needs auth');
    if (CLEAN_CACHE_PERCENT < 1 || CLEAN_CACHE_PERCENT > 100) logWarn(`CLEAN_CACHE_PERCENT=${process.env.CLEAN_CACHE_PERCENT} out of 1-100, using 95`);
})();

const qbittorrent = new qt(BASE_URL, USERNAME, PASSWORD, { UPLOAD_LIMIT, RATIO_LIMIT, INCLUDE_TRACKER, BLOCK_DOWNLOAD, SKIP_CHECKING });

log('############### Stremio Seeds ##############');
log('OS:', CURRENT_OS);
log('Cache Dir:', CacheDir);
if(CUSTOM_CACHE_SIZE) log('Cache Size:', CUSTOM_CACHE_SIZE);
log('INTERVAL CHECK:', INTERVAL_CHECK);
log('RATIO LIMIT:', RATIO_LIMIT),
log('UPLOAD LIMIT:', UPLOAD_LIMIT);
log('INCLUDE TRACKERS:', INCLUDE_TRACKER);
log('############# END ##############');

// Never let a startup failure kill Stremio's server.js (the ENOENT bug).
main().catch(err => logError('Stremio Seeds fatal (non-fatal for server):', err?.stack || err));

async function main(){ 
    try {
        const login = await qbittorrent.login().catch(err => console.error(err));
        if(!login) {
            console.error('Login Fail! Retrying in 10s...');
            return setTimeout(() => main(), 10000);
        }

        try { cleanEmptyCache(); } catch (err) { console.error('cleanEmptyCache failed (non-fatal):', err.message); }
        await Update();
        if(INTERVAL_CHECK) {
            setInterval(async () => {
                try { await Update(); } catch (err) { console.error('Periodic Update failed (non-fatal):', err.message); }
            }, INTERVAL_CHECK);
        }
    }
    catch(err) {
        console.error('main() failed (non-fatal, server keeps running):', err?.stack || err);
        // Never let an uncaught throw kill server.js. Retry in 30s.
        setTimeout(() => main(), 30000);
    }
}

async function Update() {
    try {
        if(!ensureCacheDir(CacheDir)) {
            console.error('Cache dir unavailable, skipping Update. Check CACHE_DIR / Stremio cacheRoot:', CacheDir);
            return;
        }
        if(KEEP_TORRENT_LOW_SEEDER && _CUSTOM_CACHE_SIZE) {
            const currentCacheSize = getFolderSize(CacheDir);
            if((currentCacheSize/_CUSTOM_CACHE_SIZE)*100 >= CLEAN_CACHE_PERCENT){
                await cleanTorrentsCache(currentCacheSize);
            }
        }

        let dirs = safeListSubdirs(CacheDir);
        //console.log(dirs.length);
        const torrentList = await qbittorrent.getTorrentList({
            category: 'Stremio Seeds'
        });
        if(!torrentList) return;

        const torrentListHashes = torrentList.map(_torrent => _torrent.hash);

        const expiredTorrentsHash = torrentListHashes.filter(_hash => !checkFolder(path.join(CacheDir, _hash)));
        if(expiredTorrentsHash.length) {
            console.log('Deleting Expired Torrents:', expiredTorrentsHash.length);
            await qbittorrent.removeTorrents(expiredTorrentsHash, true);
            for(const _dir of expiredTorrentsHash) {
                try { fs.rmSync(path.join(CacheDir, _dir), {recursive: true, force: true}); }
                catch (err) { console.error('Could not remove expired folder', _dir, '-', err.message); }
            }
        }

        const validDirs = dirs.filter(dir => !torrentListHashes.find(_hash => _hash === dir));

        for(const dir of validDirs) {
            try { await addTorrent(path.join(CacheDir, dir)); }
            catch (err) { console.error('addTorrent failed for', dir, '-', err.message); }
        }
    }
    catch(err) {
        // Critical: never re-throw. Stremio kills server.js on uncaught throw.
        console.error('Update() failed (non-fatal, will retry next interval):', err?.stack || err);
    }
}

function safeRmSync(target) {
    try {
        if (!target || !fs.existsSync(target)) return;
        fs.rmSync(target, {recursive: true, force: true});
    } catch (err) {
        console.error('Could not remove', target, '-', err.message);
    }
}

function cleanEmptyCache() {
    try {
        console.log('Cleaning empty folder...');
        const dirs = safeListSubdirs(CacheDir);
        for(const dir of dirs) {
            const folderPath = path.join(CacheDir, dir);
            if(!checkFolder(folderPath)) {
                console.log('Deleting folder:', folderPath);
                safeRmSync(folderPath);
            }
        }
    } catch (err) {
        console.error('cleanEmptyCache failed (non-fatal):', err.message);
    }
}

async function cleanTorrentsCache(currentSize) {
  try {
    console.log('Cleaning torrent, bc cache is full...');
    const dirs = safeListSubdirs(CacheDir);
    //console.log(dirs.length);
    const torrentList = await qbittorrent.getTorrentList({
        category: 'Stremio Seeds',
        sort: 'num_complete'
    });
    if(!torrentList) return;

    const torrentListHashes = torrentList.map(_torrent => _torrent.hash);

    const _dirs = dirs.map(_dir => {
        try {
            return {
                name: _dir,
                time: fs.statSync(path.join(CacheDir, _dir)).birthtimeMs
            }
        } catch {
            return { name: _dir, time: 0 };
        }
    })
    .sort((a,b) => b.time - a.time)
    .slice(3); //skip 3 files newest

    let _removed_size = 0;

    const _remove_size = currentSize - _CUSTOM_CACHE_SIZE*CLEAN_CACHE_PERCENT/100;
    //console.log('will remove', _remove_size)

    //clean Uncompleted Torrents;
    for(const _dir of _dirs.reverse()) {
        const folderPath = path.join(CacheDir, _dir.name);
        if(!checkFolder(folderPath)) continue;
        const bitfield = path.join(folderPath, 'bitfield');
        const cacheTorrent = path.join(folderPath, 'cache');
        let torrent;
        try {
            torrent = parseTorrent(fs.readFileSync(cacheTorrent));
        } catch (err) {
            console.error('Skipping corrupt cache torrent', _dir.name, '-', err.message);
            continue;
        }
        const totalPieces = (torrent.length - torrent.lastPieceLength)/torrent.pieceLength + 1;
        if(!checkBitField(bitfield, totalPieces)) {
            _removed_size += getFolderSize(folderPath);
            console.log('Cache Full: Deleting Folder:', _dir.name);
            safeRmSync(folderPath);
        }
        if(_removed_size >= _remove_size) break;
    }

    //clean Completed Torrents
    while(_removed_size < _remove_size && torrentListHashes.length) {
        const shouldDeleteIdx = torrentListHashes.reverse().findIndex(_hash => _dirs.find(_dir => _dir.name === _hash));
        if(shouldDeleteIdx !== -1) {
            const shouldDelete = torrentListHashes.reverse().splice(shouldDeleteIdx, 1)[0];
            const folderPath = path.join(CacheDir, shouldDelete);
            _removed_size += getFolderSize(folderPath);
            console.log('Cache Full: Deleing Torrent + Folder:', shouldDelete);
            try { await qbittorrent.removeTorrents([shouldDelete], true); } catch (err) { console.error('removeTorrents failed:', err.message); }
            safeRmSync(folderPath);
        } else break;
    }

    console.log('Removed', Math.floor(_removed_size/(1024*1024)), 'MB');
  } catch (err) {
    console.error('cleanTorrentsCache failed (non-fatal):', err.message);
  }
}

function getFolderSize(folderPath) {
    let totalSize = 0;
    const traverse = (currentPath) => {
      let files;
      try {
        files = fs.readdirSync(currentPath);
      } catch (err) {
        // ENOENT (deleted by Stremio) or EACCES: count as 0, don't crash
        return;
      }
      files.forEach(file => {
        try {
          const filePath = path.join(currentPath, file);
          const stats = fs.lstatSync(filePath);
          if (stats.isDirectory()) {
            traverse(filePath);
          }
          else if(stats.isSymbolicLink()) {
              try {
                  totalSize += stats.size;
              }
              catch(err) {
                  console.error('symbolink error:', filePath);
              }
          }
          else {
            totalSize += stats.size;
          }
        } catch {
          // File vanished mid-scan (Stremio cleaning cache concurrently). Ignore.
        }
      });
    };
    try {
      if (!fs.existsSync(folderPath)) return 0;
      traverse(folderPath);
    } catch {
      return totalSize;
    }
    return totalSize;
}

function checkFolder(folderPath) {
    try {
        const bitfield = path.join(folderPath, 'bitfield');
        const cacheTorrent = path.join(folderPath, 'cache');
        if(!fs.existsSync(bitfield) || !fs.existsSync(cacheTorrent)) return false;
        return true;
    } catch {
        return false;
    }
}

const createDirectories = (filePath) => {
    try {
        const directory = path.dirname(filePath);

        if (!fs.existsSync(directory)) {
            createDirectories(directory);
            fs.mkdirSync(directory, { recursive: true });
        }
    } catch (err) {
        console.error('createDirectories failed for', filePath, '-', err.message);
        throw err;
    }
};

async function addTorrent(folderPath) {
    try {
        const bitfield = path.join(folderPath, 'bitfield');
        const cacheTorrent = path.join(folderPath, 'cache');
        if(!fs.existsSync(bitfield) || !fs.existsSync(cacheTorrent)) return;
        let torrent;
        try {
            torrent = parseTorrent(fs.readFileSync(cacheTorrent));
        } catch (err) {
            console.error('Skipping unreadable torrent cache at', folderPath, '-', err.message);
            return;
        }
        let torrentName = folderPath;
        try { torrentName = torrent.info?.name?.toString('utf-8') || folderPath; } catch { /* ignore */ }
        console.log(torrentName);

        //Flatpak default folder
        let _folderPath = folderPath;
        if(process.env.FLATPAK_ID) _folderPath = folderPath.replace(os.homedir(), path.join(os.homedir(), '.var', 'app', 'com.stremio.Stremio'));

        let totalPieces = (torrent.length - torrent.lastPieceLength)/torrent.pieceLength + 1;
        if(checkBitField(bitfield, totalPieces)) {
            //make symbol link
            for(const idx in torrent.files) {
                try {
                    const offset = path.join(_folderPath, idx);
                    const syml = path.join(folderPath, torrent.files[idx].path);
                    //console.log(fs.existsSync(syml), syml)
                    if(!fs.existsSync(syml) && fs.existsSync(offset)) {
                        createDirectories(syml);
                        try { fs.symlinkSync(offset, syml, 'file'); }
                        catch (err) {
                            // Windows needs admin/dev-mode for symlinks. Don't crash, just log once.
                            console.error('symlink failed (run Stremio as admin on Windows?):', syml, '-', err.message);
                        }
                    }
                } catch (err) {
                    console.error('symlink entry failed (non-fatal):', err.message);
                }
            }

            //add torrent to qbittorrent
            console.log('Adding torrent at:', path.basename(folderPath));
            try { await qbittorrent.addTorrentFile(cacheTorrent, _folderPath); }
            catch (err) { console.error('addTorrentFile failed (non-fatal):', err.message); }
        }
    } catch (err) {
        console.error('addTorrent failed (non-fatal) for', folderPath, '-', err.message);
    }
}

function checkBitField(bitFieldPath, totalPieces) {
    try {
        let pieces = 0;
        const bytes = fs.readFileSync(bitFieldPath);
    for(const byte of bytes) {
        if(byte === 255)
            pieces += 8;
        else {
            let bits = 0;
            for(let i = 7; i >= 0; i--) {
                if(byte & (1 << i)) bits++;
            }
            pieces += bits;
        }
    }
    const percent = (pieces/totalPieces) * 100;
    console.log('   => Pieces:', pieces, 'Percent:', Math.floor(percent * 100)/100 + '%');
    if(percent >= START_SEED_PERCENT) return true;
    return false;
    } catch (err) {
        console.error('checkBitField failed (non-fatal) for', bitFieldPath, '-', err.message);
        return false;
    }
}