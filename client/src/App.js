import React, { useState, useEffect, useRef } from "react";
import io from "socket.io-client";

import './App.css';
import TurtleSvg from './assets/turtle.svg';

const endPoint = "http://localhost:5000";
const socket = io.connect(`${endPoint}`);

const App = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [randomText, setRandomText] = useState('');
  const [wordArr, setWordArr] = useState([]);
  const [userInput, setUserInput] = useState('');
  const [current, setCurrent] = useState(0);
  const [totalProgress, setTotalProgress] = useState(0);
  const [kaplumbagaPos, setKaplumbagaPos] = useState(0);
  const [isFinished, setIsFinished] = useState(false);
  const raceArea = useRef();

  useEffect(() => {
    // connect to the server and listen for messages
    socket.on('connect', () => {
      setIsConnected(true);
      // get the random text sent from server
      socket.on('load_text', (text) => {
        // create array of word objects to keep status of words
        const textArr = text.split(" ")
        for (let i=0; textArr.length > i; i++){
          let newWord = {
            order:i,
            word:textArr[i],
            status:'default',
          }
          setWordArr(prev => [...prev, newWord])
        }
        // set the text after the wordArr to prevent
        // wordArr[current] is 'undefined' error on useEffect
        setRandomText(text)
      })
      // get current progress of user
      socket.on('progress_percentage', (progress) => {
        // change kamplumbaga position according to the progress
        let raceAreaWidth = raceArea.current.getBoundingClientRect().width
        setKaplumbagaPos(((raceAreaWidth - 60) / 100) * progress);
      })
      socket.on('finish_game', () => {
        setIsFinished(true)
        updateWordStatus(current, 'correct')
        setUserInput('')
      })
    });
  }, []);

  useEffect(() => {
    if (randomText && !isFinished){
      // set the status of the first word of wordArr to 'current' on game_start
      if (wordArr[current].status === 'default'){
        updateWordStatus(current, 'current')
      }
      // check if user keeps writing correctly
      // set word status to 'wrong' if user presses wrong letters
      // set word status to 'current' if user deletes mistakes
      const inputLength = userInput.length
      const currentWord = wordArr[current].word
      if (currentWord.slice(0, inputLength) !== userInput){
        updateWordStatus(current, 'wrong')
      } else if (wordArr[current].status !== 'current') {
        updateWordStatus(current, 'current')
      } else {
        // if user keeps writing correctly, add word progress to total progress
        let kaplumbagaProgress = totalProgress + inputLength
        let currentProgress = (kaplumbagaProgress / randomText.length) * 100
        // send finish message to server if user reaches end of text
        // else, send progress
        if (currentProgress === 100) {
          socket.emit('finish')
        } else {
          socket.emit('progress', currentProgress)
        }
      }
    }
  }, [userInput, randomText]);

  const handleStart = () => {
    // set all states to inital value on game start
    setCurrent(0)
    setTotalProgress(0)
    setKaplumbagaPos(0)
    setIsFinished(false)
    // send game_start message to server
    socket.emit('game_start')
  }

  const handleChange = (event) => {
    setUserInput(event.target.value)
  }

  const updateWordStatus = (index, status) => {
    const updatedTextList = wordArr.map(word => {
      if (word.order === index){
        word.status = status
      }
      return word
    })
    setWordArr(updatedTextList)
  }

  const handleSpace = (event) => {
    const spaceKey = 32;
    // check if user pressed spacebar and current word is not the last word
    if ((event.keyCode === spaceKey) && (current + 1 < wordArr.length)){
      if (userInput === wordArr[current].word){
        event.preventDefault();
        updateWordStatus(current, 'correct')
        // add word length (including whitespace) permanently to total progress
        setTotalProgress(prev => prev + wordArr[current].word.length + 1)
        setCurrent(prev => prev + 1)
        setUserInput('')
      }
    }
  }

  const Game = () => {
    return (
      <>
        <div className="game-container">
          <div ref={raceArea} className="kaplumbaga-race">
            <img
              style={{left:kaplumbagaPos || 0}}
              className="kaplumbaga"
              src={TurtleSvg}
              alt="kaplumbaga"
            />
          </div>
          <div className="game-text default">
            {wordArr.map((item, index) => {
              return (
                <span key={index}>
                  <span className={item.status}>
                    {item.word}
                  </span>
                  {" "}
                </span>
              )
            })}
          </div>
          <div className="game-input">
            <input
              value={userInput}
              onChange={handleChange}
              disabled={(randomText === "" || isFinished) ? true : false}
              onKeyDown={handleSpace}
              autoFocus
            />
          </div>
        </div>
        <input
          type="button"
          value="Start"
          className="start-button"
          onClick={handleStart}
          disabled={randomText === "" || isFinished ? false : true}
        />
        {isFinished ? 'Finished' : 'Keep playing'}
      </>
    )
  }

  return (
    <div className="main">
      {isConnected ? <Game /> : 'No connection'}
    </div>
  );
};

export default App;
