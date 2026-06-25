const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const CONSUMER_COOKIES_JSON = [{"domain":".tiktok.com","name":"ttwid","value":"1%7CXYF1f6kgkIsiC2WjpKFLyeTXzTAxWxLNYNreS4dnoXs%7C1776593253%7C83e875f46d40765dac41d8b3de9d8390867be4a2fa4d62120fed28e9c692cd40"},{"domain":".tiktok.com","name":"tt_chain_token","value":"w/rLPAcShdB89zPBNke1sg=="},{"domain":".tiktok.com","name":"d_ticket","value":"5bd7362e0d62d0cfb6e6188b55ffb49092d8f"},{"domain":".tiktok.com","name":"multi_sids","value":"7000343721028862977%3A644c1723605bc90e41553198d433f46c"},{"domain":".tiktok.com","name":"cmpl_token","value":"AgQYAPOF_hfkTtKxGNkh1b0dOPOFMFPZjD-WDmCmrkQ"},{"domain":".tiktok.com","name":"passport_auth_status","value":"f9ac8eaa774fa2c033750d723e63245e%2C"},{"domain":".tiktok.com","name":"sid_guard","value":"644c1723605bc90e41553198d433f46c%7C1782108518%7C15551999%7CSat%2C+19-Dec-2026+06%3A08%3A37+GMT"},{"domain":".tiktok.com","name":"uid_tt","value":"2708cc26047c95f74f8e978a16ec8d5f72d188e59ba6a2e8546ce24e04385e11"},{"domain":".tiktok.com","name":"sid_tt","value":"644c1723605bc90e41553198d433f46c"},{"domain":".tiktok.com","name":"sessionid","value":"644c1723605bc90e41553198d433f46c"},{"domain":".tiktok.com","name":"sessionid_ss","value":"644c1723605bc90e41553198d433f46c"},{"domain":".tiktok.com","name":"tt_session_tlb_tag","value":"sttt%7C1%7CZEwXI2BbyQ5BVTGY1DP0bP_________LDvSmKyvS_oDemLIgMVOe4EPcTCTpUw1PAtNFM4spv5s%3D"},{"domain":".tiktok.com","name":"sid_ucp_v1","value":"1.0.1-KDk1Zjk0MTRhMzkxZjFhMWQwZDQ3NzdmYTI4NGIxOTc5NGUxYjE2MDAKIQiBiL_s5fCNk2EQ5qLj0QYYswsgDDDlouPRBjgIQBJIBBADGgNteTIiIDY0NGMxNzIzNjA1YmM5MGU0MTU1MzE5OGQ0MzNmNDZjMk4KIMxUP5CbXAmGV1Kdm41FJ42s4E1e4zCAO6aQ1imMD5pREiCnHQ5ahGxyjtVVArX8ngjAF5uwCnsHEL09picZBUUxwBgFIgZ0aWt0b2s"},{"domain":".tiktok.com","name":"ssid_ucp_v1","value":"1.0.1-KDk1Zjk0MTRhMzkxZjFhMWQwZDQ3NzdmYTI4NGIxOTc5NGUxYjE2MDAKIQiBiL_s5fCNk2EQ5qLj0QYYswsgDDDlouPRBjgIQBJIBBADGgNteTIiIDY0NGMxNzIzNjA1YmM5MGU0MTU1MzE5OGQ0MzNmNDZjMk4KIMxUP5CbXAmGV1Kdm41FJ42s4E1e4zCAO6aQ1imMD5pREiCnHQ5ahGxyjtVVArX8ngjAF5uwCnsHEL09picZBUUxwBgFIgZ0aWt0b2s"},{"domain":".tiktok.com","name":"store-idc","value":"alisg"},{"domain":".tiktok.com","name":"store-country-code","value":"vn"},{"domain":".tiktok.com","name":"store-country-code-src","value":"uid"},{"domain":".tiktok.com","name":"tt-target-idc","value":"alisg"},{"domain":".tiktok.com","name":"tt-target-idc-sign","value":"Sy970MmPr-xlJSTQ9DEoidA2LkZuIQyP2Z3OE7pAsAdpbeSwmEDv0ZFEbD32JvjVPfJfj0iDpoislVuMFxPefKN4SDXsRwaOYbh0Ka1vcLgfR36V4nOHcG7sqT7ah9TshXguqLGD7cM4XhYkX4x6UNNb9ZmVsxQUOTCCPUfdncAY8HugnXvuDbndQ8lGSw3VE3IoILahVdrFvVZogOidZ4Rs9-J2JvvQ3_LtYrnRdV7yk339WKACP7_vAAOpTcIuxavRS5Cv4-RD6Gg-4Xdb90991cqA6we2Uc3RqqvJPJC4shD7Lqu3Gnrj0pcdQACSCJF1PpQHvFv_mqRr1C9DHYr4t4fOsQgHJ5yfJHWvsHdEkCZDqhrdfYWJ579OMX0HhyGJJ9vuTDC3NFPxa6sUdCDhYB6IG3C1nqdIXSpgWe1gG9lqLQE2IJKffyAwbaZlJbmV1sHhyYucMSuDca6xTzRELvB9YgfWELWVmXsKrOXqlY1gxEteRw_qXB5M02KR"},{"domain":".tiktok.com","name":"passport_csrf_token","value":"a2af09b9f6748489bd85005de0af353e"},{"domain":".tiktok.com","name":"passport_csrf_token_default","value":"a2af09b9f6748489bd85005de0af353e"},{"domain":".tiktok.com","name":"odin_tt","value":"0d23fd97d11f05ba72e82ecfebf69c26dd2de80e9931796e877d1df91ba88007dafe44073a934799c027ba6361ee7bf992d616ee293dceb851f133ee83f0d167fb209c384c565c1269650c1e4387336d"},{"domain":".tiktok.com","name":"tt_csrf_token","value":"FoDFiDrG-tO4664D8s9d-iNepMRIK1V3JaYI"},{"domain":".tiktok.com","name":"msToken","value":"As7TgV1aug4vqfCmKLYWrokC8mEdoBdFaTtZEl1iyXnMO7kvMBnJWqbsDD6ONqemsFI5XrEwy1sKJC3ZeGWTnM0m8u-Ixqw1GifdyOLWw6qUlwgUUD1bNtqXI1BsObz2GjSqHc4x8pojtt8="},{"domain":"www.tiktok.com","name":"s_v_web_id","value":"verify_mqor1w0o_PmW42CSc_EIw2_4uKR_AQUY_YhwS0tzYSBQr"}];

