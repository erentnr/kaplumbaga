import { test, expect } from '@playwright/test'

const newRoom = () => `e2e${Math.random().toString(36).slice(2, 8)}`

// a player in their own browser context, like a separate device
async function joinAs(browser, name, room, { viaHome = false, language } = {}) {
  const context = await browser.newContext()
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

const turtles = (page) => page.locator('.kaplumbaga-wrapper p')
const words = (page) => page.locator('.game-text > span > span')
const message = (page) => page.locator('.game-message')
const input = (page) => page.locator('.game-input input')
const startButton = (page) => page.locator('.start-button')
const languageSelect = (page) => page.locator('.language-select')
const turtleLeft = (page, name) => page.locator('.kaplumbaga-wrapper', { hasText: name })
  .evaluate((el) => parseFloat(getComputedStyle(el).left))

async function typeWholeText(page) {
  const all = await words(page).allTextContents()
  for (let i = 0; i < all.length; i++) {
    await input(page).pressSequentially(i < all.length - 1 ? `${all[i]} ` : all[i])
  }
}

test('players race with a countdown, rematch, late joiners and leaving', async ({ browser }) => {
  const room = newRoom()
  const alice = await joinAs(browser, 'alice', room)
  const bob = await joinAs(browser, 'bob', room, { viaHome: true })

  await expect(turtles(alice.page)).toHaveText(['alice', 'bob'])
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
  await expect(message(alice.page)).toHaveText('alice won!')
  await expect(words(alice.page)).toHaveCount(wordCount)
  await expect(input(bob.page)).toBeDisabled()
  const raceWidth = await alice.page.locator('.kaplumbaga-race').evaluate((el) => el.clientWidth)
  await expect.poll(() => turtleLeft(bob.page, 'alice')).toBeCloseTo(raceWidth - 60, 0)

  // --- race 2: fresh text, names kept, turtles back at the start
  await startButton(bob.page).click()
  await expect(alice.page.locator('.countdown')).toBeVisible()
  await expect(words(alice.page)).toHaveCount(0)
  await expect(words(alice.page)).toHaveCount(wordCount)
  await expect(turtles(alice.page)).toHaveText(['alice', 'bob'])
  await expect.poll(() => turtleLeft(alice.page, 'alice')).toBe(0)

  const carol = await joinAs(browser, 'carol', room)
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

test('connects with a websocket and loads nothing from third parties', async ({ browser }) => {
  const alice = await joinAs(browser, 'alice', newRoom())
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

test('language picker changes the text for everyone in the room', async ({ browser }) => {
  const room = newRoom()
  const alice = await joinAs(browser, 'alice', room, { language: 'tr' })
  const bob = await joinAs(browser, 'bob', room, { language: 'fr' })

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

test('every language can be raced', async ({ browser }) => {
  const room = newRoom()
  const alice = await joinAs(browser, 'alice', room)
  const options = await languageSelect(alice.page).locator('option').evaluateAll(
    (els) => els.map((el) => el.value))
  expect(options).toEqual(['tr', 'en', 'pt', 'de', 'fr', 'es'])

  for (const language of options) {
    await languageSelect(alice.page).selectOption(language)
    await expect(alice.page.locator('.game-text')).toHaveAttribute('lang', language)
    await startButton(alice.page).click()
    await expect(input(alice.page)).toBeFocused()
    await typeWholeText(alice.page)
    await expect(message(alice.page)).toHaveText('alice won!')
  }
  expect(alice.errors).toEqual([])
})

test('invalid room code shows an error', async ({ page }) => {
  await page.goto(`/play/${encodeURIComponent('bad room!')}`)
  await expect(message(page)).toHaveText('invalid room id')
  await expect(startButton(page)).toBeDisabled()
})
