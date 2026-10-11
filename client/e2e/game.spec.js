import { test as base, expect } from '@playwright/test'

const newRoom = () => `e2e${Math.random().toString(36).slice(2, 8)}`

// a player in their own browser context, like a separate device
async function openPlayer(context, name, room, { viaHome = false, language, beforeGoto } = {}) {
  await context.addInitScript(([username, lang]) => {
    try {
      localStorage.setItem('username', username)
      // init scripts run on every page load, keep a language picked in the game
      if (lang && !localStorage.getItem('language')) localStorage.setItem('language', lang)
    } catch {
      // about:blank has no localStorage
    }
  }, [name, language])
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()))
  const requests = []
  page.on('request', (request) => requests.push(request.url()))
  const websockets = []
  page.on('websocket', (ws) => websockets.push(ws.url()))
  if (beforeGoto) await beforeGoto(page)

  if (viaHome) {
    // enter through the home page so back/forward are in-app navigations
    await page.goto('/')
    await page.fill('.room-code-input', room)
    await page.click('input[value="Join Game"]')
    await page.waitForURL(`**/play/${room}`)
  } else {
    await page.goto(`/play/${room}`)
  }
  return { page, context, errors, requests, websockets }
}

const test = base.extend({
  // opens players, and closes their browser contexts after the test so
  // sockets don't pile up against the per-client connection limit
  // (Playwright calls the second argument `use`, oxlint would take it for a React hook)
  joinAs: async ({ browser }, provide) => {
    const contexts = []
    await provide(async (name, room, options) => {
      // registered before anything can fail, so it is always closed
      const context = await browser.newContext()
      contexts.push(context)
      return openPlayer(context, name, room, options)
    })
    await Promise.all(contexts.map((context) => context.close()))
  },
})

const turtles = (page) => page.locator('.kaplumbaga-wrapper p')
const words = (page) => page.locator('.game-text > span > span')
const message = (page) => page.locator('.game-message')
const input = (page) => page.locator('.game-input input')
const startButton = (page) => page.locator('.start-button')
const languageSelect = (page) => page.locator('.language-select')
// distance of a turtle from the start line, and the room left to the finish line
const turtleOffsets = (page, name) => page.locator('.kaplumbaga-wrapper', { hasText: name })
  .evaluate((lane) => {
    const track = lane.closest('.kaplumbaga-race').getBoundingClientRect()
    const turtle = lane.querySelector('.kaplumbaga').getBoundingClientRect()
    const label = lane.querySelector('p').getBoundingClientRect()
    return {
      fromStart: Math.round(turtle.left - track.left),
      toFinish: Math.round(track.right - turtle.right),
      labelToFinish: Math.round(track.right - label.right),
    }
  })
const turtleLeft = async (page, name) => (await turtleOffsets(page, name)).fromStart

// types the words from `from` on, each as `typed` turns it into keys
async function typeWholeText(page, { from = 0, typed = (word) => word } = {}) {
  const all = await words(page).allTextContents()
  for (let i = from; i < all.length; i++) {
    await input(page).pressSequentially(i < all.length - 1 ? `${typed(all[i])} ` : typed(all[i]))
  }
}

