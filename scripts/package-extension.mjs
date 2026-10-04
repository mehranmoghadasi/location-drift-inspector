#!/usr/bin/env node
/**
 * package-extension.mjs — copy extension/ to dist/extension/, add PNG icons rendered by
 * extension/lib/icon.js, and list them in the copied manifest. Use the result for a
 * Chrome Web Store upload (zip dist/extension). The unpacked extension in extension/
 * does not need this step: it draws its toolbar icon at run time.
 *
 *   npm run package
 *
 * PNG encoding uses only node:zlib (one IHDR, one IDAT, one IEND chunk, RGBA, filter 0).
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { renderIcon, ICON_SIZES } from '../extension/lib/icon.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode RGBA pixels as a PNG file. */
export function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function packageExtension(outDir = path.join(root, 'dist', 'extension')) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.dirname(outDir), { recursive: true });
  await cp(path.join(root, 'extension'), outDir, { recursive: true });
  await mkdir(path.join(outDir, 'icons'), { recursive: true });
  const icons = {};
  for (const size of ICON_SIZES) {
    const file = `icons/icon-${size}.png`;
    await writeFile(path.join(outDir, file), encodePng(renderIcon(size), size));
    icons[size] = file;
  }
  const manifest = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8'));
  manifest.icons = icons;
  manifest.action.default_icon = { 16: icons[16], 32: icons[32] };
  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { outDir, icons };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { outDir, icons } = await packageExtension();
  process.stdout.write(`packaged ${path.relative(root, outDir)} with ${Object.keys(icons).length} icons\n`);
}
