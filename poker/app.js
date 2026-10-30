/* app.js — 界面与交互（移动端） v2
   - 位置标签（庄家/小盲/大盲/UTG/MP/CO）全程常显
   - 每手记录自动生成复盘 Markdown，可写入 notes/hands/ 并本地留存历史
*/
(function () {
  'use strict';
  const P = window.Poker;
  const $ = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));

  const LS_HIST = 'poker.history.v1';
  const LS_AUTO = 'poker.autosave.v1';
  const LS_STATE = 'poker.state.v1';
  const LS_THEME = 'poker.theme.v1';
  const APP_VER = 'v19 · 2026-10-29（翻后反制 + 紧手尊重 + 48 成就墙）';
  // 任意字符串本地化（用于导出文件等非 DOM 文本）
  const TR = (s) => (window.I18N && I18N.tr ? I18N.tr(s) : s);

  /* ---------- 浅色 / 深色主题 ---------- */
  function applyTheme(mode) {
    const light = mode === 'light';
    document.documentElement.classList.toggle('light', light);
    const btn = $('#btnTheme');
    if (btn) btn.textContent = light ? '深色' : '浅色';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', light ? '#f4f1e8' : '#0b1f16');
    // APK：让原生把状态栏/刘海区域也刷成主题色，避免浅色页面顶上一条黑块
    try {
      if (window.InsetBridge && window.InsetBridge.setColor) {
        window.InsetBridge.setColor(light ? '#ece8dc' : '#0b1f16', light);
      }
    } catch (e) {}
  }

  function initTheme() {
    let mode = null;
    try { mode = localStorage.getItem(LS_THEME); } catch (e) {}
    if (mode !== 'light' && mode !== 'dark') {
      mode = (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches)
        ? 'light' : 'dark';
    }
    applyTheme(mode);
  }

  $('#btnTheme').addEventListener('click', () => {
    const next = document.documentElement.classList.contains('light') ? 'dark' : 'light';
    try { localStorage.setItem(LS_THEME, next); } catch (e) {}
    applyTheme(next);
    showToast(next === 'light' ? '已切到浅色模式' : '已切到深色模式');
  });

  /* ---------- 盲注（手动设置） ---------- */
  const LS_BLINDS = 'poker.blinds.v1';
  const BLIND_TIERS = [[2, 5], [5, 10], [10, 20], [25, 50], [50, 100]];
  let blinds = { sb: 5, bb: 10 };
  let pendingBlinds = null;

  function updateBlindLabel() {
    const b = $('#btnBlinds');
    if (b) b.innerHTML = '盲注 <b>' + blinds.sb + '/' + blinds.bb + '</b>';
  }

  function loadBlinds() {
    try {
      const v = JSON.parse(localStorage.getItem(LS_BLINDS) || 'null');
      if (v && BLIND_TIERS.some((t) => t[0] === v.sb && t[1] === v.bb)) {
        blinds = { sb: v.sb, bb: v.bb };
      }
    } catch (e) {}
    P.setBlinds(blinds.sb, blinds.bb);
    updateBlindLabel();
  }

  function chooseBlinds(sb, bb) {
    blinds = { sb: sb, bb: bb };
    pendingBlinds = { sb: sb, bb: bb };
    try { localStorage.setItem(LS_BLINDS, JSON.stringify(blinds)); } catch (e) {}
    updateBlindLabel();
    hideOverlay();
    showToast('盲注已设为 ' + sb + '/' + bb + '，下一手生效');
  }

  function openBlinds() {
    const rows = BLIND_TIERS.map((t) => {
      const sb = t[0], bb = t[1];
      const depth = Math.round(P.START_STACK / bb);
      return '<button class="blindOpt' + (bb === blinds.bb ? ' active' : '') +
        '" data-sb="' + sb + '" data-bb="' + bb + '">' +
        '<b>' + sb + ' / ' + bb + '</b><span>起始筹码约 ' + depth + ' BB</span></button>';
    }).join('');
    showOverlay('盲注设置',
      '<div class="blindGrid">' + rows + '</div>' +
      '<div class="tip">只在你手动选择时生效：系统不会自动切换盲注，也不会反复提醒。</div>',
      [{ label: '关闭', cls: 'ghost', onClick: hideOverlay }]);
    qa('.blindOpt').forEach((el) => {
      el.addEventListener('click', () => chooseBlinds(Number(el.dataset.sb), Number(el.dataset.bb)));
    });
  }

  // 原生（Capacitor/Android）下改存手机本地；网页版仍写入 notes/hands/
  const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform &&
    window.Capacitor.isNativePlatform());
  const NATIVE_DIR = 'poker/hands';
  const capPlugin = (name) => (window.Capacitor && window.Capacitor.Plugins)
    ? window.Capacitor.Plugins[name] : null;

  // 原生端由 MainActivity 用 WindowInsets 统一让位系统栏，CSS 侧清零避免叠加
  if (IS_NATIVE) {
    document.documentElement.classList.add('native');
    const rs = document.documentElement.style;
    rs.setProperty('--safe-t', '0px');
    rs.setProperty('--safe-b', '0px');
    rs.setProperty('--safe-l', '0px');
    rs.setProperty('--safe-r', '0px');
  }

  /* ---------- 座位 DOM ---------- */
  const table = $('#table');
  const seatEls = [];
  for (let i = 0; i < P.NUM; i++) {
    const d = document.createElement('div');
    d.className = 'seat';
    d.dataset.i = String(i);
    d.innerHTML = '<div class="pos blank"></div><div class="cards"></div>' +
      '<div class="info"><span class="nm"></span><span class="st">0</span></div>' +
      '<div class="bet"></div><div class="act"></div>';
    table.appendChild(d);
    seatEls.push(d);
  }

  /* ---------- 操作栏状态 ---------- */
  // 操作栏常驻显示。controlsActive = 是否轮到人类（决定按钮可用/灰置）。
  const ctlEl = $('#controls');
  let controlsActive = false;

  function setControlsActive(canRaise) {
    controlsActive = true;
    ctlEl.classList.remove('idle');
    $('#btnFold').disabled = false;
    $('#btnCall').disabled = false;
    $('#btnRaise').disabled = !canRaise;
    $('#slider').disabled = false;
    qa('button.quick').forEach((b) => { b.disabled = false; });
  }
  function setControlsIdle(msg) {
    controlsActive = false;
    ctlEl.classList.add('idle');
    $('#ctlMsg').textContent = msg || '⏳ 等待其他玩家…';
    $('#raiseVal').textContent = '—';
    $('#btnFold').disabled = true;
    $('#btnCall').disabled = true;
    $('#btnRaise').disabled = true;
    $('#btnCall').textContent = '过牌';
    $('#btnRaise').textContent = '加注';
    $('#slider').disabled = true;
    const def = ['2.5BB', '3BB', '4BB', '全下'];
    qa('button.quick').forEach((b, i) => { b.disabled = true; b.textContent = def[i]; });
  }

  /* ---------- 工具 ---------- */
  const SUITS = ['♠', '♥', '♦', '♣'];
  const rankLabel = (r) => ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'][r - 2];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function cardEl(card, faceDown, big) {
    const d = document.createElement('div');
    d.className = 'card' + (big ? ' big' : '');
    if (faceDown || card == null) { d.classList.add('back'); return d; }
    const r = (card >> 2) + 2, s = card & 3;
    if (s === 1 || s === 2) d.classList.add('red');
    d.innerHTML = '<span>' + rankLabel(r) + '</span><span class="s">' + SUITS[s] + '</span>';
    return d;
  }
  function cardHTML(card) {
    if (card == null) return '';
    const r = (card >> 2) + 2, s = card & 3;
    return '<span class="card' + ((s === 1 || s === 2) ? ' red' : '') + '">' + rankLabel(r) + SUITS[s] + '</span>';
  }
  function showToast(txt, ms) {
    const old = document.querySelector('.toast');
    if (old) old.remove();
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = txt;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms || 2800);
  }
  const fmtDate = (d) => {
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };

  /* ---------- 成就系统：48 项，累计不随重开清零 ---------- */
  const LS_ACHV = 'poker.achv.v1';
  const ACHV_CATS = ['出场', '盈利', '清台', '倒霉蛋', '底池', '牌型', '摊牌', '全下', '坚持'];
  const todayStr = () => fmtDate(new Date());
  function blankAchv() {
    return {
      hands: 0, wins: 0, cleared: 0, busted: 0, maxPot: 0, bestNet: 0, biggestWin: 0,
      showdowns: 0, showdownWins: 0, sdStreak: 0, sdBestStreak: 0,
      winStreak: 0, bestWinStreak: 0, allinWins: 0, allinLosses: 0,
      types: {}, days: {}, unlocked: []
    };
  }
  let achv = blankAchv();
  try {
    const saved = JSON.parse(localStorage.getItem(LS_ACHV) || '{}');
    Object.assign(achv, saved);
    achv.types = saved.types || {};
    achv.days = saved.days || {};
    achv.unlocked = Array.isArray(saved.unlocked) ? saved.unlocked : [];
  } catch (e) {}
  function persistAchv() { try { localStorage.setItem(LS_ACHV, JSON.stringify(achv)); } catch (e) {} }

  const T = (a, k) => (a.types && a.types[k]) ? 1 : 0;
  const ACHV_DEFS = [
    /* 出场 5 */
    { id: 'seat', name: '初次落座', icon: '🪑', cat: '出场', desc: '打满 1 手牌', test: (a) => a.hands >= 1, prog: (a) => [a.hands, 1] },
    { id: 'regular', name: '常客', icon: '🎫', cat: '出场', desc: '累计 50 手', test: (a) => a.hands >= 50, prog: (a) => [a.hands, 50] },
    { id: 'veteran', name: '老手', icon: '🎖', cat: '出场', desc: '累计 200 手', test: (a) => a.hands >= 200, prog: (a) => [a.hands, 200] },
    { id: 'expert', name: '资深', icon: '🏅', cat: '出场', desc: '累计 1000 手', test: (a) => a.hands >= 1000, prog: (a) => [a.hands, 1000] },
    { id: 'grinder', name: '骨灰级', icon: '💎', cat: '出场', desc: '累计 5000 手', test: (a) => a.hands >= 5000, prog: (a) => [a.hands, 5000] },
    /* 盈利 5 */
    { id: 'firstwin', name: '开张', icon: '🌱', cat: '盈利', desc: '赢下第一手牌', test: (a) => a.wins >= 1, prog: (a) => [a.wins, 1] },
    { id: 'profit500', name: '手气正顺', icon: '📈', cat: '盈利', desc: '单周期盈利 500 分', test: (a) => a.bestNet >= 500, prog: (a) => [Math.max(0, a.bestNet), 500] },
    { id: 'profit2000', name: '大赚一笔', icon: '💰', cat: '盈利', desc: '单周期盈利 2000 分', test: (a) => a.bestNet >= 2000, prog: (a) => [Math.max(0, a.bestNet), 2000] },
    { id: 'profit5000', name: '暴富', icon: '🤑', cat: '盈利', desc: '单周期盈利 5000 分', test: (a) => a.bestNet >= 5000, prog: (a) => [Math.max(0, a.bestNet), 5000] },
    { id: 'profit10000', name: '封神', icon: '👑', cat: '盈利', desc: '单周期盈利 10000 分', test: (a) => a.bestNet >= 10000, prog: (a) => [Math.max(0, a.bestNet), 10000] },
    /* 清台 6 */
    { id: 'firstblood', name: '首杀', icon: '🗡', cat: '清台', desc: '第一次清台对手', test: (a) => a.cleared >= 1, prog: (a) => [a.cleared, 1] },
    { id: 'reaper', name: '收割机', icon: '🌾', cat: '清台', desc: '累计清台 5 次', test: (a) => a.cleared >= 5, prog: (a) => [a.cleared, 5] },
    { id: 'tenkill', name: '十连斩', icon: '⚔️', cat: '清台', desc: '累计清台 10 次', test: (a) => a.cleared >= 10, prog: (a) => [a.cleared, 10] },
    { id: 'butcher', name: '屠夫', icon: '🔪', cat: '清台', desc: '累计清台 25 次', test: (a) => a.cleared >= 25, prog: (a) => [a.cleared, 25] },
    { id: 'tableclear', name: '灭桌', icon: '💥', cat: '清台', desc: '累计清台 50 次', test: (a) => a.cleared >= 50, prog: (a) => [a.cleared, 50] },
    { id: 'myth', name: '桌上传奇', icon: '🏆', cat: '清台', desc: '累计清台 100 次', test: (a) => a.cleared >= 100, prog: (a) => [a.cleared, 100] },
    /* 倒霉蛋 5 */
    { id: 'bust1', name: '初次翻车', icon: '🩹', cat: '倒霉蛋', desc: '第一次被清台', test: (a) => a.busted >= 1, prog: (a) => [a.busted, 1] },
    { id: 'bust5', name: '倒霉蛋', icon: '💀', cat: '倒霉蛋', desc: '被清台 5 次', test: (a) => a.busted >= 5, prog: (a) => [a.busted, 5] },
    { id: 'bust10', name: '老倒霉', icon: '☠️', cat: '倒霉蛋', desc: '被清台 10 次', test: (a) => a.busted >= 10, prog: (a) => [a.busted, 10] },
    { id: 'bust25', name: '屡败屡战', icon: '🪖', cat: '倒霉蛋', desc: '被清台 25 次', test: (a) => a.busted >= 25, prog: (a) => [a.busted, 25] },
    { id: 'bust50', name: '钢铁韭菜', icon: '🥬', cat: '倒霉蛋', desc: '被清台 50 次', test: (a) => a.busted >= 50, prog: (a) => [a.busted, 50] },
    /* 底池 5 */
    { id: 'pot200', name: '小有斩获', icon: '🪙', cat: '底池', desc: '单池 200 分', test: (a) => a.maxPot >= 200, prog: (a) => [a.maxPot, 200] },
    { id: 'pot500', name: '大底池', icon: '💵', cat: '底池', desc: '单池 500 分', test: (a) => a.maxPot >= 500, prog: (a) => [a.maxPot, 500] },
    { id: 'pot1000', name: '巨池', icon: '🏦', cat: '底池', desc: '单池 1000 分', test: (a) => a.maxPot >= 1000, prog: (a) => [a.maxPot, 1000] },
    { id: 'pot2000', name: '超级巨池', icon: '🚀', cat: '底池', desc: '单池 2000 分', test: (a) => a.maxPot >= 2000, prog: (a) => [a.maxPot, 2000] },
    { id: 'pot5000', name: '世纪巨池', icon: '🌋', cat: '底池', desc: '单池 5000 分', test: (a) => a.maxPot >= 5000, prog: (a) => [a.maxPot, 5000] },
    /* 牌型 9 */
    { id: 'whigh', name: '高牌取胜', icon: '🃏', cat: '牌型', desc: '用高牌赢下一手', test: (a) => T(a, 'high') >= 1, prog: (a) => [T(a, 'high'), 1] },
    { id: 'wpair', name: '一对取胜', icon: '👯', cat: '牌型', desc: '用一对赢下一手', test: (a) => T(a, 'pair') >= 1, prog: (a) => [T(a, 'pair'), 1] },
    { id: 'wtwo', name: '两对取胜', icon: '✌️', cat: '牌型', desc: '用两对赢下一手', test: (a) => T(a, 'two') >= 1, prog: (a) => [T(a, 'two'), 1] },
    { id: 'wtrips', name: '三条取胜', icon: '🎯', cat: '牌型', desc: '用三条赢下一手', test: (a) => T(a, 'trips') >= 1, prog: (a) => [T(a, 'trips'), 1] },
    { id: 'wstraight', name: '顺子取胜', icon: '🪜', cat: '牌型', desc: '用顺子赢下一手', test: (a) => T(a, 'straight') >= 1, prog: (a) => [T(a, 'straight'), 1] },
    { id: 'wflush', name: '同花取胜', icon: '🌸', cat: '牌型', desc: '用同花赢下一手', test: (a) => T(a, 'flush') >= 1, prog: (a) => [T(a, 'flush'), 1] },
    { id: 'wfull', name: '葫芦取胜', icon: '🏠', cat: '牌型', desc: '用葫芦赢下一手', test: (a) => T(a, 'full') >= 1, prog: (a) => [T(a, 'full'), 1] },
    { id: 'wquads', name: '四条取胜', icon: '🧱', cat: '牌型', desc: '用四条赢下一手', test: (a) => T(a, 'quads') >= 1, prog: (a) => [T(a, 'quads'), 1] },
    { id: 'wsf', name: '同花顺取胜', icon: '🌈', cat: '牌型', desc: '用同花顺赢下一手', test: (a) => T(a, 'sf') >= 1, prog: (a) => [T(a, 'sf'), 1] },
    /* 摊牌 4 */
    { id: 'sd1', name: '首次摊牌', icon: '👀', cat: '摊牌', desc: '第一次走到摊牌', test: (a) => a.showdowns >= 1, prog: (a) => [a.showdowns, 1] },
    { id: 'sd50', name: '摊牌常客', icon: '🪞', cat: '摊牌', desc: '摊牌 50 次', test: (a) => a.showdowns >= 50, prog: (a) => [a.showdowns, 50] },
    { id: 'sdrate', name: '摊牌高手', icon: '🎓', cat: '摊牌', desc: '30 次摊牌后胜率 ≥55%', test: (a) => a.showdowns >= 30 && a.showdownWins / a.showdowns >= 0.55, prog: (a) => [Math.round(100 * a.showdownWins / Math.max(1, a.showdowns)), 55] },
    { id: 'sdstreak', name: '摊牌五连', icon: '🔥', cat: '摊牌', desc: '连续 5 次摊牌获胜', test: (a) => a.sdBestStreak >= 5, prog: (a) => [a.sdBestStreak, 5] },
    /* 全下 4 */
    { id: 'allin1', name: '首次全下获胜', icon: '💪', cat: '全下', desc: '全下并赢下', test: (a) => a.allinWins >= 1, prog: (a) => [a.allinWins, 1] },
    { id: 'allin10', name: '全下十胜', icon: '⚡', cat: '全下', desc: '全下获胜 10 次', test: (a) => a.allinWins >= 10, prog: (a) => [a.allinWins, 10] },
    { id: 'allin25', name: '全下廿五胜', icon: '🌩', cat: '全下', desc: '全下获胜 25 次', test: (a) => a.allinWins >= 25, prog: (a) => [a.allinWins, 25] },
    { id: 'allinloss', name: '全下十败', icon: '🕳', cat: '全下', desc: '全下被淘汰 10 次', test: (a) => a.allinLosses >= 10, prog: (a) => [a.allinLosses, 10] },
    /* 坚持 5 */
    { id: 'streak3', name: '三连胜', icon: '3️⃣', cat: '坚持', desc: '连续 3 手盈利', test: (a) => a.bestWinStreak >= 3, prog: (a) => [a.bestWinStreak, 3] },
    { id: 'streak5', name: '五连胜', icon: '5️⃣', cat: '坚持', desc: '连续 5 手盈利', test: (a) => a.bestWinStreak >= 5, prog: (a) => [a.bestWinStreak, 5] },
    { id: 'streak10', name: '十连胜', icon: '🔟', cat: '坚持', desc: '连续 10 手盈利', test: (a) => a.bestWinStreak >= 10, prog: (a) => [a.bestWinStreak, 10] },
    { id: 'daily100', name: '单日百手', icon: '📅', cat: '坚持', desc: '单日打满 100 手', test: (a) => (a.days[todayStr()] || 0) >= 100, prog: (a) => [(a.days[todayStr()] || 0), 100] },
    { id: 'days7', name: '七日到场', icon: '🗓', cat: '坚持', desc: '累计 7 天来打牌', test: (a) => Object.keys(a.days).length >= 7, prog: (a) => [Object.keys(a.days).length, 7] }
  ];
  function achvHas(id) { return achv.unlocked.indexOf(id) >= 0; }
  function achvCheck() {
    const newly = [];
    ACHV_DEFS.forEach((d) => {
      if (achvHas(d.id)) return;
      let ok = false;
      try { ok = !!d.test(achv); } catch (e) { ok = false; }
      if (ok) { achv.unlocked.push(d.id); newly.push(d); }
    });
    if (newly.length) persistAchv();
    return newly;
  }

  /* ---------- 历史存储 ---------- */
  let history = [];
  let autoSave = true;
  let lastHandBody = '';        // 结算面板正文，历史返回时恢复
  let handOverButtons = [];     // 结算面板按钮，供历史面板「返回」恢复
  try {
    history = JSON.parse(localStorage.getItem(LS_HIST) || '[]') || [];
    const a = localStorage.getItem(LS_AUTO);
    autoSave = (a === null) ? true : (a === '1');
  } catch (e) { history = []; }
  function persistHistory() {
    try { localStorage.setItem(LS_HIST, JSON.stringify(history.slice(0, 200))); } catch (e) {}
  }

  /* ---------- 刷新续局：存档 / 读档 ---------- */
  function saveState() {
    try { localStorage.setItem(LS_STATE, JSON.stringify(game.saveState())); } catch (e) {}
  }

  // 从历史记录的 Markdown 里解析出各家结束筹码与庄家（旧版记录无结构化字段时的回退）
  function parseHandMd(md) {
    const out = { players: [], buttonName: '' };
    const bm = md.match(/^- 庄家：(.+?)；/m);
    if (bm) out.buttonName = bm[1].trim();
    let inTable = false;
    for (const ln of md.split('\n')) {
      if (/^\|\s*位置\s*\|/.test(ln)) { inTable = true; continue; }
      if (!inTable) continue;
      if (!ln.startsWith('|')) break;
      const cols = ln.split('|').slice(1, -1).map((x) => x.trim());
      if (cols.length < 6 || cols[0].indexOf('---') >= 0) continue;
      const name = cols[1].replace(/（你）/g, '').trim();
      const stack = Number(cols[5]);
      if (name && Number.isFinite(stack)) out.players.push({ name: name, stack: stack });
    }
    return out;
  }

  // 回退路径：用最后一手历史记录（含各家结束筹码）恢复
  function resumeFromHistory() {
    if (!history.length || !history[0]) return false;
    const h = history[0];
    let stacks = Array.isArray(h.stacks) ? h.stacks.slice() : null;
    let names = Array.isArray(h.names) ? h.names.slice() : null;
    let buttonIdx = Number.isInteger(h.buttonIdx) ? h.buttonIdx : null;
    if (!stacks && h.md) {
      const p = parseHandMd(h.md);
      if (p.players.length === game.players.length) {
        stacks = p.players.map((x) => x.stack);
        names = p.players.map((x) => x.name);
        const bi = p.players.findIndex((x) => x.name === p.buttonName);
        buttonIdx = bi >= 0 ? bi : null;
      }
    }
    if (!stacks || stacks.length !== game.players.length) return false;
    game.players.forEach((p, i) => {
      if (names && names[i] && names[i] !== p.name) return;   // 名字对不上就不套用
      const n = Math.floor(Number(stacks[i]));
      p.stack = Number.isFinite(n) && n > 0 ? n : 0;
      p.hole = []; p.bet = 0; p.committed = 0; p.folded = false; p.allIn = false;
      p.acted = false; p.score = null; p.won = 0; p.lastAction = '';
      p.handName = ''; p.shown = true; p.active = p.stack > 0;
    });
    game.handNo = Number(h.no) || 0;
    game.button = (buttonIdx == null) ? -1 : buttonIdx;
    game.pot = 0; game.community = []; game.busy = false; game.turnId = -1;
    return game.handNo > 0;
  }

  // 优先用显式快照；否则回退到历史记录
  function restoreState() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(LS_STATE) || 'null'); } catch (e) { s = null; }
    if (s && Number(s.handNo) > 0 && game.loadState(s)) return 'state';
    return resumeFromHistory() ? 'history' : null;
  }

  /* ---------- 游戏实例 ---------- */
  const game = new P.PokerGame({
    render, log, awaitHuman,
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
    onHandEnd, onHandStart, onHandRecorded
  });
  game.players[0].human = true;

  /* ---------- 渲染 ---------- */
  function render() {
    const rb = $('#btnRebuy');
    if (rb) {
      const t = '＋' + game.currentBuyIn();
      if (rb.textContent !== t) rb.textContent = t;
    }
    $('#handNo').textContent = '第 ' + game.handNo + ' 手';
    $('#pot').textContent = '底池 ' + game.pot;

    const com = $('#community');
    com.innerHTML = '';
    game.community.forEach((c) => com.appendChild(cardEl(c, false, true)));

    game.players.forEach((p, i) => {
      const el = seatEls[i];
      const dealt = p.hole.length > 0;
      const posEl = el.querySelector('.pos');
      const pos = game.posLabels[p.id];
      posEl.textContent = pos || '';
      posEl.classList.toggle('blank', !pos);

      el.querySelector('.nm').textContent = p.name;
      el.querySelector('.st').textContent = p.stack;
      el.querySelector('.bet').textContent = p.bet > 0 ? '🪙 ' + p.bet : '';

      let act;
      if (p.shown) {
        act = p.won > 0 ? ('🏆 赢 +' + p.won) : (p.folded ? '弃牌' : (p.handName || ''));
      } else {
        act = p.lastAction || '';
      }
      el.querySelector('.act').textContent = act;

      const cd = el.querySelector('.cards');
      cd.innerHTML = '';
      if (dealt) p.hole.forEach((c) => cd.appendChild(cardEl(c, !(p.human || p.shown), false)));

      el.classList.toggle('out', !dealt);
      el.classList.toggle('folded', dealt && p.folded && !p.shown);
      el.classList.toggle('turn', game.turnId === p.id);
      el.classList.toggle('winner', p.shown && p.won > 0);
    });

    // 非人类回合：操作栏留在原地，只更新“等谁”的提示（高度不变）
    if (!controlsActive) {
      const t = game.turnId >= 0 ? game.players[game.turnId] : null;
      $('#ctlMsg').textContent = t
        ? (t.human ? '轮到你行动' : '⏳ 等待 ' + t.name + ' 行动…')
        : (game.busy ? '⏳ 进行中…' : '准备中…');
    }
  }

  function log(msg) {
    const el = $('#log');
    const line = document.createElement('div');
    line.textContent = msg;
    el.appendChild(line);
    while (el.children.length > 150) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }

  /* ---------- 覆盖层 ---------- */
  function showOverlay(title, bodyHTML, buttons) {
    $('#ovTitle').textContent = title;
    $('#ovBody').innerHTML = bodyHTML;
    const bar = $('#ovBtns');
    bar.innerHTML = '';
    (buttons || []).forEach((b) => {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      btn.className = b.cls || 'primary';
      if (b.countdown) {
        let armed = false, timer = null;
        btn.addEventListener('click', () => {
          if (armed) { b.onClick(); return; }
          if (timer) return;
          let left = b.countdown;
          btn.disabled = true;
          btn.textContent = b.label + '（' + left + 's）';
          timer = setInterval(() => {
            left--;
            if (left > 0) { btn.textContent = b.label + '（' + left + 's）'; return; }
            clearInterval(timer); timer = null; armed = true;
            btn.disabled = false;
            btn.textContent = '✔ 确认' + b.label;
          }, 1000);
        });
      } else {
        btn.addEventListener('click', b.onClick);
      }
      bar.appendChild(btn);
    });
    $('#overlay').classList.add('show');
  }
  const hideOverlay = () => $('#overlay').classList.remove('show');

  /* ---------- 人类回合 ---------- */
  let humCtx = null, settle = null;

  function awaitHuman(p, toCall, g) {
    return new Promise((resolve) => {
      settle = resolve;
      const maxTarget = p.bet + p.stack;
      const minTarget = toCall > 0
        ? Math.min(Math.max(g.currentBet + g.minRaise, p.bet + toCall), maxTarget)
        : Math.min(Math.max(P.limits.bb, g.minRaise), maxTarget);
      const slider = $('#slider');
      slider.min = minTarget; slider.max = maxTarget; slider.step = 5;
      let def = Math.round((g.currentBet + Math.max(0.6 * Math.max(g.pot, P.limits.bb), g.minRaise)) / 5) * 5;
      slider.value = Math.min(maxTarget, Math.max(minTarget, def));
      humCtx = { p, toCall, g, minTarget, maxTarget };

      const pos = g.posLabels[p.id] || '';
      $('#ctlMsg').textContent = (pos ? '【' + pos + '】' : '') + (toCall > 0
        ? '需跟注 ' + toCall + ' · 底池 ' + g.pot
        : '无人下注，可过牌或下注 · 底池 ' + g.pot);
      $('#btnCall').textContent = toCall > 0 ? '跟注 ' + toCall : '过牌';
      const canRaise = toCall > 0 ? (maxTarget > g.currentBet) : (maxTarget >= P.limits.bb);
      setControlsActive(canRaise);

      // 快捷按钮上下文自适应：翻牌前按 BB 倍数，翻牌后按底池比例
      const preflop = g.community.length === 0;
      const specs = preflop ? [2.5, 3, 4] : [0.5, 0.75, 1];
      qa('button.quick').forEach((b, i) => {
        if (i >= 3) { b.dataset.mode = 'max'; b.dataset.val = 'max'; b.textContent = '全下'; return; }
        b.dataset.mode = preflop ? 'bb' : 'pot';
        b.dataset.val = String(specs[i]);
        b.textContent = preflop ? (specs[i] + 'BB')
          : (specs[i] === 0.5 ? '½ 池' : specs[i] === 0.75 ? '¾ 池' : '1 池');
      });

      const sync = () => {
        const v = Number(slider.value);
        $('#raiseVal').textContent = v + ' 分';
        $('#btnRaise').textContent = canRaise
          ? ((toCall > 0 ? '加注到 ' : '下注 ') + v + (v >= maxTarget ? ' · 全下' : ''))
          : '无法加注';
      };
      slider.oninput = sync;
      sync();
    });
  }
  function finishHuman(dec) {
    if (!settle) return;
    const s = settle; settle = null; humCtx = null;
    setControlsIdle();
    s(dec);
  }

  /* ---------- 行动文本 ---------- */
  function reasonTag(r) {
    if (!r) return '';
    if (r.indexOf('人类决策') >= 0) return '人类决策';
    if (r.indexOf('弃牌') === 0) return '弃牌';
    if (r.indexOf('过牌') === 0) return '过牌';
    if (r.indexOf('跟注') === 0) return '跟注';
    if (r.indexOf('抓鸡') >= 0) return '抓鸡';
    if (r.indexOf('诈唬') >= 0) return '诈唬/半诈唬';
    if (r.indexOf('4bet') >= 0) return '4bet';
    if (r.indexOf('3bet') >= 0) return '3bet';
    if (r.indexOf('开池') >= 0) return '开池';
    if (r.indexOf('c-bet') >= 0) return 'c-bet';
    if (r.indexOf('价值') >= 0) return '价值';
    return '其他';
  }
  function actionLabel(a) {
    if (a.action === 'fold') return '弃牌';
    if (a.action === 'check') return '过牌';
    if (a.action === 'call') return '跟注 ' + a.amount;
    return (a.toCall > 0 ? '加注到 ' : '下注 ') + a.amount;
  }
  const POS_SLUG = { '庄家 D': 'btn', '小盲 SB': 'sb', '大盲 BB': 'bb', '枪口 UTG': 'utg', '中间 MP': 'mp', '后位 CO': 'co' };
  const posSlug = (pos) => POS_SLUG[pos] || 'pos';
  const cardsSlug = (hole) => (hole || []).join('').toLowerCase().replace(/[^a-z0-9]/g, '');

  /* ---------- 复盘 Markdown ---------- */
  function handToMarkdown(rec, dateStr) {
    const me = rec.players.find((x) => x.human) || rec.players[0];
    const L = [];
    L.push('# 手牌复盘 — ' + dateStr + ' 第 ' + rec.no + ' 手');
    L.push('');
    L.push('## 牌局描述');
    L.push('');
    L.push('- 形式：无限注德州（NLHE），' + rec.players.length + ' 人桌，盲注 ' + rec.blinds + '，起始买入 1000 分');
    L.push('- 庄家：' + rec.button + '；本手底池合计 **' + rec.potTotal + '** 分');
    L.push('- 公共牌：' + (rec.board.length ? rec.board.join(' ') : '（未发牌，翻牌前结束）'));
    L.push('');
    L.push('| 位置 | 玩家 | 起始筹码 | 手牌 | 结果 | 结束筹码 | 净输赢 | 风格 |');
    L.push('|---|---|---|---|---|---|---|---|');
    rec.players.forEach((p) => {
      const end = p.won > 0 ? ('收 +' + p.won + (p.handName ? ' · ' + p.handName : ''))
        : (p.folded ? '弃牌' : (p.handName || '—'));
      const net = p.stackEnd - p.stackStart;
      const netTxt = net > 0 ? '+' + net : (net < 0 ? '−' + Math.abs(net) : '0');
      L.push('| ' + p.pos + ' | ' + p.name + (p.human ? '（你）' : '') + ' | ' + p.stackStart +
        ' | ' + p.hole.join(' ') + ' | ' + end + ' | ' + p.stackEnd + ' | ' + netTxt + ' | ' + (p.style || '—') + ' |');
    });
    L.push('');
    L.push('### 行动序列');
    L.push('');
    const order = ['翻牌前', '翻牌', '转牌', '河牌'];
    const byStreet = {};
    rec.actions.forEach((a) => { (byStreet[a.street] = byStreet[a.street] || []).push(a); });
    order.forEach((s) => {
      if (!byStreet[s]) return;
      L.push('**' + s + '**');
      byStreet[s].forEach((a) => {
        L.push('- ' + (a.pos ? a.pos + ' ' : '') + a.name + '：' + actionLabel(a) +
          '（底池 ' + a.potBefore + '→' + a.potAfter + (a.toCall > 0 ? '，需跟 ' + a.toCall : '') + '）' +
          (a.reason ? ' — ' + a.reason : ''));
      });
      L.push('');
    });

    // 各方行动原因汇总（机器人带策略标注；人类标为「人类决策」）
    const agg = {};
    rec.actions.forEach((a) => {
      const tag = reasonTag(a.reason);
      if (!tag) return;
      const o = agg[a.name] = agg[a.name] || { style: a.style || '', tags: {} };
      o.tags[tag] = (o.tags[tag] || 0) + 1;
    });
    const aggNames = Object.keys(agg);
    if (aggNames.length) {
      L.push('### 各方行动原因');
      L.push('');
      L.push('| 玩家 | 风格 | 原因分布 |');
      L.push('|---|---|---|');
      aggNames.forEach((n) => {
        const o = agg[n];
        const dist = Object.keys(o.tags).sort((x, y) => o.tags[y] - o.tags[x])
          .map((t) => t + '×' + o.tags[t]).join('、');
        L.push('| ' + n + ' | ' + (o.style || '—') + ' | ' + dist + ' |');
      });
      L.push('');
    }

    // 对手画像（机器人据此调整 3bet/防守/诈唬频率）
    if (rec.profiles && Object.keys(rec.profiles).length) {
      L.push('### 对手画像（本手机器人据此调整）');
      L.push('');
      L.push('| 玩家 | 样本 | VPIP | PFR | 3bet 频率 | 翻牌 c-bet | 遇注弃牌 | 对 3bet 弃牌 |');
      L.push('|---|---|---|---|---|---|---|---|');
      Object.keys(rec.profiles).forEach((n) => {
        const o = rec.profiles[n];
        L.push('| ' + n + ' | ' + o.hands + ' 手 | ' + o.vpip + '% | ' + o.pfr + '% | ' +
          (o.threeBetFreq == null ? '—' : o.threeBetFreq + '%') + ' | ' +
          (o.cbetFreq == null ? '—' : o.cbetFreq + '%') + ' | ' +
          o.foldToBet + '% | ' + (o.foldTo3bet == null ? '—' : o.foldTo3bet + '%') + ' |');
      });
      L.push('');
    }

    const mine = rec.actions.filter((a) => a.human);
    L.push('## 决策点');
    if (!mine.length) {
      L.push('');
      L.push('（本手未参与行动。）');
    }
    mine.forEach((a, i) => {
      const odds = a.toCall > 0 ? a.toCall / (a.potBefore + a.toCall) : 0;
      L.push('');
      L.push('### 决策 ' + (i + 1) + ' · ' + a.street + ' · 位置 ' + (a.pos || '—'));
      L.push('- 底池 ' + a.potBefore + '，需跟注 ' + a.toCall);
      L.push('- 底池赔率：' + (a.toCall > 0
        ? (a.toCall + '/(' + a.potBefore + '+' + a.toCall + ') = ' + (odds * 100).toFixed(1) + '%')
        : '无（无人下注）'));
      L.push('- 你的行动：' + actionLabel(a));
      if (a.equity != null) {
        L.push('- 决策时权益（蒙特卡洛 4000 次，对手随机手 ×' + a.opp + '）：**' + (a.equity * 100).toFixed(1) + '%**');
      }
    });

    L.push('');
    L.push('## 数学分析');
    L.push('');
    if (mine.length) {
      L.push('| 决策 | 底池赔率 | 权益估算 | 权益−赔率 | 行动 |');
      L.push('|---|---|---|---|---|');
      mine.forEach((a, i) => {
        const odds = a.toCall > 0 ? (a.toCall / (a.potBefore + a.toCall) * 100).toFixed(1) + '%' : '—';
        const eq = a.equity != null ? (a.equity * 100).toFixed(1) + '%' : '—';
        const edge = (a.equity != null && a.toCall > 0)
          ? (((a.equity - a.toCall / (a.potBefore + a.toCall)) * 100).toFixed(1) + 'pp') : '—';
        L.push('| ' + (i + 1) + ' | ' + odds + ' | ' + eq + ' | ' + edge + ' | ' + actionLabel(a) + ' |');
      });
    } else {
      L.push('（无人类决策。）');
    }

    L.push('');
    L.push('## 结论');
    L.push('');
    const tips = [];
    mine.forEach((a, i) => {
      if (a.equity == null) return;
      if (a.toCall === 0) {
        if (a.action === 'fold') {
          tips.push('决策 ' + (i + 1) + '（' + a.street + '）：无人下注时弃牌，本可免费过牌看牌（当时权益 ' +
            (a.equity * 100).toFixed(1) + '%）。除极端情况外都应过牌。');
        }
        return;
      }
      const odds = a.toCall / (a.potBefore + a.toCall);
      const edge = a.equity - odds;
      if (a.action === 'fold' && edge > 0.15) {
        tips.push('决策 ' + (i + 1) + '（' + a.street + '）：弃牌时权益 ' + (a.equity * 100).toFixed(1) +
          '% 明显高于所需底池赔率 ' + (odds * 100).toFixed(1) + '%（+' + (edge * 100).toFixed(1) +
          'pp）。若对手范围偏宽，这里可能弃得偏紧。');
      }
      if (a.action === 'call' && edge < -0.05) {
        tips.push('决策 ' + (i + 1) + '（' + a.street + '）：跟注时权益 ' + (a.equity * 100).toFixed(1) +
          '% 低于底池赔率 ' + (odds * 100).toFixed(1) + '%（' + (edge * 100).toFixed(1) +
          'pp）。长期看该跟注为负 EV。');
      }
    });
    if (tips.length) { L.push(''); tips.forEach((t) => L.push('- ' + t)); }
    else { L.push('（自动检查未发现明显偏离。）'); }

    L.push('');
    L.push('## 可改进点');
    L.push('');
    L.push('（待复盘：对照上面的权益与底池赔率，判断每个决策点的方向是否正确；');
    L.push('并注意权益是按「对手随机手牌」估算的上限参考，真实对手范围更窄时你的权益会下降。）');
    L.push('');
    L.push('---');
    L.push('*数据来源：本机引擎蒙特卡洛估算（假设对手手牌随机，非其真实范围），4000 次采样，');
    L.push('采样误差约 ±1~2pp；底池赔率与筹码为精确值。*');
    L.push('');
    return L.map(TR).join('\n');
  }

  /* ---------- 保存：App 写手机本地，网页版写 notes/hands/ ---------- */
  async function saveNative(item) {
    const FS = capPlugin('Filesystem');
    if (!FS) throw new Error('Filesystem 插件不可用');
    const name = item.date + '-' + item.slug + '.md';
    try {
      await FS.writeFile({
        path: NATIVE_DIR + '/' + name,
        data: item.md,
        directory: 'DATA',
        encoding: 'utf8',
        recursive: true
      });
    } catch (e) {
      throw new Error('写入手机失败：' + (e && e.message ? e.message : e));
    }
    return { ok: true, path: 'notes/hands/' + name, native: true };
  }

  async function saveToServer(item) {
    if (IS_NATIVE) return saveNative(item);
    const res = await fetch('/api/hand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: item.md, slug: item.slug, date: item.date })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function shareHand(item) {
    const Share = capPlugin('Share');
    if (!Share) { showToast('当前环境不支持分享'); return; }
    try {
      await Share.share({
        title: '第 ' + item.no + ' 手复盘',
        text: item.md,
        dialogTitle: '导出复盘'
      });
    } catch (e) {
      if (!/cancel/i.test(String(e && e.message))) {
        showToast('分享失败：' + (e && e.message ? e.message : e));
      }
    }
  }

  /* ---------- 导出全部历史：合并成单个 .md 后走系统分享 ---------- */
  function buildExportMarkdown() {
    const now = new Date();
    const hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    const L = [];
    L.push('# PokerSim 对局记录导出');
    L.push('');
    L.push('- 导出时间：' + fmtDate(now) + ' ' + hm);
    L.push('- 手数：' + history.length + '（含尚未落盘的本地记录）');
    L.push('- 分隔标记：`<!-- hand:第 N 手 -->`，每手之间以 `---` 分隔，便于批量解析');
    L.push('');
    L.push('---');
    L.push('');
    // history 是「新→旧」，导出按时间正序，复盘顺手
    for (const h of history.slice().reverse()) {
      L.push('<!-- hand:第 ' + h.no + ' 手 · ' + h.date + ' -->');
      L.push('');
      L.push(String(h.md || '').trimEnd());
      L.push('');
      L.push('---');
      L.push('');
    }
    return L.map(TR).join('\n');
  }

  async function exportAllHands() {
    if (!history.length) { showToast('还没有可导出的记录'); return; }
    const md = buildExportMarkdown();
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
    const name = 'pokersim-hands-' + fmtDate(now).replace(/-/g, '') + '-' + hh + '.md';
    const FS = capPlugin('Filesystem');
    const Share = capPlugin('Share');

    if (IS_NATIVE && FS) {
      try {
        await FS.writeFile({
          path: name, data: md, directory: 'CACHE', encoding: 'utf8', recursive: true
        });
        const res = await FS.getUri({ path: name, directory: 'CACHE' });
        const uri = (res && (res.uri || res)) || '';
        log('📦 已生成导出文件 ' + name + '（' + history.length + ' 手，' + md.length + ' 字符）');
        if (Share && uri) {
          await Share.share({
            title: '扑克对局记录（' + history.length + ' 手）',
            files: [uri],
            dialogTitle: '导出全部记录'
          });
          showToast('已导出 ' + history.length + ' 手 → 选择接收方即可');
          return;
        }
        showToast('已写入应用缓存：' + name);
        return;
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        if (/cancel/i.test(msg)) return;
        log('⚠️ 文件导出失败（' + msg + '），尝试文本分享');
        if (Share) {
          try {
            await Share.share({
              title: '扑克对局记录（' + history.length + ' 手）',
              text: md,
              dialogTitle: '导出全部记录'
            });
            return;
          } catch (e2) {
            if (/cancel/i.test(String(e2 && e2.message))) return;
          }
        }
        showToast('导出失败：' + msg);
      }
      return;
    }

    // 网页版：直接下载文件
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    showToast('已下载 ' + name);
  }

  function onHandRecorded(rec) {
    const date = fmtDate(new Date(rec.time));
    const me = rec.players.find((x) => x.human) || rec.players[0];
    const item = {
      date: date,
      no: rec.no,
      slug: 'h' + String(rec.no).padStart(4, '0') + '-' + posSlug(me.pos) + '-' + (cardsSlug(me.hole) || 'na'),
      summary: (me.pos || '—') + ' · ' + me.hole.join(' ') + ' · ' + (me.won > 0 ? ('赢 +' + me.won) : (me.folded ? '弃牌' : '摊牌')),
      md: handToMarkdown(rec, date),
      savedPath: null,
      // 结构化字段：供「刷新续局」与历史面板使用
      stacks: rec.players.map((p) => p.stackEnd),
      names: rec.players.map((p) => p.name),
      buttonIdx: game.button
    };
    history.unshift(item);
    if (history.length > 200) history.length = 200;
    persistHistory();
    saveState();
    if (autoSave && me.hole.length === 2) {
      saveToServer(item).then((r) => {
        item.savedPath = r.path;
        persistHistory();
        log('💾 已存 ' + r.path);
      }).catch((e) => {
        log('⚠️ 存盘失败（' + e.message + '），已保存在浏览器本地');
      });
    }
  }

  /* ---------- 历史面板 ---------- */
  // backButtons：从结算面板进入时传入其按钮，用于「← 返回」回到结算面板
  function openHistory(backButtons) {
    const back = (backButtons && backButtons.length)
      ? backButtons
      : [{ label: '返回牌桌', cls: 'primary', onClick: hideOverlay }];

    const rows = history.map((h, i) =>
      '<div class="histRow" data-i="' + i + '">' +
      '<div class="histHead">' +
      '<span class="hn">第 ' + h.no + ' 手</span>' +
      '<span class="hc">' + esc(h.summary) + '</span>' +
      '<button class="ghost" data-act="view">查看</button>' +
      '<button class="ghost" data-act="save">' + (h.savedPath ? '已存 ✓' : '存盘') + '</button>' +
      (IS_NATIVE ? '<button class="ghost" data-act="share">分享</button>' : '') +
      '</div>' +
      '<div class="histPre" style="display:none"></div>' +
      (h.savedPath ? '<div class="badge on" style="margin-top:6px">📄 notes/' + esc(h.savedPath.replace(/^notes\//, '')) + '</div>' : '') +
      '</div>').join('');

    const body = '<div class="toolbar">' +
      '<button class="ghost" id="hAuto">自动存盘：' + (autoSave ? '开' : '关') + '</button>' +
      '<button class="ghost" id="hSaveAll">' + (IS_NATIVE ? '全部存到手机' : '全部存入 notes/') + '</button>' +
      '<button class="ghost" id="hExport">⬇ 导出全部</button>' +
      '<button class="ghost danger" id="hClear">清空本地历史</button>' +
      '<span class="spacer"></span>' +
      '</div>' +
      (history.length ? rows : '<div class="tip">还没有手牌记录。打完一手后会自动出现在这里。</div>');

    showOverlay('牌局历史（' + history.length + ' 手）', body, back);
    const bodyEl = $('#ovBody');

    // 「← 返回」：有结算面板则回结算面板，否则回牌桌
    const backBar = document.createElement('div');
    backBar.className = 'toolbar';
    backBar.innerHTML = '<button class="ghost" id="hClose">← 返回</button>';
    bodyEl.parentNode.insertBefore(backBar, bodyEl);
    bodyEl.parentNode.querySelector('#hClose').addEventListener('click', () => {
      if (handOverButtons.length) showOverlay('本手结束 · 全部手牌', lastHandBody, handOverButtons);
      else hideOverlay();
    });
    bodyEl.querySelectorAll('.histRow').forEach((row) => {
      const item = history[Number(row.dataset.i)];
      const pre = row.querySelector('.histPre');
      row.querySelector('[data-act="view"]').addEventListener('click', () => {
        if (pre.style.display === 'none') { pre.textContent = item.md; pre.style.display = 'block'; }
        else { pre.style.display = 'none'; }
      });
      row.querySelector('[data-act="save"]').addEventListener('click', () => {
        saveToServer(item).then((r) => {
          item.savedPath = r.path; persistHistory();
          showToast('已存 ' + r.path);
          openHistory(backButtons);
        }).catch((e) => showToast('存盘失败：' + e.message));
      });
      const shareBtn = row.querySelector('[data-act="share"]');
      if (shareBtn) shareBtn.addEventListener('click', () => shareHand(item));
      pre.addEventListener('dblclick', () => {
        navigator.clipboard && navigator.clipboard.writeText(item.md);
        showToast('Markdown 已复制到剪贴板');
      });
    });
    const a = bodyEl.querySelector('#hAuto');
    if (a) a.addEventListener('click', () => {
      autoSave = !autoSave;
      try { localStorage.setItem(LS_AUTO, autoSave ? '1' : '0'); } catch (e) {}
      a.textContent = '自动存盘：' + (autoSave ? '开' : '关');
      showToast('自动存盘已' + (autoSave ? '开启' : '关闭'));
    });
    const ex = bodyEl.querySelector('#hExport');
    if (ex) ex.addEventListener('click', () => { exportAllHands(); });
    const sa = bodyEl.querySelector('#hSaveAll');
    if (sa) sa.addEventListener('click', async () => {
      let n = 0, failn = 0;
      for (const h of history) {
        try { const r = await saveToServer(h); h.savedPath = r.path; n++; }
        catch (e) { failn++; }
      }
      persistHistory();
      showToast('已存 ' + n + ' 手' + (failn ? '，失败 ' + failn : ''));
      openHistory(backButtons);
    });
    const cl = bodyEl.querySelector('#hClear');
    if (cl) cl.addEventListener('click', () => {
      if (!window.confirm('清空浏览器本地历史？（已存入 notes/ 的文件不受影响）')) return;
      history = []; persistHistory(); openHistory(backButtons);
    });
  }

  /* ---------- 结算面板 ---------- */
  function onHandStart() { hideOverlay(); }

  function onHandEnd(results) {
    setControlsIdle('本手结束，看下方结果');
    const me = game.players[0];
    const myStart = (game.stackStart[0] == null) ? me.stack : game.stackStart[0];
    const myNet = me.stack - myStart;
    const sess = game.sessionNet || 0;
    const fmtNet = (v) => (v > 0 ? '+' + v : (v < 0 ? '−' + Math.abs(v) : '0'));
    const clsNet = (v) => (v > 0 ? 'plus' : (v < 0 ? 'minus' : 'zero'));
    // ---- 成就统计（48 项，累计不随重开清零） ----
    if (game.handNo === 1) achv.maxPot = 0;   // 新一轮（清零重开）重置本轮底池记录
    const heroBusted = me.stack <= 0;
    const botBusted = game.players.filter((p) => !p.human && p.stack <= 0).length;
    const wonChips = myNet > 0;
    const rec = game.history[game.history.length - 1] || { players: [], board: [] };
    const heroRec = rec.players[0] || {};
    const handName = heroRec.handName || '';
    let newly = [];
    try {
      achv.hands++;
      if (wonChips) {
        achv.wins++;
        achv.winStreak++;
        if (achv.winStreak > achv.bestWinStreak) achv.bestWinStreak = achv.winStreak;
      } else {
        achv.winStreak = 0;
      }
      if (myNet > achv.biggestWin) achv.biggestWin = myNet;
      if (heroBusted) achv.busted++;
      if (botBusted > 0 && wonChips) achv.cleared += botBusted;
      if (game.lastPot > achv.maxPot) achv.maxPot = game.lastPot;
      if (sess > achv.bestNet) achv.bestNet = sess;
      // 摊牌与牌型
      const reachedSD = (rec.board || []).length === 5 && !heroRec.folded;
      if (reachedSD) {
        achv.showdowns++;
        if (wonChips) {
          achv.showdownWins++;
          achv.sdStreak++;
          if (achv.sdStreak > achv.sdBestStreak) achv.sdBestStreak = achv.sdStreak;
          if (handName) {
            const t = achv.types;
            if (handName.indexOf('皇家同花顺') >= 0) t.royal = 1;
            else if (handName.indexOf('同花顺') >= 0) t.sf = 1;
            else if (handName.indexOf('四条') >= 0) t.quads = 1;
            else if (handName.indexOf('葫芦') >= 0) t.full = 1;
            else if (handName.indexOf('同花') >= 0) t.flush = 1;
            else if (handName.indexOf('顺子') >= 0) t.straight = 1;
            else if (handName.indexOf('三条') >= 0) t.trips = 1;
            else if (handName.indexOf('两对') >= 0) t.two = 1;
            else if (handName.indexOf('一对') >= 0) t.pair = 1;
            else if (handName.indexOf('高牌') >= 0) t.high = 1;
          }
        } else {
          achv.sdStreak = 0;
        }
      }
      if (heroRec.allIn) { if (wonChips) achv.allinWins++; else achv.allinLosses++; }
      const dk = todayStr();
      achv.days[dk] = (achv.days[dk] || 0) + 1;
      persistAchv();
      newly = achvCheck();
      newly.forEach((d) => showToast('🏅 解锁「' + d.name + '」 ' + d.desc, 3800));
    } catch (e) {
      console.warn('[achv] 成就统计失败，不影响结算', e);
    }
    // 成就提示压缩成一行（电视上一屏放得下，细节在成就墙看）
    const achvHTML = newly.length
      ? '<div class="achvLine">🏅 新成就 ' + newly.length + ' 项：' +
        newly.slice(0, 4).map((d) => d.name).join('、') +
        (newly.length > 4 ? ' 等' : '') + '</div>'
      : '';
    const bustHTML = heroBusted
      ? '<div class="bustAlert"><b>⚠️ 又输光了</b><br>' +
        '这是模拟积分，不是真钱。现实里赌博十赌九输、久赌必输——别拿生活费、别借钱去赌。<br>' +
        '建议先停一停：今天到此为止，也是一种赢。</div>'
      : '';
    let inner = bustHTML + achvHTML +
      '<div class="sessionNet ' + clsNet(sess) + '">您此周期内总输赢 <span>' + fmtNet(sess) + '</span> 分</div>' +
      '<div class="sub">本手底池 ' + game.lastPot + ' 分 · 本手净 <b class="' + clsNet(myNet) + '">' + fmtNet(myNet) + '</b></div>' +
      '<div class="boardRow">' +
      (game.community.length ? game.community.map(cardHTML).join('') : '<span class="rh">未进入翻牌</span>') +
      '</div>';
    game.players.forEach((p) => {
      const dealt = p.hole.length > 0;
      const cards = dealt ? p.hole.map(cardHTML).join('') : '<span class="rh">未参与</span>';
      const hn = p.handName ? p.handName : (p.folded ? '已弃牌' : (dealt ? '—' : ''));
      const start = (game.stackStart[p.id] == null) ? p.stack : game.stackStart[p.id];
      const net = p.stack - start;
      const netTxt = net > 0 ? '+' + net : (net < 0 ? '−' + Math.abs(net) : '0');
      const netCls = net > 0 ? 'plus' : (net < 0 ? 'minus' : 'zero');
      inner += '<div class="res' + (net > 0 ? ' win' : '') + '">' +
        '<div class="rcards">' + cards + '</div>' +
        '<div class="rmeta"><div class="rname">' + (game.posLabels[p.id] || '') + ' ' + p.name + (p.human ? '（你）' : '') + '</div>' +
        '<div class="rh">' + (p.human ? '' : (p.styleName ? p.styleName + ' · ' : '')) + hn + ' · ' + start + ' → ' + p.stack + '</div></div>' +
        '<div class="rwin ' + netCls + '">' + netTxt + '</div></div>';
    });
    const html = '<div class="resWrap">' + inner + '</div>';
    const buttons = [];
    if (me.stack > 0) {
      buttons.push({ label: '下一手 ▶', cls: 'primary', onClick: () => { hideOverlay(); nextHand(); } });
      buttons.push({ label: '＋' + game.currentBuyIn(), cls: 'ghost', onClick: () => { hideOverlay(); game.rebuy(0); saveState(); nextHand(); } });
      buttons.push({ label: '清零重开', cls: 'ghost', countdown: 5, onClick: () => { hideOverlay(); game.reset(); saveState(); nextHand(); } });
    } else {
      buttons.push({ label: '再买入 ' + game.currentBuyIn() + ' 继续', cls: 'primary', onClick: () => { hideOverlay(); game.rebuy(0); saveState(); nextHand(); } });
      buttons.push({ label: '清零重开', cls: 'ghost', countdown: 5, onClick: () => { hideOverlay(); game.reset(); saveState(); nextHand(); } });
    }
    buttons.push({ label: '📜 历史', cls: 'ghost', onClick: () => openHistory(buttons) });
    lastHandBody = html;
    buttons.push({ label: '🌐 语言', cls: 'ghost', onClick: () => openLangPicker(() => showOverlay('本手结束 · 全部手牌', lastHandBody, handOverButtons)) });
    handOverButtons = buttons.slice();
    showOverlay('本手结束 · 全部手牌', html, buttons);
  }

  /* ---------- 电视模式：底池移入顶栏，避免与上方座位/动作文字重叠 ---------- */
  (function placePot() {
    const pot = $('#pot'), topbar = $('#topbar'), board = $('#board');
    if (!pot || !topbar || !board) return;
    const mq = window.matchMedia('(min-width: 1500px) and (min-height: 780px)');
    const apply = () => {
      if (mq.matches) {
        if (pot.parentNode !== topbar) {
          topbar.insertBefore(pot, topbar.querySelector('.spacer') || null);
          pot.classList.add('potTop');
        }
      } else if (pot.parentNode !== board) {
        board.insertBefore(pot, board.firstChild);
        pot.classList.remove('potTop');
      }
    };
    apply();
    if (mq.addEventListener) mq.addEventListener('change', apply);
  })();

  /* ---------- 成就墙（独立一页，不再占用顶部信息） ---------- */
  function openAchvWall(onBack) {
    const total = ACHV_DEFS.length;
    const got = ACHV_DEFS.filter((d) => achvHas(d.id)).length;
    let body = '<div class="achvSummary">已解锁 <b>' + got + '</b> / ' + total +
      ' <span>' + Math.round(100 * got / total) + '%</span></div>' +
      '<div class="achvTotal"><i style="width:' + Math.round(100 * got / total) + '%"></i></div>';
    ACHV_CATS.forEach((cat) => {
      const list = ACHV_DEFS.filter((d) => d.cat === cat);
      const done = list.filter((d) => achvHas(d.id)).length;
      body += '<div class="achvCat"><div class="achvCatTitle">' + cat +
        '<span>' + done + '/' + list.length + '</span></div><div class="achvGrid">';
      list.forEach((d) => {
        const ok = achvHas(d.id);
        let pr = [0, 1];
        try { pr = d.prog(achv) || [0, 1]; } catch (e) { pr = [0, 1]; }
        const pct = Math.max(0, Math.min(100, Math.round(100 * pr[0] / Math.max(1, pr[1]))));
        body += '<div class="achvCard' + (ok ? ' done' : '') + '">' +
          '<div class="achvIcon">' + (ok ? d.icon : '🔒') + '</div>' +
          '<div class="achvName">' + d.name + '</div>' +
          '<div class="achvDesc">' + d.desc + '</div>' +
          '<div class="achvMini"><i style="width:' + (ok ? 100 : pct) + '%"></i></div>' +
          '<div class="achvNum">' + (ok ? '已解锁' : pr[0] + ' / ' + pr[1]) + '</div></div>';
      });
      body += '</div></div>';
    });
    showOverlay('🏅 成就墙', body,
      [{ label: '返回', cls: 'primary', onClick: () => { if (onBack) onBack(); else hideOverlay(); } }]);
  }

  /* ---------- 流程 ---------- */
  function nextHand() {
    if (game.busy) return;
    if (pendingBlinds) {
      P.setBlinds(pendingBlinds.sb, pendingBlinds.bb);
      pendingBlinds = null;
    }
    game.startHand().catch((e) => { log('⚠️ ' + e.message); console.error(e); });
  }
  function startScreen(resumed) {
    const me = game.players[0];
    const styleLine = '· 对手风格：' + game.players.filter((p) => !p.human)
      .map((p) => '<b>' + p.name + '</b>（' + p.styleName + '）').join('、') + '<br>';
    const intro = '<div class="tip">' +
      '· 无限注德州，<b>6 人桌</b>（你在最下方）<br>' +
      '· 盲注 <b>小盲 5 / 大盲 10</b>，起始买入 <b>1000</b> 分<br>' +
      styleLine +
      '· 每个人头上常显<b>位置</b>（庄家/小盲/大盲/UTG/MP/CO）<br>' +
      '· 每手结束<b>所有人亮牌</b>（不影响对局中的弃牌）<br>' +
      '· 每手自动生成复盘并存入 <b>notes/hands/</b>，可随时在「历史」查看<br>' +
      '· 界面版本 <b>' + APP_VER + '</b></div>';
    let body = intro;
    const buttons = [];
    if (resumed) {
      body = '<div class="tip">📌 <b>已恢复上一局</b>：从第 <b>' + (game.handNo + 1) +
        '</b> 手继续（上次打完了第 ' + game.handNo + ' 手）<br>' +
        '你的筹码：<b>' + me.stack + '</b> 分<br>' +
        '各家筹码：' + game.players.map((p) => p.name + ' ' + p.stack).join(' · ') + '</div>' + intro;
      buttons.push({ label: '继续下一手 ▶', cls: 'primary', onClick: () => { hideOverlay(); nextHand(); } });
      buttons.push({ label: '重新开始（清零）', cls: 'ghost', countdown: 5, onClick: () => { hideOverlay(); game.reset(); saveState(); startScreen(false); } });
    } else {
      buttons.push({ label: '开始第一手 ▶', cls: 'primary', onClick: () => { hideOverlay(); nextHand(); } });
    }
    buttons.push({ label: '🏅 成就墙', cls: 'ghost', onClick: () => openAchvWall(() => startScreen(resumed)) });
    buttons.push({ label: '历史', cls: 'ghost', onClick: () => openHistory(null) });
    buttons.push({ label: '🌐 语言', cls: 'ghost', onClick: () => openLangPicker(() => startScreen(resumed)) });
    showOverlay(resumed ? '继续牌局' : '德州扑克 · 六人桌', body, buttons);
  }

  /* ---------- 控件绑定 ---------- */
  $('#btnFold').addEventListener('click', () => finishHuman({ action: 'fold' }));
  $('#btnCall').addEventListener('click', () => finishHuman(humCtx && humCtx.toCall > 0 ? { action: 'call' } : { action: 'check' }));
  $('#btnRaise').addEventListener('click', () => {
    if (humCtx) finishHuman({ action: 'raise', amount: Number($('#slider').value) });
  });
  qa('button.quick').forEach((b) => {
    b.addEventListener('click', () => {
      if (!humCtx) return;
      const { p, toCall, g, minTarget, maxTarget } = humCtx;
      const mode = b.dataset.mode;
      let target;
      if (mode === 'max') {
        target = maxTarget;
      } else if (mode === 'bb') {
        // 翻牌前：按当前下注额的 2.5x / 3x / 4x 加注
        target = Math.round(g.currentBet * Number(b.dataset.val) / 5) * 5;
      } else {
        // 翻牌后：底池的 1/2 / 3/4 / 1 倍
        const size = Math.round(Math.max(g.pot, P.limits.bb) * Number(b.dataset.val) / 5) * 5;
        target = (p.bet + toCall) + size;
      }
      target = Math.min(maxTarget, Math.max(minTarget, target));
      const slider = $('#slider');
      slider.value = target;
      if (typeof slider.oninput === 'function') slider.oninput();
    });
  });
  $('#btnRebuy').addEventListener('click', () => { if (!game.busy) { game.rebuy(0); saveState(); } });
  $('#btnBlinds').addEventListener('click', openBlinds);
  $('#btnHistory').addEventListener('click', () => openHistory(null));
  $('#btnAchv').addEventListener('click', () => openAchvWall(() => { startScreen(!!game.handNo); }));
  // 多语言切换
  const langBtn = $('#btnLang');   // 顶栏按钮已移除；语言入口保留在开始界面与结算面板
  function refreshLangBtn() {
    if (!window.I18N || !langBtn) return;
    const cur = I18N.LANGS.find((x) => x.code === I18N.lang) || { short: '中' };
    langBtn.textContent = cur.short;
  }
  // 语言选择：可从顶栏、开始界面、结算面板打开，并支持返回
  function openLangPicker(back) {
    if (!window.I18N) return;
    const btns = I18N.LANGS.map((l) => ({
      label: (l.code === I18N.lang ? '✓ ' : '') + l.name,
      cls: l.code === I18N.lang ? 'primary' : 'ghost',
      onClick: () => I18N.setLang(l.code)
    }));
    btns.push({ label: '返回', cls: 'ghost', onClick: () => { if (back) back(); else hideOverlay(); } });
    showOverlay('语言 / Language',
      '<div class="tip">选择界面语言，切换后页面会重新加载；牌局进度、成就与历史都会保留。</div>',
      btns);
  }
  if (langBtn) {
    langBtn.addEventListener('click', () => {
      if (!window.I18N) return;
      if (game.busy) { showToast('对局进行中，本手结束后再切换语言'); return; }
      openLangPicker(null);
    });
  }
  $('#btnEquity').addEventListener('click', () => {
    const me = game.players[0];
    if (me.hole.length !== 2) { showToast('现在没有手牌'); return; }
    const opp = Math.max(1, game.players.filter((p) => p.active && p.id !== 0).length || (P.NUM - 1));
    showToast('计算中…', 1200);
    setTimeout(() => {
      const eq = P.estimateEquity(me.hole, game.community, opp, 8000);
      const toCall = Math.max(0, game.currentBet - me.bet);
      const odds = toCall > 0 ? ((toCall / (game.pot + toCall) * 100).toFixed(1) + '%') : '无';
      showToast('权益 ≈ ' + (eq * 100).toFixed(1) + '%（vs ' + opp + ' 个随机手）· 需跟注赔率 ' + odds, 4000);
      log('📊 权益估算：' + (eq * 100).toFixed(1) + '%（vs ' + opp + ' 个随机手，8000 次蒙特卡洛）');
    }, 30);
  });

  /* ---------- Android 返回键：有弹层先关弹层，否则退出 ---------- */
  if (IS_NATIVE) {
    const App = capPlugin('App');
    if (App && App.addListener) {
      App.addListener('backButton', () => {
        if ($('#overlay').classList.contains('show')) { hideOverlay(); return; }
        App.exitApp();
      });
    }
  }

  /* ---------- 启动 ---------- */
  initTheme();
  loadBlinds();
  setControlsIdle('准备中…');
  const resumed = restoreState();
  render();
  log('界面版本 ' + APP_VER);
  if (resumed) {
    log('📌 已恢复上一局（来源：' + (resumed === 'state' ? '存档快照' : '历史记录') + '）：第 ' +
      game.handNo + ' 手结束时，你的筹码 ' + game.players[0].stack + ' 分');
  }
  log('每手结束会亮出所有人的手牌，并自动存一份复盘到' + (IS_NATIVE ? '手机本地。' : ' notes/hands/。'));
  if (history.length) log('本地已有 ' + history.length + ' 手历史，点右上角「历史」查看。');

  // 开机提示：仅 debug 构建显示（发行版/web 版不显示）
  if (window.POKER_BUILD && window.POKER_BUILD.debug) {
    showOverlay('使用提示',
      '<div class="noticeMain">仅供梅花小兄弟内部交流</div>' +
      '<div class="tip">本工具仅用于牌局复盘与学习，请勿用于任何形式的赌博。</div>',
      [{ label: '我已了解', cls: 'primary', onClick: () => { hideOverlay(); startScreen(!!resumed); } }]);
  } else {
    startScreen(!!resumed);
  }

  // 多语言初始化
  if (window.I18N) { I18N.init(); refreshLangBtn(); }
  // PWA：注册 Service Worker（离线可用；原生 App 内自动跳过）
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  // 自动化测试入口
  window.__poker = { game, nextHand, getBlinds: () => blinds, getPending: () => pendingBlinds,
    setBlinds: chooseBlinds, limits: P.limits };
})();
