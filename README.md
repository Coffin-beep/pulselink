# PulseLink

PulseLink — dependency-free Node.js prototype of a modern messenger.

## Implemented

- Registration by unique `@username`, nickname, mandatory email and password stored as a Node `crypto.scrypt` hash.
- Personal chats, saved messages (`Избранное`), groups and admin-only publishing channels.
- Message read statuses `✓✓`, online presence and instant updates over Server-Sent Events with polling fallback.
- Voice messages: microphone recording, automatic waveform generation and a built-in seekable waveform player.
- Discord-like group voice channels: browser `AudioWorklet` captures PCM frames, a custom RFC 6455 WebSocket relay in `server.js` broadcasts audio through the server, plus mute/listener modes and active-speaker highlighting.
- Public community discovery and one-click join.
- Avatars for users/groups/channels: client-side square crop/compression and dataURL storage.
- Settings: message sound, system notifications, Enter/Ctrl+Enter sending, compact mode and chat background.
- Member management: add/remove, owner/admin roles and ownership transfer on leave.
- Admin panel for `@coffin`: stats, ban/unban, global role grants, chat deletion and announcements to `PulseLink News`.
- Responsive layout for mobile and desktop.

## Run

```bash
npm start
# or
HOST=0.0.0.0 PORT=3000 npm run dev
```

Open `http://localhost:3000`.

On first start the server seeds the super-admin account:

- username: `@coffin`
- password: `PulseLink2026!`

Override the default password with `PULSELINK_ADMIN_PASSWORD` before first start.

Runtime data is stored in `data/db.json` and is ignored by Git.

## Scripts

```bash
npm test        # Node test runner / syntax smoke
node --check server.js
```

## Notes

The voice-channel relay intentionally uses only Node built-ins: it performs the WebSocket handshake and frame parsing/writing directly without external dependencies.
