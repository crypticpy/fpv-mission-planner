// Minimal PNG encode/decode — no dependencies, both directions used.
//
// Encode: the DEM tile generator writes 8-bit RGB terrarium tiles.
// Decode: the Playwright spec reads pixels out of a page screenshot. A
// screenshot is the only readback that composites BOTH canvases, which is what
// "occluded" has to mean in overlaid mode (deck.gl draws on its own canvas
// there, so a single-canvas readPixels would answer the wrong question).
//
// Scope is exactly what those two jobs need: 8 bits per channel, no interlace,
// colour type 2 (RGB) or 6 (RGBA).

import { deflateSync, inflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 8-bit RGB PNG from tightly packed `rgb` (width * height * 3 bytes).
 *
 * Filter type 0 (None) on every scanline: the DEM payload is high-entropy in
 * the low byte and a filter would not help, and "no filter" keeps this
 * byte-for-byte deterministic across node versions.
 */
export function encodeRGB(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * PNG -> `{ width, height, channels, data }` with `data` tightly packed and
 * unfiltered. Throws on anything outside the supported subset rather than
 * returning quietly wrong pixels — a silently mis-decoded screenshot would turn
 * this spike's assertions into noise.
 */
export function decode(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('png: not a PNG');

  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];

  for (let at = 8; at < buf.length;) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    at += length + 12;

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colorType = body[9];
      const interlace = body[12];
      if (depth !== 8) throw new Error(`png: bit depth ${depth} unsupported`);
      if (interlace !== 0) throw new Error('png: interlaced images unsupported');
      if (colorType === 2) channels = 3;
      else if (colorType === 6) channels = 4;
      else throw new Error(`png: colour type ${colorType} unsupported`);
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    const up = out - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? data[out + i - channels] : 0;
      const b = y > 0 ? data[up + i] : 0;
      const c = y > 0 && i >= channels ? data[up + i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`png: filter ${filter} unsupported`);
      data[out + i] = v & 0xff;
    }
  }

  return { width, height, channels, data };
}

/** `[r, g, b]` at a pixel, or null when the coordinate is outside the image. */
export function pixelAt(image, x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= image.width || py >= image.height) return null;
  const at = (py * image.width + px) * image.channels;
  return [image.data[at], image.data[at + 1], image.data[at + 2]];
}
