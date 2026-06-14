'use strict';

/* =========================================================
   drum-box /js/audio.js  — Síntesis integrada (sin WAV)
   v3.1
   - Kits 'acoustic' / 'electronic' (seleccionables)
   - Volumen por pieza + acento/ghost por velocidad (niveles 1/2/3)
   - Swing, metrónomo y cuenta de entrada (claqueta)
   - Soporte toms
   - Exportable a WAV (Tone.Offline) reutilizando los builders
   API:
     start/stop/setBpm/setOnStep/getCurrentStep/isRunning
     setKit/setVolume/previewHit/setSwing/setMetronome
     renderToWav(state) -> Promise<Blob>
========================================================= */

(function () {
  if (typeof window.Tone === 'undefined') {
    console.error('[audio.js] Tone.js no está cargado.');
    window.DrumAudio = {
      async start() { throw new Error('Tone.js no está cargado'); },
      stop() {}, setBpm() {}, setOnStep() {},
      getCurrentStep() { return -1; }, isRunning() { return false; },
      setKit() {}, setVolume() {}, previewHit() {}, setSwing() {}, setMetronome() {},
      async renderToWav() { throw new Error('Tone.js no está cargado'); },
    };
    return;
  }

  const Tone = window.Tone;

  const DEFAULTS = { minBpm: 40, maxBpm: 240, startDelaySec: 0.05, bpmRampSec: 0.06 };
  const TRACK_IDS = ['hh', 'sn', 'bd', 't1', 't2', 'tf'];

  // nivel -> velocidad
  const LEVEL_VEL = { 1: 0.85, 2: 1.0, 3: 0.4 };

  let initialized = false;
  let startedOnce = false;
  let onStepCb = null;
  let loop = null;
  let _currentStep = -1;
  let _stepCounter = 0;

  let masterGain = null;
  let metroSynth = null;
  const trackGains = Object.create(null);
  let voices = Object.create(null);
  let currentKit = null;

  const Utils = window.DrumUtils || null;
  const clamp = Utils?.clamp || ((n, min, max) => Math.max(min, Math.min(max, Number(n))));

  function getState() {
    const S = window.DrumState;
    return (S && typeof S.get === 'function') ? S.get() : (S || {});
  }
  function setStatePatch(patch) {
    try { const S = window.DrumState; if (!S) return;
      if (typeof S.set === 'function') S.set(patch); else Object.assign(S, patch);
    } catch (_) {}
  }
  function setStateStep(stepIndex) {
    _currentStep = stepIndex;
    try { const S = window.DrumState; if (S && typeof S.setCurrentStep === 'function') S.setCurrentStep(stepIndex); } catch (_) {}
    if (typeof onStepCb === 'function') { try { onStepCb(stepIndex); } catch (_) {} }
  }
  function getStepsFromState(state) {
    const steps = Number(state?.steps);
    return Number.isFinite(steps) && steps > 0 ? Math.floor(steps) : 16;
  }
  function levelVel(level) { return LEVEL_VEL[level] || (level ? 0.85 : 0); }

  // -----------------------------
  // Builders de kit (reutilizables: reciben el mapa de gains)
  // -----------------------------
  function buildAcousticKit(g) {
    const v = Object.create(null);

    v.bd = {
      synth: new Tone.MembraneSynth({ pitchDecay: 0.03, octaves: 6,
        envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.2 } }).connect(g.bd),
      trigger(t, vel) { this.synth.triggerAttackRelease('C1', '8n', t, vel); },
    };

    v.sn = {
      synth: new Tone.NoiseSynth({ noise: { type: 'white' },
        envelope: { attack: 0.001, decay: 0.16, sustain: 0 } }).connect(g.sn),
      extra: new Tone.MembraneSynth({ pitchDecay: 0.02, octaves: 4,
        envelope: { attack: 0.001, decay: 0.12, sustain: 0 } }).connect(g.sn),
      trigger(t, vel) {
        this.synth.triggerAttackRelease('16n', t, vel);
        this.extra.triggerAttackRelease('D3', '32n', t, vel * 0.3);
      },
    };

    // Hi-hat: ruido blanco filtrado (paso-alto) = chasquido nítido y realista
    {
      const filt = new Tone.Filter({ frequency: 8000, type: 'highpass', Q: 1 }).connect(g.hh);
      const noise = new Tone.NoiseSynth({ noise: { type: 'white' },
        envelope: { attack: 0.001, decay: 0.045, sustain: 0, release: 0.02 } }).connect(filt);
      v.hh = { synth: noise, filter: filt,
        trigger(t, vel) { this.synth.triggerAttackRelease('16n', t, vel * 1.1); } };
    }

    // Toms: membrana sine afinada (poco "boing") + leve transitorio de ataque
    const tom = (gain, note) => {
      const body = new Tone.MembraneSynth({ pitchDecay: 0.05, octaves: 2,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.12 } }).connect(gain);
      return { synth: body, _note: note,
        trigger(t, vel) { this.synth.triggerAttackRelease(this._note, '8n', t, vel); } };
    };
    v.t1 = tom(g.t1, 'D3'); v.t2 = tom(g.t2, 'A2'); v.tf = tom(g.tf, 'F2');
    return v;
  }

  function buildElectronicKit(g) {
    const v = Object.create(null);

    v.bd = {
      synth: new Tone.MembraneSynth({ pitchDecay: 0.06, octaves: 8, oscillator: { type: 'sine' },
        envelope: { attack: 0.001, decay: 0.5, sustain: 0.01, release: 0.4 } }).connect(g.bd),
      trigger(t, vel) { this.synth.triggerAttackRelease('C1', '4n', t, vel); },
    };

    v.sn = {
      synth: new Tone.NoiseSynth({ noise: { type: 'pink' },
        envelope: { attack: 0.001, decay: 0.2, sustain: 0 } }).connect(g.sn),
      extra: new Tone.Synth({ oscillator: { type: 'triangle' },
        envelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.05 } }).connect(g.sn),
      trigger(t, vel) {
        this.synth.triggerAttackRelease('8n', t, vel);
        this.extra.triggerAttackRelease('A3', '32n', t, vel * 0.4);
      },
    };

    // Hi-hat electrónico: ruido filtrado más brillante y un pelín más largo
    {
      const filt = new Tone.Filter({ frequency: 9000, type: 'highpass', Q: 1.2 }).connect(g.hh);
      const noise = new Tone.NoiseSynth({ noise: { type: 'white' },
        envelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.02 } }).connect(filt);
      v.hh = { synth: noise, filter: filt,
        trigger(t, vel) { this.synth.triggerAttackRelease('16n', t, vel * 1.1); } };
    }

    // Toms electrónicos: sine afinado, un poco más de cuerpo
    const tom = (gain, note) => {
      const body = new Tone.MembraneSynth({ pitchDecay: 0.06, octaves: 3,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.001, decay: 0.4, sustain: 0, release: 0.15 } }).connect(gain);
      return { synth: body, _note: note,
        trigger(t, vel) { this.synth.triggerAttackRelease(this._note, '8n', t, vel); } };
    };
    v.t1 = tom(g.t1, 'D2'); v.t2 = tom(g.t2, 'A1'); v.tf = tom(g.tf, 'F1');
    return v;
  }

  function makeKit(kitName, gains) {
    return (kitName === 'electronic') ? buildElectronicKit(gains) : buildAcousticKit(gains);
  }

  function disposeVoices() {
    for (const k of Object.keys(voices)) {
      const v = voices[k];
      if (!v) continue;
      // Libera cualquier nodo de Tone almacenado en la voz (synth, extra, filter, ...)
      for (const prop of Object.keys(v)) {
        const node = v[prop];
        if (node && typeof node.dispose === 'function') { try { node.dispose(); } catch (_) {} }
      }
    }
    voices = Object.create(null);
  }

  function buildKit(kitName) {
    disposeVoices();
    currentKit = (kitName === 'electronic') ? 'electronic' : 'acoustic';
    voices = makeKit(currentKit, trackGains);
  }

  // -----------------------------
  // Volúmenes
  // -----------------------------
  function applyVolumesFromState() {
    const st = getState();
    const vols = st?.volumes || {};
    for (const id of TRACK_IDS) {
      const gg = trackGains[id]; if (!gg) continue;
      const v = Number.isFinite(Number(vols[id])) ? Number(vols[id]) : 0.8;
      try { gg.gain.rampTo(clamp(v, 0, 1), 0.02); } catch (_) { gg.gain.value = clamp(v, 0, 1); }
    }
  }
  function setVolume(trackId, value) {
    const id = String(trackId || '').trim();
    const gg = trackGains[id]; const v = clamp(Number(value), 0, 1);
    if (gg) { try { gg.gain.rampTo(v, 0.02); } catch (_) { gg.gain.value = v; } }
    try { const S = window.DrumState; if (S && typeof S.setVolume === 'function') S.setVolume(id, v); } catch (_) {}
    return v;
  }

  // -----------------------------
  // Grafo
  // -----------------------------
  function initAudioGraph() {
    if (initialized) return;
    masterGain = new Tone.Gain(0.9).toDestination();
    for (const id of TRACK_IDS) trackGains[id] = new Tone.Gain(0.8).connect(masterGain);

    metroSynth = new Tone.MembraneSynth({ pitchDecay: 0.008, octaves: 2,
      envelope: { attack: 0.001, decay: 0.05, sustain: 0 } }).connect(masterGain);
    metroSynth.volume.value = -8;

    const st = getState();
    buildKit(st?.kit || 'acoustic');
    applyVolumesFromState();
    initialized = true;
  }

  function setKit(kitName) {
    const next = (kitName === 'electronic') ? 'electronic' : 'acoustic';
    try { const S = window.DrumState; if (S && typeof S.setKit === 'function') S.setKit(next); } catch (_) {}
    if (!initialized) return next;
    if (next === currentKit) return next;
    buildKit(next); applyVolumesFromState();
    return next;
  }

  // -----------------------------
  // Swing / metrónomo
  // -----------------------------
  function applySwingFromState() {
    const st = getState();
    try {
      Tone.Transport.swingSubdivision = '16n';
      Tone.Transport.swing = clamp(Number(st?.swing) || 0, 0, 0.75);
    } catch (_) {}
  }
  function setSwing(amount) {
    const v = clamp(Number(amount) || 0, 0, 1);
    try { const S = window.DrumState; if (S && typeof S.set === 'function') S.set({ swing: v }); } catch (_) {}
    try { Tone.Transport.swingSubdivision = '16n'; Tone.Transport.swing = clamp(v, 0, 0.75); } catch (_) {}
    return v;
  }
  function setMetronome(on) {
    try { const S = window.DrumState; if (S && typeof S.set === 'function') S.set({ metronome: !!on }); } catch (_) {}
    return !!on;
  }
  function clickMetro(time, accent) {
    if (!metroSynth) return;
    try { metroSynth.triggerAttackRelease(accent ? 'C3' : 'C2', '32n', time, accent ? 1 : 0.6); } catch (_) {}
  }

  // -----------------------------
  // Triggering
  // -----------------------------
  function triggerAtStep(stepIndex, time, state) {
    const pattern = state?.pattern || {};
    for (const id of TRACK_IDS) {
      const arr = pattern[id];
      const lvl = Array.isArray(arr) ? (arr[stepIndex] | 0) : 0;
      if (lvl > 0) {
        const vv = voices[id];
        if (vv && typeof vv.trigger === 'function') { try { vv.trigger(time, levelVel(lvl)); } catch (_) {} }
      }
    }
    // Metrónomo durante la reproducción
    if (state?.metronome) {
      const spb = Number(state.stepsPerBeat) || 4;
      const spBar = Number(state.stepsPerBar) || 16;
      if (stepIndex % spb === 0) clickMetro(time, stepIndex % spBar === 0);
    }
  }

  function previewHit(trackId, level) {
    if (!initialized) { try { initAudioGraph(); } catch (_) {} }
    if (Tone.context.state !== 'running') Tone.start().catch(() => {});
    const vv = voices[String(trackId || '').trim()];
    if (vv && typeof vv.trigger === 'function') {
      try { vv.trigger(Tone.now(), levelVel(level || 1)); } catch (_) {}
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
  function resetCounters() { _stepCounter = 0; _currentStep = -1; }
  function ensureTransportDefaults() { try { Tone.Transport.loop = false; } catch (_) {} }

  function buildLoop() {
    try { Tone.Transport.cancel(); } catch (_) {}
    disposeLoop();
    resetCounters();
    loop = new Tone.Loop((time) => {
      const liveState = getState();
      const liveSteps = getStepsFromState(liveState);
      const step = _stepCounter % liveSteps;
      triggerAtStep(step, time, liveState);
      try { Tone.Draw.schedule(() => setStateStep(step), time); }
      catch (_) { setStateStep(step); }
      _stepCounter = (_stepCounter + 1) % liveSteps;
    }, '16n');
  }

  function applyTempoFromState() {
    const state = getState();
    const bpm = clamp(Number(state?.bpm) || 90, DEFAULTS.minBpm, DEFAULTS.maxBpm);
    try { Tone.Transport.bpm.value = bpm; } catch (_) {}
    return bpm;
  }

  async function start() {
    initAudioGraph();
    if (Tone.context.state !== 'running') await Tone.start();

    const st = getState();
    if ((st?.kit || 'acoustic') !== currentKit) buildKit(st?.kit || 'acoustic');
    applyVolumesFromState();

    ensureTransportDefaults();
    applyTempoFromState();
    applySwingFromState();
    buildLoop();

    const stepDur = Tone.Time('16n').toSeconds();
    const stepsPerBeat = Number(st.stepsPerBeat) || 4;
    const stepsPerBar = Number(st.stepsPerBar) || 16;
    const beatsPerBar = Number(st.beatsPerBar) || 4;

    let loopStart = `+${DEFAULTS.startDelaySec}`;

    if (st.countIn) {
      const base = DEFAULTS.startDelaySec;
      // Una vuelta de claqueta (un compás), acento en el primer pulso
      for (let b = 0; b < beatsPerBar; b++) {
        const t = base + b * stepsPerBeat * stepDur;
        try { Tone.Transport.scheduleOnce((time) => clickMetro(time, b === 0), `+${t}`); } catch (_) {}
      }
      loopStart = `+${base + stepsPerBar * stepDur}`;
    }

    try { loop.start(loopStart); } catch (_) {}

    try { if (Tone.Transport.state !== 'started') Tone.Transport.start(`+${DEFAULTS.startDelaySec}`); }
    catch (err) { console.warn('[audio.js] Error al iniciar Transport:', err); throw err; }

    startedOnce = true;
    setStatePatch({ isPlaying: true });
    return true;
  }

  function stop() {
    if (!startedOnce) {
      resetCounters();
      setStatePatch({ isPlaying: false, currentStep: -1 });
      if (typeof onStepCb === 'function') { try { onStepCb(-1); } catch (_) {} }
      return;
    }
    try { if (Tone.Transport.state === 'started') Tone.Transport.stop(); } catch (_) {}
    try { Tone.Transport.cancel(); } catch (_) {}
    disposeLoop();
    resetCounters();
    if (typeof onStepCb === 'function') { try { onStepCb(-1); } catch (_) {} }
    setStatePatch({ isPlaying: false, currentStep: -1 });
  }

  function setBpm(bpm) {
    const value = clamp(Number(bpm) || 90, DEFAULTS.minBpm, DEFAULTS.maxBpm);
    try { const S = window.DrumState; if (S && typeof S.setBpm === 'function') S.setBpm(value); else setStatePatch({ bpm: value }); } catch (_) {}
    try { if (Tone.Transport?.bpm?.rampTo) Tone.Transport.bpm.rampTo(value, DEFAULTS.bpmRampSec); else Tone.Transport.bpm.value = value; } catch (_) {}
    return value;
  }

  function setOnStep(cb) { onStepCb = (typeof cb === 'function') ? cb : null; }
  function getCurrentStep() { return _currentStep; }
  function isRunning() { try { return Tone.Transport.state === 'started'; } catch (_) { return false; } }

  // -----------------------------
  // Exportar a WAV (offline)
  // -----------------------------
  function audioBufferToWav(buffer) {
    const numCh = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const len = buffer.length * numCh * 2 + 44;
    const ab = new ArrayBuffer(len);
    const view = new DataView(ab);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

    writeStr(0, 'RIFF'); view.setUint32(4, len - 8, true); writeStr(8, 'WAVE');
    writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numCh * 2, true); view.setUint16(32, numCh * 2, true);
    view.setUint16(34, 16, true); writeStr(36, 'data'); view.setUint32(40, len - 44, true);

    const channels = [];
    for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
    let off = 44;
    for (let i = 0; i < buffer.length; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = Math.max(-1, Math.min(1, channels[c][i]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        off += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }

  async function renderToWav(stateArg) {
    const st = stateArg || getState();
    const bpm = clamp(Number(st?.bpm) || 90, DEFAULTS.minBpm, DEFAULTS.maxBpm);
    const steps = getStepsFromState(st);
    const pattern = st?.pattern || {};
    const vols = st?.volumes || {};

    // Duración: dos vueltas del patrón + cola para que decaigan los sonidos
    const secsPer16 = (60 / bpm) / 4;
    const loops = 2;
    const tail = 0.6;
    const duration = steps * secsPer16 * loops + tail;

    const buffer = await Tone.Offline(() => {
      // Dentro de Offline, Tone usa el contexto offline para los constructores globales
      const master = new Tone.Gain(0.9).toDestination();
      const gains = Object.create(null);
      for (const id of TRACK_IDS) {
        const v = Number.isFinite(Number(vols[id])) ? Number(vols[id]) : 0.8;
        gains[id] = new Tone.Gain(clamp(v, 0, 1)).connect(master);
      }
      const kit = makeKit(st?.kit || 'acoustic', gains);

      for (let l = 0; l < loops; l++) {
        for (let i = 0; i < steps; i++) {
          const t = (l * steps + i) * secsPer16 + 0.02;
          for (const id of TRACK_IDS) {
            const arr = pattern[id];
            const lvl = Array.isArray(arr) ? (arr[i] | 0) : 0;
            if (lvl > 0 && kit[id]?.trigger) {
              try { kit[id].trigger(t, levelVel(lvl)); } catch (_) {}
            }
          }
        }
      }
    }, duration);

    // Tone.Offline devuelve un ToneAudioBuffer; obtenemos el AudioBuffer nativo
    const native = buffer.get ? buffer.get() : buffer;
    return audioBufferToWav(native);
  }

  window.DrumAudio = {
    start, stop, setBpm, setOnStep, getCurrentStep, isRunning,
    setKit, setVolume, previewHit, setSwing, setMetronome, renderToWav,
  };
})();
