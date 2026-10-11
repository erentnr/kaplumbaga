# Kaplumbaga

Kaplumbaga is a competitive fast-typing game which you can play with your friends.
Create a room, share the code, and race your turtles by typing the same text.
*Kaplumbağa* means turtle in Turkish.

Play: [Kaplumbaga - Test your speed.](https://kaplumbaga.eren.sh/)

## The story

It started with an argument. In December 2021, during a coding bootcamp, a few
of us kept debating who was the fastest on the keyboard, and talking wasn't
going to settle it. So I built a game to find out: everyone joins a room, types
the same sentence, and their turtles crawl to the finish line as they type.

I put the server on Heroku and the frontend on Netlify, and we raced.

Four years later, a friend from the bootcamp reminded me of the game. I wanted
to see what Claude would do with it, and to deploy it in a more persistent way.
So in October 2026, Claude went through the old code with me:

- upgraded everything to current versions: React 19, Vite, Flask 3, Python 3.14
- fixed the multiplayer bugs that had been hiding all along: duplicated text,
  names vanishing between rounds, players who never left the race
- added races in six languages and a 3-2-1 countdown, so nobody gets a head start
- added tests, including browser tests that play real games, and CI/CD
- moved hosting next to my other projects: the frontend on Cloudflare, the
  game server in Docker on my own VPS behind a Cloudflare Tunnel, at no extra cost

Same turtles, same argument. Still settling it.

## Tech

Flask, Flask-SocketIO, React, Vite, Socket.IO

## Running it locally

Server (Python 3.10+), on port 5001:

`cd server && python -m venv .venv && source .venv/bin/activate && pip install -r requirements-dev.txt && python game.py`

Client (Node 22+), on http://localhost:5173:

`cd client && cp .env-sample .env && npm install && npm run dev`

Tests: `pytest` in `server`, `npx playwright test` in `client` (uses Google Chrome).

## Deployment

GitHub Actions tests every pull request. Pushes to `main` build the server
image once, push it to ghcr.io, and run it on a VPS
([`docker-compose.yml`](docker-compose.yml), [`deploy/vps-deploy.sh`](deploy/vps-deploy.sh)).
The client goes to Cloudflare as static assets.
