// 第二轮共用折叠卡。样式在 kit.css 的 .fold 一节。用法见 BRIEF.md 第 1.1 节。
// R2Fold.card({ id, title, kind, count, elapsed, members, open, flags }) 返回一段 HTML 字符串。flags 是 [{ tone: 'wait' | 'err', text }]，写在第二行末尾，用来标「等你」「出错」。
// R2Fold.fromGroup(group, { kind, open }) 把 scenario2.js 里的 group 转成上面的参数。
// R2Fold.fromSession(session) 把今天的真实形状里的一个观察会话转成上面的参数（抽样只给了数量，没给状态：能对上派活的画成「有记录」，其余画成状态未知）。
// 点击展开由页面自己接：监听 .fold 的 click，切 aria-expanded，并显示自己的详情区。
(function () {
  const MAX_DOTS = 16;
  const ORDER = ['err', 'wait', 'run', 'guess', 'done', 'known', 'unk'];
  const NAMES = { err: '出错', wait: '等你', run: '在跑', guess: '≈ 可能在跑', done: '已回报', known: '有记录', unk: '状态未知' };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function tone(m) {
    if (m.state === 'error') return 'err';
    if (m.state === 'waitingYou') return 'wait';
    if (m.state === 'running') return 'run';
    if (m.state === 'guess') return 'guess';
    if (m.state === 'reported') return 'done';
    if (m.state === 'known' || m.state === 'idle' || m.state === 'waitingAgent') return 'known';
    return 'unk';
  }

  // 一个成员一个点；超过 MAX_DOTS 改画分段条，宽度按人数比例，分项写进 title，保证计数仍等于列表长度。
  function marks(members) {
    const tones = members.map(tone).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    const tally = ORDER.map((k) => [k, tones.filter((t) => t === k).length]).filter((x) => x[1] > 0);
    const label = tally.map(([k, n]) => NAMES[k] + ' ' + n).join('，');
    if (members.length === 0) return { html: '', label: '' };
    if (members.length <= MAX_DOTS) {
      return { html: '<span class="fold-dots" role="img" aria-label="' + esc(label) + '" title="' + esc(label) + '">' + tones.map((t) => '<i class="fd fd-' + t + '"></i>').join('') + '</span>', label };
    }
    return { html: '<span class="fold-bar" role="img" aria-label="' + esc(label) + '" title="' + esc(label) + '">' + tally.map(([k, n]) => '<i class="fd-' + k + '" style="flex:' + n + '"></i>').join('') + '</span>', label };
  }

  function card(o) {
    const m = marks(o.members || []);
    const meta = [o.kind, o.count, o.elapsed == null ? '耗时未知' : o.elapsed].filter(Boolean).map((x) => '<span>' + esc(x) + '</span>').join('') +
      (o.flags || []).map((f) => '<span class="fold-flag fold-flag-' + esc(f.tone) + '">' + esc(f.text) + '</span>').join('');
    return '<button type="button" class="fold" aria-expanded="' + (o.open ? 'true' : 'false') + '"' + (o.id ? ' data-fold="' + esc(o.id) + '"' : '') + '>' +
      '<span class="fold-title">' + esc(o.title) + '</span>' +
      '<span class="fold-chev" aria-hidden="true"></span>' +
      '<span class="fold-meta">' + meta + '</span>' + m.html + '</button>';
  }

  function fromGroup(g, opts) {
    const o = opts || {};
    return { id: g.id, title: g.title || g.label, kind: o.kind || 'subagent', count: g.members.length + ' 个', elapsed: g.elapsed, members: g.members, open: o.open };
  }

  function fromSession(s) {
    return { id: s.id, title: s.name, kind: 'subagent', count: s.subagents + ' 个', elapsed: null, members: Array.from({ length: s.subagents }, (_, i) => ({ state: i < (s.subagentsLinked || 0) ? 'known' : 'unknown' })) };
  }

  window.R2Fold = { card, fromGroup, fromSession };
})();
