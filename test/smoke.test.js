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
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      PULSELINK_DATA_DIR: dataDir,
      PULSELINK_ADMIN_PASSWORD: 'test-admin-pass'
    },
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
    const aliceSaved = chats.chats.filter((chat) => chat.type === 'saved');
    assert.equal(aliceSaved.length, 1);
    assert.equal(aliceSaved[0].ownerId, alice.user.id);

    const bob = await json(await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: '@bob', nickname: 'Bob', email: 'bob@example.com', password: 'secret1' })
    }));
    const bobChats = await json(await fetch(`${baseUrl}/api/chats`, { headers: { authorization: `Bearer ${bob.token}` } }));
    const bobSaved = bobChats.chats.filter((chat) => chat.type === 'saved');
    assert.equal(bobSaved.length, 1);
    assert.equal(bobSaved[0].ownerId, bob.user.id);
    assert.notEqual(bobSaved[0].id, aliceSaved[0].id);
    assert.equal(bob.user.settings.diplomaticFilter, false);

    const direct = await json(await fetch(`${baseUrl}/api/chats/direct`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ username: '@bob' })
    }));

    const unfiltered = await json(await fetch(`${baseUrl}/api/chats/${direct.chat.id}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Ты ужасно всё сделал' })
    }));
    assert.equal(unfiltered.message.text, 'Ты ужасно всё сделал');
    assert.equal(unfiltered.message.is_diplomatic_rewrite, false);
    assert.equal(unfiltered.message.rewrite_style, null);

    const aliceSettings = await json(await fetch(`${baseUrl}/api/me`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { diplomaticFilter: true } })
    }));
    assert.equal(aliceSettings.user.settings.diplomaticFilter, true);

    const rewritten = await json(await fetch(`${baseUrl}/api/chats/${direct.chat.id}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Ты опять всё ужасно сделал' })
    }));
    assert.notEqual(rewritten.message.text, 'Ты опять всё ужасно сделал');
    assert.match(rewritten.message.text, /поразительно неудачно/u);
    assert.equal(rewritten.message.is_diplomatic_rewrite, true);
    assert.ok(['absurd', 'polite', 'cute', 'zen'].includes(rewritten.message.rewrite_style));

    const receivedByBob = await json(await fetch(`${baseUrl}/api/chats/${direct.chat.id}/messages`, {
      headers: { authorization: `Bearer ${bob.token}` }
    }));
    const bobCopy = receivedByBob.messages.find((message) => message.id === rewritten.message.id);
    assert.equal(bobCopy.text, rewritten.message.text);
    assert.equal(bobCopy.is_diplomatic_rewrite, true);

    await json(await fetch(`${baseUrl}/api/me`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { diplomaticFilter: false } })
    }));

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

    const file = await json(await fetch(`${baseUrl}/api/chats/${group.chat.id}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: 'note.txt', fileType: 'text/plain', fileSize: 5, fileDataUrl: 'data:text/plain;base64,aGVsbG8=' })
    }));
    assert.equal(file.message.kind, 'file');
    assert.equal(file.message.fileName, 'note.txt');

    const deleted = await json(await fetch(`${baseUrl}/api/chats/${group.chat.id}/messages/${sent.message.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${alice.token}` }
    }));
    assert.equal(deleted.ok, true);
    const afterDelete = await json(await fetch(`${baseUrl}/api/chats/${group.chat.id}/messages`, { headers: { authorization: `Bearer ${alice.token}` } }));
    assert.ok(!afterDelete.messages.some((message) => message.id === sent.message.id));
    assert.ok(afterDelete.messages.some((message) => message.id === file.message.id));

    const admin = await json(await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: '@coffin', password: 'test-admin-pass' })
    }));
    const adminChats = await json(await fetch(`${baseUrl}/api/chats`, { headers: { authorization: `Bearer ${admin.token}` } }));
    const adminSaved = adminChats.chats.filter((chat) => chat.type === 'saved');
    assert.equal(adminSaved.length, 1);
    assert.equal(adminSaved[0].ownerId, admin.user.id);
    assert.ok(!adminChats.chats.some((chat) => chat.id === aliceSaved[0].id || chat.id === bobSaved[0].id));

    const stats = await json(await fetch(`${baseUrl}/api/admin/stats`, { headers: { authorization: `Bearer ${admin.token}` } }));
    assert.ok(stats.stats.users >= 3);
    assert.ok(stats.stats.messages >= 1);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
