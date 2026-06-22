// launcher.js
// Windows-friendly interactive helper for setup, env config, uploads, history and playback links.
require('dotenv').config();
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, '.env');
const MANIFEST_ROOT = path.join(ROOT, 'upload', 'tiktok', 'manifests');
const PUBLIC_UPLOAD_ROOT = path.join(ROOT, 'public', 'upload');
const REQUIRED_ENV = ['TIKTOK_CSRF_TOKEN', 'TIKTOK_COOKIE'];
const CHECK_FILES = [
    'launcher.js',
    'server.js',
    'upload.js',
    'tiktok.js',
    'carrier.js',
    'public/carrier-player.js',
    'public/carrier-worker.js',
];

function createRl() {
    return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, question) {
    return new Promise(resolve => {
        let done = false;
        const finish = (answer) => {
            if (done) return;
            done = true;
            resolve(String(answer || '').trim());
        };
        rl.once('close', () => finish(''));
        try {
            rl.question(question, answer => finish(answer));
        } catch (err) {
            if (err && err.code === 'ERR_USE_AFTER_CLOSE') finish('');
            else throw err;
        }
    });
}

function maskSecret(value) {
    if (!value) return '(chưa có)';
    value = String(value);
    if (value.length <= 8) return '*'.repeat(value.length);
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function parseEnv(raw) {
    const env = {};
    for (const line of raw.split(/\r?\n/)) {
        if (!line || /^\s*#/.test(line)) continue;
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        env[key] = value;
    }
    return env;
}

function parseJ2teamCookies(text) {
    try {
        const parsed = JSON.parse(text);
        let cookieArray = [];
        if (Array.isArray(parsed)) {
            cookieArray = parsed;
        } else if (parsed && Array.isArray(parsed.cookies)) {
            cookieArray = parsed.cookies;
        } else {
            return null;
        }

        const cookieStr = cookieArray.map(c => `${c.name}=${c.value}`).join('; ');
        
        let csrfToken = '';
        const exactNames = ['tt_csrf_token', 'csrf_session_id', 'passport_csrf_token', 'ac_csrftoken', 'tt_csrf_token_default'];
        
        for (const name of exactNames) {
            const found = cookieArray.find(c => c.name === name);
            if (found && found.value) {
                csrfToken = found.value;
                break;
            }
        }
        
        if (!csrfToken) {
            const found = cookieArray.find(c => String(c.name || '').toLowerCase().includes('csrf'));
            if (found && found.value) {
                csrfToken = found.value;
            }
        }

        return {
            TIKTOK_COOKIE: cookieStr,
            TIKTOK_CSRF_TOKEN: csrfToken
        };
    } catch (err) {
        return null;
    }
}

function quoteEnvValue(value) {
    value = String(value || '');
    if (/^[A-Za-z0-9_./:@-]*$/.test(value)) return value;
    return JSON.stringify(value);
}

async function loadEnvFile() {
    try {
        return parseEnv(await fsp.readFile(ENV_PATH, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        throw err;
    }
}

async function saveEnvFile(updates) {
    let raw = '';
    try { raw = await fsp.readFile(ENV_PATH, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    const lines = raw ? raw.split(/\r?\n/) : [];
    const seen = new Set();
    const nextLines = lines.map((line) => {
        const idx = line.indexOf('=');
        if (idx < 0 || /^\s*#/.test(line)) return line;
        const key = line.slice(0, idx).trim();
        if (!Object.prototype.hasOwnProperty.call(updates, key)) return line;
        seen.add(key);
        return `${key}=${quoteEnvValue(updates[key])}`;
    });
    for (const [key, value] of Object.entries(updates)) {
        if (!seen.has(key)) nextLines.push(`${key}=${quoteEnvValue(value)}`);
    }
    await fsp.writeFile(ENV_PATH, nextLines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n', 'utf8');
}

async function reloadEnvFromFile() {
    const current = await loadEnvFile();
    Object.assign(process.env, current);
    return current;
}

async function ensureEnvInteractive(existingRl = null) {
    const rl = existingRl || createRl();
    try {
        const current = await loadEnvFile();
        const updates = {};
        console.log('\n=== Kiểm tra TikTok env ===');
        console.log(`TIKTOK_CSRF_TOKEN: ${maskSecret(current.TIKTOK_CSRF_TOKEN || process.env.TIKTOK_CSRF_TOKEN)}`);
        console.log(`TIKTOK_COOKIE: ${maskSecret(current.TIKTOK_COOKIE || process.env.TIKTOK_COOKIE)}`);
        const hasToken = current.TIKTOK_CSRF_TOKEN || process.env.TIKTOK_CSRF_TOKEN;
        const hasCookie = current.TIKTOK_COOKIE || process.env.TIKTOK_COOKIE;
        if (!hasToken || !hasCookie) {
            console.log('\n======================================================================');
            console.log('⚠️ CẢNH BÁO: CHƯA THIẾT LẬP THÔNG TIN ĐĂNG NHẬP TIKTOK!');
            console.log('Bạn có hai cách để lấy và cấu hình Cookie/CSRF:');
            console.log('----------------------------------------------------------------------');
            console.log('👉 CÁCH 1: Dùng J2TEAM Cookies (KHUYÊN DÙNG - ĐẦY ĐỦ VÀ NHANH NHẤT)');
            console.log('1. Cài extension J2TEAM Cookies trên trình duyệt Chrome/Edge/Cốc Cốc.');
            console.log('2. Đăng nhập tài khoản của bạn tại: https://www.tiktok.com/');
            console.log('3. Nhấp vào extension J2TEAM, chọn "Export" (Xuất) để tải tệp JSON về.');
            console.log('4. Sao chép toàn bộ nội dung trong tệp JSON đó và dán trực tiếp vào bên dưới.');
            console.log('----------------------------------------------------------------------');
            console.log('👉 CÁCH 2: Dùng DevTools Console (Có thể thiếu HttpOnly sessionid)');
            console.log('1. Đăng nhập https://www.tiktok.com/, nhấn F12 chọn tab "Console".');
            console.log('2. Copy đoạn mã dưới đây dán vào và nhấn Enter:');
            console.log('----------------------------------------------------------------------');
            try {
                const code = fs.readFileSync(path.join(__dirname, 'devtools_get_tiktok_auth.js'), 'utf8');
                console.log(code);
            } catch (e) {
                console.log(`// (Mở devtools_get_tiktok_auth.js trong thư mục để lấy mã)`);
            }
            console.log('----------------------------------------------------------------------');
            console.log('3. Copy toàn bộ văn bản kết quả in ra trong Console và dán vào bên dưới.');
            console.log('======================================================================\n');

            console.log('👉 HÃY DÁN KHỐI JSON CỦA J2TEAM HOẶC KHỐI CONFIG TỪ DEVTOOLS VÀO ĐÂY:');
            console.log('(Hoặc nhấn Enter để bỏ qua dán khối và cấu hình thủ công từng dòng)');
            console.log('----------------------------------------------------------------------');

            const pastedText = await new Promise((resolve) => {
                let lines = [];
                let resolved = false;
                let timer = null;
                
                const onLine = (line) => {
                    if (resolved) return;
                    const trimmed = line.trim();
                    lines.push(line);
                    
                    const textSoFar = lines.join('\n');
                    // Check if both keys are present
                    if (textSoFar.includes('TIKTOK_CSRF_TOKEN=') && textSoFar.includes('TIKTOK_COOKIE=')) {
                        resolved = true;
                        if (timer) clearTimeout(timer);
                        rl.removeListener('line', onLine);
                        resolve(textSoFar);
                        return;
                    }
                    
                    // Finished on empty line if we have some text, or immediately if empty
                    if (trimmed === '') {
                        resolved = true;
                        if (timer) clearTimeout(timer);
                        rl.removeListener('line', onLine);
                        resolve(textSoFar);
                        return;
                    }
                    
                    if (timer) clearTimeout(timer);
                    timer = setTimeout(() => {
                        if (!resolved) {
                            resolved = true;
                            rl.removeListener('line', onLine);
                            resolve(lines.join('\n'));
                        }
                    }, 100);
                };
                
                rl.on('line', onLine);
            });

            if (pastedText && pastedText.trim()) {
                const trimmed = pastedText.trim();
                if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                    const j2team = parseJ2teamCookies(trimmed);
                    if (j2team) {
                        if (j2team.TIKTOK_CSRF_TOKEN) updates.TIKTOK_CSRF_TOKEN = j2team.TIKTOK_CSRF_TOKEN;
                        if (j2team.TIKTOK_COOKIE) updates.TIKTOK_COOKIE = j2team.TIKTOK_COOKIE;
                        console.log('✅ Đã nhận diện và bóc tách thành công định dạng J2TEAM Cookies JSON!');
                    } else {
                        console.log('❌ Định dạng JSON không tương thích với cấu trúc J2TEAM Cookies.');
                    }
                } else {
                    const parsed = parseEnv(pastedText);
                    if (parsed.TIKTOK_CSRF_TOKEN) updates.TIKTOK_CSRF_TOKEN = parsed.TIKTOK_CSRF_TOKEN;
                    if (parsed.TIKTOK_COOKIE) updates.TIKTOK_COOKIE = parsed.TIKTOK_COOKIE;
                }
            }
        }

        if (typeof current.USE_RPC_SIGNER === 'undefined' && typeof process.env.USE_RPC_SIGNER === 'undefined') {
            updates.USE_RPC_SIGNER = 'false';
        }

        for (const key of REQUIRED_ENV) {
            const existing = updates[key] || current[key] || process.env[key] || '';
            if (existing) continue;
            const answer = await ask(rl, `Nhập ${key} (Enter để bỏ qua tạm): `);
            if (answer) updates[key] = answer;
        }

        const port = current.PORT || process.env.PORT || '';
        if (!port) {
            const answer = await ask(rl, 'PORT server muốn dùng (Enter = 3000): ');
            if (answer) updates.PORT = answer;
        }

        if (Object.keys(updates).length > 0) {
            await saveEnvFile(updates);
            await reloadEnvFromFile();
            console.log('✅ Đã cập nhật .env (không in secret ra màn hình).');
        } else {
            await reloadEnvFromFile();
            console.log('✅ Env đã đủ hoặc bạn chọn bỏ qua.');
        }
    } finally {
        if (!existingRl) rl.close();
    }
}

function pickVideoFile() {
    if (process.platform !== 'win32') return '';

    const psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
        '$dialog.Title = "Chon video can upload"',
        '$dialog.Filter = "Video files (*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v)|*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v|All files (*.*)|*.*"',
        '$dialog.Multiselect = $false',
        'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $dialog.FileName }',
    ].join('; ');

    const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: false,
    });

    if (result.error) {
        console.log(`[CANH BAO] Khong mo duoc hop thoai chon file: ${result.error.message}`);
        return '';
    }
    if (result.status !== 0) {
        const message = String(result.stderr || '').trim();
        if (message) console.log(`[CANH BAO] Hop thoai chon file loi: ${message}`);
        return '';
    }
    return String(result.stdout || '').trim().replace(/^"|"$/g, '');
}

function runNodeScript(script, args = []) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [script, ...args], {
            cwd: ROOT,
            stdio: 'inherit',
            shell: false,
            env: process.env,
        });
        child.on('error', err => {
            console.error(`[LOI] Khong chay duoc ${script}: ${err.message}`);
            resolve(1);
        });
        child.on('exit', code => resolve(typeof code === 'number' ? code : 1));
    });
}

