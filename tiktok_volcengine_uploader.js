// tiktok_volcengine_uploader.js
// Upload lossless lên TikTok CDN qua Volcengine/ImageX AWS4 - KHÔNG CẦN BROWSER

const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');

/**
 * Hàm helper cho AWS4 signing
 */
function hmacSha256(key, msg) {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest();
}

function sha256Hex(data) {
  const isBuffer = Buffer.isBuffer(data);
  return crypto.createHash('sha256').update(data, isBuffer ? undefined : 'utf8').digest('hex');
}

/**
 * Parse cookie string thành object
 */
function parseCookies(cookieString) {
  const cookies = {};
  cookieString.split(';').forEach(cookie => {
    const [key, value] = cookie.trim().split('=');
    if (key && value) cookies[key] = value;
  });
  return cookies;
}

/**
 * Tạo canonical request cho AWS4 signature
 */
function createCanonicalRequest(method, url, headers, payload = '') {
  const urlObj = new URL(url);

  // Canonical URI
  const canonicalUri = urlObj.pathname || '/';

  // Canonical Query String - encode theo AWS4 spec
  const params = [];
  urlObj.searchParams.forEach((value, key) => {
    params.push([encodeURIComponent(key), encodeURIComponent(value)]);
  });
  params.sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    return a[1] < b[1] ? -1 : 1;
  });
  const canonicalQuery = params.map(p => `${p[0]}=${p[1]}`).join('&');

  // Canonical Headers - phải lowercase và trim
  const headerMap = {};
  Object.keys(headers).forEach(k => {
    const lower = k.toLowerCase();
    headerMap[lower] = String(headers[k]).trim();
  });

  const sortedKeys = Object.keys(headerMap).sort();
  const canonicalHeaders = sortedKeys
    .map(k => `${k}:${headerMap[k]}`)
    .join('\n') + '\n';

  const signedHeaders = sortedKeys.join(';');

  // Payload hash - empty string cho GET request
  const payloadHash = sha256Hex(payload);

  const canonical = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  return { canonical, signedHeaders };
}

/**
 * Ký request theo chuẩn AWS4
 */
function signAWS4(credentials, method, url, headers, payload = '') {
  const { accessKeyId, secretAccessKey, securityToken, region, service } = credentials;

  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

  // Clone headers để tránh mutate
  const signHeaders = { ...headers };

  // Thêm headers bắt buộc
  signHeaders['x-amz-date'] = amzDate;
  if (securityToken) {
    signHeaders['x-amz-security-token'] = securityToken;
  }

  // Tạo canonical request
  const { canonical, signedHeaders } = createCanonicalRequest(method, url, signHeaders, payload);

  // Debug
  console.log('     [DEBUG] Canonical Request:');
  console.log(canonical.split('\n').map(l => '       ' + l).join('\n'));

  // Tạo string to sign
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonical)
  ].join('\n');

  console.log('     [DEBUG] String to Sign:');
  console.log(stringToSign.split('\n').map(l => '       ' + l).join('\n'));

  // Tính signature
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  console.log('     [DEBUG] Signature:', signature);

  // Thêm Authorization header
  signHeaders['authorization'] = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return signHeaders;
}

/**
 * Bước 1: Lấy STS credentials từ TikTok
 */
async function getSTSCredentials(cookieString) {
  console.log('[1/4] Lấy STS credentials từ TikTok...');

  try {
    const response = await axios.get('https://www.tiktok.com/api/v1/video/upload/auth/', {
      params: { aid: '1988' },
      headers: {
        'Cookie': cookieString,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.tiktok.com/upload'
      },
      timeout: 30000
    });

    if (!response.data || !response.data.video_token_v5) {
      throw new Error('Không nhận được STS token. Response: ' + JSON.stringify(response.data));
    }

    const token = response.data.video_token_v5;
    console.log('  ✅ Nhận STS token thành công');
    console.log(`     - AccessKeyId: ${token.access_key_id.substring(0, 20)}...`);
    console.log(`     - Region: ap-singapore-1`);

    return {
      accessKeyId: token.access_key_id,
      secretAccessKey: token.secret_acess_key, // Lưu ý typo "acess" từ API
      securityToken: token.session_token,
      region: 'ap-singapore-1',
      service: 'vod'
    };
  } catch (error) {
    console.error('  ❌ Lỗi khi lấy STS credentials:', error.message);
    if (error.response) {
      console.error('     Status:', error.response.status);
      console.error('     Data:', JSON.stringify(error.response.data).substring(0, 200));
    }
    throw error;
  }
}

/**
 * Bước 2: ApplyUploadInner - Xin quyền upload
 */
