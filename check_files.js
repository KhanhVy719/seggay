// check_files.js
const fs = require('fs');

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
    'public/carrier-player.js',
    'public/carrier-worker.js',
    'deobfuscator/select_account.html',
    'deobfuscator/webmssdk_original.js',
    'dashboard/dist/index.html'
];

const missing = files.filter(f => !fs.existsSync(f));
if (missing.length) {
    console.error('\n[LỖI] Thư mục dự án bị thiếu các file quan trọng:\n' + missing.map(f => '  - ' + f).join('\n') + '\nVui lòng chạy git pull để kéo lại đầy đủ.\n');
    process.exit(1);
}
process.exit(0);
