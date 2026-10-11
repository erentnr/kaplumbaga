import { useState } from "react";
import { useNavigate } from "react-router";

import TurtleSvg from '../assets/turtle.svg';

import Modal from './Modal'
import { getUsername, saveUsername } from '../username'
import { randomRoomCode } from '../random'

// accepts a room code or a whole invite link, codes are lowercase
const roomCodeFrom = (text) => {
  const value = text.trim()
  const link = value.match(/\/play\/([^/?#\s]+)/)
  return (link ? link[1] : value).toLowerCase()
}

const Home = () => {
  const [roomID, setRoomID] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [username, setUsername] = useState(getUsername);

  let navigate = useNavigate();

  const handleCreate = () => {
    navigate(`/play/${randomRoomCode()}`)
  }

  const handleJoin = () => {
    const code = roomCodeFrom(roomID)
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
    saveUsername(newUsername)
    setUsername(newUsername)
    setShowModal(false)
  }

  const handleCloseModal = () => {
    setShowModal(false)
  }

  return (
    <div className="main">
      <Modal showModal={showModal} onSave={handleSaveUsername} onClose={handleCloseModal} />
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
          onKeyDown={(event) => event.key === 'Enter' && handleJoin()}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <input
          className="kaplumbaga-button"
          type="button"
          value="Join Game"
          onClick={handleJoin}
          disabled={!roomCodeFrom(roomID)}
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
