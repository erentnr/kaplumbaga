import functools
import ipaddress
import itertools
import logging
import math
import os
import re
import threading
import time
import unicodedata

from flask import Flask, request
from flask_socketio import SocketIO, join_room, leave_room

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kaplumbaga")

# Comma separated list of origins allowed to open a socket, e.g.
# "https://kaplumbaga.eren.sh". Defaults to the Vite dev server.
CORS_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    ).split(",")
    if origin.strip()
]

app = Flask(__name__)
socketio = SocketIO(
    app,
    async_mode="threading",
    cors_allowed_origins=CORS_ORIGINS,
    max_http_buffer_size=16 * 1024,
    # clients connect with a websocket right away, no long-polling first
    transports=["websocket"],
    # run a client's events one after another on its connection thread. The
    # default starts a new thread per event, so a leave could overtake a join.
    async_handlers=False,
)

# race text of each language, every room picks one language
TEXTS = {
    "tr": ("Artık bir satranç oynuyorduk, satrançta da en işe yaramaz "
           "hamle feda etmek zorunda olduğun taşları okşamaktır."),
    "en": ("The tortoise never hurries, yet it always reaches the finish line; "
           "patience wins more races than speed ever could."),
    "pt": ("A tartaruga nunca tem pressa, mas chega sempre à meta; a paciência "
           "e a constância vencem mais corridas do que a velocidade."),
    "de": ("Die Schildkröte hat es nie eilig und kommt trotzdem immer ans Ziel; "
           "Geduld gewinnt mehr Rennen als bloße Schnelligkeit."),
    "fr": ("La tortue ne se presse jamais, et pourtant elle arrive toujours à "
           "l'heure. Sa patience gagne plus de courses que la rapidité."),
    "es": ("La pequeña tortuga nunca tiene prisa, pero siempre llega a la meta; "
           "la paciencia gana más carreras que la velocidad."),
}
DEFAULT_LANGUAGE = "en"
# seconds between pressing Start and the text appearing
COUNTDOWN_SECONDS = float(os.environ.get("COUNTDOWN_SECONDS", 3))
# a race nobody finishes ends after this many seconds, so the room can race again
RACE_SECONDS = float(os.environ.get("RACE_SECONDS", 180))
# Progress can't run ahead of fast human typing, ~240 words per minute, plus
# a few characters typed right as the text appears. A finish that comes too
# early is kept and counts once it's plausible. 0 turns the check off.
MAX_CHARS_PER_SECOND = float(os.environ.get("MAX_CHARS_PER_SECOND", 20))
HEAD_START_CHARS = 10
# sockets that don't join a room within this many seconds are closed
ROOMLESS_SECONDS = float(os.environ.get("ROOMLESS_SECONDS", 30))
# how often the room clock runs countdowns, time limits and cleanup
CLOCK_SECONDS = 0.1

ROOM_ID_PATTERN = re.compile(r"[a-z0-9_-]{1,32}")
MAX_USERNAME_LENGTH = 24

# room_id -> {"status": "waiting" | "countdown" | "playing" | "finished",
#             "language": key of TEXTS,
#             "version": increases with every change, see bump(),
#             "players": {sid: {"username": str, "progress": float}},
#             plus the race fields of race_fields()}
ROOM_LIST = {}
# sid -> room_id, every socket is in at most one room
PLAYER_ROOMS = {}
# sid -> time.monotonic() of the connection, for closing sockets without a room
CONNECTED_AT = {}
# Guards ROOM_LIST, PLAYER_ROOMS and CONNECTED_AT. Never send while holding
# it: sending to a socket that stopped answering pings closes it, and
# engineio runs handle_disconnect in the same thread, which needs this lock.
state_lock = threading.Lock()
# unique across rooms, so a deleted and recreated room never reuses one
race_ids = itertools.count(1)
versions = itertools.count(1)
clock_started = False


