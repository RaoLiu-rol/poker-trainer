/*
 * i18n.js — 运行时多语言层
 * 设计：以中文原文为 key，渲染后对 DOM 文本做最长匹配替换，避免改动上百处渲染代码。
 * 用法：I18N.register('en', {...}); I18N.setLang('en');
 */
(function (root) {
  'use strict';

  const LANGS = [
    { code: 'zh', name: '简体中文', short: '中' },
    { code: 'en', name: 'English', short: 'EN' },
    { code: 'ja', name: '日本語', short: '日' },
    { code: 'ko', name: '한국어', short: '한' },
    { code: 'es', name: 'Español', short: 'ES' },
    { code: 'pt', name: 'Português', short: 'PT' },
    { code: 'de', name: 'Deutsch', short: 'DE' },
    { code: 'fr', name: 'Français', short: 'FR' }
  ];

  const I18N = {
    lang: 'zh',
    dicts: {},
    LANGS,
    _pairs: {},
    _applying: false
  };

  I18N.register = function (code, dict) {
    if (!dict) return;
    I18N.dicts[code] = dict;
    const pairs = Object.keys(dict)
      .filter((k) => k && dict[k] && dict[k] !== k)
      .map((k) => [k, dict[k]])
      .sort((a, b) => b[0].length - a[0].length);
    I18N._pairs[code] = pairs;
  };

  I18N.t = function (s) {
    const d = I18N.dicts[I18N.lang];
    if (!d) return s;
    return d[s] != null ? d[s] : s;
  };

  const PLURAL = {
    en: [[/\b1 (hands|chips|times|wins|games|players|days|characters)\b/g,
      (m, w) => '1 ' + ({ hands: 'hand', chips: 'chip', times: 'time', wins: 'win', games: 'game', players: 'player', days: 'day', characters: 'character' }[w])]],
    es: [[/\b1 (manos|fichas|veces|días|jugadores|caracteres)\b/g,
      (m, w) => '1 ' + ({ manos: 'mano', fichas: 'ficha', veces: 'vez', días: 'día', jugadores: 'jugador', caracteres: 'carácter' }[w])]],
    pt: [[/\b1 (mãos|fichas|vezes|dias|jogadores|caracteres)\b/g,
      (m, w) => '1 ' + ({ mãos: 'mão', fichas: 'ficha', vezes: 'vez', dias: 'dia', jogadores: 'jogador', caracteres: 'caractere' }[w])]],
    de: [[/\b1 (Hände|Chips|Mal|Tage|Spieler|Zeichen)\b/g,
      (m, w) => '1 ' + ({ Hände: 'Hand', Chips: 'Chip', Mal: 'Mal', Tage: 'Tag', Spieler: 'Spieler', Zeichen: 'Zeichen' }[w])]],
    fr: [[/\b1 (mains|jetons|fois|jours|joueurs|caractères)\b/g,
      (m, w) => '1 ' + ({ mains: 'main', jetons: 'jeton', fois: 'fois', jours: 'jour', joueurs: 'joueur', caractères: 'caractère' }[w])]]
  };
  function fixPlurals(txt, lang) {
    const rules = PLURAL[lang];
    if (!rules) return txt;
    let out = txt;
    for (const [re, fn] of rules) out = out.replace(re, fn);
    return out;
  }

  // 任意字符串翻译（用于导出文件、日志等非 DOM 文本）
  I18N.tr = function (s) {
    if (I18N.lang === 'zh' || !s) return s;
    const pairs = I18N._pairs[I18N.lang];
    if (!pairs) return s;
    return fixPlurals(translateText(String(s), pairs), I18N.lang);
  };

  function translateText(txt, pairs) {
    let out = txt;
    for (let i = 0; i < pairs.length; i++) {
      const src = pairs[i][0];
      if (out.indexOf(src) >= 0) out = out.split(src).join(pairs[i][1]);
    }
    return out;
  }

  I18N.apply = function (node) {
    if (I18N.lang === 'zh' || I18N._applying) return;
    const pairs = I18N._pairs[I18N.lang];
    if (!pairs || !pairs.length || !node) return;
    I18N._applying = true;
    try {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
      const targets = [];
      let n;
      while ((n = walker.nextNode())) {
        if (/[\u4e00-\u9fa5]/.test(n.nodeValue)) targets.push(n);
      }
      targets.forEach((t) => {
        const v = fixPlurals(translateText(t.nodeValue, pairs), I18N.lang);
        if (v !== t.nodeValue) t.nodeValue = v;
      });
      // 属性：title / placeholder / aria-label
      const els = node.querySelectorAll ? node.querySelectorAll('[title],[placeholder],[aria-label]') : [];
      els.forEach((el) => {
        ['title', 'placeholder', 'aria-label'].forEach((a) => {
          const v = el.getAttribute(a);
          if (v && /[\u4e00-\u9fa5]/.test(v)) {
            const nv = translateText(v, pairs);
            if (nv !== v) el.setAttribute(a, nv);
          }
        });
      });
    } finally {
      I18N._applying = false;
    }
  };

  I18N.setLang = function (code, silent) {
    if (code !== 'zh' && !I18N.dicts[code]) code = 'en';
    I18N.lang = code;
    try { localStorage.setItem('poker.lang.v1', code); } catch (e) {}
    // 用户主动选择优先于 URL 的 ?lang=xx（否则刷新后又被参数覆盖）
    try {
      const u = new URL(location.href);
      if (u.searchParams.has('lang')) {
        u.searchParams.delete('lang');
        history.replaceState(null, '', u.toString());
      }
    } catch (e) {}
    document.documentElement.setAttribute('lang', code === 'zh' ? 'zh-CN' : code);
    if (!silent) {
      // 中文原文可能已被替换，重载最稳
      location.reload();
    }
  };

  I18N.detect = function () {
    try {
      const q = new URLSearchParams(location.search).get('lang');
      if (q && (q === 'zh' || I18N.dicts[q])) return q;
    } catch (e) {}
    try {
      const saved = localStorage.getItem('poker.lang.v1');
      if (saved && (saved === 'zh' || I18N.dicts[saved])) return saved;
    } catch (e) {}
    const nav = (navigator.language || 'en').toLowerCase();
    const map = [['zh', 'zh'], ['ja', 'ja'], ['ko', 'ko'], ['es', 'es'], ['pt', 'pt'], ['de', 'de'], ['fr', 'fr'], ['en', 'en']];
    for (const [k, v] of map) if (nav.indexOf(k) === 0) return I18N.dicts[v] ? v : 'en';
    return I18N.dicts.en ? 'en' : 'zh';
  };

  I18N.init = function () {
    I18N.lang = I18N.detect();
    document.documentElement.setAttribute('lang', I18N.lang === 'zh' ? 'zh-CN' : I18N.lang);
    // 标题也本地化
    try {
      if (!I18N._origTitle) I18N._origTitle = document.title;
      document.title = I18N.lang === 'zh' ? I18N._origTitle : I18N.tr(I18N._origTitle);
    } catch (e) {}
    if (I18N.lang !== 'zh') {
      I18N.apply(document.body);
      // 动态渲染的内容也自动翻译
      let queued = false;
      const schedule = () => {
        if (queued || I18N._applying) return;
        queued = true;
        const run = () => { queued = false; I18N.apply(document.body); };
        if (window.requestAnimationFrame) requestAnimationFrame(() => setTimeout(run, 40));
        else setTimeout(run, 60);
      };
      const mo = new MutationObserver(schedule);
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
  };

  root.I18N = I18N;
})(typeof window !== 'undefined' ? window : this);
