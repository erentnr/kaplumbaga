import collections
import functools
import ipaddress
import logging
import math
import os
import re
import threading
import time
import unicodedata

from flask import Flask, request
from flask_socketio import SocketIO

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

# engine.io pings every client this often, and closes one that doesn't
# answer within PING_TIMEOUT seconds
PING_INTERVAL = 25
PING_TIMEOUT = 20

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
    ping_interval=PING_INTERVAL,
    ping_timeout=PING_TIMEOUT,
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

ROOM_ID_PATTERN = re.compile(r"[a-z0-9_-]{1,32}")
# random id of a browser tab, so a reconnecting tab replaces its old connection
PLAYER_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{8,64}")
MAX_USERNAME_LENGTH = 24

# Every player gets every progress message of their room, so the messages
# sent grow with the square of the room size. A class of 30 and a teacher fit.
MAX_PLAYERS_PER_ROOM = 32

# room_id -> {"status": "waiting" | "countdown" | "playing" | "finished",
#             "language": key of TEXTS,
#             "players": {sid: {"username": str, "progress": float, "player_id": str | None}},
#             plus the race fields of race_fields()}
ROOM_LIST = {}
# sid -> room_id, every socket is in at most one room
PLAYER_ROOMS = {}
# sids of the open sockets. A socket can disconnect on another thread while
# its join waits for the lock, the join must not add it then.
CONNECTED = set()
# Guards ROOM_LIST, PLAYER_ROOMS and CONNECTED, and messages are queued under
# it in the order of the changes. Never send while holding it: sending to a
# socket that stopped answering pings closes it, and engineio runs
# handle_disconnect in the same thread, which needs this lock.
state_lock = threading.Lock()
# Messages to send, (event, data, recipient sids), in the order of the
# changes they tell about. Appended under state_lock, sent by flush().
OUTBOX = collections.deque()
# held by the one thread sending, so every client gets the messages in order
send_lock = threading.Lock()
clock_lock = threading.Lock()
clock_thread = None
# set when a new countdown starts, the clock sleeps until then or the next deadline
clock_wakeup = threading.Event()


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


# per socket: progress comes with every finished word, ~5/s at the typing
# world record. It goes to every player of the room.
PROGRESS_LIMIT = RateLimiter(rate=5, burst=10)
# a finish is one message per race, its own small limit keeps it from being
# dropped by a burst of progress without letting a flood of them through
FINISH_LIMIT = RateLimiter(rate=1, burst=3)
# per socket: join, leave, game_start and set_language. A dropped leave does
# no harm, the client follows it with a join or a disconnect, both leave too.
ACTION_LIMIT = RateLimiter(rate=1, burst=10)

# Every open websocket holds one gunicorn thread until it closes. Keep the
# total below gunicorn's --threads in the Dockerfile, so the health check
# always gets a thread. A connection that stops sending closes after its
# read timeout, see ConnectionLimits.
MAX_SOCKETS = int(os.environ.get("MAX_SOCKETS", 280))
# per client: a full room behind one NAT address, like a classroom, plus
# room to reconnect while the old connections time out
MAX_SOCKETS_PER_CLIENT = 40
CONNECT_LIMIT = RateLimiter(rate=0.5, burst=40)
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
        origin = environ.get("HTTP_ORIGIN")
        if origin is not None and origin not in CORS_ORIGINS:
            # A page on another site, socket.io would refuse it too. Refused
            # here before it's counted, so it can't use up the connection
            # allowance of the address its visitors share, like a school's.
            start_response("403 Forbidden", [("Content-Type", "text/plain")])
            return [b"origin not allowed\n"]
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
        sock = environ.get("gunicorn.socket")
        if sock is not None:
            # engine.io means to set this read timeout but looks for the
            # socket under another name. Without it a client gone without
            # closing, like a phone that lost Wi-Fi behind the tunnel, kept
            # its thread and slot until the TCP connection died. A live
            # client answers a ping every PING_INTERVAL seconds.
            sock.settimeout(PING_INTERVAL + PING_TIMEOUT)
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


# Zero width non-joiner and joiner: needed by emoji sequences (a family of
# three is man, joiner, woman, joiner, girl) and by Persian and Indic words.
JOINERS = chr(0x200C) + chr(0x200D)
# a joiner at the start or end of a word, or more than one in a row, joins nothing
STRAY_JOINERS = re.compile(rf"(?<!\S)[{JOINERS}]+|[{JOINERS}]+(?!\S)|(?<=[{JOINERS}])[{JOINERS}]+")
# characters that draw nothing although they aren't format characters:
# combining grapheme joiner, Hangul fillers, Khmer inherent vowels, Mongolian
# variation selectors and the blank Braille pattern
BLANKS = {chr(code) for code in (0x034F, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x180B, 0x180C,
                                  0x180D, 0x180E, 0x180F, 0x2800, 0x3164, 0xFFA0)}


