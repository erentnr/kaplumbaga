import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

import TurtleSvg from '../assets/turtle.svg';

const Home = ({socket}) => {
  const [roomID, setRoomID] = useState('');

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

  return (
    <div className="main">
      <div className="home-header">
       <img className="kaplumbaga" src={TurtleSvg} />
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
        />
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
