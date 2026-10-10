// random numbers from the Web Crypto API, Math.random() is predictable
export const randomInt = (max) => crypto.getRandomValues(new Uint32Array(1))[0] % max

// room codes skip letters that are easy to confuse when shared: l, o, 0 and 1
const ROOM_CODE_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789'

export const randomRoomCode = (length = 5) =>
  Array.from({ length }, () => ROOM_CODE_CHARS[randomInt(ROOM_CODE_CHARS.length)]).join('')
