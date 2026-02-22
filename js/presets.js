'use strict';

/* =========================================================
   drum-box /js/presets.js
   Presets rítmicos (MVP / v1.1)
   ---------------------------------------------------------
   Requiere:
   - state.js (window.DrumState) [solo para apply()]
   - tracks base: hh, sn, bd

   Expone:
   - window.DrumPresets.rock
   - window.DrumPresets.funk
   - window.DrumPresets.get(name)
   - window.DrumPresets.list()
   - window.DrumPresets.apply(name, stateApi?)
========================================================= */

(function () {
  // -----------------------------
  // Helpers
  // -----------------------------
  function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function bools(arr) {
    return arr.map(v => !!v);
  }

  function makePattern({ hh = [], sn = [], bd = [] } = {}) {
    return {
      hh: bools(hh),
      sn: bools(sn),
      bd: bools(bd),
    };
  }

  function ensure16(arr) {
    const out = Array(16).fill(false);
    if (!Array.isArray(arr)) return out;
    for (let i = 0; i < 16; i++) out[i] = !!arr[i];
    return out;
  }

  function normalizePreset(preset) {
    const p = clone(preset || {});
    p.id = String(p.id || 'preset');
    p.name = String(p.name || p.id);
    p.description = String(p.description || '');
    p.bpm = Number.isFinite(Number(p.bpm)) ? Number(p.bpm) : 90;
    p.pattern = p.pattern || {};
    p.pattern.hh = ensure16(p.pattern.hh);
    p.pattern.sn = ensure16(p.pattern.sn);
    p.pattern.bd = ensure16(p.pattern.bd);
    return p;
  }

  // -----------------------------
  // Presets base (16 pasos / 4x4)
  // Convención pasos por beat:
  // [1 e & a | 2 e & a | 3 e & a | 4 e & a]
  // indices:
  //  0 1 2 3 | 4 5 6 7 | 8 9 10 11 | 12 13 14 15
  // -----------------------------
  const PRESET_MAP = Object.create(null);

  function addPreset(preset) {
    const p = normalizePreset(preset);
    PRESET_MAP[p.id] = p;
    return p;
  }

  // ROCK básico:
  // HH en corcheas, SN en 2 y 4, BD en 1 y 3
  addPreset({
    id: 'rock',
    name: 'Rock básico',
    description: 'Hi-hat en corcheas, redoblante en 2 y 4, bombo en 1 y 3.',
    bpm: 92,
    pattern: makePattern({
      hh: [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0],
      sn: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
      bd: [1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0],
    })
  });

  // FUNK básico (ghost-ish sin ghost note real, pero con síncopa útil)
  addPreset({
    id: 'funk',
    name: 'Funk básico',
    description: 'Groove base con síncopa en bombo e hi-hat en semicorcheas.',
    bpm: 98,
    pattern: makePattern({
      hh: [1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1], // semis
      sn: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0], // 2 y 4
      bd: [1,0,0,1, 0,0,1,0, 1,0,0,0, 0,1,0,0], // sincopadito
    })
  });

  // Extra útil: POP (para probar rápido sin tocar botones si luego lo agregan)
  addPreset({
    id: 'pop',
    name: 'Pop básico',
    description: 'Bombo sólido con hi-hat en corcheas y caja en 2 y 4.',
    bpm: 104,
    pattern: makePattern({
      hh: [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0],
      sn: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
      bd: [1,0,0,0, 0,0,1,0, 1,0,0,0, 0,0,1,0],
    })
  });

  // Extra útil: HALF-TIME (para ver negra/corchea/semi bien diferenciadas)
  addPreset({
    id: 'half',
    name: 'Half-time',
    description: 'Caja en 3 (half-time feel), hi-hat en corcheas.',
    bpm: 78,
    pattern: makePattern({
      hh: [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0],
      sn: [0,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0],
      bd: [1,0,0,0, 0,0,1,0, 0,0,0,0, 1,0,0,0],
    })
  });

  // -----------------------------
  // API pública
  // -----------------------------
  function get(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    const p = PRESET_MAP[key];
    return p ? clone(p) : null;
  }

  function list() {
    return Object.values(PRESET_MAP).map(p => clone(p));
  }

  function names() {
    return Object.keys(PRESET_MAP);
  }

  function apply(name, stateApi) {
    const preset = get(name);
    if (!preset) {
      console.warn(`[presets.js] Preset no encontrado: ${name}`);
      return null;
    }

    const S = stateApi || window.DrumState;
    if (!S) {
      console.warn('[presets.js] DrumState no está disponible para apply().');
      return preset;
    }

    // Soporte flexible de APIs
    if (typeof S.update === 'function') {
      S.update((draft) => {
        // Forzamos resolución MVP para que no se rompa visual/audio
        draft.bars = 1;
        draft.beatsPerBar = 4;
        draft.stepsPerBeat = 4;
        draft.steps = 16;
        draft.subdivision = '16';

        // Si no existen tracks, dejamos base
        if (!Array.isArray(draft.tracks) || !draft.tracks.length) {
          draft.tracks = [
            { id: 'hh', label: 'Hi-hat' },
            { id: 'sn', label: 'Redoblante' },
            { id: 'bd', label: 'Bombo' },
          ];
        }

        draft.pattern = clone(preset.pattern);
        draft.bpm = preset.bpm;
        draft.currentStep = -1;
      });
      return preset;
    }

    if (typeof S.set === 'function') {
      S.set({
        bars: 1,
        beatsPerBar: 4,
        stepsPerBeat: 4,
        steps: 16,
        subdivision: '16',
        pattern: clone(preset.pattern),
        bpm: preset.bpm,
        currentStep: -1,
      });
      return preset;
    }

    // Si DrumState fuera objeto directo (fallback)
    try {
      S.bars = 1;
      S.beatsPerBar = 4;
      S.stepsPerBeat = 4;
      S.steps = 16;
      S.subdivision = '16';
      S.pattern = clone(preset.pattern);
      S.bpm = preset.bpm;
      S.currentStep = -1;
    } catch (err) {
      console.warn('[presets.js] No se pudo aplicar preset en objeto state fallback:', err);
    }

    return preset;
  }
  
  // Exponer también acceso directo por nombre (compatibilidad con app.js)
  const exported = {
    get,
    list,
    names,
    apply,
  };

  // Adjuntamos cada preset como propiedad directa: DrumPresets.rock, DrumPresets.funk, etc.
  for (const [key, preset] of Object.entries(PRESET_MAP)) {
    exported[key] = clone(preset);
  }

  window.DrumPresets = exported;
})();