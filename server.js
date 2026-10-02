#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.PULSELINK_DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 32 * 1024 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const ADMIN_USERNAME = '@coffin';
const DEFAULT_ADMIN_PASSWORD = process.env.PULSELINK_ADMIN_PASSWORD || 'PulseLink2026!';

fs.mkdirSync(DATA_DIR, { recursive: true });

function now() {
  return new Date().toISOString();
}

function timestamp() {
  return Date.now();
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function defaultSettings() {
  return {
    messageSound: true,
    notifications: false,
    sendMode: 'enter',
    compactMode: false,
    uiScale: 1
  };
}

function dropLegacyAppearanceSettings(settings) {
  for (const key of ['chat' + 'Background', 'custom' + 'Background']) delete settings[key];
  return settings;
}

function defaultDb() {
  return {
    version: 1,
    createdAt: now(),
    users: [],
    chats: [],
    messages: [],
    sessions: []
  };
}

let db = loadDb();
migrateDb();
ensureSuperAdmin();
ensureSavedChats();
writeDb();

function loadDb() {
  if (!fs.existsSync(DB_FILE)) return defaultDb();
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : defaultDb();
  } catch (error) {
    console.error('[PulseLink] Failed to read db.json, starting with an empty database:', error.message);
    return defaultDb();
  }
}

function migrateDb() {
  db.version = db.version || 1;
  db.createdAt = db.createdAt || now();
  db.users = Array.isArray(db.users) ? db.users : [];
  db.chats = Array.isArray(db.chats) ? db.chats : [];
  db.messages = Array.isArray(db.messages) ? db.messages : [];
  db.sessions = Array.isArray(db.sessions) ? db.sessions : [];

  for (const user of db.users) {
    user.id = user.id || newId('usr');
    user.username = normalizeUsername(user.username || user.nickname || 'user');
    user.usernameLower = user.username.toLowerCase();
    user.nickname = user.nickname || user.username.slice(1);
    user.email = user.email || `${user.username.slice(1)}@pulselink.local`;
    user.avatar = user.avatar || '';
    user.role = user.role || (user.usernameLower === ADMIN_USERNAME ? 'superadmin' : 'user');
    user.banned = Boolean(user.banned);
    user.createdAt = user.createdAt || now();
    user.lastSeen = user.lastSeen || now();
    user.settings = dropLegacyAppearanceSettings({ ...defaultSettings(), ...(user.settings || {}) });
    if (!Number.isFinite(Number(user.settings.uiScale))) user.settings.uiScale = 1;
    user.settings.uiScale = Math.max(0.85, Math.min(1.2, Number(user.settings.uiScale)));
    if (!user.password || !user.password.hash || !user.password.salt) {
      user.password = hashPassword(crypto.randomBytes(12).toString('hex'));
    }
  }

  for (const chat of db.chats) {
    chat.id = chat.id || newId('chat');
    chat.type = chat.type || 'group';
    chat.title = chat.title || 'PulseLink';
    chat.description = chat.description || '';
    chat.avatar = chat.avatar || '';
    chat.public = Boolean(chat.public);
    chat.participants = Array.isArray(chat.participants) ? [...new Set(chat.participants)] : [];
    chat.admins = Array.isArray(chat.admins) ? [...new Set(chat.admins)] : [];
    chat.ownerId = chat.ownerId || chat.participants[0] || null;
    chat.createdAt = chat.createdAt || now();
    chat.updatedAt = chat.updatedAt || chat.createdAt;
    chat.voiceChannels = Array.isArray(chat.voiceChannels) ? chat.voiceChannels : [];
    for (const vc of chat.voiceChannels) {
      vc.id = vc.id || newId('vc');
      vc.name = vc.name || 'Голосовой';
      vc.createdAt = vc.createdAt || now();
    }
  }

  for (const message of db.messages) {
    message.id = message.id || newId('msg');
    message.kind = message.kind || 'text';
    message.text = message.text || '';
    message.readBy = Array.isArray(message.readBy) ? [...new Set(message.readBy)] : [message.senderId].filter(Boolean);
    message.createdAt = message.createdAt || now();
  }

  db.sessions = db.sessions.filter((session) => session && session.token && findUserById(session.userId));
}

function writeDb() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { algorithm: 'scrypt', salt, hash };
}

