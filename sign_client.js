const axios = require('axios');

// === Path C signer (mới) ===
// Signer Service mới (signer_service.js) chạy một Chromium thật + _mssdk, sinh ĐẦY ĐỦ
// chữ ký path-bound: msToken + X-Bogus + X-Gnarly. Đây là cách ký HỢP LỆ hiện tại của
// TikTok (byted_acrawler.frontierSign cũ chỉ trả X-Bogus và đã bị từ chối).
const SIGNER_URL = process.env.SIGNER_URL || 'http://localhost:35123';

// === Fallback RPC cũ (rpc_server.js / rpc_compat.js) — chỉ X-Bogus ===
const RPC_SERVER_URL = process.env.RPC_SERVER_URL || 'http://localhost:30010/sign';

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// QUAN TRỌNG: _mssdk CHỈ ký các path nằm trong allow-list (_enablePathList). Path upload
// hợp lệ hiện tại là '/aweme/v1/upload/image2/' (ảnh) và '/api/v1/item/create/' (tạo item).
// Path cũ '/api/upload/image/' KHÔNG nằm trong allow-list nên KHÔNG bao giờ được ký.
const DEFAULT_PATH = '/aweme/v1/upload/image2/';

// Các path mà _mssdk thực sự ký (trích từ _mssdk._enablePathList trên www.tiktok.com).
// Dùng để cảnh báo sớm nếu caller truyền path không được ký.
const SIGNABLE_PATHS = [
    '/aweme/v1/upload/image2/',
    '/api/v1/item/create/',
    '/api/recommend/item_list/',
    '/api/post/item_list/',
    '/api/item/detail/',
    '/api/user/detail/',
];

function warnIfUnsignablePath(p) {
    try {
        const pathname = p.startsWith('http') ? new URL(p).pathname : p.split('?')[0];
        const ok = SIGNABLE_PATHS.some((s) => pathname === s) || pathname.startsWith('/aweme/') || pathname.startsWith('/api/');
        if (!ok || pathname === '/api/upload/image/') {
            console.warn(`[!] Path "${pathname}" có thể KHÔNG nằm trong allow-list ký của _mssdk; chữ ký sẽ rỗng. Dùng /aweme/v1/upload/image2/ hoặc /api/v1/item/create/.`);
        }
    } catch { /* bỏ qua */ }
}

function signerConnErr(err) {
    if (err.code === 'ECONNREFUSED') {
        return new Error('[-] Không kết nối được Signer Service. Hãy khởi chạy: node signer_service.js (cổng 35123).');
    }
    return new Error(`[-] Lỗi Signer Service: ${err.response ? JSON.stringify(err.response.data) : err.message}`);
}

/**
 * Ký một URL đầy đủ qua Signer Service mới. Trả về URL đã gắn msToken+X-Bogus+X-Gnarly
 * cùng các tham số chữ ký tách riêng.
 * @param {string} url URL tuyệt đối cần ký (vd https://www.tiktok.com/api/upload/image/?...)
 * @param {string} method HTTP method (GET/POST), mặc định GET
 * @returns {Promise<{signedUrl:string, params:{msToken:string,xBogus:string,xGnarly:string}}>}
 */
async function getSignedUrl(url, method = 'GET') {
    warnIfUnsignablePath(url);
    try {
        const res = await axios.post(`${SIGNER_URL}/sign`, { url, method }, { timeout: 30000 });
        if (!res.data || !res.data.signedUrl) {
            const ev = res.data && res.data.evalRes;
            // fetch chạy OK (status 200) nhưng không bắt được request đã ký => path KHÔNG nằm trong allow-list _mssdk.
            if (ev && ev.ok) {
                throw new Error(
                    'Signer không bắt được request đã ký cho URL này — path không nằm trong allow-list ký của _mssdk. ' +
                    'Hãy dùng /aweme/v1/upload/image2/ hoặc /api/v1/item/create/. (evalRes=' + JSON.stringify(ev) + ')'
                );
            }
            throw new Error('Signer không trả về signedUrl: ' + JSON.stringify(res.data));
        }
        return { signedUrl: res.data.signedUrl, params: res.data.params };
    } catch (err) {
        if (err.code === 'ECONNREFUSED' || (err.response && err.response.status >= 500)) {
            throw signerConnErr(err);
        }
        throw err;
    }
}