function runNodeCheck(file) {
    const result = spawnSync(process.execPath, ['--check', file], {
        cwd: ROOT,
        stdio: 'inherit',
        shell: false,
        env: process.env,
    });
    return result.status === 0;
}

function openUrl(url) {
    if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
        return;
    }
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
}

function isValidJobId(jobId) {
    return /^[a-zA-Z0-9_-]{8,80}$/.test(String(jobId || ''));
}

function resolveInside(root, targetPath) {
    const rootResolved = path.resolve(root);
    const targetResolved = path.resolve(targetPath || '');
    const relative = path.relative(rootResolved, targetResolved);
    return {
        rootResolved,
        targetResolved,
        inside: relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative)),
    };
}

function manifestFilePath(jobId) {
    if (!isValidJobId(jobId)) throw new Error('Job ID không hợp lệ.');
    return path.join(MANIFEST_ROOT, `${jobId}.json`);
}

function resolveHistoryChoice(choice, jobs) {
    const text = String(choice || '').trim();
    if (!text) return null;
    const n = Number(text);
    if (Number.isInteger(n) && n >= 1 && n <= jobs.length) return jobs[n - 1];
    return jobs.find(item => item.manifest?.jobId === text) || null;
}

function safeLocalDirForManifest(manifest) {
    const jobId = String(manifest?.jobId || '');
    if (!isValidJobId(jobId)) throw new Error('Manifest có Job ID không hợp lệ.');

    const rawLocalDir = manifest?.source?.localDir || '';
    if (!rawLocalDir) return '';
    const check = resolveInside(PUBLIC_UPLOAD_ROOT, rawLocalDir);
    if (!check.inside) {
        throw new Error(`Từ chối xóa localDir ngoài public/upload: ${rawLocalDir}`);
    }
    if (path.basename(check.targetResolved) !== jobId) {
        throw new Error(`Từ chối xóa localDir không khớp Job ID: ${rawLocalDir}`);
    }
    return check.targetResolved;
}

