// check_files.js
const fs = require('fs');
const path = require('path');

const files = [
    'package.json',
    'package-lock.json',
    'carrier.js',
    'server.js',
    'server_extended.js',
    'sign_client.js',
    'signer_service.js',
    'tiktok.js',
    'tiktok_cdn_uploader.js',
    'tiktok_volcengine_uploader.js',
    'pure_lossless_upload.js',
    'upload.js',
    'decoded.js',
    'public/carrier-player.js',
    'public/carrier-worker.js',
    'deobfuscator/select_account.html',
    'deobfuscator/webmssdk_original.js',
    'dashboard/dist/index.html'
];

// Tự tạo file .env mẫu nếu thiếu
const envPath = path.join(process.cwd(), '.env');
if (!fs.existsSync(envPath)) {
    const envTemplate = `PORT=30001
TIKTOK_COOKIE=""
CONSUMER_COOKIES_JSON="[]"
SEGMENT_CONCURRENCY=1
UPLOAD_CONCURRENCY=3
`;
    fs.writeFileSync(envPath, envTemplate, 'utf8');
    console.log('\n[INFO] Không tìm thấy file .env. Hệ thống đã tự tạo file .env mẫu.');
    console.log('Bạn có thể cấu hình TIKTOK_COOKIE trực tiếp trong file .env hoặc lưu qua giao diện Dashboard.\n');
}

const missing = files.filter(f => !fs.existsSync(f));
if (missing.length) {
    console.error('\n[LỖI] Thư mục dự án bị thiếu các file quan trọng:\n' + missing.map(f => '  - ' + f).join('\n') + '\nVui lòng chạy git pull để kéo lại đầy đủ.\n');
    process.exit(1);
}
process.exit(0);
