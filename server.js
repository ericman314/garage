import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import argon2 from 'argon2'
import { readFileSync } from 'node:fs'

const config = JSON.parse(readFileSync('./config/config.json', 'utf8'))
if (!config.jwtSecret) throw new Error('config.jwtSecret is required')
if (!config.passwordHash) throw new Error('config.passwordHash is required')
const app = express()
app.set('trust proxy', 'loopback')

const JWT_TTL_SECONDS = 60 * 60 * 24 * 30
const COOKIE_NAME = 'garage_token'

// Global state
let doorState = 'unknown'
let doorStateTimestamp = 0

let command = 'ok'
let commandTimestamp = 0

let userInteractionTimestamp = 0

// Open-door alerting. openSinceTimestamp accumulates only while the door is
// confirmed open; a lapse to 'unknown' (wemos offline) freezes it rather than
// resetting, so a brief wifi drop doesn't restart the clock.
let openElapsedMs = 0
let openElapsedTickTimestamp = 0
let alertsSent = 0
let offlineAlertSent = false

// Doubling up to 16h, then once every 24h of open time (24h, 48h, 72h, ...).
const ALERT_THRESHOLDS_MS = [1, 2, 4, 8, 16].map(h => h * 60 * 60 * 1000)
const ALERT_INTERVAL_AFTER_MS = 24 * 60 * 60 * 1000

const trustIps = new Set(config.trustIps || [])

/**
 * Push a notification via ntfy. Fire-and-forget: a failed alert must never
 * take down the door-control loop, so errors are logged and swallowed.
 */
const notify = async (message, { title, priority } = {}) => {
  if (!config.ntfyTopic) return
  const headers = {}
  if (title) headers.Title = title
  if (priority) headers.Priority = priority
  try {
    const res = await fetch(`https://ntfy.sh/${config.ntfyTopic}`, {
      method: 'POST',
      body: message,
      headers,
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) console.error(`ntfy responded ${res.status}`)
  } catch (err) {
    console.error('ntfy notify failed:', err.message)
  }
}

const formatDuration = ms => {
  const hours = Math.round(ms / (60 * 60 * 1000))
  return hours === 1 ? '1 hour' : `${hours} hours`
}

const auth = (req, res, next) => {
  if (trustIps.has(req.ip)) return next()

  const token = req.cookies?.[COOKIE_NAME]
  if (token) {
    try {
      jwt.verify(token, config.jwtSecret)
      return next()
    } catch {}
  }

  res.status(401).json({ error: 'unauthorized' })
}

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())

app.post('/login', async (req, res) => {
  const { password } = req.body || {}
  let ok = false
  if (typeof password === 'string') {
    try { ok = await argon2.verify(config.passwordHash, password) } catch {}
  }
  if (!ok) {
    return res.status(401).json({ error: 'invalid password' })
  }
  const token = jwt.sign({ sub: 'user' }, config.jwtSecret, { expiresIn: JWT_TTL_SECONDS })
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    path: '/',
    maxAge: JWT_TTL_SECONDS * 1000,
  })
  res.json({ ok: true })
})

app.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' })
  res.json({ ok: true })
})

/**
 * GET /setDoorState
 *
 * Typically issued by the door wemos every 1 to 5 seconds to set the door state and check for commands
 *
 * Query params:
 *   doorState: The current actual state of the door: open, closed, or moving.
 *
 * Response:
 *   ok: Take no action
 *   standby: User has opened webpage; briefly increase rate of request polling
 *   open: Open the door
 *   close: Close the door
 */
app.get('/setDoorState', auth, (req, res) => {
  if (req.query.doorState === 'open') {
    doorState = 'open'
    doorStateTimestamp = Date.now()
  } else if (req.query.doorState === 'closed') {
    doorState = 'closed'
    doorStateTimestamp = Date.now()
  } else if (req.query.doorState === 'moving') {
    doorState = 'moving'
    doorStateTimestamp = Date.now()
  }

  // Send command
  res.send(command)
})


/**
 * GET /getDoorState
 *
 * Typically issued by web client user.
 *
 * Response: object containing the current doorState, the age of that state in ms, and the current command being sent to the door.
 */
app.get('/getDoorState', auth, (req, res) => {
  userInteractionTimestamp = Date.now()
  res.json({ doorState, age: Date.now() - doorStateTimestamp, command })
})

/**
 * POST /command
 *
 * Typically issued by a web client user
 *
 * Body:
 *   command: The desired command to send to the door: open or close.
 */
app.post('/command', auth, (req, res) => {
  if (req.body?.command === 'open') {
    command = 'open'
    commandTimestamp = Date.now()
  }
  if (req.body?.command === 'close') {
    command = 'close'
    commandTimestamp = Date.now()
  }
  res.json('ok')
})

setInterval(() => {
  if (Date.now() - commandTimestamp > 15000) {
    // Reset commands that are >15 seconds old
    if (Date.now() - userInteractionTimestamp > 15000) {
      command = 'ok'
    } else {
      command = 'standby'
    }
  }

  if (Date.now() - doorStateTimestamp > 60000) {
    // Reset doorState that is >60 seconds old
    doorState = 'unknown'
  }

  // Accumulate open time and fire alerts at the doubling thresholds.
  const now = Date.now()
  if (doorState === 'open') {
    if (openElapsedTickTimestamp) openElapsedMs += now - openElapsedTickTimestamp
    openElapsedTickTimestamp = now
    offlineAlertSent = false

    const threshold = alertsSent < ALERT_THRESHOLDS_MS.length
      ? ALERT_THRESHOLDS_MS[alertsSent]
      : ALERT_INTERVAL_AFTER_MS * (alertsSent - ALERT_THRESHOLDS_MS.length + 1)

    if (openElapsedMs >= threshold) {
      alertsSent++
      notify(`Garage door has been open for ${formatDuration(openElapsedMs)}.`, {
        title: 'Garage door open',
        priority: 'high',
      })
    }
  } else if (doorState === 'closed') {
    // Door confirmed closed: clear everything.
    openElapsedMs = 0
    openElapsedTickTimestamp = 0
    alertsSent = 0
    offlineAlertSent = false
  } else {
    // 'unknown' or 'moving': freeze the accumulator, don't reset it.
    openElapsedTickTimestamp = 0
    // Sensor dropped out while we were tracking an open door — that's worth
    // knowing about, since it means we can no longer see the real state.
    if (doorState === 'unknown' && openElapsedMs > 0 && !offlineAlertSent) {
      offlineAlertSent = true
      notify(
        `Garage sensor went offline. Door was last seen OPEN for ${formatDuration(openElapsedMs)}.`,
        { title: 'Garage sensor offline', priority: 'high' },
      )
    }
  }
}, 500)


app.use(express.static('public'))

app.listen(config.port, function () {
  console.log('Garage app listening on port ' + config.port)
})
