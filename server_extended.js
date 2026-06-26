// server_extended.js
require('dotenv').config();

// Auto-fallback: Sync TIKTOK_COOKIE from CONSUMER_COOKIES_JSON if missing
if (!process.env.TIKTOK_COOKIE && process.env.CONSUMER_COOKIES_JSON) {
  try {
    const parsed = JSON.parse(process.env.CONSUMER_COOKIES_JSON);
    if (Array.isArray(parsed) && parsed.length > 0) {
      process.env.TIKTOK_COOKIE = parsed.map(c => `${c.name}=${c.value}`).join('; ');
    }
  } catch (e) {}
}

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const axios = require('axios');
const tiktokService = require('./tiktok');
const originalServer = require('./server');

const app = originalServer;

const TOKENS_FILE = path.join(__dirname, 'users_tokens.json');

// Ensure token file exists
function ensureTokensFile() {
  if (!fs.existsSync(TOKENS_FILE)) {
    const defaultData = [
      {
        username: 'admin',
        token: 'tok_admin_default_719',
        createdAt: new Date().toISOString(),
        active: true
      }
    ];
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(defaultData, null, 2), 'utf8');
  }
}

async function readTokens() {
  ensureTokensFile();
  try {
    const raw = await fsp.readFile(TOKENS_FILE, 'utf8');
    let tokens = JSON.parse(raw);
    if (!Array.isArray(tokens)) {
      tokens = [];
    }
    // Self-healing: if there is no active token, reactivate tok_admin_default_719
    const activeCount = tokens.filter(t => t.active).length;
    if (activeCount === 0) {
      console.warn('[Security] No active tokens found. Reactivating tok_admin_default_719 for safety.');
      const adminToken = tokens.find(t => t.token === 'tok_admin_default_719');
      if (adminToken) {
        adminToken.active = true;
      } else {
        tokens.push({
          username: 'admin',
          token: 'tok_admin_default_719',
          createdAt: new Date().toISOString(),
          active: true
        });
      }
      await writeTokens(tokens);
    }
    return tokens;
  } catch (e) {
    return [];
  }
}

async function writeTokens(tokens) {
  await fsp.writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
}

async function validateToken(tokenStr) {
  const tokens = await readTokens();
  return tokens.some(t => t.token === tokenStr && t.active);
}

// Authentication middleware
async function authMiddleware(req, res, next) {
  // Allow index, static dashboard files, player, carrier streams
  const publicPaths = ['/dashboard', '/player', '/carrier', '/upload', '/favicon.ico'];
  if (publicPaths.some(p => req.path.startsWith(p)) && !req.path.startsWith('/api/')) {
    return next();
  }
  
  // Authenticate /api/ routes
  if (req.path.startsWith('/api/')) {
    let token = '';
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else if (req.query.token) {
      token = String(req.query.token).trim();
    }
    
    if (!token) {
      return res.status(401).json({ ok: false, error: 'Thiếu API Token (Authorization: Bearer <token>)' });
    }
    
    const isValid = await validateToken(token);
    if (!isValid) {
      return res.status(403).json({ ok: false, error: 'API Token không hợp lệ hoặc đã bị vô hiệu hóa' });
    }
  }
  
  next();
}

// Inject authMiddleware at the beginning of the stack to protect routes inherited from server.js
app.use(authMiddleware);
if (app._router && Array.isArray(app._router.stack)) {
  const authLayer = app._router.stack.pop();
  let insertIndex = 0;
  for (let i = 0; i < app._router.stack.length; i++) {
    const name = app._router.stack[i].name;
    if (name === 'query' || name === 'expressInit') {
      insertIndex = i + 1;
    }
  }
  app._router.stack.splice(insertIndex, 0, authLayer);
}

// Clean up original routes registered in server.js that we want to override
const routerObj = app.router || app._router;
if (routerObj && Array.isArray(routerObj.stack)) {
  routerObj.stack = routerObj.stack.filter(layer => {
    if (!layer.route) return true;
    const path = layer.route.path;
    const methods = layer.route.methods || {};
    const shouldRemove = methods.get && (
      path === '/api/jobs' || 
      path === '/api/jobs/:jobId' || 
      path === '/api/jobs/:id' || 
      path === '/' ||
      path === '/player' ||
      path === '/embed/player'
    );
    if (shouldRemove) {
      console.log(`[Extension] Removing original route handler: GET ${path}`);
      return false;
    }
    return true;
  });
}

function isValidJobId(jobId) {
  return /^[a-zA-Z0-9_-]{8,80}$/.test(String(jobId || ''));
}

function parseSignedUrlExpiry(url) {
  try {
    const parsed = new URL(url);
    const value = parsed.searchParams.get('x-expires') || parsed.searchParams.get('X-Expires') || parsed.searchParams.get('expires') || parsed.searchParams.get('Expires');
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds > 100000000000 ? seconds : seconds * 1000;
    }
  } catch (err) {}
  return null;
}

function directUrlMeta(url) {
  const now = Date.now();
  const expiresAt = parseSignedUrlExpiry(url);
  const safetyMs = expiresAt ? Math.min(Math.max(60000, Math.floor((expiresAt - now) * 0.1)), 120000) : 120000;
  return {
    serverNow: now,
    expiresAt,
    refreshAfter: expiresAt ? Math.max(now, expiresAt - safetyMs) : null,
  };
}

function sanitizeSegment(manifest, segment, includeDirect) {
  let publicImageUrl = segment.uploaded && segment.publicImageUrl ? segment.publicImageUrl : '';
  if (publicImageUrl.includes('p16-va.tiktokcdn.com')) {
    publicImageUrl = publicImageUrl.replace('p16-va.tiktokcdn.com', 'p16-sg.tiktokcdn.com');
  }
  let signedImageUrl = includeDirect && segment.uploaded && segment.resolvedImageUrl ? segment.resolvedImageUrl : '';
  if (signedImageUrl.includes('p16-va.tiktokcdn.com')) {
    signedImageUrl = signedImageUrl.replace('p16-va.tiktokcdn.com', 'p16-sg.tiktokcdn.com');
  } else if (signedImageUrl.includes('p16-sign-va.tiktokcdn.com')) {
    signedImageUrl = signedImageUrl.replace('p16-sign-va.tiktokcdn.com', 'p16-sign-sg.tiktokcdn.com');
  }
  const directMeta = signedImageUrl ? directUrlMeta(signedImageUrl) : {};
  return {
    index: segment.index,
    duration: segment.duration,
    uploaded: Boolean(segment.uploaded && segment.imageUri),
    imageUrl: segment.uploaded && segment.imageUri ? `/api/jobs/${encodeURIComponent(manifest.jobId)}/images/${segment.index}` : '',
    publicImageUrl,
    directImageUrl: signedImageUrl,
    expiresAt: directMeta.expiresAt || null,
    refreshAfter: directMeta.refreshAfter || null,
    serverNow: directMeta.serverNow || Date.now(),
    assetVersion: manifest.assetVersion || manifest.jobId,
    tsBytes: Number(segment.tsBytes || 0),
    payloadBytes: Number(segment.payloadBytes || 0),
    carrierBytes: Number(segment.carrierBytes || 0),
    pngBytes: Number(segment.pngBytes || 0),
    width: Number(segment.width || 0),
    height: Number(segment.height || 0),
    overTarget: Boolean(segment.overTarget),
    overMax: Boolean(segment.overMax),
  };
}

