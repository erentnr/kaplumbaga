import pathlib
import re
import threading
import time
import unicodedata

import pytest
from werkzeug.test import EnvironBuilder

import game


def reset_state():
    for state in (game.ROOM_LIST, game.PLAYER_ROOMS, game.CONNECTED_AT,
                  game.connection_limits.per_client):
        state.clear()
    game.connection_limits.total = 0
    game.clock_started = False
    for limiter in (game.PROGRESS_LIMIT, game.ACTION_LIMIT, game.CONNECT_LIMIT):
        limiter.clear()


@pytest.fixture(autouse=True)
def clean_state():
    reset_state()
    yield
    reset_state()


@pytest.fixture(autouse=True)
def no_typing_speed_check(monkeypatch):
    """Tests send progress instantly, the typing speed check has its own tests."""
    monkeypatch.setattr(game, "MAX_CHARS_PER_SECOND", 0)


@pytest.fixture(autouse=True)
def background_tasks(monkeypatch):
    """No real threads: tests run the room clock with tick(). Returns the
    functions the server tried to start in the background."""
    started = []
    monkeypatch.setattr(game, "COUNTDOWN_SECONDS", 0)
    monkeypatch.setattr(game.socketio, "start_background_task",
                        lambda target, *args: started.append(target))
    return started


def start(client):
    """Press Start and let the room clock end the (zero second) countdown."""
    reply = client.emit("game_start", callback=True)
    game.tick()
    return reply


def connect(username, room="abc12", language=None):
    client = game.socketio.test_client(game.app)
    data = {"room_id": room, "username": username}
    if language:
        data["language"] = language
    assert client.emit("join", data, callback=True) == {"ok": True}
    return client


def status(room="abc12"):
    return game.ROOM_LIST[room]["status"]


def names(room="abc12"):
    return sorted(p["username"] for p in game.ROOM_LIST[room]["players"].values())


def sid_of(username, room="abc12"):
    return next(sid for sid, p in game.ROOM_LIST[room]["players"].items()
                if p["username"] == username)


def events(client, name):
    return [msg["args"][0] if msg["args"] else None
            for msg in client.get_received() if msg["name"] == name]


def texts(client):
    return [data["text"] for data in events(client, "load_text")]


def finishes(client):
    return [{"winner": data["winner"], "winner_id": data["winner_id"]}
            for data in events(client, "finish_game")]


def test_join_broadcasts_players():
    alice = connect("alice")
    bob = connect("bob")
    state = events(alice, "room_update")[-1]
    assert sorted(p["username"] for p in state["players"].values()) == ["alice", "bob"]
    assert state["status"] == "waiting"
    assert events(bob, "room_update")[-1] == state


def test_join_rejects_bad_room_id():
    client = game.socketio.test_client(game.app)
    assert client.emit("join", {"room_id": "../etc", "username": "x"}, callback=True)["ok"] is False
    assert game.ROOM_LIST == {}


def test_room_id_with_a_newline_never_makes_a_separate_room():
    # with re.match and $, "abc\n" was a different room than "abc"
    connect("alice", room="abc")
    connect("bob", room="abc\n")
    assert list(game.ROOM_LIST) == ["abc"]
    client = game.socketio.test_client(game.app)
    assert client.emit("join", {"room_id": "ab\nc", "username": "x"}, callback=True) == {
        "ok": False, "error": "invalid room id"}


def test_room_codes_are_not_case_sensitive():
    # phone keyboards capitalize the first letter
    connect("alice", room="xk3mp")
    connect("bob", room="Xk3mp")
    assert list(game.ROOM_LIST) == ["xk3mp"]
    assert names("xk3mp") == ["alice", "bob"]


@pytest.mark.parametrize("payload", ["just a string", None, ["abc12"]])
def test_join_with_a_bad_payload_gets_an_error(payload):
    client = game.socketio.test_client(game.app)
    assert client.emit("join", payload, callback=True) == {"ok": False, "error": "invalid request"}


