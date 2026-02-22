'use strict';

/* =============================================================================
  notation.js — DrumNotation (VexFlow SVG) — v2.1
  ------------------------------------------------------------------------------
  - VexFlow SVG backend
  - Renderiza dentro de <div id="notation"></div> (NO svg manual)
  - Convierte 16 steps (semicorcheas en 4/4) a figuras reales
  - Parte cuando cruza beat (internamente correcto)
  - Opción A: NO dibuja ligaduras y puede ocultar notas de continuación

  API:
    - DrumNotation.init(container, state)
    - DrumNotation.render(state)
    - DrumNotation.refreshFromState(state)  // alias

============================================================================= */

(() => {
  const VF = window?.Vex?.Flow;
  if (!VF) {
    console.error('[DrumNotation] VexFlow no está cargado. Incluye vexflow.js antes de notation.js');
    return;
  }

  // -------------------------
  // Display config (Opción A)
  // -------------------------
  const DISPLAY = {
    showTies: false,               // <- NO dibujar ligaduras
    hideTiedContinuations: true,   // <- Ocultar notas “de continuidad” (las que serían ligadas)
  };

  // 16 steps = 1 compás 4/4 en semicorcheas
  const STEPS_PER_BAR = 16;
  const STEPS_PER_BEAT = 4; // negra = 4 semicorcheas
  const DEFAULT_HEIGHT = 220;

  // Duración en steps -> VexFlow duration
  const STEP_TO_VF = new Map([
    [16, 'w'],
    [8, 'h'],
    [4, 'q'],
    [2, '8'],
    [1, '16'],
  ]);

  // Para descomponer dentro de beat
  const GREEDY = [16, 8, 4, 2, 1];

  // Posiciones en pentagrama (clef percussion)
  const PITCH = {
    hh: 'g/5', // arriba
    sn: 'd/5', // medio
    bd: 'f/4', // abajo
  };

  // Estado interno
  let containerEl = null;
  let renderer = null;
  let context = null;
  let width = 0;
  let height = DEFAULT_HEIGHT;
  let lastHash = null;
  let ro = null; // ResizeObserver

  // -------------------------
  // Helpers
  // -------------------------
  const normalize16 = (arr) => {
    const out = new Array(STEPS_PER_BAR).fill(0);
    if (!Array.isArray(arr)) return out;
    for (let i = 0; i < STEPS_PER_BAR; i++) out[i] = arr[i] ? 1 : 0;
    return out;
  };

  const getPatternFromState = (state) => {
    if (!state) return { hh: [], sn: [], bd: [] };
    const p = state.pattern && typeof state.pattern === 'object' ? state.pattern : state;
    return {
      hh: normalize16(p.hh),
      sn: normalize16(p.sn),
      bd: normalize16(p.bd),
    };
  };

  const hashPattern = (p) => `${p.hh.join('')}/${p.sn.join('')}/${p.bd.join('')}`;

  const nextHitIndex = (steps, from) => {
    for (let i = from; i < STEPS_PER_BAR; i++) if (steps[i]) return i;
    return STEPS_PER_BAR;
  };

  const beatEnd = (pos) => {
    const beatIdx = Math.floor(pos / STEPS_PER_BEAT);
    return Math.min(STEPS_PER_BAR, (beatIdx + 1) * STEPS_PER_BEAT);
  };

  const decomposeSteps = (len) => {
    const parts = [];
    let rem = len;
    for (const s of GREEDY) {
      while (rem >= s) {
        parts.push(s);
        rem -= s;
      }
    }
    return parts;
  };

  const clearContainer = () => {
    if (!containerEl) return;
    containerEl.innerHTML = '';
  };

  const computeWidth = () => {
    const rect = containerEl.getBoundingClientRect();
    return Math.max(520, Math.floor(rect.width || 0) || 720);
  };

  function getLiveStateFallback() {
    try {
      return window?.DrumState?.get?.() || {};
    } catch (_) {
      return {};
    }
  }

  // Oculta una nota VISUALMENTE pero deja sus ticks para que el compás cuadre.
  function hideNoteVisually(note) {
    try {
      // Nota + plica invisibles
      if (typeof note.setStyle === 'function') {
        note.setStyle({ fillStyle: 'transparent', strokeStyle: 'transparent' });
      }

      // Heads invisibles (VexFlow a veces dibuja heads aparte)
      if (typeof note.getNoteHeads === 'function') {
        const heads = note.getNoteHeads() || [];
        heads.forEach(h => {
          if (h?.setStyle) h.setStyle({ fillStyle: 'transparent', strokeStyle: 'transparent' });
        });
      }

      // Stem invisible
      if (typeof note.setStemStyle === 'function') {
        note.setStemStyle({ strokeStyle: 'transparent', fillStyle: 'transparent' });
      }

      // Flag invisible (si aplica)
      if (typeof note.setFlagStyle === 'function') {
        note.setFlagStyle({ strokeStyle: 'transparent', fillStyle: 'transparent' });
      }
    } catch (_) {
      // Si VexFlow se pone dramático, igual seguimos
    }
  }

  // -------------------------
  // VexFlow builders
  // -------------------------
  function makeNote(inst, vfDur, isRest) {
    const duration = isRest ? `${vfDur}r` : vfDur;

    const note = new VF.StaveNote({
      clef: 'percussion',
      keys: [PITCH[inst]],
      duration,
    });

    // Hi-hat con cabeza "x" si el build lo permite
    if (!isRest && inst === 'hh') {
      try {
        if (note.setNoteHeadType) note.setNoteHeadType(0, 'x');
      } catch (_) {}
    }

    return note;
  }

  function buildVoice(inst, steps) {
    const notes = [];
    const ties = [];

    let pos = 0;
    while (pos < STEPS_PER_BAR) {
      const isHit = !!steps[pos];

      // Segmento:
      // - Si hay hit, se sostiene hasta el siguiente hit o fin
      // - Si no hay hit, es silencio hasta el próximo hit
      const segEnd = isHit ? nextHitIndex(steps, pos + 1) : nextHitIndex(steps, pos);
      let segLen = Math.max(0, segEnd - pos);

      if (segLen === 0) {
        pos++;
        continue;
      }

      let remaining = segLen;
      let cursor = pos;

      // Piezas del hit (para ties / continuaciones)
      const hitPieces = [];

      // Partimos por beats para no cruzar pulso con una sola figura
      while (remaining > 0) {
        const bEnd = beatEnd(cursor);
        const chunk = Math.min(remaining, bEnd - cursor); // <= 4 en 4/4 semicorcheas

        const parts = decomposeSteps(chunk).filter(s => s <= 4);

        for (const partSteps of parts) {
          const vfDur = STEP_TO_VF.get(partSteps) || '16';
          const n = makeNote(inst, vfDur, !isHit);

          // Marcamos si esto es “continuación” de un hit sostenido
          const isContinuation = isHit && hitPieces.length > 0;

          // Opción A: ocultar continuaciones
          if (DISPLAY.hideTiedContinuations && isContinuation) {
            hideNoteVisually(n);
          }

          notes.push(n);

          if (isHit) hitPieces.push(n);

          cursor += partSteps;
          remaining -= partSteps;
        }
      }

      // Ties entre piezas (solo si se quieren mostrar)
      if (DISPLAY.showTies && isHit && hitPieces.length > 1) {
        for (let i = 0; i < hitPieces.length - 1; i++) {
          ties.push(new VF.StaveTie({
            first_note: hitPieces[i],
            last_note: hitPieces[i + 1],
            first_indices: [0],
            last_indices: [0],
          }));
        }
      }

      pos = segEnd;
    }

    const voice = new VF.Voice({ num_beats: 4, beat_value: 4 });
    // strict(false) evita que explote por pequeños desfases en algunos builds
    voice.setStrict(false);
    voice.addTickables(notes);

    return { voice, ties };
  }

  // -------------------------
  // Render
  // -------------------------
  function draw(state) {
    if (!containerEl) throw new Error('DrumNotation no inicializado. Llama init() primero.');

    const pattern = getPatternFromState(state);
    const h = hashPattern(pattern);

    // No render por playhead tick: solo si cambió el patrón
    if (h === lastHash) return;
    lastHash = h;

    clearContainer();

    width = computeWidth();
    height = DEFAULT_HEIGHT;

    renderer = new VF.Renderer(containerEl, VF.Renderer.Backends.SVG);
    renderer.resize(width, height);
    context = renderer.getContext();

    // Stave
    const stave = new VF.Stave(10, 20, width - 20);
    stave.addClef('percussion').addTimeSignature('4/4');
    stave.setContext(context).draw();

    // Voces
    const hh = buildVoice('hh', pattern.hh);
    const sn = buildVoice('sn', pattern.sn);
    const bd = buildVoice('bd', pattern.bd);

    // Formateo conjunto
    const formatter = new VF.Formatter();
    formatter.joinVoices([hh.voice, sn.voice, bd.voice]);
    formatter.format([hh.voice, sn.voice, bd.voice], width - 90);

    // Draw voices
    hh.voice.draw(context, stave);
    sn.voice.draw(context, stave);
    bd.voice.draw(context, stave);

    // Draw ties (si están habilitadas)
    if (DISPLAY.showTies) {
      [...hh.ties, ...sn.ties, ...bd.ties].forEach(t => t.setContext(context).draw());
    }

    // Hint si todo está vacío
    const any =
      pattern.hh.some(Boolean) ||
      pattern.sn.some(Boolean) ||
      pattern.bd.some(Boolean);

    if (!any) {
      try {
        const svg = containerEl.querySelector('svg');
        if (svg) {
          const ns = 'http://www.w3.org/2000/svg';
          const t = document.createElementNS(ns, 'text');
          t.setAttribute('x', String(width / 2));
          t.setAttribute('y', String(height - 18));
          t.setAttribute('text-anchor', 'middle');
          t.setAttribute('font-family', 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial');
          t.setAttribute('font-size', '12');
          t.setAttribute('font-weight', '600');
          t.setAttribute('fill', 'rgba(15,23,42,0.35)');
          t.textContent = 'Activa pasos en la rejilla para ver la partitura 🙂';
          svg.appendChild(t);
        }
      } catch (_) {}
    }
  }

  // -------------------------
  // Public API
  // -------------------------
  const DrumNotation = {
    init(container, state) {
      containerEl = (typeof container === 'string')
        ? document.querySelector(container)
        : container;

      if (!containerEl) throw new Error('DrumNotation.init: container no encontrado.');

      clearContainer();

      // Responsive: re-render en resize (aunque patrón igual)
      if ('ResizeObserver' in window) {
        try {
          ro?.disconnect?.();
          ro = new ResizeObserver(() => {
            lastHash = null;
            draw(getLiveStateFallback());
          });
          ro.observe(containerEl);
        } catch (_) {}
      }

      lastHash = null;
      draw(state || getLiveStateFallback());
    },

    render(state) {
      draw(state || getLiveStateFallback());
    },

    refreshFromState(state) {
      draw(state || getLiveStateFallback());
    },
  };

  window.DrumNotation = DrumNotation;
})();