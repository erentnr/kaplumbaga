import { io } from "socket.io-client";
import { Routes, Route, Navigate } from "react-router";

import './App.css';
import './Modal.css';

import { Home, Game } from "./components"

// Connects to the page's own origin when VITE_SOCKET_SERVER is not set. The
// server only accepts websockets, so skip the long-polling handshake. Only the
// game page connects, see Game.
const socket = io(import.meta.env.VITE_SOCKET_SERVER, { transports: ['websocket'], autoConnect: false });

const App = () => {
  return (
    <Routes>
      <Route path="/" element={ <Home /> } />
      <Route path="/play/:room_id" element={ <Game socket={socket} /> } />
      <Route path="*" element={ <Navigate to="/" replace /> } />
    </Routes>
  )
};

export default App;
