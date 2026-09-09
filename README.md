# Collaborative Canvas

A real-time, multi-user drawing canvas. Multiple people draw on the same
canvas at once, see each other's strokes as they're drawn (not after), see
each other's cursors, and share a single **global** undo/redo history.

Built with vanilla JavaScript + the HTML5 Canvas API on the client (no
frameworks, no drawing libraries) and Node.js + native WebSockets on the
server. No build step — the client runs as native ES modules directly in the
browser.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how it actually works
(protocol, undo/redo strategy, conflict resolution, performance decisions).

## Setup

Requires Node.js 18+.

```bash
npm install
npm start
```

Then open **http://localhost:3000**. That's it — no build step, no config.

`npm run dev` runs the same server with `node --watch` for auto-restart
while editing.

## Testing with multiple users

Open the same URL in two (or more) browser windows/tabs — including private/
incognito windows if you want to simulate fully separate sessions:

```
http://localhost:3000/
```

Draw in one window and watch the stroke appear in the other **while it's
still being drawn**, not just once you lift the pen. Each user gets an
assigned color and shows up in the "Online" panel on the right, with a
labeled cursor dot following their pointer.

**To test rooms**: append `?room=<any-name>` to the URL, or use the "Room"
box + Join button in the toolbar. Only users in the same room see each
other's drawing; rooms are fully isolated. Leave it blank / use `main` for
the default shared room.

**To set your name**: use the "Name" box in the toolbar (or `?name=` in the
URL) and hit Join. It's remembered in `localStorage` so you don't have to
re-enter it next time; leave it blank for a random `Guest-XXXX` name.

**To test global undo**: draw a stroke in window A, then click Undo in
window B. It removes window A's stroke — undo/redo is global across every
user in the room, not per-user (see ARCHITECTURE.md for why).

**Keyboard shortcuts**: `Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Shift+Z` redo, `Escape`
cancels the stroke you're currently mid-draw on.

## Features

- Brush + eraser tools, adjustable color and stroke size
- Choose your own display name (or get a random `Guest-XXXX`)
- Real-time sync of in-progress strokes (not just finished ones)
- Live cursor position + name/color for every connected user
- Global undo/redo shared across all users in a room
- Room system (`?room=` query param) — multiple isolated canvases
- Reconnect with exponential backoff on dropped connections
- Lightweight persistence — a room's drawing survives a server restart
- Mobile/touch support (Pointer Events — draw with a finger or stylus)
- FPS + latency HUD (bottom-right corner)

## Known limitations

- **Persistence is a single JSON file per room**, not a real database. Fine
  for a demo; would need to move to a real store (Postgres/Redis) at scale.
  See ARCHITECTURE.md's scaling section.
- **No authentication.** Users are anonymous guests with a random id/color,
  per the assignment spec (auth explicitly out of scope).
- **Op log grows unbounded** for a very long-lived room — there's no
  compaction. Not an issue for a demo session; would matter for a canvas
  left running for weeks.
- **Free-tier hosting cold start**: if deployed on a free Render/Railway
  instance, the first request after ~15 minutes of inactivity can take
  30-50 seconds while the instance wakes up. Refresh and it's instant after
  that.
- Room ids are sanitized to `[a-zA-Z0-9_-]`; anything else gets stripped.

## Time spent

Roughly one focused day: architecture/protocol design, server-side drawing
state + undo/redo logic, client canvas renderer + tool registry, WebSocket
wiring, multi-user testing, and documentation.
