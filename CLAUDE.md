# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Kaplumbaga is a multiplayer typing race. `server/` is a Flask-SocketIO game server in one file (`game.py`); `client/` is a React 19 + Vite SPA in plain JavaScript (no TypeScript), using react-router (imported from `"react-router"`) and socket.io-client.

## Commands

Server (`cd server`, Python 3.10+, CI uses 3.14):

```sh
python -m venv .venv && source .venv/bin/activate && pip install -r requirements-dev.txt
python game.py                              # dev server on :5001, debug mode
pytest -q                                   # all server tests
pytest test_game.py::test_full_game_flow    # one test
pytest -k language                          # tests matching a name
docker build -t kaplumbaga-server .         # production image, CI builds the deployed one
```

Client (`cd client`, Node 22+):

```sh
cp .env-sample .env && npm install
npm run dev        # http://localhost:5173, talks to VITE_SOCKET_SERVER (default http://localhost:5001)
npm run lint       # oxlint (React hooks rules), there is no ESLint or Prettier
npm run build
npx playwright test                      # end-to-end tests
npx playwright test -g "language picker" # one e2e test by title
```

The e2e tests start their own servers: gunicorn on :8000 using `server/.venv/bin/python` (override with `PYTHON=...`), and a production build served by `vite preview` on :4173 with `COUNTDOWN_SECONDS=1`. They use the installed Google Chrome (`channel: 'chrome'`) and run with one worker. Locally they reuse anything already listening on :8000 or :4173, so stop a stale server there before running them.

## Server architecture (`server/game.py`)

- **All state is in memory**: `ROOM_LIST` (room → status, language, players, race fields), `PLAYER_ROOMS` (sid → room) and `CONNECTED`, all guarded by `state_lock`. This is why production runs exactly one gunicorn worker (gthread, 300 threads); there are no sticky sessions and no shared store.
- **Never emit while holding `state_lock`.** Handlers change state and call `queue(...)` under the lock, then call `flush()` after releasing it. Sending to a dead socket makes engine.io run `handle_disconnect` on the same thread, and that handler needs the lock. `flush()` sends from one thread at a time, in queue order, so every client gets messages in the order the changes happened. Tests check both rules.
- `async_handlers=False` handles each client's events in order on its connection thread. Transport is websocket-only, on both server and client.
- **Room lifecycle**: `waiting → countdown → playing → finished`. A single background thread (`room_clock`) handles every room's deadlines: countdown end (`start_race`) and the `RACE_SECONDS` limit (`finish_race`). It sleeps until the next deadline or until `clock_wakeup` is set. Never start a thread or timer per race.
- `racers` holds the sids that received the race text. Only they can send progress or win. Players who join mid-race watch.
- **Reconnects**: the client sends a `player_id` that lasts one page load. `add_player` sees a known `player_id` in the room and calls `take_over`, which moves the old sid's player (name, lane, race and win) to the new sid. A racer who reconnects gets `load_text` again with their progress.
- **Limits**: per-socket token buckets (`PROGRESS_LIMIT`, `FINISH_LIMIT`, `ACTION_LIMIT` through the `@rate_limited` decorator). The `ConnectionLimits` WSGI middleware checks the origin and caps sockets in total (`MAX_SOCKETS`) and per client IP. The client IP comes from `TRUSTED_IP_HEADER` (CF-Connecting-IP in prod), and IPv6 counts per /64. `MAX_SOCKETS` must stay at least 10 below the Dockerfile's `--threads`; a test parses the Dockerfile to check this. `playwright.config.js` copies the same gunicorn command.
- Usernames are cleaned on the server (`clean_username`: no control, direction, or blank characters; joiners only inside words). Duplicates get a number (`unique_username` compares names with invisible characters removed).
- Env vars: `CORS_ORIGINS`, `TRUSTED_IP_HEADER`, `COUNTDOWN_SECONDS`, `RACE_SECONDS`, `MAX_SOCKETS`, `PORT`.

### Socket protocol

Client → server: `join {room_id, username, language, player_id}`, `leave`, `set_language {language}`, `game_start`, `progress {progress}`. Join, set_language and game_start reply with an ack `{ok, error}`.
Server → client: `room_update`, `load_text` (positional args `(text, room, progress?)`), `progress_percentage`, `finish_game`.

