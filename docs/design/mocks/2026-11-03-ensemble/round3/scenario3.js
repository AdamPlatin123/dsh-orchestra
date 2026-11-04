// 第三轮在第二轮数据上加的部分（2026-11-03）。完全虚构，不来自任何真实会话。先加载 ../round2/scenario2.js，再加载本文件，读 window.R3。
// policy = 派活权限；team = 右侧的 team；live = 一次可以按步骤回放的派发，用来考验「折叠不藏事」。
(function () {
  const levels = [
    { id: 'ask', label: '派前问你', note: '每次派发都先给你看派单，你点「派出」才算数。' },
    { id: 'free', label: '直接派出', note: '你在时直接派，事后给你回执，你可以随时停。' },
    { id: 'away', label: '你不在也派', note: '你离开后也继续派。r4 的 D20（默认有人值守：你不在时不派新的执行 Task）现在不允许，这里画出来给你看要不要改。' }
  ];

  // 无论权限开到哪一档都不放开的事。
  const keeps = [
    '工具和命令的批准还是等你，权限只管「派出去」这一步',
    '只有你能开这个权限，bot 不能给自己或别人开',
    '来源不可信的请求不走权限，退回「派前问你」',
    '同时在跑的自有会话上限照旧，超过的排队，不丢',
    '派给谁、谁开的权限，每一次都留记录，和你亲手派的分开写'
  ];

  const member = (i, task) => ({
    id: 'wf' + i, name: 'edge-' + i, kind: 'edge-check', confidence: 'real', state: 'running', stateText: '在跑',
    dispatch: { task, why: 'CSV 边界情况不想漏', returns: '一句结论和复现步骤', at: '14:21' },
    summary: null, steps: [{ tool: 'Read', arg: 'src/orders/export.ts', result: '98 行' }], children: []
  });
  const edgeTasks = ['空订单列表', '10 万行订单', '含逗号和换行的商品名', '时区跨日', '导出中途断网', '无权限账号'];

  const live = {
    dispatch: { id: 'd5', by: 'Aiko', to: 'export-edge-cases', at: '14:21', task: '查 CSV 导出的 6 种边界情况', why: 'Task 4 交回前要知道哪里会坏', returns: '每种情况一句结论', status: '在跑', viaGrant: 'Aiko 的权限是「直接派出」，你 09:30 开的' },
    group: { id: 'g-edge', title: 'export-edge-cases', kind: 'Workflow', label: 'export-edge-cases', elapsed: '7 秒', members: edgeTasks.map((t, i) => member(i + 1, '查：' + t)) },
    // 按顺序回放。set 是成员状态，summary 是这一步回报的内容，elapsed 是这一步的耗时，queue 是这一步新冒到顶层的事。
    steps: [
      { at: '14:21', note: 'Aiko 派出 6 个，权限是直接派出，没有问你', elapsed: '7 秒', set: {} },
      { at: '14:22', note: '4 个已回报', elapsed: '48 秒', set: { wf1: 'reported', wf2: 'reported', wf3: 'reported', wf4: 'reported' }, summary: { wf1: '空列表导出只有表头，符合约定', wf2: '10 万行流式导出内存稳定', wf3: '含逗号和换行的名字转义正确', wf4: '跨日订单按下单时区写日期' } },
      {
        at: '14:23', note: 'edge-5 想跑命令，在等你批准', elapsed: '1 分 30 秒', set: { wf5: 'waitingYou' },
        queue: { id: 'q5', kind: 'approval', title: 'edge-5 想跑 pnpm vitest run export --offline', left: '29:50', leftSec: 1790, path: ['你', '总台', 'Aiko', 'export-edge-cases', 'edge-5'], risk: '高风险', hold: true, verbs: ['按住批准', '拒绝'] }
      },
      { at: '14:24', note: 'edge-6 出错了', elapsed: '2 分 10 秒', set: { wf6: 'error' }, error: { who: 'edge-6', path: ['你', '总台', 'Aiko', 'export-edge-cases', 'edge-6'], text: '读权限配置时报错：缺少 fixtures/roles.json' } }
    ]
  };

  // team：一组一起干活的 worker，r4 里最接近的是声部。成员是能收消息的 worker，不是 subagent。
  const team = {
    id: 't-w12', name: 'W12 小组', project: 'shop-web、api-core', wish: 'W12', note: '为愿望 W12 一起干活的 worker',
    memberIds: ['sora', 'aiko', 'ren', 'c7', 'mio']
  };

  const grants = [
    { id: 'router', who: '总台', level: 'free', at: '09:30', scope: 'shop-web、api-core' },
    { id: 'aiko', who: 'Aiko', level: 'free', at: '09:30', scope: 'shop-web' },
    { id: 'ren', who: 'Ren', level: 'ask', at: null, scope: 'api-core' },
    { id: 'c7', who: 'Codex c-7', level: 'ask', at: null, scope: 'api-core' },
    { id: 'mio', who: 'Mio', level: 'ask', at: null, scope: 'shop-web' },
    { id: 'sora', who: 'Sora', level: 'ask', at: null, scope: 'shop-web' }
  ];

  // 今天的真实形状：没有总台，自有 worker 也没有派别的会话的工具，权限开关还没有东西可管。
  const today = {
    policyNote: '今天没有 bot 能派活：没有总台，自有 worker 也没有派别的会话的工具。这个开关还没有东西可管。',
    ownedFold: '自有 worker 今天看不到 subagent：Claude 关了派 subagent 的工具，Codex 的事件还没接。',
    observedFold: '只读会话的折叠卡今天能给出数量和部分状态。名字退回 subagent 类型，耗时算不出，出错画不出。'
  };

  // 总台和 Aiko 09:30 起是「直接派出」，所以第二轮数据里之后它们的派发都是权限派的。
  window.R2.rich.workers[0].groups.forEach((g) => { g.viaGrant = 'Aiko 的权限是「直接派出」，你 09:30 开的'; });
  window.R2.rich.dispatches.forEach((d) => { if (d.by === '总台') d.viaGrant = '总台的权限是「直接派出」，你 09:30 开的'; });

  window.R3 = { levels, keeps, grants, team, live, today };
})();