function sanitizeJob(manifest, options = {}) {
  const uploadedSegments = manifest.segments.filter(segment => segment.uploaded && segment.imageUri);
  const includeDirect = Boolean(options.includeDirect);
  const size = getManifestSizeBytes(manifest);
  return {
    jobId: manifest.jobId,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    total: manifest.segments.length,
    uploaded: uploadedSegments.length,
    complete: Boolean(manifest.complete) && uploadedSegments.length === manifest.segments.length,
    size,
    sourceSize: Number(manifest.source?.sizeBytes || 0),
    carrierPlaylistUrl: `/carrier/${encodeURIComponent(manifest.jobId)}/master.m3u8`,
    carrierPlayerUrl: `/player?jobId=${encodeURIComponent(manifest.jobId)}`,
    directCarrierPlayerUrl: `/player?jobId=${encodeURIComponent(manifest.jobId)}&direct=1&auto=1`,
    localPlaylistUrl: manifest.source?.playlistPath || '',
    fallbackEnabled: process.env.ENABLE_SERVER_SEGMENT_FALLBACK === 'true',
    directEnabled: includeDirect,
    assetVersion: manifest.assetVersion || manifest.jobId,
    sizing: manifest.sizing || null,
    serverNow: Date.now(),
    segments: manifest.segments.map(segment => sanitizeSegment(manifest, segment, includeDirect)),
  };
}

function renderPlayerPage(initial) {
  const safeInitial = JSON.stringify(initial || {})
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const fallbackEnabled = process.env.ENABLE_SERVER_SEGMENT_FALLBACK === 'true';
  const bodyClass = initial && initial.embed ? ' class="embed-mode"' : '';
  return `<!doctype html>
<html lang="vi">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>TikTok Carrier HLS Player</title>
    <style>
        html, body { min-height: 100%; }
        body { margin: 0; font-family: Arial, sans-serif; background: #111; color: #fff; }
        main { max-width: 1100px; margin: 0 auto; padding: 24px; }
        video { width: 100%; max-height: 75vh; background: #000; border-radius: 10px; }
        input { width: 100%; box-sizing: border-box; padding: 10px; margin: 8px 0 12px; border-radius: 6px; border: 1px solid #555; background: #222; color: #fff; }
        button { padding: 10px 16px; border: 0; border-radius: 6px; cursor: pointer; margin-right: 8px; }
        label { display: block; color: #ddd; margin-top: 14px; }
        .hint { color: #bbb; line-height: 1.5; }
        .status { color: #78d6ff; white-space: pre-wrap; line-height: 1.45; }
        .error { color: #ff7676; white-space: pre-wrap; line-height: 1.45; }
        .telemetry { color: #9cffb1; background: #1b1b1b; border: 1px solid #333; border-radius: 8px; padding: 12px; white-space: pre-wrap; line-height: 1.45; overflow-x: auto; }
        body.embed-mode { width: 100vw; height: 100vh; min-height: 100vh; overflow: hidden; background: #000; }
        body.embed-mode main { width: 100%; height: 100vh; max-width: none; margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; }
        body.embed-mode h1,
        body.embed-mode .controls-panel,
        body.embed-mode .hint,
        body.embed-mode .status,
        body.embed-mode .telemetry { display: none; }
        body.embed-mode video { width: 100%; height: 100%; max-height: none; border-radius: 0; object-fit: contain; }
        body.embed-mode .error { position: absolute; left: 16px; right: 16px; bottom: 16px; margin: 0; padding: 10px 12px; border-radius: 8px; background: rgba(0, 0, 0, 0.72); color: #ff8a8a; z-index: 2; }
        body.embed-mode .error:empty { display: none; }
    </style>
    <script>
    (function() {
        const originalFetch = window.fetch;
        window.fetch = function(url, options = {}) {
            if (typeof url === 'string' && (url.startsWith('/api/') || url.includes('/api/'))) {
                const initial = window.__PLAYER_INITIAL__ || {};
                const query = new URLSearchParams(window.location.search);
                const token = initial.token || query.get('token') || 'tok_admin_default_719';
                options.headers = {
                    ...options.headers,
                    'Authorization': 'Bearer ' + token
                };
            }
            return originalFetch.call(this, url, options);
        };
    })();
    </script>
</head>
<body${bodyClass}>
<main>
    <h1>TikTok Carrier HLS Player</h1>
    <video id="video" controls autoplay muted playsinline></video>

    <section class="controls-panel">
        <label>Carrier Job ID (phát trực tiếp từ ảnh TikTok carrier)</label>
        <input id="jobId" placeholder="<jobId>">
        <button id="loadJob">Load carrier job</button>

        <label>Hoặc M3U8 local/debug</label>
        <input id="src" placeholder="/upload/<date>/<jobId>/master.m3u8">
        <button id="loadSrc">Load m3u8</button>
    </section>

    <p class="hint">Carrier mode: browser tự decode PNG pixel thành TS segment rồi feed vào hls.js. Mở <code>&direct=1&auto=1</code> để ưu tiên CDN TikTok, tự refresh URL, tự chọn profile/mode, dùng IndexedDB cache, sliding-window prefetch, Web Worker decode và fallback proxy/server khi cần.</p>
    <p id="status" class="status"></p>
    <p id="error" class="error"></p>
    <pre id="telemetry" class="telemetry"></pre>
</main>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js"></script>
<script>window.__PLAYER_INITIAL__ = ${safeInitial}; window.__SERVER_SEGMENT_FALLBACK__ = ${JSON.stringify(fallbackEnabled)};</script>
<script src="/carrier-player.js"></script>
</body>
</html>`;
}

app.get('/embed/player', (req, res) => {
    const jobId = String(req.query.jobId || '');
    const token = String(req.query.token || '');
    if (!isValidJobId(jobId)) {
        res.status(400).type('text').send('Invalid jobId');
        return;
    }

    const tokenParam = token ? `&token=\${encodeURIComponent(token)}` : '';
    const playerPath = `/player?jobId=\${encodeURIComponent(jobId)}&direct=1&auto=1&embed=1\${tokenParam}`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'autoplay=(self), fullscreen=(self), picture-in-picture=(self)');
    res.type('html').send(`<!doctype html>
<html lang="vi">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>TikTok Carrier Embed</title>
    <style>
        html, body { width: 100%; height: 100%; margin: 0; background: #000; overflow: hidden; }
        iframe { width: 100%; height: 100%; border: 0; display: block; background: #000; }
    </style>
</head>
<body>
    <iframe src="\${playerPath}" title="TikTok Carrier Player" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
</body>
</html>`);
});

