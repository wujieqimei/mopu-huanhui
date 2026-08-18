/* =========================================================
   茶裙画隅 · 背景与氛围层（独立模块，不触碰数据逻辑）
   - 飘落抹茶花瓣 / 茶叶粒子（Canvas，可一键开关）
   - 和风涟漪纹样 + 顶部柔光晕 + 鼠标视差
   - 欢迎页「推开画阁之门」晕开过渡
   兼容 reduced-motion，开关状态存 localStorage
   ========================================================= */
(function () {
  "use strict";

  const STORAGE_KEY = "mopu_petals";
  const reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // 花瓣开关状态（默认开启）
  let enabled = localStorage.getItem(STORAGE_KEY) !== "off";

  /* ---------- 花瓣 Canvas ---------- */
  const canvas = document.getElementById("bgPetals");
  let ctx = null, W = 0, H = 0, DPR = 1;
  let petals = [], raf = null, running = false;
  const COLORS = ["#a8c686", "#7a9b5e", "#5b7a43", "#c7dab0", "#d9e6c3"];

  function resize() {
    if (!canvas) return;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    if (ctx) ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function spawn(initial) {
    const r = 5 + Math.random() * 9;
    return {
      x: Math.random() * W,
      y: initial ? Math.random() * H : -r - Math.random() * 40,
      r: r,
      speed: 0.35 + Math.random() * 0.85,
      sway: 0.4 + Math.random() * 0.9,
      swaySpeed: 0.6 + Math.random() * 1.1,
      phase: Math.random() * Math.PI * 2,
      rot: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.04,
      opacity: 0.35 + Math.random() * 0.45,
      color: COLORS[(Math.random() * COLORS.length) | 0],
    };
  }

  function buildPetals() {
    const count = Math.max(10, Math.min(40, Math.round(W / 38)));
    petals = [];
    for (let i = 0; i < count; i++) petals.push(spawn(true));
  }

  function drawPetal(p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.globalAlpha = p.opacity;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    const r = p.r;
    ctx.moveTo(0, -r);
    ctx.bezierCurveTo(r * 0.65, -r * 0.5, r * 0.65, r * 0.5, 0, r);
    ctx.bezierCurveTo(-r * 0.65, r * 0.5, -r * 0.65, -r * 0.5, 0, -r);
    ctx.fill();
    ctx.restore();
  }

  let t = 0;
  function loop() {
    t += 0.016;
    ctx.clearRect(0, 0, W, H);
    for (const p of petals) {
      p.y += p.speed;
      p.x += Math.sin(t * p.swaySpeed + p.phase) * p.sway;
      p.rot += p.rotSpeed;
      if (p.y - p.r > H) {
        p.x = Math.random() * W;
        p.y = -p.r - Math.random() * 30;
      }
      drawPetal(p);
    }
    raf = requestAnimationFrame(loop);
  }

  function startPetals() {
    if (!canvas || !ctx) return;
    if (running) return;
    running = true;
    if (reduceMotion) {
      // 静态分布一帧，不持续飘动
      ctx.clearRect(0, 0, W, H);
      for (const p of petals) drawPetal(p);
      running = false;
      return;
    }
    loop();
  }

  function stopPetals() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    running = false;
    if (ctx) ctx.clearRect(0, 0, W, H);
  }

  function applyPetals() {
    if (enabled) startPetals();
    else stopPetals();
    updateToggleUI();
  }

  /* ---------- 鼠标视差 ---------- */
  let parallaxBound = false;
  function bindParallax() {
    if (parallaxBound || reduceMotion) return;
    parallaxBound = true;
    const pattern = document.querySelector(".bg-pattern");
    const glow = document.querySelector(".bg-glow");
    window.addEventListener("mousemove", (e) => {
      const nx = (e.clientX / window.innerWidth - 0.5);
      const ny = (e.clientY / window.innerHeight - 0.5);
      if (pattern) pattern.style.transform =
        `translate(${nx * -14}px, ${ny * -10}px)`;
      if (glow) glow.style.transform =
        `translate(calc(-50% + ${nx * 26}px), ${ny * 18}px)`;
    }, { passive: true });
  }

  /* ---------- 开关按钮 ---------- */
  function updateToggleUI() {
    document.querySelectorAll("#petalToggle").forEach((btn) => {
      btn.classList.toggle("is-off", !enabled);
      if (btn.dataset.mode === "text") {
        btn.textContent = "🍃 花瓣飘落：" + (enabled ? "开" : "关");
      }
    });
  }

  function bindToggle() {
    document.querySelectorAll("#petalToggle").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        enabled = !enabled;
        localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
        applyPetals();
      });
    });
  }

  /* ---------- 欢迎页入场过渡（晕开） ---------- */
  let curtainPlaying = false;
  function bindCurtain() {
    const welcome = document.querySelector(".welcome-page");
    const curtain = document.getElementById("curtain");
    if (!welcome || !curtain) return;
    // capture 阶段拦截，阻止 main.js 的 body 冒泡跳转
    document.body.addEventListener("click", (e) => {
      if (curtainPlaying) { e.preventDefault(); e.stopPropagation(); return; }
      if (e.target.closest(".auth") || e.target.closest(".login") ||
          e.target.closest("#petalToggle")) return;
      e.stopPropagation();
      curtainPlaying = true;
      curtain.style.setProperty("--cx", (e.clientX || W / 2) + "px");
      curtain.style.setProperty("--cy", (e.clientY || H / 2) + "px");
      // 触发重排以确保过渡生效
      void curtain.offsetWidth;
      curtain.classList.add("is-open");
      setTimeout(() => { window.location.href = "gallery.html"; }, 740);
    }, true);
  }

  /* ---------- 初始化 ---------- */
  function init() {
    if (canvas) {
      ctx = canvas.getContext("2d");
      resize();
      buildPetals();
      window.addEventListener("resize", () => {
        resize();
        buildPetals();
        if (enabled && !running) applyPetals();
      });
    }
    bindParallax();
    bindToggle();
    bindCurtain();
    applyPetals();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
