// Summarize `prefix-test.mjs blocks` output (one JSON object per rollout) into the totals used in REPORT.md.
// Usage: node24 summarize-blocks.mjs <blocks-all.jsonl>   (prints JSON; counts only)
// Same logic as the inline summary the first executor ran on 2026-10-29 (blocks-all.summary.json).
import fs from 'node:fs';

const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
const out = {
  files: rows.length,
  errors: rows.filter((r) => r.err).length,
  decodedMatchesFcs: rows.filter((r) => r.decodedTotal === r.fcs).length,
  headerOnlyOutputNonZero: rows.filter((r) => r.headerOnlyOutput > 0).length,
  totalBlocks: sum((r) => r.blocks),
  nonLastBlocks: sum((r) => r.nonLastBlocks),
  // every rollout ends with '\n', so the last block always ends on a newline; subtract it per file
  nonLastBlocksEndingOnNewline: sum((r) => r.blocksEndingOnNewline - 1),
  filesWhereLastBlockEndsOnNewline: rows.filter((r) => r.blocksEndingOnNewline >= 1).length,
  nonLastExactly128KiB: sum((r) => r.nonLastBlocksExactly128KiB),
  nonLastMultipleOf8KiB: sum((r) => r.nonLastBlocksMultipleOf8KiB),
  multiBlockFiles: rows.filter((r) => r.blocks > 1).length,
  filesWithAnyNonLastBlockOnNewline: rows.filter((r) => r.blocksEndingOnNewline > 1).length,
  totalDecodedBytes: sum((r) => r.decodedTotal),
  totalLines: sum((r) => r.lines),
  everyBlockProducedOutput: rows.every((r) => r.everyBlockProducedOutput),
  // if block ends were unrelated to line ends, a block would end on '\n' with probability ~ 1 / meanLineBytes
  expectedNewlineHitsIfRandom: Math.round(rows.reduce((s, r) => s + r.nonLastBlocks / (r.meanLineBytes || 1), 0)),
};
console.log(JSON.stringify(out, null, 1));
