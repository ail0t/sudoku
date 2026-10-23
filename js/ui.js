/* Интерфейс игры: сетка 9x9, панель цифр, заметки, таймер, диалоги.
 * Логику ходов делает Sudoku.Game, сохранение — SudokuStorage;
 * здесь только отображение и связывание событий.
 *
 * Для звука и вибрации (Этап 4) на каждое значимое действие рассылается
 * document-событие 'sudoku:event' с detail.type: select, place, note, erase,
 * undo, redo, hint, error, mode, win, lose. ui.js о них ничего не знает. */
(function () {
  'use strict';

  const { Game, LEVELS, MAX_ERRORS } = Sudoku;

  const $ = (id) => document.getElementById(id);
  const appEl = $('app');
  const boardEl = $('board');
  const numpadEl = $('numpad');
  const overlayEl = $('overlay');
  const dialogTitleEl = $('dialog-title');
  const dialogTextEl = $('dialog-text');
  const dialogActionsEl = $('dialog-actions');
  const toastEl = $('toast');
  const liveEl = $('live');
  const timerEl = $('timer');
  const errorsEl = $('errors');
  const numButtons = Array.from(numpadEl.querySelectorAll('.num-btn'));

  const undoBtn = $('undo-btn');
  const redoBtn = $('redo-btn');
  const notesBtn = $('notes-btn');
  const hintBtn = $('hint-btn');

  // Флаги подсветки клетки — храним числом, чтобы быстро сравнивать «было/стало»
  const F_SELECTED = 1, F_RELATED = 2, F_CONFLICT = 4, F_WRONG = 8;

  const state = {
    game: null,
    selected: null,          // индекс выбранной клетки или null
    notesMode: false,
    paused: false,
    dialogOpen: false,
    timerId: null,
    marks: new Set(),        // клетки, подсвеченные кнопкой «Проверить»
    conflicts: new Set()     // клетки с дублями цифр
  };

  let cells = [];            // по одной записи на клетку: { el, val, marks[], v, n, flags }
  let toastTimer = null;

  /* ---------- Вспомогательное ---------- */

  function emit(type, extra) {
    document.dispatchEvent(new CustomEvent('sudoku:event', { detail: Object.assign({ type }, extra) }));
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  // Перезапуск CSS-анимации на элементе, у которого она уже могла отыграть
  function restartAnim(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;     // принудительный пересчёт стилей, иначе браузер склеит удаление и добавление
    el.classList.add(cls);
  }

  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  // Сообщение для VoiceOver/TalkBack: сначала очищаем регион, иначе
  // одинаковый текст подряд не будет озвучен
  function announce(text) {
    liveEl.textContent = '';
    setTimeout(() => { liveEl.textContent = text; }, 50);
  }

  function save() {
    const g = state.game;
    if (g && g.status === 'playing') SudokuStorage.saveGame(g.toJSON());
  }

  /* ---------- Построение и отрисовка поля ---------- */

  function buildBoard() {
    const frag = document.createDocumentFragment();
    cells = [];
    for (let r = 0; r < 9; r++) {
      // Строки нужны для ARIA (role="grid" требует role="row");
      // сами строки — вложенные CSS Grid, поэтому семантика не страдает
      const row = document.createElement('div');
      row.className = 'row';
      row.setAttribute('role', 'row');
      for (let c = 0; c < 9; c++) {
        const i = r * 9 + c;
        const el = document.createElement('div');
        el.className = 'cell';
        el.setAttribute('role', 'gridcell');
        el.tabIndex = i === 0 ? 0 : -1;       // «плавающий» tabindex: в поле один пункт Tab
        el.dataset.i = i;
        el.style.setProperty('--d', r + c);   // задержка волны при победе

        const val = document.createElement('span');
        val.className = 'val';
        const notes = document.createElement('span');
        notes.className = 'notes';
        notes.setAttribute('aria-hidden', 'true');
        const marks = [];
        for (let d = 1; d <= 9; d++) {
          const s = document.createElement('span');
          notes.appendChild(s);
          marks.push(s);
        }
        el.append(val, notes);
        row.appendChild(el);
        cells.push({ el, val, marks, v: -1, n: -1, flags: 0 });
      }
      frag.appendChild(row);
    }
    boardEl.replaceChildren(frag);
  }

  function cellLabel(i) {
    const g = state.game;
    const v = g.values[i];
    let text = 'Строка ' + (Sudoku.rowOf(i) + 1) + ', столбец ' + (Sudoku.colOf(i) + 1) + ', ';
    if (v) {
      text += 'цифра ' + v + (g.isGiven(i) ? ', исходная' : '');
    } else if (g.notes[i]) {
      const list = [];
      for (let d = 1; d <= 9; d++) if (g.notes[i] & (1 << (d - 1))) list.push(d);
      text += 'заметки ' + list.join(', ');
    } else {
      text += 'пусто';
    }
    return text;
  }

  // Обновляем только то, что изменилось: лишние записи в DOM на слабых
  // Android-устройствах заметно тормозят
  function renderCell(i, animate) {
    const g = state.game;
    const c = cells[i];
    const v = g.values[i];
    const n = g.notes[i];
    if (c.v === v && c.n === n) return;

    if (c.v !== v) {
      const given = g.isGiven(i);
      c.val.textContent = v || '';
      c.el.classList.toggle('filled', v !== 0);
      c.el.classList.toggle('given', given);
      c.el.classList.toggle('user', v !== 0 && !given);
      if (animate && v !== 0) restartAnim(c.val, 'pop');
    }
    for (let d = 1; d <= 9; d++) {
      c.marks[d - 1].textContent = (v === 0 && (n & (1 << (d - 1)))) ? d : '';
    }
    c.v = v;
    c.n = n;
    c.el.setAttribute('aria-label', cellLabel(i));
    c.el.setAttribute('aria-selected', i === state.selected ? 'true' : 'false');
  }

  function renderHighlights() {
    const sel = state.selected;
    const peers = sel === null ? null : new Set(Sudoku.peersOf(sel));
    for (let i = 0; i < 81; i++) {
      let f = 0;
      if (i === sel) f |= F_SELECTED;
      else if (peers && peers.has(i)) f |= F_RELATED;
      if (state.conflicts.has(i)) f |= F_CONFLICT;
      if (state.marks.has(i)) f |= F_WRONG;

      const c = cells[i];
      const diff = f ^ c.flags;
      if (!diff) continue;
      if (diff & F_SELECTED) {
        c.el.classList.toggle('selected', !!(f & F_SELECTED));
        c.el.setAttribute('aria-selected', (f & F_SELECTED) ? 'true' : 'false');
      }
      if (diff & F_RELATED) c.el.classList.toggle('related', !!(f & F_RELATED));
      if (diff & F_CONFLICT) c.el.classList.toggle('conflict', !!(f & F_CONFLICT));
      if (diff & F_WRONG) c.el.classList.toggle('wrong', !!(f & F_WRONG));
      c.flags = f;
    }
  }

  function renderStatus() {
    const g = state.game;
    errorsEl.textContent = 'Ошибки: ' + g.errors + '/' + MAX_ERRORS;
    errorsEl.classList.toggle('danger', g.errors > 0);

    const left = g.remainingCounts();
    numButtons.forEach((btn) => {
      const n = Number(btn.dataset.num);
      btn.querySelector('.num-left').textContent = left[n];
      btn.classList.toggle('done', left[n] === 0);
      btn.setAttribute('aria-label', 'Цифра ' + n + ', осталось ' + left[n]);
    });

    undoBtn.disabled = !g.history.length;
    redoBtn.disabled = !g.future.length;
    hintBtn.textContent = 'Подсказка (' + g.hintsLeft + ')';
    hintBtn.disabled = g.hintsLeft <= 0;
    notesBtn.setAttribute('aria-pressed', state.notesMode ? 'true' : 'false');
    timerEl.textContent = formatTime(g.elapsed);
  }

  function renderAll() {
    const g = state.game;
    for (let i = 0; i < 81; i++) {
      cells[i].v = -1;                 // сбрасываем кеш, чтобы клетки перерисовались целиком
      cells[i].n = -1;
      cells[i].flags = 0;
      cells[i].el.className = 'cell';
      renderCell(i, false);
    }
    state.conflicts = g.getConflicts();
    renderHighlights();
    renderStatus();
    $('difficulty-label').textContent = LEVELS[g.difficulty].label;
  }

  // Размер клетки нужен CSS для размера цифр; считаем после показа экрана,
  // пока он скрыт, ширина поля равна нулю
  function recalculateLayout() {
    const w = boardEl.clientWidth;
    if (w) boardEl.style.setProperty('--cell-px', (w / 9).toFixed(2) + 'px');
  }

  /* ---------- Таймер ---------- */

  function startTimer() {
    if (state.timerId) return;
    state.timerId = setInterval(tick, 1000);
  }

  function stopTimer() {
    clearInterval(state.timerId);
    state.timerId = null;
  }

  function tick() {
    const g = state.game;
    if (!g || g.status !== 'playing' || state.paused) return;
    g.elapsed++;
    timerEl.textContent = formatTime(g.elapsed);
    if (g.elapsed % 10 === 0) save();   // раз в 10 секунд, чтобы при вылете не потерять время
  }

  /* ---------- Диалоги ---------- */

  function showDialog(opts) {
    dialogTitleEl.textContent = opts.title;
    dialogTextEl.replaceChildren();
    if (opts.body) dialogTextEl.appendChild(opts.body);
    else dialogTextEl.textContent = opts.text || '';

    dialogActionsEl.replaceChildren();
    opts.buttons.forEach((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ' + (b.primary ? 'btn-primary' : 'btn-secondary');
      btn.textContent = b.label;
      btn.addEventListener('click', b.onClick);
      dialogActionsEl.appendChild(btn);
    });

    overlayEl.classList.toggle('opaque', !!opts.opaque);
    overlayEl.hidden = false;
    appEl.inert = true;                 // фон не получает фокус и не читается экранным диктором
    state.dialogOpen = true;
    const first = dialogActionsEl.querySelector('.btn-primary') || dialogActionsEl.firstElementChild;
    if (first) first.focus({ preventScroll: true });
  }

  function hideDialog() {
    overlayEl.hidden = true;
    appEl.inert = false;
    state.dialogOpen = false;
  }

  /* ---------- Жизненный цикл партии ---------- */

  function setupGame(game) {
    stopTimer();
    hideDialog();
    state.game = game;
    state.selected = null;
    state.notesMode = false;
    state.paused = false;
    state.marks = new Set();
    state.conflicts = new Set();
    boardEl.classList.remove('win');

    if (!cells.length) buildBoard();
    App.showScreen('game');
    renderAll();
    recalculateLayout();
    requestAnimationFrame(recalculateLayout);   // страховка: размеры могли устояться уже после показа
    startTimer();
  }

  function startNewGame(difficulty) {
    setupGame(Game.create(difficulty));
    save();
  }

  function continueGame() {
    const game = Game.fromJSON(SudokuStorage.loadGame());
    if (!game) {
      // Сохранение повреждено или от старой версии — убираем, чтобы кнопка не обманывала
      SudokuStorage.clearGame();
      App.refreshContinueButton();
      showToast('Не удалось восстановить игру');
      return;
    }
    setupGame(game);
  }

  function confirmNewGame(difficulty) {
    showDialog({
      title: 'Начать новую игру?',
      text: 'Незавершённая партия будет потеряна.',
      buttons: [
        { label: 'Начать', primary: true, onClick: () => { hideDialog(); startNewGame(difficulty); } },
        { label: 'Отмена', onClick: hideDialog }
      ]
    });
  }

  function leaveToMenu() {
    save();
    stopTimer();
    hideDialog();
    state.game = null;
    state.paused = false;
    App.refreshContinueButton();
    App.showScreen('menu');
  }

  function pause() {
    const g = state.game;
    if (!g || g.status !== 'playing' || state.paused) return;
    state.paused = true;
    stopTimer();
    save();
    const body = document.createElement('div');
    body.append(el('p', '', 'Таймер остановлен.'),
                el('p', 'dialog-dedication', 'для любимой Лизаньки❤️'));
    // Сплошной фон: на паузе поле видеть нельзя, иначе можно думать «бесплатно»
    showDialog({
      title: 'Пауза',
      body,
      opaque: true,
      buttons: [
        { label: 'Продолжить', primary: true, onClick: resume },
        { label: 'Новая игра', onClick: leaveToMenu }
      ]
    });
  }

  function resume() {
    hideDialog();
    state.paused = false;
    startTimer();
  }

  function finish() {
    const g = state.game;
    stopTimer();
    const won = g.status === 'won';
    const summary = g.summary();
    const fresh = SudokuStorage.recordResult(summary);   // ровно один раз на партию
    SudokuStorage.clearGame();
    emit(won ? 'win' : 'lose');
    announce(won ? 'Победа!' : 'Игра окончена');
    if (won) boardEl.classList.add('win');
    // Небольшая задержка: даём доиграть анимацию победы и увидеть последний ход
    setTimeout(() => {
      if (state.game === g) showResult(summary, fresh);
    }, won ? 900 : 500);
  }

  function showResult(summary, fresh) {
    const won = summary.result === 'won';
    const body = document.createElement('div');
    [
      'Сложность: ' + LEVELS[summary.difficulty].label,
      'Время: ' + formatTime(summary.time),
      'Ошибки: ' + summary.errors
    ].forEach((t) => {
      const p = document.createElement('p');
      p.textContent = t;
      body.appendChild(p);
    });
    fresh.forEach((a) => {
      const p = document.createElement('p');
      p.className = 'dialog-achievement';
      p.textContent = 'Достижение: ' + a.title;
      body.appendChild(p);
    });

    showDialog({
      title: won ? 'Победа!' : 'Игра окончена',
      body,
      buttons: [
        { label: 'Новая игра', primary: true, onClick: () => startNewGame(summary.difficulty) },
        { label: 'В меню', onClick: leaveToMenu }
      ]
    });
  }

  /* ---------- Действия игрока ---------- */

  function canAct() {
    const g = state.game;
    return !!g && g.status === 'playing' && !state.paused && !state.dialogOpen;
  }

  function select(i, silent) {
    if (state.selected !== null) cells[state.selected].el.tabIndex = -1;
    state.selected = i;
    cells[i].el.tabIndex = 0;
    renderHighlights();
    if (!silent) emit('select');
  }

  // Общая часть любого изменения поля: перерисовать, подсветить, сохранить
  function afterMove(res, eventType) {
    const g = state.game;
    state.marks.clear();                 // отметки «Проверить» живут до следующего хода
    res.changed.forEach((i) => renderCell(i, true));

    // Пульсируют только клетки, ставшие конфликтными именно сейчас
    const next = g.getConflicts();
    next.forEach((i) => {
      if (!state.conflicts.has(i)) restartAnim(cells[i].val, 'pulse');
    });
    state.conflicts = next;

    renderHighlights();
    renderStatus();
    save();

    if (res.wrong) {
      emit('error');
      announce('Неверная цифра. Ошибок: ' + g.errors + ' из ' + MAX_ERRORS);
    } else {
      emit(eventType);
    }
    if (g.status !== 'playing') finish();
  }

  function onNumber(n) {
    if (!canAct()) return;
    if (state.selected === null) {
      showToast('Сначала выберите клетку');
      return;
    }
    const g = state.game;
    const res = state.notesMode ? g.toggleNote(state.selected, n) : g.setValue(state.selected, n);
    if (res) afterMove(res, state.notesMode ? 'note' : 'place');
  }

  function onErase() {
    if (!canAct() || state.selected === null) return;
    const res = state.game.erase(state.selected);
    if (res) afterMove(res, 'erase');
  }

  function onUndo() {
    if (!canAct()) return;
    const res = state.game.undo();
    if (res) afterMove(res, 'undo');
  }

  function onRedo() {
    if (!canAct()) return;
    const res = state.game.redo();
    if (res) afterMove(res, 'redo');
  }

  function onHint() {
    if (!canAct()) return;
    const g = state.game;
    const res = g.hint(state.selected === null ? undefined : state.selected);
    if (!res) {
      showToast(g.hintsLeft <= 0 ? 'Подсказки закончились' : 'Подсказывать нечего');
      return;
    }
    select(res.idx, true);
    afterMove(res, 'hint');
  }

  function onCheck() {
    if (!canAct()) return;
    const wrong = state.game.check();
    state.marks = new Set(wrong);
    renderHighlights();
    const text = wrong.length ? 'Неверных цифр: ' + wrong.length : 'Ошибок нет';
    showToast(text);
    announce(text);
  }

  function toggleNotesMode() {
    if (!canAct()) return;
    state.notesMode = !state.notesMode;
    notesBtn.setAttribute('aria-pressed', state.notesMode ? 'true' : 'false');
    emit('mode', { notes: state.notesMode });
  }

  function moveSelection(dr, dc) {
    const from = state.selected === null ? 0 : state.selected;
    const r = Math.min(8, Math.max(0, Sudoku.rowOf(from) + dr));
    const c = Math.min(8, Math.max(0, Sudoku.colOf(from) + dc));
    const i = r * 9 + c;
    select(i);
    cells[i].el.focus({ preventScroll: true });
  }

  /* ---------- Настройки ---------- */

  function setToggle(btn, on) {
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.querySelector('.toggle-state').textContent = on ? 'Вкл' : 'Выкл';
  }

  function bindSettings() {
    const soundBtn = $('sound-toggle');
    const vibBtn = $('vibration-toggle');

    setToggle(soundBtn, SudokuAudio.isSoundOn());
    soundBtn.addEventListener('click', () => {
      const on = !SudokuAudio.isSoundOn();
      SudokuAudio.setSound(on);
      setToggle(soundBtn, on);
      if (on) emit('mode');          // короткий щелчок: заодно подтверждает, что звук работает
    });

    // iOS не поддерживает вибрацию в PWA — переключатель только запутал бы
    if (!SudokuAudio.canVibrate()) {
      vibBtn.hidden = true;
      return;
    }
    setToggle(vibBtn, SudokuAudio.isVibrationOn());
    vibBtn.addEventListener('click', () => {
      const on = !SudokuAudio.isVibrationOn();
      SudokuAudio.setVibration(on);
      setToggle(vibBtn, on);
      if (on) emit('mode');
    });
  }

  /* ---------- Статистика ---------- */

  const dateFormat = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Список «название — значение» для <dl>; обёртка div допустима в HTML5
  function fillDl(dl, rows) {
    dl.replaceChildren();
    rows.forEach(([name, value]) => {
      const wrap = el('div');
      wrap.append(el('dt', '', name), el('dd', '', String(value)));
      dl.appendChild(wrap);
    });
  }

  function renderStats() {
    const stats = SudokuStorage.getStats();

    fillDl($('stats-summary'), [
      ['Игр сыграно', stats.gamesPlayed],
      ['Побед', stats.wins],
      ['Без ошибок', stats.flawlessWins]
    ]);

    fillDl($('stats-best'), Object.keys(LEVELS).map((id) => [
      LEVELS[id].label,
      stats.best[id] === null ? '—' : formatTime(stats.best[id])
    ]));

    // Статус пишем словами, а не только цветом: цвет не должен быть единственным признаком
    const achList = $('stats-achievements');
    achList.replaceChildren();
    SudokuStorage.getAchievements().forEach((a) => {
      const li = el('li', 'achievement ' + (a.unlocked ? 'unlocked' : 'locked'));
      const status = a.unlocked
        ? 'Получено ' + dateFormat.format(new Date(a.date))
        : 'Не получено';
      li.append(el('div', 'achievement-title', a.title),
                el('div', 'achievement-desc', a.description),
                el('div', 'achievement-status', status));
      achList.appendChild(li);
    });

    const histList = $('stats-history');
    histList.replaceChildren();
    const history = SudokuStorage.getHistory();
    if (!history.length) {
      histList.appendChild(el('li', 'empty-note', 'Пока пусто. Сыграйте первую партию, и она появится здесь.'));
      return;
    }
    history.forEach((h) => {
      const level = LEVELS[h.difficulty];
      const won = h.result === 'won';
      const li = el('li', 'history-item');
      li.append(
        el('span', 'history-level', level ? level.label : h.difficulty),
        el('span', 'history-time', formatTime(h.time)),
        el('span', 'history-meta', dateFormat.format(new Date(h.date)) + ', ошибок: ' + h.errors),
        el('span', 'history-result ' + (won ? 'won' : 'lost'), won ? 'Победа' : 'Поражение')
      );
      histList.appendChild(li);
    });
  }

  function bindStats() {
    $('stats-btn').addEventListener('click', () => {
      renderStats();
      App.showScreen('stats');
      $('stats-back-btn').focus({ preventScroll: true });
    });
    $('stats-back-btn').addEventListener('click', () => App.showScreen('menu'));
  }

  /* ---------- Привязка событий ---------- */

  function bindEvents() {
    boardEl.addEventListener('click', (e) => {
      const el = e.target.closest('.cell');
      if (el && canAct()) select(Number(el.dataset.i));
    });

    // Классы анимаций снимаем сами, чтобы их можно было запустить снова
    boardEl.addEventListener('animationend', (e) => {
      e.target.classList.remove('pop', 'pulse');
    });

    numpadEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.num-btn');
      if (btn) onNumber(Number(btn.dataset.num));
    });

    $('erase-btn').addEventListener('click', onErase);
    undoBtn.addEventListener('click', onUndo);
    redoBtn.addEventListener('click', onRedo);
    hintBtn.addEventListener('click', onHint);
    $('check-btn').addEventListener('click', onCheck);
    notesBtn.addEventListener('click', toggleNotesMode);
    $('pause-btn').addEventListener('click', pause);

    // События от app.js (меню)
    document.addEventListener('sudoku:new-game', (e) => {
      const level = e.detail.difficulty;
      if (SudokuStorage.hasSavedGame()) confirmNewGame(level);
      else startNewGame(level);
    });
    document.addEventListener('sudoku:continue', continueGame);
    document.addEventListener('sudoku:leave-game', () => {
      // Вызывается кнопкой «назад» ДО смены экрана; app.js сам обновит меню
      save();
      stopTimer();
      state.game = null;
    });

    // Свернули приложение — ставим на паузу и сохраняем: iOS и Android могут
    // выгрузить страницу из памяти без предупреждения
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (state.game && state.game.status === 'playing') pause();
        save();
      }
    });
    window.addEventListener('pagehide', save);

    // Поворот и изменение размера: debounce, чтобы не пересчитывать на каждый кадр анимации
    const recalc = debounce(recalculateLayout, 100);
    window.addEventListener('resize', recalc);
    window.addEventListener('orientationchange', recalc);

    // Клавиатура (удобно при проверке на компьютере и для внешних клавиатур)
    document.addEventListener('keydown', (e) => {
      if (!canAct()) return;
      if (e.key >= '1' && e.key <= '9') onNumber(Number(e.key));
      else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') onErase();
      else if (e.key === 'ArrowUp') moveSelection(-1, 0);
      else if (e.key === 'ArrowDown') moveSelection(1, 0);
      else if (e.key === 'ArrowLeft') moveSelection(0, -1);
      else if (e.key === 'ArrowRight') moveSelection(0, 1);
      else if (e.key === 'n' || e.key === 'N' || e.key === 'т' || e.key === 'Т') toggleNotesMode();
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        if (e.shiftKey) onRedo(); else onUndo();
      } else return;
      e.preventDefault();
    });
  }

  bindEvents();
  bindSettings();
  bindStats();
})();
