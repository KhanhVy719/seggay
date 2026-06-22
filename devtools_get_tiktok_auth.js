// Paste this into DevTools Console while you are logged in at https://www.tiktok.com/
// It only prints values locally in your browser console. Do not share the output publicly.
(() => {
  const cookies = document.cookie || '';
  const getCookie = (name) => {
    const found = cookies.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
    return found ? decodeURIComponent(found.slice(name.length + 1)) : '';
  };
  
  const csrf = getCookie('tt_csrf_token') || getCookie('csrf_session_id') || '';
  const env = [
    `TIKTOK_CSRF_TOKEN=${csrf}`,
    `TIKTOK_COOKIE="${cookies}"`,
  ].join('\n');

  console.log('%cTikTok Env values (copy into .env or launcher option 2):', 'color:#00c853;font-weight:bold');
  console.log(env);

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(env)
      .then(() => console.log('Copied to clipboard.'))
      .catch(() => console.log('Clipboard copy failed; copy the text above manually.'));
  }

  if (!csrf) console.warn('No csrf cookie found. Make sure you are on www.tiktok.com and logged in.');
  
  const verifyFp = getCookie('s_v_web_id');
  if (!verifyFp) console.warn('Warning: s_v_web_id (verifyFp) cookie is missing. Upload might fail.');
})();