Every server message carries `room`, and the client drops messages for other rooms. **Keep the protocol compatible in both directions.** The server deploys before the client, so an old client can talk to the new server. A rolled-back server can talk to the new client, which is why the client accepts messages that have no `room`. This is also why the text is the first argument of `load_text`.

Progress is sent once per completed word, as a percentage (`progressAt`/`wordAt` in `Game.jsx` convert between word index and percent). A race ends when someone reports 100.

## Client architecture (`client/src`)

- `App.jsx` creates a single socket with `autoConnect: false`. Only the game page (`/play/:room_id`) connects; the home page never does.
- In `Game.jsx`, `Game` owns the connection. `Race` is keyed by a count of connections, so it mounts again after every reconnect with clean state. While the socket is down, the old `Race` stays on screen, frozen (controls disabled). It joins on mount and emits `leave` on unmount, only on the connection it joined with.
- The look follows the Kaplumbaga design canvas: colors are CSS variables in `index.css` (shared buttons, fields and the status line live there too), the turtle and icons are inline SVG in `components/Art.jsx`, and phones get their own layout through `@media (max-width: 640px)` in `Game.css`. While racing on a phone, the room is fixed over the visual viewport (`--viewport-height` and `--viewport-top`, set from `window.visualViewport`), so the text and input stay above the keyboard even when the browser scrolls the page to show the input (iOS does). The e2e test fakes `visualViewport` to open a keyboard, real test browsers never show one.
- `storage.js` wraps localStorage and falls back to memory when the browser blocks site data. Use it, not `localStorage` directly.
- `getPlayerId()` is kept in module memory on purpose. sessionStorage would be copied into a duplicated tab, and the two tabs would then replace each other.

## Adding or changing race texts

The texts live in `TEXTS` in `game.py`. Language codes must also be added to `LANGUAGES` in `client/src/languages.js` and to the language set in `test_every_language_has_a_typable_text`. Texts must use single spaces, be NFC-normalized and have no curly apostrophes, because the client splits on spaces and normalizes typed input.

## Gotchas

- `game.py` must not contain invisible (Unicode `Cf`) characters; a test checks this. Write special characters as `chr(0x...)`, as both `game.py` and the tests do.
- Server tests (`test_game.py`) use `socketio.test_client`. Autouse fixtures reset the global state, replace `start_background_task` so no real threads run, and set `COUNTDOWN_SECONDS=0`. Advance the room clock by calling `game.tick()`; the `clock` fixture fakes `time.monotonic`.
- In e2e tests, each player gets its own browser context through the `joinAs` fixture, which closes the contexts afterwards. All test sockets come from 127.0.0.1 and count against the per-client socket limit.
- `requirements.txt` is a `pip freeze` (see its header for how to regenerate it). The server image is `python:3.14-alpine`, which works because every dependency is pure Python.

## Deployment

`main` is protected (PRs only, squash merge, required checks). The CI workflow in `.github/workflows/ci.yml` runs the server tests, client lint plus build, then the e2e tests. The `image` job builds the server image and checks that it starts and answers `/healthz`. On a push to `main`, that job pushes the image as `ghcr.io/erentnr/kaplumbaga-server:<commit sha>`, and the workflow then deploys, but only if the commit is still the newest on `main` (queued runs don't always run in commit order; when main has moved on, the newer commit's run deploys instead):

1. **Server**: CI connects over SSH with a key whose forced command is `/usr/local/bin/kaplumbaga-deploy` on the VPS, a copy of `deploy/vps-deploy.sh`. The script deploys a commit SHA only if it is on `main`. It checks out that commit (for `docker-compose.yml`), pulls the commit's image with `SERVER_TAG=<sha>` and runs `docker compose up --no-build --wait`. If the new server isn't healthy, it goes back to the previous commit's image, which ghcr.io still has. After a successful deploy it installs its own new version over the copy, so script changes deploy too. The VPS never builds images; without `SERVER_TAG`, compose builds one locally tagged `local`. `docker-compose.yml` publishes no ports; `cloudflared` tunnels `kaplumbaga-api.eren.sh` to `server:8000`. Health check: `/healthz`.
2. **Client**: after the server, `npm run deploy` (`vite build && wrangler deploy`) uploads static assets to Cloudflare (no Worker script). The custom domain is attached outside `wrangler.jsonc` on purpose, so don't add `routes` there.

Actions are pinned to commit SHAs, npm always runs with `--ignore-scripts`, and Dependabot opens grouped weekly updates with a 7-day cooldown.
