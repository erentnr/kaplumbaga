import unicodedata

import pytest

import game


def reset_state():
    for state in (game.ROOM_LIST, game.PLAYER_ROOMS, game.CONNECTIONS, game.SOCKET_IPS):
        state.clear()
    for limiter in (game.PROGRESS_LIMIT, game.ACTION_LIMIT, game.CONNECT_LIMIT):
        limiter.clear()


@pytest.fixture(autouse=True)
def clean_state():
    reset_state()
    yield
    reset_state()


@pytest.fixture(autouse=True)
def instant_countdown(monkeypatch):
    """Run the countdown timer inline, so game_start sends the text right away."""
    monkeypatch.setattr(game, "COUNTDOWN_SECONDS", 0)
    monkeypatch.setattr(game.socketio, "start_background_task",
                        lambda target, *args: target(*args))


@pytest.fixture
def paused_countdown(monkeypatch):
    """Keep countdown timers until the test runs them."""
    timers = []
    monkeypatch.setattr(game, "COUNTDOWN_SECONDS", 3)
    monkeypatch.setattr(game.socketio, "sleep", lambda seconds: None)
    monkeypatch.setattr(game.socketio, "start_background_task",
                        lambda target, *args: timers.append(lambda: target(*args)))
    return timers


def connect(username, room="abc12", language=None):
    client = game.socketio.test_client(game.app)
    data = {"room_id": room, "username": username}
    if language:
        data["language"] = language
    assert client.emit("join", data, callback=True) == {"ok": True}
    return client


def status(room="abc12"):
    return game.ROOM_LIST[room]["status"]


def events(client, name):
    return [msg["args"][0] if msg["args"] else None
            for msg in client.get_received() if msg["name"] == name]


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


def test_username_is_trimmed_and_capped():
    client = connect("  " + "x" * 100 + "  ")
    state = events(client, "room_update")[-1]
    (player,) = state["players"].values()
    assert player["username"] == "x" * game.MAX_USERNAME_LENGTH


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
    alice.emit("game_start")
    assert events(bob, "load_text") == [game.TEXTS["en"]]
    assert events(alice, "load_text") == [game.TEXTS["en"]]

    # a second start while playing is ignored
    assert bob.emit("game_start", callback=True)["ok"] is False

    bob.emit("progress", {"progress": 50})
    assert events(alice, "progress_percentage")[-1]["progress"] == 50

    alice_id = next(sid for sid, p in game.ROOM_LIST["abc12"]["players"].items()
                    if p["username"] == "alice")
    alice.emit("progress", {"progress": 100})
    assert events(bob, "finish_game") == [{"winner": "alice", "winner_id": alice_id}]
    assert game.ROOM_LIST["abc12"]["status"] == "finished"

    # progress after the game ended is ignored, a new game resets progress
    bob.emit("progress", {"progress": 100})
    assert events(bob, "finish_game") == []
    assert game.ROOM_LIST["abc12"]["winner"] == "alice"
    bob.emit("game_start")
    assert all(p["progress"] == 0 for p in game.ROOM_LIST["abc12"]["players"].values())


def test_progress_is_validated():
    alice = connect("alice")
    alice.emit("progress", {"progress": 100})  # game not started
    assert game.ROOM_LIST["abc12"]["status"] == "waiting"
    alice.emit("game_start")
    alice.emit("progress", {"progress": "lots"})
    alice.emit("progress", {"progress": -20})
    (player,) = game.ROOM_LIST["abc12"]["players"].values()
    assert player["progress"] == 0


@pytest.mark.parametrize("value", ["nan", "NaN", float("nan"), "inf", "-inf"])
def test_non_finite_progress_is_rejected(value):
    alice = connect("alice")
    bob = connect("bob")
    alice.emit("game_start")
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
    victim_sid = next(sid for sid, p in game.ROOM_LIST["room2"]["players"].items()
                      if p["username"] == "victim")
    victim.get_received()

    attacker = connect("attacker", room=victim_sid)
    attacker.emit("game_start")
    attacker.emit("progress", {"progress": 100})
    assert victim.get_received() == []
    assert game.ROOM_LIST["room2"]["status"] == "waiting"


def test_progress_from_stranger_is_ignored():
    connect("alice")
    stranger = game.socketio.test_client(game.app)
    stranger.emit("progress", {"progress": 100})
    assert game.ROOM_LIST["abc12"]["status"] == "waiting"