app.get('/player', async (req, res) => {
    const initial = {
        src: req.query.src || '',
        jobId: req.query.jobId || '',
        direct: req.query.direct === '1',
        auto: req.query.auto !== '0',
        embed: req.query.embed === '1',
        token: req.query.token || '',
        bootstrapJob: null,
    };

    try {
        if (initial.jobId && isValidJobId(initial.jobId)) {
            const manifest = await loadManifest(initial.jobId);
            initial.bootstrapJob = sanitizeJob(manifest, { includeDirect: initial.direct });
        }
    } catch (err) {
        initial.bootstrapError = err.message;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.type('html').send(renderPlayerPage(initial));
});

const PORT = Number(process.env.PORT || 3000);

const { v4: uuidv4 } = require('uuid');

const activeJobs = new Map();
const activeReconstructs = new Map();

function startReconstruction(jobId) {
  if (activeReconstructs.has(jobId)) {
    return activeReconstructs.get(jobId);
  }

  const outputDir = path.join(ROOT, 'tmp_reconstruct');
  const outputPath = path.join(outputDir, `${jobId}.mp4`);
  
  const state = {
    status: 'processing',
    percent: 0,
    message: 'Bắt đầu quá trình khôi phục...',
    outputPath,
    error: null
  };
  activeReconstructs.set(jobId, state);

  fsp.mkdir(outputDir, { recursive: true }).then(() => {
    const child = spawn(process.execPath, [path.join(ROOT, 'decoded.js'), outputPath, jobId], {
      cwd: ROOT,
      env: { ...process.env, TIKTOK_DECODE_JOB_ID: jobId },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let buffer = '';

    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const parts = buffer.split(/[\r\n]+/);
      buffer = parts.pop();
      
      for (const line of parts) {
        if (!line.trim()) continue;
        console.log(`[Reconstruct: ${jobId}] ${line}`);

        const matchPart = line.match(/\[(\d+)\/(\d+)\]/);
        if (matchPart) {
          const current = parseInt(matchPart[1], 10);
          const total = parseInt(matchPart[2], 10);
          state.percent = Math.round((current / (total + 1)) * 95);
          state.message = line.trim();
        }
        
        if (line.includes('Đang ghép')) {
          state.percent = 96;
          state.message = 'Đang ghép các phân đoạn video (FFmpeg)...';
        }
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('close', code => {
      if (code === 0) {
        state.status = 'complete';
        state.percent = 100;
        state.message = 'Khôi phục hoàn thành!';
      } else {
        state.status = 'failed';
        state.error = stderr.trim() || `decoded.js exited with code ${code}`;
        state.message = `Lỗi: ${state.error}`;
      }
    });
    
    child.on('error', err => {
      state.status = 'failed';
      state.error = err.message;
      state.message = `Lỗi: ${err.message}`;
    });
  }).catch(err => {
    state.status = 'failed';
    state.error = err.message;
    state.message = `Lỗi: ${err.message}`;
  });

  return state;
}

function sendSseToClient(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (e) {}
}

async function writeJson(filePath, data) {
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function runBackgroundJob(jobId, jobFile, segmentConcurrency, uploadConcurrency, filename) {
  const job = activeJobs.get(jobId);
  if (job) job.jobFile = jobFile;

  try {
    // 1. Ghi manifest ban đầu
    const manifestPathJson = manifestPath(jobId);
    const initialManifest = {
      version: 4,
      jobId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      complete: false,
      status: 'processing',
      source: {
        filename,
      },
      segments: []
    };
    await writeJson(manifestPathJson, initialManifest);

    // 2. Probe video
    const progressEvent = (event, data) => {
      const j = activeJobs.get(jobId);
      if (j) {
        j.logs.push({ event, data });
        for (const client of j.sseClients) {
          sendSseToClient(client, event, data);
        }
      }
    };

    progressEvent('progress', { step: 'probe', percent: 5, message: 'Video probing', segmentConcurrency, uploadConcurrency });
    const probe = await tiktokService.probeVideo(jobFile);
    progressEvent('progress', { step: 'probe-complete', percent: 8, message: 'Probe complete', probe });

    const currentJob = activeJobs.get(jobId);
    if (currentJob && currentJob.status === 'cancelled') return;

    // 3. Chạy processJob
    const result = await tiktokService.processJob(
      jobFile,
      4,
      probe.duration,
      (percent, message, details = {}) => {
        const j = activeJobs.get(jobId);
        if (j) {
          j.percent = percent;
          j.step = details.phase || 'pipeline';
          j.message = message;
          j.details = details;
          
          const eventData = { step: j.step, percent, message, ...details };
          progressEvent('progress', eventData);
        }
      },
      { 
        ...probe,
        jobId, 
        source: 'dashboard', 
        segmentConcurrency, 
        uploadConcurrency,
        isAborted: () => {
          const j = activeJobs.get(jobId);
          return !j || j.status === 'cancelled';
        },
        onFfmpegSpawn: (ps) => {
          const j = activeJobs.get(jobId);
          if (j) j.ffmpegProcess = ps;
        }
      }
    );

    const j = activeJobs.get(jobId);
    if (j) {
      if (j.status === 'cancelled') return;
      j.status = 'complete';
      j.percent = 100;
      
      const doneData = {
        ok: true,
        jobId,
        playlistUrl: result.playlistUrl,
        carrierPlaylistUrl: result.carrierPlaylistUrl,
        carrierPlayerUrl: result.carrierPlayerUrl,
        sizing: result.sizing
      };
      progressEvent('done', doneData);
      
      for (const client of j.sseClients) {
        client.end();
      }
      j.sseClients.clear();
      setTimeout(() => activeJobs.delete(jobId), 10 * 60 * 1000);
    }
  } catch (err) {
    const j = activeJobs.get(jobId);
    if (j) {
      if (j.status === 'cancelled') return;
      j.status = 'failed';
      
      const errData = { ok: false, error: err.message };
      progressEvent('error', errData);
      
      for (const client of j.sseClients) {
        client.end();
      }
      j.sseClients.clear();
      setTimeout(() => activeJobs.delete(jobId), 10 * 60 * 1000);
    }
    // Ghi status: 'failed' lên manifest trên đĩa
    const mPath = manifestPath(jobId);
    loadManifest(jobId).then(async manifest => {
      manifest.complete = false;
      manifest.status = 'failed';
      manifest.updatedAt = new Date().toISOString();
      await writeJson(mPath, manifest);
    }).catch(() => {});
  } finally {
    if (jobFile) await fsp.unlink(jobFile).catch(() => {});
  }
}

async function runTorrentBackgroundJob(jobId, magnetUrl, segmentConcurrency, uploadConcurrency) {
  const job = activeJobs.get(jobId);
  const progressEvent = (event, data) => {
    const j = activeJobs.get(jobId);
    if (j) {
      j.logs.push({ event, data });
      for (const client of j.sseClients) {
        sendSseToClient(client, event, data);
      }
    }
  };

  const tempDir = path.join(ROOT, 'tmp_upload');
  const downloadDir = path.join(tempDir, `torrent_${jobId}`);
  await fsp.mkdir(downloadDir, { recursive: true });

  let client;
  let finished = false;

  try {
    progressEvent('progress', { step: 'torrent-start', percent: 0, message: 'Đang khởi tạo WebTorrent client...', segmentConcurrency, uploadConcurrency });

    const { default: WebTorrent } = await import('webtorrent');
    client = new WebTorrent();

    // 1. Tạo manifest ban đầu
    const manifestPathJson = manifestPath(jobId);
    const initialManifest = {
      version: 4,
      jobId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      complete: false,
      status: 'processing',
      source: {
        filename: 'Tải từ Torrent',
      },
      segments: []
    };
    await writeJson(manifestPathJson, initialManifest);

    // Timeout nếu không lấy được metadata của torrent trong 60 giây
    const metadataTimeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        if (client) client.destroy();
        progressEvent('error', { ok: false, error: 'Timeout: Không lấy được metadata torrent (không tìm thấy peers).' });
      }
    }, 60000);

    client.add(magnetUrl, { path: downloadDir }, function (torrent) {
      clearTimeout(metadataTimeout);
      if (finished) return;

      progressEvent('progress', { step: 'torrent-metadata', percent: 1, message: `Đã kết nối! Đang tìm file video lớn nhất... (Peers: ${torrent.numPeers})` });

      // Tìm file video lớn nhất
      const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.ts', '.m4v'];
      const videoFiles = torrent.files.filter(f => videoExtensions.some(ext => f.name.toLowerCase().endsWith(ext)));
      
      const file = videoFiles.length > 0
        ? videoFiles.reduce((a, b) => a.length > b.length ? a : b)
        : torrent.files.reduce((a, b) => a.length > b.length ? a : b);

      if (!file) {
        finished = true;
        client.destroy();
        progressEvent('error', { ok: false, error: 'Không tìm thấy file nào trong Torrent.' });
        return;
      }

      progressEvent('progress', { step: 'torrent-selected', percent: 2, message: `Đã chọn: ${file.name} (${formatBytes(file.length)})` });

      // Chỉ tải file được chọn, deselect các file khác để tiết kiệm băng thông
      torrent.files.forEach(f => {
        if (f !== file) {
          f.deselect();
        }
      });

      let lastEmitTime = Date.now();

      torrent.on('download', function () {
        if (finished) return;
        const now = Date.now();
        if (now - lastEmitTime > 1500) {
          lastEmitTime = now;
          const speed = torrent.downloadSpeed;
          const progress = torrent.progress;
          const percent = Math.round(progress * 100);
          
          progressEvent('progress', {
            step: 'torrent-downloading',
            percent: Math.min(99, Math.round(percent * 0.95)), // 0-95% cho download
            realPercent: percent,
            message: `Đang tải: ${percent}% (${formatBytes(speed)}/s) · Peers: ${torrent.numPeers}`
          });
        }
      });

      torrent.on('done', async function () {
        if (finished) return;
        finished = true;

        const jobFile = path.join(downloadDir, file.path);
        const filename = file.name;
        
        progressEvent('progress', { step: 'torrent-done', percent: 95, message: 'Đã tải xong file video từ Torrent! Bắt đầu xử lý video...' });

        // Cập nhật manifest tên file thật
        try {
          const manifest = await loadManifest(jobId);
          manifest.source.filename = filename;
          manifest.source.sizeBytes = file.length;
          await writeJson(manifestPathJson, manifest);
        } catch (e) {}

        // Giải phóng client
        client.destroy();

        // Chạy tiếp tục luồng xử lý video (probe, processJob...)
        try {
          progressEvent('progress', { step: 'probe', percent: 96, message: 'Video probing', segmentConcurrency, uploadConcurrency });
          const probe = await tiktokService.probeVideo(jobFile);
          progressEvent('progress', { step: 'probe-complete', percent: 97, message: 'Probe complete', probe });

          const currentJob = activeJobs.get(jobId);
          if (currentJob && currentJob.status === 'cancelled') return;

          const result = await tiktokService.processJob(
            jobFile,
            4,
            probe.duration,
            (percent, message, details = {}) => {
              const j = activeJobs.get(jobId);
              if (j) {
                j.percent = percent;
                j.step = details.phase || 'pipeline';
                j.message = message;
                j.details = details;
                
                const eventData = { step: j.step, percent, message, ...details };
                progressEvent('progress', eventData);
              }
            },
            {
              ...probe,
              jobId,
              source: 'dashboard',
              segmentConcurrency,
              uploadConcurrency,
              isAborted: () => {
                const j = activeJobs.get(jobId);
                return !j || j.status === 'cancelled';
              },
              onFfmpegSpawn: (ps) => {
                const j = activeJobs.get(jobId);
                if (j) j.ffmpegProcess = ps;
              }
            }
          );

          const j = activeJobs.get(jobId);
          if (j) {
            if (j.status === 'cancelled') return;
            j.status = 'complete';
            j.percent = 100;
            
            const doneData = {
              ok: true,
              jobId,
              playlistUrl: result.playlistUrl,
              carrierPlaylistUrl: result.carrierPlaylistUrl,
              carrierPlayerUrl: result.carrierPlayerUrl,
              sizing: result.sizing
            };
            progressEvent('done', doneData);
            
            for (const client of j.sseClients) {
              client.end();
            }
            j.sseClients.clear();
            setTimeout(() => activeJobs.delete(jobId), 10 * 60 * 1000);
          }
        } catch (err) {
          const j = activeJobs.get(jobId);
          if (j) {
            if (j.status === 'cancelled') return;
            j.status = 'failed';
            const errData = { ok: false, error: err.message };
            progressEvent('error', errData);
            for (const client of j.sseClients) {
              client.end();
            }
            j.sseClients.clear();
            setTimeout(() => activeJobs.delete(jobId), 10 * 60 * 1000);
          }
          const mPath = manifestPath(jobId);
          loadManifest(jobId).then(async manifest => {
            manifest.complete = false;
            manifest.status = 'failed';
            manifest.updatedAt = new Date().toISOString();
            await writeJson(mPath, manifest);
          }).catch(() => {});
        } finally {
          await fsp.unlink(jobFile).catch(() => {});
          await fsp.rm(downloadDir, { recursive: true, force: true }).catch(() => {});
        }
      });

      torrent.on('error', function (err) {
        if (finished) return;
        finished = true;
        client.destroy();
        progressEvent('error', { ok: false, error: `Lỗi tải Torrent: ${err.message}` });
        fsp.rm(downloadDir, { recursive: true, force: true }).catch(() => {});
      });
    });

    client.on('error', function (err) {
      if (finished) return;
      finished = true;
      progressEvent('error', { ok: false, error: `Lỗi WebTorrent Client: ${err.message}` });
      fsp.rm(downloadDir, { recursive: true, force: true }).catch(() => {});
    });

  } catch (err) {
    finished = true;
    if (client) {
      try { client.destroy(); } catch (e) {}
    }
    const j = activeJobs.get(jobId);
    if (j) {
      j.status = 'failed';
      progressEvent('error', { ok: false, error: err.message });
      for (const client of j.sseClients) {
        client.end();
      }
      j.sseClients.clear();
      setTimeout(() => activeJobs.delete(jobId), 10 * 60 * 1000);
    }
    fsp.rm(downloadDir, { recursive: true, force: true }).catch(() => {});
  }
}

const ROOT = process.cwd();
const MANIFEST_ROOT = path.join(ROOT, 'upload', 'tiktok', 'manifests');
const DASHBOARD_DIST = path.join(ROOT, 'dashboard', 'dist');

function manifestPath(jobId) {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(String(jobId || ''))) {
    throw new Error('Invalid jobId');
  }
  return path.join(MANIFEST_ROOT, `${jobId}.json`);
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

async function loadManifest(jobId) {
  const manifest = await readJson(manifestPath(jobId));
  if (!manifest || !Array.isArray(manifest.segments)) throw new Error('Invalid manifest');
  return manifest;
}

function clampHeaderInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function getManifestSizeBytes(manifest) {
  const sourceSize = Number(manifest.source?.sizeBytes || manifest.sourceSize || manifest.size || 0);
  if (Number.isFinite(sourceSize) && sourceSize > 0) return sourceSize;
  return (manifest.segments || []).reduce((sum, segment) => {
    const bytes = Number(segment.tsBytes || segment.payloadBytes || segment.carrierBytes || segment.pngBytes || 0);
    return sum + (Number.isFinite(bytes) ? bytes : 0);
  }, 0);
}

function recoverNestedCookie(cookie) {
  if (!cookie?.name || !cookie?.value) return null;
  const name = String(cookie.name).trim();
  const value = String(cookie.value).trim();

  if (name.startsWith('{') && (name.includes('"cookies"') || name.includes("'cookies'"))) {
    const recovered = parseCookieInput(`${name}=${value}`);
    if (recovered.length > 1) return recovered;
  }

  return { name, value };
}

function normalizeCookieList(list) {
  return (Array.isArray(list) ? list : [])
    .flatMap(cookie => recoverNestedCookie(cookie) || [])
    .filter(cookie => cookie && cookie.name && cookie.value)
    .map(cookie => ({ name: String(cookie.name), value: String(cookie.value) }));
}

function parseCookiePairs(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const rows = raw.includes('\n') ? raw.split(/\r?\n/) : raw.split(';');
  return rows
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const idx = part.indexOf('=');
      if (idx === -1) return null;
      return { name: part.slice(0, idx).trim(), value: part.slice(idx + 1).trim() };
    })
    .filter(cookie => cookie?.name && cookie?.value);
}

