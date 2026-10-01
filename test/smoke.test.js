const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 5000) {
    assert.equal(child.exitCode, null, 'server exited early');
    try {
      const response = await fetch(`${baseUrl}/api/login`, { method: 'POST', body: '{}' });
      if (response.status === 401) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error('server did not start');
}

async function json(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}

test('PulseLink API smoke flow', async () => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulselink-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PULSELINK_DATA_DIR: dataDir, PULSELINK_ADMIN_PASSWORD: 'test-admin-pass' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(baseUrl, child);

    const alice = await json(await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '@alice', nickname: 'Alice', email: 'alice@example.com', password: 'secret1' })
    }));
    assert.equal(alice.user.username, '@alice');
    assert.ok(alice.token);

    const chats = await json(await fetch(`${baseUrl}/api/chats`, { headers: { authorization: `Bearer ${alice.token}` } }));
    assert.ok(chats.chats.some((chat) => chat.type === 'saved'));

    const group = await json(await fetch(`${baseUrl}/api/chats`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'group', title: 'QA', public: true })
    }));
    assert.equal(group.chat.type, 'group');
    assert.equal(group.chat.voiceChannels.length, 1);

    const sent = await json(await fetch(`${baseUrl}/api/chats/${group.chat.id}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello pulse' })
    }));
    assert.equal(sent.message.text, 'hello pulse');

    const admin = await json(await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: '@coffin', password: 'test-admin-pass' })
    }));
    const stats = await json(await fetch(`${baseUrl}/api/admin/stats`, { headers: { authorization: `Bearer ${admin.token}` } }));
    assert.ok(stats.stats.users >= 2);
    assert.ok(stats.stats.messages >= 1);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