def test_countdown_comes_before_the_text(paused_countdown):
    alice = connect("alice")
    bob = connect("bob")
    bob.get_received()
    alice.emit("game_start")

    received = bob.get_received()
    assert [msg["name"] for msg in received] == ["room_update"]
    state = received[0]["args"][0]
    assert state["status"] == "countdown"
    assert 0 < state["starts_in"] <= game.COUNTDOWN_SECONDS

    # nothing can start, change or score while counting down
    assert bob.emit("game_start", callback=True)["ok"] is False
    assert bob.emit("set_language", {"language": "de"}, callback=True)["ok"] is False
    bob.emit("progress", {"progress": 100})
    assert status() == "countdown"
    assert events(alice, "finish_game") == []

    (timer,) = paused_countdown
    timer()
    received = bob.get_received()
    assert [msg["name"] for msg in received] == ["load_text", "room_update"]
    assert received[0]["args"][0] == game.TEXTS["en"]
    assert received[1]["args"][0]["status"] == "playing"
    assert "starts_in" not in received[1]["args"][0]


def test_late_joiner_during_countdown_gets_the_text(paused_countdown):
    alice = connect("alice")
    alice.emit("game_start")
    carol = connect("carol")
    assert events(carol, "room_update")[-1]["status"] == "countdown"
    paused_countdown[0]()
    assert events(carol, "load_text") == [game.TEXTS["en"]]


def test_countdown_of_a_deleted_room_does_nothing(paused_countdown):
    alice = connect("alice")
    alice.emit("game_start")
    alice.emit("leave")
    assert game.ROOM_LIST == {}
    # same room code created again while the old timer is pending
    bob = connect("bob")
    paused_countdown[0]()
    assert status() == "waiting"
    assert events(bob, "load_text") == []


def test_room_language_comes_from_the_creator():
    alice = connect("alice", language="de")
    connect("bob", language="fr")
    assert events(alice, "room_update")[-1]["language"] == "de"
    alice.emit("game_start")
    assert events(alice, "load_text") == [game.TEXTS["de"]]


def test_unknown_language_falls_back_to_default():
    alice = connect("alice", language="xx")
    assert events(alice, "room_update")[-1]["language"] == game.DEFAULT_LANGUAGE


def test_set_language_is_broadcast_and_used_for_the_next_race():
    alice = connect("alice")
    bob = connect("bob")
    bob.get_received()
    assert alice.emit("set_language", {"language": "tr"}, callback=True) == {"ok": True}
    assert events(bob, "room_update")[-1]["language"] == "tr"
    bob.emit("game_start")
    assert events(alice, "load_text") == [game.TEXTS["tr"]]


@pytest.mark.parametrize("payload", [{"language": "xx"}, {}, "tr", None])
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
    alice.emit("game_start")
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
    alice.emit("game_start")
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


def test_rate_limits_are_per_socket(clock):
    alice = connect("alice")
    bob = connect("bob")
    for _ in range(game.ACTION_LIMIT.burst):
        alice.emit("set_language", {"language": "de"})
    assert bob.emit("set_language", {"language": "es"}, callback=True) == {"ok": True}


def from_ip(ip):
    return game.socketio.test_client(game.app, headers={"CF-Connecting-IP": ip})


def test_open_connections_per_ip_are_limited(monkeypatch):
    monkeypatch.setattr(game, "TRUSTED_IP_HEADER", "CF-Connecting-IP")
    monkeypatch.setattr(game, "MAX_CONNECTIONS_PER_IP", 3)
    clients = [from_ip("203.0.113.1") for _ in range(3)]
    assert all(client.is_connected() for client in clients)
    assert not from_ip("203.0.113.1").is_connected()
    assert from_ip("203.0.113.2").is_connected()
    # a closed connection frees its slot
    clients[0].disconnect()
    assert from_ip("203.0.113.1").is_connected()


def test_new_connections_per_ip_are_rate_limited(monkeypatch, clock):
    monkeypatch.setattr(game, "TRUSTED_IP_HEADER", "CF-Connecting-IP")
    monkeypatch.setattr(game, "CONNECT_LIMIT", game.RateLimiter(rate=0.5, burst=2))
    for _ in range(2):
        from_ip("203.0.113.1").disconnect()
    assert not from_ip("203.0.113.1").is_connected()
    clock.advance(2)
    assert from_ip("203.0.113.1").is_connected()


def test_ip_header_is_ignored_unless_trusted(monkeypatch):
    # without a trusted proxy anyone could send the header with a new IP
    monkeypatch.setattr(game, "MAX_CONNECTIONS_PER_IP", 2)
    assert from_ip("203.0.113.1").is_connected()
    assert from_ip("203.0.113.2").is_connected()
    assert not from_ip("203.0.113.3").is_connected()


def test_rate_limiter_forgets_full_buckets(clock):
    limiter = game.RateLimiter(rate=1, burst=2)
    for key in range(10_001):
        limiter.allow(key)
    clock.advance(5)
    limiter.allow("new")
    assert list(limiter.buckets) == ["new"]


def test_healthz():
    connect("alice")
    response = game.app.test_client().get("/healthz")
    assert response.json == {"status": "ok", "rooms": 1, "players": 1}
