import { frozen } from '../../shared/frozen.js';
import type { LoopbackPostResult } from '../net/magpie.ts';
import type { RouteHarness } from './rules.ts';
import { ROUTE_HARNESSES, ROUTE_MODELS, canonicalModel, clip } from './rules.ts';

// The dispatch desk's second step (orchestra app plan §3; r4 D9: the model only after the rules): one
// chat completion on the local magpie gateway, JSON only. What goes out is the fixed system prompt
// below and the person's one sentence, nothing else: no session content, no path, no history. What
// comes back is read as {harness, model, title, reason}; magpie's message.content is that JSON as a
// string (its reasoning_content is ignored). Anything else (no answer in time, a status that is not
// 200, content that is not that object, a model off the list, a harness that is off) is a typed `why`,
// and the desk shows the rules' suggestion alone.

/** The router model the composition root asks by default (orchestra app plan §3). */
export const DEFAULT_ROUTER_MODEL = 'zcode/GLM-5.3';
/** Why the router model's answer was not used. */
export const ROUTER_WHY = frozen(['timeout', 'network', 'too-big', 'http-error', 'bad-json', 'bad-shape', 'model-not-allowed', 'harness-off'] as const);
export type RouterWhy = (typeof ROUTER_WHY)[number];
/** Code points kept of the model's title and reason. */
export const ROUTER_TEXT = frozen({ titleCp: 40, reasonCp: 160 });

/** The system prompt, fixed: the harnesses and their models are this build's lists. */
export const ROUTER_SYSTEM_PROMPT = [
  'You are the dispatch router of Orchestra, a local tool that starts coding-agent sessions on this computer.',
  'Read the user\'s one-sentence task and pick who should run it. Do not do the task.',
  'Harnesses:',
  `- "codex": the Codex CLI. Best for changing code, running commands and tests, editing files in a work directory. Models: ${ROUTE_MODELS.codex.join(', ')}.`,
  `- "claude": Claude Code. Good for explaining, reading, reviewing, writing prose and answering questions; it can edit files too. Models: ${ROUTE_MODELS.claude.join(', ')}.`,
  'For a short question, prefer the cheaper, faster model zcode/GLM-5.3-Flash on "claude".',
  'Use only the harnesses and models listed above, spelled exactly as listed.',
  'Answer with one JSON object and nothing else: {"harness": "...", "model": "...", "title": "...", "reason": "..."}.',
  'title: a short name for the task, at most 30 characters, in the language of the task.',
  'reason: one sentence, at most 80 characters, in the language of the task: why this harness and model.',
].join('\n');

/** The request body: the fixed prompt and the sentence, JSON mode, no streaming. */
export function routerRequest(model: string, text: string): Record<string, unknown> {
  return {
    model,
    messages: [{ role: 'system', content: ROUTER_SYSTEM_PROMPT }, { role: 'user', content: text }],
    response_format: { type: 'json_object' },
    temperature: 0,
    stream: false,
    max_tokens: 4096,
  };
}

export type RouterPick = { readonly harness: RouteHarness; readonly model: string; readonly title: string; readonly reason: string | null };
export type RouterAnswer = { readonly ok: true; readonly pick: RouterPick } | { readonly ok: false; readonly why: RouterWhy };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The JSON object inside the content: as it is, or inside one ``` fence. */
function contentObject(content: string): unknown {
  const s = content.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(s);
  try {
    return JSON.parse(fenced === null ? s : fenced[1]!);
  } catch {
    return undefined;
  }
}

/**
 * The router model's answer to one POST. `on` says which harnesses can start a session now; `redact`
 * runs over the title and the reason before they are kept (the model saw the person's sentence and may
 * echo what was in it).
 */
export function readRouterReply(r: LoopbackPostResult, on: Readonly<Record<RouteHarness, boolean>>, redact: (s: string) => string): RouterAnswer {
  const no = (why: RouterWhy): RouterAnswer => ({ ok: false, why });
  if (!r.ok) return no(r.why);
  if (r.status !== 200) return no('http-error');
  let body: unknown;
  try {
    body = JSON.parse(r.text);
  } catch {
    return no('bad-json');
  }
  const choice = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : undefined;
  const message = isRecord(choice) ? choice.message : undefined;
  const content = isRecord(message) ? message.content : undefined;
  if (typeof content !== 'string') return no('bad-json');
  const o = contentObject(content);
  if (o === undefined) return no('bad-json');
  if (!isRecord(o) || typeof o.harness !== 'string' || typeof o.model !== 'string' || typeof o.title !== 'string') return no('bad-shape');
  const harness = o.harness.trim().toLowerCase();
  if (!(ROUTE_HARNESSES as readonly string[]).includes(harness)) return no('bad-shape');
  const h = harness as RouteHarness;
  const model = canonicalModel(o.model.trim(), h);
  if (model === null) return no('model-not-allowed');
  if (!on[h]) return no('harness-off');
  const title = clip(redact(o.title), ROUTER_TEXT.titleCp);
  if (title === '') return no('bad-shape');
  const reasonRaw = typeof o.reason === 'string' ? clip(redact(o.reason), ROUTER_TEXT.reasonCp) : '';
  return { ok: true, pick: Object.freeze({ harness: h, model, title, reason: reasonRaw === '' ? null : reasonRaw }) };
}