async function pruneEmptyParents(startDir, stopRoot) {
    const stop = path.resolve(stopRoot);
    let current = path.dirname(path.resolve(startDir));
    while (current && current !== stop) {
        const check = resolveInside(stop, current);
        if (!check.inside) break;
        try {
            const entries = await fsp.readdir(current);
            if (entries.length > 0) break;
            await fsp.rmdir(current);
            current = path.dirname(current);
        } catch (err) {
            break;
        }
    }
}

async function uploadVideo(existingRl = null) {
    const rl = existingRl || createRl();
    try {
        await ensureEnvInteractive(rl);

        console.log('\nĐang mở cửa sổ chọn video...');
        let cleanPath = pickVideoFile();
        if (cleanPath) {
            console.log(`Đã chọn: ${cleanPath}`);
        } else {
            const videoPath = await ask(rl, '\nBạn chưa chọn file. Kéo-thả/nhập đường dẫn video cần upload (Enter để hủy): ');
            if (!videoPath) {
                console.log('Đã hủy upload video.');
                return;
            }
            cleanPath = videoPath.replace(/^"|"$/g, '');
        }

        if (!fs.existsSync(cleanPath)) {
            console.log('❌ Không tìm thấy file video.');
            return;
        }
        const title = await ask(rl, 'Tiêu đề (Enter = Auto timestamp): ');
        const desc = await ask(rl, 'Mô tả/hashtag (Enter = #fyp #xuhuong): ');
        const args = [cleanPath];
        if (title) args.push(title);
        if (desc) {
            if (!title) args.push('Auto ' + Date.now());
            args.push(desc);
        }
        const code = await runNodeScript('upload.js', args);
        console.log(code === 0 ? '\n✅ Upload command hoàn tất.' : `\n❌ Upload command thoát với mã ${code}.`);
    } finally {
        if (!existingRl) rl.close();
    }
}

