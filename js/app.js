'use strict';

/* =========================================================
   drum-box /js/app.js
   Orquestador principal (pulido / v1.4)
   ---------------------------------------------------------
   Ajustes clave:
   - Notación (VexFlow) renderiza en <div id="notation"></div>
   - Notación NO renderiza por tick de playhead
   - Notación renderiza solo si cambia el patrón (patternRevision),
     con fallback a firma si no existe patternRevision.
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
    kitSelect: $('#kitSelect'),
    tomsToggle: $('#tomsToggle'),
    mixer: $('#mixer'),
    brushSeg: $('#brushSeg'),
    meterSelect: $('#meterSelect'),
    barsSelect: $('#barsSelect'),
    gridSubtitle: $('#gridSubtitle'),
    swingRange: $('#swingRange'),
    swingPct: $('#swingPct'),
    metroToggle: $('#metroToggle'),
    countInToggle: $('#countInToggle'),
    exportPngBtn: $('#exportPngBtn'),
    exportWavBtn: $('#exportWavBtn'),
    presetName: $('#presetName'),
    savePresetBtn: $('#savePresetBtn'),
    userPresetSelect: $('#userPresetSelect'),
    loadPresetBtn: $('#loadPresetBtn'),
    deletePresetBtn: $('#deletePresetBtn'),
    statusText: $('#statusText') || $('#status') || null,
    gridRoot: $('#drumGrid'),
    notationRoot: $('#notation'), // ✅ ahora es DIV contenedor (VexFlow crea SVG dentro)
  };

  const required = ['playBtn', 'bpmInput', 'clearBtn', 'rockBtn', 'funkBtn', 'gridRoot', 'notationRoot'];
  const missing = required.filter(k => !els[k]);
  if (missing.length) {
    console.error('[app.js] Faltan elementos en el HTML:', missing);
    return;
  }

  // Guard: si alguien dejó <svg id="notation">, avisamos.
  // VexFlow espera un contenedor normal; un SVG directo suele dar renders raros/vacíos.
  if (els.notationRoot && els.notationRoot.tagName?.toLowerCase() === 'svg') {
    console.warn('[app.js] #notation es <svg>. Para VexFlow debería ser <div id="notation"></div>.');
  }

  // -----------------------------
  // Render scheduling (separado)
  // -----------------------------
  const renderUI = rafThrottle(() => {
    syncToolbarFromState();
    syncGridPlayhead();
  });

  // -----------------------------
  // Notación: solo cuando cambie el patrón
  // -----------------------------
  let notationInitialized = false;
  let lastPatternRev = -1;
  let lastPatternSig = '';

  function patternSignatureFallback(s) {
    // Si no hay patternRevision, hacemos firma simple.
    // (No es perfecto, pero evita renders inútiles)
    const p = s?.pattern || {};
    const hh = Array.isArray(p.hh) ? p.hh : [];
    const sn = Array.isArray(p.sn) ? p.sn : [];
    const bd = Array.isArray(p.bd) ? p.bd : [];
    const steps = Number.isFinite(Number(s?.steps)) ? Number(s.steps) : 16;

    const pack = (arr) => {
      let out = '';
      for (let i = 0; i < steps; i++) if (arr[i]) out += i + ',';
      return out;
    };

    return `hh:${pack(hh)}|sn:${pack(sn)}|bd:${pack(bd)}|steps:${steps}`;
  }

  const renderNotation = rafThrottle(() => {
    const s = stateGet();

    const rev = Number(s.patternRevision ?? NaN);
    if (Number.isFinite(rev)) {
      if (rev === lastPatternRev) return;
      lastPatternRev = rev;
    } else {
      const sig = patternSignatureFallback(s);
      if (sig === lastPatternSig) return;
      lastPatternSig = sig;
    }

    if (typeof Notation.render === 'function') {
      Notation.render(s);
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
  function initNotationIfNeeded() {
    if (notationInitialized) return;

    if (typeof Notation.init === 'function') {
      // ✅ init recibe el contenedor, NO un <svg>
      Notation.init(els.notationRoot, stateGet());
      notationInitialized = true;

      // fuerza primer render
      lastPatternRev = -1;
      lastPatternSig = '';
      renderNotation();
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

    // BPM — NO sobrescribir mientras el usuario escribe (input enfocado)
    const bpm = clamp(Number(s.bpm ?? 90), 40, 240);
    if (document.activeElement !== els.bpmInput &&
        String(els.bpmInput.value) !== String(bpm)) {
      els.bpmInput.value = bpm;
    }

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
    try { if (typeof Audio.setBpm === 'function') Audio.setBpm(stateGet().bpm); } catch (_) {}

    // Sync UI + notación
    syncGridFromState();
    lastPatternRev = -1;
    lastPatternSig = '';
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
    lastPatternRev = -1;
    lastPatternSig = '';
    renderNotation();
    renderUI();
  }

  // -----------------------------
  // Kit / Toms / Mixer
  // -----------------------------
  function onKitChange() {
    const kit = els.kitSelect.value === 'electronic' ? 'electronic' : 'acoustic';
    if (typeof State.setKit === 'function') State.setKit(kit);
    else stateSet({ kit });
    try { if (typeof Audio.setKit === 'function') Audio.setKit(kit); } catch (_) {}
  }

  function onTomsToggle() {
    const show = !!els.tomsToggle.checked;
    if (typeof State.setShowToms === 'function') State.setShowToms(show);
    else stateSet({ showToms: show });

    // Cambia la estructura de pistas: reconstruir rejilla, mixer y notación
    syncGridFromState();
    buildMixer();
    lastPatternRev = -1;
    lastPatternSig = '';
    renderNotation();
    renderUI();
  }

  function buildMixer() {
    if (!els.mixer) return;
    const s = stateGet();
    const tracks = Array.isArray(s.tracks) ? s.tracks : [];
    const volumes = s.volumes || {};

    els.mixer.innerHTML = '';

    tracks.forEach((track) => {
      const id = String(track.id);
      const vol = Number.isFinite(Number(volumes[id])) ? Number(volumes[id]) : 0.8;

      const row = document.createElement('div');
      row.className = 'mixer__row';

      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'mixer__name';
      name.textContent = track.label || id;
      name.title = 'Escuchar';
      name.addEventListener('click', () => {
        try { if (typeof Audio.previewHit === 'function') Audio.previewHit(id); } catch (_) {}
      });

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'mixer__slider';
      slider.min = '0';
      slider.max = '100';
      slider.step = '1';
      slider.value = String(Math.round(vol * 100));
      slider.setAttribute('aria-label', `Volumen ${track.label || id}`);

      const pct = document.createElement('span');
      pct.className = 'mixer__pct';
      pct.textContent = `${Math.round(vol * 100)}%`;

      slider.addEventListener('input', () => {
        const v = clamp(Number(slider.value) / 100, 0, 1);
        pct.textContent = `${Math.round(v * 100)}%`;
        if (typeof State.setVolume === 'function') State.setVolume(id, v);
        try { if (typeof Audio.setVolume === 'function') Audio.setVolume(id, v); } catch (_) {}
      });

      row.appendChild(name);
      row.appendChild(slider);
      row.appendChild(pct);
      els.mixer.appendChild(row);
    });
  }

  // -----------------------------
  // Brush (tipo de golpe)
  // -----------------------------
  function onBrushClick(e) {
    const btn = e.target?.closest?.('.seg__btn');
    if (!btn || !els.brushSeg.contains(btn)) return;
    const level = Number(btn.dataset.brush) | 0;
    if (typeof Grid.setBrush === 'function') Grid.setBrush(level);
    [...els.brushSeg.querySelectorAll('.seg__btn')].forEach(b => {
      b.classList.toggle('is-on', b === btn);
    });
  }

  // -----------------------------
  // Métrica / compases
  // -----------------------------
  function parseMeter(str) {
    const [numStr, denStr] = String(str || '4/4').split('/');
    const num = Math.max(1, Number(numStr) || 4);
    const den = (Number(denStr) === 8) ? 8 : 4;
    // step = semicorchea (1/16) siempre
    const stepsPerBeat = (den === 8) ? 2 : 4;
    return { beatsPerBar: num, beatUnit: den, stepsPerBeat };
  }

  function applyResolution() {
    const meter = parseMeter(els.meterSelect ? els.meterSelect.value : '4/4');
    const bars = Math.max(1, Number(els.barsSelect ? els.barsSelect.value : 1) || 1);

    if (typeof State.setResolution === 'function') {
      State.setResolution({
        bars,
        beatsPerBar: meter.beatsPerBar,
        stepsPerBeat: meter.stepsPerBeat,
        beatUnit: meter.beatUnit,
      });
    }

    syncGridFromState();
    syncControlsFromState();
    lastPatternRev = -1;
    lastPatternSig = '';
    renderNotation();
    renderUI();
  }

  // -----------------------------
  // Swing / metrónomo / claqueta
  // -----------------------------
  function onSwingInput() {
    const pct = clamp(Number(els.swingRange.value) || 0, 0, 100);
    const amount = pct / 100;
    if (els.swingPct) els.swingPct.textContent = `${Math.round(pct)}%`;
    if (typeof State.set === 'function') State.set({ swing: amount });
    try { if (typeof Audio.setSwing === 'function') Audio.setSwing(amount); } catch (_) {}
  }

  function onMetroToggle() {
    const on = !!els.metroToggle.checked;
    if (typeof State.set === 'function') State.set({ metronome: on });
    try { if (typeof Audio.setMetronome === 'function') Audio.setMetronome(on); } catch (_) {}
  }

  function onCountInToggle() {
    const on = !!els.countInToggle.checked;
    if (typeof State.set === 'function') State.set({ countIn: on });
  }

  // -----------------------------
  // Exportar
  // -----------------------------
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function exportPng() {
    const svg = els.notationRoot.querySelector('svg');
    if (!svg) { alert('No hay partitura para exportar todavía.'); return; }

    const xml = new XMLSerializer().serializeToString(svg);
    const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    const img = new Image();
    img.onload = () => {
      const scale = 2; // nitidez
      const w = svg.viewBox?.baseVal?.width || svg.width.baseVal.value || img.width;
      const h = svg.viewBox?.baseVal?.height || svg.height.baseVal.value || img.height;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, 'partitura-musicala.png');
      }, 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); alert('No se pudo exportar la partitura.'); };
    img.src = url;
  }

  async function exportWav() {
    if (typeof Audio.renderToWav !== 'function') { alert('Exportación de audio no disponible.'); return; }
    const btn = els.exportWavBtn;
    const prev = btn ? btn.textContent : '';
    try {
      if (btn) { btn.disabled = true; btn.textContent = 'Generando…'; }
      const blob = await Audio.renderToWav(stateGet());
      downloadBlob(blob, 'ritmo-musicala.wav');
    } catch (err) {
      console.error('[app.js] Error exportando WAV:', err);
      alert('No se pudo exportar el audio.');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = prev; }
    }
  }

  // -----------------------------
  // Sincronizar todos los controles con el estado
  // -----------------------------
  function syncControlsFromState() {
    const s = stateGet();
    if (els.kitSelect) els.kitSelect.value = (s.kit === 'electronic') ? 'electronic' : 'acoustic';
    if (els.tomsToggle) els.tomsToggle.checked = !!s.showToms;
    if (els.meterSelect) els.meterSelect.value = `${s.beatsPerBar}/${s.beatUnit}`;
    if (els.barsSelect) els.barsSelect.value = String(s.bars);
    if (els.gridSubtitle) {
      const subdivLabel = s.stepsPerBeat === 4 ? 'semicorcheas'
        : s.stepsPerBeat === 2 ? 'corcheas'
        : s.stepsPerBeat === 3 ? 'tresillos'
        : `${s.stepsPerBeat} por pulso`;
      const barsLabel = s.bars === 1 ? '1 compás' : `${s.bars} compases`;
      els.gridSubtitle.textContent =
        `${s.steps} pasos (${subdivLabel}) · ${barsLabel} ${s.beatsPerBar}/${s.beatUnit}`;
    }
    if (els.swingRange) {
      const pct = Math.round((Number(s.swing) || 0) * 100);
      els.swingRange.value = String(pct);
      if (els.swingPct) els.swingPct.textContent = `${pct}%`;
    }
    if (els.metroToggle) els.metroToggle.checked = !!s.metronome;
    if (els.countInToggle) els.countInToggle.checked = !!s.countIn;
    if (els.bpmInput && document.activeElement !== els.bpmInput) {
      els.bpmInput.value = clamp(Number(s.bpm) || 90, 40, 240);
    }
  }

  // -----------------------------
  // Presets de usuario (localStorage)
  // -----------------------------
  const USER_PRESETS_KEY = 'drumbox.userPresets.v1';

  function loadUserPresets() {
    try {
      const raw = localStorage.getItem(USER_PRESETS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function saveUserPresets(list) {
    try { localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(list)); return true; }
    catch (err) { console.warn('[app.js] No se pudo guardar en localStorage:', err); return false; }
  }

  function refreshUserPresetSelect(selectName) {
    if (!els.userPresetSelect) return;
    const list = loadUserPresets();
    els.userPresetSelect.innerHTML = '<option value="">— Guardados —</option>';
    list.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      els.userPresetSelect.appendChild(opt);
    });
    if (selectName) els.userPresetSelect.value = selectName;
  }

  function snapshotForPreset() {
    const s = stateGet();
    return {
      name: '',
      bpm: s.bpm,
      beatsPerBar: s.beatsPerBar,
      stepsPerBeat: s.stepsPerBeat,
      beatUnit: s.beatUnit,
      bars: s.bars,
      kit: s.kit,
      showToms: !!s.showToms,
      swing: Number(s.swing) || 0,
      volumes: deepClone(s.volumes || {}),
      pattern: deepClone(s.pattern || {}),
    };
  }

  function saveCurrentAsPreset() {
    const name = String(els.presetName ? els.presetName.value : '').trim();
    if (!name) { alert('Ponle un nombre a tu ritmo antes de guardar.'); els.presetName?.focus(); return; }

    const data = snapshotForPreset();
    data.name = name;

    const list = loadUserPresets();
    const idx = list.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    if (idx >= 0) {
      if (!confirm(`Ya existe un ritmo llamado “${name}”. ¿Reemplazarlo?`)) return;
      list[idx] = data;
    } else {
      list.push(data);
    }

    if (saveUserPresets(list)) {
      refreshUserPresetSelect(name);
      if (els.presetName) els.presetName.value = '';
    }
  }

  function applyFullState(data) {
    if (!data) return;

    // 1) Estructura primero (toms y resolución) para que el patrón cuadre
    if (typeof State.setShowToms === 'function') State.setShowToms(!!data.showToms);
    if (typeof State.setResolution === 'function') {
      State.setResolution({
        bars: data.bars,
        beatsPerBar: data.beatsPerBar,
        stepsPerBeat: data.stepsPerBeat,
        beatUnit: data.beatUnit,
      });
    }

    // 2) Kit
    if (typeof State.setKit === 'function') State.setKit(data.kit);
    try { if (typeof Audio.setKit === 'function') Audio.setKit(data.kit); } catch (_) {}

    // 3) Tempo / swing
    stateSet({ bpm: clamp(Number(data.bpm) || 90, 40, 240), swing: clamp(Number(data.swing) || 0, 0, 1) });
    try { if (typeof Audio.setSwing === 'function') Audio.setSwing(Number(data.swing) || 0); } catch (_) {}
    try { if (typeof Audio.setBpm === 'function') Audio.setBpm(stateGet().bpm); } catch (_) {}

    // 4) Volúmenes
    if (data.volumes) {
      for (const id of Object.keys(data.volumes)) {
        const v = data.volumes[id];
        if (typeof State.setVolume === 'function') State.setVolume(id, v);
        try { if (typeof Audio.setVolume === 'function') Audio.setVolume(id, v); } catch (_) {}
      }
    }

    // 5) Patrón
    if (data.pattern && typeof State.setPattern === 'function') {
      State.setPattern(data.pattern);
    }

    // 6) Refrescar toda la UI
    syncControlsFromState();
    buildMixer();
    syncGridFromState();
    lastPatternRev = -1;
    lastPatternSig = '';
    renderNotation();
    renderUI();
  }

  function loadSelectedPreset() {
    const name = els.userPresetSelect ? els.userPresetSelect.value : '';
    if (!name) { alert('Elige un ritmo guardado para cargar.'); return; }
    const data = loadUserPresets().find((p) => p.name === name);
    if (!data) { alert('No se encontró ese ritmo.'); return; }
    applyFullState(data);
  }

  function deleteSelectedPreset() {
    const name = els.userPresetSelect ? els.userPresetSelect.value : '';
    if (!name) { alert('Elige un ritmo guardado para borrar.'); return; }
    if (!confirm(`¿Borrar el ritmo “${name}”?`)) return;
    const list = loadUserPresets().filter((p) => p.name !== name);
    if (saveUserPresets(list)) refreshUserPresetSelect();
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
    }, 33);
  }

  function stopPollingFallback() {
    if (!pollingTimer) return;
    clearInterval(pollingTimer);
    pollingTimer = null;
  }

  function bindAudioStepCallback() {
    if (typeof Audio.setOnStep !== 'function') return;

    Audio.setOnStep((stepIndex) => {
      stateSet({ currentStep: stepIndex });
      renderUI();
    });
  }

  async function togglePlay() {
    const s = stateGet();

    try {
      if (!s.isPlaying) {
        if (typeof Audio.setBpm === 'function') Audio.setBpm(Number(s.bpm));
        if (typeof Audio.start === 'function') await Audio.start();
        else throw new Error('audio.js no expone start()');

        stateSet({ isPlaying: true });

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
      alert(`No se pudo iniciar el audio.\n\n${err?.message || err}`);
    }
  }

  // -----------------------------
  // BPM handling (pulido)
  // -----------------------------
  const setBpmToAudioDebounced = debounce((value) => {
    try { if (typeof Audio.setBpm === 'function') Audio.setBpm(value); } catch (_) {}
  }, 120);

  function onBpmInput() {
    // Mientras escribe: limpiamos a dígitos, NO recortamos ni reescribimos el campo.
    const digits = String(els.bpmInput.value).replace(/[^0-9]/g, '');
    if (els.bpmInput.value !== digits) els.bpmInput.value = digits;
    if (digits === '') return;

    const raw = Number(digits);
    if (!Number.isFinite(raw)) return;

    // Solo aplicamos al estado/audio si ya es un valor en rango razonable.
    if (raw >= 40 && raw <= 240) {
      stateSet({ bpm: raw });
      if (stateGet().isPlaying) setBpmToAudioDebounced(raw);
    }
  }

  function onBpmChange() {
    // Al salir del campo (blur/enter): recortamos y normalizamos la vista.
    const value = clamp(Number(els.bpmInput.value) || 90, 40, 240);
    stateSet({ bpm: value });
    els.bpmInput.value = value;

    try { if (typeof Audio.setBpm === 'function') Audio.setBpm(value); } catch (_) {}
    renderUI();
  }

  // -----------------------------
  // Events
  // -----------------------------
  function bindEvents() {
    els.playBtn.addEventListener('click', togglePlay);

    els.bpmInput.addEventListener('input', onBpmInput);
    els.bpmInput.addEventListener('change', onBpmChange);
    els.bpmInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') els.bpmInput.blur();
    });

    els.clearBtn.addEventListener('click', clearPattern);
    els.rockBtn.addEventListener('click', () => applyPreset('rock'));
    els.funkBtn.addEventListener('click', () => applyPreset('funk'));

    // Presets con data-preset (reggaeton, cumbia, bossa, ...)
    document.querySelectorAll('.preset-btn').forEach((b) => {
      b.addEventListener('click', () => applyPreset(b.dataset.preset));
    });

    if (els.kitSelect) els.kitSelect.addEventListener('change', onKitChange);
    if (els.tomsToggle) els.tomsToggle.addEventListener('change', onTomsToggle);

    if (els.brushSeg) els.brushSeg.addEventListener('click', onBrushClick);
    if (els.meterSelect) els.meterSelect.addEventListener('change', applyResolution);
    if (els.barsSelect) els.barsSelect.addEventListener('change', applyResolution);
    if (els.swingRange) els.swingRange.addEventListener('input', onSwingInput);
    if (els.metroToggle) els.metroToggle.addEventListener('change', onMetroToggle);
    if (els.countInToggle) els.countInToggle.addEventListener('change', onCountInToggle);
    if (els.exportPngBtn) els.exportPngBtn.addEventListener('click', exportPng);
    if (els.exportWavBtn) els.exportWavBtn.addEventListener('click', exportWav);

    if (els.savePresetBtn) els.savePresetBtn.addEventListener('click', saveCurrentAsPreset);
    if (els.loadPresetBtn) els.loadPresetBtn.addEventListener('click', loadSelectedPreset);
    if (els.deletePresetBtn) els.deletePresetBtn.addEventListener('click', deleteSelectedPreset);
    if (els.presetName) els.presetName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveCurrentAsPreset(); }
    });

    // Barra espaciadora = play/pausa (salvo cuando se escribe en un campo)
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      const t = e.target;
      const tag = t && t.tagName ? t.tagName.toUpperCase() : '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      // Evitar que el espacio "active" un botón enfocado además de togglear
      if (tag === 'BUTTON') t.blur();
      e.preventDefault();
      togglePlay();
    });
  }

  // -----------------------------
  // Init
  // -----------------------------
  let initialized = false;

  function init() {
    if (initialized) return;
    initialized = true;

    // Asegurar forma mínima
    stateUpdate((draft) => {
      if (typeof draft.bpm !== 'number') draft.bpm = 90;
      if (typeof draft.isPlaying !== 'boolean') draft.isPlaying = false;
      if (typeof draft.currentStep !== 'number') draft.currentStep = -1;
    });

    initNotationIfNeeded();
    bindAudioStepCallback();
    initGrid();
    bindEvents();

    // Sincronizar controles con el estado inicial
    syncControlsFromState();
    refreshUserPresetSelect();
    buildMixer();

    // Render inicial
    syncGridFromState();

    // Si viene todo vacío, setea rock por defecto (igual que antes)
    const s = stateGet();
    const hasAnyStep = Object.values(s.pattern || {}).some(arr => Array.isArray(arr) && arr.some(Boolean));
    if (!hasAnyStep && Presets) {
      applyPreset('rock');
    } else {
      lastPatternRev = -1;
      lastPatternSig = '';
      renderNotation();
      renderUI();
    }

    console.log('[app.js] Inicializado ✅');
  }

  // Debug útil
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