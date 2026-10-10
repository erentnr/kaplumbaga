import { useState, useEffect } from "react";
import { io } from "socket.io-client";
import { Routes, Route, Navigate } from "react-router";

import './App.css';
import './Modal.css';

import { Home, Game } from "./components"

// connects to the page's own origin when VITE_SOCKET_SERVER is not set.
// The server only accepts websockets, so skip the long-polling handshake.
const socket = io(import.meta.env.VITE_SOCKET_SERVER, { transports: ['websocket'] });

const App = () => {
  const [isConnected, setIsConnected] = useState(socket.connected);
  const [connectionFailed, setConnectionFailed] = useState(false);

  useEffect(() => {
    let retryTimer;
    // socket.io-client retries network errors by itself, but not a connection
    // the server refused or closed, so try again after a pause
    const retryLater = () => {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => socket.connect(), 5000);
    };
    const onConnect = () => {
      setIsConnected(true);
      setConnectionFailed(false);
    };
    const onDisconnect = (reason) => {
      setIsConnected(false);
      if (reason === 'io server disconnect') retryLater();
    };
    const onConnectError = () => {
      setConnectionFailed(true);
      if (!socket.active) retryLater();
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    return () => {
      clearTimeout(retryTimer);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
    };
  }, []);

  if (isConnected){
    return (
      <Routes>
        <Route path="/" element={ <Home /> } />
        <Route path="/play/:room_id" element={ <Game socket={socket} /> } />
        <Route path="*" element={ <Navigate to="/" replace /> } />
      </Routes>
    )
  } else {
    return (
      <div className="main">
        <h2>{connectionFailed ? "Can't reach the game server, retrying..." : "Connecting..."}</h2>
      </div>
    );
  }
};

export default App;