@pytest.mark.parametrize("event", ["join", "set_language", "progress", "game_start", "leave"])
def test_events_without_data_do_not_crash(event, caplog):
    client = game.socketio.test_client(game.app)
    client.emit(event, callback=True)
    assert not [r for r in caplog.records if r.levelname == "ERROR"]


def test_join_with_a_non_string_language_uses_the_default():
    client = game.socketio.test_client(game.app)
    data = {"room_id": "abc12", "username": "alice", "language": ["tr"]}
    assert client.emit("join", data, callback=True) == {"ok": True}
    assert game.ROOM_LIST["abc12"]["language"] == game.DEFAULT_LANGUAGE


def test_username_is_trimmed_and_capped():
    client = connect("  " + "x" * 100 + "  ")
    state = events(client, "room_update")[-1]
    (player,) = state["players"].values()
    assert player["username"] == "x" * game.MAX_USERNAME_LENGTH


def test_username_keeps_joiners_of_emoji_and_words():
    # zero width joiner builds 👨‍👩‍👧, zero width non-joiner is part of Persian words
    connect("\U0001f468\u200d\U0001f469\u200d\U0001f467")
    connect("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645")
    assert set(names()) == {"\U0001f468\u200d\U0001f469\u200d\U0001f467",
                            "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645"}


def test_username_control_and_direction_characters_are_removed():
    # a line break could fake a log line, U+202E reverses the text others see
    connect("ali\nce‮​\x07  ")
    assert names() == ["ali ce"]
    connect("‮ ")
    assert names() == ["ali ce", "player"]


def test_duplicate_names_in_a_room_get_a_number():
    for _ in range(3):
        connect("player417")
    assert names() == ["player417", "player417 2", "player417 3"]
    long_name = "x" * game.MAX_USERNAME_LENGTH
    connect(long_name)
    connect(long_name)
    assert "x" * (game.MAX_USERNAME_LENGTH - 2) + " 2" in names()


def test_disconnect_notifies_room_and_cleans_up():
    alice = connect("alice")
    bob = connect("bob")
    alice.get_received()
    bob.disconnect()
    state = events(alice, "room_update")[-1]
    assert [p["username"] for p in state["players"].values()] == ["alice"]
    alice.disconnect()
    assert game.ROOM_LIST == {} and game.PLAYER_ROOMS == {}


def test_leave_only_affects_own_room():
    alice = connect("alice", room="room1")
    bob = connect("bob", room="room1")
    connect("carol", room="room2")
    alice.get_received()
    bob.emit("leave", {"room_id": "room1"})
    state = events(alice, "room_update")[-1]
    assert [p["username"] for p in state["players"].values()] == ["alice"]
    assert len(game.ROOM_LIST["room2"]["players"]) == 1


def test_joining_another_room_leaves_the_old_one():
    alice = connect("alice", room="room1")
    bob = connect("bob", room="room1")
    alice.get_received()
    bob.emit("join", {"room_id": "room2", "username": "bob"})
    state = events(alice, "room_update")[-1]
    assert [p["username"] for p in state["players"].values()] == ["alice"]


def test_full_game_flow():
    alice = connect("alice")
    bob = connect("bob")
    start(alice)
    assert texts(bob) == [game.TEXTS["en"]]
    assert texts(alice) == [game.TEXTS["en"]]

    # a second start while playing is ignored
    assert bob.emit("game_start", callback=True)["ok"] is False

    bob.emit("progress", {"progress": 50})
    assert events(alice, "progress_percentage")[-1]["progress"] == 50

    alice_id = sid_of("alice")
    alice.emit("progress", {"progress": 100})
    assert finishes(bob) == [{"winner": "alice", "winner_id": alice_id}]
    assert status() == "finished"
    assert game.ROOM_LIST["abc12"]["winner_id"] == alice_id

    # progress after the game ended is ignored, a new game resets progress
    bob.emit("progress", {"progress": 100})
    assert events(bob, "finish_game") == []
    assert game.ROOM_LIST["abc12"]["winner"] == "alice"
    start(bob)
    assert all(p["progress"] == 0 for p in game.ROOM_LIST["abc12"]["players"].values())


