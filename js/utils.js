'use strict';

/* =========================================================
   drum-box /js/utils.js
   Utilidades compartidas (pulido / v1.1)
   ---------------------------------------------------------
   MISMAS utilidades (y algunas mejoras internas) sin cambiar
   el contrato que ya usan los otros módulos.

   Expone:
   - window.DrumUtils.$ / $$
   - window.DrumUtils.clamp
   - window.DrumUtils.debounce
   - window.DrumUtils.throttle
   - window.DrumUtils.rafThrottle
   - window.DrumUtils.deepClone
   - window.DrumUtils.escapeHtml
   - window.DrumUtils.range
   - window.DrumUtils.step helpers (quarter/eighth/sixteenth)
   - + extras ya existentes: lerp, round, uid, pattern helpers, URL helpers
========================================================= */

(function () {
  // Evitar pisar si ya existía (por si cargan dos veces por error)
  if (window.DrumUtils) {
    // Si el humano promedio duplicó el <script>, no vamos a incendiar la app.
    // Igual dejamos lo existente.
    return;
  }

  // -----------------------------
  // DOM
  // -----------------------------
  const $ = (sel, root = document) => root ? root.querySelector(sel) : null;
  const $$ = (sel, root = document) => root ? Array.from(root.querySelectorAll(sel)) : [];

  // -----------------------------
  // Básicos
  // -----------------------------
  function isFiniteNumber(n) {
    return Number.isFinite(Number(n));
  }

  function clamp(n, min, max) {
    const num = Number(n);
    const a = Number(min);
    const b = Number(max);

    if (!Number.isFinite(num)) return a;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return num;

    return Math.max(a, Math.min(b, num));
  }

  function lerp(a, b, t) {
    const A = Number(a);
    const B = Number(b);
    const T = Number(t);
    if (!Number.isFinite(A) || !Number.isFinite(B) || !Number.isFinite(T)) return NaN;
    return A + (B - A) * T;
  }

  function round(n, precision = 2) {
    const num = Number(n);
    const p = Math.max(0, Math.floor(Number(precision) || 0));
    if (!Number.isFinite(num)) return NaN;
    const m = Math.pow(10, p);
    return Math.round(num * m) / m;
  }

  function range(length, start = 0) {
    const len = Math.max(0, Math.floor(Number(length) || 0));
    const s = Math.floor(Number(start) || 0);
    return Array.from({ length: len }, (_, i) => s + i);
  }

  function deepClone(value) {
    // structuredClone es mejor (maneja Date/Map/etc). JSON es fallback MVP.
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(text) {
    // Seguro y rápido. replaceAll funciona en navegadores modernos.
    // Si quieres compat ancestral, toca polyfill (no recomendado en 2026).
    return String(text ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function uid(prefix = 'id') {
    // crypto.randomUUID si existe (mejor), si no: fallback
    try {
      if (window.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
    } catch (_) {}

    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${Date.now().toString(36)}_${rand}`;
  }

  // -----------------------------
  // Tiempo / performance
  // -----------------------------
  function debounce(fn, wait = 120) {
    let t = null;
    return function debounced(...args) {
      const ctx = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(ctx, args), Math.max(0, Number(wait) || 0));
    };
  }

  function throttle(fn, wait = 120) {
    let last = 0;
    let timeout = null;
    let pendingArgs = null;
    let pendingThis = null;

    function invoke() {
      last = Date.now();
      timeout = null;
      fn.apply(pendingThis, pendingArgs);
      pendingArgs = pendingThis = null;
    }

    return function throttled(...args) {
      const now = Date.now();
      const w = Math.max(0, Number(wait) || 0);
      const remaining = w - (now - last);

      pendingArgs = args;
      pendingThis = this;

      if (remaining <= 0 || remaining > w) {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        invoke();
      } else if (!timeout) {
        timeout = setTimeout(invoke, remaining);
      }
    };
  }

  function rafThrottle(fn) {
    let queued = false;
    let lastArgs = null;
    let lastThis = null;

    return function throttled(...args) {
      lastArgs = args;
      lastThis = this;
      if (queued) return;
      queued = true;

      requestAnimationFrame(() => {
        queued = false;
        fn.apply(lastThis, lastArgs);
      });
    };
  }

  // -----------------------------
  // Ritmo / pasos (MVP)
  // -----------------------------
  function isQuarterStep(stepIndex, stepsPerBeat = 4) {
    const i = Number(stepIndex) || 0;
    const spb = Number(stepsPerBeat) || 4;
    return spb !== 0 ? (i % spb === 0) : false;
  }

  function isEighthStep(stepIndex, stepsPerBeat = 4) {
    // especialmente válido cuando stepsPerBeat = 4
    const spb = Number(stepsPerBeat) || 4;
    if (spb !== 4) return false;
    const i = Number(stepIndex) || 0;
    return (i % 4 === 2);
  }

  function isSixteenthStep(stepIndex, stepsPerBeat = 4) {
    const spb = Number(stepsPerBeat) || 4;
    if (spb !== 4) return false;
    const i = Number(stepIndex) || 0;
    const m = i % 4;
    return m === 1 || m === 3;
  }

  function getSubdivisionClass(stepIndex, stepsPerBeat = 4) {
    if (isQuarterStep(stepIndex, stepsPerBeat)) return 'quarter';
    if (isEighthStep(stepIndex, stepsPerBeat)) return 'eighth';
    return 'sixteenth';
  }

  function getBeatIndex(stepIndex, stepsPerBeat = 4) {
    const i = Number(stepIndex) || 0;
    const spb = Number(stepsPerBeat) || 4;
    return Math.floor(i / spb);
  }

  function getStepInBeat(stepIndex, stepsPerBeat = 4) {
    const spb = Number(stepsPerBeat) || 4;
    const n = Number(stepIndex) || 0;
    return ((n % spb) + spb) % spb;
  }

  function getCountToken(stepIndex, {
    stepsPerBeat = 4,
    beatsPerBar = 4,
    countMode = 'full'
  } = {}) {
    const spb = Number(stepsPerBeat) || 4;
    const bpb = Number(beatsPerBar) || 4;
    const step = Number(stepIndex) || 0;

    const barLen = spb * bpb;
    const stepInBar = ((step % barLen) + barLen) % barLen;
    const posInBeat = stepInBar % spb;
    const beatNum = Math.floor(stepInBar / spb) + 1;

    if (spb === 4) {
      if (countMode === 'simple') {
        if (posInBeat === 0) return String(beatNum);
        if (posInBeat === 2) return '&';
        return '';
      }
      return [String(beatNum), 'e', '&', 'a'][posInBeat] || '';
    }

    // fallback genérico
    return posInBeat === 0 ? String(beatNum) : '';
  }

  // -----------------------------
  // Pattern helpers
  // -----------------------------
  function makeBoolArray(length = 16, fill = false) {
    const len = Math.max(0, Math.floor(Number(length) || 0));
    return Array(len).fill(!!fill);
  }

  function ensureBoolArray(arr, length = 16) {
    const out = makeBoolArray(length, false);
    if (!Array.isArray(arr)) return out;
    for (let i = 0; i < out.length; i++) out[i] = !!arr[i];
    return out;
  }

  function patternHasAnyNote(pattern) {
    if (!pattern || typeof pattern !== 'object') return false;
    return Object.values(pattern).some(arr => Array.isArray(arr) && arr.some(Boolean));
  }

  function patternClone(pattern, length = 16) {
    if (!pattern || typeof pattern !== 'object') return {};
    const out = {};
    for (const [k, arr] of Object.entries(pattern)) {
      out[k] = ensureBoolArray(arr, length);
    }
    return out;
  }

  // -----------------------------
  // URL helpers
  // -----------------------------
  function toQueryString(obj = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) {
      if (v == null) continue;
      params.set(k, String(v));
    }
    return params.toString();
  }

  function fromQueryString(search = window.location.search) {
    const out = {};
    const params = new URLSearchParams(search);
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
  }

  // -----------------------------
  // Exposición global
  // -----------------------------
  window.DrumUtils = {
    // DOM
    $,
    $$,

    // básicos
    isFiniteNumber,
    clamp,
    lerp,
    round,
    range,
    deepClone,
    escapeHtml,
    uid,

    // performance
    debounce,
    throttle,
    rafThrottle,

    // ritmo / pasos
    isQuarterStep,
    isEighthStep,
    isSixteenthStep,
    getSubdivisionClass,
    getBeatIndex,
    getStepInBeat,
    getCountToken,

    // pattern
    makeBoolArray,
    ensureBoolArray,
    patternHasAnyNote,
    patternClone,

    // URL
    toQueryString,
    fromQueryString,
  };
})();