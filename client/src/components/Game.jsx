import { Fragment, useState, useEffect, useRef } from "react";
import { Link, useParams } from "react-router";

import '../Game.css';

import { Alert, Chevron, Crown, Eye, Turtle, TurtleOnBack } from './Art';
import { getPlayerId, getUsername } from '../username';
import { LANGUAGES, getPreferredLanguage, savePreferredLanguage } from '../languages';

// percent of the text typed once the words before `index` are done, each
// with its space. wordAt turns it back into a word with the same numbers.
const progressAt = (words, text, index) =>
  Math.min(100, (words.slice(0, index).reduce((total, word) => total + word.length + 1, 0) / text.length) * 100)

// the word to type next at `progress` percent
const wordAt = (words, text, progress) => {
  let index = 0
  while (index < words.length - 1 && progressAt(words, text, index + 1) <= progress) index++
  return index
}

// more players than this get narrower lanes
const ROOMY_LANES = 8
// fewer players leave lanes empty, so the countdown has room on the track
const MIN_LANES = 3

const Status = ({tone, icon, alert = false, children}) => (
  <p className={tone ? `status status-${tone}` : 'status'} role={alert ? 'alert' : 'status'}>
    {icon}
    <span>{children}</span>
  </p>
)

const Dot = ({color}) => <span className="dot" style={{background: color}} aria-hidden="true" />

const Spinner = () => <span className="spin" aria-hidden="true" />

// while the socket is down, the last known room stays frozen under it
const ConnectionStatus = ({failed}) => failed
  ? <Status tone="warn" icon={<Spinner />} alert>Can't reach the game server, retrying...</Status>
  : <Status icon={<Spinner />}>Connecting...</Status>

const RoomHeader = ({roomID}) => (
  <header className="room-header">
    <Link to="/" className="logo"><Turtle />Kaplumbaga</Link>
    <p className="room-code">Room <strong>{roomID}</strong></p>
  </header>
)

// the room's shape before its state arrives, so nothing jumps when it loads
const RoomSkeleton = ({roomID, status}) => (
  <div className="room">
    <RoomHeader roomID={roomID} />
    <div className="room-bar">{status}</div>
    <div className="track track-skeleton" aria-hidden="true">
      {[80, 64, 92].map((width) => (
        <div className="skel-lane" key={width}><span className="skel-tag" style={{width}} /></div>
      ))}
    </div>
    <div className="race-text race-text-skeleton" aria-hidden="true">
      <div className="skel" style={{width: '92%'}} />
      <div className="skel" />
      <div className="skel" style={{width: '64%'}} />
    </div>
    <div className="skel-input" aria-hidden="true" />
  </div>
)

const ERROR_HELP = {
  'invalid room id': 'Check the code with your friend, or start a new room.',
  'room is full': 'Start a new room for your group, or try again when someone leaves.',
}

// an error that joining again won't fix, like an invalid room code
const RoomError = ({message}) => (
  <main className="room-error">
    <section className="card error-card">
      <TurtleOnBack width="170" height="128" />
      <Status tone="error" icon={<Alert />} alert>{message}</Status>
      <p className="error-help">{ERROR_HELP[message] || 'Go back and try again, or start a new room.'}</p>
      <Link className="btn" to="/">Back to home</Link>
    </section>
  </main>
)

// big number over the track, every step of the countdown under it
const Countdown = ({secondsLeft, total}) => {
  const steps = [...Array.from({length: total}, (_, i) => total - i), 0]
  const label = (step) => step > 0 ? String(step) : 'Go!'
  const stepClass = (step) => step > secondsLeft ? 'done' : step === secondsLeft ? 'now' : undefined
  return (
    <div className="countdown">
      <div className="countdown-inner">
        <div aria-live="assertive">
          {/* a new element every second plays the pop again */}
          <div key={secondsLeft} className={secondsLeft > 0 ? 'countdown-number' : 'countdown-number is-go'}>
            {label(secondsLeft)}
          </div>
        </div>
        <ol className="countdown-steps" aria-hidden="true">
          {steps.map((step) => <li key={step} className={stepClass(step)}>{label(step)}</li>)}
        </ol>
      </div>
    </div>
  )
}