function parseJsonWithTrailingRepair(raw) {
    try {
        return { value: JSON.parse(raw), repairedRaw: '' };
    } catch (originalErr) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        let end = -1;

        for (let i = 0; i < raw.length; i += 1) {
            const ch = raw[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') {
                inString = true;
                continue;
            }
            if (ch === '{' || ch === '[') depth += 1;
            else if (ch === '}' || ch === ']') {
                depth -= 1;
                if (depth === 0) {
                    end = i + 1;
                    break;
                }
            }
        }

        if (end > 0) {
            const candidate = raw.slice(0, end);
            const trailing = raw.slice(end);
            if (trailing.trim()) {
                try {
                    return { value: JSON.parse(candidate), repairedRaw: candidate };
                } catch (err) {}
            }
        }

        throw originalErr;
    }
}

async function readJsonFileSafe(filePath) {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = parseJsonWithTrailingRepair(raw);
    if (parsed.repairedRaw) await fsp.writeFile(filePath, parsed.repairedRaw + '\n', 'utf8');
    return parsed.value;
}

async function readManifests() {
    try {
        await fsp.mkdir(MANIFEST_ROOT, { recursive: true });
        const files = (await fsp.readdir(MANIFEST_ROOT)).filter(file => file.endsWith('.json'));
        const jobs = [];
        for (const file of files) {
            try {
                const manifest = await readJsonFileSafe(path.join(MANIFEST_ROOT, file));
                const uploaded = Array.isArray(manifest.segments) ? manifest.segments.filter(s => s.uploaded && s.imageUri).length : 0;
                const total = Array.isArray(manifest.segments) ? manifest.segments.length : 0;
                jobs.push({ manifest, uploaded, total });
            } catch (err) {}
        }
        jobs.sort((a, b) => String(b.manifest.createdAt || b.manifest.updatedAt || '').localeCompare(String(a.manifest.createdAt || a.manifest.updatedAt || '')));
        return jobs;
    } catch (err) {
        return [];
    }
}

