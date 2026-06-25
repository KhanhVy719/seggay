// server_extended.js
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

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const axios = require('axios');
const tiktokService = require('./tiktok');
const originalServer = require('./server');

const app = originalServer;
const PORT = Number(process.env.PORT || 3000);

process.on('uncaughtException', err => {
  console.error('[fatal] uncaughtException:', err && err.stack ? err.stack : err);
});

process.on('unhandledRejection', err => {
  console.error('[fatal] unhandledRejection:', err && err.stack ? err.stack : err);
});
const ROOT = process.cwd();
const MANIFEST_ROOT = path.join(ROOT, 'upload', 'tiktok', 'manifests');
const DASHBOARD_DIST = path.join(ROOT, 'dashboard', 'dist');

function manifestPath(jobId) {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(String(jobId || ''))) {
    throw new Error('Invalid jobId');
  }
  return path.join(MANIFEST_ROOT, `${jobId}.json`);
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

async function loadManifest(jobId) {
  const manifest = await readJson(manifestPath(jobId));
  if (!manifest || !Array.isArray(manifest.segments)) throw new Error('Invalid manifest');
  return manifest;
}

function clampHeaderInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function getManifestSizeBytes(manifest) {
  const sourceSize = Number(manifest.source?.sizeBytes || manifest.sourceSize || manifest.size || 0);
  if (Number.isFinite(sourceSize) && sourceSize > 0) return sourceSize;
  return (manifest.segments || []).reduce((sum, segment) => {
    const bytes = Number(segment.tsBytes || segment.payloadBytes || segment.carrierBytes || segment.pngBytes || 0);
    return sum + (Number.isFinite(bytes) ? bytes : 0);
  }, 0);
}

function recoverNestedCookie(cookie) {
  if (!cookie?.name || !cookie?.value) return null;
  const name = String(cookie.name).trim();
  const value = String(cookie.value).trim();

  if (name.startsWith('{') && (name.includes('"cookies"') || name.includes("'cookies'"))) {
    const recovered = parseCookieInput(`${name}=${value}`);
    if (recovered.length > 1) return recovered;
  }

  return { name, value };
}

function normalizeCookieList(list) {
  return (Array.isArray(list) ? list : [])
    .flatMap(cookie => recoverNestedCookie(cookie) || [])
    .filter(cookie => cookie && cookie.name && cookie.value)
    .map(cookie => ({ name: String(cookie.name), value: String(cookie.value) }));
}

function parseCookiePairs(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const rows = raw.includes('\n') ? raw.split(/\r?\n/) : raw.split(';');
  return rows
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const idx = part.indexOf('=');
      if (idx === -1) return null;
      return { name: part.slice(0, idx).trim(), value: part.slice(idx + 1).trim() };
    })
    .filter(cookie => cookie?.name && cookie?.value);
}

function parseJSObject(str) {
  // Strip comments first
  str = str.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  
  let index = 0;
  
  function skipWhitespace() {
    while (index < str.length && /\s/.test(str[index])) {
      index++;
    }
  }
  
  function parseString(quoteChar) {
    let val = '';
    index++; // skip open quote
    while (index < str.length) {
      const char = str[index];
      if (char === '\\') {
        val += str[index + 1];
        index += 2;
      } else if (char === quoteChar) {
        index++; // skip close quote
        return val;
      } else {
        val += char;
        index++;
      }
    }
    return val;
  }
  
  function parseValue() {
    skipWhitespace();
    if (index >= str.length) return null;
    const char = str[index];
    if (char === '"' || char === "'") {
      return parseString(char);
    }
    if (char === '{') {
      return parseObject();
    }
    if (char === '[') {
      return parseArray();
    }
    // Number, boolean, null, undefined, or unquoted identifier
    let valStr = '';
    while (index < str.length && !/[\s,}:\]]/.test(str[index])) {
      valStr += str[index];
      index++;
    }
    if (valStr === 'true') return true;
    if (valStr === 'false') return false;
    if (valStr === 'null') return null;
    if (valStr === 'undefined') return undefined;
    if (!isNaN(Number(valStr))) return Number(valStr);
    return valStr;
  }
  
  function parseObject() {
    const obj = {};
    index++; // skip '{'
    while (index < str.length) {
      skipWhitespace();
      if (str[index] === '}') {
        index++;
        return obj;
      }
      // Parse key
      let key = '';
      const char = str[index];
      if (char === '"' || char === "'") {
        key = parseString(char);
      } else {
        // unquoted key
        while (index < str.length && /[a-zA-Z0-9_$]/.test(str[index])) {
          key += str[index];
          index++;
        }
      }
      
      skipWhitespace();
      if (str[index] !== ':') {
        break;
      }
      index++; // skip ':'
      
      const val = parseValue();
      obj[key] = val;
      
      skipWhitespace();
      if (str[index] === ',') {
        index++;
      }
    }
    return obj;
  }
  
  function parseArray() {
    const arr = [];
    index++; // skip '['
    while (index < str.length) {
      skipWhitespace();
      if (str[index] === ']') {
        index++;
        return arr;
      }
      arr.push(parseValue());
      skipWhitespace();
      if (str[index] === ',') {
        index++;
      }
    }
    return arr;
  }
  
  skipWhitespace();
  if (str[index] === '{') {
    return parseObject();
  } else if (str[index] === '[') {
    return parseArray();
  }
  return null;
}

