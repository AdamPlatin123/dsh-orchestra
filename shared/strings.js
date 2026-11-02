// @ts-check
// Chinese text the page and the toast share (plan §3), as far as step 3 needs it: what a title arg
// shows when the source's string may not be shown, and the text of each error code, end class and
// action outcome. One symbol, one meaning (P1): two codes that ask you for different things never
// share a text (test/shared/protocol.test.ts). Step 4 freezes the keys. STAGE_TEXT, at the end, holds
// the stage preview's texts (0.1 alpha design §5), which ui/view.js fills.
import { END_CLASSES, ERROR_CODES, ACTION_OUTCOMES, TITLE_ARG_NAMES } from './protocol.js';
import { frozen } from './frozen.js';

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

/**
 * Every Chinese text of the stage preview (0.1 alpha design §5–§7, a labelled M2 preview, r4:2051).
 * `{name}` takes an argument from ui/view.js fill(). The word for "done" never appears (T2): a todo the
 * agent checked off reads 自报已勾, a work item goes no further than 已回报, and the verdict is always
 * 无复核者（M0）, since only a reviewer who did not write the work, or you, can call it done (D19). A
 * rule checked against no real sample reads 未测（N=0）, never a pass (T4).
 * @type {Readonly<Record<string, string>>}
 */
