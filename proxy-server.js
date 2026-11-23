
'use strict';

const express = require('express');
const compression = require('compression');
const { chromium } = require('playwright');
const WebSocket = require('ws');
const crypto = require('crypto');
const https = require('https');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const ipaddr = require('ipaddr.js');
const fs = require('fs');

const app = express();

const PORT = Number(process.env.PORT || 443);
const HOST = process.env.HOST || '127.0.0.1';

const MAX_SESSIONS = 4;
const SESSION_TIMEOUT = 60000;

const WIDTH = 1280;
const HEIGHT = 800;

const FRAME_INTERVAL = 0;
const FRAME_QUALITY = 45;
const MAX_BUFFER = 512 * 1024;
const MAX_QUEUE = 256;

let browser;
let pendingSessions = 0;
let shuttingDown = false;

const sessions = new Map();
const dnsCache = new Map();

let config;

try {
  config = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')
  );

  if (typeof config.logRequests !== 'boolean') {
    throw new Error('Invalid logRequests configuration');
  }
} catch (error) {
  console.error('Configuration error:', error.message);
  process.exit(1);
}

const httpsOptions = {
  key: fs.readFileSync(path.join(__dirname, 'server.key')),
  cert: fs.readFileSync(path.join(__dirname, 'server.cert'))
};

const server = https.createServer(httpsOptions, app);

const wss = new WebSocket.Server({
  noServer: true,
  maxPayload: 4096,
  perMessageDeflate: false
});

app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function isPublicIP(address) {
  try {
    return ipaddr.parse(address).range() === 'unicast';
  } catch {
    return false;
  }
}

async function validateURL(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('Invalid URL');
  }

  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP and HTTPS are supported');
  }

  if (url.username || url.password) {
    throw new Error('URL credentials are not allowed');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('Destination not allowed');
  }

  if (net.isIP(hostname)) {
    if (!isPublicIP(hostname)) {
      throw new Error('Private IP addresses are blocked');
    }

    return url.href;
  }

  const cached = dnsCache.get(hostname);

  if (cached && cached.expires > Date.now()) {
    if (!cached.safe) {
      throw new Error('Restricted destination');
    }

    return url.href;
  }

  let addresses;

  try {
    addresses = await dns.lookup(hostname, {
      all: true,
      verbatim: true
    });
  } catch {
    throw new Error('Unable to resolve website');
  }

  const safe =
    addresses.length > 0 &&
    addresses.every(item => isPublicIP(item.address));

  dnsCache.set(hostname, {
    safe,
    expires: Date.now() + 30000
  });

  if (!safe) {
    throw new Error('Website resolves to a restricted address');
  }

  return url.href;
}

function getSession(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) {
    return undefined;
  }

  return sessions.get(id);
}

async function closeSession(id) {
  const session = sessions.get(id);

  if (!session) return;

  sessions.delete(id);

  if (session.frameTimer) {
    clearInterval(session.frameTimer);
  }

  if (session.ws) {
    try {
      session.ws.close(1000, 'Session closed');
    } catch {}
  }

  await session.context.close().catch(() => {});
}

