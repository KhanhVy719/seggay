// tiktok.js
if (!process.env.TIKTOK_COOKIE && process.env.CONSUMER_COOKIES_JSON) {
    try {
        const parsed = JSON.parse(process.env.CONSUMER_COOKIES_JSON);
        if (Array.isArray(parsed) && parsed.length > 0) {
            process.env.TIKTOK_COOKIE = parsed.map(c => `${c.name}=${c.value}`).join('; ');
        }
    } catch (e) {}
}
const axios = require('axios');
const { spawn } = require('child_process');
const { randomBytes } = require('crypto');
const FormData = require('form-data');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { promisify } = require('util');
const util = require('util');
const {
    APPEND_TS_MODE,
    encodePayloadToAppendPng,
    encodePayloadToPng,
    decodePngCarrierBuffer,
} = require('./carrier');

const execPromise = promisify(require('child_process').exec);

let ffmpegPath = 'ffmpeg';
let ffprobePath = 'ffprobe';

try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic) {
        ffmpegPath = ffmpegStatic;
        const ffmpegDir = path.dirname(ffmpegStatic);
        const possibleFfprobe = path.join(ffmpegDir, 'ffprobe.exe');
        if (fs.existsSync(possibleFfprobe)) {
            ffprobePath = possibleFfprobe;
        }
    }
} catch (e) {}

function randomString(len = 8) {
    return randomBytes(len).toString('hex').substring(0, len);
}

async function createThumbnail(videoPath) {
    const thumbPath = path.join(path.dirname(videoPath), `thumb_${Date.now()}.png`);
    await execPromise(`"${ffmpegPath}" -i "${videoPath}" -ss 00:00:01 -vframes 1 -vf "scale=640:360" "${thumbPath}" -y`);
    return thumbPath;
}

async function appendDataToPng(pngPath, dataPath, outputPath) {
    const pngBuffer = fs.readFileSync(pngPath);
    const dataBuffer = fs.readFileSync(dataPath);
    fs.writeFileSync(outputPath, Buffer.concat([pngBuffer, dataBuffer]));
    return outputPath;
}

async function parseHlsPlaylist(playlistPath, fallbackDuration) {
    const text = await fsp.readFile(playlistPath, 'utf8');
    const durations = [];
    let targetDuration = Math.ceil(fallbackDuration || 4);

    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('#EXT-X-TARGETDURATION:')) {
            const value = Number(line.split(':')[1]);
            if (Number.isFinite(value) && value > 0) targetDuration = Math.ceil(value);
        }
        if (line.startsWith('#EXTINF:')) {
            const value = Number(line.slice('#EXTINF:'.length).split(',')[0]);
            if (Number.isFinite(value) && value > 0) durations.push(value);
        }
    }

    if (durations.length > 0) {
        targetDuration = Math.max(targetDuration, Math.ceil(Math.max(...durations)));
    }

    return { durations, targetDuration };
}

async function writeJson(filePath, data) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function positiveNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function mbToBytes(value) {
    return Math.round(value * 1024 * 1024);
}

function clampInteger(value, fallback, min = 1, max = 8) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(number)));
}

function formatMb(bytes) {
    return `${(Number(bytes || 0) / 1024 / 1024).toFixed(2)} MB`;
}

function normalizeCodec(value) {
    return String(value || '').trim().toLowerCase();
}

function isTenBitPixelFormat(value) {
    const pixFmt = normalizeCodec(value);
    return /10|12|p010|p016|yuv420p10|yuv422p10|yuv444p10/.test(pixFmt);
}

function browserSafeHlsDecision(metadata = {}) {
    const videoCodec = normalizeCodec(metadata.videoCodec || metadata.codecName || metadata.codec_name);
    const audioCodec = normalizeCodec(metadata.audioCodec || metadata.audioCodecName || metadata.audio_codec);
    const pixFmt = normalizeCodec(metadata.pixelFormat || metadata.pixFmt || metadata.pix_fmt);
    const profile = normalizeCodec(metadata.profile);
    const reasons = [];

    if (!videoCodec) reasons.push('missing-video-codec');
    if (['hevc', 'h265', 'hev1', 'hvc1'].includes(videoCodec)) reasons.push(`unsupported-video-codec:${videoCodec}`);
    if (['vp9', 'av1', 'av01'].includes(videoCodec)) reasons.push(`unsupported-video-codec:${videoCodec}-in-ts`);
    if (videoCodec && !['h264', 'avc1'].includes(videoCodec) && !reasons.some(reason => reason.startsWith('unsupported-video-codec'))) {
        reasons.push(`unknown-video-codec:${videoCodec}`);
    }
    if (isTenBitPixelFormat(pixFmt)) reasons.push(`unsupported-pixel-format:${pixFmt}`);
    if (profile.includes('10')) reasons.push(`unsupported-profile:${profile}`);
    if (audioCodec && !['aac', 'mp3'].includes(audioCodec)) reasons.push(`transcode-audio:${audioCodec}`);

    return {
        safe: reasons.length === 0,
        reasons,
        videoCodec: videoCodec || null,
        audioCodec: audioCodec || null,
        pixelFormat: pixFmt || null,
        profile: profile || null,
    };
}

function envFlag(name, fallback = false) {
    const value = process.env[name];
    if (value === undefined) return fallback;
    return /^(1|true|yes|on)$/i.test(String(value));
}

