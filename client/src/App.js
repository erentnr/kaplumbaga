import React, { useState, useEffect } from "react";
import io from "socket.io-client";

let endPoint = "http://localhost:5000";
let socket = io.connect(`${endPoint}`);

const App = () => {
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    socket.on('connect', () => {
      setIsConnected(true);
    });
  }, []);

  return (
    <div>
      <h2>
        {isConnected ? 'Connected' : 'No connection'}
      </h2>
    </div>
  );
};

export default App;