def test_progress_is_validated():
    alice = connect("alice")
    alice.emit("progress", {"progress": 100})  # game not started
    assert status() == "waiting"
    start(alice)
    alice.emit("progress", {"progress": "lots"})
    alice.emit("progress", {"progress": -20})
    alice.emit("progress", ["not", "a", "dict"])
    (player,) = game.ROOM_LIST["abc12"]["players"].values()
    assert player["progress"] == 0


@pytest.mark.parametrize("value", ["nan", "NaN", float("nan"), "inf", "-inf"])
def test_non_finite_progress_is_rejected(value):
    alice = connect("alice")
    bob = connect("bob")
    start(alice)
    bob.get_received()
    alice.emit("progress", {"progress": value})
    assert events(bob, "progress_percentage") == []
    assert events(bob, "finish_game") == []
    assert all(p["progress"] == 0 for p in game.ROOM_LIST["abc12"]["players"].values())


def test_room_named_after_a_socket_id_does_not_reach_that_player():
    # every socket is also in a private socket.io room named after its sid,
    # and sids are broadcast to room members as player ids
    connect("alice")
    victim = connect("victim", room="room2")
    victim_sid = sid_of("victim", room="room2")
    victim.get_received()

    attacker = connect("attacker", room=victim_sid.lower())
    start(attacker)
    attacker.emit("progress", {"progress": 100})
    assert victim.get_received() == []
    assert status("room2") == "waiting"


def test_progress_from_stranger_is_ignored():
    connect("alice")
    stranger = game.socketio.test_client(game.app)
    stranger.emit("progress", {"progress": 100})
    assert status() == "waiting"


def test_players_who_joined_mid_race_cannot_finish():
    alice = connect("alice")
    start(alice)
    carol = connect("carol")  # never got the text
    carol.emit("progress", {"progress": 100})
    assert status() == "playing" and game.ROOM_LIST["abc12"]["winner"] is None
    alice.emit("progress", {"progress": 100})
    assert game.ROOM_LIST["abc12"]["winner"] == "alice"


def test_race_ends_when_everyone_racing_has_left():
    alice = connect("alice")
    bob = connect("bob")
    start(alice)
    carol = connect("carol")  # watches the race
    carol.get_received()
    alice.disconnect()
    assert status() == "playing"
    bob.emit("leave")
    assert finishes(carol) == [{"winner": None, "winner_id": None}]
    assert status() == "finished"
    assert start(carol) == {"ok": True}
    assert texts(carol) == [game.TEXTS["en"]]


def test_race_ends_after_the_time_limit(clock):
    alice = connect("alice")
    start(alice)
    alice.get_received()
    clock.advance(game.RACE_SECONDS - 1)
    game.tick()
    assert status() == "playing"
    clock.advance(1)
    game.tick()
    assert finishes(alice) == [{"winner": None, "winner_id": None}]
    assert status() == "finished"
    assert start(alice) == {"ok": True}


def test_time_limit_counts_from_the_current_race(clock):
    alice = connect("alice")
    start(alice)
    alice.emit("progress", {"progress": 100})
    clock.advance(game.RACE_SECONDS - 10)
    start(alice)
    clock.advance(20)  # past the first race's limit, not the second's
    game.tick()
    assert status() == "playing"


def test_races_do_not_start_threads(background_tasks):
    # a thread sleeping through every race's time limit piled up with
    # join, start, leave loops until no new thread could start
    for i in range(50):
        client = connect(f"player{i}", room=f"room{i}")
        start(client)
        client.emit("leave")
    assert background_tasks == [game.room_clock]


def test_progress_cannot_outrun_human_typing(monkeypatch, clock):
    monkeypatch.setattr(game, "MAX_CHARS_PER_SECOND", 20)
    length = len(game.TEXTS["en"])
    alice = connect("alice")
    start(alice)

    def progress():
        return game.ROOM_LIST["abc12"]["players"][sid_of("alice")]["progress"]

    # a devtools one-liner right as the text appears
    alice.emit("progress", {"progress": 99})
    assert progress() == pytest.approx(game.HEAD_START_CHARS / length * 100)
    clock.advance(1)
    alice.emit("progress", {"progress": 99})
    assert progress() == pytest.approx((game.HEAD_START_CHARS + 20) / length * 100)
    assert status() == "playing"


