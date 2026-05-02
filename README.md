# garage

Tiny Express app that mediates between a browser and a Wemos (ESP8266) garage door controller. The Wemos polls for commands; the browser sends them.

## Run locally

```bash
npm install
# create config/config.json (see below)
npm start
```

Server listens on `config.port`.

## Config

`config/config.json` is gitignored. Required keys:

```json
{
  "port": 8085,
  "jwtSecret": "<48+ random bytes hex>",
  "passwordHash": "<argon2id hash>",
  "trustIps": ["<wemos public egress IP>"]
}
```

Generate a JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Generate the password hash:

```bash
node -e "import('argon2').then(a => a.default.hash(process.argv[1]).then(console.log))" 'YOUR_PASSWORD'
```

## API

- `GET /setDoorState?doorState=open|closed|moving` — Wemos reports door state, gets pending command in response. Authenticated by trusted IP.
- `GET /getDoorState` — browser polls for current state. Authenticated by JWT cookie.
- `GET /command?command=open|close` — browser issues command. Authenticated by JWT cookie.
- `POST /login` — body `{ "password": "..." }`, sets `garage_token` cookie on success.
- `POST /logout` — clears cookie.

## Deploy

PM2 deploy via GitHub Actions on push to `main`. See `ecosystem.config.cjs` and `.github/workflows/deploy.yml`.