def shorten(name, length):
    """The name cut to `length` characters, without a space or a joiner left
    at the end."""
    return STRAY_JOINERS.sub("", name[:length]).strip()


def clean_username(value):
    """Printable name: no control, line break, text direction or blank characters,
    and at least one visible character."""
    kept = []
    for ch in unicodedata.normalize("NFC", str(value or "")):
        category = unicodedata.category(ch)
        if category in ("Cc", "Zl", "Zp"):
            kept.append(" ")  # line breaks and tabs become spaces
        elif ch in BLANKS:
            continue
        elif not category.startswith("C") or ch in JOINERS:
            # drops text direction and other format characters, private use, unassigned
            kept.append(ch)
    text = STRAY_JOINERS.sub("", "".join(kept))
    name = shorten(" ".join(text.split()), MAX_USERNAME_LENGTH)
    # a letter, number, punctuation or symbol, not only combining marks
    visible = any(unicodedata.category(ch)[0] in "LNPS" for ch in name)
    return name if visible else "player"


# joiners and variation selectors are invisible next to most letters
LOOK_ALIKE = str.maketrans(dict.fromkeys(
    [ord(joiner) for joiner in JOINERS] + list(range(0xFE00, 0xFE10)) + list(range(0xE0100, 0xE01F0))))


def looks_like(name):
    """The name without characters that don't show: "alice" + joiner looks like "alice"."""
    return name.translate(LOOK_ALIKE)


def unique_username(name, players):
    """Add a number to a name already used in the room: "player417 2"."""
    taken = {looks_like(player["username"]) for player in players.values()}
    candidate, number = name, 2
    while looks_like(candidate) in taken:
        suffix = f" {number}"
        candidate = shorten(name, MAX_USERNAME_LENGTH - len(suffix)) + suffix
        number += 1
    return candidate


def race_fields(**values):
    """Fields of the current race, empty unless given."""
    fields = {
        "starts_at": None,   # time.monotonic() when the countdown ends
        "started_at": None,  # time.monotonic() when the text was sent
        "text": None,
        "racers": set(),     # sids that got the text, only they can finish
        "winner": None,
        "winner_id": None,
    }
    fields.update(values)
    return fields


def new_room(language):
    return {"status": "waiting", "language": language, "players": {}, **race_fields()}


def room_state(room, now=None):
    state = ROOM_LIST[room]
    message = {
        "room": room,
        # copied, the message is sent after releasing the lock
        "players": {sid: {"username": player["username"], "progress": player["progress"]}
                    for sid, player in state["players"].items()},
        "status": state["status"],
        "winner": state["winner"],
        "winner_id": state["winner_id"],
        "language": state["language"],
    }
    if state["status"] == "countdown":
        now = time.monotonic() if now is None else now
        message["starts_in"] = max(0.0, state["starts_at"] - now)
    return message


def queue(room, event, data, recipients=None):
    """Queue a message for `recipients`, by default the players in the room
    right now: a player who joins before it's sent doesn't get it. Hold
    state_lock."""
    if recipients is None:
        recipients = list(ROOM_LIST[room]["players"])
    OUTBOX.append((event, data, recipients))


def flush():
    """Send the queued messages. Call after releasing state_lock.

    One thread sends at a time, in queue order, so every client gets the
    messages in the order the changes happened. A thread that finds another
    one sending leaves its messages to it, the loop picks up any queued while
    the lock was let go.
    """
    while OUTBOX:
        if not send_lock.acquire(blocking=False):
            return
        try:
            while OUTBOX:
                event, data, recipients = OUTBOX.popleft()
                # One at a time: a socket that finishes closing on another
                # thread raises, and must not cost the others this message.
                for sid in recipients:
                    try:
                        socketio.emit(event, data, to=sid)
                    except Exception:
                        log.exception("can't send %s to %s", event, sid)
        finally:
            send_lock.release()


def start_race(room, now):
    """Countdown is over: send the text. Hold state_lock."""
    state = ROOM_LIST[room]
    state.update(status="playing", starts_at=None, started_at=now,
                 text=TEXTS[state["language"]], racers=set(state["players"]))
    # Text first, so clients never see "playing" without a text. The text is
    # the first argument, so clients from before the room argument still work.
    queue(room, "load_text", (state["text"], room))
    queue(room, "room_update", room_state(room, now))