function baseUrl() {
    const envBase = process.env.PUBLIC_BASE_URL || '';
    if (envBase) return envBase.replace(/\/$/, '');
    return `http://localhost:${process.env.PORT || 3000}`;
}

function linksForJob(jobId) {
    const base = baseUrl();
    const encodedJobId = encodeURIComponent(jobId);
    const embedPlayer = `${base}/player?jobId=${encodedJobId}&direct=1&auto=1&embed=1`;
    return {
        player: `${base}/player?jobId=${encodedJobId}&direct=1&auto=1`,
        embedPlayer,
        embedWrapper: `${base}/embed/player?jobId=${encodedJobId}`,
        iframe: `<iframe src="${embedPlayer.replace(/&/g, '&amp;')}" width="100%" height="600" style="border:0;background:#000;" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`,
        carrierHls: `${base}/carrier/${encodedJobId}/master.m3u8`,
        api: `${base}/api/jobs/${encodedJobId}?direct=1`,
    };
}

async function listHistory(showLinks = false) {
    await reloadEnvFromFile();
    const jobs = await readManifests();
    if (jobs.length < 1) {
        console.log('\nChưa có manifest upload nào trong upload/tiktok/manifests.');
        return jobs;
    }
    console.log('\n=== Lịch sử video đã upload ===');
    jobs.forEach((item, idx) => {
        const m = item.manifest;
        const complete = m.complete && item.uploaded === item.total ? 'complete' : 'incomplete';
        console.log(`\n[${idx + 1}] Job ID: ${m.jobId}`);
        console.log(`    Created: ${m.createdAt || '(unknown)'}`);
        console.log(`    Updated: ${m.updatedAt || '(unknown)'}`);
        console.log(`    Segments: ${item.uploaded}/${item.total} (${complete})`);
        console.log(`    Local HLS: ${m.source?.playlistPath || '(none)'}`);
        if (showLinks) {
            const links = linksForJob(m.jobId);
            console.log(`    Player: ${links.player}`);
            console.log(`    Embed Player: ${links.embedPlayer}`);
            console.log(`    Embed Wrapper: ${links.embedWrapper}`);
            console.log(`    Iframe: ${links.iframe}`);
            console.log(`    Carrier M3U8: ${links.carrierHls}`);
            console.log(`    API: ${links.api}`);
        }
    });
    return jobs;
}

async function extractLinks() {
    await reloadEnvFromFile();
    const rl = createRl();
    try {
        const jobs = await listHistory(false);
        if (jobs.length < 1) return;
        const choice = await ask(rl, '\nChọn số thứ tự job hoặc dán Job ID: ');
        if (!choice) return;
        const selected = resolveHistoryChoice(choice, jobs);
        const jobId = selected ? selected.manifest.jobId : choice;
        const links = linksForJob(jobId);
        console.log('\n=== URL trích xuất ===');
        console.log(`Player khuyến nghị: ${links.player}`);
        console.log(`Embed Player:       ${links.embedPlayer}`);
        console.log(`Embed Wrapper:      ${links.embedWrapper}`);
        console.log(`Iframe HTML:        ${links.iframe}`);
        console.log(`Carrier M3U8:       ${links.carrierHls}`);
        console.log(`Job API direct:     ${links.api}`);
        console.log('\nLưu ý: Carrier M3U8 trần không tự chạy thuật toán decode/cache/prefetch. Muốn nhúng sang web khác thì dùng Embed Player hoặc Iframe HTML ở trên.');
        const open = await ask(rl, '\nMở Player khuyến nghị trong trình duyệt luôn? (y/N): ');
        if (/^y(es)?$/i.test(open)) openUrl(links.player);
    } finally {
        rl.close();
    }
}