async function applyUploadInner(credentials, cookieString) {
  console.log('[2/4] Gọi ApplyUploadInner để xin quyền upload...');

  const applyUrl = 'https://www.tiktok.com/top/v1';
  const params = new URLSearchParams({
    'Action': 'ApplyUploadInner',
    'Version': '2020-11-19',
    'SpaceName': 'tiktok_avatar',
    'FileType': 'image',
    'IsInner': '1',
    's': 'yqpl39xuexr',
    'device_platform': 'web'
  });

  const fullUrl = `${applyUrl}?${params.toString()}`;
  const urlObj = new URL(fullUrl);

  // Headers cơ bản
  const headers = {
    'host': urlObj.host,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'cookie': cookieString
  };

  // Ký AWS4
  const signedHeaders = signAWS4(credentials, 'GET', fullUrl, headers);

  try {
    const response = await axios.get(fullUrl, {
      headers: signedHeaders,
      timeout: 30000
    });

    if (!response.data || !response.data.Result || !response.data.Result.InnerUploadAddress) {
      throw new Error('Response không hợp lệ: ' + JSON.stringify(response.data));
    }

    const node = response.data.Result.InnerUploadAddress.UploadNodes[0];
    const storeInfo = node.StoreInfos[0];

    console.log('  ✅ Nhận thông tin upload thành công');
    console.log(`     - UploadHost: ${node.UploadHost}`);
    console.log(`     - StoreUri: ${storeInfo.StoreUri.substring(0, 50)}...`);
    console.log(`     - Full Response:`, JSON.stringify(response.data, null, 2).substring(0, 1000));

    return {
      uploadHost: node.UploadHost,
      storeUri: storeInfo.StoreUri,
      authToken: storeInfo.Auth,
      sessionKey: node.SessionKey,
      fullResponse: response.data
    };
  } catch (error) {
    console.error('  ❌ Lỗi khi gọi ApplyUploadInner:', error.message);
    if (error.response) {
      console.error('     Status:', error.response.status);
      console.error('     Data:', JSON.stringify(error.response.data).substring(0, 200));
    }
    throw error;
  }
}

/**
 * Bước 3.5: CommitUploadInner - Xác nhận upload hoàn tất
 */
async function commitUploadInner(credentials, cookieString, sessionKey, callbackArgs) {
  console.log('[3.5/4] Gọi CommitUploadInner để xác nhận upload...');

  const commitUrl = 'https://www.tiktok.com/top/v1';
  const params = new URLSearchParams({
    'Action': 'CommitUploadInner',
    'Version': '2020-11-19',
    'SpaceName': 'tiktok',
    's': 'yqpl39xuexr',
    'device_platform': 'web'
  });

  const fullUrl = `${commitUrl}?${params.toString()}`;
  const urlObj = new URL(fullUrl);

  const body = JSON.stringify({
    SessionKey: sessionKey,
    CallbackArgs: callbackArgs
  });

  const headers = {
    'host': urlObj.host,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'content-type': 'application/json',
    'cookie': cookieString
  };

  const signedHeaders = signAWS4(credentials, 'POST', fullUrl, headers, body);

  try {
    const response = await axios.post(fullUrl, body, {
      headers: signedHeaders,
      timeout: 30000
    });

    console.log('  ✅ Commit thành công');
    console.log('     Response:', JSON.stringify(response.data).substring(0, 300));

    return response.data;
  } catch (error) {
    console.error('  ❌ Lỗi khi commit:', error.message);
    if (error.response) {
      console.error('     Status:', error.response.status);
      console.error('     Data:', JSON.stringify(error.response.data).substring(0, 200));
    }
    throw error;
  }
}

/**
 * Bước 3: PUT file lên TOS storage
 */
