/* Хранилище: текущая игра, история, статистика, достижения, настройки.
 * Назван SudokuStorage, потому что глобальное имя Storage занято браузером.
 * localStorage бывает недоступен (приватный режим, переполнение, запрет),
 * поэтому каждая операция защищена, а при сбое данные живут в памяти
 * до закрытия приложения — игра при этом не ломается. */
(function (root) {
  'use strict';

  const KEYS = {
    game: 'sudoku:game',
    history: 'sudoku:history',
    stats: 'sudoku:stats',
    settings: 'sudoku:settings'
  };
  const HISTORY_LIMIT = 100;      // старые записи вытесняются, чтобы не раздувать хранилище
  const LEVEL_IDS = ['easy', 'medium', 'hard', 'expert'];
  const EXPERT_MASTER_WINS = 5;   // порог для «Мастера Эксперта»; в ТЗ число не задано

  const memory = {};              // запасное хранилище на случай сбоя localStorage

  /* ---------- Низкоуровневые операции ---------- */

  function remove(key) {
    delete memory[key];
    try { localStorage.removeItem(key); } catch (e) { /* игнорируем */ }
  }

  function read(key, fallback) {
    let raw = null;
    try {
      raw = localStorage.getItem(key);
    } catch (e) {
      return key in memory ? memory[key] : fallback;
    }
    if (raw === null) return key in memory ? memory[key] : fallback;
    try {
      return JSON.parse(raw);
    } catch (e) {
      remove(key);                // повреждённый JSON лучше выбросить, чем падать на нём вечно
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      delete memory[key];
      return true;
    } catch (e) {
      memory[key] = value;
      return false;
    }
  }

  /* ---------- Текущая игра ---------- */

  function saveGame(gameJSON) {
    return write(KEYS.game, gameJSON);
  }

  function loadGame() {
    return read(KEYS.game, null);
  }

  function clearGame() {
    remove(KEYS.game);
  }

  // Сохранённое есть, но проверку структуры делает Game.fromJSON —
  // здесь смотрим только на формальное наличие и статус
  function hasSavedGame() {
    const g = loadGame();
    return !!(g && g.status === 'playing');
  }

  /* ---------- Настройки ---------- */

  const DEFAULT_SETTINGS = { sound: true, vibration: true };

  function getSettings() {
    return Object.assign({}, DEFAULT_SETTINGS, read(KEYS.settings, {}));
  }

  function saveSettings(partial) {
    const next = Object.assign(getSettings(), partial);
    write(KEYS.settings, next);
    return next;
  }

  /* ---------- Достижения ---------- */

  const ACHIEVEMENTS = [
    {
      id: 'first_win',
      title: 'Первая победа',
      description: 'Выиграйте любую игру',
      test: (s) => s.wins >= 1
    },
    {
      id: 'ten_flawless',
      title: '10 игр без ошибок',
      description: 'Выиграйте 10 игр, не сделав ни одной ошибки',
      test: (s) => s.flawlessWins >= 10
    },
    {
      id: 'expert_master',
      title: 'Мастер Эксперта',
      description: 'Выиграйте ' + EXPERT_MASTER_WINS + ' игр на уровне «Эксперт»',
      test: (s) => s.expertWins >= EXPERT_MASTER_WINS
    }
  ];

  /* ---------- Статистика ---------- */

  function defaultStats() {
    const best = {};
    LEVEL_IDS.forEach((id) => { best[id] = null; });   // лучшее время в секундах
    return {
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      flawlessWins: 0,
      expertWins: 0,
      best,
      achievements: {}            // id → ISO-дата получения
    };
  }

  // Подмешиваем значения по умолчанию: если в новой версии появится поле,
  // старые данные из localStorage не сломают код
  function getStats() {
    const saved = read(KEYS.stats, {});
    const stats = Object.assign(defaultStats(), saved);
    stats.best = Object.assign(defaultStats().best, saved.best || {});
    stats.achievements = Object.assign({}, saved.achievements || {});
    return stats;
  }

  function getAchievements() {
    const unlocked = getStats().achievements;
    return ACHIEVEMENTS.map((a) => ({
      id: a.id,
      title: a.title,
      description: a.description,
      unlocked: !!unlocked[a.id],
      date: unlocked[a.id] || null
    }));
  }

  /* ---------- История игр ---------- */

  function getHistory() {
    const list = read(KEYS.history, []);
    return Array.isArray(list) ? list : [];
  }

  function clearHistory() {
    remove(KEYS.history);
  }

  // Вызывать один раз при завершении игры (победа или поражение).
  // record: { difficulty, time (сек), errors, result: 'won' | 'lost' }
  // Возвращает список только что полученных достижений.
  function recordResult(record) {
    const entry = {
      date: new Date().toISOString(),
      difficulty: record.difficulty,
      time: record.time,
      errors: record.errors,
      result: record.result
    };

    const history = getHistory();
    history.unshift(entry);                 // новые записи сверху
    if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
    write(KEYS.history, history);

    const stats = getStats();
    stats.gamesPlayed++;
    if (record.result === 'won') {
      stats.wins++;
      if (record.errors === 0) stats.flawlessWins++;
      if (record.difficulty === 'expert') stats.expertWins++;
      const best = stats.best[record.difficulty];
      if (best === null || record.time < best) stats.best[record.difficulty] = record.time;
    } else {
      stats.losses++;
    }

    // Достижения проверяем уже по обновлённой статистике
    const fresh = [];
    ACHIEVEMENTS.forEach((a) => {
      if (!stats.achievements[a.id] && a.test(stats)) {
        stats.achievements[a.id] = entry.date;
        fresh.push({ id: a.id, title: a.title, description: a.description });
      }
    });

    write(KEYS.stats, stats);
    return fresh;
  }

  root.SudokuStorage = {
    saveGame,
    loadGame,
    clearGame,
    hasSavedGame,
    getSettings,
    saveSettings,
    getHistory,
    clearHistory,
    getStats,
    getAchievements,
    recordResult
  };

  // Для запуска тестов в Node
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SudokuStorage;
})(typeof window !== 'undefined' ? window : globalThis);