def test_early_finish_counts_once_it_is_plausible(monkeypatch, clock):
    # the client sends nothing after the last word, so a finish that comes
    # too early must not be lost
    monkeypatch.setattr(game, "MAX_CHARS_PER_SECOND", 20)
    plausible_after = (len(game.TEXTS["en"]) - game.HEAD_START_CHARS) / 20
    alice = connect("alice")
    bob = connect("bob")
    start(alice)
    alice.emit("progress", {"progress": 100})
    assert status() == "playing"
    clock.advance(1)
    bob.emit("progress", {"progress": 100})  # later claim
    clock.advance(plausible_after - 1.5)
    game.tick()
    assert status() == "playing"
    bob.get_received()
    clock.advance(1)
    game.tick()
    assert status() == "finished"
    assert finishes(bob) == [{"winner": "alice", "winner_id": sid_of("alice")}]
    assert game.ROOM_LIST["abc12"]["players"][sid_of("alice")]["progress"] == 100


def test_finish_messages_are_rate_limited_too(monkeypatch, clock):
    # 100 used to skip the rate limit, with the speed check it no longer ends
    # the race, so every one of them was broadcast
    monkeypatch.setattr(game, "MAX_CHARS_PER_SECOND", 20)
    alice = connect("alice")
    bob = connect("bob")
    start(alice)
    bob.get_received()
    for _ in range(1000):
        alice.emit("progress", {"progress": 100})
    assert len(events(bob, "progress_percentage")) <= game.PROGRESS_LIMIT.burst
    assert status() == "playing"
    assert sid_of("alice") in game.ROOM_LIST["abc12"]["claims"]


def test_messages_are_never_sent_while_holding_the_state_lock(monkeypatch):
    # a send can close a socket that stopped answering pings, and engineio
    # then runs handle_disconnect in the same thread, which needs the lock
    sent = []
    real_emit = game.socketio.emit

    def recording_emit(event, *args, **kwargs):
        sent.append((event, game.state_lock.locked()))
        return real_emit(event, *args, **kwargs)

    monkeypatch.setattr(game.socketio, "emit", recording_emit)
    alice = connect("alice")
    bob = connect("bob")
    alice.emit("set_language", {"language": "de"})
    start(alice)
    bob.emit("progress", {"progress": 30})
    alice.emit("progress", {"progress": 100})
    bob.emit("join", {"room_id": "other", "username": "bob"})
    alice.disconnect()
    assert {event for event, _ in sent} == {
        "room_update", "load_text", "progress_percentage", "finish_game"}
    assert not any(locked for _, locked in sent), sent


def test_a_socket_closing_while_messages_are_sent_does_not_deadlock(monkeypatch):
    alice = connect("alice")
    bob = connect("bob")
    start(alice)
    real_emit = game.socketio.emit
    closed = []

    def emit_and_close_bob(event, *args, **kwargs):
        # what engineio does when a send finds a client that stopped answering pings
        if event == "progress_percentage" and not closed:
            closed.append(True)
            bob.disconnect()
        return real_emit(event, *args, **kwargs)

    monkeypatch.setattr(game.socketio, "emit", emit_and_close_bob)
    done = threading.Event()
    threading.Thread(target=lambda: (alice.emit("progress", {"progress": 10}), done.set()),
                     daemon=True).start()
    assert done.wait(3), "server deadlocked"
    assert names() == ["alice"]


def test_messages_carry_increasing_room_versions():
    # sent outside the lock, messages can arrive out of order: clients drop
    # anything older than the newest version they have seen
    alice = connect("alice")
    bob = connect("bob")
    start(alice)
    alice.emit("progress", {"progress": 100})
    versions = [msg["args"][0]["version"] for msg in alice.get_received()
                if msg["name"] in ("room_update", "load_text", "finish_game")]
    assert len(versions) >= 5
    assert versions == sorted(versions)
    assert len(set(versions)) >= 4


def test_events_of_a_client_are_handled_in_order():
    # with async handlers every event gets its own thread, in any order
    assert game.socketio.server.async_handlers is False


