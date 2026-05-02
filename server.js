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

const trustIps = new Set(config.trustIps || [])

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
 * GET /command
 *
 * Typically issued by a web client user
 *
 * Query params:
 *   command: The desired command to send to the door: open or close.
 */
app.get('/command', auth, (req, res) => {
  if (req.query.command === 'open') {
    command = 'open'
    commandTimestamp = Date.now()
  }
  if (req.query.command === 'close') {
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
}, 500)


app.use(express.static('public'))

app.listen(config.port, function () {
  console.log('Garage app listening on port ' + config.port)
})
