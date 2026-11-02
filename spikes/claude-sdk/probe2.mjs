// Spike, round 2: eleven SDK behaviours the alpha 0.2 interactive thin slice depends on.
// Mock backend only (a local Anthropic-compatible gateway, see REPORT §9), synthetic prompts,
// throwaway config dirs and cwds under one temp root. Records structure only: types, keys,
// counts, timings, booleans. Assistant text is reduced to marker booleans and never written.
//
//   node probe2.mjs --gateway http://127.0.0.1:3425 --model opencode-go/claude-haiku-5-5 --out <dir>
//        [--only resume,files,fork,sysprompt,chrome,firstline,maxturns,hostkill,fresh,tools,skills]
//        [--desktop-transcript <a Desktop-hosted transcript, for the first-line check>] [--keep]
import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : '']] : acc), []));
const GATEWAY = args.gateway || 'http://127.0.0.1:3425';
const MODEL = args.model || 'opencode-go/claude-haiku-5-5';
const CLAUDE = args.claude || path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const OUT = args.out || fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-probe2-out-'));
const ONLY = args.only ? new Set(args.only.split(',')) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keys = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).sort() : []);
fs.mkdirSync(OUT, { recursive: true });

const ENV_KEEP = ['SystemRoot', 'windir', 'SystemDrive', 'PATH', 'Path', 'PATHEXT', 'ComSpec', 'OS', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles', 'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];
function childEnv(cfg) {
  const env = {};
  for (const k of ENV_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
  // The gateway takes no key; the CLI wants one set, so this is a placeholder, not a credential.
  return { ...env, CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_BASE_URL: GATEWAY, ANTHROPIC_API_KEY: 'mock-gateway-no-key', NO_PROXY: '127.0.0.1,localhost', CLAUDE_CODE_DISABLE_WORKFLOWS: '1' };
}

function inbox() {
  const items = [];
  let wake = null;
  let done = false;
  return {
    push(m) {
      items.push(m);
      wake?.();
    },
    end() {
      done = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length) yield items.shift();
        if (done) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };
}
const userMsg = (text) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
const textOf = (m) => {
  const c = m?.message?.content;
  return Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : typeof c === 'string' ? c : '';
};

// ---------- one temp root for every config dir and cwd ----------
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-sdk2-'));
const dirs = [];
function mk(kind, name) {
  const p = path.join(ROOT, `${kind}-${name}`);
  fs.mkdirSync(p, { recursive: true });
  dirs.push(p);
  return p;
}
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/** List a tree as relative names and sizes (no content). */
function tree(p, base = p, out = []) {
  if (!fs.existsSync(p)) return out;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    if (e.isDirectory()) {
      out.push(`${path.relative(base, f).split(path.sep).join('/')}/`);
      tree(f, base, out);
    } else out.push(`${path.relative(base, f).split(path.sep).join('/')} ${fs.statSync(f).size}`);
  }
  return out;
}
function findTranscript(cfg, sessionId) {
  const root = path.join(cfg, 'projects');
  if (!fs.existsSync(root)) return null;
  for (const d of fs.readdirSync(root)) {
    const p = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return { dir: d, file: p };
  }
  return null;
}
function lines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { bad: true };
    }
  });
}
/** Shape of a transcript line: type, keys and a few short enum fields only. */
const shape = (o) => ({ type: o.type ?? null, subtype: o.subtype ?? null, keys: keys(o).join(','), entrypoint: o.entrypoint ?? null, userType: o.userType ?? null, isSidechain: o.isSidechain ?? null, hasUuid: !!o.uuid, sessionId: o.sessionId ?? null });

