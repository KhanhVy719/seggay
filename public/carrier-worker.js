const MAGIC = 'TTKPIX1\0';
const VERSION = 1;
const HEADER_SIZE = 8 + 1 + 2 + 36 + 4 + 4 + 4 + 32;

function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

async function sha256(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(digest);
}

function readAscii(bytes, offset, length) {
    let value = '';
    for (let i = 0; i < length; i++) {
        const code = bytes[offset + i];
        if (code === 0) continue;
        value += String.fromCharCode(code);
    }
    return value;
}

function findMpegTsOffset(bytes) {
    for (let i = 0; i < bytes.length - 188 * 3; i++) {
        if (
            bytes[i] === 0x47 &&
            bytes[i + 188] === 0x47 &&
            bytes[i + 376] === 0x47 &&
            bytes[i + 564] === 0x47
        ) {
            return i;
        }
    }
    return -1;
}

async function parseCarrierBuffer(arrayBuffer, expected) {
        const bytes = new Uint8Array(arrayBuffer);
        const tsOffset = findMpegTsOffset(bytes);
        if (tsOffset >= 0) {
            const payload = new Uint8Array(arrayBuffer, tsOffset, bytes.length - tsOffset);
            return {
                jobId: expected?.jobId || '',
                index: expected?.index || 0,
                total: expected?.total || 0,
                payload,
                payloadLength: payload.byteLength,
                mode: 'png-append-ts',
                tsOffset,
            };
        }

        // Fallback: decode legacy PNG pixel carrier.
        const blob = new Blob([arrayBuffer], { type: 'image/png' });
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        const data = imageData.data;
        
        // Convert RGBA to RGB
        const rgb = new Uint8Array(bitmap.width * bitmap.height * 3);
        for (let src = 0, dst = 0; src < data.length && dst < rgb.length; src += 4) {
            rgb[dst++] = data[src];
            rgb[dst++] = data[src + 1];
            rgb[dst++] = data[src + 2];
        }

        // Step 2: Parse Carrier Header
        const magicStr = readAscii(rgb, 0, 8);
        if (magicStr !== 'TTKPIX1') throw new Error('Carrier magic not found in pixels');

        const version = rgb[8];
        if (version !== VERSION) throw new Error(`Unsupported carrier version ${version}`);

        const headerSize = (rgb[9] << 8) | rgb[10];
        if (headerSize !== HEADER_SIZE) throw new Error(`Invalid header size ${headerSize}`);

        const jobId = readAscii(rgb, 11, 36);
        const index = (rgb[47] << 24) | (rgb[48] << 16) | (rgb[49] << 8) | rgb[50];
        const total = (rgb[51] << 24) | (rgb[52] << 16) | (rgb[53] << 8) | rgb[54];
        const payloadLength = (rgb[55] << 24) | (rgb[56] << 16) | (rgb[57] << 8) | rgb[58];
        const expectedHash = rgb.slice(59, 91);

        const end = HEADER_SIZE + payloadLength;
        if (payloadLength < 1 || end > rgb.length) {
            throw new Error(`Invalid carrier payload length ${payloadLength}`);
        }

        const payload = rgb.slice(HEADER_SIZE, end);
        const actualHash = await sha256(payload);

        if (!arraysEqual(actualHash, expectedHash)) {
            throw new Error('Carrier payload checksum mismatch; image pixels were modified');
        }

        return { jobId, index, total, payload, payloadLength };
    }

    self.onmessage = async (event) => {
        const { id, source, expected } = event.data || {};
        const meta = { label: source?.label || 'worker', downloadMs: 0, decodeMs: 0 };
        try {
            if (!source || !source.url) throw new Error('Missing worker source URL');
            const downloadStart = performance.now();
            const response = await fetch(source.url, {
                cache: 'force-cache',
                mode: source.direct ? 'cors' : 'same-origin',
                credentials: source.direct ? 'omit' : 'same-origin',
            });
            if (!response.ok) throw new Error(`${source.label || 'worker'} fetch failed ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();
            meta.downloadMs = performance.now() - downloadStart;

            const decodeStart = performance.now();
            const decoded = await parseCarrierBuffer(arrayBuffer, expected);
            meta.decodeMs = performance.now() - decodeStart;
            meta.payloadLength = decoded.payloadLength;

            const data = decoded.payload.buffer.slice(decoded.payload.byteOffset, decoded.payload.byteOffset + decoded.payload.byteLength);
            self.postMessage({ id, ok: true, data, meta }, [data]);
        } catch (err) {
            self.postMessage({ id, ok: false, error: err.message || String(err), meta });
        }
    };
