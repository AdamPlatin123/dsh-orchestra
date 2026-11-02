// @ts-check
// Chinese text the page and the toast share (plan §3): what a title arg shows when the source's string
// may not be shown, and the text of each error code, end class and action outcome. One symbol, one
// meaning (P1): codes that ask you for different things never share a text (test/shared/protocol.test.ts).
// Step 4 freezes the keys. TOWER_TEXT, at the end, holds the tower page's texts (orchestra app plan §5).
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
  'text-too-long': '文字太长',
  'brake-unavailable': '刹车不可用：保护名单还没确认',
  'not-test-root': '不是登记过的测试根',
  'procguard-timeout': '保护名单没改成，可重试',
  'plan-expired': '刹车计划已过期，请重新生成',
  'not-unlocked': '还没解锁操控',
  'owned-disabled': '现在不能新开或导入',
  'owned-limit': '会话数已满，先结束一个',
  'slash-command': '消息不能以 / 开头',
  'digest-mismatch': '要批的内容变了',
  'approval-gone': '这条审批已失效',
  'stale-view': '页面不是最新，请重看',
  'still-running': '上次的进程可能还在',
  'source-live': '原会话还开着，只能另开一份',
  'cwd-gone': '工作目录不在了',
  'cwd-forbidden': '不许在这个目录里跑',
  'unfinished-frame': '记录最后一段不完整',
  'source-changed': '原会话刚变了，请重看',
  'newer-format': '记录格式比这一版新',
  'reparse-point': '目录里有链接，不复制',
  'import-too-big': '太大，不能导入',
  'gateway-real-data': '用网关时不导入真实数据',
  'rename-busy': '文件被占用，稍后再试',
  'host-tampered': '会话程序被改过，不启动',
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
 * Every Chinese text of the tower page (orchestra app plan §5, tower panel research §1-§3). `{name}`
 * takes an argument from ui/view.js t(). The word for "done" never appears (T2): the furthest a subagent
 * gets is 已回报 (it sent its report back), which is no verdict (D19). A guessed state carries ≈ and its
 * basis says how it was guessed (T1); a rule checked against no real sample reads 没测过 (T4). The icons
 * are text too, so each glyph means one thing (P1): ✋ ？ ⇢ wait on you, ✕ failed, ● runs.
 * @type {Readonly<Record<string, string>>}
 */