app.post('/api/session', async (req, res) => {
  if (shuttingDown) {
    return res.status(503).json({
      error: 'Server is shutting down'
    });
  }

  if (sessions.size + pendingSessions >= MAX_SESSIONS) {
    return res.status(503).json({
      error: 'All browsers are busy'
    });
  }

  pendingSessions++;

  let context;

  try {
    const target = await validateURL(req.body?.url);

    if (config.logRequests) {
      console.log('[SESSION]', target);
    }

    context = await browser.newContext({
      viewport: {
        width: WIDTH,
        height: HEIGHT
      },
      screen: {
        width: WIDTH,
        height: HEIGHT
      }
    });

    await context.route('**/*', async route => {
      try {
        const requestURL = route.request().url();

        if (/^(data:|blob:|about:)/i.test(requestURL)) {
          return route.continue();
        }

        await validateURL(requestURL);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient').catch(() => {});
      }
    });

    const page = await context.newPage();

    await page.goto(target, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    const id = crypto.randomBytes(32).toString('hex');

    sessions.set(id, {
      id,
      context,
      page,
      ws: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      messageTimes: [],
      frameTimer: null,
      captureRunning: false,
      processing: false,
      inputQueue: []
    });

    res.json({
      success: true,
      id,
      url: page.url(),
      width: WIDTH,
      height: HEIGHT
    });

  } catch (error) {
    if (context) {
      await context.close().catch(() => {});
    }

    res.status(400).json({
      error: error.message || 'Could not start browser'
    });

  } finally {
    pendingSessions--;
  }
});

app.get('/api/session/:id', (req, res) => {
  const session = getSession(req.params.id);

  if (
    !session ||
    session.page.isClosed() ||
    Date.now() - session.lastActivity >= SESSION_TIMEOUT
  ) {
    if (session) closeSession(session.id);

    return res.status(404).json({
      error: 'Session expired'
    });
  }

  session.lastActivity = Date.now();

  res.json({
    success: true,
    url: session.page.url()
  });
});

app.delete('/api/session/:id', async (req, res) => {
  await closeSession(req.params.id);

  res.json({
    success: true
  });
});

const allowedKeys = new Set([
  'Enter', 'Tab', 'Escape',
  'Backspace', 'Delete', 'Insert',
  'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'Shift', 'Control', 'Alt', 'Meta',
  'CapsLock', 'NumLock', 'ScrollLock',
  'Space', ' ',
  'PrintScreen', 'Pause', 'ContextMenu', 'Clear',

  'F1', 'F2', 'F3', 'F4',
  'F5', 'F6', 'F7', 'F8',
  'F9', 'F10', 'F11', 'F12',
  'F13', 'F14', 'F15', 'F16',
  'F17', 'F18', 'F19', 'F20',
  'F21', 'F22', 'F23', 'F24',

  'Numpad0', 'Numpad1', 'Numpad2',
  'Numpad3', 'Numpad4', 'Numpad5',
  'Numpad6', 'Numpad7', 'Numpad8',
  'Numpad9',

  'NumpadAdd', 'NumpadSubtract',
  'NumpadMultiply', 'NumpadDivide',
  'NumpadDecimal', 'NumpadEnter'
]);

function validKey(key) {
  return (
    typeof key === 'string' &&
    key.length <= 80 &&
    (
      allowedKeys.has(key) ||
      (
        [...key].length === 1 &&
        !/[\u0000-\u001f\u007f]/.test(key)
      )
    )
  );
}

function validMessage(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }

  switch (data.action) {
    case 'heartbeat':
    case 'up':
    case 'back':
    case 'forward':
    case 'reload':
    case 'stop':
      return true;

    case 'move':
    case 'down':
    case 'click':
      return (
        Number.isFinite(data.x) &&
        Number.isFinite(data.y) &&
        data.x >= 0 && data.x <= WIDTH &&
        data.y >= 0 && data.y <= HEIGHT
      );

    case 'scroll':
      return (
        Number.isFinite(data.deltaX) &&
        Number.isFinite(data.deltaY) &&
        Math.abs(data.deltaX) <= 1000 &&
        Math.abs(data.deltaY) <= 1000
      );

    case 'type':
      return (
        typeof data.text === 'string' &&
        data.text.length <= 1000
      );

    case 'key':
    case 'keydown':
    case 'keyup':
      return validKey(data.key);

    case 'navigate':
      return (
        typeof data.url === 'string' &&
        data.url.length <= 2048
      );

    default:
      return false;
  }
}

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, 'https://localhost');

    if (url.pathname !== '/stream') {
      socket.destroy();
      return;
    }

    const origin = req.headers.origin;

    if (!origin || new URL(origin).host !== req.headers.host) {
      socket.destroy();
      return;
    }

    const session = getSession(url.searchParams.get('session'));

    if (
      !session ||
      session.ws ||
      Date.now() - session.lastActivity >= SESSION_TIMEOUT
    ) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, session);
    });

  } catch {
    socket.destroy();
  }
});

