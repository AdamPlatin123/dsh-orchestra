// Item 4: cold-start cost = decode one rollout from byte 0 to the end with the streaming decoder.
// Usage: node24 cold-start.mjs <file.jsonl.zst> [decode|parse|sync] [chunkSize]
//   decode: count bytes and '\n' only;  parse: also split lines and JSON.parse each to read `type`.
// Read-only (createReadStream flags 'r'). Prints counts, ms and peak RSS; never decoded text.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';

const [file, mode = 'decode', chunkArg] = process.argv.slice(2);
const chunkSize = chunkArg ? Number(chunkArg) : undefined; // zlib output chunk size (default 16 KiB in Node)
const t0 = performance.now();
let bytes = 0, lines = 0, maxLine = 0, carry = [], carryLen = 0, rssPeakSampled = 0;
const types = {};
const sampler = setInterval(() => { rssPeakSampled = Math.max(rssPeakSampled, process.memoryUsage.rss()); }, 50);

function onLine(buf) {
  lines++; if (buf.length > maxLine) maxLine = buf.length;
  if (mode === 'parse') { try { const t = JSON.parse(buf.toString('utf8')).type; types[t] = (types[t] || 0) + 1; } catch { types['<unparsable>'] = (types['<unparsable>'] || 0) + 1; } }
}

const sink = new Writable({
  write(chunk, _enc, cb) {
    bytes += chunk.length;
    if (mode === 'decode') { for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) lines++; return cb(); }
    let start = 0;
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, i);
      if (carryLen) { carry.push(piece); onLine(Buffer.concat(carry)); carry = []; carryLen = 0; } else onLine(piece);
      start = i + 1;
    }
    if (start < chunk.length) { carry.push(chunk.subarray(start)); carryLen += chunk.length - start; }
    cb();
  },
});

if (mode === 'sync') { // baseline: one zstdDecompressSync over the whole file (not usable for tailing)
  const out = zlib.zstdDecompressSync(fs.readFileSync(file, { flag: 'r' }));
  bytes = out.length; for (let i = out.indexOf(10); i !== -1; i = out.indexOf(10, i + 1)) lines++;
} else await pipeline(fs.createReadStream(file, { flags: 'r', highWaterMark: 1 << 20 }), zlib.createZstdDecompress(chunkSize ? { chunkSize } : {}), sink);
clearInterval(sampler);
const ms = performance.now() - t0;
console.log(JSON.stringify({
  mode, chunkSize: chunkSize ?? 16384, compressedBytes: fs.statSync(file).size, decodedBytes: bytes, lines, maxLineBytes: mode === 'parse' ? maxLine : undefined,
  ms: Math.round(ms), decodedMiBps: Math.round(bytes / 1048576 / (ms / 1000)),
  // CPU time (user+system) is much less sensitive to a busy machine than wall time; added 2026-10-30.
  cpuMs: Math.round((process.cpuUsage().user + process.cpuUsage().system) / 1000),
  peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024), sampledPeakRssMiB: Math.round(rssPeakSampled / 1048576),
  types: mode === 'parse' ? types : undefined,
}));
