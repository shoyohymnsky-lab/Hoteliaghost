
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const express = require('express');
const http = require('http');
const https = require('https');
const readline = require('readline');
const config = require('./settings.json');

// ============================================================
// MINECRAFT AFK BOT v2.4 - STABILITY FIX EDITION
// Minecraft 1.15.1 Compatible
// ============================================================

const app = express();
const PORT = Number(process.env.PORT) || 5000;

let bot = null;
let currentSession = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let shuttingDown = false;

const state = {
  connected: false,
  startTime: Date.now(),
  lastActivity: Date.now(),
  connectedSince: null,
  errors: [],
  lastKick: null
};

const utils = config.utils || {};
const movement = config.movement || {};
const modules = config.modules || {};
const combatSettings = config.combat || {};

const AUTO_RECONNECT = utils['auto-reconnect'] !== false;

// Attacking is OFF unless explicitly enabled.
const ENABLE_ATTACKS =
  process.env.BOT_ENABLE_ATTACKS === 'true' &&
  combatSettings['attack-mobs'] === true;

const ENABLE_CREATIVE =
  process.env.BOT_ENABLE_CREATIVE === 'true';

const AUTH_PASSWORD =
  process.env.MC_AUTH_PASSWORD || '';

function log(message) {
  console.log(
    `[${new Date().toISOString()}] ${message}`
  );
}

function recordError(type, message) {
  state.errors.push({
    type,
    message: String(message),
    time: Date.now()
  });

  if (state.errors.length > 30) {
    state.errors.shift();
  }
}

function isActive(session) {
  return (
    !shuttingDown &&
    currentSession === session &&
    bot === session.bot &&
    !session.closed &&
    state.connected &&
    !!session.bot.entity
  );
}

// ============================================================
// WEB DASHBOARD
// ============================================================

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>Minecraft AFK Bot Dashboard</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #0f172a;
  color: #f8fafc;
  font-family: Arial, sans-serif;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}

.container {
  background: #1e293b;
  padding: 30px;
  border-radius: 18px;
  width: 90%;
  max-width: 450px;
  border: 1px solid #334155;
  box-shadow: 0 0 35px #0d948844;
}

h1 {
  text-align: center;
  color: #2dd4bf;
}

.card {
  background: #0f172a;
  margin: 15px 0;
  padding: 18px;
  border-radius: 10px;
  border-left: 4px solid #2dd4bf;
}

.label {
  color: #94a3b8;
  font-size: 12px;
  text-transform: uppercase;
}

.value {
  color: #2dd4bf;
  font-size: 19px;
  margin-top: 8px;
  overflow-wrap: anywhere;
}

.online {
  color: #4ade80;
}

.offline {
  color: #f87171;
}

.footer {
  text-align: center;
  font-size: 12px;
  color: #64748b;
  margin-top: 20px;
}
</style>
</head>

<body>

<div class="container">

<h1>Minecraft AFK Bot</h1>

<div class="card">
<div class="label">Connection</div>
<div class="value" id="status">Loading...</div>
</div>

<div class="card">
<div class="label">Server</div>
<div class="value">${config.server.ip}</div>
</div>

<div class="card">
<div class="label">Coordinates</div>
<div class="value" id="coords">Waiting...</div>
</div>

<div class="card">
<div class="label">Uptime</div>
<div class="value" id="uptime">0 seconds</div>
</div>

<div class="card">
<div class="label">Reconnect Attempts</div>
<div class="value" id="attempts">0</div>
</div>

<div class="card">
<div class="label">Last Kick</div>
<div class="value" id="kick">None</div>
</div>

<div class="footer">
Minecraft AFK Bot v2.4
</div>

</div>

<script>
async function update() {
  try {
    const response = await fetch('/health');
    const data = await response.json();

    const status = document.getElementById('status');

    if (data.status === 'connected') {
      status.innerText = 'ONLINE';
      status.className = 'value online';
    } else {
      status.innerText = 'RECONNECTING';
      status.className = 'value offline';
    }

    document.getElementById('uptime').innerText =
      data.uptime + ' seconds';

    document.getElementById('attempts').innerText =
      data.reconnectAttempts;

    document.getElementById('kick').innerText =
      data.lastKick || 'None';

    if (data.coords) {
      document.getElementById('coords').innerText =
        Math.floor(data.coords.x) + ', ' +
        Math.floor(data.coords.y) + ', ' +
        Math.floor(data.coords.z);
    } else {
      document.getElementById('coords').innerText =
        'Unknown';
    }

  } catch (error) {
    document.getElementById('status').innerText =
      'DASHBOARD OFFLINE';
  }
}