def finish_race(room, winner_id=None):
    """End the race, without a winner when nobody finished. Hold state_lock."""
    state = ROOM_LIST[room]
    winner = state["players"][winner_id]["username"] if winner_id else None
    state.update(status="finished", winner=winner, winner_id=winner_id, racers=set())
    if winner_id:
        state["players"][winner_id]["progress"] = 100
        queue(room, "progress_percentage", {"room": room, "user_id": winner_id, "progress": 100})
        log.info("room %s won by %s", room, winner)
    queue(room, "finish_game", {"room": room, "winner": winner, "winner_id": winner_id})


def remove_player(user_id):
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
    if not state["players"]:
        del ROOM_LIST[room]
        return room
    if state["status"] == "playing" and not state["racers"]:
        # nobody left who can finish, let the others start a new race
        finish_race(room)
    queue(room, "room_update", room_state(room))
    return room


def take_over(room, old, new):
    """Give the player of socket `old` to socket `new`, the same tab
    reconnected: it keeps its name, lane, race and win. Hold state_lock."""
    state = ROOM_LIST[room]
    # rebuilt in the same order, so the lanes stay where they were
    state["players"] = {(new if sid == old else sid): player
                        for sid, player in state["players"].items()}
    del PLAYER_ROOMS[old]
    PLAYER_ROOMS[new] = room
    if old in state["racers"]:
        state["racers"].discard(old)
        state["racers"].add(new)
    if state["winner_id"] == old:
        state["winner_id"] = new


def add_player(room, user_id, username, player_id, language):
    """Put a socket in a room, it leaves its current one. Hold state_lock.
    Returns an error message, None when it joined."""
    if user_id not in CONNECTED:
        # it disconnected while this join waited for the lock, nothing would
        # remove a player added now
        return "not connected"
    remove_player(user_id)
    state = ROOM_LIST.get(room)
    # this tab reconnected, its old socket stays until the ping timeout
    old = next((sid for sid, player in state["players"].items()
                if player["player_id"] == player_id), None) if state and player_id else None
    if old:
        take_over(room, old, user_id)
    elif state and len(state["players"]) >= MAX_PLAYERS_PER_ROOM:
        return "room is full"
    else:
        if state is None:
            state = ROOM_LIST[room] = new_room(language)
        state["players"][user_id] = {"progress": 0, "player_id": player_id,
                                     "username": unique_username(username, state["players"])}
        PLAYER_ROOMS[user_id] = room
    if user_id in state["racers"]:
        # a racer who reconnected gets the text again and types on from
        # their progress, the last argument
        queue(room, "load_text", (state["text"], room, state["players"][user_id]["progress"]),
              [user_id])
    queue(room, "room_update", room_state(room))
    return None


def room_between_races(user_id):
    """The room of a socket when no race runs in it. Returns the room and
    None, or None and the error. Hold state_lock."""
    room = PLAYER_ROOMS.get(user_id)
    if room is None:
        return None, "not in a room"
    if ROOM_LIST[room]["status"] in ("countdown", "playing"):
        return None, "game already running"
    return room, None


def next_deadline():
    """When the clock has something to do: the earliest countdown end or race
    time limit, None without either. Hold state_lock."""
    deadlines = [state["starts_at"] if state["status"] == "countdown"
                 else state["started_at"] + RACE_SECONDS
                 for state in ROOM_LIST.values() if state["status"] in ("countdown", "playing")]
    return min(deadlines, default=None)


def tick():
    """Send the text of countdowns that are over, end races past the time limit."""
    now = time.monotonic()
    try:
        with state_lock:
            for room, state in ROOM_LIST.items():
                try:
                    if state["status"] == "countdown" and now >= state["starts_at"]:
                        start_race(room, now)
                    elif state["status"] == "playing" and now >= state["started_at"] + RACE_SECONDS:
                        finish_race(room)
                except Exception:
                    # A broken room must not hold back the rooms after it. It
                    # goes back to waiting, or its passed deadline would wake
                    # the clock again right away.
                    log.exception("room %s failed, back to waiting", room)
                    state.update(status="waiting", **race_fields())
                    queue(room, "room_update", room_state(room))
    finally:
        # rooms changed before an error still get their messages
        flush()


def room_clock():
    """One thread for every room's timers. It sleeps until the next deadline,
    or until a new countdown wakes it."""
    while True:
        try:
            with state_lock:
                deadline = next_deadline()
            # at most an hour, Event.wait() can't take a huge RACE_SECONDS
            clock_wakeup.wait(None if deadline is None
                              else min(max(0, deadline - time.monotonic()), 3600))
            # cleared before tick() reads the rooms, so a countdown started meanwhile
            # is either in this tick or wakes the next wait
            clock_wakeup.clear()
            tick()
        except Exception:
            log.exception("room clock")
            socketio.sleep(1)


