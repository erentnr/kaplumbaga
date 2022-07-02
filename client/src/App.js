import React, { useState, useEffect } from "react";
import io from "socket.io-client";
import { Routes, Route } from "react-router-dom";

import './App.css';
import './Modal.css';

import { Home, Game } from "./components"

const endPoint = process.env.REACT_APP_SOCKET_SERVER;
const socket = io.connect(`${endPoint}`);

const App = () => {
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    // connect to the server and listen for messages
    socket.on('connect', () => {
      setIsConnected(true);
    });
    // connect to the server and listen for messages
    socket.on('disconnect', () => {
      setIsConnected(false);
    });
  }, []);

  if (isConnected){
    return (
      <Routes>
        <Route path="/" element={ <Home socket={socket} /> } />
        <Route path="/play/:room_id" element={ <Game socket={socket} /> } />
      </Routes>
    )
  } else {
    return (
      <div className="main">
        <h2>No connetion</h2>
      </div>
    );
  }
};

export default App;
