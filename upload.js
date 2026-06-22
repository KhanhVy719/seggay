// upload.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const tiktokService = require('./tiktok');

function formatMb(bytes) {
    return `${(Number(bytes || 0) / 1024 / 1024).toFixed(2)} MB`;
}

function formatMbps(bitsPerSecond) {
    return `${(Number(bitsPerSecond || 0) / 1000 / 1000).toFixed(2)} Mbps`;
}

const args = process.argv.slice(2);
let videoPath = args[0];
let videoTitle = args[1] || 'Auto ' + Date.now();
let videoDescription = args[2] || '#fyp #xuhuong';

if (!videoPath) {
    console.log('Cách dùng: node upload.js <đường_dẫn_video> [tiêu_đề] [mô_tả]');
    process.exit(1);
}

videoPath = path.resolve(videoPath);
if (!fs.existsSync(videoPath)) {
    console.error('❌ Không tìm thấy file video');
    process.exit(1);
}

async function main() {
    try {
        console.log('\n🚀 TIKTOK UPLOADER\n');
        console.log(`📁 Video: ${path.basename(videoPath)}`);
        console.log(`📝 Tiêu đề: ${videoTitle}`);
        console.log(`📄 Mô tả: ${videoDescription}\n`);

        console.log('📹 [1/2] Đang phân tích video...');
        const metadata = await tiktokService.probeVideo(videoPath);
        const codecText = [metadata.videoCodec, metadata.profile, metadata.pixelFormat].filter(Boolean).join(' / ') || 'unknown codec';
        console.log(`   ✅ ${metadata.width}x${metadata.height}, ${Math.floor(metadata.duration / 60)}p${Math.floor(metadata.duration % 60)}s, bitrate≈${formatMbps(metadata.bitrate)}, codec=${codecText}`);

        console.log('\n🎬 [2/2] Đang upload lên TikTok...');
        const result = await tiktokService.processJob(videoPath, 4, metadata.duration, (percent, msg) => {
            process.stdout.write(`\r   ⏳ ${msg} (${percent}%)`);
        }, metadata);
        console.log(`\n   ✅ Upload thành công!`);
        console.log(`   🆔 Job ID: ${result.jobId}`);
        console.log(`   🖼️ Carrier images: ${(result.uploadedImages || []).length}`);
        const publicCount = (result.uploadedImages || []).filter(item => item.publicImageUrl).length;
        console.log(`   🌐 Public no-cookie URLs verified: ${publicCount}/${(result.uploadedImages || []).length}`);
        if (publicCount < 1) console.log('   ℹ️ TikTok chưa trả URL public carrier hợp lệ; player vẫn dùng signed URL/proxy fallback.');
        if (result.sizing) {
            console.log(`   📦 Segment policy: target=${formatMb(result.sizing.targetSegmentBytes)}, max=${formatMb(result.sizing.maxSegmentBytes)}, hls_time=${result.sizing.selectedSegmentDuration}s, strategy=${result.sizing.strategy || 'unknown'}`);
            if (result.sizing.codecDecision && result.sizing.codecDecision.safe === false) {
                console.log(`   🔁 Browser-safe transcode: ${result.sizing.codecDecision.reasons.join(', ')}`);
            }
            console.log(`   📊 Max TS=${formatMb(result.sizing.maxTsBytes)}, Max PNG=${formatMb(result.sizing.maxPngBytes)}, overMax=${result.sizing.overMax ? 'yes' : 'no'}`);
        }
        console.log(`   🎞️ Carrier Player: ${result.carrierPlayerUrl}`);
        console.log(`   📺 Carrier HLS: ${result.carrierPlaylistUrl}`);
        console.log(`   🔗 Local debug HLS: ${result.playlistUrl}`);

        const port = process.env.PORT || 3000;
        const encodedJobId = encodeURIComponent(result.jobId);
        const baseUrl = (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
        const recommendedPlayerPath = `/player?jobId=${encodedJobId}&direct=1&auto=1`;
        const recommendedPlayerUrl = `${baseUrl}${recommendedPlayerPath}`;
        const embedPlayerUrl = `${baseUrl}/player?jobId=${encodedJobId}&direct=1&auto=1&embed=1`;
        const embedWrapperUrl = `${baseUrl}/embed/player?jobId=${encodedJobId}`;
        const iframeHtml = `<iframe src="${embedPlayerUrl.replace(/&/g, '&amp;')}" width="100%" height="600" style="border:0;background:#000;" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
        console.log(`   ▶️ Carrier Player URL khuyến nghị: ${recommendedPlayerUrl}`);
        console.log(`   🧩 Embed Player URL: ${embedPlayerUrl}`);
        console.log(`   🧩 Embed Wrapper URL: ${embedWrapperUrl}`);
        console.log(`   🧩 Iframe HTML: ${iframeHtml}`);
        if (!String(result.carrierPlaylistUrl || '').startsWith('http')) {
            console.log(`   📺 Carrier HLS URL: http://localhost:${port}${result.carrierPlaylistPath}`);
        }

        const localPath = result.playlistPath || result.playlistUrl;
        if (localPath && localPath.startsWith('/')) {
            console.log(`   🧪 Local debug URL: http://localhost:${port}${localPath}`);
            console.log(`   💡 Nếu chưa bật server, chạy: node server.js`);
        }

        console.log('\n✅ HOÀN THÀNH UPLOAD!');
        console.log(`\n🔧 Link nên dùng để xem: ${recommendedPlayerUrl}`);
        console.log(`🔧 decoded.js chỉ dùng khi cần export MP4 offline/debug, không cần cho playback web.`);

    } catch (error) {
        console.error(`\n❌ LỖI: ${error.message}`);
        process.exit(1);
    }
}

main();
