// server.js
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
const axios = require('axios');
const tiktokService = require('./tiktok');


const app = express();
const port = Number(process.env.PORT || 3000);
const uploadRoot = path.join(process.cwd(), 'public', 'upload');
const publicRoot = path.join(process.cwd(), 'public');
const manifestRoot = path.join(process.cwd(), 'upload', 'tiktok', 'manifests');
const fallbackEnabled = process.env.ENABLE_SERVER_SEGMENT_FALLBACK === 'true';
const imageUrlCache = new Map();
const materialPageCache = {
    expiresAt: 0,
    scannedPages: 0,
};
const MATERIAL_PAGE_SIZE = 100;
const MATERIAL_MAX_SCAN_PAGES = 10;
const DIRECT_BOOTSTRAP_SEGMENTS = 45;

app.use(express.json({ limit: '128kb' }));

app.use('/upload', express.static(uploadRoot, {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.m3u8')) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-store');
        }
        if (filePath.endsWith('.ts')) {
            res.setHeader('Content-Type', 'video/mp2t');
            res.setHeader('Cache-Control', 'no-store');
        }
    }
}));

app.use(express.static(publicRoot, {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
        }
    }
}));

function isValidJobId(jobId) {
    return /^[a-zA-Z0-9_-]{8,80}$/.test(String(jobId || ''));
}

function manifestPath(jobId) {
    if (!isValidJobId(jobId)) throw new Error('Invalid jobId');
    return path.join(manifestRoot, `${jobId}.json`);
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
    if (parsed.repairedRaw) {
        await fsp.writeFile(filePath, parsed.repairedRaw + '\n', 'utf8');
    }
    return parsed.value;
}

async function loadManifest(jobId) {
    const filePath = manifestPath(jobId);
    const manifest = await readJsonFileSafe(filePath);
    if (!manifest || manifest.jobId !== jobId || !Array.isArray(manifest.segments)) {
        throw new Error('Invalid manifest');
    }
    return manifest;
}

function getSegment(manifest, indexValue) {
    const index = Number(indexValue);
    if (!Number.isInteger(index) || index < 0) throw new Error('Invalid segment index');
    const segment = manifest.segments.find(item => item.index === index);
    if (!segment || !segment.imageUri) throw new Error('Segment not found or not uploaded');
    return segment;
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

function getManifestSizeBytes(manifest) {
    const sourceSize = Number(manifest.source?.sizeBytes || manifest.sourceSize || manifest.size || 0);
    if (Number.isFinite(sourceSize) && sourceSize > 0) return sourceSize;
    return (manifest.segments || []).reduce((sum, segment) => {
        const bytes = Number(segment.tsBytes || segment.payloadBytes || segment.carrierBytes || segment.pngBytes || 0);
        return sum + (Number.isFinite(bytes) ? bytes : 0);
    }, 0);
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
        fallbackEnabled,
        directEnabled: includeDirect,
        assetVersion: manifest.assetVersion || manifest.jobId,
        sizing: manifest.sizing || null,
        serverNow: Date.now(),
        segments: manifest.segments.map(segment => sanitizeSegment(manifest, segment, includeDirect)),
    };
}

function renderCarrierPlaylist(manifest) {
    const uploadedSegments = manifest.segments.filter(segment => segment.uploaded && segment.imageUri);
    if (uploadedSegments.length !== manifest.segments.length) {
        throw new Error(`Job is incomplete (${uploadedSegments.length}/${manifest.segments.length})`);
    }

    const targetDuration = Math.max(
        Number(manifest.hls?.targetDuration || 4),
        Math.ceil(Math.max(...manifest.segments.map(segment => Number(segment.duration || 4))))
    );
    const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        `#EXT-X-TARGETDURATION:${targetDuration}`,
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-MEDIA-SEQUENCE:0',
    ];

    for (const segment of manifest.segments.slice().sort((a, b) => a.index - b.index)) {
        lines.push(`#EXTINF:${Number(segment.duration || 4).toFixed(3)},`);
        lines.push(`/carrier/${encodeURIComponent(manifest.jobId)}/segment/${segment.index}.ts`);
    }

    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
}

async function saveManifest(manifest) {
    await fsp.mkdir(manifestRoot, { recursive: true });
    await fsp.writeFile(manifestPath(manifest.jobId), JSON.stringify(manifest, null, 2), 'utf8');
}