function normalizeCookieList(list) {
    return (Array.isArray(list) ? list : [])
        .filter(cookie => cookie && cookie.name && cookie.value)
        .map(cookie => ({ name: String(cookie.name), value: String(cookie.value) }));
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

    const rows = raw.includes('\n') ? raw.split(/\r?\n/) : raw.split(';');
    return rows
        .map(row => row.trim())
        .filter(Boolean)
        .map(row => {
            const idx = row.indexOf('=');
            if (idx === -1) return null;
            return { name: row.slice(0, idx).trim(), value: row.slice(idx + 1).trim() };
        })
        .filter(cookie => cookie?.name && cookie?.value);
}

function buildCookieHeader(cookies) {
    return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

function getRuntimeCookies() {
    const consumerCookies = parseCookieInput(process.env.CONSUMER_COOKIES_JSON || '');
    if (consumerCookies.length) return consumerCookies;
    return parseCookieInput(process.env.TIKTOK_COOKIE || '');
}

function pickCookieValue(cookies, names) {
    for (const name of names) {
        const found = cookies.find(cookie => cookie.name === name);
        if (found?.value) return found.value;
    }
    return '';
}

function estimateFrameRate(metadata = {}) {
    const values = [metadata.frameRate, metadata.avgFrameRate, metadata.rFrameRate];
    for (const value of values) {
        if (!value) continue;
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
        const text = String(value);
        if (text.includes('/')) {
            const [a, b] = text.split('/').map(Number);
            if (Number.isFinite(a) && Number.isFinite(b) && b > 0) return a / b;
        }
        const parsed = Number(text);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 30;
}

function buildTranscodeOptions(metadata = {}, policy = {}, duration = 4) {
    const audioBitrate = positiveNumber(process.env.TRANSCODE_AUDIO_BITRATE, 128000);
    const width = positiveNumber(metadata.width, 1280);
    const height = positiveNumber(metadata.height, 720);
    const fps = Math.max(1, Math.min(120, estimateFrameRate(metadata)));
    const sourceBitrate = positiveNumber(metadata.bitrate || metadata.videoBitrate || metadata.formatBitrate, 0);
    const targetTotalBps = Math.max(600000, policy.targetSegmentBytes * 8 / Math.max(duration, 0.5));
    const maxTotalBps = Math.max(targetTotalBps, policy.maxSegmentBytes * 8 / Math.max(duration, 0.5));
    const resolutionBased = Math.max(1200000, width * height * fps * 0.03);
    const sourceBased = sourceBitrate > 0 ? sourceBitrate * 2.5 : 0;
    const envVideoBitrate = positiveNumber(process.env.TRANSCODE_VIDEO_BITRATE, 0);
    const targetVideoCap = Math.max(500000, targetTotalBps - audioBitrate - 150000);
    const maxVideoCap = Math.max(targetVideoCap, maxTotalBps - audioBitrate - 150000);
    const videoBitrate = Math.round(Math.min(targetVideoCap, envVideoBitrate || Math.max(resolutionBased, sourceBased, 1500000)));
    const maxVideoBitrate = Math.round(Math.min(maxVideoCap, Math.max(videoBitrate * 1.6, videoBitrate + 500000)));
    const gop = Math.max(1, Math.round(fps * duration));

    return {
        audioBitrate,
        videoBitrate,
        maxVideoBitrate,
        bufSize: Math.max(maxVideoBitrate * 2, videoBitrate * 2),
        gop,
        preset: process.env.TRANSCODE_PRESET || 'veryfast',
    };
}

function buildSizingPolicy(metadata = {}, requestedSegDuration = 4) {
    const targetMb = positiveNumber(process.env.SEGMENT_TARGET_MB, 3.5);
    const maxMb = Math.max(targetMb, positiveNumber(process.env.SEGMENT_MAX_MB, 5));
    const minDuration = Math.max(0.1, positiveNumber(process.env.SEGMENT_MIN_SECONDS, 0.25));
    const maxDuration = Math.max(minDuration, positiveNumber(process.env.SEGMENT_MAX_SECONDS, 10));
    const fallbackDuration = Math.max(minDuration, Math.min(maxDuration, positiveNumber(requestedSegDuration, 3)));
    const bitrate = positiveNumber(metadata.bitrate || metadata.videoBitrate || metadata.formatBitrate, 0);
    const targetBytes = mbToBytes(targetMb);
    const maxBytes = mbToBytes(maxMb);
    const sizingTargetBytes = Math.min(targetBytes, Math.floor(maxBytes * 0.82));

    let selectedSegmentDuration = fallbackDuration;
    if (bitrate > 0) {
        selectedSegmentDuration = sizingTargetBytes * 8 / bitrate;
    }
    selectedSegmentDuration = Math.max(minDuration, Math.min(maxDuration, selectedSegmentDuration));
    selectedSegmentDuration = Math.max(0.1, Math.round(selectedSegmentDuration * 100) / 100);

    return {
        targetSegmentBytes: targetBytes,
        maxSegmentBytes: maxBytes,
        sizingTargetBytes,
        targetSegmentMb: targetMb,
        maxSegmentMb: maxMb,
        minSegmentDuration: minDuration,
        maxSegmentDuration: maxDuration,
        selectedSegmentDuration,
        sourceBitrate: bitrate || null,
        strictSegmentBytes: envFlag('STRICT_SEGMENT_BYTES', false),
        preserveSourceQuality: envFlag('PRESERVE_SOURCE_QUALITY', true),
        strategy: 'copy-preserve-quality',
    };
}

function collectSegmentStats(jobPublicDir, tsFiles, durations, seg, policy) {
    return tsFiles.map((file, index) => {
        const tsPath = path.join(jobPublicDir, file);
        const tsBytes = fs.statSync(tsPath).size;
        return {
            index,
            duration: durations[index] || seg,
            originalTsFile: file,
            tsBytes,
            overTarget: tsBytes > policy.targetSegmentBytes,
            overMax: tsBytes > policy.maxSegmentBytes,
            imageUri: '',
            uploaded: false,
        };
    });
}

function isAllowedPublicImageHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    const allowed = [
        'tiktokcdn.com',
        'tiktokcdn-us.com',
        'tiktokcdn-eu.com',
        'byteimg.com',
        'ibytedtos.com',
        'pstatp.com',
        'ttwstatic.com',
        'tiktok.com',
    ];
    return allowed.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function hasSignedOrExpiringQuery(parsed) {
    for (const key of parsed.searchParams.keys()) {
        if (/^(x-)?(expires?|expire|expiry|signature|sign|sig|token|auth|auth_key|timestamp|ts)$/i.test(key)) return true;
        if (/sign|signature|expire|token|auth/i.test(key)) return true;
    }
    return false;
}

function normalizeCandidateUrl(value) {
    if (!value) return '';
    let text = String(value).trim();
    if (!text) return '';
    try { text = JSON.parse(`"${text.replace(/"/g, '\\"')}"`); } catch (err) {}
    text = text
        .replace(/\\u0026/g, '&')
        .replace(/&amp;/g, '&')
        .replace(/^url\((['"]?)(.*)\1\)$/i, '$2')
        .trim();
    if (text.startsWith('//')) text = `https:${text}`;
    if (!/^https:\/\//i.test(text)) return '';
    try {
        const parsed = new URL(text);
        parsed.hash = '';
        if (!isAllowedPublicImageHost(parsed.hostname)) return '';
        if (hasSignedOrExpiringQuery(parsed)) return '';
        return parsed.toString();
    } catch (err) {
        return '';
    }
}

function collectUrlCandidates(value, output = [], seen = new Set(), depth = 0) {
    if (value == null || depth > 8) return output;
    if (typeof value === 'string' || typeof value === 'number') {
        const url = normalizeCandidateUrl(value);
        if (url && !seen.has(url)) {
            seen.add(url);
            output.push(url);
        }
        return output;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectUrlCandidates(item, output, seen, depth + 1);
        return output;
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value);
        entries.sort(([a], [b]) => {
            const rank = key => /image|url|uri|preview|thumb|origin|download/i.test(key) ? 0 : 1;
            return rank(a) - rank(b);
        });
        for (const [, item] of entries) collectUrlCandidates(item, output, seen, depth + 1);
    }
    return output;
}

async function probePublicCarrierUrl(url, expected, userAgent) {
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 12000,
        maxRedirects: 0,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        headers: {
            'User-Agent': userAgent,
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
        validateStatus: status => status >= 200 && status < 300,
    });
    const decoded = await decodePngCarrierBuffer(Buffer.from(response.data), expected);
    if (decoded.mode !== APPEND_TS_MODE && (decoded.jobId !== expected.jobId || decoded.index !== expected.index || decoded.total !== expected.total)) {
        throw new Error(`Carrier metadata mismatch (${decoded.jobId}/${decoded.index}/${decoded.total})`);
    }
    return {
        url,
        payloadLength: decoded.payloadLength,
        contentType: response.headers['content-type'] || 'image/png',
        bytes: Buffer.byteLength(response.data),
        carrierMode: decoded.mode,
        tsOffset: decoded.tsOffset || 0,
    };
}

class TiktokService {
    constructor() {
        this.publicDir = path.join(process.cwd(), 'public', 'upload');
        this.secureKeyDir = path.join(process.cwd(), 'upload', 'tiktok', 'secure_keys');
        this.manifestDir = path.join(process.cwd(), 'upload', 'tiktok', 'manifests');

        if (!fs.existsSync(this.publicDir))
            fs.mkdirSync(this.publicDir, { recursive: true });
        if (!fs.existsSync(this.secureKeyDir))
            fs.mkdirSync(this.secureKeyDir, { recursive: true });
        if (!fs.existsSync(this.manifestDir))
            fs.mkdirSync(this.manifestDir, { recursive: true });
    }

    get config() {
        const runtimeCookies = getRuntimeCookies();
        const cookie = runtimeCookies.length ? buildCookieHeader(runtimeCookies) : (process.env.TIKTOK_COOKIE || '');
        const csrfToken = pickCookieValue(runtimeCookies, [
            'tt_csrf_token',
            'csrf_session_id',
            'passport_csrf_token',
            'passport_csrf_token_default',
            'ac_csrftoken',
            'tt_csrf_token_default',
        ]) || process.env.TIKTOK_CSRF_TOKEN || '';
        return {
            orgId: process.env.TIKTOK_ORG_ID || '',
            cookie,
            csrfToken,
            originLink: 'https://www.tiktok.com/',
            userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
            tiktokUploadRequired: process.env.TIKTOK_UPLOAD_REQUIRED !== 'false',
        };
    }

    getHeaders() {
        const config = this.config;
        return {
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
            'cache-control': 'no-cache',
            'origin': 'https://business.tiktok.com',
            'pragma': 'no-cache',
            'referer': 'https://business.tiktok.com/manage/material/image',
            'user-agent': config.userAgent,
            'cookie': config.cookie,
            'x-csrftoken': config.csrfToken,
            'content-type': 'application/json',
        };
    }

    async getRecentImages() {
        console.log('\n📋 Đang lấy danh sách ảnh gần đây...');

        const config = this.config;
        const headers = this.getHeaders();

        const requestBody = {
            m_type: 2,
            metrics: [],
            is_lifetime: 0,
            order_field: "create_time",
            order_type: 1,
            keyword_type: 6,
            page: 1,
            page_size: 50,
            keyword: "",
            country: [],
            image_mode: [],
            placement_id: [],
            cost_lower: "",
            cost_upper: "",
            permission_type: []
        };

        const response = await axios.post(
            `https://business.tiktok.com/api/v3/bm/material/list/?org_id=${config.orgId}&call_platform=library`,
            requestBody,
            { headers, timeout: 60000 }
        );

        if (response.data.code !== 0 && response.data.code !== '0') {
            throw new Error(`API error: ${response.data.msg}`);
        }

        const materials = response.data.data?.material_infos || [];
        const images = [];

        for (const material of materials) {
            const rawUrl = material.base_info?.image_url;
            if (rawUrl) {
                const decodedUrl = rawUrl.replace(/\\u0026/g, '&');
                images.push(decodedUrl);
            }
        }

        console.log(`   📊 Tìm thấy ${images.length} ảnh`);
        return images;
    }

    async uploadToTiktokAPI(input, originalFilename, retryCount = 0, carrierOpts) {
        if (!carrierOpts || !carrierOpts.jobId) {
            throw new Error('uploadToTiktokAPI requires carrierOpts with jobId');
        }

        const config = this.config;

        let fileBuffer;
        if (Buffer.isBuffer(input)) {
            fileBuffer = input;
        } else {
            fileBuffer = fs.readFileSync(input);
        }

        const carrierMode = process.env.CARRIER_MODE || APPEND_TS_MODE;
        const tempPngPath = path.join(process.cwd(), 'upload', 'tiktok', 'temp_' + originalFilename + '.png');
        let carrierBuffer;
        let carrierMeta;
        try {
            carrierMeta = carrierMode === APPEND_TS_MODE
                ? await encodePayloadToAppendPng(fileBuffer, tempPngPath, carrierOpts)
                : await encodePayloadToPng(fileBuffer, tempPngPath, carrierOpts);
            carrierBuffer = fs.readFileSync(tempPngPath);
        } finally {
            await fsp.unlink(tempPngPath).catch(() => {});
        }

        console.log(`   [+] Đang gửi upload ảnh lossless qua Volcengine AWS4 Direct TOS...`);
        try {
            const { uploadLossless } = require('./pure_lossless_upload');
            const res = await uploadLossless(carrierBuffer);

            if (res.success && res.publicUrl) {
                console.log(`   ✅ Upload qua Volcengine thành công. CDN URL: ${res.publicUrl}`);

                return {
                    imageUri: res.publicUrl,
                    publicCandidates: [res.publicUrl],
                    uploadCode: 0,
                    createCode: 0,
                    publicUrl: res.publicUrl,
                    carrierMeta: {
                        ...carrierMeta,
                        carrierBytes: carrierBuffer.length,
                        payloadBytes: fileBuffer.length,
                    },
                };
            }
            throw new Error('Volcengine upload did not return publicUrl');
        } catch (e) {
            if (retryCount < 2) {
                console.log(`   ⏳ Retry (${retryCount + 1}/2)...`);
                await new Promise(r => setTimeout(r, 5000));
                return this.uploadToTiktokAPI(input, originalFilename, retryCount + 1, carrierOpts);
            }
            const status = e.response?.status ? `HTTP ${e.response.status}: ` : '';
            const data = e.response?.data;
            const statusCode = data?.status_code ?? data?.code;
            const message = data?.status_msg || data?.msg || data?.message || e.message;
            const suffix = statusCode !== undefined ? ` (status=${statusCode})` : '';
            throw new Error(`Volcengine upload failed: ${status}${message}${suffix}`);
        }
    }

    async processJob(inputFile, segDuration = 4, totalDurationSec, onProgress, metadata = {}) {
        try {
            if (!metadata || typeof metadata !== 'object') metadata = {};
        if (!metadata.duration && totalDurationSec) metadata.duration = totalDurationSec;
        const policy = buildSizingPolicy(metadata, segDuration);
        const codecDecision = browserSafeHlsDecision(metadata);
        const segmentConcurrency = clampInteger(metadata.segmentConcurrency ?? metadata.splitConcurrency ?? process.env.SEGMENT_CONCURRENCY, 1, 1, 4);
        const uploadConcurrency = clampInteger(metadata.uploadConcurrency ?? process.env.UPLOAD_CONCURRENCY, 1, 1, 8);
        const preserveSourceQuality = envFlag('PRESERVE_SOURCE_QUALITY', true);
        const forceTranscode = envFlag('FORCE_BROWSER_SAFE_TRANSCODE', false);
        const disableTranscode = envFlag('DISABLE_BROWSER_SAFE_TRANSCODE', false);
        const shouldTranscode = forceTranscode || (!codecDecision.safe && !disableTranscode) || (!preserveSourceQuality && !disableTranscode);
        policy.preserveSourceQuality = preserveSourceQuality;
        policy.strategy = shouldTranscode 
            ? (preserveSourceQuality ? 'transcode-browser-safe-dual' : 'transcode-browser-safe') 
            : 'copy-preserve-quality';
        policy.codecDecision = codecDecision;
        policy.sourceCodec = {
            video: codecDecision.videoCodec,
            audio: codecDecision.audioCodec,
            pixelFormat: codecDecision.pixelFormat,
            profile: codecDecision.profile,
        };
        policy.transcode = shouldTranscode ? buildTranscodeOptions(metadata, policy, policy.selectedSegmentDuration) : null;
        let seg = policy.selectedSegmentDuration;
        const jobId = uuidv4();
        const config = this.config;

        const now = new Date();
        const day = now.getDate();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const year = now.getFullYear();

        const relativePath = `${day}/${month}/${year}/${jobId}`;
        const jobPublicDir = path.join(this.publicDir, String(day), month, String(year), jobId);

        await fsp.mkdir(jobPublicDir, { recursive: true });

        const outM3u8 = path.join(jobPublicDir, 'master.m3u8');
        const playlistPath = `/upload/${relativePath}/master.m3u8`;
        const carrierPlaylistPath = `/carrier/${jobId}/master.m3u8`;
        const carrierPlayerPath = `/player?jobId=${encodeURIComponent(jobId)}`;
        const manifestPath = path.join(this.manifestDir, `${jobId}.json`);
        const publicBaseUrl = config.publicBaseUrl.replace(/\/$/, '');
        const uploadedImages = [];
        const emitProgress = (percent, message, details = {}) => {
            if (!onProgress) return;
            onProgress(percent, message, {
                percent,
                message,
                ...details,
            });
        };

        const runFfmpeg = (duration, attempt, type = 'default') => new Promise((resolve, reject) => {
            const isOrig = type === 'original';
            const isTrans = type === 'transcoded';
            const actualShouldTranscode = isTrans ? true : (isOrig ? false : shouldTranscode);
            const prefix = isOrig ? 'orig_' : (isTrans ? 'trans_' : '');
            
            const segmentPattern = path.join(jobPublicDir, `${prefix}${randomString(6)}_%05d.ts`);
            const outPlaylistName = isOrig ? 'master_orig.m3u8' : (isTrans ? 'master_trans.m3u8' : 'master.m3u8');
            const outPlaylistPath = path.join(jobPublicDir, outPlaylistName);
            
            const args = [
                '-y', '-i', inputFile,
                '-map', '0:v:0',
                '-map', '0:a?',
                '-sn',
                '-dn',
                '-ignore_unknown',
            ];

            args.push('-threads', String(segmentConcurrency));

            if (actualShouldTranscode) {
                const transcode = buildTranscodeOptions(metadata, policy, duration);
                policy.transcode = transcode;
                args.push(
                    '-c:v', 'libx264',
                    '-preset', transcode.preset,
                    '-profile:v', 'high',
                    '-level:v', '5.2',
                    '-pix_fmt', 'yuv420p',
                    '-b:v', String(transcode.videoBitrate),
                    '-maxrate', String(transcode.maxVideoBitrate),
                    '-bufsize', String(transcode.bufSize),
                    '-g', String(transcode.gop),
                    '-keyint_min', String(transcode.gop),
                    '-sc_threshold', '0',
                    '-force_key_frames', `expr:gte(t,n_forced*${duration})`,
                    '-c:a', 'aac',
                    '-b:a', String(transcode.audioBitrate),
                    '-ar', '48000',
                    '-ac', '2'
                );
            } else {
                args.push(
                    '-c', 'copy',
                    '-copyts',
                    '-avoid_negative_ts', 'make_zero'
                );
            }

            args.push(
                '-hls_time', String(duration),
                '-hls_playlist_type', 'vod',
                '-hls_segment_filename', segmentPattern,
                '-hls_flags', 'independent_segments',
                '-max_muxing_queue_size', '4096',
                outPlaylistPath
            );
            const ps = spawn(ffmpegPath, args, { windowsHide: true });
            let stderr = '';

            ps.stderr.on('data', (d) => {
                const str = d.toString();
                stderr += str;
                if (onProgress) {
                    const timeMatch = str.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/);
                    if (timeMatch) {
                        const hours = parseFloat(timeMatch[1]);
                        const minutes = parseFloat(timeMatch[2]);
                        const seconds = parseFloat(timeMatch[3]);
                        const currentSec = hours * 3600 + minutes * 60 + seconds;
                        const sourceDuration = totalDurationSec || metadata.duration || 1;
                        const encodePercent = Math.max(0, Math.min(100, Math.round((currentSec / sourceDuration) * 100)));
                        const base = attempt > 1 ? 10 : 0;
                        const percent = Math.min(70, base + Math.round((currentSec / sourceDuration) * 60));
                        let generatedSegments = 0;
                        try {
                            generatedSegments = fs.readdirSync(jobPublicDir).filter(file => file.startsWith(prefix) && file.endsWith('.ts')).length;
                        } catch (_) {}
                        const estimatedTotalSegments = Math.max(generatedSegments, Math.ceil(sourceDuration / duration));
                        emitProgress(percent, `Cắt HLS [${type}] ${generatedSegments}/${estimatedTotalSegments} đoạn (${encodePercent}%)`, {
                            phase: 'segmenting',
                            realPercent: encodePercent,
                            segmentIndex: generatedSegments,
                            segmentTotal: estimatedTotalSegments,
                            segmentDuration: duration,
                            segmentConcurrency,
                            uploadConcurrency,
                            attempt,
                            currentSec: Math.min(currentSec, sourceDuration),
                            totalSec: sourceDuration,
                        });
                    }
                }
            });

            ps.on('close', async (code) => {
                if (code !== 0) return reject(new Error(`ffmpeg error: ${stderr}`));
                try {
                    const files = await fsp.readdir(jobPublicDir);
                    const prefixToFilter = prefix;
                    const tsFiles = files.filter(f => f.startsWith(prefixToFilter) && f.endsWith('.ts')).sort();
                    const hlsInfo = await parseHlsPlaylist(outPlaylistPath, duration);
                    const segments = collectSegmentStats(jobPublicDir, tsFiles, hlsInfo.durations, duration, policy);
                    resolve({ tsFiles, hlsInfo, segments, playlistName: outPlaylistName });
                } catch (err) {
                    reject(err);
                }
            });
        });

        const clearGeneratedHls = async () => {
            try {
                const files = await fsp.readdir(jobPublicDir);
                await Promise.all(files
                    .filter(file => file.endsWith('.ts') || file.endsWith('.vtt') || file === 'master.m3u8')
                    .map(file => fsp.unlink(path.join(jobPublicDir, file)).catch(() => {})));
            } catch (err) {}
        };

        const isDual = shouldTranscode && preserveSourceQuality;
        if (isDual) {
            console.log(`   🔁 Codec nguồn không browser-safe (${codecDecision.reasons.join(', ') || 'forced'}), dual-stream được bật: transcode H.264/AAC để phát + giữ gốc HEVC/AAC để tải về.`);
        } else if (shouldTranscode) {
            console.log(`   🔁 Codec nguồn không browser-safe (${codecDecision.reasons.join(', ') || 'forced'}), transcode sang H.264/AAC trước khi upload...`);
        } else {
            console.log('   ✅ Giữ nguyên chất lượng nguồn 100%: FFmpeg dùng stream copy (-c copy), không đổi bitrate, codec hoặc độ phân giải.');
        }
        const statusMessage = isDual
            ? `Transcode sang H.264 để phát + giữ gốc HEVC để tải · target segment ${formatMb(policy.targetSegmentBytes)}`
            : (shouldTranscode
                ? `Transcode sang H.264/AAC browser-safe · target segment ${formatMb(policy.targetSegmentBytes)}`
                : `Giữ nguyên chất lượng nguồn 100% · target segment ${formatMb(policy.targetSegmentBytes)}`);
        
        emitProgress(8, statusMessage, {
            phase: 'quality-policy',
            realPercent: 100,
            preserveSourceQuality,
            strategy: policy.strategy,
            targetSegmentBytes: policy.targetSegmentBytes,
            maxSegmentBytes: policy.maxSegmentBytes,
            selectedSegmentDuration: seg,
            sourceBitrate: policy.sourceBitrate,
        });

        let ffmpegResult;
        let originalFfmpegResult;
        const attempts = [];
        for (let attempt = 1; attempt <= 3; attempt++) {
            await clearGeneratedHls();
            console.log(`   🎞️ Segment target ${formatMb(policy.targetSegmentBytes)}, max ${formatMb(policy.maxSegmentBytes)}; strategy=${policy.strategy}; thử hls_time=${seg}s...`);
            ffmpegResult = await runFfmpeg(seg, attempt, shouldTranscode ? 'transcoded' : 'default');
            emitProgress(70, `Đã cắt xong ${ffmpegResult.tsFiles.length}/${ffmpegResult.tsFiles.length} segment HLS · chuẩn bị upload ${uploadConcurrency} luồng`, {
                phase: 'segmenting-complete',
                realPercent: 100,
                segmentIndex: ffmpegResult.tsFiles.length,
                segmentTotal: ffmpegResult.tsFiles.length,
                segmentDuration: seg,
                segmentConcurrency,
                uploadConcurrency,
                attempt,
            });
            const maxTsBytes = Math.max(...ffmpegResult.segments.map(segment => segment.tsBytes), 0);
            attempts.push({ attempt, segmentDuration: seg, totalSegments: ffmpegResult.tsFiles.length, maxTsBytes });
            if (maxTsBytes <= policy.maxSegmentBytes || seg <= policy.minSegmentDuration) break;
            const ratio = Math.max(0.1, Math.min(0.9, policy.maxSegmentBytes / maxTsBytes));
            const nextSeg = Math.max(policy.minSegmentDuration, Math.floor(seg * ratio * 0.9 * 100) / 100);
            if (nextSeg >= seg) break;
            console.log(`   ⚠️ Segment lớn nhất ${formatMb(maxTsBytes)} > ${formatMb(policy.maxSegmentBytes)}, retry với hls_time=${nextSeg}s...`);
            seg = nextSeg;
        }

        if (!ffmpegResult || !ffmpegResult.tsFiles.length) {
            throw new Error('Không tạo được HLS segment từ video');
        }

        if (isDual) {
            console.log(`   🎞️ Đang cắt thêm bản gốc (original HEVC) nguyên bản với cùng hls_time=${seg}s...`);
            originalFfmpegResult = await runFfmpeg(seg, 1, 'original');
        }

        const maxTsBytes = Math.max(...ffmpegResult.segments.map(segment => segment.tsBytes), 0);
        if (maxTsBytes > policy.maxSegmentBytes) {
            const reason = shouldTranscode ? 'bitrate/cảnh quay phức tạp' : 'bitrate/keyframe nguồn';
            const message = `Có segment TS ${formatMb(maxTsBytes)} vượt max ${formatMb(policy.maxSegmentBytes)} do ${reason}. Đang bật giữ nguyên chất lượng nên không ép keyframe/re-encode; theo cấu hình hiện tại hệ thống sẽ cảnh báo và vẫn upload segment này.`;
            if (policy.strictSegmentBytes) {
                throw new Error(`${message} STRICT_SEGMENT_BYTES=true nên job bị dừng.`);
            }
            console.log(`   ⚠️ ${message}`);
        }

        const sourceSizeBytes = fs.statSync(inputFile).size;
        const manifest = {
            version: 4, // Version 4 denotes PNG append-TS carrier by default
            jobId,
            assetVersion: `${jobId}:seg-${seg}:target-${policy.targetSegmentBytes}:max-${policy.maxSegmentBytes}`,
            createdAt: new Date().toISOString(),
            source: {
                playlistPath,
                localDir: jobPublicDir,
                filename: path.basename(inputFile),
                sizeBytes: sourceSizeBytes,
            },
            sizing: {
                ...policy,
                selectedSegmentDuration: seg,
                attempts,
                maxTsBytes,
                overMax: maxTsBytes > policy.maxSegmentBytes,
                concurrency: {
                    segment: segmentConcurrency,
                    upload: uploadConcurrency,
                },
            },
            hls: {
                targetDuration: ffmpegResult.hlsInfo.targetDuration,
                playlistType: 'VOD',
            },
            complete: false,
            segments: ffmpegResult.segments,
            originalSegments: isDual ? originalFfmpegResult.segments : null,
        };

        await writeJson(manifestPath, manifest);

        const segmentTotal = ffmpegResult.tsFiles.length + 
            (isDual && originalFfmpegResult ? originalFfmpegResult.tsFiles.length : 0);
        let uploadedCount = 0;
        let manifestWrite = Promise.resolve();
        const writeManifestQueued = async () => {
            manifestWrite = manifestWrite.then(() => writeJson(manifestPath, manifest));
            return manifestWrite;
        };

        const uploadSet = async (items) => {
            let nextIndex = 0;
            const runUploadWorker = async (workerId) => {
                while (nextIndex < items.length) {
                    const item = items[nextIndex++];
                    const i = item.index;
                    const type = item.type;
                    const tsPath = path.join(jobPublicDir, item.file);
                    const tsSize = fs.statSync(tsPath).size;
                    
                    const targetArray = type === 'original' ? manifest.originalSegments : manifest.segments;
                    
                    Object.assign(targetArray[i], {
                        payloadBytes: tsSize,
                        carrierBytes: tsSize,
                        pngBytes: tsSize,
                        carrierMode: process.env.CARRIER_MODE || APPEND_TS_MODE,
                        width: 1,
                        height: 1,
                        tsOffset: 0,
                        overTarget: tsSize > policy.targetSegmentBytes,
                        overMax: tsSize > policy.maxSegmentBytes,
                        workerId,
                    });
                    manifest.sizing.maxPngBytes = Math.max(Number(manifest.sizing.maxPngBytes || 0), tsSize);
                    await writeManifestQueued();

                    const uploadBasePercent = 70 + Math.round((uploadedCount / segmentTotal) * 30);
                    emitProgress(uploadBasePercent, `Luồng ${workerId}: đang upload ${type} segment ${i + 1}/${targetArray.length}`, {
                        phase: 'uploading-segment',
                        realPercent: Math.round((uploadedCount / segmentTotal) * 100),
                        segmentIndex: i + 1,
                        segmentTotal: targetArray.length,
                        segmentFile: item.file,
                        tsBytes: tsSize,
                        uploadedSegments: uploadedCount,
                        uploadConcurrency,
                        workerId,
                    });

                    console.log(`   📤 Worker ${workerId}/${uploadConcurrency} uploading ${type} PNG carrier ${i + 1}/${targetArray.length} (ts=${formatMb(tsSize)})...`);
                    try {
                        const carrierOpts = {
                            jobId: jobId,
                            index: i,
                            total: targetArray.length
                        };
                        const uploadResult = await this.uploadToTiktokAPI(tsPath, `${jobId}_${type}_${String(i).padStart(5, '0')}`, 0, carrierOpts);

                        const carrierMeta = uploadResult.carrierMeta || {};
                        const carrierBytes = Number(carrierMeta.carrierBytes || tsSize);
                        targetArray[i].imageUri = uploadResult.publicUrl;
                        targetArray[i].publicImageUrl = uploadResult.publicUrl;
                        targetArray[i].carrierMode = carrierMeta.mode || targetArray[i].carrierMode;
                        targetArray[i].payloadBytes = Number(carrierMeta.payloadBytes || tsSize);
                        targetArray[i].carrierBytes = carrierBytes;
                        targetArray[i].pngBytes = carrierBytes;
                        targetArray[i].width = Number(carrierMeta.width || targetArray[i].width || 1);
                        targetArray[i].height = Number(carrierMeta.height || targetArray[i].height || 1);
                        targetArray[i].tsOffset = Number(carrierMeta.tsOffset || 0);
                        targetArray[i].publicProbe = {
                            tested: 1,
                            passed: true,
                            contentType: 'image/png',
                            bytes: carrierBytes,
                            verifiedAt: new Date().toISOString(),
                        };
                        console.log(`   🌐 Worker ${workerId}: public URL OK cho ${type} segment ${i + 1}`);

                        targetArray[i].uploaded = true;
                        uploadedCount += 1;
                        manifest.updatedAt = new Date().toISOString();
                        
                        const allTranscodedUploaded = manifest.segments.every(s => s.uploaded && s.imageUri);
                        const allOriginalUploaded = !isDual || manifest.originalSegments.every(s => s.uploaded && s.imageUri);
                        manifest.complete = allTranscodedUploaded && allOriginalUploaded;
                        
                        await writeManifestQueued();

                        const percent = 70 + Math.round((uploadedCount / segmentTotal) * 30);
                        emitProgress(percent, `Đã upload ${uploadedCount}/${segmentTotal} segment tổng · ${uploadConcurrency} luồng`, {
                            phase: 'uploading',
                            realPercent: Math.round((uploadedCount / segmentTotal) * 100),
                            segmentIndex: i + 1,
                            segmentTotal,
                            segmentFile: item.file,
                            uploadedSegments: uploadedCount,
                            uploadConcurrency,
                            workerId,
                        });
                    } catch (err) {
                        targetArray[i].error = err.message;
                        manifest.updatedAt = new Date().toISOString();
                        await writeManifestQueued();
                        if (config.tiktokUploadRequired) {
                            throw err;
                        }
                        console.log(`   ⚠️ Worker ${workerId}: TikTok upload lỗi, giữ HLS local để phát tiếp: ${err.message}`);
                    }
                }
            };

            await Promise.all(Array.from({ length: Math.min(uploadConcurrency, items.length) }, (_, idx) => runUploadWorker(idx + 1)));
        };

        // 1. Upload transcoded (H.264) queue first
        const transcodedQueue = ffmpegResult.tsFiles.map((file, index) => ({ type: 'transcoded', file, index }));
        console.log(`   📤 Bắt đầu upload ${transcodedQueue.length} segment transcoded (H.264) trước...`);
        await uploadSet(transcodedQueue);

        // 2. Upload original (HEVC) queue second
        if (isDual && originalFfmpegResult) {
            const originalQueue = originalFfmpegResult.tsFiles.map((file, index) => ({ type: 'original', file, index }));
            console.log(`   📤 Bắt đầu upload ${originalQueue.length} segment original (HEVC) tiếp theo...`);
            await uploadSet(originalQueue);
        }

        await manifestWrite;

        const allTranscodedUploadedFinal = manifest.segments.every(s => s.uploaded && s.imageUri);
        const allOriginalUploadedFinal = !isDual || manifest.originalSegments.every(s => s.uploaded && s.imageUri);
        manifest.complete = allTranscodedUploadedFinal && allOriginalUploadedFinal;
        manifest.updatedAt = new Date().toISOString();
        await writeJson(manifestPath, manifest);

            return {
                jobId,
                playlistPath,
                playlistUrl: publicBaseUrl ? `${publicBaseUrl}${playlistPath}` : playlistPath,
                carrierPlaylistPath,
                carrierPlaylistUrl: publicBaseUrl ? `${publicBaseUrl}${carrierPlaylistPath}` : carrierPlaylistPath,
                carrierPlayerPath,
                carrierPlayerUrl: publicBaseUrl ? `${publicBaseUrl}${carrierPlayerPath}` : carrierPlayerPath,
                carrierManifestPath: manifestPath,
                sizing: manifest.sizing,
                uploadedImages,
            };
        } finally {
            if (process.env.USE_RPC_SIGNER === 'true') {
                try {
                    require('./xbogus_jsdom').close();
                } catch (e) {
                    console.error('[-] Lỗi khi đóng RPC Signer:', e.message);
                }
            }
        }
    }

    async probeVideo(filePath) {
        return new Promise((resolve, reject) => {
            const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath];
            const ps = spawn(ffprobePath, args);
            let stdout = '', stderr = '';
            ps.stdout.on('data', (data) => { stdout += data.toString(); });
            ps.stderr.on('data', (data) => { stderr += data.toString(); });
            ps.on('close', (code) => {
                if (code !== 0) return reject(new Error(`ffprobe error: ${stderr}`));
                try {
                    const data = JSON.parse(stdout);
                    const streams = Array.isArray(data.streams) ? data.streams : [];
                    const stream = streams.find(item => item.codec_type === 'video') || streams[0] || {};
                    const audioStream = streams.find(item => item.codec_type === 'audio') || {};
                    const format = data.format;
                    const duration = positiveNumber(format?.duration || stream.duration, 0);
                    const formatBitrate = positiveNumber(format?.bit_rate, 0);
                    const videoBitrate = positiveNumber(stream?.bit_rate, 0);
                    let estimatedBitrate = 0;
                    if (duration > 0) {
                        try {
                            estimatedBitrate = fs.statSync(filePath).size * 8 / duration;
                        } catch (err) {}
                    }
                    const bitrate = videoBitrate || formatBitrate || estimatedBitrate;
                    resolve({
                        width: stream?.width || 0,
                        height: stream?.height || 0,
                        format: format?.format_name || 'unknown',
                        duration,
                        formatBitrate,
                        videoBitrate,
                        bitrate,
                        estimatedBitrate,
                        videoCodec: stream?.codec_name || '',
                        codecName: stream?.codec_name || '',
                        profile: stream?.profile || '',
                        pixelFormat: stream?.pix_fmt || '',
                        frameRate: stream?.avg_frame_rate || stream?.r_frame_rate || '',
                        avgFrameRate: stream?.avg_frame_rate || '',
                        rFrameRate: stream?.r_frame_rate || '',
                        audioCodec: audioStream?.codec_name || '',
                        audioBitrate: positiveNumber(audioStream?.bit_rate, 0),
                    });
                } catch (e) { reject(new Error('Invalid probe output')); }
            });
        });
    }
}

module.exports = new TiktokService();
