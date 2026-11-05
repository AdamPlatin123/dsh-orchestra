import { frozen } from '../../shared/frozen.js';

// The dispatch desk's deterministic rules (orchestra app plan §3; r4 D9: deterministic rules first, a
// model only after them; §9.2 step 1, an explicit name, comes before anything else). Pure: a sentence
// and which harnesses are on in, the rules that hit and their candidates out. Nothing here starts a
// session or reaches the network; src/route/desk.ts asks the router model afterwards and never lets a
// suggestion dispatch by itself (r4 §9.2 step 10, "Route to?": the person picks).
//
// The rules, in order (each one that hits is listed in `hits`, the record keeps them):
//   named-model      the sentence names a model of ROUTE_MODELS (zcode/GLM-5.3, or a bare GLM-5.3-Flash);
//   named-harness    it names a harness: "用 codex", "use claude", "@codex"; "不要用 codex" drops that harness;
//   code-or-command  it asks to change code, run a command or a test, or edit a named file: Codex;
//   short-question   a short question or "explain" with none of the above: the cheap model, on Claude;
//   fallback         always last, to fill the alternatives: Codex's default, then Claude's.
// A candidate whose harness is off, or whose model its harness does not take, is left out.

export type RouteHarness = 'codex' | 'claude';

/** The models the desk may suggest, per harness, the default first: ui/owned.js MODELS (the dialog's lists), which a test holds equal. */
export const ROUTE_MODELS: Readonly<Record<RouteHarness, readonly string[]>> = frozen({
  codex: ['codex/gpt-6.1-sol', 'codex/gpt-6-astra', 'codex/gpt-6.1-terra', 'zcode/GLM-5.3', 'opencode-go/glm-5.3'],
  claude: ['zcode/GLM-5.3', 'zcode/GLM-5.3-Flash', 'zcode/GLM-5.2', 'opencode-go/glm-5.3', 'opencode-go/kimi-k3', 'opencode-go/claude-haiku-5-5'],
});
export const ROUTE_HARNESSES: readonly RouteHarness[] = frozen(['codex', 'claude'] as const);
/** The rules, in the order they run; each candidate names the one that put it there (null: the router model). */
export const RULE_IDS = frozen(['named-model', 'named-harness', 'code-or-command', 'short-question', 'fallback'] as const);
export type RuleId = (typeof RULE_IDS)[number];
/** What the rules read the sentence as (RouteDecision.taskClass, r4 §6.2). */
export const TASK_CLASSES = frozen(['named', 'code', 'question', 'general'] as const);
export type TaskClass = (typeof TASK_CLASSES)[number];

/** What the router model did for a suggestion: answered, failed to (no-answer), was not asked because the rules settled it (skipped), or is off. */
export const ROUTER_STATES = frozen(['answered', 'no-answer', 'skipped', 'off'] as const);
export type RouterState = (typeof ROUTER_STATES)[number];
/** What a RouteDecision record says of the router model: a suggestion's state, or not-asked (a dispatch with no suggestion for its sentence). */
export const ROUTE_RECORD_ROUTER = frozen([...ROUTER_STATES, 'not-asked'] as const);
/**
 * The dispatch modes: manual, a person dispatched it (r4 §9.5, from M1); auto, a worker did, on the permission a person
 * gave it (src/route/dispatch.ts; the user's word of 2026-11-03, against r4 §9.5's shadow and Q11's gate: orchestra app
 * plan 派活权限). Shadow and active come later.
 */
export const ROUTE_MODES = frozen(['manual', 'auto'] as const);
/** A RouteDecision's reason chip: the rule of the candidate taken, router-model for the model's pick, manual for a choice by hand, worker for a worker's own (mode auto). */
export const ROUTE_REASONS = frozen([...RULE_IDS, 'router-model', 'manual', 'worker'] as const);

/** The model a short question goes to: the fast one Claude takes. */
export const CHEAP_MODEL = 'zcode/GLM-5.3-Flash';
const DEFAULT: Readonly<Record<RouteHarness, string>> = frozen({ codex: 'codex/gpt-6.1-sol', claude: 'zcode/GLM-5.3' });
/** The most candidates a suggestion shows: the first and two alternatives. */
export const MAX_CANDIDATES = 3;
/** A short question is at most this many code points. */
const SHORT_CP = 80;
/** A rule title is the sentence's first line, cut to this many code points. */
export const TITLE_CP = 40;

