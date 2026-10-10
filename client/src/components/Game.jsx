import { useState, useEffect, useRef } from "react";
import { useParams } from "react-router";

import '../Game.css';

import TurtleSvg from '../assets/turtle.svg';
import { getUsername } from '../username';
import { LANGUAGES, getPreferredLanguage, savePreferredLanguage } from '../languages';

const Game = ({socket}) => {
  const [competitors, setCompetitors] = useState({});
  const [status, setStatus] = useState('waiting');
  const [winner, setWinner] = useState(null);
  const [winnerID, setWinnerID] = useState(null);
  const [joinError, setJoinError] = useState('');
  const [randomText, setRandomText] = useState('');
  const [current, setCurrent] = useState(0);
  const [userInput, setUserInput] = useState('');
  const [language, setLanguage] = useState(getPreferredLanguage);
  const [countdownEnd, setCountdownEnd] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  const inputRef = useRef(null);

  const params = useParams();
  // room codes are lowercase, phone keyboards like to capitalize them
  const roomID = params.room_id.toLowerCase();

  const [username] = useState(getUsername);

  const words = randomText ? randomText.split(" ") : [];

  useEffect(() => {
    // players, game status, winner and text language of the room
    const onRoomUpdate = (state) => {
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
    // get the text sent from server, reset typing state for the new game
    const onLoadText = (text) => {
      setRandomText(text)
      setCurrent(0)
      setUserInput('')
      setWinner(null)
      setWinnerID(null)
      setStatus('playing')
    }
    // get current progress of a competitor
    const onProgress = (data) => {
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
      socket.emit('join', {room_id: roomID, username: username, language: getPreferredLanguage()}, (response) => {
        if (!active || response?.ok) return
        if (response?.error === 'too many requests') {
          // rate limited, try again in a moment instead of giving up
          retryTimer = setTimeout(join, 2000)
        } else {
          setJoinError(response?.error || 'Could not join the room')
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
  }, [socket, roomID, username]);

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

  const handleStart = () => {
    // send game_start message to server, it starts a countdown for everyone
    socket.emit('game_start')
  }

  const handleLanguage = (event) => {
    // the server sends the new language to everyone in the room
    savePreferredLanguage(event.target.value)
    socket.emit('set_language', {language: event.target.value})
  }

  const sendProgress = (wordIndex, input) => {
    // length of the completed words including their trailing whitespace
    const completed = words.slice(0, wordIndex).reduce((total, word) => total + word.length + 1, 0)
    const progress = Math.min(100, ((completed + input.length) / randomText.length) * 100)
    // server ends the game when someone reaches 100
    socket.emit('progress', {progress: progress})
  }

  const handleChange = (event) => {
    // some keyboards send accented letters as letter + combining mark
    const value = event.target.value.normalize('NFC')
    const currentWord = words[current]
    const isLastWord = current === words.length - 1
    // the word is done when it is typed correctly and followed by a space.
    // checked here instead of onKeyDown because mobile keyboards don't report
    // the space key reliably
    if (!isLastWord && value === currentWord + ' ') {
      setCurrent(current + 1)
      setUserInput('')
      sendProgress(current + 1, '')
      return
    }
    setUserInput(value)
    // only move the kaplumbaga while user keeps writing correctly
    if (currentWord.startsWith(value)) {
      sendProgress(current, value)
    }
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
  if (joinError) {
    message = joinError
  } else if (status === 'finished' && !winner) {
    message = 'Race over, nobody finished.'
  } else if (status === 'finished') {
    // the id tells apart players with the same name
    message = winnerID === socket.id ? 'You won!' : `${winner} won!`
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
                <p style={position}>{competitor.username}</p>
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
          disabled={isRacing || !!joinError}
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
          disabled={isRacing || !!joinError}
        />
      </div>
      <p className="game-message">{message}</p>
    </div>
  );
};

export default Game;