// ---------- a session: push messages one by one, wait for each result ----------
async function session(name, { cfg, cwd, msgs, opts = {}, allow = [], maxTurns = 3, onReady }) {
  const rec = { name, cfg: rel(cfg), cwd: rel(cwd), inits: [], turns: [], perm: [], stderr: [], t0: Date.now() };
  const input = inbox();
  let cur = null;
  let waiter = null;
  const q = query({
    prompt: input,
    options: {
      cwd,
      model: MODEL,
      pathToClaudeCodeExecutable: CLAUDE,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      maxTurns,
      maxBudgetUsd: 0.05,
      persistSession: true,
      env: childEnv(cfg),
      stderr: (d) => {
        if (/error|fail|denied|unknown|invalid/i.test(d)) rec.stderr.push(d.slice(0, 200).replace(/\s+/g, ' '));
      },
      canUseTool: async (tool, input2) => {
        rec.perm.push({ turn: cur?.i ?? null, tool, inputKeys: keys(input2).join(',') });
        if (allow.includes(tool)) return { behavior: 'allow', updatedInput: input2 };
        return { behavior: 'deny', message: 'Denied by the Orchestra probe: no tool may run in this session.' };
      },
      ...opts,
    },
  });
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        rec.inits.push({ t: Date.now() - rec.t0, model: m.model, sessionId: m.session_id, tools: m.tools, skills: m.skills ?? null, plugins: (m.plugins ?? []).map((p) => p.name), slashCommands: m.slash_commands, mcpServers: (m.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`), permissionMode: m.permissionMode });
      }
      if (!cur) continue;
      if (m.type === 'assistant') {
        cur.text += textOf(m);
        cur.assistantUuids.push(m.uuid);
        for (const b of m.message?.content ?? []) if (b.type === 'tool_use') cur.toolUses.push(b.name);
        if (m.message?.model) cur.models.add(m.message.model);
      }
      if (m.type === 'user' && Array.isArray(m.message?.content)) {
        for (const b of m.message.content) if (b.type === 'tool_result') cur.toolResults.push(!!b.is_error);
      }
      if (m.type === 'result') {
        cur.result = { subtype: m.subtype, isError: m.is_error, numTurns: m.num_turns, costUsd: m.total_cost_usd, denials: (m.permission_denials ?? []).map((d) => d.tool_name), errors: (m.errors ?? []).map((e) => String(e).slice(0, 200)) };
        waiter?.();
      }
    }
  })().catch((e) => rec.turns.push({ pumpError: String(e?.message ?? e).slice(0, 300) }));

  try {
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      cur = { i, label: m.label, text: '', assistantUuids: [], toolUses: [], toolResults: [], models: new Set(), result: null };
      const done = new Promise((r) => {
        const to = setTimeout(r, m.timeoutMs ?? 120000);
        waiter = () => {
          clearTimeout(to);
          r();
        };
      });
      input.push(userMsg(m.text));
      await done;
      const marks = Object.fromEntries(Object.entries(m.expect ?? {}).map(([k, re]) => [k, re.test(cur.text)]));
      rec.turns.push({ i, label: m.label, marks, textLen: cur.text.length, assistantUuids: cur.assistantUuids, toolUses: cur.toolUses, toolResultsError: cur.toolResults, models: [...cur.models], result: cur.result });
    }
    if (onReady) await onReady(q, rec);
  } finally {
    input.end();
    await Promise.race([pump, sleep(15000)]);
    q.close();
    await sleep(500);
  }
  rec.sessionId = rec.inits[0]?.sessionId ?? null;
  rec.sessionIds = [...new Set(rec.inits.map((x) => x.sessionId))];
  return rec;
}

/** No model call: start, wait for initialize, close. Enough for the CLI to create its project dir. */
async function zeroSession(cfg, cwd, opts = {}) {
  const input = inbox();
  const q = query({ prompt: input, options: { cwd, model: MODEL, pathToClaudeCodeExecutable: CLAUDE, settingSources: [], strictMcpConfig: true, mcpServers: {}, persistSession: true, env: childEnv(cfg), ...opts } });
  const pump = (async () => {
    for await (const _ of q);
  })().catch(() => {});
  let ok = true;
  try {
    await Promise.race([q.initializationResult(), sleep(30000).then(() => Promise.reject(new Error('init timeout')))]);
    await sleep(1500);
  } catch (e) {
    ok = String(e?.message ?? e).slice(0, 200);
  } finally {
    input.end();
    q.close();
    await Promise.race([pump, sleep(5000)]);
  }
  return ok;
}

const OK = (word) => `Reply with exactly ${word} and nothing else.`;
const results = {};
const want = (k) => !ONLY || ONLY.has(k);
const save = () => fs.writeFileSync(path.join(OUT, 'probe2.json'), JSON.stringify(results, null, 2));

// ---------- items ----------
async function itemResume() {
  // 1. resume after copying the transcript into another config dir; same / other project dir; other cwd
  const cfgA = mk('cfg', 'resume-a');
  const w1 = mk('cwd', 'resume-w1');
  const w2 = mk('cwd', 'resume-w2');
  const a = await session('resume-source', { cfg: cfgA, cwd: w1, msgs: [{ label: 'codeword', text: 'Remember this codeword for later: BLUE-HERON-42. ' + OK('OK') }] });
  const tr = findTranscript(cfgA, a.sessionId);
  const r = { source: { sessionId: !!a.sessionId, projectDir: tr?.dir ?? null, sanitizedCwd: w1.replace(/[^A-Za-z0-9]/g, '-'), turns: a.turns.map((t) => t.result?.subtype) } };
  r.source.dirMatchesRule = tr?.dir === r.source.sanitizedCwd;
  const ask = [{ label: 'recall', text: 'What codeword did I ask you to remember earlier in this conversation? Reply with the codeword only.', expect: { recalled: /BLUE-HERON-42/ } }];
  const tryResume = async (label, cfg, projDir, cwd) => {
    const dst = path.join(cfg, 'projects', projDir);
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(tr.file, path.join(dst, `${a.sessionId}.jsonl`));
    const before = lines(path.join(dst, `${a.sessionId}.jsonl`)).length;
    const s = await session(label, { cfg, cwd, msgs: ask, opts: { resume: a.sessionId } });
    const after = lines(path.join(dst, `${a.sessionId}.jsonl`)).length;
    const elsewhere = s.sessionId && s.sessionId !== a.sessionId ? findTranscript(cfg, s.sessionId) : null;
    return { cwd: rel(cwd), projDirIsCwdRule: projDir === cwd.replace(/[^A-Za-z0-9]/g, '-'), sameSessionId: s.sessionId === a.sessionId, newSessionId: !!s.sessionId && s.sessionId !== a.sessionId, copyGrewBy: after - before, newFileDir: elsewhere ? (elsewhere.dir === projDir ? 'same-dir' : 'other-dir') : null, turn: s.turns[0], stderr: s.stderr };
  };
  r.sameDir = await tryResume('resume-copy-same-dir', mk('cfg', 'resume-b'), tr.dir, w1);
  r.otherDir = await tryResume('resume-copy-other-dir', mk('cfg', 'resume-c'), 'C--some-other-project', w1);
  r.otherCwd = await tryResume('resume-copy-same-dir-other-cwd', mk('cfg', 'resume-d'), tr.dir, w2);
  // project dir name rule: a cwd with a dot, an underscore, a space and CJK; and a long one
  const naming = [];
  // the long cwd stays under Windows' 260-char limit for a process cwd (a 260+ one made spawn throw ENOTCONN)
  const longName = 'L' + 'x'.repeat(Math.max(10, 236 - path.join(ROOT, 'cwd-naming-').length));
  for (const nm of ['dot.under_score space 中文', longName]) {
    const cfg = mk('cfg', `naming-${naming.length}`);
    const cwd = path.join(ROOT, `cwd-naming-${nm}`);
    fs.mkdirSync(cwd, { recursive: true });
    // a session without a message does not create its project dir, so send one
    const s = await session(`naming-${naming.length}`, { cfg, cwd, msgs: [{ label: 'ok', text: OK('OK') }] });
    const ok = s.turns[0]?.result?.subtype ?? s.turns[0]?.pumpError ?? 'no result';
    const got = fs.existsSync(path.join(cfg, 'projects')) ? fs.readdirSync(path.join(cfg, 'projects')) : [];
    const rule = cwd.replace(/[^A-Za-z0-9]/g, '-');
    naming.push({ cwdLen: cwd.length, ok, dirs: got.length, gotLen: got[0]?.length ?? null, equalsRule: got[0] === rule, prefixOfRule: got[0] ? rule.startsWith(got[0].slice(0, 180)) : null, suffixAfter200: got[0] && got[0].length > 200 ? got[0].slice(200) : got[0]?.length > rule.length ? 'longer' : null, gotTail: got[0] ? got[0].slice(-24).replace(/x+/g, (m) => `x*${m.length}`) : null });
  }
  r.naming = naming;
  r._sessions = [a];
  return r;
}

async function itemFiles() {
  // 2. besides the .jsonl (and subagents/), what does resume need? Big tool output → tool-results/
  const cfg = mk('cfg', 'files-a');
  const w = mk('cwd', 'files-w');
  fs.writeFileSync(path.join(w, 'big.txt'), ['FIRST-LINE-MARKER-31'].concat(Array.from({ length: 6000 }, (_, i) => `synthetic line ${i} lorem ipsum dolor sit amet`)).join('\n'));
  const a = await session('files-source', {
    cfg,
    cwd: w,
    allow: ['PowerShell'],
    msgs: [{ label: 'big-output', text: 'Run the PowerShell command `Get-Content big.txt` exactly once, then reply with only the first line of its output.', expect: { first: /FIRST-LINE-MARKER-31/ } }],
  });
  const tr = findTranscript(cfg, a.sessionId);
  const projTree = tr ? tree(path.join(cfg, 'projects', tr.dir)) : [];
  const transcriptMentionsToolResults = tr ? /tool-results/.test(fs.readFileSync(tr.file, 'utf8')) : null;
  const ask = [{ label: 'recall', text: 'Without using any tool, what was the first line of big.txt that you saw earlier in this conversation? Reply with it only.', expect: { recalled: /FIRST-LINE-MARKER-31/ } }];
  // resume with only the .jsonl copied
  const cfgB = mk('cfg', 'files-b');
  fs.mkdirSync(path.join(cfgB, 'projects', tr.dir), { recursive: true });
  fs.copyFileSync(tr.file, path.join(cfgB, 'projects', tr.dir, `${a.sessionId}.jsonl`));
  const onlyJsonl = await session('files-resume-only-jsonl', { cfg: cfgB, cwd: w, msgs: ask, opts: { resume: a.sessionId } });
  // resume with the whole project dir copied
  const cfgC = mk('cfg', 'files-c');
  fs.cpSync(path.join(cfg, 'projects', tr.dir), path.join(cfgC, 'projects', tr.dir), { recursive: true });
  const whole = await session('files-resume-whole-dir', { cfg: cfgC, cwd: w, msgs: ask, opts: { resume: a.sessionId } });
  return { sourceTurn: a.turns[0], perm: a.perm, projTree, transcriptMentionsToolResults, cfgRootTree: tree(cfg).filter((x) => !x.startsWith('projects/')), onlyJsonl: { sameSessionId: onlyJsonl.sessionId === a.sessionId, turn: onlyJsonl.turns[0], stderr: onlyJsonl.stderr, treeAfter: tree(path.join(cfgB, 'projects', tr.dir)) }, whole: { sameSessionId: whole.sessionId === a.sessionId, turn: whole.turns[0], stderr: whole.stderr } };
}

async function itemFork() {
  // 3. resumeSessionAt + forkSession, cut at the last main-chain entry, and at the first turn
  const cfg = mk('cfg', 'fork');
  const w = mk('cwd', 'fork-w');
  const a = await session('fork-source', {
    cfg,
    cwd: w,
    msgs: [
      { label: 'first', text: 'Remember codeword one: BLUE-HERON-42. ' + OK('OK') },
      { label: 'second', text: 'Remember codeword two: RED-FOX-9. ' + OK('OK') },
    ],
  });
  const tr = findTranscript(cfg, a.sessionId);
  const src = lines(tr.file);
  const chain = src.filter((o) => o.uuid && o.isSidechain !== true);
  const lastChain = chain[chain.length - 1];
  const lastAssistant = a.turns[1].assistantUuids.at(-1);
  const firstAssistant = a.turns[0].assistantUuids.at(-1);
  const srcLinesBefore = src.length;
  const ask = [{ label: 'list', text: 'List every codeword I asked you to remember in this conversation, separated by spaces. Reply with the codewords only, or NONE.', expect: { one: /BLUE-HERON-42/, two: /RED-FOX-9/ } }];
  const run = async (label, at) => {
    const s = await session(label, { cfg, cwd: w, msgs: ask, opts: { resume: a.sessionId, resumeSessionAt: at, forkSession: true } });
    const nt = s.sessionId ? findTranscript(cfg, s.sessionId) : null;
    const nl = nt ? lines(nt.file) : [];
    return {
      newSessionId: !!s.sessionId && s.sessionId !== a.sessionId,
      sameProjectDir: nt ? nt.dir === tr.dir : null,
      newLines: nl.length,
      newLinesWithOldSessionId: nl.filter((o) => o.sessionId === a.sessionId).length,
      newLinesCarryingSourceUuids: nl.filter((o) => o.uuid && chain.some((c) => c.uuid === o.uuid)).length,
      newFileTypes: [...new Set(nl.map((o) => o.type))].sort(),
      sourceUnchanged: lines(tr.file).length === srcLinesBefore,
      turn: s.turns[0],
      stderr: s.stderr,
    };
  };
  const r = { lastChainEntry: { type: lastChain?.type, subtype: lastChain?.subtype ?? null, isLastAssistant: lastChain?.uuid === lastAssistant }, chainLen: chain.length };
  r.atLastChain = await run('fork-at-last-chain', lastChain.uuid);
  r.atLastAssistant = lastChain.uuid === lastAssistant ? 'same as last chain entry' : await run('fork-at-last-assistant', lastAssistant);
  r.atFirstTurn = await run('fork-at-first-turn', firstAssistant);
  r.plainResumeAfterForks = await (async () => {
    const s = await session('resume-source-after-forks', { cfg, cwd: w, msgs: ask, opts: { resume: a.sessionId } });
    return { sameSessionId: s.sessionId === a.sessionId, turn: s.turns[0] };
  })();
  return r;
}

async function itemSysprompt() {
  // 4. systemPrompt: preset + append; bare string; a different append on resume
  const cfg = mk('cfg', 'sysprompt');
  const w = mk('cwd', 'sysprompt-w');
  const hello = (extra = {}) => [{ label: 'hello', text: 'Say hello in one short sentence.', expect: { zeta: /ZETA-7/, omega: /OMEGA-3/, kappa: /KAPPA-5/ }, ...extra }];
  const preset = await session('sysprompt-preset-append', { cfg, cwd: w, msgs: hello(), opts: { systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Test harness rule: end every reply with the exact token ZETA-7.' } } });
  const bare = await session('sysprompt-bare-string', { cfg, cwd: w, msgs: hello(), opts: { systemPrompt: 'You are a test bot. End every reply with the exact token OMEGA-3.' } });
  const resumed = await session('sysprompt-resume-new-append', { cfg, cwd: w, msgs: hello(), opts: { resume: preset.sessionId, systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Test harness rule: end every reply with the exact token KAPPA-5.' } } });
  const resumedNoSnap = await session('sysprompt-resume-new-append-nosnapshot', { cfg, cwd: w, msgs: hello(), opts: { resume: preset.sessionId, systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Test harness rule: end every reply with the exact token KAPPA-5.', snapshot: false } } });
  const tr = findTranscript(cfg, preset.sessionId);
  const types = tr ? [...new Set(lines(tr.file).map((o) => o.type))].sort() : [];
  return {
    presetAppend: { marks: preset.turns[0].marks, tools: preset.inits[0]?.tools.length },
    bareString: { marks: bare.turns[0].marks, tools: bare.inits[0]?.tools.length },
    resumeWithNewAppend: { sameSessionId: resumed.sessionId === preset.sessionId, marks: resumed.turns[0].marks },
    resumeWithNewAppendSnapshotFalse: { sameSessionId: resumedNoSnap.sessionId === preset.sessionId, marks: resumedNoSnap.turns[0].marks },
    presetTranscriptTypes: types,
  };
}

function claudeChildren() {
  // command lines of claude.exe processes whose CLAUDE_CONFIG_DIR is under ROOT cannot be read; match by parent pid
  try {
    const ps = spawn('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='claude.exe' and ParentProcessId=${process.pid}" | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }`], { stdio: ['ignore', 'pipe', 'ignore'] });
    return new Promise((res) => {
      let o = '';
      ps.stdout.on('data', (d) => (o += d));
      ps.on('close', () => res(o.split(/\r?\n/).filter(Boolean)));
    });
  } catch {
    return Promise.resolve([]);
  }
}