const Track = ({players, myID, winnerID, status, children}) => {
  const entries = Object.entries(players)
  let className = 'track'
  if (entries.length > ROOMY_LANES) className += ' is-crowded'
  if (status === 'playing') className += ' is-racing'
  return (
    <section className={className} aria-label="Race track">
      <div className="lanes">
        {entries.map(([id, player]) => {
          // left edge on the start line at 0%, right edge on the finish line at 100%
          const progress = player.progress || 0
          const isMe = id === myID
          const won = status === 'finished' && id === winnerID
          let laneClass = 'lane'
          if (isMe) laneClass += ' lane-me'
          if (won) laneClass += ' lane-win'
          return (
            <div className={laneClass} key={id}>
              <div className="lane-name">
                <span className="tag" title={player.username}>{player.username}</span>
              </div>
              <div className="lane-run">
                <div
                  className="turtle"
                  style={{'--progress': progress / 100}}
                  role="img"
                  aria-label={`${player.username}${isMe ? ' (you)' : ''}, ${won ? 'winner' : `${Math.round(progress)}% done`}`}
                >
                  {won && <Crown className="crown" />}
                  <Turtle />
                </div>
              </div>
              <div className="finish" aria-hidden="true" />
            </div>
          )
        })}
        {Array.from({length: Math.max(0, MIN_LANES - entries.length)}, (_, index) => (
          <div className="lane" key={`empty-${index}`} aria-hidden="true">
            <div className="lane-name" />
            <div />
            <div className="finish" />
          </div>
        ))}
      </div>
      {children}
    </section>
  )
}