function getCookieString() { return CONSUMER_COOKIES_JSON.map(c => `${c.name}=${c.value}`).join('; '); }
const delay = ms => new Promise(res => setTimeout(res, ms));

async function createPngCarrier(tsBuf, carrierOpts) {
  const { APPEND_TS_MODE, encodePayloadToAppendPng, encodePayloadToPng } = require('./carrier');
  const tempPath = path.join(__dirname, 'avatar_upload_work', `carrier_${Date.now()}.png`);
  const carrierMode = process.env.CARRIER_MODE || APPEND_TS_MODE;
  if (carrierMode === APPEND_TS_MODE) {
    await encodePayloadToAppendPng(tsBuf, tempPath, carrierOpts);
  } else {
    await encodePayloadToPng(tsBuf, tempPath, carrierOpts);
  }
  return fs.readFileSync(tempPath);
}

async function uploadToTiktokCDN(fileBuffer, fileName) {
  const formData = new FormData();
  formData.append('file', fileBuffer, {
    filename: fileName + '.png',
    contentType: 'image/png'
  });

  const url = 'https://www.tiktok.com/api/upload/image/?WebIdLastTime=1776593253&aid=1988&app_language=en&app_name=tiktok_web&browser_language=en-US&browser_name=Mozilla&browser_online=true&browser_platform=Win32&browser_version=5.0%20%28Windows%20NT%2010.0%3B%20Win64%3B%20x64%29%20AppleWebKit%2F537.36%20%28KHTML%2C%20like%20Gecko%29%20Chrome%2F149.0.0.0%20Safari%2F537.36&channel=tiktok_web&cookie_enabled=true&device_id=7630409900435375636&device_platform=web_pc&focus_state=true&from_page=user&is_fullscreen=false&is_page_visible=true&odinId=7000343721028862977&os=windows&priority_region=VN&region=VN&screen_height=864&screen_width=1536&tz_name=Asia%2FBangkok&user_is_login=true&verifyFp=verify_mqor1w0o_PmW42CSc_EIw2_4uKR_AQUY_YhwS0tzYSBQr';

  try {
    const res = await axios.post(url, formData, {
      headers: {
        ...formData.getHeaders(),
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'origin': 'https://www.tiktok.com',
        'referer': 'https://www.tiktok.com/@thaitran8050',
        'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", ";Not A Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'tt-csrf-token': 'FoDFiDrG-tO4664D8s9d-iNepMRIK1V3JaYI',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        'cookie': getCookieString(),
      }
    });

    if (res.data && res.data.data && res.data.data.url_list) {
      return res.data.data.url_list[0];
    }
    throw new Error('Upload failed: ' + JSON.stringify(res.data));
  } catch (err) {
    if (err.response) throw new Error(`HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    throw err;
  }
}

async function main() {
  const workDir = path.join(__dirname, 'avatar_upload_work');
  const files = fs.readdirSync(workDir).filter(f => f.endsWith('.ts') && f.startsWith('seg_')).sort();
  
  if (files.length === 0) {
    console.log('No .ts segments found in avatar_upload_work/');
    return;
  }

  console.log(`Found ${files.length} segments to upload (encoding PNG carrier first).`);
  const uploadedLinks = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fullPath = path.join(workDir, file);
    console.log(`\n[${i+1}/${files.length}] Uploading ${file}...`);
    
    try {
      const tsBuf = fs.readFileSync(fullPath);
      const carrierOpts = { jobId: path.basename(workDir), index: i, total: files.length };
      const carrierBuf = await createPngCarrier(tsBuf, carrierOpts);

      const cdnUrl = await uploadToTiktokCDN(carrierBuf, file);
      console.log(`  -> Success! CDN Link: ${cdnUrl.substring(0, 90)}...`);
      
      uploadedLinks.push({ file: file, cdnUrl: cdnUrl });
      await delay(3000); // Respect rate limits
    } catch (e) {
      console.error(`  -> Failed: ${e.message}`);
    }
  }

  const linksPath = path.join(workDir, 'uploaded_cdn_links.json');
  fs.writeFileSync(linksPath, JSON.stringify(uploadedLinks, null, 2));
  console.log(`\n✅ Saved all links to ${linksPath}`);

  // We will read the original master.m3u8 to get the exact durations if available
  let m3u8Content = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:11\n#EXT-X-MEDIA-SEQUENCE:0\n";
  const durationMap = {};
  
  try {
    const masterStr = fs.readFileSync(path.join(workDir, 'master.m3u8'), 'utf-8');
    const lines = masterStr.split('\n');
    let lastDuration = 10;
    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) {
        lastDuration = parseFloat(line.replace('#EXTINF:', '').replace(',', ''));
      } else if (line.endsWith('.ts')) {
        durationMap[line.trim()] = lastDuration;
      }
    }
  } catch(e) {}

  // Helper to convert signed URL to public unsigned URL
  function convertToPublicUrl(signedUrl) {
    // Example: https://p16-common-sign.tiktokcdn.com/tiktok-obj/375dce3836ffbc394d0dec0132f642dc~tplv-tiktokx-origin.image?dr=...
    const urlObj = new URL(signedUrl);
    // Remove query parameters
    urlObj.search = '';
    
    // Pathname typically looks like: /tiktok-obj/375dce3836ffbc394d0dec0132f642dc~tplv-tiktokx-origin.image
    let pathname = urlObj.pathname;
    
    // Remove the template part (everything from ~ onwards)
    if (pathname.includes('~')) {
      pathname = pathname.substring(0, pathname.indexOf('~'));
    }
    
    // Prepend /obj if not already present
    if (!pathname.startsWith('/obj/')) {
      // Remove leading slash if any to avoid double slashes
      pathname = '/obj/' + pathname.replace(/^\//, '');
    }
    
    // Change host to the public cdn domain
    urlObj.host = 'p16-va.tiktokcdn.com';
    urlObj.pathname = pathname;
    
    return urlObj.toString();
  }

  for (const linkObj of uploadedLinks) {
    const duration = durationMap[linkObj.file] || 10.0;
    const publicCdnUrl = convertToPublicUrl(linkObj.cdnUrl);
    m3u8Content += `#EXTINF:${duration.toFixed(6)},\n${publicCdnUrl}\n`;
  }
  m3u8Content += "#EXT-X-ENDLIST\n";
  
  const m3u8Path = path.join(workDir, 'tiktok_stream.m3u8');
  fs.writeFileSync(m3u8Path, m3u8Content);
  console.log(`✅ Generated PNG-carrier streaming playlist (Public URLs): ${m3u8Path}`);
}

main().catch(console.error);