update();
setInterval(update, 2000);
</script>

</body>
</html>
  `);
});

app.get('/health', (req, res) => {
  res.json({
    status: state.connected ? 'connected' : 'disconnected',
    uptime: Math.floor(
      (Date.now() - state.startTime) / 1000
    ),
    coords:
      state.connected && bot && bot.entity
        ? bot.entity.position
        : null,
    reconnectAttempts,
    lastActivity: state.lastActivity,
    lastKick: state.lastKick,
    errors: state.errors.slice(-5),
    memoryMB: Math.round(
      process.memoryUsage().heapUsed / 1048576
    )
  });
});

app.get('/ping', (req, res) => {
  res.send('pong');
});

const webServer = app.listen(PORT, '0.0.0.0', () => {
  log(`[HTTP] Dashboard started on port ${PORT}`);
});

// ============================================================
// SELF PING
// ============================================================

function selfPing() {
  const url =
    process.env.RENDER_EXTERNAL_URL ||
    `http://localhost:${PORT}`;

  const client =
    url.startsWith('https:') ? https : http;

  try {
    const request = client.get(
      `${url.replace(/\/$/, '')}/ping`,
      response => {
        response.resume();
      }
    );

    request.setTimeout(10000, () => {
      request.destroy();
    });

    request.on('error', error => {
      log(`[KeepAlive] ${error.message}`);
    });

  } catch (error) {
    log(`[KeepAlive] ${error.message}`);
  }
}

setInterval(selfPing, 10 * 60 * 1000);

log('[KeepAlive] Self-ping enabled');

// ============================================================
// DISCORD WEBHOOK
// ============================================================