// One race room. Mounted again after every reconnection, so a new socket
// starts with a clean state. While the socket is down it stays, frozen.
const Race = ({socket, roomID, connected, connectionFailed, onFatalError}) => {
  const [competitors, setCompetitors] = useState({});
  // null until the first room update
  const [status, setStatus] = useState(null);
  const [winner, setWinner] = useState(null);
  const [winnerID, setWinnerID] = useState(null);
  const [randomText, setRandomText] = useState('');
  const [current, setCurrent] = useState(0);
  const [userInput, setUserInput] = useState('');
  const [language, setLanguage] = useState(getPreferredLanguage);
  const [countdownEnd, setCountdownEnd] = useState(null);
  const [countdownTotal, setCountdownTotal] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  // why the server turned down Start or a language change
  const [notice, setNotice] = useState('');
  // this connection's id, the socket loses it when it goes down
  const [myID] = useState(() => socket.id);

  const inputRef = useRef(null);
  const textRef = useRef(null);
  const currentWordRef = useRef(null);
  const countingDown = useRef(false);

  const [username] = useState(getUsername);

  const words = randomText ? randomText.split(" ") : [];

  useEffect(() => {
    // The server sends the messages in the order the changes happened. Drop
    // those of a room this tab has left, messages without a room come from
    // an older server (a rolled back deploy).
    const isOtherRoom = (room) => room !== undefined && room !== roomID

    // players, game status, winner and text language of the room
    const onRoomUpdate = (state) => {
      if (isOtherRoom(state.room)) return
      setNotice('')
      setCompetitors(state.players)
      setStatus(state.status)
      setWinner(state.winner)
      setWinnerID(state.winner_id)
      setLanguage(state.language)
      if (state.status === 'countdown') {
        // the first update of a countdown tells how long it is
        if (!countingDown.current) setCountdownTotal(Math.max(1, Math.ceil(state.starts_in)))
        // a new race is about to start, clear the previous one
        setCountdownEnd(Date.now() + state.starts_in * 1000)
        setNow(Date.now())
        setRandomText('')
        setCurrent(0)
        setUserInput('')
      } else {
        setCountdownEnd(null)
      }
      countingDown.current = state.status === 'countdown'
    }
    // the race text, a room update with the status comes right after it
    const onLoadText = (text, room, progress = 0) => {
      if (isOtherRoom(room)) return
      setRandomText(text)
      // a racer who reconnected types on from where they were
      setCurrent(wordAt(text.split(" "), text, progress))
      setUserInput('')
    }
    // get current progress of a competitor
    const onProgress = (data) => {
      if (isOtherRoom(data.room)) return
      setCompetitors(
        prev => ({
          ...prev,
          [data.user_id]: {
            ...prev[data.user_id],
            progress: data.progress,
          }
        })
      )
    }
    const onFinish = (data) => {
      if (isOtherRoom(data.room)) return
      setStatus('finished')
      setWinner(data.winner)
      setWinnerID(data.winner_id)
    }

    socket.on('room_update', onRoomUpdate)
    socket.on('load_text', onLoadText)
    socket.on('progress_percentage', onProgress)
    socket.on('finish_game', onFinish)
    // join after the listeners are registered so the first room_update isn't missed
    let active = true
    let retryTimer
    // only this connection is in the room, the next one joins on its own
    const joinedAs = socket.id
    const join = () => {
      // a retry after the connection dropped, socket.io would send it on the next one
      if (socket.id !== joinedAs) return
      // language is only used if this join creates the room
      socket.emit('join', {
        room_id: roomID,
        username: username,
        language: getPreferredLanguage(),
        // a reconnecting tab replaces its old connection, and keeps its name
        player_id: getPlayerId(),
      }, (response) => {
        if (!active || response?.ok) return
        if (response?.error === 'too many requests') {
          // rate limited, try again in a moment instead of giving up
          retryTimer = setTimeout(join, 2000)
        } else {
          onFatalError(response?.error || 'Could not join the room')
        }
      })
    }
    join()

    return () => {
      active = false
      clearTimeout(retryTimer)
      // a disconnected socket already left the room on the server
      if (socket.connected && socket.id === joinedAs) socket.emit('leave')
      socket.off('room_update', onRoomUpdate)
      socket.off('load_text', onLoadText)
      socket.off('progress_percentage', onProgress)
      socket.off('finish_game', onFinish)
    }
  }, [socket, roomID, username, onFatalError]);

  // tick while counting down
  useEffect(() => {
    if (countdownEnd === null) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [countdownEnd]);

  // put the cursor in the input when the race starts
  useEffect(() => {
    if (status === 'playing' && randomText) inputRef.current?.focus()
  }, [status, randomText]);

  // this player races, as opposed to watching a race that started without them
  const racing = status === 'playing' && words.length > 0

  // On phones the race fills the screen above the keyboard (see Game.css).
  // The visual viewport is what's left over by the keyboard, also in
  // browsers that don't shrink 100dvh for it.
  useEffect(() => {
    const viewport = window.visualViewport
    if (!racing || !viewport) return
    const root = document.documentElement
    const update = () => root.style.setProperty('--viewport-height', `${viewport.height}px`)
    update()
    viewport.addEventListener('resize', update)
    return () => {
      viewport.removeEventListener('resize', update)
      root.style.removeProperty('--viewport-height')
    }
  }, [racing]);

  // where the text box scrolls (phones), keep the word being typed in it,
  // a third of the way down. Only the box scrolls, never the page.
  useEffect(() => {
    const box = textRef.current
    const word = currentWordRef.current
    if (!racing || !box || !word || box.scrollHeight <= box.clientHeight) return
    const { offsetTop, offsetHeight } = word
    if (offsetTop < box.scrollTop || offsetTop + offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = offsetTop - box.clientHeight / 3
    }
  }, [racing, current]);

  const showRefusal = (response) => {
    // "game already running": someone else pressed Start first, the countdown says it all
    if (response?.ok === false && response.error !== 'game already running') setNotice(response.error)
  }

  const handleStart = () => {
    // send game_start message to server, it starts a countdown for everyone
    socket.emit('game_start', showRefusal)
  }

  const handleLanguage = (event) => {
    const code = event.target.value
    // the server sends the new language to everyone in the room
    socket.emit('set_language', {language: code}, (response) => {
      // remembered for the rooms this player creates, once this room took it
      if (response?.ok) savePreferredLanguage(code)
      showRefusal(response)
    })
  }

  const sendProgress = (wordsDone) => {
    // server ends the game when someone reaches 100
    socket.emit('progress', {progress: progressAt(words, randomText, wordsDone)})
  }

  const handleChange = (event) => {
    // some keyboards send accented letters as letter + combining mark, and
    // curly apostrophes where the text has straight ones
    const value = event.target.value.normalize('NFC').replace(/[‘’]/g, "'")
    const currentWord = words[current]
    const isLastWord = current === words.length - 1
    // the word is done when it is typed correctly and followed by a space.
    // checked here instead of onKeyDown because mobile keyboards don't report
    // the space key reliably
    if (!isLastWord && value === currentWord + ' ') {
      setCurrent(current + 1)
      setUserInput('')
      // once a word, not every key: every player of the room gets each one
      sendProgress(current + 1)
      return
    }
    setUserInput(value)
    if (isLastWord && value === currentWord) sendProgress(words.length)
  }

  if (status === null) {
    return <RoomSkeleton roomID={roomID} status={<ConnectionStatus failed={!connected && connectionFailed} />} />
  }

  const frozen = !connected
  const watching = status === 'playing' && !words.length
  const isRacing = status === 'countdown' || status === 'playing'
  const typo = racing && current < words.length && !words[current].startsWith(userInput)
  const secondsLeft = countdownEnd === null ? 0 : Math.max(0, Math.ceil((countdownEnd - now) / 1000))

  const wordClass = (index) => {
    if (index < current) return 'w w-ok'
    if (index === current && index === words.length - 1 && userInput === words[index]) return 'w w-ok'
    if (index > current || !racing) return 'w'
    return typo ? 'w w-bad' : 'w w-cur'
  }

  let statusLine
  if (frozen) {
    statusLine = <ConnectionStatus failed={connectionFailed} />
  } else if (notice) {
    statusLine = <Status tone="error" icon={<Alert />} alert>{notice}</Status>
  } else if (status === 'finished' && winner) {
    // the id tells apart players with the same name
    statusLine = <Status tone="win" icon={<Crown />}>{winnerID === myID ? 'You won!' : `${winner} won!`}</Status>
  } else if (status === 'finished') {
    statusLine = <Status icon={<Dot color="#9DA394" />}>Race over, nobody finished.</Status>
  } else if (status === 'countdown') {
    statusLine = <Status icon={<Dot color="#F2994A" />}>Get ready!</Status>
  } else if (watching) {
    statusLine = <Status tone="watch" icon={<Eye />}>Race in progress, you can join the next one.</Status>
  } else if (racing) {
    statusLine = (
      <Status icon={<Dot color="#6FB043" />}>
        Race on!<span className="status-more"> Type the text below.</span>
      </Status>
    )
  } else {
    statusLine = (
      <Status icon={<Dot color="#F2C94C" />}>Room code: {roomID}. Press Start when everyone is here.</Status>
    )
  }

  let placeholder = 'Waiting for the race to start'
  if (status === 'countdown') placeholder = 'Get ready…'
  else if (racing) placeholder = 'Start typing the text above'
  else if (watching) placeholder = "You're watching this one. Your turtle joins the next race."
  else if (status === 'finished') placeholder = 'Race over. Press Start for a rematch.'

  let note = 'The race text shows up here for everyone when someone presses Start.'
  if (status === 'countdown') note = 'Fingers on the keys. The text appears on Go!'
  else if (watching) note = 'The text shows up here when the next race starts.'

  let roomClass = 'room'
  if (racing) roomClass += ' is-typing'
  if (frozen) roomClass += ' is-frozen'

  return (
    <div className={roomClass}>
      <RoomHeader roomID={roomID} />
      <div className="room-bar">
        {statusLine}
        <div className="room-controls">
          <label htmlFor="language">Language</label>
          <div className="select-wrap">
            <select
              id="language"
              className="field select"
              value={language}
              onChange={handleLanguage}
              disabled={frozen || isRacing}
            >
              {LANGUAGES.map(({code, name}) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </select>
            <Chevron />
          </div>
          <button
            type="button"
            className="btn start-button"
            onClick={handleStart}
            disabled={frozen || isRacing}
          >
            Start
          </button>
        </div>
      </div>

      <Track players={competitors} myID={myID} winnerID={winnerID} status={status}>
        {status === 'countdown' && <Countdown secondsLeft={secondsLeft} total={countdownTotal} />}
      </Track>

      <section ref={textRef} className={words.length ? 'race-text' : 'race-text is-empty'} aria-label="Race text">
        {words.length > 0 ? (
          <p className="words" lang={language}>
            {words.map((word, index) => (
              <Fragment key={index}>
                <span className={wordClass(index)} ref={index === current ? currentWordRef : undefined}>
                  {word}
                </span>
                {" "}
              </Fragment>
            ))}
          </p>
        ) : (
          <p className="race-text-note">{note}</p>
        )}
      </section>

      <div className="typing">
        <div className="typing-head">
          <label htmlFor="typing">Your typing</label>
          {typo && (
            <p id="typo-hint" className="typo-hint">
              <Alert width="18" height="18" />
              Typo. Fix it to keep going.
            </p>
          )}
        </div>
        <input
          ref={inputRef}
          id="typing"
          className={typo ? 'field typing-field field-bad' : 'field typing-field'}
          // after the race the placeholder says what's next
          value={racing ? userInput : ''}
          onChange={handleChange}
          disabled={frozen || !racing}
          placeholder={placeholder}
          aria-invalid={typo || undefined}
          aria-describedby={typo ? 'typo-hint' : undefined}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
    </div>
  );
};

// Holds the server connection while a game page is open, the home page
// doesn't need one.
const Game = ({socket}) => {
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [connectionFailed, setConnectionFailed] = useState(false);
  // counts the connections, each one gets a new Race
  const [connection, setConnection] = useState(() => socket.connected ? 1 : 0);
  const [fatalError, setFatalError] = useState('');

  const params = useParams();
  // codes are lowercase, phone keyboards like to capitalize them; the server
  // also trims spaces and line breaks, like in /play/abc%0A
  const roomID = params.room_id.trim().toLowerCase();

  useEffect(() => {
    const onConnect = () => {
      setIsConnected(true);
      setConnectionFailed(false);
      setConnection((count) => count + 1);
    };
    // socket.io-client reconnects by itself, this server never disconnects a client
    const onDisconnect = () => setIsConnected(false);
    const onConnectError = () => setConnectionFailed(true);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.connect();
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.disconnect();
    };
  }, [socket]);

  // an error that joining again won't fix, like an invalid room code
  useEffect(() => {
    if (fatalError) socket.disconnect();
  }, [socket, fatalError]);

  if (fatalError) return <RoomError message={fatalError} />;
  if (connection === 0) {
    return <RoomSkeleton roomID={roomID} status={<ConnectionStatus failed={connectionFailed} />} />;
  }
  return (
    <Race
      key={connection}
      socket={socket}
      roomID={roomID}
      connected={isConnected}
      connectionFailed={connectionFailed}
      onFatalError={setFatalError}
    />
  );
};

export default Game;