test('players race with a countdown, rematch, late joiners and leaving', async ({ joinAs }) => {
  const room = newRoom()
  const alice = await joinAs('alice', room)
  const bob = await joinAs('bob', room, { viaHome: true })

  await expect(turtles(alice.page)).toHaveText(['alice', 'bob'])
  // your own turtle is marked
  await expect(alice.page.locator('.kaplumbaga-wrapper.me')).toHaveText('alice')
  await expect(message(alice.page)).toContainText(`Room code: ${room}`)

  // --- race 1: countdown, then the text
  await startButton(alice.page).click()
  for (const { page } of [alice, bob]) {
    await expect(page.locator('.countdown')).toBeVisible()
    await expect(message(page)).toHaveText('Get ready!')
    await expect(input(page)).toBeDisabled()
    await expect(startButton(page)).toBeDisabled()
    await expect(languageSelect(page)).toBeDisabled()
  }
  await expect(words(alice.page).first()).toBeVisible()
  await expect(alice.page.locator('.countdown')).toBeHidden()
  await expect(input(bob.page)).toBeFocused()
  const wordCount = await words(alice.page).count()
  await expect(words(bob.page)).toHaveCount(wordCount)

  const firstWord = await words(bob.page).first().textContent()
  await input(bob.page).pressSequentially(`${firstWord} `)
  await expect(words(bob.page).first()).toHaveClass('correct')
  await expect.poll(() => turtleLeft(alice.page, 'bob')).toBeGreaterThan(0)

  await input(bob.page).pressSequentially('#')
  await expect(words(bob.page).nth(1)).toHaveClass('wrong')
  await input(bob.page).press('Backspace')
  await expect(words(bob.page).nth(1)).toHaveClass('current')

  await typeWholeText(alice.page)
  await expect(message(bob.page)).toHaveText('alice won!')
  await expect(message(alice.page)).toHaveText('You won!')
  await expect(words(alice.page)).toHaveCount(wordCount)
  await expect(input(bob.page)).toBeDisabled()
  await expect.poll(async () => (await turtleOffsets(bob.page, 'alice')).toFinish).toBe(0)

  // --- race 2: fresh text, names kept, turtles back at the start
  await startButton(bob.page).click()
  await expect(alice.page.locator('.countdown')).toBeVisible()
  await expect(words(alice.page)).toHaveCount(0)
  await expect(words(alice.page)).toHaveCount(wordCount)
  await expect(turtles(alice.page)).toHaveText(['alice', 'bob'])
  await expect.poll(() => turtleLeft(alice.page, 'alice')).toBe(0)

  const carol = await joinAs('carol', room)
  await expect(message(carol.page)).toHaveText('Race in progress, you can join the next one.')
  await expect(startButton(carol.page)).toBeDisabled()
  await expect(turtles(alice.page)).toHaveText(['alice', 'bob', 'carol'])

  // --- in-app navigation unmounts the game: bob leaves and comes back
  await bob.page.goBack()
  await expect(bob.page.locator('.room-code-input')).toBeVisible()
  await expect(turtles(alice.page)).toHaveText(['alice', 'carol'])
  await bob.page.goForward()
  await expect(turtles(alice.page)).toHaveText(['alice', 'carol', 'bob'])

  // --- race 3: the re-mounted game shows the text once, carol can play
  await typeWholeText(alice.page)
  await expect(message(carol.page)).toHaveText('alice won!')
  await startButton(carol.page).click()
  await expect(words(bob.page)).toHaveCount(wordCount)
  await expect(input(carol.page)).toBeEnabled()

  // --- closing the tab removes the player
  await carol.context.close()
  await expect(turtles(alice.page)).toHaveText(['alice', 'bob'])

  expect([...alice.errors, ...bob.errors]).toEqual([])
})

test('connects with a websocket and loads nothing from third parties', async ({ joinAs }) => {
  const alice = await joinAs('alice', newRoom())
  await expect(turtles(alice.page)).toHaveText(['alice'])
  // the font is bundled, the server is the only other host
  expect(alice.requests.length).toBeGreaterThan(0)
  for (const url of alice.requests) {
    expect(new URL(url).host).toBe('localhost:4173')
  }
  expect(alice.websockets).toHaveLength(1)
  expect(alice.websockets[0]).toMatch(/^ws:\/\/localhost:8000\/socket\.io\/\?EIO=4&transport=websocket/)
  expect(alice.errors).toEqual([])
})

test('language picker changes the text for everyone in the room', async ({ joinAs }) => {
  const room = newRoom()
  const alice = await joinAs('alice', room, { language: 'tr' })
  const bob = await joinAs('bob', room, { language: 'fr' })

  // the room keeps its creator's language
  await expect(languageSelect(bob.page)).toHaveValue('tr')

  await languageSelect(bob.page).selectOption('de')
  await expect(languageSelect(alice.page)).toHaveValue('de')
  await expect(alice.page.locator('.game-text')).toHaveAttribute('lang', 'de')

  await startButton(alice.page).click()
  await expect(words(alice.page).first()).toHaveText('Die')
  await expect(words(bob.page).first()).toHaveText('Die')

  // accented letters can be typed to the finish
  await typeWholeText(bob.page)
  await expect(message(alice.page)).toHaveText('bob won!')

  // bob's pick is remembered for rooms he creates
  const otherRoom = newRoom()
  await bob.page.goto(`/play/${otherRoom}`)
  await expect(languageSelect(bob.page)).toHaveValue('de')

  expect([...alice.errors, ...bob.errors]).toEqual([])
})

test('every language can be raced', async ({ joinAs }) => {
  const room = newRoom()
  const alice = await joinAs('alice', room)
  const options = await languageSelect(alice.page).locator('option').evaluateAll(
    (els) => els.map((el) => el.value))
  expect(options).toEqual(['tr', 'en', 'pt', 'de', 'fr', 'es'])

  for (const language of options) {
    await languageSelect(alice.page).selectOption(language)
    await expect(alice.page.locator('.game-text')).toHaveAttribute('lang', language)
    await startButton(alice.page).click()
    await expect(input(alice.page)).toBeFocused()
    // phone keyboards can type a curly apostrophe for the straight one in "l'heure"
    await typeWholeText(alice.page, { typed: (word) => word.replaceAll("'", '\u2019') })
    await expect(message(alice.page)).toHaveText('You won!')
  }
  expect(alice.errors).toEqual([])
})

