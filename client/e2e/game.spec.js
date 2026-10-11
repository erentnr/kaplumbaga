import { test as base, expect } from '@playwright/test'

const newRoom = () => `e2e${Math.random().toString(36).slice(2, 8)}`

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
const SMALL_PHONE = { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true }

// Stands in for the on-screen keyboard. Browsers report it through
// window.visualViewport, which test browsers never shrink, so the page gets
// a fake one. openKeyboard(height, scrolledBy) leaves `height` pixels visible
// with the page scrolled down by `scrolledBy`, like iOS does to show the input.
const fakeKeyboard = (page) => page.addInitScript(() => {
  let keyboard = null
  const viewport = new EventTarget()
  // read when asked, the page sizes aren't final before the viewport meta
  Object.defineProperties(viewport, {
    width: { get: () => innerWidth },
    height: { get: () => keyboard?.height ?? innerHeight },
    offsetTop: { get: () => keyboard?.scrolledBy ?? 0 },
    offsetLeft: { value: 0 },
    scale: { value: 1 },
  })
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
  window.openKeyboard = (height, scrolledBy) => {
    keyboard = { height, scrolledBy }
    viewport.dispatchEvent(new Event('resize'))
    viewport.dispatchEvent(new Event('scroll'))
  }
})

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
    await roomCodeInput(page).fill(room)
    await page.getByRole('button', { name: 'Join Game' }).click()
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
      const context = await browser.newContext(options?.device ?? {})
      contexts.push(context)
      return openPlayer(context, name, room, options)
    })
    await Promise.all(contexts.map((context) => context.close()))
  },
})

