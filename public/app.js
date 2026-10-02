(() => {
  'use strict';

  const app = document.getElementById('app');
  const modalRoot = document.getElementById('modal-root');
  const toastRoot = document.getElementById('toast-root');

  const state = {
    token: localStorage.getItem('pulselink_token') || '',
    me: null,
    chats: [],
    messages: new Map(),
    selectedChatId: '',
    online: new Map(),
    eventSource: null,
    pollTimer: null,
    sidebarOpen: false,
    detailsOpen: typeof window !== 'undefined' && window.matchMedia('(min-width: 1181px)').matches,
    search: '',
    authMode: 'login',
    recording: null,
    voice: null,
    lastRenderedShell: false
  };

  const defaultSettings = {
    messageSound: true,
    notifications: false,
    sendMode: 'enter',
    compactMode: false,
    uiScale: 1
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function initials(value) {
    const text = String(value || '?').trim();
    return escapeHtml((text[0] || '?').toUpperCase());
  }

  function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return 'Сегодня';
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return 'Вчера';
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  }

  function formatDuration(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = Math.floor(seconds / 60);
    const s = String(seconds % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function settings() {
    return { ...defaultSettings, ...(state.me?.settings || {}) };
  }

  function selectedChatStorageKey(userId = state.me?.id) {
    return userId ? `pulselink:selected-chat:${userId}` : 'pulselink:selected-chat:anonymous';
  }


  function rememberSelectedChat(chatId) {
    if (!state.me?.id || !chatId) return;
    localStorage.setItem(selectedChatStorageKey(), chatId);
  }

  function resetUserScopedState(user = null) {
    state.chats = [];
    state.messages.clear();
    state.search = '';
    state.selectedChatId = user ? (localStorage.getItem(selectedChatStorageKey(user.id)) || '') : '';
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (!(options.body instanceof FormData)) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const response = await fetch(path, { ...options, headers });
    const text = await response.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch (_error) { data = { error: text }; }
    }
    if (!response.ok) {
      if (response.status === 401 && state.token) logout(false);
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function toast(message, type = 'info') {
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    toastRoot.appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transform = 'translateY(8px)';
      setTimeout(() => node.remove(), 220);
    }, 3600);
  }


  function logoHtml(extra = '') {
    return `
      <div class="logo-mark ${extra}" aria-label="PulseLink logo" role="img">
        <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
          <path class="logo-bubble" d="M17 31.5C17 22.4 23.9 16 32.4 16C41.4 16 48 22.7 48 31.4C48 40.4 41.1 47 31.8 47H20.4L24.8 42.2C20 39.8 17 35.9 17 31.5Z"/>
          <path class="logo-link" d="M14 33H24.1L28.4 24L35.5 42L40.4 32H50"/>
          <circle class="logo-node left" cx="18" cy="33" r="4"/>
          <circle class="logo-node right" cx="49" cy="32" r="4"/>
        </svg>
      </div>
    `;
  }


  const ICONS = {
    message: '<path d="M5 7.8C5 6.25 6.25 5 7.8 5h8.4C17.75 5 19 6.25 19 7.8v5.4c0 1.55-1.25 2.8-2.8 2.8h-5.6L6.4 19v-3H7.8C6.25 16 5 14.75 5 13.2V7.8Z"/>',
    users: '<path d="M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M15.5 10a2.5 2.5 0 1 0 0-5"/><path d="M3.5 19a5 5 0 0 1 10 0"/><path d="M14.5 14.5A4.5 4.5 0 0 1 20.5 19"/>',
    channel: '<path d="M5 14.5h3l7 4.5V5L8 9.5H5a2 2 0 0 0-2 2v1a2 2 0 0 0 2 2Z"/><path d="M18 9a4.5 4.5 0 0 1 0 6"/>',
    bookmark: '<path d="M7 5.8C7 4.8 7.8 4 8.8 4h6.4c1 0 1.8.8 1.8 1.8V20l-5-3.2L7 20V5.8Z"/>',
    search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4 4"/>',
    settings: '<path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z"/><path d="M19.4 13.5a7.8 7.8 0 0 0 0-3l2-1.5-2-3.4-2.4 1a8.2 8.2 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.6A8.2 8.2 0 0 0 7 6.6l-2.4-1-2 3.4 2 1.5a7.8 7.8 0 0 0 0 3l-2 1.5 2 3.4 2.4-1a8.2 8.2 0 0 0 2.6 1.5l.4 2.6h4l.4-2.6a8.2 8.2 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.5Z"/>',
    shield: '<path d="M12 3.5 19 6v5.3c0 4.4-2.8 7.7-7 9.2-4.2-1.5-7-4.8-7-9.2V6l7-2.5Z"/><path d="m9.5 12 1.7 1.7 3.7-4"/>',
    mic: '<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
    micOff: '<path d="m4 4 16 16"/><path d="M9 9v2a3 3 0 0 0 4.6 2.55"/><path d="M15 10.2V6a3 3 0 0 0-5.1-2.15"/><path d="M5 11a7 7 0 0 0 10.8 5.9"/><path d="M19 11a7 7 0 0 1-1.1 3.75"/><path d="M12 18v3"/>',
    headphones: '<path d="M4 13a8 8 0 0 1 16 0"/><path d="M4 13v3a3 3 0 0 0 3 3h1v-7H7a3 3 0 0 0-3 3Z"/><path d="M20 13v3a3 3 0 0 1-3 3h-1v-7h1a3 3 0 0 1 3 3Z"/>',
    volume: '<path d="M5 14.5h3l5 3.5V6L8 9.5H5a2 2 0 0 0-2 2v1a2 2 0 0 0 2 2Z"/><path d="M16 9.5a4 4 0 0 1 0 5"/><path d="M18.5 7a7.5 7.5 0 0 1 0 10"/>',
    menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
    logout: '<path d="M10 5H6.8C5.8 5 5 5.8 5 6.8v10.4c0 1 .8 1.8 1.8 1.8H10"/><path d="M14 8l4 4-4 4"/><path d="M18 12H9"/>'
  };

  function iconHtml(name, extra = '') {
    const body = ICONS[name] || ICONS.info;
    return `<svg class="ui-icon ${extra}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
  }

  function avatarHtml(entity, size = '', fallback = 'P') {
    const cls = ['avatar', size].filter(Boolean).join(' ');
    if (entity?.avatar) return `<img class="${cls}" src="${entity.avatar}" alt="">`;
    return `<span class="avatar-fallback ${size || ''}">${initials(entity?.nickname || entity?.title || entity?.rawTitle || fallback)}</span>`;
  }

  function chatIconHtml(chat) {
    if (chat.avatar) return `<span class="chat-icon"><img src="${chat.avatar}" alt=""></span>`;
    const icon = chat.type === 'saved' ? 'bookmark' : chat.type === 'direct' ? 'message' : chat.type === 'channel' ? 'channel' : 'users';
    return `<span class="chat-icon">${iconHtml(icon)}</span>`;
  }

  function typeLabel(chat) {
    return chat.type === 'saved' ? 'избранное'
      : chat.type === 'direct' ? 'личный'
      : chat.type === 'channel' ? 'канал'
      : 'группа';
  }

  async function init() {
    if (!state.token) return renderAuth();
    try {
      const data = await api('/api/me');
      state.me = data.user;
      resetUserScopedState(data.user);
      setOnline(data.online || []);
      await loadChats();
      renderShell();
      connectSse();
      startPolling();
    } catch (error) {
      console.warn(error);
      localStorage.removeItem('pulselink_token');
      localStorage.removeItem('pulselink_selected_chat');
      state.token = '';
      renderAuth();
    }
  }

  function authFieldsHtml(mode) {
    if (mode === 'login') {
      return `
        <label class="field"><span>@username или почта</span><input class="input" name="login" autocomplete="username" placeholder="@coffin" data-username-input data-allow-email="true" required></label>
        <label class="field"><span>Пароль</span><input class="input" name="password" type="password" autocomplete="current-password" placeholder="••••••••" required></label>
        <div class="hint">Для первого запуска создан главный администратор <b>@coffin</b>. Пароль по умолчанию: <b>PulseLink2026!</b> (изменяется переменной PULSELINK_ADMIN_PASSWORD).</div>
      `;
    }
    return `
      <label class="field"><span>Username</span><input class="input" name="username" autocomplete="username" placeholder="@pulse" pattern="^@?[a-zA-Z0-9_]{3,24}$" data-username-input required></label>
      <label class="field"><span>Nickname</span><input class="input" name="nickname" autocomplete="name" placeholder="Ваше имя" maxlength="48" required></label>
      <label class="field"><span>Почта (обязательно)</span><input class="input" name="email" type="email" autocomplete="email" placeholder="you@example.com" required></label>
      <label class="field"><span>Пароль</span><input class="input" name="password" type="password" autocomplete="new-password" minlength="6" placeholder="минимум 6 символов" required></label>
    `;
  }

  function renderAuth() {
    disconnectSse();
    stopPolling();
    document.body.classList.remove('compact');
    applySettings();
    app.className = `auth-shell auth-mode-${state.authMode}`;
    app.innerHTML = `
      <main class="auth-page auth-mode-${state.authMode}">
        <section class="auth-hero">
          <div>
            <div class="brand-lockup">
              ${logoHtml()}
              <div>
                <div class="brand-title">PulseLink</div>
                <div class="brand-subtitle">мессенджер нового поколения</div>
              </div>
            </div>
            <h1>Чаты, голос и сообщества в одном пульсе.</h1>
            <p>Личные переписки с прочтениями, голосовые сообщения с волной, Discord-подобные голосовые комнаты через собственный серверный WebSocket-релей и живые SSE-обновления.</p>
          </div>
          <div class="feature-grid">
            <div class="feature-pill">@username + обязательная почта</div>
            <div class="feature-pill">scrypt-хеш пароля</div>
            <div class="feature-pill">Группы, каналы и обзор</div>
            <div class="feature-pill">${iconHtml('shield')} Админ-панель @coffin</div>
          </div>
        </section>
        <section class="auth-card auth-mode-${state.authMode}">
          <div class="auth-tabs auth-mode-${state.authMode}" role="tablist" aria-label="Режим авторизации">
            <button type="button" data-auth-tab="login" class="${state.authMode === 'login' ? 'active' : ''}" aria-selected="${state.authMode === 'login'}">Вход</button>
            <button type="button" data-auth-tab="register" class="${state.authMode === 'register' ? 'active' : ''}" aria-selected="${state.authMode === 'register'}">Регистрация</button>
          </div>
          <form id="auth-form" class="form-stack">
            <div id="auth-fields" class="auth-fields">${authFieldsHtml(state.authMode)}</div>
            <div id="auth-error" class="error-text"></div>
            <button id="authSubmit" class="primary-btn full" type="submit">${state.authMode === 'login' ? 'Войти' : 'Создать аккаунт'}</button>
          </form>
        </section>
      </main>
    `;
    wireAuthControls();
  }

  function wireAuthControls(root = document) {
    $$('[data-auth-tab]', root).forEach((button) => {
      button.addEventListener('click', () => switchAuthMode(button.dataset.authTab));
    });
    $$('[data-username-input]', root).forEach((input) => wireUsernameAutoprefix(input, { allowEmail: input.dataset.allowEmail === 'true' }));
    $('#auth-form', root)?.addEventListener('submit', handleAuthSubmit);
  }

  function setAuthModeClasses(mode) {
    app.classList.toggle('auth-mode-login', mode === 'login');
    app.classList.toggle('auth-mode-register', mode === 'register');
    $('.auth-page')?.classList.toggle('auth-mode-login', mode === 'login');
    $('.auth-page')?.classList.toggle('auth-mode-register', mode === 'register');
    $('.auth-card')?.classList.toggle('auth-mode-login', mode === 'login');
    $('.auth-card')?.classList.toggle('auth-mode-register', mode === 'register');
    $('.auth-tabs')?.classList.toggle('auth-mode-login', mode === 'login');
    $('.auth-tabs')?.classList.toggle('auth-mode-register', mode === 'register');
    $$('[data-auth-tab]').forEach((button) => {
      const active = button.dataset.authTab === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
  }

  function switchAuthMode(mode) {
    if (!['login', 'register'].includes(mode) || state.authMode === mode) return;
    state.authMode = mode;
    setAuthModeClasses(mode);
    const fields = $('#auth-fields');
    const submit = $('#authSubmit');
    const errorBox = $('#auth-error');
    if (!fields || !submit) return;
    errorBox.textContent = '';
    fields.style.minHeight = `${fields.offsetHeight}px`;
    fields.classList.add('is-switching');
    window.setTimeout(() => {
      fields.innerHTML = authFieldsHtml(mode);
      $$('[data-username-input]', fields).forEach((input) => wireUsernameAutoprefix(input, { allowEmail: input.dataset.allowEmail === 'true' }));
      submit.textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
      fields.classList.remove('is-switching');
      fields.classList.add('is-entering');
      fields.style.minHeight = `${fields.scrollHeight}px`;
      window.setTimeout(() => {
        fields.classList.remove('is-entering');
        fields.style.minHeight = '';
      }, 230);
    }, 105);
  }

  function looksLikeEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
  }

  function normalizeUsernameForSubmit(value, allowEmail = false) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return trimmed;
    if (allowEmail && looksLikeEmail(trimmed)) return trimmed;
    return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
  }

  function wireUsernameAutoprefix(input, { allowEmail = false } = {}) {
    const fix = () => {
      const raw = input.value.trimStart();
      if (!raw) return;
      if (allowEmail && !raw.startsWith('@') && (raw.includes('.') || looksLikeEmail(raw))) return;
      if (allowEmail && raw.includes('@') && !raw.startsWith('@')) return;
      const cleaned = raw.startsWith('@') ? `@${raw.slice(1).replace(/@+/g, '')}` : `@${raw.replace(/^@+/, '')}`;
      if (input.value !== cleaned) {
        const caret = Math.max(1, input.selectionStart || cleaned.length);
        input.value = cleaned;
        requestAnimationFrame(() => input.setSelectionRange(Math.min(cleaned.length, caret + 1), Math.min(cleaned.length, caret + 1)));
      }
    };
    input.addEventListener('focus', () => {
      if (!allowEmail && !input.value) {
        input.value = '@';
        requestAnimationFrame(() => input.setSelectionRange(1, 1));
      }
    });
    input.addEventListener('input', fix);
    input.addEventListener('blur', () => {
      if (input.value === '@') input.value = '';
      if (input.value && !allowEmail) input.value = normalizeUsernameForSubmit(input.value);
    });
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const errorBox = $('#auth-error');
    errorBox.textContent = '';
    const submitButton = form.querySelector('button[type=submit]');
    const body = Object.fromEntries(new FormData(form).entries());
    if (body.username) body.username = normalizeUsernameForSubmit(body.username);
    if (body.login && !looksLikeEmail(body.login)) body.login = normalizeUsernameForSubmit(body.login, true);
    const endpoint = state.authMode === 'login' ? '/api/login' : '/api/register';
    form.classList.add('auth-submitting');
    submitButton?.classList.add('is-loading');
    if (submitButton) submitButton.disabled = true;
    try {
      const data = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      state.token = data.token;
      state.me = data.user;
      localStorage.setItem('pulselink_token', state.token);
      resetUserScopedState(data.user);
      await loadChats();
      renderShell();
      connectSse();
      startPolling();
      toast('Добро пожаловать в PulseLink', 'success');
    } catch (error) {
      errorBox.textContent = error.message;
      form.classList.remove('auth-submitting');
      submitButton?.classList.remove('is-loading');
      if (submitButton) submitButton.disabled = false;
    }
  }

  async function loadChats() {
    const data = await api('/api/chats');
    state.chats = data.chats || [];
    if (!state.selectedChatId || !state.chats.some((chat) => chat.id === state.selectedChatId)) {
      const saved = state.chats.find((chat) => chat.type === 'saved');
      state.selectedChatId = saved?.id || state.chats[0]?.id || '';
    }
    if (state.selectedChatId) rememberSelectedChat(state.selectedChatId);
  }

  async function loadMessages(chatId, silent = false) {
    if (!chatId) return;
    try {
      const data = await api(`/api/chats/${encodeURIComponent(chatId)}/messages?limit=150`);
      state.messages.set(chatId, data.messages || []);
      const idx = state.chats.findIndex((chat) => chat.id === chatId);
      if (idx !== -1 && data.chat) state.chats[idx] = data.chat;
      if (state.selectedChatId === chatId) {
        renderChat();
        renderDetails();
        markRead(chatId);
      }
    } catch (error) {
      if (!silent) toast(error.message, 'error');
    }
  }

  async function markRead(chatId) {
    const chat = state.chats.find((item) => item.id === chatId);
    if (!chat) return;
    chat.unread = 0;
    renderSidebar();
    try { await api(`/api/chats/${encodeURIComponent(chatId)}/read`, { method: 'POST', body: '{}' }); } catch (_error) { /* offline fallback */ }
  }

  function renderShell() {
    applySettings();
    if (!state.lastRenderedShell) {
      app.className = 'app-shell';
      app.innerHTML = `
        <aside id="sidebar" class="sidebar"></aside>
        <section id="chatPane" class="chat-pane"></section>
        <aside id="detailsPane" class="details-pane"></aside>
        <div id="voiceControls" class="voice-controls"></div>
      `;
      state.lastRenderedShell = true;
    }
    updateShellLayout();
    renderSidebar();
    renderChat();
    renderDetails();
    renderVoiceControls();
  }


  function updateShellLayout() {
    if (!app.classList.contains('app-shell')) return;
    app.classList.toggle('details-open', Boolean(state.detailsOpen));
    app.classList.toggle('details-collapsed', !state.detailsOpen);
    app.classList.toggle('sidebar-open', Boolean(state.sidebarOpen));
  }

  function applySettings() {
    const s = settings();
    document.body.classList.toggle('compact', Boolean(s.compactMode));
    const scale = Math.max(0.85, Math.min(1.2, Number(s.uiScale) || 1));
    document.documentElement.style.setProperty('--ui-scale', scale.toFixed(2));
  }

  function renderSidebar() {
    const sidebar = $('#sidebar');
    if (!sidebar || !state.me) return;
    sidebar.classList.toggle('open', state.sidebarOpen);
    const query = state.search.trim().toLowerCase();
    const chats = state.chats.filter((chat) => !query
      || chat.title.toLowerCase().includes(query)
      || (chat.lastMessage?.text || '').toLowerCase().includes(query));
    sidebar.innerHTML = `
      <div class="sidebar-header">
        <div class="brand-lockup">
          ${logoHtml()}
          <div>
            <div class="brand-title" style="font-size:24px">PulseLink</div>
            <div class="brand-subtitle">живой мессенджер</div>
          </div>
        </div>
        <div class="quick-actions">
          <button class="round-btn" data-action="new-dm" title="Личный чат" aria-label="Личный чат">${iconHtml('message')}</button>
          <button class="round-btn" data-action="new-group" title="Создать группу" aria-label="Создать группу">${iconHtml('users')}</button>
          <button class="round-btn" data-action="new-channel" title="Создать канал" aria-label="Создать канал">${iconHtml('channel')}</button>
          <button class="round-btn" data-action="discover" title="Обзор" aria-label="Обзор">${iconHtml('search')}</button>
        </div>
        <div class="search-box"><input id="chatSearch" class="input" placeholder="Поиск чатов" value="${escapeHtml(state.search)}"></div>
      </div>
      <div class="chat-list">
        ${chats.map((chat) => chatListItem(chat)).join('') || '<div class="empty-state"><p>Чаты не найдены</p></div>'}
      </div>
      <div class="sidebar-footer">
        <div class="sidebar-profile">
          <button class="me-card profile-card" data-action="settings" title="Профиль и настройки">
            ${avatarHtml(state.me)}
            <span class="me-meta">
              <span class="me-name">${escapeHtml(state.me.nickname)}</span>
              <span class="me-username">${escapeHtml(state.me.username)} · ${state.me.role === 'superadmin' ? 'главный админ' : state.me.role === 'admin' ? 'админ' : 'online'}</span>
            </span>
            <span class="online-dot on" title="online"></span>
          </button>
          <div class="profile-actions">
            <button class="round-btn settings-btn" data-action="settings" title="Настройки" aria-label="Настройки">${iconHtml('settings')}</button>
            ${isGlobalAdmin() ? `<button class="round-btn" data-action="admin" title="Админ-панель" aria-label="Админ-панель">${iconHtml('shield')}</button>` : ''}
          </div>
        </div>
      </div>
    `;
    $('#chatSearch')?.addEventListener('input', (event) => {
      state.search = event.target.value;
      renderSidebar();
    });
    $$('[data-chat-id]', sidebar).forEach((button) => {
      button.addEventListener('click', async () => {
        selectChat(button.dataset.chatId);
        state.sidebarOpen = false;
        renderSidebar();
      });
    });
    $$('[data-action]', sidebar).forEach((button) => button.addEventListener('click', handleAction));
  }

  function chatListItem(chat) {
    const last = chat.lastMessage;
    let lastText = chat.description || 'Нет сообщений';
    if (last) lastText = last.kind === 'voice' ? 'Голосовое сообщение' : last.text;
    const voiceCount = (chat.voiceStates || []).reduce((sum, room) => sum + (room.users?.length || 0), 0);
    const lastTime = last?.createdAt ? formatTime(last.createdAt) : '';
    return `
      <button class="chat-item ${chat.id === state.selectedChatId ? 'active' : ''}" data-chat-id="${chat.id}">
        ${chatIconHtml(chat)}
        <span class="chat-meta">
          <span class="chat-title">${escapeHtml(chat.title)}</span>
          <span class="chat-last">${escapeHtml(lastText)}</span>
        </span>
        <span class="chat-badges">
          ${lastTime ? `<span class="chat-time">${lastTime}</span>` : ''}
          ${chat.unread ? `<span class="badge">${chat.unread}</span>` : ''}
          ${voiceCount ? `<span class="type-pill icon-pill">${iconHtml('headphones')} ${voiceCount}</span>` : `<span class="type-pill">${typeLabel(chat)}</span>`}
        </span>
      </button>
    `;
  }

  function handleAction(event) {
    const action = event.currentTarget.dataset.action;
    if (action === 'new-dm') showNewDirectModal();
    if (action === 'new-group') showCreateCommunityModal('group');
    if (action === 'new-channel') showCreateCommunityModal('channel');
    if (action === 'discover') showDiscoverModal();
    if (action === 'settings') showSettingsModal();
    if (action === 'admin') showAdminModal();
  }

  async function selectChat(chatId) {
    state.selectedChatId = chatId;
    rememberSelectedChat(chatId);
    renderChat();
    renderDetails();
    if (!state.messages.has(chatId)) await loadMessages(chatId);
    else markRead(chatId);
  }

  function selectedChat() {
    return state.chats.find((chat) => chat.id === state.selectedChatId) || null;
  }

  function renderChat() {
    applySettings();
    const pane = $('#chatPane');
    if (!pane) return;
    const chat = selectedChat();
    if (!chat) {
      pane.innerHTML = `
        <div class="chat-header"><button class="round-btn mobile-menu-btn" data-mobile-menu aria-label="Меню">${iconHtml('menu')}</button><div class="chat-header-title">PulseLink</div></div>
        <div class="messages"><div class="empty-state">${logoHtml('large-logo')}<h2>Выберите чат</h2><p>Создайте личный чат, группу или найдите публичное сообщество в обзоре.</p></div></div>
      `;
      $('[data-mobile-menu]', pane)?.addEventListener('click', () => toggleSidebar());
      return;
    }
    const memberSummary = chat.type === 'direct'
      ? directSubtitle(chat)
      : `${chat.members?.length || chat.participants?.length || 0} участников · ${chat.public ? 'публичное' : 'приватное'}`;
    pane.innerHTML = `
      <header class="chat-header">
        <button class="round-btn mobile-menu-btn" data-mobile-menu aria-label="Меню">${iconHtml('menu')}</button>
        ${chatIconHtml(chat)}
        <div>
          <div class="chat-header-title">${escapeHtml(chat.title)}</div>
          <div class="chat-header-sub">${escapeHtml(memberSummary)}${chat.type === 'channel' ? ' · публикуют админы' : ''}</div>
        </div>
        <div class="header-actions">
          <button class="round-btn ${state.detailsOpen ? 'active' : ''}" data-details-toggle title="Информация" aria-label="Информация">${iconHtml('info')}</button>
        </div>
      </header>
      <div id="messages" class="messages"></div>
      <form id="composer" class="composer">
        <div id="recordingChip" class="recording-chip"><span class="record-dot"></span><span>Идёт запись… <b id="recordingTimer">0:00</b></span></div>
        <div class="composer-box">
          <button class="round-btn" type="button" id="recordButton" title="Голосовое сообщение" aria-label="Голосовое сообщение">${iconHtml('mic')}</button>
          <button class="round-btn" type="button" id="stopRecordButton" title="Остановить запись" hidden>⏹</button>
          <textarea id="messageInput" class="input" placeholder="${chat.canPost ? 'Напишите сообщение…' : 'В этом канале публикуют только администраторы'}" ${chat.canPost ? '' : 'disabled'}></textarea>
          <button class="primary-btn send-button" type="submit" ${chat.canPost ? '' : 'disabled'}>Отправить</button>
        </div>
        <div class="hint">${settings().sendMode === 'enter' ? 'Enter отправляет, Shift+Enter — новая строка' : 'Ctrl+Enter отправляет, Enter — новая строка'}</div>
      </form>
    `;
    $('[data-mobile-menu]', pane)?.addEventListener('click', () => toggleSidebar());
    $('[data-details-toggle]', pane)?.addEventListener('click', () => toggleDetails());
    $('#composer')?.addEventListener('submit', sendTextMessage);
    $('#messageInput')?.addEventListener('keydown', handleComposerKeydown);
    $('#recordButton')?.addEventListener('click', startVoiceMessageRecording);
    $('#stopRecordButton')?.addEventListener('click', stopVoiceMessageRecording);
    renderMessages();
    updateRecordingUi();
  }

  function directSubtitle(chat) {
    const other = (chat.members || []).find((member) => member.id !== state.me.id);
    if (!other) return 'личный чат';
    const online = state.online.get(other.id)?.online || other.online;
    return `${other.username} · ${online ? 'online' : `был(а) ${formatTime(other.lastSeen)}`}`;
  }

  function renderMessages() {
    const wrap = $('#messages');
    const chat = selectedChat();
    if (!wrap || !chat) return;
    const messages = state.messages.get(chat.id) || [];
    if (!messages.length) {
      wrap.innerHTML = `<div class="empty-state"><h2>${chat.type === 'saved' ? 'Ваше избранное' : 'Пока пусто'}</h2><p>${chat.type === 'saved' ? 'Сохраняйте здесь заметки и голосовые — их видите только вы.' : 'Отправьте первое сообщение или голосовое.'}</p></div>`;
      return;
    }
    let lastDay = '';
    wrap.innerHTML = messages.map((message) => {
      const day = formatDate(message.createdAt);
      const divider = day !== lastDay ? `<div class="day-divider">${day}</div>` : '';
      lastDay = day;
      return divider + messageHtml(message, chat);
    }).join('');
    setupVoicePlayers(wrap);
    requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
  }

  function messageHtml(message, chat) {
    if (message.system) return `<div class="system-message">${escapeHtml(message.text)}</div>`;
    const own = message.senderId === state.me.id;
    const sender = message.sender || { nickname: 'Unknown', username: '@unknown' };
    const read = own && chat.type === 'direct' && (chat.participants || []).every((id) => id === state.me.id || (message.readBy || []).includes(id));
    return `
      <div class="message-row ${own ? 'own' : ''}" data-message-id="${message.id}">
        ${avatarHtml(sender, 'small')}
        <div class="message-bubble">
          ${!own ? `<div class="message-name">${escapeHtml(sender.nickname)} · ${escapeHtml(sender.username)}</div>` : ''}
          ${message.kind === 'voice' ? voiceMessageHtml(message) : `<div class="message-text">${escapeHtml(message.text)}</div>`}
          <div class="message-foot"><span>${formatTime(message.createdAt)}</span>${own ? `<span class="read-status ${read ? 'read' : ''}">${read ? '✓✓' : '✓'}</span>` : ''}</div>
        </div>
      </div>
    `;
  }

  function voiceMessageHtml(message) {
    return `
      <div class="voice-player" data-voice-id="${message.id}">
        <button class="round-btn" type="button" data-voice-play>▶</button>
        <canvas width="520" height="88" data-waveform="${escapeHtml(JSON.stringify(message.waveform || []))}"></canvas>
        <span class="voice-duration">${formatDuration(message.duration)}</span>
        <audio src="${message.audioDataUrl}" preload="metadata"></audio>
      </div>
    `;
  }

  function setupVoicePlayers(root) {
    $$('[data-voice-id]', root).forEach((player) => {
      const audio = $('audio', player);
      const button = $('[data-voice-play]', player);
      const canvas = $('canvas', player);
      const waveform = JSON.parse(canvas.dataset.waveform || '[]');
      const ctx = canvas.getContext('2d');
      const draw = () => drawWaveform(ctx, canvas, waveform, audio.duration ? audio.currentTime / audio.duration : 0);
      draw();
      button.addEventListener('click', () => {
        if (audio.paused) audio.play(); else audio.pause();
      });
      audio.addEventListener('play', () => { button.textContent = '⏸'; });
      audio.addEventListener('pause', () => { button.textContent = '▶'; });
      audio.addEventListener('ended', () => { button.textContent = '▶'; draw(); });
      audio.addEventListener('timeupdate', draw);
      canvas.addEventListener('click', (event) => {
        const rect = canvas.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        if (Number.isFinite(audio.duration)) audio.currentTime = audio.duration * ratio;
        draw();
      });
    });
  }

  function drawWaveform(ctx, canvas, waveform, progress = 0) {
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    const bars = waveform.length ? waveform : Array.from({ length: 48 }, (_, index) => 0.18 + Math.abs(Math.sin(index)) * 0.55);
    const gap = 3;
    const barWidth = Math.max(3, (width - gap * (bars.length - 1)) / bars.length);
    bars.forEach((value, index) => {
      const x = index * (barWidth + gap);
      const h = Math.max(5, value * (height - 14));
      const y = (height - h) / 2;
      ctx.fillStyle = index / bars.length <= progress ? '#8be9fd' : 'rgba(238,244,255,0.42)';
      roundRect(ctx, x, y, barWidth, h, 8);
      ctx.fill();
    });
  }

  function roundRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  function handleComposerKeydown(event) {
    const sendMode = settings().sendMode;
    if (sendMode === 'enter' && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#composer')?.requestSubmit();
    }
    if (sendMode === 'ctrlEnter' && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      $('#composer')?.requestSubmit();
    }
  }

  async function sendTextMessage(event) {
    event.preventDefault();
    const chat = selectedChat();
    const input = $('#messageInput');
    const text = input?.value.trim();
    if (!chat || !text) return;
    input.value = '';
    try {
      const data = await api(`/api/chats/${encodeURIComponent(chat.id)}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
      appendMessage(chat.id, data.message);
    } catch (error) {
      input.value = text;
      toast(error.message, 'error');
    }
  }

  function appendMessage(chatId, message) {
    const list = state.messages.get(chatId) || [];
    if (!list.some((item) => item.id === message.id)) list.push(message);
    state.messages.set(chatId, list);
    const chat = state.chats.find((item) => item.id === chatId);
    if (chat) {
      chat.lastMessage = message;
      chat.updatedAt = message.createdAt;
      if (state.selectedChatId !== chatId && message.senderId !== state.me.id) chat.unread = (chat.unread || 0) + 1;
    }
    renderSidebar();
    if (state.selectedChatId === chatId) {
      renderMessages();
      markRead(chatId);
    }
  }

  async function startVoiceMessageRecording() {
    const chat = selectedChat();
    if (!chat?.canPost || state.recording) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      toast('Браузер не поддерживает запись с микрофона', 'error');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const recorder = new MediaRecorder(stream);
      const chunks = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        const duration = (Date.now() - state.recording.startedAt) / 1000;
        const mime = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunks, { type: mime });
        stream.getTracks().forEach((track) => track.stop());
        const recording = state.recording;
        state.recording = null;
        updateRecordingUi();
        clearInterval(recording.timer);
        try {
          const [audioDataUrl, waveform] = await Promise.all([blobToDataUrl(blob), waveformFromBlob(blob)]);
          const data = await api(`/api/chats/${encodeURIComponent(chat.id)}/voice-messages`, {
            method: 'POST',
            body: JSON.stringify({ audioDataUrl, waveform, duration })
          });
          appendMessage(chat.id, data.message);
        } catch (error) {
          toast(error.message || 'Не удалось отправить голосовое', 'error');
        }
      };
      state.recording = { recorder, stream, chunks, startedAt: Date.now(), timer: setInterval(updateRecordingUi, 250) };
      recorder.start(250);
      updateRecordingUi();
    } catch (error) {
      toast('Нет доступа к микрофону', 'error');
    }
  }

  function stopVoiceMessageRecording() {
    if (!state.recording) return;
    state.recording.recorder.stop();
  }

  function updateRecordingUi() {
    const chip = $('#recordingChip');
    const timer = $('#recordingTimer');
    const recordButton = $('#recordButton');
    const stopButton = $('#stopRecordButton');
    if (!chip || !recordButton || !stopButton) return;
    const active = Boolean(state.recording);
    chip.classList.toggle('active', active);
    recordButton.hidden = active;
    stopButton.hidden = !active;
    if (active && timer) timer.textContent = formatDuration((Date.now() - state.recording.startedAt) / 1000);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function waveformFromBlob(blob) {
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      const data = audioBuffer.getChannelData(0);
      const bars = 56;
      const block = Math.max(1, Math.floor(data.length / bars));
      const waveform = [];
      for (let i = 0; i < bars; i += 1) {
        let sum = 0;
        for (let j = 0; j < block; j += 1) sum += Math.abs(data[i * block + j] || 0);
        waveform.push(Math.min(1, Math.max(0.05, (sum / block) * 2.8)));
      }
      ctx.close?.();
      return waveform;
    } catch (_error) {
      return Array.from({ length: 56 }, (_, index) => 0.15 + Math.abs(Math.sin(index * 1.7)) * 0.7);
    }
  }

  function renderDetails() {
    const pane = $('#detailsPane');
    if (!pane) return;
    updateShellLayout();
    pane.classList.toggle('open', state.detailsOpen);
    const chat = selectedChat();
    if (!chat) {
      pane.innerHTML = '<div class="details-header"><div class="modal-title">Информация</div></div>';
      return;
    }
    pane.innerHTML = `
      <div class="details-header">
        <div class="button-row" style="justify-content:space-between">
          <div class="modal-title">${escapeHtml(chat.title)}</div>
          <button class="round-btn" data-close-details aria-label="Закрыть">${iconHtml('close')}</button>
        </div>
        <div class="muted">${escapeHtml(chat.description || typeLabel(chat))}</div>
      </div>
      <div class="details-scroll">
        ${chat.type === 'group' ? voiceChannelsHtml(chat) : ''}
        ${communityToolsHtml(chat)}
        ${membersHtml(chat)}
      </div>
    `;
    $('[data-close-details]', pane)?.addEventListener('click', () => toggleDetails(false));
    $$('[data-join-voice]', pane).forEach((button) => button.addEventListener('click', () => joinVoice(chat.id, button.dataset.joinVoice, false)));
    $$('[data-listen-voice]', pane).forEach((button) => button.addEventListener('click', () => joinVoice(chat.id, button.dataset.listenVoice, true)));
    $('[data-add-voice-channel]', pane)?.addEventListener('submit', addVoiceChannel);
    $$('[data-username-input]', pane).forEach((input) => wireUsernameAutoprefix(input));
    $('[data-add-member]', pane)?.addEventListener('submit', addMember);
    $$('[data-member-action]', pane).forEach((button) => button.addEventListener('click', handleMemberAction));
    $('[data-leave-chat]', pane)?.addEventListener('click', leaveChat);
    $('[data-delete-chat]', pane)?.addEventListener('click', deleteCurrentChat);
    $('[data-edit-chat]', pane)?.addEventListener('click', () => showEditChatModal(chat));
  }

  function voiceChannelsHtml(chat) {
    const channels = chat.voiceChannels || [];
    return `
      <section class="panel-card">
        <div class="panel-title"><span>Голосовые каналы</span>${chat.canAdmin ? '<span class="tiny-text">AudioWorklet + WS relay</span>' : ''}</div>
        <div class="voice-channel-list">
          ${channels.map((channel) => voiceChannelHtml(chat, channel)).join('') || '<div class="muted">Нет каналов</div>'}
        </div>
        ${chat.canAdmin ? `
          <form class="form-stack" data-add-voice-channel style="margin-top:12px">
            <input class="input" name="name" placeholder="Новый голосовой канал" maxlength="48" required>
            <button class="secondary-btn" type="submit">Добавить канал</button>
          </form>
        ` : ''}
      </section>
    `;
  }

  function voiceChannelHtml(chat, channel) {
    const room = (chat.voiceStates || []).find((stateItem) => stateItem.channelId === channel.id);
    const users = room?.users || [];
    const active = state.voice?.chatId === chat.id && state.voice?.channelId === channel.id;
    return `
      <div class="voice-channel">
        <div class="voice-channel-head">
          <div class="voice-channel-name">${iconHtml('volume')} ${escapeHtml(channel.name)}</div>
          <div class="voice-channel-actions">
            <button class="mini-btn" data-join-voice="${channel.id}">${active ? 'Войти снова' : 'Войти'}</button>
            <button class="mini-btn" data-listen-voice="${channel.id}" title="Режим слушателя" aria-label="Режим слушателя">${iconHtml('headphones')}</button>
          </div>
        </div>
        <div class="voice-users">
          ${users.map((user) => `
            <div class="voice-user-row ${user.speaking ? 'speaking' : ''}">
              ${avatarHtml(user, 'tiny')}
              <div class="member-name">${escapeHtml(user.nickname)}</div>
              <div class="voice-state-icons">${user.listener ? iconHtml('headphones') : ''}${user.muted ? iconHtml('micOff') : iconHtml('mic')}</div>
            </div>
          `).join('') || '<div class="tiny-text">Пока никто не подключен</div>'}
        </div>
      </div>
    `;
  }

  function communityToolsHtml(chat) {
    if (!['group', 'channel'].includes(chat.type)) {
      return `<section class="panel-card"><div class="panel-title">${chat.type === 'saved' ? 'Избранное' : 'Личный чат'}</div><p class="muted">${chat.type === 'saved' ? 'Это приватное хранилище видно только вам.' : 'Сообщения доставляются мгновенно через SSE, статус прочтения отмечается ✓✓.'}</p></section>`;
    }
    return `
      <section class="panel-card">
        <div class="panel-title"><span>Управление</span><span class="type-pill">${chat.public ? 'public' : 'private'}</span></div>
        <div class="button-row">
          ${chat.canAdmin ? '<button class="secondary-btn" data-edit-chat>Изменить</button>' : ''}
          <button class="ghost-btn" data-leave-chat>Выйти</button>
          ${(chat.canAdmin || isGlobalAdmin()) ? '<button class="danger-btn" data-delete-chat>Удалить</button>' : ''}
        </div>
        ${chat.type === 'channel' ? '<p class="hint">Канал: публиковать сообщения могут только владелец и администраторы.</p>' : ''}
      </section>
    `;
  }

  function membersHtml(chat) {
    const members = chat.members || [];
    return `
      <section class="panel-card">
        <div class="panel-title"><span>Участники</span><span class="badge">${members.length}</span></div>
        ${chat.canAdmin && ['group', 'channel'].includes(chat.type) ? `
          <form class="form-stack" data-add-member style="margin-bottom:12px">
            <input class="input" name="username" placeholder="@username" data-username-input required>
            <button class="secondary-btn" type="submit">Добавить</button>
          </form>
        ` : ''}
        <div class="member-list">
          ${members.map((member) => memberRowHtml(chat, member)).join('')}
        </div>
      </section>
    `;
  }

  function memberRowHtml(chat, member) {
    const role = chat.ownerId === member.id ? 'владелец' : (chat.admins || []).includes(member.id) ? 'админ' : member.role === 'superadmin' ? 'superadmin' : 'участник';
    const canManage = chat.canAdmin && ['group', 'channel'].includes(chat.type) && member.id !== state.me.id;
    const isOwner = chat.ownerId === state.me.id || isSuperAdmin();
    return `
      <div class="member-row">
        ${avatarHtml(member, 'small')}
        <div>
          <div class="member-name">${escapeHtml(member.nickname)}</div>
          <div class="member-role">${escapeHtml(member.username)} · ${role} · ${(state.online.get(member.id)?.online || member.online) ? 'online' : 'offline'}</div>
        </div>
        <div class="member-actions">
          ${canManage && isOwner && chat.ownerId !== member.id ? `<button class="mini-btn" data-member-action="${(chat.admins || []).includes(member.id) ? 'member' : 'admin'}" data-member-id="${member.id}">${(chat.admins || []).includes(member.id) ? 'снять' : 'админ'}</button>` : ''}
          ${canManage && isOwner && chat.ownerId !== member.id ? `<button class="mini-btn" data-member-action="owner" data-member-id="${member.id}">передать</button>` : ''}
          ${canManage && chat.ownerId !== member.id ? `<button class="mini-btn danger" data-member-action="remove" data-member-id="${member.id}">убрать</button>` : ''}
        </div>
      </div>
    `;
  }

  async function addVoiceChannel(event) {
    event.preventDefault();
    const chat = selectedChat();
    const name = new FormData(event.currentTarget).get('name');
    try {
      const data = await api(`/api/chats/${chat.id}/voice-channels`, { method: 'POST', body: JSON.stringify({ name }) });
      replaceChat(data.chat);
      renderDetails();
      toast('Голосовой канал добавлен', 'success');
    } catch (error) { toast(error.message, 'error'); }
  }

  async function addMember(event) {
    event.preventDefault();
    const chat = selectedChat();
    const username = normalizeUsernameForSubmit(new FormData(event.currentTarget).get('username'));
    try {
      const data = await api(`/api/chats/${chat.id}/members`, { method: 'POST', body: JSON.stringify({ username }) });
      replaceChat(data.chat);
      renderDetails();
      toast('Участник добавлен', 'success');
    } catch (error) { toast(error.message, 'error'); }
  }

  async function handleMemberAction(event) {
    const chat = selectedChat();
    const action = event.currentTarget.dataset.memberAction;
    const memberId = event.currentTarget.dataset.memberId;
    try {
      if (action === 'remove') {
        await api(`/api/chats/${chat.id}/members/${memberId}`, { method: 'DELETE' });
      } else {
        await api(`/api/chats/${chat.id}/members/${memberId}`, { method: 'PATCH', body: JSON.stringify({ role: action }) });
      }
      await loadChats();
      renderShell();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function leaveChat() {
    const chat = selectedChat();
    if (!chat || !confirm('Выйти из сообщества?')) return;
    try {
      await api(`/api/chats/${chat.id}/leave`, { method: 'POST', body: '{}' });
      await loadChats();
      renderShell();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function deleteCurrentChat() {
    const chat = selectedChat();
    if (!chat || !confirm('Удалить чат и все сообщения?')) return;
    try {
      const endpoint = isGlobalAdmin() ? `/api/admin/chats/${chat.id}` : `/api/chats/${chat.id}`;
      await api(endpoint, { method: 'DELETE' });
      state.messages.delete(chat.id);
      await loadChats();
      renderShell();
    } catch (error) { toast(error.message, 'error'); }
  }

  function replaceChat(chat) {
    const index = state.chats.findIndex((item) => item.id === chat.id);
    if (index === -1) state.chats.unshift(chat);
    else state.chats[index] = chat;
    renderSidebar();
  }

  function toggleSidebar(force) {
    state.sidebarOpen = typeof force === 'boolean' ? force : !state.sidebarOpen;
    updateShellLayout();
    renderSidebar();
  }

  function toggleDetails(force) {
    state.detailsOpen = typeof force === 'boolean' ? force : !state.detailsOpen;
    updateShellLayout();
    renderChat();
    renderDetails();
  }

  function openModal(title, bodyHtml, { wide = false, compact = false } = {}) {
    const modalClass = ['modal', wide ? 'wide' : '', compact ? 'compact' : ''].filter(Boolean).join(' ');
    modalRoot.innerHTML = `
      <div class="modal-backdrop" data-modal-backdrop>
        <section class="${modalClass}" role="dialog" aria-modal="true">
          <header class="modal-head"><div class="modal-title">${escapeHtml(title)}</div><button class="round-btn" data-modal-close aria-label="Закрыть">${iconHtml('close')}</button></header>
          <div class="modal-body">${bodyHtml}</div>
        </section>
      </div>
    `;
    $('[data-modal-close]').addEventListener('click', closeModal);
    $('[data-modal-backdrop]').addEventListener('click', (event) => {
      if (event.target.dataset.modalBackdrop !== undefined) closeModal();
    });
    return $('.modal-body');
  }

  function closeModal() {
    modalRoot.innerHTML = '';
  }

  function showNewDirectModal() {
    const body = openModal('Новый личный чат', `
      <form id="newDmForm" class="form-stack">
        <label class="field"><span>@username</span><input class="input" name="username" placeholder="@friend" data-username-input required></label>
        <button class="primary-btn" type="submit">Открыть чат</button>
      </form>
    `);
    $$('[data-username-input]', body).forEach((input) => wireUsernameAutoprefix(input));
    $('#newDmForm', body).addEventListener('submit', async (event) => {
      event.preventDefault();
      const username = normalizeUsernameForSubmit(new FormData(event.currentTarget).get('username'));
      try {
        const data = await api('/api/chats/direct', { method: 'POST', body: JSON.stringify({ username }) });
        replaceChat(data.chat);
        closeModal();
        await selectChat(data.chat.id);
      } catch (error) { toast(error.message, 'error'); }
    });
  }

  function showCreateCommunityModal(type) {
    let avatar = '';
    const body = openModal(type === 'channel' ? 'Создать канал' : 'Создать группу', `
      <form id="createCommunityForm" class="modal-grid compact-create">
        <div class="compact-avatar-row">
          <span id="communityAvatarPreview" class="avatar-fallback small">${iconHtml(type === 'channel' ? 'channel' : 'users')}</span>
          <label class="ghost-btn compact-upload" for="communityAvatarInput">Аватар</label>
          <input id="communityAvatarInput" type="file" accept="image/*" hidden>
        </div>
        <label class="field"><span>Название</span><input class="input" name="title" maxlength="80" placeholder="Например: Команда Pulse" required></label>
        <label class="field"><span>Описание</span><textarea class="textarea compact-textarea" name="description" maxlength="280" rows="3" placeholder="Коротко о сообществе"></textarea></label>
        <label class="check-row compact-check"><input type="checkbox" name="public" checked><span>Публичное сообщество</span></label>
        <button class="primary-btn" type="submit">Создать</button>
      </form>
    `, { compact: true });
    $('#communityAvatarInput', body).addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      avatar = await compressImage(file);
      $('#communityAvatarPreview', body).outerHTML = `<img id="communityAvatarPreview" class="avatar small" src="${avatar}" alt="">`;
    });
    $('#createCommunityForm', body).addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = Object.fromEntries(new FormData(event.currentTarget).entries());
      try {
        const data = await api('/api/chats', {
          method: 'POST',
          body: JSON.stringify({ type, title: form.title, description: form.description, public: Boolean(form.public), avatar })
        });
        replaceChat(data.chat);
        closeModal();
        await selectChat(data.chat.id);
      } catch (error) { toast(error.message, 'error'); }
    });
  }

  function showEditChatModal(chat) {
    let avatar = chat.avatar || '';
    const body = openModal('Настройки сообщества', `
      <form id="editChatForm" class="modal-grid">
        <div class="avatar-upload">
          <span id="editChatAvatarWrap">${avatar ? `<img class="avatar large" src="${avatar}" alt="">` : avatarHtml(chat, 'large')}</span>
          <div>
            <label class="secondary-btn" for="editChatAvatarInput">Сменить аватар</label>
            <input id="editChatAvatarInput" type="file" accept="image/*" hidden>
          </div>
        </div>
        <label class="field"><span>Название</span><input class="input" name="title" maxlength="80" value="${escapeHtml(chat.rawTitle || chat.title)}" required></label>
        <label class="field"><span>Описание</span><textarea class="textarea" name="description" maxlength="280">${escapeHtml(chat.description || '')}</textarea></label>
        <label class="check-row"><input type="checkbox" name="public" ${chat.public ? 'checked' : ''}><span>Публичное</span></label>
        <button class="primary-btn" type="submit">Сохранить</button>
      </form>
    `);
    $('#editChatAvatarInput', body).addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      avatar = await compressImage(file);
      $('#editChatAvatarWrap', body).innerHTML = `<img class="avatar large" src="${avatar}" alt="">`;
    });
    $('#editChatForm', body).addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = Object.fromEntries(new FormData(event.currentTarget).entries());
      try {
        const data = await api(`/api/chats/${chat.id}`, { method: 'PATCH', body: JSON.stringify({ title: form.title, description: form.description, public: Boolean(form.public), avatar }) });
        replaceChat(data.chat);
        closeModal();
        renderShell();
      } catch (error) { toast(error.message, 'error'); }
    });
  }

  function showDiscoverModal() {
    const body = openModal('Обзор сообществ', `
      <div class="modal-grid">
        <div class="search-box"><input id="discoverSearch" class="input" placeholder="Поиск публичных групп и каналов"></div>
        <div id="discoverResults" class="discover-results"><div class="muted">Загрузка…</div></div>
      </div>
    `, { wide: true });
    const load = debounce(async () => {
      const q = encodeURIComponent($('#discoverSearch', body).value || '');
      const result = $('#discoverResults', body);
      result.innerHTML = '<div class="muted">Ищем…</div>';
      try {
        const data = await api(`/api/discover?q=${q}`);
        result.innerHTML = (data.chats || []).map((chat) => `
          <div class="discover-card">
            ${chatIconHtml(chat)}
            <div>
              <div class="chat-title">${escapeHtml(chat.title)}</div>
              <div class="chat-last">${escapeHtml(chat.description || typeLabel(chat))} · ${chat.members?.length || chat.participants?.length || 0} участников</div>
            </div>
            <button class="${chat.joined ? 'ghost-btn' : 'primary-btn'}" data-discover-join="${chat.id}" ${chat.joined ? 'disabled' : ''}>${chat.joined ? 'Вы уже там' : 'Вступить'}</button>
          </div>
        `).join('') || '<div class="empty-state"><p>Публичные сообщества не найдены</p></div>';
        $$('[data-discover-join]', result).forEach((button) => button.addEventListener('click', async () => {
          try {
            const data = await api(`/api/chats/${button.dataset.discoverJoin}/join`, { method: 'POST', body: '{}' });
            replaceChat(data.chat);
            await loadChats();
            renderShell();
            closeModal();
            selectChat(data.chat.id);
          } catch (error) { toast(error.message, 'error'); }
        }));
      } catch (error) { result.innerHTML = `<div class="error-text">${escapeHtml(error.message)}</div>`; }
    }, 250);
    $('#discoverSearch', body).addEventListener('input', load);
    load();
  }

  function showSettingsModal() {
    let avatar = state.me.avatar || '';
    const s = settings();
    const body = openModal('Настройки', `
      <form id="settingsForm" class="modal-grid">
        <div class="avatar-upload">
          <span id="profileAvatarWrap">${avatar ? `<img class="avatar large" src="${avatar}" alt="">` : avatarHtml(state.me, 'large')}</span>
          <div>
            <label class="secondary-btn" for="profileAvatarInput">Загрузить аватар</label>
            <input id="profileAvatarInput" type="file" accept="image/*" hidden>
            <div class="hint">Обрезка квадратом + сжатие на клиенте, хранение dataURL.</div>
          </div>
        </div>
        <label class="field"><span>Nickname</span><input class="input" name="nickname" value="${escapeHtml(state.me.nickname)}" maxlength="48" required></label>
        <div class="two-col">
          <label class="check-row"><input type="checkbox" name="messageSound" ${s.messageSound ? 'checked' : ''}><span>Звук сообщений</span></label>
          <label class="check-row"><input type="checkbox" name="notifications" ${s.notifications ? 'checked' : ''}><span>Системные уведомления</span></label>
          <label class="check-row"><input type="checkbox" name="compactMode" ${s.compactMode ? 'checked' : ''}><span>Компактный режим</span></label>
          <label class="field"><span>Отправка</span><select class="select" name="sendMode"><option value="enter" ${s.sendMode === 'enter' ? 'selected' : ''}>Enter</option><option value="ctrlEnter" ${s.sendMode === 'ctrlEnter' ? 'selected' : ''}>Ctrl+Enter</option></select></label>
        </div>
        <label class="field scale-field"><span>Масштаб интерфейса: <b id="uiScaleValue">${Math.round((Number(s.uiScale) || 1) * 100)}%</b></span><input class="range-input" name="uiScale" type="range" min="85" max="120" step="5" value="${Math.round((Number(s.uiScale) || 1) * 100)}"></label>
        <div class="settings-actions">
          <button class="danger-btn" type="button" id="settingsLogout">${iconHtml('logout')} Выйти из аккаунта</button>
          <button class="primary-btn" type="submit">Сохранить</button>
        </div>
      </form>
    `);
    $('#profileAvatarInput', body).addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      avatar = await compressImage(file);
      $('#profileAvatarWrap', body).innerHTML = `<img class="avatar large" src="${avatar}" alt="">`;
    });
    $('[name="uiScale"]', body)?.addEventListener('input', (event) => {
      const value = Number(event.target.value || 100);
      $('#uiScaleValue', body).textContent = `${value}%`;
      document.documentElement.style.setProperty('--ui-scale', (value / 100).toFixed(2));
    });
    $('#settingsLogout', body)?.addEventListener('click', async () => {
      closeModal();
      await logout(true);
    });
    $('#settingsForm', body).addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = Object.fromEntries(new FormData(event.currentTarget).entries());
      const nextSettings = {
        messageSound: Boolean(form.messageSound),
        notifications: Boolean(form.notifications),
        compactMode: Boolean(form.compactMode),
        sendMode: form.sendMode,
        uiScale: Math.max(0.85, Math.min(1.2, Number(form.uiScale || 100) / 100))
      };
      if (nextSettings.notifications && window.Notification?.permission === 'default') {
        try { await window.Notification.requestPermission(); } catch (_error) { /* noop */ }
      }
      try {
        const data = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ nickname: form.nickname, avatar, settings: nextSettings }) });
        state.me = data.user;
        closeModal();
        renderShell();
        toast('Настройки сохранены', 'success');
      } catch (error) { toast(error.message, 'error'); }
    });
  }

  async function showAdminModal() {
    const body = openModal('Админ-панель', '<div class="muted">Загрузка…</div>', { wide: true });
    try {
      const [{ stats }, { users }] = await Promise.all([api('/api/admin/stats'), api('/api/admin/users')]);
      body.innerHTML = `
        <div class="modal-grid">
          <div class="stats-grid">
            ${statCard('Пользователи', stats.users)}
            ${statCard('Online', stats.online)}
            ${statCard('Чаты', stats.chats)}
            ${statCard('Сообщения', stats.messages)}
            ${statCard('Группы', stats.groups)}
            ${statCard('Каналы', stats.channels)}
            ${statCard('Голосовые', stats.voiceMessages)}
            ${statCard('Баны', stats.banned)}
          </div>
          <form id="announcementForm" class="panel-card form-stack">
            <div class="panel-title">Объявление в PulseLink News</div>
            <textarea class="textarea" name="text" placeholder="Текст объявления" required></textarea>
            <button class="primary-btn" type="submit">Опубликовать</button>
          </form>
          <div class="panel-card">
            <div class="panel-title">Управление пользователями</div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Пользователь</th><th>Почта</th><th>Роль</th><th>Статус</th><th>Действия</th></tr></thead>
                <tbody>
                  ${users.map((user) => `
                    <tr>
                      <td>${escapeHtml(user.nickname)}<br><span class="tiny-text">${escapeHtml(user.username)}</span></td>
                      <td>${escapeHtml(user.email || '')}</td>
                      <td>${escapeHtml(user.role)}</td>
                      <td>${user.banned ? 'ban' : user.online ? 'online' : 'offline'}</td>
                      <td class="button-row">
                        <button class="mini-btn" data-admin-user="${user.id}" data-admin-action="${user.banned ? 'unban' : 'ban'}">${user.banned ? 'разбан' : 'бан'}</button>
                        <button class="mini-btn" data-admin-user="${user.id}" data-admin-action="admin">admin</button>
                        <button class="mini-btn" data-admin-user="${user.id}" data-admin-action="user">user</button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `;
      $('#announcementForm', body).addEventListener('submit', async (event) => {
        event.preventDefault();
        const text = new FormData(event.currentTarget).get('text');
        try {
          await api('/api/admin/announcement', { method: 'POST', body: JSON.stringify({ text }) });
          event.currentTarget.reset();
          await loadChats();
          renderShell();
          toast('Объявление опубликовано', 'success');
        } catch (error) { toast(error.message, 'error'); }
      });
      $$('[data-admin-user]', body).forEach((button) => button.addEventListener('click', async () => {
        const action = button.dataset.adminAction;
        const payload = action === 'ban' ? { banned: true } : action === 'unban' ? { banned: false } : { role: action };
        try {
          await api(`/api/admin/users/${button.dataset.adminUser}`, { method: 'PATCH', body: JSON.stringify(payload) });
          toast('Пользователь обновлен', 'success');
          showAdminModal();
        } catch (error) { toast(error.message, 'error'); }
      }));
    } catch (error) {
      body.innerHTML = `<div class="error-text">${escapeHtml(error.message)}</div>`;
    }
  }

  function statCard(label, value) {
    return `<div class="stat-card"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`;
  }

  async function compressImage(file, size = 384, quality = 0.82) {
    const image = await loadImage(file);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const side = Math.min(image.width, image.height);
    const sx = (image.width - side) / 2;
    const sy = (image.height - side) / 2;
    ctx.drawImage(image, sx, sy, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', quality);
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = reject;
      image.src = url;
    });
  }

  function connectSse() {
    disconnectSse();
    if (!state.token) return;
    const source = new EventSource(`/api/events?token=${encodeURIComponent(state.token)}`);
    state.eventSource = source;
    source.addEventListener('ready', (event) => {
      const data = JSON.parse(event.data);
      setOnline(data.online || []);
      renderShell();
    });
    source.addEventListener('presence', (event) => {
      const data = JSON.parse(event.data);
      setOnline(data.users || []);
      renderSidebar();
      renderDetails();
    });
    source.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      if (data.message) {
        appendMessage(data.chatId, data.message);
        if (data.message.senderId !== state.me.id) notifyIncoming(data.message);
      }
    });
    source.addEventListener('read', (event) => {
      const data = JSON.parse(event.data);
      const list = state.messages.get(data.chatId) || [];
      for (const message of list) {
        message.readBy = [...new Set([...(message.readBy || []), data.userId])];
      }
      if (state.selectedChatId === data.chatId) renderMessages();
    });
    source.addEventListener('chat_updated', async () => {
      await loadChats();
      renderSidebar();
      renderDetails();
    });
    source.addEventListener('chat_deleted', async (event) => {
      const data = JSON.parse(event.data);
      state.messages.delete(data.chatId);
      await loadChats();
      renderShell();
    });
    source.addEventListener('voice_state', (event) => {
      const data = JSON.parse(event.data);
      const chat = state.chats.find((item) => item.id === data.chatId);
      if (chat) chat.voiceStates = data.states || [];
      renderSidebar();
      renderDetails();
    });
    source.addEventListener('user_updated', async () => {
      await loadChats();
      renderShell();
    });
    source.onerror = () => {
      console.warn('[PulseLink] SSE disconnected, polling fallback remains active');
    };
  }

  function disconnectSse() {
    if (state.eventSource) state.eventSource.close();
    state.eventSource = null;
  }

  function setOnline(users) {
    for (const item of users || []) state.online.set(item.id, item);
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(async () => {
      if (!state.token) return;
      try {
        const query = state.selectedChatId ? `?chatId=${encodeURIComponent(state.selectedChatId)}` : '';
        const data = await api(`/api/poll${query}`);
        setOnline(data.online || []);
        if (data.chats) state.chats = data.chats;
        if (data.messages && state.selectedChatId) state.messages.set(state.selectedChatId, data.messages);
        renderSidebar();
        renderDetails();
        if (data.messages) renderMessages();
      } catch (_error) { /* fallback is best effort */ }
    }, 15000);
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function notifyIncoming(message) {
    const s = settings();
    if (s.messageSound) playBeep();
    if (s.notifications && document.hidden && window.Notification?.permission === 'granted') {
      const sender = message.sender?.nickname || 'PulseLink';
      const text = message.kind === 'voice' ? 'Голосовое сообщение' : message.text;
      new Notification(sender, { body: text, icon: '/favicon.ico' });
    }
  }

  function playBeep() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.18);
      setTimeout(() => ctx.close?.(), 260);
    } catch (_error) { /* noop */ }
  }

  async function joinVoice(chatId, channelId, listener = false) {
    await leaveVoice();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const voice = {
      chatId,
      channelId,
      muted: false,
      listener,
      ws: null,
      ctx: new AudioCtx({ sampleRate: 48000 }),
      stream: null,
      source: null,
      worklet: null,
      zeroGain: null,
      nextPlayTime: 0,
      speakers: new Map()
    };
    state.voice = voice;
    try { await voice.ctx.resume(); } catch (_error) { /* noop */ }
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${scheme}://${location.host}/voice?token=${encodeURIComponent(state.token)}&chatId=${encodeURIComponent(chatId)}&channelId=${encodeURIComponent(channelId)}&listener=${listener ? '1' : '0'}`;
    voice.ws = new WebSocket(url);
    voice.ws.binaryType = 'arraybuffer';
    voice.ws.onopen = async () => {
      if (!listener) {
        try {
          await setupVoiceCapture(voice);
        } catch (_error) {
          voice.listener = true;
          toast('Микрофон недоступен — включён режим слушателя', 'error');
        }
      }
      sendVoiceState();
      renderVoiceControls();
      toast(voice.listener ? 'Вы слушаете голосовой канал' : 'Вы вошли в голосовой канал', 'success');
    };
    voice.ws.onmessage = (event) => {
      if (typeof event.data === 'string') handleVoiceTextMessage(event.data);
      else handleVoiceBinaryMessage(event.data);
    };
    voice.ws.onclose = () => {
      if (state.voice === voice) {
        cleanupVoiceResources(voice);
        state.voice = null;
        renderVoiceControls();
        renderDetails();
      }
    };
    voice.ws.onerror = () => toast('Ошибка голосового канала', 'error');
    renderVoiceControls();
  }

  async function setupVoiceCapture(voice) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Нет getUserMedia');
    voice.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    await voice.ctx.audioWorklet.addModule('/audio-worklet.js');
    voice.source = voice.ctx.createMediaStreamSource(voice.stream);
    voice.worklet = new AudioWorkletNode(voice.ctx, 'pulselink-pcm-capture');
    voice.zeroGain = voice.ctx.createGain();
    voice.zeroGain.gain.value = 0;
    voice.worklet.port.onmessage = (event) => {
      const current = state.voice;
      if (!current || current !== voice || !voice.ws || voice.ws.readyState !== WebSocket.OPEN) return;
      if (voice.muted || voice.listener) return;
      voice.ws.send(event.data.pcm);
      if ((event.data.level || 0) > 0.025) markSpeaker(state.me.id);
    };
    voice.source.connect(voice.worklet).connect(voice.zeroGain).connect(voice.ctx.destination);
  }

  function handleVoiceTextMessage(text) {
    let data;
    try { data = JSON.parse(text); } catch (_error) { return; }
    if (data.type === 'speaking') markSpeaker(data.userId);
    if (data.type === 'voice_state') {
      const chat = state.chats.find((item) => item.id === data.chatId);
      if (chat) chat.voiceStates = data.states || [];
      renderSidebar();
      renderDetails();
    }
  }

  function handleVoiceBinaryMessage(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const idLength = bytes[0];
    if (!idLength || bytes.length <= idLength + 1) return;
    const userId = new TextDecoder().decode(bytes.slice(1, 1 + idLength));
    const pcm = bytes.slice(1 + idLength);
    markSpeaker(userId);
    playPcm(pcm);
  }

  function playPcm(pcmBytes) {
    const voice = state.voice;
    if (!voice?.ctx || !pcmBytes?.length) return;
    const int16 = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, Math.floor(pcmBytes.byteLength / 2));
    const audioBuffer = voice.ctx.createBuffer(1, int16.length, 48000);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < int16.length; i += 1) channel[i] = int16[i] / 32768;
    const source = voice.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(voice.ctx.destination);
    const startAt = Math.max(voice.ctx.currentTime + 0.025, voice.nextPlayTime || 0);
    source.start(startAt);
    voice.nextPlayTime = startAt + audioBuffer.duration;
  }

  function markSpeaker(userId) {
    const voice = state.voice;
    if (!voice) return;
    const wasActive = (voice.speakers.get(userId) || 0) > Date.now();
    voice.speakers.set(userId, Date.now() + 850);
    const chat = selectedChat();
    if (chat?.voiceStates) {
      for (const room of chat.voiceStates) {
        for (const user of room.users || []) {
          if (user.id === userId) user.speaking = true;
        }
      }
    }
    if (!wasActive) renderDetails();
    setTimeout(() => {
      const current = state.voice;
      if (!current) return;
      const until = current.speakers.get(userId) || 0;
      if (Date.now() >= until) {
        current.speakers.delete(userId);
        const currentChat = selectedChat();
        if (currentChat?.voiceStates) {
          for (const room of currentChat.voiceStates) {
            for (const user of room.users || []) if (user.id === userId) user.speaking = false;
          }
        }
        renderDetails();
      }
    }, 900);
  }

  function sendVoiceState() {
    const voice = state.voice;
    if (!voice?.ws || voice.ws.readyState !== WebSocket.OPEN) return;
    voice.ws.send(JSON.stringify({ type: 'state', muted: voice.muted, listener: voice.listener, sampleRate: Math.round(voice.ctx?.sampleRate || 48000) }));
  }

  async function toggleVoiceMute() {
    if (!state.voice) return;
    state.voice.muted = !state.voice.muted;
    sendVoiceState();
    renderVoiceControls();
  }

  async function toggleVoiceListener() {
    const voice = state.voice;
    if (!voice) return;
    voice.listener = !voice.listener;
    if (voice.listener) {
      stopCapture(voice);
    } else {
      try { await setupVoiceCapture(voice); }
      catch (_error) {
        voice.listener = true;
        toast('Не удалось включить микрофон', 'error');
      }
    }
    sendVoiceState();
    renderVoiceControls();
  }

  async function leaveVoice() {
    const voice = state.voice;
    if (!voice) return;
    try { voice.ws?.close(); } catch (_error) { /* noop */ }
    cleanupVoiceResources(voice);
    state.voice = null;
    renderVoiceControls();
    renderDetails();
  }

  function cleanupVoiceResources(voice) {
    stopCapture(voice);
    try { voice.ctx?.close?.(); } catch (_error) { /* noop */ }
  }

  function stopCapture(voice) {
    try { voice.worklet?.disconnect(); } catch (_error) { /* noop */ }
    try { voice.source?.disconnect(); } catch (_error) { /* noop */ }
    try { voice.zeroGain?.disconnect(); } catch (_error) { /* noop */ }
    if (voice.stream) voice.stream.getTracks().forEach((track) => track.stop());
    voice.stream = null;
    voice.source = null;
    voice.worklet = null;
    voice.zeroGain = null;
  }

  function renderVoiceControls() {
    const wrap = $('#voiceControls');
    if (!wrap) return;
    const voice = state.voice;
    wrap.classList.toggle('active', Boolean(voice));
    if (!voice) {
      wrap.innerHTML = '';
      return;
    }
    const chat = state.chats.find((item) => item.id === voice.chatId);
    const channel = chat?.voiceChannels?.find((item) => item.id === voice.channelId);
    wrap.innerHTML = `
      <strong>${iconHtml('volume')} ${escapeHtml(channel?.name || 'Голос')}</strong>
      <button class="secondary-btn" data-voice-mute>${iconHtml(voice.muted ? 'mic' : 'micOff')} ${voice.muted ? 'Включить' : 'Мьют'}</button>
      <button class="secondary-btn" data-voice-listener>${iconHtml(voice.listener ? 'mic' : 'headphones')} ${voice.listener ? 'Говорить' : 'Слушатель'}</button>
      <button class="danger-btn" data-voice-leave>Выйти</button>
    `;
    $('[data-voice-mute]', wrap)?.addEventListener('click', toggleVoiceMute);
    $('[data-voice-listener]', wrap)?.addEventListener('click', toggleVoiceListener);
    $('[data-voice-leave]', wrap)?.addEventListener('click', leaveVoice);
  }

  function isSuperAdmin() {
    return state.me?.role === 'superadmin' || state.me?.username === '@coffin';
  }

  function isGlobalAdmin() {
    return isSuperAdmin() || state.me?.role === 'admin';
  }

  async function logout(callApi = true) {
    if (callApi && state.token) {
      try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch (_error) { /* noop */ }
    }
    await leaveVoice();
    disconnectSse();
    stopPolling();
    localStorage.removeItem('pulselink_token');
    localStorage.removeItem('pulselink_selected_chat');
    state.token = '';
    state.me = null;
    resetUserScopedState(null);
    state.lastRenderedShell = false;
    renderAuth();
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeModal();
      if (state.sidebarOpen) toggleSidebar(false);
      if (state.detailsOpen) toggleDetails(false);
    }
  });

  init();
})();
