import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertCircle, ArrowRight, Binary, CloudLightning, Copy, Download, Eye, EyeOff, Film, Globe, History, Loader2, MoreVertical, RefreshCw, Save, Scissors, Server, ShieldCheck, UploadCloud, Video, ChevronDown, ChevronUp, Trash2, FolderSync, Waves, Cpu, Database, PlayCircle, TerminalSquare, Settings, BookOpen, Code, ExternalLink, FileText, Key
} from 'lucide-react';

const API = '';

// Global Fetch Interceptor to inject API Token authentication header
(function() {
  const originalFetch = window.fetch;
  window.fetch = async function(url, options = {}) {
    if (url && (typeof url === 'string') && (url.startsWith('/api/') || url.includes('/api/'))) {
      const token = localStorage.getItem('api_token') || 'tok_admin_default_719';
      options.headers = {
        ...options.headers,
        'Authorization': `Bearer ${token}`
      };
      try {
        const response = await originalFetch.call(this, url, options);
        if (response.status === 401 || response.status === 403) {
          window.dispatchEvent(new CustomEvent('ttk-token-error', { detail: { status: response.status } }));
        }
        return response;
      } catch (err) {
        throw err;
      }
    }
    return originalFetch.call(this, url, options);
  };
})();

function absoluteUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  if (typeof window === 'undefined') return path;
  return `${window.location.origin}${path.startsWith('/') ? path : `/${path}`}`;
}

function jobLinks(jobId) {
  if (!jobId) return { streamUrl: '', embedUrl: '', iframeHtml: '' };
  const encodedJobId = encodeURIComponent(jobId);
  const activeToken = localStorage.getItem('api_token') || 'tok_admin_default_719';
  const streamUrl = absoluteUrl(`/carrier/${encodedJobId}/master.m3u8?token=${encodeURIComponent(activeToken)}`);
  const embedUrl = absoluteUrl(`/player?jobId=${encodedJobId}&direct=1&auto=1&embed=1&token=${encodeURIComponent(activeToken)}`);
  const iframeHtml = `<iframe src="${embedUrl.replace(/&/g, '&amp;')}" width="100%" height="600" style="border:0;background:#000;" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  return { streamUrl, embedUrl, iframeHtml };
}

function getJobSizeBytes(job) {
  const explicitSize = Number(job?.sourceSize || job?.source?.sizeBytes || job?.size || job?.totalBytes || 0);
  if (Number.isFinite(explicitSize) && explicitSize > 0) return explicitSize;
  if (!Array.isArray(job?.segments)) return 0;
  return job.segments.reduce((sum, segment) => {
    const bytes = Number(segment.tsBytes || segment.payloadBytes || segment.carrierBytes || segment.pngBytes || 0);
    return sum + (Number.isFinite(bytes) ? bytes : 0);
  }, 0);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

const navItems = [
  { id: 'home', label: 'Tổng quan', icon: Activity },
  { id: 'upload', label: 'Tải video', icon: UploadCloud },
  { id: 'cdn', label: 'Cài đặt', icon: Settings },
  { id: 'jobs', label: 'Lịch sử', icon: History },
  { id: 'player', label: 'Trình phát', icon: PlayCircle },
  { id: 'users', label: 'Quản lý Token', icon: Key },
  { id: 'docs', label: 'Tài liệu API', icon: BookOpen },
];

function SectionTitle({ title, subtitle }) {
  return (
    <div className="mb-4">
      <h2 className="text-xl font-semibold tracking-tight text-zinc-50">{title}</h2>
      {subtitle ? <p className="mt-1 text-sm text-zinc-400">{subtitle}</p> : null}
    </div>
  );
}

function Card({ children, className = '' }) {
  return <div className={`rounded-xl border border-zinc-800/60 bg-zinc-900/60 shadow-sm ${className}`}>{children}</div>;
}

function Badge({ children, tone = 'slate' }) {
  const tones = {
    slate: 'bg-zinc-800 text-zinc-200',
    green: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
    red: 'bg-red-500/15 text-red-300 ring-1 ring-red-500/30',
    blue: 'bg-blue-500/15 text-blue-300 ring-1 ring-blue-500/30',
  };
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${tones[tone] || tones.slate}`}>{children}</span>;
}

