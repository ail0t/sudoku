/* Инициализация приложения: service worker, тема, переключение экранов,
 * установка на главный экран. Игровая логика и рендеринг сетки появятся
 * в sudoku.js и ui.js (Этапы 2–3) и подключатся через события ниже. */
(function () {
  'use strict';

  const root = document.documentElement;
  const appEl = document.getElementById('app');

  // Единый «шлюз» для остальных модулей: ui.js будет вызывать App.showScreen(...)
  const App = {
    showScreen,
    isStandalone,
    getTheme,
    setTheme,
    refreshContinueButton
  };
  window.App = App;

  /* ---------- Экраны ---------- */

  function showScreen(name) {
    // hidden вместо display:none из JS — скрытые экраны не попадают
    // в дерево доступности, и VoiceOver/TalkBack их не зачитывают
    ['menu', 'game', 'stats'].forEach((n) => {
      document.getElementById('screen-' + n).hidden = n !== name;
    });
    appEl.dataset.screen = name;
  }

  function bindMenu() {
    document.querySelectorAll('[data-difficulty]').forEach((btn) => {
      btn.addEventListener('click', () => {
        // Экран игры откроет сам ui.js: сначала он может спросить подтверждение,
        // если есть незавершённая партия
        document.dispatchEvent(new CustomEvent('sudoku:new-game', {
          detail: { difficulty: btn.dataset.difficulty }
        }));
      });
    });

    document.getElementById('continue-btn').addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('sudoku:continue'));
    });

    document.getElementById('back-btn').addEventListener('click', () => {
      // ui.js сохранит партию синхронно в обработчике, поэтому
      // обновляем кнопку «Продолжить» только после dispatchEvent
      document.dispatchEvent(new CustomEvent('sudoku:leave-game'));
      refreshContinueButton();
      showScreen('menu');
    });

    refreshContinueButton();
  }

  // Кнопка видна, только если есть незавершённая партия
  function refreshContinueButton() {
    document.getElementById('continue-btn').hidden = !SudokuStorage.hasSavedGame();
  }

  /* ---------- Тема ---------- */

  const THEME_KEY = 'sudoku:theme';
  const THEME_COLORS = { light: '#4a90e2', dark: '#121212' };

  function systemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // Что реально отображается сейчас: ручной выбор или системная настройка
  function getTheme() {
    return root.dataset.theme || systemTheme();
  }

  function setTheme(theme) {
    root.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* приватный режим */ }
    // Мета-теги с media реагируют только на систему, поэтому при ручном
    // выборе задаём цвет системного бара явно
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
      m.setAttribute('content', THEME_COLORS[theme]);
    });
  }

  function bindTheme() {
    document.getElementById('theme-toggle').addEventListener('click', () => {
      setTheme(getTheme() === 'dark' ? 'light' : 'dark');
    });
  }

  /* ---------- Установка на главный экран ---------- */

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.navigator.standalone === true;   // iOS Safari
  }

  function isIOS() {
    // iPadOS 13+ выдаёт себя за Mac, отличаем по наличию мультитача
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function bindInstall() {
    if (isStandalone()) return;   // уже установлено — подсказки не нужны

    const installBtn = document.getElementById('install-btn');
    let deferredPrompt = null;

    // Chrome/Android: браузер сам решает, когда установка доступна
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();         // не показываем стандартный баннер, используем свою кнопку
      deferredPrompt = e;
      installBtn.hidden = false;
    });

    installBtn.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;      // повторно использовать событие нельзя
      installBtn.hidden = true;
    });

    window.addEventListener('appinstalled', () => { installBtn.hidden = true; });

    // iOS не даёт программной установки — показываем инструкцию
    if (isIOS()) {
      document.getElementById('ios-hint').hidden = false;
    }
  }

  /* ---------- Ограничения жестов ---------- */

  function blockZoomGestures() {
    // iOS Safari игнорирует user-scalable=no (с iOS 10), поэтому
    // pinch-zoom гасим вручную
    document.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  /* ---------- Service Worker ---------- */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // Регистрируем после load, чтобы кеширование не конкурировало
    // с первой отрисовкой за сеть
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('Service worker не зарегистрирован:', err);
      });
    });
  }

  /* ---------- Старт ---------- */

  bindMenu();
  bindTheme();
  bindInstall();
  blockZoomGestures();
  registerServiceWorker();
  showScreen('menu');
})();
