/* Звук и вибрация. Подписывается на document-событие 'sudoku:event'
 * (его рассылает ui.js) и ничего не знает об интерфейсе игры.
 *
 * Звуки синтезируются WebAudio на лету — аудиофайлов нет, поэтому
 * нечего кешировать и нечего догружать офлайн.
 * Вибрация работает только там, где есть navigator.vibrate (Android);
 * iOS её не поддерживает, и это не ошибка — там просто ничего не происходит. */
(function (root) {
  'use strict';

  const settings = SudokuStorage.getSettings();   // { sound, vibration }
  let ctx = null;
  let master = null;

  /* ---------- AudioContext и политика автовоспроизведения ---------- */

  function ensureContext() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    } catch (e) {
      ctx = null;
    }
    return ctx;
  }

  // iOS Safari и Chrome создают контекст в состоянии suspended и разрешают
  // resume() только из обработчика жеста пользователя. Слушаем touchend/click/keydown
  // (pointerdown и touchstart iOS жестом для звука не считает) и снимаем
  // слушатели, когда контекст реально заработал
  function unlock() {
    const c = ensureContext();
    if (!c) return;
    if (c.state === 'running') {
      detachUnlock();
      return;
    }
    c.resume().then(() => {
      if (c.state === 'running') detachUnlock();
    }).catch(() => { /* повторим при следующем жесте */ });
  }

  const UNLOCK_EVENTS = ['touchend', 'click', 'keydown'];

  function detachUnlock() {
    UNLOCK_EVENTS.forEach((t) => document.removeEventListener(t, unlock, true));
  }

  UNLOCK_EVENTS.forEach((t) => document.addEventListener(t, unlock, true));

  // Свернули приложение — гасим звук, вернулись — возобновляем.
  // На iOS после звонка или блокировки контекст может оказаться в 'interrupted'
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) {
      if (ctx.state === 'running') ctx.suspend().catch(() => {});
    } else if (ctx.state !== 'running') {
      ctx.resume().catch(() => {});
    }
  });

  /* ---------- Синтез звуков ---------- */

  // Одна нота: быстрое нарастание и затухание убирают щелчки на стыках
  function tone(freq, delay, dur, opts) {
    const o = opts || {};
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(o.slideTo, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(o.vol || 0.2, t0 + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  const SOUNDS = {
    select: () => tone(1100, 0, 0.03, { vol: 0.07 }),
    place:  () => tone(660, 0, 0.09, { type: 'triangle', vol: 0.22 }),
    note:   () => tone(1000, 0, 0.04, { vol: 0.1 }),
    erase:  () => tone(420, 0, 0.08, { slideTo: 260, vol: 0.15 }),
    undo:   () => tone(500, 0, 0.07, { slideTo: 380, vol: 0.12 }),
    redo:   () => tone(500, 0, 0.07, { slideTo: 650, vol: 0.12 }),
    mode:   () => tone(900, 0, 0.05, { vol: 0.1 }),
    hint:   () => { tone(784, 0, 0.12, { vol: 0.18 }); tone(1175, 0.1, 0.18, { vol: 0.18 }); },
    error:  () => tone(170, 0, 0.22, { type: 'sawtooth', slideTo: 120, vol: 0.16 }),
    win:    () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.14, 0.28, { type: 'triangle', vol: 0.22 })),
    lose:   () => [392, 330, 262].forEach((f, i) => tone(f, i * 0.18, 0.3, { type: 'triangle', vol: 0.18 }))
  };

  // Паттерны вибрации в миллисекундах (чётные — вибрация, нечётные — пауза).
  // На выбор клетки вибрации нет: она раздражала бы при каждом касании
  const VIBRATION = {
    place: 8, note: 5, erase: 8, undo: 8, redo: 8, mode: 6, hint: 15,
    error: [50, 40, 50],
    win: [40, 60, 40, 60, 160],
    lose: 220
  };

  function canVibrate() {
    return typeof navigator.vibrate === 'function';
  }

  function playSound(type) {
    const fn = SOUNDS[type];
    if (!fn || !ensureContext() || ctx.state !== 'running') return;   // пока нет жеста — молчим
    fn();
  }

  function vibrate(type) {
    const pattern = VIBRATION[type];
    if (pattern === undefined || !canVibrate()) return;
    try { navigator.vibrate(pattern); } catch (e) { /* некоторые браузеры блокируют без жеста */ }
  }

  document.addEventListener('sudoku:event', (e) => {
    const type = e.detail && e.detail.type;
    if (settings.sound) playSound(type);
    if (settings.vibration) vibrate(type);
  });

  root.SudokuAudio = {
    isSoundOn: () => settings.sound,
    isVibrationOn: () => settings.vibration,
    canVibrate,
    setSound(on) {
      settings.sound = !!on;
      SudokuStorage.saveSettings({ sound: settings.sound });
    },
    setVibration(on) {
      settings.vibration = !!on;
      SudokuStorage.saveSettings({ vibration: settings.vibration });
    }
  };
})(window);