function parseCookieInput(input) {
  if (Array.isArray(input)) return normalizeCookieList(input);
  if (Array.isArray(input?.cookies)) return normalizeCookieList(input.cookies);

  const raw = String(input || '').trim();
  if (!raw) return [];

  try {
    const parsed = parseJSObject(raw);
    if (parsed) {
      if (Array.isArray(parsed)) return normalizeCookieList(parsed);
      if (Array.isArray(parsed?.cookies)) return normalizeCookieList(parsed.cookies);
      if (typeof parsed === 'object') {
        if (parsed.name && parsed.value) {
          return normalizeCookieList([parsed]);
        }
      }
    }
  } catch (_) {
    // ignore
  }

  return parseCookiePairs(raw);
}


function parseConsumerCookies() {
  return parseCookieInput(process.env.CONSUMER_COOKIES_JSON || '');
}

function parseCookieHeader(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const idx = part.indexOf('=');
      if (idx === -1) return null;
      return {
        name: part.slice(0, idx).trim(),
        value: part.slice(idx + 1).trim(),
      };
    })
    .filter(cookie => cookie?.name && cookie?.value);
}

function buildCookieHeader(cookies) {
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

function getHealthCookieSource() {
  const consumerCookies = parseConsumerCookies();
  if (consumerCookies.length) {
    return {
      cookies: consumerCookies,
      cookieHeader: buildCookieHeader(consumerCookies),
      cookieCount: consumerCookies.length,
    };
  }

  const rawCookieHeader = String(process.env.TIKTOK_COOKIE || '').trim();
  const rawCookies = parseCookieHeader(rawCookieHeader);
  return {
    cookies: rawCookies,
    cookieHeader: rawCookieHeader,
    cookieCount: rawCookies.length,
  };
}

function pickCsrfToken(cookies) {
  const names = ['tt_csrf_token', 'csrf_session_id', 'passport_csrf_token', 'passport_csrf_token_default', 'ac_csrftoken', 'tt_csrf_token_default'];
  for (const name of names) {
    const found = cookies.find(cookie => cookie.name === name);
    if (found?.value) return found.value;
  }
  return process.env.TIKTOK_CSRF_TOKEN || '';
}

function readEnvSummary() {
  const healthCookieSource = getHealthCookieSource();
  const hasCookie = Boolean(process.env.TIKTOK_COOKIE) || (healthCookieSource.cookieCount > 0);
  const hasCsrf = Boolean(process.env.TIKTOK_CSRF_TOKEN);
  const hasOrg = Boolean(process.env.TIKTOK_ORG_ID);
  const cookieCount = healthCookieSource.cookieCount;
  return {
    hasCookie,
    hasCsrf,
    hasOrg,
    cookieCount,
    xBogusReady: Boolean(require('xbogus')),
  };
}

async function checkConsumerCookieHealth() {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const cookieSource = getHealthCookieSource();
  const userAgent = process.env.USER_AGENT || tiktokService.config.userAgent;

  const base = {
    status: 'unknown',
    alive: false,
    checkedAt,
    latencyMs: 0,
    cookieCount: cookieSource.cookieCount,
    message: '',
  };

  if (!cookieSource.cookieHeader) {
    return { ...base, status: 'missing', message: 'Chưa có Cookie TikTok đăng nhập để kiểm tra.' };
  }

  try {
    const response = await axios.get(
      'https://www.tiktok.com/api/v1/video/upload/auth/?aid=1988',
      {
        timeout: 12000,
        headers: {
          'user-agent': userAgent,
          'cookie': cookieSource.cookieHeader,
          'referer': 'https://www.tiktok.com/',
        },
        validateStatus: status => status >= 200 && status < 500,
      }
    );

    const latencyMs = Date.now() - startedAt;
    const hasToken = Boolean(response.data?.video_token_v5?.access_key_id);
    const msg = response.data?.message || response.data?.status_msg || '';

    if (hasToken) {
      return { ...base, status: 'alive', alive: true, latencyMs, message: 'Cookie còn sống, lấy STS Upload Token thành công.' };
    }
    
    return { 
      ...base, 
      status: 'dead', 
      alive: false, 
      latencyMs, 
      message: `Cookie hết hạn hoặc không đủ quyền upload (${response.status}${msg ? `: ${msg}` : ' - Thiếu video_token_v5'}).` 
    };
  } catch (err) {
    return {
      ...base,
      status: 'unknown',
      alive: false,
      latencyMs: Date.now() - startedAt,
      message: `Không thể kiểm tra TikTok lúc này: ${err.code || err.message}`,
    };
  }
}

function getXbogusStatusCode(data) {
  if (!data || typeof data !== 'object' || !Object.prototype.hasOwnProperty.call(data, 'status_code')) return null;
  return data.status_code;
}

async function signXbogusForHealth(query, userAgent) {
  if (process.env.USE_RPC_SIGNER === 'true') {
    const rpcSigner = require('./xbogus_jsdom');
    return {
      signerMode: 'jsdom-rpc',
      signature: await rpcSigner.sign(query, userAgent),
    };
  }

  const generateBogus = require('xbogus');
  return {
    signerMode: 'local',
    signature: generateBogus(query, userAgent),
  };
}

async function checkXbogusHealth() {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const userAgent = process.env.USER_AGENT || tiktokService.config.userAgent;
  const base = {
    status: 'unknown',
    ok: false,
    checkedAt,
    latencyMs: 0,
    signerMode: process.env.USE_RPC_SIGNER === 'true' ? 'jsdom-rpc' : 'local',
    httpStatus: 0,
    tikTokStatusCode: null,
    message: '',
  };

  const query = new URLSearchParams({
    aid: '1988',
    app_name: 'tiktok_web',
    device_platform: 'web_pc',
    user_is_login: 'true',
  }).toString();

  let signature = '';
  let signerMode = base.signerMode;
  try {
    const signed = await signXbogusForHealth(query, userAgent);
    signature = signed.signature;
    signerMode = signed.signerMode;
  } catch (err) {
    return {
      ...base,
      signerMode,
      status: 'missing',
      latencyMs: Date.now() - startedAt,
      message: `Không sinh được chữ ký X-Bogus bằng ${signerMode === 'jsdom-rpc' ? 'JSDOM RPC' : 'Local signer'}: ${err.message}`,
    };
  }

  if (!signature) {
    return {
      ...base,
      signerMode,
      status: 'failed',
      latencyMs: Date.now() - startedAt,
      message: 'Bộ ký X-Bogus trả về chữ ký rỗng.',
    };
  }

  try {
    const response = await axios.post(`https://www.tiktok.com/api/upload/image/?${query}&X-Bogus=${encodeURIComponent(signature)}`, {}, {
      timeout: 12000,
      maxRedirects: 0,
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'cache-control': 'no-cache',
        origin: 'https://www.tiktok.com',
        pragma: 'no-cache',
        referer: 'https://www.tiktok.com/',
        'tt-csrf-token': 'healthcheck-only-dummy-token',
        'user-agent': userAgent,
      },
      validateStatus: status => status >= 200 && status < 500,
    });

    const latencyMs = Date.now() - startedAt;
    const tikTokStatusCode = getXbogusStatusCode(response.data);
    const acceptedCodes = new Set([0, 7, 8, 9, '0', '7', '8', '9']);
    const wafRejected = response.status === 400 || response.status === 403;

    if (acceptedCodes.has(tikTokStatusCode)) {
      return {
        ...base,
        status: 'passed',
        ok: true,
        checkedAt,
        latencyMs,
        signerMode,
        httpStatus: response.status,
        tikTokStatusCode,
        message: 'Chữ ký X-Bogus hợp lệ: TikTok đã nhận request và trả về mã API handler thay vì chặn ở lớp WAF.',
      };
    }

    return {
      ...base,
      status: 'failed',
      ok: false,
      checkedAt,
      latencyMs,
      signerMode,
      httpStatus: response.status,
      tikTokStatusCode,
      message: wafRejected
        ? 'TikTok chặn ở lớp WAF/signature, bộ ký X-Bogus có thể đã lỗi thời.'
        : 'TikTok không trả về status_code hợp lệ cho API handler, cần kiểm tra lại bộ ký X-Bogus.',
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const response = err.response;
    const tikTokStatusCode = getXbogusStatusCode(response?.data);
    if (tikTokStatusCode === 7 || tikTokStatusCode === 8 || tikTokStatusCode === '7' || tikTokStatusCode === '8') {
      return {
        ...base,
        status: 'passed',
        ok: true,
        checkedAt,
        latencyMs,
        signerMode,
        httpStatus: response?.status || 0,
        tikTokStatusCode,
        message: 'Chữ ký X-Bogus hợp lệ: request vượt lớp chữ ký và dừng ở bước quyền/session.',
      };
    }

    return {
      ...base,
      status: 'unknown',
      ok: false,
      checkedAt,
      latencyMs,
      signerMode,
      httpStatus: response?.status || 0,
      tikTokStatusCode,
      message: `Không thể kiểm tra X-Bogus lúc này: ${err.code || err.message}`,
    };
  }
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sanitizeUploadFilename(value) {
  const safe = String(value || 'upload.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe || 'upload.bin';
}

function streamRequestToFile(req, filePath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filePath);
    let bytes = 0;
    let settled = false;

    function cleanup() {
      req.off('data', onData);
      req.off('aborted', onAborted);
      req.off('error', onError);
      output.off('error', onError);
      output.off('finish', onFinish);
    }

    function finish(err) {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(bytes);
    }

    function onData(chunk) {
      bytes += chunk.length;
    }

    function onAborted() {
      const err = new Error('Upload bị hủy trước khi server nhận xong file.');
      output.destroy(err);
      finish(err);
    }

    function onError(err) {
      finish(err);
    }

    function onFinish() {
      finish();
    }

    req.on('data', onData);
    req.on('aborted', onAborted);
    req.on('error', onError);
    output.on('error', onError);
    output.on('finish', onFinish);
    req.pipe(output);
  });
}

