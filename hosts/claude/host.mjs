// Entry of the Claude host (alpha 0.2 design §1 route B). orchestrad's spawn gate starts it as
// `node host.mjs` with no arguments; everything else comes in the start frame on stdin. This file only
// wires powers: it loads the Agent SDK, and hands runHost (host-core.mjs) stdio, crypto, realpath and the
// one timer. No logic lives here.
import { createHash, randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { runHost } from './host-core.mjs';

// The SDK by absolute file URL, never by package name: a bare name would let Node walk up the parent
// directories' node_modules, where anyone could have put a package first. The user installs it here
// with `npm ci --omit=optional --omit=dev --ignore-scripts`.
const SDK_URL = new URL('./node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', import.meta.url);

const writeLine = (line) => process.stdout.write(line);
const exitLine = (reason) => `${JSON.stringify({ t: 'exit', reason })}\n`;

/** Ends the host once stdout has taken the last frame. */
function end(code) {
  process.stdin.destroy();
  process.stdout.write('', () => process.exit(code));
}

let sdk = null;
try {
  sdk = await import(SDK_URL.href);
} catch {
  sdk = null;
}

if (sdk === null || typeof sdk.query !== 'function') {
  writeLine(exitLine('sdk-missing'));
  end(2);
} else {
  try {
    const result = await runHost({
      query: sdk.query,
      input: process.stdin,
      output: writeLine,
      // The host's one timer: the approval backstop.
      schedule: (ms, fn) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
      randomBytes: (n) => randomBytes(n),
      sha256: (text) => createHash('sha256').update(text, 'utf8').digest('hex'),
      realpath: (p) => realpath(p),
      env: { ...process.env },
      log: (line) => process.stderr.write(`${line}\n`),
    });
    end(result.reason === 'closed' || result.reason === 'stdin-eof' ? 0 : 2);
  } catch {
    writeLine(exitLine('host-error'));
    end(2);
  }
}
