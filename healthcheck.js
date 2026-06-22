// healthcheck.js
// Script to verify if the generated X-Bogus signature is accepted by the TikTok API.
require('dotenv').config();
const axios = require('axios');

async function testSignature() {
    console.log('[+] Đang chạy kiểm tra chữ ký X-Bogus...');
    
    // 1. Khởi tạo các tham số truy vấn mẫu (Query string)
    const urlParams = new URLSearchParams({
        aid: '1988',
        app_name: 'tiktok_web',
        device_platform: 'web_pc',
        user_is_login: 'true',
    });
    const query = urlParams.toString();
    const userAgent = process.env.USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    
    // 2. Sinh chữ ký
    let bogus = '';
    const useRpc = process.env.USE_RPC_SIGNER === 'true';
    let signerType = 'xbogus local';
    
    try {
        if (useRpc) {
            const rpcSigner = require('./xbogus_jsdom');
            bogus = await rpcSigner.sign(query, userAgent);
            signerType = 'JSDOM RPC';
        } else {
            const generate_bogus = require('xbogus');
            bogus = generate_bogus(query, userAgent);
        }
    } catch (err) {
        console.error(`[-] Lỗi khi sinh chữ ký bằng bộ ký ${signerType}:`, err.message);
        return { ok: false, reason: `Không thể sinh chữ ký: ${err.message}` };
    }

    if (!bogus) {
        return { ok: false, reason: 'Chữ ký sinh ra bị rỗng.' };
    }

    console.log(`[+] Chữ ký (${signerType}) đã sinh: ${bogus}`);
    
    // 3. Gửi yêu cầu kiểm tra lên TikTok API
    // Gửi request giả lập KHÔNG có cookie đăng nhập thực sự.
    // Nếu chữ ký hợp lệ -> Vượt qua lớp kiểm tra signature của TikTok -> Đi vào lớp check session và trả về "Permission Denied" (status_code: 7 hoặc 8).
    // Nếu chữ ký không hợp lệ -> Bị chặn ngay từ lớp WAF và trả về lỗi chữ ký hoặc mã lỗi verify fail.
    const url = 'https://www.tiktok.com/api/upload/image/?' + query + '&X-Bogus=' + bogus;
    
    try {
        const response = await axios.post(url, {}, {
            headers: {
                'accept': '*/*',
                'accept-language': 'vi-VN,vi;q=0.9',
                'origin': 'https://www.tiktok.com',
                'referer': 'https://www.tiktok.com/',
                'tt-csrf-token': 'FoDFiDrG-tO4664D8s9d-iNepMRIK1V3JaYI', // Dummy token
                'user-agent': userAgent,
            },
            timeout: 10000
        });
        
        const resData = response.data;
        console.log('[+] Phản hồi từ TikTok API:', JSON.stringify(resData));
        
        // Nếu phản hồi có cấu trúc và trả về lỗi quyền hạn hoặc phiên đăng nhập (status_code: 7 hoặc 8)
        if (resData && (resData.status_code === 7 || resData.status_code === 8 || resData.status_code === 9)) {
            return { ok: true, reason: 'Chữ ký hợp lệ và được máy chủ TikTok chấp nhận (vượt qua lớp chữ ký, dừng ở bước kiểm tra quyền đăng nhập).' };
        } else if (resData && resData.status_code === 0) {
            return { ok: true, reason: 'Chữ ký được máy chủ TikTok chấp nhận thành công.' };
        } else {
            return { ok: false, reason: `Máy chủ phản hồi lạ. Mã phản hồi: ${JSON.stringify(resData)}` };
        }
    } catch (err) {
        if (err.response) {
            const dataStr = JSON.stringify(err.response.data || '');
            console.log('[-] Phản hồi lỗi HTTP từ TikTok:', err.response.status, dataStr);
            if (dataStr.includes('"status_code":7') || dataStr.includes('"status_code":8')) {
                return { ok: true, reason: 'Chữ ký hợp lệ (vượt qua lớp chữ ký, lỗi HTTP trả về Permission Denied/Session Expired từ API handler).' };
            }
            return { ok: false, reason: `Máy chủ TikTok trả về lỗi HTTP ${err.response.status}: ${dataStr}` };
        }
        return { ok: false, reason: `Lỗi kết nối mạng khi gửi request: ${err.message}` };
    }
}

if (require.main === module) {
    testSignature().then(res => {
        if (res.ok) {
            console.log('\n✅ HEALTHCHECK THÀNH CÔNG:', res.reason);
            process.exit(0);
        } else {
            console.error('\n❌ HEALTHCHECK THẤT BẠI:', res.reason);
            process.exit(1);
        }
    }).catch(err => {
        console.error('\n❌ Lỗi hệ thống khi chạy healthcheck:', err.message);
        process.exit(1);
    });
}

module.exports = { testSignature };