function parseJSObject(str) {
  // Strip comments first
  str = str.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  
  let index = 0;
  
  function skipWhitespace() {
    while (index < str.length && /\s/.test(str[index])) {
      index++;
    }
  }
  
  function parseString(quoteChar) {
    let val = '';
    index++; // skip open quote
    while (index < str.length) {
      const char = str[index];
      if (char === '\\') {
        val += str[index + 1];
        index += 2;
      } else if (char === quoteChar) {
        index++; // skip close quote
        return val;
      } else {
        val += char;
        index++;
      }
    }
    return val;
  }
  
  function parseValue() {
    skipWhitespace();
    if (index >= str.length) return null;
    const char = str[index];
    if (char === '"' || char === "'") {
      return parseString(char);
    }
    if (char === '{') {
      return parseObject();
    }
    if (char === '[') {
      return parseArray();
    }
    // Number, boolean, null, undefined, or unquoted identifier
    let valStr = '';
    while (index < str.length && !/[\s,}:\]]/.test(str[index])) {
      valStr += str[index];
      index++;
    }
    if (valStr === 'true') return true;
    if (valStr === 'false') return false;
    if (valStr === 'null') return null;
    if (valStr === 'undefined') return undefined;
    if (!isNaN(Number(valStr))) return Number(valStr);
    return valStr;
  }
  
  function parseObject() {
    const obj = {};
    index++; // skip '{'
    while (index < str.length) {
      skipWhitespace();
      if (str[index] === '}') {
        index++;
        return obj;
      }
      // Parse key
      let key = '';
      const char = str[index];
      if (char === '"' || char === "'") {
        key = parseString(char);
      } else {
        // unquoted key
        while (index < str.length && /[a-zA-Z0-9_$]/.test(str[index])) {
          key += str[index];
          index++;
        }
      }
      
      skipWhitespace();
      if (str[index] !== ':') {
        break;
      }
      index++; // skip ':'
      
      const val = parseValue();
      obj[key] = val;
      
      skipWhitespace();
      if (str[index] === ',') {
        index++;
      }
    }
    return obj;
  }
  
  function parseArray() {
    const arr = [];
    index++; // skip '['
    while (index < str.length) {
      skipWhitespace();
      if (str[index] === ']') {
        index++;
        return arr;
      }
      arr.push(parseValue());
      skipWhitespace();
      if (str[index] === ',') {
        index++;
      }
    }
    return arr;
  }
  
  skipWhitespace();
  if (str[index] === '{') {
    return parseObject();
  } else if (str[index] === '[') {
    return parseArray();
  }
  return null;
}