function printDeleteSummary(items) {
    console.log('\n=== Sẽ xóa LOCAL upload history ===');
    console.log('⚠️ Chỉ xóa manifest + file HLS/carrier local trên máy này. KHÔNG xóa ảnh/material đã upload trên TikTok.');
    for (const item of items) {
        const m = item.manifest;
        const manifestPath = manifestFilePath(m.jobId);
        let localDir = '';
        try { localDir = safeLocalDirForManifest(m); } catch (err) { localDir = `[BỊ CHẶN] ${err.message}`; }
        console.log(`\n- Job ID: ${m.jobId}`);
        console.log(`  Created: ${m.createdAt || '(unknown)'}`);
        console.log(`  Updated: ${m.updatedAt || '(unknown)'}`);
        console.log(`  Segments: ${item.uploaded}/${item.total}`);
        console.log(`  Manifest: ${manifestPath}`);
        console.log(`  Local HLS dir: ${localDir || '(none)'}`);
        console.log('  TikTok remote material: giữ nguyên / chưa xóa remote');
    }
}

async function deleteOneLocalJob(item) {
    const manifest = item.manifest;
    const jobId = String(manifest.jobId || '');
    const manifestPath = manifestFilePath(jobId);
    const manifestCheck = resolveInside(MANIFEST_ROOT, manifestPath);
    if (!manifestCheck.inside || path.basename(manifestCheck.targetResolved) !== `${jobId}.json`) {
        throw new Error(`Manifest path không an toàn cho job ${jobId}`);
    }

    const localDir = safeLocalDirForManifest(manifest);
    if (localDir) {
        await fsp.rm(localDir, { recursive: true, force: true });
        await pruneEmptyParents(localDir, PUBLIC_UPLOAD_ROOT);
    }
    await fsp.unlink(manifestCheck.targetResolved).catch(err => {
        if (err.code !== 'ENOENT') throw err;
    });
    return { jobId, localDir, manifestPath: manifestCheck.targetResolved };
}

async function deleteHistory(existingRl = null, options = {}) {
    await reloadEnvFromFile();
    const rl = existingRl || createRl();
    try {
        const jobs = await listHistory(false);
        if (jobs.length < 1) return;
        const nonInteractive = Boolean(options.choice);
        if (!nonInteractive) {
            console.log('\nChọn job để xóa local history:');
            console.log('- Nhập số thứ tự hoặc Job ID để xóa 1 job');
            console.log('- Nhập ALL để xóa toàn bộ lịch sử local');
            console.log('- Enter để hủy');
        }
        const choice = options.choice || await ask(rl, '\nLựa chọn xóa: ');
        if (!choice) {
            console.log('Đã hủy xóa lịch sử.');
            return;
        }

        let targets = [];
        if (/^all$/i.test(choice)) {
            targets = jobs;
        } else {
            const selected = resolveHistoryChoice(choice, jobs);
            if (!selected) {
                console.log('❌ Không tìm thấy job trong lịch sử.');
                return;
            }
            targets = [selected];
        }

        printDeleteSummary(targets);
        const confirmText = targets.length === 1 ? `DELETE ${targets[0].manifest.jobId}` : `DELETE ALL ${targets.length}`;
        const confirm = options.yesLocal ? confirmText : (options.confirm || await ask(rl, `\nGõ chính xác "${confirmText}" để xác nhận xóa local: `));
        if (confirm !== confirmText) {
            console.log('Đã hủy xóa lịch sử.');
            return;
        }

        const deleted = [];
        for (const item of targets) {
            deleted.push(await deleteOneLocalJob(item));
        }

        console.log(`\n✅ Đã xóa ${deleted.length} job khỏi lịch sử local.`);
        for (const item of deleted) {
            console.log(`- ${item.jobId}`);
            console.log(`  Manifest: ${item.manifestPath}`);
            if (item.localDir) console.log(`  Local dir: ${item.localDir}`);
        }
        console.log('ℹ️ Ảnh/material đã upload trên TikTok vẫn giữ nguyên; chức năng xóa remote chưa bật để tránh xóa nhầm dữ liệu ngoài hệ thống.');
    } finally {
        if (!existingRl) rl.close();
    }
}