/**
 * Ký một chuỗi queryParams và trả về CHUỖI QUERY đã ký đầy đủ (đã gồm msToken/X-Bogus/X-Gnarly).
 * @param {string} queryParams query không kèm dấu '?'
 * @param {string} path đường dẫn endpoint (mặc định /api/upload/image/)
 * @param {string} method HTTP method, mặc định POST (upload)
 * @returns {Promise<string>} chuỗi query đã ký
 */
async function getSignedQuery(queryParams, path = DEFAULT_PATH, method = 'POST') {
    const url = `https://www.tiktok.com${path}?${queryParams}`;
    const { signedUrl } = await getSignedUrl(url, method);
    const q = signedUrl.split('?')[1];
    return q || queryParams;
}

/**
 * Lấy chữ ký X-Bogus.
 * Tương thích ngược với interface cũ: getXBogus(queryParams, userAgent) -> Promise<string>.
 * Ưu tiên Signer Service mới (cổng 35123) để X-Bogus khớp với msToken/X-Gnarly đồng bộ;
 * nếu service mới không sẵn sàng thì fallback về RPC cũ (cổng 30010, chỉ X-Bogus).
 * @param {string} queryParams query không kèm dấu '?'
 * @param {string} userAgent User-Agent (giữ tham số để tương thích; service mới dùng UA cố định của browser)
 * @returns {Promise<string>} chuỗi X-Bogus
 */
async function getXBogus(queryParams, userAgent = DEFAULT_USER_AGENT) {
    // 1) Thử Signer Service mới — trả X-Bogus đồng bộ với msToken + X-Gnarly.
    try {
        const url = `https://www.tiktok.com${DEFAULT_PATH}?${queryParams}`;
        const { params } = await getSignedUrl(url, 'POST');
        if (params && params.xBogus) {
            return params.xBogus;
        }
        throw new Error('Signer không trả về X-Bogus.');
    } catch (errNew) {
        // 2) Fallback: RPC cũ (chỉ X-Bogus). Cảnh báo vì có thể bị TikTok từ chối khi thiếu X-Gnarly/msToken.
        try {
            const response = await axios.post(RPC_SERVER_URL, { queryParams, userAgent }, { timeout: 10000 });
            if (response.data && response.data.xBogus) {
                console.warn('[!] Dùng fallback RPC cũ (chỉ X-Bogus). Khuyến nghị chạy signer_service.js để ký đầy đủ.');
                return response.data.xBogus;
            }
            throw new Error('Server không trả về trường xBogus.');
        } catch (errOld) {
            if (errOld.code === 'ECONNREFUSED' && (errNew.message || '').includes('Signer Service')) {
                throw new Error('[-] Không kết nối được Signer Service (35123) lẫn RPC cũ (30010). Hãy khởi chạy: node signer_service.js');
            }
            // Ưu tiên báo lỗi của signer mới nếu nó không phải lỗi kết nối.
            throw errNew;
        }
    }
}

/**
 * Gửi NGUYÊN request đã ký NGAY TRONG browser đã đăng nhập (in-page fetch).
 * Dùng cho POST/upload nơi chữ ký bind theo body + cookie phiên đăng nhập.
 * @param {{url:string, method?:string, headers?:object, body?:string}} req
 * @returns {Promise<{status:number, respHeaders:object, body:string, signedUrl:string, params:object}>}
 */
