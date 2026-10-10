import { randomInt } from './random'

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
