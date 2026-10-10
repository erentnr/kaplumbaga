import { useState } from "react";
import { useNavigate } from "react-router";

import TurtleSvg from '../assets/turtle.svg';

import Modal from './Modal'
import { getUsername } from '../username'
import { randomRoomCode } from '../random'

const Home = () => {
  const [roomID, setRoomID] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [username, setUsername] = useState(getUsername);

  let navigate = useNavigate();

  const handleCreate = () => {
    navigate(`/play/${randomRoomCode()}`)
  }

  const handleJoin = () => {
    const code = roomID.trim()
    if (!code) return
    navigate(`/play/${encodeURIComponent(code)}`)
  }

  const handleChange = (event) => {
    setRoomID(event.target.value)
  }

  const handleNewUsername = () => {
    setShowModal(true)
  }

  const handleSaveUsername = (newUsername) => {
    localStorage.setItem("username", newUsername)
    setUsername(newUsername)
    setShowModal(false)
  }

  return (
    <div className="main">
      <Modal showModal={showModal} onSave={handleSaveUsername} />
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
          disabled={!roomID.trim()}
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
