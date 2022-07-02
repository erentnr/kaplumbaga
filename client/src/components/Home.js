import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

import TurtleSvg from '../assets/turtle.svg';

import Modal from './Modal'

const Home = ({socket}) => {
  const [roomID, setRoomID] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [username, setUsername] = useState('');

  useEffect(() => {
    let usernameOnLS = localStorage.getItem("username")
    if (!usernameOnLS) {
      let randomUsername = `player${~~(Math.random()*1000)}`
      localStorage.setItem("username", randomUsername)
      setUsername(randomUsername)
    } else {
      setUsername(usernameOnLS)
    }
  }, [showModal]);

  let navigate = useNavigate();

  const handleCreate = () => {
    const randomRoomID = Math.random().toString(36).substr(2, 5)
    navigate(`/play/${randomRoomID}`)
  }

  const handleJoin = () => {
    if (!roomID) return
    navigate(`/play/${roomID}`)
  }

  const handleChange = (event) => {
    setRoomID(event.target.value)
  }

  const handleNewUsername = () => {
    setShowModal(true)
  }

  return (
    <div className="main">
      <Modal showModal={showModal} setShowModal={setShowModal} />
      <div className="home-header">
       <img className="kaplumbaga" alt="" src={TurtleSvg} />
       <div className="header-title">
         <h2>Kaplumbaga</h2>
         <p>Test your speed, play with your friends!</p>
       </div>
      </div>

      <div className="join-wrapper">
        <input
          className="room-code-input"
          placeholder="Room Code..."
          value={roomID}
          onChange={handleChange}
        />
        <input
          className="kaplumbaga-button"
          type="button"
          value="Join Game"
          onClick={handleJoin}
          disabled={!roomID}
        />
        <div className="username-wrapper">
         <p>Joining as {username}. 
          <span
            className="change-username"
            onClick={handleNewUsername}
          >
            Change
          </span>
        </p>
        </div>
        <h2>or</h2>
        <input
          className="kaplumbaga-button"
          type="button"
          value="Create Game"
          onClick={handleCreate}
        />
      </div>
    </div>
  )
};

export default Home;