function parseCookieInput(input) {
  if (Array.isArray(input)) return normalizeCookieList(input);
  if (Array.isArray(input?.cookies)) return normalizeCookieList(input.cookies);

  const raw = String(input || '').trim();
  if (!raw) return [];

  try {
    const parsed = parseJSObject(raw);
    if (parsed) {
      if (Array.isArray(parsed)) return normalizeCookieList(parsed);
      if (Array.isArray(parsed?.cookies)) return normalizeCookieList(parsed.cookies);
      if (typeof parsed === 'object') {
        if (parsed.name && parsed.value) {
          return normalizeCookieList([parsed]);
        }
      }
    }
  } catch (_) {
    // ignore
  }

  return parseCookiePairs(raw);
}


function parseConsumerCookies() {
  return parseCookieInput(process.env.CONSUMER_COOKIES_JSON || '');
}

function parseCookieHeader(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const idx = part.indexOf('=');
      if (idx === -1) return null;
      return {
        name: part.slice(0, idx).trim(),
        value: part.slice(idx + 1).trim(),
      };
    })
    .filter(cookie => cookie?.name && cookie?.value);
}

function buildCookieHeader(cookies) {
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

function getHealthCookieSource() {
  const consumerCookies = parseConsumerCookies();
  if (consumerCookies.length) {
    return {
      cookies: consumerCookies,
      cookieHeader: buildCookieHeader(consumerCookies),
      cookieCount: consumerCookies.length,
    };
  }

  const rawCookieHeader = String(process.env.TIKTOK_COOKIE || '').trim();
  const rawCookies = parseCookieHeader(rawCookieHeader);
  return {
    cookies: rawCookies,
    cookieHeader: rawCookieHeader,
    cookieCount: rawCookies.length,
  };
}

function pickCsrfToken(cookies) {
  const names = ['tt_csrf_token', 'csrf_session_id', 'passport_csrf_token', 'passport_csrf_token_default', 'ac_csrftoken', 'tt_csrf_token_default'];
  for (const name of names) {
    const found = cookies.find(cookie => cookie.name === name);
    if (found?.value) return found.value;
  }
  return process.env.TIKTOK_CSRF_TOKEN || '';
}

function readEnvSummary() {
  const healthCookieSource = getHealthCookieSource();
  const hasCookie = Boolean(process.env.TIKTOK_COOKIE) || (healthCookieSource.cookieCount > 0);
  const hasCsrf = Boolean(process.env.TIKTOK_CSRF_TOKEN);
  const hasOrg = Boolean(process.env.TIKTOK_ORG_ID);
  const cookieCount = healthCookieSource.cookieCount;
  return {
    hasCookie,
    hasCsrf,
    hasOrg,
    cookieCount,
    xBogusReady: Boolean(require('xbogus')),
  };
}

async function checkConsumerCookieHealth() {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const cookieSource = getHealthCookieSource();
  const userAgent = process.env.USER_AGENT || tiktokService.config.userAgent;

  const base = {
    status: 'unknown',
    alive: false,
    checkedAt,
    latencyMs: 0,
    cookieCount: cookieSource.cookieCount,
    message: '',
  };

  if (!cookieSource.cookieHeader) {
    return { ...base, status: 'missing', message: 'Chưa có Cookie TikTok đăng nhập để kiểm tra.' };
  }

  try {
    const response = await axios.get(
      'https://www.tiktok.com/api/v1/video/upload/auth/?aid=1988',
      {
        timeout: 12000,
        headers: {
          'user-agent': userAgent,
          'cookie': cookieSource.cookieHeader,
          'referer': 'https://www.tiktok.com/',
        },
        validateStatus: status => status >= 200 && status < 500,
      }
    );

    const latencyMs = Date.now() - startedAt;
    const hasToken = Boolean(response.data?.video_token_v5?.access_key_id);
    const msg = response.data?.message || response.data?.status_msg || '';

    if (hasToken) {
      return { ...base, status: 'alive', alive: true, latencyMs, message: 'Cookie còn sống, lấy STS Upload Token thành công.' };
    }
    
    return { 
      ...base, 
      status: 'dead', 
      alive: false, 
      latencyMs, 
      message: `Cookie hết hạn hoặc không đủ quyền upload (${response.status}${msg ? `: ${msg}` : ' - Thiếu video_token_v5'}).` 
    };
  } catch (err) {
    return {
      ...base,
      status: 'unknown',
      alive: false,
      latencyMs: Date.now() - startedAt,
      message: `Không thể kiểm tra TikTok lúc này: ${err.code || err.message}`,
    };
  }
}

function getXbogusStatusCode(data) {
  if (!data || typeof data !== 'object' || !Object.prototype.hasOwnProperty.call(data, 'status_code')) return null;
  return data.status_code;
}

async function signXbogusForHealth(query, userAgent) {
  if (process.env.USE_RPC_SIGNER === 'true') {
    const rpcSigner = require('./xbogus_jsdom');
    return {
      signerMode: 'jsdom-rpc',
      signature: await rpcSigner.sign(query, userAgent),
    };
  }

  const generateBogus = require('xbogus');
  return {
    signerMode: 'local',
    signature: generateBogus(query, userAgent),
  };
}

async function checkXbogusHealth() {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const userAgent = process.env.USER_AGENT || tiktokService.config.userAgent;
  const base = {
    status: 'unknown',
    ok: false,
    checkedAt,
    latencyMs: 0,
    signerMode: process.env.USE_RPC_SIGNER === 'true' ? 'jsdom-rpc' : 'local',
    httpStatus: 0,
    tikTokStatusCode: null,
    message: '',
  };

  const query = new URLSearchParams({
    aid: '1988',
    app_name: 'tiktok_web',
    device_platform: 'web_pc',
    user_is_login: 'true',
  }).toString();

  let signature = '';
  let signerMode = base.signerMode;
  try {
    const signed = await signXbogusForHealth(query, userAgent);
    signature = signed.signature;
    signerMode = signed.signerMode;
  } catch (err) {
    return {
      ...base,
      signerMode,
      status: 'missing',
      latencyMs: Date.now() - startedAt,
      message: `Không sinh được chữ ký X-Bogus bằng ${signerMode === 'jsdom-rpc' ? 'JSDOM RPC' : 'Local signer'}: ${err.message}`,
    };
  }

  if (!signature) {
    return {
      ...base,
      signerMode,
      status: 'failed',
      latencyMs: Date.now() - startedAt,
      message: 'Bộ ký X-Bogus trả về chữ ký rỗng.',
    };
  }

  try {
    const response = await axios.post(`https://www.tiktok.com/api/upload/image/?${query}&X-Bogus=${encodeURIComponent(signature)}`, {}, {
      timeout: 12000,
      maxRedirects: 0,
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'cache-control': 'no-cache',
        origin: 'https://www.tiktok.com',
        pragma: 'no-cache',
        referer: 'https://www.tiktok.com/',
        'tt-csrf-token': 'healthcheck-only-dummy-token',
        'user-agent': userAgent,
      },
      validateStatus: status => status >= 200 && status < 500,
    });

    const latencyMs = Date.now() - startedAt;
    const tikTokStatusCode = getXbogusStatusCode(response.data);
    const acceptedCodes = new Set([0, 7, 8, 9, '0', '7', '8', '9']);
    const wafRejected = response.status === 400 || response.status === 403;

    if (acceptedCodes.has(tikTokStatusCode)) {
      return {
        ...base,
        status: 'passed',
        ok: true,
        checkedAt,
        latencyMs,
        signerMode,
        httpStatus: response.status,
        tikTokStatusCode,
        message: 'Chữ ký X-Bogus hợp lệ: TikTok đã nhận request và trả về mã API handler thay vì chặn ở lớp WAF.',
      };
    }

    return {
      ...base,
      status: 'failed',
      ok: false,
      checkedAt,
      latencyMs,
      signerMode,
      httpStatus: response.status,
      tikTokStatusCode,
      message: wafRejected
        ? 'TikTok chặn ở lớp WAF/signature, bộ ký X-Bogus có thể đã lỗi thời.'
        : 'TikTok không trả về status_code hợp lệ cho API handler, cần kiểm tra lại bộ ký X-Bogus.',
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const response = err.response;
    const tikTokStatusCode = getXbogusStatusCode(response?.data);
    if (tikTokStatusCode === 7 || tikTokStatusCode === 8 || tikTokStatusCode === '7' || tikTokStatusCode === '8') {
      return {
        ...base,
        status: 'passed',
        ok: true,
        checkedAt,
        latencyMs,
        signerMode,
        httpStatus: response?.status || 0,
        tikTokStatusCode,
        message: 'Chữ ký X-Bogus hợp lệ: request vượt lớp chữ ký và dừng ở bước quyền/session.',
      };
    }

    return {
      ...base,
      status: 'unknown',
      ok: false,
      checkedAt,
      latencyMs,
      signerMode,
      httpStatus: response?.status || 0,
      tikTokStatusCode,
      message: `Không thể kiểm tra X-Bogus lúc này: ${err.code || err.message}`,
    };
  }
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sanitizeUploadFilename(value) {
  const safe = String(value || 'upload.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe || 'upload.bin';
}

function streamRequestToFile(req, filePath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filePath);
    let bytes = 0;
    let settled = false;

    function cleanup() {
      req.off('data', onData);
      req.off('aborted', onAborted);
      req.off('error', onError);
      output.off('error', onError);
      output.off('finish', onFinish);
    }

    function finish(err) {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(bytes);
    }

    function onData(chunk) {
      bytes += chunk.length;
    }

    function onAborted() {
      const err = new Error('Upload bị hủy trước khi server nhận xong file.');
      output.destroy(err);
      finish(err);
    }

    function onError(err) {
      finish(err);
    }

    function onFinish() {
      finish();
    }

    req.on('data', onData);
    req.on('aborted', onAborted);
    req.on('error', onError);
    output.on('error', onError);
    output.on('finish', onFinish);
    req.pipe(output);
  });
}

