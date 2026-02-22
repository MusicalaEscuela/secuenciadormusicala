'use strict';

/* =========================================================
   drum-box /js/notation.js
   Partitura (vista generada) en SVG (mejorado / v1.4)
   ---------------------------------------------------------
   MISMAS funciones, mejor rendimiento + layout más sólido:
   - Render en 2 capas: layout fijo (fondo/pentagrama/guías) + notas (dinámico)
   - No borra TODO el SVG cada vez: solo actualiza el grupo de notas + hint
   - Rebuild completo SOLO si cambia estructura (steps, stepsPerBeat, beatsPerBar, bars)
   - Usa DrumUtils (si existe) para clamp/rafThrottle/safe helpers
   - FIX: compás (4/4) ya NO se superpone con labels (gutter izquierdo real)

   Requiere:
   - state.js (window.DrumState)

   Expone:
   - window.DrumNotation.init(svgEl, state, { onRender })
   - window.DrumNotation.render(state)
   - window.DrumNotation.refreshFromState(state)  // alias
========================================================= */

(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let svg = null;
  let callbacks = { onRender: null };

  // Cache de estructura para decidir si toca reconstruir layout
  let layoutCache = {
    steps: 16,
    stepsPerBeat: 4,
    beatsPerBar: 4,
    bars: 1,
  };

  // Referencias a capas (para actualizar sin borrar todo)
  let gRoot = null;
  let gStatic = null;
  let gNotes = null;
  let gHint = null;

  // Cache mínimo para evitar trabajo redundante
  let lastPatternSignature = '';

  // -----------------------------
  // Utils (con fallbacks)
  // -----------------------------
  const Utils = window.DrumUtils || null;

  const clamp = Utils?.clamp || ((n, a, b) => Math.max(a, Math.min(b, Number(n))));
  const rafThrottle = Utils?.rafThrottle || ((fn) => {
    let queued = false;
    let lastArgs = null;
    return (...args) => {
      lastArgs = args;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        fn(...lastArgs);
      });
    };
  });

  // -----------------------------
  // Helpers
  // -----------------------------
  function getState() {
    const S = window.DrumState;
    if (S && typeof S.get === 'function') return S.get();
    return null;
  }

  function elNS(name, attrs = {}) {
    const n = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      n.setAttribute(k, String(v));
    }
    return n;
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function safeInt(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : fallback;
  }

  function emit(name, payload) {
    const fn = callbacks[name];
    if (typeof fn !== 'function') return;
    try { fn(payload); } catch (e) { console.warn('[notation.js] callback error:', e); }
  }

  function isQuarterStep(i, stepsPerBeat) {
    return i % stepsPerBeat === 0;
  }

  function isEighthStep(i, stepsPerBeat) {
    // para semicorcheas (4 por pulso), la corchea cae en offset 2
    if (stepsPerBeat !== 4) return false;
    return i % stepsPerBeat === 2;
  }

  // Firma simple para evitar re-render de notas si el patrón no cambió
  function patternSignature(pattern, steps) {
    const hh = Array.isArray(pattern?.hh) ? pattern.hh : [];
    const sn = Array.isArray(pattern?.sn) ? pattern.sn : [];
    const bd = Array.isArray(pattern?.bd) ? pattern.bd : [];

    const collect = (arr) => {
      let out = '';
      for (let i = 0; i < steps; i++) if (arr[i]) out += i + ',';
      return out;
    };

    return `hh:${collect(hh)}|sn:${collect(sn)}|bd:${collect(bd)}`;
  }

  // -----------------------------
  // Layout (métricas)
  // -----------------------------
  function getLayout(state) {
    const steps = safeInt(state?.steps, 16);
    const stepsPerBeat = safeInt(state?.stepsPerBeat, 4);
    const beatsPerBar = safeInt(state?.beatsPerBar, 4);
    const bars = safeInt(state?.bars, 1);

    // === Área izquierda (labels + compás) ===
    // Antes: leftPad fijo 120 y compás en leftPad-42 => se montaba con "Redoblante".
    // Ahora: reservamos un gutter real.
    const labelX = 18;              // donde arranca el texto de los instrumentos
    const labelFontPx = 12;
    const approxCharW = 0.58 * labelFontPx; // estimación razonable para Inter a 12px
    const labels = ['Hi-hat', 'Redoblante', 'Bombo'];
    const maxLabelChars = labels.reduce((m, t) => Math.max(m, String(t).length), 0);
    const labelsW = Math.ceil(maxLabelChars * approxCharW);

    // Espacios:
    const gapAfterLabels = 14;       // aire entre labels y zona del compás
    const timeSigBoxW = 44;          // ancho aprox del "4/4" (y centrado)
    const timeSigGapToStaff = 10;    // aire entre compás y barra inicial

    // leftPad = inicio del pentagrama (x del staff)
    const leftPad = Math.max(
      140, // mínimo sano (evita layout apretado)
      labelX + labelsW + gapAfterLabels + timeSigBoxW + timeSigGapToStaff
    );

    const rightPad = 24;
    const topPad = 22;

    const staffTop = 58;
    const staffLineGap = 14;
    const staffLines = 5;

    // Ancho por paso: ahora sí depende de steps para no volverse “chorizo” o “microtexto”
    // Target: que la partitura se vea bien entre ~960 y ~1180 px (sin depender del CSS)
    const targetStaffW = clamp(980, 860, 1180);
    const stepW = clamp(targetStaffW / Math.max(1, steps), 26, 44);

    const width = leftPad + rightPad + (steps * stepW);
    const height = 220;

    // Y de instrumentos (legible)
    const yHH = staffTop + staffLineGap * 0.5;
    const ySN = staffTop + staffLineGap * 2.0;
    const yBD = staffTop + staffLineGap * 3.8;

    const x0 = leftPad;
    const xStep = (i) => x0 + (i + 0.5) * stepW;

    // Compás: lo centramos en la “caja” reservada antes del staff
    const timeSigX = leftPad - (timeSigBoxW * 0.5) - timeSigGapToStaff;

    return {
      steps, stepsPerBeat, beatsPerBar, bars,
      width, height,
      leftPad, rightPad, topPad,
      staffTop, staffLineGap, staffLines,
      yHH, ySN, yBD,
      stepW,
      x0,
      xStep,

      // para dibujar mejor
      labelX,
      timeSigX,
    };
  }

  function structureChanged(state) {
    const steps = safeInt(state?.steps, 16);
    const stepsPerBeat = safeInt(state?.stepsPerBeat, 4);
    const beatsPerBar = safeInt(state?.beatsPerBar, 4);
    const bars = safeInt(state?.bars, 1);

    return (
      steps !== layoutCache.steps ||
      stepsPerBeat !== layoutCache.stepsPerBeat ||
      beatsPerBar !== layoutCache.beatsPerBar ||
      bars !== layoutCache.bars
    );
  }

  // -----------------------------
  // Dibujo: capa estática (una sola vez por estructura)
  // -----------------------------
  function drawStaticLayer(L) {
    clearChildren(gStatic);

    // Fondo suave
    gStatic.appendChild(elNS('rect', {
      x: 8, y: 8,
      width: L.width - 16,
      height: L.height - 16,
      rx: 14,
      fill: 'rgba(255,255,255,0.6)',
      stroke: 'rgba(15,23,42,0.08)',
    }));

    // Labels instrumentos
    const labels = [
      { text: 'Hi-hat', y: L.yHH + 5 },
      { text: 'Redoblante', y: L.ySN + 5 },
      { text: 'Bombo', y: L.yBD + 5 },
    ];

    for (const lb of labels) {
      const t = elNS('text', {
        x: L.labelX,
        y: lb.y,
        'font-family': 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial',
        'font-size': 12,
        'font-weight': 600,
        fill: 'rgba(15,23,42,0.75)',
      });
      t.textContent = lb.text;
      gStatic.appendChild(t);
    }

    // Compás (fix: ya no se monta)
    const timeSig = elNS('text', {
      x: L.timeSigX,
      y: L.staffTop + L.staffLineGap * 2.2,
      'font-family': 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial',
      'font-size': 14,
      'font-weight': 700,
      fill: 'rgba(15,23,42,0.65)',
      'text-anchor': 'middle',
    });
    timeSig.textContent = `${L.beatsPerBar}/${4}`;
    gStatic.appendChild(timeSig);

    // Pentagrama (líneas + barras)
    const staff = elNS('g');

    for (let i = 0; i < L.staffLines; i++) {
      const y = L.staffTop + i * L.staffLineGap;
      staff.appendChild(elNS('line', {
        x1: L.leftPad,
        y1: y,
        x2: L.width - L.rightPad,
        y2: y,
        stroke: 'rgba(15,23,42,0.25)',
        'stroke-width': 1,
      }));
    }

    // Barra inicial
    staff.appendChild(elNS('line', {
      x1: L.leftPad,
      y1: L.staffTop,
      x2: L.leftPad,
      y2: L.staffTop + (L.staffLines - 1) * L.staffLineGap,
      stroke: 'rgba(15,23,42,0.55)',
      'stroke-width': 2,
    }));

    // Barra final (doble)
    const xEnd = L.width - L.rightPad;
    staff.appendChild(elNS('line', {
      x1: xEnd,
      y1: L.staffTop,
      x2: xEnd,
      y2: L.staffTop + (L.staffLines - 1) * L.staffLineGap,
      stroke: 'rgba(15,23,42,0.55)',
      'stroke-width': 2,
    }));
    staff.appendChild(elNS('line', {
      x1: xEnd - 4,
      y1: L.staffTop,
      x2: xEnd - 4,
      y2: L.staffTop + (L.staffLines - 1) * L.staffLineGap,
      stroke: 'rgba(15,23,42,0.55)',
      'stroke-width': 1,
    }));

    gStatic.appendChild(staff);

    // Guías verticales (subdivisiones)
    const yTop = L.staffTop - 14;
    const yBot = L.staffTop + (L.staffLines - 1) * L.staffLineGap + 14;

    for (let i = 0; i < L.steps; i++) {
      const x = L.xStep(i);

      let opacity = 0.05;
      let w = 1;

      if (isQuarterStep(i, L.stepsPerBeat)) { opacity = 0.22; w = 1.6; }
      else if (isEighthStep(i, L.stepsPerBeat)) { opacity = 0.12; w = 1.2; }

      gStatic.appendChild(elNS('line', {
        x1: x, y1: yTop,
        x2: x, y2: yBot,
        stroke: `rgba(15,23,42,${opacity})`,
        'stroke-width': w,
      }));
    }

    // Números de pulso (solo primer compás visual, MVP)
    for (let b = 0; b < L.beatsPerBar; b++) {
      const stepIndex = b * L.stepsPerBeat;
      const x = L.xStep(stepIndex);
      const t = elNS('text', {
        x,
        y: L.staffTop - 22,
        'text-anchor': 'middle',
        'font-family': 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial',
        'font-size': 11,
        'font-weight': 700,
        fill: 'rgba(15,23,42,0.5)',
      });
      t.textContent = String(b + 1);
      gStatic.appendChild(t);
    }
  }

  // -----------------------------
  // Dibujo: notas (se actualiza cada cambio de patrón)
  // -----------------------------
  function drawNoteHH(g, x, y) {
    const size = 7.5;
    const stroke = 'rgba(15,23,42,0.75)';
    g.appendChild(elNS('line', { x1: x - size, y1: y - size, x2: x + size, y2: y + size, stroke, 'stroke-width': 2, 'stroke-linecap': 'round' }));
    g.appendChild(elNS('line', { x1: x - size, y1: y + size, x2: x + size, y2: y - size, stroke, 'stroke-width': 2, 'stroke-linecap': 'round' }));
  }

  function drawNoteFilled(g, x, y) {
    g.appendChild(elNS('ellipse', {
      cx: x,
      cy: y,
      rx: 7.5,
      ry: 5.2,
      fill: 'rgba(15,23,42,0.8)',
    }));
  }

  function drawStem(g, x, y, up = true) {
    const len = 26;
    const xStem = x + (up ? 8 : -8);
    const y1 = y;
    const y2 = y + (up ? -len : len);
    g.appendChild(elNS('line', {
      x1: xStem, y1,
      x2: xStem, y2,
      stroke: 'rgba(15,23,42,0.75)',
      'stroke-width': 1.8,
      'stroke-linecap': 'round',
    }));
  }

  function setHint(L, textOrNull) {
    clearChildren(gHint);

    if (!textOrNull) return;

    const t = elNS('text', {
      x: L.width / 2,
      y: L.staffTop + L.staffLineGap * 2.3,
      'text-anchor': 'middle',
      'font-family': 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial',
      'font-size': 12,
      'font-weight': 600,
      fill: 'rgba(15,23,42,0.35)',
    });
    t.textContent = textOrNull;
    gHint.appendChild(t);
  }

  function renderNotesOnly(state, L) {
    const pattern = state.pattern || {};
    const hh = Array.isArray(pattern.hh) ? pattern.hh : [];
    const sn = Array.isArray(pattern.sn) ? pattern.sn : [];
    const bd = Array.isArray(pattern.bd) ? pattern.bd : [];

    const sig = patternSignature(pattern, L.steps);
    if (sig === lastPatternSignature) return; // nada cambió realmente

    lastPatternSignature = sig;
    clearChildren(gNotes);

    let hasAny = false;

    // Dibujar notas
    // (mantengo la lógica exacta: HH con X + stem arriba, SN stem arriba, BD stem abajo)
    for (let i = 0; i < L.steps; i++) {
      const x = L.xStep(i);

      if (hh[i]) {
        hasAny = true;
        drawNoteHH(gNotes, x, L.yHH);
        drawStem(gNotes, x, L.yHH, true);
      }

      if (sn[i]) {
        hasAny = true;
        drawNoteFilled(gNotes, x, L.ySN);
        drawStem(gNotes, x, L.ySN, true);
      }

      if (bd[i]) {
        hasAny = true;
        drawNoteFilled(gNotes, x, L.yBD);
        drawStem(gNotes, x, L.yBD, false);
      }
    }

    setHint(L, hasAny ? null : 'Activa pasos en la rejilla para ver la partitura aquí 🙂');
  }

  // -----------------------------
  // Render principal (throttle)
  // -----------------------------
  const render = rafThrottle(function (state) {
    if (!svg) return;
    if (!state) state = getState() || {};

    const needsRebuild = structureChanged(state);
    const L = getLayout(state);

    // Cache estructura
    layoutCache = {
      steps: L.steps,
      stepsPerBeat: L.stepsPerBeat,
      beatsPerBar: L.beatsPerBar,
      bars: L.bars,
    };

    // ViewBox responsive (clave)
    svg.setAttribute('viewBox', `0 0 ${L.width} ${L.height}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    // Rebuild completo solo si cambió estructura o aún no hay capas
    if (needsRebuild || !gRoot || !gStatic || !gNotes || !gHint) {
      clearChildren(svg);

      gRoot = elNS('g');
      gStatic = elNS('g', { 'data-layer': 'static' });
      gNotes = elNS('g', { 'data-layer': 'notes' });
      gHint = elNS('g', { 'data-layer': 'hint' });

      gRoot.appendChild(gStatic);
      gRoot.appendChild(gNotes);
      gRoot.appendChild(gHint);

      svg.appendChild(gRoot);

      // reset caches dependientes
      lastPatternSignature = '';

      drawStaticLayer(L);
    }

    // Notas siempre (pero con firma para evitar trabajo si no cambió)
    renderNotesOnly(state, L);

    emit('onRender', { layout: L, state });
  });

  // -----------------------------
  // API pública
  // -----------------------------
  function init(svgEl, state, opts = {}) {
    if (!svgEl) throw new Error('DrumNotation.init requiere un svgEl');
    svg = svgEl;

    callbacks.onRender = typeof opts.onRender === 'function' ? opts.onRender : null;

    svg.classList.add('drum-notation');

    // Primer render
    render(state || getState() || {});
  }

  function refreshFromState(state) {
    render(state || getState() || {});
  }

  // Alias
  const update = refreshFromState;

  window.DrumNotation = {
    init,
    render,
    refreshFromState,
    update,
  };
})();