class RateLimiter:
    """Token bucket per key: `burst` events at once, refilled at `rate` per second."""

    def __init__(self, rate, burst):
        self.rate = rate
        self.burst = burst
        self.buckets = {}  # key -> (tokens, time.monotonic() of the last update)
        self.lock = threading.Lock()
        self.next_cleanup = 0

    def allow(self, key):
        now = time.monotonic()
        with self.lock:
            tokens, updated = self.buckets.get(key, (self.burst, now))
            tokens = min(self.burst, tokens + (now - updated) * self.rate)
            allowed = tokens >= 1
            self.buckets[key] = (tokens - 1 if allowed else tokens, now)
            # at most once a minute, scanning every bucket on each call would be slow
            if len(self.buckets) > 10_000 and now >= self.next_cleanup:
                self._drop_full_buckets(now)
                self.next_cleanup = now + 60
            return allowed

    def forget(self, key):
        with self.lock:
            self.buckets.pop(key, None)

    def clear(self):
        with self.lock:
            self.buckets.clear()
            self.next_cleanup = 0

    def _drop_full_buckets(self, now):
        # a full bucket behaves like a missing one
        for key, (tokens, updated) in list(self.buckets.items()):
            if tokens + (now - updated) * self.rate >= self.burst:
                del self.buckets[key]


# per socket: progress comes with every keystroke, ~15/s for very fast typists
PROGRESS_LIMIT = RateLimiter(rate=30, burst=60)
# per socket: join, game_start and set_language. leave is never limited, a
# dropped leave would keep a player in the room.
ACTION_LIMIT = RateLimiter(rate=1, burst=10)

# Every open websocket holds one gunicorn thread until it closes. Keep the
# total below gunicorn's --threads in the Dockerfile, so the health check
# always gets a thread.
MAX_SOCKETS = int(os.environ.get("MAX_SOCKETS", 280))
# per client, generous enough for a classroom behind one NAT address
MAX_SOCKETS_PER_CLIENT = 30
CONNECT_LIMIT = RateLimiter(rate=0.5, burst=30)
# Header a trusted proxy puts the client IP in, "CF-Connecting-IP" behind
# Cloudflare Tunnel. Without it all clients would share the proxy's address.
TRUSTED_IP_HEADER = os.environ.get("TRUSTED_IP_HEADER")


def client_key(environ):
    """Who a connection counts against: the client IP, a whole /64 for IPv6."""
    ip = ""
    if TRUSTED_IP_HEADER:
        ip = environ.get("HTTP_" + TRUSTED_IP_HEADER.upper().replace("-", "_"), "")
    ip = ip.strip() or environ.get("REMOTE_ADDR", "")
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if address.version == 6:
        if address.ipv4_mapped:
            return str(address.ipv4_mapped)
        # one IPv6 client usually has a whole /64 to pick addresses from
        return str(ipaddress.ip_network(f"{address}/64", strict=False))
    return str(address)


class ConnectionLimits:
    """WSGI middleware that limits socket.io connections, in total and per client.

    It runs before the websocket is accepted, so a refused client only costs
    a quick 429 response and socket.io-client retries on its own.
    """

    def __init__(self, wsgi_app):
        self.wsgi_app = wsgi_app
        self.lock = threading.Lock()
        self.total = 0
        self.per_client = {}  # client key -> open connections

    def __call__(self, environ, start_response):
        if not environ.get("PATH_INFO", "").startswith("/socket.io"):
            return self.wsgi_app(environ, start_response)
        key = client_key(environ)
        with self.lock:
            allowed = (self.total < MAX_SOCKETS
                       and self.per_client.get(key, 0) < MAX_SOCKETS_PER_CLIENT
                       and CONNECT_LIMIT.allow(key))
            if allowed:
                self.total += 1
                self.per_client[key] = self.per_client.get(key, 0) + 1
        if not allowed:
            log.warning("connection refused, too many connections")
            start_response("429 Too Many Requests",
                           [("Content-Type", "text/plain"), ("Retry-After", "5")])
            return [b"too many connections\n"]
        try:
            # for a websocket this returns when the connection closes
            return self.wsgi_app(environ, start_response)
        finally:
            with self.lock:
                self.total -= 1
                self.per_client[key] -= 1
                if not self.per_client[key]:
                    del self.per_client[key]