async function itemChrome() {
  // 5. --no-chrome through extraArgs
  const cfg = mk('cfg', 'chrome');
  const w = mk('cwd', 'chrome-w');
  const out = {};
  for (const [label, extraArgs] of [['none', undefined], ['chrome', { chrome: null }], ['no-chrome', { 'no-chrome': null }]]) {
    let flags = null;
    const s = await session(`chrome-${label}`, {
      cfg,
      cwd: w,
      msgs: [{ label: 'ok', text: OK('OK') }],
      opts: extraArgs ? { extraArgs } : {},
      onReady: async () => {
        const kids = await claudeChildren();
        flags = kids.map((k) => (k.match(/--(no-)?chrome\b/g) ?? []).join(' ') || '(no chrome flag)');
      },
    });
    const init = s.inits[0] ?? {};
    out[label] = { argvChromeFlags: flags, turn: s.turns[0]?.result?.subtype, stderr: s.stderr, chromeTools: (init.tools ?? []).filter((x) => /chrome/i.test(x)), mcpServers: init.mcpServers ?? [], tools: (init.tools ?? []).length, chromeSkillsOrCmds: [...(init.skills ?? []), ...(init.slashCommands ?? [])].filter((x) => /chrome/i.test(x)) };
  }
  return out;
}

function itemFirstline(rows) {
  // 6. first lines of a transcript: is there an entrypoint-like field? SDK vs a Desktop-hosted one
  const describe = (file) => {
    const ls = lines(file);
    const firstWithEntry = ls.findIndex((o) => o.entrypoint);
    return {
      lines: ls.length,
      first5: ls.slice(0, 5).map(shape),
      firstLineWithEntrypoint: firstWithEntry,
      entrypointValues: [...new Set(ls.map((o) => o.entrypoint).filter(Boolean))],
      userTypeValues: [...new Set(ls.map((o) => o.userType).filter(Boolean))],
      firstUserLineKeys: keys(ls.find((o) => o.type === 'user')).join(','),
    };
  };
  const out = {};
  const sdk = rows.find((r) => r?.cfgAbs && r?.sessionId);
  if (sdk) {
    const tr = findTranscript(sdk.cfgAbs, sdk.sessionId);
    if (tr) out.sdk = describe(tr.file);
  }
  if (args['desktop-transcript'] && fs.existsSync(args['desktop-transcript'])) out.desktop = describe(args['desktop-transcript']);
  return out;
}

