import { useState, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";

import '../Game.css';

import TurtleSvg from '../assets/turtle.svg';

const Game = ({socket}) => {
  const [competitors, setCompetitors] = useState({});
  const [randomText, setRandomText] = useState('');
  const [wordArr, setWordArr] = useState([]);
  const [userInput, setUserInput] = useState('');
  const [current, setCurrent] = useState(0);
  const [totalProgress, setTotalProgress] = useState(0);
  const [isFinished, setIsFinished] = useState(false);

  const raceArea = useRef();

  const params = useParams();
  const roomID = params.room_id;
  const userID = socket.id;

  const username = localStorage.getItem("username");

  useEffect(() => {
    if (!isFinished){
      setCurrent(0)
      setTotalProgress(0)
      for (let competitor in competitors){
        setCompetitors(
          prev=> ({
            ...prev,
            [competitor]:{
              ...prev.competitor,
              progress:0,
              position:0,
            }
          })
        )
      }
    }
  }, [isFinished])

  useEffect(() => {
    // join to server
    socket.emit('join', {room_id:roomID, sid:userID, username:username})
    // listen for join response
    socket.on('join_room', (data) => {
      setCompetitors(data)
    })
    // get the random text sent from server
    socket.on('load_text', (text) => {
      // set all states to inital value on game start
      setIsFinished(false)
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
    socket.on('progress_percentage', (data) => {
      // change kamplumbaga position according to the progress
      let raceAreaWidth = raceArea.current.getBoundingClientRect().width;
      let position = ((raceAreaWidth - 60) / 100) * data.progress;
      setCompetitors(
        prev=> ({
          ...prev,
          [data.user_id]:{
            ...prev.user_id,
            progress:data.progress,
            position:position,
            username:data.username
          }
        })
      )
    })
    socket.on('finish_game', () => {
      setIsFinished(true)
      updateWordStatus(current, 'correct')
      setUserInput('')
    })
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
          socket.emit('finish', {room_id:roomID})
        } else {
          socket.emit('progress', {room_id:roomID, progress:currentProgress, username:username})
        }
      }
    }
  }, [userInput, randomText]);

  const handleStart = () => {
    // send game_start message to server
    socket.emit('game_start', {room_id:roomID})
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

  return (
    <div className="main">
      <div className="game-container">
        <div ref={raceArea} className="kaplumbaga-race">
          {Object.keys(competitors).map((competitor)=>{
            return (
              <div
                className="kaplumbaga-wrapper"
                key={competitor}
                style={{left:competitors[competitor].position || 0}}
              >
                <p>{competitors[competitor].username}</p>
                <img
                  className="kaplumbaga"
                  src={TurtleSvg}
                  alt="kaplumbaga"
                />
              </div>
            )
          })}
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
    </div>
  );
};

export default Game;