async function downloadXbogusFiles() {
    console.log('\n=== Cập nhật bộ ký X-Bogus từ TikTok ===');
    console.log('[+] Đang tải trang HTML select-account từ TikTok...');
    const axios = require('axios');
    
    try {
        const htmlUrl = 'https://business.tiktok.com/select-account';
        const htmlRes = await axios.get(htmlUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 15000
        });
        const html = htmlRes.data;
        
        // Tìm URL của webmssdk trong HTML
        const webmssdkReg = /https:\/\/[^\s"']+\/webmssdk\/[^\s"']+\.js/g;
        const match = html.match(webmssdkReg);
        let webmssdkUrl = 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/webmssdk/1.0.0.162/webmssdk.js';
        
        if (match && match.length > 0) {
            webmssdkUrl = match[0];
            console.log(`[+] Tìm thấy URL webmssdk trực tiếp: ${webmssdkUrl}`);
        } else {
            console.log(`[!] Không tìm thấy URL động. Dùng URL mặc định: ${webmssdkUrl}`);
        }
        
        console.log('[+] Đang tải file webmssdk.js...');
        const jsRes = await axios.get(webmssdkUrl, { timeout: 15000 });
        const jsCode = jsRes.data;
        
        const deobfDir = path.join(__dirname, 'deobfuscator');
        if (!fs.existsSync(deobfDir)) {
            fs.mkdirSync(deobfDir, { recursive: true });
        }
        
        const htmlPath = path.join(deobfDir, 'select_account.html');
        const jsPath = path.join(deobfDir, 'webmssdk_original.js');
        
        fs.writeFileSync(htmlPath, html, 'utf8');
        fs.writeFileSync(jsPath, jsCode, 'utf8');
        
        console.log(`✅ Đã lưu HTML tại: ${htmlPath}`);
        console.log(`✅ Đã lưu JS tại: ${jsPath}`);
        console.log('🎉 CẬP NHẬT BỘ KÝ THÀNH CÔNG! Bộ ký offline JSDOM đã được đồng bộ với phiên bản mới nhất.');
    } catch (err) {
        console.error('❌ Lỗi khi tải bộ ký mới:', err.message);
    }
}

async function startServer() {
    console.log(`\nServer sẽ chạy tại ${baseUrl()}`);
    console.log('Nhấn Ctrl+C để dừng server.');
    await runNodeScript('server.js', []);
}

async function runChecks() {
    console.log('\n=== Check sẵn sàng ===');
    console.log(`Node: ${process.version}`);
    await ensureEnvInteractive();
    const missingEnv = REQUIRED_ENV.filter(key => !(process.env[key] || ''));
    if (missingEnv.length) console.log(`⚠️ Env còn thiếu: ${missingEnv.join(', ')}`);
    else console.log('✅ Env TikTok đã có đủ key chính.');

    // Auto-fetch X-Bogus offline files if missing
    const htmlPath = path.join(__dirname, 'deobfuscator', 'select_account.html');
    const jsPath = path.join(__dirname, 'deobfuscator', 'webmssdk_original.js');
    if (!fs.existsSync(htmlPath) || !fs.existsSync(jsPath)) {
        console.log('\n=== Tải bộ ký X-Bogus mặc định ===');
        console.log('⚠️ Phát hiện thiếu tệp bộ ký X-Bogus cục bộ. Đang tự động tải...');
        await downloadXbogusFiles();
    } else {
        console.log('✅ Tệp bộ ký X-Bogus cục bộ đã sẵn sàng.');
    }

    console.log('\n=== Syntax check source chính ===');
    let syntaxOk = true;
    for (const file of CHECK_FILES) {
        process.stdout.write(`- ${file}: `);
        const ok = runNodeCheck(file);
        console.log(ok ? 'OK' : 'FAIL');
        if (!ok) syntaxOk = false;
    }
    if (!syntaxOk) throw new Error('Syntax check thất bại, xem lỗi ở trên.');

    console.log('\n=== Test carrier encode/decode ===');
    try {
        const crypto = require('crypto');
        const os = require('os');
        const { encodePayloadToPng, decodePngCarrier } = require('./carrier');
        const payload = crypto.randomBytes(1024 * 1024 + 123);
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttk-carrier-'));
        const pngPath = path.join(workDir, 'carrier.png');

        await encodePayloadToPng(payload, pngPath, {
            jobId: 'local-carrier-test-job-000000000000',
            index: 2,
            total: 5,
        });

        const decoded = await decodePngCarrier(pngPath);
        if (decoded.jobId !== 'local-carrier-test-job-000000000000') throw new Error('jobId mismatch');
        if (decoded.index !== 2) throw new Error('index mismatch');
        if (decoded.total !== 5) throw new Error('total mismatch');
        if (!decoded.payload.equals(payload)) throw new Error('payload mismatch');

        fs.rmSync(workDir, { recursive: true, force: true });
        console.log('✅ carrier local encode/decode OK');
    } catch (err) {
        throw new Error(`test_carrier thất bại: ${err.message}`);
    }
}