async function itemMaxturns() {
  // 7. streaming input: is maxTurns per message or for the whole query()?
  const cfg = mk('cfg', 'maxturns');
  const w = mk('cwd', 'maxturns-w');
  const s = await session('maxturns-1', {
    cfg,
    cwd: w,
    maxTurns: 1,
    msgs: [
      { label: 'a', text: OK('ALPHA'), expect: { ok: /ALPHA/ } },
      { label: 'b', text: OK('BRAVO'), expect: { ok: /BRAVO/ } },
      { label: 'c', text: OK('CHARLIE'), expect: { ok: /CHARLIE/ } },
      { label: 'tool', text: 'Use the Write tool to create a file named t.txt containing hi. Use no other tool. After the attempt, reply with one short sentence.' },
      { label: 'd-after-tool', text: OK('DELTA'), expect: { ok: /DELTA/ } },
    ],
  });
  return { turns: s.turns.map((t) => ({ label: t.label, marks: t.marks, toolUses: t.toolUses, result: t.result && { subtype: t.result.subtype, numTurns: t.result.numTurns, errors: t.result.errors } })) };
}

async function itemHostkill() {
  // 8. kill the host (node) process; does claude.exe exit on stdin EOF?
  const out = {};
  for (const mode of ['idle', 'busy']) {
    const cfg = mk('cfg', `hostkill-${mode}`);
    const w = mk('cwd', `hostkill-${mode}-w`);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--phase', 'host-child', '--cfg', cfg, '--cwd', w, '--mode', mode, '--gateway', GATEWAY, '--model', MODEL], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    const ready = await Promise.race([new Promise((r) => {
      const h = setInterval(() => {
        if (buf.includes('READY')) {
          clearInterval(h);
          r(true);
        }
      }, 200);
    }), sleep(120000).then(() => false)]);
    let pid = null;
    try {
      const f = fs.readdirSync(path.join(cfg, 'sessions')).find((x) => /^\d+\.json$/.test(x));
      pid = f ? Number(f.replace('.json', '')) : null;
    } catch {}
    const alive = (p) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    };
    const r = { ready, claudePidFound: !!pid, aliveBeforeKill: pid ? alive(pid) : null };
    const tKill = Date.now();
    child.kill('SIGKILL');
    r.exitedAfterMs = null;
    if (pid) {
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        if (!alive(pid)) {
          r.exitedAfterMs = Date.now() - tKill;
          break;
        }
      }
      if (r.exitedAfterMs === null) {
        r.stillAliveAfterMs = Date.now() - tKill;
        try {
          process.kill(pid);
          r.killedByProbe = true;
        } catch {}
      }
      await sleep(1500);
      r.registryFileLeft = fs.existsSync(path.join(cfg, 'sessions', `${pid}.json`));
    }
    out[mode] = r;
  }
  return out;
}