function runDecodedCli(jobId, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'decoded.js'), outputPath, jobId], {
      cwd: ROOT,
      env: { ...process.env, TIKTOK_DECODE_JOB_ID: jobId },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      process.stdout.write(text);
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve(outputPath);
      reject(new Error(stderr.trim() || `decoded.js exited with code ${code}`));
    });
  });
}

app.get('/api/server/status', (req, res) => {
  res.json({
    status: 'active',
    port: PORT,
    uptime: process.uptime(),
    env: readEnvSummary(),
    concurrency: {
      segmentConcurrency: Number(process.env.SEGMENT_CONCURRENCY || 1),
      uploadConcurrency: Number(process.env.UPLOAD_CONCURRENCY || 3),
      reconstructConcurrency: Number(process.env.RECONSTRUCT_CONCURRENCY || 4),
    }
  });
});

app.post('/api/env/validate', (req, res) => {
  res.json({ ok: true, env: readEnvSummary() });
});

app.get('/api/cookies/health', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await checkConsumerCookieHealth());
});

app.get('/api/xbogus/health', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await checkXbogusHealth());
});

app.post('/api/cookies', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const cookies = parseCookieInput(req.body);

    if (!cookies.length) {
      return res.status(400).json({ ok: false, error: 'Cookie trống hoặc sai định dạng.' });
    }

    const cookiesJson = JSON.stringify(cookies);
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const envPath = path.join(ROOT, '.env');
    let raw = await fsp.readFile(envPath, 'utf8').catch(() => '');

    // Cập nhật hoặc thêm CONSUMER_COOKIES_JSON
    const lineConsumer = `CONSUMER_COOKIES_JSON=${cookiesJson}`;
    if (/^CONSUMER_COOKIES_JSON=.*$/m.test(raw)) {
      raw = raw.replace(/^CONSUMER_COOKIES_JSON=.*$/m, lineConsumer);
    } else {
      raw = `${raw}${raw.endsWith('\n') || !raw ? '' : '\n'}${lineConsumer}\n`;
    }

    // Cập nhật hoặc thêm TIKTOK_COOKIE
    const lineTiktok = `TIKTOK_COOKIE='${cookieStr}'`;
    if (/^TIKTOK_COOKIE=.*$/m.test(raw)) {
      raw = raw.replace(/^TIKTOK_COOKIE=.*$/m, lineTiktok);
    } else {
      raw = `${raw}${raw.endsWith('\n') || !raw ? '' : '\n'}${lineTiktok}\n`;
    }

    await fsp.writeFile(envPath, raw, 'utf8');
    process.env.CONSUMER_COOKIES_JSON = cookiesJson;
    process.env.TIKTOK_COOKIE = cookieStr;

    res.json({ ok: true, cookieCount: cookies.length, env: readEnvSummary() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/xbogus/refresh', (req, res) => {
  res.json({ ok: true, message: 'xbogus helper is available through existing pipeline' });
});

app.post('/api/config/concurrency', express.json(), async (req, res) => {
  try {
    const { segmentConcurrency, uploadConcurrency, reconstructConcurrency } = req.body;
    const seg = Math.max(1, Number(segmentConcurrency || 1));
    const up = Math.max(1, Number(uploadConcurrency || 3));
    const rec = Math.max(1, Number(reconstructConcurrency || 4));

    const envPath = path.join(ROOT, '.env');
    let raw = await fsp.readFile(envPath, 'utf8').catch(() => '');

    // Cập nhật hoặc thêm SEGMENT_CONCURRENCY
    const lineSeg = `SEGMENT_CONCURRENCY=${seg}`;
    if (/^SEGMENT_CONCURRENCY=.*$/m.test(raw)) {
      raw = raw.replace(/^SEGMENT_CONCURRENCY=.*$/m, lineSeg);
    } else {
      raw = `${raw}${raw.endsWith('\n') || !raw ? '' : '\n'}${lineSeg}\n`;
    }

    // Cập nhật hoặc thêm UPLOAD_CONCURRENCY
    const lineUp = `UPLOAD_CONCURRENCY=${up}`;
    if (/^UPLOAD_CONCURRENCY=.*$/m.test(raw)) {
      raw = raw.replace(/^UPLOAD_CONCURRENCY=.*$/m, lineUp);
    } else {
      raw = `${raw}${raw.endsWith('\n') || !raw ? '' : '\n'}${lineUp}\n`;
    }

    // Cập nhật hoặc thêm RECONSTRUCT_CONCURRENCY
    const lineRec = `RECONSTRUCT_CONCURRENCY=${rec}`;
    if (/^RECONSTRUCT_CONCURRENCY=.*$/m.test(raw)) {
      raw = raw.replace(/^RECONSTRUCT_CONCURRENCY=.*$/m, lineRec);
    } else {
      raw = `${raw}${raw.endsWith('\n') || !raw ? '' : '\n'}${lineRec}\n`;
    }

    await fsp.writeFile(envPath, raw, 'utf8');
    process.env.SEGMENT_CONCURRENCY = String(seg);
    process.env.UPLOAD_CONCURRENCY = String(up);
    process.env.RECONSTRUCT_CONCURRENCY = String(rec);

    res.json({ ok: true, segmentConcurrency: seg, uploadConcurrency: up, reconstructConcurrency: rec });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/upload/torrent', express.json(), async (req, res) => {
  try {
    const { magnetUrl } = req.body;
    if (!magnetUrl) {
      return res.status(400).json({ ok: false, error: 'Thiếu magnetUrl trong body.' });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (res.flushHeaders) res.flushHeaders();

    const segmentConcurrency = clampHeaderInt(req.headers['x-segment-concurrency'], 1, 1, 999999);
    const uploadConcurrency = clampHeaderInt(req.headers['x-upload-concurrency'], 1, 1, 999999);

    // 1. Tạo jobId và đăng ký activeJobs
    const jobId = uuidv4();
    const jobObj = {
      jobId,
      filename: 'torrent_download',
      createdAt: new Date().toISOString(),
      status: 'processing',
      percent: 0,
      step: 'torrent-initialized',
      message: 'Khởi tạo tiến trình tải Torrent...',
      details: {},
      ffmpegProcess: null,
      logs: [],
      sseClients: new Set([res])
    };
    activeJobs.set(jobId, jobObj);

    // 2. Gửi sự kiện meta ban đầu
    sendSseToClient(res, 'meta', {
      ok: true,
      filename: 'torrent_download',
      bytes: 0,
      segmentConcurrency,
      uploadConcurrency,
      jobId
    });

    // 3. Khởi chạy background job (bất đồng bộ)
    runTorrentBackgroundJob(jobId, magnetUrl, segmentConcurrency, uploadConcurrency);

    // Lắng nghe đóng connection từ phía client
    req.on('close', () => {
      const j = activeJobs.get(jobId);
      if (j) {
        j.sseClients.delete(res);
      }
    });

  } catch (err) {
    if (res.headersSent) {
      sendSseToClient(res, 'error', { ok: false, error: err.message });
      res.end();
    } else {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
});

app.post('/api/upload', async (req, res) => {
  const tempDir = path.join(ROOT, 'tmp_upload');
  let jobFile = '';

  try {
    await fsp.mkdir(tempDir, { recursive: true });
    jobFile = path.join(tempDir, `${Date.now()}_${sanitizeUploadFilename(req.headers['x-filename'])}`);
    const receivedBytes = await streamRequestToFile(req, jobFile);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (res.flushHeaders) res.flushHeaders();

    const segmentConcurrency = clampHeaderInt(req.headers['x-segment-concurrency'], 1, 1, 999999);
    const uploadConcurrency = clampHeaderInt(req.headers['x-upload-concurrency'], 1, 1, 999999);
    const filename = path.basename(jobFile);

    // 1. Tạo jobId và đăng ký activeJobs
    const jobId = uuidv4();
    const jobObj = {
      jobId,
      filename,
      createdAt: new Date().toISOString(),
      status: 'processing',
      percent: 0,
      step: 'upload-complete',
      message: 'Upload complete, queueing background processing...',
      details: {},
      ffmpegProcess: null,
      logs: [],
      sseClients: new Set([res])
    };
    activeJobs.set(jobId, jobObj);

    // 2. Gửi sự kiện meta ban đầu
    sendSseToClient(res, 'meta', {
      ok: true,
      filename,
      bytes: receivedBytes,
      segmentConcurrency,
      uploadConcurrency,
      jobId
    });

    // 3. Khởi chạy background job (bất đồng bộ)
    runBackgroundJob(jobId, jobFile, segmentConcurrency, uploadConcurrency, filename);

    // Lắng nghe đóng connection từ phía client
    req.on('close', () => {
      const j = activeJobs.get(jobId);
      if (j) {
        j.sseClients.delete(res);
      }
    });

  } catch (err) {
    if (res.headersSent) {
      sendSseToClient(res, 'error', { ok: false, error: err.message });
      res.end();
    } else {
      res.status(req.aborted ? 499 : 500).json({ ok: false, error: err.message });
    }
    if (jobFile) await fsp.unlink(jobFile).catch(() => {});
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const files = await fsp.readdir(MANIFEST_ROOT).catch(() => []);
    const jobs = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const jobId = path.basename(file, '.json');
      const manifest = await loadManifest(jobId).catch(() => null);
      if (!manifest) continue;

      const activeJob = activeJobs.get(jobId);
      const uploaded = activeJob 
        ? (activeJob.details?.uploadedSegments || 0)
        : (manifest.segments || []).filter(segment => segment.uploaded && segment.imageUri).length;

      const total = activeJob
        ? (activeJob.details?.segmentTotal || 0)
        : (manifest.segments?.length || 0);

      const percent = activeJob ? activeJob.percent : (manifest.complete ? 100 : 0);
      const status = activeJob ? activeJob.status : (manifest.status || (manifest.complete ? 'complete' : 'failed'));

      const size = getManifestSizeBytes(manifest);
      jobs.push({
        jobId,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        total,
        uploaded,
        complete: activeJob ? false : Boolean(manifest.complete),
        status,
        percent,
        size,
        sourceSize: Number(manifest.source?.sizeBytes || 0),
      });
    }
    jobs.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs/:id', async (req, res) => {
  try {
    res.json(await loadManifest(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete('/api/jobs/:id', async (req, res) => {
  try {
    const jobId = req.params.id;
    await fsp.unlink(manifestPath(jobId)).catch(() => {});
    await fsp.rm(path.join(ROOT, 'public', 'upload', jobId), { recursive: true, force: true }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs/:id/events', (req, res) => {
  const jobId = req.params.id;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();

  const job = activeJobs.get(jobId);
  if (!job) {
    loadManifest(jobId).then(manifest => {
      sendSseToClient(res, 'done', { ok: true, jobId, playlistUrl: manifest.source?.playlistPath });
      res.end();
    }).catch(err => {
      sendSseToClient(res, 'error', { ok: false, error: 'Job not found or already finished' });
      res.end();
    });
    return;
  }

  // Replay logs
  for (const log of job.logs) {
    sendSseToClient(res, log.event, log.data);
  }

  job.sseClients.add(res);

  req.on('close', () => {
    job.sseClients.delete(res);
  });
});

app.post('/api/jobs/:id/cancel', async (req, res) => {
  const jobId = req.params.id;
  const job = activeJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ ok: false, error: 'Job không tồn tại hoặc đã hoàn thành.' });
  }

  job.status = 'cancelled';

  if (job.ffmpegProcess) {
    try {
      job.ffmpegProcess.kill('SIGKILL');
      console.log(`[Cancel] Đã kill FFmpeg của job ${jobId}`);
    } catch (e) {}
  }

  const cancelData = { ok: false, error: 'Tiến trình bị hủy bởi người dùng' };
  job.logs.push({ event: 'error', data: cancelData });

  for (const client of job.sseClients) {
    sendSseToClient(client, 'error', cancelData);
    client.end();
  }
  job.sseClients.clear();

  // Ghi đè manifest
  const mPath = manifestPath(jobId);
  loadManifest(jobId).then(async manifest => {
    manifest.complete = false;
    manifest.status = 'cancelled';
    manifest.updatedAt = new Date().toISOString();
    await writeJson(mPath, manifest);
  }).catch(() => {});

  activeJobs.delete(jobId);
  res.json({ ok: true });
});

app.post('/api/jobs/:id/reconstruct', (req, res) => {
  const jobId = req.params.id;
  const state = startReconstruction(jobId);
  res.json({ ok: true, state: { status: state.status, percent: state.percent, message: state.message } });
});

app.get('/api/jobs/:id/reconstruct/status', (req, res) => {
  const jobId = req.params.id;
  const state = activeReconstructs.get(jobId);
  if (!state) {
    return res.status(404).json({ error: 'Không tìm thấy tiến trình khôi phục cho Job này.' });
  }
  res.json({
    status: state.status,
    percent: state.percent,
    message: state.message,
    error: state.error
  });
});

app.get('/api/jobs/:id/reconstruct/download', async (req, res) => {
  const jobId = req.params.id;
  const state = activeReconstructs.get(jobId);
  if (!state || state.status !== 'complete') {
    return res.status(400).send('File khôi phục chưa sẵn sàng hoặc tiến trình bị lỗi.');
  }

  const outputPath = state.outputPath;
  res.download(outputPath, `${jobId}.mp4`, async () => {
    await fsp.unlink(outputPath).catch(() => {});
    activeReconstructs.delete(jobId);
  });
});

app.get('/api/tokens', async (req, res) => {
  try {
    const tokens = await readTokens();
    res.json({ ok: true, tokens });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/tokens', express.json(), async (req, res) => {
  try {
    const { username } = req.body;
    if (!username || !username.trim()) {
      return res.status(400).json({ ok: false, error: 'Tên người dùng không được để trống' });
    }
    
    const tokens = await readTokens();
    const tokenStr = `tok_${username.trim().toLowerCase().replace(/[^a-z0-9]/g, '_')}_${uuidv4().slice(0, 8)}`;
    
    const newToken = {
      username: username.trim(),
      token: tokenStr,
      createdAt: new Date().toISOString(),
      active: true
    };
    
    tokens.push(newToken);
    await writeTokens(tokens);
    
    res.json({ ok: true, token: newToken });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/tokens/:token/toggle', async (req, res) => {
  try {
    const tokenStr = req.params.token;
    const tokens = await readTokens();
    const found = tokens.find(t => t.token === tokenStr);
    
    if (!found) {
      return res.status(404).json({ ok: false, error: 'Không tìm thấy token này' });
    }
    
    // Chống lock-out: Không cho phép vô hiệu hóa token duy nhất đang hoạt động
    if (found.active) {
      const activeCount = tokens.filter(t => t.active).length;
      if (activeCount <= 1) {
        return res.status(400).json({ ok: false, error: 'Không thể vô hiệu hóa token duy nhất đang hoạt động' });
      }
    }
    
    found.active = !found.active;
    await writeTokens(tokens);
    
    res.json({ ok: true, token: found });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/tokens/:token', async (req, res) => {
  try {
    const tokenStr = req.params.token;
    let tokens = await readTokens();
    const initialLength = tokens.length;
    
    const targetToken = tokens.find(t => t.token === tokenStr);
    if (!targetToken) {
      return res.status(404).json({ ok: false, error: 'Không tìm thấy token này' });
    }
    
    // Chống lock-out: Không thể xóa token duy nhất đang hoạt động
    if (targetToken.active) {
      const activeCount = tokens.filter(t => t.active).length;
      if (activeCount <= 1) {
        return res.status(400).json({ ok: false, error: 'Không thể xoá token duy nhất đang hoạt động' });
      }
    }
    
    tokens = tokens.filter(t => t.token !== tokenStr);
    if (tokens.length === initialLength) {
      return res.status(404).json({ ok: false, error: 'Không tìm thấy token này' });
    }
    
    await writeTokens(tokens);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const dashboardIndex = path.join(DASHBOARD_DIST, 'index.html');
app.use('/dashboard', express.static(DASHBOARD_DIST, { maxAge: '0' }));
app.get(['/dashboard', '/dashboard/'], (req, res) => {
  if (fs.existsSync(dashboardIndex)) return res.sendFile(dashboardIndex);
  res.status(404).send('Dashboard build not found. Run `npm --prefix dashboard run build`.');
});
app.get('/', (req, res) => res.redirect('/dashboard/'));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/carrier/') || req.path.startsWith('/upload/')) return next();
  if (fs.existsSync(dashboardIndex)) return res.sendFile(dashboardIndex);
  return next();
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}/dashboard/`);
  });
}

module.exports = app;