test('a long name keeps the turtle inside the track', async ({ joinAs }) => {
  const longName = 'Wolfeschlegelsteinhausen'
  const racer = await joinAs(longName, newRoom())
  await startButton(racer.page).click()
  await expect(words(racer.page).first()).toBeVisible()
  await typeWholeText(racer.page)
  await expect(message(racer.page)).toHaveText('You won!')
  await expect.poll(async () => (await turtleOffsets(racer.page, longName)).toFinish).toBe(0)
  expect((await turtleOffsets(racer.page, longName)).labelToFinish).toBeGreaterThanOrEqual(0)
})

test('a classroom fits on the track', async ({ joinAs }) => {
  // the track had a fixed height, more than ~8 players overlapped the text
  const room = newRoom()
  const teacher = await joinAs('teacher', room)
  for (let i = 1; i < 12; i++) {
    // tabs of one browser, each its own player
    await teacher.context.newPage().then((page) => page.goto(`/play/${room}`))
  }
  await expect(turtles(teacher.page)).toHaveCount(12)
  const layout = await teacher.page.evaluate(() => {
    const box = (element) => element.getBoundingClientRect()
    const track = box(document.querySelector('.kaplumbaga-race'))
    const lanes = [...document.querySelectorAll('.kaplumbaga-wrapper')].map(box)
    return {
      top: track.top, bottom: track.bottom,
      lanesTop: Math.min(...lanes.map((lane) => lane.top)),
      lanesBottom: Math.max(...lanes.map((lane) => lane.bottom)),
      textTop: box(document.querySelector('.game-text')).top,
    }
  })
  expect(layout.lanesTop).toBeGreaterThanOrEqual(layout.top)
  expect(layout.lanesBottom).toBeLessThanOrEqual(layout.bottom)
  expect(layout.bottom).toBeLessThanOrEqual(layout.textTop)
})

test('room codes ignore case and a pasted invite link works', async ({ joinAs, baseURL }) => {
  const room = newRoom()
  const alice = await joinAs('alice', room)
  // a phone keyboard capitalized the code
  const bob = await joinAs('bob', room.toUpperCase())
  await expect(turtles(alice.page)).toHaveText(['alice', 'bob'])
  await expect(message(bob.page)).toContainText(`Room code: ${room}`)

  const carol = await joinAs('carol', newRoom())
  await carol.page.goto('/')
  await carol.page.fill('.room-code-input', ` ${baseURL}/play/${room} `)
  await carol.page.press('.room-code-input', 'Enter')
  await carol.page.waitForURL(`**/play/${room}`)
  await expect(turtles(alice.page)).toHaveText(['alice', 'bob', 'carol'])
})

test('a room address with a trailing line break still works', async ({ joinAs }) => {
  // the server trims the code, the client has to match its messages
  const room = newRoom()
  const alice = await joinAs('alice', room)
  const bob = await joinAs('bob', `${room}%0A`)
  await expect(turtles(bob.page)).toHaveText(['alice', 'bob'])
  await expect(message(bob.page)).toContainText(`Room code: ${room}.`)
  await startButton(bob.page).click()
  await expect(words(alice.page).first()).toBeVisible()
  await expect(words(bob.page).first()).toBeVisible()
})

test('a racer who reconnects types on from where they were', async ({ joinAs }) => {
  const room = newRoom()
  const alice = await joinAs('alice', room)
  const connections = []
  const bob = await joinAs('bob', room, {
    beforeGoto: (page) => page.routeWebSocket(/socket\.io/, (ws) => {
      connections.push(ws)
      ws.onClose(() => {})
      ws.connectToServer().onClose(() => {})
    }),
  })
  await startButton(alice.page).click()
  await expect(input(bob.page)).toBeEnabled()
  const [first, second] = await words(bob.page).allTextContents()
  await input(bob.page).pressSequentially(`${first} ${second} `)
  await expect(words(bob.page).nth(1)).toHaveClass('correct')
  // the server keeps the old connection until its ping timeout
  await connections[0].close()
  await expect.poll(() => connections.length).toBe(2)
  await expect(input(bob.page)).toBeEnabled()
  await expect(words(bob.page).nth(1)).toHaveClass('correct')
  await expect(words(bob.page).nth(2)).toHaveClass('current')
  await typeWholeText(bob.page, { from: 2 })
  await expect(message(bob.page)).toHaveText('You won!')
  await expect(message(alice.page)).toHaveText('bob won!')
})

test('the player is told when the server turns down a change', async ({ joinAs }) => {
  // the replies were thrown away, the picker or Start just did nothing
  const alice = await joinAs('alice', newRoom())
  await expect(turtles(alice.page)).toHaveText(['alice'])
  // more changes than the server takes at once
  for (let i = 0; i < 20; i++) {
    await languageSelect(alice.page).selectOption(i % 2 ? 'de' : 'fr')
  }
  await expect(message(alice.page)).toHaveText('too many requests')
  // the next change that goes through clears it
  await expect(async () => {
    await startButton(alice.page).click()
    await expect(message(alice.page)).toHaveText('Get ready!', { timeout: 500 })
  }).toPass()
})