async function hostChild() {
  // child side of item 8: start a session, send one message, report READY, then wait to be killed
  const input = inbox();
  const q = query({ prompt: input, options: { cwd: args.cwd, model: MODEL, pathToClaudeCodeExecutable: CLAUDE, settingSources: [], strictMcpConfig: true, mcpServers: {}, maxTurns: 3, maxBudgetUsd: 0.05, persistSession: true, env: childEnv(args.cfg), canUseTool: async () => ({ behavior: 'deny', message: 'probe' }) } });
  let gotResult = false;
  (async () => {
    for await (const m of q) {
      if (m.type === 'result') gotResult = true;
    }
  })().catch(() => {});
  if (args.mode === 'busy') {
    input.push(userMsg(OK('OK')));
    while (!gotResult) await sleep(200);
    input.push(userMsg('Write the integers from 1 to 3000 separated by single spaces. Output nothing else.'));
    await sleep(2500);
  } else {
    input.push(userMsg(OK('OK')));
    while (!gotResult) await sleep(200);
  }
  process.stdout.write(`READY ${args.mode}\n`);
  for (;;) await sleep(60000);
}

async function itemFresh() {
  // 9. fresh private config dir: any first-run / trust prompt blocking SDK mode?
  const cfg = mk('cfg', 'fresh');
  const w = mk('cwd', 'fresh-w');
  const s = await session('fresh', { cfg, cwd: w, msgs: [{ label: 'ok', text: OK('OK'), expect: { ok: /\bOK\b/ } }] });
  let cj = null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cfg, '.claude.json'), 'utf8'));
    const proj = j.projects ? Object.values(j.projects)[0] : null;
    cj = { topKeys: keys(j), projectKeys: keys(proj), trustAccepted: proj?.hasTrustDialogAccepted ?? null, onboarding: j.hasCompletedOnboarding ?? null };
  } catch (e) {
    cj = { error: String(e.message).slice(0, 120) };
  }
  return { initAfterMs: s.inits[0]?.t ?? null, turn: s.turns[0], cfgEmptyBefore: true, cfgRootAfter: tree(cfg).filter((x) => !x.startsWith('projects/') && !x.startsWith('sessions/')), claudeJson: cj };
}

