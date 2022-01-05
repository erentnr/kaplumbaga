import React, { useState, useEffect } from "react";
import io from "socket.io-client";

import './App.css';

import Game from "./components/Game"

const endPoint = "http://localhost:5000";
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
      <div className="main">
        <Game
          socket={socket}
        />
      </div>
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