function Button({ children, className = '', variant = 'default', ...props }) {
  const styles = {
    default: 'bg-zinc-100 text-zinc-950 hover:bg-white',
    ghost: 'bg-transparent text-zinc-200 hover:bg-zinc-800',
    danger: 'bg-red-500/15 text-red-300 hover:bg-red-500/25',
    accent: 'bg-cyan-500 text-zinc-950 hover:bg-cyan-400',
  };
  return (
    <button
      {...props}
      className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-cyan-500/70 disabled:opacity-60 ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

function StatCard({ title, value, icon: Icon }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-sm text-zinc-400">{title}</div>
          <div className="mt-2 text-3xl font-bold tracking-tight text-zinc-50">{value}</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-2 text-zinc-300">
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </Card>
  );
}

function DashboardHome() {
  const [status, setStatus] = useState({ status: 'unknown', port: '-', uptime: 0, env: { hasCookie: false, hasCsrf: false, hasOrg: false, cookieCount: 0, xBogusReady: false } });
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [cookieHealth, setCookieHealth] = useState({ status: 'unknown', alive: false, checkedAt: '', latencyMs: 0, cookieCount: 0, message: 'Đang chờ kiểm tra cookie...' });
  const [checkingCookie, setCheckingCookie] = useState(false);
  const [xBogusHealth, setXbogusHealth] = useState({ status: 'unknown', ok: false, checkedAt: '', latencyMs: 0, signerMode: 'local', httpStatus: 0, tikTokStatusCode: null, message: 'Đang chờ kiểm tra chữ ký X-Bogus...' });
  const [checkingXbogus, setCheckingXbogus] = useState(false);

  async function refreshCookieHealth() {
    setCheckingCookie(true);
    try {
      const res = await fetch(`${API}/api/cookies/health`, { cache: 'no-store' });
      if (res.ok) setCookieHealth(await res.json());
    } catch (err) {
      setCookieHealth(prev => ({ ...prev, status: 'unknown', alive: false, message: 'Không gọi được API healthcheck cookie.' }));
    } finally {
      setCheckingCookie(false);
    }
  }

  async function refreshXbogusHealth() {
    setCheckingXbogus(true);
    try {
      const res = await fetch(`${API}/api/xbogus/health`, { cache: 'no-store' });
      if (res.ok) setXbogusHealth(await res.json());
    } catch (err) {
      setXbogusHealth(prev => ({ ...prev, status: 'unknown', ok: false, message: 'Không gọi được API healthcheck X-Bogus.' }));
    } finally {
      setCheckingXbogus(false);
    }
  }

  async function refresh() {
    setLoading(true);
    try {
      const [statusRes, jobsRes] = await Promise.all([
        fetch(`${API}/api/server/status`),
        fetch(`${API}/api/jobs`),
      ]);
      if (statusRes.ok) setStatus(await statusRes.json());
      if (jobsRes.ok) {
        const payload = await jobsRes.json();
        const list = Array.isArray(payload) ? payload : Array.isArray(payload?.jobs) ? payload.jobs : [];
        setJobs(list);
      }
      await Promise.all([refreshCookieHealth(), refreshXbogusHealth()]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => {
      refreshCookieHealth();
      refreshXbogusHealth();
    }, 20000);
    return () => window.clearInterval(timer);
  }, []);

  const totalSizeBytes = jobs.reduce((sum, job) => sum + getJobSizeBytes(job), 0);
  const activeJobs = jobs.filter(job => !job.complete).length;
  const healthTone = cookieHealth.status === 'alive' ? 'green' : cookieHealth.status === 'dead' || cookieHealth.status === 'missing' ? 'red' : 'slate';
  const healthLabel = cookieHealth.status === 'alive' ? 'Còn sống' : cookieHealth.status === 'dead' ? 'Đã die' : cookieHealth.status === 'missing' ? 'Thiếu cookie' : 'Không rõ';
  const checkedAtLabel = cookieHealth.checkedAt ? new Date(cookieHealth.checkedAt).toLocaleTimeString('vi-VN') : 'Chưa kiểm tra';
  const xBogusTone = xBogusHealth.status === 'passed' ? 'green' : xBogusHealth.status === 'failed' || xBogusHealth.status === 'missing' ? 'red' : 'slate';
  const xBogusLabel = xBogusHealth.status === 'passed' ? 'Hợp lệ' : xBogusHealth.status === 'failed' ? 'Lỗi chữ ký' : xBogusHealth.status === 'missing' ? 'Thiếu signer' : 'Không rõ';
  const xBogusCheckedAtLabel = xBogusHealth.checkedAt ? new Date(xBogusHealth.checkedAt).toLocaleTimeString('vi-VN') : 'Chưa kiểm tra';
  const signerModeLabel = xBogusHealth.signerMode === 'jsdom-rpc' ? 'JSDOM RPC' : 'Local signer';

  return (
    <div className="space-y-6">
      <SectionTitle title="Tổng quan Dashboard" subtitle="Trạng thái Express, kiểm tra môi trường, tổng quan pipeline." />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm text-zinc-400">Điều khiển Server</div>
              <div className="mt-2 flex items-center gap-3">
                <Badge tone={status.status === 'active' ? 'green' : 'slate'}>{status.status === 'active' ? 'Đang chạy' : 'Dừng'}</Badge>
                <span className="text-sm text-zinc-300">Port {status.port}</span>
              </div>
            </div>
            <Button onClick={refresh} disabled={loading} variant="ghost">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Làm mới
            </Button>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-3 text-sm text-zinc-300">
            {[
              ['Cookie TikTok chính', status.env?.hasCookie],
              ['Cookie TikTok đăng nhập', Boolean(status.env?.cookieCount)],
              ['Chữ ký X-Bogus', status.env?.xBogusReady],
            ].map(([label, ok]) => (
              <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span>{label}</span>
                  <Badge tone={ok ? 'green' : 'red'}>{ok ? 'Ổn' : 'Thiếu'}</Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-zinc-400">Kiểm tra Môi trường</div>
              <div className="mt-1 text-sm text-zinc-300">Phiên TikTok Business + X-Bogus sẵn sàng</div>
            </div>
            <Button variant="ghost" onClick={refresh}><RefreshCw className="h-4 w-4" /></Button>
          </div>
          <div className="mt-4 space-y-2 text-sm">
            <div className="flex items-center justify-between rounded-lg border border-zinc-800 px-3 py-2"><span>.env đã tải</span><Badge tone="green">Có</Badge></div>
            <div className="flex items-center justify-between rounded-lg border border-zinc-800 px-3 py-2"><span>Cookie TikTok đăng nhập</span><Badge tone={status.env?.cookieCount ? 'green' : 'red'}>{status.env?.cookieCount || 0}</Badge></div>
            <div className="flex items-center justify-between rounded-lg border border-zinc-800 px-3 py-2"><span>X-Bogus</span><Badge tone={status.env?.xBogusReady ? 'green' : 'red'}>{status.env?.xBogusReady ? 'Sẵn sàng' : 'Thiếu'}</Badge></div>
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-zinc-800 px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
              <ShieldCheck className="h-4 w-4 text-cyan-300" />
              Healthcheck Cookie TikTok đăng nhập
            </div>
            <div className="mt-1 text-sm text-zinc-400">Tự kiểm tra realtime mỗi 20 giây, chỉ trả trạng thái an toàn, không lộ cookie.</div>
          </div>
          <Button variant="ghost" onClick={() => refreshCookieHealth()} disabled={checkingCookie}>
            {checkingCookie ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Check ngay
          </Button>
        </div>
        <div className="grid gap-3 p-5 md:grid-cols-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Trạng thái acc</div>
            <div className="mt-3 flex items-center gap-2">
              <Badge tone={healthTone}>{checkingCookie ? 'Đang check' : healthLabel}</Badge>
              {checkingCookie ? <Loader2 className="h-4 w-4 animate-spin text-cyan-300" /> : null}
            </div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Số cookie</div>
            <div className="mt-2 text-2xl font-bold text-zinc-50">{cookieHealth.cookieCount || status.env?.cookieCount || 0}</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Độ trễ</div>
            <div className="mt-2 text-2xl font-bold text-zinc-50">{Number(cookieHealth.latencyMs || 0)} ms</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Lần cuối</div>
            <div className="mt-2 text-sm font-medium text-zinc-200">{checkedAtLabel}</div>
          </div>
        </div>
        <div className="border-t border-zinc-800 px-5 py-3 text-sm text-zinc-300">
          {cookieHealth.message || 'Đang chờ kết quả healthcheck...'}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-zinc-800 px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
              <Cpu className="h-4 w-4 text-cyan-300" />
              Healthcheck Chữ ký X-Bogus
            </div>
            <div className="mt-1 text-sm text-zinc-400">Kiểm tra signer realtime mỗi 20 giây bằng request test không upload file, không hiển thị chữ ký.</div>
          </div>
          <Button variant="ghost" onClick={() => refreshXbogusHealth()} disabled={checkingXbogus}>
            {checkingXbogus ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Check ngay
          </Button>
        </div>
        <div className="grid gap-3 p-5 md:grid-cols-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Trạng thái signer</div>
            <div className="mt-3 flex items-center gap-2">
              <Badge tone={xBogusTone}>{checkingXbogus ? 'Đang check' : xBogusLabel}</Badge>
              {checkingXbogus ? <Loader2 className="h-4 w-4 animate-spin text-cyan-300" /> : null}
            </div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Bộ ký</div>
            <div className="mt-2 text-lg font-bold text-zinc-50">{signerModeLabel}</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">HTTP / API</div>
            <div className="mt-2 text-sm font-medium text-zinc-200">{xBogusHealth.httpStatus || '-'} / {xBogusHealth.tikTokStatusCode ?? '-'}</div>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Lần cuối</div>
            <div className="mt-2 text-sm font-medium text-zinc-200">{xBogusCheckedAtLabel}</div>
            <div className="mt-1 text-xs text-zinc-500">{Number(xBogusHealth.latencyMs || 0)} ms</div>
          </div>
        </div>
        <div className="border-t border-zinc-800 px-5 py-3 text-sm text-zinc-300">
          {xBogusHealth.message || 'Đang chờ kết quả healthcheck X-Bogus...'}
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard title="Tổng video" value={String(jobs.length)} icon={Video} />
        <StatCard title="Dung lượng manifest" value={formatBytes(totalSizeBytes)} icon={Database} />
        <StatCard title="Đang xử lý" value={String(activeJobs)} icon={Activity} />
      </div>
    </div>
  );
}

function normalizeThreadInput(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function VideoUploader({ onLog, serverStatus, restoreJobId, onClearRestore }) {
  const [uploadMethod, setUploadMethod] = useState('local'); // 'local' | 'torrent'
  const [magnetUrl, setMagnetUrl] = useState('');
  const [file, setFile] = useState(null);
  const [browserUploadProgress, setBrowserUploadProgress] = useState(0);
  const [progress, setProgress] = useState(0);
  const [step, setStep] = useState('idle');
  const [uploading, setUploading] = useState(false);
  const [share, setShare] = useState(null);
  const [segments, setSegments] = useState({ current: 0, total: 0, uploaded: 0, phasePercent: 0, duration: 0, file: '' });
  const [uploadLog, setUploadLog] = useState([]);
  const inputRef = useRef(null);
  const xhrRef = useRef(null);

  useEffect(() => {
    if (restoreJobId) {
      setUploading(true);
      setProgress(0);
      setStep('Đang kết nối lại tiến trình xử lý ngầm...');
      setUploadLog([]);
      setBrowserUploadProgress(100);

      const eventSource = new EventSource(`/api/jobs/${restoreJobId}/events`);
      
      const onProgress = (e) => {
        handleSseChunk(`event: progress\ndata: ${e.data}\n\n`);
      };

      const onMeta = (e) => {
        handleSseChunk(`event: meta\ndata: ${e.data}\n\n`);
      };

      const onDone = (e) => {
        handleSseChunk(`event: done\ndata: ${e.data}\n\n`);
        eventSource.close();
        onClearRestore?.();
      };

      const onError = (e) => {
        handleSseChunk(`event: error\ndata: ${e.data}\n\n`);
        eventSource.close();
        onClearRestore?.();
      };

      eventSource.addEventListener('progress', onProgress);
      eventSource.addEventListener('meta', onMeta);
      eventSource.addEventListener('done', onDone);
      eventSource.addEventListener('error', onError);

      xhrRef.current = {
        abort: () => {
          eventSource.close();
          fetch(`/api/jobs/${restoreJobId}/cancel`, { method: 'POST' }).catch(() => {});
          setUploading(false);
          setStep('Đã hủy kết nối và tiến trình');
          onClearRestore?.();
        }
      };

      return () => {
        eventSource.close();
      };
    }
  }, [restoreJobId]);

  const segmentConcurrency = normalizeThreadInput(localStorage.getItem('segment_concurrency') || '1', 1, 1, 999999);
  const uploadConcurrency = normalizeThreadInput(localStorage.getItem('upload_concurrency') || '3', 3, 1, 999999);

  const appendUploadLog = useCallback((line) => {
    const text = String(line || '').trim();
    if (!text) return;
    setUploadLog(prev => [text, ...prev].slice(0, 80));
    onLog?.(text);
  }, [onLog]);

  function handleSseChunk(chunk) {
    const lines = chunk.split('\n');
    const eventLine = lines.find(line => line.startsWith('event: '));
    const dataLine = lines.find(line => line.startsWith('data: '));
    if (!dataLine) return;

    const event = eventLine ? eventLine.slice(7).trim() : 'message';
    let data = {};
    try {
      data = JSON.parse(dataLine.slice(6));
    } catch (err) {
      appendUploadLog(`Không parse được SSE: ${err.message}`);
      return;
    }

    if (event === 'meta') {
      appendUploadLog(`Server đã nhận file tạm: ${data.filename || file?.name || 'video'} · tách ${data.segmentConcurrency || segmentConcurrency} luồng · upload ${data.uploadConcurrency || uploadConcurrency} luồng`);
      return;
    }

    if (event === 'progress') {
      const nextPercent = Math.max(0, Math.min(100, Number(data.percent || 0)));
      const phasePercent = Math.max(0, Math.min(100, Number(data.realPercent ?? nextPercent)));
      setProgress(nextPercent);
      setStep(data.message || (data.step === 'probe' ? 'Đang phân tích video...' : 'Đang xử lý pipeline...'));
      
      if (data.step === 'torrent-downloading' || data.step === 'torrent-selected' || data.step === 'torrent-metadata' || data.step === 'torrent-start') {
        setBrowserUploadProgress(phasePercent);
      } else if (data.step === 'torrent-done') {
        setBrowserUploadProgress(100);
      }

      if (data.step === 'probe') {
        setSegments(prev => ({ ...prev, phasePercent: 0 }));
      }
      if (data.segmentIndex !== undefined || data.segmentTotal !== undefined || data.realPercent !== undefined) {
        setSegments(prev => ({
          current: Number(data.segmentIndex ?? prev.current ?? 0),
          total: Number(data.segmentTotal ?? prev.total ?? 0),
          uploaded: Number(data.uploadedSegments ?? prev.uploaded ?? 0),
          phasePercent,
          duration: Number(data.segmentDuration ?? prev.duration ?? 0),
          file: String(data.segmentFile || prev.file || ''),
        }));
      }
      appendUploadLog(`${data.phase || data.step || 'pipeline'} · tổng ${nextPercent}% · bước ${phasePercent}% · ${data.message || 'Đang xử lý'}`);
      return;
    }

    if (event === 'done') {
      setBrowserUploadProgress(100);
      setProgress(100);
      setStep('Hoàn tất upload');
      setUploading(false);
      setSegments(prev => ({ ...prev, phasePercent: 100, uploaded: prev.total || prev.uploaded }));
      appendUploadLog(`Hoàn tất job ${data.jobId || ''}`);
      setShare(data);
      return;
    }

    if (event === 'error') {
      setUploading(false);
      setStep(`Lỗi upload: ${data.error || 'Không rõ nguyên nhân'}`);
      appendUploadLog(`Lỗi: ${data.error || 'Không rõ nguyên nhân'}`);
    }
  }

  function submit() {
    if (!file || uploading) return;
    xhrRef.current?.abort();
    setUploading(true);
    setStep('Đang gửi file từ trình duyệt lên server...');
    setBrowserUploadProgress(0);
    setProgress(0);
    setShare(null);
    setSegments({ current: 0, total: 0, uploaded: 0, phasePercent: 0, duration: 0, file: '' });
    appendUploadLog(`Bắt đầu upload ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
    appendUploadLog(`Cấu hình đa luồng: tách HLS ${segmentConcurrency} luồng · upload CDN ${uploadConcurrency} luồng`);

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    let seen = 0;
    let buffer = '';

    xhr.open('POST', `${API}/api/upload`);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-filename', file.name);
    xhr.setRequestHeader('x-segment-concurrency', String(segmentConcurrency));
    xhr.setRequestHeader('x-upload-concurrency', String(uploadConcurrency));
    const activeToken = localStorage.getItem('api_token') || 'tok_admin_default_719';
    xhr.setRequestHeader('Authorization', `Bearer ${activeToken}`);

    xhr.upload.onprogress = event => {
      if (!event.lengthComputable) return;
      const pct = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)));
      setBrowserUploadProgress(pct);
      setStep(pct < 100 ? `Đang gửi file lên server... ${pct}%` : 'Server đã nhận xong file, bắt đầu xử lý video...');
      appendUploadLog(`Browser upload ${pct}% (${(event.loaded / 1024 / 1024).toFixed(2)}/${(event.total / 1024 / 1024).toFixed(2)} MB)`);
    };

    xhr.onprogress = () => {
      const nextText = xhr.responseText.slice(seen);
      seen = xhr.responseText.length;
      buffer += nextText;
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';
      chunks.forEach(handleSseChunk);
    };

    xhr.onload = () => {
      if (buffer.trim()) handleSseChunk(buffer.trim());
      if (xhr.status < 200 || xhr.status >= 300) {
        setUploading(false);
        setStep(`Lỗi upload: HTTP ${xhr.status}`);
        appendUploadLog(`Lỗi HTTP ${xhr.status} khi gọi /api/upload`);
      }
    };

    xhr.onerror = () => {
      setUploading(false);
      setStep('Lỗi upload: Không kết nối được server');
      appendUploadLog('Lỗi upload: Không kết nối được server backend');
    };

    xhr.onabort = () => {
      setUploading(false);
      setStep('Đã hủy upload');
      appendUploadLog('Đã hủy upload hiện tại');
    };

    xhr.send(file);
  }

  function submitTorrent() {
    if (!magnetUrl.trim() || uploading) return;
    xhrRef.current?.abort();
    setUploading(true);
    setStep('Đang gửi yêu cầu tải torrent lên server...');
    setBrowserUploadProgress(0);
    setProgress(0);
    setShare(null);
    setSegments({ current: 0, total: 0, uploaded: 0, phasePercent: 0, duration: 0, file: '' });
    appendUploadLog(`Bắt đầu tải torrent từ Magnet Link...`);
    appendUploadLog(`Cấu hình đa luồng: tách HLS ${segmentConcurrency} luồng · upload CDN ${uploadConcurrency} luồng`);

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    let seen = 0;
    let buffer = '';

    xhr.open('POST', `${API}/api/upload/torrent`);
    xhr.setRequestHeader('content-type', 'application/json');
    xhr.setRequestHeader('x-segment-concurrency', String(segmentConcurrency));
    xhr.setRequestHeader('x-upload-concurrency', String(uploadConcurrency));
    const activeToken = localStorage.getItem('api_token') || 'tok_admin_default_719';
    xhr.setRequestHeader('Authorization', `Bearer ${activeToken}`);

    xhr.onprogress = () => {
      const nextText = xhr.responseText.slice(seen);
      seen = xhr.responseText.length;
      buffer += nextText;
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';
      chunks.forEach(handleSseChunk);
    };

    xhr.onload = () => {
      if (buffer.trim()) handleSseChunk(buffer.trim());
      if (xhr.status < 200 || xhr.status >= 300) {
        setUploading(false);
        setStep(`Lỗi upload torrent: HTTP ${xhr.status}`);
        appendUploadLog(`Lỗi HTTP ${xhr.status} khi gọi /api/upload/torrent`);
      }
    };

    xhr.onerror = () => {
      setUploading(false);
      setStep('Lỗi upload torrent: Không kết nối được server');
      appendUploadLog('Lỗi upload torrent: Không kết nối được server backend');
    };

    xhr.onabort = () => {
      setUploading(false);
      setStep('Đã hủy upload torrent');
      appendUploadLog('Đã hủy upload torrent hiện tại');
    };

    xhr.send(JSON.stringify({ magnetUrl }));
  }

  const segmentLabel = segments.total ? `${segments.current}/${segments.total}` : '0/0';
  const uploadedLabel = segments.total ? `${segments.uploaded}/${segments.total}` : '0/0';
  const steps = [
    [Film, 'Quét video'],
    [Scissors, `Cắt HLS ${segmentLabel}`],
    [Binary, `Mã hóa carrier ${segmentLabel}`],
    [CloudLightning, `Đẩy CDN ${uploadedLabel}`],
  ];

  const carrierLabels = ['Chiều rộng canvas', 'Chiều cao canvas', 'Mật độ bit', 'Magic Header'];

  return (
    <div className="space-y-6">
      <SectionTitle title="Tải video" subtitle="Kéo thả, cấu hình carrier, stepper thời gian thực, chia sẻ." />
      <Card className="p-5">
        <div className="mb-5 flex gap-2 border-b border-zinc-800 pb-4">
          <button
            onClick={() => !uploading && setUploadMethod('local')}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${uploadMethod === 'local' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
            disabled={uploading}
          >
            Tải file từ máy
          </button>
          <button
            onClick={() => !uploading && setUploadMethod('torrent')}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${uploadMethod === 'torrent' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
            disabled={uploading}
          >
            Tải qua Torrent
          </button>
        </div>

        {uploadMethod === 'local' ? (
          <div
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); setFile(e.dataTransfer.files?.[0] || null); }}
            onClick={() => inputRef.current?.click()}
            className="flex min-h-48 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-zinc-700 bg-zinc-950/60 px-6 text-center transition-colors hover:border-zinc-500"
          >
            <input ref={inputRef} type="file" accept="video/*" className="hidden" onChange={e => setFile(e.target.files?.[0] || null)} />
            <UploadCloud className="h-10 w-10 text-zinc-400" />
            <div className="mt-3 text-lg font-medium">Thả video vào đây</div>
            <div className="text-sm text-zinc-400">hoặc bấm để chọn file</div>
            {file ? <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200">{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB</div> : null}
          </div>
        ) : (
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-5 space-y-3">
            <label className="block text-sm font-medium text-zinc-300">Nhập Magnet Link / Torrent URL</label>
            <input
              type="text"
              value={magnetUrl}
              onChange={e => setMagnetUrl(e.target.value)}
              disabled={uploading}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none focus:border-cyan-500/70"
              placeholder="magnet:?xt=urn:btih:..."
            />
            <p className="text-xs text-zinc-500">Hệ thống sẽ tải torrent về server tạm, tự động lọc file video lớn nhất và chuyển tiếp qua pipeline upload TikTok.</p>
          </div>
        )}

        <div className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-100">
          <div className="flex items-center gap-2 font-medium">
            <ShieldCheck className="h-4 w-4 text-emerald-300" />
            Giữ nguyên chất lượng video 100%
          </div>
          <div className="mt-1 text-emerald-100/80">
            FFmpeg dùng stream copy, không giảm bitrate, không đổi codec, không đổi độ phân giải. Hệ thống chỉ tự tính lại thời lượng cắt để segment nhắm khoảng 2–5MB; nếu source/keyframe khiến segment vẫn vượt 5MB thì backend sẽ cảnh báo nhưng vẫn tiếp tục upload theo yêu cầu.
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="accent"
            onClick={uploadMethod === 'local' ? submit : submitTorrent}
            disabled={uploading || (uploadMethod === 'local' ? !file : !magnetUrl.trim())}
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            {uploading ? 'Đang upload...' : 'Tải lên'}
          </Button>
          {uploading ? <Button variant="ghost" onClick={() => xhrRef.current?.abort()}>Hủy upload</Button> : null}
        </div>

        <div className="mt-5 space-y-3">
          <div className="flex items-center justify-between text-sm text-zinc-400"><span>{step}</span><span className="font-mono text-cyan-200">{progress}%</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-zinc-800"><div className="h-full rounded-full bg-cyan-400 transition-all duration-300" style={{ width: `${progress}%` }} /></div>
          <div className="grid gap-2 md:grid-cols-4 text-xs text-zinc-300">
            {steps.map(([Icon, label], idx) => (
              <div key={String(label)} className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${idx * 25 <= progress ? 'border-cyan-500/40 bg-cyan-500/10' : 'border-zinc-800 bg-zinc-950'}`}>
                <Icon className="h-4 w-4" /><span>{label}</span>
              </div>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-5">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
              <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">
                {uploadMethod === 'torrent' ? '% tải torrent' : '% gửi file'}
              </div>
              <div className="mt-2 font-mono text-2xl font-bold text-emerald-300">{browserUploadProgress}%</div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-800"><div className="h-full rounded-full bg-emerald-400 transition-all duration-300" style={{ width: `${browserUploadProgress}%` }} /></div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
              <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">% tổng pipeline</div>
              <div className="mt-2 font-mono text-2xl font-bold text-cyan-200">{progress}%</div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-800"><div className="h-full rounded-full bg-cyan-400 transition-all duration-300" style={{ width: `${progress}%` }} /></div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
              <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">% bước hiện tại</div>
              <div className="mt-2 font-mono text-2xl font-bold text-zinc-50">{segments.phasePercent}%</div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-800"><div className="h-full rounded-full bg-zinc-200 transition-all duration-300" style={{ width: `${segments.phasePercent}%` }} /></div>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
              <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">Segment đang xử lý</div>
              <div className="mt-2 font-mono text-2xl font-bold text-zinc-50">{segmentLabel}</div>
              {segments.duration ? <div className="mt-1 text-xs text-zinc-500">hls_time={segments.duration}s</div> : null}
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
              <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">Đã upload CDN</div>
              <div className="mt-2 font-mono text-2xl font-bold text-emerald-300">{uploadedLabel}</div>
              {segments.file ? <div className="mt-1 truncate font-mono text-xs text-zinc-500">{segments.file}</div> : null}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-black p-3 font-mono text-xs text-zinc-300">
            <div className="mb-2 flex items-center gap-2 text-zinc-500"><TerminalSquare className="h-4 w-4" />Log upload realtime</div>
            <div className="max-h-48 space-y-1 overflow-auto">
              {uploadLog.length ? uploadLog.map((line, idx) => <div key={`${idx}-${line}`} className="truncate">▶ {line}</div>) : <div className="text-zinc-600">Chưa có log upload.</div>}
            </div>
          </div>
        </div>
      </Card>

      {share ? (
        <Card className="p-5">
          <div className="text-sm text-zinc-400">Thẻ chia sẻ</div>
          <div className="mt-4 space-y-2">
            {[
              ['Liên kết Player', share.carrierPlayerUrl],
              ['Mã nhúng iFrame', `<iframe src="${share.carrierPlayerUrl}" />`],
              ['URL stream .m3u8', share.carrierPlaylistUrl],
            ].map(([label, value]) => (
              <div key={String(label)} className="flex items-center gap-2">
                <input readOnly value={String(value || '')} className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none" />
                <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(String(value || ''))}><Copy className="h-4 w-4" />Sao chép</Button>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
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

  const rows = raw.includes('\n')
    ? raw.split(/\r?\n/)
    : raw.split(';');

  return rows
    .map(row => row.trim())
    .filter(Boolean)
    .map(row => {
      const idx = row.indexOf('=');
      if (idx === -1) return null;
      return { name: row.slice(0, idx).trim(), value: row.slice(idx + 1).trim() };
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

function parseCookieInput(text) {
  const raw = String(text || '').trim();
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

function CdnManager() {
  const [visible, setVisible] = useState(false);
  const [cookies, setCookies] = useState('');
  const [saving, setSaving] = useState(false);
  const [format, setFormat] = useState('json');
  const [saveState, setSaveState] = useState({ tone: 'slate', message: 'Chưa lưu cookie trong phiên này.' });
  const [health, setHealth] = useState(null);

  const [segmentConcurrencyInput, setSegmentConcurrencyInput] = useState(() => localStorage.getItem('segment_concurrency') || '1');
  const [uploadConcurrencyInput, setUploadConcurrencyInput] = useState(() => localStorage.getItem('upload_concurrency') || '3');
  const [reconstructConcurrencyInput, setReconstructConcurrencyInput] = useState(() => localStorage.getItem('reconstruct_concurrency') || '4');
  const [savingConcurrency, setSavingConcurrency] = useState(false);
  const [concurrencySaveState, setConcurrencySaveState] = useState({ tone: 'slate', message: 'Chưa lưu cấu hình luồng.' });

  useEffect(() => {
    async function loadConfig() {
      try {
        const res = await fetch(`${API}/api/server/status`);
        if (res.ok) {
          const data = await res.json();
          if (data.concurrency) {
            setSegmentConcurrencyInput(String(data.concurrency.segmentConcurrency || 1));
            setUploadConcurrencyInput(String(data.concurrency.uploadConcurrency || 3));
            setReconstructConcurrencyInput(String(data.concurrency.reconstructConcurrency || 4));
            
            localStorage.setItem('segment_concurrency', String(data.concurrency.segmentConcurrency || 1));
            localStorage.setItem('upload_concurrency', String(data.concurrency.uploadConcurrency || 3));
            localStorage.setItem('reconstruct_concurrency', String(data.concurrency.reconstructConcurrency || 4));
          }
        }
      } catch (err) {
        console.error('Failed to load server config', err);
      }
    }
    loadConfig();
    
    async function getCookieHealth() {
      try {
        const res = await fetch(`${API}/api/cookies/health`, { cache: 'no-store' });
        if (res.ok) setHealth(await res.json());
      } catch (err) {}
    }
    getCookieHealth();
  }, []);

  function normalizeCookiesForSave() {
    return parseCookieInput(cookies);
  }

  async function refreshHealthAfterSave() {
    const res = await fetch(`${API}/api/cookies/health`, { cache: 'no-store' });
    if (res.ok) setHealth(await res.json());
  }

  async function saveCookies() {
    setSaving(true);
    setSaveState({ tone: 'slate', message: 'Đang lưu cookie...' });
    try {
      const payload = normalizeCookiesForSave();
      if (!payload.length) {
        setSaveState({ tone: 'red', message: 'Cookie trống hoặc sai định dạng. Hãy dán JSON/J2Team hợp lệ rồi lưu lại.' });
        return;
      }

      const res = await fetch(`${API}/api/cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'Không lưu được cookie.');

      setSaveState({ tone: 'green', message: `Đã lưu ${data.cookieCount || payload.length} cookie. Healthcheck sẽ dùng ngay, không cần restart server.` });
      await refreshHealthAfterSave().catch(() => {});
    } catch (err) {
      setSaveState({ tone: 'red', message: `Lưu cookie lỗi: ${err.message}` });
    } finally {
      setSaving(false);
    }
  }

  async function saveConcurrency() {
    setSavingConcurrency(true);
    setConcurrencySaveState({ tone: 'slate', message: 'Đang lưu cấu hình luồng...' });
    try {
      const seg = Math.max(1, Number(segmentConcurrencyInput || 1));
      const up = Math.max(1, Number(uploadConcurrencyInput || 3));
      const rec = Math.max(1, Number(reconstructConcurrencyInput || 4));

      const response = await fetch(`${API}/api/config/concurrency`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          segmentConcurrency: seg,
          uploadConcurrency: up,
          reconstructConcurrency: rec,
        }),
      });
      const data = await response.json();
      if (data.ok) {
        localStorage.setItem('segment_concurrency', String(data.segmentConcurrency));
        localStorage.setItem('upload_concurrency', String(data.uploadConcurrency));
        localStorage.setItem('reconstruct_concurrency', String(data.reconstructConcurrency));
        setSegmentConcurrencyInput(String(data.segmentConcurrency));
        setUploadConcurrencyInput(String(data.uploadConcurrency));
        setReconstructConcurrencyInput(String(data.reconstructConcurrency));
        setConcurrencySaveState({ tone: 'green', message: `Đã lưu: Tách ${data.segmentConcurrency} · Upload ${data.uploadConcurrency} · Khôi phục ${data.reconstructConcurrency}` });
      } else {
        throw new Error(data.error || 'Lỗi không xác định');
      }
    } catch (err) {
      setConcurrencySaveState({ tone: 'red', message: `Lưu luồng lỗi: ${err.message}` });
    } finally {
      setSavingConcurrency(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionTitle title="Cài đặt" subtitle="Cấu hình Cookie đăng nhập và số luồng xử lý." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="text-sm text-zinc-400">Nhập cookie đăng nhập TikTok</div>
            <div className="flex items-center gap-2">
              <select value={format} onChange={e => setFormat(e.target.value)} className="rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-none">
                <option value="json">Auto JSON/J2Team</option>
                <option value="j2team">Name=Value</option>
              </select>
              <Button variant="ghost" onClick={() => setVisible(v => !v)}>{visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4 opacity-60" />}</Button>
            </div>
          </div>
          <div className="relative">
            <textarea
              value={cookies}
              onChange={e => setCookies(e.target.value)}
              className={`min-h-48 w-full rounded-xl border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs outline-none ${visible ? 'text-zinc-200' : 'text-transparent caret-cyan-300 selection:bg-cyan-500/30'}`}
              placeholder={format === 'j2team' ? 'sessionid=...\ntt_chain_token=...\nhoặc sessionid=...; tt_chain_token=...' : '{"url":"https://www.tiktok.com","cookies":[{"name":"sessionid","value":"..."}]}'}
              spellCheck={false}
            />
            {!visible && cookies ? (
              <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl p-3 font-mono text-xs leading-5 text-zinc-500">
                {'●'.repeat(Math.min(cookies.length, 800))}
              </div>
            ) : null}
          </div>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-zinc-300">
              <Badge tone={saveState.tone}>{saveState.tone === 'green' ? 'Đã lưu' : saveState.tone === 'red' ? 'Lỗi' : 'Trạng thái'}</Badge>
              <span className="ml-2">{saveState.message}</span>
            </div>
            <Button variant="accent" onClick={saveCookies} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}Lưu cookie</Button>
          </div>
          {health ? (
            <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-sm text-zinc-300">
              Healthcheck mới nhất: <Badge tone={health.status === 'alive' ? 'green' : health.status === 'dead' || health.status === 'missing' ? 'red' : 'slate'}>{health.status === 'alive' ? 'Còn sống' : health.status === 'dead' ? 'Đã die' : health.status === 'missing' ? 'Thiếu cookie' : 'Không rõ'}</Badge>
              <span className="ml-2">{health.message}</span>
            </div>
          ) : null}
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="text-sm text-zinc-400">Cấu hình luồng xử lý (Concurrency)</div>
          </div>
          <div className="space-y-4">
            <label className="block space-y-2 text-sm text-zinc-300">
              <span className="flex items-center gap-2 font-medium">
                <Scissors className="h-4 w-4 text-cyan-300" /> Luồng tách HLS (tối thiểu 1)
              </span>
              <input
                type="number"
                min="1"
                value={segmentConcurrencyInput}
                onChange={e => setSegmentConcurrencyInput(e.target.value)}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:ring-2 focus:ring-cyan-500/60"
              />
              <span className="block text-xs text-zinc-500">Số luồng phân mảnh video đồng thời qua FFmpeg.</span>
            </label>

            <label className="block space-y-2 text-sm text-zinc-300">
              <span className="flex items-center gap-2 font-medium">
                <CloudLightning className="h-4 w-4 text-emerald-300" /> Luồng upload CDN (tối thiểu 1)
              </span>
              <input
                type="number"
                min="1"
                value={uploadConcurrencyInput}
                onChange={e => setUploadConcurrencyInput(e.target.value)}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:ring-2 focus:ring-cyan-500/60"
              />
              <span className="block text-xs text-zinc-500">Số luồng upload các mảnh ảnh carrier lên TikTok CDN song song.</span>
            </label>

            <label className="block space-y-2 text-sm text-zinc-300">
              <span className="flex items-center gap-2 font-medium">
                <Download className="h-4 w-4 text-amber-300" /> Luồng khôi phục / download (tối thiểu 1)
              </span>
              <input
                type="number"
                min="1"
                value={reconstructConcurrencyInput}
                onChange={e => setReconstructConcurrencyInput(e.target.value)}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:ring-2 focus:ring-cyan-500/60"
              />
              <span className="block text-xs text-zinc-500">Số luồng tải ảnh carrier đồng thời về máy khi giải mã khôi phục video.</span>
            </label>
          </div>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-zinc-300">
              <Badge tone={concurrencySaveState.tone}>
                {concurrencySaveState.tone === 'green' ? 'Đã lưu' : concurrencySaveState.tone === 'red' ? 'Lỗi' : 'Trạng thái'}
              </Badge>
              <span className="ml-2">{concurrencySaveState.message}</span>
            </div>
            <Button variant="accent" onClick={saveConcurrency} disabled={savingConcurrency}>
              {savingConcurrency ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Lưu cấu hình
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

function JobHistory({ onPlay, onViewProgress }) {
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState({});
  const [openMenu, setOpenMenu] = useState(null);
  const [copyNotice, setCopyNotice] = useState('');
  const [reconstructState, setReconstructState] = useState({});

  async function refresh() {
    const res = await fetch(`${API}/api/jobs`);
    const data = res.ok ? await res.json() : [];
    const list = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : [];
    setJobs(list);
  }

  useEffect(() => { refresh().catch(() => {}); }, []);

  useEffect(() => {
    const hasActive = jobs.some(j => j.status === 'processing');
    if (!hasActive) return;

    const intervalId = setInterval(() => {
      refresh().catch(() => {});
    }, 2000);

    return () => clearInterval(intervalId);
  }, [jobs]);

  useEffect(() => {
    if (openMenu === null) return;
    const handleClose = () => setOpenMenu(null);
    document.addEventListener('click', handleClose);
    return () => document.removeEventListener('click', handleClose);
  }, [openMenu]);

  async function remove(jobId) {
    setBusy(prev => ({ ...prev, [jobId]: 'delete' }));
    try {
      await fetch(`${API}/api/jobs/${jobId}`, { method: 'DELETE' });
      await refresh();
    } finally {
      setBusy(prev => ({ ...prev, [jobId]: null }));
      setOpenMenu(null);
    }
  }

  async function reconstruct(jobId) {
    setBusy(prev => ({ ...prev, [jobId]: 'reconstruct' }));
    try {
      const startRes = await fetch(`${API}/api/jobs/${jobId}/reconstruct`, { method: 'POST' });
      if (!startRes.ok) throw new Error('Không thể khởi động tiến trình khôi phục');

      await new Promise((resolve, reject) => {
        const intervalId = setInterval(async () => {
          try {
            const statusRes = await fetch(`${API}/api/jobs/${jobId}/reconstruct/status`);
            if (!statusRes.ok) {
              clearInterval(intervalId);
              reject(new Error('Lỗi truy vấn tiến trình'));
              return;
            }
            const data = await statusRes.json();

            setReconstructState(prev => ({
              ...prev,
              [jobId]: {
                status: data.status,
                percent: data.percent,
                message: data.message,
                error: data.error
              }
            }));

            if (data.status === 'complete') {
              clearInterval(intervalId);
              resolve();
            } else if (data.status === 'failed') {
              clearInterval(intervalId);
              reject(new Error(data.error || 'Khôi phục thất bại'));
            }
          } catch (err) {
            clearInterval(intervalId);
            reject(err);
          }
        }, 1500);
      });

      const downloadUrl = `${API}/api/jobs/${jobId}/reconstruct/download`;
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `${jobId}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

    } catch (err) {
      alert(`Khôi phục Video thất bại: ${err.message}`);
    } finally {
      setBusy(prev => ({ ...prev, [jobId]: null }));
      setOpenMenu(null);
      setTimeout(() => {
        setReconstructState(prev => {
          const next = { ...prev };
          delete next[jobId];
          return next;
        });
      }, 5000);
    }
  }

  async function cancelJob(jobId) {
    setBusy(prev => ({ ...prev, [jobId]: 'cancel' }));
    try {
      await fetch(`${API}/api/jobs/${jobId}/cancel`, { method: 'POST' });
      await refresh();
    } finally {
      setBusy(prev => ({ ...prev, [jobId]: null }));
      setOpenMenu(null);
    }
  }

  async function copyText(value, label) {
    const text = String(value || '');
    if (!text) return;
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopyNotice(`Đã copy ${label}`);
    setOpenMenu(null);
    setTimeout(() => setCopyNotice(''), 1800);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <SectionTitle title="Lịch sử Job" subtitle="Bảng manifest, copy link M3U8/embed, khôi phục, xóa, tải MP4." />
        {copyNotice ? <Badge tone="green">{copyNotice}</Badge> : null}
      </div>
      <Card className="overflow-visible">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-950 text-zinc-500"><tr><th className="px-5 py-3">Job ID</th><th className="px-5 py-3">Ngày tải lên</th><th className="px-5 py-3">Dung lượng</th><th className="px-5 py-3">Phân đoạn</th><th className="px-5 py-3">Thao tác</th></tr></thead>
          <tbody>
            {jobs.length ? jobs.map(job => {
              const state = busy[job.jobId];
              const links = jobLinks(job.jobId);
              return (
                <tr key={job.jobId} className="border-t border-zinc-800">
                  <td className="px-5 py-3 font-mono text-xs text-zinc-300">
                    {job.status === 'processing' ? (
                      <button
                        onClick={() => onViewProgress?.(job.jobId)}
                        className="flex items-center gap-1 font-mono text-xs text-cyan-400 hover:underline hover:text-cyan-300 focus:outline-none"
                        title="Bấm để xem tiến trình chi tiết"
                      >
                        {job.jobId} (Xem tiến độ)
                      </button>
                    ) : (
                      job.jobId
                    )}
                  </td>
                  <td className="px-5 py-3 text-zinc-300">{job.createdAt?.slice(0, 10)}</td>
                  <td className="px-5 py-3 text-zinc-300">{formatBytes(getJobSizeBytes(job))}</td>
                  <td className="px-5 py-3 text-zinc-300">
                    {job.status === 'processing' ? (
                      <div className="flex flex-col gap-1">
                        <span className="text-cyan-400 font-medium">Đang xử lý ({job.percent}%)</span>
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-800">
                          <div className="h-full bg-cyan-400 transition-all duration-300" style={{ width: `${job.percent}%` }} />
                        </div>
                      </div>
                    ) : reconstructState[job.jobId] && reconstructState[job.jobId].status === 'processing' ? (
                      <div className="flex flex-col gap-1">
                        <span className="text-amber-400 font-medium" title={reconstructState[job.jobId].message}>
                          Đang khôi phục ({reconstructState[job.jobId].percent}%)
                        </span>
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-800">
                          <div className="h-full bg-amber-400 transition-all duration-300" style={{ width: `${reconstructState[job.jobId].percent}%` }} />
                        </div>
                      </div>
                    ) : job.status === 'cancelled' ? (
                      <span className="text-red-400 font-medium">Đã hủy</span>
                    ) : job.status === 'failed' ? (
                      <span className="text-red-500 font-medium">Lỗi</span>
                    ) : (
                      `${job.uploaded}/${job.total}`
                    )}
                  </td>
                  <td className={`relative px-5 py-3 ${openMenu === job.jobId ? 'z-50' : 'z-0'}`}>
                    <div className="relative flex justify-end">
                      <Button
                        variant="ghost"
                        className="h-9 w-9 justify-center px-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenu(openMenu === job.jobId ? null : job.jobId);
                        }}
                        disabled={Boolean(state)}
                        aria-label="Mở menu thao tác job"
                      >
                        {state === 'reconstruct' ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreVertical className="h-4 w-4" />}
                      </Button>
                      {openMenu === job.jobId ? (
                        <div onClick={(e) => e.stopPropagation()} className="absolute right-0 top-full z-50 mt-2 w-64 rounded-xl border border-zinc-800 bg-zinc-950/95 p-2 shadow-2xl shadow-black/50 ring-1 ring-white/5 backdrop-blur">
                          <button onClick={() => { onPlay?.(job); setOpenMenu(null); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-cyan-200 transition-colors hover:bg-cyan-500/10 hover:text-cyan-100 focus:bg-cyan-500/10 focus:outline-none">
                            <PlayCircle className="h-4 w-4" />Phát bằng embed
                          </button>
                          <button onClick={() => copyText(links.streamUrl, 'link M3U8')} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800 focus:bg-zinc-800 focus:outline-none">
                            <Copy className="h-4 w-4" />Copy link M3U8
                          </button>
                          <button onClick={() => copyText(links.embedUrl, 'link embed')} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800 focus:bg-zinc-800 focus:outline-none">
                            <Copy className="h-4 w-4" />Copy link embed
                          </button>
                          <button onClick={() => copyText(links.iframeHtml, 'mã iframe')} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800 focus:bg-zinc-800 focus:outline-none">
                            <Copy className="h-4 w-4" />Copy mã iframe
                          </button>
                          <button onClick={() => reconstruct(job.jobId)} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800 focus:bg-zinc-800 focus:outline-none">
                            <Download className="h-4 w-4" />Khôi phục Video
                          </button>
                          {job.status === 'processing' ? (
                            <>
                              <button onClick={() => { onViewProgress?.(job.jobId); setOpenMenu(null); }} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-cyan-200 transition-colors hover:bg-cyan-500/10 hover:text-cyan-100 focus:bg-cyan-500/10 focus:outline-none">
                                <Activity className="h-4 w-4" />Xem tiến độ
                              </button>
                              <button onClick={() => cancelJob(job.jobId)} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300 focus:bg-red-500/10 focus:outline-none">
                                <AlertCircle className="h-4 w-4" />Hủy tiến trình
                              </button>
                            </>
                          ) : null}
                          <button onClick={() => remove(job.jobId)} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300 focus:bg-red-500/10 focus:outline-none">
                            <Trash2 className="h-4 w-4" />Xóa video đã tải
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            }) : (
              <tr><td colSpan="5" className="px-5 py-8 text-center text-zinc-500">Chưa có job nào</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function CarrierPlayer({ selectedJob }) {
  const [jobs, setJobs] = useState([]);
  const [activeJobId, setActiveJobId] = useState(selectedJob?.jobId || '');

  async function refreshJobs() {
    const res = await fetch(`${API}/api/jobs`, { cache: 'no-store' });
    const data = res.ok ? await res.json() : [];
    const list = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : [];
    setJobs(list);
    if (!activeJobId && list[0]?.jobId) setActiveJobId(list[0].jobId);
  }

  useEffect(() => { refreshJobs().catch(() => {}); }, []);
  useEffect(() => {
    if (selectedJob?.jobId) setActiveJobId(selectedJob.jobId);
  }, [selectedJob?.jobId]);

  const activeJob = jobs.find(job => job.jobId === activeJobId) || selectedJob || null;
  const links = jobLinks(activeJobId);
  const embedUrl = links.embedUrl;
  const streamUrl = links.streamUrl;

  return (
    <div className="space-y-6">
      <SectionTitle title="Trình phát Carrier" subtitle="Chọn job đã upload rồi phát qua embed player, đúng link dùng để nhúng sang web khác." />
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-zinc-800 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
              <PlayCircle className="h-4 w-4 text-cyan-300" />
              Phát video bằng embed
            </div>
            <div className="mt-1 text-xs text-zinc-500">Iframe bên dưới dùng URL embed mode (`embed=1`), không nhúng player thường.</div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <select
              value={activeJobId}
              onChange={e => setActiveJobId(e.target.value)}
              className="min-w-72 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200 outline-none focus:ring-2 focus:ring-cyan-500/60"
            >
              {!jobs.length ? <option value="">Chưa có job nào</option> : null}
              {jobs.map(job => (
                <option key={job.jobId} value={job.jobId}>{job.jobId} — {job.uploaded}/{job.total} đoạn</option>
              ))}
            </select>
            <Button variant="ghost" onClick={() => refreshJobs()}><RefreshCw className="h-4 w-4" />Tải lại</Button>
            {embedUrl ? <a href={embedUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-3 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-cyan-400"><ArrowRight className="h-4 w-4" />Mở embed riêng</a> : null}
          </div>
        </div>

        {embedUrl ? (
          <div className="p-4">
            <div className="overflow-hidden rounded-xl border border-zinc-800 bg-black shadow-2xl shadow-black/40">
              <iframe
                key={embedUrl}
                title="TikTok carrier embed player"
                src={embedUrl}
                className="aspect-video w-full bg-black"
                allow="autoplay; fullscreen; picture-in-picture"
                allowFullScreen
              />
            </div>
            <div className="mt-4 grid gap-3 text-xs text-zinc-300 md:grid-cols-4">
              <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                <div className="text-zinc-500">Chế độ</div>
                <div className="mt-1 font-medium text-cyan-200">Embed + Direct + Auto</div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                <div className="text-zinc-500">Job ID</div>
                <div className="mt-1 truncate font-mono text-zinc-200">{activeJobId}</div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                <div className="text-zinc-500">Phân đoạn</div>
                <div className="mt-1 font-medium text-zinc-200">{activeJob?.uploaded ?? '-'} / {activeJob?.total ?? '-'}</div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                <div className="text-zinc-500">Embed URL</div>
                <div className="mt-1 truncate font-mono text-zinc-200">{embedUrl}</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-8 text-center text-sm text-zinc-500">
            Chưa có job để phát. Vào tab <span className="text-zinc-300">Tải video</span> upload trước, hoặc kiểm tra lại Lịch sử Job.
          </div>
        )}
      </Card>
    </div>
  );
}

const apiEndpoints = [
  {
    category: 'Cấu hình & Hệ thống',
    endpoints: [
      {
        method: 'GET',
        path: '/api/server/status',
        desc: 'Lấy thông tin trạng thái hoạt động của server Node.js, bao gồm port, uptime, các cấu hình môi trường và số luồng xử lý hiện tại.',
        headers: [{ name: 'Authorization', value: 'Bearer <token>' }],
        body: '',
        response: '{\n  "status": "active",\n  "port": 30001,\n  "uptime": 235.42,\n  "env": {\n    "hasCookie": true,\n    "hasCsrf": true,\n    "hasOrg": true,\n    "cookieCount": 20,\n    "xBogusReady": true\n  },\n  "concurrency": {\n    "segmentConcurrency": 2,\n    "uploadConcurrency": 4,\n    "reconstructConcurrency": 8\n  }\n}'
      },
      {
        method: 'POST',
        path: '/api/config/concurrency',
        desc: 'Cập nhật cấu hình số luồng song song cho các tác vụ tách HLS, upload CDN và khôi phục video. Ghi trực tiếp vào file .env và cập nhật RAM ngay lập tức.',
        headers: [
          { name: 'Authorization', value: 'Bearer <token>' },
          { name: 'Content-Type', value: 'application/json' }
        ],
        body: '{\n  "segmentConcurrency": 2,\n  "uploadConcurrency": 4,\n  "reconstructConcurrency": 8\n}',
        response: '{\n  "ok": true,\n  "segmentConcurrency": 2,\n  "uploadConcurrency": 4,\n  "reconstructConcurrency": 8\n}'
      },
      {
        method: 'POST',
        path: '/api/cookies',
        desc: 'Cập nhật Cookie TikTok đăng nhập mới. Hỗ trợ định dạng JSON J2Team Cookie hoặc chuỗi cookie thô. Tự động parse và lưu vào tệp .env / cập nhật RAM.',
        headers: [
          { name: 'Authorization', value: 'Bearer <token>' },
          { name: 'Content-Type', value: 'application/json' }
        ],
        body: '[\n  { "name": "sessionid", "value": "..." },\n  { "name": "tt_chain_token", "value": "..." }\n]',
        response: '{\n  "ok": true,\n  "cookieCount": 2,\n  "env": {\n    "hasCookie": true,\n    "cookieCount": 2,\n    "xBogusReady": true\n  }\n}'
      },
      {
        method: 'GET',
        path: '/api/cookies/health',
        desc: 'Kiểm tra sức khỏe Cookie TikTok đăng nhập bằng cách gửi request test lấy STS upload token. Đảm bảo cookie không bị hết hạn hoặc thiếu quyền.',
        headers: [{ name: 'Authorization', value: 'Bearer <token>' }],
        body: '',
        response: '{\n  "status": "alive",\n  "alive": true,\n  "latencyMs": 142,\n  "cookieCount": 2,\n  "message": "Cookie còn sống, lấy STS Upload Token thành công."\n}'
      },
      {
        method: 'GET',
        path: '/api/xbogus/health',
        desc: 'Kiểm tra hoạt động của bộ sinh chữ ký X-Bogus (local hoặc jsdom-rpc) bằng cách gửi request giả lập lên TikTok WAF.',
        headers: [{ name: 'Authorization', value: 'Bearer <token>' }],
        body: '',
        response: '{\n  "status": "passed",\n  "ok": true,\n  "checkedAt": "2026-06-25T15:00:00.000Z",\n  "latencyMs": 95,\n  "signerMode": "local",\n  "httpStatus": 200,\n  "tikTokStatusCode": 0,\n  "message": "Chữ ký X-Bogus hợp lệ: TikTok đã nhận request..."\n}'
      }
    ]
  },
  {
    category: 'Pipeline Tải Lên (Upload)',
    endpoints: [
      {
        method: 'POST',
        path: '/api/upload',
        desc: 'API tải video nhị phân lên server để đưa vào pipeline xử lý. Server sẽ lưu tạm file, sinh Job ID và thực hiện tác vụ ngầm. Kết nối HTTP được giữ dưới dạng Server-Sent Events (SSE) để truyền logs.',
        headers: [
          { name: 'Authorization', value: 'Bearer <token>' },
          { name: 'Content-Type', value: 'application/octet-stream' },
          { name: 'x-filename', value: 'video.mp4 (Tên file gốc)' },
          { name: 'x-segment-concurrency', value: '2 (Số luồng tách HLS)' },
          { name: 'x-upload-concurrency', value: '4 (Số luồng upload CDN)' }
        ],
        body: 'Binary stream data (Dữ liệu file video thô)',
        response: 'event: meta\ndata: {"ok":true,"filename":"upload_123.bin","bytes":10485760,"segmentConcurrency":2,"uploadConcurrency":4,"jobId":"a1b2c3d4-..."}\n\nevent: progress\ndata: {"step":"probe","percent":5,"message":"Video probing"}\n\nevent: done\ndata: {"ok":true,"jobId":"a1b2c3d4-...","playlistUrl":"...","carrierPlaylistUrl":"..."}'
      },
      {
        method: 'GET',
        path: '/api/jobs/:jobId/events',
        desc: 'Đăng ký nhận luồng sự kiện SSE (Server-Sent Events) của một Job đang chạy ngầm để khôi phục log hiển thị và thanh tiến độ khi người dùng reload trang.',
        headers: [{ name: 'Authorization', value: 'Bearer <token>' }],
        body: '',
        response: 'event: progress\ndata: {"step":"ffmpeg-cut","percent":35,"message":"Cắt video thành HLS..."}'
      },
      {
        method: 'POST',
        path: '/api/jobs/:jobId/cancel',
        desc: 'Hủy khẩn cấp một job đang xử lý. Tắt tiến trình FFmpeg (nếu đang chạy), dừng các luồng upload CDN, cập nhật trạng thái job thành cancelled.',
        headers: [{ name: 'Authorization', value: 'Bearer <token>' }],
        body: '',
        response: '{\n  "ok": true\n}'
      }
    ]
  },
  {
    category: 'Quản Lý Jobs',
    endpoints: [
      {
        method: 'GET',
        path: '/api/jobs',
        desc: 'Lấy danh sách tất cả các Jobs trong hệ thống (bao gồm cả job đang xử lý trong RAM và job đã hoàn thành trên đĩa).',
        headers: [{ name: 'Authorization', value: 'Bearer <token>' }],
        body: '',
        response: '{\n  "jobs": [\n    {\n      "jobId": "a1b2c3d4-...",\n      "createdAt": "2026-06-25T15:00:00.000Z",\n      "updatedAt": "2026-06-25T15:05:00.000Z",\n      "total": 45,\n      "uploaded": 45,\n      "complete": true,\n      "status": "complete",\n      "percent": 100,\n      "size": 10485760,\n      "sourceSize": 10485760\n    }\n  ]\n}'
      },
      {
        method: 'GET',
        path: '/api/jobs/:jobId',
        desc: 'Lấy Manifest JSON chi tiết của một job. Chứa danh sách các segments, thời lượng, kích thước và link ảnh carrier CDN.',
        headers: [{ name: 'Authorization', value: 'Bearer <token>' }],
        body: '',
        response: '{\n  "jobId": "a1b2c3d4-...",\n  "createdAt": "2026-06-25T15:00:00.000Z",\n  "complete": true,\n  "status": "complete",\n  "segments": [\n    {\n      "index": 0,\n      "duration": 4.12,\n      "uploaded": true,\n      "imageUrl": "/api/jobs/a1b2c3d4-.../images/0",\n      "publicImageUrl": "https://p16-sg.tiktokcdn.com/...",\n      "directImageUrl": "https://p16-sign-sg.tiktokcdn.com/..."\n    }\n  ]\n}'
      },
      {
        method: 'DELETE',
        path: '/api/jobs/:jobId',
        desc: 'Xóa hoàn toàn dữ liệu của Job, bao gồm tệp Manifest JSON trên đĩa và thư mục chứa các mảnh video đã mã hoá.',
        headers: [{ name: 'Authorization', value: 'Bearer <token>' }],
        body: '',
        response: '{\n  "ok": true\n}'
      }
    ]
  },
  {
    category: 'Giải Mã / Khôi Phục',
    endpoints: [
      {
        method: 'POST',
        path: '/api/jobs/:jobId/reconstruct',
        desc: 'Bắt đầu giải mã các segment dạng ảnh PNG carrier trên TikTok CDN thành các file .ts nhị phân và dùng FFmpeg ghép lại thành video MP4 gốc.',
        headers: [{ name: 'Authorization', value: 'Bearer <token>' }],
        body: '',
        response: '{\n  "ok": true,\n  "state": {\n    "status": "processing",\n    "percent": 0,\n    "message": "Bắt đầu quá trình khôi phục..."\n  }\n}'
      },
      {
        method: 'GET',
        path: '/api/jobs/:jobId/reconstruct/status',
        desc: 'Kiểm tra tiến độ giải mã khôi phục video thời gian thực từ RAM của server.',
        headers: [{ name: 'Authorization', value: 'Bearer <token>' }],
        body: '',
        response: '{\n  "status": "processing",\n  "percent": 45,\n  "message": "Đang ghép các phân đoạn video (FFmpeg)...",\n  "error": null\n}'
      },
      {
        method: 'GET',
        path: '/api/jobs/:jobId/reconstruct/download',
        desc: 'Tải về video MP4 hoàn chỉnh sau khi khôi phục thành công. Server sẽ tự động xoá file MP4 tạm này ngay khi quá trình download hoàn tất.',
        headers: [{ name: 'Authorization', value: 'Bearer <token>' }],
        body: '',
        response: 'Binary Stream (.mp4 File)'
      }
    ]
  },
  {
    category: 'Quản Lý Người dùng & API Token',
    endpoints: [
      {
        method: 'GET',
        path: '/api/tokens',
        desc: 'Lấy toàn bộ danh sách các API Tokens trong hệ thống bao gồm Username, Token thô, trạng thái active và ngày tạo.',
        headers: [{ name: 'Authorization', value: 'Bearer <token>' }],
        body: '',
        response: '{\n  "ok": true,\n  "tokens": [\n    {\n      "username": "admin",\n      "token": "tok_admin_default_719",\n      "createdAt": "2026-06-25T15:00:00.000Z",\n      "active": true\n    }\n  ]\n}'
      },
      {
        method: 'POST',
        path: '/api/tokens',
        desc: 'Tạo một API Token ngẫu nhiên mới cấp cho một người dùng mới.',
        headers: [
          { name: 'Authorization', value: 'Bearer <token>' },
          { name: 'Content-Type', value: 'application/json' }
        ],
        body: '{\n  "username": "ten_nguoi_dung_moi"\n}',
        response: '{\n  "ok": true,\n  "token": {\n    "username": "ten_nguoi_dung_moi",\n    "token": "tok_ten_nguoi_dung_moi_abc12345",\n    "createdAt": "2026-06-25T15:10:00.000Z",\n    "active": true\n  }\n}'
      },
      {
        method: 'POST',
        path: '/api/tokens/:token/toggle',
        desc: 'Bật hoặc tắt (kích hoạt / vô hiệu hóa) tạm thời một API Token mà không cần xóa hẳn.',
        headers: [{ name: 'Authorization', value: 'Bearer <token>' }],
        body: '',
        response: '{\n  "ok": true,\n  "token": {\n    "username": "admin",\n    "token": "tok_admin_default_719",\n    "createdAt": "2026-06-25T15:00:00.000Z",\n    "active": false\n  }\n}'
      },
      {
        method: 'DELETE',
        path: '/api/tokens/:token',
        desc: 'Xóa hoàn toàn một API Token khỏi cơ sở dữ liệu. Admin mặc định không thể bị xóa nếu là token hoạt động cuối cùng.',
        headers: [{ name: 'Authorization', value: 'Bearer <token>' }],
        body: '',
        response: '{\n  "ok": true\n}'
      }
    ]
  },
  {
    category: 'Phát Video & Streaming',
    endpoints: [
      {
        method: 'GET',
        path: '/carrier/:jobId/master.m3u8',
        desc: 'Trả về file Master Playlist định dạng HLS cho trình phát video. Các segment trong file trỏ tới API Proxy giải mã của Server.',
        headers: [{ name: 'token', value: 'tok_admin_default_719' }],
        body: '',
        response: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4.120,\n/carrier/a1b2c3d4-.../segment/0.ts?token=tok_admin_default_719\n#EXTINF:4.120,\n/carrier/a1b2c3d4-.../segment/1.ts?token=tok_admin_default_719\n#EXT-X-ENDLIST'
      },
      {
        method: 'GET',
        path: '/carrier/:jobId/segment/:index.ts',
        desc: 'API Fallback / Proxy giải mã segment: Server sẽ tải ảnh PNG từ TikTok CDN về, giải mã nhị phân thành file TS gốc và stream trực tiếp về cho trình phát video HLS.',
        headers: [{ name: 'token', value: 'tok_admin_default_719' }],
        body: '',
        response: 'Binary Stream (.ts Video Segment)'
      },
      {
        method: 'GET',
        path: '/player?jobId=:jobId',
        desc: 'Giao diện phát video trực tiếp. Tích hợp Hls.js và thuật toán client-side decoder: Trình duyệt tự tải ảnh PNG từ TikTok CDN về, giải mã trực tiếp bằng Canvas/Web Worker rồi truyền qua MSE để phát. Giảm tải 100% băng thông cho server Node.js.',
        headers: [{ name: 'token', value: 'tok_admin_default_719' }],
        body: '',
        response: 'HTML Page'
      }
    ]
  }
];

function ApiDocs() {
  const [selectedEndpoint, setSelectedEndpoint] = useState(apiEndpoints[0].endpoints[0]);
  const [copiedText, setCopiedText] = useState('');

  const handleCopy = (text, type) => {
    navigator.clipboard?.writeText(text);
    setCopiedText(type);
    setTimeout(() => setCopiedText(''), 2000);
  };

  const getMethodBadgeClass = (method) => {
    switch (method) {
      case 'GET': return 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30';
      case 'POST': return 'bg-blue-500/15 text-blue-300 ring-1 ring-blue-500/30';
      case 'DELETE': return 'bg-red-500/15 text-red-300 ring-1 ring-red-500/30';
      default: return 'bg-zinc-800 text-zinc-300';
    }
  };

  const getJsSnippet = (endpoint) => {
    let headersObj = {};
    endpoint.headers.forEach(h => {
      headersObj[h.name] = h.value;
    });
    
    let options = {
      method: endpoint.method,
    };
    
    if (endpoint.headers.length > 0) {
      options.headers = headersObj;
    }
    
    if (endpoint.body) {
      options.body = endpoint.body.startsWith('//') || endpoint.body.includes('Binary') 
        ? '___BODY___'
        : JSON.parse(endpoint.body.startsWith('{') ? endpoint.body : '{}');
    }
    
    let optionsStr = JSON.stringify(options, null, 2);
    if (endpoint.body && (endpoint.body.startsWith('//') || endpoint.body.includes('Binary') || endpoint.body.includes('['))) {
      optionsStr = optionsStr.replace('"___BODY___"', '/* Dữ liệu nhị phân hoặc danh sách Cookies */');
    }
    
    return `// JavaScript Fetch Example
fetch('${window.location.origin}${endpoint.path}', ${optionsStr})
  .then(res => res.json())
  .then(data => console.log(data))
  .catch(err => console.error(err));`;
  };

  return (
    <div className="space-y-6">
      <SectionTitle title="Tài liệu API & Hướng dẫn sử dụng" subtitle="Full API của hệ thống TikTok Carrier Pipeline, phục vụ tích hợp bên thứ ba hoặc phát triển mở rộng." />
      
      <Card className="p-5 border-cyan-500/20 bg-cyan-500/5">
        <div className="flex items-center gap-2 text-sm font-semibold text-cyan-300">
          <ShieldCheck className="h-5 w-5 text-cyan-400" /> Hướng dẫn Xác thực API bằng Token
        </div>
        <p className="mt-2 text-xs text-zinc-300 leading-relaxed">
          Tất cả các yêu cầu gọi tới các dịch vụ API bắt đầu bằng <code>/api/</code> đều phải đính kèm API Token hợp lệ trong yêu cầu để xác thực quyền truy cập. 
          Hệ thống hỗ trợ 2 cách truyền Token linh hoạt:
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-2 text-xs">
          <div className="rounded-lg border border-zinc-800/80 bg-zinc-950 p-4">
            <div className="font-semibold text-zinc-200 flex items-center gap-2">
              <Code className="h-4 w-4 text-emerald-400" /> Cách 1: Sử dụng Authorization Header (Khuyên dùng)
            </div>
            <p className="mt-1 text-zinc-400 text-[11px]">Đính kèm chuỗi Bearer Token vào header của yêu cầu HTTP.</p>
            <pre className="mt-2.5 p-3 rounded-lg bg-black text-cyan-300 font-mono text-[10px] border border-zinc-800 overflow-x-auto">
              Authorization: Bearer YOUR_API_TOKEN
            </pre>
          </div>
          <div className="rounded-lg border border-zinc-800/80 bg-zinc-950 p-4">
            <div className="font-semibold text-zinc-200 flex items-center gap-2">
              <Globe className="h-4 w-4 text-cyan-400" /> Cách 2: Sử dụng Query Parameter (Tiện lợi)
            </div>
            <p className="mt-1 text-zinc-400 text-[11px]">Thêm tham số token vào chuỗi truy vấn (query string) của URL.</p>
            <pre className="mt-2.5 p-3 rounded-lg bg-black text-cyan-300 font-mono text-[10px] border border-zinc-800 overflow-x-auto">
              ?token=YOUR_API_TOKEN
            </pre>
          </div>
        </div>
        <div className="mt-4 text-xs text-zinc-400 leading-relaxed border-t border-zinc-800 pt-3">
          API Token hoạt động của Dashboard hiện tại: <code className="px-1.5 py-0.5 rounded bg-zinc-800 text-cyan-200 font-mono">{localStorage.getItem('api_token') || 'tok_admin_default_719'}</code>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-4">
        {/* Sidebar */}
        <Card className="p-4 lg:col-span-1 space-y-4 max-h-[80vh] overflow-y-auto">
          {apiEndpoints.map((cat, catIdx) => (
            <div key={catIdx} className="space-y-1">
              <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 px-2 py-1">{cat.category}</div>
              {cat.endpoints.map((ep, epIdx) => {
                const isSelected = selectedEndpoint.path === ep.path && selectedEndpoint.method === ep.method;
                return (
                  <button
                    key={epIdx}
                    onClick={() => setSelectedEndpoint(ep)}
                    className={`w-full flex flex-col text-left rounded-lg p-2 transition-all duration-200 ${isSelected ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-bold ${getMethodBadgeClass(ep.method)}`}>{ep.method}</span>
                      <span className="font-mono text-xs truncate">{ep.path}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </Card>

        {/* Content */}
        <Card className="p-6 lg:col-span-3 space-y-6 min-h-[60vh] overflow-x-hidden">
          {/* Header */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-zinc-800 pb-4">
            <div className="flex items-center gap-3">
              <span className={`text-xs px-2.5 py-1 rounded-lg font-mono font-bold ${getMethodBadgeClass(selectedEndpoint.method)}`}>
                {selectedEndpoint.method}
              </span>
              <span className="font-mono text-lg font-semibold tracking-tight text-zinc-100">{selectedEndpoint.path}</span>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => handleCopy(`${window.location.origin}${selectedEndpoint.path}`, 'url')}>
                <Copy className="h-4 w-4" />
                {copiedText === 'url' ? 'Đã copy URL!' : 'Copy full URL'}
              </Button>
            </div>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
              <FileText className="h-4 w-4 text-cyan-300" /> Mô tả
            </h3>
            <p className="text-sm text-zinc-400 leading-relaxed">{selectedEndpoint.desc}</p>
          </div>

          {/* Headers */}
          {selectedEndpoint.headers.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
                <Code className="h-4 w-4 text-emerald-300" /> Request Headers
              </h3>
              <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/60">
                <table className="w-full text-left text-xs font-mono">
                  <thead className="bg-zinc-900 text-zinc-400">
                    <tr>
                      <th className="px-4 py-2">Header Name</th>
                      <th className="px-4 py-2">Example Value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800 text-zinc-300">
                    {selectedEndpoint.headers.map((h, i) => (
                      <tr key={i}>
                        <td className="px-4 py-2 text-cyan-200">{h.name}</td>
                        <td className="px-4 py-2">{h.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Body */}
          {selectedEndpoint.body && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
                  <Binary className="h-4 w-4 text-purple-300" /> Request Body
                </h3>
                <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => handleCopy(selectedEndpoint.body, 'body')}>
                  <Copy className="h-3 w-3" />
                  {copiedText === 'body' ? 'Đã copy!' : 'Copy'}
                </Button>
              </div>
              <pre className="p-4 rounded-lg bg-black/80 font-mono text-xs text-zinc-300 overflow-auto border border-zinc-800 max-h-48 whitespace-pre-wrap">
                {selectedEndpoint.body}
              </pre>
            </div>
          )}

          {/* Response */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
                <Database className="h-4 w-4 text-yellow-300" /> Response Example
              </h3>
              <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => handleCopy(selectedEndpoint.response, 'res')}>
                <Copy className="h-3 w-3" />
                {copiedText === 'res' ? 'Đã copy!' : 'Copy'}
              </Button>
            </div>
            <pre className="p-4 rounded-lg bg-black/80 font-mono text-xs text-zinc-300 overflow-auto border border-zinc-800 max-h-64">
              {selectedEndpoint.response}
            </pre>
          </div>

          {/* Example Code */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
                <Code className="h-4 w-4 text-cyan-300" /> JavaScript Fetch
              </h3>
              <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => handleCopy(getJsSnippet(selectedEndpoint), 'js')}>
                <Copy className="h-3 w-3" />
                {copiedText === 'js' ? 'Đã copy!' : 'Copy'}
              </Button>
            </div>
            <pre className="p-4 rounded-lg bg-black/80 font-mono text-xs text-emerald-400 overflow-auto border border-zinc-800 whitespace-pre">
              {getJsSnippet(selectedEndpoint)}
            </pre>
          </div>
        </Card>
      </div>
    </div>
  );
}

function TokenManager() {
  const [tokens, setTokens] = useState([]);
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showToken, setShowToken] = useState({});
  const [activeTokenInput, setActiveTokenInput] = useState(() => localStorage.getItem('api_token') || 'tok_admin_default_719');
  
  async function loadTokens() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/tokens`);
      if (!res.ok) {
        if (res.status === 403 || res.status === 401) {
          setError(`Lỗi xác thực (${res.status}): API Token hiện tại không hợp lệ hoặc đã bị vô hiệu hóa. Vui lòng nhập token chính xác ở phần "Cấu hình Phiên Dashboard" bên trái (mặc định là tok_admin_default_719).`);
          return;
        }
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.ok) {
        setTokens(data.tokens || []);
      }
    } catch (err) {
      setError(`Không thể tải danh sách token: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }
  
  useEffect(() => {
    loadTokens();
  }, []);
  
  async function createToken(e) {
    e.preventDefault();
    if (!username.trim()) return;
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const res = await fetch(`${API}/api/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setSuccess(`Đã tạo thành công token cho người dùng "${data.token.username}"`);
        setUsername('');
        await loadTokens();
      } else {
        throw new Error(data.error || 'Lỗi không xác định');
      }
    } catch (err) {
      setError(`Lỗi tạo token: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }
  
  async function toggleToken(tokenStr) {
    setError('');
    try {
      const res = await fetch(`${API}/api/tokens/${tokenStr}/toggle`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.ok) {
        await loadTokens();
      } else {
        throw new Error(data.error || 'Lỗi không xác định');
      }
    } catch (err) {
      setError(`Lỗi thay đổi trạng thái token: ${err.message}`);
    }
  }
  
  async function deleteToken(tokenStr) {
    if (!confirm(`Bạn có chắc chắn muốn xóa token này?`)) return;
    setError('');
    try {
      const res = await fetch(`${API}/api/tokens/${tokenStr}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok && data.ok) {
        await loadTokens();
      } else {
        throw new Error(data.error || 'Lỗi không xác định');
      }
    } catch (err) {
      setError(`Lỗi xóa token: ${err.message}`);
    }
  }
  
  function saveActiveToken() {
    const cleanToken = activeTokenInput.trim();
    if (!cleanToken) {
      alert('Vui lòng nhập API Token hợp lệ');
      return;
    }
    localStorage.setItem('api_token', cleanToken);
    alert('Đã lưu token hoạt động. Trang web sẽ tự động reload để áp dụng cấu hình mới.');
    window.location.reload();
  }
  
  return (
    <div className="space-y-6">
      <SectionTitle title="Quản lý Người dùng & API Token" subtitle="Cấp phát, bật/tắt và xóa token xác thực API. Cấu hình token hoạt động cho trình duyệt." />
      
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Left side: Config dashboard active token & create new token */}
        <div className="lg:col-span-1 space-y-4">
          <Card className="p-5">
            <div className="text-sm font-medium text-zinc-100 mb-4 flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-400" /> Cấu hình Phiên Dashboard
            </div>
            <div className="space-y-4">
              <label className="block space-y-2 text-sm text-zinc-300">
                <span>Nhập API Token đang sử dụng:</span>
                <input
                  type="text"
                  value={activeTokenInput}
                  onChange={e => setActiveTokenInput(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200 outline-none focus:ring-2 focus:ring-cyan-500/60"
                  placeholder="tok_admin_default_719"
                />
              </label>
              <Button variant="accent" onClick={saveActiveToken} className="w-full justify-center">
                <Save className="h-4 w-4" /> Lưu Token Hoạt động
              </Button>
            </div>
            <div className="mt-4 text-xs text-zinc-400 leading-relaxed border-t border-zinc-800/60 pt-3">
              <strong>Lưu ý:</strong> API Token này được lưu ở bộ nhớ trình duyệt (`localStorage`) để gửi kèm trong header xác thực của các yêu cầu API.
            </div>
          </Card>
          
          <Card className="p-5">
            <div className="text-sm font-medium text-zinc-100 mb-4 flex items-center gap-2">
              <Key className="h-4 w-4 text-cyan-400" /> Cấp API Token mới
            </div>
            <form onSubmit={createToken} className="space-y-4">
              <label className="block space-y-2 text-sm text-zinc-300">
                <span>Tên người dùng (Username / App):</span>
                <input
                  type="text"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 outline-none focus:ring-2 focus:ring-cyan-500/60"
                  placeholder="Ví dụ: app_khach_hang_A"
                  disabled={loading}
                />
              </label>
              <Button type="submit" variant="default" className="w-full justify-center" disabled={loading || !username.trim()}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                Tạo Token
              </Button>
            </form>
            
            {error && (
              <div className="mt-3 rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-xs text-red-400">
                {error}
              </div>
            )}
            {success && (
              <div className="mt-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-3 text-xs text-emerald-400">
                {success}
              </div>
            )}
          </Card>
        </div>
        
        {/* Right side: Token list table */}
        <Card className="lg:col-span-2 overflow-x-auto p-5">
          <div className="text-sm font-medium text-zinc-100 mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-purple-400" /> Danh sách API Tokens trong Hệ thống
            </div>
            <Button variant="ghost" onClick={loadTokens} disabled={loading} className="h-8 px-2 text-xs">
              <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> Làm mới
            </Button>
          </div>
          
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-950 text-zinc-500">
              <tr>
                <th className="px-4 py-2.5">Người dùng</th>
                <th className="px-4 py-2.5">API Token</th>
                <th className="px-4 py-2.5">Ngày tạo</th>
                <th className="px-4 py-2.5 text-center">Trạng thái</th>
                <th className="px-4 py-2.5 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 text-zinc-300">
              {tokens.length ? (
                tokens.map((item) => {
                  const isCurrent = item.token === localStorage.getItem('api_token');
                  return (
                    <tr key={item.token} className={`hover:bg-zinc-900/30 ${isCurrent ? 'bg-cyan-500/5' : ''}`}>
                      <td className="px-4 py-3">
                        <span className="font-semibold text-zinc-100">{item.username}</span>
                        {isCurrent && <Badge tone="blue" className="ml-1">Đang dùng</Badge>}
                      </td>
                      <td className="px-4 py-3 font-mono">
                        <div className="flex items-center gap-2">
                          <span>
                            {showToken[item.token] ? item.token : `${item.token.slice(0, 10)}...`}
                          </span>
                          <button
                            onClick={() => setShowToken(prev => ({ ...prev, [item.token]: !prev[item.token] }))}
                            className="text-zinc-500 hover:text-zinc-300"
                            title="Hiện/Ẩn Token"
                          >
                            {showToken[item.token] ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </button>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(item.token);
                              alert('Đã copy API Token vào clipboard!');
                            }}
                            className="text-zinc-500 hover:text-zinc-300"
                            title="Copy Token"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-zinc-400">
                        {item.createdAt ? new Date(item.createdAt).toLocaleString('vi-VN') : '—'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={() => toggleToken(item.token)}
                          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${item.active ? 'bg-cyan-500' : 'bg-zinc-700'}`}
                          title={item.active ? "Click để Vô hiệu hóa" : "Click để Kích hoạt"}
                        >
                          <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${item.active ? 'translate-x-4' : 'translate-x-0'}`} />
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => deleteToken(item.token)}
                          className="text-red-400 hover:text-red-300 transition-colors p-1"
                          title="Xóa Token"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan="5" className="px-4 py-8 text-center text-zinc-500">
                    {loading ? 'Đang tải dữ liệu...' : 'Không tìm thấy Token nào trong hệ thống.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}

function TerminalPanel({ logs }) {
  return (
    <Card className="mt-6 overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-zinc-300"><TerminalSquare className="h-4 w-4" />Terminal realtime</div>
        <Badge tone="green">Đang nghe log</Badge>
      </div>
      <div className="max-h-52 overflow-auto bg-black p-4 font-mono text-xs text-zinc-300">
        <div className="space-y-1">
          {logs.length ? logs.map((line, idx) => <div key={`${idx}-${line}`} className="whitespace-pre-wrap break-words">▶ {line}</div>) : <div className="text-zinc-600">▶ pipeline tải lên đang chờ</div>}
        </div>
      </div>
    </Card>
  );
}

export default function App() {
  const [tab, setTab] = useState('home');
  const [selectedJob, setSelectedJob] = useState(null);
  const [restoreJobId, setRestoreJobId] = useState(null);
  const [terminalLogs, setTerminalLogs] = useState(['server đã sẵn sàng tại /dashboard', 'pipeline tải lên đang chờ']);
  const [status, setStatus] = useState(null);
  const [tokenError, setTokenError] = useState(false);

  useEffect(() => {
    const handleTokenError = () => setTokenError(true);
    window.addEventListener('ttk-token-error', handleTokenError);
    return () => window.removeEventListener('ttk-token-error', handleTokenError);
  }, []);

  useEffect(() => {
    async function getStatus() {
      try {
        const res = await fetch(`${API}/api/server/status`);
        if (res.ok) {
          const data = await res.json();
          setStatus(data);
          if (data.concurrency) {
            if (!localStorage.getItem('segment_concurrency')) {
              localStorage.setItem('segment_concurrency', String(data.concurrency.segmentConcurrency));
            }
            if (!localStorage.getItem('upload_concurrency')) {
              localStorage.setItem('upload_concurrency', String(data.concurrency.uploadConcurrency));
            }
            if (!localStorage.getItem('reconstruct_concurrency')) {
              localStorage.setItem('reconstruct_concurrency', String(data.concurrency.reconstructConcurrency));
            }
          }
        }
      } catch (err) {
        console.error(err);
      }
    }
    getStatus();
  }, []);

  const appendTerminalLog = useCallback((line) => {
    const stamped = `[${new Date().toLocaleTimeString('vi-VN')}] ${line}`;
    setTerminalLogs(prev => [stamped, ...prev].slice(0, 160));
  }, []);
  const playJob = (job) => {
    setSelectedJob(job);
    setTab('player');
  };
  const views = {
    home: <DashboardHome />,
    upload: <VideoUploader onLog={appendTerminalLog} serverStatus={status} restoreJobId={restoreJobId} onClearRestore={() => setRestoreJobId(null)} />,
    cdn: <CdnManager />,
    jobs: <JobHistory onPlay={playJob} onViewProgress={(jobId) => { setRestoreJobId(jobId); setTab('upload'); }} />,
    player: <CarrierPlayer selectedJob={selectedJob} />,
    users: <TokenManager />,
    docs: <ApiDocs />,
  };

  return (
    <div className="flex min-h-full bg-zinc-950 text-zinc-50">
      <aside className="hidden w-60 shrink-0 border-r border-zinc-800/80 bg-zinc-950 px-4 py-5 lg:block">
        <div className="mb-8">
          <div className="text-xs uppercase tracking-[0.35em] text-zinc-500">Claude Artifacts</div>
          <div className="mt-2 text-xl font-semibold tracking-tight">TikTok Pipeline</div>
        </div>
        <nav className="space-y-2">
          {navItems.map(item => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button key={item.id} onClick={() => setTab(item.id)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all duration-200 ${active ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'}`}>
                <Icon className="h-4 w-4" />{item.label}
              </button>
            );
          })}
        </nav>
      </aside>
      <main className="flex-1 px-4 py-5 lg:px-6">
        <header className="mb-6 flex items-center justify-between rounded-xl border border-zinc-800/60 bg-zinc-900/40 px-4 py-3">
          <div>
            <div className="text-xs uppercase tracking-[0.25em] text-zinc-500">Bảng điều khiển</div>
            <div className="text-lg font-semibold tracking-tight">{navItems.find(item => item.id === tab)?.label}</div>
          </div>
          <div className="flex items-center gap-2 text-sm text-zinc-400"><ShieldCheck className="h-4 w-4 text-emerald-400" />Đã kết nối</div>
        </header>

        {tokenError && (
          <div className="mb-6 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 shrink-0 text-red-400" />
              <span>
                <strong>Lỗi Xác thực API Token (401/403)</strong>: Token hiện tại của bạn không hợp lệ hoặc đã bị vô hiệu hóa trên server. Vui lòng chuyển sang tab <strong>Quản lý Token</strong> để cấu hình lại, hoặc bấm reset về token mặc định.
              </span>
            </div>
            <Button variant="danger" className="h-8 py-1 text-xs shrink-0" onClick={() => { localStorage.setItem('api_token', 'tok_admin_default_719'); window.location.reload(); }}>
              Reset về Token mặc định
            </Button>
          </div>
        )}

        {views[tab]}
        <TerminalPanel logs={terminalLogs} />
      </main>
    </div>
  );
}
