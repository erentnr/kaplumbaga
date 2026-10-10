import functools
import itertools
import logging
import math
import os
import re
import threading
import time

from flask import Flask, request
from flask_socketio import SocketIO, join_room, leave_room, emit

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

ROOM_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
MAX_USERNAME_LENGTH = 24

# room_id -> {"status": "waiting" | "countdown" | "playing" | "finished",
#             "winner": username | None,
#             "language": key of TEXTS,
#             "race": id of the current race,
#             "starts_at": time.monotonic() when the countdown ends,
#             "players": {sid: {"username": str, "progress": float}}}
ROOM_LIST = {}
# sid -> room_id, every socket is in at most one room
PLAYER_ROOMS = {}
# handlers run in parallel threads, guard ROOM_LIST and PLAYER_ROOMS with this
state_lock = threading.Lock()
# unique across rooms, so a countdown timer can't start a newer race
race_ids = itertools.count(1)


class RateLimiter:
    """Token bucket per key: `burst` events at once, refilled at `rate` per second."""

    def __init__(self, rate, burst):
        self.rate = rate
        self.burst = burst
        self.buckets = {}  # key -> (tokens, time.monotonic() of the last update)
        self.lock = threading.Lock()

    def allow(self, key):
        now = time.monotonic()
        with self.lock:
            tokens, updated = self.buckets.get(key, (self.burst, now))
            tokens = min(self.burst, tokens + (now - updated) * self.rate)
            allowed = tokens >= 1
            self.buckets[key] = (tokens - 1 if allowed else tokens, now)
            if len(self.buckets) > 10_000:
                self._drop_full_buckets(now)
            return allowed

    def forget(self, key):
        with self.lock:
            self.buckets.pop(key, None)

    def clear(self):
        with self.lock:
            self.buckets.clear()

    def _drop_full_buckets(self, now):
        # a full bucket behaves like a missing one
        for key, (tokens, updated) in list(self.buckets.items()):
            if tokens + (now - updated) * self.rate >= self.burst:
                del self.buckets[key]


# per socket: progress comes with every keystroke, ~15/s for very fast typists
PROGRESS_LIMIT = RateLimiter(rate=30, burst=60)
# per socket: join, leave, game_start and set_language
ACTION_LIMIT = RateLimiter(rate=1, burst=10)
# per client IP: new connections, and connections open at the same time.
# Generous enough for a classroom behind one NAT address.
CONNECT_LIMIT = RateLimiter(rate=0.5, burst=30)
MAX_CONNECTIONS_PER_IP = 30
# Header a trusted proxy puts the client IP in, "CF-Connecting-IP" behind
# Cloudflare Tunnel. Without it all clients would share the proxy's address.
TRUSTED_IP_HEADER = os.environ.get("TRUSTED_IP_HEADER")
# client IP -> number of open sockets, and sid -> client IP
CONNECTIONS = {}
SOCKET_IPS = {}


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


def client_ip():
    if TRUSTED_IP_HEADER:
        return request.headers.get(TRUSTED_IP_HEADER) or request.remote_addr
    return request.remote_addr


def room_state(room):
    state = {
        "players": dict(ROOM_LIST[room]["players"]),
        "status": ROOM_LIST[room]["status"],
        "winner": ROOM_LIST[room]["winner"],
        "language": ROOM_LIST[room]["language"],
    }
    if state["status"] == "countdown":
        state["starts_in"] = max(0.0, ROOM_LIST[room]["starts_at"] - time.monotonic())
    return state


def channel(room):
    """socket.io room name of a game room.

    Every socket is also in a private socket.io room named after its sid, and
    sids are sent to clients as player ids. The prefix keeps a room code from
    ever matching a sid, otherwise joining "<someone's sid>" would deliver that
    room's events to them.
    """
    return f"game:{room}"


def remove_player(user_id):
    """Remove user from their room. Returns (room, state) or (None, None)."""
    room = PLAYER_ROOMS.pop(user_id, None)
    if room is None or room not in ROOM_LIST:
        return None, None
    ROOM_LIST[room]["players"].pop(user_id, None)
    if not ROOM_LIST[room]["players"]:
        del ROOM_LIST[room]
        return room, None
    return room, room_state(room)


@app.get("/healthz")
def healthz():
    return {"status": "ok", "rooms": len(ROOM_LIST), "players": len(PLAYER_ROOMS)}


@socketio.on("connect")
def handle_connect(auth=None):
    ip = client_ip()
    with state_lock:
        if CONNECTIONS.get(ip, 0) >= MAX_CONNECTIONS_PER_IP or not CONNECT_LIMIT.allow(ip):
            log.warning("connection refused, too many connections from one address")
            return False
        CONNECTIONS[ip] = CONNECTIONS.get(ip, 0) + 1
        SOCKET_IPS[request.sid] = ip