function decodeTikTokImageUrl(rawUrl) {
    if (!rawUrl) return '';
    return String(rawUrl).replace(/\\u0026/g, '&');
}

function imageUriMatches(value, imageUri) {
    if (!value || !imageUri) return false;
    value = String(value);
    imageUri = String(imageUri);
    return value === imageUri || value.includes(imageUri) || imageUri.includes(value);
}

function cacheMaterialImageUrls(materials) {
    for (const material of materials || []) {
        const webUri = material.base_info?.web_uri || material.web_uri || material.base_info?.image_uri || '';
        const imageUrl = decodeTikTokImageUrl(material.base_info?.image_url || material.image_url || '');
        if (webUri && imageUrl) imageUrlCache.set(String(webUri), imageUrl);
        if (imageUrl) imageUrlCache.set(String(imageUrl), imageUrl);
    }
}

function findCachedImageUrl(imageUri) {
    if (imageUrlCache.has(imageUri)) return imageUrlCache.get(imageUri);
    for (const [key, value] of imageUrlCache.entries()) {
        if (imageUriMatches(key, imageUri) || imageUriMatches(value, imageUri)) {
            imageUrlCache.set(imageUri, value);
            return value;
        }
    }
    return '';
}

async function loadMaterialPage(page) {
    const config = tiktokService.config;
    const headers = tiktokService.getHeaders();
    const requestBody = {
        m_type: 2,
        metrics: [],
        is_lifetime: 0,
        order_field: 'create_time',
        order_type: 1,
        keyword_type: 6,
        page,
        page_size: MATERIAL_PAGE_SIZE,
        keyword: '',
        country: [],
        image_mode: [],
        placement_id: [],
        cost_lower: '',
        cost_upper: '',
        permission_type: [],
    };

    const response = await axios.post(
        `https://business.tiktok.com/api/v3/bm/material/list/?org_id=${config.orgId}&call_platform=library`,
        requestBody,
        { headers, timeout: 60000 }
    );

    if (response.data?.code !== 0 && response.data?.code !== '0') {
        throw new Error(`Material list API error: ${response.data?.msg || response.data?.message || 'unknown'}`);
    }

    const materials = response.data?.data?.material_infos || [];
    cacheMaterialImageUrls(materials);
    return materials.length;
}