function sendDiscord(message, color = 0x2dd4bf) {
  const discord = config.discord;

  if (
    !discord ||
    !discord.enabled ||
    !discord.webhookUrl ||
    discord.webhookUrl.includes('YOUR_DISCORD')
  ) {
    return;
  }

  try {
    const url = new URL(discord.webhookUrl);

    const payload = JSON.stringify({
      username: config.name || 'Minecraft AFK Bot',
      embeds: [{
        description: message,
        color,
        timestamp: new Date().toISOString()
      }]
    });

    const client =
      url.protocol === 'https:' ? https : http;

    const request = client.request({
      hostname: url.hostname,
      port: url.port || (
        url.protocol === 'https:' ? 443 : 80
      ),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, response => {
      response.resume();
    });

    request.on('error', error => {
      log(`[Discord] ${error.message}`);
    });

    request.end(payload);

  } catch (error) {
    log(`[Discord] ${error.message}`);
  }
}

// ============================================================
// SESSION TIMER MANAGEMENT
// ============================================================

function addInterval(session, callback, delay) {
  const id = setInterval(() => {
    if (!isActive(session)) return;

    try {
      const result = callback();

      if (result && typeof result.catch === 'function') {
        result.catch(error => {
          log(`[Module] ${error.message}`);
        });
      }
    } catch (error) {
      log(`[Module] ${error.message}`);
    }
  }, Math.max(100, Number(delay) || 1000));

  session.intervals.add(id);
  return id;
}

function addTimeout(session, callback, delay) {
  const id = setTimeout(() => {
    session.timeouts.delete(id);

    if (!isActive(session)) return;

    try {
      callback();
    } catch (error) {
      log(`[Timer] ${error.message}`);
    }
  }, delay);

  session.timeouts.add(id);
  return id;
}

function cleanupSession(session) {
  if (session.cleaned) return;

  session.cleaned = true;
  session.closed = true;

  log(
    `[Cleanup] Clearing ${session.intervals.size} intervals`
  );

  for (const id of session.intervals) {
    clearInterval(id);
  }

  for (const id of session.timeouts) {
    clearTimeout(id);
  }

  session.intervals.clear();
  session.timeouts.clear();

  if (session.connectionTimeout) {
    clearTimeout(session.connectionTimeout);
    session.connectionTimeout = null;
  }

  if (session.bot) {
    try {
      session.bot.clearControlStates();
    } catch (error) {}

    try {
      if (session.bot.pathfinder) {
        session.bot.pathfinder.setGoal(null);
      }
    } catch (error) {}
  }
}

// ============================================================
// RECONNECT SYSTEM
// ============================================================

function getReconnectDelay() {
  const base = Math.max(
    1000,
    Number(utils['auto-reconnect-delay']) || 3000
  );

  const max = Math.max(
    base,
    Number(utils['max-reconnect-delay']) || 30000
  );

  const exponential = base *
    Math.pow(2, Math.min(reconnectAttempts - 1, 5));

  return Math.min(exponential, max);
}

function scheduleReconnect() {
  if (
    shuttingDown ||
    !AUTO_RECONNECT ||
    reconnectTimer
  ) {
    return;
  }

  reconnectAttempts++;

  const delay = getReconnectDelay();

  log(
    `[Bot] Reconnecting in ${delay / 1000}s ` +
    `(attempt #${reconnectAttempts})`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, delay);
}

function disconnectSession(session, reason) {
  if (session.closed) return;

  log(`[Bot] Disconnected: ${reason || 'Unknown'}`);

  const wasConnected = state.connected;

  cleanupSession(session);

  if (currentSession === session) {
    state.connected = false;
    state.connectedSince = null;
    currentSession = null;

    if (
      wasConnected &&
      config.discord &&
      config.discord.events &&
      config.discord.events.disconnect
    ) {
      sendDiscord(
        `[-] Disconnected: ${reason || 'Unknown'}`,
        0xf87171
      );
    }

    scheduleReconnect();
  }
}

// ============================================================
// BOT CREATION
// ============================================================

function createBot() {
  if (shuttingDown) return;

  if (currentSession && !currentSession.closed) {
    log('[Bot] Existing session is still active');
    return;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  state.connected = false;

  log('[Bot] Creating bot instance...');
  log(
    `[Bot] Connecting to ` +
    `${config.server.ip}:${config.server.port}`
  );

  let newBot;

  try {
    newBot = mineflayer.createBot({
      username: config['bot-account'].username,
      password:
        config['bot-account'].password || undefined,
      auth: config['bot-account'].type,
      host: config.server.ip,
      port: Number(config.server.port),
      version: config.server.version,
      hideErrors: false,
      checkTimeoutInterval: 120000
    });
  } catch (error) {
    log(`[Bot] Creation failed: ${error.message}`);
    recordError('creation', error.message);
    scheduleReconnect();
    return;
  }

  const session = {
    bot: newBot,
    closed: false,
    cleaned: false,
    spawned: false,
    intervals: new Set(),
    timeouts: new Set(),
    connectionTimeout: null
  };

  bot = newBot;
  currentSession = session;

  try {
    newBot.loadPlugin(pathfinder);
  } catch (error) {
    log(`[Pathfinder] ${error.message}`);

    cleanupSession(session);
    currentSession = null;

    try {
      newBot.end();
    } catch (e) {}

    scheduleReconnect();
    return;
  }

  session.connectionTimeout = setTimeout(() => {
    if (
      currentSession !== session ||
      session.closed ||
      session.spawned
    ) {
      return;
    }

    log('[Bot] Connection timeout');

    disconnectSession(session, 'Connection timeout');

    try {
      newBot.end();
    } catch (error) {}
  }, 60000);

  // ==========================================================
  // SPAWN
  // ==========================================================

  newBot.once('spawn', () => {
    if (
      currentSession !== session ||
      session.closed
    ) {
      return;
    }

    session.spawned = true;

    clearTimeout(session.connectionTimeout);
    session.connectionTimeout = null;

    state.connected = true;
    state.connectedSince = Date.now();
    state.lastActivity = Date.now();

    log('[Bot] Successfully spawned on server!');

    // Reset reconnect backoff only after stable uptime.
    addTimeout(session, () => {
      reconnectAttempts = 0;
      log('[Bot] Connection stable; reconnect counter reset');
    }, 120000);

    if (
      config.discord &&
      config.discord.events &&
      config.discord.events.connect
    ) {
      sendDiscord(
        `[+] Connected to ${config.server.ip}`,
        0x4ade80
      );
    }

    try {
      const mcData =
        require('minecraft-data')(config.server.version);

      const defaultMove =
        new Movements(newBot, mcData);

      initializeModules(
        session,
        mcData,
        defaultMove
      );

    } catch (error) {
      log(`[Modules] Initialization error: ${error.message}`);
      recordError('modules', error.message);
    }

    if (ENABLE_CREATIVE) {
      addTimeout(session, () => {
        safeChat(session, '/gamemode creative');
        log('[INFO] Creative mode requested');
      }, 3000);
    }
  });

  // ==========================================================
  // KICK HANDLER
  // ==========================================================

  newBot.on('kicked', reason => {
    const text =
      typeof reason === 'string'
        ? reason
        : JSON.stringify(reason);

    state.lastKick = text;

    log(`[KICK] ${text}`);

    if (text.includes('invalid_entity_attacked')) {
      log(
        '[Safety] Server rejected an entity attack. ' +
        'Check combat settings or other attack plugins.'
      );
    }
  });

  // ==========================================================
  // ERROR HANDLER
  // ==========================================================

  newBot.on('error', error => {
    if (session.closed) return;

    const message = error.message || String(error);

    if (
      error.code === 'EPIPE' ||
      error.code === 'ECONNRESET'
    ) {
      log(`[Network] ${error.code}: socket interrupted`);
    } else {
      log(`[Bot] Error: ${message}`);
    }

    recordError('bot', message);

    // Do not reconnect here.
    // The end event handles normal disconnections.
  });

  // ==========================================================
  // END HANDLER
  // ==========================================================

  newBot.once('end', reason => {
    disconnectSession(session, reason);
  });

  // ==========================================================
  // AUTO LOGIN
  // ==========================================================

  let authenticationSent = false;

  newBot.on('messagestr', message => {
    if (!isActive(session)) return;
    if (!AUTH_PASSWORD || authenticationSent) return;

    const lower = String(message).toLowerCase();

    if (
      lower.includes('/register') &&
      lower.includes('register')
    ) {
      authenticationSent = true;

      safeChat(
        session,
        `/register ${AUTH_PASSWORD} ${AUTH_PASSWORD}`
      );

      log('[Auth] Register command sent');
      return;
    }

    if (lower.includes('/login')) {
      authenticationSent = true;

      safeChat(
        session,
        `/login ${AUTH_PASSWORD}`
      );

      log('[Auth] Login command sent');
    }
  });
}

// ============================================================
// SAFE CHAT
// ============================================================

function safeChat(session, message) {
  if (!isActive(session)) return false;

  try {
    session.bot.chat(message);
    state.lastActivity = Date.now();
    return true;
  } catch (error) {
    log(`[Chat] ${error.message}`);
    return false;
  }
}

// ============================================================
// MODULE INITIALIZATION
// ============================================================

function initializeModules(
  session,
  mcData,
  defaultMove
) {
  log('[Modules] Initializing all modules...');

  const currentBot = session.bot;

  // ----------------------------------------------------------
  // MOVE TO POSITION
  // ----------------------------------------------------------

  if (config.position && config.position.enabled) {
    try {
      currentBot.pathfinder.setMovements(defaultMove);

      currentBot.pathfinder.setGoal(
        new GoalBlock(
          config.position.x,
          config.position.y,
          config.position.z
        )
      );
    } catch (error) {
      log(`[Position] ${error.message}`);
    }
  }

  // ----------------------------------------------------------
  // ANTI AFK
  // ----------------------------------------------------------

  if (
    utils['anti-afk'] &&
    utils['anti-afk'].enabled
  ) {
    addInterval(session, () => {
      currentBot.setControlState('jump', true);

      addTimeout(session, () => {
        currentBot.setControlState('jump', false);
      }, 150);

      state.lastActivity = Date.now();
    }, 3000);

    if (utils['anti-afk'].sneak) {
      currentBot.setControlState('sneak', true);
    }

    log('[AntiAFK] Enabled');
  }

  // ----------------------------------------------------------
  // CIRCLE WALK
  // ----------------------------------------------------------

  if (
    movement['circle-walk'] &&
    movement['circle-walk'].enabled
  ) {
    startCircleWalk(
      session,
      defaultMove
    );
  }

  // ----------------------------------------------------------
  // RANDOM JUMP
  // ----------------------------------------------------------

  if (
    movement['random-jump'] &&
    movement['random-jump'].enabled
  ) {
    startRandomJump(session);
  }

  // ----------------------------------------------------------
  // LOOK AROUND
  // ----------------------------------------------------------

  if (
    movement['look-around'] &&
    movement['look-around'].enabled
  ) {
    startLookAround(session);
  }

  // ----------------------------------------------------------
  // AVOID MOBS
  // ----------------------------------------------------------

  if (modules.avoidMobs) {
    avoidMobs(session);
  }

  // ----------------------------------------------------------
  // COMBAT
  // ----------------------------------------------------------

  if (modules.combat) {
    combatModule(session, mcData);
  }

  // ----------------------------------------------------------
  // BEDS
  // ----------------------------------------------------------

  if (modules.beds) {
    bedModule(session);
  }

  // ----------------------------------------------------------
  // CHAT
  // ----------------------------------------------------------

  if (modules.chat) {
    chatModule(session);
  }

  // ----------------------------------------------------------
  // PERIODIC REJOIN
  // ----------------------------------------------------------

  if (
    utils['periodic-rejoin'] &&
    utils['periodic-rejoin'].enabled
  ) {
    periodicRejoin(session);
  }

  log('[Modules] All modules initialized!');
}

// ============================================================
// CIRCLE WALK
// ============================================================

function startCircleWalk(session, defaultMove) {
  const currentBot = session.bot;
  const settings = movement['circle-walk'];

  const radius = Number(settings.radius) || 3;
  const speed = Math.max(
    2000,
    Number(settings.speed) || 4000
  );

  let angle = 0;

  addInterval(session, () => {
    if (!currentBot.entity) return;

    try {
      const pos = currentBot.entity.position;

      const x =
        pos.x + Math.cos(angle) * radius;

      const z =
        pos.z + Math.sin(angle) * radius;

      currentBot.pathfinder.setMovements(defaultMove);

      currentBot.pathfinder.setGoal(
        new GoalBlock(
          Math.floor(x),
          Math.floor(pos.y),
          Math.floor(z)
        )
      );

      angle += Math.PI / 4;

      state.lastActivity = Date.now();

    } catch (error) {
      log(`[CircleWalk] ${error.message}`);
    }
  }, speed);
}

// ============================================================
// RANDOM JUMP
// ============================================================

function startRandomJump(session) {
  const currentBot = session.bot;

  const delay =
    Number(movement['random-jump'].interval) || 5000;

  addInterval(session, () => {
    currentBot.setControlState('jump', true);

    addTimeout(session, () => {
      currentBot.setControlState('jump', false);
    }, 300);

    state.lastActivity = Date.now();
  }, delay);
}

// ============================================================
// LOOK AROUND
// ============================================================

function startLookAround(session) {
  const currentBot = session.bot;

  const delay =
    Number(movement['look-around'].interval) || 5000;

  addInterval(session, () => {
    const yaw = Math.random() * Math.PI * 2;

    const pitch =
      (Math.random() - 0.5) * Math.PI / 4;

    currentBot.look(yaw, pitch, true);

    state.lastActivity = Date.now();
  }, delay);
}

// ============================================================
// AVOID MOBS
// ============================================================

function avoidMobs(session) {
  const currentBot = session.bot;

  addInterval(session, () => {
    const entities = Object.values(
      currentBot.entities
    );

    const danger = entities.find(entity => {
      if (!entity || !entity.position) return false;

      if (
        entity.type !== 'mob' &&
        entity.type !== 'player'
      ) {
        return false;
      }

      if (entity.id === currentBot.entity.id) {
        return false;
      }

      if (entity.username === currentBot.username) {
        return false;
      }

      return (
        currentBot.entity.position.distanceTo(
          entity.position
        ) < 5
      );
    });

    if (!danger) return;

    currentBot.setControlState('back', true);

    addTimeout(session, () => {
      currentBot.setControlState('back', false);
    }, 500);

  }, 2000);
}

// ============================================================
// SAFE COMBAT MODULE
// ============================================================

function combatModule(session, mcData) {
  const currentBot = session.bot;

  const allowedMobs = new Set([
    'zombie',
    'skeleton',
    'spider',
    'creeper',
    'drowned',
    'husk',
    'stray',
    'witch'
  ]);

  let lastAttack = 0;

  if (ENABLE_ATTACKS) {
    log('[Combat] Safe attacking enabled');

    addInterval(session, () => {
      if (!currentBot.entity) return;

      const now = Date.now();

      if (now - lastAttack < 2000) return;

      const target = Object.values(
        currentBot.entities
      ).find(entity => {
        if (!entity || !entity.position) {
          return false;
        }

        if (entity.type !== 'mob') {
          return false;
        }

        if (!allowedMobs.has(entity.name)) {
          return false;
        }

        if (entity.id === currentBot.entity.id) {
          return false;
        }

        if (
          currentBot.entities[entity.id] !== entity
        ) {
          return false;
        }

        const distance =
          currentBot.entity.position.distanceTo(
            entity.position
          );

        return distance > 0 && distance < 3.5;
      });

      if (!target) return;

      // Recheck the entity immediately before attacking.
      if (
        currentBot.entities[target.id] !== target
      ) {
        return;
      }

      try {
        currentBot.attack(target);
        lastAttack = now;

        state.lastActivity = now;

      } catch (error) {
        log(`[Combat] Attack blocked: ${error.message}`);
      }

    }, 1500);

  } else {
    log(
      '[Combat] Automatic attacks disabled for safety'
    );
  }

  // ----------------------------------------------------------
  // AUTO EAT
  // ----------------------------------------------------------

  let eating = false;

  currentBot.on('health', async () => {
    if (!isActive(session)) return;
    if (!combatSettings['auto-eat']) return;
    if (eating) return;
    if (currentBot.food >= 14) return;

    const food = currentBot.inventory.items().find(
      item => {
        const itemData =
          mcData.itemsByName[item.name];

        return itemData && itemData.food;
      }
    );

    if (!food) return;

    eating = true;

    try {
      await currentBot.equip(food, 'hand');

      if (!isActive(session)) return;

      await currentBot.consume();

      state.lastActivity = Date.now();

    } catch (error) {
      log(`[AutoEat] ${error.message}`);

    } finally {
      eating = false;
    }
  });
}

// ============================================================
// BED MODULE
// ============================================================

function bedModule(session) {
  const currentBot = session.bot;

  let sleepingAttempt = false;

  addInterval(session, async () => {
    if (!config.beds) return;
    if (!config.beds['place-night']) return;
    if (sleepingAttempt) return;
    if (currentBot.isSleeping) return;
    if (!currentBot.time) return;

    const time = currentBot.time.timeOfDay;

    const isNight =
      time >= 12500 && time <= 23500;

    if (!isNight) return;

    try {
      const bed = currentBot.findBlock({
        matching: block =>
          block.name.includes('bed'),
        maxDistance: 8
      });

      if (!bed) return;

      sleepingAttempt = true;

      await currentBot.sleep(bed);

      log('[Bed] Sleeping');

    } catch (error) {
      // Sleeping may fail when a bed is occupied,
      // monsters are nearby, or the server denies it.
    } finally {
      sleepingAttempt = false;
    }

  }, 10000);
}

// ============================================================
// CHAT MODULE
// ============================================================

function chatModule(session) {
  const currentBot = session.bot;

  currentBot.on('chat', (username, message) => {
    if (!isActive(session)) return;
    if (username === currentBot.username) return;

    if (!config.chat || !config.chat.respond) {
      return;
    }

    const lower = message.toLowerCase();

    if (
      /\b(hello|hi)\b/.test(lower)
    ) {
      safeChat(
        session,
        `Hello, ${username}!`
      );
    }

    if (message.startsWith('!tp ')) {
      const target = message.split(' ')[1];

      if (
        target &&
        /^[a-zA-Z0-9_]{1,16}$/.test(target)
      ) {
        safeChat(
          session,
          `/tp ${target}`
        );
      }
    }
  });
}

// ============================================================
// PERIODIC REJOIN
// ============================================================

function periodicRejoin(session) {
  const settings = utils['periodic-rejoin'];

  // Default 30 minutes if no interval is configured.
  const delay = Math.max(
    60000,
    Number(settings.interval) || 1800000
  );

  log(
    `[Rejoin] Periodic rejoin every ${delay / 60000} minutes`
  );

  addInterval(session, () => {
    log('[Rejoin] Performing scheduled rejoin');

    const currentBot = session.bot;

    disconnectSession(
      session,
      'Periodic Rejoin'
    );

    try {
      currentBot.end();
    } catch (error) {}

  }, delay);
}

// ============================================================
// CONSOLE COMMANDS
// ============================================================

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', line => {
  const command = line.trim();

  if (command === 'status') {
    log(
      `[Status] Connected=${state.connected}, ` +
      `Reconnects=${reconnectAttempts}`
    );
    return;
  }

  if (command === 'reconnect') {
    log('[Console] Manual reconnect requested');

    if (currentSession) {
      const session = currentSession;

      disconnectSession(
        session,
        'Manual Reconnect'
      );

      try {
        session.bot.end();
      } catch (error) {}

    } else {
      scheduleReconnect();
    }

    return;
  }

  if (!currentSession || !isActive(currentSession)) {
    log('[Console] Bot is not connected');
    return;
  }

  if (command.startsWith('say ')) {
    safeChat(
      currentSession,
      command.slice(4)
    );

  } else if (command.startsWith('cmd ')) {
    safeChat(
      currentSession,
      '/' + command.slice(4)
    );

  } else if (command) {
    safeChat(currentSession, command);
  }
});

