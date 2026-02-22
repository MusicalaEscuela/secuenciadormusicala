'use strict';

/* =========================================================
   drum-box /js/app.js
   Orquestador principal (pulido / v1.3)
   ---------------------------------------------------------
   Meta: MISMAS funciones, mejor performance + claridad.
   - Menos renders innecesarios (especialmente notación)
   - Menos dependencia repetitiva de window.*
   - Usa DrumUtils si existe (clamp/debounce/rafThrottle/deepClone)
   - BPM: update suave + setBpm con debounce si está sonando
========================================================= */

(function () {
  // -----------------------------
  // Utils (con fallbacks)
  // -----------------------------
  const Utils = window.DrumUtils || null;

  const $ = Utils?.$ || ((sel, root = document) => root.querySelector(sel));

  const clamp = Utils?.clamp || ((n, min, max) => Math.max(min, Math.min(max, Number(n))));

  const deepClone = Utils?.deepClone || ((obj) => {
    if (typeof structuredClone === 'function') return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj));
  });

  const debounce = Utils?.debounce || ((fn, wait = 120) => {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  });

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
  // APIs (cacheadas)
  // -----------------------------
  function requireApi(name, hint) {
    const api = window[name];
    if (!api) throw new Error(`No se encontró window.${name} (${hint}).`);
    return api;
  }

  const State = requireApi('DrumState', 'state.js no cargó o cambió nombre');
  const Audio = requireApi('DrumAudio', 'audio.js no cargó');
  const Grid = requireApi('DrumGrid', 'grid.js no cargó');
  const Notation = requireApi('DrumNotation', 'notation.js no cargó');
  const Presets = window.DrumPresets || null;

  // -----------------------------
  // State wrappers
  // -----------------------------
  function stateGet() {
    return (typeof State.get === 'function') ? State.get() : State;
  }

  function stateSet(patch) {
    if (typeof State.set === 'function') return State.set(patch);
    Object.assign(State, patch);
    return State;
  }

  function stateUpdate(mutator) {
    if (typeof State.update === 'function') return State.update(mutator);
    const s = stateGet();
    mutator(s);
    return s;
  }

  // -----------------------------
  // DOM
  // -----------------------------
  const els = {
    playBtn: $('#playBtn'),
    bpmInput: $('#bpmInput'),
    clearBtn: $('#clearBtn'),
    rockBtn: $('#rockBtn'),
    funkBtn: $('#funkBtn'),
    statusText: $('#statusText') || $('#status') || null,
    gridRoot: $('#drumGrid'),
    notationSvg: $('#notation'),
  };

  const required = ['playBtn', 'bpmInput', 'clearBtn', 'rockBtn', 'funkBtn', 'gridRoot', 'notationSvg'];
  const missing = required.filter(k => !els[k]);
  if (missing.length) {
    console.error('[app.js] Faltan elementos en el HTML:', missing);
    return;
  }

  // -----------------------------
  // Render scheduling (separado)
  // -----------------------------
  const renderUI = rafThrottle(() => {
    syncToolbarFromState();
    syncGridPlayhead();
  });

  // OJO: Notación NO debe renderizarse en cada step (pesado e inútil).
  // Solo cuando cambia el patrón / preset / clear.
  const renderNotation = rafThrottle(() => {
    const s = stateGet();

    if (typeof Notation.render === 'function') {
      // Soporta firma render(svgEl, state) o render(state)
      if (Notation.render.length >= 2) Notation.render(els.notationSvg, s);
      else Notation.render(s);
      return;
    }

    if (typeof Notation.refreshFromState === 'function') {
      Notation.refreshFromState(s);
      return;
    }

    console.warn('[app.js] No se pudo renderizar notación: falta render()/refreshFromState().');
  });

  // -----------------------------
  // Notation lifecycle
  // -----------------------------
  let notationInitialized = false;

  function initNotationIfNeeded() {
    if (notationInitialized) return;

    if (typeof Notation.init === 'function') {
      Notation.init(els.notationSvg, stateGet(), { onRender() {} });
      notationInitialized = true;
      return;
    }

    // Si no hay init, igual podemos usar render directo
    if (typeof Notation.render === 'function' || typeof Notation.refreshFromState === 'function') {
      notationInitialized = true;
      return;
    }

    console.warn('[app.js] notation.js no expone init() ni render()/refreshFromState().');
  }

  // -----------------------------
  // Grid
  // -----------------------------
  function initGrid() {
    if (typeof Grid.init !== 'function') throw new Error('grid.js no expone init().');

    Grid.init(els.gridRoot, stateGet(), {
      onStepToggle() {
        // Pattern cambió => notación sí debe actualizarse
        renderNotation();
        renderUI();
      },
      onChange() {
        // Por si grid emite cambios más amplios
        renderNotation();
        renderUI();
      },
    });
  }

  function syncGridFromState() {
    const s = stateGet();
    if (typeof Grid.refreshFromState === 'function') Grid.refreshFromState(s);
  }

  function syncGridPlayhead() {
    const s = stateGet();
    const step = Number(s.currentStep ?? -1);

    if (typeof Grid.paintCurrentStep === 'function') {
      Grid.paintCurrentStep(step);
      return;
    }
    if (typeof Grid.setCurrentStep === 'function') {
      Grid.setCurrentStep(step);
    }
  }

  // -----------------------------
  // Toolbar
  // -----------------------------
  function syncToolbarFromState() {
    const s = stateGet();

    // BPM
    const bpm = clamp(Number(s.bpm ?? 90), 40, 240);
    if (String(els.bpmInput.value) !== String(bpm)) els.bpmInput.value = bpm;

    // Play button
    const playing = !!s.isPlaying;
    els.playBtn.classList.toggle('is-playing', playing);
    els.playBtn.setAttribute('aria-pressed', String(playing));
    els.playBtn.textContent = playing ? '■ Detener' : '▶ Reproducir';

    // Status
    if (els.statusText) {
      els.statusText.textContent = playing
        ? `Reproduciendo · Paso ${Number.isFinite(Number(s.currentStep)) && s.currentStep >= 0 ? (s.currentStep + 1) : '-'}`
        : 'Listo';
    }
  }

  // -----------------------------
  // Presets / acciones
  // -----------------------------
  function applyPreset(name) {
    if (!Presets) {
      console.warn('[app.js] presets.js no está cargado.');
      return;
    }

    const presetName = String(name || '').trim().toLowerCase();
    let applied = false;

    if (typeof Presets.apply === 'function') {
      Presets.apply(presetName, State);
      applied = true;
    } else if (typeof Presets.get === 'function') {
      const p = Presets.get(presetName);
      if (p?.pattern) stateSet({ pattern: deepClone(p.pattern) });
      if (typeof p?.bpm === 'number') stateSet({ bpm: clamp(p.bpm, 40, 240) });
      stateSet({ currentStep: -1 });
      applied = true;
    } else if (Presets[presetName]?.pattern) {
      stateSet({ pattern: deepClone(Presets[presetName].pattern) });
      if (typeof Presets[presetName].bpm === 'number') stateSet({ bpm: clamp(Presets[presetName].bpm, 40, 240) });
      stateSet({ currentStep: -1 });
      applied = true;
    }

    if (!applied) {
      console.warn(`[app.js] Preset no encontrado: ${presetName}`);
      return;
    }

    // Sync tempo con audio (si existe)
    try {
      if (typeof Audio.setBpm === 'function') Audio.setBpm(stateGet().bpm);
    } catch (_) {}

    // Sync UI
    syncGridFromState();
    renderNotation();
    renderUI();
  }

  function clearPattern() {
    if (typeof State.resetPattern === 'function') {
      State.resetPattern({ keepPlayhead: false });
    } else {
      stateUpdate((draft) => {
        const pattern = draft.pattern || {};
        for (const k of Object.keys(pattern)) {
          if (Array.isArray(pattern[k])) pattern[k] = pattern[k].map(() => false);
        }
        draft.currentStep = -1;
      });
    }

    syncGridFromState();
    renderNotation();
    renderUI();
  }

  // -----------------------------
  // Audio control
  // -----------------------------
  let pollingTimer = null;

  function startPollingFallback() {
    stopPollingFallback();
    pollingTimer = setInterval(() => {
      const s = stateGet();
      if (!s.isPlaying) return;

      const step = (typeof Audio.getCurrentStep === 'function') ? Audio.getCurrentStep() : null;
      if (typeof step === 'number' && step !== s.currentStep) {
        stateSet({ currentStep: step });
        // Playhead + status (NO notación)
        renderUI();
      }
    }, 33); // ~30fps suficiente para playhead, menos CPU
  }

  function stopPollingFallback() {
    if (!pollingTimer) return;
    clearInterval(pollingTimer);
    pollingTimer = null;
  }

  function bindAudioStepCallback() {
    if (typeof Audio.setOnStep !== 'function') return;

    Audio.setOnStep((stepIndex) => {
      // audio.js usualmente ya setea currentStep, pero lo garantizamos
      stateSet({ currentStep: stepIndex });
      // Solo UI (notación NO cambia por playhead)
      renderUI();
    });
  }

  async function togglePlay() {
    const s = stateGet();

    try {
      if (!s.isPlaying) {
        // BPM al iniciar
        if (typeof Audio.setBpm === 'function') Audio.setBpm(Number(s.bpm));

        if (typeof Audio.start === 'function') await Audio.start();
        else throw new Error('audio.js no expone start()');

        stateSet({ isPlaying: true });

        // Si no hay callback, fallback polling
        if (typeof Audio.setOnStep !== 'function') startPollingFallback();
      } else {
        if (typeof Audio.stop === 'function') Audio.stop();
        stopPollingFallback();
        stateSet({ isPlaying: false, currentStep: -1 });
      }

      renderUI();
    } catch (err) {
      console.error('[app.js] Error play/stop:', err);
      stopPollingFallback();
      stateSet({ isPlaying: false, currentStep: -1 });
      renderUI();

      // Mantengo alert porque es la única forma de decirle al usuario “toca click” (autoplay policy),
      // pero sin dramatismo.
      alert(`No se pudo iniciar el audio.\n\n${err?.message || err}`);
    }
  }

  // -----------------------------
  // BPM handling (pulido)
  // -----------------------------
  const setBpmToAudioDebounced = debounce((value) => {
    try {
      if (typeof Audio.setBpm === 'function') Audio.setBpm(value);
    } catch (_) {}
  }, 120);

  function onBpmInput() {
    const raw = Number(els.bpmInput.value);
    if (!Number.isFinite(raw)) return;

    const value = clamp(raw, 40, 240);
    stateSet({ bpm: value });
    syncToolbarFromState(); // inmediato

    // Si está sonando, actualiza tempo sin spamear
    if (stateGet().isPlaying) setBpmToAudioDebounced(value);
  }

  function onBpmChange() {
    const value = clamp(Number(els.bpmInput.value) || 90, 40, 240);
    stateSet({ bpm: value });
    els.bpmInput.value = value;

    try {
      if (typeof Audio.setBpm === 'function') Audio.setBpm(value);
    } catch (_) {}

    renderUI();
  }

  // -----------------------------
  // Events
  // -----------------------------
  function bindEvents() {
    els.playBtn.addEventListener('click', togglePlay);

    els.bpmInput.addEventListener('input', onBpmInput);
    els.bpmInput.addEventListener('change', onBpmChange);

    els.clearBtn.addEventListener('click', clearPattern);
    els.rockBtn.addEventListener('click', () => applyPreset('rock'));
    els.funkBtn.addEventListener('click', () => applyPreset('funk'));
  }

  // -----------------------------
  // Init
  // -----------------------------
  let initialized = false;

  function init() {
    if (initialized) return;
    initialized = true;

    // Asegurar forma mínima (sin pelear con state.js)
    stateUpdate((draft) => {
      if (typeof draft.bpm !== 'number') draft.bpm = 90;
      if (typeof draft.isPlaying !== 'boolean') draft.isPlaying = false;
      if (typeof draft.currentStep !== 'number') draft.currentStep = -1;
    });

    initNotationIfNeeded();
    bindAudioStepCallback();
    initGrid();
    bindEvents();

    // Render inicial
    syncGridFromState();

    // Si viene todo vacío, setea rock por defecto (igual que antes)
    const s = stateGet();
    const hasAnyStep = Object.values(s.pattern || {}).some(arr => Array.isArray(arr) && arr.some(Boolean));
    if (!hasAnyStep && Presets) {
      applyPreset('rock');
    } else {
      renderNotation();
      renderUI();
    }

    console.log('[app.js] Inicializado ✅');
  }

  // Debug útil (no cambia UX)
  window.DrumApp = {
    init,
    getState: stateGet,
    setState: stateSet,
    applyPreset,
    clearPattern,
    togglePlay,
    renderNotation,
    renderUI,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();