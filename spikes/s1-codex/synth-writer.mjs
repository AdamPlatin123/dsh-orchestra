// Synthetic rollout writer (no real data): emits N fake JSONL events as ONE zstd frame on stdout,
// one event every --interval ms. --flush event : ZSTD_e_flush after every event (block per event);
// --flush none : never flush until the end (encoder buffers up to a full 128 KiB block).
// Redirect stdout to a file in the scratch tmp dir and tail that file with stream-tail.mjs.
// Usage: node24 synth-writer.mjs --events 30 --interval 300 --flush event|none --pad 200 >> tmp/synth.jsonl.zst
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const N = Number(opt('--events', 30)), INTERVAL = Number(opt('--interval', 300)), FLUSH = opt('--flush', 'event'), PAD = Number(opt('--pad', 200));
const enc = zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
enc.on('data', (c) => process.stdout.write(c));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 1; i <= N; i++) {
  const rec = { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'synthetic', seq: i, pad: 'x'.repeat(PAD) } };
  enc.write(JSON.stringify(rec) + '\n');
  if (FLUSH === 'event') await new Promise((r) => enc.flush(zlib.constants.ZSTD_e_flush, r));
  await sleep(INTERVAL);
}
enc.end();
await new Promise((r) => enc.on('end', r));
process.stderr.write(JSON.stringify({ writerPid: process.pid, events: N, flush: FLUSH }) + '\n');
