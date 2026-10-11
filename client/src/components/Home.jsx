import { useState } from "react";
import { useNavigate } from "react-router";

import '../Home.css';

import { Turtle } from './Art'
import NameDialog from './NameDialog'
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
  const [showNameDialog, setShowNameDialog] = useState(false);
  const [username, setUsername] = useState(getUsername);

  let navigate = useNavigate();

  const handleCreate = () => {
    navigate(`/play/${randomRoomCode()}`)
  }

  const handleJoin = (event) => {
    event.preventDefault()
    const code = roomCodeFrom(roomID)
    if (!code) return
    navigate(`/play/${encodeURIComponent(code)}`)
  }

  const handleSaveUsername = (newUsername) => {
    saveUsername(newUsername)
    setUsername(newUsername)
    setShowNameDialog(false)
  }

  return (
    <main className="home">
      {showNameDialog && (
        <NameDialog
          username={username}
          onSave={handleSaveUsername}
          onClose={() => setShowNameDialog(false)}
        />
      )}
      <div className="home-hero">
        <div className="hero-turtle">
          <Turtle detailed width="200" height="127" />
        </div>
        <div className="hero-ground" aria-hidden="true" />
      </div>
      <div className="home-title">
        <h1>Kaplumbaga</h1>
        <p>Test your speed, play with your friends!</p>
      </div>

      <section className="card" aria-label="Join or create a game">
        <form className="join-form" onSubmit={handleJoin}>
          <label htmlFor="room-code">Room code</label>
          <div className="join-row">
            <input
              id="room-code"
              className="field room-code-input"
              placeholder="e.g. k7m2p"
              value={roomID}
              onChange={(event) => setRoomID(event.target.value)}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button className="btn" type="submit" disabled={!roomCodeFrom(roomID)}>
              Join Game
            </button>
          </div>
        </form>
        <p className="joining-as">
          Joining as <strong>{username}</strong>.{' '}
          <button type="button" className="link" onClick={() => setShowNameDialog(true)}>
            Change
          </button>
        </p>
        <div className="divider" aria-hidden="true">or</div>
        <button className="btn btn-2" type="button" onClick={handleCreate}>
          Create Game
        </button>
      </section>
    </main>
  )
};

export default Home;
