(() => {
    const MAGIC = 'TTKPIX1\0';
    const VERSION = 1;
    const HEADER_SIZE = 8 + 1 + 2 + 36 + 4 + 4 + 4 + 32;
    const MAX_CACHE_BYTES = 64 * 1024 * 1024;
    const DEFAULT_AHEAD_SEGMENTS = 40;
    const REFRESH_AHEAD_SEGMENTS = 45;
    const STARTUP_PRIME_SEGMENTS = 4;
    const STARTUP_REFRESH_SEGMENTS = 5;
    const STARTUP_FULL_PREFETCH_DELAY_MS = 1200;
    const URGENT_AHEAD_SEGMENTS = 40;
    const MIN_PREFETCH_BUDGET_BYTES = 64 * 1024 * 1024;
    const MAX_PREFETCH_BUDGET_BYTES = 384 * 1024 * 1024;
    const DB_NAME = 'ttk-carrier-cache-v1';
    const DB_VERSION = 1;
    const STORE_SEGMENTS = 'segments';

    const video = document.getElementById('video');
    const srcInput = document.getElementById('src');
    const jobInput = document.getElementById('jobId');
    const statusEl = document.getElementById('status');
    const errorEl = document.getElementById('error');
    const telemetryEl = document.getElementById('telemetry');
    const initial = window.__PLAYER_INITIAL__ || {};
    const serverFallback = Boolean(window.__SERVER_SEGMENT_FALLBACK__);
    const query = new URLSearchParams(window.location.search);
    const directMode = Boolean(initial.direct || query.get('direct') === '1');
    const autoMode = initial.auto !== false && query.get('auto') !== '0';
    const embedMode = Boolean(initial.embed || query.get('embed') === '1');
    if (embedMode) document.body.classList.add('embed-mode');

    const MODE_NAMES = ['client-only', 'hybrid', 'server-assisted', 'server-transcoded'];
    const PROFILES = {
        performance: {
            maxBufferLength: 45,
            maxMaxBufferLength: 60,
            backBufferLength: 30,
            maxBufferSize: 80 * 1024 * 1024,
            maxCacheBytes: 384 * 1024 * 1024,
            idbMaxBytes: 4 * 1024 * 1024 * 1024,
            refreshLookahead: REFRESH_AHEAD_SEGMENTS,
            refreshLookaheadSegments: REFRESH_AHEAD_SEGMENTS,
            prefetchAheadSeconds: 80,
            prefetchAheadSegments: DEFAULT_AHEAD_SEGMENTS,
            keepBehindSeconds: 30,
            keepBehindSegments: 20,
            prefetchConcurrency: 4,
            useWorker: true,
        },
        balanced: {
            maxBufferLength: 10,
            maxMaxBufferLength: 14,
            backBufferLength: 12,
            maxBufferSize: 96 * 1024 * 1024,
            maxCacheBytes: 256 * 1024 * 1024,
            idbMaxBytes: 2 * 1024 * 1024 * 1024,
            refreshLookahead: REFRESH_AHEAD_SEGMENTS,
            refreshLookaheadSegments: REFRESH_AHEAD_SEGMENTS,
            prefetchAheadSeconds: 80,
            prefetchAheadSegments: DEFAULT_AHEAD_SEGMENTS,
            keepBehindSeconds: 12,
            keepBehindSegments: 16,
            prefetchConcurrency: 3,
            useWorker: true,
        },
        light: {
            maxBufferLength: 8,
            maxMaxBufferLength: 10,
            backBufferLength: 8,
            maxBufferSize: 64 * 1024 * 1024,
            maxCacheBytes: 192 * 1024 * 1024,
            idbMaxBytes: 512 * 1024 * 1024,
            refreshLookahead: REFRESH_AHEAD_SEGMENTS,
            refreshLookaheadSegments: REFRESH_AHEAD_SEGMENTS,
            prefetchAheadSeconds: 80,
            prefetchAheadSegments: DEFAULT_AHEAD_SEGMENTS,
            keepBehindSeconds: 8,
            keepBehindSegments: 12,
            prefetchConcurrency: 2,
            useWorker: true,
        },
    };

    let hls;
    let currentJob;
    let activeProfile = PROFILES.balanced;
    let activeProfileName = 'balanced';
    let currentMode = 1;
    let lastModeSwitchAt = 0;
    let currentLoadKey = '';
    let idbPromise;
    let decodeWorker;
    let workerRequestId = 0;
    let seekBoostTimer = null;
    let lastSeekAt = 0;
    const workerPending = new Map();
    const segmentCache = new Map();
    const inflightSegments = new Map();
    let cacheBytes = 0;

    const prefetchState = {
        queue: [],
        queued: new Set(),
        active: 0,
        controllers: new Map(),
        lastCenter: -1,
        startupSettled: false,
        fullPrefetchTimer: null,
    };

    function cloneBufferForHls(data) {
        if (data instanceof ArrayBuffer) return data.slice(0);
        if (ArrayBuffer.isView(data)) {
            return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        }
        return data;
    }

    const metrics = {
        directFailures: 0,
        proxyFailures: 0,
        serverFallbacks: 0,
        refreshes: 0,
        refreshFailures: 0,
        refreshMs: [],
        downloads: 0,
        downloadFailures: 0,
        downloadMs: [],
        decodes: 0,
        decodeFailures: 0,
        decodeMs: [],
        decodeSamples: [],
        ramHits: 0,
        idbHits: 0,
        idbWrites: 0,
        idbFailures: 0,
        prefetchQueued: 0,
        prefetchDone: 0,
        prefetchFailed: 0,
        stalls: 0,
        waiting: 0,
        seeks: 0,
        hlsErrors: 0,
        fatalErrors: 0,
        droppedFrames: 0,
        workerDecodes: 0,
        mainDecodes: 0,
        workerFailures: 0,
        startupPrimeHit: 0,
        startupPrimeMiss: 0,
        inflightJoins: 0,
        queuedBytes: 0,
        maxSegmentBytes: 0,
        lastErrorAt: 0,
    };

    function postEmbedMessage(type, payload = {}) {
        if (!embedMode || window.parent === window) return;
        window.parent.postMessage({
            source: 'tiktok-carrier-player',
            type: `carrier:${type}`,
            jobId: currentJob?.jobId || initial.jobId || query.get('jobId') || '',
            ...payload,
        }, '*');
    }

    function setStatus(message) {
        if (statusEl) statusEl.textContent = message || '';
        if (message) postEmbedMessage('status', { message });
        renderTelemetry();
    }

    function setError(message) {
        if (errorEl) errorEl.textContent = message || '';
        if (message) {
            metrics.lastErrorAt = Date.now();
            postEmbedMessage('error', { message });
        }
        renderTelemetry();
    }

    function avg(values) {
        if (!values.length) return 0;
        return values.reduce((sum, item) => sum + item, 0) / values.length;
    }

    function pushMetric(list, value, limit = 20) {
        list.push(value);
        if (list.length > limit) list.shift();
    }

    function modeLabel() {
        return `${MODE_NAMES[currentMode] || 'unknown'} / ${activeProfileName}`;
    }

    function renderTelemetry() {
        if (!telemetryEl) return;
        const buffered = bufferedSecondsAhead();
        const lines = [
            `mode=${modeLabel()} auto=${autoMode ? 'on' : 'off'} direct=${currentJob?.directEnabled ? 'on' : 'off'} worker=${decodeWorker ? 'on' : 'off'}`,
            `buffer=${buffered.toFixed(1)}s targetAhead=${activeProfile.prefetchAheadSegments || DEFAULT_AHEAD_SEGMENTS}seg/${activeProfile.prefetchAheadSeconds || 0}s ram=${(cacheBytes / 1024 / 1024).toFixed(1)}MB queue=${prefetchState.queue.length} queued=${(metrics.queuedBytes / 1024 / 1024).toFixed(1)}MB budget=${(prefetchByteBudget() / 1024 / 1024).toFixed(0)}MB activePrefetch=${prefetchState.active} inflight=${inflightSegments.size}`,
            `cache ramHit=${metrics.ramHits} idbHit=${metrics.idbHits} idbWrite=${metrics.idbWrites} idbFail=${metrics.idbFailures}`,
            `net downloads=${metrics.downloads} avgDownload=${avg(metrics.downloadMs).toFixed(0)}ms directFail=${metrics.directFailures} proxyFail=${metrics.proxyFailures}`,
            `decode count=${metrics.decodes} worker=${metrics.workerDecodes} main=${metrics.mainDecodes} avgDecode=${avg(metrics.decodeMs).toFixed(0)}ms fail=${metrics.decodeFailures}`,
            `refresh count=${metrics.refreshes} avgRefresh=${avg(metrics.refreshMs).toFixed(0)}ms fail=${metrics.refreshFailures}`,
            `prefetch queued=${metrics.prefetchQueued} done=${metrics.prefetchDone} fail=${metrics.prefetchFailed} startupHit=${metrics.startupPrimeHit} startupMiss=${metrics.startupPrimeMiss} inflightJoin=${metrics.inflightJoins}`,
            `playback stalls=${metrics.stalls} waiting=${metrics.waiting} seeks=${metrics.seeks} droppedFrames=${metrics.droppedFrames} hlsErrors=${metrics.hlsErrors} fatal=${metrics.fatalErrors}`,
        ];
        telemetryEl.textContent = lines.join('\n');
    }

    function deviceProfile(job) {
        const requested = String(query.get('profile') || '').toLowerCase();
        if (requested === 'performance' || requested === 'balanced' || requested === 'light') return requested;
        const cores = navigator.hardwareConcurrency || 4;
        const memory = navigator.deviceMemory || 4;
        const totalDuration = totalJobDuration(job);
        if (memory >= 4 && cores >= 4 && totalDuration <= 1800) return 'balanced';
        return 'light';
    }

    function chooseInitialMode(job) {
        return 1;
    }

    function switchMode(nextMode, reason, force = false) {
        return; // disabled: no auto mode switching
    }

    function applyHlsBufferConfig() {
        if (!hls?.config) return;
        hls.config.maxBufferLength = activeProfile.maxBufferLength;
        hls.config.maxMaxBufferLength = activeProfile.maxMaxBufferLength;
        hls.config.backBufferLength = activeProfile.backBufferLength;
        hls.config.maxBufferSize = activeProfile.maxBufferSize;
    }

    function downgradeProfile(reason) {
        return false; // disabled: no auto downgrade
    }

    function isBufferPressureError(data) {
        const text = `${data?.type || ''} ${data?.details || ''} ${data?.error?.message || ''} ${data?.reason || ''}`.toLowerCase();
        return text.includes('bufferfull') || text.includes('objectbufferfull') || text.includes('quota') || text.includes('sourcebuffer');
    }

    function recoverPlaybackError(data) {
        const message = `HLS error: ${data.type} / ${data.details}`;
        const bufferPressure = isBufferPressureError(data);
        if (bufferPressure) {
            downgradeProfile('buffer của trình duyệt bị đầy');
            // if (currentMode < 1) switchMode(1, 'SourceBuffer đầy nên tắt client-only thuần', true);
        }
        if (bufferPressure && !data.fatal) {
            setStatus(`${message}; đã giữ nguyên mode, bỏ auto downgrade/prefetch switch (${modeLabel()})`);
            return true;
        }
        if (!hls) return false;
        if (data.fatal) {
            try {
                hls.recoverMediaError();
                setStatus(`${message}; đã thử recover media fatal (${modeLabel()})`);
                return true;
            } catch (err) {
                return false;
            }
        }
        return false;
    }

    function recordDecodeSample(ms, segmentDuration) {
        const realtime = Number(segmentDuration || 4) * 1000;
        metrics.decodeSamples.push(ms / realtime);
        if (metrics.decodeSamples.length > 8) metrics.decodeSamples.shift();
        const sampleAvg = avg(metrics.decodeSamples);
        // disabled: no auto mode switching on decode speed
    }

    function shouldRefreshSegment(segment) {
        if (!segment) return true;
        if (segment.publicImageUrl) return false;
        if (!segment.directImageUrl) return true;
        if (!segment.expiresAt || !segment.refreshAfter) return false;
        return Date.now() >= Number(segment.refreshAfter);
    }

    function normalizeSrc(value) {
        if (!value) return '';
        if (value.startsWith('http://') || value.startsWith('https://')) return value;
        return value.startsWith('/') ? value : '/' + value;
    }

    function destroyHls(options = {}) {
        const resetVideo = Boolean(options.resetVideo);
        cancelPrefetch();
        if (prefetchState.fullPrefetchTimer) {
            clearTimeout(prefetchState.fullPrefetchTimer);
            prefetchState.fullPrefetchTimer = null;
        }
        prefetchState.startupSettled = false;
        destroyWorker();
        if (hls) {
            hls.destroy();
            hls = null;
        }
        if (resetVideo) {
            video.pause();
            video.removeAttribute('src');
            video.load();
        }
    }

    function segmentKey(job, index) {
        return `${job.assetVersion || job.jobId}:seg:${index}`;
    }

    function estimateSegmentBytes(segment) {
        const direct = Number(segment?.pngBytes || segment?.carrierBytes || segment?.payloadBytes || segment?.tsBytes || 0);
        if (Number.isFinite(direct) && direct > 0) return direct;
        return 4 * 1024 * 1024;
    }

    function prefetchByteBudget() {
        const cacheLimit = activeProfile.maxCacheBytes || MAX_CACHE_BYTES;
        return Math.max(MIN_PREFETCH_BUDGET_BYTES, Math.min(cacheLimit * 0.8, MAX_PREFETCH_BUDGET_BYTES));
    }

    function queuedPrefetchBytes(job = currentJob) {
        if (!job) return 0;
        let total = 0;
        const indexes = new Set(prefetchState.queue);
        for (const index of prefetchState.controllers.keys()) indexes.add(index);
        for (const index of indexes) {
            total += estimateSegmentBytes(job.segments.find(item => item.index === index));
        }
        return total;
    }

    function cacheGet(key) {
        const entry = segmentCache.get(key);
        if (!entry) return null;
        segmentCache.delete(key);
        segmentCache.set(key, entry);
        metrics.ramHits++;
        return entry.data;
    }

    function evictRamCache(limit = activeProfile.maxCacheBytes || MAX_CACHE_BYTES) {
        while (cacheBytes > limit && segmentCache.size > 0) {
            const firstKey = segmentCache.keys().next().value;
            const first = segmentCache.get(firstKey);
            cacheBytes -= first.size;
            segmentCache.delete(firstKey);
        }
        if (cacheBytes < 0 || segmentCache.size === 0) cacheBytes = Math.max(0, cacheBytes);
    }

    function cacheSet(key, data) {
        if (!data || !data.byteLength) return;
        const limit = activeProfile.maxCacheBytes || MAX_CACHE_BYTES;
        if (data.byteLength > limit) return;
        if (segmentCache.has(key)) {
            cacheBytes -= segmentCache.get(key).size;
            segmentCache.delete(key);
        }
        segmentCache.set(key, { data, size: data.byteLength });
        cacheBytes += data.byteLength;
        evictRamCache(limit);
    }

    function openCacheDb() {
        if (!('indexedDB' in window)) return Promise.resolve(null);
        if (idbPromise) return idbPromise;
        idbPromise = new Promise((resolve) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_SEGMENTS)) {
                    const store = db.createObjectStore(STORE_SEGMENTS, { keyPath: 'key' });
                    store.createIndex('lastAccess', 'lastAccess');
                    store.createIndex('assetVersion', 'assetVersion');
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
                metrics.idbFailures++;
                resolve(null);
            };
        });
        return idbPromise;
    }

    async function idbGetSegment(job, index) {
        try {
            const db = await openCacheDb();
            if (!db) return null;
            const key = segmentKey(job, index);
            return await new Promise((resolve) => {
                const tx = db.transaction(STORE_SEGMENTS, 'readwrite');
                const store = tx.objectStore(STORE_SEGMENTS);
                const request = store.get(key);
                request.onsuccess = () => {
                    const entry = request.result;
                    if (!entry || !entry.data) return resolve(null);
                    entry.lastAccess = Date.now();
                    store.put(entry);
                    metrics.idbHits++;
                    resolve(entry.data);
                };
                request.onerror = () => {
                    metrics.idbFailures++;
                    resolve(null);
                };
            });
        } catch (err) {
            metrics.idbFailures++;
            return null;
        }
    }

    async function idbSetSegment(job, index, data) {
        try {
            const db = await openCacheDb();
            if (!db || !data || !data.byteLength) return;
            const key = segmentKey(job, index);
            const now = Date.now();
            await new Promise((resolve) => {
                const tx = db.transaction(STORE_SEGMENTS, 'readwrite');
                tx.oncomplete = resolve;
                tx.onerror = () => {
                    metrics.idbFailures++;
                    resolve();
                };
                tx.objectStore(STORE_SEGMENTS).put({
                    key,
                    jobId: job.jobId,
                    assetVersion: job.assetVersion || job.jobId,
                    index,
                    size: data.byteLength,
                    data,
                    createdAt: now,
                    lastAccess: now,
                });
            });
            metrics.idbWrites++;
            evictIdbIfNeeded().catch(() => {});
        } catch (err) {
            metrics.idbFailures++;
        }
    }

    async function evictIdbIfNeeded() {
        if (!navigator.storage?.estimate) return;
        const estimate = await navigator.storage.estimate();
        const usage = Number(estimate.usage || 0);
        const quota = Number(estimate.quota || 0);
        const target = Math.min(activeProfile.idbMaxBytes || Infinity, quota ? quota * 0.6 : Infinity);
        if (!Number.isFinite(target) || usage < target) return;
        const db = await openCacheDb();
        if (!db) return;
        await new Promise((resolve) => {
            const tx = db.transaction(STORE_SEGMENTS, 'readwrite');
            const index = tx.objectStore(STORE_SEGMENTS).index('lastAccess');
            let freed = 0;
            tx.oncomplete = resolve;
            tx.onerror = resolve;
            index.openCursor().onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor || usage - freed < target * 0.85) return;
                freed += Number(cursor.value?.size || 0);
                cursor.delete();
                cursor.continue();
            };
        });
    }

    function arraysEqual(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    async function sha256(bytes) {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return new Uint8Array(digest);
    }

    function readAscii(bytes, offset, length) {
        let value = '';
        for (let i = 0; i < length; i++) {
            const code = bytes[offset + i];
            if (code === 0) continue;
            value += String.fromCharCode(code);
        }
        return value;
    }

    function findMpegTsOffset(bytes) {
        for (let i = 0; i < bytes.length - 188 * 3; i++) {
            if (
                bytes[i] === 0x47 &&
                bytes[i + 188] === 0x47 &&
                bytes[i + 376] === 0x47 &&
                bytes[i + 564] === 0x47
            ) {
                return i;
            }
        }
        return -1;
    }

    async function parseCarrierBuffer(arrayBuffer, expected) {
        const bytes = new Uint8Array(arrayBuffer);
        const tsOffset = findMpegTsOffset(bytes);
        if (tsOffset >= 0) {
            const payloadLength = bytes.length - tsOffset;
            const payload = new Uint8Array(arrayBuffer, tsOffset, payloadLength);
            return {
                jobId: expected?.jobId || '',
                index: expected?.index || 0,
                total: expected?.total || 0,
                payload,
                payloadLength,
                mode: 'png-append-ts',
                tsOffset,
            };
        }

        const blob = new Blob([arrayBuffer], { type: 'image/png' });
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        const rgba = imageData.data;
        const rgb = new Uint8Array(bitmap.width * bitmap.height * 3);
        for (let src = 0, dst = 0; src < rgba.length && dst < rgb.length; src += 4) {
            rgb[dst++] = rgba[src];
            rgb[dst++] = rgba[src + 1];
            rgb[dst++] = rgba[src + 2];
        }

        const magicStr = readAscii(rgb, 0, 8);
        if (magicStr !== 'TTKPIX1') throw new Error('Carrier magic not found in pixels');

        const version = rgb[8];
        if (version !== VERSION) throw new Error(`Unsupported carrier version ${version}`);

        const headerSize = (rgb[9] << 8) | rgb[10];
        if (headerSize !== HEADER_SIZE) throw new Error(`Invalid carrier header size ${headerSize}`);

        const jobId = readAscii(rgb, 11, 36);
        const index = (rgb[47] << 24) | (rgb[48] << 16) | (rgb[49] << 8) | rgb[50];
        const total = (rgb[51] << 24) | (rgb[52] << 16) | (rgb[53] << 8) | rgb[54];
        const payloadLength = (rgb[55] << 24) | (rgb[56] << 16) | (rgb[57] << 8) | rgb[58];
        const expectedHash = rgb.slice(59, 91);
        const end = HEADER_SIZE + payloadLength;
        if (payloadLength < 1 || end > rgb.length) throw new Error(`Invalid carrier payload length ${payloadLength}`);

        const payload = rgb.slice(HEADER_SIZE, end);
        const actualHash = await sha256(payload);
        if (!arraysEqual(actualHash, expectedHash)) throw new Error('Carrier payload checksum mismatch; image pixels were modified');
        return { jobId, index, total, payload, payloadLength, mode: 'png-pixel-carrier' };
    }

    function workerSupported() {
        // Worker is still supported for offloading ArrayBuffer parsing if needed, but it's so fast now it might not matter.
        return activeProfile.useWorker && 'Worker' in window;
    }

    function ensureWorker() {
        if (!workerSupported()) return null;
        if (decodeWorker) return decodeWorker;
        try {
            decodeWorker = new Worker('/carrier-worker.js');
            decodeWorker.onmessage = (event) => {
                const { id, ok, data, error, meta } = event.data || {};
                const pending = workerPending.get(id);
                if (!pending) return;
                workerPending.delete(id);
                if (ok) pending.resolve({ data, decoded: { payloadLength: data.byteLength }, label: meta?.label || pending.label, meta });
                else pending.reject(new Error(error || 'Worker decode failed'));
            };
            decodeWorker.onerror = (event) => {
                metrics.workerFailures++;
                for (const pending of workerPending.values()) pending.reject(new Error(event.message || 'Worker crashed'));
                workerPending.clear();
                destroyWorker();
            };
        } catch (err) {
            metrics.workerFailures++;
            decodeWorker = null;
        }
        return decodeWorker;
    }

    function destroyWorker() {
        if (decodeWorker) {
            decodeWorker.terminate();
            decodeWorker = null;
        }
        for (const pending of workerPending.values()) pending.reject(new Error('Worker stopped'));
        workerPending.clear();
    }

    function workerFetchAndDecode(job, segment, source) {
        const worker = ensureWorker();
        if (!worker) return null;
        const id = ++workerRequestId;
        const expected = { jobId: job.jobId, index: segment.index, total: job.total };
        return new Promise((resolve, reject) => {
            workerPending.set(id, { resolve, reject, label: source.label });
            worker.postMessage({ id, source, expected });
        });
    }

    async function refreshSegments(job, indexes, force) {
        const unique = Array.from(new Set(indexes.filter(index => Number.isInteger(index))));
        if (unique.length < 1) return [];
        const startedAt = performance.now();
        const response = await fetch(`/api/jobs/${encodeURIComponent(job.jobId)}/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ indexes: unique, force: Boolean(force) }),
            cache: 'no-store',
        });
        const payload = await response.json();
        if (!response.ok) {
            metrics.refreshFailures++;
            throw new Error(payload.error || `Refresh failed ${response.status}`);
        }
        for (const fresh of payload.segments || []) {
            const segment = job.segments.find(item => item.index === fresh.index);
            if (segment) Object.assign(segment, fresh);
        }
        metrics.refreshes++;
        pushMetric(metrics.refreshMs, performance.now() - startedAt);
        return payload.segments || [];
    }

    async function refreshWindowIfNeeded(job, index, options = {}) {
        if (!job.directEnabled) return;
        const defaultLookahead = Math.max(activeProfile.refreshLookahead || 8, activeProfile.refreshLookaheadSegments || REFRESH_AHEAD_SEGMENTS, DEFAULT_AHEAD_SEGMENTS);
        const startupLookahead = Math.min(STARTUP_REFRESH_SEGMENTS, defaultLookahead);
        const requestedLookahead = Number(options.lookahead || (prefetchState.startupSettled ? defaultLookahead : startupLookahead));
        const lookahead = Math.max(1, Math.min(requestedLookahead, defaultLookahead));
        const indexes = [];
        for (let i = index; i < Math.min(job.total, index + lookahead); i++) {
            const segment = job.segments.find(item => item.index === i);
            if (shouldRefreshSegment(segment)) indexes.push(i);
        }
        if (indexes.length > 0) {
            const phase = prefetchState.startupSettled ? 'cửa sổ nền' : 'khởi động nhanh';
            if (!options.quiet) setStatus(`Đang refresh signed URL ${phase} cho ${indexes.length} segment quanh ${index + 1}...`);
            await refreshSegments(job, indexes, false);
        }
    }

    async function fetchAndDecodeSegment(job, segment, source, signal, options = {}) {
        if (!options.prefetch) setStatus(`Đang tải ${source.label} segment ${segment.index + 1}/${job.total} (${modeLabel()})...`);
        const startedAt = performance.now();
        let result;
        const workerPromise = workerFetchAndDecode(job, segment, source);
        if (workerPromise) {
            try {
                result = await workerPromise;
                metrics.workerDecodes++;
                if (signal?.aborted) throw new Error('aborted');
                if (result.meta?.downloadMs) pushMetric(metrics.downloadMs, result.meta.downloadMs);
                if (result.meta?.decodeMs) pushMetric(metrics.decodeMs, result.meta.decodeMs);
            } catch (err) {
                metrics.workerFailures++;
                result = null;
            }
        }

        if (!result) {
            metrics.mainDecodes++;
            const downloadStart = performance.now();
            const response = await fetch(source.url, {
                signal,
                cache: 'force-cache',
                mode: source.direct ? 'cors' : 'same-origin',
                credentials: source.direct ? 'omit' : 'same-origin',
            });
            if (!response.ok) throw new Error(`${source.label} fetch failed ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();
            pushMetric(metrics.downloadMs, performance.now() - downloadStart);
            if (!options.prefetch) setStatus(`Đang parse PNG carrier segment ${segment.index + 1}/${job.total} từ ${source.label}...`);
            const decodeStart = performance.now();
            
            const decoded = await parseCarrierBuffer(arrayBuffer, { jobId: job.jobId, index: segment.index, total: job.total });
            const data = decoded.payload.buffer.slice(decoded.payload.byteOffset, decoded.payload.byteOffset + decoded.payload.byteLength);
            
            pushMetric(metrics.decodeMs, performance.now() - decodeStart);
            result = { data, decoded, label: source.label };
        }

        metrics.downloads++;
        metrics.decodes++;
        recordDecodeSample(performance.now() - startedAt, segment.duration);
        return result;
    }

    async function fetchServerSegment(job, segment, signal) {
        const startedAt = performance.now();
        const response = await fetch(`/carrier/${encodeURIComponent(job.jobId)}/segment/${segment.index}.ts`, {
            signal,
            cache: 'force-cache',
            mode: 'same-origin',
        });
        if (!response.ok) throw new Error(`server segment fallback failed ${response.status}`);
        const data = await response.arrayBuffer();
        metrics.serverFallbacks++;
        pushMetric(metrics.downloadMs, performance.now() - startedAt);
        return { data, decoded: { payloadLength: data.byteLength }, label: 'server segment fallback' };
    }

    async function storeDecoded(job, index, data) {
        const key = segmentKey(job, index);
        cacheSet(key, data);
        idbSetSegment(job, index, data).catch(() => {});
    }

    function waitWithCallerAbort(promise, signal) {
        if (!signal) return promise;
        if (signal.aborted) return Promise.reject(new Error('aborted'));
        return Promise.race([
            promise,
            new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            }),
        ]);
    }

    async function decodeSegment(job, index, signal, options = {}) {
        const key = segmentKey(job, index);
        const cached = cacheGet(key);
        if (cached) return cached;

        const idbCached = await idbGetSegment(job, index);
        if (idbCached) {
            cacheSet(key, idbCached);
            return idbCached;
        }

        if (inflightSegments.has(key)) {
            metrics.inflightJoins++;
            return waitWithCallerAbort(inflightSegments.get(key), signal);
        }

        const promise = (async () => {
            const segment = job.segments.find(item => item.index === index);
            if (!segment || (!segment.imageUrl && !segment.publicImageUrl && !segment.directImageUrl)) throw new Error(`Missing segment ${index}`);

            if (job.directEnabled && currentMode <= 2 && !segment.publicImageUrl) {
                const refreshOptions = options.prefetch
                    ? { lookahead: options.startup ? STARTUP_REFRESH_SEGMENTS : 1, quiet: true }
                    : { lookahead: prefetchState.startupSettled ? undefined : STARTUP_REFRESH_SEGMENTS };
                try { await refreshWindowIfNeeded(job, index, refreshOptions); } catch (err) { metrics.directFailures++; }
            }

            const sources = [];
            if (segment.publicImageUrl && currentMode <= 2) {
                sources.push({ label: 'TikTok public no-cookie', url: segment.publicImageUrl, direct: true, public: true });
            }
            if (job.directEnabled && segment.directImageUrl && currentMode <= 2 && segment.directImageUrl !== segment.publicImageUrl) {
                sources.push({ label: 'CDN TikTok trực tiếp', url: segment.directImageUrl, direct: true });
            }
            if (currentMode >= 1 && segment.imageUrl) {
                sources.push({ label: 'proxy local', url: segment.imageUrl, direct: false });
            }

            const failures = [];
            for (const source of sources) {
                try {
                    const result = await fetchAndDecodeSegment(job, segment, source, null, options);
                    await storeDecoded(job, index, result.data);
                    if (!options.prefetch) setStatus(`Đã decode segment ${index + 1}/${job.total} từ ${result.label} (${(result.decoded.payloadLength / 1024).toFixed(0)} KB, ${modeLabel()})`);
                    return result.data;
                } catch (err) {
                    metrics.decodeFailures++;
                    failures.push(`${source.label}: ${err.message}`);
                    if (source.direct) {
                        metrics.directFailures++;
                        if (source.public) {
                            segment.publicImageFailed = true;
                            if (!options.prefetch) setStatus(`Public URL lỗi segment ${index + 1}, thử signed/proxy fallback...`);
                            continue;
                        }
                        if (!options.prefetch) setStatus(`Direct CDN lỗi segment ${index + 1}, refresh/fallback proxy...`);
                        if (job.directEnabled) {
                            try {
                                await refreshSegments(job, [index], true);
                                if (segment.directImageUrl) {
                                    const retry = await fetchAndDecodeSegment(job, segment, { label: 'CDN TikTok refreshed', url: segment.directImageUrl, direct: true }, null, options);
                                    await storeDecoded(job, index, retry.data);
                                    return retry.data;
                                }
                            } catch (refreshErr) {
                                failures.push(`refresh: ${refreshErr.message}`);
                            }
                        }
                        // disabled: no auto mode switching on direct failures
                    } else {
                        metrics.proxyFailures++;
                    }
                }
            }

            if (serverFallback && currentMode >= 2) {
                try {
                    const result = await fetchServerSegment(job, segment, null);
                    await storeDecoded(job, index, result.data);
                    if (!options.prefetch) setStatus(`Đã nhận segment ${index + 1}/${job.total} từ server fallback (${(result.decoded.payloadLength / 1024).toFixed(0)} KB, ${modeLabel()})`);
                    return result.data;
                } catch (err) {
                    failures.push(`server fallback: ${err.message}`);
                }
            }

            // disabled: no auto mode switching on repeated failures

            metrics.downloadFailures++;
            throw new Error(`Không decode được segment ${index}: ${failures.join(' | ')}`);
        })().finally(() => {
            inflightSegments.delete(key);
            renderTelemetry();
        });

        inflightSegments.set(key, promise);
        return waitWithCallerAbort(promise, signal);
    }

    function totalJobDuration(job) {
        return (job?.segments || []).reduce((sum, item) => sum + Number(item.duration || 4), 0);
    }

    function buildTimeline(job) {
        let time = 0;
        job.timeline = job.segments
            .slice()
            .sort((a, b) => a.index - b.index)
            .map((segment) => {
                const start = time;
                const duration = Number(segment.duration || 4);
                time += duration;
                return { index: segment.index, start, end: time };
            });
        job.duration = time;
        metrics.maxSegmentBytes = Math.max(...job.segments.map(estimateSegmentBytes), 0);
    }

    function segmentIndexFromTime(job, time) {
        if (!job?.timeline?.length) return 0;
        let lo = 0;
        let hi = job.timeline.length - 1;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const item = job.timeline[mid];
            if (time < item.start) hi = mid - 1;
            else if (time >= item.end) lo = mid + 1;
            else return item.index;
        }
        return job.timeline[Math.max(0, Math.min(job.timeline.length - 1, lo))]?.index || 0;
    }

    function bufferedSecondsAhead() {
        try {
            const time = video.currentTime || 0;
            for (let i = 0; i < video.buffered.length; i++) {
                if (video.buffered.start(i) <= time && video.buffered.end(i) >= time) {
                    return video.buffered.end(i) - time;
                }
            }
        } catch (err) {}
        return 0;
    }

    function cancelPrefetch() {
        for (const controller of prefetchState.controllers.values()) controller.abort();
        prefetchState.controllers.clear();
        prefetchState.queue = [];
        prefetchState.queued.clear();
        metrics.queuedBytes = 0;
    }

    function schedulePrefetch(centerIndex, options = {}) {
        if (!currentJob || currentMode >= 3 || !autoMode) return;
        if (!Number.isInteger(centerIndex)) return;
        if (!prefetchState.startupSettled && !options.startup && !options.force) return;
        const aheadSeconds = activeProfile.prefetchAheadSeconds || 0;
        const aheadSegments = Math.max(activeProfile.prefetchAheadSegments || 0, DEFAULT_AHEAD_SEGMENTS);
        const concurrency = activeProfile.prefetchConcurrency || 0;
        if ((aheadSeconds <= 0 && aheadSegments <= 0) || concurrency <= 0) {
            cancelPrefetch();
            return;
        }
        if (cacheBytes >= (activeProfile.maxCacheBytes || MAX_CACHE_BYTES) * 0.92) {
            cancelPrefetch();
            return;
        }
        if (centerIndex === prefetchState.lastCenter && !options.force) return;
        prefetchState.lastCenter = centerIndex;

        const keepBehindSeconds = activeProfile.keepBehindSeconds || 60;
        const keepBehindSegments = activeProfile.keepBehindSegments || 12;
        const wanted = [];
        const byteBudget = prefetchByteBudget();
        let ahead = 0;
        let estimatedBytes = queuedPrefetchBytes(currentJob);
        for (let i = centerIndex + 1; i < currentJob.total; i++) {
            const segment = currentJob.segments.find(item => item.index === i);
            if (!segment) continue;
            const segmentBytes = estimateSegmentBytes(segment);
            const needMoreSegments = wanted.length < aheadSegments;
            const needMoreSeconds = ahead < aheadSeconds;
            if (!needMoreSegments && !needMoreSeconds) break;
            if (wanted.length > 0 && !needMoreSegments && estimatedBytes + segmentBytes > byteBudget) break;
            if (wanted.length >= aheadSegments && estimatedBytes + segmentBytes > byteBudget) break;
            wanted.push(i);
            estimatedBytes += segmentBytes;
            ahead += Number(segment.duration || 4);
        }
        metrics.queuedBytes = estimatedBytes;

        const keepMinBySeconds = Math.max(0, centerIndex - Math.ceil(keepBehindSeconds / 2));
        const keepMin = Math.max(0, Math.min(keepMinBySeconds, centerIndex - keepBehindSegments));
        const keepMax = Math.min(currentJob.total - 1, centerIndex + Math.max(wanted.length, aheadSegments) + 4);
        for (const [index, controller] of prefetchState.controllers.entries()) {
            if (index < keepMin || index > keepMax) {
                controller.abort();
                prefetchState.controllers.delete(index);
            }
        }

        refreshWindowIfNeeded(currentJob, centerIndex).catch(() => {});
        for (const index of wanted) enqueuePrefetch(index);
        metrics.queuedBytes = queuedPrefetchBytes(currentJob);
        pumpPrefetch();
    }

    function enqueuePrefetch(index, urgent = false) {
        if (!currentJob || index < 0 || index >= currentJob.total) return;
        const key = segmentKey(currentJob, index);
        if (segmentCache.has(key) || inflightSegments.has(key) || prefetchState.queued.has(index) || prefetchState.controllers.has(index)) return;
        const segment = currentJob.segments.find(item => item.index === index);
        const segmentBytes = estimateSegmentBytes(segment);
        const byteBudget = prefetchByteBudget();
        if (!urgent && queuedPrefetchBytes(currentJob) + segmentBytes > byteBudget) return;
        prefetchState.queued.add(index);
        if (urgent) {
            const insertAt = prefetchState.queue.findIndex(value => value > index);
            if (insertAt >= 0) prefetchState.queue.splice(insertAt, 0, index);
            else prefetchState.queue.push(index);
        } else prefetchState.queue.push(index);
        metrics.queuedBytes = queuedPrefetchBytes(currentJob);
        metrics.prefetchQueued++;
    }

    function prefetchBoost(centerIndex, count = URGENT_AHEAD_SEGMENTS, options = {}) {
        if (!currentJob || currentMode >= 3 || !autoMode) return;
        if (!Number.isInteger(centerIndex)) return;
        if (options.cancel !== false) cancelPrefetch();
        refreshWindowIfNeeded(currentJob, centerIndex).catch(() => {});
        const limit = Math.max(1, Number(count || URGENT_AHEAD_SEGMENTS));
        for (let i = centerIndex; i < Math.min(currentJob.total, centerIndex + limit); i++) enqueuePrefetch(i, true);
        pumpPrefetch();
    }

    function scheduleSeekBoost(delay = 350) {
        if (!currentJob || !autoMode) return;
        lastSeekAt = performance.now();
        if (seekBoostTimer) clearTimeout(seekBoostTimer);
        seekBoostTimer = setTimeout(() => {
            seekBoostTimer = null;
            if (!currentJob) return;
            const index = segmentIndexFromTime(currentJob, video.currentTime || 0);
            prefetchBoost(index, URGENT_AHEAD_SEGMENTS);
            setStatus(`Đã ổn định vị trí tua, tải trước khoảng ${URGENT_AHEAD_SEGMENTS} segment từ segment ${index + 1} (${modeLabel()})`);
        }, delay);
    }

    function settleStartupPrefetch(reason) {
        if (!currentJob || !autoMode || prefetchState.startupSettled) return;
        prefetchState.startupSettled = true;
        const index = segmentIndexFromTime(currentJob, video.currentTime || 0);
        if (prefetchState.fullPrefetchTimer) clearTimeout(prefetchState.fullPrefetchTimer);
        prefetchState.fullPrefetchTimer = setTimeout(() => {
            prefetchState.fullPrefetchTimer = null;
            if (!currentJob || currentMode >= 3) return;
            refreshWindowIfNeeded(currentJob, index, { lookahead: REFRESH_AHEAD_SEGMENTS, quiet: true }).catch(() => {});
            schedulePrefetch(index, { force: true });
            setStatus(`Video đã bắt đầu ${reason || 'ổn định'}, mở refresh/prefetch nền khoảng ${DEFAULT_AHEAD_SEGMENTS}-${REFRESH_AHEAD_SEGMENTS} segment (${modeLabel()})`);
        }, STARTUP_FULL_PREFETCH_DELAY_MS);
    }

    async function primeStartupSegments(job) {
        if (!job || currentMode >= 3 || !autoMode) return;
        openCacheDb().catch(() => {});
        ensureWorker();
        const startupCount = Math.min(job.total, STARTUP_PRIME_SEGMENTS);
        refreshWindowIfNeeded(job, 0, { lookahead: Math.min(job.total, STARTUP_REFRESH_SEGMENTS), quiet: true }).catch(() => {});
        const primePromise = decodeSegment(job, 0, null, { prefetch: true, startup: true })
            .then(() => { metrics.startupPrimeHit++; })
            .catch(() => { metrics.startupPrimeMiss++; });
        for (let i = 1; i < startupCount; i++) enqueuePrefetch(i, true);
        pumpPrefetch();
        await Promise.race([
            primePromise,
            new Promise(resolve => setTimeout(resolve, 1200)),
        ]);
        setStatus(`Đã prime nhanh ${startupCount} segment đầu; video sẽ phát trước rồi tải trước khoảng ${DEFAULT_AHEAD_SEGMENTS} segment trong nền.`);
        renderTelemetry();
    }

    function pumpPrefetch() {
        if (!currentJob) return;
        const limit = activeProfile.prefetchConcurrency || 0;
        if (limit <= 0) return;
        while (prefetchState.active < limit && prefetchState.queue.length > 0) {
            const index = prefetchState.queue.shift();
            prefetchState.queued.delete(index);
            const controller = new AbortController();
            prefetchState.controllers.set(index, controller);
            prefetchState.active++;
            decodeSegment(currentJob, index, controller.signal, { prefetch: true })
                .then(() => { metrics.prefetchDone++; })
                .catch((err) => { if (!controller.signal.aborted) metrics.prefetchFailed++; })
                .finally(() => {
                    prefetchState.active = Math.max(0, prefetchState.active - 1);
                    prefetchState.controllers.delete(index);
                    metrics.queuedBytes = queuedPrefetchBytes(currentJob);
                    renderTelemetry();
                    pumpPrefetch();
                });
        }
        renderTelemetry();
    }

    function parseSegmentIndex(url) {
        const match = String(url || '').match(/\/carrier\/([^/]+)\/segment\/(\d+)\.ts(?:\?|$)/);
        if (!match) return null;
        return { jobId: decodeURIComponent(match[1]), index: Number(match[2]) };
    }

    class CarrierLoader extends Hls.DefaultConfig.loader {
        constructor(config) {
            super(config);
            this.controller = null;
            this.fallbackLoader = null;
        }

        load(context, config, callbacks) {
            const parsed = parseSegmentIndex(context.url);
            if (!parsed || !currentJob || parsed.jobId !== currentJob.jobId) {
                this.fallbackLoader = new Hls.DefaultConfig.loader(config);
                this.fallbackLoader.load(context, config, callbacks);
                return;
            }

            this.context = context;
            this.config = config;
            this.callbacks = callbacks;
            this.stats = { trequest: performance.now(), retry: 0, loaded: 0, total: 0 };
            this.controller = new AbortController();

            decodeSegment(currentJob, parsed.index, this.controller.signal)
                .then((data) => {
                    this.stats.tfirst = this.stats.tfirst || performance.now();
                    this.stats.loaded = data.byteLength;
                    this.stats.total = data.byteLength;
                    this.stats.tload = performance.now();
                    schedulePrefetch(parsed.index);
                    callbacks.onSuccess({ url: context.url, data: cloneBufferForHls(data) }, this.stats, context, null);
                })
                .catch((err) => {
                    if (this.controller?.signal?.aborted) return;
                    setError(err.message);
                    callbacks.onError({ code: 0, text: err.message }, context, null, this.stats);
                });
        }

        abort() {
            if (this.controller) this.controller.abort();
            if (this.fallbackLoader && this.fallbackLoader.abort) this.fallbackLoader.abort();
        }

        destroy() {
            this.abort();
            if (this.fallbackLoader && this.fallbackLoader.destroy) this.fallbackLoader.destroy();
            this.controller = null;
            this.fallbackLoader = null;
            this.callbacks = null;
            this.context = null;
            this.config = null;
        }
    }

    async function loadCarrierJob(jobId) {
        jobId = String(jobId || '').trim();
        if (!jobId) {
            setError('Chưa có Job ID.');
            return;
        }
        const loadKey = `job:${jobId}:direct:${directMode ? '1' : '0'}:auto:${autoMode ? '1' : '0'}:profile:${query.get('profile') || ''}`;
        if (currentLoadKey === loadKey && currentJob?.jobId === jobId && hls) return;
        currentLoadKey = loadKey;

        destroyHls({ resetVideo: false });
        segmentCache.clear();
        cacheBytes = 0;
        setError('');
        jobInput.value = jobId;

        let job = null;
        const bootstrapJob = initial.bootstrapJob;
        if (bootstrapJob && bootstrapJob.jobId === jobId && Boolean(bootstrapJob.directEnabled) === Boolean(directMode)) {
            job = bootstrapJob;
            setStatus('');
        } else {
            setStatus(`Đang tải manifest job ${jobId}...`);
            const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}${directMode ? '?direct=1' : ''}`, { cache: 'no-store' });
            job = await response.json();
            if (!response.ok) throw new Error(job.error || `Job API failed ${response.status}`);
        }
        if (!job.complete) throw new Error(`Job chưa đủ segment (${job.uploaded}/${job.total})`);
        buildTimeline(job);
        activeProfileName = deviceProfile(job);
        activeProfile = PROFILES[activeProfileName] || PROFILES.balanced;
        currentMode = 1;
        currentJob = job;
        ensureWorker();
        primeStartupSegments(job).catch(() => {});

        if (window.Hls && Hls.isSupported() && currentMode < 3) {
            hls = new Hls({
                enableWorker: true,
                loader: CarrierLoader,
                maxBufferLength: activeProfile.maxBufferLength,
                maxMaxBufferLength: activeProfile.maxMaxBufferLength,
                backBufferLength: activeProfile.backBufferLength,
                maxBufferSize: activeProfile.maxBufferSize,
                startPosition: 0,
                startFragPrefetch: true,
            });
            hls.on(Hls.Events.ERROR, (event, data) => {
                metrics.hlsErrors++;
                const message = `HLS error: ${data.type} / ${data.details}`;
                const recovered = recoverPlaybackError(data);
                if (data.fatal) {
                    metrics.fatalErrors++;
                    if (recovered) return;
                    // disabled: no auto mode switching on fatal errors
                    setError(`${message}${data.error?.message ? `: ${data.error.message}` : ''}`);
                } else if (!recovered) {
                    setStatus(`${message} (${modeLabel()})`);
                }
            });
            hls.attachMedia(video);
            hls.on(Hls.Events.MEDIA_ATTACHED, () => {
                hls.loadSource(job.carrierPlaylistUrl);
            });
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                setStatus(`Sẵn sàng phát carrier job ${jobId} (${job.total} segment, auto=${autoMode ? 'on' : 'off'}, mode=${modeLabel()}, direct=${job.directEnabled ? 'on' : 'off'}). Đang prime ${Math.min(job.total, STARTUP_PRIME_SEGMENTS)} segment đầu trước.`);
                video.play().catch(() => {});
            });
            return;
        }

        if (serverFallback && video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = job.carrierPlaylistUrl;
            setStatus('Trình duyệt không hỗ trợ hls.js/MSE, dùng Safari/native fallback server decode từng segment.');
            video.play().catch(() => {});
            return;
        }

        throw new Error('Trình duyệt này không hỗ trợ carrier playback. Hãy dùng Chrome/Edge desktop, hoặc bật ENABLE_SERVER_SEGMENT_FALLBACK=true cho Safari native.');
    }

    function loadNormalHls(value) {
        const src = normalizeSrc(value);
        srcInput.value = src;
        const loadKey = `src:${src}`;
        if (currentLoadKey === loadKey && !currentJob && hls) return;
        currentLoadKey = loadKey;
        destroyHls({ resetVideo: false });
        currentJob = null;
        setStatus('');
        setError('');

        if (!src) {
            setError('Chưa có link m3u8.');
            return;
        }

        if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = src;
            video.play().catch(() => {});
            return;
        }

        if (!window.Hls || !Hls.isSupported()) {
            setError('Trình duyệt này không hỗ trợ HLS/hls.js.');
            return;
        }

        hls = new Hls({ enableWorker: true });
        hls.on(Hls.Events.ERROR, (event, data) => {
            const message = `HLS error: ${data.type} / ${data.details}`;
            if (data.fatal) setError(message);
            else setStatus(message);
        });
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    }

    video.addEventListener('playing', () => {
        settleStartupPrefetch('phát');
        postEmbedMessage('play', { currentTime: video.currentTime || 0, duration: video.duration || 0 });
    });
    video.addEventListener('pause', () => postEmbedMessage('pause', { currentTime: video.currentTime || 0, duration: video.duration || 0 }));
    video.addEventListener('ended', () => postEmbedMessage('ended', { currentTime: video.currentTime || 0, duration: video.duration || 0 }));
    video.addEventListener('canplay', () => {
        settleStartupPrefetch('có buffer đầu');
        postEmbedMessage('ready', { currentTime: video.currentTime || 0, duration: video.duration || 0 });
    });
    video.addEventListener('timeupdate', () => {
        if (embedMode) postEmbedMessage('timeupdate', { currentTime: video.currentTime || 0, duration: video.duration || 0 });
        if (!currentJob) return;
        settleStartupPrefetch('có timeupdate');
        schedulePrefetch(segmentIndexFromTime(currentJob, video.currentTime || 0));
        renderTelemetry();
    });
    video.addEventListener('seeking', () => {
        metrics.seeks++;
        if (currentJob) {
            const index = segmentIndexFromTime(currentJob, video.currentTime || 0);
            scheduleSeekBoost();
            setStatus(`Đang tua tới segment ${index + 1}; đợi vị trí ổn định rồi tải trước khoảng ${URGENT_AHEAD_SEGMENTS} segment (${modeLabel()})`);
        }
    });
    video.addEventListener('seeked', () => {
        if (currentJob) scheduleSeekBoost(80);
    });
    video.addEventListener('stalled', () => { metrics.stalls++; renderTelemetry(); });
    video.addEventListener('waiting', () => {
        metrics.waiting++;
        if (currentJob && autoMode && bufferedSecondsAhead() < 5) {
            const index = segmentIndexFromTime(currentJob, video.currentTime || 0);
            const recentlySeeking = performance.now() - lastSeekAt < 1200;
            const boostCount = prefetchState.startupSettled ? URGENT_AHEAD_SEGMENTS : STARTUP_PRIME_SEGMENTS;
            prefetchBoost(index, boostCount, { cancel: prefetchState.startupSettled && !recentlySeeking });
            setStatus(`Buffer thấp, đang tải trước khoảng ${boostCount} segment từ segment ${index + 1} (${modeLabel()})`);
        }
        renderTelemetry();
    });

    setInterval(() => {
        if (video.getVideoPlaybackQuality) {
            const q = video.getVideoPlaybackQuality();
            metrics.droppedFrames = q.droppedVideoFrames || 0;
        }
        renderTelemetry();
    }, 2000);

    document.getElementById('loadJob').addEventListener('click', () => {
        loadCarrierJob(jobInput.value).catch(err => setError(err.message));
    });
    document.getElementById('loadSrc').addEventListener('click', () => loadNormalHls(srcInput.value));
    jobInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') loadCarrierJob(jobInput.value).catch(err => setError(err.message));
    });
    srcInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') loadNormalHls(srcInput.value);
    });

    if (initial.jobId) {
        jobInput.value = initial.jobId;
        loadCarrierJob(initial.jobId).catch(err => setError(err.message));
    } else if (initial.src) {
        srcInput.value = normalizeSrc(initial.src);
        loadNormalHls(initial.src);
    }
})();
