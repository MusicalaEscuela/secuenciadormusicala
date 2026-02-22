'use strict';

/* =========================================================
   drum-box /js/audio.js
   Motor de audio (Tone.js) para caja de ritmos — WAV Samples
   ---------------------------------------------------------
   v2.1 (mejorado / FIX real de carga)
   - Reemplaza synths por WAV usando Tone.Player (bombo/redoblante/platillo)
   - FIX: carga de samples sin depender de player.url (evita undefined.match)
   - Preload seguro (espera a que carguen los samples antes de arrancar)
   - Lee estado “vivo” en cada tick (puedes editar el patrón mientras suena)
   - Loop/Transport robustos (sin callbacks colgados)
   - setBpm con rampTo suave
   - Misma API pública:
     window.DrumAudio.start()
     window.DrumAudio.stop()
     window.DrumAudio.setBpm(bpm)
     window.DrumAudio.setOnStep(cb)
     window.DrumAudio.getCurrentStep()
     window.DrumAudio.isRunning()

   Requiere:
   - Tone.js cargado en index.html
   - state.js (window.DrumState)

   Rutas:
   - WAV en: ./assets/sounds/
     - bombo.wav
     - redoblante.wav
     - platillo.wav
========================================================= */

(function () {
  // -----------------------------
  // Guard: Tone.js
  // -----------------------------
  if (typeof window.Tone === 'undefined') {
    console.error('[audio.js] Tone.js no está cargado.');
    window.DrumAudio = {
      async start() { throw new Error('Tone.js no está cargado'); },
      stop() {},
      setBpm() {},
      setOnStep() {},
      getCurrentStep() { return -1; },
      isRunning() { return false; },
    };
    return;
  }

  const Tone = window.Tone;

  // -----------------------------
  // Config
  // -----------------------------
  const DEFAULTS = {
    minBpm: 40,
    maxBpm: 240,
    startDelaySec: 0.01,
    bpmRampSec: 0.06,

    // Ruta base donde están los WAV
    samplesBaseUrl: './assets/sounds/',

    // Nombres de archivo
    samples: {
      bd: 'bombo.wav',
      sn: 'redoblante.wav',
      hh: 'platillo.wav',
    },

    // Evita click raro en algunos samples al re-disparar
    fadeOut: 0.01,

    // Retrigger limpio (corta el sample anterior antes de disparar)
    retriggerStop: true,
  };

  // -----------------------------
  // Estado interno
  // -----------------------------
  let initialized = false;
  let startedOnce = false;

  let onStepCb = null;
  let loop = null;

  let _currentStep = -1;
  let _stepCounter = 0;

  // players
  let kick = null;  // bd
  let snare = null; // sn
  let hihat = null; // hh

  let masterGain = null;

  // cache para evitar rebuild tonto del loop
  let lastLoopResolution = { interval: '16n' };

  // cache: URLs reales (no dependemos de player.url)
  let sampleUrls = null;
  let samplesLoaded = false;

  // -----------------------------
  // Utils (con fallbacks)
  // -----------------------------
  const Utils = window.DrumUtils || null;
  const clamp = Utils?.clamp || ((n, min, max) => Math.max(min, Math.min(max, Number(n))));

  // -----------------------------
  // Helpers: DrumState
  // -----------------------------
  function requireState() {
    const S = window.DrumState;
    if (!S) throw new Error('DrumState no está disponible.');
    if (typeof S.get !== 'function') throw new Error('DrumState.get() no está disponible.');
    return S;
  }

  function getState() {
    return requireState().get();
  }

  function setStatePatch(patch) {
    try {
      const S = window.DrumState;
      if (!S) return;

      if (typeof S.set === 'function') S.set(patch);
      else Object.assign(S, patch);
    } catch (_) {}
  }

  function setStateStep(stepIndex) {
    _currentStep = stepIndex;

    // Actualizar DrumState si se puede
    try {
      const S = window.DrumState;
      if (!S) return;

      if (typeof S.setCurrentStep === 'function') S.setCurrentStep(stepIndex);
      else if (typeof S.set === 'function') S.set({ currentStep: stepIndex });
      else S.currentStep = stepIndex;
    } catch (err) {
      console.warn('[audio.js] No se pudo actualizar currentStep en DrumState:', err);
    }

    // Callback hacia app.js (protegido)
    if (typeof onStepCb === 'function') {
      try { onStepCb(stepIndex); }
      catch (err) { console.warn('[audio.js] Error en onStep callback:', err); }
    }
  }

  function getStepsFromState(state) {
    const steps = Number(state?.steps);
    return Number.isFinite(steps) && steps > 0 ? Math.floor(steps) : 16;
  }

  // -----------------------------
  // URL helpers
  // -----------------------------
  function buildSampleUrls() {
    const base = DEFAULTS.samplesBaseUrl;
    return {
      bd: base + DEFAULTS.samples.bd,
      sn: base + DEFAULTS.samples.sn,
      hh: base + DEFAULTS.samples.hh,
    };
  }

  // -----------------------------
  // Triggering de instrumentos (WAV)
  // -----------------------------
  function safeStart(player, time) {
    if (!player) return;
    try {
      if (DEFAULTS.retriggerStop && typeof player.stop === 'function') {
        try { player.stop(time); } catch (_) {}
      }
      player.start(time);
    } catch (err) {
      console.warn('[audio.js] No se pudo disparar sample:', err);
    }
  }

  function triggerAtStep(stepIndex, time, state) {
    const pattern = state?.pattern || {};

    if (Array.isArray(pattern.hh) && pattern.hh[stepIndex]) safeStart(hihat, time);
    if (Array.isArray(pattern.sn) && pattern.sn[stepIndex]) safeStart(snare, time);
    if (Array.isArray(pattern.bd) && pattern.bd[stepIndex]) safeStart(kick, time);
  }

  // -----------------------------
  // Inicialización audio graph (WAV)
  // -----------------------------
  function initAudioGraph() {
    if (initialized) return;

    masterGain = new Tone.Gain(0.95).toDestination();

    sampleUrls = buildSampleUrls();

    // OJO: No confiamos en player.url para cargar.
    kick = new Tone.Player({
      url: sampleUrls.bd,
      autostart: false,
      fadeOut: DEFAULTS.fadeOut,
    }).connect(masterGain);

    snare = new Tone.Player({
      url: sampleUrls.sn,
      autostart: false,
      fadeOut: DEFAULTS.fadeOut,
    }).connect(masterGain);

    hihat = new Tone.Player({
      url: sampleUrls.hh,
      autostart: false,
      fadeOut: DEFAULTS.fadeOut,
    }).connect(masterGain);

    // Balance de niveles (dB). Ajusta si tus WAV vienen muy duros.
    kick.volume.value = -3;
    snare.volume.value = -6;
    hihat.volume.value = -10;

    initialized = true;
  }

  async function ensureSamplesLoaded() {
    // Evita recargar en cada play
    if (samplesLoaded) return;

    const urls = sampleUrls || buildSampleUrls();

    try {
      // FIX: cargar con URLs explícitas, no p.load(p.url)
      await Promise.all([
        kick?.load(urls.bd),
        snare?.load(urls.sn),
        hihat?.load(urls.hh),
      ]);

      samplesLoaded = true;
    } catch (err) {
      console.error('[audio.js] Error cargando samples WAV. Revisa rutas/archivos:', err);
      samplesLoaded = false;
      throw err;
    }
  }

  // -----------------------------
  // Loop / Transport
  // -----------------------------
  function disposeLoop() {
    if (!loop) return;
    try { loop.stop(0); } catch (_) {}
    try { loop.dispose(); } catch (_) {}
    loop = null;
  }

  function resetCounters() {
    _stepCounter = 0;
    _currentStep = -1;
  }

  function ensureTransportDefaults() {
    try {
      Tone.Transport.loop = false;
      Tone.Transport.swing = 0;
    } catch (_) {}
  }

  function buildLoopIfNeeded() {
    const interval = '16n';
    if (loop && lastLoopResolution.interval === interval) return;

    try { Tone.Transport.cancel(); } catch (_) {}
    disposeLoop();
    resetCounters();

    loop = new Tone.Loop((time) => {
      const liveState = getState();
      const liveSteps = getStepsFromState(liveState);

      const step = _stepCounter % liveSteps;

      triggerAtStep(step, time, liveState);
      setStateStep(step);

      _stepCounter = (_stepCounter + 1) % liveSteps;
    }, interval);

    loop.start(0);
    lastLoopResolution.interval = interval;
  }

  function applyTempoFromState() {
    const state = getState();
    const bpm = clamp(Number(state?.bpm) || 90, DEFAULTS.minBpm, DEFAULTS.maxBpm);
    try { Tone.Transport.bpm.value = bpm; } catch (_) {}
    return bpm;
  }

  // -----------------------------
  // API pública
  // -----------------------------
  async function start() {
    initAudioGraph();

    // Browsers: necesitan gesto del usuario para arrancar audio
    if (Tone.context.state !== 'running') {
      await Tone.start();
    }

    // Cargar WAV antes de sonar
    await ensureSamplesLoaded();

    ensureTransportDefaults();
    applyTempoFromState();
    buildLoopIfNeeded();

    try {
      if (Tone.Transport.state !== 'started') {
        Tone.Transport.start(`+${DEFAULTS.startDelaySec}`);
      }
    } catch (err) {
      console.warn('[audio.js] Error al iniciar Transport:', err);
      throw err;
    }

    startedOnce = true;
    setStatePatch({ isPlaying: true });

    return true;
  }

  function stop() {
    if (!startedOnce) {
      resetCounters();
      setStatePatch({ isPlaying: false, currentStep: -1 });
      if (typeof onStepCb === 'function') {
        try { onStepCb(-1); } catch (_) {}
      }
      return;
    }

    try {
      if (Tone.Transport.state === 'started') Tone.Transport.stop();
    } catch (err) {
      console.warn('[audio.js] Error al detener Transport:', err);
    }

    try { Tone.Transport.cancel(); } catch (_) {}

    disposeLoop();
    resetCounters();

    // Cortar tails
    try { kick?.stop(); } catch (_) {}
    try { snare?.stop(); } catch (_) {}
    try { hihat?.stop(); } catch (_) {}

    if (typeof onStepCb === 'function') {
      try { onStepCb(-1); } catch (_) {}
    }

    setStatePatch({ isPlaying: false, currentStep: -1 });
  }

  function setBpm(bpm) {
    const value = clamp(Number(bpm) || 90, DEFAULTS.minBpm, DEFAULTS.maxBpm);

    try {
      const S = window.DrumState;
      if (S && typeof S.setBpm === 'function') S.setBpm(value);
      else setStatePatch({ bpm: value });
    } catch (_) {}

    try {
      if (Tone.Transport?.bpm?.rampTo) Tone.Transport.bpm.rampTo(value, DEFAULTS.bpmRampSec);
      else Tone.Transport.bpm.value = value;
    } catch (_) {}

    return value;
  }

  function setOnStep(cb) {
    onStepCb = (typeof cb === 'function') ? cb : null;
  }

  function getCurrentStep() {
    return _currentStep;
  }

  function isRunning() {
    try { return Tone.Transport.state === 'started'; }
    catch (_) { return false; }
  }

  // -----------------------------
  // Exposición global
  // -----------------------------
  window.DrumAudio = {
    start,
    stop,
    setBpm,
    setOnStep,
    getCurrentStep,
    isRunning,
  };
})();