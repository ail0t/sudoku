/* Логика судоку: решатель, генератор с уровнями сложности, проверка
 * конфликтов и класс Game (ходы, заметки, отмена/повтор, подсказки).
 * Модуль не трогает DOM и localStorage — его можно тестировать в Node. */
(function (root) {
  'use strict';

  const FULL = 0x1FF;            // девять установленных битов: все цифры 1–9 допустимы
  const MAX_ERRORS = 3;
  const MAX_HINTS = 3;
  const HISTORY_LIMIT = 100;     // ТЗ требует минимум 10 шагов отмены
  const SAVE_VERSION = 1;

  /* ---------- Геометрия поля ---------- */

  // Таблицы считаем один раз: в решателе они вызываются сотни тысяч раз,
  // и деление/остаток на каждом шаге заметно тормозили бы генерацию
  const ROW = new Uint8Array(81);
  const COL = new Uint8Array(81);
  const BOX = new Uint8Array(81);
  for (let i = 0; i < 81; i++) {
    ROW[i] = Math.floor(i / 9);
    COL[i] = i % 9;
    BOX[i] = Math.floor(ROW[i] / 3) * 3 + Math.floor(COL[i] / 3);
  }

  // 27 групп: 9 строк, 9 столбцов, 9 блоков 3x3
  const UNITS = [];
  for (let k = 0; k < 9; k++) {
    const row = [], col = [], box = [];
    for (let j = 0; j < 9; j++) {
      row.push(k * 9 + j);
      col.push(j * 9 + k);
      box.push((Math.floor(k / 3) * 3 + Math.floor(j / 3)) * 9 + (k % 3) * 3 + (j % 3));
    }
    UNITS.push(row, col, box);
  }

  // «Соседи» клетки: те же строка, столбец и блок (по 20 клеток)
  const PEERS = [];
  for (let i = 0; i < 81; i++) {
    const set = new Set();
    for (const unit of UNITS) {
      if (unit.includes(i)) unit.forEach((j) => { if (j !== i) set.add(j); });
    }
    PEERS.push(Array.from(set));
  }

  // Число единичных битов в маске — сколько кандидатов осталось у клетки
  const POPCOUNT = new Uint8Array(512);
  for (let m = 1; m < 512; m++) POPCOUNT[m] = POPCOUNT[m >> 1] + (m & 1);

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /* ---------- Решатель (перебор с выбором клетки с минимумом кандидатов) ---------- */

  // Считает решения до limit штук. Остановка на втором решении — всё, что
  // нужно для проверки единственности, и это на порядки быстрее полного перебора
  function search(grid, limit, randomize) {
    const cells = grid.slice();
    const rows = new Array(9).fill(0);
    const cols = new Array(9).fill(0);
    const boxes = new Array(9).fill(0);
    let count = 0;
    let solution = null;

    for (let i = 0; i < 81; i++) {
      const v = cells[i];
      if (!v) continue;
      const bit = 1 << (v - 1);
      // Исходная сетка уже противоречива — решений нет
      if ((rows[ROW[i]] | cols[COL[i]] | boxes[BOX[i]]) & bit) {
        return { count: 0, solution: null };
      }
      rows[ROW[i]] |= bit;
      cols[COL[i]] |= bit;
      boxes[BOX[i]] |= bit;
    }

    (function recurse() {
      let best = -1, bestMask = 0, bestCount = 10;
      for (let i = 0; i < 81; i++) {
        if (cells[i]) continue;
        const mask = FULL & ~(rows[ROW[i]] | cols[COL[i]] | boxes[BOX[i]]);
        const n = POPCOUNT[mask];
        if (n === 0) return;                 // тупик
        if (n < bestCount) {
          best = i; bestMask = mask; bestCount = n;
          if (n === 1) break;
        }
      }
      if (best === -1) {                     // пустых клеток нет — найдено решение
        count++;
        if (!solution) solution = cells.slice();
        return;
      }

      const digits = [];
      for (let d = 1; d <= 9; d++) if (bestMask & (1 << (d - 1))) digits.push(d);
      if (randomize) shuffle(digits);        // случайный порядок даёт разные полные сетки

      const r = ROW[best], c = COL[best], b = BOX[best];
      for (const d of digits) {
        const bit = 1 << (d - 1);
        cells[best] = d;
        rows[r] |= bit; cols[c] |= bit; boxes[b] |= bit;
        recurse();
        cells[best] = 0;
        rows[r] &= ~bit; cols[c] &= ~bit; boxes[b] &= ~bit;
        if (count >= limit) return;
      }
    })();

    return { count, solution };
  }

  function solve(grid) {
    return search(grid, 1, false).solution;
  }

  function countSolutions(grid, limit) {
    return search(grid, limit || 2, false).count;
  }

  function randomSolvedGrid() {
    return search(new Array(81).fill(0), 1, true).solution;
  }

  /* ---------- Оценка сложности «по-человечески» ---------- */

  // Решается ли головоломка только одиночками? Так мы отличаем лёгкие
  // головоломки от тех, где нужны более сложные приёмы или перебор.
  //  useHidden=false: только «голые» одиночки (в клетке остался один кандидат)
  //  useHidden=true:  ещё и «скрытые» (цифра в группе помещается в единственную клетку)
  function solvableBySingles(grid, useHidden) {
    const cells = grid.slice();
    const rows = new Array(9).fill(0);
    const cols = new Array(9).fill(0);
    const boxes = new Array(9).fill(0);
    let empty = 0;

    for (let i = 0; i < 81; i++) {
      if (cells[i]) {
        const bit = 1 << (cells[i] - 1);
        rows[ROW[i]] |= bit; cols[COL[i]] |= bit; boxes[BOX[i]] |= bit;
      } else {
        empty++;
      }
    }

    const allowed = (i) => FULL & ~(rows[ROW[i]] | cols[COL[i]] | boxes[BOX[i]]);
    const place = (i, d) => {
      const bit = 1 << (d - 1);
      cells[i] = d;
      rows[ROW[i]] |= bit; cols[COL[i]] |= bit; boxes[BOX[i]] |= bit;
      empty--;
    };

    while (empty > 0) {
      let progress = false;

      for (let i = 0; i < 81; i++) {
        if (cells[i]) continue;
        const mask = allowed(i);
        if (mask === 0) return false;
        if (POPCOUNT[mask] === 1) {
          place(i, 32 - Math.clz32(mask));   // номер единственного установленного бита = цифра
          progress = true;
        }
      }
      if (progress) continue;
      if (!useHidden) return false;

      search_hidden:
      for (const unit of UNITS) {
        for (let d = 1; d <= 9; d++) {
          const bit = 1 << (d - 1);
          let pos = -1, n = 0;
          for (const i of unit) {
            if (!cells[i] && (allowed(i) & bit)) {
              pos = i;
              if (++n > 1) break;
            }
          }
          if (n === 1) {
            place(pos, d);
            progress = true;
            break search_hidden;             // после хода кандидаты изменились — начинаем заново
          }
        }
      }
      if (!progress) return false;
    }
    return true;
  }

  /* ---------- Валидатор ---------- */

  // Все клетки, у которых в строке, столбце или блоке есть такая же цифра
  function findConflicts(grid) {
    const bad = new Set();
    for (const unit of UNITS) {
      const first = {};
      for (const i of unit) {
        const v = grid[i];
        if (!v) continue;
        if (first[v] !== undefined) {
          bad.add(i);
          bad.add(first[v]);
        } else {
          first[v] = i;
        }
      }
    }
    return bad;
  }

  // Соседи клетки idx, у которых уже стоит цифра value
  function conflictsFor(grid, idx, value) {
    return PEERS[idx].filter((p) => grid[p] === value);
  }

  /* ---------- Генератор ---------- */

  // target — сколько подсказок стараемся оставить, maxClues — сколько
  // допустимо в итоге. Сложность задаётся и числом подсказок, и приёмами:
  //  easy   — решается только голыми одиночками
  //  medium — решается одиночками (голыми и скрытыми)
  //  hard   — одиночек недостаточно уже без скрытых
  //  expert — одиночками (даже скрытыми) не решается
  const LEVELS = {
    easy:   { label: 'Легкий',  target: 40, maxClues: 42, solveWith: 'naked',  notSolvableWith: null },
    medium: { label: 'Средний', target: 34, maxClues: 36, solveWith: 'hidden', notSolvableWith: null },
    hard:   { label: 'Сложный', target: 29, maxClues: 31, solveWith: null,     notSolvableWith: 'naked' },
    expert: { label: 'Эксперт', target: 24, maxClues: 27, solveWith: null,     notSolvableWith: 'hidden' }
  };

  const GENERATION_TIME_MS = 2500;

  function countClues(grid) {
    let n = 0;
    for (let i = 0; i < 81; i++) if (grid[i]) n++;
    return n;
  }

  // Удовлетворяет ли головоломка ограничению «должна решаться приёмами X»
  function stillSolvable(puzzle, cfg) {
    if (cfg.solveWith === 'naked') return solvableBySingles(puzzle, false);
    if (cfg.solveWith === 'hidden') return solvableBySingles(puzzle, true);
    return true;
  }

  function meetsLevel(puzzle, cfg) {
    if (countClues(puzzle) > cfg.maxClues) return false;
    if (cfg.notSolvableWith === 'naked') return !solvableBySingles(puzzle, false);
    if (cfg.notSolvableWith === 'hidden') return !solvableBySingles(puzzle, true);
    return true;
  }

  // Убираем цифры из готовой сетки в случайном порядке. Цифра остаётся
  // удалённой, только если решение по-прежнему единственное
  function carvePuzzle(solution, cfg) {
    const puzzle = solution.slice();
    let clues = 81;
    for (const idx of shuffle(Array.from({ length: 81 }, (_, i) => i))) {
      if (clues <= cfg.target) break;
      const backup = puzzle[idx];
      puzzle[idx] = 0;
      if (countSolutions(puzzle, 2) === 1 && stillSolvable(puzzle, cfg)) {
        clues--;
      } else {
        puzzle[idx] = backup;
      }
    }
    return puzzle;
  }

  function generate(difficulty) {
    const cfg = LEVELS[difficulty];
    if (!cfg) throw new Error('Неизвестный уровень сложности: ' + difficulty);

    const deadline = Date.now() + GENERATION_TIME_MS;
    let fallback = null;

    // Не каждая случайная сетка даёт нужную сложность (особенно для «Эксперта»),
    // поэтому пробуем снова, пока не выйдет время
    do {
      const solution = randomSolvedGrid();
      const puzzle = carvePuzzle(solution, cfg);
      // Единственность решения гарантирована построением, но запасной вариант
      // сохраняем только после явной проверки — так он точно корректен
      if (!fallback || countClues(puzzle) < countClues(fallback.puzzle)) {
        fallback = { puzzle, solution };
      }
      if (meetsLevel(puzzle, cfg)) {
        return { difficulty, puzzle, solution };
      }
    } while (Date.now() < deadline);

    // Время вышло: отдаём самую «жёсткую» из попыток. Она всегда с единственным
    // решением, просто может быть чуть легче заявленного уровня
    return { difficulty, puzzle: fallback.puzzle, solution: fallback.solution };
  }

  /* ---------- Состояние игры ---------- */

  class Game {
    constructor(data) {
      this.difficulty = data.difficulty;
      this.puzzle = data.puzzle;         // исходные подсказки (0 = пусто)
      this.solution = data.solution;
      this.values = data.values;         // текущие цифры, включая подсказки
      this.notes = data.notes;           // заметки: битовая маска 1–9 на клетку
      this.errors = data.errors;
      this.hintsLeft = data.hintsLeft;
      this.elapsed = data.elapsed;       // секунды; таймером управляет UI
      this.status = data.status;         // 'playing' | 'won' | 'lost'
      this.history = [];                 // стек для «Отменить»
      this.future = [];                  // стек для «Повторить»
    }

    static create(difficulty) {
      const { puzzle, solution } = generate(difficulty);
      return new Game({
        difficulty,
        puzzle,
        solution,
        values: puzzle.slice(),
        notes: new Array(81).fill(0),
        errors: 0,
        hintsLeft: MAX_HINTS,
        elapsed: 0,
        status: 'playing'
      });
    }

    // Восстановление из localStorage. Данные могли испортиться или остаться
    // от старой версии, поэтому проверяем всё и при любой странности возвращаем null
    static fromJSON(data) {
      try {
        if (!data || data.v !== SAVE_VERSION || !LEVELS[data.difficulty]) return null;
        const isGrid = (a, max) => Array.isArray(a) && a.length === 81 &&
          a.every((x) => Number.isInteger(x) && x >= 0 && x <= max);
        if (!isGrid(data.puzzle, 9) || !isGrid(data.solution, 9) ||
            !isGrid(data.values, 9) || !isGrid(data.notes, FULL)) return null;
        for (let i = 0; i < 81; i++) {
          if (!data.solution[i]) return null;
          if (data.puzzle[i] && (data.puzzle[i] !== data.solution[i] ||
                                 data.values[i] !== data.puzzle[i])) return null;
        }
        if (data.status !== 'playing') return null;   // завершённые игры не продолжаем
        const errors = Number(data.errors);
        const hintsLeft = Number(data.hintsLeft);
        const elapsed = Number(data.elapsed);
        if (![errors, hintsLeft, elapsed].every(Number.isFinite)) return null;
        return new Game({
          difficulty: data.difficulty,
          puzzle: data.puzzle,
          solution: data.solution,
          values: data.values,
          notes: data.notes,
          errors: Math.min(Math.max(errors, 0), MAX_ERRORS - 1),
          hintsLeft: Math.min(Math.max(hintsLeft, 0), MAX_HINTS),
          elapsed: Math.max(elapsed, 0),
          status: 'playing'
        });
      } catch (e) {
        return null;
      }
    }

    // История отмены не сохраняется: после закрытия приложения она не нужна,
    // а место в localStorage ограничено
    toJSON() {
      return {
        v: SAVE_VERSION,
        difficulty: this.difficulty,
        puzzle: this.puzzle,
        solution: this.solution,
        values: this.values,
        notes: this.notes,
        errors: this.errors,
        hintsLeft: this.hintsLeft,
        elapsed: this.elapsed,
        status: this.status
      };
    }

    isGiven(idx) {
      return this.puzzle[idx] !== 0;
    }

    isComplete() {
      return this.values.every((v, i) => v === this.solution[i]);
    }

    /* --- Служебное: запись шага в историю --- */

    // Перед изменением клетки вызываем touch — запоминаем её прежнее состояние.
    // После изменений commit сравнивает «до» и «после» и кладёт шаг в историю
    _recorder() {
      const before = new Map();
      return {
        touch: (i) => {
          if (!before.has(i)) before.set(i, { v: this.values[i], n: this.notes[i] });
        },
        commit: () => {
          const changes = [];
          before.forEach((b, i) => {
            if (b.v !== this.values[i] || b.n !== this.notes[i]) {
              changes.push({ i, v0: b.v, n0: b.n, v1: this.values[i], n1: this.notes[i] });
            }
          });
          if (changes.length) {
            this.history.push(changes);
            if (this.history.length > HISTORY_LIMIT) this.history.shift();
            this.future = [];            // новый ход обнуляет «Повторить»
          }
          return changes.map((c) => c.i);
        }
      };
    }

    _canEdit(idx) {
      return this.status === 'playing' && Number.isInteger(idx) &&
             idx >= 0 && idx < 81 && !this.isGiven(idx);
    }

    _updateStatus() {
      if (this.errors >= MAX_ERRORS) this.status = 'lost';
      else if (this.isComplete()) this.status = 'won';
    }

    /* --- Действия игрока --- */

    // Поставить цифру. Ошибкой считается цифра, не совпавшая с решением:
    // так игрок не может подбирать цифры, пока подсветка конфликтов молчит.
    // Возвращает null, если ход невозможен.
    setValue(idx, num) {
      if (!this._canEdit(idx) || !Number.isInteger(num) || num < 1 || num > 9) return null;
      if (this.values[idx] === num) return null;

      const rec = this._recorder();
      const bit = 1 << (num - 1);
      rec.touch(idx);
      this.values[idx] = num;
      this.notes[idx] = 0;
      // Автоудаление заметок: эта цифра больше не кандидат у соседей
      for (const p of PEERS[idx]) {
        if (this.notes[p] & bit) {
          rec.touch(p);
          this.notes[p] &= ~bit;
        }
      }
      const changed = rec.commit();

      const wrong = num !== this.solution[idx];
      if (wrong) this.errors++;          // ошибки не откатываются отменой хода
      this._updateStatus();

      return {
        changed,
        wrong,
        conflicts: conflictsFor(this.values, idx, num),
        status: this.status
      };
    }

    // Включить/выключить заметку-кандидата. В клетке с цифрой заметок нет.
    toggleNote(idx, num) {
      if (!this._canEdit(idx) || !Number.isInteger(num) || num < 1 || num > 9) return null;
      if (this.values[idx] !== 0) return null;
      const rec = this._recorder();
      rec.touch(idx);
      this.notes[idx] ^= 1 << (num - 1);
      return { changed: rec.commit() };
    }

    erase(idx) {
      if (!this._canEdit(idx)) return null;
      if (this.values[idx] === 0 && this.notes[idx] === 0) return null;
      const rec = this._recorder();
      rec.touch(idx);
      this.values[idx] = 0;
      this.notes[idx] = 0;
      return { changed: rec.commit() };
    }

    undo() {
      if (this.status !== 'playing' || !this.history.length) return null;
      const changes = this.history.pop();
      for (const c of changes) {
        this.values[c.i] = c.v0;
        this.notes[c.i] = c.n0;
      }
      this.future.push(changes);
      return { changed: changes.map((c) => c.i) };
    }

    redo() {
      if (this.status !== 'playing' || !this.future.length) return null;
      const changes = this.future.pop();
      for (const c of changes) {
        this.values[c.i] = c.v1;
        this.notes[c.i] = c.n1;
      }
      this.history.push(changes);
      return { changed: changes.map((c) => c.i) };
    }

    // Подсказка: подставляет верную цифру. Если выбрана клетка, которую можно
    // исправить, — в неё, иначе в случайную пустую или ошибочную.
    // Подсказка не считается ошибкой и расходует лимит.
    hint(preferredIdx) {
      if (this.status !== 'playing' || this.hintsLeft <= 0) return null;
      const fixable = (i) => !this.isGiven(i) && this.values[i] !== this.solution[i];

      let idx = preferredIdx;
      if (!(Number.isInteger(idx) && idx >= 0 && idx < 81 && fixable(idx))) {
        const options = [];
        for (let i = 0; i < 81; i++) if (fixable(i)) options.push(i);
        if (!options.length) return null;
        idx = options[Math.floor(Math.random() * options.length)];
      }

      const rec = this._recorder();
      const num = this.solution[idx];
      const bit = 1 << (num - 1);
      rec.touch(idx);
      this.values[idx] = num;
      this.notes[idx] = 0;
      for (const p of PEERS[idx]) {
        if (this.notes[p] & bit) {
          rec.touch(p);
          this.notes[p] &= ~bit;
        }
      }
      const changed = rec.commit();
      this.hintsLeft--;
      this._updateStatus();
      return { idx, value: num, changed, status: this.status };
    }

    /* --- Для отрисовки --- */

    // Клетки, где цифра дублируется в строке, столбце или блоке (подсветка в реальном времени)
    getConflicts() {
      return findConflicts(this.values);
    }

    // Кнопка «Проверить»: все клетки с цифрой, не совпавшей с решением
    check() {
      const wrong = [];
      for (let i = 0; i < 81; i++) {
        if (!this.isGiven(i) && this.values[i] && this.values[i] !== this.solution[i]) wrong.push(i);
      }
      return wrong;
    }

    // Сколько экземпляров каждой цифры ещё осталось поставить (индекс = цифра)
    remainingCounts() {
      const left = new Array(10).fill(9);
      left[0] = 0;
      for (const v of this.values) if (v) left[v]--;
      return left.map((n) => Math.max(n, 0));
    }

    summary() {
      return {
        difficulty: this.difficulty,
        time: this.elapsed,
        errors: this.errors,
        result: this.status
      };
    }
  }

  const Sudoku = {
    LEVELS,
    MAX_ERRORS,
    MAX_HINTS,
    HISTORY_LIMIT,
    generate,
    solve,
    countSolutions,
    solvableBySingles,
    findConflicts,
    conflictsFor,
    peersOf: (idx) => PEERS[idx],
    rowOf: (idx) => ROW[idx],
    colOf: (idx) => COL[idx],
    boxOf: (idx) => BOX[idx],
    Game
  };

  root.Sudoku = Sudoku;
  // Для запуска тестов в Node
  if (typeof module !== 'undefined' && module.exports) module.exports = Sudoku;
})(typeof window !== 'undefined' ? window : globalThis);
