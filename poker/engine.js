/*
 * engine.js — 德州扑克核心引擎（无 DOM 依赖，可在 node 中直接测试）
 * 规则：无限注德州（NLHE），6 人桌，小盲 5 / 大盲 10，起始买入 1000。
 * 牌表示：整数 0..51，rank = (c>>2)+2 (2..14)，suit = c&3 (0♠ 1♥ 2♦ 3♣)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.Poker = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const START_STACK = 1000, NUM = 6;
  const limits = { sb: 5, bb: 10 };
  let SB = limits.sb, BB = limits.bb;
  // 可控牌序（配对比较用）：setDeckSeed(n) 后每手洗牌可复现
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  let deckRnd = Math.random;
  function setDeckSeed(n) { deckRnd = (n === null || n === undefined) ? Math.random : mulberry32(n >>> 0); }
  function setBlinds(sb, bb) {
    if (!(sb > 0) || !(bb > 0) || bb < sb) return false;
    limits.sb = sb; limits.bb = bb; SB = sb; BB = bb;
    return true;
  }
  const BASE = 15, CATDIV = 759375; // 15^5
  const HAND_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

  // ---------- 牌力评估 ----------
  function enc(a) {
    let v = 0;
    for (let i = 0; i < 6; i++) v = v * BASE + (a[i] || 0);
    return v;
  }

  function score5(cs) {
    const ranks = [], suits = [];
    for (let i = 0; i < 5; i++) { ranks.push((cs[i] >> 2) + 2); suits.push(cs[i] & 3); }
    const flush = suits[0] === suits[1] && suits[1] === suits[2] && suits[2] === suits[3] && suits[3] === suits[4];
    const cnt = new Array(15).fill(0);
    for (let i = 0; i < 5; i++) cnt[ranks[i]]++;
    const groups = [];
    for (let r = 14; r >= 2; r--) if (cnt[r] > 0) groups.push([cnt[r], r]);
    groups.sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]));
    const uniq = groups.map(g => g[1]).sort((a, b) => b - a);
    let sHigh = 0;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) sHigh = uniq[0];
      else if (uniq[0] === 14 && uniq[1] === 5) sHigh = 5; // A2345
    }
    if (flush && sHigh) return enc([8, sHigh]);
    if (groups[0][0] === 4) return enc([7, groups[0][1], groups[1][1]]);
    if (groups[0][0] === 3 && groups[1][0] === 2) return enc([6, groups[0][1], groups[1][1]]);
    if (flush) return enc([5, uniq[0], uniq[1], uniq[2], uniq[3], uniq[4]]);
    if (sHigh) return enc([4, sHigh]);
    if (groups[0][0] === 3) return enc([3, groups[0][1], groups[1][1], groups[2][1]]);
    if (groups[0][0] === 2 && groups[1][0] === 2) return enc([2, groups[0][1], groups[1][1], groups[2][1]]);
    if (groups[0][0] === 2) return enc([1, groups[0][1], groups[1][1], groups[2][1], groups[3][1]]);
    return enc([0, uniq[0], uniq[1], uniq[2], uniq[3], uniq[4]]);
  }

  function score7(cs) {
    let best = -1; const n = cs.length;
    for (let i = 0; i < n - 4; i++)
      for (let j = i + 1; j < n - 3; j++)
        for (let k = j + 1; k < n - 2; k++)
          for (let l = k + 1; l < n - 1; l++)
            for (let m = l + 1; m < n; m++) {
              const v = score5([cs[i], cs[j], cs[k], cs[l], cs[m]]);
              if (v > best) best = v;
            }
    return best;
  }

  function handName(score) { return HAND_NAMES[Math.floor(score / CATDIV)] || '高牌'; }

  function cardStr(c) {
    const r = (c >> 2) + 2, s = c & 3;
    const R = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'][r - 2];
    const S = ['s', 'h', 'd', 'c'][s];
    return R + S;
  }

  // ---------- 蒙特卡洛权益 ----------
  // 假设：对手手牌完全随机；未被封锁的牌等概率出现。iterations 越大越准。
  function estimateEquity(hole, board, nOpp, iters) {
    const dead = new Set();
    for (const c of hole) dead.add(c);
    for (const c of board) dead.add(c);
    const deck = [];
    for (let c = 0; c < 52; c++) if (!dead.has(c)) deck.push(c);
    const need = (5 - board.length) + 2 * nOpp;
    let win = 0, tie = 0;
    for (let it = 0; it < iters; it++) {
      const d = deck.slice();
      for (let i = 0; i < need; i++) {
        const j = i + Math.floor(Math.random() * (d.length - i));
        const t = d[i]; d[i] = d[j]; d[j] = t;
      }
      let idx = 0;
      const full = board.slice();
      while (full.length < 5) full.push(d[idx++]);
      const my = score7(hole.concat(full));
      let best = -1;
      for (let o = 0; o < nOpp; o++) {
        const s = score7([d[idx++], d[idx++]].concat(full));
        if (s > best) best = s;
      }
      if (my > best) win++; else if (my === best) tie++;
    }
    return (win + tie * 0.5) / iters;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function round5(v) { return Math.round(v / 5) * 5; }

  // ---------- 翻前手牌评分与百分位（用于构建机器人范围）----------
  // 启发式评分（非 GTO 范围）：只用于给机器人一个位置化的开牌/反加范围。
  function preflopScore(hole) {
    const r1 = (hole[0] >> 2) + 2, r2 = (hole[1] >> 2) + 2;
    const suited = (hole[0] & 3) === (hole[1] & 3);
    const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
    const gap = hi - lo;
    let s = (hi - 2) * 2.2 + (lo - 2) * 1.1;
    if (hi === lo) s += 22;
    if (suited) s += 7;
    if (gap === 1) s += 5; else if (gap === 2) s += 3; else if (gap === 3) s += 1;
    if (gap > 4 && hi < 12) s -= 4;
    return s;
  }

  let PF_PCT = null;
  function preflopPercentile(hole) {
    if (!PF_PCT) {
      const rows = [];
      for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) rows.push([preflopScore([a, b]), a, b]);
      rows.sort((x, y) => x[0] - y[0]);
      PF_PCT = new Float64Array(52 * 52);
      const n = rows.length;
      for (let i = 0; i < n; i++) {
        // 百分位：分数越高（越强）百分位越接近 1.00；AA ≈ 1.00，72o ≈ 0
        const pct = (i + 1) / n;
        PF_PCT[rows[i][1] * 52 + rows[i][2]] = pct;
        PF_PCT[rows[i][2] * 52 + rows[i][1]] = pct;
      }
    }
    return PF_PCT[hole[0] * 52 + hole[1]] || 0;
  }

  // 各位置开牌门槛（最低百分位，可由 personality 微调）：
  // 翻前面对无人加注的底池时，达到门槛就加注开牌；否则跟/弃。
  const PF_OPEN = { '枪口 UTG': 0.83, '中间 MP': 0.76, '后位 CO': 0.68, '庄家 D': 0.56, '小盲 SB': 0.62, '大盲 BB': 0.48 };
  // 面对加注时，可继续的百分位门槛（反加或跟注）
  const PF_3BET = 0.92;
  const PF_CALL_VS_RAISE = { '枪口 UTG': 0.70, '中间 MP': 0.68, '后位 CO': 0.66, '庄家 D': 0.64, '小盲 SB': 0.72, '大盲 BB': 0.58 };

  // ---------- 位置分档范围表（GTO 取向，6-max）----------
  // 开池宽度：UTG 最紧，BTN 最宽；SB 用 steal 范围，BB 只做隔离/防守。
  const RANK_CHARS = '23456789TJQKA';
  function handClass(hole) {
    const r1 = (hole[0] >> 2) + 2, r2 = (hole[1] >> 2) + 2;
    const suited = (hole[0] & 3) === (hole[1] & 3);
    const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
    return RANK_CHARS[hi - 2] + RANK_CHARS[lo - 2] + (hi === lo ? '' : (suited ? 's' : 'o'));
  }
  function expandRange(tokens) {
    const out = new Set();
    for (const t of tokens) {
      let m;
      if ((m = t.match(/^([2-9TJQKA])\1\+$/))) {
        const i = RANK_CHARS.indexOf(m[1]);
        for (let k = i; k <= 12; k++) out.add(RANK_CHARS[k] + RANK_CHARS[k]);
      } else if ((m = t.match(/^([2-9TJQKA])([2-9TJQKA])([so])\+$/))) {
        const hi = RANK_CHARS.indexOf(m[1]), lo = RANK_CHARS.indexOf(m[2]);
        for (let k = lo; k < hi; k++) out.add(m[1] + RANK_CHARS[k] + m[3]);
      } else if (t.length === 2 || /^[2-9TJQKA]{2}[so]$/.test(t)) {
        out.add(t);
      }
    }
    return out;
  }
  // 开池范围（按位置分档）
  const PF_OPEN_RANGE = {
    '枪口 UTG': expandRange(['22+', 'A9s+', 'A5s', 'A4s', 'KTs+', 'QTs+', 'JTs', 'T9s', '98s', 'AJo+', 'KQo']),
    '中间 MP': expandRange(['22+', 'A7s+', 'A4s', 'A3s', 'A2s', 'K9s+', 'Q9s+', 'J9s+', 'T8s+', '97s+', '87s', '76s', 'ATo+', 'KJo+', 'QJo']),
    '后位 CO': expandRange(['22+', 'A2s+', 'K7s+', 'Q8s+', 'J8s+', 'T7s+', '96s+', '86s+', '75s+', '65s', 'A9o+', 'KTo+', 'QTo+', 'JTo']),
    '庄家 D': expandRange(['22+', 'A2s+', 'K2s+', 'Q4s+', 'J6s+', 'T6s+', '95s+', '85s+', '74s+', '64s+', '53s+', '43s', 'A2o+', 'K8o+', 'Q9o+', 'J9o+', 'T8o+', '98o', '87o']),
    '小盲 SB': expandRange(['22+', 'A2s+', 'K5s+', 'Q7s+', 'J8s+', 'T8s+', '97s+', '86s+', '75s', '65s', 'A7o+', 'K9o+', 'QTo+', 'JTo']),
    '大盲 BB': expandRange(['22+', 'A2s+', 'K6s+', 'Q7s+', 'J8s+', 'T8s+', '97s+', '87s', '76s', '65s', 'A8o+', 'KTo+', 'QTo+', 'JTo'])
  };
  const PF_WIDER = { '枪口 UTG': '中间 MP', '中间 MP': '后位 CO', '后位 CO': '庄家 D', '庄家 D': '庄家 D', '小盲 SB': '庄家 D', '大盲 BB': '庄家 D' };
  const PF_SPECULATIVE = expandRange(['A5s', 'A4s', 'A3s', 'A2s', 'K9s', 'Q9s', 'J9s', 'T9s', '98s', '87s', '76s', '65s', '54s', 'KTo', 'QTo', 'JTo', 'T9o']);
  // 3bet：极化范围（强 value + 少量诈唬）
  const PF_3BET_VALUE = expandRange(['QQ+', 'AKs', 'AKo', 'AQs']);
  const PF_3BET_BLUFF = expandRange(['A5s', 'A4s', 'A3s', 'A2s', 'KQs', 'KJs', 'QJs', 'JTs', 'T9s', '98s', '87s', '76s', '65s']);
  // 4bet：顶端 value + 极少量诈唬
  const PF_4BET_VALUE = expandRange(['QQ+', 'AKs', 'AKo']);
  const PF_4BET_BLUFF = expandRange(['A5s', 'A4s']);
  // 对手 VPIP 很高时（松/疯），3bet 价值范围加宽
  const PF_3BET_VALUE_WIDE = expandRange(['TT+', 'AQs+', 'AJs', 'KQs', 'AKo']);
  // 面对疯子（VPIP>60%）：价值 3bet 再宽一档，诈唬用更宽的同花/连张组合
  const PF_3BET_VALUE_MANIAC = expandRange(['99+', 'ATs+', 'KQs', 'KJs', 'QJs', 'AKo', 'AJo', 'KQo']);
  const PF_3BET_BLUFF_WIDE = expandRange(['A2s+', 'K8s+', 'Q9s+', 'J9s+', 'T8s+', '97s+', '86s+', '75s+', '65s', '54s', 'ATo+', 'KJo+', 'QJo', 'JTo']);
  const PF_DEFEND_WIDE = expandRange(['22+', 'A2s+', 'K2s+', 'Q4s+', 'J6s+', 'T6s+', '95s+', '85s+', '74s+', '64s+', '53s+', 'A2o+', 'K8o+', 'Q9o+', 'J9o+', 'T8o+', '98o', '87o']);
  // 对 3bet 的防守范围
  const PF_CALL_3BET = expandRange(['TT+', 'AQs+', 'AJs', 'ATs', 'KQs', 'KJs', 'QJs', 'JTs', 'T9s', '98s', '87s', '76s', 'AJo+', 'KQo', '99', '88']);
  // 面对单个加注时的防守范围（按位置分档；BB 赔率最好，防守最宽）
  const PF_DEFEND = {
    '枪口 UTG': expandRange(['TT+', 'AQs+', 'AJs', 'KQs', '99', '88']),
    '中间 MP': expandRange(['TT+', 'AQs+', 'AJs', 'ATs', 'KQs', 'KJs', '99', '88', '77']),
    '后位 CO': expandRange(['22+', 'A9s+', 'KTs+', 'QTs+', 'JTs', 'T9s', '98s', '87s', 'AJo+', 'KQo']),
    '庄家 D': expandRange(['22+', 'A7s+', 'K9s+', 'Q9s+', 'J9s+', 'T9s', '98s', '87s', '76s', 'AJo+', 'KQo', 'QJo']),
    '小盲 SB': expandRange(['22+', 'A7s+', 'K9s+', 'QTs+', 'JTs', 'T9s', '98s', '87s', '76s', 'AJo+', 'KQo']),
    '大盲 BB': expandRange(['22+', 'A2s+', 'K5s+', 'Q6s+', 'J7s+', 'T7s+', '96s+', '86s+', '75s+', '64s+', '54s', 'A8o+', 'KTo+', 'QTo+', 'JTo', 'T9o', '98o'])
  };
  // 翻前加注上限：已按需求取消（保留常量位，=Infinity 表示不限制）
  const PF_RAISE_CAP = Infinity;

  // 反制参数（可由迭代脚本调整；出厂值即最终调优结果）
  const TUNE = {
    defendWidenOpp3: 0.05,      // 对手 3bet ≥5% 就用宽表防守（10 轮×400 手迭代结果）
    fourBetWidenOpp3: 0.08,     // 对手 3bet ≥8% 就扩 4bet 价值
    fourBetBluffMul: 2.40,      // 4bet 诈唬倍数
    threeBetBluffMulAggro: 0.45,// 对手对 3bet 弃得少时，自己诈唬倍数
    cbetCounterOppCbet: 0.48,   // 对手 c-bet ≥48% → 反制加注
    cbetCounterFreq: 0.63,      // 反制加注频率
    catchAdjBase: 0.096,        // 抓鸡阈值附加（更敢跟）
    foldToBetLean: 0.047,       // 遇注弃牌倾向（更少弃牌）
    advWeight: 0.0,             // 范围优势权重（实测 1.0 反而变弱 → 默认关闭）
    trapWeight: 1.0,            // 松被动陷阱识别强度（高 VPIP + 低 betFreq）
    multiTighten: 1.0,          // 多人池收紧强度（0=关闭）
    sprShove: 2.5,              // 3bet 底池 SPR ≤ 它 → 全下/弃牌二选一
    dryBonus: 0.03,             // 干燥面：更敢跟/加（抓鸡放宽）
    wetPenalty: 0.03            // 湿润面：更谨慎（抓鸡收紧）
  };

  function openOk(cls, pos, st) {
    const base = PF_OPEN_RANGE[pos] || PF_OPEN_RANGE['中间 MP'];
    if (base.has(cls)) {
      if (st.open < 0.8) return Math.random() < 0.62;   // 岩石/紧手弃掉部分边缘
      return true;
    }
    const wider = PF_WIDER[pos];
    if (wider && st.open > 1.15 && PF_OPEN_RANGE[wider] && PF_OPEN_RANGE[wider].has(cls)) {
      return Math.random() < Math.max(0, Math.min(0.8, (st.open - 1) * 0.85));
    }
    if (st.open > 1.3 && (pos === '庄家 D' || pos === '小盲 SB' || pos === '后位 CO') && PF_SPECULATIVE.has(cls)) {
      return Math.random() < Math.max(0, Math.min(0.5, (st.open - 1) * 0.6));
    }
    return false;
  }

  // 牌面纹理：干燥面（彩虹、不连）vs 湿润面（同花听牌/连张/对子面）
  function boardTexture(board) {
    if (!board || board.length < 3) return { wet: false, paired: false, flushDraw: false, connected: 0 };
    const suits = [0, 0, 0, 0];
    for (const c of board) suits[c & 3]++;
    const maxSuit = Math.max.apply(null, suits);
    const ranks = [...new Set(board.map(c => (c >> 2) + 2))].sort((a, b) => a - b);
    const paired = ranks.length < board.length;
    let connected = 0;
    for (let i = 1; i < ranks.length; i++) if (ranks[i] - ranks[i - 1] <= 2) connected++;
    const flushDraw = board.length === 3 ? maxSuit >= 2 : maxSuit >= 3;
    const wet = flushDraw || connected >= 2 || (ranks.length >= 3 && ranks[ranks.length - 1] - ranks[0] <= 4);
    return { wet, paired, flushDraw, connected };
  }

  // 听牌识别：只用于决策原因标注与半诈唬（不改权益计算）
  function drawInfo(hole, board) {
    const out = { flush: false, straight: false };
    if (!hole || hole.length !== 2 || board.length === 0 || board.length >= 5) return out;
    const all = hole.concat(board);
    const suits = [0, 0, 0, 0];
    for (const c of all) suits[c & 3]++;
    for (let s = 0; s < 4; s++) {
      if (suits[s] === 4 && hole.some(c => (c & 3) === s)) out.flush = true;
    }
    const ranks = [...new Set(all.map(c => (c >> 2) + 2))].sort((a, b) => a - b);
    for (let lo = 2; lo <= 10; lo++) {
      let have = 0;
      for (let k = 0; k < 5; k++) if (ranks.indexOf(lo + k) >= 0) have++;
      if (have === 4) out.straight = true;
    }
    return out;
  }

  // ---------- 六种风格原型（真正拉开差异）----------
  // open/threeBet：范围"宽松度"倍数（>1 = 玩更多手）
  // cbet：翻牌持续下注频率；bluff：诈唬频率倍数（1.0 为基准）
  // aggr：加注意愿倍数；callWide：跟注范围放宽量（百分位）；polar：极化下注概率
  const STYLES = [
    { key: 'tag', name: '紧凶 TAG', open: 1.00, threeBet: 1.20, cbet: 0.68, bluff: 0.55, aggr: 1.10, callWide: 0.00, polar: 0.35 },
    { key: 'lag', name: '松凶 LAG', open: 1.55, threeBet: 1.70, cbet: 0.78, bluff: 1.30, aggr: 1.35, callWide: 0.04, polar: 0.55 },
    { key: 'rock', name: '岩石 Rock', open: 0.55, threeBet: 0.70, cbet: 0.40, bluff: 0.20, aggr: 0.72, callWide: -0.06, polar: 0.20 },
    { key: 'fish', name: '跟注站 Station', open: 1.15, threeBet: 0.40, cbet: 0.30, bluff: 0.25, aggr: 0.50, callWide: 0.16, polar: 0.15 },
    { key: 'mani', name: '疯子 Maniac', open: 1.90, threeBet: 1.90, cbet: 0.88, bluff: 1.90, aggr: 1.55, callWide: 0.10, polar: 0.70 },
    { key: 'bal', name: '均衡 Balanced', open: 1.15, threeBet: 1.45, cbet: 0.72, bluff: 1.00, aggr: 1.15, callWide: 0.02, polar: 0.60 }
  ];
  const STYLE_BY_KEY = {};
  for (const s of STYLES) STYLE_BY_KEY[s.key] = s;
  // 风格抽取权重（岩石刻意压低："岩石频次少一点"）
  const STYLE_WEIGHTS = { tag: 0.26, lag: 0.24, bal: 0.20, fish: 0.16, mani: 0.10, rock: 0.04 };
  // 相位长度范围（手）：一段风格持续多少手，然后换挡
  const PHASE_MIN = 15, PHASE_MAX = 38;

  // 买入档位：桌上的最大筹码越高，补码越大 —— 保持有效筹码深度，不靠定期重置
  // 规则：最大筹码 <10000 → 1000；<20000 → 5000；<40000 → 10000；<80000 → 20000；否则 40000
  const BUYIN_TIERS = [
    { maxStack: 10000, buyIn: 1000 },
    { maxStack: 20000, buyIn: 5000 },
    { maxStack: 40000, buyIn: 10000 },
    { maxStack: 80000, buyIn: 20000 },
    { maxStack: Infinity, buyIn: 40000 }
  ];
  function buyInFor(maxStack) {
    for (const t of BUYIN_TIERS) if (maxStack < t.maxStack) return t.buyIn;
    return START_STACK;
  }

  // 极化（超池）下注概率的整体缩放：下调约 1/3
  const POLAR_SCALE = 0.67;
  // 座位 1~5 的主场风格（座位 0 是人类）；只是偏好，不是固定
  const SEAT_STYLE = [null, 'tag', 'lag', 'rock', 'fish', 'mani'];

  // ---------- 按对手行动收窄范围后的权益 ----------
  // oppSpec: [{floor, tries}]；floor = 该对手翻前手牌百分位下限，
  // tries = 采样几次取与牌面联系最强的一次（越大表示其范围越强/越连通）。
  // 这取代了「对随机手牌」的假设，是机器人变强的关键。
  function estimateEquityRange(hole, board, oppSpec, iters) {
    const dead = new Set();
    for (const c of hole) dead.add(c);
    for (const c of board) dead.add(c);
    const base = [];
    for (let c = 0; c < 52; c++) if (!dead.has(c)) base.push(c);
    const nOpp = oppSpec.length;
    let win = 0, tie = 0;
    for (let it = 0; it < iters; it++) {
      const pool = base.slice();
      const full = board.slice();
      while (full.length < 5) {
        const k = Math.floor(Math.random() * pool.length);
        full.push(pool.splice(k, 1)[0]);
      }
      const my = score7(hole.concat(full));
      let best = -1;
      for (let o = 0; o < nOpp; o++) {
        const spec = oppSpec[o];
        const floor = spec.floor || 0;
        const tries = Math.max(1, spec.tries || 1);
        let pick = null;
        for (let a = 0; a < tries; a++) {
          let cand = null;
          for (let att = 0; att < 20 && pool.length >= 2; att++) {
            const i1 = Math.floor(Math.random() * pool.length);
            let i2 = Math.floor(Math.random() * pool.length);
            while (i2 === i1) i2 = Math.floor(Math.random() * pool.length);
            const h = [pool[i1], pool[i2]];
            if (floor <= 0 || preflopPercentile(h) >= floor) { cand = h; break; }
          }
          if (cand && (!pick || score7(cand.concat(full)) > score7(pick.concat(full)))) pick = cand;
        }
        if (!pick && pool.length >= 2) pick = [pool[0], pool[1]];
        if (!pick) continue;
        const k1 = pool.indexOf(pick[0]); if (k1 >= 0) pool.splice(k1, 1);
        const k2 = pool.indexOf(pick[1]); if (k2 >= 0) pool.splice(k2, 1);
        const s = score7(pick.concat(full));
        if (s > best) best = s;
      }
      if (my > best) win++; else if (my === best) tie++;
    }
    return (win + tie * 0.5) / iters;
  }

  // ---------- 游戏 ----------
  class PokerGame {
    constructor(hooks) {
      hooks = hooks || {};
      this.hooks = {
        render: hooks.render || function () {},
        log: hooks.log || function () {},
        awaitHuman: hooks.awaitHuman || function () { return Promise.resolve({ action: 'check' }); },
        delay: hooks.delay || function (ms) { return new Promise(r => setTimeout(r, ms)); },
        onHandEnd: hooks.onHandEnd || function () {},
        onHandStart: hooks.onHandStart || function () {},
        onHandRecorded: hooks.onHandRecorded || function () {}
      };
      const names = ['你', '老张', '小李', '阿May', '老K', '阿豪'];
      this.players = [];
      for (let i = 0; i < NUM; i++) {
        this.players.push({
          id: i, name: names[i], human: i === 0,
          stack: START_STACK, hole: [], bet: 0, committed: 0,
          folded: false, active: false, allIn: false, acted: false,
          score: null, won: 0, lastAction: '', handName: '', shown: false,
          rangeFloor: 0, postAggro: 0,
          style: i === 0 ? null : STYLE_BY_KEY[SEAT_STYLE[i]],
          styleName: i === 0 ? '—' : STYLE_BY_KEY[SEAT_STYLE[i]].name,
          styleKey: i === 0 ? null : SEAT_STYLE[i],
          homeKey: i === 0 ? null : SEAT_STYLE[i],
          phaseLeft: 0
        });
      }
      this.button = -1; this.handNo = 0;
      this.pot = 0; this.lastPot = 0; this.community = [];
      this.currentBet = 0; this.minRaise = BB;
      this.busy = false; this.turnId = -1;
      this.sbIdx = -1; this.bbIdx = -1;
      this.preflopAggressor = -1;
      this.pfRaises = 0;      // 本手翻前加注次数（open=1 / 3bet=2 / 4bet=3）
      this.profiles = {};     // 对手画像：跨手统计 VPIP/PFR/翻后激进度/遇注弃牌
      this.lastAggressor = -1;
      this.lastAggressorPos = '';
      this.sessionNet = 0;    // 人类本场累计输赢（补码不计入）
      this.equityIters = 220;
      this.buyIn = START_STACK;
      // 风格周期换档开关（批量分析时可关掉）
      this.styleCycling = true;
      // 人类决策点写进复盘的权益采样次数（实盘 4000；批量模拟可调低）
      this.humanEquityIters = 4000;
      this.posLabels = {};   // playerId -> 位置名（每手开始时算，全程常显）
      this.recActions = [];  // 本手行动记录
      this.streetName = '';
      this.stackStart = [];
      this.history = [];     // 所有已完成的手牌记录
    }

    // ---------- 风格换挡：按相位随机切换（像真人变节奏）----------
    // 每个座位有"主场风格"，但会周期性漂移到其他风格；岩石的抽取权重最低。
    pickStyle(p) {
      const keys = STYLES.map(s => s.key);
      const w = keys.map(k => (STYLE_WEIGHTS[k] || 0.05) * (k === p.homeKey ? 2.2 : 1));
      const total = w.reduce((a, b) => a + b, 0);
      let x = Math.random() * total;
      for (let i = 0; i < keys.length; i++) {
        x -= w[i];
        if (x <= 0) return i;
      }
      return 0;
    }

    cycleStyle(p) {
      p.phaseLeft = (p.phaseLeft || 0) - 1;
      if (p.phaseLeft > 0) return;
      const idx = this.pickStyle(p);
      const s = STYLES[idx];
      const changed = (p.styleKey !== s.key);
      p.styleKey = s.key; p.style = s; p.styleName = s.name;
      p.phaseLeft = PHASE_MIN + Math.floor(Math.random() * (PHASE_MAX - PHASE_MIN + 1));
      if (changed) this.hooks.log('🎭 ' + p.name + ' 改变了打法');
    }

    nextActive(i) {
      let j = (i + 1) % NUM, g = 0;
      while (!this.players[j].active && g++ < NUM) j = (j + 1) % NUM;
      return j;
    }
    activeCount() { return this.players.filter(p => p.active).length; }

    postBlind(i, amt, label) {
      const p = this.players[i];
      const a = Math.min(amt, p.stack);
      p.stack -= a; p.bet += a; p.committed += a; this.pot += a;
      if (p.stack === 0) p.allIn = true;
      p.lastAction = label + ' ' + a;
    }

    totalPot() { return this.players.reduce((s, p) => s + p.committed, 0); }

    // ---------- 存档 / 读档（用于刷新页面后续打）----------
    saveState() {
      return {
        v: 1,
        handNo: this.handNo,
        button: this.button,
        stacks: this.players.map(p => p.stack),
        sessionNet: this.sessionNet || 0,
        profiles: this.profiles || {},
        at: Date.now()
      };
    }

    loadState(s) {
      if (!s || s.v !== 1) return false;
      if (!Array.isArray(s.stacks) || s.stacks.length !== this.players.length) return false;
      const handNo = Math.floor(Number(s.handNo));
      if (!Number.isFinite(handNo) || handNo <= 0) return false;
      s.stacks.forEach((v, i) => {
        const n = Math.floor(Number(v));
        this.players[i].stack = Number.isFinite(n) && n > 0 ? n : 0;
      });
      this.handNo = handNo;
      this.sessionNet = Number.isFinite(Number(s.sessionNet)) ? Math.floor(Number(s.sessionNet)) : 0;
      if (s.profiles && typeof s.profiles === 'object') this.profiles = s.profiles;
      this.button = Number.isInteger(s.button) ? s.button : -1;
      this.players.forEach(p => {
        p.hole = []; p.bet = 0; p.committed = 0; p.folded = false; p.allIn = false;
        p.acted = false; p.score = null; p.won = 0; p.lastAction = '';
        p.handName = ''; p.shown = true; p.active = p.stack > 0;
      });
      this.pot = 0; this.community = []; this.currentBet = 0; this.minRaise = BB;
      this.busy = false; this.turnId = -1; this.posLabels = {}; this.recActions = [];
      return true;
    }

    reset() {
      this.players.forEach(p => { p.stack = START_STACK; });
      this.buyIn = START_STACK;
      this.sessionNet = 0;
      this.pfRaises = 0;
      this.profiles = {};
      this.button = -1; this.handNo = 0; this.pot = 0; this.community = [];
      this.currentBet = 0; this.minRaise = BB; this.busy = false; this.turnId = -1;
      this.hooks.log('🔄 牌局已重置：所有人回到 1000 分');
      this.hooks.render();
    }

    currentBuyIn() {
      let mx = 0;
      for (const p of this.players) if (p.stack > mx) mx = p.stack;
      return buyInFor(mx);
    }

    rebuy(playerId, amount) {
      const p = this.players[playerId];
      if (!p) return;
      const amt = amount || this.currentBuyIn();
      p.stack += amt;
      if (p.human) this.sessionNet = (this.sessionNet || 0) - amt;
      this.hooks.log('💰 ' + p.name + ' 补充 ' + amt + ' 分 → ' + p.stack);
      this.hooks.render();
    }

    // ---------- 对手画像（跨手统计 + 平滑先验）----------
    blankProfile() {
      return { n: 0, vpip: 0, pfr: 0, bets: 0, raises: 0, calls: 0, folds: 0,
               faced: 0, facedFold: 0, facedCall: 0, sd: 0, sdw: 0,
               faced3bet: 0, foldTo3bet: 0, faced4bet: 0, foldTo4bet: 0,
               facedRaise: 0, threeBets: 0, cbetOpp: 0, cbetMade: 0, byPos: {} };
    }

    updateProfiles(acts, players) {
      if (!this.profiles) this.profiles = {};
      // 时间衰减：每手把历史计数 ×0.99，等效“最近约 100 手”权重
      const DECAY = 0.99;
      const FIELDS = ['n', 'vpip', 'pfr', 'bets', 'raises', 'calls', 'folds', 'faced', 'facedFold',
        'facedCall', 'sd', 'sdw', 'faced3bet', 'foldTo3bet', 'faced4bet', 'foldTo4bet',
        'facedRaise', 'threeBets', 'cbetOpp', 'cbetMade'];
      for (const id in this.profiles) {
        const pr = this.profiles[id];
        for (const k of FIELDS) if (pr[k]) pr[k] *= DECAY;
        if (pr.byPos) for (const pos in pr.byPos) {
          const bp = pr.byPos[pos];
          for (const k of ['n', 'vpip', 'pfr', 'faced', 'facedFold']) if (bp[k]) bp[k] *= DECAY;
        }
      }
      for (const pl of players) {
        if (!pl.hole || pl.hole.length !== 2) continue;
        const pr = this.profiles[pl.id] = this.profiles[pl.id] || this.blankProfile();
        pr.n++;
      }
      const seen = {};
      let raises = 0;
      for (const a of acts) {
        const pr = this.profiles[a.playerId];
        if (!pr) continue;
        if (a.street === '翻牌前') {
          const pos = a.pos || '未知';
          if (!pr.byPos) pr.byPos = {};
          const bp = pr.byPos[pos] = pr.byPos[pos] || { n: 0, vpip: 0, pfr: 0, faced: 0, facedFold: 0 };
          if (!seen[a.playerId]) {
            seen[a.playerId] = 1;
            bp.n++;
            if (a.action === 'call' || a.action === 'raise') { pr.vpip++; bp.vpip++; }
            if (a.action === 'raise') { pr.pfr++; bp.pfr++; }
          }
          if (raises >= 1) {
            bp.faced++;
            if (raises === 1) {
              pr.faced3bet++; pr.facedRaise = (pr.facedRaise || 0) + 1;
              if (a.action === 'fold') pr.foldTo3bet++;
              if (a.action === 'raise') pr.threeBets = (pr.threeBets || 0) + 1;
            } else {
              pr.faced4bet++; if (a.action === 'fold') pr.foldTo4bet++;
            }
            if (a.action === 'fold') bp.facedFold++;
          }
          if (a.action === 'raise') raises++;
        } else {
          if (a.action === 'bet') pr.bets++;
          else if (a.action === 'raise') { pr.bets++; pr.raises++; }
          else if (a.action === 'call') pr.calls++;
          else if (a.action === 'fold') pr.folds++;
          if (a.toCall > 0) {
            pr.faced++;
            if (a.action === 'fold') pr.facedFold++;
            else if (a.action === 'call') pr.facedCall++;
          }
        }
      }
      // 翻牌 c-bet（翻前最后加注者在翻牌下注的比例）
      let pfAgg = -1;
      for (const a of acts) if (a.street === '翻牌前' && a.action === 'raise') pfAgg = a.playerId;
      if (pfAgg >= 0) {
        for (const a of acts) {
          if (a.street !== '翻牌' || a.playerId !== pfAgg) continue;
          const pr = this.profiles[pfAgg];
          if (!pr) break;
          pr.cbetOpp = (pr.cbetOpp || 0) + 1;
          if (a.action === 'bet') pr.cbetMade = (pr.cbetMade || 0) + 1;
          break;
        }
      }
      for (const pl of players) {
        if (!pl.hole || pl.hole.length !== 2) continue;
        if (this.community.length === 5 && !pl.folded) {
          const pr = this.profiles[pl.id];
          if (!pr) continue;
          pr.sd++;
          if (pl.won > 0) pr.sdw++;
        }
      }
    }

    // 带先验的画像（前 30 手向 28% VPIP / 20% PFR / 50% 弃牌 收敛）
    statsOf(id) {
      const pr = (this.profiles && this.profiles[id]) || this.blankProfile();
      const n = pr.n || 0;
      const k = Math.min(n, 30) / 30;
      const vpip = (1 - k) * 0.28 + k * ((pr.vpip || 0) / Math.max(1, n));
      const pfr = (1 - k) * 0.20 + k * ((pr.pfr || 0) / Math.max(1, n));
      const faced = Math.max(1, pr.faced || 0);
      const foldToBet = (1 - k) * 0.50 + k * ((pr.facedFold || 0) / faced);
      const dec = Math.max(1, (pr.bets || 0) + (pr.calls || 0) + (pr.folds || 0));
      const betFreq = (1 - k) * 0.30 + k * ((pr.bets || 0) / dec);
      const f3 = Math.max(1, pr.faced3bet || 0);
      const foldTo3bet = (1 - k) * 0.55 + k * ((pr.foldTo3bet || 0) / f3);
      const f4 = Math.max(1, pr.faced4bet || 0);
      const foldTo4bet = (1 - k) * 0.60 + k * ((pr.foldTo4bet || 0) / f4);
      const fr = Math.max(1, pr.facedRaise || 0);
      const threeBetFreq = (1 - k) * 0.08 + k * ((pr.threeBets || 0) / fr);
      const co = Math.max(1, pr.cbetOpp || 0);
      const cbetFreq = (1 - k) * 0.55 + k * ((pr.cbetMade || 0) / co);
      return { n, vpip, pfr, foldToBet, betFreq, foldTo3bet, foldTo4bet, threeBetFreq, cbetFreq,
               aggr: pfr / Math.max(0.05, vpip) };
    }

    // 当前活跃对手的整体倾向
    tableTendency(p) {
      const opps = this.players.filter(o => o !== p && o.active && o.hole && o.hole.length === 2);
      let v = 0, f = 0, b = 0;
      for (const o of opps) {
        const st = this.statsOf(o.id);
        v += st.vpip; f += st.foldToBet; b += st.betFreq;
      }
      const n = Math.max(1, opps.length);
      return { vpip: v / n, foldToBet: f / n, betFreq: b / n, n: opps.length };
    }

    // 某对手在特定位置的倾向（样本不足时回退到整体）
    posStatsOf(id, pos) {
      const base = this.statsOf(id);
      const pr = (this.profiles && this.profiles[id]) || {};
      const bp = (pr.byPos || {})[pos];
      if (!bp || !bp.n) return base;
      const k = Math.min(bp.n, 12) / 12;
      const vpip = (1 - k) * base.vpip + k * (bp.vpip / Math.max(1, bp.n));
      const pfr = (1 - k) * base.pfr + k * (bp.pfr / Math.max(1, bp.n));
      return Object.assign({}, base, { vpip, pfr, n: bp.n });
    }

    profilesSnapshot() {
      const out = {};
      for (const p of this.players) {
        if (p.human) continue;
        const st = this.statsOf(p.id);
        const pr = (this.profiles && this.profiles[p.id]) || {};
        out[p.name] = {
          hands: pr.n || 0,
          vpip: Math.round(100 * st.vpip),
          pfr: Math.round(100 * st.pfr),
          foldToBet: Math.round(100 * st.foldToBet),
          betFreq: Math.round(100 * st.betFreq),
          foldTo3bet: Math.round(100 * st.foldTo3bet),
          threeBetFreq: Math.round(100 * st.threeBetFreq),
          cbetFreq: Math.round(100 * st.cbetFreq)
        };
      }
      return out;
    }

    roundComplete() {
      const alive = this.players.filter(p => p.active);
      if (alive.length <= 1) return true;
      const canAct = alive.filter(p => !p.allIn);
      if (canAct.length === 0) return true;
      return canAct.every(p => p.acted && p.bet === this.currentBet);
    }

    applyDecision(p, dec, toCall) {
      if (dec.action === 'fold') {
        p.active = false; p.folded = true; p.acted = true; p.lastAction = '弃牌';
        this.hooks.log('🙅 ' + p.name + ' 弃牌');
        return;
      }
      if (dec.action === 'check') {
        p.acted = true; p.lastAction = '过牌';
        this.hooks.log('✋ ' + p.name + ' 过牌');
        return;
      }
      if (dec.action === 'call') {
        const amt = Math.min(toCall, p.stack);
        p.stack -= amt; p.bet += amt; p.committed += amt; this.pot += amt;
        if (p.stack === 0) p.allIn = true;
        p.acted = true; p.lastAction = '跟注 ' + amt;
        if (this.community.length === 0) p.rangeFloor = Math.max(p.rangeFloor, 0.24);
        this.hooks.log('👌 ' + p.name + ' 跟注 ' + amt + (p.allIn ? '（全下）' : ''));
        return;
      }
      if (dec.action === 'raise') {
        const maxTarget = p.bet + p.stack;
        let target = Math.round(dec.amount || 0);
        const minTarget = Math.min(this.currentBet + this.minRaise, maxTarget);
        if (target < minTarget) target = minTarget;
        if (target > maxTarget) target = maxTarget;
        const add = target - p.bet;
        if (add <= 0) { p.acted = true; p.lastAction = '过牌'; return; }
        const raiseSize = target - this.currentBet;
        p.stack -= add; p.bet += add; p.committed += add; this.pot += add;
        if (p.stack === 0) p.allIn = true;
        if (raiseSize >= this.minRaise) this.minRaise = raiseSize;
        if (target > this.currentBet) this.currentBet = target;
        p.acted = true;
        p.lastAction = (toCall > 0 ? '加注到 ' : '下注 ') + target;
        // 记录该玩家的"已展示的强牌程度"：翻前开牌/反加、翻后下注/加注都提升它
        if (this.community.length === 0) {
          this.preflopAggressor = p.id;
          this.lastAggressor = p.id;
          this.lastAggressorPos = this.posLabels[p.id] || '';
          this.pfRaises = (this.pfRaises || 0) + 1;
          p.rangeFloor = Math.max(p.rangeFloor, 0.68);
        } else {
          p.postAggro += 1;
        }
        this.players.forEach(o => { if (o !== p && o.active && !o.allIn) o.acted = false; });
        this.hooks.log('🔥 ' + p.name + ' ' + p.lastAction + (p.allIn ? '（全下）' : ''));
        return;
      }
      // 兜底
      p.acted = true;
    }

    // 机器人决策总入口
    botDecide(p, toCall) {
      return this.community.length === 0 ? this.botPreflop(p, toCall) : this.botPostflop(p, toCall);
    }

    // ---------- 翻前：位置分档 + 极化 3bet/4bet + 4bet 上限 ----------
    botPreflop(p, toCall) {
      const st = p.style || STYLES[0];
      const pos = this.posLabels[p.id] || '中间 MP';
      const cls = handClass(p.hole);
      const raises = this.pfRaises || 0;
      const potOdds = toCall > 0 ? toCall / (this.pot + toCall) : 0;
      const effBB = p.stack / BB;
      const opp = Math.max(1, this.activeCount() - 1);
      const r = Math.random();
      // 对手建模：桌面越松（VPIP 高），3bet/防守越宽；对手越爱弃，越爱诈唬
      const tend = this.tableTendency(p);
      const loose = Math.max(-0.5, Math.min(1.5, (tend.vpip - 0.28) / 0.28));
      const raiser = this.lastAggressor >= 0 ? this.statsOf(this.lastAggressor) : null;
      const mk = (action, amount, reason) => ({
        action: action, amount: amount, reason: reason,
        _eq: null, _potOdds: potOdds, _opp: opp
      });

      // 无人加注：按位置开池
      if (raises === 0) {
        if (toCall === 0) {
          if (openOk(cls, pos, st) && r < 0.60 * st.aggr) {
            return mk('raise', p.bet + round5(clamp(BB * 3.5, BB * 2, p.stack)), '大盲加注（隔离平跟）');
          }
          return mk('check', 0, '过牌（大盲免费看翻牌）');
        }
        if (openOk(cls, pos, st)) {
          const limpers = this.players.filter(o => o !== p && o.active && o.id !== this.bbIdx
            && o.acted && o.bet === this.currentBet).length;
          const ip = (pos === '庄家 D' || pos === '后位 CO');
          const base = ip ? 2.3 : 3.0;
          const size = round5(clamp(BB * (base + limpers * 0.8), BB * 2, p.stack));
          return mk('raise', p.bet + size, '开池（' + pos + ' 范围' + (limpers ? '·隔离 ' + limpers + ' 平跟' : '') + '）');
        }
        if (effBB <= 12 && preflopPercentile(p.hole) >= 0.78) {
          return mk('raise', p.bet + p.stack, '全下（短码 ' + Math.round(effBB) + 'BB）');
        }
        if (st.callWide >= 0.10 && toCall <= BB && preflopPercentile(p.hole) >= PF_OPEN[pos] - 0.12 && r < 0.45) {
          return mk('call', 0, '平跟进池（跟注站风格）');
        }
        return mk('fold', 0, '弃牌（位置范围外）');
      }

      // 面对 1 次加注：3bet 决策（极化）
      if (raises === 1) {
        const ip = (pos === '庄家 D' || pos === '后位 CO');
        const size3 = () => round5(clamp(this.currentBet * (ip ? 3 : 4), this.currentBet * 2.5, p.bet + p.stack));
        if (toCall <= 0) return mk('check', 0, '过牌');
        const opp3 = raiser ? raiser.threeBetFreq : 0.08;
        const maniac = (loose > 0.9) || (raiser && raiser.vpip > 0.60) || opp3 > 0.20;
        const wideValue = maniac || loose > 0.6 || (raiser && raiser.vpip > 0.45);
        const valueR = maniac ? PF_3BET_VALUE_MANIAC : (wideValue ? PF_3BET_VALUE_WIDE : PF_3BET_VALUE);
        if (valueR.has(cls)) return mk('raise', size3(), '3bet 价值（极化顶端' + (maniac ? '·针对疯子' : (wideValue ? '·对松对手加宽' : '')) + '）');
        const bluffSet = maniac ? PF_3BET_BLUFF_WIDE : PF_3BET_BLUFF;
        const fold3 = raiser ? raiser.foldTo3bet : 0.55;
        // 反制：对手对 3bet 弃得少 → 我们少诈唬；弃得多 → 多诈唬
        const bluffRate = clamp(0.45 * st.bluff * (1 + 0.9 * Math.max(0, loose)) *
          (1 + (fold3 - 0.55) * 1.6) * (maniac ? 1.4 : 1) *
          (fold3 < 0.45 ? TUNE.threeBetBluffMulAggro : 1), 0, 0.92);
        if (bluffSet.has(cls) && r < bluffRate) {
          return mk('raise', size3(), '3bet 诈唬（对手对 3bet 弃 ' + Math.round(fold3 * 100) + '%' + (maniac ? '·疯子' : '') + '）');
        }
        const commit = toCall / Math.max(1, p.stack);
        const openerPos = this.lastAggressorPos || '';
        const opAtPos = raiser ? this.posStatsOf(this.lastAggressor, openerPos) : null;
        const opLoose = opAtPos ? Math.max(0, Math.min(1.2, (opAtPos.vpip - 0.28) / 0.28)) : 0;
        const defend = (PF_DEFEND[pos] || PF_DEFEND['中间 MP']);
        // 反制高频 3bet：防守范围直接换宽表
        const canDefend = PF_CALL_3BET.has(cls) || defend.has(cls)
          || (maniac && PF_DEFEND_WIDE.has(cls))
          || (opp3 > TUNE.defendWidenOpp3 && PF_DEFEND_WIDE.has(cls))
          || (loose > 0.45 && PF_SPECULATIVE.has(cls) && Math.random() < 0.55)
          || (st.callWide > 0.08 && preflopPercentile(p.hole) >= 0.52);
        if (canDefend && commit <= 0.26 + 0.20 * Math.max(0, Math.max(loose, opLoose))) {
          return mk('call', 0, '跟注（位置防守' + (maniac ? '·针对疯子' : (opLoose > 0.45 ? '·对手 ' + openerPos + ' 开池 ' + Math.round(100 * opAtPos.vpip) + '%' : (loose > 0.45 ? '·对松对手放宽' : ''))) + '）');
        }
        if (canDefend && potOdds <= 0.26) return mk('call', 0, '跟注（赔率足够）');
        return mk('fold', 0, '弃牌（对 3bet 范围外）');
      }

      // 面对 3bet：4bet 决策（价值/诈唬极化；可全下）
      const opp3b = raiser ? raiser.threeBetFreq : 0.08;
      const fourValue = (opp3b > TUNE.fourBetWidenOpp3) ? PF_3BET_VALUE_WIDE : PF_4BET_VALUE;
      if (fourValue.has(cls)) {
        const target = round5(clamp(this.currentBet * 2.3, this.currentBet * 2.1, p.bet + p.stack));
        const shove = (p.bet + p.stack - target) <= BB * 12 || target >= p.bet + p.stack * 0.5;
        return shove
          ? mk('raise', p.bet + p.stack, '4bet 全下（价值）')
          : mk('raise', target, '4bet 价值（极化顶端）');
      }
      const fold4 = raiser ? raiser.foldTo4bet : 0.60;
      const fourBluff = clamp(0.20 * st.bluff * (1 + 1.2 * Math.max(0, loose)) *
        (1 + (fold4 - 0.60) * 1.5) * (opp3b > TUNE.fourBetWidenOpp3 ? TUNE.fourBetBluffMul : 1), 0, 0.65);
      if (PF_4BET_BLUFF.has(cls) && r < fourBluff) {
        return mk('raise', p.bet + p.stack, '4bet 全下（诈唬·极化）');
      }
      if (toCall <= 0) return mk('check', 0, '过牌');
      if (potOdds <= 0.20 && PF_CALL_3BET.has(cls) && toCall <= p.stack * 0.35) return mk('call', 0, '跟注 3bet（赔率）');
      return mk('fold', 0, '弃牌（对 3bet 范围外）');
    }

    // ---------- 翻后：范围权益 + 极化尺度 + 决策原因 ----------
    botPostflop(p, toCall) {
      const st = p.style || STYLES[0];
      const opps = this.players.filter(o => o.active && o.id !== p.id);
      const specs = opps.map(o => ({
        floor: o.rangeFloor || 0,
        tries: 1 + Math.min(2, o.postAggro || 0)
      }));
      const eq = estimateEquityRange(p.hole, this.community, specs, this.equityIters);
      const pot = Math.max(this.pot, BB);
      const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
      const street = this.community.length;          // 3=翻牌 4=转牌 5=河牌
      const nOpp = Math.max(1, opps.length);
      const r = Math.random();
      const made = handName(score7(p.hole.concat(this.community)));
      const draw = drawInfo(p.hole, this.community);
      const commit = toCall / Math.max(1, p.stack);
      const tex = boardTexture(this.community);
      const is3betPot = (this.pfRaises || 0) >= 2;
      const effStack = Math.min.apply(null, [p.bet + p.stack].concat(opps.map(o => o.bet + o.stack)));
      const spr = effStack / Math.max(pot, BB);
      // 多人池：翻后阈值全面收紧
      const multi = opps.length >= 2;
      // 范围优势（简化模型）：翻前加注者 / 3bet 者 / 高张面 有利；对子面 / 湿面 对跟注方有利
      const hiRank = Math.max.apply(null, this.community.map(c => (c >> 2) + 2));
      let adv = 0;
      if (this.preflopAggressor === p.id) adv += 0.15;
      if (is3betPot && this.preflopAggressor === p.id) adv += 0.12;
      if (hiRank >= 13) adv += 0.06;
      if (tex.paired) adv -= 0.06;
      if (tex.wet) adv -= 0.06;
      adv = Math.max(-0.20, Math.min(0.30, adv)) * TUNE.advWeight;
      const mT = TUNE.multiTighten;
      const mk = (action, amount, reason) => ({ action, amount, reason, _eq: eq, _potOdds: potOdds, _opp: nOpp });

      const polar = clamp(st.polar * POLAR_SCALE, 0, 0.85);
      // 混合尺度：同一牌力随机在小/标准/超池之间切换，避免被读尺度
      const sizeFor = (kind) => {
        const roll = Math.random();
        if (kind === 'small') return round5(clamp(0.33 * pot, BB, p.stack));
        if (kind === 'over') return round5(clamp(1.25 * pot, BB, p.stack));
        if (kind === 'bluff') {
          const f = roll < 0.50 ? 0.33 : (roll < 0.80 ? 0.66 : 1.25);
          return round5(clamp(f * pot, BB, p.stack));
        }
        const f = roll < 0.60 ? (0.60 + 0.15 * Math.random()) : (roll < 0.85 ? 0.33 : 1.25);
        return round5(clamp(f * pot, BB, p.stack));
      };
      const tend = this.tableTendency(p);
      const focus = (opps.length === 1) ? this.statsOf(opps[0].id) : null;
      const useFold = focus ? focus.foldToBet : tend.foldToBet;
      const useBet = focus ? focus.betFreq : tend.betFreq;
      const useVpip = focus ? focus.vpip : tend.vpip;
      const oppCbet = focus ? focus.cbetFreq : 0.55;
      const bluffBoost = clamp(0.55 + (useFold - 0.50) * 2.4, 0.25, 1.9);
      // 松被动陷阱：高 VPIP + 低下注频率 = 只在有牌时下注，不能把 VPIP 当“爱诈唬”
      const trap = clamp((useVpip - 0.42) * 1.2, 0, 0.9) * (useBet < 0.36 ? 1 : 0.2) * TUNE.trapWeight;
      // 抓鸡阈值：看下注频率而非 VPIP；松被动对手要收紧
      const catchAdj = clamp((useBet - 0.30) * 0.55 + (useVpip - 0.28) * 0.28 -
        trap * 0.42 + TUNE.catchAdjBase, -0.12, 0.24);
      const cbetSpot = (this.preflopAggressor === p.id && street === 3 && nOpp <= 2);

      // —— 3bet 底池 + 低 SPR：全下或弃牌，不做中间尺度 ——
      if (is3betPot && spr <= TUNE.sprShove) {
        if (toCall === 0) {
          if (eq > 0.58 && p.stack > BB) {
            return mk('raise', p.bet + p.stack, '3bet 底池·SPR ' + spr.toFixed(1) + '：全下（价值）');
          }
          if (eq < 0.35 && p.stack > BB && Math.random() < 0.18 * bluffBoost * (1 - 0.85 * trap)) {
            return mk('raise', p.bet + p.stack, '3bet 底池·SPR ' + spr.toFixed(1) + '：全下诈唬');
          }
          return mk('check', 0, '3bet 底池·低 SPR：过牌控池');
        }
        if (eq >= potOdds + 0.02) {
          return mk('call', 0, '3bet 底池·低 SPR：跟注（权益 ' + Math.round(eq * 100) + '%）');
        }
        return mk('fold', 0, '3bet 底池·低 SPR：弃牌');
      }

      if (toCall === 0) {
        if (eq > 0.72 - 0.14 * trap && p.stack > BB) {
          const size = (useVpip > 0.42)
            ? round5(clamp((0.85 + 0.15 * Math.random()) * pot, BB, p.stack))
            : sizeFor('value');
          return mk('raise', p.bet + size, '价值下注（' + made + '·权益 ' + Math.round(eq * 100) + '%·' +
            Math.round(100 * size / pot) + '% 池·混合尺度' + (multi ? '·多人池' : '') + '）');
        }
        if (eq > (multi ? 0.55 + 0.07 * mT : 0.55) - 0.08 * trap && p.stack > BB) {
          if (Math.random() < (multi ? 0.55 - 0.15 * mT : 0.55) + 0.20 * trap) {
            const size = cbetSpot ? sizeFor('small') : sizeFor('value');
            return mk('raise', p.bet + size, '中等价值/保护（' + made + '）');
          }
          return mk('check', 0, '过牌（控制底池）');
        }
        if ((draw.flush || draw.straight) && p.stack > BB) {
          if (Math.random() < 0.45 * st.bluff * bluffBoost * (1 - 0.8 * trap)) {
            return mk('raise', p.bet + sizeFor('value'), '半诈唬（' + (draw.flush ? '同花听牌' : '顺子听牌') + '）');
          }
          return mk('check', 0, '过牌（听牌·保留免费牌）');
        }
        if (cbetSpot && p.stack > BB) {
          const cbetFreq = clamp(st.cbet * bluffBoost * (1 - 0.7 * trap) + (tex.wet ? -0.12 : 0.12) +
            adv * 0.60 - (multi ? 0.18 * mT : 0), 0, 0.95);
          if (r < cbetFreq) {
            const size = tex.wet
              ? round5(clamp((0.60 + 0.20 * Math.random()) * pot, BB, p.stack))
              : round5(clamp((0.33 + 0.17 * Math.random()) * pot, BB, p.stack));
            return mk('raise', p.bet + size, 'c-bet（' + (tex.wet ? '湿面' : '干面') + ' ' +
              Math.round(100 * size / pot) + '% 池·对手弃牌 ' + Math.round(useFold * 100) + '%）');
          }
        }
        const bluffRate = clamp(st.bluff * (street >= 5 ? 0.12 : 0.18) * bluffBoost *
          (tex.wet ? 0.60 : 1.25) * (multi ? (1 - 0.55 * mT) : 1) * (1 + adv * 1.5) * (1 - 0.85 * trap), 0, 0.72);
        if (p.stack > BB && r < bluffRate) {
          return mk('raise', p.bet + sizeFor('bluff'), '纯诈唬（对手遇注弃 ' + Math.round(useFold * 100) + '%·极化下注）');
        }
        return mk('check', 0, '过牌（放弃/示弱）');
      }

      // 面对小注：提高加注频率（不再只针对高 c-bet 对手）
      const smallBet = toCall > 0 && toCall <= 0.45 * pot;
      if (smallBet && !multi && p.stack > toCall) {
        const isCounter = oppCbet > TUNE.cbetCounterOppCbet;
        const raiseFreq = isCounter ? TUNE.cbetCounterFreq * (tex.wet ? 0.70 : 1) : (tex.wet ? 0.18 : 0.30);
        const eqNeed = isCounter ? 0.45 : 0.55;
        if (eq > eqNeed && Math.random() < raiseFreq) {
          const inc = Math.max(this.minRaise, round5(1.0 * toCall + 0.5 * pot));
          return mk('raise', Math.min(this.currentBet + inc, p.bet + p.stack),
            '反制加注（' + (isCounter ? '对手 c-bet ' + Math.round(oppCbet * 100) + '%' : '小注 ' + Math.round(100 * toCall / pot) + '% 池') +
            '·权益 ' + Math.round(eq * 100) + '%）');
        }
      }
      // 面对下注
      if (commit >= 0.90 && eq < 0.62 && !draw.flush && !draw.straight) {
        return mk('fold', 0, '弃牌（面对全下·权益不足）');
      }
      if (eq > 0.80 && p.stack > toCall && Math.random() < 0.70 * st.aggr) {
        const inc = Math.max(this.minRaise, round5((Math.random() < polar ? 1.2 : 0.85) * pot));
        return mk('raise', Math.min(this.currentBet + inc, p.bet + p.stack), '价值加注（' + made + '）');
      }
      if (eq > 0.66 && p.stack > toCall && Math.random() < 0.40 * st.aggr) {
        return mk('raise', Math.min(this.currentBet + this.minRaise, p.bet + p.stack), '价值加注（' + made + '）');
      }
      const texAdj = tex.wet ? TUNE.wetPenalty : -TUNE.dryBonus;
      if (spr < 3 && eq < 0.45 && toCall > 0.30 * pot) {
        return mk('fold', 0, '弃牌（低 SPR ' + spr.toFixed(1) + '·中等牌不跟大注）');
      }
      // 对手越紧（VPIP 低），越要尊重其下注/加注
      const tight = clamp((0.24 - useVpip) * 0.70, 0, 0.14);
      const need = potOdds + texAdj + 0.01 - st.callWide * 0.12 - catchAdj -
        (oppCbet > TUNE.cbetCounterOppCbet && !tex.wet ? 0.02 : 0) - TUNE.foldToBetLean +
        (multi ? 0.03 * mT : 0) - adv * 0.05 + tight +
        (toCall > 0.50 * pot ? (street >= 7 ? 0.10 : (street >= 5 ? 0.06 : 0)) : 0);
      if (eq >= need) {
        const bluffCatch = (eq < 0.68 && toCall <= 1.0 * pot && !draw.flush && !draw.straight);
        return mk('call', 0, bluffCatch
          ? '抓鸡（对手下注频率 ' + Math.round(useBet * 100) + '%·权益 ' + Math.round(eq * 100) + '% vs 赔率 ' + Math.round(potOdds * 100) + '%）'
          : '跟注（' + (draw.flush || draw.straight ? '听牌赔率' : '权益≥赔率') + '）');
      }
      if ((draw.flush || draw.straight) && eq >= potOdds - 0.02 && r < 0.5) {
        return mk('call', 0, '跟注（听牌·隐含赔率）');
      }
      return mk('fold', 0, '弃牌（权益 ' + Math.round(eq * 100) + '% < 赔率 ' + Math.round(potOdds * 100) + '%）');
    }

    async bettingRound(preflop) {
      if (!preflop) {
        this.currentBet = 0; this.minRaise = BB;
        this.players.forEach(p => { p.bet = 0; p.postAggro = 0; });
      }
      this.players.forEach(p => { p.acted = false; });
      let idx = preflop ? this.nextActive(this.bbIdx) : this.nextActive(this.button);
      let guard = 0;
      this.hooks.render();
      while (!this.roundComplete() && guard++ < 400) {
        const p = this.players[idx];
        if (p.active && !p.allIn && !(p.acted && p.bet === this.currentBet)) {
          const toCall = Math.max(0, this.currentBet - p.bet);
          const potBefore = this.pot;
          this.turnId = p.id;
          this.hooks.render();
          let dec = null;
          if (p.human) {
            const opp = Math.max(1, this.activeCount() - 1);
            const eq = estimateEquity(p.hole, this.community, opp, this.humanEquityIters);
            const potOdds = toCall > 0 ? toCall / (this.pot + toCall) : 0;
            dec = await this.hooks.awaitHuman(p, toCall, this);
            if (dec) { dec._eq = eq; dec._potOdds = potOdds; dec._opp = opp; }
          } else {
            await this.hooks.delay(250 + Math.random() * 550);
            dec = this.botDecide(p, toCall);
          }
          if (!dec) dec = { action: toCall > 0 ? 'fold' : 'check' };
          this.applyDecision(p, dec, toCall);
          this.recActions.push({
            street: this.streetName,
            playerId: p.id, name: p.name, human: !!p.human,
            pos: this.posLabels[p.id] || '',
            action: dec.action,
            amount: dec.action === 'raise' ? Math.round(dec.amount || 0) : (dec.action === 'call' ? toCall : 0),
            toCall: toCall,
            potBefore: potBefore, potAfter: this.pot,
            equity: (dec._eq == null ? null : Math.round(dec._eq * 1000) / 1000),
            opp: (dec._opp == null ? null : dec._opp),
            reason: dec.reason || (p.human ? '人类决策' : ''),
            style: p.human ? '' : (p.styleName || ''),
            board: this.community.slice()
          });
          this.turnId = -1;
          this.hooks.render();
        }
        idx = this.nextActive(idx);
      }
      this.turnId = -1;
      this.hooks.render();
    }

    buildPots() {
      const levels = [...new Set(this.players.filter(p => p.committed > 0).map(p => p.committed))]
        .sort((a, b) => a - b);
      const pots = []; let prev = 0;
      for (const lvl of levels) {
        let amount = 0; const elig = [];
        for (const p of this.players) {
          const contrib = Math.max(0, Math.min(p.committed, lvl) - prev);
          if (contrib > 0) amount += contrib;
          if (p.committed >= lvl && p.active) elig.push(p);
        }
        if (amount > 0) pots.push({ amount, elig });
        prev = lvl;
      }
      return pots;
    }

    async finishHand() {
      this.lastPot = this.totalPot();
      const alive = this.players.filter(p => p.active);
      const results = [];
      if (alive.length === 1) {
        const w = alive[0];
        w.stack += this.pot; w.won += this.pot;
        results.push({ name: w.name, amount: this.pot, label: '无人跟注' });
        this.hooks.log('🏆 ' + w.name + ' 赢得 ' + this.pot + '（其余弃牌）');
      } else {
        const pots = this.buildPots();
        pots.forEach((pot, pi) => {
          let best = -1, winners = [];
          for (const p of pot.elig) {
            if (p.score == null) p.score = score7(p.hole.concat(this.community));
            if (p.score > best) { best = p.score; winners = [p]; }
            else if (p.score === best) winners.push(p);
          }
          if (!winners.length) return;
          const share = Math.floor(pot.amount / winners.length);
          let rem = pot.amount - share * winners.length;
          winners.forEach((w, i) => {
            const g = share + (i < rem ? 1 : 0);
            w.stack += g; w.won += g;
          });
          const hn = handName(best);
          results.push({ name: winners.map(w => w.name).join('、'), amount: pot.amount, label: pots.length > 1 ? '边池 ' + (pi + 1) + ' · ' + hn : hn });
          this.hooks.log('🏆 ' + winners.map(w => w.name).join('、') + ' 赢得 ' + pot.amount + (pots.length > 1 ? '（边池' + (pi + 1) + '）' : '') + ' — ' + hn);
        });
      }
      // 摊牌：为所有有 5 张公共牌的手算牌型名
      for (const p of this.players) {
        if (p.hole.length === 2 && this.community.length === 5) {
          p.handName = handName(score7(p.hole.concat(this.community)));
        } else { p.handName = ''; }
      }
      this.players.forEach(p => { p.shown = true; });
      this.lastResults = results;
      // 人类本场累计输赢（补码单独扣减，不计入盈亏）
      const human = this.players[0];
      if (human && this.stackStart[0] != null) {
        this.sessionNet = (this.sessionNet || 0) + (human.stack - this.stackStart[0]);
      }
      // ---- 生成手牌记录（用于复盘导出）----
      const rec = {
        no: this.handNo,
        time: new Date().toISOString(),
        button: this.players[this.button] ? this.players[this.button].name : '',
        board: this.community.map(cardStr),
        potTotal: this.lastPot,
        blinds: SB + '/' + BB,
        players: this.players.map(p => ({
          id: p.id, name: p.name, human: !!p.human,
          pos: this.posLabels[p.id] || '',
          style: p.human ? '' : (p.styleName || ''),
          hole: p.hole.map(cardStr),
          stackStart: (this.stackStart[p.id] == null ? p.stack : this.stackStart[p.id]),
          stackEnd: p.stack,
          folded: p.folded, allIn: p.allIn,
          won: p.won, handName: p.handName || ''
        })),
        actions: this.recActions.slice(),
        results: results
      };
      this.updateProfiles(this.recActions, this.players);
      rec.profiles = this.profilesSnapshot();
      this.history.push(rec);
      this.pot = 0;
      this.busy = false;
      this.hooks.render();
      this.hooks.onHandEnd(results);
      this.hooks.onHandRecorded(rec);
      return true;
    }

    async runHand() {
      this.streetName = '翻牌前';
      await this.bettingRound(true);
      if (this.activeCount() <= 1) return this.finishHand();
      const streets = [['翻牌', 3], ['转牌', 1], ['河牌', 1]];
      for (const st of streets) {
        if (this.activeCount() <= 1) break;
        for (let k = 0; k < st[1]; k++) this.community.push(this.deck[this.deckPos++]);
        this.streetName = st[0];
        this.hooks.log('—— ' + st[0] + ' ——');
        this.hooks.render();
        await this.bettingRound(false);
      }
      return this.finishHand();
    }

    async startHand() {
      if (this.busy) return false;
      this.busy = true;
      // 买入档位随桌上最大筹码升级；低于大盲的机器人自动补到当前档位
      this.buyIn = this.currentBuyIn();
      for (const p of this.players) {
        if (!p.human && p.stack < BB) {
          p.stack += this.buyIn;
          this.hooks.log('🤖 ' + p.name + ' 自动买入 ' + this.buyIn + ' → ' + p.stack);
        }
      }
      // 风格换挡（只能在两手之间发生）
      if (this.styleCycling) for (const p of this.players) if (!p.human) this.cycleStyle(p);
      const seated = this.players.filter(p => p.stack > 0);
      if (seated.length < 2) {
        this.busy = false;
        this.hooks.log('⚠️ 可用玩家不足 2 人');
        return false;
      }
      this.handNo++;
      this.community = []; this.pot = 0; this.currentBet = 0; this.minRaise = BB;
      this.players.forEach(p => {
        p.hole = []; p.bet = 0; p.committed = 0; p.folded = false; p.allIn = false;
        p.acted = false; p.score = null; p.won = 0; p.lastAction = ''; p.handName = ''; p.shown = false;
        p.rangeFloor = 0; p.postAggro = 0;
        p.active = p.stack > 0;
      });
      this.preflopAggressor = -1;
      this.pfRaises = 0;
      this.deck = [];
      for (let c = 0; c < 52; c++) this.deck.push(c);
      for (let i = this.deck.length - 1; i > 0; i--) {
        const j = Math.floor(deckRnd() * (i + 1));
        const t = this.deck[i]; this.deck[i] = this.deck[j]; this.deck[j] = t;
      }
      this.deckPos = 0;
      this.button = this.nextActive(this.button);
      const n = this.activeCount();
      if (n === 2) { this.sbIdx = this.button; this.bbIdx = this.nextActive(this.sbIdx); }
      else { this.sbIdx = this.nextActive(this.button); this.bbIdx = this.nextActive(this.sbIdx); }
      this.hooks.log('=== 第 ' + this.handNo + ' 手 === 庄家：' + this.players[this.button].name);
      this.postBlind(this.sbIdx, SB, '小盲');
      this.postBlind(this.bbIdx, BB, '大盲');
      this.currentBet = BB; this.minRaise = BB;
      // 位置标签：每手开始时算一次，全程常显（不随行动消失）
      this.stackStart = this.players.map(p => p.stack + p.committed);
      this.posLabels = {};
      this.posLabels[this.button] = '庄家 D';
      this.posLabels[this.sbIdx] = '小盲 SB';
      this.posLabels[this.bbIdx] = '大盲 BB';
      const PLABELS = ['枪口 UTG', '中间 MP', '后位 CO', '枪口+3', '枪口+4'];
      let li = 0, pi = this.nextActive(this.bbIdx), g2 = 0;
      while (pi !== this.sbIdx && g2++ < NUM) {
        if (this.posLabels[pi] === undefined) this.posLabels[pi] = PLABELS[li++] || '后位';
        pi = this.nextActive(pi);
      }
      this.recActions = [];
      this.streetName = '翻牌前';
      for (let r = 0; r < 2; r++) {
        let idx = this.sbIdx;
        for (let k = 0; k < n; k++) { this.players[idx].hole.push(this.deck[this.deckPos++]); idx = this.nextActive(idx); }
      }
      this.hooks.render();
      this.hooks.onHandStart();
      return this.runHand();
    }
  }

  return {
    PokerGame, estimateEquity, estimateEquityRange, preflopPercentile, preflopScore, score7, score5, handName, cardStr,
    SB, BB, limits, setBlinds, START_STACK, NUM, HAND_NAMES, STYLES, PF_OPEN, PF_3BET, PF_CALL_VS_RAISE, STYLE_WEIGHTS, PHASE_MIN, PHASE_MAX,
    BUYIN_TIERS, buyInFor, TUNE, setDeckSeed,
    PLAYER_NAMES: ['你', '老张', '小李', '阿May', '老K', '阿豪']
  };
});
