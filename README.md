
# WebProxy

Browse websites through a remote browser using a simple webpage. WebProxy launches Chromium and streams the browser screen directly to your webpage, with mouse and keyboard controls.

## Features

- Remote browser streaming.
- Mouse movement, clicking, scrolling and dragging.
- Full keyboard input support, including typing, shortcuts, modifiers, function keys and navigation keys.
- Browser navigation (back, forward, reload and stop).
- HTTP and HTTPS website support.
- WebSocket-based communication.
- Automatic session cleanup.
- Multiple browser sessions (up to 4 by default).
- Configurable screen resolution and streaming quality.

## Requirements

- Node.js
- npm
- Chromium (installed through Playwright)
- HTTPS certificates for the HTTPS version.

## Installation

Clone the repository:

```bash
git clone https://github.com/RTBExtreme/WebProxy.git
cd WebProxy
```

Initialize the project:

```bash
npm init -y
```

Install dependencies:

```bash
npm install express compression playwright ws ipaddr.js
```

Install Chromium:

```bash
npx playwright install chromium
```

## Configuration

Create or edit `config.json`:

```json
{
  "logRequests": true
}
```

Set `logRequests` to `false` to disable request logging.

## HTTPS Version

The HTTPS server uses:

- `proxy-server.js`
- `server.key`
- `server.cert`

Make sure your HTTPS private key and certificate are valid and belong to your server.

To change the HTTPS port, edit:

```javascript
const PORT = Number(process.env.PORT || 443);
```

Start the HTTPS server:

```bash
node proxy-server.js
```

By default, the server listens on:

```text
https://localhost:443/
```

## HTTP Version (No HTTPS)

If you don't want to use HTTPS, run:

```bash
node proxy-server-nohttps.js
```

The HTTP version uses the same browser streaming and input functionality but does not require HTTPS certificates.

## Keyboard Controls

WebProxy supports:

- Typing text.
- Enter, Tab, Escape and Backspace.
- Arrow keys and navigation keys.
- Shift, Ctrl, Alt and Meta modifiers.
- Keyboard shortcuts such as Ctrl+A, Ctrl+C, Ctrl+V and Ctrl+Z.
- Function keys (F1–F24).
- Numpad keys.
- Keydown and keyup events for holding keys.

The frontend must forward keyboard events through the WebSocket connection.

## Server Settings

The following settings can be changed in the server code:

| Setting | Default | Description |
|---|---|---|
| `PORT` | 443 (HTTPS) | Server port |
| `MAX_SESSIONS` | 4 | Maximum concurrent browser sessions |
| `SESSION_TIMEOUT` | 60000 | Session timeout in milliseconds |
| `WIDTH` | 1280 | Browser width |
| `HEIGHT` | 800 | Browser height |
| `FRAME_INTERVAL` | 250 | Screenshot interval in milliseconds |
| `FRAME_QUALITY` | 45 | JPEG screenshot quality |

## Important Security Information

The original example certificates and private keys are for testing only. Replace them with your own certificates before deployment.

Never publish or share your private key.

WebProxy can browse external websites, so it should not be exposed as an unrestricted public service. Use authentication, access controls and appropriate network restrictions before deploying it publicly.

## Troubleshooting

### Chromium not found

Run:

```bash
npx playwright install chromium
```

### HTTPS certificate error

Check that `server.key` and `server.cert` exist and match.

### Port already in use

Change the `PORT` setting or stop the process using that port.

### Keyboard not working

Make sure your frontend sends the appropriate WebSocket `type`, `key`, `keydown` and `keyup` messages.

### Browser sessions unavailable

Check the active session count and wait for an existing session to expire.

## License

See the repository for licensing information.