async function resolveImageUrl(imageUri) {
    imageUri = String(imageUri || '');
    if (/^https?:\/\//i.test(imageUri)) return imageUri;

    const cached = findCachedImageUrl(imageUri);
    if (cached) return cached;

    const now = Date.now();
    const cacheFresh = materialPageCache.expiresAt > now;
    const startPage = cacheFresh ? materialPageCache.scannedPages + 1 : 1;
    if (!cacheFresh) {
        materialPageCache.scannedPages = 0;
        materialPageCache.expiresAt = now + 5 * 60 * 1000;
    }

    for (let page = startPage; page <= MATERIAL_MAX_SCAN_PAGES; page += 1) {
        const count = await loadMaterialPage(page);
        materialPageCache.scannedPages = Math.max(materialPageCache.scannedPages, page);
        const match = findCachedImageUrl(imageUri);
        if (match) return match;
        if (count < MATERIAL_PAGE_SIZE) break;
    }

    throw new Error(`Cannot resolve TikTok image URL from manifest web_uri after scanning ${materialPageCache.scannedPages} material pages`);
}

async function ensureDirectImageUrls(manifest, options = {}) {
    let changed = false;
    const indexes = Array.isArray(options.indexes) ? new Set(options.indexes) : null;
    const force = Boolean(options.force);
    const failures = [];
    for (const segment of manifest.segments) {
        if (indexes && !indexes.has(segment.index)) continue;
        if (!segment.uploaded || !segment.imageUri) continue;
        if (!force && segment.publicImageUrl) continue;
        if (!force && segment.resolvedImageUrl) continue;
        try {
            if (force) imageUrlCache.delete(segment.imageUri);
            const imageUrl = await resolveImageUrl(segment.imageUri);
            if (/^https?:\/\//i.test(imageUrl) && segment.resolvedImageUrl !== imageUrl) {
                segment.resolvedImageUrl = imageUrl;
                changed = true;
            }
        } catch (err) {
            failures.push({ index: segment.index, message: err.message });
        }
    }
    if (changed) {
        manifest.updatedAt = new Date().toISOString();
        await saveManifest(manifest);
    }
    if (failures.length && !changed) {
        const err = new Error(`Cannot refresh TikTok image URLs for ${failures.length} segment(s): ${failures.slice(0, 3).map(item => `${item.index + 1}: ${item.message}`).join('; ')}`);
        err.failures = failures;
        throw err;
    }
    return { changed, failures };
}

function normalizeRefreshIndexes(manifest, rawIndexes) {
    const maxBatch = 200;
    const indexes = Array.isArray(rawIndexes) ? rawIndexes : [];
    const valid = [];
    const seen = new Set();
    for (const value of indexes) {
        const index = Number(value);
        if (!Number.isInteger(index) || index < 0 || seen.has(index)) continue;
        if (!manifest.segments.some(segment => segment.index === index && segment.uploaded && segment.imageUri)) continue;
        seen.add(index);
        valid.push(index);
        if (valid.length >= maxBatch) break;
    }
    return valid;
}

async function fetchImageBuffer(segment, manifest) {
    const baseHeaders = {
        'User-Agent': process.env.USER_AGENT || tiktokService.config.userAgent,
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    };
    const signedHeaders = {
        ...baseHeaders,
        'Referer': 'https://business.tiktok.com/manage/material/image',
    };
    if (process.env.TIKTOK_COOKIE) signedHeaders.Cookie = process.env.TIKTOK_COOKIE;

    async function fetchFrom(sourceUrl, headers) {
        const response = await axios.get(sourceUrl, {
            responseType: 'arraybuffer',
            headers,
            timeout: 120000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            validateStatus: status => status >= 200 && status < 400,
        });
        return {
            data: Buffer.from(response.data),
            contentType: response.headers['content-type'] || 'image/png',
        };
    }

    if (segment.publicImageUrl) {
        try {
            return await fetchFrom(segment.publicImageUrl, baseHeaders);
        } catch (err) {}
    }

    let sourceUrl = segment.resolvedImageUrl || await resolveImageUrl(segment.imageUri);
    if (!segment.resolvedImageUrl && /^https?:\/\//i.test(sourceUrl)) {
        segment.resolvedImageUrl = sourceUrl;
        manifest.updatedAt = new Date().toISOString();
        await saveManifest(manifest);
    }

    try {
        return await fetchFrom(sourceUrl, signedHeaders);
    } catch (err) {
        if (!segment.resolvedImageUrl || /^https?:\/\//i.test(String(segment.imageUri || ''))) throw err;
        imageUrlCache.delete(segment.imageUri);
        sourceUrl = await resolveImageUrl(segment.imageUri);
        segment.resolvedImageUrl = sourceUrl;
        manifest.updatedAt = new Date().toISOString();
        await saveManifest(manifest);
        return await fetchFrom(sourceUrl, signedHeaders);
    }
}

function scriptJson(value) {
    return JSON.stringify(value || {})
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(new RegExp('\\u2028', 'g'), '\\u2028')
        .replace(new RegExp('\\u2029', 'g'), '\\u2029');
}

function renderPlayerPage(initial) {
    const safeInitial = scriptJson(initial || {});
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

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/api/jobs', async (req, res) => {
    try {
        await fsp.mkdir(manifestRoot, { recursive: true });
        const files = (await fsp.readdir(manifestRoot)).filter(file => file.endsWith('.json'));
        const jobs = [];
        for (const file of files) {
            try {
                const manifest = await readJsonFileSafe(path.join(manifestRoot, file));
                jobs.push(sanitizeJob(manifest));
            } catch (err) {}
        }
        jobs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        res.json({ jobs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/jobs/:jobId', async (req, res) => {
    try {
        const includeDirect = req.query.direct === '1';
        const manifest = await loadManifest(req.params.jobId);
        if (includeDirect) {
            const limit = Math.max(1, Math.min(Number(req.query.limit || DIRECT_BOOTSTRAP_SEGMENTS), DIRECT_BOOTSTRAP_SEGMENTS));
            const indexes = manifest.segments
                .filter(segment => segment.uploaded && segment.imageUri && !segment.publicImageUrl)
                .slice(0, limit)
                .map(segment => segment.index);
            await ensureDirectImageUrls(manifest, { indexes });
        }
        res.json(sanitizeJob(manifest, { includeDirect }));
    } catch (err) {
        res.status(err.code === 'ENOENT' ? 404 : 400).json({ error: err.message });
    }
});

app.post('/api/jobs/:jobId/refresh', async (req, res) => {
    try {
        const manifest = await loadManifest(req.params.jobId);
        const indexes = normalizeRefreshIndexes(manifest, req.body?.indexes);
        if (indexes.length < 1) throw new Error('No valid segment indexes to refresh');

        await ensureDirectImageUrls(manifest, { indexes, force: req.body?.force === true });
        res.json({
            jobId: manifest.jobId,
            assetVersion: manifest.assetVersion || manifest.jobId,
            serverNow: Date.now(),
            segments: manifest.segments
                .filter(segment => indexes.includes(segment.index))
                .map(segment => sanitizeSegment(manifest, segment, true)),
        });
    } catch (err) {
        res.status(err.code === 'ENOENT' ? 404 : 400).json({ error: err.message });
    }
});

app.get('/api/jobs/:jobId/images/:index', async (req, res) => {
    try {
        const manifest = await loadManifest(req.params.jobId);
        const segment = getSegment(manifest, req.params.index);
        const image = await fetchImageBuffer(segment, manifest);
        res.setHeader('Content-Type', image.contentType);
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.send(image.data);
    } catch (err) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(err.code === 'ENOENT' ? 404 : 502).json({
            error: err.message,
            jobId: req.params.jobId,
            index: Number(req.params.index),
        });
    }
});

app.get('/carrier/:jobId/master.m3u8', async (req, res) => {
    try {
        const manifest = await loadManifest(req.params.jobId);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        res.send(renderCarrierPlaylist(manifest));
    } catch (err) {
        res.status(err.code === 'ENOENT' ? 404 : 400).type('text').send(`#EXTM3U\n# error: ${err.message}\n`);
    }
});

app.get('/carrier/:jobId/segment/:index.ts', async (req, res) => {
    if (!fallbackEnabled) {
        res.status(404).type('text').send('Server segment fallback is disabled');
        return;
    }

    try {
        const manifest = await loadManifest(req.params.jobId);
        const segment = getSegment(manifest, req.params.index);
        const image = await fetchImageBuffer(segment, manifest);
        
        const { decodePngCarrierBuffer } = require('./carrier');
        const decoded = await decodePngCarrierBuffer(image.data);

        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('Cache-Control', segment.publicImageUrl ? 'public, max-age=3600' : 'private, max-age=3600');
        res.send(decoded.payload);
    } catch (err) {
        res.status(502).type('text').send(err.message);
    }
});

app.get('/embed/player', (req, res) => {
    const jobId = String(req.query.jobId || '');
    if (!isValidJobId(jobId)) {
        res.status(400).type('text').send('Invalid jobId');
        return;
    }

    const playerPath = `/player?jobId=${encodeURIComponent(jobId)}&direct=1&auto=1&embed=1`;
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
    <iframe src="${playerPath}" title="TikTok Carrier Player" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
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

app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(renderPlayerPage({ src: '', jobId: '', direct: false, auto: true }));
});

if (require.main === module) {
    const os = require('os');
    function getLocalIp() {
        const interfaces = os.networkInterfaces();
        const candidates = [];
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if ((iface.family === 'IPv4' || iface.family === 4) && !iface.internal) {
                    const addr = iface.address;
                    if (addr.startsWith('169.254.')) continue; // Bỏ qua link-local
                    if (addr.startsWith('192.168.') || addr.startsWith('10.') || addr.startsWith('172.')) {
                        candidates.unshift(addr); // Ưu tiên các dải IP LAN
                    } else {
                        candidates.push(addr);
                    }
                }
            }
        }
        return candidates[0] || 'localhost';
    }
    const localIp = getLocalIp();

    app.listen(port, '0.0.0.0', () => {
        console.log(`HLS server: http://localhost:${port}`);
        console.log(`LAN Access: http://${localIp}:${port}`);
        console.log(`Serving uploads: http://${localIp}:${port}/upload`);
        console.log(`Local player: http://${localIp}:${port}/player?src=/upload/<date>/<jobId>/master.m3u8`);
        console.log(`Carrier player: http://${localIp}:${port}/player?jobId=<jobId>&direct=1&auto=1`);
    });
}

module.exports = app;