export const STAGE_TEXT = frozen({
  'page.title': 'Stage · 舞台预览',
  'tab.stage': '舞台',
  'tab.plan': '分谱',
  'bar.lane': '项目',
  'bar.approx': '≈ 按名字归组（推测）',
  'bar.players': '成员 {a}/{b} 在演奏',
  'bar.items': '任务 {c}/{d} 已回报',
  'bar.sources': 'claude {c}、dsh {d} 个会话，codex 未接入',
  'bar.srcError': '{h} 读取出错：{code}',
  'bar.fresh': '观测于 {t}',
  'bar.stale': '数据截至 {t}',
  'bar.test': '[测试]',
  'bar.preview': 'M2 预览：只读',
  'theme.auto': '主题：跟随系统',
  'theme.light': '主题：日场',
  'theme.dark': '主题：夜场',
  'sec.claude': 'Claude',
  'sec.dsh': 'DSH',
  'sec.codex': 'Codex 未接入（M0 不读）',
  'stage.label': '舞台：每个演奏者是一个会话或子代理',
  podium: '你：需要你 {n}，收件箱未接入',
  'podium.label': '指挥台：跳到第一个在等你的成员',
  overflow: '+{n}',
  'legend.title': '乐器 = 风险类别',
  'legend.dispatch': '派活',
  'legend.report': '回报：压缩上下文',
  'instr.woodwind': '木管：只读',
  'instr.strings': '弦乐：写代码',
  'instr.percussion': '打击：跑命令',
  'instr.brass': '铜管：复核',
  'instr.unknown': '休止：没有工具调用',
  'live.busy': '在忙',
  'live.idle': '空闲',
  'live.waiting': '在等你',
  'live.running': '在跑',
  'live.returned': '已交回',
  'live.quiet': '安静',
  'live.unknown': '未知',
  'basis.registry': '登记表',
  'basis.inferred': '推断',
  'basis.none': '无依据',
  'look.solid': '在场',
  'look.translucent': '不活跃',
  'look.ghost': '疑似孤儿',
  'role.principal': '主奏',
  'role.clone': '分身',
  'role.teammate': '队友',
  'harness.claude': 'Claude',
  'harness.dsh': 'DSH',
  'stand.todo': '待办',
  'stand.task-brief': '派活',
  'stand.goal': '目标',
  'stand.team-task': '团队任务',
  'stand.none': '谱架空着',
  'stand.tail-miss': '不在读到的尾部',
  'stand.mismatch': '字段对不上',
  'todo.pending': '待做',
  'todo.in_progress': '在做',
  'todo.completed': '自报已勾',
  'todo.other': '状态不明',
  'player.title': '{label}，{role}，{instr}，{live}，谱架：{plate}',
  'player.waiting': '在等你：{w}',
  'plate.session': '会话 {id}',
  'desk.goal': '目标：{g}',
  'desk.noGoal': '未设目标',
  'desk.todo': '主奏自己的待办，自报 {x}/{y}',
  'desk.allChecked': '全部自报已勾',
  'desk.noTodo': '没有读到待办',
  'chip.sent': '已派 {n}',
  'chip.running': '在跑 {n}',
  'chip.reported': '已回报 {n}',
  'chip.reviewed': '已复核 {n}',
  'chip.label': '按状态筛选',
  'col.brief': '派活',
  'col.exec': '执行',
  'col.report': '回报',
  'col.verdict': '验收',
  'src.task': 'Task 派活',
  'src.todo': '待办',
  'src.team-task': '团队任务',
  'src.subagent-catalog': '子代理目录',
  'plan.crit': '验收标准：未声明',
  'plan.critNote': '派活原文，不是验收标准',
  'plan.verdict': '无复核者（M0）',
  'plan.noExec': '没有执行者',
  'plan.noBrief': '没有找到派活记录',
  'plan.dept': '部门：下派 {n}，深度 {d}',
  'plan.deep': '层级偏深',
  'plan.unlinked': '未关联（{n}）',
  'plan.unlinkedNote': '没找到派活记录或父会话的任务和分身',
  'plan.empty': '这个项目没有派出去的任务',
  'plan.emptyChip': '没有这类任务',
  'plan.emptyReviewed': '已复核 0：M0 没有复核者',
  'plan.noLanes': '还没有读到任何会话',
  'rep.reported': '已回报 {t}，{b}',
  'rep.noTime': '时间未知',
  'rep.working': '在跑',
  'rep.unknown': '未知',
  'rep.orphan': '疑似孤儿',
  'rep.self': '由主奏自己做',
  'flow.line': '局部上下文 {a} → 回流 {b}（压缩 {r}×）',
  'flow.half': '局部上下文 {a} → 回流 {b}',
  'flow.pending': '还在跑，没有回流',
  'flow.unknownSide': '未知',
  'flow.total': '分身读了 {a}，回流 {b}：主奏少读约 {c}（{n} 项有数据）',
  bytes: '{n} 字节',
  'join.agentId': '按 agentId 关联',
  'join.description': '按描述关联（推测）',
  'join.parentSession': '按父会话关联',
  'join.team-owner': '按团队负责人关联',
  'join.none': '未关联',
  'health.keys': '字段对不上（解析器是推测）：{ids}',
  'health.src': '{h} 读取出错：{code}',
  clipped: '另有 {n} 项没显示（超出上限）',
  'rules.title': '规则体检',
  'rule.untested': '未测（N={n}）',
  'rule.mismatch': '字段对不上',
  'rule.hits': '本次命中 {h}',
  'note.tail-only': '只读了文件末尾',
  'note.too-large': '文件太大，没读',
  'note.bad-frame': '有损坏的数据帧',
  'note.unfinished-frame': '最后一帧还没写完',
  'age.s': '{n} 秒前',
  'age.m': '{n} 分钟前',
  'age.h': '{n} 小时前',
  'dr.close': '关闭',
  'dr.peek': '打开完整 peek',
  'dr.who': '身份',
  'dr.session': '会话',
  'dr.live': '状态',
  'dr.look': '外观',
  'dr.instr': '乐器依据',
  'dr.instrLine': '近 {n} 次工具调用：读 {r}、写 {w}、命令 {s}',
  'dr.rule': '判定规则',
  'dr.brief': '派活原文',
  'dr.report': '回报',
  'dr.verdict': '验收',
  'dr.join': '关联',
  'dr.stand': '谱架',
  'dr.events': '最近事件',
  'dr.loading': '读取中…',
  'dr.noSession': '没有会话文件',
  'dr.noEvents': '没有可显示的事件',
  'dr.unparsed': '另有 {n} 行没解析',
  'dr.err': '读取失败：{code}',
  'dr.depth': '深度 {d}',
  'err.unpaired': '未配对：先回首页输入配对码',
  'err.network': '连不上 orchestrad，显示的是上一次的数据',
  'err.shape': '数据格式不对，没有显示',
  'err.http': '读取失败：{code}',
  'live.update': '舞台已更新：成员 {a}/{b} 在演奏，任务 {c}/{d} 已回报',
  'link.home': '回首页',
});