function verifyPassword(password, saved) {
  if (!saved || saved.algorithm !== 'scrypt' || !saved.salt || !saved.hash) return false;
  const candidate = crypto.scryptSync(String(password), saved.salt, 64);
  const expected = Buffer.from(saved.hash, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

function normalizeUsername(username) {
  const raw = String(username || '').trim();
  const withAt = raw.startsWith('@') ? raw : `@${raw}`;
  return withAt.toLowerCase();
}

function validateUsername(username) {
  return /^@[a-z0-9_]{3,24}$/.test(username);
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function ensureSuperAdmin() {
  let admin = db.users.find((user) => user.usernameLower === ADMIN_USERNAME);
  if (!admin) {
    admin = {
      id: newId('usr'),
      username: ADMIN_USERNAME,
      usernameLower: ADMIN_USERNAME,
      nickname: 'Coffin',
      email: 'coffin@pulselink.local',
      password: hashPassword(DEFAULT_ADMIN_PASSWORD),
      avatar: '',
      role: 'superadmin',
      banned: false,
      createdAt: now(),
      lastSeen: now(),
      settings: defaultSettings()
    };
    db.users.push(admin);
    console.log(`[PulseLink] Created @coffin super admin. Default password: ${DEFAULT_ADMIN_PASSWORD}`);
  } else {
    admin.role = 'superadmin';
    admin.banned = false;
  }
}

function ensureSavedChats() {
  const validUserIds = new Set(db.users.map((user) => user.id));
  const savedByOwner = new Map();
  const removeChatIds = new Set();

  for (const chat of db.chats) {
    if (chat.type !== 'saved') continue;
    if (!chat.ownerId || !validUserIds.has(chat.ownerId)) {
      removeChatIds.add(chat.id);
      continue;
    }
    if (!savedByOwner.has(chat.ownerId)) savedByOwner.set(chat.ownerId, []);
    savedByOwner.get(chat.ownerId).push(chat);
  }

  for (const user of db.users) {
    const list = (savedByOwner.get(user.id) || [])
      .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

    if (!list.length) {
      ensureSavedChat(user.id);
      continue;
    }

    const primary = list[0];
    primary.type = 'saved';
    primary.title = 'Избранное';
    primary.description = 'Ваши личные заметки и голосовые сообщения';
    primary.public = false;
    primary.ownerId = user.id;
    primary.admins = [];
    primary.participants = [user.id];
    primary.voiceChannels = [];
    primary.updatedAt = primary.updatedAt || primary.createdAt || now();

    for (const duplicate of list.slice(1)) {
      for (const message of db.messages) {
        if (message.chatId === duplicate.id) message.chatId = primary.id;
      }
      removeChatIds.add(duplicate.id);
    }
  }

  if (removeChatIds.size) {
    db.chats = db.chats.filter((chat) => !removeChatIds.has(chat.id));
  }
}

function findUserById(id) {
  return db.users.find((user) => user.id === id) || null;
}

function findUserByUsername(username) {
  const normalized = normalizeUsername(username);
  return db.users.find((user) => user.usernameLower === normalized) || null;
}

function publicUser(user, viewer = null, includeEmail = false) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    email: includeEmail || (viewer && viewer.id === user.id) ? user.email : undefined,
    avatar: user.avatar || '',
    role: user.role,
    banned: Boolean(user.banned),
    online: isUserOnline(user.id),
    lastSeen: user.lastSeen,
    createdAt: user.createdAt,
    settings: viewer && viewer.id === user.id ? { ...defaultSettings(), ...(user.settings || {}) } : undefined
  };
}

function isSuperAdmin(user) {
  return Boolean(user && (user.role === 'superadmin' || user.usernameLower === ADMIN_USERNAME));
}

function isGlobalAdmin(user) {
  return Boolean(user && (user.role === 'admin' || isSuperAdmin(user)));
}

function isChatAdmin(chat, user) {
  if (!chat || !user) return false;
  return isSuperAdmin(user) || chat.ownerId === user.id || (chat.admins || []).includes(user.id);
}

function isChatOwner(chat, user) {
  return Boolean(chat && user && (isSuperAdmin(user) || chat.ownerId === user.id));
}

function canSeeChat(chat, user) {
  if (!chat || !user) return false;
  if (chat.type === 'saved') return chat.ownerId === user.id;
  if (chat.type === 'direct') return (chat.participants || []).includes(user.id);
  return (chat.participants || []).includes(user.id) || isSuperAdmin(user);
}

function canPostToChat(chat, user) {
  if (!canSeeChat(chat, user)) return false;
  if (chat.type === 'channel') return isChatAdmin(chat, user);
  return true;
}

function ensureSavedChat(userId) {
  let chat = db.chats.find((item) => item.type === 'saved' && item.ownerId === userId);
  if (!chat) {
    chat = {
      id: newId('chat'),
      type: 'saved',
      title: 'Избранное',
      description: 'Ваши личные заметки и голосовые сообщения',
      avatar: '',
      public: false,
      ownerId: userId,
      admins: [],
      participants: [userId],
      voiceChannels: [],
      createdAt: now(),
      updatedAt: now()
    };
    db.chats.push(chat);
  }
  return chat;
}

function ensureDirectChat(userA, userB) {
  const ids = [userA, userB].sort();
  let chat = db.chats.find((item) => item.type === 'direct'
    && item.participants.length === 2
    && item.participants.includes(ids[0])
    && item.participants.includes(ids[1]));
  if (!chat) {
    chat = {
      id: newId('chat'),
      type: 'direct',
      title: 'Личный чат',
      description: '',
      avatar: '',
      public: false,
      ownerId: null,
      admins: [],
      participants: ids,
      voiceChannels: [],
      createdAt: now(),
      updatedAt: now()
    };
    db.chats.push(chat);
  }
  return chat;
}

function chatMessages(chatId) {
  return db.messages.filter((message) => message.chatId === chatId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

function lastMessage(chatId) {
  const list = chatMessages(chatId);
  return list[list.length - 1] || null;
}

function unreadCount(chat, user) {
  return db.messages.filter((message) => message.chatId === chat.id
    && message.senderId !== user.id
    && !(message.readBy || []).includes(user.id)).length;
}

function chatTitleFor(chat, user) {
  if (chat.type === 'direct') {
    const otherId = chat.participants.find((id) => id !== user.id) || chat.participants[0];
    const other = findUserById(otherId);
    return other ? `${other.nickname} ${other.username}` : 'Личный чат';
  }
  return chat.title;
}

function roomKey(chatId, channelId) {
  return `${chatId}:${channelId}`;
}

function splitRoomKey(key) {
  const index = key.indexOf(':');
  if (index === -1) return { chatId: key, channelId: '' };
  return { chatId: key.slice(0, index), channelId: key.slice(index + 1) };
}

function voiceStatesForChat(chatId) {
  const states = [];
  for (const [roomId, clients] of voiceRooms.entries()) {
    const parsed = splitRoomKey(roomId);
    if (parsed.chatId !== chatId) continue;
    const users = [...clients.values()].map((client) => ({
      id: client.user.id,
      username: client.user.username,
      nickname: client.user.nickname,
      avatar: client.user.avatar || '',
      muted: Boolean(client.muted),
      listener: Boolean(client.listener),
      speaking: Date.now() - (client.lastSpeakingAt || 0) < 850
    }));
    states.push({ roomId, chatId: parsed.chatId, channelId: parsed.channelId, users });
  }
  return states;
}

function chatDto(chat, viewer, options = {}) {
  const includeMessages = Boolean(options.includeMessages);
  const members = (chat.participants || []).map((id) => publicUser(findUserById(id), viewer)).filter(Boolean);
  const owner = publicUser(findUserById(chat.ownerId), viewer);
  const last = lastMessage(chat.id);
  return {
    id: chat.id,
    type: chat.type,
    title: chatTitleFor(chat, viewer),
    rawTitle: chat.title,
    description: chat.description || '',
    avatar: chat.avatar || '',
    public: Boolean(chat.public),
    ownerId: chat.ownerId,
    owner,
    admins: chat.admins || [],
    participants: chat.participants || [],
    members,
    role: chat.ownerId === viewer.id ? 'owner' : (chat.admins || []).includes(viewer.id) ? 'admin' : isSuperAdmin(viewer) ? 'superadmin' : 'member',
    canPost: canPostToChat(chat, viewer),
    canAdmin: isChatAdmin(chat, viewer),
    voiceChannels: chat.voiceChannels || [],
    voiceStates: voiceStatesForChat(chat.id),
    unread: unreadCount(chat, viewer),
    lastMessage: last ? messageDto(last, viewer) : null,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    messages: includeMessages ? chatMessages(chat.id).map((message) => messageDto(message, viewer)) : undefined
  };
}

function messageDto(message, viewer) {
  const sender = findUserById(message.senderId);
  return {
    id: message.id,
    chatId: message.chatId,
    kind: message.kind,
    text: message.text || '',
    audioDataUrl: message.kind === 'voice' ? message.audioDataUrl : undefined,
    waveform: message.kind === 'voice' ? (message.waveform || []) : undefined,
    duration: message.kind === 'voice' ? Number(message.duration || 0) : undefined,
    sender: publicUser(sender, viewer),
    senderId: message.senderId,
    readBy: message.readBy || [],
    createdAt: message.createdAt,
    editedAt: message.editedAt || null,
    system: Boolean(message.system)
  };
}

function createMessage(chat, user, payload) {
  const message = {
    id: newId('msg'),
    chatId: chat.id,
    senderId: user.id,
    kind: payload.kind || 'text',
    text: payload.text || '',
    audioDataUrl: payload.audioDataUrl || '',
    waveform: Array.isArray(payload.waveform) ? payload.waveform.slice(0, 128).map((value) => Math.max(0, Math.min(1, Number(value) || 0))) : [],
    duration: Number(payload.duration || 0),
    readBy: [user.id],
    createdAt: now(),
    system: Boolean(payload.system)
  };
  db.messages.push(message);
  chat.updatedAt = message.createdAt;
  writeDb();
  broadcastToChat(chat, 'message', { chatId: chat.id, message: messageDto(message, user) });
  broadcastToChat(chat, 'chat_updated', { chat: null, chatId: chat.id });
  return message;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Тело запроса слишком большое'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_error) {
        reject(Object.assign(new Error('Некорректный JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function sendError(res, status, message, details = undefined) {
  sendJson(res, status, { error: message, details });
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `pl_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'pl_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function tokenFromRequest(req, parsedUrl = null) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const cookies = parseCookies(req.headers.cookie || '');
  if (cookies.pl_token) return cookies.pl_token;
  if (parsedUrl) return parsedUrl.searchParams.get('token') || '';
  return '';
}

function userFromToken(token) {
  if (!token) return null;
  const session = db.sessions.find((item) => item.token === token);
  if (!session) return null;
  const user = findUserById(session.userId);
  if (!user || user.banned) return null;
  session.lastSeen = now();
  user.lastSeen = now();
  return user;
}

function requireUser(req, res, parsedUrl = null) {
  const token = tokenFromRequest(req, parsedUrl);
  const user = userFromToken(token);
  if (!user) {
    sendError(res, 401, 'Нужна авторизация');
    return null;
  }
  req.token = token;
  return user;
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.sessions.push({ token, userId: user.id, createdAt: now(), lastSeen: now() });
  user.lastSeen = now();
  writeDb();
  return token;
}

function deleteSession(token) {
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((session) => session.token !== token);
  if (db.sessions.length !== before) writeDb();
}

function getRequestPath(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
}

function matches(pathname, pattern) {
  const pathParts = pathname.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);
  if (pathParts.length !== patternParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i];
    const actual = pathParts[i];
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

function cleanupSessions() {
  const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 45;
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((session) => new Date(session.createdAt).getTime() > cutoff);
  if (db.sessions.length !== before) writeDb();
}

const sseClients = new Map();
const voiceRooms = new Map();

function isUserOnline(userId) {
  if (sseClients.has(userId) && sseClients.get(userId).size > 0) return true;
  for (const room of voiceRooms.values()) {
    if (room.has(userId)) return true;
  }
  const user = findUserById(userId);
  if (!user || !user.lastSeen) return false;
  return Date.now() - new Date(user.lastSeen).getTime() < 45000;
}

function onlinePayload() {
  return db.users.map((user) => ({ id: user.id, online: isUserOnline(user.id), lastSeen: user.lastSeen }));
}

function writeSse(res, event, payload) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (_error) {
    // closed stream; cleanup happens on close
  }
}

function addSseClient(user, res) {
  if (!sseClients.has(user.id)) sseClients.set(user.id, new Set());
  sseClients.get(user.id).add(res);
  user.lastSeen = now();
  writeSse(res, 'ready', { user: publicUser(user, user), online: onlinePayload(), serverTime: now() });
  broadcastAll('presence', { users: onlinePayload() });
}

function removeSseClient(user, res) {
  const set = sseClients.get(user.id);
  if (set) {
    set.delete(res);
    if (!set.size) sseClients.delete(user.id);
  }
  user.lastSeen = now();
  setTimeout(() => broadcastAll('presence', { users: onlinePayload() }), 250);
}

function broadcastAll(event, payload) {
  for (const set of sseClients.values()) {
    for (const res of set) writeSse(res, event, payload);
  }
}

function broadcastToUsers(userIds, event, payload) {
  const unique = [...new Set(userIds)];
  for (const userId of unique) {
    const set = sseClients.get(userId);
    if (!set) continue;
    for (const res of set) writeSse(res, event, payload);
  }
}

function broadcastToChat(chat, event, payload) {
  broadcastToUsers(chat.participants || [], event, payload);
}

setInterval(() => {
  for (const set of sseClients.values()) {
    for (const res of set) writeSse(res, 'heartbeat', { serverTime: now() });
  }
}, 25000).unref();

setInterval(() => {
  cleanupSessions();
}, 1000 * 60 * 60).unref();

async function handleApi(req, res, parsedUrl) {
  const { pathname, searchParams } = parsedUrl;

  try {
    if (req.method === 'POST' && pathname === '/api/register') {
      const body = await readJsonBody(req);
      const username = normalizeUsername(body.username);
      const nickname = String(body.nickname || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!validateUsername(username)) return sendError(res, 400, 'Username должен быть уникальным @именем: 3-24 латинских символа, цифры или _');
      if (!nickname || nickname.length > 48) return sendError(res, 400, 'Укажите nickname до 48 символов');
      if (!validateEmail(email)) return sendError(res, 400, 'Укажите обязательную корректную почту');
      if (password.length < 6) return sendError(res, 400, 'Пароль должен быть не короче 6 символов');
      if (findUserByUsername(username)) return sendError(res, 409, 'Такой username уже занят');
      if (db.users.some((user) => user.email.toLowerCase() === email)) return sendError(res, 409, 'Эта почта уже используется');

      const user = {
        id: newId('usr'),
        username,
        usernameLower: username,
        nickname,
        email,
        password: hashPassword(password),
        avatar: '',
        role: username === ADMIN_USERNAME ? 'superadmin' : 'user',
        banned: false,
        createdAt: now(),
        lastSeen: now(),
        settings: defaultSettings()
      };
      db.users.push(user);
      ensureSavedChat(user.id);
      const token = createSession(user);
      setSessionCookie(res, token);
      broadcastAll('presence', { users: onlinePayload() });
      return sendJson(res, 201, { token, user: publicUser(user, user) });
    }

    if (req.method === 'POST' && pathname === '/api/login') {
      const body = await readJsonBody(req);
      const login = String(body.login || body.username || body.email || '').trim();
      const password = String(body.password || '');
      const user = login.includes('@') && !login.startsWith('@')
        ? db.users.find((item) => item.email.toLowerCase() === login.toLowerCase())
        : findUserByUsername(login);
      if (!user || !verifyPassword(password, user.password)) return sendError(res, 401, 'Неверный логин или пароль');
      if (user.banned) return sendError(res, 403, 'Аккаунт заблокирован');
      const token = createSession(user);
      setSessionCookie(res, token);
      return sendJson(res, 200, { token, user: publicUser(user, user) });
    }

    if (req.method === 'POST' && pathname === '/api/logout') {
      const token = tokenFromRequest(req, parsedUrl);
      if (token) deleteSession(token);
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      const user = userFromToken(tokenFromRequest(req, parsedUrl));
      if (!user) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Нужна авторизация');
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write(': PulseLink SSE connected\n\n');
      addSseClient(user, res);
      req.on('close', () => removeSseClient(user, res));
      return;
    }

    const user = requireUser(req, res, parsedUrl);
    if (!user) return;

    if (req.method === 'GET' && pathname === '/api/me') {
      return sendJson(res, 200, { user: publicUser(user, user), online: onlinePayload(), serverTime: now() });
    }

    if (req.method === 'PATCH' && pathname === '/api/me') {
      const body = await readJsonBody(req);
      if (typeof body.nickname === 'string') {
        const nickname = body.nickname.trim();
        if (!nickname || nickname.length > 48) return sendError(res, 400, 'Nickname должен быть от 1 до 48 символов');
        user.nickname = nickname;
      }
      if (typeof body.avatar === 'string') {
        if (body.avatar && !body.avatar.startsWith('data:image/')) return sendError(res, 400, 'Аватар должен быть dataURL изображением');
        if (body.avatar.length > 1024 * 1024) return sendError(res, 400, 'Аватар слишком большой');
        user.avatar = body.avatar;
      }
      if (body.settings && typeof body.settings === 'object') {
        const incoming = body.settings;
        user.settings = { ...defaultSettings(), ...(user.settings || {}) };
        if (typeof incoming.messageSound === 'boolean') user.settings.messageSound = incoming.messageSound;
        if (typeof incoming.notifications === 'boolean') user.settings.notifications = incoming.notifications;
        if (incoming.sendMode === 'enter' || incoming.sendMode === 'ctrlEnter') user.settings.sendMode = incoming.sendMode;
        if (typeof incoming.compactMode === 'boolean') user.settings.compactMode = incoming.compactMode;
        if (Number.isFinite(Number(incoming.uiScale))) {
          user.settings.uiScale = Math.max(0.85, Math.min(1.2, Number(incoming.uiScale)));
        }
        dropLegacyAppearanceSettings(user.settings);
      }
      user.lastSeen = now();
      writeDb();
      broadcastAll('presence', { users: onlinePayload() });
      broadcastAll('user_updated', { user: publicUser(user, null) });
      return sendJson(res, 200, { user: publicUser(user, user) });
    }

    if (req.method === 'GET' && pathname === '/api/chats') {
      ensureSavedChat(user.id);
      const chats = db.chats
        .filter((chat) => canSeeChat(chat, user))
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
        .map((chat) => chatDto(chat, user));
      return sendJson(res, 200, { chats });
    }

    if (req.method === 'POST' && pathname === '/api/chats/direct') {
      const body = await readJsonBody(req);
      const peer = findUserByUsername(body.username);
      if (!peer) return sendError(res, 404, 'Пользователь не найден');
      if (peer.banned) return sendError(res, 403, 'Пользователь заблокирован');
      if (peer.id === user.id) return sendJson(res, 200, { chat: chatDto(ensureSavedChat(user.id), user) });
      const chat = ensureDirectChat(user.id, peer.id);
      chat.updatedAt = now();
      writeDb();
      broadcastToChat(chat, 'chat_updated', { chat: chatDto(chat, user), chatId: chat.id });
      return sendJson(res, 201, { chat: chatDto(chat, user) });
    }

    if (req.method === 'POST' && pathname === '/api/chats') {
      const body = await readJsonBody(req);
      const type = body.type === 'channel' ? 'channel' : 'group';
      const title = String(body.title || '').trim();
      const description = String(body.description || '').trim();
      if (!title || title.length > 80) return sendError(res, 400, 'Название должно быть от 1 до 80 символов');
      const avatar = typeof body.avatar === 'string' && body.avatar.startsWith('data:image/') && body.avatar.length < 1024 * 1024 ? body.avatar : '';
      const chat = {
        id: newId('chat'),
        type,
        title,
        description: description.slice(0, 280),
        avatar,
        public: Boolean(body.public),
        ownerId: user.id,
        admins: [],
        participants: [user.id],
        voiceChannels: type === 'group' ? [{ id: newId('vc'), name: 'Лобби', createdAt: now() }] : [],
        createdAt: now(),
        updatedAt: now()
      };
      db.chats.push(chat);
      writeDb();
      broadcastToChat(chat, 'chat_updated', { chat: chatDto(chat, user), chatId: chat.id });
      return sendJson(res, 201, { chat: chatDto(chat, user) });
    }

    if (req.method === 'GET' && pathname === '/api/discover') {
      const query = String(searchParams.get('q') || '').trim().toLowerCase();
      const chats = db.chats
        .filter((chat) => (chat.type === 'group' || chat.type === 'channel') && chat.public)
        .filter((chat) => !query || chat.title.toLowerCase().includes(query) || (chat.description || '').toLowerCase().includes(query))
        .sort((a, b) => (b.participants.length - a.participants.length) || new Date(b.updatedAt) - new Date(a.updatedAt))
        .slice(0, 50)
        .map((chat) => ({ ...chatDto(chat, user), joined: chat.participants.includes(user.id) }));
      return sendJson(res, 200, { chats });
    }

    if (req.method === 'GET' && pathname === '/api/poll') {
      const selected = searchParams.get('chatId');
      const payload = {
        serverTime: now(),
        online: onlinePayload(),
        chats: db.chats.filter((chat) => canSeeChat(chat, user)).map((chat) => chatDto(chat, user))
      };
      if (selected) {
        const chat = db.chats.find((item) => item.id === selected);
        if (chat && canSeeChat(chat, user)) payload.messages = chatMessages(chat.id).map((message) => messageDto(message, user));
      }
      return sendJson(res, 200, payload);
    }

    let params;

    params = matches(pathname, '/api/chats/:chatId');
    if (params && req.method === 'PATCH') {
      const chat = db.chats.find((item) => item.id === params.chatId);
      if (!chat || !canSeeChat(chat, user)) return sendError(res, 404, 'Чат не найден');
      if (!isChatAdmin(chat, user)) return sendError(res, 403, 'Недостаточно прав');
      const body = await readJsonBody(req);
      if (typeof body.title === 'string') {
        const title = body.title.trim();
        if (!title || title.length > 80) return sendError(res, 400, 'Название должно быть от 1 до 80 символов');
        chat.title = title;
      }
      if (typeof body.description === 'string') chat.description = body.description.trim().slice(0, 280);
      if (typeof body.public === 'boolean') chat.public = body.public;
      if (typeof body.avatar === 'string') {
        if (body.avatar && !body.avatar.startsWith('data:image/')) return sendError(res, 400, 'Аватар должен быть dataURL изображением');
        if (body.avatar.length > 1024 * 1024) return sendError(res, 400, 'Аватар слишком большой');
        chat.avatar = body.avatar;
      }
      chat.updatedAt = now();
      writeDb();
      broadcastToChat(chat, 'chat_updated', { chat: chatDto(chat, user), chatId: chat.id });
      return sendJson(res, 200, { chat: chatDto(chat, user) });
    }

    if (params && req.method === 'DELETE') {
      const chat = db.chats.find((item) => item.id === params.chatId);
      if (!chat || !canSeeChat(chat, user)) return sendError(res, 404, 'Чат не найден');
      if (!isChatOwner(chat, user) && !isGlobalAdmin(user)) return sendError(res, 403, 'Недостаточно прав');
      deleteChat(chat.id);
      return sendJson(res, 200, { ok: true });
    }

    params = matches(pathname, '/api/chats/:chatId/messages');
    if (params && req.method === 'GET') {
      const chat = db.chats.find((item) => item.id === params.chatId);
      if (!chat || !canSeeChat(chat, user)) return sendError(res, 404, 'Чат не найден');
      const limit = Math.max(1, Math.min(200, Number(searchParams.get('limit') || 100)));
      const messages = chatMessages(chat.id).slice(-limit).map((message) => messageDto(message, user));
      return sendJson(res, 200, { messages, chat: chatDto(chat, user) });
    }

    if (params && req.method === 'POST') {
      const chat = db.chats.find((item) => item.id === params.chatId);
      if (!chat || !canSeeChat(chat, user)) return sendError(res, 404, 'Чат не найден');
      if (!canPostToChat(chat, user)) return sendError(res, 403, 'В этом канале публикуют только администраторы');
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim();
      if (!text) return sendError(res, 400, 'Сообщение пустое');
      if (text.length > 4000) return sendError(res, 400, 'Сообщение слишком длинное');
      const message = createMessage(chat, user, { kind: 'text', text });
      return sendJson(res, 201, { message: messageDto(message, user) });
    }

    params = matches(pathname, '/api/chats/:chatId/voice-messages');
    if (params && req.method === 'POST') {
      const chat = db.chats.find((item) => item.id === params.chatId);
      if (!chat || !canSeeChat(chat, user)) return sendError(res, 404, 'Чат не найден');
      if (!canPostToChat(chat, user)) return sendError(res, 403, 'В этом канале публикуют только администраторы');
      const body = await readJsonBody(req);
      const audioDataUrl = String(body.audioDataUrl || '');
      if (!audioDataUrl.startsWith('data:audio/')) return sendError(res, 400, 'Нужно audio dataURL');
      if (audioDataUrl.length > 20 * 1024 * 1024) return sendError(res, 400, 'Голосовое сообщение слишком большое');
      const waveform = Array.isArray(body.waveform) ? body.waveform : [];
      const message = createMessage(chat, user, {
        kind: 'voice',
        audioDataUrl,
        waveform,
        duration: Number(body.duration || 0)
      });
      return sendJson(res, 201, { message: messageDto(message, user) });
    }

    params = matches(pathname, '/api/chats/:chatId/read');
    if (params && req.method === 'POST') {
      const chat = db.chats.find((item) => item.id === params.chatId);
      if (!chat || !canSeeChat(chat, user)) return sendError(res, 404, 'Чат не найден');
      let changed = false;
      for (const message of db.messages) {
        if (message.chatId !== chat.id) continue;
        message.readBy = Array.isArray(message.readBy) ? message.readBy : [];
        if (!message.readBy.includes(user.id)) {
          message.readBy.push(user.id);
          changed = true;
        }
      }
      if (changed) writeDb();
      broadcastToChat(chat, 'read', { chatId: chat.id, userId: user.id, messageIds: chatMessages(chat.id).map((message) => message.id) });
      return sendJson(res, 200, { ok: true });
    }

    params = matches(pathname, '/api/chats/:chatId/join');
    if (params && req.method === 'POST') {
      const chat = db.chats.find((item) => item.id === params.chatId);
      if (!chat || !(chat.type === 'group' || chat.type === 'channel')) return sendError(res, 404, 'Сообщество не найдено');
      if (!chat.public && !isChatAdmin(chat, user)) return sendError(res, 403, 'Это приватное сообщество');
      if (!chat.participants.includes(user.id)) chat.participants.push(user.id);
      chat.updatedAt = now();
      writeDb();
      broadcastToChat(chat, 'chat_updated', { chat: chatDto(chat, user), chatId: chat.id });
      return sendJson(res, 200, { chat: chatDto(chat, user) });
    }

    params = matches(pathname, '/api/chats/:chatId/leave');
    if (params && req.method === 'POST') {
      const chat = db.chats.find((item) => item.id === params.chatId);
      if (!chat || !canSeeChat(chat, user)) return sendError(res, 404, 'Чат не найден');
      if (!['group', 'channel'].includes(chat.type)) return sendError(res, 400, 'Из этого чата нельзя выйти');
      chat.participants = chat.participants.filter((id) => id !== user.id);
      chat.admins = chat.admins.filter((id) => id !== user.id);
      if (chat.ownerId === user.id) {
        const nextOwner = chat.admins.find((id) => chat.participants.includes(id)) || chat.participants[0] || null;
        chat.ownerId = nextOwner;
        if (nextOwner) chat.admins = chat.admins.filter((id) => id !== nextOwner);
      }
      if (!chat.participants.length) {
        deleteChat(chat.id);
        return sendJson(res, 200, { ok: true, deleted: true });
      }
      chat.updatedAt = now();
      writeDb();
      broadcastToChat(chat, 'chat_updated', { chat: chatDto(chat, findUserById(chat.ownerId) || user), chatId: chat.id });
      return sendJson(res, 200, { ok: true });
    }

    params = matches(pathname, '/api/chats/:chatId/members');
    if (params && req.method === 'POST') {
      const chat = db.chats.find((item) => item.id === params.chatId);
      if (!chat || !canSeeChat(chat, user)) return sendError(res, 404, 'Чат не найден');
      if (!isChatAdmin(chat, user)) return sendError(res, 403, 'Недостаточно прав');
      const body = await readJsonBody(req);
      const peer = findUserByUsername(body.username);
      if (!peer) return sendError(res, 404, 'Пользователь не найден');
      if (peer.banned) return sendError(res, 403, 'Пользователь заблокирован');
      if (!chat.participants.includes(peer.id)) chat.participants.push(peer.id);
      chat.updatedAt = now();
      writeDb();
      broadcastToChat(chat, 'chat_updated', { chat: chatDto(chat, user), chatId: chat.id });
      return sendJson(res, 200, { chat: chatDto(chat, user) });
    }

    params = matches(pathname, '/api/chats/:chatId/members/:memberId');
    if (params && req.method === 'DELETE') {
      const chat = db.chats.find((item) => item.id === params.chatId);
      if (!chat || !canSeeChat(chat, user)) return sendError(res, 404, 'Чат не найден');
      if (!isChatAdmin(chat, user)) return sendError(res, 403, 'Недостаточно прав');
      if (params.memberId === chat.ownerId && !isSuperAdmin(user)) return sendError(res, 400, 'Нельзя удалить владельца');
      chat.participants = chat.participants.filter((id) => id !== params.memberId);
      chat.admins = chat.admins.filter((id) => id !== params.memberId);
      chat.updatedAt = now();
      writeDb();
      broadcastToChat(chat, 'chat_updated', { chat: chatDto(chat, user), chatId: chat.id });
      return sendJson(res, 200, { chat: chatDto(chat, user) });
    }

    if (params && req.method === 'PATCH') {
      const chat = db.chats.find((item) => item.id === params.chatId);
      if (!chat || !canSeeChat(chat, user)) return sendError(res, 404, 'Чат не найден');
      if (!isChatOwner(chat, user)) return sendError(res, 403, 'Только владелец управляет ролями');
      if (!chat.participants.includes(params.memberId)) return sendError(res, 404, 'Участник не найден');
      const body = await readJsonBody(req);
      if (body.role === 'admin') {
        if (!chat.admins.includes(params.memberId) && params.memberId !== chat.ownerId) chat.admins.push(params.memberId);
      } else if (body.role === 'member') {
        chat.admins = chat.admins.filter((id) => id !== params.memberId);
      } else if (body.role === 'owner') {
        if (params.memberId === chat.ownerId) return sendJson(res, 200, { chat: chatDto(chat, user) });
        chat.admins = [...new Set([...chat.admins, chat.ownerId])].filter(Boolean);
        chat.ownerId = params.memberId;
        chat.admins = chat.admins.filter((id) => id !== params.memberId);
      } else {
        return sendError(res, 400, 'Неизвестная роль');
      }
      chat.updatedAt = now();
      writeDb();
      broadcastToChat(chat, 'chat_updated', { chat: chatDto(chat, user), chatId: chat.id });
      return sendJson(res, 200, { chat: chatDto(chat, user) });
    }

    params = matches(pathname, '/api/chats/:chatId/voice-channels');
    if (params && req.method === 'POST') {
      const chat = db.chats.find((item) => item.id === params.chatId);
      if (!chat || !canSeeChat(chat, user)) return sendError(res, 404, 'Чат не найден');
      if (!isChatAdmin(chat, user)) return sendError(res, 403, 'Недостаточно прав');
      if (chat.type !== 'group') return sendError(res, 400, 'Голосовые каналы доступны в группах');
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      if (!name || name.length > 48) return sendError(res, 400, 'Название голосового канала должно быть от 1 до 48 символов');
      chat.voiceChannels.push({ id: newId('vc'), name, createdAt: now() });
      chat.updatedAt = now();
      writeDb();
      broadcastToChat(chat, 'chat_updated', { chat: chatDto(chat, user), chatId: chat.id });
      return sendJson(res, 201, { chat: chatDto(chat, user) });
    }

    params = matches(pathname, '/api/admin/stats');
    if (params && req.method === 'GET') {
      if (!isGlobalAdmin(user)) return sendError(res, 403, 'Нужны права администратора');
      const stats = {
        users: db.users.length,
        banned: db.users.filter((item) => item.banned).length,
        online: db.users.filter((item) => isUserOnline(item.id)).length,
        chats: db.chats.length,
        directChats: db.chats.filter((item) => item.type === 'direct').length,
        groups: db.chats.filter((item) => item.type === 'group').length,
        channels: db.chats.filter((item) => item.type === 'channel').length,
        messages: db.messages.length,
        voiceMessages: db.messages.filter((item) => item.kind === 'voice').length,
        sessions: db.sessions.length,
        startedAt: db.createdAt
      };
      return sendJson(res, 200, { stats });
    }

    params = matches(pathname, '/api/admin/users');
    if (params && req.method === 'GET') {
      if (!isGlobalAdmin(user)) return sendError(res, 403, 'Нужны права администратора');
      const users = db.users.map((item) => publicUser(item, user, true));
      return sendJson(res, 200, { users });
    }

    params = matches(pathname, '/api/admin/users/:userId');
    if (params && req.method === 'PATCH') {
      if (!isGlobalAdmin(user)) return sendError(res, 403, 'Нужны права администратора');
      const target = findUserById(params.userId);
      if (!target) return sendError(res, 404, 'Пользователь не найден');
      if (target.usernameLower === ADMIN_USERNAME && !isSuperAdmin(user)) return sendError(res, 403, 'Главного администратора менять нельзя');
      const body = await readJsonBody(req);
      if (typeof body.banned === 'boolean') target.banned = body.banned;
      if (body.role) {
        if (!isSuperAdmin(user)) return sendError(res, 403, 'Только @coffin выдает глобальные права');
        if (!['user', 'admin', 'superadmin'].includes(body.role)) return sendError(res, 400, 'Неизвестная роль');
        target.role = target.usernameLower === ADMIN_USERNAME ? 'superadmin' : body.role;
      }
      target.lastSeen = target.lastSeen || now();
      writeDb();
      broadcastAll('user_updated', { user: publicUser(target, null) });
      return sendJson(res, 200, { user: publicUser(target, user, true) });
    }

    params = matches(pathname, '/api/admin/chats/:chatId');
    if (params && req.method === 'DELETE') {
      if (!isGlobalAdmin(user)) return sendError(res, 403, 'Нужны права администратора');
      const chat = db.chats.find((item) => item.id === params.chatId);
      if (!chat) return sendError(res, 404, 'Чат не найден');
      deleteChat(chat.id);
      return sendJson(res, 200, { ok: true });
    }

    params = matches(pathname, '/api/admin/announcement');
    if (params && req.method === 'POST') {
      if (!isGlobalAdmin(user)) return sendError(res, 403, 'Нужны права администратора');
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim();
      if (!text) return sendError(res, 400, 'Текст объявления пустой');
      const news = ensureNewsChannel(user);
      const message = createMessage(news, user, { kind: 'text', text: `🛡 ${text}` });
      return sendJson(res, 201, { chat: chatDto(news, user), message: messageDto(message, user) });
    }

    sendError(res, 404, 'Маршрут не найден');
  } catch (error) {
    if (error && error.status) return sendError(res, error.status, error.message);
    console.error('[PulseLink] API error:', error);
    sendError(res, 500, 'Внутренняя ошибка сервера');
  }
}

function ensureNewsChannel(user) {
  let chat = db.chats.find((item) => item.type === 'channel' && item.title === 'PulseLink News');
  if (!chat) {
    chat = {
      id: newId('chat'),
      type: 'channel',
      title: 'PulseLink News',
      description: 'Официальные объявления PulseLink',
      avatar: '',
      public: true,
      ownerId: user.id,
      admins: [],
      participants: db.users.map((item) => item.id),
      voiceChannels: [],
      createdAt: now(),
      updatedAt: now()
    };
    db.chats.push(chat);
  } else {
    for (const item of db.users) {
      if (!chat.participants.includes(item.id)) chat.participants.push(item.id);
    }
  }
  writeDb();
  return chat;
}

function deleteChat(chatId) {
  const chat = db.chats.find((item) => item.id === chatId);
  const participants = chat ? [...chat.participants] : [];
  db.chats = db.chats.filter((item) => item.id !== chatId);
  db.messages = db.messages.filter((item) => item.chatId !== chatId);
  for (const key of [...voiceRooms.keys()]) {
    if (splitRoomKey(key).chatId === chatId) {
      const room = voiceRooms.get(key);
      for (const client of room.values()) {
        try { client.socket.end(); } catch (_error) { /* noop */ }
      }
      voiceRooms.delete(key);
    }
  }
  writeDb();
  broadcastToUsers(participants, 'chat_deleted', { chatId });
}

function serveStatic(req, res, parsedUrl) {
  let pathname = decodeURIComponent(parsedUrl.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      const fallback = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(fallback, (readErr, data) => {
        if (readErr) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(data);
      });
      return;
    }
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(500);
        return res.end('Read error');
      }
      res.writeHead(200, {
        'Content-Type': contentType(filePath),
        'Cache-Control': filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=3600'
      });
      res.end(data);
    });
  });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon'
  }[ext] || 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  const parsedUrl = getRequestPath(req);
  if (parsedUrl.pathname.startsWith('/api/')) return handleApi(req, res, parsedUrl);
  return serveStatic(req, res, parsedUrl);
});

server.on('upgrade', (req, socket, head) => {
  const parsedUrl = getRequestPath(req);
  if (parsedUrl.pathname !== '/voice') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  handleVoiceUpgrade(req, socket, head, parsedUrl);
});

function handleVoiceUpgrade(req, socket, head, parsedUrl) {
  const token = tokenFromRequest(req, parsedUrl);
  const user = userFromToken(token);
  const chatId = parsedUrl.searchParams.get('chatId') || '';
  const channelId = parsedUrl.searchParams.get('channelId') || '';
  const listener = parsedUrl.searchParams.get('listener') === '1';
  const chat = db.chats.find((item) => item.id === chatId);
  const channel = chat && (chat.voiceChannels || []).find((item) => item.id === channelId);
  if (!user || !chat || !channel || !canSeeChat(chat, user)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n'
  ].join('\r\n'));

  const roomId = roomKey(chatId, channelId);
  if (!voiceRooms.has(roomId)) voiceRooms.set(roomId, new Map());
  const room = voiceRooms.get(roomId);
  const existing = room.get(user.id);
  if (existing) {
    try { sendWs(existing.socket, 8, Buffer.from([0x03, 0xe8])); existing.socket.end(); } catch (_error) { /* noop */ }
  }

  const client = {
    socket,
    user,
    chat,
    channel,
    roomId,
    muted: false,
    listener,
    buffer: head && head.length ? Buffer.from(head) : Buffer.alloc(0),
    lastSpeakingAt: 0,
    lastWsSpeakingAt: 0,
    lastSseSpeakingAt: 0,
    sampleRate: 48000
  };
  room.set(user.id, client);
  sendWsJson(socket, { type: 'hello', roomId, userId: user.id, sampleRate: client.sampleRate });
  broadcastVoiceState(roomId);

  socket.on('data', (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    parseWsFrames(client);
  });
  if (client.buffer.length) parseWsFrames(client);
  socket.on('close', () => cleanupVoiceClient(client));
  socket.on('end', () => cleanupVoiceClient(client));
  socket.on('error', () => cleanupVoiceClient(client));
}

function cleanupVoiceClient(client) {
  const room = voiceRooms.get(client.roomId);
  if (room && room.get(client.user.id) === client) {
    room.delete(client.user.id);
    if (!room.size) voiceRooms.delete(client.roomId);
    broadcastVoiceState(client.roomId);
  }
}

function parseWsFrames(client) {
  let offset = 0;
  const buffer = client.buffer;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength += 2;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(8 * 1024 * 1024)) {
        client.socket.destroy();
        return;
      }
      length = Number(bigLength);
      headerLength += 8;
    }

    const maskLength = masked ? 4 : 0;
    const frameEnd = offset + headerLength + maskLength + length;
    if (buffer.length < frameEnd) break;

    let payload = Buffer.from(buffer.slice(offset + headerLength + maskLength, frameEnd));
    if (masked) {
      const mask = buffer.slice(offset + headerLength, offset + headerLength + 4);
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }

    if (opcode === 0x8) {
      cleanupVoiceClient(client);
      try { client.socket.end(); } catch (_error) { /* noop */ }
      offset = frameEnd;
      break;
    } else if (opcode === 0x9) {
      sendWs(client.socket, 0xA, payload);
    } else if (opcode === 0x1) {
      handleVoiceText(client, payload.toString('utf8'));
    } else if (opcode === 0x2) {
      handleVoiceBinary(client, payload);
    }

    offset = frameEnd;
  }
  client.buffer = buffer.slice(offset);
}

function handleVoiceText(client, text) {
  let data;
  try { data = JSON.parse(text); } catch (_error) { return; }
  if (data.type === 'state') {
    client.muted = Boolean(data.muted);
    client.listener = Boolean(data.listener);
    if (Number(data.sampleRate)) client.sampleRate = Math.max(8000, Math.min(96000, Number(data.sampleRate)));
    broadcastVoiceState(client.roomId);
  }
}

function handleVoiceBinary(client, payload) {
  if (!payload.length || client.muted || client.listener) return;
  if (payload.length > 8192) return;
  const room = voiceRooms.get(client.roomId);
  if (!room) return;
  client.lastSpeakingAt = Date.now();
  const sender = Buffer.from(client.user.id, 'utf8');
  if (sender.length > 255) return;
  const frame = Buffer.concat([Buffer.from([sender.length]), sender, payload]);
  for (const [userId, peer] of room.entries()) {
    if (userId === client.user.id) continue;
    sendWs(peer.socket, 0x2, frame);
  }
  if (Date.now() - client.lastWsSpeakingAt > 180) {
    client.lastWsSpeakingAt = Date.now();
    sendWsJsonToRoom(client.roomId, { type: 'speaking', userId: client.user.id, at: timestamp() });
  }
  if (Date.now() - client.lastSseSpeakingAt > 650) {
    client.lastSseSpeakingAt = Date.now();
    broadcastVoiceState(client.roomId);
  }
}

function sendWsJsonToRoom(roomId, payload) {
  const room = voiceRooms.get(roomId);
  if (!room) return;
  for (const peer of room.values()) sendWsJson(peer.socket, payload);
}

function broadcastVoiceState(roomId) {
  const { chatId } = splitRoomKey(roomId);
  const chat = db.chats.find((item) => item.id === chatId);
  if (!chat) return;
  const payload = { chatId, states: voiceStatesForChat(chatId) };
  broadcastToChat(chat, 'voice_state', payload);
  sendWsJsonToRoom(roomId, { type: 'voice_state', ...payload });
  broadcastAll('presence', { users: onlinePayload() });
}

function sendWsJson(socket, data) {
  sendWs(socket, 0x1, Buffer.from(JSON.stringify(data), 'utf8'));
}

function sendWs(socket, opcode, payload) {
  if (!socket || socket.destroyed) return;
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  try { socket.write(Buffer.concat([header, payload])); } catch (_error) { /* noop */ }
}

server.listen(PORT, HOST, () => {
  console.log(`[PulseLink] listening on http://${HOST}:${PORT}`);
  console.log(`[PulseLink] @coffin password: ${DEFAULT_ADMIN_PASSWORD}`);
});

module.exports = { server, db, hashPassword, verifyPassword };
