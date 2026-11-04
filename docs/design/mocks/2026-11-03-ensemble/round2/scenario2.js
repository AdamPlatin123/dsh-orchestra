// 第二轮共用合成数据（2026-11-03）。完全虚构，不来自任何真实会话。读 window.R2。
// rich = 将来有总台、worker、subagent 时的样子；barren = 今天真实数据的形状（数字取自 docs/research/2026-11-02-tower-panel.md 的抽样）。
(function () {
  const exploreTasks = ['订单列表页入口', '现有下载按钮组件', '权限判断写在哪', '日期格式工具函数', 'i18n 文案位置', '表格列配置', '接口客户端封装', 'toast 组件用法', '路由守卫', '埋点约定', 'e2e 目录结构', '样式变量'];
  const explore = exploreTasks.map((t, i) => {
    const unknown = i >= 9;
    return {
      id: 'ex' + (i + 1), name: 'Explore #' + (i + 1), kind: 'Explore', confidence: unknown ? 'unknown' : 'real',
      state: unknown ? 'unknown' : 'reported',
      stateText: unknown ? '状态未知' : '已回报',
      dispatch: { task: '查：' + t, why: '改之前先知道现有写法在哪', returns: '文件路径和一句话结论', at: '14:03' },
      summary: unknown ? null : '找到 ' + (i % 3 + 1) + ' 处相关代码，已列路径',
      steps: unknown ? null : [
        { tool: 'Grep', arg: t.slice(0, 4), result: (i % 3 + 2) + ' 处命中' },
        { tool: 'Read', arg: 'src/orders/OrdersPage.tsx', result: '212 行' },
        { tool: '回报', arg: '回给 Aiko', result: '回合结束' }
      ],
      children: []
    };
  });

  const rich = {
    label: '设想的数据',
    router: {
      name: '总台', harness: 'Claude', model: 'claude-haiku-5-5', project: '全部项目',
      purity: { toolCalls: 0, lookups: 6, note: '今天 0 次动手操作，6 次查 Orchestra 自己的状态' },
      wish: { id: 'W12', title: 'shop-web 加订单 CSV 导出', verified: 3, total: 7, source: 'Mio 复核通过 2 条 + 你确认 1 条' },
      thread: [
        { t: '09:40', who: 'you', text: 'shop-web 加订单 CSV 导出，后端要流式，前端一个按钮。' },
        { t: '09:40', who: 'router', text: '我把它记成愿望 W12。这件事要先规划，我派给 Sora，写好后你确认，我再找人。' },
        { t: '09:40', who: 'receipt', dispatchId: 'd0' },
        { t: '09:43', who: 'report', from: 'Sora', text: 'W12 的验收 7 条和 Task 列表写好了，已列在愿望卡里，等你确认。', status: '回合结束' },
        { t: '09:43', who: 'you', text: '可以。' },
        { t: '09:44', who: 'receipt', dispatchId: 'd1' },
        { t: '09:44', who: 'receipt', dispatchId: 'd2' },
        { t: '09:45', who: 'receipt', dispatchId: 'd3' },
        { t: '13:48', who: 'report', from: 'Mio', text: 'Task 2 复核通过（W12 变成 3/7 已验证）。', status: '回合结束' },
        { t: '14:02', who: 'receipt', dispatchId: 'd4' },
        { t: '14:18', who: 'you', text: '现在进展到哪了？' },
        { t: '14:18', who: 'router', text: 'W12 是 3/7 已验证。Aiko 在跑 Task 4，Ren 在等 Aiko 回信，Mio 打回了 Task 3。有 4 件事等你，最急的还剩 6:10。', sources: ['Orchestra 账本', 'Aiko 状态', 'Ren 状态', 'Mio 复核记录'] },
        { t: '14:19', who: 'you', text: 'Ren 为什么没动？' },
        { t: '14:19', who: 'router', text: 'Ren 问 Aiko「CSV 列顺序按什么排？」，已等 12 分，消息还没读。Ren 同时请求派一个 Codex，那张卡在等你点。', sources: ['Ren → Aiko 消息', '等你 #1'] }
      ]
    },
    dispatches: [
      { id: 'd0', by: '总台', to: 'Sora', at: '09:40', task: '把 W12 写成验收条款和 Task 列表', why: '总台不做规划；规划者不接 Task，也不判定是否通过', returns: '验收条款和 Task 列表，交你确认', status: '已回报' },
      { id: 'd1', by: '总台', to: 'Aiko', at: '09:44', task: 'Task 1：导出入口设计', why: '前端归 Aiko', returns: '方案和改动清单', status: '已回报' },
      { id: 'd2', by: '总台', to: 'Ren', at: '09:44', task: 'Task 2：/orders/export 接口约定', why: '后端归 Ren', returns: '接口文档和测试', status: '复核通过（Mio）' },
      { id: 'd3', by: '总台', to: 'Mio', at: '09:45', task: '复核 W12 每一条 Task', why: '作者不能判自己', returns: '复核结论和证据', status: '在跑' },
      { id: 'd4', by: '总台', to: 'Aiko', at: '14:02', task: 'Task 4：导出按钮与下载', why: '依赖 Task 1 的入口方案', returns: 'diff、测试日志', status: '在跑' }
    ],
    workers: [
      {
        id: 'aiko', name: 'Aiko', harness: 'Claude', model: 'claude-sonnet-5-5', ownership: '自有', project: 'shop-web', role: '前端',
        state: 'running', stateText: '在跑', waitingOn: { kind: 'none', text: '不等谁' }, task: 'Task 4：导出按钮与下载', dispatchId: 'd4', since: '14:02', confidence: 'real',
        lastLine: '在写 ExportButton 的测试',
        thread: [
          { t: '14:02', who: 'dispatch', text: '收到派单：Task 4 导出按钮与下载' },
          { t: '14:03', who: 'worker', text: '先弄清现有写法，派 12 个 Explore。' },
          { t: '14:03', who: 'subgroup', groupId: 'g-explore' },
          { t: '14:09', who: 'worker', text: '入口放订单列表页右上。下面写测试。' },
          { t: '14:10', who: 'subgroup', groupId: 'g-test' },
          { t: '14:16', who: 'ask', text: '问你：CSV 日期用 ISO 8601 还是本地格式？', queueId: 'q3' }
        ],
        groups: [
          { id: 'g-explore', label: 'Explore ×12', elapsed: '6 分 12 秒', total: 12, breakdown: [['已回报', 9], ['状态未知', 3]], members: explore },
          {
            id: 'g-test', label: 'test-writer', elapsed: '10 分', total: 1, breakdown: [['在跑', 1]], members: [{
              id: 'tw', name: 'test-writer', kind: 'test-writer', state: 'running', stateText: '在跑', confidence: 'real',
              dispatch: { task: '给 ExportButton 写测试', why: '按钮要能在无网络时报错', returns: '测试文件和一次运行结果', at: '14:10' },
              summary: null,
              steps: [{ tool: 'Write', arg: 'ExportButton.test.tsx', result: '86 行' }, { tool: 'Bash', arg: 'pnpm test --run', result: '在跑' }],
              children: [{
                id: 'fx', name: 'fixture-gen', kind: 'fixture-gen', state: 'guess', stateText: '≈ 可能在跑', confidence: 'guess', guessBasis: '按文件 2 分钟前有写入推测',
                dispatch: { task: '造 3 份订单假数据', why: '测试要覆盖空列表和超长列表', returns: 'fixture 文件', at: '14:12' }, summary: null, steps: null, children: []
              }]
            }]
          }
        ]
      },
      {
        id: 'ren', name: 'Ren', harness: 'DSH', model: 'deepseek-v4-flash', ownership: '自有', project: 'api-core', role: '后端',
        state: 'waitingAgent', stateText: '等 Aiko 回信', waitingOn: { kind: 'agent', who: 'Aiko', text: '等 Aiko 回信「CSV 列顺序按什么排？」', minutes: 12, delivery: '在途（未读）' }, task: 'Task 6：流式导出实现', dispatchId: null, since: '13:20', confidence: 'real',
        lastLine: '接口约定已复核，实现等列顺序',
        thread: [
          { t: '13:20', who: 'worker', text: '接口约定已复核通过，开始实现。' },
          { t: '13:31', who: 'request', text: '请求派 Codex 写单元测试，你已派出：c-7', workerId: 'c7' },
          { t: '14:08', who: 'send', text: '问 Aiko：CSV 列顺序按什么排？（在途，未读）' },
          { t: '14:14', who: 'request', text: '请求派 Codex：给 /orders/export 写流式实现', queueId: 'q1' }
        ],
        groups: []
      },
      {
        id: 'c7', name: 'Codex c-7', parent: 'ren', harness: 'Codex', model: 'gpt-5.5', ownership: '自有', project: 'api-core', role: '测试',
        state: 'waitingYou', stateText: '等你批准', waitingOn: { kind: 'you', text: '等你批准 shell 命令', queueId: 'q2' }, task: '给 /orders/export 写单元测试', dispatchId: null, since: '13:31', confidence: 'real',
        lastLine: '想跑 pnpm vitest run api/export',
        thread: [
          { t: '13:31', who: 'dispatch', text: '应 Ren 请求由你派出' },
          { t: '13:50', who: 'subgroup', groupId: 'g-review' },
          { t: '14:12', who: 'ask', text: '想跑 pnpm vitest run api/export', queueId: 'q2' }
        ],
        groups: [{
          id: 'g-review', label: 'reviewer', elapsed: '8 分 40 秒', total: 1, breakdown: [['已回报', 1]], members: [{
            id: 'rv', name: 'reviewer', kind: 'reviewer', state: 'reported', stateText: '已回报', confidence: 'real',
            dispatch: { task: '看测试有没有漏掉空结果', why: '作者自己容易漏', returns: '问题列表', at: '13:50' },
            summary: '覆盖了空结果和超长结果；分页边界没有测到。', truncated: '已截断（原文 41 KB）', status: '回合结束',
            refs: ['diff：api/export.test.ts', '日志：vitest 第 3 次'], quote: { who: 'reviewer 自述', text: '基本没问题' },
            steps: [{ tool: 'Read', arg: 'api/export.test.ts', result: '140 行' }, { tool: 'Task', arg: '派 grep-helper', result: '状态未知' }, { tool: '回报', arg: '回给 c-7', result: '回合结束' }],
            children: [{ id: 'gh', name: 'grep-helper', kind: 'grep-helper', state: 'unknown', stateText: '状态未知', confidence: 'unknown', dispatch: { task: '找分页相关用例', why: '确认边界有没有测', returns: '用例名', at: '13:58' }, summary: null, steps: null, children: [] }]
          }]
        }]
      },
      {
        id: 'mio', name: 'Mio', harness: 'Claude', model: 'claude-sonnet-5-5', ownership: '自有', project: 'shop-web', role: 'QA',
        state: 'running', stateText: '在跑', waitingOn: { kind: 'none', text: '不等谁' }, task: '复核 W12 每一条 Task', dispatchId: 'd3', since: '09:45', confidence: 'real',
        lastLine: '刚判 Task 3 没通过，已打回 Aiko（打回 1/3）',
        verdict: { task: 'Task 3', result: '没通过', by: 'Mio', bounce: '1/3', evidence: 'e2e 第 7 次失败日志' },
        thread: [
          { t: '13:48', who: 'worker', text: 'Task 2 复核通过。' },
          { t: '14:11', who: 'worker', text: 'Task 3 没通过，已打回 Aiko（打回 1/3）。证据：e2e 第 7 次失败日志。' }
        ],
        groups: []
      },
      {
        id: 'sora', name: 'Sora', harness: 'Claude', model: 'claude-opus-5-5', ownership: '自有', project: 'shop-web', role: '规划',
        state: 'idle', stateText: '空闲', waitingOn: { kind: 'none', text: '不等谁' }, task: '维护 W12 的验收和 Task 列表', dispatchId: 'd0', since: '09:40', confidence: 'real',
        lastLine: '提议把 Task 5 拆成两条',
        thread: [
          { t: '09:40', who: 'dispatch', text: '收到派单：把 W12 写成验收条款和 Task 列表' },
          { t: '09:43', who: 'worker', text: '验收 7 条和 Task 列表写好了，交你确认。我只规划，不接 Task，也不判定是否通过。' },
          { t: '14:15', who: 'ask', text: '提议：Task 5 拆成两条（导出 / 邮件发送）', queueId: 'q4' }
        ],
        groups: []
      }
    ],
    observed: {
      kaito: {
        id: 'kaito', name: 'Kaito', harness: 'Codex', ownership: '只读', project: 'api-core', state: 'error', stateText: '出错', note: '你在 Codex CLI 里开的，只能看',
        sub: { name: 'rg 子代理', text: '死循环嫌疑：rg ×7 / 120 秒，内存 3.1 GB', since: '13:55', action: '去 Codex CLI 里处理；本机进程层面可以刹车（要键入确认）' }
      },
      others: { total: 21, projects: 4, breakdown: [['在跑', 2], ['≈ 可能在跑', 4], ['空闲', 9], ['状态未知', 6]] }
    },
    queue: [
      { id: 'q1', kind: 'dispatch', title: 'Ren 请求派 Codex：给 /orders/export 写流式实现', left: '6:10', leftSec: 370, path: ['你', '总台', 'Ren'], via: 'seat', claim: '自称来自 DSH 会话 ds-41a（未核实）', model: 'gpt-5.5（路由模型建议）', scope: 'api-core', verbs: ['派出', '拒绝'] },
      { id: 'q2', kind: 'approval', title: 'Codex c-7 想跑 pnpm vitest run api/export', left: '27:40', leftSec: 1660, path: ['你', '总台', 'Ren', 'c-7'], risk: '高风险', hold: true, verbs: ['按住批准', '拒绝'] },
      { id: 'q3', kind: 'question', title: 'Aiko 问你：CSV 日期用 ISO 8601 还是本地格式？', left: null, path: ['你', '总台', 'Aiko'], verbs: ['回答'] },
      { id: 'q4', kind: 'decision', title: 'Sora 提议：Task 5 拆成两条（导出 / 邮件发送）', left: null, path: ['你', '总台', 'Sora'], verbs: ['拍板', '不拆'] }
    ],
    away: {
      since: '12:58', reports: 11, reportsBreakdown: [['Explore 给 Aiko', 9], ['reviewer 给 c-7', 1], ['Mio 复核结论给总台', 1]],
      handoffs: 3, wishMove: 'W12：2/7 → 3/7 已验证', bounces: 1, errors: 1
    }
  };

  const subCounts = [16, 14, 12, 11, 9, 8, 7, 6, 5, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1, 0, 0, 0, 0, 0];
  const repoNames = ['shop-web', 'api-core', 'dsh-plugin', 'sparse-attn', 'blog', 'infra'];
  const sessions = subCounts.map((n, i) => ({
    id: 's' + (i + 1), name: '观察会话 ' + (i + 1), harness: 'Claude', ownership: '只读', project: repoNames[i % repoNames.length],
    inRegistry: i < 13,
    state: i < 3 ? 'running' : i === 3 ? 'guessWaiting' : i < 13 ? 'idle' : 'unknown',
    stateText: i < 3 ? '在跑' : i === 3 ? '≈ 可能在等你' : i < 13 ? '空闲' : '状态未知',
    subagents: n, subagentsLinked: i === 0 ? 2 : 0
  }));

  const barren = {
    label: '今天的真实形状',
    router: null,
    routerNote: '还没有总台。今天你的话直接派给一个会话。',
    workers: [
      { id: 'o1', name: 'Codex 会话 1', harness: 'Codex', model: 'gpt-5.5', ownership: '自有', project: 'api-core', state: 'waitingYou', stateText: '等你批准', waitingOn: { kind: 'you', text: '等你批准 shell 命令', queueId: 'b1' }, task: '你派的：修分页测试', since: '14:05', confidence: 'real', lastLine: '想跑 pnpm vitest', groups: [], thread: [{ t: '14:05', who: 'dispatch', text: '你派的：修分页测试' }] },
      { id: 'o2', name: 'Claude 会话 1', harness: 'Claude', model: 'claude-sonnet-5-5', ownership: '自有', project: 'shop-web', state: 'running', stateText: '在跑', waitingOn: { kind: 'none', text: '不等谁' }, task: '你派的：查订单页慢在哪', since: '14:11', confidence: 'real', lastLine: '状态来自 Orchestra 登记', groups: [], thread: [{ t: '14:11', who: 'dispatch', text: '你派的：查订单页慢在哪' }] }
    ],
    observedMain: { total: 24, inRegistry: 13, busy: 4, breakdown: [['在跑', 3], ['≈ 可能在等你', 1], ['空闲', 9], ['状态未知', 11]] },
    sessions,
    subagents: { total: 111, unknown: 109, linkedToDispatch: 2, maxPerSession: 16, depthMax: 1, clipped: 718 },
    dsh: { onDisk: 92, read: 0, text: '92 个，因上限未读入' },
    queue: [
      { id: 'b2', kind: 'dispatch', title: 'DSH 会话请求派 Codex：补分页用例', left: '8:30', leftSec: 510, path: ['你', 'DSH 会话'], via: 'seat', claim: '自称来自 DSH 会话（未核实）', scope: 'api-core', verbs: ['派出', '拒绝'] },
      { id: 'b1', kind: 'approval', title: 'Codex 会话 1 想跑 pnpm vitest', left: '24:12', leftSec: 1452, path: ['你', 'Codex 会话 1'], verbs: ['批准', '拒绝'] }
    ],
    outsideQueue: { title: '观察会话 4 ≈ 可能在等你', note: '只读，去它自己的界面处理' }
  };

  window.R2 = { meta: { synthetic: true, now: '14:20' }, rich, barren };
})();
