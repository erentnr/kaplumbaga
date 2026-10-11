// localStorage throws when the browser blocks site data. The game works
// without it, values are then kept in memory until the page closes.
const memory = new Map()

export const load = (key) => {
  try {
    const value = localStorage.getItem(key)
    if (value !== null) return value
  } catch {
    // blocked, the copy in memory is all there is
  }
  return memory.get(key) ?? null
}

export const save = (key, value) => {
  memory.set(key, value)
  try {
    localStorage.setItem(key, value)
  } catch {
    // blocked, remembered in memory only
  }
}
