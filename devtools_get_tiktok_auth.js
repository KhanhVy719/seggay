// Dán toàn bộ mã này vào DevTools Console (F12 -> tab Console) sau khi đăng nhập TikTok tại https://www.tiktok.com/
// Đoạn mã chỉ hoạt động cục bộ trên trình duyệt của bạn để lấy thông tin kết nối an toàn.
(() => {
  console.clear();
  console.log('%c[TikTok Auth Grabber] Đang khởi chạy script...', 'color:#ff0050;font-weight:bold;font-size:14px;');

  const getCookie = (name) => {
    const cookies = document.cookie || '';
    const found = cookies.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
    return found ? decodeURIComponent(found.slice(name.length + 1)) : '';
  };

  const findCsrfFromCookies = () => {
    // 1. Kiểm tra các cookie CSRF phổ biến của TikTok
    const exactNames = ['tt_csrf_token', 'csrf_session_id', 'passport_csrf_token', 'ac_csrftoken', 'tt_csrf_token_default'];
    for (const name of exactNames) {
      const val = getCookie(name);
      if (val) return val;
    }
    // 2. Tìm bất cứ cookie nào chứa chữ 'csrf'
    const cookies = document.cookie || '';
    const csrfCookie = cookies.split(';').map(v => v.trim()).find(v => v.toLowerCase().includes('csrf'));
    if (csrfCookie) {
      const parts = csrfCookie.split('=');
      const val = decodeURIComponent(parts.slice(1).join('='));
      if (val && val.length > 5) return val; // tránh các giá trị quá ngắn/rỗng
    }
    return '';
  };

  const getEnvText = (csrfToken) => {
    const cookies = document.cookie || '';
    return [
      `TIKTOK_CSRF_TOKEN=${csrfToken || ''}`,
      `TIKTOK_COOKIE="${cookies}"`
    ].join('\n');
  };

  const copyToClipboard = (text, quiet = false) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => {
          if (!quiet) console.log('%c[+] ĐÃ SAO CHÉP VÀO CLIPBOARD THÀNH CÔNG! Vui lòng dán trực tiếp vào Launcher.', 'color:#00c853;font-weight:bold;');
        })
        .catch(() => {
          if (!quiet) console.warn('[-] Không thể tự động sao chép vào clipboard, vui lòng copy phần text bên dưới thủ công.');
        });
    }
  };

  let currentCsrf = findCsrfFromCookies();
  
  const printAuthInfo = (csrf, source = 'Cookie') => {
    console.log(`%c[!] Đã lấy được CSRF Token từ: ${source}`, 'color:#00e5ff;font-weight:bold;');
    const envBlock = getEnvText(csrf);
    
    console.log('%c---------------- TIKTOK CONFIG START ----------------', 'color:#ff0050;font-weight:bold;');
    console.log(`%c${envBlock}`, 'color:#fff;background:#222;padding:10px;border-radius:4px;font-family:monospace;display:block;');
    console.log('%c----------------- TIKTOK CONFIG END -----------------', 'color:#ff0050;font-weight:bold;');
    
    copyToClipboard(envBlock);
  };

  // 1. In thông tin ban đầu nếu tìm thấy
  if (currentCsrf) {
    printAuthInfo(currentCsrf, 'Duyệt Cookie');
  } else {
    console.warn('⚠️ Chưa tìm thấy csrf token trực tiếp từ cookie. Tiến hành theo dõi các cuộc gọi mạng ngầm...');
  }

  // 2. Hook Fetch & XHR để bắt tiêu đề động
  const handleCapturedToken = (token, method) => {
    if (token && token !== currentCsrf) {
      currentCsrf = token;
      console.log(`%c[+] BẮT ĐƯỢC TIÊU ĐỀ CSRF ĐỘNG QUA ${method}!`, 'color:#00c853;font-weight:bold;');
      printAuthInfo(token, `Theo dõi request (${method})`);
    }
  };

  // Hook window.fetch
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const request = args[0];
    const options = args[1];
    
    let headers = null;
    if (options && options.headers) {
      headers = options.headers;
    } else if (request && request.headers) {
      headers = request.headers;
    }

    if (headers) {
      let token = '';
      if (headers instanceof Headers) {
        token = headers.get('tt-csrf-token') || headers.get('x-secsdk-csrf-token') || headers.get('x-csrftoken');
      } else if (typeof headers === 'object') {
        token = headers['tt-csrf-token'] || headers['x-secsdk-csrf-token'] || headers['x-csrftoken'] || headers['tt-csrf-token-default'];
      }
      if (token) handleCapturedToken(token, 'fetch');
    }
    return originalFetch.apply(this, args);
  };

  // Hook XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  
  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    const lowerHeader = header.toLowerCase();
    if (lowerHeader === 'tt-csrf-token' || lowerHeader === 'x-secsdk-csrf-token' || lowerHeader === 'x-csrftoken') {
      if (value) handleCapturedToken(value, 'XMLHttpRequest');
    }
    return originalSetRequestHeader.apply(this, arguments);
  };

  // 3. Hướng dẫn lấy thủ công
  console.log('\n%c💡 HƯỚNG DẪN NẾU TIKTOK_CSRF_TOKEN VẪN BỊ TRỐNG:', 'color:#ffeb3b;font-weight:bold;');
  console.log('1. Nhấp chuột vào bất cứ đâu trên trang web (ví dụ: nút Tìm kiếm, trang cá nhân, hoặc cuộn video).');
  console.log('2. Script sẽ tự động bắt lấy CSRF Token từ các cuộc gọi mạng ngầm.');
  console.log('3. Nếu vẫn không được: Chuyển qua tab "Network" (Mạng) ở cạnh tab Console, gõ vào bộ lọc: "upload" hoặc "recommend".');
  console.log('4. Nhấp vào một request bất kỳ trong danh sách, nhìn sang phần "Headers" bên phải.');
  console.log('5. Cuộn xuống phần "Request Headers" (Tiêu đề yêu cầu), tìm tiêu đề "tt-csrf-token" và copy giá trị của nó.');
  
  const verifyFp = getCookie('s_v_web_id');
  if (!verifyFp) {
    console.warn('⚠️ Chú ý: Thiếu cookie s_v_web_id (verifyFp). Việc tải lên video có thể sẽ thất bại do cơ chế chống robot của TikTok. Hãy chắc chắn bạn đã đăng nhập và hoàn thành xác minh captcha trên trang web trước khi chạy script.');
  }
})();
