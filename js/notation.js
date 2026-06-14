'use strict';

/* =============================================================================
  notation.js — DrumNotation (VexFlow SVG) — v4.0
  ------------------------------------------------------------------------------
  - Una sola voz con ACORDES por compás => notas simultáneas alineadas en columna
  - Paramétrico: métrica (2/4, 3/4, 4/4, 6/8...) y varios compases
  - Hi-hat con cabeza "x"
  - Acentos (nivel 2) con articulación; ghost notes (nivel 3) entre paréntesis/atenuadas
  - Step = semicorchea (1/16). beatUnit define el denominador de la métrica.

  API: init(container, state) / render(state) / refreshFromState(state)
============================================================================= */

(() => {
  const VF = window?.Vex?.Flow;
  if (!VF) { console.error('[DrumNotation] VexFlow no está cargado.'); return; }

  const DEFAULT_HEIGHT = 170;
  const STEP_TO_VF = new Map([[16, 'w'], [8, 'h'], [4, 'q'], [2, '8'], [1, '16']]);
  const GREEDY = [16, 8, 4, 2, 1];

  // Posiciones en pentagrama (percusión). hh con cabeza "x".
  const VOICES_DEF = [
    { id: 'hh', key: 'g/5/x2' },
    { id: 't1', key: 'e/5' },
    { id: 't2', key: 'd/5' },
    { id: 'sn', key: 'c/5' },
    { id: 'tf', key: 'a/4' },
    { id: 'bd', key: 'f/4' },
  ];
  const ALL_IDS = VOICES_DEF.map(v => v.id);

  let containerEl = null, renderer = null, context = null;
  let width = 0, height = DEFAULT_HEIGHT, lastHash = null, ro = null;

  // -------- helpers --------
  const clearContainer = () => { if (containerEl) containerEl.innerHTML = ''; };
  const computeWidth = () => {
    const rect = containerEl.getBoundingClientRect();
    return Math.max(420, Math.floor(rect.width || 0) || 720);
  };
  const getLiveState = () => { try { return window?.DrumState?.get?.() || {}; } catch (_) { return {}; } };

  function getConfig(state) {
    const beatsPerBar = Math.max(1, Number(state?.beatsPerBar) || 4);
    const stepsPerBeat = Math.max(1, Number(state?.stepsPerBeat) || 4);
    const bars = Math.max(1, Number(state?.bars) || 1);
    const beatUnit = (Number(state?.beatUnit) === 8) ? 8 : 4;
    const stepsPerBar = beatsPerBar * stepsPerBeat;
    // Agrupación de vigas: en x/8 agrupamos por pulso compuesto (3 corcheas)
    const beamGroupSteps = (beatUnit === 8) ? stepsPerBeat * 3 : stepsPerBeat;
    return { beatsPerBar, stepsPerBeat, bars, beatUnit, stepsPerBar, beamGroupSteps,
             totalSteps: stepsPerBar * bars, ts: `${beatsPerBar}/${beatUnit}` };
  }

  function getLevels(state, totalSteps) {
    const p = (state && state.pattern && typeof state.pattern === 'object') ? state.pattern : (state || {});
    const out = {};
    for (const id of ALL_IDS) {
      const arr = Array.isArray(p[id]) ? p[id] : [];
      const a = new Array(totalSteps).fill(0);
      for (let i = 0; i < totalSteps; i++) a[i] = arr[i] | 0;
      out[id] = a;
    }
    return out;
  }

  const keyToValue = (key) => {
    const [letter, octStr] = String(key).split('/');
    const order = { c: 0, d: 1, e: 2, f: 3, g: 4, a: 5, b: 6 };
    const oct = Number(octStr) || 4;
    return oct * 7 + (order[letter[0].toLowerCase()] ?? 0);
  };

  const decompose = (len) => {
    const parts = []; let rem = len;
    for (const s of GREEDY) while (rem >= s) { parts.push(s); rem -= s; }
    return parts;
  };

  const anyHitAt = (lv, i) => ALL_IDS.some(id => lv[id][i]);
  const nextOnset = (lv, from, total) => {
    for (let i = from; i < total; i++) if (anyHitAt(lv, i)) return i;
    return total;
  };

  // -------- construcción de notas para UN compás --------
  function buildBar(lv, startStep, cfg) {
    const notes = [], ties = [];
    const { stepsPerBar, beamGroupSteps } = cfg;
    const barEndAbs = startStep + stepsPerBar;

    const groupEnd = (posAbs) => {
      const rel = posAbs - startStep;
      const g = Math.floor(rel / beamGroupSteps);
      return Math.min(stepsPerBar, (g + 1) * beamGroupSteps) + startStep;
    };

    const emitSpan = (a, b, idsAtStep) => {
      let cursor = a, remaining = b - a;
      const pieces = [];
      while (remaining > 0) {
        // Figura más grande que (a) cabe y (b) está alineada a su propia duración
        // dentro del compás. Evita sobre-dividir (p.ej. una redonda no se parte en 4 negras).
        const rel = cursor - startStep;
        let chosen = 1;
        for (const L of GREEDY) {
          if (L <= remaining && rel % L === 0) { chosen = L; break; }
        }
        const vfDur = STEP_TO_VF.get(chosen) || '16';
        const note = idsAtStep ? makeChord(idsAtStep, vfDur, lv, a) : makeRest(vfDur);
        notes.push(note);
        if (idsAtStep) pieces.push(note);
        cursor += chosen; remaining -= chosen;
      }
      if (idsAtStep && pieces.length > 1) {
        for (let i = 0; i < pieces.length - 1; i++) {
          ties.push(new VF.StaveTie({ first_note: pieces[i], last_note: pieces[i + 1] }));
        }
      }
    };

    let pos = startStep;
    while (pos < barEndAbs) {
      if (!anyHitAt(lv, pos)) {
        const end = Math.min(barEndAbs, nextOnset(lv, pos, barEndAbs));
        emitSpan(pos, end, null);
        pos = end;
      } else {
        const ids = ALL_IDS.filter(id => lv[id][pos]);
        const end = Math.min(barEndAbs, nextOnset(lv, pos + 1, barEndAbs));
        emitSpan(pos, end, ids);
        pos = end;
      }
    }
    return { notes, ties };
  }

  function makeChord(idsAtStep, vfDur, lv, atStep) {
    const defs = VOICES_DEF.filter(v => idsAtStep.includes(v.id));
    const sorted = defs.slice().sort((a, b) => keyToValue(a.key) - keyToValue(b.key));
    const keys = sorted.map(d => d.key);
    const note = new VF.StaveNote({ clef: 'percussion', keys, duration: vfDur });

    let hasAccent = false;
    sorted.forEach((d, idx) => {
      const lvl = lv[d.id][atStep] | 0;
      if (lvl === 2) hasAccent = true;
      if (lvl === 3) { // ghost: atenuar
        try { note.setKeyStyle(idx, { fillStyle: 'rgba(24,35,58,0.45)', strokeStyle: 'rgba(24,35,58,0.45)' }); } catch (_) {}
      }
    });

    if (hasAccent) {
      try { note.addModifier(new VF.Articulation('a>').setPosition(VF.Modifier.Position.ABOVE), 0); }
      catch (_) {
        try { note.addArticulation(0, new VF.Articulation('a>').setPosition(3)); } catch (_) {}
      }
    }
    return note;
  }

  function makeRest(vfDur) {
    return new VF.StaveNote({ clef: 'percussion', keys: ['b/4'], duration: `${vfDur}r` });
  }

  // -------- render --------
  function draw(state) {
    if (!containerEl) throw new Error('DrumNotation no inicializado.');
    const cfg = getConfig(state);
    const lv = getLevels(state, cfg.totalSteps);

    // Nota: el control de "cuándo renderizar" lo lleva app.js (por patternRevision).
    // No deduplicamos aquí para evitar desincronización con cambios de estructura.
    lastHash = cfg.ts + '|' + cfg.bars + '|' + ALL_IDS.map(id => lv[id].join('')).join('/');

    clearContainer();
    width = computeWidth();
    height = DEFAULT_HEIGHT;

    renderer = new VF.Renderer(containerEl, VF.Renderer.Backends.SVG);
    renderer.resize(width, height);
    context = renderer.getContext();

    const B = cfg.bars;
    const leftPad = 10, rightPad = 12;
    const usable = width - leftPad - rightPad;
    const barW = usable / B;

    for (let b = 0; b < B; b++) {
      const x = leftPad + b * barW;
      const stave = new VF.Stave(x, 18, barW);
      if (b === 0) stave.addClef('percussion').addTimeSignature(cfg.ts);
      stave.setContext(context).draw();

      const { notes, ties } = buildBar(lv, b * cfg.stepsPerBar, cfg);

      const voice = new VF.Voice({ num_beats: cfg.beatsPerBar, beat_value: cfg.beatUnit });
      voice.setStrict(false);
      voice.addTickables(notes.length ? notes : [makeRest('w')]);

      let beams = [];
      try {
        beams = VF.Beam.generateBeams(notes, {
          groups: [new VF.Fraction(cfg.beamGroupSteps, 16)],
          beam_rests: false,
        });
      } catch (_) { beams = []; }

      const formatPad = b === 0 ? 92 : 24;
      new VF.Formatter().joinVoices([voice]).format([voice], Math.max(60, barW - formatPad));

      voice.draw(context, stave);
      beams.forEach(bm => bm.setContext(context).draw());
      ties.forEach(t => t.setContext(context).draw());
    }

    const any = ALL_IDS.some(id => lv[id].some(Boolean));
    if (!any) {
      try {
        const svg = containerEl.querySelector('svg');
        if (svg) {
          const ns = 'http://www.w3.org/2000/svg';
          const t = document.createElementNS(ns, 'text');
          t.setAttribute('x', String(width / 2));
          t.setAttribute('y', String(height - 14));
          t.setAttribute('text-anchor', 'middle');
          t.setAttribute('font-family', 'Inter, system-ui, sans-serif');
          t.setAttribute('font-size', '12');
          t.setAttribute('font-weight', '600');
          t.setAttribute('fill', 'rgba(15,23,42,0.35)');
          t.textContent = 'Activa pasos en la rejilla para ver la partitura 🙂';
          svg.appendChild(t);
        }
      } catch (_) {}
    }
  }

  const DrumNotation = {
    init(container, state) {
      containerEl = (typeof container === 'string') ? document.querySelector(container) : container;
      if (!containerEl) throw new Error('DrumNotation.init: container no encontrado.');
      clearContainer();
      if ('ResizeObserver' in window) {
        try {
          ro?.disconnect?.();
          ro = new ResizeObserver(() => { lastHash = null; draw(getLiveState()); });
          ro.observe(containerEl);
        } catch (_) {}
      }
      lastHash = null;
      draw(state || getLiveState());
    },
    render(state) { draw(state || getLiveState()); },
    refreshFromState(state) { draw(state || getLiveState()); },
  };

  window.DrumNotation = DrumNotation;
})();
