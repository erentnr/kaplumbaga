import { randomInt, randomRoomCode } from './random'
import { load, save } from './storage'

// returns the saved username, creates a random one on the first visit
export const getUsername = () => {
  let username = load("username")
  if (!username) {
    username = `player${randomInt(1000)}`
    save("username", username)
  }
  return username
}

export const saveUsername = (username) => {
  save("username", username)
}

// Same through reconnects of this page, like a phone switching networks, so
// the server replaces the old connection instead of counting a second player.
// Kept in memory: a duplicated tab copies sessionStorage, and the two tabs
// would replace each other. A reload closes the old connection anyway.
const playerId = randomRoomCode(16)

export const getPlayerId = () => playerId
