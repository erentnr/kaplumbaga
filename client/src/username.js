// returns the saved username, creates a random one on the first visit
export const getUsername = () => {
  let username = localStorage.getItem("username")
  if (!username) {
    username = `player${~~(Math.random()*1000)}`
    localStorage.setItem("username", username)
  }
  return username
}