def ensure_clock():
    """Start the room clock, again if it stopped or couldn't start before.
    Returns whether it runs."""
    global clock_thread
    with clock_lock:
        if clock_thread is None or not clock_thread.is_alive():
            try:
                clock_thread = socketio.start_background_task(room_clock)
            except RuntimeError:
                log.exception("can't start the room clock, trying again with the next start")
                return False
        return True


@app.get("/healthz")
def healthz():
    return {"status": "ok", "rooms": len(ROOM_LIST), "players": len(PLAYER_ROOMS),
            "sockets": connection_limits.total}


# Handlers take *_ so extra arguments from a client don't raise TypeError.

@socketio.on("connect")
def handle_connect(auth=None, *_):
    with state_lock:
        CONNECTED.add(request.sid)


@socketio.on("disconnect")
def handle_disconnect(reason=None, *_):
    with state_lock:
        CONNECTED.discard(request.sid)
        remove_player(request.sid)
    flush()
    for limiter in (PROGRESS_LIMIT, FINISH_LIMIT, ACTION_LIMIT):
        limiter.forget(request.sid)


@socketio.on("join")
@rate_limited(ACTION_LIMIT)
def handle_join(data=None, *_):
    if not isinstance(data, dict):
        return {"ok": False, "error": "invalid request"}
    # Codes are lowercase, phone keyboards like to capitalize the first letter.
    # Only ASCII spaces and line breaks are stripped: JavaScript's trim()
    # strips them too, so the client already uses the same code. Python's
    # strip() would also drop characters like U+001F, which trim() keeps.
    room = str(data.get("room_id", "")).strip(" \t\n\r\f\v").lower()
    if not ROOM_ID_PATTERN.fullmatch(room):
        return {"ok": False, "error": "invalid room id"}
    username = clean_username(data.get("username"))
    player_id = data.get("player_id")
    if not isinstance(player_id, str) or not PLAYER_ID_PATTERN.fullmatch(player_id):
        player_id = None
    # only used when this join creates the room
    language = data.get("language")
    if not isinstance(language, str) or language not in TEXTS:
        language = DEFAULT_LANGUAGE

    with state_lock:
        error = add_player(room, request.sid, username, player_id, language)
    flush()
    return {"ok": False, "error": error} if error else {"ok": True}


@socketio.on("leave")
@rate_limited(ACTION_LIMIT)
def handle_leave(data=None, *_):
    with state_lock:
        remove_player(request.sid)
    flush()


@socketio.on("set_language")
@rate_limited(ACTION_LIMIT)
def handle_set_language(data=None, *_):
    language = data.get("language") if isinstance(data, dict) else None
    if not isinstance(language, str) or language not in TEXTS:
        return {"ok": False, "error": "invalid language"}
    with state_lock:
        room, error = room_between_races(request.sid)
        if error:
            return {"ok": False, "error": error}
        ROOM_LIST[room]["language"] = language
        queue(room, "room_update", room_state(room))
    flush()
    return {"ok": True}


@socketio.on("game_start")
@rate_limited(ACTION_LIMIT)
def handle_game_start(data=None, *_):
    # without the clock the countdown would never end, and nobody could press Start again
    if not ensure_clock():
        return {"ok": False, "error": "server busy, try again"}
    with state_lock:
        room, error = room_between_races(request.sid)
        if error:
            return {"ok": False, "error": error}
        # the room clock sends the text when the countdown is over
        ROOM_LIST[room].update(status="countdown",
                               **race_fields(starts_at=time.monotonic() + COUNTDOWN_SECONDS))
        for player in ROOM_LIST[room]["players"].values():
            player["progress"] = 0
        queue(room, "room_update", room_state(room))
    flush()
    clock_wakeup.set()
    return {"ok": True}


@socketio.on("progress")
def handle_progress(data=None, *_):
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
    if not (FINISH_LIMIT if progress >= 100 else PROGRESS_LIMIT).allow(user_id):
        return

    with state_lock:
        room = PLAYER_ROOMS.get(user_id)
        if room is None:
            return
        state = ROOM_LIST[room]
        # players who joined mid-race never got the text, they watch
        if state["status"] != "playing" or user_id not in state["racers"]:
            return
        if progress >= 100:
            finish_race(room, winner_id=user_id)
        else:
            state["players"][user_id]["progress"] = progress
            queue(room, "progress_percentage", {"room": room, "user_id": user_id, "progress": progress})
    flush()


if __name__ == "__main__":
    socketio.run(app, port=int(os.environ.get("PORT", 5001)), debug=True)
