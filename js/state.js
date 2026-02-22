'use strict';

/* =========================================================
   drum-box /js/state.js
   Estado global de la caja de ritmos (pulido / v1.3)
   ---------------------------------------------------------
   MISMA API pública, pero más sólido:
   - Normalización más consistente (sin “pisar” cosas raras)
   - Preserva patrón inteligentemente al cambiar resolución/tracks
   - helpers centralizados (usa DrumUtils si existe)
   - get() sigue devolviendo referencia viva (como tu v1.2),
     pero añadí getSnapshot() por si algún día la quieres sin mutación
     (no rompe nada porque es extra).
========================================================= */

(function () {
  const DEFAULT_STEPS = 16;
  const DEFAULT_BPM = 90;

  // Orden visual / lógico base (MVP)
  const DEFAULT_TRACKS = [
    { id: 'hh', label: 'Hi-hat' },
    { id: 'sn', label: 'Redoblante' },
    { id: 'bd', label: 'Bombo' },
  ];

  // -----------------------------
  // Utils (con fallbacks)
  // -----------------------------
  const Utils = window.DrumUtils || null;

  const clamp = Utils?.clamp || ((n, min, max) => Math.max(min, Math.min(max, Number(n))));
  const deepClone = Utils?.deepClone || ((v) => {
    if (typeof structuredClone === 'function') return structuredClone(v);
    return JSON.parse(JSON.stringify(v));
  });

  // -----------------------------
  // Helpers internos
  // -----------------------------
  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function toInt(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : fallback;
  }

  function toPosInt(v, fallback, min = 1) {
    const n = toInt(v, fallback);
    return Number.isFinite(n) ? Math.max(min, n) : fallback;
  }

  function toBoolArray(arr, len) {
    const out = Array(len).fill(false);
    if (!Array.isArray(arr)) return out;
    for (let i = 0; i < len; i++) out[i] = !!arr[i];
    return out;
  }

  function normalizeTracks(tracks) {
    if (!Array.isArray(tracks) || !tracks.length) return deepClone(DEFAULT_TRACKS);

    const clean = [];
    const seen = new Set();

    for (const t of tracks) {
      if (!isPlainObject(t)) continue;
      const id = String(t.id || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);

      clean.push({
        id,
        label: String(t.label || id),
        shortLabel: t.shortLabel ? String(t.shortLabel) : undefined,
      });
    }

    return clean.length ? clean : deepClone(DEFAULT_TRACKS);
  }

  function buildEmptyPattern(trackIds, steps) {
    const pattern = {};
    for (const id of trackIds) pattern[id] = Array(steps).fill(false);
    return pattern;
  }

  function normalizePattern(inputPattern, tracks, steps) {
    const src = isPlainObject(inputPattern) ? inputPattern : {};
    const pattern = {};
    for (const t of tracks) pattern[t.id] = toBoolArray(src[t.id], steps);
    return pattern;
  }

  function computeSteps(beatsPerBar, stepsPerBeat, bars) {
    const bpb = toPosInt(beatsPerBar, 4, 1);
    const spb = toPosInt(stepsPerBeat, 4, 1);
    const brs = toPosInt(bars, 1, 1);
    return bpb * spb * brs;
  }

  function ensureStateShape(s) {
    // Tracks
    s.tracks = normalizeTracks(s.tracks);

    // Resolución
    s.bars = toPosInt(s.bars, 1, 1);
    s.beatsPerBar = toPosInt(s.beatsPerBar, 4, 1);
    s.stepsPerBeat = toPosInt(s.stepsPerBeat, 4, 1);

    // Steps coherentes
    s.steps = computeSteps(s.beatsPerBar, s.stepsPerBeat, s.bars);

    // Tempo
    s.bpm = clamp(Number(s.bpm) || DEFAULT_BPM, 40, 240);

    // Playback
    s.isPlaying = !!s.isPlaying;
    s.currentStep = Number.isFinite(Number(s.currentStep)) ? Math.floor(Number(s.currentStep)) : -1;
    if (s.currentStep < -1 || s.currentStep >= s.steps) s.currentStep = -1;

    // UI prefs
    s.countMode = (s.countMode === 'simple' || s.countMode === 'full') ? s.countMode : 'full';
    s.showBeatNumbersInCells = (s.showBeatNumbersInCells !== false);
    s.subdivision = String(s.beatsPerBar * s.stepsPerBeat); // "16" para 4/4 semicorcheas

    // Pattern
    s.pattern = normalizePattern(s.pattern, s.tracks, s.steps);

    return s;
  }

  // Preservar lo que se pueda al redimensionar steps
  function resizePatternKeepNotes(prevPattern, tracks, prevSteps, nextSteps) {
    const out = {};
    for (const t of tracks) {
      const src = Array.isArray(prevPattern?.[t.id]) ? prevPattern[t.id] : [];
      const next = Array(nextSteps).fill(false);

      // Copia lo que quepa
      const limit = Math.min(prevSteps, nextSteps);
      for (let i = 0; i < limit; i++) next[i] = !!src[i];

      out[t.id] = next;
    }
    return out;
  }

  // -----------------------------
  // Estado interno
  // -----------------------------
  const _state = ensureStateShape({
    bpm: DEFAULT_BPM,
    isPlaying: false,
    currentStep: -1,

    bars: 1,
    beatsPerBar: 4,
    stepsPerBeat: 4,
    steps: DEFAULT_STEPS,
    subdivision: '16',

    countMode: 'full',
    showBeatNumbersInCells: true,

    tracks: deepClone(DEFAULT_TRACKS),
    pattern: buildEmptyPattern(DEFAULT_TRACKS.map(t => t.id), DEFAULT_STEPS),
  });

  // -----------------------------
  // API pública
  // -----------------------------
  function get() {
    // referencia viva (como tu versión)
    return _state;
  }

  // extra (no rompe): snapshot inmutable por si algún día lo quieres
  function getSnapshot() {
    return deepClone(_state);
  }

  function set(patch) {
    if (!isPlainObject(patch)) return _state;

    // Guardar prev por si cambian cosas estructurales
    const prev = {
      tracks: _state.tracks,
      steps: _state.steps,
      pattern: _state.pattern,
      bars: _state.bars,
      beatsPerBar: _state.beatsPerBar,
      stepsPerBeat: _state.stepsPerBeat,
    };

    Object.assign(_state, patch);
    ensureStateShape(_state);

    // Si cambiaron steps por efecto colateral de patch (resolución),
    // intentamos preservar notas por índice.
    const stepsChanged = prev.steps !== _state.steps;
    const tracksChanged = prev.tracks.length !== _state.tracks.length ||
      prev.tracks.some((t, i) => t.id !== _state.tracks[i]?.id);

    if (stepsChanged || tracksChanged) {
      _state.pattern = resizePatternKeepNotes(prev.pattern, _state.tracks, prev.steps, _state.steps);
    }

    return _state;
  }

  function update(mutator) {
    if (typeof mutator !== 'function') return _state;

    const prev = {
      tracks: _state.tracks,
      steps: _state.steps,
      pattern: _state.pattern,
    };

    mutator(_state);
    ensureStateShape(_state);

    const stepsChanged = prev.steps !== _state.steps;
    const tracksChanged = prev.tracks.length !== _state.tracks.length ||
      prev.tracks.some((t, i) => t.id !== _state.tracks[i]?.id);

    if (stepsChanged || tracksChanged) {
      _state.pattern = resizePatternKeepNotes(prev.pattern, _state.tracks, prev.steps, _state.steps);
    }

    return _state;
  }

  function resetPattern(options = {}) {
    const { keepPlayhead = false } = options;

    const trackIds = _state.tracks.map(t => t.id);
    _state.pattern = buildEmptyPattern(trackIds, _state.steps);

    if (!keepPlayhead) _state.currentStep = -1;
    return _state;
  }

  function setPattern(nextPattern, options = {}) {
    const { resetPlayhead = false } = options;

    _state.pattern = normalizePattern(nextPattern, _state.tracks, _state.steps);
    if (resetPlayhead) _state.currentStep = -1;

    return _state;
  }

  function toggleStep(trackId, stepIndex, forceValue) {
    const id = String(trackId || '').trim();
    const idx = Math.floor(Number(stepIndex));

    if (!_state.pattern[id]) return false;
    if (!Number.isInteger(idx) || idx < 0 || idx >= _state.steps) return false;

    const nextValue = (typeof forceValue === 'boolean')
      ? forceValue
      : !_state.pattern[id][idx];

    _state.pattern[id][idx] = !!nextValue;
    return _state.pattern[id][idx];
  }

  function setStep(trackId, stepIndex, value) {
    return toggleStep(trackId, stepIndex, !!value);
  }

  function getStep(trackId, stepIndex) {
    const id = String(trackId || '').trim();
    const idx = Math.floor(Number(stepIndex));
    if (!_state.pattern[id]) return false;
    if (!Number.isInteger(idx) || idx < 0 || idx >= _state.steps) return false;
    return !!_state.pattern[id][idx];
  }

  function setCurrentStep(stepIndex) {
    const idx = Math.floor(Number(stepIndex));
    _state.currentStep = (Number.isInteger(idx) && idx >= 0 && idx < _state.steps) ? idx : -1;
    return _state.currentStep;
  }

  function setBpm(bpm) {
    _state.bpm = clamp(Number(bpm) || DEFAULT_BPM, 40, 240);
    return _state.bpm;
  }

  function hasAnyActiveStep() {
    for (const arr of Object.values(_state.pattern)) {
      if (Array.isArray(arr) && arr.some(Boolean)) return true;
    }
    return false;
  }

  function getTrackById(trackId) {
    const id = String(trackId || '').trim();
    return _state.tracks.find(t => t.id === id) || null;
  }

  function setTracks(tracks, options = {}) {
    const { preservePattern = false } = options;

    const prevPattern = preservePattern ? deepClone(_state.pattern) : null;

    _state.tracks = normalizeTracks(tracks);
    _state.pattern = buildEmptyPattern(_state.tracks.map(t => t.id), _state.steps);

    if (preservePattern && prevPattern) {
      for (const t of _state.tracks) {
        if (Array.isArray(prevPattern[t.id])) {
          _state.pattern[t.id] = toBoolArray(prevPattern[t.id], _state.steps);
        }
      }
    }

    return _state;
  }

  function setResolution(config = {}) {
    // Guardar prev para preservar notas al redimensionar
    const prevSteps = _state.steps;
    const prevPattern = deepClone(_state.pattern);

    const nextBars = Number.isFinite(Number(config.bars)) ? Math.max(1, Math.floor(Number(config.bars))) : _state.bars;
    const nextBeatsPerBar = Number.isFinite(Number(config.beatsPerBar)) ? Math.max(1, Math.floor(Number(config.beatsPerBar))) : _state.beatsPerBar;
    const nextStepsPerBeat = Number.isFinite(Number(config.stepsPerBeat)) ? Math.max(1, Math.floor(Number(config.stepsPerBeat))) : _state.stepsPerBeat;

    _state.bars = nextBars;
    _state.beatsPerBar = nextBeatsPerBar;
    _state.stepsPerBeat = nextStepsPerBeat;

    _state.steps = computeSteps(_state.beatsPerBar, _state.stepsPerBeat, _state.bars);
    _state.subdivision = String(_state.beatsPerBar * _state.stepsPerBeat);

    // Preservar notas por índice
    _state.pattern = resizePatternKeepNotes(prevPattern, _state.tracks, prevSteps, _state.steps);

    if (_state.currentStep >= _state.steps) _state.currentStep = -1;

    // Normalización final por seguridad
    ensureStateShape(_state);

    return _state;
  }

  // -----------------------------
  // Presets (opcional, sigue existiendo)
  // -----------------------------
  function loadRockBasic() {
    resetPattern({ keepPlayhead: false });

    if (_state.steps !== 16) return _state;

    const hh = [1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0];
    const sn = [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0];
    const bd = [1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0];

    _state.pattern.hh = hh.map(Boolean);
    _state.pattern.sn = sn.map(Boolean);
    _state.pattern.bd = bd.map(Boolean);

    return _state;
  }

  // -----------------------------
  // Exposición global
  // -----------------------------
  window.DrumState = {
    // Estado base
    get,
    getSnapshot, // extra, no rompe nada
    set,
    update,

    // Pattern
    resetPattern,
    setPattern,
    toggleStep,
    setStep,
    getStep,
    hasAnyActiveStep,

    // Tracks / config
    setTracks,
    getTrackById,
    setResolution,

    // Playback/UI
    setCurrentStep,
    setBpm,

    // Presets
    loadRockBasic,

    // Constantes (debug/UI)
    DEFAULTS: {
      BPM: DEFAULT_BPM,
      STEPS: DEFAULT_STEPS,
      TRACKS: deepClone(DEFAULT_TRACKS),
    }
  };
})();