connection_limits = ConnectionLimits(app.wsgi_app)
app.wsgi_app = connection_limits


def rate_limited(limiter):
    """Ignore events of a socket that sends more than `limiter` allows."""
    def decorator(handler):
        @functools.wraps(handler)
        def wrapper(*args):
            if not limiter.allow(request.sid):
                return {"ok": False, "error": "too many requests"}
            return handler(*args)
        return wrapper
    return decorator


# joiners that shape emoji sequences (👨‍👩‍👧) and Persian or Indic words
KEPT_FORMAT_CHARACTERS = {"‌", "‍"}


def clean_username(value):
    """Printable name: no control, line break or text direction characters."""
    kept = []
    for ch in unicodedata.normalize("NFC", str(value or "")):
        category = unicodedata.category(ch)
        if category in ("Cc", "Zl", "Zp"):
            kept.append(" ")  # line breaks and tabs become spaces
        elif not category.startswith("C") or ch in KEPT_FORMAT_CHARACTERS:
            # drops text direction and other format characters, private use, unassigned
            kept.append(ch)
    return " ".join("".join(kept).split())[:MAX_USERNAME_LENGTH].strip() or "player"


def unique_username(name, players):
    """Add a number to a name already used in the room: "player417 2"."""
    taken = {player["username"] for player in players.values()}
    candidate, number = name, 2
    while candidate in taken:
        suffix = f" {number}"
        candidate = name[:MAX_USERNAME_LENGTH - len(suffix)] + suffix
        number += 1
    return candidate


def race_fields(**values):
    """Fields of the current race, empty unless given."""
    fields = {
        "race": None,        # id of the race
        "starts_at": None,   # time.monotonic() when the countdown ends
        "started_at": None,  # time.monotonic() when the text was sent
        "text": None,
        "racers": set(),     # sids that got the text, only they can finish
        "claims": {},        # sid -> time.monotonic() of a finish sent too early
        "winner": None,
        "winner_id": None,
    }
    fields.update(values)
    return fields


def new_room(language):
    return {"status": "waiting", "language": language, "version": next(versions),
            "players": {}, **race_fields()}


def bump(room):
    """Mark a change. Messages carry the version, so a client can drop one
    that arrives after a newer one (they are sent outside the lock)."""
    ROOM_LIST[room]["version"] = next(versions)


def room_state(room, now=None):
    state = {
        "players": dict(ROOM_LIST[room]["players"]),
        "status": ROOM_LIST[room]["status"],
        "winner": ROOM_LIST[room]["winner"],
        "winner_id": ROOM_LIST[room]["winner_id"],
        "language": ROOM_LIST[room]["language"],
        "version": ROOM_LIST[room]["version"],
    }
    if state["status"] == "countdown":
        now = time.monotonic() if now is None else now
        state["starts_in"] = max(0.0, ROOM_LIST[room]["starts_at"] - now)
    return state


def channel(room):
    """socket.io room name of a game room.

    Every socket is also in a private socket.io room named after its sid, and
    sids are sent to clients as player ids. The prefix keeps a room code from
    ever matching a sid, otherwise joining "<someone's sid>" would deliver that
    room's events to them.
    """
    return f"game:{room}"


def send(outbox):
    """Send (event, data, room) messages collected under state_lock, after releasing it."""
    for event, data, room in outbox:
        socketio.emit(event, data, to=channel(room))


def start_race(room, now, outbox):
    """Countdown is over: send the text. Hold state_lock."""
    state = ROOM_LIST[room]
    state.update(status="playing", starts_at=None, started_at=now,
                 text=TEXTS[state["language"]], racers=set(state["players"]))
    bump(room)
    # text first, so clients never see "playing" without a text
    outbox.append(("load_text", {"text": state["text"], "version": state["version"]}, room))
    outbox.append(("room_update", room_state(room, now), room))