export const TOWER_TEXT = frozen({
  'page.title': 'Orchestra · 塔',
  'page.titleWait': '({n}) Orchestra · 塔',
  'bar.brand': 'Orchestra',
  'bar.sub': '塔',
  'bar.test': '测试数据',
  'bar.counts': '计数也是筛选：点一下只看这一类，再点一下取消',
  'count.waiting': '等你 {n}',
  'count.error': '出错 {n}',
  'count.running': '在跑 {n}',
  'bar.sources': '来源',
  'src.ok': '{h}：{total} 个会话，全部显示',
  'src.clipped': '{h}：{total} 个会话，因上限只显示 {shown} 个',
  'src.empty': '{h}：没找到会话',
  'src.error': '{h}：读取出错（{code}）',
  'fresh.live': '{age}更新',
  'fresh.stale': '已 {n} 秒没拿到新数据',
  'fresh.none': '等第一次数据…',
  'bar.about': '关于数据',
  'bar.tower': '回到塔',
  'theme.auto': '主题：跟随系统',
  'theme.light': '主题：浅色',
  'theme.dark': '主题：深色',
  'pin.title': '等你',
  'pin.n': '{n} 件',
  'pin.order': '有期限的按剩余时间排在前面',
  'pin.you': '你',
  'sep.path': ' › ',
  'sep.notes': '；',
  'wait.approval': '等你批准',
  'wait.question': '等你回答',
  'wait.route': '等你选派给谁',
  'wait.inferred': '≈ 可能在等你',
  'wait.native': '{h} 原生 · 不计时',
  'wait.left': '剩 {t} 自动拒',
  'wait.overdue': '已到期，等 orchestrad 自动拒',
  'wait.goNative': '这里只读：请到 {h} 自己的界面里处理',
  'wait.goNativeGuess': '这里只读，而且只是推测：请到 {h} 自己的界面里看一眼',
  'tree.title': '塔',
  'tree.label': '你名下所有项目的会话树',
  'tree.changes': '↻ {n} 处变化',
  'tree.changesHint': '鼠标或焦点在树里时不重排，停手 5 秒后自动更新；点这里立即更新',
  'tree.empty': '还没有读到任何会话',
  'tree.emptyFilter': '眼下没有{f}的节点',
  'tree.filter': '只看{f}：{n} 个（上级只作路标，不算在内）',
  'tree.clear': '取消筛选',
  'tree.keys': '方向键上下选择，左右折叠或展开，空格就地展开，回车打开',
  'col.name': '名字',
  'col.act': '在做 / 在等什么',
  'col.kids': '子·错·等',
  'col.age': '上次动静',
  'col.own': '归属',
  'router.icon': '◆',
  'router.you': '你',
  'router.note': '只读阶段：只观察，不派活',
  'state.waiting': '等你',
  'state.error': '出错',
  'state.running': '在跑',
  'state.unknown': '状态未知',
  'state.returned': '已回报',
  'state.idle': '空闲',
  'icon.approval': '✋',
  'icon.question': '？',
  'icon.route': '⇢',
  'icon.error': '✕',
  'icon.running': '●',
  'icon.unknown': '◇',
  'icon.returned': '↩',
  'icon.idle': '◌',
  'mark.inferred': '≈',
  'mark.inferredSr': '（推测）',
  'basis.registry': '会话自己登记的',
  'basis.log': '从会话记录里读出来的（推测）',
  'basis.mtime': '按文件最后写入的时间推测',
  'basis.none': '没有依据，所以写未知',
  'source.orchestra': 'Orchestra 审批队列：到点自动拒',
  'source.native': '{h} 自己说的：原生界面不计时',
  'source.inferred': '推测：最后一个调用还没有结果',
  'own.observed': '只读',
  'own.owned': '自有',
  'own.foreign': '被占用',
  'own.observedLong': '只读观察：Orchestra 不驱动它',
  'own.ownedLong': 'Orchestra 自己开的会话',
  'own.foreignLong': '别人正在驱动它',
  'harness.claude': 'Claude',
  'harness.dsh': 'DSH',
  'harness.codex': 'Codex',
  'layer.agent': 'agent',
  'layer.sub': '分身 · 第 {d} 层',
  'kids.sr': '子节点 {c} 个，出错 {e}，等你 {w}',
  'kids.err': '{n}✕',
  'kids.wait': '{n}✋',
  'age.s': '{n} 秒',
  'age.m': '{n} 分',
  'age.h': '{n} 时',
  'age.d': '{n} 天',
  'ago.s': '{n} 秒前',
  'ago.m': '{n} 分钟前',
  'ago.h': '{n} 小时前',
  'ago.d': '{n} 天前',
  dash: '—',
  'group.returned': '已回报 ×{n}',
  'group.idle': '空闲 ×{n}',
  'group.same': '{label} ×{n}',
  'group.note': '折起来的同类行，展开后逐个显示',
  'project.n': '{n} 个节点',
  'peek.state': '状态：{s}；依据：{b}',
  'peek.type': '类型：{t}',
  'peek.session': '会话 {id}',
  'peek.act': '活动：{a}',
  'detail.empty': '选中塔里的一行，这里显示它的详情',
  'detail.back': '‹ 回到塔',
  'detail.state': '状态',
  'detail.basis': '依据',
  'detail.wait': '在等',
  'detail.waitSrc': '等你的来源',
  'detail.harness': '来自',
  'detail.owner': '归属',
  'detail.layer': '层级',
  'detail.type': '分身类型',
  'detail.kids': '子树',
  'detail.age': '上次动静',
  'detail.session': '会话',
  'detail.project': '项目',
  'detail.activity': '最近活动',
  'detail.noActivity': '没读到活动',
  'detail.events': '最近事件',
  'detail.noType': '没有记录',
  'detail.noSession': '这个节点没有会话文件',
  'detail.loading': '读取中…',
  'detail.noEvents': '没有可显示的事件',
  'detail.unparsed': '另有 {n} 行不是记录，没显示',
  'detail.err': '读取失败：{code}',
  'detail.gone': '这一行已不在最新数据里，显示的是它消失前的样子',
  'detail.full': '打开完整记录',
  'detail.lastN': '最后 {n} 条，新的在上',
  'detail.groupTitle': '折起来的 {n} 行',
  'detail.groupSub': '{label}：展开后逐个查看',
  'detail.projectSub': '项目 · {n} 个节点',
  'detail.counts': '在跑 {r} · 等你 {w} · 出错 {e}',
  'note.tail-only': '只读了文件末尾，更早的事件没显示',
  'note.too-large': '文件太大，没读全',
  'note.bad-frame': '有几行记录坏了，已跳过',
  'note.unfinished-frame': '最后一行记录还没写完，下次刷新再看',
  'dock.to': '发给 → {who}',
  'dock.none': '发给 → （先选中一行）',
  'dock.readonly': '这一版只读：发消息、审批和停止在下一阶段接上，而且只对 Orchestra 自己开的会话',
  'about.title': '关于数据',
  'about.sources': '来源',
  'about.colSrc': '来源',
  'about.colState': '状态',
  'about.colTotal': '会话总数',
  'about.colShown': '显示',
  'about.colClipped': '因上限没显示',
  'about.colRegistry': '在登记表里',
  'about.stateOk': '正常',
  'about.stateEmpty': '没找到会话',
  'about.stateError': '读取出错（{code}）',
  'about.noRegistry': '没有登记表',
  'about.clipped': '另有 {p} 个项目、{n} 个节点因上限没画出来',
  'about.noClip': '这次没有项目或节点因上限被裁掉',
  'about.rules': '判定规则',
  'about.rulesNote': '状态和关联是按这些规则从记录里读出来的。用上了不等于对：没在真实样本上核对过的，一律写没测过',
  'about.noRules': '这次快照没带规则清单',
  'about.honest': '诚实声明',
  'about.h1': '这一版只读：只观察你的会话，不驱动、不批准、不停止任何一个',
  'about.h2': '≈ 表示推测：状态是从会话记录或文件最后写入的时间推出来的，不是会话自己登记的',
  'about.h3': '已回报只表示分身把结果交回去了，不是验收通过；这里没有哪一行会被标成做好了',
  'about.h4': '计数等于列表：顶栏每个数字点开，就是同样多的行',
  'about.h5': '等你分三种来源：Orchestra 审批队列（有倒计时，到点自动拒）、原生（harness 自己说的，不计时）、推测（≈）。这一版只有后两种',
  'about.h6': '原生界面里的成功标记只表示回合正常结束，不是验收',
  'about.h7': '时间以 orchestrad 观测到的为准，页面不拿浏览器的时钟去减它',
  'rule.untested': '没测过（{n} 个样本）',
  'rule.mismatch': '记录格式和预期不一样，这部分可能读错',
  'rule.hits': '这次用上 {h} 次',
  'rule.unknown': '（没有说明）',
  'rule.claude.live.registry': '按会话自己登记的状态',
  'rule.claude.join.agentId': '按分身编号找派活记录',
  'rule.claude.join.description': '按任务描述找派活记录（推测）',
  'rule.claude.clone.running': '派出去还没回报，算在跑',
  'rule.claude.clone.orphan': '找到分身，没找到派它的记录',
  'rule.claude.stand.todo-keys': '读 Claude 的待办',
  'rule.dsh.stand.todo-keys': '读 DSH 的待办',
  'rule.dsh.stand.goal-keys': '读 DSH 的目标',
  'rule.dsh.team-task-keys': '读 DSH 队友的任务',
  'rule.dsh.child.parentSession': '按派它的会话找派活记录',
  'rule.dsh.live.mtime': '按记录最后改动的时间判断状态',
  'rule.instrument.tool-map': '按用过的工具分类',
  'rule.fermata.registry-waiting': '会话自己登记在等你',
  'rule.codex.meta.keys': '读 Codex 会话开头的编号、目录和开始时间',
  'rule.codex.live.turn': '按 Codex 回合开始和结束的记录判断状态',
  'rule.codex.waiting.unpaired': '最后一个调用没有结果，推测在等你（Codex 不记审批）',
  'rule.codex.child.parentThread': '按分身记下的上级会话找到它',
  'rule.codex.join.spawn': '按派活调用的结果找到分身',
  'rule.codex.join.activity': '按上级记下的分身动态判断进度',
  'rule.codex.stand.plan-keys': '读 Codex 的计划',
  'err.unpaired': '未配对：回首页输入控制台里的配对码',
  'err.network': '连不上 orchestrad，显示的是上一次的数据',
  'err.shape': '数据格式不对，没有显示：{why}',
  'err.http': '读取失败：{code}',
  'live.wait': '等你的事：{n} 件',
});
