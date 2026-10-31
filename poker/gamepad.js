/* Texas Hold'em Trainer — Copyright (c) 2026 raollll. All rights reserved. */
/* gamepad.js — Xbox / 标准手柄控制（Gamepad API） */
(function () {
  'use strict';

  const DEAD = 0.55;
  const REPEAT_MS = 170;

  const st = {
    prev: [],           // 上一帧按钮状态
    focus: -1,          // 当前焦点索引
    lastNav: 0,
    connected: false,
    hintShown: false
  };

  const $ = (s) => document.querySelector(s);
  const overlayShown = () => {
    const ov = $('#overlay');
    return !!(ov && ov.classList.contains('show'));
  };

  function focusables() {
    if (overlayShown()) {
      const list = [...document.querySelectorAll('#ovBtns button')].filter((b) => !b.disabled && b.offsetParent !== null);
      return list.length ? list : [...document.querySelectorAll('#overlay button')].filter((b) => !b.disabled);
    }
    return [1, 0, 2].map((i) => document.getElementById(['btnFold', 'btnCall', 'btnRaise'][i])).filter(Boolean);
  }

  function setFocus(idx) {
    const list = focusables();
    if (!list.length) return;
    document.querySelectorAll('.gp-focus').forEach((e) => e.classList.remove('gp-focus'));
    st.focus = ((idx % list.length) + list.length) % list.length;
    const el = list[st.focus];
    el.classList.add('gp-focus');
    try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
  }

  function moveFocus(dir) {
    const list = focusables();
    if (!list.length) return;
    if (st.focus < 0) st.focus = 0;
    setFocus(st.focus + dir);
  }

  function activate() {
    const list = focusables();
    if (!list.length) return false;
    if (st.focus < 0) st.focus = 0;
    const el = list[st.focus] || list[0];
    if (!el || el.disabled) return false;
    el.click();
    return true;
  }

  function back() {
    if (!overlayShown()) return false;
    const btns = [...document.querySelectorAll('#ovBtns button, #overlay button')];
    const b = btns.find((x) => /返回|Back|Zurück|Retour|Volver|Voltar|뒤로|戻る|关闭|Close/i.test(x.textContent));
    if (b) { b.click(); return true; }
    return false;
  }

  function bumpSlider(step) {
    const s = document.getElementById('slider');
    if (!s) return false;
    const min = Number(s.min || 0), max = Number(s.max || 100), cur = Number(s.value || 0);
    s.value = String(Math.max(min, Math.min(max, cur + step)));
    s.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom));transform:translateX(-50%);' +
      'background:rgba(0,0,0,.86);color:#f4f1e8;padding:10px 16px;border-radius:999px;font-size:14px;z-index:9999;' +
      'border:1px solid rgba(243,217,141,.45);pointer-events:none';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  function handle(idx, buttons) {
    const pressed = (i) => !!(buttons[i] && buttons[i].pressed);
    const was = (i) => !!st.prev[i];
    const hit = (i) => pressed(i) && !was(i);

    const inOverlay = overlayShown();

    // 对局中：固定映射，不依赖焦点
    if (!inOverlay) {
      if (hit(0)) { const c = document.getElementById('btnCall'); if (c && !c.disabled) c.click(); }
      else if (hit(1)) { const f = document.getElementById('btnFold'); if (f && !f.disabled) f.click(); }
      else if (hit(2)) { const r = document.getElementById('btnRaise'); if (r && !r.disabled) r.click(); }
      else if (hit(3)) {
        const s = document.getElementById('slider');
        if (s) { s.value = s.max; s.dispatchEvent(new Event('input', { bubbles: true })); }
      } else if (hit(4)) bumpSlider(-10);
      else if (hit(5)) bumpSlider(10);
      st.prev = buttons.map((b) => !!(b && b.pressed));
      return;
    }

    // 方向：十字键 + 左摇杆
    const now = Date.now();
    const navLeft = hit(14) || hit(13) || (pressed(14) && now - st.lastNav > REPEAT_MS);
    const navRight = hit(15) || hit(12) || (pressed(15) && now - st.lastNav > REPEAT_MS);
    if (navLeft || navRight) {
      if (inOverlay || true) { moveFocus(navLeft ? -1 : 1); st.lastNav = now; }
      return;
    }

    if (hit(0)) {            // A
      if (!activate() && !inOverlay) { const c = document.getElementById('btnCall'); if (c && !c.disabled) c.click(); }
    } else if (hit(1)) {     // B
      if (!back() && !inOverlay) { const f = document.getElementById('btnFold'); if (f && !f.disabled) f.click(); }
    } else if (hit(2)) {     // X
      const r = document.getElementById('btnRaise'); if (r && !r.disabled) r.click();
    } else if (hit(3)) {     // Y：全下尺度
      const s = document.getElementById('slider');
      if (s) { s.value = s.max; s.dispatchEvent(new Event('input', { bubbles: true })); }
    } else if (hit(4)) {     // LB
      bumpSlider(-10);
    } else if (hit(5)) {     // RB
      bumpSlider(10);
    } else if (hit(9)) {     // Start/Menu
      const h = document.getElementById('btnHist'); if (h) h.click();
    }

    st.prev = buttons.map((b) => !!(b && b.pressed));
  }

  function loop() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (let i = 0; i < pads.length; i++) { if (pads[i] && pads[i].connected) { pad = pads[i]; break; } }

    if (!pad) {
      if (st.connected) { st.connected = false; st.focus = -1; document.querySelectorAll('.gp-focus').forEach((e) => e.classList.remove('gp-focus')); }
      requestAnimationFrame(loop);
      return;
    }

    if (!st.connected) {
      st.connected = true;
      if (!st.hintShown) {
        st.hintShown = true;
        toast('🎮 手柄已连接：A 确认 / B 返回或弃牌 / X 加注 / Y 全下 / LB·RB 调尺度');
      }
      setTimeout(() => setFocus(0), 300);
    }

    // 摇杆当作方向
    const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
    const btns = pad.buttons.map((b) => b);
    if (Math.abs(ax) > DEAD && Date.now() - st.lastNav > REPEAT_MS) {
      moveFocus(ax > 0 ? 1 : -1); st.lastNav = Date.now();
    }
    if (Math.abs(ay) > DEAD && Date.now() - st.lastNav > REPEAT_MS) {
      moveFocus(ay > 0 ? 1 : -1); st.lastNav = Date.now();
    }

    handle(0, btns);
    requestAnimationFrame(loop);
  }

  if ('getGamepads' in navigator) requestAnimationFrame(loop);

  // 供自动化测试使用
  window.__gp = { setFocus, moveFocus, activate, back, state: st };
})();
