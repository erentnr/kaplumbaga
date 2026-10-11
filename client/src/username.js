import { randomInt, randomRoomCode } from './random'

// returns the saved username, creates a random one on the first visit
export const getUsername = () => {
  let username = localStorage.getItem("username")
  if (!username) {
    username = `player${randomInt(1000)}`
    localStorage.setItem("username", username)
  }
  return username
}

export const saveUsername = (username) => {
  localStorage.setItem("username", username)
}

// Same through reconnects of this page, like a phone switching networks, so
// the server replaces the old connection instead of counting a second player.
// Kept in memory: a duplicated tab copies sessionStorage, and the two tabs
// would replace each other. A reload closes the old connection anyway.
const playerId = randomRoomCode(16)

export const getPlayerId = () => playerId