test('works when the browser blocks site data', async ({ browser }) => {
  // localStorage throws then, the app went blank
  const context = await browser.newContext()
  await context.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() { throw new DOMException('The operation is insecure.', 'SecurityError') },
    })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.click('.change-username')
  await page.fill('.username-input', 'dana')
  await page.click('.username-save-button')
  await expect(page.getByText(/^Joining as dana\./)).toBeVisible()
  // kept for the rest of the visit
  await page.click('input[value="Create Game"]')
  await expect(turtles(page)).toHaveText(['dana'])
  expect(errors).toEqual([])
  await context.close()
})

test('the username dialog can be closed without saving', async ({ page }) => {
  await page.goto('/')
  const dialog = page.locator('.modal-main')
  const change = page.getByRole('button', { name: 'Change' })
  const joiningAs = page.getByText(/^Joining as /)
  const before = await joiningAs.textContent()
  for (const close of [
    () => page.click('input[value="Cancel"]'),
    () => page.keyboard.press('Escape'),
    () => page.mouse.click(5, 5),  // outside the dialog
  ]) {
    await change.click()
    await expect(page.locator('.username-input')).toBeFocused()
    await close()
    await expect(dialog).toBeHidden()
  }
  await expect(joiningAs).toHaveText(before)
  // opened from the keyboard too, Enter saves
  await change.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.username-input')).toBeFocused()
  await page.keyboard.type('erin')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(joiningAs).toHaveText(/^Joining as erin\./)
})

test('a tab that reconnects keeps its name', async ({ joinAs }) => {
  const room = newRoom()
  const alice = await joinAs('alice', room)
  const connections = []
  const bob = await joinAs('bob', room, {
    beforeGoto: (page) => page.routeWebSocket(/socket\.io/, (ws) => {
      connections.push(ws)
      // with close handlers, closing one side doesn't close the other
      ws.onClose(() => {})
      ws.connectToServer().onClose(() => {})
    }),
  })
  await expect(turtles(alice.page)).toHaveText(['alice', 'bob'])
  // drop the connection on the browser side only, like a phone switching
  // networks: the server keeps the old one until its ping timeout
  await connections[0].close()
  await expect.poll(() => connections.length).toBe(2)
  await expect(turtles(bob.page)).toHaveText(['alice', 'bob'])
  await expect(turtles(alice.page)).toHaveText(['alice', 'bob'])
})

test('a copy of a tab is another player', async ({ joinAs }) => {
  const room = newRoom()
  const alice = await joinAs('alice', room)
  // joined, so a tab id kept in sessionStorage would be there to copy
  await expect(turtles(alice.page)).toHaveText(['alice'])
  // window.open copies sessionStorage, like duplicating a tab
  const [copy] = await Promise.all([
    alice.page.waitForEvent('popup'),
    alice.page.evaluate(() => window.open(location.href)),
  ])
  await expect(turtles(copy)).toHaveText(['alice', 'alice 2'])
  await expect(turtles(alice.page)).toHaveText(['alice', 'alice 2'])
})

test('unknown addresses go to the home page', async ({ page }) => {
  for (const path of ['/foo', '/play/', '/play']) {
    await page.goto(path)
    await expect(page.locator('.room-code-input')).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/')
  }
})

test('create game opens a new room with a readable code', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText(/^Joining as player\d+\./)).toBeVisible()
  await page.click('input[value="Create Game"]')
  await page.waitForURL(/\/play\/[a-km-np-z2-9]{5}$/)
  await expect(turtles(page)).toHaveCount(1)
})

test('invalid room code shows an error', async ({ page }) => {
  await page.goto(`/play/${encodeURIComponent('bad room!')}`)
  await expect(message(page)).toHaveText('invalid room id')
  await expect(startButton(page)).toHaveCount(0)
  await page.getByRole('link', { name: 'Back to the home page' }).click()
  await expect(page.locator('.room-code-input')).toBeVisible()
})

test('only the game page connects to the server', async ({ page }) => {
  const websockets = []
  page.on('websocket', (ws) => websockets.push(ws))
  await page.goto('/')
  await expect(page.locator('.room-code-input')).toBeVisible()
  await page.waitForTimeout(500)
  expect(websockets).toHaveLength(0)
  await page.click('input[value="Create Game"]')
  await expect(turtles(page)).toHaveCount(1)
  expect(websockets).toHaveLength(1)
  // back home closes the connection
  await page.goBack()
  await expect.poll(() => websockets[0].isClosed()).toBe(true)
})
