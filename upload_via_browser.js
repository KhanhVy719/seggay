// upload_via_browser.js — Path C / option 2.
//
// Gửi NGUYÊN request upload ảnh (polyglot PNG chứa payload TS) NGAY TRONG browser Chromium
// đã đăng nhập (signer_service.js cổng 35123), thay vì forge X-Bogus trong Node rồi gửi axios.
// Nhờ vậy:
//   - _mssdk tự ký đầy đủ msToken + X-Bogus + X-Gnarly (chữ ký HỢP LỆ hiện tại của TikTok),
//   - cookie phiên đăng nhập khớp tự nhiên với msToken,
//   - file nhị phân không bị hỏng vì được truyền base64 và dựng lại Blob/FormData TRONG page.
//
// QUAN TRỌNG (đã KIỂM CHỨNG LIVE 2026-06-24): endpoint upload avatar THẬT của TikTok web là
// '/api/upload/image/'. Nó KHÔNG cần _mssdk ký X-Bogus/msToken — xác thực bằng cookie phiên +
// verifyFp + tt-csrf-token. Gọi NGAY TRONG browser đã đăng nhập nên các thứ này khớp tự nhiên.
//   -> /api/upload/image/  => HTTP 200 + link CDN sống (đã tải về kiểm chứng image/png).  [ĐÚNG]
//   -> /aweme/v1/upload/image2/  => CÓ ký đầy đủ nhưng TikTok trả status_code=5 "Invalid
//      parameters" (endpoint app-internal, contract khác).  [SAI cho avatar upload]
// ⚠️ Đừng đổi UPLOAD_PATH về image2 dựa trên lý thuyết "chỉ path allow-list mới ký được" —
//    thực nghiệm round-trip đã bác bỏ điều đó cho avatar upload.
//
// Yêu cầu: signer_service.js đang chạy (node signer_service.js) và .env có TIKTOK_COOKIE.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
require('dotenv').config();

const signClient = require('./sign_client');

const cookie = process.env.TIKTOK_COOKIE;
if (!cookie) {
  console.error('[-] Lỗi: Không tìm thấy TIKTOK_COOKIE trong file .env!');
  process.exit(1);
}
const csrfMatch = cookie.match(/tt_csrf_token=([^;]+)/);
const csrf = csrfMatch ? csrfMatch[1] : '';

// Endpoint upload avatar THẬT mà TikTok web dùng (xác minh từ request đã capture):
//   /api/upload/image/  — KHÔNG cần X-Bogus/msToken; xác thực bằng cookie phiên + verifyFp + tt-csrf-token.
// Vì gọi NGAY TRONG browser đã đăng nhập, cookie + verifyFp khớp tự nhiên nên không cần forge gì thêm.
const UPLOAD_PATH = '/api/upload/image/';

// Cố gắng tái dùng NGUYÊN bộ query thật đã bắt được (đầy đủ browser_*, device_id, verifyFp, region…),
// vì /api/upload/image/ trả "Invalid parameters" nếu thiếu các tham số web này.
function loadRealQuery() {
  const candidates = [
    path.join(__dirname, 'avatar_upload_work', 'all_requests_v4.json'),
    path.join(__dirname, 'avatar_upload_work', 'all_requests_v3.json'),
    path.join(__dirname, 'avatar_upload_work', 'captured_requests.json'),
  ];
  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue;
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const arr = Array.isArray(d) ? d : (d.requests || d.list || []);
      const r = arr.find((x) => /\/api\/upload\/image\//.test(x.url || (x.request && x.request.url) || ''));
      if (!r) continue;
      const u = new URL(r.url || r.request.url);
      // Bỏ mọi tham số chữ ký cũ — browser sẽ tự thêm lại nếu cần.
      ['X-Bogus', 'X-Gnarly', 'msToken', '_signature'].forEach((k) => u.searchParams.delete(k));
      console.log(`[+] Dùng lại query thật từ ${path.basename(f)} (${[...u.searchParams.keys()].length} tham số).`);
      return u.searchParams.toString();
    } catch (e) { /* thử file kế tiếp */ }
  }
  return null;
}

