/**
 * pure_lossless_upload.js
 * 
 * Module upload ảnh lossless lên TikTok CDN không cần giả lập trình duyệt.
 * Sử dụng Volcengine/ImageX AWS4 direct TOS upload protocol.
 * 
 * Luồng hoạt động:
 * 1. Đọc cookie từ .env
 * 2. Lấy STS Token (từ API /api/v1/video/upload/auth/)
 * 3. Ký số AWS4 để gọi ApplyUploadInner
 * 4. Gửi PUT request trực tiếp chứa file nhị phân thô lên TOS
 * 5. Trả về link CDN bypass chữ ký vĩnh viễn
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

// Auto-fallback: Sync TIKTOK_COOKIE from CONSUMER_COOKIES_JSON if missing
if (!process.env.TIKTOK_COOKIE && process.env.CONSUMER_COOKIES_JSON) {
  try {
    const parsed = JSON.parse(process.env.CONSUMER_COOKIES_JSON);
    if (Array.isArray(parsed) && parsed.length > 0) {
      process.env.TIKTOK_COOKIE = parsed.map(c => `${c.name}=${c.value}`).join('; ');
    }
  } catch (e) {}
}

const SIGNER_URL = 'http://127.0.0.1:35123';

// Helper: HMAC-SHA256
function hmacSha256(key, msg) {
  return crypto.createHmac('sha256', key).update(msg).digest();
}

// Helper: SHA256 Hex
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Helper: Sắp xếp query params theo chuẩn AWS4
function getCanonicalQueryString(searchParams) {
  const params = [];
  for (const [key, value] of searchParams.entries()) {
    params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return params.sort().join('&');
}

/**
 * Lấy STS token sử dụng Cookie tài khoản mồi
 */
async function getSTSToken(cookieStr) {
  console.log('🔑 Step 1: Đang lấy STS credentials...');
  
  // Cách 1: Thử gọi trực tiếp bằng axios với Cookie
  try {
    const res = await axios.get('https://www.tiktok.com/api/v1/video/upload/auth/?aid=1988', {
      headers: {
        'Cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.tiktok.com/'
      },
      timeout: 10000
    });
    
    if (res.data?.video_token_v5) {
      console.log('   ✅ Lấy STS Token trực tiếp thành công.');
      return res.data.video_token_v5;
    }
  } catch (err) {
    console.log(`   ⚠️ Lấy trực tiếp thất bại (${err.message}). Thử fallback qua Signer Service...`);
  }

  // Cách 2: Fallback qua Signer Service chạy ngầm
  try {
    const authExpr = `
      (async () => {
        const resp = await fetch('/api/v1/video/upload/auth/?aid=1988', { credentials: 'include' });
        return await resp.text();
      })()
    `;
    const authResp = await axios.post(`${SIGNER_URL}/eval`, { expr: authExpr }, { timeout: 10000 });
    const authData = JSON.parse(authResp.data.value);
    if (authData?.video_token_v5) {
      console.log('   ✅ Lấy STS Token qua Signer Service thành công.');
      return authData.video_token_v5;
    }
    throw new Error(JSON.stringify(authData));
  } catch (err) {
    throw new Error(`Không thể lấy STS Token. Vui lòng kiểm tra Cookie trong .env hoặc chạy Signer Service. Lỗi: ${err.message}`);
  }
}

/**
 * Gọi ApplyUploadInner để xin cấp quyền ghi file lên bucket lossless
 */
