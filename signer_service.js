// signer_service.js — Signer Service mới (cổng 35123)
//
// Service chạy Chromium thật (Playwright) + đăng nhập TikTok, cung cấp API ký đầy đủ:
//   - msToken (cookie phiên từ _mssdk)
//   - X-Bogus (chữ ký query từ _mssdk)
//   - X-Gnarly (chữ ký body từ _mssdk, nếu POST có body)
//
// QUAN TRỌNG: Đảm bảo cookie WAF Token (_waftokenid) luôn mới nhất để upload vào
// bucket lossless `tos-alisg-avt-0068` thay vì bucket công cộng `tiktok-obj` bị nén.
//
// Chạy:  node signer_service.js
// Yêu cầu: .env có TIKTOK_COOKIE (sessionid còn hạn)

require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');

const PORT = Number(process.env.SIGNER_PORT || 35123);
const CONSUMER_COOKIES_JSON = process.env.CONSUMER_COOKIES_JSON;
const TIKTOK_COOKIE = process.env.TIKTOK_COOKIE;

// Ưu tiên CONSUMER_COOKIES_JSON (có đầy đủ _waftokenid), fallback sang TIKTOK_COOKIE
const cookieSource = CONSUMER_COOKIES_JSON || TIKTOK_COOKIE;

if (!cookieSource) {
  console.error('[-] Lỗi: Thiếu CONSUMER_COOKIES_JSON hoặc TIKTOK_COOKIE trong file .env!');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '50mb' }));

let browser = null;
let context = null;
let page = null;
let isInitializing = false;
let mssdkReady = false;
let lastWafRefresh = 0;
const WAF_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 phút

// Parse cookie string hoặc JSON array thành array cookie objects
function parseCookieString(cookieStr) {
  // Thử parse CONSUMER_COOKIES_JSON trước
  if (cookieStr.startsWith('[')) {
    try {
      const arr = JSON.parse(cookieStr);
      console.log(`[+] Đã parse ${arr.length} cookies từ CONSUMER_COOKIES_JSON`);
      return arr
        .filter(c => c.name && c.value) // Bỏ cookie rỗng
        .map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain || '.tiktok.com',
          path: c.path || '/',
          // Playwright chỉ chấp nhận các field chuẩn
        }));
    } catch (e) {
      console.warn('[!] Parse JSON cookies thất bại:', e.message);
    }
  }

  // Fallback: parse format name=value; name=value
  return cookieStr.split(';')
    .map((pair) => {
      const [name, ...rest] = pair.trim().split('=');
      return {
        name: name.trim(),
        value: rest.join('=').trim(),
        domain: '.tiktok.com',
        path: '/',
      };
    })
    .filter(c => c.name && c.value);
}

// Khởi động browser Chromium + đăng nhập TikTok
async function initBrowser() {
  if (isInitializing) return;
  isInitializing = true;

  console.log('[+] Đang khởi chạy Chromium (Playwright)...');
  try {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }

    // CRITICAL: Dùng Chrome thật thay vì Chromium để bypass detection
    const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const fs = require('fs');

    browser = await chromium.launch({
      headless: false,
      executablePath: fs.existsSync(chromePath) ? chromePath : undefined, // Dùng Chrome nếu có
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security',
        '--disable-site-isolation-trials',
        '--disable-features=ImprovedCookieControls',
        '--allow-running-insecure-content',
      ],
    });

    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'Asia/Bangkok',
      permissions: ['geolocation', 'notifications'],
      geolocation: { latitude: 13.7563, longitude: 100.5018 }, // Bangkok
      colorScheme: 'light',
      hasTouch: false,
      isMobile: false,
      deviceScaleFactor: 1,
    });

    // Inject cookie đăng nhập
    const cookies = parseCookieString(cookieSource);
    await context.addCookies(cookies);
    console.log(`[+] Đã inject ${cookies.length} cookies vào browser context.`);

    // CRITICAL: Mask automation detection signals TRƯỚC khi tạo page
    await context.addInitScript(() => {
      // Override navigator.webdriver
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });

      // Override Chrome runtime
      window.chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
      };

      // Override permissions query
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );

      // Override plugins length
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });

      // Override languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
    });

    page = await context.newPage();

    // Xử lý lỗi page
    page.on('pageerror', (err) => {
      console.error('[-] Page error:', err.message);
    });
    page.on('crash', () => {
      console.error('[-] Page crashed! Đang khởi tạo lại...');
      setTimeout(() => initBrowser(), 2000);
    });

    // Refresh WAF token (_waftokenid) — đây là thứ QUAN TRỌNG cho upload lossless
    await refreshWafToken();

    // Thử load _mssdk (cho các endpoint khác cần ký), nhưng KHÔNG bắt buộc cho /api/upload/image/
    console.log('[+] Đang thử load _mssdk (optional cho upload path)...');
    try {
      await page.waitForFunction(
        () => {
          return (
            window._mssdk &&
            typeof window._mssdk.sign === 'function' &&
            window._mssdk._enablePathList &&
            window._mssdk._enablePathList.length > 0
          );
        },
        { timeout: 10000, polling: 500 }
      );
      mssdkReady = true;
      console.log('[+] _mssdk đã sẵn sàng (bonus).');
    } catch (e) {
      console.warn('[!] _mssdk không load được (bỏ qua - không cần cho /api/upload/image/)');
      mssdkReady = false; // Không fatal
    }

    console.log('[+] Signer Service hoạt động (WAF Token ready).');
  } catch (err) {
    console.error('[-] Lỗi khởi tạo browser:', err.message);
    mssdkReady = false;
    setTimeout(() => initBrowser(), 5000);
  } finally {
    isInitializing = false;
  }
}

