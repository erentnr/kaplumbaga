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

// Same through reloads and reconnects of this tab, different in another tab.
// The server uses it to replace the tab's old connection instead of counting
// a second player.
export const getPlayerId = () => {
  let id = sessionStorage.getItem("player_id")
  if (!id) {
    id = randomRoomCode(16)
    sessionStorage.setItem("player_id", id)
  }
  return id
}
