# Collide

A real-time multiplayer territory game for 2–8 players. Everyone plays from their own phone or laptop by entering a 4-letter room code. Nobody logs in or installs anything.

## How to play

1. Every round, everyone secretly taps one empty cell at the same time. You have 15 seconds.
2. If you were the **only one** to pick that cell, it becomes yours.
3. If **two or more** players pick the same cell, it **cracks**, and nobody can ever take it.
4. Your first pick can be anywhere. After that you must pick a cell **touching your land** (up, down, left or right). The cells you can pick glow. If you're boxed in, you can pick anywhere.
5. When the board is full, the player with the **most cells wins**. Ties go to whoever has the biggest connected area.

The fun is in reading the other players. Do you grab the cell everyone wants and risk a crack, or take the safe one and fall behind?

## Features

- Room codes and invite links (`/?room=ABCD`). The host starts the game, and "Play again" keeps the group together.
- Everyone's screen stays in sync over Socket.IO. Picks stay hidden until the reveal, but you can see who has locked in.
- Refreshing or briefly dropping the connection keeps your seat. The host keeps their role through a refresh, and another player stands in while the host is offline.
- The board grows with the group: 6×6 for 2 players, up to 9×9 for 8.
- Mobile-first layout with touch targets sized for phones. Respects reduced-motion settings.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000 in two browser tabs (each tab is its own player), or on two devices on the same Wi-Fi via `http://<your-computer-ip>:3000`.

```bash
npm test
```

This runs the rules tests and an end-to-end test where two simulated players create a room, collide, claim cells, refresh mid-game, and play to the end.

## Put it online (free, on Render)

1. Push this folder to a GitHub repository.
2. On [render.com](https://render.com), choose **New → Blueprint** and pick the repo. `render.yaml` sets everything up.
3. Share the `https://collide-game-xxxx.onrender.com` URL.

Free Render services sleep after 15 minutes without traffic, so the first visit after that takes about 30–50 seconds to wake up. Rooms live in memory, so a restart or redeploy ends games in progress.

Any Node host that supports WebSockets works (Railway, Fly.io, a VPS). Set `PORT` if the host doesn't set it for you.

## Configuration

| Env var     | Default | Meaning                          |
|-------------|---------|----------------------------------|
| `PORT`      | `3000`  | HTTP port                        |
| `PICK_MS`   | `15000` | Time to pick a cell each round   |
| `REVEAL_MS` | `2600`  | Pause showing results between rounds |

## Project layout

- `game.js`: the pure game rules (legal moves, resolving a round, scoring)
- `server.js`: Express plus Socket.IO; rooms, timers, reconnects, and a per-player view of the state
- `public/`: the client (plain HTML, CSS and JS; no build step)
- `test/`: `node:test` suites
