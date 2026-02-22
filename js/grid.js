'use strict';

/* =========================================================
   drum-box /js/grid.js
   Rejilla de edición (pulido / v1.3)
   ---------------------------------------------------------
   MISMAS funciones, mejor rendimiento + limpieza:
   - Delegación de eventos (1 listener, no 48+)
   - Repaint inteligente (no recalcular todo si no toca)
   - Playhead sin borrar toda la rejilla cada frame
   - Usa DrumUtils.escapeHtml / clamp si existe
   - EstructuraChanged más robusto
   - Mantiene API pública idéntica:
     window.DrumGrid.init(rootEl, state, { onChange, onStepToggle })
     window.DrumGrid.refreshFromState(state)
     window.DrumGrid.paintCurrentStep(stepIndex)
     window.DrumGrid.setCurrentStep(stepIndex) // alias
========================================================= */

(function () {
  // -----------------------------
  // Estado interno del módulo
  // -----------------------------
  let root = null;
  let callbacks = {
    onChange: null,
    onStepToggle: null,
  };

  // stepEls[trackId][stepIndex] = button.step
  const stepEls = Object.create(null);

  // countEls[stepIndex] = div.grid-count
  const countEls = [];

  // Cache config útil
  let config = {
    countMode: 'full',
    beatsPerBar: 4,
    stepsPerBeat: 4,
    bars: 1,
    steps: 16,
    showBeatNumbersInCells: true,
  };

  // Cache playhead para no repintar todo
  let lastCurrentStep = -1;

  // Cache de ids para detectar cambios estructurales
  let lastTrackIds = [];

  // -----------------------------
  // Utils (con fallbacks)
  // -----------------------------
  const Utils = window.DrumUtils || null;

  const escapeHtml = Utils?.escapeHtml || function (text) {
    return String(text ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  };

  // -----------------------------
  // Helpers
  // -----------------------------
  function getState() {
    const S = window.DrumState;
    if (S && typeof S.get === 'function') return S.get();
    return null;
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function isQuarterStep(stepIndex, stepsPerBeat) {
    return stepIndex % stepsPerBeat === 0;
  }

  function isEighthStep(stepIndex, stepsPerBeat) {
    // Para stepsPerBeat=4 (semicorcheas): corchea cae en offset 2
    if (stepsPerBeat !== 4) return false;
    return stepIndex % stepsPerBeat === 2;
  }

  function getSubdivisionClass(stepIndex, stepsPerBeat) {
    if (isQuarterStep(stepIndex, stepsPerBeat)) return 'step--quarter';
    if (isEighthStep(stepIndex, stepsPerBeat)) return 'step--eighth';
    return 'step--sixteenth';
  }

  function getPulseBandClass(stepIndex, stepsPerBeat) {
    const pulseIndex = Math.floor(stepIndex / stepsPerBeat);
    return pulseIndex % 2 === 0 ? 'step--pulseA' : 'step--pulseB';
  }

  function getBeatNumber(stepIndex, stepsPerBeat, beatsPerBar) {
    const stepInBar = stepIndex % (stepsPerBeat * beatsPerBar);
    const beatIndexInBar = Math.floor(stepInBar / stepsPerBeat);
    return beatIndexInBar + 1;
  }

  function getCountToken(stepIndex, s) {
    const { stepsPerBeat, beatsPerBar, countMode } = s;
    const stepInBar = stepIndex % (stepsPerBeat * beatsPerBar);
    const posInBeat = stepInBar % stepsPerBeat;
    const beatNum = Math.floor(stepInBar / stepsPerBeat) + 1;

    if (stepsPerBeat === 4) {
      if (countMode === 'simple') {
        if (posInBeat === 0) return String(beatNum);
        if (posInBeat === 2) return '&';
        return '';
      }
      return [String(beatNum), 'e', '&', 'a'][posInBeat] ?? '';
    }

    if (posInBeat === 0) return String(beatNum);
    return '';
  }

  function getCountClass(stepIndex, s) {
    const { stepsPerBeat } = s;
    if (isQuarterStep(stepIndex, stepsPerBeat)) return 'count--quarter';
    if (isEighthStep(stepIndex, stepsPerBeat)) return 'count--eighth';
    return 'count--sixteenth';
  }

  function getTrackRows(state) {
    const tracks = Array.isArray(state?.tracks) ? state.tracks : [];
    if (tracks.length) return tracks;
    return [
      { id: 'hh', label: 'Hi-hat' },
      { id: 'sn', label: 'Redoblante' },
      { id: 'bd', label: 'Bombo' },
    ];
  }

  function emit(name, payload) {
    const fn = callbacks[name];
    if (typeof fn !== 'function') return;
    try { fn(payload); } catch (err) { console.warn('[grid.js] callback error:', err); }
  }

  function setCellActiveClass(trackId, stepIndex, value) {
    const row = stepEls[trackId];
    if (!row) return;
    const cell = row[stepIndex];
    if (!cell) return;
    const v = !!value;
    cell.classList.toggle('is-active', v);
    cell.setAttribute('aria-pressed', String(v));
  }

  function setCountCurrentClass(stepIndex, on) {
    const el = countEls[stepIndex];
    if (!el) return;
    el.classList.toggle('is-current', !!on);
  }

  // -----------------------------
  // Construcción DOM
  // -----------------------------
  function buildCountRow(state) {
    const steps = Number(state.steps) || 16;
    const stepsPerBeat = Number(state.stepsPerBeat) || 4;
    const beatsPerBar = Number(state.beatsPerBar) || 4;
    const bars = Number(state.bars) || 1;
    const countMode = state.countMode || 'full';

    const countLabel = document.createElement('div');
    countLabel.className = 'grid-count-label';
    countLabel.textContent = countMode === 'full' ? 'Conteo' : 'Pulso';
    root.appendChild(countLabel);

    countEls.length = 0;

    for (let i = 0; i < steps; i++) {
      const count = document.createElement('div');
      count.className = `grid-count ${getCountClass(i, { stepsPerBeat })}`;
      count.textContent = getCountToken(i, { stepsPerBeat, beatsPerBar, bars, countMode });
      count.dataset.step = String(i);
      count.dataset.role = 'count';
      root.appendChild(count);
      countEls.push(count);
    }
  }

  function buildTrackRows(state) {
    const tracks = getTrackRows(state);
    const steps = Number(state.steps) || 16;
    const stepsPerBeat = Number(state.stepsPerBeat) || 4;
    const beatsPerBar = Number(state.beatsPerBar) || 4;
    const pattern = state.pattern || {};
    const showBeatNumbersInCells = state.showBeatNumbersInCells !== false;

    // reset refs
    Object.keys(stepEls).forEach((k) => delete stepEls[k]);

    tracks.forEach((track) => {
      const trackId = String(track.id);
      const arr = Array.isArray(pattern[trackId]) ? pattern[trackId] : Array(steps).fill(false);
      stepEls[trackId] = [];

      // Label
      const label = document.createElement('div');
      label.className = 'row-label';
      label.innerHTML = `
        <span>${escapeHtml(track.label || trackId)}</span>
        ${track.shortLabel ? `<small>${escapeHtml(track.shortLabel)}</small>` : ''}
      `;
      root.appendChild(label);

      // Celdas
      for (let i = 0; i < steps; i++) {
        const btn = document.createElement('button');
        btn.type = 'button';

        const subdivisionClass = getSubdivisionClass(i, stepsPerBeat);
        const pulseBandClass = getPulseBandClass(i, stepsPerBeat);

        btn.className = `step ${subdivisionClass} ${pulseBandClass}`;
        btn.dataset.trackId = trackId;
        btn.dataset.stepIndex = String(i);
        btn.setAttribute('role', 'switch');
        btn.setAttribute('aria-label', `${track.label || trackId}, paso ${i + 1}`);
        btn.setAttribute('aria-pressed', String(!!arr[i]));

        if (showBeatNumbersInCells && isQuarterStep(i, stepsPerBeat)) {
          btn.classList.add('step--beat-marker');
          btn.dataset.beat = String(getBeatNumber(i, stepsPerBeat, beatsPerBar));
        }

        if (arr[i]) btn.classList.add('is-active');

        // OJO: ya NO ponemos listeners por botón (delegación abajo)
        root.appendChild(btn);
        stepEls[trackId].push(btn);
      }
    });
  }

  // -----------------------------
  // Delegación de eventos (1 listener)
  // -----------------------------
  function bindDelegatedEvents() {
    // Evitar duplicar bindings si rebuild se llama varias veces
    root.removeEventListener('click', onRootClick);
    root.removeEventListener('keydown', onRootKeydown);

    root.addEventListener('click', onRootClick);
    root.addEventListener('keydown', onRootKeydown);
  }

  function onRootClick(event) {
    const btn = event.target?.closest?.('button.step');
    if (!btn || !root || !root.contains(btn)) return;

    const trackId = btn.dataset.trackId;
    const stepIndex = Number(btn.dataset.stepIndex);

    if (!trackId || !Number.isFinite(stepIndex)) return;

    let nextValue = false;

    const S = window.DrumState;
    if (S && typeof S.toggleStep === 'function') {
      nextValue = !!S.toggleStep(trackId, stepIndex);
    } else {
      // fallback
      nextValue = !btn.classList.contains('is-active');
    }

    setCellActiveClass(trackId, stepIndex, nextValue);

    emit('onStepToggle', { trackId, stepIndex, value: nextValue });
    emit('onChange', { source: 'grid-cell', trackId, stepIndex, value: nextValue });
  }

  function onRootKeydown(event) {
    const btn = event.target?.closest?.('button.step');
    if (!btn || !root || !root.contains(btn)) return;

    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    btn.click();
  }

  // -----------------------------
  // API pública
  // -----------------------------
  function init(rootEl, state, opts = {}) {
    if (!rootEl) throw new Error('DrumGrid.init requiere rootEl');
    root = rootEl;

    callbacks.onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
    callbacks.onStepToggle = typeof opts.onStepToggle === 'function' ? opts.onStepToggle : null;

    rebuild(state || getState() || {});
  }

  function rebuild(state) {
    if (!root) throw new Error('DrumGrid no ha sido inicializado');

    // Cache config útil
    config = {
      countMode: state.countMode || 'full',
      beatsPerBar: Number(state.beatsPerBar) || 4,
      stepsPerBeat: Number(state.stepsPerBeat) || 4,
      bars: Number(state.bars) || 1,
      steps: Number(state.steps) || 16,
      showBeatNumbersInCells: state.showBeatNumbersInCells !== false,
    };

    clearChildren(root);

    // Clase base por si no estaba
    root.classList.add('drum-grid');

    // Si el CSS se queda fijo en 16, esto no rompe nada.
    // Pero si luego ponen --steps en CSS, aquí ya queda listo:
    root.style.setProperty('--steps', String(config.steps));

    // Tracks cache
    const tracks = getTrackRows(state);
    lastTrackIds = tracks.map(t => String(t.id));

    buildCountRow(state);
    buildTrackRows(state);

    // Delegación (1 vez por rebuild)
    bindDelegatedEvents();

    // Pintar playhead inicial sin limpiar todo
    lastCurrentStep = -1;
    paintCurrentStep(Number(state.currentStep ?? -1));
  }

  function refreshFromState(state) {
    if (!root) return;
    if (!state) state = getState();
    if (!state) return;

    const tracks = getTrackRows(state);
    const nextTrackIds = tracks.map(t => String(t.id));

    const nextConfig = {
      countMode: state.countMode || 'full',
      beatsPerBar: Number(state.beatsPerBar) || 4,
      stepsPerBeat: Number(state.stepsPerBeat) || 4,
      bars: Number(state.bars) || 1,
      steps: Number(state.steps) || 16,
      showBeatNumbersInCells: state.showBeatNumbersInCells !== false,
    };

    const structureChanged =
      nextConfig.steps !== config.steps ||
      nextConfig.stepsPerBeat !== config.stepsPerBeat ||
      nextConfig.beatsPerBar !== config.beatsPerBar ||
      nextConfig.bars !== config.bars ||
      nextConfig.countMode !== config.countMode ||
      nextConfig.showBeatNumbersInCells !== config.showBeatNumbersInCells ||
      nextTrackIds.length !== lastTrackIds.length ||
      nextTrackIds.some((id, i) => id !== lastTrackIds[i]);

    if (structureChanged) {
      rebuild(state);
      return;
    }

    // Solo sincronizar activos (sin tocar DOM completo)
    const pattern = state.pattern || {};
    for (const trackId of nextTrackIds) {
      const row = stepEls[trackId] || [];
      const arr = Array.isArray(pattern[trackId]) ? pattern[trackId] : [];
      const len = row.length;

      for (let i = 0; i < len; i++) {
        const value = !!arr[i];
        // micro-optim: solo tocar si cambió
        const el = row[i];
        const isActive = el.classList.contains('is-active');
        if (value !== isActive) {
          el.classList.toggle('is-active', value);
          el.setAttribute('aria-pressed', String(value));
        }
      }
    }

    // Sync playhead (sin barrer todo)
    paintCurrentStep(Number(state.currentStep ?? -1));
  }

  function paintCurrentStep(stepIndex) {
    const idx = Number(stepIndex);

    // Si no cambió, no hacer nada
    if (idx === lastCurrentStep) return;

    // Quitar current del anterior (solo esos nodos)
    if (Number.isInteger(lastCurrentStep) && lastCurrentStep >= 0) {
      for (const row of Object.values(stepEls)) {
        const prev = row[lastCurrentStep];
        if (prev) prev.classList.remove('is-current');
      }
      setCountCurrentClass(lastCurrentStep, false);
    }

    lastCurrentStep = Number.isFinite(idx) ? Math.trunc(idx) : -1;

    // Si es inválido, listo
    if (!Number.isInteger(lastCurrentStep) || lastCurrentStep < 0) return;

    // Pintar current del nuevo
    for (const row of Object.values(stepEls)) {
      const el = row[lastCurrentStep];
      if (el) el.classList.add('is-current');
    }
    setCountCurrentClass(lastCurrentStep, true);
  }

  // Alias por compatibilidad con app.js
  const setCurrentStep = paintCurrentStep;

  // -----------------------------
  // Exposición global
  // -----------------------------
  window.DrumGrid = {
    init,
    rebuild,
    refreshFromState,
    paintCurrentStep,
    setCurrentStep,
  };
})();