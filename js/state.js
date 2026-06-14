'use strict';

/* =========================================================
   drum-box /js/state.js
   Estado global de la caja de ritmos (mejorado / v1.4)
   ---------------------------------------------------------
   Mantiene la MISMA API pública existente y agrega extras
   sin romper compatibilidad.

   Mejoras clave:
   - patternRevision: contador de cambios del patrón (ideal para VexFlow/UI)
   - subscribe/unsubscribe: eventos opcionales (no rompe si no se usan)
   - Comparación de tracks por IDs (no por referencia viva)
   - Normalización más consistente + aliases útiles (stepsPerBar, totalSteps)
   - Preservación de patrón más robusta en cambios de resolución/tracks
========================================================= */

(function () {
  const DEFAULT_STEPS = 16;
  const DEFAULT_BPM = 90;

  // Orden visual / lógico base (MVP)
  const BASE_TRACKS = [
    { id: 'hh', label: 'Hi-hat' },
    { id: 'sn', label: 'Redoblante' },
    { id: 'bd', label: 'Bombo' },
  ];

  // Set extendido con toms (orden de agudo a grave, como en partitura)
  const TRACKS_WITH_TOMS = [
    { id: 'hh', label: 'Hi-hat' },
    { id: 't1', label: 'Tom 1' },
    { id: 't2', label: 'Tom 2' },
    { id: 'sn', label: 'Redoblante' },
    { id: 'tf', label: 'Tom piso' },
    { id: 'bd', label: 'Bombo' },
  ];

  // Compat: muchos módulos referencian DEFAULT_TRACKS
  const DEFAULT_TRACKS = BASE_TRACKS;

  // Volúmenes por pista (0..1 lineal). Audio.js los convierte a dB.
  const DEFAULT_VOLUMES = {
    hh: 0.6,
    sn: 0.85,
    bd: 1.0,
    t1: 0.8,
    t2: 0.8,
    tf: 0.85,
  };

  const DEFAULT_KIT = 'acoustic'; // 'acoustic' | 'electronic'

  function tracksForState(showToms) {
    return deepClone(showToms ? TRACKS_WITH_TOMS : BASE_TRACKS);
  }

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

  // Niveles de golpe: 0 = off, 1 = normal, 2 = acento, 3 = ghost
  function toLevel(v) {
    if (v === true) return 1;
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > 3 ? 1 : n;
  }

  function toLevelArray(arr, len) {
    const out = Array(len).fill(0);
    if (!Array.isArray(arr)) return out;
    for (let i = 0; i < len; i++) out[i] = toLevel(arr[i]);
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
    for (const id of trackIds) pattern[id] = Array(steps).fill(0);
    return pattern;
  }

  function normalizePattern(inputPattern, tracks, steps) {
    const src = isPlainObject(inputPattern) ? inputPattern : {};
    const pattern = {};
    for (const t of tracks) pattern[t.id] = toLevelArray(src[t.id], steps);
    return pattern;
  }

  function computeSteps(beatsPerBar, stepsPerBeat, bars) {
    const bpb = toPosInt(beatsPerBar, 4, 1);
    const spb = toPosInt(stepsPerBeat, 4, 1);
    const brs = toPosInt(bars, 1, 1);
    return bpb * spb * brs;
  }

  function getTrackIds(tracks) {
    return Array.isArray(tracks) ? tracks.map(t => String(t?.id || '').trim()).filter(Boolean) : [];
  }

  function sameTrackIds(a, b) {
    const A = getTrackIds(a);
    const B = getTrackIds(b);
    if (A.length !== B.length) return false;
    for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return false;
    return true;
  }

  // Preservar lo que se pueda al redimensionar steps
  function resizePatternKeepNotes(prevPattern, tracks, prevSteps, nextSteps) {
    const out = {};
    for (const t of tracks) {
      const src = Array.isArray(prevPattern?.[t.id]) ? prevPattern[t.id] : [];
      const next = Array(nextSteps).fill(0);

      const limit = Math.min(prevSteps, nextSteps);
      for (let i = 0; i < limit; i++) next[i] = toLevel(src[i]);

      out[t.id] = next;
    }
    return out;
  }

  // -----------------------------
  // Event system (opcional)
  // -----------------------------
  const _subs = new Set();

  function emit(type, payload) {
    if (!_subs.size) return;
    const evt = { type, ...payload };
    for (const fn of _subs) {
      try { fn(evt); } catch (e) { console.warn('[DrumState] subscriber error:', e); }
    }
  }

  function touchPattern(reason = 'pattern') {
    _state.patternRevision = (_state.patternRevision + 1) >>> 0; // uint32 wrap
    emit(reason, { state: _state, patternRevision: _state.patternRevision });
  }

  // -----------------------------
  // Normalización global
  // -----------------------------
  function normalizeVolumes(input) {
    const src = isPlainObject(input) ? input : {};
    const out = {};
    for (const id of Object.keys(DEFAULT_VOLUMES)) {
      const v = Number(src[id]);
      out[id] = Number.isFinite(v) ? clamp(v, 0, 1) : DEFAULT_VOLUMES[id];
    }
    return out;
  }

  function ensureStateShape(s) {
    // Toms (define qué tracks existen)
    s.showToms = !!s.showToms;

    // Kit de sonidos
    s.kit = (s.kit === 'electronic') ? 'electronic' : DEFAULT_KIT;

    // Volúmenes por pista
    s.volumes = normalizeVolumes(s.volumes);

    // Tracks: se derivan de showToms (no se editan a mano en este app)
    s.tracks = normalizeTracks(tracksForState(s.showToms));

    // Resolución
    s.bars = toPosInt(s.bars, 1, 1);
    s.beatsPerBar = toPosInt(s.beatsPerBar, 4, 1);
    s.stepsPerBeat = toPosInt(s.stepsPerBeat, 4, 1);

    // Steps coherentes
    s.steps = computeSteps(s.beatsPerBar, s.stepsPerBeat, s.bars);

    // Aliases útiles (no rompen nada)
    s.stepsPerBar = s.beatsPerBar * s.stepsPerBeat; // p.ej. 16 en 4/4 semicorcheas
    s.totalSteps = s.steps;

    // Tempo
    s.bpm = clamp(Number(s.bpm) || DEFAULT_BPM, 40, 240);

    // Playback
    s.isPlaying = !!s.isPlaying;
    s.currentStep = Number.isFinite(Number(s.currentStep)) ? Math.floor(Number(s.currentStep)) : -1;
    if (s.currentStep < -1 || s.currentStep >= s.steps) s.currentStep = -1;

    // UI prefs
    s.countMode = (s.countMode === 'simple' || s.countMode === 'full') ? s.countMode : 'full';
    s.showBeatNumbersInCells = (s.showBeatNumbersInCells !== false);

    // subdivision (por compás, no por total)
    s.subdivision = String(s.stepsPerBar); // "16" para 4/4 semicorcheas

    // Unidad de pulso de la métrica (4 = negra, 8 = corchea p.ej. 6/8)
    s.beatUnit = (Number(s.beatUnit) === 8) ? 8 : 4;

    // Groove / práctica
    s.swing = clamp(Number(s.swing) || 0, 0, 1);
    s.metronome = !!s.metronome;
    s.countIn = !!s.countIn;

    // patternRevision (si no existe)
    s.patternRevision = Number.isFinite(Number(s.patternRevision)) ? (Number(s.patternRevision) >>> 0) : 0;

    // Pattern
    s.pattern = normalizePattern(s.pattern, s.tracks, s.steps);

    return s;
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

    // Nuevos
    kit: DEFAULT_KIT,
    volumes: { ...DEFAULT_VOLUMES },
    showToms: false,
    beatUnit: 4,
    swing: 0,
    metronome: false,
    countIn: false,

    tracks: deepClone(DEFAULT_TRACKS),
    pattern: buildEmptyPattern(DEFAULT_TRACKS.map(t => t.id), DEFAULT_STEPS),

    // Nuevo (no rompe)
    patternRevision: 0,
  });

  // -----------------------------
  // API pública (mantener compat)
  // -----------------------------
  function get() {
    // referencia viva (como ustedes quieren)
    return _state;
  }

  function getSnapshot() {
    return deepClone(_state);
  }

  function set(patch) {
    if (!isPlainObject(patch)) return _state;

    // Snapshot mínimo para detectar cambios estructurales
    const prevSteps = _state.steps;
    const prevPattern = _state.pattern;
    const prevTrackIds = getTrackIds(_state.tracks);

    Object.assign(_state, patch);
    ensureStateShape(_state);

    const nextTrackIds = getTrackIds(_state.tracks);
    const stepsChanged = prevSteps !== _state.steps;
    const tracksChanged = prevTrackIds.length !== nextTrackIds.length ||
      prevTrackIds.some((id, i) => id !== nextTrackIds[i]);

    if (stepsChanged || tracksChanged) {
      _state.pattern = resizePatternKeepNotes(prevPattern, _state.tracks, prevSteps, _state.steps);
      ensureStateShape(_state);
      touchPattern('structure');
    } else {
      // Si patch trae pattern, se normalizó en ensureStateShape. Consideramos cambio.
      if ('pattern' in patch) touchPattern('pattern');
    }

    emit('state', { state: _state });
    return _state;
  }

  function update(mutator) {
    if (typeof mutator !== 'function') return _state;

    const prevSteps = _state.steps;
    const prevPattern = _state.pattern;
    const prevTrackIds = getTrackIds(_state.tracks);
    const prevPatternRev = _state.patternRevision;

    mutator(_state);
    ensureStateShape(_state);

    const nextTrackIds = getTrackIds(_state.tracks);
    const stepsChanged = prevSteps !== _state.steps;
    const tracksChanged = prevTrackIds.length !== nextTrackIds.length ||
      prevTrackIds.some((id, i) => id !== nextTrackIds[i]);

    if (stepsChanged || tracksChanged) {
      _state.pattern = resizePatternKeepNotes(prevPattern, _state.tracks, prevSteps, _state.steps);
      ensureStateShape(_state);
      touchPattern('structure');
    } else {
      // Si el mutator tocó pattern "a mano", no lo sabemos con certeza.
      // Pero si tocó patternRevision (no debería), respetamos. Si no, NO incrementamos.
      // Recomendación: usar setPattern/toggleStep/resetPattern para cambios de patrón.
      if (_state.patternRevision !== prevPatternRev) {
        // ok, alguien lo incrementó explícitamente
      }
    }

    emit('state', { state: _state });
    return _state;
  }

  function resetPattern(options = {}) {
    const { keepPlayhead = false } = options;

    const trackIds = getTrackIds(_state.tracks);
    _state.pattern = buildEmptyPattern(trackIds, _state.steps);

    if (!keepPlayhead) _state.currentStep = -1;

    ensureStateShape(_state);
    touchPattern('pattern');
    return _state;
  }

  function setPattern(nextPattern, options = {}) {
    const { resetPlayhead = false } = options;

    _state.pattern = normalizePattern(nextPattern, _state.tracks, _state.steps);
    if (resetPlayhead) _state.currentStep = -1;

    ensureStateShape(_state);
    touchPattern('pattern');
    return _state;
  }

  function toggleStep(trackId, stepIndex, forceValue) {
    const id = String(trackId || '').trim();
    const idx = Math.floor(Number(stepIndex));

    if (!_state.pattern[id]) return 0;
    if (!Number.isInteger(idx) || idx < 0 || idx >= _state.steps) return 0;

    const current = _state.pattern[id][idx];
    let nextValue;

    if (typeof forceValue === 'number' || typeof forceValue === 'boolean') {
      // forceValue como nivel deseado. Si ya es ese nivel, apaga (toggle).
      const wanted = toLevel(forceValue);
      nextValue = (current === wanted) ? 0 : wanted;
    } else {
      // Sin valor: alterna off/normal
      nextValue = current ? 0 : 1;
    }

    _state.pattern[id][idx] = nextValue;
    if (current !== nextValue) touchPattern('pattern');
    return nextValue;
  }

  function setStep(trackId, stepIndex, value) {
    const id = String(trackId || '').trim();
    const idx = Math.floor(Number(stepIndex));
    if (!_state.pattern[id]) return 0;
    if (!Number.isInteger(idx) || idx < 0 || idx >= _state.steps) return 0;
    const next = toLevel(value);
    const prev = _state.pattern[id][idx];
    _state.pattern[id][idx] = next;
    if (prev !== next) touchPattern('pattern');
    return next;
  }

  function getStep(trackId, stepIndex) {
    const id = String(trackId || '').trim();
    const idx = Math.floor(Number(stepIndex));
    if (!_state.pattern[id]) return 0;
    if (!Number.isInteger(idx) || idx < 0 || idx >= _state.steps) return 0;
    return _state.pattern[id][idx] | 0;
  }

  function setCurrentStep(stepIndex) {
    const idx = Math.floor(Number(stepIndex));
    _state.currentStep = (Number.isInteger(idx) && idx >= 0 && idx < _state.steps) ? idx : -1;
    emit('playhead', { currentStep: _state.currentStep, state: _state });
    return _state.currentStep;
  }

  function setBpm(bpm) {
    _state.bpm = clamp(Number(bpm) || DEFAULT_BPM, 40, 240);
    emit('tempo', { bpm: _state.bpm, state: _state });
    return _state.bpm;
  }

  function setKit(kit) {
    _state.kit = (kit === 'electronic') ? 'electronic' : 'acoustic';
    emit('kit', { kit: _state.kit, state: _state });
    return _state.kit;
  }

  function setVolume(trackId, value) {
    const id = String(trackId || '').trim();
    if (!(id in _state.volumes)) return null;
    _state.volumes[id] = clamp(Number(value), 0, 1);
    emit('volume', { trackId: id, value: _state.volumes[id], state: _state });
    return _state.volumes[id];
  }

  function getVolume(trackId) {
    const id = String(trackId || '').trim();
    return Number.isFinite(_state.volumes[id]) ? _state.volumes[id] : null;
  }

  function setShowToms(show) {
    const next = !!show;
    if (next === _state.showToms) return _state;

    const prevSteps = _state.steps;
    const prevPattern = deepClone(_state.pattern);

    _state.showToms = next;
    ensureStateShape(_state); // recalcula tracks

    // Preservar lo que existía por id (hh/sn/bd se mantienen)
    _state.pattern = buildEmptyPattern(getTrackIds(_state.tracks), _state.steps);
    for (const t of _state.tracks) {
      if (Array.isArray(prevPattern[t.id])) {
        _state.pattern[t.id] = toBoolArray(prevPattern[t.id], _state.steps);
      }
    }

    ensureStateShape(_state);
    touchPattern('structure');
    return _state;
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

    const prevSteps = _state.steps;
    const prevPattern = preservePattern ? deepClone(_state.pattern) : null;

    _state.tracks = normalizeTracks(tracks);

    // Rebuild pattern desde tracks actuales
    _state.pattern = buildEmptyPattern(getTrackIds(_state.tracks), _state.steps);

    // Preservación por ID si piden
    if (preservePattern && prevPattern) {
      for (const t of _state.tracks) {
        if (Array.isArray(prevPattern[t.id])) {
          _state.pattern[t.id] = toBoolArray(prevPattern[t.id], _state.steps);
        }
      }
    }

    // Normalización final
    ensureStateShape(_state);

    // Si por algún motivo steps cambió, preservamos por índice igual
    if (prevSteps !== _state.steps) {
      _state.pattern = resizePatternKeepNotes(prevPattern || {}, _state.tracks, prevSteps, _state.steps);
      ensureStateShape(_state);
    }

    touchPattern('structure');
    return _state;
  }

  function setResolution(config = {}) {
    const prevSteps = _state.steps;
    const prevPattern = deepClone(_state.pattern);

    const nextBars = Number.isFinite(Number(config.bars)) ? Math.max(1, Math.floor(Number(config.bars))) : _state.bars;
    const nextBeatsPerBar = Number.isFinite(Number(config.beatsPerBar)) ? Math.max(1, Math.floor(Number(config.beatsPerBar))) : _state.beatsPerBar;
    const nextStepsPerBeat = Number.isFinite(Number(config.stepsPerBeat)) ? Math.max(1, Math.floor(Number(config.stepsPerBeat))) : _state.stepsPerBeat;

    _state.bars = nextBars;
    _state.beatsPerBar = nextBeatsPerBar;
    _state.stepsPerBeat = nextStepsPerBeat;
    if (Number(config.beatUnit) === 8 || Number(config.beatUnit) === 4) {
      _state.beatUnit = Number(config.beatUnit);
    }

    _state.steps = computeSteps(_state.beatsPerBar, _state.stepsPerBeat, _state.bars);
    _state.stepsPerBar = _state.beatsPerBar * _state.stepsPerBeat;
    _state.totalSteps = _state.steps;
    _state.subdivision = String(_state.stepsPerBar);

    // Preservar notas por índice
    _state.pattern = resizePatternKeepNotes(prevPattern, _state.tracks, prevSteps, _state.steps);

    if (_state.currentStep >= _state.steps) _state.currentStep = -1;

    ensureStateShape(_state);
    touchPattern('structure');
    return _state;
  }

  // -----------------------------
  // Presets
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

    ensureStateShape(_state);
    touchPattern('pattern');
    return _state;
  }

  // -----------------------------
  // Subscriptions (extra, no rompe)
  // -----------------------------
  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    _subs.add(fn);
    return () => _subs.delete(fn);
  }

  function unsubscribe(fn) {
    _subs.delete(fn);
  }

  // -----------------------------
  // Exposición global
  // -----------------------------
  window.DrumState = {
    // Estado base
    get,
    getSnapshot,
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

    // Sonido / mezcla / toms
    setKit,
    setVolume,
    getVolume,
    setShowToms,

    // Playback/UI
    setCurrentStep,
    setBpm,

    // Presets
    loadRockBasic,

    // Extras (no rompe)
    subscribe,
    unsubscribe,

    // Constantes (debug/UI)
    DEFAULTS: {
      BPM: DEFAULT_BPM,
      STEPS: DEFAULT_STEPS,
      TRACKS: deepClone(DEFAULT_TRACKS),
    }
  };
})();