wss.on('connection', (ws, session) => {
  session.ws = ws;
  session.lastActivity = Date.now();

  let closed = false;

  ws.on('pong', () => {
    session.lastActivity = Date.now();
  });

  async function sendFrame() {
    if (
      closed ||
      session.captureRunning ||
      ws.readyState !== WebSocket.OPEN ||
      ws.bufferedAmount > MAX_BUFFER
    ) {
      return;
    }

    session.captureRunning = true;

    try {
      if (!session.page.isClosed()) {
        const frame = await session.page.screenshot({
          type: 'jpeg',
          quality: FRAME_QUALITY,
          timeout: 10000,
          animations: 'disabled'
        });

        if (
          !closed &&
          ws.readyState === WebSocket.OPEN &&
          ws.bufferedAmount < MAX_BUFFER
        ) {
          ws.send(frame);
        }
      }
    } catch {
      
    } finally {
      session.captureRunning = false;
    }
  }

  session.frameTimer = setInterval(sendFrame, FRAME_INTERVAL);
  sendFrame();

  async function executeAction(data) {
    const page = session.page;

    if (page.isClosed()) {
      ws.close();
      return;
    }

    switch (data.action) {
      case 'click':
        await page.mouse.click(data.x, data.y);
        break;

      case 'down':
        await page.mouse.down();
        break;

      case 'up':
        await page.mouse.up();
        break;

      case 'move':
        await page.mouse.move(data.x, data.y);
        break;

      case 'scroll':
        await page.mouse.wheel(data.deltaX, data.deltaY);
        break;

      case 'type':
        await page.keyboard.insertText(data.text);
        break;

      case 'key':
        await page.keyboard.press(data.key);
        break;

      case 'keydown':
        await page.keyboard.down(data.key);
        break;

      case 'keyup':
        await page.keyboard.up(data.key);
        break;

      case 'navigate': {
        const target = await validateURL(data.url);

        await page.goto(target, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });

        break;
      }

      case 'back':
        await page.goBack({
          waitUntil: 'domcontentloaded',
          timeout: 15000
        }).catch(() => {});
        break;

      case 'forward':
        await page.goForward({
          waitUntil: 'domcontentloaded',
          timeout: 15000
        }).catch(() => {});
        break;

      case 'reload':
        await page.reload({
          waitUntil: 'domcontentloaded',
          timeout: 30000
        }).catch(() => {});
        break;

      case 'stop':
        await page.evaluate(() => window.stop()).catch(() => {});
        break;
    }
  }

  async function processQueue() {
    if (session.processing || closed) return;

    session.processing = true;

    try {
      while (session.inputQueue.length > 0 && !closed) {
        const data = session.inputQueue.shift();

        try {
          await executeAction(data);
        } catch (error) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'error',
              message: String(error.message).slice(0, 150)
            }));
          }
        }
      }
    } finally {
      session.processing = false;

      if (session.inputQueue.length > 0 && !closed) {
        processQueue();
      }
    }
  }

  function enqueue(data) {
    if (data.action === 'move') {
      const last = session.inputQueue.at(-1);

      if (last && last.action === 'move') {
        session.inputQueue[session.inputQueue.length - 1] = data;
      } else {
        session.inputQueue.push(data);
      }
    } else {
      if (session.inputQueue.length >= MAX_QUEUE) {
        ws.close(1008, 'Input queue full');
        return;
      }

      session.inputQueue.push(data);
    }

    processQueue();
  }

  ws.on('message', raw => {
    if (closed) return;

    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      ws.close(1007, 'Invalid message');
      return;
    }

    if (!validMessage(data)) return;

    const now = Date.now();

    session.messageTimes = session.messageTimes.filter(
      time => now - time < 1000
    );

    if (session.messageTimes.length >= 120) {
      ws.close(1008, 'Rate limit exceeded');
      return;
    }

    session.messageTimes.push(now);
    session.lastActivity = now;

    if (data.action === 'heartbeat') return;

    enqueue(data);
  });

  function cleanup() {
    if (closed) return;

    closed = true;

    if (session.frameTimer) {
      clearInterval(session.frameTimer);
      session.frameTimer = null;
    }

    session.inputQueue.length = 0;

    if (session.ws === ws) {
      session.ws = null;
      session.lastActivity = Date.now();
    }
  }

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();

  for (const [id, session] of sessions) {
    if (
      now - session.lastActivity >= SESSION_TIMEOUT ||
      session.page.isClosed()
    ) {
      closeSession(id);
    }
  }

  for (const [hostname, item] of dnsCache) {
    if (item.expires <= now) {
      dnsCache.delete(hostname);
    }
  }
}, 5000);

cleanupTimer.unref();

async function start() {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });

  server.listen(PORT, HOST, () => {
    console.log('HTTPS Remote Browser started');
    console.log(`HTTPS: https://${HOST}:${PORT}`);
    console.log(`Maximum sessions: ${MAX_SESSIONS}`);
    console.log(`Frame interval: ${FRAME_INTERVAL}ms`);
    console.log(`JPEG quality: ${FRAME_QUALITY}`);
    console.log(`Request logging: ${config.logRequests}`);
  });
}

async function shutdown() {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log('Shutting down...');

  clearInterval(cleanupTimer);

  for (const id of [...sessions.keys()]) {
    await closeSession(id);
  }

  if (browser) {
    await browser.close().catch(() => {});
  }

  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch(error => {
  console.error('Browser startup failed:', error);
  process.exit(1);
});