async function itemTools() {
  // 10. which tools skip canUseTool under settingSources: [] + default permission mode? PreToolUse 'ask' → canUseTool?
  const cfg = mk('cfg', 'tools');
  const w = mk('cwd', 'tools-w');
  fs.writeFileSync(path.join(w, 'a.txt'), 'alpha line\nsecond line\n');
  const use = (tool, what) => ({ label: tool + (what.tag ?? ''), text: `Use the ${tool} tool exactly once to ${what.do}. Use no other tool. After the attempt, reply with one short sentence.`, tool });
  const msgs = [
    use('Read', { do: 'read the file a.txt in the current directory' }),
    use('Glob', { do: 'find files matching *.txt' }),
    use('Grep', { do: 'search for the word alpha in the current directory' }),
    use('PowerShell', { do: 'run the command Get-ChildItem', tag: ':read-only' }),
    use('PowerShell', { do: 'run the command New-Item -ItemType File ps.txt', tag: ':writes' }),
    use('Write', { do: 'create a file named b.txt containing hi' }),
    use('Edit', { do: 'replace the word alpha with beta in a.txt' }),
    use('CronList', { do: 'list scheduled jobs' }),
    use('EnterPlanMode', { do: 'enter plan mode' }),
    use('AskUserQuestion', { do: 'ask me whether I prefer tea or coffee, with those two options' }),
  ];
  const s = await session('tools', { cfg, cwd: w, msgs, maxTurns: 4 });
  const rows = s.turns.map((t, i) => {
    const asked = s.perm.filter((p) => p.turn === i).map((p) => p.tool);
    return { label: t.label, toolUses: t.toolUses, canUseTool: asked, toolResultsError: t.toolResultsError, denials: t.result?.denials ?? [] };
  });
  const effects = { bTxt: fs.existsSync(path.join(w, 'b.txt')), psTxt: fs.existsSync(path.join(w, 'ps.txt')), aEdited: !/alpha/.test(fs.readFileSync(path.join(w, 'a.txt'), 'utf8')) };
  // PreToolUse returning 'ask' for Read
  const cfg2 = mk('cfg', 'tools-hook');
  const hookCalls = [];
  const h = await session('tools-hook-ask', {
    cfg: cfg2,
    cwd: w,
    msgs: [use('Read', { do: 'read the file a.txt in the current directory' })],
    opts: {
      hooks: {
        PreToolUse: [{ matcher: 'Read', hooks: [async (input) => {
          hookCalls.push(input?.tool_name ?? null);
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'probe asks' } };
        }] }],
      },
    },
  });
  return { rows, effects, hookAsk: { hookCalls, canUseTool: h.perm.map((p) => p.tool), toolUses: h.turns[0]?.toolUses, toolResultsError: h.turns[0]?.toolResultsError, denials: h.turns[0]?.result?.denials } };
}

