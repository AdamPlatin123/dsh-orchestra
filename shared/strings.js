// @ts-check
// Chinese text the page and the toast share (plan §3), as far as step 3 needs it: what a title arg
// shows when the source's string may not be shown, and the text of each error code, end class and
// action outcome. One symbol, one meaning (P1): two codes that ask you for different things never
// share a text (test/shared/protocol.test.ts). Step 4 freezes the keys.
import { END_CLASSES, ERROR_CODES, ACTION_OUTCOMES, TITLE_ARG_NAMES } from './protocol.js';

/** What a tool name or version title arg shows when the source's string fails its grammar (UI design 一 2). */
export const ARG_UNKNOWN = '未知';

/**
 * The text of every title key (UI design 一 2): the page and the toast both fill it with formatTitle.
 * A guess class says so first (推测：). The reminder's own words go to the notification body, never
 * into its title.
 * @type {Readonly<Record<string, string>>}
 */
export const TITLE_TEXT = Object.freeze({
  'item.approval': '{project} 在等你批准',
  'item.approval.guess': '推测：{project} 可能在等你批准',
  'item.question': '{project} 在等你回答',
  'item.question.guess': '推测：{project} 可能在等你回答',
  'item.failure': '{project} 出错了',
  'item.runaway': '{project} 失控，可能要刹车',
  'item.policy': '{project} 触发了规则',
  'item.flood': '{project} 输出过多',
  'item.ready-for-review': '{project} 待审',
  'item.reminder': '提醒到点',
  'item.unknown-outcome': '{project} 的动作结果不明',
});

const PLACEHOLDER = new RegExp(`\\{(${TITLE_ARG_NAMES.join('|')})\\}`, 'g');

/**
 * The text of a title (already through protocol.js titleError): each placeholder takes its arg, or
 * ARG_UNKNOWN when the daemon left it out. An unknown key gives ARG_UNKNOWN, never the key itself.
 * @param {{ key: string, args: Readonly<Record<string, string>> }} title
 * @returns {string}
 */
export function formatTitle(title) {
  const text = Object.hasOwn(TITLE_TEXT, title.key) ? TITLE_TEXT[title.key] : undefined;
  if (text === undefined) return ARG_UNKNOWN;
  return text.replace(PLACEHOLDER, (_m, /** @type {string} */ name) => (Object.hasOwn(title.args, name) ? String(title.args[name]) : ARG_UNKNOWN));
}

/** @type {Readonly<Record<import('./protocol.js').ErrorCode, string>>} */
export const ERROR_TEXT = Object.freeze({
  'in-flight': '仍在处理',
  'actionId-reused': '动作编号已用于另一个请求',
  'actionId-missing': '请求缺少动作编号',
  'verb-not-allowed': '这一条现在不能这样操作',
  'ui-only': 'orchestrad 处于只读界面模式',
  'item-unknown': '没有这一条',
  'text-too-long': '提醒文字超过 120 个字',
  'brake-unavailable': '刹车不可用：保护名单还没确认',
  'not-test-root': '不是登记过的测试根',
  'procguard-timeout': '保护名单没改成，可重试',
  'plan-expired': '刹车计划已过期，请重新生成',
});

/** @type {Readonly<Record<import('./protocol.js').EndClass, string>>} */
export const END_TEXT = Object.freeze({
  acted: '已处理',
  'auto-cleared': '已自动清除',
  expired: '已过期',
});

/** @type {Readonly<Record<string, string>>} */
export const OUTCOME_TEXT = Object.freeze({
  applied: '已生效',
  'noop:already-ended': '无需操作：已结束',
  unknown: '结果不明',
});

/** Every enum value has a text: the check the tests run, kept beside the tables it checks. @returns {string[]} */
export function missingTexts() {
  return [
    ...ERROR_CODES.filter((c) => !Object.hasOwn(ERROR_TEXT, c)).map((c) => `error:${c}`),
    ...END_CLASSES.filter((c) => !Object.hasOwn(END_TEXT, c)).map((c) => `end:${c}`),
    ...ACTION_OUTCOMES.filter((c) => !Object.hasOwn(OUTCOME_TEXT, c)).map((c) => `outcome:${c}`),
  ];
}