@socketio.on("disconnect")
def handle_disconnect(reason=None):
    with state_lock:
        room, state = remove_player(request.sid)
        ip = SOCKET_IPS.pop(request.sid, None)
        if ip is not None:
            CONNECTIONS[ip] -= 1
            if not CONNECTIONS[ip]:
                del CONNECTIONS[ip]
    PROGRESS_LIMIT.forget(request.sid)
    ACTION_LIMIT.forget(request.sid)
    if state:
        emit("room_update", state, to=channel(room))


@socketio.on("join")
@rate_limited(ACTION_LIMIT)
def handle_join(data):
    user_id = request.sid
    room = str(data.get("room_id", ""))
    if not ROOM_ID_PATTERN.match(room):
        return {"ok": False, "error": "invalid room id"}
    username = str(data.get("username") or "").strip()[:MAX_USERNAME_LENGTH] or "player"
    # only used when this join creates the room
    language = data.get("language")
    if language not in TEXTS:
        language = DEFAULT_LANGUAGE

    with state_lock:
        old_room, old_state = remove_player(user_id)
        if room not in ROOM_LIST:
            ROOM_LIST[room] = {"status": "waiting", "winner": None, "language": language,
                               "race": None, "starts_at": None, "players": {}}
        ROOM_LIST[room]["players"][user_id] = {"progress": 0, "username": username}
        PLAYER_ROOMS[user_id] = room
        state = room_state(room)

    if old_room and old_room != room:
        leave_room(channel(old_room))
        if old_state:
            emit("room_update", old_state, to=channel(old_room))
    join_room(channel(room))
    emit("room_update", state, to=channel(room))
    return {"ok": True}


@socketio.on("leave")
@rate_limited(ACTION_LIMIT)
def handle_leave(data=None):
    with state_lock:
        room, state = remove_player(request.sid)
    if room:
        leave_room(channel(room))
    if state:
        emit("room_update", state, to=channel(room))


@socketio.on("set_language")
@rate_limited(ACTION_LIMIT)
def handle_set_language(data):
    language = data.get("language") if isinstance(data, dict) else None
    with state_lock:
        room = PLAYER_ROOMS.get(request.sid)
        if room is None or language not in TEXTS:
            return {"ok": False, "error": "invalid language"}
        if ROOM_LIST[room]["status"] in ("countdown", "playing"):
            return {"ok": False, "error": "game already running"}
        ROOM_LIST[room]["language"] = language
        state = room_state(room)

    emit("room_update", state, to=channel(room))
    return {"ok": True}


@socketio.on("game_start")
@rate_limited(ACTION_LIMIT)
def handle_game_start(data=None):
    with state_lock:
        room = PLAYER_ROOMS.get(request.sid)
        if room is None or ROOM_LIST[room]["status"] in ("countdown", "playing"):
            return {"ok": False, "error": "game already running"}
        race = next(race_ids)
        ROOM_LIST[room].update(status="countdown", winner=None, race=race,
                               starts_at=time.monotonic() + COUNTDOWN_SECONDS)
        for player in ROOM_LIST[room]["players"].values():
            player["progress"] = 0
        state = room_state(room)

    emit("room_update", state, to=channel(room))
    socketio.start_background_task(start_race, room, race)
    return {"ok": True}


def start_race(room, race):
    """Send the text when the countdown ends, runs in a background thread."""
    socketio.sleep(COUNTDOWN_SECONDS)
    with state_lock:
        # the room may be gone, or empty and created again, since the countdown began
        if room not in ROOM_LIST or ROOM_LIST[room]["race"] != race:
            return
        ROOM_LIST[room].update(status="playing", starts_at=None)
        text = TEXTS[ROOM_LIST[room]["language"]]
        state = room_state(room)

    # text first, so clients never see "playing" without a text
    socketio.emit("load_text", text, to=channel(room))
    socketio.emit("room_update", state, to=channel(room))


@socketio.on("progress")
def handle_progress(data):
    user_id = request.sid
    try:
        progress = float(data["progress"])
    except (KeyError, TypeError, ValueError):
        return
    # float() accepts "nan" and "inf", NaN would also slip through the clamp
    # and break JSON parsing on every client in the room
    if not math.isfinite(progress):
        return
    progress = min(max(progress, 0), 100)
    # over the limit only the turtle's position lags, never drop the finish
    if progress < 100 and not PROGRESS_LIMIT.allow(user_id):
        return

    with state_lock:
        room = PLAYER_ROOMS.get(user_id)
        if room is None or ROOM_LIST[room]["status"] != "playing":
            return
        player = ROOM_LIST[room]["players"][user_id]
        player["progress"] = progress
        finished = progress >= 100
        if finished:
            ROOM_LIST[room]["status"] = "finished"
            ROOM_LIST[room]["winner"] = player["username"]

    emit("progress_percentage", {"user_id": user_id, "progress": progress}, to=channel(room))
    if finished:
        log.info("room %s won by %s", room, player["username"])
        emit("finish_game", {"winner": player["username"], "winner_id": user_id}, to=channel(room))


if __name__ == "__main__":
    socketio.run(app, port=int(os.environ.get("PORT", 5001)), debug=True)