def finish_race(room, outbox, winner_id=None):
    """End the race, without a winner when nobody finished. Hold state_lock."""
    state = ROOM_LIST[room]
    winner = None
    if winner_id:
        winner = state["players"][winner_id]["username"]
        state["players"][winner_id]["progress"] = 100
        outbox.append(("progress_percentage", {"user_id": winner_id, "progress": 100,
                                               "version": state["version"]}, room))
        log.info("room %s won by %s", room, winner)
    state.update(status="finished", winner=winner, winner_id=winner_id,
                 racers=set(), claims={})
    bump(room)
    outbox.append(("finish_game", {"winner": winner, "winner_id": winner_id,
                                   "version": state["version"]}, room))


def finish_is_plausible(state, now):
    if not MAX_CHARS_PER_SECOND:
        return True
    typing_seconds = max(0, len(state["text"]) - HEAD_START_CHARS) / MAX_CHARS_PER_SECOND
    return now >= state["started_at"] + typing_seconds


def remove_player(user_id, outbox):
    """Remove a player from their room. Hold state_lock.

    Deletes the room when it gets empty, and ends a race when nobody racing is
    left. Returns the room the player was in, or None.
    """
    room = PLAYER_ROOMS.pop(user_id, None)
    if room is None or room not in ROOM_LIST:
        return None
    state = ROOM_LIST[room]
    state["players"].pop(user_id, None)
    state["racers"].discard(user_id)
    state["claims"].pop(user_id, None)
    if not state["players"]:
        del ROOM_LIST[room]
        return room
    bump(room)
    if state["status"] == "playing" and not state["racers"]:
        # only players who joined mid-race are left, let them start a new one
        finish_race(room, outbox)
    outbox.append(("room_update", room_state(room), room))
    return room


def tick():
    """Run countdowns, early finishes, time limits and cleanup. The room clock calls this."""
    now = time.monotonic()
    outbox = []
    with state_lock:
        for room, state in ROOM_LIST.items():
            if state["status"] == "countdown" and now >= state["starts_at"]:
                start_race(room, now, outbox)
            elif state["status"] == "playing":
                if state["claims"] and finish_is_plausible(state, now):
                    finish_race(room, outbox, min(state["claims"], key=state["claims"].get))
                elif now >= state["started_at"] + RACE_SECONDS:
                    finish_race(room, outbox)
        roomless = [sid for sid, since in CONNECTED_AT.items()
                    if sid not in PLAYER_ROOMS and now - since > ROOMLESS_SECONDS]
    send(outbox)
    for sid in roomless:
        socketio.server.disconnect(sid)


def room_clock():
    """One thread for every room's timers, instead of a thread per race."""
    while True:
        socketio.sleep(CLOCK_SECONDS)
        try:
            tick()
        except Exception:
            log.exception("room clock")


@app.get("/healthz")
def healthz():
    return {"status": "ok", "rooms": len(ROOM_LIST), "players": len(PLAYER_ROOMS),
            "sockets": connection_limits.total}


@socketio.on("connect")
def handle_connect(auth=None):
    global clock_started
    with state_lock:
        CONNECTED_AT[request.sid] = time.monotonic()
        start_clock = not clock_started
        clock_started = True
    if start_clock:
        socketio.start_background_task(room_clock)


@socketio.on("disconnect")
def handle_disconnect(reason=None):
    outbox = []
    with state_lock:
        CONNECTED_AT.pop(request.sid, None)
        remove_player(request.sid, outbox)
    send(outbox)
    PROGRESS_LIMIT.forget(request.sid)
    ACTION_LIMIT.forget(request.sid)


