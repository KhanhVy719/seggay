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
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

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
let lastCapturedQuery = null;

// Parse cookie string hoặc JSON array thành array cookie objects chuẩn hóa cho Puppeteer
function parseCookieString(cookieStr) {
  let rawCookies = [];
  if (cookieStr.trim().startsWith('[')) {
    try {
      rawCookies = JSON.parse(cookieStr);
      console.log(`[+] Đã parse ${rawCookies.length} cookies từ CONSUMER_COOKIES_JSON`);
    } catch (e) {
      console.warn('[!] Parse JSON cookies thất bại:', e.message);
    }
  }

  if (rawCookies.length === 0) {
    rawCookies = cookieStr.split(';')
      .map((pair) => {
        const [name, ...rest] = pair.trim().split('=');
        return {
          name: name.trim(),
          value: rest.join('=').trim(),
          domain: '.tiktok.com',
          path: '/',
        };
      });
  }

  return rawCookies
    .filter(c => c.name && c.value)
    .map(c => {
      let domain = c.domain || '.tiktok.com';
      if (!domain.startsWith('.')) {
        domain = `.${domain}`;
      }
      return {
        name: c.name,
        value: c.value,
        domain: domain,
        path: c.path || '/',
        secure: c.secure !== undefined ? c.secure : true,
        httpOnly: c.httpOnly !== undefined ? c.httpOnly : false,
        sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax'
      };
    });
}

// Khởi động browser Chrome/Chromium qua Puppeteer Stealth + đăng nhập TikTok
async function initBrowser() {
  if (isInitializing) return;
  isInitializing = true;

  console.log('[+] Đang khởi chạy Chrome (Puppeteer Stealth)...');
  try {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }

    const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const fs = require('fs');

    browser = await puppeteer.launch({
      headless: false,
      executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--start-maximized'
      ],
      defaultViewport: null
    });

    page = await browser.newPage();

    // Set User Agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

    // Bật Request Interception để chặn media nặng và bắt query params
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
      const type = req.resourceType();
      
      // Bắt query parameters thực tế từ browser để đồng bộ hóa cho upload
      if (url.includes('/api/') && url.includes('device_id')) {
        try {
          const u = new URL(url);
          const q = u.searchParams.toString();
          if (q) {
            lastCapturedQuery = q;
          }
        } catch (e) {}
      }

      // Chặn các tài nguyên nặng gây crash GPU/hệ thống
      if (['media', 'font', 'image'].includes(type) || 
          url.includes('.mp4') || url.includes('.ts') || url.includes('.m3u8') || url.includes('tos-alisg-pv')) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Inject cookie đăng nhập
    const cookies = parseCookieString(cookieSource);
    await page.setCookie(...cookies);
    console.log(`[+] Đã inject ${cookies.length} cookies vào browser context.`);

    // Xử lý lỗi page
    page.on('error', (err) => {
      console.error('[-] Page error:', err.message);
    });
    page.on('close', () => {
      console.error('[-] Page closed! Đang khởi tạo lại...');
      setTimeout(() => initBrowser(), 2000);
    });

    // Chỉ refresh WAF token nếu chưa có trong cookie inject thô
    const hasWaf = cookies.some(c => c.name === '_waftokenid');
    if (!hasWaf) {
      await refreshWafToken();
    } else {
      console.log('[+] Đã có sẵn WAF Token từ CONSUMER_COOKIES_JSON, bỏ qua refresh tự động.');
      lastWafRefresh = Date.now(); // Đánh dấu thời điểm nạp
      // Đảm bảo page chuyển sang domain tiktok.com thay vì about:blank
      console.log('[+] Đang chuyển hướng page sang https://www.tiktok.com/@tiktok để sẵn sàng...');
      await page.goto('https://www.tiktok.com/@tiktok', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      }).catch(e => console.warn('[!] Chuyển hướng cảnh báo:', e.message));
    }

    // Thử load _mssdk (optional)
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

