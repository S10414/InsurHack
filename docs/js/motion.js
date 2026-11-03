/*
 * Motion: Lenis smooth scrolling + GSAP.
 *   - one page-load sequence (headline, counters, bars rising month by month)
 *   - one scroll moment: the hero is pinned while the field tilts to a top-down heat map
 *   - responses to user actions only: tab change, chart reveal after a new selection
 * Falls back to instant states when the libraries are missing or the user prefers reduced motion.
 */
(function (root) {
  'use strict';
  const gsap = root.gsap, ST = root.ScrollTrigger;
  const reduced = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const on = !!gsap && !reduced;
  let lenis = null, field = null, pinTrigger = null;

  function init() {
    if (!on) return;
    if (ST) gsap.registerPlugin(ST);
    if (root.Lenis) {
      lenis = new root.Lenis({ lerp: 0.11, smoothWheel: true, wheelMultiplier: 0.95 });
      if (ST) lenis.on('scroll', ST.update);
      gsap.ticker.add((t) => lenis.raf(t * 1000));
      gsap.ticker.lagSmoothing(0);
    }
  }

  function countUp(el) {
    const end = parseFloat(el.dataset.v), dec = +(el.dataset.d || 0);
    const fmt = (v) => v.toLocaleString('zh-TW', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    if (!on || !Number.isFinite(end)) { el.textContent = fmt(end); return null; }
    const o = { v: 0 };
    return gsap.to(o, { v: end, duration: 1.4, ease: 'power3.out', onUpdate: () => { el.textContent = fmt(o.v); } });
  }

  /** Page-load sequence. Plays once; later data changes only re-grow the bars. */
  function heroIntro(f) {
    field = f;
    const nums = document.querySelectorAll('.hero-title [data-v]');
    if (!on) { nums.forEach(countUp); if (field) field.setGrow(2); return; }
    const g = { v: 0 };
    const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
    tl.from('.hero-title .ln > span', { yPercent: 105, duration: 0.9, stagger: 0.1 }, 0)
      .add(() => nums.forEach(countUp), 0.15)
      .from('.hero-sub', { opacity: 0, y: 8, duration: 0.6 }, 0.35)
      .from('.hero-legend li', { opacity: 0, x: -8, duration: 0.5, stagger: 0.06 }, 0.45);
    if (field) tl.to(g, { v: 2, duration: 2.2, ease: 'power2.out', onUpdate: () => field.setGrow(g.v) }, 0.2);
  }

  function regrow() {
    if (!field) return;
    if (!on) { field.setGrow(2); return; }
    const g = { v: 0.6 };
    gsap.to(g, { v: 2, duration: 1.1, ease: 'power2.out', onUpdate: () => field.setGrow(g.v) });
  }

  function refreshHeroNumbers() { document.querySelectorAll('.hero-title [data-v]').forEach(countUp); }

  /** Pin the hero and tilt the field to a top-down view as the reader scrolls into the tool. */
  function pinHero(heroEl, f) {
    field = f;
    if (!on || !ST || !f) return;
    const tilt = { t: 0 };
    pinTrigger = gsap.timeline({
      scrollTrigger: { trigger: heroEl, start: 'top top', end: '+=75%', pin: true, scrub: 0.7, anticipatePin: 1 },
    });
    pinTrigger.to(tilt, { t: 1, ease: 'none', onUpdate: () => f.setTilt(tilt.t) }, 0)
      .to(".hero-copy", { opacity: 0, y: -24, ease: "none" }, 0)
      .to('.scroll-cue', { opacity: 0, ease: 'none', duration: 0.2 }, 0);
  }

  function toTools() {
    const nav = document.getElementById('nav');
    if (!nav) return;
    const top = nav.getBoundingClientRect().top + root.scrollY;
    if (root.scrollY <= top + 2) return;          // already above the tool: stay
    if (lenis) lenis.scrollTo(top, { duration: 0.7 }); else root.scrollTo(0, top);
  }
  function goTools() {
    const nav = document.getElementById('nav');
    const top = nav.getBoundingClientRect().top + root.scrollY;
    if (lenis) lenis.scrollTo(top, { duration: 1.4, easing: (x) => 1 - Math.pow(1 - x, 4) }); else root.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
  }

  function tabEnter(el) {
    if (!on) return;
    gsap.fromTo(el, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.32, ease: 'power2.out', clearProps: 'transform' });
  }

  /** Reveal a chart left to right (clip rect inside the SVG). */
  function revealChart(el) {
    const r = el && el.querySelector('.reveal-rect');
    if (!r) return;
    const w = r.getAttribute('data-w');
    if (!on) { r.setAttribute('width', w); return; }
    gsap.fromTo(r, { attr: { width: 0 } }, { attr: { width: w }, duration: 1.0, ease: 'power2.inOut' });
  }
  function revealBars(el) {
    if (!on || !el) return;
    gsap.from(el.querySelectorAll('rect.wf'), { opacity: 0, y: 8, duration: 0.45, stagger: 0.035, ease: 'power2.out' });
  }

  function refresh() { if (on && ST) ST.refresh(); }

  root.FPAMotion = { init, heroIntro, regrow, refreshHeroNumbers, pinHero, toTools, goTools, tabEnter, revealChart, revealBars, refresh, get enabled() { return on; } };
})(window);
