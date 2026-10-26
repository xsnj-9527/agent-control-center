const { readFile, readdir, realpath, lstat } = require('node:fs/promises');
const path = require('node:path');
const { zstdDecompressSync } = require('node:zlib');

const MAX_BYTES = 32 * 1024 * 1024;

function contained(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function zstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 5) return { frames, partial: true };
    if (buffer.readUInt32LE(offset) !== 0xfd2fb528) throw new Error('无效 Zstandard 帧。');
    offset += 4;
    const flags = buffer[offset++];
    if (flags & 0x18) throw new Error('不支持的 Zstandard 帧头。');
    const sizeFlag = flags >>> 6;
    const single = Boolean(flags & 0x20);
    const dictionary = flags & 3;
    offset += (single ? 0 : 1) + (dictionary === 3 ? 4 : dictionary) + (sizeFlag ? 2 ** sizeFlag : single ? 1 : 0);
    if (offset > buffer.length) return { frames, partial: true };
    let last = false;
    while (!last) {
      if (offset + 3 > buffer.length) return { frames, partial: true };
      const header = buffer.readUIntLE(offset, 3);
      offset += 3;
      const kind = (header >>> 1) & 3;
      if (kind === 3) throw new Error('无效 Zstandard 数据块。');
      offset += kind === 1 ? 1 : header >>> 3;
      last = Boolean(header & 1);
      if (offset > buffer.length) return { frames, partial: true };
    }
    if (flags & 4) offset += 4;
    if (offset > buffer.length) return { frames, partial: true };
    frames.push(buffer.subarray(start, offset));
  }
  return { frames, partial: false };
}

function decodeZstd(buffer, limit = MAX_BYTES) {
  const parsed = zstdFrames(buffer);
  const chunks = [];
  let bytes = 0;
  let partial = parsed.partial;
  for (const frame of parsed.frames) {
    try {
      const decoded = zstdDecompressSync(frame, { maxOutputLength: limit - bytes });
      bytes += decoded.length;
      chunks.push(decoded);
      if (bytes >= limit) { partial = true; break; }
    } catch { partial = true; break; }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), partial };
}

async function findFiles(root, match, depth = 3) {
  const canonical = await realpath(root);
  const files = [];
  async function walk(directory, level) {
    if (files.length >= 5000 || level > depth) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (files.length >= 5000) return;
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file, level + 1);
      else if (entry.isFile() && match(entry.name)) {
        const stat = await lstat(file);
        files.push({ file, size: stat.size, modified: stat.mtimeMs });
      }
    }
  }
  await walk(canonical, 0);
  return files.sort((a, b) => b.modified - a.modified);
}

async function readRecords(root, file) {
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(file)]);
  if (!contained(canonicalRoot, canonicalFile)) throw new Error('记录路径超出所选目录。');
  const stat = await lstat(canonicalFile);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('记录文件超出读取限制。');
  const buffer = await readFile(canonicalFile);
  const decoded = file.endsWith('.zstd') ? decodeZstd(buffer) : { text: buffer.toString('utf8'), partial: false };
  const rows = [];
  let partial = decoded.partial;
  for (const line of decoded.text.split('\n')) {
    if (!line.trim()) continue;
    if (line.length > 1024 * 1024) { partial = true; continue; }
    try { rows.push(JSON.parse(line)); } catch { partial = true; }
  }
  return { rows, partial };
}

module.exports = { contained, decodeZstd, findFiles, readRecords };
