// decoded.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const axios = require('axios');
const { exec } = require('child_process');
const { promisify } = require('util');
const tiktokService = require('./tiktok');
const { decodePngCarrier } = require('./carrier');

const execPromise = promisify(exec);
const args = process.argv.slice(2);
let outputVideo = args[0] || 'video_ghép.mp4';
const requestedJobId = args[1] || process.env.TIKTOK_DECODE_JOB_ID || '';
const MANIFEST_ROOT = path.join(process.cwd(), 'upload', 'tiktok', 'manifests');
const MATERIAL_PAGE_SIZE = 100;
const MATERIAL_MAX_SCAN_PAGES = 10;

function decodeTikTokImageUrl(value) {
    return String(value || '').replace(/\\u0026/g, '&');
}

function imageUriMatches(value, imageUri) {
    value = String(value || '');
    imageUri = String(imageUri || '');
    return value === imageUri || value.includes(imageUri) || imageUri.includes(value);
}

async function downloadFile(url, outputPath, cookie) {
    return new Promise((resolve, reject) => {
        if (!/^https?:\/\//i.test(url)) {
            reject(new Error('URL ảnh không hợp lệ hoặc chưa resolve được'));
            return;
        }
        const protocol = url.startsWith('https') ? https : http;
        const options = {
            headers: {
                'User-Agent': process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Cookie': cookie || '',
            }
        };

        const req = protocol.get(url, options, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                downloadFile(response.headers.location, outputPath, cookie).then(resolve).catch(reject);
                return;
            }
            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }
            const ws = fs.createWriteStream(outputPath);
            let downloaded = 0;
            const total = parseInt(response.headers['content-length'], 10);
            response.on('data', (chunk) => {
                downloaded += chunk.length;
                if (total) {
                    const percent = ((downloaded / total) * 100).toFixed(1);
                    process.stdout.write(`\r      ⏳ Tải: ${(downloaded/1024).toFixed(0)}KB / ${(total/1024).toFixed(0)}KB (${percent}%)`);
                }
            });
            response.pipe(ws);
            ws.on('finish', () => {
                ws.close();
                console.log('');
                resolve(outputPath);
            });
            ws.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(120000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

function pickBestJob(jobs) {
    const complete = [...jobs.values()].filter(job => job.total > 0 && job.parts.size === job.total);
    if (requestedJobId) return jobs.get(requestedJobId);
    if (complete.length > 0) return complete[0];
    return [...jobs.values()].sort((a, b) => b.parts.size - a.parts.size)[0];
}

function loadManifest(jobId) {
    const cleanJobId = String(jobId || '').trim();
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(cleanJobId)) throw new Error('Job ID không hợp lệ');
    const manifestPath = path.join(MANIFEST_ROOT, `${cleanJobId}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifest.segments)) throw new Error('Manifest không có danh sách segments');
    return { manifest, manifestPath };
}

async function saveManifest(manifestPath, manifest) {
    manifest.updatedAt = new Date().toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

async function scanMaterialPagesForManifest(manifest, manifestPath) {
    const targetSegments = Array.isArray(manifest.originalSegments) ? manifest.originalSegments : manifest.segments;
    const candidates = targetSegments
        .filter(segment => segment.uploaded && segment.imageUri && !/^https?:\/\//i.test(segment.imageUri));
    if (candidates.length < 1) return { changed: false, resolved: 0 };

    console.log(`\n📋 Đang refresh signed URL cho ${candidates.length} segment từ Material Library...`);
    const wanted = new Map(candidates.map(segment => [String(segment.imageUri), segment]));
    const config = tiktokService.config;
    const headers = tiktokService.getHeaders();
    let changed = false;
    let resolved = 0;

    for (let page = 1; page <= MATERIAL_MAX_SCAN_PAGES && wanted.size > 0; page += 1) {
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
        for (const material of materials) {
            const webUri = material.base_info?.web_uri || material.web_uri || material.base_info?.image_uri || '';
            const imageUrl = decodeTikTokImageUrl(material.base_info?.image_url || material.image_url || '');
            if (!imageUrl) continue;
            for (const [imageUri, segment] of Array.from(wanted.entries())) {
                if (imageUriMatches(webUri, imageUri) || imageUriMatches(imageUrl, imageUri)) {
                    segment.resolvedImageUrl = imageUrl;
                    wanted.delete(imageUri);
                    changed = true;
                    resolved += 1;
                }
            }
        }

        console.log(`   Trang ${page}: ${materials.length} ảnh, resolve thêm ${resolved}/${candidates.length}`);
        if (materials.length < MATERIAL_PAGE_SIZE) break;
    }

    if (changed) await saveManifest(manifestPath, manifest);
    return { changed, resolved };
}

async function buildManifestImageSources(jobId) {
    const { manifest, manifestPath } = loadManifest(jobId);
    await scanMaterialPagesForManifest(manifest, manifestPath);

    const sources = [];
    const missing = [];
    const targetSegments = Array.isArray(manifest.originalSegments) ? manifest.originalSegments : manifest.segments;
    console.log(`ℹ️ Sử dụng danh sách segment: ${Array.isArray(manifest.originalSegments) ? 'originalSegments (Video gốc)' : 'segments (HLS phát)'}`);
    
    for (const segment of targetSegments.slice().sort((a, b) => a.index - b.index)) {
        if (!segment.uploaded || !segment.imageUri) {
            missing.push(segment.index);
            continue;
        }
        const directUrl = segment.resolvedImageUrl || (/^https?:\/\//i.test(segment.imageUri) ? segment.imageUri : '');
        if (!directUrl) {
            missing.push(segment.index);
            continue;
        }
        sources.push({ url: directUrl, index: segment.index, total: targetSegments.length, expectedJobId: manifest.jobId, source: 'manifest' });
    }
    if (missing.length) {
        console.log(`⚠️ Manifest vẫn thiếu signed URL cho ${missing.length} segment: ${missing.slice(0, 20).map(i => i + 1).join(', ')}${missing.length > 20 ? '...' : ''}`);
    }
    console.log(`📦 Dùng manifest ${manifest.jobId}: ${sources.length}/${targetSegments.length} segment có URL tải ảnh.`);
    return sources;
}

async function buildRecentImageSources() {
    const imageUrls = await tiktokService.getRecentImages();
    return imageUrls.map((url, index) => ({ url, index, source: 'recent' }));
}

async function main() {
    try {
        console.log('\n🔓 GIẢI MÃ FILE TỪ TIKTOK API\n');
        if (requestedJobId) console.log(`🎯 Job ID yêu cầu: ${requestedJobId}`);

        const imageSources = requestedJobId ? await buildManifestImageSources(requestedJobId) : await buildRecentImageSources();
        if (imageSources.length === 0) throw new Error('Không tìm thấy ảnh nào để decode');

        const workDir = path.join(process.cwd(), `decode_${Date.now()}`);
        fs.mkdirSync(workDir, { recursive: true });

        const cookie = process.env.TIKTOK_COOKIE || '';
        const jobs = new Map();

        const concurrency = Math.min(8, Math.max(1, Number(process.env.RECONSTRUCT_CONCURRENCY || process.env.UPLOAD_CONCURRENCY || 4)));
        console.log(`🚀 Chạy song song ${concurrency} luồng tải ảnh...`);

        let nextIndex = 0;
        let shouldStop = false;

        const runWorker = async (workerId) => {
            while (nextIndex < imageSources.length && !shouldStop) {
                const i = nextIndex++;
                if (i >= imageSources.length) break;

                const source = imageSources[i];
                const pngPath = path.join(workDir, `img_${i}.png`);

                console.log(`\n   [Luồng ${workerId}] [${i + 1}/${imageSources.length}] Đang tải ảnh${Number.isInteger(source.index) ? ` segment ${source.index + 1}` : ''} (${source.source})...`);

                try {
                    await downloadFile(source.url, pngPath, cookie);
                    const pngSize = fs.statSync(pngPath).size;
                    console.log(`      📦 PNG: ${(pngSize / 1024).toFixed(2)} KB`);

                    const decoded = await decodePngCarrier(pngPath, { jobId: source.expectedJobId || requestedJobId, index: source.index, total: source.total || imageSources.length });
                    if (requestedJobId && decoded.jobId !== requestedJobId) {
                        console.log(`      ⏭️ Bỏ qua job khác: ${decoded.jobId}`);
                        continue;
                    }

                    if (!jobs.has(decoded.jobId)) {
                        jobs.set(decoded.jobId, { jobId: decoded.jobId, total: decoded.total, parts: new Map() });
                    }

                    const job = jobs.get(decoded.jobId);
                    if (job.total !== decoded.total) {
                        throw new Error(`Job ${decoded.jobId} total mismatch (${job.total} != ${decoded.total})`);
                    }
                    if (!job.parts.has(decoded.index)) {
                        const tsPath = path.join(workDir, `${decoded.jobId}_${String(decoded.index).padStart(5, '0')}.ts`);
                        fs.writeFileSync(tsPath, decoded.payload);
                        job.parts.set(decoded.index, tsPath);
                    }

                    console.log(`      ✅ Carrier: luồng=${workerId}, job=${decoded.jobId}, part=${decoded.index + 1}/${decoded.total}, TS=${(decoded.payloadLength / 1024).toFixed(2)} KB`);
                    if (requestedJobId && job.parts.size === job.total) {
                        console.log(`      ✅ Đã đủ ${job.total}/${job.total} segment cho job yêu cầu, dừng tải.`);
                        shouldStop = true;
                        break;
                    }
                } catch (err) {
                    console.log(`      ❌ Lỗi luồng ${workerId} ở segment ${i + 1}: ${err.message}`);
                } finally {
                    try { fs.unlinkSync(pngPath); } catch(e) {}
                }
            }
        };

        const workers = Array.from({ length: Math.min(concurrency, imageSources.length) }, (_, idx) => runWorker(idx + 1));
        await Promise.all(workers);

        const selectedJob = pickBestJob(jobs);
        if (!selectedJob) {
            throw new Error('Không tìm được ảnh carrier hợp lệ. TikTok/CDN có thể đã resize/recompress làm đổi pixel, hoặc ảnh chưa kịp xuất hiện trong Material Library.');
        }

        console.log(`\n🧩 Job chọn: ${selectedJob.jobId} (${selectedJob.parts.size}/${selectedJob.total} segment)`);
        if (selectedJob.parts.size !== selectedJob.total) {
            const missing = [];
            for (let i = 0; i < selectedJob.total; i++) {
                if (!selectedJob.parts.has(i)) missing.push(i);
            }
            throw new Error(`Thiếu segment carrier: ${missing.join(', ')}`);
        }

        console.log(`\n🎬 Đang ghép ${selectedJob.total} segment...`);

        const ffmpegStatic = require('ffmpeg-static');
        const outputPath = path.resolve(outputVideo);
        const tempOutput = path.join(workDir, 'temp.ts');
        const writeStream = fs.createWriteStream(tempOutput);

        for (let i = 0; i < selectedJob.total; i++) {
            const data = fs.readFileSync(selectedJob.parts.get(i));
            writeStream.write(data);
        }
        await new Promise((resolve) => writeStream.end(resolve));

        try {
            await execPromise(`"${ffmpegStatic}" -i "${tempOutput}" -c copy "${outputPath}" -y`);
        } catch (err) {
            console.log(`   ⚠️ Copy lỗi, thử re-encode...`);
            await execPromise(`"${ffmpegStatic}" -i "${tempOutput}" -c:v libx264 -c:a aac "${outputPath}" -y`);
        }

        try { fs.unlinkSync(tempOutput); } catch(e) {}

        const stats = fs.statSync(outputPath);
        console.log(`\n✅ THÀNH CÔNG!`);
        console.log(`📁 Video: ${outputPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
    } catch (error) {
        console.error(`\n❌ LỖI: ${error.message}`);
        process.exit(1);
    }
}

main();