function runDecodedCli(jobId, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'decoded.js'), outputPath, jobId], {
      cwd: ROOT,
      env: { ...process.env, TIKTOK_DECODE_JOB_ID: jobId },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      process.stdout.write(text);
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve(outputPath);
      reject(new Error(stderr.trim() || `decoded.js exited with code ${code}`));
    });
  });
}

app.get('/api/server/status', (req, res) => {
  res.json({
    status: 'active',
    port: PORT,
    uptime: process.uptime(),
    env: readEnvSummary(),
  });
});

app.post('/api/env/validate', (req, res) => {
  res.json({ ok: true, env: readEnvSummary() });
});

app.get('/api/cookies/health', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await checkConsumerCookieHealth());
});

app.get('/api/xbogus/health', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await checkXbogusHealth());
});

app.post('/api/cookies', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const cookies = parseCookieInput(req.body);

    if (!cookies.length) {
      return res.status(400).json({ ok: false, error: 'Cookie trống hoặc sai định dạng.' });
    }

    const cookiesJson = JSON.stringify(cookies);
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const envPath = path.join(ROOT, '.env');
    let raw = await fsp.readFile(envPath, 'utf8').catch(() => '');

    // Cập nhật hoặc thêm CONSUMER_COOKIES_JSON
    const lineConsumer = `CONSUMER_COOKIES_JSON=${cookiesJson}`;
    if (/^CONSUMER_COOKIES_JSON=.*$/m.test(raw)) {
      raw = raw.replace(/^CONSUMER_COOKIES_JSON=.*$/m, lineConsumer);
    } else {
      raw = `${raw}${raw.endsWith('\n') || !raw ? '' : '\n'}${lineConsumer}\n`;
    }

    // Cập nhật hoặc thêm TIKTOK_COOKIE
    const lineTiktok = `TIKTOK_COOKIE='${cookieStr}'`;
    if (/^TIKTOK_COOKIE=.*$/m.test(raw)) {
      raw = raw.replace(/^TIKTOK_COOKIE=.*$/m, lineTiktok);
    } else {
      raw = `${raw}${raw.endsWith('\n') || !raw ? '' : '\n'}${lineTiktok}\n`;
    }

    await fsp.writeFile(envPath, raw, 'utf8');
    process.env.CONSUMER_COOKIES_JSON = cookiesJson;
    process.env.TIKTOK_COOKIE = cookieStr;

    res.json({ ok: true, cookieCount: cookies.length, env: readEnvSummary() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/xbogus/refresh', (req, res) => {
  res.json({ ok: true, message: 'xbogus helper is available through existing pipeline' });
});

app.post('/api/upload', async (req, res) => {
  const tempDir = path.join(ROOT, 'tmp_upload');
  let jobFile = '';

  try {
    await fsp.mkdir(tempDir, { recursive: true });
    jobFile = path.join(tempDir, `${Date.now()}_${sanitizeUploadFilename(req.headers['x-filename'])}`);
    const receivedBytes = await streamRequestToFile(req, jobFile);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (res.flushHeaders) res.flushHeaders();
    const segmentConcurrency = clampHeaderInt(req.headers['x-segment-concurrency'], 1, 1, 4);
    const uploadConcurrency = clampHeaderInt(req.headers['x-upload-concurrency'], 1, 1, 8);
    sendSse(res, 'meta', {
      ok: true,
      filename: path.basename(jobFile),
      bytes: receivedBytes,
      segmentConcurrency,
      uploadConcurrency,
    });

    const probe = await tiktokService.probeVideo(jobFile);
    sendSse(res, 'progress', { step: 'probe', percent: 5, message: 'Video probing', probe, segmentConcurrency, uploadConcurrency });

    const result = await tiktokService.processJob(
      jobFile,
      4,
      probe.duration,
      (percent, message, details = {}) => sendSse(res, 'progress', {
        step: details.phase || 'pipeline',
        percent,
        message,
        ...details,
      }),
      { ...probe, source: 'dashboard', segmentConcurrency, uploadConcurrency }
    );

    sendSse(res, 'done', {
      ok: true,
      jobId: result.jobId,
      playlistUrl: result.playlistUrl,
      carrierPlaylistUrl: result.carrierPlaylistUrl,
      carrierPlayerUrl: result.carrierPlayerUrl,
      sizing: result.sizing,
    });
    res.end();
  } catch (err) {
    if (res.headersSent) {
      sendSse(res, 'error', { ok: false, error: err.message });
      res.end();
    } else {
      res.status(req.aborted ? 499 : 500).json({ ok: false, error: err.message });
    }
  } finally {
    if (jobFile) await fsp.unlink(jobFile).catch(() => {});
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const files = await fsp.readdir(MANIFEST_ROOT).catch(() => []);
    const jobs = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const jobId = path.basename(file, '.json');
      const manifest = await loadManifest(jobId).catch(() => null);
      if (!manifest) continue;
      const uploaded = (manifest.segments || []).filter(segment => segment.uploaded && segment.imageUri).length;
      const size = getManifestSizeBytes(manifest);
      jobs.push({
        jobId,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        total: manifest.segments?.length || 0,
        uploaded,
        complete: Boolean(manifest.complete),
        size,
        sourceSize: Number(manifest.source?.sizeBytes || 0),
      });
    }
    jobs.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs/:id', async (req, res) => {
  try {
    res.json(await loadManifest(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete('/api/jobs/:id', async (req, res) => {
  try {
    const jobId = req.params.id;
    await fsp.unlink(manifestPath(jobId)).catch(() => {});
    await fsp.rm(path.join(ROOT, 'public', 'upload', jobId), { recursive: true, force: true }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs/:id/reconstruct', async (req, res) => {
  const jobId = req.params.id;
  const outputDir = path.join(ROOT, 'tmp_reconstruct');
  await fsp.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${jobId}.mp4`);

  try {
    await runDecodedCli(jobId, outputPath);
    res.download(outputPath, `${jobId}.mp4`, async () => {
      await fsp.unlink(outputPath).catch(() => {});
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const dashboardIndex = path.join(DASHBOARD_DIST, 'index.html');
app.use('/dashboard', express.static(DASHBOARD_DIST, { maxAge: '0' }));
app.get(['/dashboard', '/dashboard/'], (req, res) => {
  if (fs.existsSync(dashboardIndex)) return res.sendFile(dashboardIndex);
  res.status(404).send('Dashboard build not found. Run `npm --prefix dashboard run build`.');
});
app.get('/', (req, res) => res.redirect('/dashboard/'));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/carrier/') || req.path.startsWith('/upload/')) return next();
  if (fs.existsSync(dashboardIndex)) return res.sendFile(dashboardIndex);
  return next();
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}/dashboard/`);
  });
}

module.exports = app;