async function putFileToTOS(uploadInfo, fileBuffer, userId = '7000343721028862977') {
  console.log('[3/4] PUT file lên TOS storage...');
  console.log(`     - File size: ${fileBuffer.length} bytes`);

  const uploadUrl = `https://${uploadInfo.uploadHost}/${uploadInfo.storeUri}`;

  try {
    const response = await axios.put(uploadUrl, fileBuffer, {
      headers: {
        'Authorization': uploadInfo.authToken,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(fileBuffer.length),
        'X-Storage-U': userId,
        'content-crc32': 'ignore' // QUAN TRỌNG: Bypass CRC check
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 60000
    });

    console.log('  ✅ Upload thành công!');
    console.log(`     - HTTP Status: ${response.status}`);

    return true;
  } catch (error) {
    console.error('  ❌ Lỗi khi PUT file:', error.message);
    if (error.response) {
      console.error('     Status:', error.response.status);
      console.error('     Headers:', JSON.stringify(error.response.headers));
    }
    throw error;
  }
}

/**
 * Bước 4: Tạo public URL vĩnh viễn
 */
function createPublicURL(storeUri) {
  console.log('[4/4] Tạo public URL vĩnh viễn...');

  // Sử dụng domain OEC (e-commerce) không yêu cầu signature
  const publicUrl = `https://p16-oec-va.ibyteimg.com/origin/${storeUri}`;

  console.log('  ✅ URL tạo thành công:');
  console.log(`     ${publicUrl}`);

  return publicUrl;
}

/**
 * MAIN FUNCTION: Upload lossless không cần browser
 */
async function uploadLosslessVolcengine(fileBuffer, cookieString, userId) {
  console.log('\n========================================');
  console.log('TikTok Volcengine Lossless Upload');
  console.log('========================================\n');

  try {
    // Bước 1: Lấy STS credentials
    const credentials = await getSTSCredentials(cookieString);

    // Bước 2: ApplyUploadInner
    const uploadInfo = await applyUploadInner(credentials, cookieString);

    // Bước 3: PUT file
    await putFileToTOS(uploadInfo, fileBuffer, userId);

    // Bước 3.5: Commit upload
    const commitResult = await commitUploadInner(
      credentials,
      cookieString,
      uploadInfo.sessionKey,
      uploadInfo.storeUri
    );

    // Bước 4: Tạo public URL
    const publicUrl = createPublicURL(uploadInfo.storeUri);

    console.log('\n========================================');
    console.log('✅ UPLOAD HOÀN TẤT');
    console.log('========================================\n');

    return {
      success: true,
      url: publicUrl,
      storeUri: uploadInfo.storeUri
    };

  } catch (error) {
    console.error('\n❌ UPLOAD THẤT BẠI:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Helper: Load cookie từ file JSON
 */
function loadCookiesFromJSON(jsonFilePath) {
  const data = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
  // Support cả format array và object {cookies: [...]}
  const cookiesArray = Array.isArray(data) ? data : data.cookies;
  return cookiesArray
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Helper: Tạo test image buffer
 */
function createTestImageBuffer() {
  // Tạo PNG header hợp lệ
  const pngSignature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR chunk (1x1 pixel, RGB)
  const ihdr = Buffer.from([
    0x00, 0x00, 0x00, 0x0D, // Length: 13
    0x49, 0x48, 0x44, 0x52, // Type: IHDR
    0x00, 0x00, 0x00, 0x01, // Width: 1
    0x00, 0x00, 0x00, 0x01, // Height: 1
    0x08, 0x02, 0x00, 0x00, 0x00, // Bit depth, color type, compression, filter, interlace
    0x90, 0x77, 0x53, 0xDE  // CRC
  ]);

  // IDAT chunk (compressed image data)
  const idat = Buffer.from([
    0x00, 0x00, 0x00, 0x0C, // Length: 12
    0x49, 0x44, 0x41, 0x54, // Type: IDAT
    0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00,
    0x18, 0xDD, 0x8D, 0xB4  // CRC
  ]);

  // IEND chunk
  const iend = Buffer.from([
    0x00, 0x00, 0x00, 0x00, // Length: 0
    0x49, 0x45, 0x4E, 0x44, // Type: IEND
    0xAE, 0x42, 0x60, 0x82  // CRC
  ]);

  // Payload ẩn (binary data sau PNG)
  const hiddenPayload = Buffer.from('HIDDEN_BINARY_DATA_TEST_12345');

  return Buffer.concat([pngSignature, ihdr, idat, iend, hiddenPayload]);
}

// Export
module.exports = {
  uploadLosslessVolcengine,
  loadCookiesFromJSON,
  createTestImageBuffer
};

// CLI test nếu chạy trực tiếp
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Usage: node tiktok_volcengine_uploader.js <cookies.json> [file.png] [userId]');
    console.log('Example: node tiktok_volcengine_uploader.js cookies.json test.png 7000343721028862977');
    process.exit(1);
  }

  const cookieFile = args[0];
  const imageFile = args[1];
  const userId = args[2];

  (async () => {
    try {
      const cookieString = loadCookiesFromJSON(cookieFile);
      const fileBuffer = imageFile
        ? fs.readFileSync(imageFile)
        : createTestImageBuffer();

      const result = await uploadLosslessVolcengine(fileBuffer, cookieString, userId);

      if (result.success) {
        console.log('\nPublic URL:', result.url);
        process.exit(0);
      } else {
        console.error('\nUpload failed:', result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error('Fatal error:', error);
      process.exit(1);
    }
  })();
}