async function showMenu() {
    while (true) {
        const rl = createRl();
        console.log('\n==============================');
        console.log(' TikTok Carrier Launcher');
        console.log('==============================');
        console.log('1. Check cài đặt/env và test sẵn sàng');
        console.log('2. Nhập/cập nhật TikTok cookie / csrf token');
        console.log('3. Upload file video');
        console.log('4. Xem lịch sử video đã upload');
        console.log('5. Trích xuất URL chiếu phim + m3u8');
        console.log('6. Xóa lịch sử upload local');
        console.log('7. Cập nhật bộ ký X-Bogus từ TikTok');
        console.log('8. Chạy web server/player');
        console.log('9. Thoát');
        const choice = await ask(rl, 'Chọn chức năng: ');
        rl.close();

        try {
            if (choice === '1') await runChecks();
            else if (choice === '2') await ensureEnvInteractive();
            else if (choice === '3') await uploadVideo();
            else if (choice === '4') await listHistory(true);
            else if (choice === '5') await extractLinks();
            else if (choice === '6') await deleteHistory();
            else if (choice === '7') await downloadXbogusFiles();
            else if (choice === '8') await startServer();
            else if (choice === '9') return;
            else console.log('Lựa chọn không hợp lệ.');
        } catch (err) {
            console.log(`❌ Lỗi: ${err.message}`);
        }
    }
}

const command = process.argv[2] || 'menu';
(async () => {
    if (command === 'check') await runChecks();
    else if (command === 'env') await ensureEnvInteractive();
    else if (command === 'upload') await uploadVideo();
    else if (command === 'history') await listHistory(true);
    else if (command === 'links') await extractLinks();
    else if (command === 'delete-history' || command === 'delete') {
        const choice = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '';
        const yesLocal = process.argv.includes('--yes') || process.argv.includes('--yes-local');
        await deleteHistory(null, { choice, yesLocal });
    } else if (command === 'server') await startServer();
    else if (command === 'xbogus') await downloadXbogusFiles();
    else {
        // 1. Tự động kiểm tra cấu hình tài khoản (Cookie & CSRF)
        const current = await loadEnvFile();
        const hasToken = current.TIKTOK_CSRF_TOKEN || process.env.TIKTOK_CSRF_TOKEN;
        const hasCookie = current.TIKTOK_COOKIE || process.env.TIKTOK_COOKIE;
        
        if (!hasToken || !hasCookie) {
            const rl = createRl();
            try {
                await ensureEnvInteractive(rl);
            } finally {
                rl.close();
            }
        }
        
        // 2. Tự động kiểm tra file bộ ký X-Bogus JSDOM
        const htmlPath = path.join(__dirname, 'deobfuscator', 'select_account.html');
        const jsPath = path.join(__dirname, 'deobfuscator', 'webmssdk_original.js');
        if (!fs.existsSync(htmlPath) || !fs.existsSync(jsPath)) {
            await downloadXbogusFiles();
        }
        
        // 3. Mở Menu chính
        await showMenu();
    }
})().catch((err) => {
    console.error('\n[FATAL] Launcher crash:');
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
});