def test_sockets_without_a_room_are_closed(clock):
    idle = game.socketio.test_client(game.app)
    player = connect("alice")
    clock.advance(game.ROOMLESS_SECONDS + 1)
    game.tick()
    assert not idle.is_connected()
    assert player.is_connected()
    assert list(game.CONNECTED_AT) == [sid_of("alice")]


@pytest.fixture
def countdown(monkeypatch, clock):
    monkeypatch.setattr(game, "COUNTDOWN_SECONDS", 3)
    return clock


def test_countdown_comes_before_the_text(countdown):
    alice = connect("alice")
    bob = connect("bob")
    bob.get_received()
    alice.emit("game_start")

    received = bob.get_received()
    assert [msg["name"] for msg in received] == ["room_update"]
    state = received[0]["args"][0]
    assert state["status"] == "countdown"
    assert state["starts_in"] == 3

    # nothing can start, change or score while counting down
    assert bob.emit("game_start", callback=True)["ok"] is False
    assert bob.emit("set_language", {"language": "de"}, callback=True)["ok"] is False
    bob.emit("progress", {"progress": 100})
    countdown.advance(2.9)
    game.tick()
    assert status() == "countdown"
    assert events(alice, "finish_game") == []

    countdown.advance(0.1)
    game.tick()
    received = bob.get_received()
    assert [msg["name"] for msg in received] == ["load_text", "room_update"]
    assert received[0]["args"][0]["text"] == game.TEXTS["en"]
    assert received[1]["args"][0]["status"] == "playing"
    assert "starts_in" not in received[1]["args"][0]


def test_late_joiner_during_countdown_gets_the_text(countdown):
    alice = connect("alice")
    alice.emit("game_start")
    carol = connect("carol")
    assert events(carol, "room_update")[-1]["status"] == "countdown"
    countdown.advance(3)
    game.tick()
    assert texts(carol) == [game.TEXTS["en"]]
    assert sid_of("carol") in game.ROOM_LIST["abc12"]["racers"]


def test_countdown_of_a_deleted_room_does_nothing(countdown):
    alice = connect("alice")
    alice.emit("game_start")
    alice.emit("leave")
    assert game.ROOM_LIST == {}
    # same room code created again
    bob = connect("bob")
    countdown.advance(3)
    game.tick()
    assert status() == "waiting"
    assert events(bob, "load_text") == []


def test_room_language_comes_from_the_creator():
    alice = connect("alice", language="de")
    connect("bob", language="fr")
    assert events(alice, "room_update")[-1]["language"] == "de"
    start(alice)
    assert texts(alice) == [game.TEXTS["de"]]


def test_unknown_language_falls_back_to_default():
    alice = connect("alice", language="xx")
    assert events(alice, "room_update")[-1]["language"] == game.DEFAULT_LANGUAGE


def test_set_language_is_broadcast_and_used_for_the_next_race():
    alice = connect("alice")
    bob = connect("bob")
    bob.get_received()
    assert alice.emit("set_language", {"language": "tr"}, callback=True) == {"ok": True}
    assert events(bob, "room_update")[-1]["language"] == "tr"
    start(bob)
    assert texts(alice) == [game.TEXTS["tr"]]


@pytest.mark.parametrize("payload", [{"language": "xx"}, {}, "tr", None, {"language": ["tr"]}])
def test_set_language_rejects_bad_input(payload):
    alice = connect("alice")
    assert alice.emit("set_language", payload, callback=True)["ok"] is False
    assert game.ROOM_LIST["abc12"]["language"] == game.DEFAULT_LANGUAGE


def test_every_language_has_a_typable_text():
    assert set(game.TEXTS) == {"tr", "en", "pt", "de", "fr", "es"}
    for text in game.TEXTS.values():
        # the client splits on single spaces and matches word by word
        assert text == text.strip() and "  " not in text and "\n" not in text
        # the client compares NFC normalized input
        assert unicodedata.is_normalized("NFC", text)


