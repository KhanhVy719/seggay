// tiktok.js
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
    const minDuration = Math.max(1, positiveNumber(process.env.SEGMENT_MIN_SECONDS, 1));
    const maxDuration = Math.max(minDuration, positiveNumber(process.env.SEGMENT_MAX_SECONDS, 10));
    const fallbackDuration = Math.max(minDuration, Math.min(maxDuration, positiveNumber(requestedSegDuration, 3)));
    const bitrate = positiveNumber(metadata.bitrate || metadata.videoBitrate || metadata.formatBitrate, 0);
    const targetBytes = mbToBytes(targetMb);
    const maxBytes = mbToBytes(maxMb);

    let selectedSegmentDuration = fallbackDuration;
    if (bitrate > 0) {
        selectedSegmentDuration = targetBytes * 8 / bitrate;
    }
    selectedSegmentDuration = Math.max(minDuration, Math.min(maxDuration, selectedSegmentDuration));
    selectedSegmentDuration = Math.max(0.5, Math.round(selectedSegmentDuration * 100) / 100);

    return {
        targetSegmentBytes: targetBytes,
        maxSegmentBytes: maxBytes,
        targetSegmentMb: targetMb,
        maxSegmentMb: maxMb,
        minSegmentDuration: minDuration,
        maxSegmentDuration: maxDuration,
        selectedSegmentDuration,
        sourceBitrate: bitrate || null,
        strategy: 'copy-adaptive',
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
    const decoded = await decodePngCarrierBuffer(Buffer.from(response.data));
    if (decoded.jobId !== expected.jobId || decoded.index !== expected.index || decoded.total !== expected.total) {
        throw new Error(`Carrier metadata mismatch (${decoded.jobId}/${decoded.index}/${decoded.total})`);
    }
    return {
        url,
        payloadLength: decoded.payloadLength,
        contentType: response.headers['content-type'] || 'image/png',
        bytes: Buffer.byteLength(response.data),
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
        return {
            orgId: process.env.TIKTOK_ORG_ID || '',
            cookie: process.env.TIKTOK_COOKIE || '',
            csrfToken: process.env.TIKTOK_CSRF_TOKEN || '',
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

        const formData = new FormData();
        const config = this.config;

        let fileBuffer;
        if (Buffer.isBuffer(input)) {
            fileBuffer = input;
        } else {
            fileBuffer = fs.readFileSync(input);
        }

        const { encodePayloadToPng } = require('./carrier');
        const tempPngPath = path.join(process.cwd(), 'upload', 'tiktok', 'temp_' + originalFilename + '.png');
        let carrierBuffer;
        try {
            await encodePayloadToPng(fileBuffer, tempPngPath, carrierOpts);
            carrierBuffer = fs.readFileSync(tempPngPath);
        } finally {
            await fsp.unlink(tempPngPath).catch(() => {});
        }

        formData.append('file', carrierBuffer, {
            filename: originalFilename + '.png',
            contentType: 'image/png'
        });

        // PNG carrier path only; no JPEG fallback.

        // Extract tt-csrf-token and other identifiers from cookie
        let csrfToken = config.csrfToken;
        let verifyFp = '';
        let deviceId = '7630409900435375636';
        if (config.cookie) {
            const csrfMatch = config.cookie.match(/tt_csrf_token=([^;]+)/);
            if (csrfMatch && !csrfToken) csrfToken = csrfMatch[1];
            
            const verifyFpMatch = config.cookie.match(/s_v_web_id=([^;]+)/);
            if (verifyFpMatch) verifyFp = verifyFpMatch[1];
            
            const ttwidMatch = config.cookie.match(/ttwid=([^;]+)/);
            if (ttwidMatch) {
                // simple hash to generate a pseudo device_id if needed, but hardcoded usually works
                // we'll stick to a fallback if verifyFp is missing
            }
        }

        const urlParams = new URLSearchParams({
            aid: '1988',
            app_name: 'tiktok_web',
            device_platform: 'web_pc',
            user_is_login: 'true',
        });
        if (verifyFp) urlParams.append('verifyFp', verifyFp);

        const query = urlParams.toString();
        let bogus = '';
        const useRpc = process.env.USE_RPC_SIGNER === 'true';

        if (useRpc) {
            try {
                const rpcSigner = require('./xbogus_jsdom');
                const signUa = config.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
                bogus = await rpcSigner.sign(query, signUa);
                if (!bogus) {
                    throw new Error('RPC Signer returned empty/null signature');
                }
            } catch (rpcErr) {
                console.log(`   ⚠️ Lỗi RPC Signer (${rpcErr.message}). Tự động fallback về xbogus local...`);
                const generate_bogus = require('xbogus');
                bogus = generate_bogus(query, config.userAgent);
            }
        } else {
            const generate_bogus = require('xbogus');
            bogus = generate_bogus(query, config.userAgent);
        }

        const url = 'https://www.tiktok.com/api/upload/image/?' + query + '&X-Bogus=' + bogus;
        
        const headers = {
            ...formData.getHeaders(),
            'accept': '*/*',
            'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
            'origin': 'https://www.tiktok.com',
            'referer': 'https://www.tiktok.com/',
            'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", ";Not A Brand";v="99"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'tt-csrf-token': csrfToken || 'FoDFiDrG-tO4664D8s9d-iNepMRIK1V3JaYI',
            'user-agent': config.userAgent,
            'cookie': config.cookie,
        };

        try {
            const uploadRes = await axios.post(url, formData, {
                headers,
                maxBodyLength: Infinity,
                timeout: 120000
            });

            if (uploadRes.data?.data?.url_list && uploadRes.data?.data?.url_list.length > 0) {
                const signedUrl = uploadRes.data.data.url_list[0];
                
                // Convert to Public URL
                const urlObj = new URL(signedUrl);
                urlObj.search = '';
                let pathname = urlObj.pathname;
                if (pathname.includes('~')) {
                    pathname = pathname.substring(0, pathname.indexOf('~'));
                }
                if (!pathname.startsWith('/obj/')) {
                    pathname = '/obj/' + pathname.replace(/^\//, '');
                }
                urlObj.host = 'p16-va.tiktokcdn.com';
                urlObj.pathname = pathname;
                const publicUrl = urlObj.toString();

                return {
                    imageUri: publicUrl,
                    publicCandidates: [publicUrl],
                    uploadCode: 0,
                    createCode: 0,
                    publicUrl: publicUrl
                };
            }
            throw new Error(`Upload failed, no url_list returned: ${JSON.stringify(uploadRes.data)}`);
        } catch (e) {
            if (retryCount < 2) {
                console.log(`   ⏳ Retry (${retryCount + 1}/2)...`);
                await new Promise(r => setTimeout(r, 5000));
                return this.uploadToTiktokAPI(input, originalFilename, retryCount + 1, carrierOpts);
            }
            throw new Error(`Upload failed: ${e.message}`);
        }
    }

    async processJob(inputFile, segDuration = 4, totalDurationSec, onProgress, metadata = {}) {
        try {
            if (!metadata || typeof metadata !== 'object') metadata = {};
        if (!metadata.duration && totalDurationSec) metadata.duration = totalDurationSec;
        const policy = buildSizingPolicy(metadata, segDuration);
        const codecDecision = browserSafeHlsDecision(metadata);
        const forceTranscode = envFlag('FORCE_BROWSER_SAFE_TRANSCODE', false);
        const disableTranscode = envFlag('DISABLE_BROWSER_SAFE_TRANSCODE', false);
        const shouldTranscode = !disableTranscode && (forceTranscode || !codecDecision.safe);
        policy.strategy = shouldTranscode ? 'transcode-browser-safe' : 'copy-adaptive';
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

        const runFfmpeg = (duration, attempt) => new Promise((resolve, reject) => {
            const segmentPattern = path.join(jobPublicDir, `${randomString(8)}_%05d.ts`);
            const args = [
                '-y', '-i', inputFile,
                '-map', '0:v:0',
                '-map', '0:a?',
                '-sn',
                '-dn',
                '-ignore_unknown',
            ];

            if (shouldTranscode) {
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
                args.push('-c', 'copy');
            }

            args.push(
                '-hls_time', String(duration),
                '-hls_playlist_type', 'vod',
                '-hls_segment_filename', segmentPattern,
                '-hls_flags', 'independent_segments',
                outM3u8
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
                        const base = attempt > 1 ? 10 : 0;
                        const percent = Math.min(70, base + Math.round((currentSec / (totalDurationSec || metadata.duration || 1)) * 60));
                        onProgress(percent, `Encoding ${duration}s segments... ${percent}%`);
                    }
                }
            });

            ps.on('close', async (code) => {
                if (code !== 0) return reject(new Error(`ffmpeg error: ${stderr}`));
                try {
                    const files = await fsp.readdir(jobPublicDir);
                    const tsFiles = files.filter(f => f.endsWith('.ts')).sort();
                    const hlsInfo = await parseHlsPlaylist(outM3u8, duration);
                    const segments = collectSegmentStats(jobPublicDir, tsFiles, hlsInfo.durations, duration, policy);
                    resolve({ tsFiles, hlsInfo, segments });
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

        if (shouldTranscode) {
            console.log(`   🔁 Codec nguồn không browser-safe (${codecDecision.reasons.join(', ') || 'forced'}), transcode sang H.264/AAC trước khi upload...`);
        }

        let ffmpegResult;
        const attempts = [];
        for (let attempt = 1; attempt <= 3; attempt++) {
            await clearGeneratedHls();
            console.log(`   🎞️ Segment target ${formatMb(policy.targetSegmentBytes)}, max ${formatMb(policy.maxSegmentBytes)}; strategy=${policy.strategy}; thử hls_time=${seg}s...`);
            ffmpegResult = await runFfmpeg(seg, attempt);
            const maxTsBytes = Math.max(...ffmpegResult.segments.map(segment => segment.tsBytes), 0);
            attempts.push({ attempt, segmentDuration: seg, totalSegments: ffmpegResult.tsFiles.length, maxTsBytes });
            if (maxTsBytes <= policy.maxSegmentBytes || seg <= policy.minSegmentDuration) break;
            const nextSeg = Math.max(policy.minSegmentDuration, Math.floor(seg * 0.65 * 100) / 100);
            if (nextSeg >= seg) break;
            console.log(`   ⚠️ Segment lớn nhất ${formatMb(maxTsBytes)} > ${formatMb(policy.maxSegmentBytes)}, retry với hls_time=${nextSeg}s...`);
            seg = nextSeg;
        }

        if (!ffmpegResult || !ffmpegResult.tsFiles.length) {
            throw new Error('Không tạo được HLS segment từ video');
        }

        const maxTsBytes = Math.max(...ffmpegResult.segments.map(segment => segment.tsBytes), 0);
        if (maxTsBytes > policy.maxSegmentBytes) {
            const reason = shouldTranscode ? 'bitrate/cảnh quay phức tạp' : 'bitrate/keyframe nguồn';
            console.log(`   ⚠️ Có segment TS ${formatMb(maxTsBytes)} vượt max ${formatMb(policy.maxSegmentBytes)} do ${reason}; vẫn tiếp tục và ghi cảnh báo vào manifest.`);
        }

        const manifest = {
            version: 3, // Version 3 denotes PNG Pixel Carrier
            jobId,
            assetVersion: `${jobId}:seg-${seg}:target-${policy.targetSegmentBytes}:max-${policy.maxSegmentBytes}`,
            createdAt: new Date().toISOString(),
            source: {
                playlistPath,
                localDir: jobPublicDir,
            },
            sizing: {
                ...policy,
                selectedSegmentDuration: seg,
                attempts,
                maxTsBytes,
                overMax: maxTsBytes > policy.maxSegmentBytes,
            },
            hls: {
                targetDuration: ffmpegResult.hlsInfo.targetDuration,
                playlistType: 'VOD',
            },
            complete: false,
            segments: ffmpegResult.segments,
        };

        await writeJson(manifestPath, manifest);

        for (let i = 0; i < ffmpegResult.tsFiles.length; i++) {
            const tsPath = path.join(jobPublicDir, ffmpegResult.tsFiles[i]);
            
            const tsSize = fs.statSync(tsPath).size;
            // PNG carrier header + raw RGB overhead ≈ payload + 1024
            const pngSize = tsSize + 1024;
            
            Object.assign(manifest.segments[i], {
                payloadBytes: tsSize,
                carrierBytes: pngSize,
                pngBytes: pngSize,
                width: 1, // Fake 1x1
                height: 1, // Fake 1x1
                overTarget: tsSize > policy.targetSegmentBytes,
                overMax: tsSize > policy.maxSegmentBytes,
            });
            manifest.sizing.maxPngBytes = Math.max(Number(manifest.sizing.maxPngBytes || 0), pngSize);
            manifest.sizing.overMax = Boolean(manifest.sizing.overMax || manifest.segments[i].overMax);
            await writeJson(manifestPath, manifest);

            console.log(`   📤 Uploading PNG carrier ${i + 1}/${ffmpegResult.tsFiles.length} (ts=${formatMb(tsSize)})...`);
            try {
                const carrierOpts = {
                    jobId: jobId,
                    index: i,
                    total: ffmpegResult.tsFiles.length
                };
                const uploadResult = await this.uploadToTiktokAPI(tsPath, `${jobId}_${String(i).padStart(5, '0')}`, 0, carrierOpts);
                
                manifest.segments[i].imageUri = uploadResult.publicUrl;
                manifest.segments[i].publicImageUrl = uploadResult.publicUrl;
                manifest.segments[i].publicProbe = {
                    tested: 1,
                    passed: true,
                    contentType: 'image/png',
                    bytes: pngSize,
                    verifiedAt: new Date().toISOString(),
                };
                console.log(`   🌐 Public URL OK cho segment ${i + 1}`);

                uploadedImages.push({
                    index: i,
                    file: ffmpegResult.tsFiles[i],
                    imageUri: uploadResult.publicUrl,
                    publicImageUrl: uploadResult.publicUrl,
                    publicProbe: manifest.segments[i].publicProbe,
                    pngBytes: pngSize,
                    tsBytes: manifest.segments[i].tsBytes,
                });
                manifest.segments[i].uploaded = true;
                manifest.updatedAt = new Date().toISOString();
                manifest.complete = manifest.segments.every(segment => segment.uploaded && segment.imageUri);
                await writeJson(manifestPath, manifest);
            } catch (err) {
                manifest.segments[i].error = err.message;
                manifest.updatedAt = new Date().toISOString();
                await writeJson(manifestPath, manifest);
                if (config.tiktokUploadRequired) {
                    throw err;
                }
                console.log(`   ⚠️ TikTok upload lỗi, giữ HLS local để phát tiếp: ${err.message}`);
            }

            if (onProgress) {
                const percent = 70 + Math.round(((i + 1) / ffmpegResult.tsFiles.length) * 30);
                onProgress(percent, `Uploading ${i + 1}/${ffmpegResult.tsFiles.length}`);
            }
        }

        manifest.complete = manifest.segments.every(segment => segment.uploaded && segment.imageUri);
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