export type Candidate = {
  readonly harness: RouteHarness;
  readonly model: string;
  readonly source: 'rule' | 'model';
  /** The rule that put it here; null for the router model's pick. */
  readonly rule: RuleId | null;
  /** The router model's words (redacted, cut); null for a rule, whose reason the page words from its id. */
  readonly reason: string | null;
};

export type RuleOutcome = {
  readonly hits: readonly RuleId[];
  readonly taskClass: TaskClass;
  readonly candidates: readonly Candidate[];
  /** Harnesses the sentence ruled out ("不要用 codex"). */
  readonly excluded: readonly RouteHarness[];
  /** Both a harness and a model were named and agree: nothing is left for a model to decide (D9). */
  readonly decided: boolean;
  readonly title: string;
};

const HARNESS_NAMED = /(?:用|使用|让|交给|派给|走|\buse\b|\busing\b|\bvia\b|\bwith\b|@)\s*(codex|claude)(?![A-Za-z0-9_-])/gi;
const HARNESS_NOT = /(?:不|别|不要|勿|\bdon'?t\s+use\b|\bnot\b|\bwithout\b)\s*(?:用|使用|让|走)?\s*(codex|claude)(?![A-Za-z0-9_-])/gi;
const CODE_RE = new RegExp([
  '修复', '修一', '修个', '修掉', '改代码', '改一下代码', '重构', '跑一下', '跑下', '跑测试', '运行', '执行', '编译', '构建', '部署', '提交', '合并', '调试', '报错',
  '写(?:一个|个)?(?:函数|脚本|程序|代码|测试|单元测试)', '实现', '命令', '脚本', '单元测试', '测试用例',
  '\\bfix\\b', '\\brefactor\\b', '\\brun\\b', '\\btests?\\b', '\\bbuild\\b', '\\bcompile\\b', '\\bdebug\\b', '\\bimplement\\b', '\\bcommit\\b', '\\bdeploy\\b', '\\bscript\\b', '\\bcommand\\b', '\\bbug\\b',
].join('|'), 'i');
const FILE_RE = /(?:\bREADME\b|[\w-]+\.(?:md|txt|ts|tsx|js|mjs|py|json|toml|ya?ml|go|rs|java|cs|c|cpp|h|css|html)\b|文件)/i;
const EDIT_RE = /(?:翻译|翻成|改写|修改|编辑|更新|写入|改成|\btranslate\b|\brewrite\b|\bedit\b|\bupdate\b)/i;
const QUESTION_START = /^\s*(?:什么|为什么|为啥|怎么|如何|怎样|是否|能否|可以|解释|讲讲|说说|介绍|what\b|why\b|how\b|explain\b|is\b|are\b|does\b|do\b|can\b|should\b)/i;
const QUESTION_END = /(?:[?？]|吗|呢|是什么)\s*$/;
const MODEL_FULL = /(?:zcode|opencode-go|codex)\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}/gi;
// Control characters and the bidi marks never reach a title.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

const cpCount = (s: string): number => [...s].length;

/** `s` with control and bidi characters gone, spaces folded, cut to `max` code points (… marks a cut). */
export function clip(s: string, max: number): string {
  const one = s.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  const cps = [...one];
  return cps.length <= max ? one : `${cps.slice(0, max - 1).join('')}…`;
}

/** The whitelisted model a name stands for, matched without case; null when none. */
export function canonicalModel(name: string, harness: RouteHarness | null = null): string | null {
  const lists = harness === null ? [...ROUTE_MODELS.codex, ...ROUTE_MODELS.claude] : ROUTE_MODELS[harness];
  const want = name.toLowerCase();
  return lists.find((m) => m.toLowerCase() === want) ?? null;
}

/** The model the sentence names: a full id first, then a bare one (longest first, so GLM-5.3-Flash before GLM-5.3). */
function namedModel(text: string): string | null {
  for (const m of text.matchAll(MODEL_FULL)) {
    const c = canonicalModel(m[0]);
    if (c !== null) return c;
  }
  const all = [...new Set([...ROUTE_MODELS.codex, ...ROUTE_MODELS.claude])];
  const bare = all.map((m) => ({ m, tail: m.slice(m.indexOf('/') + 1) })).sort((a, b) => b.tail.length - a.tail.length);
  const lower = text.toLowerCase();
  for (const { m, tail } of bare) {
    const i = lower.indexOf(tail.toLowerCase());
    if (i < 0) continue;
    const before = i === 0 ? '' : lower[i - 1]!;
    const after = lower[i + tail.length] ?? '';
    if (/[a-z0-9._/-]/.test(before) || /[a-z0-9_-]/.test(after) || (after === '.' && /[0-9]/.test(lower[i + tail.length + 1] ?? ''))) continue;
    return m;
  }
  return null;
}