// ============================================================
// MEMORY MONITOR
// ============================================================

setInterval(() => {
  const memory =
    process.memoryUsage().heapUsed / 1048576;

  log(
    `[Memory] Heap: ${memory.toFixed(2)} MB`
  );
}, 5 * 60 * 1000);

// ============================================================
// PROCESS ERROR HANDLERS
// ============================================================

process.on('uncaughtException', error => {
  log(`[FATAL] ${error.message}`);

  recordError(
    'uncaughtException',
    error.message
  );

  // A process-level exception can leave state corrupted.
  // Exit so the hosting supervisor can restart cleanly.
  shutdown(1);
});

process.on('unhandledRejection', reason => {
  const message =
    reason instanceof Error
      ? reason.message
      : String(reason);

  log(`[Promise] ${message}`);

  recordError(
    'unhandledRejection',
    message
  );
});

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

function shutdown(exitCode = 0) {
  if (shuttingDown) return;

  shuttingDown = true;

  log('[System] Shutting down...');

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (currentSession) {
    const session = currentSession;

    cleanupSession(session);
    currentSession = null;
    state.connected = false;

    try {
      session.bot.end();
    } catch (error) {}
  }

  try {
    webServer.close();
  } catch (error) {}

  process.exitCode = exitCode;

  // Ensure the process does not hang on open sockets.
  setTimeout(() => {
    process.exit(exitCode);
  }, 1000).unref();
}

process.on('SIGTERM', () => {
  shutdown(0);
});

process.on('SIGINT', () => {
  shutdown(0);
});

// ============================================================
// START BOT
// ============================================================

console.log('='.repeat(55));
console.log(' Minecraft AFK Bot v2.4 - Stability Fix Edition');
console.log('='.repeat(55));

console.log(
  `Server: ${config.server.ip}:${config.server.port}`
);

console.log(
  `Version: ${config.server.version}`
);

console.log(
  `Auto-Reconnect: ${AUTO_RECONNECT ? 'ON' : 'OFF'}`
);

console.log(
  `Automatic Attacks: ${ENABLE_ATTACKS ? 'ON' : 'OFF'}`
);

console.log(
  `Creative Mode Command: ${ENABLE_CREATIVE ? 'ON' : 'OFF'}`
);

console.log('='.repeat(55));

createBot();
