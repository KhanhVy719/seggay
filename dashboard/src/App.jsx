import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertCircle, ArrowRight, Binary, CloudLightning, Copy, Download, Eye, EyeOff, Film, Globe, History, Loader2, MoreVertical, RefreshCw, Save, Scissors, Server, ShieldCheck, UploadCloud, Video, ChevronDown, ChevronUp, Trash2, FolderSync, Waves, Cpu, Database, PlayCircle, TerminalSquare
} from 'lucide-react';

const API = '';

function absoluteUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  if (typeof window === 'undefined') return path;
  return `${window.location.origin}${path.startsWith('/') ? path : `/${path}`}`;
}

function jobLinks(jobId) {
  if (!jobId) return { streamUrl: '', embedUrl: '', iframeHtml: '' };
  const encodedJobId = encodeURIComponent(jobId);
  const streamUrl = absoluteUrl(`/carrier/${encodedJobId}/master.m3u8`);
  const embedUrl = absoluteUrl(`/player?jobId=${encodedJobId}&direct=1&auto=1&embed=1`);
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
  { id: 'cdn', label: 'Kho CDN', icon: Globe },
  { id: 'jobs', label: 'Lịch sử', icon: History },
  { id: 'player', label: 'Trình phát', icon: PlayCircle },
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

function VideoUploader({ onLog, serverStatus }) {
  const [file, setFile] = useState(null);
  const [open, setOpen] = useState(false);
  const [browserUploadProgress, setBrowserUploadProgress] = useState(0);
  const [progress, setProgress] = useState(0);
  const [step, setStep] = useState('idle');
  const [uploading, setUploading] = useState(false);
  const [share, setShare] = useState(null);
  const [segments, setSegments] = useState({ current: 0, total: 0, uploaded: 0, phasePercent: 0, duration: 0, file: '' });
  const [segmentConcurrencyInput, setSegmentConcurrencyInput] = useState(() => localStorage.getItem('segment_concurrency') || '1');
  const [uploadConcurrencyInput, setUploadConcurrencyInput] = useState(() => localStorage.getItem('upload_concurrency') || '3');
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

  useEffect(() => {
    if (!localStorage.getItem('segment_concurrency') && serverStatus?.concurrency?.segmentConcurrency) {
      setSegmentConcurrencyInput(String(serverStatus.concurrency.segmentConcurrency));
    }
    if (!localStorage.getItem('upload_concurrency') && serverStatus?.concurrency?.uploadConcurrency) {
      setUploadConcurrencyInput(String(serverStatus.concurrency.uploadConcurrency));
    }
  }, [serverStatus]);

  const saveConcurrencySettings = async () => {
    try {
      const response = await fetch('/api/config/concurrency', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          segmentConcurrency,
          uploadConcurrency,
        }),
      });
      const data = await response.json();
      if (data.ok) {
        localStorage.setItem('segment_concurrency', String(data.segmentConcurrency));
        localStorage.setItem('upload_concurrency', String(data.uploadConcurrency));
        appendUploadLog(`[Cấu hình] Đã lưu số luồng: tách HLS ${data.segmentConcurrency} luồng · upload CDN ${data.uploadConcurrency} luồng`);
        alert(`Đã lưu cấu hình luồng thành công!\n- Luồng tách: ${data.segmentConcurrency}\n- Luồng upload: ${data.uploadConcurrency}`);
      } else {
        throw new Error(data.error || 'Lỗi không xác định');
      }
    } catch (err) {
      appendUploadLog(`[Lỗi] Không thể lưu cấu hình luồng: ${err.message}`);
      localStorage.setItem('segment_concurrency', String(segmentConcurrency));
      localStorage.setItem('upload_concurrency', String(uploadConcurrency));
      alert(`Đã lưu tạm cấu hình luồng vào trình duyệt (Lỗi lưu server: ${err.message})`);
    }
  };
  const segmentConcurrency = normalizeThreadInput(segmentConcurrencyInput || '1', 1, 1, 4);
  const uploadConcurrency = normalizeThreadInput(uploadConcurrencyInput || '3', 3, 1, 8);

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

  const segmentLabel = segments.total ? `${segments.current}/${segments.total}` : '0/0';
  const uploadedLabel = segments.total ? `${segments.uploaded}/${segments.total}` : '0/0';
  const steps = [
    [Film, 'Quét video'],
    [Scissors, `Cắt HLS ${segmentLabel}`],
    [Binary, `Mã hóa carrier ${segmentLabel}`],
    [CloudLightning, `Đẩy CDN ${uploadedLabel}`],
  ];

  const carrierLabels = ['Chiều rộng canvas', 'Chiều cao canvas', 'Mật độ bit', 'Magic Header'];
  const handleSegmentConcurrencyChange = event => {
    setSegmentConcurrencyInput(event.target.value);
  };
  const handleUploadConcurrencyChange = event => {
    setUploadConcurrencyInput(event.target.value);
  };
  const handleSegmentConcurrencyBlur = () => {
    setSegmentConcurrencyInput(String(segmentConcurrency));
  };
  const handleUploadConcurrencyBlur = () => {
    setUploadConcurrencyInput(String(uploadConcurrency));
  };

  return (
    <div className="space-y-6">
      <SectionTitle title="Tải video" subtitle="Kéo thả, cấu hình carrier, stepper thời gian thực, chia sẻ." />
      <Card className="p-5">
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
          <Button variant="accent" onClick={submit} disabled={!file || uploading}>
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            {uploading ? 'Đang upload...' : 'Tải lên'}
          </Button>
          {uploading ? <Button variant="ghost" onClick={() => xhrRef.current?.abort()}>Hủy upload</Button> : null}
          <Button variant="ghost" onClick={() => setOpen(v => !v)}>{open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}Cấu hình Carrier</Button>
        </div>

        {open ? (
          <div className="mt-4 space-y-4 rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-2 text-sm text-zinc-300">
                <span className="flex items-center gap-2"><Scissors className="h-4 w-4 text-cyan-300" />Luồng tách HLS (1-4)</span>
                <input type="number" min="1" max="4" value={segmentConcurrencyInput} onChange={handleSegmentConcurrencyChange} onBlur={handleSegmentConcurrencyBlur} onFocus={e => e.target.select()} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono outline-none focus:ring-2 focus:ring-cyan-500/60" />
                <span className="block text-xs text-zinc-500">Dùng cho FFmpeg -threads, chỉ tự ép 1-4 khi rời ô hoặc bắt đầu upload.</span>
              </label>
              <label className="space-y-2 text-sm text-zinc-300">
                <span className="flex items-center gap-2"><CloudLightning className="h-4 w-4 text-emerald-300" />Luồng upload CDN (1-8)</span>
                <input type="number" min="1" max="8" value={uploadConcurrencyInput} onChange={handleUploadConcurrencyChange} onBlur={handleUploadConcurrencyBlur} onFocus={e => e.target.select()} className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono outline-none focus:ring-2 focus:ring-cyan-500/60" />
                <span className="block text-xs text-zinc-500">Upload song song các segment carrier lên TikTok CDN, chỉ tự ép 1-8 khi rời ô hoặc bắt đầu upload.</span>
              </label>
            </div>
            <div className="flex justify-end pt-2">
              <button
                onClick={saveConcurrencySettings}
                className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/60"
              >
                <Save className="h-4 w-4" /> Lưu cấu hình luồng
              </button>
            </div>
          </div>
        ) : null}

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
              <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">% gửi file</div>
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

  return (
    <div className="space-y-6">
      <SectionTitle title="CDN & Phiên TikTok" subtitle="Quản lý cookie đăng nhập, upload .ts, nhật ký rewrite đường dẫn." />
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
          <div className="text-sm text-zinc-400">Khu tải .ts</div>
          <div className="mt-4 rounded-xl border-2 border-dashed border-zinc-800 bg-zinc-950/60 p-8 text-center text-zinc-400">
            <FolderSync className="mx-auto h-10 w-10" />
            <div className="mt-3">Thả file .ts → encode PNG → đẩy CDN</div>
          </div>
        </Card>
      </div>
      <Card className="overflow-hidden">
        <div className="border-b border-zinc-800 px-5 py-4 text-sm text-zinc-400">Nhật ký rewrite đường dẫn</div>
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-950 text-zinc-500"><tr><th className="px-5 py-3">Gốc</th><th className="px-5 py-3">Đã đổi</th><th className="px-5 py-3">Trạng thái</th></tr></thead>
          <tbody>
            {[
              ['p16-va.tiktokcdn.com', 'p16-sg.tiktokcdn.com', 'Proxy'],
              ['p16-sign-va.tiktokcdn.com', 'p16-sign-sg.tiktokcdn.com', 'Ký'],
            ].map(([a, b, c]) => <tr key={a} className="border-t border-zinc-800"><td className="px-5 py-3">{a}</td><td className="px-5 py-3">{b}</td><td className="px-5 py-3"><Badge tone="blue">{c}</Badge></td></tr>)}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function JobHistory({ onPlay, onViewProgress }) {
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState({});
  const [openMenu, setOpenMenu] = useState(null);
  const [copyNotice, setCopyNotice] = useState('');

  async function refresh() {
    const res = await fetch(`${API}/api/jobs`);
    const data = res.ok ? await res.json() : [];
    const list = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : [];
    setJobs(list);
  }

  useEffect(() => { refresh().catch(() => {}); }, []);

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
      const res = await fetch(`${API}/api/jobs/${jobId}/reconstruct`);
      if (!res.ok) throw new Error('reconstruct failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${jobId}.mp4`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setBusy(prev => ({ ...prev, [jobId]: null }));
      setOpenMenu(null);
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
                        onClick={() => setOpenMenu(openMenu === job.jobId ? null : job.jobId)}
                        disabled={Boolean(state)}
                        aria-label="Mở menu thao tác job"
                      >
                        {state === 'reconstruct' ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreVertical className="h-4 w-4" />}
                      </Button>
                      {openMenu === job.jobId ? (
                        <div className="absolute right-0 top-full z-50 mt-2 w-64 rounded-xl border border-zinc-800 bg-zinc-950/95 p-2 shadow-2xl shadow-black/50 ring-1 ring-white/5 backdrop-blur">
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
                            <button onClick={() => cancelJob(job.jobId)} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300 focus:bg-red-500/10 focus:outline-none">
                              <AlertCircle className="h-4 w-4" />Hủy tiến trình
                            </button>
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
        {views[tab]}
        <TerminalPanel logs={terminalLogs} />
      </main>
    </div>
  );
}