class FakeTime:
    """Stands in for the time module in game.py, the clock only moves when told."""

    def __init__(self):
        self.now = 1000.0

    def monotonic(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


@pytest.fixture
def clock(monkeypatch):
    fake = FakeTime()
    monkeypatch.setattr(game, "time", fake)
    return fake


def test_progress_flood_is_limited_but_the_finish_gets_through(clock):
    alice = connect("alice")
    bob = connect("bob")
    start(alice)
    bob.get_received()
    for i in range(1, 100):
        alice.emit("progress", {"progress": i})
    alice.emit("progress", {"progress": 100})
    updates = events(bob, "progress_percentage")
    assert len(updates) == game.PROGRESS_LIMIT.burst + 1
    assert updates[-1]["progress"] == 100
    assert game.ROOM_LIST["abc12"]["winner"] == "alice"


def test_progress_limit_refills_over_time(clock):
    alice = connect("alice")
    start(alice)
    alice.get_received()
    for _ in range(game.PROGRESS_LIMIT.burst + 5):
        alice.emit("progress", {"progress": 10})
    assert len(events(alice, "progress_percentage")) == game.PROGRESS_LIMIT.burst
    clock.advance(1)
    for _ in range(100):
        alice.emit("progress", {"progress": 20})
    assert len(events(alice, "progress_percentage")) == game.PROGRESS_LIMIT.rate


def test_actions_are_limited(clock):
    alice = connect("alice")  # join is the first action
    for _ in range(game.ACTION_LIMIT.burst - 1):
        assert alice.emit("set_language", {"language": "de"}, callback=True) == {"ok": True}
    limited = alice.emit("set_language", {"language": "fr"}, callback=True)
    assert limited == {"ok": False, "error": "too many requests"}
    assert game.ROOM_LIST["abc12"]["language"] == "de"
    clock.advance(1)
    assert alice.emit("set_language", {"language": "fr"}, callback=True) == {"ok": True}


def test_leave_is_never_rate_limited(clock):
    # a dropped leave would keep a ghost player in the room
    connect("alice", room="room1")
    bob = connect("bob", room="room1")
    for _ in range(game.ACTION_LIMIT.burst):
        bob.emit("set_language", {"language": "de"})
    assert bob.emit("set_language", {"language": "es"}, callback=True)["ok"] is False
    bob.emit("leave")
    assert names("room1") == ["alice"]


def test_rate_limits_are_per_socket(clock):
    alice = connect("alice")
    bob = connect("bob")
    for _ in range(game.ACTION_LIMIT.burst):
        alice.emit("set_language", {"language": "de"})
    assert bob.emit("set_language", {"language": "es"}, callback=True) == {"ok": True}


def test_rate_limiter_cleans_up_at_most_once_a_minute(monkeypatch, clock):
    limiter = game.RateLimiter(rate=1, burst=2)
    cleanups = []
    drop_full_buckets = limiter._drop_full_buckets
    monkeypatch.setattr(limiter, "_drop_full_buckets",
                        lambda now: (cleanups.append(now), drop_full_buckets(now)))
    for key in range(10_100):
        limiter.allow(key)
    assert len(cleanups) == 1
    clock.advance(61)
    limiter.allow("new")
    assert len(cleanups) == 2
    assert list(limiter.buckets) == ["new"]


class HeldSockets:
    """Requests through ConnectionLimits, with an inner app that keeps socket.io
    requests with ?hold open like websockets until release()."""

    def __init__(self):
        self.released = threading.Event()
        self.threads = []
        self.limits = game.ConnectionLimits(self.app)

    def app(self, environ, start_response):
        start_response("200 OK", [])
        if "hold" in environ.get("QUERY_STRING", ""):
            self.released.wait(5)
        return [b"ok"]

    def request(self, ip, path="/socket.io/?EIO=4&transport=websocket", header_ip=None):
        """Returns the HTTP status of a request that isn't held."""
        headers = {"CF-Connecting-IP": header_ip} if header_ip else {}
        environ = EnvironBuilder(path=path, headers=headers,
                                 environ_base={"REMOTE_ADDR": ip}).get_environ()
        statuses = []
        b"".join(self.limits(environ, lambda status, headers: statuses.append(status)))
        return int(statuses[0].split()[0])

    def hold(self, ip):
        """Opens a held connection. Returns 200 once it is counted, or the refusal status."""
        before = self.limits.total
        result = []
        thread = threading.Thread(
            target=lambda: result.append(self.request(ip, "/socket.io/?hold=1")))
        thread.start()
        self.threads.append(thread)
        deadline = time.monotonic() + 2
        while not result and self.limits.total == before:
            if time.monotonic() > deadline:
                raise AssertionError("connection was neither counted nor refused")
            time.sleep(0.001)
        return result[0] if result else 200

    def release(self):
        self.released.set()
        for thread in self.threads:
            thread.join()


@pytest.fixture
def sockets():
    held = HeldSockets()
    yield held
    held.release()


def test_sockets_per_client_are_limited(monkeypatch, sockets):
    monkeypatch.setattr(game, "MAX_SOCKETS_PER_CLIENT", 3)
    assert [sockets.hold("203.0.113.1") for _ in range(3)] == [200, 200, 200]
    assert sockets.hold("203.0.113.1") == 429
    assert sockets.hold("203.0.113.2") == 200
    sockets.release()
    # closed connections free their slots
    assert sockets.limits.total == 0 and sockets.limits.per_client == {}
    assert sockets.request("203.0.113.1") == 200


def test_total_sockets_stay_below_the_thread_pool(monkeypatch, sockets):
    monkeypatch.setattr(game, "MAX_SOCKETS", 2)
    assert sockets.hold("203.0.113.1") == 200
    assert sockets.hold("203.0.113.2") == 200
    assert sockets.hold("203.0.113.3") == 429
    # health checks and other requests are never limited
    assert sockets.request("203.0.113.3", path="/healthz") == 200


def test_new_connections_are_rate_limited(monkeypatch, clock, sockets):
    monkeypatch.setattr(game, "CONNECT_LIMIT", game.RateLimiter(rate=0.5, burst=2))
    assert sockets.request("203.0.113.1") == 200
    assert sockets.request("203.0.113.1") == 200
    assert sockets.request("203.0.113.1") == 429
    assert sockets.request("203.0.113.2") == 200
    clock.advance(2)
    assert sockets.request("203.0.113.1") == 200


def test_ipv6_clients_count_per_64(monkeypatch, sockets):
    # one IPv6 client can pick from a whole /64 of addresses
    monkeypatch.setattr(game, "MAX_SOCKETS_PER_CLIENT", 2)
    assert sockets.hold("2001:db8:1:2::1") == 200
    assert sockets.hold("2001:db8:1:2::ffff") == 200
    assert sockets.hold("2001:db8:1:2:abcd::5") == 429
    assert sockets.hold("2001:db8:1:3::1") == 200


def test_client_key():
    environ = {"REMOTE_ADDR": "172.19.0.3", "HTTP_CF_CONNECTING_IP": "203.0.113.7"}
    # the header is ignored unless a trusted proxy sets it
    assert game.client_key(environ) == "172.19.0.3"
    game.TRUSTED_IP_HEADER, trusted = "CF-Connecting-IP", game.TRUSTED_IP_HEADER
    try:
        assert game.client_key(environ) == "203.0.113.7"
        assert game.client_key({**environ, "HTTP_CF_CONNECTING_IP": "::ffff:203.0.113.7"}) == "203.0.113.7"
        assert game.client_key({**environ, "HTTP_CF_CONNECTING_IP": "2001:db8::1"}) == "2001:db8::/64"
        assert game.client_key({"REMOTE_ADDR": "172.19.0.3"}) == "172.19.0.3"
    finally:
        game.TRUSTED_IP_HEADER = trusted


def test_socket_limit_leaves_gunicorn_threads_for_health_checks():
    dockerfile = (pathlib.Path(__file__).parent / "Dockerfile").read_text()
    threads = int(re.search(r'"--threads", "(\d+)"', dockerfile).group(1))
    assert game.MAX_SOCKETS <= threads - 10


def test_healthz():
    connect("alice")
    response = game.app.test_client().get("/healthz")
    assert response.json == {"status": "ok", "rooms": 1, "players": 1, "sockets": 0}
