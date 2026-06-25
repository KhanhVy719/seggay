// carrier.js
const crypto = require('crypto');
const fs = require('fs');
const sharp = require('sharp');

const MAGIC = Buffer.from('TTKPIX1\0', 'ascii');
const VERSION = 1;
const HEADER_SIZE = 8 + 1 + 2 + 36 + 4 + 4 + 4 + 32;
const APPEND_TS_MODE = 'png-append-ts';
const PIXEL_MODE = 'png-pixel-carrier';
const ONE_PIXEL_PNG = Buffer.from(
    '89504e470d0a1a0a0000000d494844520000000100000001010300000025db56ca00000003504c5445000000a77a3dda0000000174524e530040e6d8660000000a4944415408d76360000000020001e221bc330000000049454e44ae426044',
    'hex'
);

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest();
}

function normalizeJobId(jobId) {
    const value = String(jobId || '').trim();
    if (!value) throw new Error('Missing jobId');
    return value.slice(0, 36).padEnd(36, '\0');
}

function buildCarrierBuffer(payload, options) {
    const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const total = Number(options.total);
    const index = Number(options.index);
    if (!Number.isInteger(total) || total < 1) throw new Error('Invalid total segment count');
    if (!Number.isInteger(index) || index < 0 || index >= total) throw new Error('Invalid segment index');

    const header = Buffer.alloc(HEADER_SIZE);
    let offset = 0;
    MAGIC.copy(header, offset); offset += 8;
    header.writeUInt8(VERSION, offset); offset += 1;
    header.writeUInt16BE(HEADER_SIZE, offset); offset += 2;
    header.write(normalizeJobId(options.jobId), offset, 36, 'ascii'); offset += 36;
    header.writeUInt32BE(index, offset); offset += 4;
    header.writeUInt32BE(total, offset); offset += 4;
    header.writeUInt32BE(payloadBuffer.length, offset); offset += 4;
    sha256(payloadBuffer).copy(header, offset); offset += 32;

    return Buffer.concat([header, payloadBuffer]);
}

function parseCarrierBuffer(buffer) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    if (buffer.length < HEADER_SIZE) throw new Error('Image pixel data too small for carrier header');
    if (!buffer.subarray(0, 8).equals(MAGIC)) throw new Error('Carrier magic not found in pixels');

    let offset = 8;
    const version = buffer.readUInt8(offset); offset += 1;
    if (version !== VERSION) throw new Error(`Unsupported carrier version ${version}`);

    const headerSize = buffer.readUInt16BE(offset); offset += 2;
    if (headerSize !== HEADER_SIZE) throw new Error(`Invalid carrier header size ${headerSize}`);

    const jobId = buffer.toString('ascii', offset, offset + 36).replace(/\0+$/g, ''); offset += 36;
    const index = buffer.readUInt32BE(offset); offset += 4;
    const total = buffer.readUInt32BE(offset); offset += 4;
    const payloadLength = buffer.readUInt32BE(offset); offset += 4;
    const expectedHash = buffer.subarray(offset, offset + 32); offset += 32;

    const end = HEADER_SIZE + payloadLength;
    if (payloadLength < 1 || end > buffer.length) {
        throw new Error(`Invalid carrier payload length ${payloadLength}`);
    }

    const payload = Buffer.from(buffer.subarray(HEADER_SIZE, end));
    const actualHash = sha256(payload);
    if (!actualHash.equals(expectedHash)) {
        throw new Error('Carrier payload checksum mismatch; image pixels were modified');
    }

    return { jobId, index, total, payload, payloadLength };
}

function chooseDimensions(byteLength) {
    const pixels = Math.ceil(byteLength / 3);
    const width = Math.max(64, Math.ceil(Math.sqrt(pixels)));
    const height = Math.ceil(pixels / width);
    return { width, height };
}

function findMpegTsOffset(buffer) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    for (let i = 0; i < buffer.length - 188 * 3; i++) {
        if (
            buffer[i] === 0x47 &&
            buffer[i + 188] === 0x47 &&
            buffer[i + 376] === 0x47 &&
            buffer[i + 564] === 0x47
        ) {
            return i;
        }
    }
    return -1;
}

function decodeAppendTsCarrierBuffer(input, expected = {}) {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const tsOffset = findMpegTsOffset(buffer);
    if (tsOffset < 0) throw new Error('MPEG-TS payload not found in PNG append carrier');
    const payload = Buffer.from(buffer.subarray(tsOffset));
    return {
        jobId: expected.jobId || '',
        index: Number.isInteger(expected.index) ? expected.index : 0,
        total: Number.isInteger(expected.total) ? expected.total : 0,
        payload,
        payloadLength: payload.length,
        mode: APPEND_TS_MODE,
        tsOffset,
    };
}

async function encodePayloadToAppendPng(payload, outputPath, options = {}) {
    const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const carrier = Buffer.concat([ONE_PIXEL_PNG, payloadBuffer]);
    await fs.promises.writeFile(outputPath, carrier);
    return {
        outputPath,
        width: 1,
        height: 1,
        carrierBytes: carrier.length,
        payloadBytes: payloadBuffer.length,
        mode: APPEND_TS_MODE,
        tsOffset: ONE_PIXEL_PNG.length,
    };
}

async function encodePayloadToPng(payload, outputPath, options) {
    const carrier = buildCarrierBuffer(payload, options);
    const { width, height } = chooseDimensions(carrier.length);
    const raw = Buffer.alloc(width * height * 3, 255);
    carrier.copy(raw, 0);

    await sharp(raw, { raw: { width, height, channels: 3 } })
        .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
        .toFile(outputPath);

    return { outputPath, width, height, carrierBytes: carrier.length, payloadBytes: Buffer.byteLength(payload), mode: PIXEL_MODE };
}

async function encodeFileToPng(inputPath, outputPath, options = {}) {
    const payload = fs.readFileSync(inputPath);
    if (options.mode === APPEND_TS_MODE || options.appendTs) {
        return encodePayloadToAppendPng(payload, outputPath, options);
    }
    return encodePayloadToPng(payload, outputPath, options);
}

async function decodePixelCarrierBuffer(input) {
    const image = sharp(input, { limitInputPixels: false });
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    if (channels < 3) throw new Error(`Unsupported image channels ${channels}`);

    const rgb = Buffer.alloc(info.width * info.height * 3);
    for (let src = 0, dst = 0; src < data.length && dst < rgb.length; src += channels) {
        rgb[dst++] = data[src];
        rgb[dst++] = data[src + 1];
        rgb[dst++] = data[src + 2];
    }

    const decoded = parseCarrierBuffer(rgb);
    decoded.mode = PIXEL_MODE;
    return decoded;
}

async function decodePngCarrierBuffer(input, expected = {}) {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
    if (findMpegTsOffset(buffer) >= 0) {
        return decodeAppendTsCarrierBuffer(buffer, expected);
    }
    return decodePixelCarrierBuffer(buffer);
}

async function decodePngCarrier(inputPath, expected = {}) {
    return decodePngCarrierBuffer(fs.readFileSync(inputPath), expected);
}

module.exports = {
    MAGIC,
    HEADER_SIZE,
    APPEND_TS_MODE,
    PIXEL_MODE,
    findMpegTsOffset,
    encodePayloadToAppendPng,
    encodePayloadToPng,
    encodeFileToPng,
    decodeAppendTsCarrierBuffer,
    decodePixelCarrierBuffer,
    decodePngCarrier,
    decodePngCarrierBuffer,
    parseCarrierBuffer,
};