// Refresh WAF Token bằng cách truy cập trang profile/settings
async function refreshWafToken(force = false) {
  if (!force && Date.now() - lastWafRefresh < WAF_REFRESH_INTERVAL) {
    return; // Chưa đến lúc refresh
  }

  console.log('[+] Đang refresh WAF Token (_waftokenid)...');
  try {
    // Lấy cookie CŨ trước khi refresh
    const cookiesBefore = await context.cookies();
    const wafBefore = cookiesBefore.find((c) => c.name === '_waftokenid');
    const oldValue = wafBefore ? wafBefore.value : null;

    console.log('[+] Đang load https://www.tiktok.com/foryou để refresh WAF...');
    // Truy cập www.tiktok.com để kích hoạt SecSDK sinh _waftokenid
    await page.goto('https://www.tiktok.com/foryou', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(5000); // Đợi SecSDK chạy

    // Kiểm tra cookie _waftokenid SAU khi load trang
    const cookiesAfter = await context.cookies();
    const wafAfter = cookiesAfter.find((c) => c.name === '_waftokenid');
    const newValue = wafAfter ? wafAfter.value : null;

    // UPDATE lastWafRefresh regardless of token change (fix for health endpoint)
    lastWafRefresh = Date.now();

    if (!wafAfter) {
      console.error('[!] ❌ TikTok KHÔNG sinh _waftokenid (phát hiện headless browser)!');
      console.error('    → Upload sẽ vào bucket COMPRESSED (tiktok-obj).');
      console.error('    → Cần dùng browser thật hoặc undetected-chromedriver.');
    } else if (oldValue === newValue) {
      console.warn('[!] ⚠️  _waftokenid KHÔNG đổi (vẫn là cookie cũ từ inject).');
      console.warn('    → TikTok phát hiện automation, SecSDK không chạy.');
      console.warn('    → Upload có thể vào bucket COMPRESSED.');
    } else {
      console.log(`[+] ✅ WAF Token MỚI đã được sinh: ${newValue.slice(0, 30)}...`);
    }
  } catch (err) {
    console.error('[-] Lỗi refresh WAF Token:', err.message);
  }
}

// Kiểm tra và đảm bảo WAF Token hợp lệ trước mỗi request
async function ensureWafToken() {
  const allCookies = await context.cookies();
  const wafCookie = allCookies.find((c) => c.name === '_waftokenid');

  if (!wafCookie || Date.now() - lastWafRefresh > WAF_REFRESH_INTERVAL) {
    console.log('[!] WAF Token không tồn tại hoặc đã hết hạn, đang refresh...');
    await refreshWafToken(true);
  }
}

// Health check endpoint
app.get('/health', async (req, res) => {
  const allCookies = context ? await context.cookies() : [];
  const wafCookie = allCookies.find((c) => c.name === '_waftokenid');

  res.json({
    ok: mssdkReady,
    mssdkReady,
    browserRunning: !!browser,
    pageReady: !!page,
    wafTokenPresent: !!wafCookie,
    wafTokenAge: wafCookie && lastWafRefresh > 0 ? Math.floor((Date.now() - lastWafRefresh) / 1000) : null,
  });
});

// Refresh WAF Token endpoint (independent of mssdkReady)
app.post('/refresh-waf', async (req, res) => {
  if (!page || !context) {
    return res.status(503).json({ error: 'Browser not ready' });
  }

  try {
    console.log('[API] /refresh-waf called - forcing WAF token refresh...');
    await refreshWafToken(true);

    const cookies = await context.cookies();
    const waf = cookies.find(c => c.name === '_waftokenid');

    res.json({
      ok: true,
      wafTokenPresent: !!waf,
      wafTokenValue: waf ? waf.value.substring(0, 30) + '...' : null,
      wafTokenAge: lastWafRefresh > 0 ? Math.floor((Date.now() - lastWafRefresh) / 1000) : 0
    });
  } catch (err) {
    console.error('[API] /refresh-waf error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get all cookies from browser context (GET /cookies)
app.get('/cookies', async (req, res) => {
  try {
    if (!context) {
      return res.status(503).json({ error: 'Browser context chưa được khởi tạo.' });
    }

    const cookies = await context.cookies();
    const waf = cookies.find(c => c.name === '_waftokenid');

    res.json({
      success: true,
      cookies: cookies,
      wafToken: waf ? {
        name: waf.name,
        value: waf.value,
        domain: waf.domain,
        path: waf.path,
        expires: waf.expires,
        age: lastWafRefresh > 0 ? Math.floor((Date.now() - lastWafRefresh) / 1000) : null
      } : null
    });
  } catch (err) {
    console.error('[API] /cookies error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Ký một URL (POST /sign)
app.post('/sign', async (req, res) => {
  const { url, method = 'GET' } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Thiếu tham số url.' });
  }

  if (!page || !mssdkReady) {
    return res.status(503).json({ error: 'Signer Service chưa sẵn sàng.' });
  }

  try {
    // Đảm bảo WAF Token hợp lệ trước khi ký
    await ensureWafToken();

    // Gọi _mssdk.sign() trong page context
    const result = await page.evaluate(
      async ({ targetUrl, targetMethod }) => {
        if (!window._mssdk || typeof window._mssdk.sign !== 'function') {
          return { error: '_mssdk chưa sẵn sàng trong page context.' };
        }

        try {
          // Gọi _mssdk.sign() và đợi kết quả
          const signResult = await window._mssdk.sign(targetUrl, { method: targetMethod });
          return { ok: true, signedUrl: signResult };
        } catch (err) {
          return { error: err.message };
        }
      },
      { targetUrl: url, targetMethod: method }
    );

    if (result.error) {
      return res.status(500).json({ error: result.error });
    }

    // Parse ra các tham số chữ ký
    const signedUrl = result.signedUrl || url;
    const u = new URL(signedUrl);
    const params = {
      msToken: u.searchParams.get('msToken') || null,
      xBogus: u.searchParams.get('X-Bogus') || null,
      xGnarly: u.searchParams.get('X-Gnarly') || null,
    };

    // Kiểm tra evalRes để phát hiện path không được ký
    const evalRes = { ok: !!params.xBogus };

    res.json({ signedUrl, params, evalRes });
  } catch (err) {
    console.error('[-] Lỗi ký URL:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Proxy request (POST /proxy)
app.post('/proxy', async (req, res) => {
  const { url, method = 'GET', headers = {}, body } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Thiếu tham số url.' });
  }

  if (!page) {
    return res.status(503).json({ error: 'Signer Service chưa sẵn sàng (page chưa load).' });
  }

  try {
    // Đảm bảo WAF Token hợp lệ
    await ensureWafToken();

    // Thực hiện fetch TRONG page (để _mssdk tự ký)
    const result = await page.evaluate(
      async ({ targetUrl, targetMethod, targetHeaders, targetBody }) => {
        const opts = {
          method: targetMethod,
          headers: targetHeaders,
          credentials: 'include',
        };
        if (targetBody && targetMethod !== 'GET') {
          opts.body = targetBody;
        }

        try {
          const resp = await fetch(targetUrl, opts);
          const respBody = await resp.text();
          const respHeaders = {};
          resp.headers.forEach((v, k) => {
            respHeaders[k] = v;
          });

          return {
            ok: true,
            status: resp.status,
            respHeaders,
            body: respBody,
            signedUrl: resp.url,
          };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
      { targetUrl: url, targetMethod: method, targetHeaders: headers, targetBody: body }
    );

    if (!result.ok) {
      return res.status(500).json({ error: result.error });
    }

    // Parse params từ signedUrl
    const u = new URL(result.signedUrl);
    const params = {
      msToken: u.searchParams.get('msToken') || null,
      xBogus: u.searchParams.get('X-Bogus') || null,
      xGnarly: u.searchParams.get('X-Gnarly') || null,
    };

    res.json({
      status: result.status,
      respHeaders: result.respHeaders,
      body: result.body,
      signedUrl: result.signedUrl,
      params,
    });
  } catch (err) {
    console.error('[-] Lỗi proxy request:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Upload file qua browser (POST /upload)
app.post('/upload', async (req, res) => {
  const {
    url,
    fileBase64,
    filename = 'avatar.png',
    contentType = 'image/png',
    fieldName = 'file',
    extraHeaders = {},
  } = req.body;

  if (!url || !fileBase64) {
    return res.status(400).json({ error: 'Thiếu tham số url hoặc fileBase64.' });
  }

  if (!page) {
    return res.status(503).json({ error: 'Signer Service chưa sẵn sàng (page chưa load).' });
  }

  try {
    // Đảm bảo WAF Token hợp lệ trước khi upload
    await ensureWafToken();

    // Thực hiện upload TRONG page
    const result = await page.evaluate(
      async ({ targetUrl, b64, fname, ctype, field, headers }) => {
        try {
          // Decode base64 -> Uint8Array -> Blob
          const binStr = atob(b64);
          const len = binStr.length;
          const arr = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            arr[i] = binStr.charCodeAt(i);
          }
          const blob = new Blob([arr], { type: ctype });

          // Tạo FormData
          const fd = new FormData();
          fd.append(field, blob, fname);

          // Gửi upload
          const resp = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: fd,
            credentials: 'include',
          });

          const respBody = await resp.text();
          let respJson = null;
          try {
            respJson = JSON.parse(respBody);
          } catch (e) {}

          return {
            ok: true,
            status: resp.status,
            body: respBody,
            json: respJson,
            signedUrl: resp.url,
            sentBytes: arr.length,
          };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      },
      {
        targetUrl: url,
        b64: fileBase64,
        fname: filename,
        ctype: contentType,
        field: fieldName,
        headers: extraHeaders,
      }
    );

    if (!result.ok) {
      return res.status(500).json({ error: result.error, err: result.error });
    }

    // Parse params
    const u = new URL(result.signedUrl);
    const params = {
      msToken: u.searchParams.get('msToken') || null,
      xBogus: u.searchParams.get('X-Bogus') || null,
      xGnarly: u.searchParams.get('X-Gnarly') || null,
    };

    // Kiểm tra bucket lossless
    const respJson = result.json;
    const urlList = (respJson?.data?.url_list || respJson?.url_list || []);
    let bucketType = 'unknown';
    if (urlList.length > 0) {
      const cdnUrl = urlList[0];
      if (cdnUrl.includes('tos-alisg-avt-0068')) {
        bucketType = 'lossless';
        console.log(`[✓] Upload thành công vào bucket LOSSLESS: tos-alisg-avt-0068`);
      } else if (cdnUrl.includes('tiktok-obj')) {
        bucketType = 'compressed';
        console.warn(`[!] Upload bị định tuyến sang bucket CÔNG CỘNG (bị nén): tiktok-obj`);
        console.warn(`[!] Nguyên nhân: Cookie WAF Token (_waftokenid) có thể đã hết hạn.`);
      }
    }

    res.json({
      ok: result.ok,
      status: result.status,
      body: result.body,
      json: result.json,
      signedUrl: result.signedUrl,
      params,
      sentBytes: result.sentBytes,
      bucketType,
    });
  } catch (err) {
    console.error('[-] Lỗi upload:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Khởi động server
app.listen(PORT, async () => {
  console.log(`[+] Signer Service đang chạy tại http://localhost:${PORT}`);
  console.log('[+] Endpoints:');
  console.log('    GET  /health  — health check');
  console.log('    POST /sign    — ký URL');
  console.log('    POST /proxy   — proxy request');
  console.log('    POST /upload  — upload file');
  console.log('');
  await initBrowser();
});

// Định kỳ kiểm tra WAF Token (mỗi 10 phút)
setInterval(async () => {
  if (page && mssdkReady) {
    await refreshWafToken();
  }
}, 10 * 60 * 1000);

// Cleanup khi tắt
process.on('SIGINT', async () => {
  console.log('\n[+] Đang tắt Signer Service...');
  if (browser) await browser.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