async function applyUpload(creds, cookieStr) {
  console.log('🏥 Step 2: Đang gửi yêu cầu ApplyUploadInner...');
  const applyUrl = 'https://www.tiktok.com/top/v1?Action=ApplyUploadInner&Version=2020-11-19&SpaceName=tiktok_avatar&FileType=image&IsInner=1&s=yqpl39xuexr&device_platform=web';
  const urlObj = new URL(applyUrl);
  
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  
  const headers = {
    'host': urlObj.host,
    'x-amz-date': amzDate
  };
  
  if (creds.securityToken) {
    headers['x-amz-security-token'] = creds.securityToken;
  }
  
  // Tạo canonical query string & headers
  const canonQuery = getCanonicalQueryString(urlObj.searchParams);
  const sortedKeys = Object.keys(headers).map(k => k.toLowerCase()).sort();
  const canonHeaders = sortedKeys.map(k => {
    const origKey = Object.keys(headers).find(h => h.toLowerCase() === k);
    return `${k}:${headers[origKey].trim()}`;
  }).join('\n') + '\n';
  const signedHdrs = sortedKeys.join(';');
  
  // Tạo chữ ký AWS4
  const canonicalRequest = ['GET', urlObj.pathname, canonQuery, canonHeaders, signedHdrs, sha256Hex('')].join('\n');
  const credentialScope = `${dateStamp}/${creds.region}/${creds.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  
  const kDate = hmacSha256(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, creds.region);
  const kService = hmacSha256(kRegion, creds.service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  
  headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHdrs}, Signature=${signature}`;

  // Cách 1: Gửi trực tiếp
  try {
    const res = await axios.get(applyUrl, {
      headers: {
        ...headers,
        'Cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });
    if (res.data?.Result?.InnerUploadAddress) {
      console.log('   ✅ Gửi ApplyUploadInner trực tiếp thành công.');
      return res.data;
    }
  } catch (err) {
    console.log(`   ⚠️ Gọi trực tiếp thất bại (${err.message}). Thử fallback qua Signer Service...`);
  }

  // Cách 2: Fallback qua Signer Service
  try {
    const expr = `
      (async () => {
        const resp = await fetch('${applyUrl}', {
          method: 'GET',
          headers: ${JSON.stringify(headers)},
          credentials: 'include'
        });
        return await resp.text();
      })()
    `;
    const evalResp = await axios.post(`${SIGNER_URL}/eval`, { expr }, { timeout: 10000 });
    const applyData = JSON.parse(evalResp.data.value);
    if (applyData?.Result?.InnerUploadAddress) {
      console.log('   ✅ Gửi ApplyUploadInner qua Signer Service thành công.');
      return applyData;
    }
    throw new Error(JSON.stringify(applyData));
  } catch (err) {
    throw new Error(`ApplyUploadInner thất bại: ${err.message}`);
  }
}

/**
 * Upload buffer trực tiếp lên TOS
 */
async function uploadToTOS(uploadHost, storeUri, authToken, fileBuffer) {
  console.log('📤 Step 3: Đang PUT dữ liệu lên TOS...');
  const putUrl = `https://${uploadHost}/${storeUri}`;
  
  const res = await axios.put(putUrl, fileBuffer, {
    headers: {
      'Authorization': authToken,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(fileBuffer.length),
      'X-Storage-U': '7000343721028862977',
      'content-crc32': 'ignore' // Bypass kiểm tra CRC nhị phân của TikTok
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 60000
  });

  if (res.status === 200 && res.data?.success === 0) {
    console.log('   ✅ Upload TOS thành công.');
    return true;
  }
  throw new Error(`Upload thất bại với status ${res.status}: ${JSON.stringify(res.data)}`);
}

/**
 * Hàm upload chính
 */
async function uploadLossless(fileBuffer) {
  const cookieStr = process.env.TIKTOK_COOKIE;
  if (!cookieStr) {
    throw new Error('Chưa cấu hình TIKTOK_COOKIE trong file .env');
  }

  // 1. Get STS Token
  const token = await getSTSToken(cookieStr);
  const creds = {
    accessKeyId: token.access_key_id,
    secretAccessKey: token.secret_acess_key,
    securityToken: token.session_token,
    region: 'ap-singapore-1',
    service: 'vod'
  };

  // 2. Apply Upload
  const applyData = await applyUpload(creds, cookieStr);
  const node = applyData.Result.InnerUploadAddress.UploadNodes[0];
  const storeUri = node.StoreInfos[0].StoreUri;
  const authToken = node.StoreInfos[0].Auth;
  const uploadHost = node.UploadHost;

  // 3. Upload file
  await uploadToTOS(uploadHost, storeUri, authToken, fileBuffer);

  // 4. Trả về URL bypass
  const publicUrl = `https://p16-oec-va.ibyteimg.com/origin/${storeUri}`;
  return {
    success: true,
    storeUri,
    publicUrl
  };
}

// Chạy trực tiếp từ dòng lệnh nếu được gọi
if (require.main === module) {
  const args = process.argv.slice(2);
  const filePath = args[0];

  if (!filePath) {
    console.log('Sử dụng: node pure_lossless_upload.js <đường_dẫn_file>');
    process.exit(1);
  }

  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    console.error(`File không tồn tại: ${absolutePath}`);
    process.exit(1);
  }

  const fileBuffer = fs.readFileSync(absolutePath);
  console.log(`Đang xử lý file: ${path.basename(absolutePath)} (${fileBuffer.length} bytes)`);

  uploadLossless(fileBuffer)
    .then(res => {
      console.log('\n🎉 UPLOAD THÀNH CÔNG!');
      console.log(`🔗 Link CDN Bypass Vĩnh Viễn: ${res.publicUrl}`);
      console.log(`🔑 Store URI: ${res.storeUri}`);
    })
    .catch(err => {
      console.error('\n❌ UPLOAD THẤT BẠI:');
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { uploadLossless };