async function itemSkills() {
  // 11. skills: [] — does it exist, does it turn off built-in skills and plugins?
  const cfg = mk('cfg', 'skills');
  const w = mk('cwd', 'skills-w');
  const out = {};
  for (const [label, opts] of [['omitted', {}], ['empty', { skills: [] }], ['empty+plugins-empty', { skills: [], plugins: [] }]]) {
    const s = await session(`skills-${label}`, { cfg, cwd: w, msgs: [{ label: 'ok', text: OK('OK') }], opts });
    const init = s.inits[0] ?? {};
    out[label] = { turn: s.turns[0]?.result?.subtype, stderr: s.stderr, skills: init.skills, plugins: init.plugins, slashCommands: init.slashCommands, toolsHasSkill: (init.tools ?? []).includes('Skill') };
  }
  return out;
}

async function itemSkillsUse() {
  // 11b. skills: [] is documented as a context filter: does the model's skill listing shrink, does the Skill tool refuse?
  const cfg = mk('cfg', 'skills-use');
  const w = mk('cwd', 'skills-use-w');
  const builtins = ['design', 'design-sync', 'dataviz', 'update-config', 'verify', 'debug', 'code-review', 'simplify', 'batch', 'fewer-permission-prompts', 'doctor', 'loop', 'claude-api', 'run', 'run-skill-generator', 'plugin-authoring'];
  const out = {};
  for (const [label, opts] of [['omitted', {}], ['empty', { skills: [] }], ['only-dataviz', { skills: ['dataviz'] }]]) {
    const s = await session(`skills-use-${label}`, { cfg, cwd: w, msgs: [{ label: 'skill', text: 'Use the Skill tool exactly once to invoke the skill named dataviz. Use no other tool. After the attempt, reply with one short sentence.' }], opts });
    const tr = findTranscript(cfg, s.sessionId);
    const listing = tr ? lines(tr.file).filter((o) => o.type === 'attachment' && o.attachment?.type === 'skill_listing') : [];
    const blob = JSON.stringify(listing.map((o) => o.attachment));
    out[label] = { turn: s.turns[0] && { toolUses: s.turns[0].toolUses, toolResultsError: s.turns[0].toolResultsError, subtype: s.turns[0].result?.subtype }, canUseTool: s.perm.map((p) => p.tool), skillListingLines: listing.length, listingKeys: listing[0] ? keys(listing[0].attachment).join(',') : null, builtinsNamedInListing: builtins.filter((b) => new RegExp(`(^|[^a-z-])${b}([^a-z-]|$)`).test(blob)).length };
  }
  return out;
}