const roomCodeInput = (page) => page.getByLabel('Room code')
// player names, one lane each
const turtles = (page) => page.locator('.lane .tag')
const words = (page) => page.locator('.words .w')
const message = (page) => page.locator('.status')
const input = (page) => page.getByLabel('Your typing')
const startButton = (page) => page.getByRole('button', { name: 'Start', exact: true })
const languageSelect = (page) => page.getByLabel('Language')
// distance of a turtle from the start line, and the room left to the finish line
const turtleOffsets = (page, name) => page.locator('.lane', { hasText: name })
  .evaluate((lane) => {
    const run = lane.querySelector('.lane-run').getBoundingClientRect()
    const turtle = lane.querySelector('.turtle').getBoundingClientRect()
    const name = lane.querySelector('.lane-name').getBoundingClientRect()
    const tag = lane.querySelector('.tag').getBoundingClientRect()
    return {
      fromStart: Math.round(turtle.left - run.left),
      toFinish: Math.round(run.right - turtle.right),
      tagOverflow: Math.round(tag.right - name.right),
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
  await expect(alice.page.locator('.lane-me .tag')).toHaveText('alice')
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
  await expect(words(bob.page).first()).toContainClass('w-ok')
  await expect.poll(() => turtleLeft(alice.page, 'bob')).toBeGreaterThan(0)

  await input(bob.page).pressSequentially('#')
  await expect(words(bob.page).nth(1)).toContainClass('w-bad')
  await expect(bob.page.getByText('Typo. Fix it to keep going.')).toBeVisible()
  await input(bob.page).press('Backspace')
  await expect(words(bob.page).nth(1)).toContainClass('w-cur')
  await expect(bob.page.getByText('Typo. Fix it to keep going.')).toBeHidden()

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
  await expect(roomCodeInput(bob.page)).toBeVisible()
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

  await startButton(alice.page).click()
  await expect(alice.page.locator('.words')).toHaveAttribute('lang', 'de')
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
  // the controls show up with the room
  await expect(turtles(alice.page)).toHaveText(['alice'])
  const options = await languageSelect(alice.page).locator('option').evaluateAll(
    (els) => els.map((el) => el.value))
  expect(options).toEqual(['tr', 'en', 'pt', 'de', 'fr', 'es'])

  for (const language of options) {
    await languageSelect(alice.page).selectOption(language)
    // the select shows the room's language, it changes once the server took it
    await expect(languageSelect(alice.page)).toHaveValue(language)
    await startButton(alice.page).click()
    await expect(input(alice.page)).toBeFocused()
    await expect(alice.page.locator('.words')).toHaveAttribute('lang', language)
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
  // the name is cut short in its column, the turtle says it in full
  expect((await turtleOffsets(racer.page, longName)).tagOverflow).toBeLessThanOrEqual(0)
  await expect(racer.page.getByRole('img', { name: `${longName} (you), winner` })).toBeVisible()
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
    const track = box(document.querySelector('.track'))
    const lanes = [...document.querySelectorAll('.lane')].map(box)
    return {
      top: track.top, bottom: track.bottom,
      lanesTop: Math.min(...lanes.map((lane) => lane.top)),
      lanesBottom: Math.max(...lanes.map((lane) => lane.bottom)),
      textTop: box(document.querySelector('.race-text')).top,
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
  await roomCodeInput(carol.page).fill(` ${baseURL}/play/${room} `)
  await roomCodeInput(carol.page).press('Enter')
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
  await expect(words(bob.page).nth(1)).toContainClass('w-ok')
  // the server keeps the old connection until its ping timeout
  await connections[0].close()
  await expect.poll(() => connections.length).toBe(2)
  await expect(input(bob.page)).toBeEnabled()
  await expect(words(bob.page).nth(1)).toContainClass('w-ok')
  await expect(words(bob.page).nth(2)).toContainClass('w-cur')
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
  await page.getByRole('button', { name: 'Change' }).click()
  await page.getByLabel('Display name').fill('dana')
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByText(/^Joining as dana\./)).toBeVisible()
  // kept for the rest of the visit
  await page.getByRole('button', { name: 'Create Game' }).click()
  await expect(turtles(page)).toHaveText(['dana'])
  expect(errors).toEqual([])
  await context.close()
})

test('the username dialog can be closed without saving', async ({ page }) => {
  await page.goto('/')
  const dialog = page.getByRole('dialog', { name: 'What should we call you?' })
  const nameInput = page.getByLabel('Display name')
  const change = page.getByRole('button', { name: 'Change' })
  const joiningAs = page.getByText(/^Joining as /)
  const before = await joiningAs.textContent()
  for (const close of [
    () => page.getByRole('button', { name: 'Cancel' }).click(),
    () => page.keyboard.press('Escape'),
    () => page.mouse.click(5, 5),  // outside the dialog
  ]) {
    await change.click()
    await expect(nameInput).toBeFocused()
    await nameInput.press('End')
    await nameInput.pressSequentially('x')
    await close()
    await expect(dialog).toBeHidden()
  }
  await expect(joiningAs).toHaveText(before)
  // opened from the keyboard too, with the name to edit, Enter saves
  await change.focus()
  await page.keyboard.press('Enter')
  await expect(nameInput).toBeFocused()
  await expect(nameInput).toHaveValue(before.match(/^Joining as (.+)\./)[1])
  await expect(dialog.getByText('/ 24')).toBeVisible()
  // the old name is selected, typing replaces it
  await page.keyboard.type('erin')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(joiningAs).toHaveText(/^Joining as erin\./)
})

test('the room stays on screen, frozen, while the connection is down', async ({ joinAs }) => {
  const room = newRoom()
  const alice = await joinAs('alice', room)
  let hold = false
  const connections = []
  const held = []
  const bob = await joinAs('bob', room, {
    beforeGoto: (page) => page.routeWebSocket(/socket\.io/, (ws) => {
      // a held connection waits for the server, like a slow network
      if (hold) return held.push(ws)
      ws.onClose(() => {})
      const server = ws.connectToServer()
      server.onClose(() => {})
      connections.push([ws, server])
    }),
  })
  await expect(turtles(bob.page)).toHaveText(['alice', 'bob'])
  hold = true
  // both ends, so the server doesn't keep the socket until its ping timeout;
  // the last one, the server may have turned down earlier ones at its limit
  const [browserSide, serverSide] = connections.at(-1)
  await Promise.all([browserSide.close(), serverSide.close()])
  await expect.poll(() => held.length).toBeGreaterThan(0)
  await expect(message(bob.page)).toHaveText('Connecting...')
  // the last known room, nothing in it can be changed
  await expect(bob.page.locator('.room.is-frozen')).toBeVisible()
  await expect(turtles(bob.page)).toHaveText(['alice', 'bob'])
  await expect(startButton(bob.page)).toBeDisabled()
  await expect(languageSelect(bob.page)).toBeDisabled()
  // it gets through, a new room view takes over
  held[0].onClose(() => {})
  held[0].connectToServer().onClose(() => {})
  await expect(message(bob.page)).toContainText(`Room code: ${room}`)
  await expect(bob.page.locator('.room.is-frozen')).toHaveCount(0)
  await expect(startButton(bob.page)).toBeEnabled()
  await expect(turtles(alice.page)).toHaveText(['alice', 'bob'])
  expect(bob.errors).toEqual([])
})

test('on a phone the race fills the screen with the input at the bottom', async ({ joinAs }) => {
  const racer = await joinAs('alice', newRoom(), { device: PHONE })
  // between races the language and Start sit at the bottom, by the thumbs
  await expect(turtles(racer.page)).toHaveText(['alice'])
  const track = await racer.page.locator('.track').boundingBox()
  expect((await startButton(racer.page).boundingBox()).y).toBeGreaterThan(track.y)
  await startButton(racer.page).click()
  await expect(input(racer.page)).toBeFocused()
  const layout = await racer.page.evaluate(() => ({
    height: window.innerHeight,
    pageHeight: document.documentElement.scrollHeight,
    inputBottom: document.getElementById('typing').getBoundingClientRect().bottom,
  }))
  expect(layout.pageHeight).toBeLessThanOrEqual(layout.height)
  expect(layout.height - layout.inputBottom).toBeLessThan(40)
  // the room code stays, the rest of the header and the controls make room
  await expect(racer.page.getByRole('link', { name: 'Kaplumbaga' })).toBeHidden()
  await expect(startButton(racer.page)).toBeHidden()
  await typeWholeText(racer.page)
  await expect(message(racer.page)).toHaveText('You won!')
  await expect(startButton(racer.page)).toBeVisible()
  expect(racer.errors).toEqual([])
})

test('on a small phone with the keyboard open, the text stays in sight', async ({ joinAs }) => {
  const bottomOf = ({ y, height }) => y + height
  const room = newRoom()
  for (const name of ['bob', 'carol', 'dan', 'erin']) await joinAs(name, room)
  // joins last, so their lane is at the bottom of the track
  const racer = await joinAs('alice', room, { device: SMALL_PHONE, beforeGoto: fakeKeyboard })
  await expect(turtles(racer.page)).toHaveCount(5)
  await startButton(racer.page).click()
  await expect(input(racer.page)).toBeFocused()
  // before the keyboard opens, the input sits at the bottom of the screen
  expect(667 - bottomOf(await input(racer.page).boundingBox())).toBeLessThan(40)
  await racer.page.evaluate(() => window.openKeyboard(300, 260))

  const box = (locator) => locator.boundingBox()
  const within = async (inner, outer) => {
    const [a, b] = [await box(inner), await box(outer)]
    expect(a.y).toBeGreaterThanOrEqual(b.y - 1)
    expect(bottomOf(a)).toBeLessThanOrEqual(bottomOf(b) + 1)
  }
  // the room covers exactly what the keyboard leaves visible
  const visible = await box(racer.page.locator('.room'))
  expect(visible.y).toBeCloseTo(260, 0)
  expect(visible.height).toBeCloseTo(300, 0)
  // a couple of lines of text, your lane, and the input all fit
  const text = racer.page.locator('.race-text')
  expect((await box(text)).height).toBeGreaterThanOrEqual(80)
  await within(text, racer.page.locator('.room'))
  await within(input(racer.page), racer.page.locator('.room'))
  await within(racer.page.locator('.lane-me'), racer.page.locator('.lanes'))
  // the word to type stays in the text box as the race goes on
  const all = await words(racer.page).allTextContents()
  for (let i = 0; i < all.length - 3; i++) {
    await input(racer.page).pressSequentially(`${all[i]} `)
    await within(racer.page.locator('.w-cur'), text)
  }
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
    await expect(roomCodeInput(page)).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/')
  }
})

test('create game opens a new room with a readable code', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText(/^Joining as player\d+\./)).toBeVisible()
  await page.getByRole('button', { name: 'Create Game' }).click()
  await page.waitForURL(/\/play\/[a-km-np-z2-9]{5}$/)
  await expect(turtles(page)).toHaveCount(1)
})

test('invalid room code shows an error', async ({ page }) => {
  await page.goto(`/play/${encodeURIComponent('bad room!')}`)
  await expect(message(page)).toHaveText('invalid room id')
  await expect(page.getByText('Check the code with your friend, or start a new room.')).toBeVisible()
  await expect(startButton(page)).toHaveCount(0)
  await page.getByRole('link', { name: 'Back to home' }).click()
  await expect(roomCodeInput(page)).toBeVisible()
})

test('only the game page connects to the server', async ({ page }) => {
  const websockets = []
  page.on('websocket', (ws) => websockets.push(ws))
  await page.goto('/')
  await expect(roomCodeInput(page)).toBeVisible()
  await page.waitForTimeout(500)
  expect(websockets).toHaveLength(0)
  await page.getByRole('button', { name: 'Create Game' }).click()
  await expect(turtles(page)).toHaveCount(1)
  expect(websockets).toHaveLength(1)
  // back home closes the connection
  await page.goBack()
  await expect.poll(() => websockets[0].isClosed()).toBe(true)
})