async function proxyRequest({ url, method = 'GET', headers, body }) {
    try {
        const res = await axios.post(`${SIGNER_URL}/proxy`, { url, method, headers, body }, { timeout: 60000 });
        return res.data;
    } catch (err) {
        throw signerConnErr(err);
    }
}

/**
 * Upload một file NHỊ PHÂN NGAY TRONG browser đã đăng nhập (Path C, option 2).
 *
 * File được gửi dưới dạng base64 tới /upload; signer dựng lại Blob/FormData TRONG page
 * rồi window.fetch(POST) để _mssdk tự ký (msToken+X-Bogus+X-Gnarly) và cookie phiên khớp.
 * Cách này tránh hỏng nhị phân do hop chuỗi của /proxy.
 *
 * LƯU Ý PATH: _mssdk chỉ ký path trong allow-list. Path upload ảnh hợp lệ là
 * '/aweme/v1/upload/image2/'. Path cũ '/api/upload/image/' KHÔNG được ký -> sẽ bị từ chối.
 *
 * @param {Object} opts
 * @param {Buffer} opts.fileBuffer dữ liệu file (Buffer Node)
 * @param {string} [opts.queryParams] query string (không kèm '?'); ghép vào url sau path
 * @param {string} [opts.path] path upload, mặc định /aweme/v1/upload/image2/
 * @param {string} [opts.url] URL tuyệt đối đầy đủ (nếu đặt sẽ override path+queryParams)
 * @param {string} [opts.filename] tên file multipart, mặc định 'avatar.png'
 * @param {string} [opts.contentType] content-type file, mặc định 'image/png'
 * @param {string} [opts.fieldName] tên field multipart, mặc định 'file'
 * @param {string} [opts.csrf] giá trị tt-csrf-token (thêm vào header)
 * @param {Object} [opts.extraHeaders] header bổ sung cho fetch
 * @returns {Promise<{status:number, signedUrl:string, params:object, json:object, body:string, sentBytes:number}>}
 */
async function uploadViaBrowser(opts = {}) {
    const {
        fileBuffer,
        queryParams = '',
        path = DEFAULT_PATH,
        filename = 'avatar.png',
        contentType = 'image/png',
        fieldName = 'file',
        csrf,
        extraHeaders,
    } = opts;

    if (!Buffer.isBuffer(fileBuffer)) {
        throw new Error('uploadViaBrowser: cần truyền fileBuffer là Buffer.');
    }

    const url = opts.url || `https://www.tiktok.com${path}${queryParams ? '?' + queryParams : ''}`;
    warnIfUnsignablePath(url);

    const headers = Object.assign({}, extraHeaders || {});
    if (csrf) headers['tt-csrf-token'] = csrf;

    const payload = {
        url,
        fileBase64: fileBuffer.toString('base64'),
        filename,
        contentType,
        fieldName,
        extraHeaders: Object.keys(headers).length ? headers : undefined,
    };

    try {
        const res = await axios.post(`${SIGNER_URL}/upload`, payload, {
            timeout: 120000,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
        });
        const d = res.data || {};
        if (d.ok === false) {
            throw new Error('Upload in-page thất bại: ' + (d.err || JSON.stringify(d)));
        }
        if (!d.params || !d.params.xBogus) {
            console.warn('[!] Upload không bắt được chữ ký (path có thể ngoài allow-list). signedUrl=' + d.signedUrl);
        }
        return d;
    } catch (err) {
        if (err.code === 'ECONNREFUSED' || (err.response && err.response.status >= 500)) {
            throw signerConnErr(err);
        }
        throw err;
    }
}

/** Kiểm tra trạng thái Signer Service mới. */
async function health() {
    const res = await axios.get(`${SIGNER_URL}/health`, { timeout: 5000 });
    return res.data;
}

module.exports = {
    getXBogus,
    getSignedUrl,
    getSignedQuery,
    proxyRequest,
    uploadViaBrowser,
    health,
};