// Refresh WAF Token bằng cách truy cập trang profile nhẹ và gọi API mồi
async function refreshWafToken(force = false) {
  if (!force && Date.now() - lastWafRefresh < WAF_REFRESH_INTERVAL) {
    return; // Chưa đến lúc refresh
  }

  console.log('[+] Đang refresh WAF Token (_waftokenid)...');
  try {
    // Lấy cookie CŨ trước khi refresh
    const cookiesBefore = await page.cookies('https://www.tiktok.com');
    const wafBefore = cookiesBefore.find((c) => c.name === '_waftokenid');
    const oldValue = wafBefore ? wafBefore.value : null;

    // Xóa WAF Token cũ để ép SecSDK sinh cái mới
    await page.deleteCookie(
      { name: '_waftokenid', domain: '.tiktok.com' },
      { name: '_waftokenid', domain: 'www.tiktok.com' },
      { name: '_waftokenid', domain: '.www.tiktok.com' }
    );
    console.log('[+] Đã xóa WAF Token cũ trong page context để ép sinh mới.');

    console.log('[+] Đang load https://www.tiktok.com/@tiktok để refresh WAF...');
    await page.goto('https://www.tiktok.com/@tiktok', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await new Promise(r => setTimeout(r, 4000));

    console.log('[+] Gọi API upload mồi lần 1 để ép sinh WAF...');
    const activeQuery = lastCapturedQuery || 'aid=1988&app_name=tiktok_web&device_platform=web_pc&region=VN&user_is_login=true';
    const triggerRes = await page.evaluate(async (queryStr) => {
      try {
        const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        const binStr = atob(b64);
        const len = binStr.length;
        const arr = new Uint8Array(len);
        for (let i = 0; i < len; i++) { arr[i] = binStr.charCodeAt(i); }
        const blob = new Blob([arr], { type: 'image/png' });
        const formData = new FormData();
        formData.append('file', blob, 'blob');
        const resp = await fetch(`https://www.tiktok.com/api/upload/image/?${queryStr}`, {
          method: 'POST',
          body: formData,
          credentials: 'include'
        });
        const text = await resp.text();
        let json = null;
        try { json = JSON.parse(text); } catch(e) {}
        return { status: resp.status, ok: resp.ok, json };
      } catch (e) { return { error: e.message }; }
    }, activeQuery);
    console.log(`   Trigger Lần 1 Status: ${triggerRes.status || triggerRes.error}`);
    await new Promise(r => setTimeout(r, 3000));

    console.log('[+] Gọi API upload mồi lần 2 (Đã có WAF Token trong cookie)...');
    const triggerRes2 = await page.evaluate(async (queryStr) => {
      try {
        const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        const binStr = atob(b64);
        const len = binStr.length;
        const arr = new Uint8Array(len);
        for (let i = 0; i < len; i++) { arr[i] = binStr.charCodeAt(i); }
        const blob = new Blob([arr], { type: 'image/png' });
        const formData = new FormData();
        formData.append('file', blob, 'blob');
        const resp = await fetch(`https://www.tiktok.com/api/upload/image/?${queryStr}`, {
          method: 'POST',
          body: formData,
          credentials: 'include'
        });
        const text = await resp.text();
        let json = null;
        try { json = JSON.parse(text); } catch(e) {}
        return { status: resp.status, ok: resp.ok, json };
      } catch (e) { return { error: e.message }; }
    }, activeQuery);
    console.log(`   Trigger Lần 2 Status: ${triggerRes2.status || triggerRes2.error}`);
    if (triggerRes2.json) {
      console.log(`   Trigger Lần 2 Response: ${JSON.stringify(triggerRes2.json).substring(0, 200)}...`);
    }
    await new Promise(r => setTimeout(r, 2000));

    // Kiểm tra cookie _waftokenid SAU khi load và trigger
    const cookiesAfter = await page.cookies('https://www.tiktok.com');
    const wafAfter = cookiesAfter.find((c) => c.name === '_waftokenid');
    const newValue = wafAfter ? wafAfter.value : null;

    lastWafRefresh = Date.now();

    if (!wafAfter) {
      console.error('[!] ❌ TikTok KHÔNG sinh _waftokenid!');
      console.error('    → Upload sẽ vào bucket COMPRESSED (tiktok-obj).');
    } else if (oldValue === newValue) {
      console.warn('[!] ⚠️  _waftokenid KHÔNG đổi (vẫn là cookie cũ từ inject).');
    } else {
      console.log(`[+] ✅ WAF Token MỚI đã được sinh: ${newValue.slice(0, 30)}...`);
    }
  } catch (err) {
    console.error('[-] Lỗi refresh WAF Token:', err.message);
  }
}

// Kiểm tra và đảm bảo WAF Token hợp lệ trước mỗi request
async function ensureWafToken() {
  const allCookies = await page.cookies('https://www.tiktok.com');
  const wafCookie = allCookies.find((c) => c.name === '_waftokenid');

  if (!wafCookie) {
    console.log('[!] WAF Token không tồn tại, đang refresh...');
    await refreshWafToken(true);
  }
}

// Health check endpoint
app.get('/health', async (req, res) => {
  const allCookies = page ? await page.cookies('https://www.tiktok.com') : [];
  const wafCookie = allCookies.find((c) => c.name === '_waftokenid');

  res.json({
    ok: mssdkReady,
    mssdkReady,
    browserRunning: !!browser,
    pageReady: !!page,
    wafTokenPresent: !!wafCookie,
    wafTokenAge: wafCookie && lastWafRefresh > 0 ? Math.floor((Date.now() - lastWafRefresh) / 1000) : null,
    lastCapturedQuery,
  });
});

// Refresh WAF Token endpoint (independent of mssdkReady)
app.post('/refresh-waf', async (req, res) => {
  if (!page) {
    return res.status(503).json({ error: 'Browser not ready' });
  }

  try {
    console.log('[API] /refresh-waf called - forcing WAF token refresh...');
    await refreshWafToken(true);

    const cookies = await page.cookies();
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
    if (!page) {
      return res.status(503).json({ error: 'Browser page chưa được khởi tạo.' });
    }

    const cookies = await page.cookies('https://www.tiktok.com');
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

// Merge query parameters từ browser context để đồng bộ hóa danh tính thiết bị
function mergeCapturedQuery(targetUrl) {
  if (!lastCapturedQuery) {
    console.warn('[!] Chưa bắt được query params thật từ browser context. Giữ nguyên URL upload.');
    return targetUrl;
  }
  try {
    const u = new URL(targetUrl);
    const captured = new URLSearchParams(lastCapturedQuery);
    
    // Đồng bộ các tham số định danh quan trọng của trình duyệt hiện tại
    const keysToSync = [
      'device_id', 'odinId', 'WebIdLastTime', 'verifyFp', 
      'browser_version', 'browser_name', 'browser_online', 
      'browser_platform', 'device_platform', 'os'
    ];
    
    let syncCount = 0;
    keysToSync.forEach(key => {
      if (captured.has(key)) {
        u.searchParams.set(key, captured.get(key));
        syncCount++;
      }
    });
    
    console.log(`[+] Đã đồng bộ ${syncCount} tham số thiết bị thực tế vào URL upload.`);
    return u.toString();
  } catch (e) {
    console.error('[-] Lỗi mergeCapturedQuery:', e.message);
    return targetUrl;
  }
}

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

    // Đồng bộ query parameters với dấu vân tay thật của browser hiện tại
    const finalUrl = mergeCapturedQuery(url);

    // In ra các cookies quan trọng trước khi upload để debug
    const allCookies = await page.cookies('https://www.tiktok.com');
    const waf = allCookies.find(c => c.name === '_waftokenid');
    const session = allCookies.find(c => c.name === 'sessionid');
    console.log(`[DEBUG /upload] wafTokenPresent: ${!!waf}, sessionid: ${session ? session.value.substring(0, 15) : 'none'}`);
    if (waf) {
      console.log(`[DEBUG /upload] wafTokenValue: ${waf.value.substring(0, 45)}...`);
    }

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
        targetUrl: finalUrl,
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
  if (page) {
    const cookies = await page.cookies();
    const waf = cookies.find(c => c.name === '_waftokenid');
    if (!waf) {
      console.log('[Interval] WAF Token bị mất, tiến hành refresh...');
      await refreshWafToken(true);
    }
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