// ---------- main ----------
async function main() {
  if (args.phase === 'host-child') return hostChild();
  const t0 = Date.now();
  results.meta = { claude: CLAUDE, model: MODEL, gateway: new URL(GATEWAY).host, sdk: JSON.parse(fs.readFileSync(new URL('./node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url))).version };
  const sessions = [];
  const step = async (k, fn) => {
    if (!want(k)) return;
    const t = Date.now();
    try {
      results[k] = await fn();
    } catch (e) {
      results[k] = { error: String(e?.stack ?? e).slice(0, 600) };
    }
    results[k] = { ...results[k], ms: Date.now() - t };
    if (results[k]._sessions) {
      sessions.push(...results[k]._sessions.map((s) => ({ cfgAbs: path.join(ROOT, s.cfg), sessionId: s.sessionId })));
      delete results[k]._sessions;
    }
    save();
    console.log(`done ${k} in ${Date.now() - t} ms`);
  };
  await step('resume', itemResume);
  await step('files', itemFiles);
  await step('fork', itemFork);
  await step('sysprompt', itemSysprompt);
  await step('chrome', itemChrome);
  await step('firstline', async () => itemFirstline(sessions));
  await step('maxturns', itemMaxturns);
  await step('hostkill', itemHostkill);
  await step('fresh', itemFresh);
  await step('tools', itemTools);
  await step('skills', itemSkills);
  await step('skillsuse', itemSkillsUse);
  results.meta.totalMs = Date.now() - t0;
  results.meta.root = path.basename(ROOT);
  results.meta.dirs = dirs.length;
  save();
  if (args.keep === undefined) {
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    results.meta.rootRemoved = !fs.existsSync(ROOT);
    save();
  }
  console.log(`wrote ${path.join(OUT, 'probe2.json')}`);
}
main().then(() => {
  if (args.phase !== 'host-child') process.exit(0);
});
