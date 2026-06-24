# WAF Token and Bucket Routing Investigation

**Date:** 2026-06-25  
**Session:** Background job 777df125

## Summary

Successfully implemented WAF token extraction and injection mechanism, but discovered that **WAF token (_waftokenid) does NOT determine bucket routing** for TikTok image uploads.

---

## Implementation Completed

### 1. Added GET /cookies Endpoint to signer_service.js

**Location:** `signer_service.js` lines 301-327  
**Purpose:** Extract all cookies from Playwright browser context, including _waftokenid

**Response format:**
```json
{
  "success": true,
  "cookies": [...],
  "wafToken": {
    "name": "_waftokenid",
    "value": "eyJ2Ijp7ImEiOi...",
    "domain": ".tiktok.com",
    "path": "/",
    "expires": 1782223200,
    "age": 28
  }
}
```

**Status:** ✅ Working (tested successfully, PID 28692)

### 2. WAF Token Injection Script

**Created:** `inject_waf_ps.js` (via PowerShell)  
**Function:** Fetches _waftokenid from signer service /cookies endpoint and injects into .env TIKTOK_COOKIE

**Process:**
1. GET http://127.0.0.1:35123/cookies
2. Extract wafToken.value
3. Update or append `_waftokenid=...` to TIKTOK_COOKIE in .env
4. Preserve existing cookie format with quotes

**Status:** ✅ Working (successfully injected 43-second-old WAF token)

---

## Key Findings: WAF Token Does NOT Control Bucket Routing

### Test 1: Upload with Fresh WAF Token (via pure_lossless_upload.js)

**Setup:**
- .env TIKTOK_COOKIE contains _waftokenid (freshly injected)
- Endpoint: `/api/v1/video/upload/auth/` (STS token for Volcengine)
- Image: 1x1 PNG (70 bytes)

**Result:**
```
✅ Upload successful
📦 Bucket: tos-alisg-pv-0037 (Profile/Video bucket)
❌ NOT tos-alisg-avt-0068 (lossless avatar bucket)
```

### Test 2: Bucket Probe with 3 Variants (via bucket_probe.js)

**Setup:**
- Browser context with fresh _waftokenid present (verified)
- Endpoint: `/api/upload/image/` (avatar upload)
- 3 test images:
  - A: Small PNG (914 bytes)
  - B: Large PNG (121,000 bytes)  
  - C: Polyglot PNG+TS (273,138 bytes)

**Result:**
```
All 3 variants → tiktok-obj bucket (COMPRESSED) ❌
WAF token present: true (eyJ2Ijp7ImEiOiJv...)
```

**Conclusion:** Having _waftokenid does NOT route to lossless bucket.

### Test 3: Analysis of Historical Successful Request

**Source:** `avatar_upload_work/all_requests_v4.json` (captured Jun 23 15:17, ~1.5 days old)

**Finding:**
```
✅ Request went to tos-alisg-avt-0068 (lossless)
✅ Had _waftokenid: eyJ2Ijp7ImEiOiJNMWNYRktWV29wenJ4Qm0zRkxH...
✅ Had sessionid, sessionid_ss, all auth cookies
```

**Current .env cookie comparison:**
```
Success request: 3278 bytes, has all critical cookies
Current .env:     2816 bytes, has all critical cookies including _waftokenid
Missing in current: x-web-secsdk-uid, tiktok_webapp_theme, etc. (non-critical)
```

**Observation:** Both success case and current setup have _waftokenid, but current tests route to compressed bucket.

---

## Hypotheses for tos-alisg-avt-0068 Routing

### 1. **Account-Based Routing** (Most Likely)
- Certain accounts (premium, verified, region-specific) get lossless bucket
- Consumer account type determines routing, not request cookies
- WAF token is security validation, NOT bucket selector

### 2. **Temporal/A-B Testing**
- TikTok may have been testing lossless routing 1.5 days ago
- Feature may have been rolled back or limited to specific regions
- Current upload infrastructure routes everything to compressed

### 3. **Endpoint Differences**
- `/api/upload/image/` (avatar) vs `/api/v1/video/upload/auth/` (STS) may have different routing logic
- pure_lossless_upload uses video/upload/auth → goes to pv-0037
- bucket_probe uses upload/image → goes to tiktok-obj
- Historical success used upload/image → went to avt-0068
- Same endpoint, different results over time

### 4. **Missing Request Context**
- May require specific referrer, from_page, or browser fingerprint
- May require active user interaction (real click vs automated POST)
- May validate browser environment beyond cookies

---

## Commits

1. **8d3efe4** - "Add /cookies endpoint to extract WAF token from browser context"
   - New GET /cookies endpoint in signer_service.js
   - Returns full cookie list + wafToken object with age
   - Deployed and tested (service PID 28692)

---

## Recommendations

### Short Term
1. ✅ Keep /cookies endpoint for future debugging
2. ✅ Keep WAF token injection capability (may be required for other features)
3. ❌ Do NOT rely on WAF token for lossless bucket routing

### Long Term
1. **Accept compressed bucket routing** - TikTok re-encodes images regardless
2. **Use video chunk path for byte-exact transport** (already proven in memory: seg_00007.ts md5-exact)
3. **Stop pursuing image smuggling** - memory confirms no TikTok image endpoint preserves appended bytes

### Investigation Paths (if lossless bucket is critical)
1. Test with different account types (verified, business, different regions)
2. Monitor TikTok network traffic from real browser avatar changes
3. Check if bucket routing changed in recent TikTok updates
4. Compare request timing (the successful case was 1.5 days ago)

---

## Files Modified

- `signer_service.js` - Added GET /cookies endpoint
- `.env` - TIKTOK_COOKIE now contains _waftokenid
- Created: `WAF_TOKEN_FINDINGS.md` (this file)

---

## Result Summary

**result:** WAF token extraction working but does not control bucket routing; all current uploads route to compressed buckets regardless of _waftokenid presence