@socketio.on("join")
@rate_limited(ACTION_LIMIT)
def handle_join(data=None):
    if not isinstance(data, dict):
        return {"ok": False, "error": "invalid request"}
    # codes are lowercase, phone keyboards like to capitalize the first letter
    room = str(data.get("room_id", "")).strip().lower()
    if not ROOM_ID_PATTERN.fullmatch(room):
        return {"ok": False, "error": "invalid room id"}
    username = clean_username(data.get("username"))
    # only used when this join creates the room
    language = data.get("language")
    if not isinstance(language, str) or language not in TEXTS:
        language = DEFAULT_LANGUAGE

    user_id = request.sid
    outbox = []
    with state_lock:
        old_room = remove_player(user_id, outbox)
        if old_room is not None and old_room != room:
            leave_room(channel(old_room))
        if room not in ROOM_LIST:
            ROOM_LIST[room] = new_room(language)
        players = ROOM_LIST[room]["players"]
        players[user_id] = {"progress": 0, "username": unique_username(username, players)}
        PLAYER_ROOMS[user_id] = room
        bump(room)
        join_room(channel(room))
        outbox.append(("room_update", room_state(room), room))
    send(outbox)
    return {"ok": True}


@socketio.on("leave")
def handle_leave(data=None):
    outbox = []
    with state_lock:
        room = remove_player(request.sid, outbox)
        if room is not None:
            leave_room(channel(room))
    send(outbox)


@socketio.on("set_language")
@rate_limited(ACTION_LIMIT)
def handle_set_language(data=None):
    language = data.get("language") if isinstance(data, dict) else None
    if not isinstance(language, str) or language not in TEXTS:
        return {"ok": False, "error": "invalid language"}
    outbox = []
    with state_lock:
        room = PLAYER_ROOMS.get(request.sid)
        if room is None:
            return {"ok": False, "error": "not in a room"}
        if ROOM_LIST[room]["status"] in ("countdown", "playing"):
            return {"ok": False, "error": "game already running"}
        ROOM_LIST[room]["language"] = language
        bump(room)
        outbox.append(("room_update", room_state(room), room))
    send(outbox)
    return {"ok": True}


@socketio.on("game_start")
@rate_limited(ACTION_LIMIT)
def handle_game_start(data=None):
    outbox = []
    with state_lock:
        room = PLAYER_ROOMS.get(request.sid)
        if room is None or ROOM_LIST[room]["status"] in ("countdown", "playing"):
            return {"ok": False, "error": "game already running"}
        # the room clock sends the text when the countdown is over
        ROOM_LIST[room].update(status="countdown", **race_fields(
            race=next(race_ids), starts_at=time.monotonic() + COUNTDOWN_SECONDS))
        for player in ROOM_LIST[room]["players"].values():
            player["progress"] = 0
        bump(room)
        outbox.append(("room_update", room_state(room), room))
    send(outbox)
    return {"ok": True}


@socketio.on("progress")
def handle_progress(data=None):
    user_id = request.sid
    try:
        progress = float(data["progress"])
    except (KeyError, TypeError, ValueError, OverflowError):
        return
    # float() accepts "nan" and "inf", NaN would also slip through the clamp
    # and break JSON parsing on every client in the room
    if not math.isfinite(progress):
        return
    progress = min(max(progress, 0), 100)
    # over the limit the update isn't sent, only a finish is still recorded
    allowed = PROGRESS_LIMIT.allow(user_id)
    if not allowed and progress < 100:
        return

    outbox = []
    with state_lock:
        room = PLAYER_ROOMS.get(user_id)
        if room is None:
            return
        state = ROOM_LIST[room]
        # players who joined mid-race never got the text, they watch
        if state["status"] != "playing" or user_id not in state["racers"]:
            return
        now = time.monotonic()
        if progress >= 100:
            state["claims"].setdefault(user_id, now)
        if MAX_CHARS_PER_SECOND:
            typed = HEAD_START_CHARS + (now - state["started_at"]) * MAX_CHARS_PER_SECOND
            progress = min(progress, typed / len(state["text"]) * 100)
        if allowed and progress < 100:
            state["players"][user_id]["progress"] = progress
            outbox.append(("progress_percentage", {"user_id": user_id, "progress": progress,
                                                   "version": state["version"]}, room))
        if user_id in state["claims"] and finish_is_plausible(state, now):
            finish_race(room, outbox, min(state["claims"], key=state["claims"].get))
    send(outbox)


if __name__ == "__main__":
    socketio.run(app, port=int(os.environ.get("PORT", 5001)), debug=True)
