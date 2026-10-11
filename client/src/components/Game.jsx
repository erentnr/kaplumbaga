import { useState, useEffect, useRef } from "react";
import { Link, useParams } from "react-router";

import '../Game.css';

import TurtleSvg from '../assets/turtle.svg';
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

// One race room. Mounted again after every reconnection, so a new socket
// starts with a clean state.
const Race = ({socket, roomID, onFatalError}) => {
  const [competitors, setCompetitors] = useState({});
  const [status, setStatus] = useState('waiting');
  const [winner, setWinner] = useState(null);
  const [winnerID, setWinnerID] = useState(null);
  const [randomText, setRandomText] = useState('');
  const [current, setCurrent] = useState(0);
  const [userInput, setUserInput] = useState('');
  const [language, setLanguage] = useState(getPreferredLanguage);
  const [countdownEnd, setCountdownEnd] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  // why the server turned down Start or a language change
  const [notice, setNotice] = useState('');

  const inputRef = useRef(null);

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
        // a new race is about to start, clear the previous one
        setCountdownEnd(Date.now() + state.starts_in * 1000)
        setNow(Date.now())
        setRandomText('')
        setCurrent(0)
        setUserInput('')
      } else {
        setCountdownEnd(null)
      }
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
    const join = () => {
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
      if (socket.connected) socket.emit('leave')
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
    const value = event.target.value.normalize('NFC').replace(/[\u2018\u2019]/g, "'")
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

  const wordStatus = (index) => {
    if (index < current) return 'correct'
    if (index > current) return 'default'
    if (index === words.length - 1 && userInput === words[index]) return 'correct'
    return words[index].startsWith(userInput) ? 'current' : 'wrong'
  }

  const isRacing = status === 'countdown' || status === 'playing'
  const secondsLeft = countdownEnd === null ? 0 : Math.max(0, Math.ceil((countdownEnd - now) / 1000))

  let message
  if (notice) {
    message = notice
  } else if (status === 'finished' && winner) {
    // the id tells apart players with the same name
    message = winnerID === socket.id ? 'You won!' : `${winner} won!`
  } else if (status === 'finished') {
    message = 'Race over, nobody finished.'
  } else if (status === 'countdown') {
    message = 'Get ready!'
  } else if (status === 'playing' && !randomText) {
    message = 'Race in progress, you can join the next one.'
  } else if (status === 'playing') {
    message = 'Keep playing'
  } else {
    message = `Room code: ${roomID}. Press Start when everyone is here.`
  }

  return (
    <div className="main">
      <div className="game-container">
        <div className="kaplumbaga-race">
          {status === 'countdown' && (
            <div className="countdown">{secondsLeft > 0 ? secondsLeft : 'Go!'}</div>
          )}
          {Object.entries(competitors).map(([competitorID, competitor]) => {
            // move kaplumbaga and name with the progress: left edge on the
            // start line at 0%, right edge on the finish line at 100%
            const progress = competitor.progress || 0
            const position = {left: `${progress}%`, transform: `translateX(-${progress}%)`}
            return (
              <div
                className={competitorID === socket.id ? "kaplumbaga-wrapper me" : "kaplumbaga-wrapper"}
                key={competitorID}
              >
                <p style={position}><span className="name">{competitor.username}</span></p>
                <img
                  className="kaplumbaga"
                  src={TurtleSvg}
                  alt="kaplumbaga"
                  style={position}
                />
              </div>
            )
          })}
        </div>
        <div className="game-text default" lang={language}>
          {words.map((word, index) => {
            return (
              <span key={index}>
                <span className={wordStatus(index)}>
                  {word}
                </span>
                {" "}
              </span>
            )
          })}
        </div>
        <div className="game-input">
          <input
            ref={inputRef}
            value={userInput}
            onChange={handleChange}
            disabled={status !== 'playing' || !randomText}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
      </div>
      <div className="game-controls">
        <select
          className="language-select"
          aria-label="Text language"
          value={language}
          onChange={handleLanguage}
          disabled={isRacing}
        >
          {LANGUAGES.map(({code, name}) => (
            <option key={code} value={code}>{name}</option>
          ))}
        </select>
        <input
          type="button"
          value="Start"
          className="start-button"
          onClick={handleStart}
          disabled={isRacing}
        />
      </div>
      <p className="game-message">{message}</p>
    </div>
  );
};

// Holds the server connection while a game page is open, the home page
// doesn't need one.
const Game = ({socket}) => {
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [fatalError, setFatalError] = useState('');

  const params = useParams();
  // codes are lowercase, phone keyboards like to capitalize them; the server
  // also trims spaces and line breaks, like in /play/abc%0A
  const roomID = params.room_id.trim().toLowerCase();

  useEffect(() => {
    const onConnect = () => {
      setIsConnected(true);
      setConnectionFailed(false);
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

  if (fatalError) {
    return (
      <div className="main">
        <p className="game-message">{fatalError}</p>
        <Link to="/">Back to the home page</Link>
      </div>
    );
  }
  if (!isConnected) {
    return (
      <div className="main">
        <h2>{connectionFailed ? "Can't reach the game server, retrying..." : "Connecting..."}</h2>
      </div>
    );
  }
  return <Race socket={socket} roomID={roomID} onFatalError={setFatalError} />;
};

export default Game;