async function run() {
  // 0) Kiểm tra signer sống + mssdk sẵn sàng
  try {
    const h = await signClient.health();
    console.log('[+] Signer health:', JSON.stringify(h));
    if (!h.mssdkReady) {
      console.warn('[!] mssdk chưa sẵn sàng — chữ ký có thể rỗng. Hãy đợi signer nạp xong www.tiktok.com.');
    }
  } catch (e) {
    console.error('[-] Không kết nối được Signer Service (35123). Hãy chạy: node signer_service.js');
    console.error('    Chi tiết:', e.message);
    process.exit(1);
  }

  const workDir = path.join(__dirname, 'avatar_upload_work');
  const tsPath = path.join(workDir, 'seg_00007.ts');

  // 1) Dựng polyglot PNG: PNG 300x300 + payload TS nối đuôi (giống test_upload_append_ts.js)
  let polyglotBuf;
  let baseOffset = 0;
  if (fs.existsSync(tsPath)) {
    const originalTsBuf = fs.readFileSync(tsPath);
    console.log(`[+] Phân đoạn TS gốc: ${originalTsBuf.length} byte.`);
    const basePngBuf = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 52, g: 152, b: 219 } },
    }).png().toBuffer();
    polyglotBuf = Buffer.concat([basePngBuf, originalTsBuf]);
    baseOffset = basePngBuf.length;
    console.log(`[+] Polyglot PNG: ${polyglotBuf.length} byte (TS offset = ${baseOffset}).`);
  } else {
    // Không có file TS — vẫn upload một PNG thuần để kiểm chứng đường ký/đăng nhập.
    console.warn(`[!] Không thấy ${tsPath} — upload PNG thuần 300x300 để kiểm chứng đường ký.`);
    polyglotBuf = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 52, g: 152, b: 219 } },
    }).png().toBuffer();
  }

  // 2) Query cho /api/upload/image/ — ưu tiên NGUYÊN bộ query thật đã capture; nếu không có thì dựng bộ web đầy đủ.
  let queryParams = loadRealQuery();
  if (!queryParams) {
    console.warn('[!] Không tìm thấy query thật đã capture — dựng bộ tham số web đầy đủ mặc định.');
    const queryParamsObj = {
      aid: '1988',
      app_language: 'en',
      app_name: 'tiktok_web',
      browser_language: 'en-US',
      browser_name: 'Mozilla',
      browser_online: 'true',
      browser_platform: 'Win32',
      browser_version: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      channel: 'tiktok_web',
      cookie_enabled: 'true',
      device_platform: 'web_pc',
      focus_state: 'true',
      from_page: 'user',
      history_len: '2',
      is_fullscreen: 'false',
      is_page_visible: 'true',
      os: 'windows',
      priority_region: 'VN',
      region: 'VN',
      screen_height: '864',
      screen_width: '1536',
      tz_name: 'Asia/Bangkok',
      user_is_login: 'true',
      webcast_language: 'en',
    };
    queryParams = Object.entries(queryParamsObj)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }

  // 3) Upload NGAY TRONG browser đã đăng nhập
  console.log(`[+] Đang upload qua browser (in-page) tới ${UPLOAD_PATH} ...`);
  let resp;
  try {
    resp = await signClient.uploadViaBrowser({
      fileBuffer: polyglotBuf,
      path: UPLOAD_PATH,
      queryParams,
      filename: 'avatar.png',
      contentType: 'image/png',
      fieldName: 'file',
      csrf,
    });
  } catch (e) {
    console.error('[-] Upload lỗi:', e.message);
    process.exit(1);
  }

  console.log('\n--- KẾT QUẢ UPLOAD (in-page) ---');
  console.log('HTTP status:', resp.status);
  console.log('signedUrl:', resp.signedUrl ? String(resp.signedUrl).slice(0, 140) + '...' : '(không bắt được)');
  if (resp.params) {
    console.log('chữ ký:  msToken=', !!resp.params.msToken, '| X-Bogus=', !!resp.params.xBogus, '| X-Gnarly=', !!resp.params.xGnarly);
  }
  console.log('sentBytes:', resp.sentBytes, '(gửi vào page)');

  // 4) Phát hiện "chưa đăng nhập" / lỗi
  const j = resp.json;
  const bodyHead = String(resp.body || '').slice(0, 600);
  if (!j) {
    console.error('[-] Response không phải JSON. Body head:\n', bodyHead);
    if (/login|log in|sign in|not.*logged/i.test(bodyHead)) {
      console.error('👉 Có vẻ CHƯA ĐĂNG NHẬP — kiểm tra lại TIKTOK_COOKIE trong .env (sessionid còn hạn?).');
    }
    process.exit(1);
  }

  // TikTok thường trả status_code / status_msg; ảnh upload trả url_list
  if (j.status_code && j.status_code !== 0) {
    console.error('[-] TikTok từ chối. status_code=', j.status_code, '| msg=', j.status_msg || j.message);
    console.error('    Full:', JSON.stringify(j).slice(0, 800));
    if (/login|not.*log|session|token/i.test(JSON.stringify(j))) {
      console.error('👉 Khả năng phiên đăng nhập hết hạn hoặc thiếu cookie.');
    }
    process.exit(1);
  }

  // 5) Kiểm tra bucket upload: lossless (tos-alisg-avt-0068) vs compressed (tiktok-obj)
  const urlList = (j.data && j.data.url_list) || j.url_list;
  if (urlList && urlList.length) {
    const cdnUrl = urlList[0];
    console.log(`\n🎉 [THÀNH CÔNG] Link CDN: ${cdnUrl}`);

    // Phân tích bucket type
    if (cdnUrl.includes('tos-alisg-avt-0068')) {
      console.log(`✅ [LOSSLESS] Upload vào bucket LOSSLESS: tos-alisg-avt-0068`);
      console.log(`   → Dữ liệu được giữ nguyên 100%, polyglot PNG hoạt động!`);
    } else if (cdnUrl.includes('tiktok-obj')) {
      console.error(`❌ [COMPRESSED] Upload bị định tuyến sang bucket CÔNG CỘNG: tiktok-obj`);
      console.error(`   → File sẽ bị nén xuống ~913 bytes, mất dữ liệu payload!`);
      console.error(`   → Nguyên nhân: Cookie WAF Token (_waftokenid) HẾT HẠN hoặc THIẾU.`);
      console.error(`   → Giải pháp: Khởi động lại signer_service.js để refresh WAF Token.`);
      process.exit(1);
    } else {
      console.warn(`⚠️  [UNKNOWN] Bucket không xác định: ${cdnUrl.match(/obj\/([^/]+)/)?.[1] || 'unknown'}`);
    }

    // Hiển thị bucket type từ response nếu có
    if (resp.bucketType) {
      console.log(`   Bucket type detected by signer: ${resp.bucketType}`);
    }
  } else {
    console.log('\n[i] Upload phản hồi OK nhưng không thấy url_list. Full JSON:');
    console.log(JSON.stringify(j, null, 2).slice(0, 1200));
  }
}

run().catch((e) => { console.error('[-] Lỗi hệ thống:', e.message); process.exit(1); });