function namedHarness(text: string): { named: RouteHarness | null; excluded: RouteHarness[] } {
  const excluded = new Set<RouteHarness>();
  const notSpans: [number, number][] = [];
  for (const m of text.matchAll(HARNESS_NOT)) {
    excluded.add(m[1]!.toLowerCase() as RouteHarness);
    notSpans.push([m.index, m.index + m[0].length]);
  }
  for (const m of text.matchAll(HARNESS_NAMED)) {
    const end = m.index + m[0].length;
    if (notSpans.some(([a, b]) => end > a && end <= b)) continue;
    const h = m[1]!.toLowerCase() as RouteHarness;
    if (!excluded.has(h)) return { named: h, excluded: [...excluded] };
  }
  return { named: null, excluded: [...excluded] };
}

export function isCodeOrCommand(text: string): boolean {
  return CODE_RE.test(text) || (FILE_RE.test(text) && EDIT_RE.test(text));
}

export function isShortQuestion(text: string): boolean {
  const t = text.trim();
  return cpCount(t) <= SHORT_CP && (QUESTION_START.test(t) || QUESTION_END.test(t));
}

/** The rule title: the sentence's first non-empty line, cleaned and cut. */
export function ruleTitle(text: string): string {
  const first = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  return clip(first, TITLE_CP);
}

/**
 * The rules over one sentence. `on` says which harnesses can start a session now: a candidate on a
 * harness that is off is left out (an `excluded` harness too).
 */
export function runRules(text: string, on: Readonly<Record<RouteHarness, boolean>>): RuleOutcome {
  const hits: RuleId[] = [];
  const out: Candidate[] = [];
  const { named, excluded } = namedHarness(text);
  const model = namedModel(text);
  const code = isCodeOrCommand(text);
  const question = !code && isShortQuestion(text);
  const usable = (h: RouteHarness) => on[h] && !excluded.includes(h);
  const add = (harness: RouteHarness, m: string, rule: RuleId) => {
    if (!usable(harness) || !ROUTE_MODELS[harness].includes(m)) return;
    if (out.some((c) => c.harness === harness && c.model === m)) return;
    out.push(Object.freeze({ harness, model: m, source: 'rule', rule, reason: null }));
  };
  /** The model a harness takes for this sentence when none was named. */
  const modelFor = (h: RouteHarness) => (h === 'claude' && question ? CHEAP_MODEL : DEFAULT[h]);

  let decided = false;
  if (model !== null) {
    hits.push('named-model');
    // The harness named with it, when it takes the model; else Codex for codex/*, Claude for the rest
    // unless the sentence is about code; else whichever takes it.
    const takers = ROUTE_HARNESSES.filter((h) => ROUTE_MODELS[h].includes(model));
    const pref: RouteHarness[] = named !== null && takers.includes(named) ? [named] : model.startsWith('codex/') || code ? ['codex', 'claude'] : ['claude', 'codex'];
    const h = [...pref, ...takers].find((x) => takers.includes(x) && usable(x));
    if (h !== undefined) add(h, model, 'named-model');
    decided = named !== null && takers.includes(named) && usable(named);
  }
  if (named !== null) {
    hits.push('named-harness');
    add(named, modelFor(named), 'named-harness');
  } else if (excluded.length > 0) {
    hits.push('named-harness');
  }
  if (code) {
    hits.push('code-or-command');
    add('codex', DEFAULT.codex, 'code-or-command');
  }
  if (question) {
    hits.push('short-question');
    add('claude', CHEAP_MODEL, 'short-question');
  }
  hits.push('fallback');
  add('codex', DEFAULT.codex, 'fallback');
  add('claude', DEFAULT.claude, 'fallback');
  const taskClass: TaskClass = model !== null || named !== null ? 'named' : code ? 'code' : question ? 'question' : 'general';
  return Object.freeze({
    hits: Object.freeze(hits), taskClass, candidates: Object.freeze(out.slice(0, MAX_CANDIDATES)), excluded: Object.freeze(excluded),
    decided: decided && out.length > 0, title: ruleTitle(text),
  });
}
