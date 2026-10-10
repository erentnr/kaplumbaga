// Uniform random integer in [0, max) from the Web Crypto API, Math.random() is
// predictable. Values from the incomplete last range are drawn again, a plain
// modulo would make small numbers slightly more likely.
export const randomInt = (max) => {
  const limit = 2 ** 32 - (2 ** 32 % max)
  for (;;) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0]
    if (value >= limit) continue
    return value % max
  }
}

// room codes skip letters that are easy to confuse when shared: l, o, 0 and 1
const ROOM_CODE_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789'

export const randomRoomCode = (length = 5) =>
  Array.from({ length }, () => ROOM_CODE_CHARS[randomInt(ROOM_CODE_CHARS.length)]).join('')
