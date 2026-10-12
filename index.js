
'use strict';

// AEVORIS v3.0 — THE SILENT EXPLORER
// Minecraft Java Edition 1.15.1

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;
const Vec3 = require('vec3');
const express = require('express');
const https = require('https');
const readline = require('readline');
const config = require('./settings.json');

const utils = config.utils || {};
const movement = config.movement || {};
const modules = config.modules || {};
const combat = config.combat || {};
const beds = config.beds || {};

const PORT = Number(process.env.PORT) || 8080;
const EXPEDITION = Math.max(128, Number(movement['expedition-distance']) || 3000);
const WAYPOINT = Math.max(12, Math.min(28, Number(movement['waypoint-distance']) || 22));
const ATTACK = process.env.AEVORIS_COMBAT === 'true' && combat['attack-mobs'] === true;
const PASSWORD = process.env.MC_AUTH_PASSWORD || utils['auto-auth']?.password || '';
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const log = text => console.log(`[Aevoris] ${text}`);

let session = null;
let reconnectTimer = null;
let attempts = 0;
let shuttingDown = false;

const started = Date.now();
const history = { kick: null, error: null };

// DASHBOARD
const app = express();

app.get('/ping', (_, res) => res.send('pong'));

app.get('/health', (_, res) => {
  const s = session;
  const online = !!s && active(s);
  const p = online ? s.bot.entity.position : null;

  res.json({
    name: config['bot-account'].username,
    connected: online,
    mode: online ? s.mode : 'offline',
    coordinates: p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : null,
    distance: online ? Math.round(s.distance) : 0,
    jumps: online ? s.jumps : 0,
    expedition: online ? Math.round(s.progress) : 0,
    reconnectAttempts: attempts,
    uptime: Math.floor((Date.now() - started) / 1000),
    lastKick: history.kick,
    lastError: history.error
  });
});

app.get('/', (_, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aevoris</title>
<style>
body{background:#080b13;color:#e9f0ff;font:16px Arial;min-height:95vh;display:grid;place-items:center}
main{background:#182033;padding:30px;border-radius:20px;width:min(450px,85%);box-shadow:0 0 45px #b0c4de22}
h1{letter-spacing:5px}p{color:#bdc9dc}b{color:#fff}
</style>
</head>
<body>
<main>
<h1>AEVORIS</h1>
<p>The Silent Explorer</p>
<p>Status: <b id="status">Loading</b></p>
<p>Behaviour: <b id="mode">Unknown</b></p>
<p>Coordinates: <b id="pos">Unknown</b></p>
<p>Distance travelled: <b id="distance">0</b></p>
<p>Jumps: <b id="jumps">0</b></p>
</main>
<script>
async function refresh(){
 try{
  const r=await fetch('/health');
  const d=await r.json();
  document.getElementById('status').textContent=d.connected?'Manifested':'Absent';
  document.getElementById('mode').textContent=d.mode;
  document.getElementById('pos').textContent=d.coordinates?Object.values(d.coordinates).join(', '):'Unknown';
  document.getElementById('distance').textContent=d.distance+' blocks';
  document.getElementById('jumps').textContent=d.jumps;
 }catch(e){}
}
refresh();setInterval(refresh,3000);
</script>
</body>
</html>`);
});

const webServer = app.listen(PORT, '0.0.0.0', () => log(`Dashboard: ${PORT}`));

// DISCORD
function notify(message, event, color = 0xb0c4de) {
  if (!config.discord?.enabled || config.discord.events?.[event] === false) return;
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return;

  try {
    const url = new URL(webhook);
    if (url.protocol !== 'https:') return;
    const body = JSON.stringify({
      username: 'Aevoris',
      embeds: [{ description: message, color, timestamp: new Date().toISOString() }]
    });
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => res.resume());
    req.on('error', e => log(`Discord: ${e.message}`));
    req.end(body);
  } catch (e) {
    log(`Discord: ${e.message}`);
  }
}

// SESSION UTILITIES
function active(s) {
  return session === s && !s.closed && s.spawned && !!s.bot.entity && !shuttingDown;
}

function interval(s, ms, fn) {
  const id = setInterval(() => {
    if (!active(s)) return;
    try {
      Promise.resolve(fn()).catch(e => log(`Module: ${e.message}`));
    } catch (e) {
      log(`Module: ${e.message}`);
    }
  }, ms);
  s.intervals.add(id);
}

function timeout(s, ms, fn) {
  const id = setTimeout(() => {
    s.timeouts.delete(id);
    if (!active(s)) return;
    try {
      Promise.resolve(fn()).catch(e => log(`Timer: ${e.message}`));
    } catch (e) {
      log(`Timer: ${e.message}`);
    }
  }, ms);
  s.timeouts.add(id);
}

function cleanup(s) {
  if (s.closed) return;
  s.closed = true;
  clearTimeout(s.connectionTimer);
  for (const id of s.intervals) clearInterval(id);
  for (const id of s.timeouts) clearTimeout(id);
  s.intervals.clear();
  s.timeouts.clear();
  try { s.bot.pathfinder.setGoal(null); } catch (_) {}
  try { s.bot.clearControlStates(); } catch (_) {}
}

// RECONNECT
function reconnect() {
  if (shuttingDown || utils['auto-reconnect'] === false || reconnectTimer) return;
  attempts++;
  const base = Math.max(2000, Number(utils['auto-reconnect-delay']) || 3000);
  const maximum = Math.max(base, Number(utils['max-reconnect-delay']) || 60000);
  const delay = Math.min(maximum, base * Math.pow(2, Math.min(attempts - 1, 6)));
  log(`Reconnecting in ${delay / 1000}s (#${attempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function disconnect(s, reason, retry = true) {
  if (s.closed) return;
  const wasOnline = s.spawned;
  log(`Disconnected: ${reason}`);
  cleanup(s);
  if (session === s) {
    session = null;
    if (wasOnline) notify(`Aevoris vanished: ${reason}`, 'disconnect', 0xe48c9b);
    if (retry) reconnect();
  }
}

// TERRAIN SCANNING
const hazards = /lava|fire|magma|cactus|campfire|sweet_berry|cobweb/;

function safeGround(bot, x, z, approximateY) {
  x = Math.floor(x);
  z = Math.floor(z);
  for (const offset of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5]) {
    const y = Math.floor(approximateY) + offset;
    const feet = bot.blockAt(new Vec3(x, y, z));
    const head = bot.blockAt(new Vec3(x, y + 1, z));
    const floor = bot.blockAt(new Vec3(x, y - 1, z));
    if (!feet || !head || !floor) continue;
    if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty') continue;
    if (floor.boundingBox !== 'block') continue;
    if (hazards.test(feet.name) || hazards.test(head.name) || hazards.test(floor.name)) continue;
    if (/water/.test(feet.name) || /water/.test(head.name)) continue;
    return { x, y, z };
  }
  return null;
}

// HOSTILE MOB DETECTION
function findThreat(s) {
  if (!modules.avoidMobs) return null;
  const hostile = new Set([
    'zombie', 'skeleton', 'creeper', 'spider', 'drowned',
    'husk', 'stray', 'witch', 'phantom', 'pillager', 'slime'
  ]);
  const p = s.bot.entity.position;
  return Object.values(s.bot.entities)
    .filter(e => e && e.position && hostile.has(e.name) && p.distanceTo(e.position) < 9)
    .sort((a, b) => p.distanceTo(a.position) - p.distanceTo(b.position))[0] || null;
}

// EXPEDITION PLANNING
function newHeading(s, major = false) {
  s.heading += (Math.random() < 0.5 ? -1 : 1) *
    (major ? 2 + Math.random() * 2 : 0.2 + Math.random() * 0.6);
  s.progress = 0;
  s.failures = 0;
  s.mode = 'choosing direction';
}

function chooseWaypoint(s, threat = null) {
  const p = s.bot.entity.position;

  for (let i = 0; i < 48; i++) {
    let angle = s.heading + (Math.random() - 0.5) * (i < 24 ? 1 : 2.8);
    if (threat) {
      angle = Math.atan2(p.z - threat.position.z, p.x - threat.position.x) +
        (Math.random() - 0.5) * 0.8;
    }

    const radius = Math.max(6, WAYPOINT - Math.floor(i / 12) * 4);
    const target = safeGround(
      s.bot,
      p.x + Math.cos(angle) * radius,
      p.z + Math.sin(angle) * radius,
      p.y
    );

    if (!target) continue;

    const key = `${target.x},${target.y},${target.z}`;
    if (s.blocked.get(key) > Date.now()) continue;

    if (threat && Math.hypot(target.x - threat.position.x, target.z - threat.position.z) < 9) continue;

    if (s.visited.some(v => Math.hypot(target.x - v.x, target.z - v.z) < 5)) continue;

    return target;
  }

  return null;
}

function setGoal(s, target, mode = 'exploring') {
  if (!active(s) || !target) return false;
  try {
    s.bot.setControlState('sneak', false);
    s.bot.pathfinder.setGoal(new GoalNear(target.x, target.y, target.z, 2));
    s.goal = target;
    s.goalStart = Date.now();
    s.lastProgress = Date.now();
    s.progressPosition = s.bot.entity.position.clone();
    s.mode = mode;
    return true;
  } catch (e) {
    log(`Navigation: ${e.message}`);
    return false;
  }
}

function abandon(s, reason) {
  if (!active(s) || !s.goal) return;
  const g = s.goal;
  s.blocked.set(`${g.x},${g.y},${g.z}`, Date.now() + 120000);
  s.goal = null;
  s.failures++;
  try { s.bot.pathfinder.setGoal(null); } catch (_) {}
  try { s.bot.clearControlStates(); } catch (_) {}
  if (s.failures >= 3) newHeading(s, true);
  s.mode = 'rerouting';
  s.pauseUntil = Date.now() + rand(1000, 2400);
  log(`Finding another route: ${reason}`);
}

// LORE: SILENTLY WATCH PLAYERS
function observePlayer(s) {
  const p = s.bot.entity.position;
  const players = Object.values(s.bot.players)
    .map(player => player.entity)
    .filter(e => e && e.position && e.id !== s.bot.entity.id && p.distanceTo(e.position) < 13);

  if (!players.length || Math.random() > 0.22) return false;

  const target = players[rand(0, players.length - 1)];
  s.mode = 'watching silently';
  s.pauseUntil = Date.now() + rand(3000, 8000);

  try {
    Promise.resolve(s.bot.lookAt(target.position.offset(0, 1.5, 0), true)).catch(() => {});
  } catch (_) {}
  return true;
}

// INTELLIGENT EXPLORATION
function startExplorer(s) {
  const b = s.bot;
  const mcData = require('minecraft-data')(config.server.version);
  const moves = new Movements(b, mcData);

  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowParkour = false;
  moves.maxDropDown = 1;
  moves.liquidCost = 50;
  moves.canOpenDoors = false;
  moves.allowSprinting = true;

  b.pathfinder.setMovements(moves);
  b.pathfinder.thinkTimeout = 4500;
  b.pathfinder.tickTimeout = 30;

  b.on('goal_reached', () => {
    if (!active(s) || !s.goal) return;
    const target = s.goal;
    s.progress += Math.hypot(
      target.x - s.goalOrigin.x,
      target.z - s.goalOrigin.z
    );
    s.visited.push(target);
    if (s.visited.length > 8) s.visited.shift();
    s.goal = null;
    s.failures = 0;
    s.mode = 'observing';
    s.pauseUntil = Date.now() + rand(400, 3000);

    if (s.progress >= EXPEDITION) newHeading(s, true);
    else if (Math.random() < 0.15) s.heading += (Math.random() - 0.5) * 0.7;
  });

  b.on('path_update', result => {
    if (active(s) && s.goal && result.status === 'noPath') abandon(s, 'no path');
  });

  b.on('path_reset', reason => {
    if (active(s) && s.goal && reason === 'stuck') abandon(s, 'stuck');
  });

  // Main exploration brain
  interval(s, 1400, () => {
    if (s.busy || b.isSleeping) return;

    const threat = findThreat(s);

    if (threat && s.mode !== 'fleeing') {
      const escape = chooseWaypoint(s, threat);
      if (escape) {
        s.goalOrigin = b.entity.position.clone();
        setGoal(s, escape, 'fleeing');
      }
    }

    if (s.goal) return;

    if (Date.now() < s.pauseUntil) {
      b.setControlState('sneak', !!utils['anti-afk']?.sneak);
      return;
    }

    b.setControlState('sneak', false);

    if (observePlayer(s)) return;

    const target = chooseWaypoint(s, threat);

    if (target) {
      s.goalOrigin = b.entity.position.clone();
      setGoal(s, target, threat ? 'fleeing' : 'exploring far away');
    } else {
      newHeading(s, true);
      s.pauseUntil = Date.now() + 2000;
    }
  });

  // Travel distance tracking
  interval(s, 1000, () => {
    const p = b.entity.position;
    if (s.previousPosition) {
      const distance = p.distanceTo(s.previousPosition);
      if (distance < 9) s.distance += distance;
    }
    s.previousPosition = p.clone();
  });

  // Stuck detection and jumping recovery
  interval(s, 2400, () => {
    if (!s.goal || s.busy || b.isSleeping) return;

    const p = b.entity.position;

    if (p.distanceTo(s.progressPosition) >= 1.1) {
      s.progressPosition = p.clone();
      s.lastProgress = Date.now();
    }

    if (Date.now() - s.lastProgress > 8500 ||
        Date.now() - s.goalStart > 65000) {
      abandon(s, 'movement timeout');
    }

    for (const [key, expiry] of s.blocked) {
      if (expiry < Date.now()) s.blocked.delete(key);
    }
  });

  // Natural random jumping
  if (movement['random-jump']?.enabled) {
    interval(s, Math.max(9000, Number(movement['random-jump'].interval) || 10000), () => {
      if (s.goal || s.busy || b.isSleeping || !b.entity.onGround || Math.random() > 0.35) return;
      b.setControlState('jump', true);
      s.jumps++;
      timeout(s, 250, () => b.setControlState('jump', false));
    });
  }

  // Look around
  if (movement['look-around']?.enabled) {
    interval(s, Math.max(3000, Number(movement['look-around'].interval) || 5000), () => {
      if (s.goal || s.busy || s.mode === 'watching silently') return;
      Promise.resolve(b.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.35, true))
        .catch(() => {});
    });
  }
}

// SURVIVAL: AUTO EAT, COMBAT, BEDS
function startSurvival(s) {
  const b = s.bot;
  const mcData = require('minecraft-data')(config.server.version);

  if (modules.combat && combat['auto-eat']) {
    interval(s, 6000, async () => {
      if (s.busy || b.isSleeping || b.food === undefined || b.food >= 14) return;
      const food = b.inventory.items().find(i => {
        const data = mcData.itemsByName[i.name];
        return data && (data.foodPoints > 0 || data.food);
      });
      if (!food) return;

      s.busy = true;
      try {
        b.pathfinder.setGoal(null);
        s.goal = null;
        await b.equip(food, 'hand');
        if (active(s)) await b.consume();
      } catch (e) {
        log(`Eating: ${e.message}`);
      } finally {
        s.busy = false;
      }
    });
  }

  if (ATTACK) {
    const allowed = new Set(['zombie', 'skeleton', 'spider', 'drowned', 'husk', 'stray']);
    let lastAttack = 0;
    interval(s, 2200, () => {
      if (s.busy || Date.now() - lastAttack < 2000) return;
      const target = Object.values(b.entities).find(e =>
        e && e.type === 'mob' && allowed.has(e.name) &&
        e.position && e.id !== b.entity.id &&
        b.entities[e.id] === e &&
        b.entity.position.distanceTo(e.position) < 2.8
      );
      if (!target) return;
      try {
        b.attack(target);
        lastAttack = Date.now();
      } catch (e) {
        log(`Combat: ${e.message}`);
      }
    });
  }

  if (modules.beds && (beds['place-night'] || beds['pick-up-day'])) {
    let lastSleepAttempt = 0;

    interval(s, 13000, async () => {
      if (s.busy || !b.time || !b.entity) return;
      const time = b.time.timeOfDay;
      const night = time >= 12500 && time <= 23500;

      if (!night && beds['pick-up-day'] && s.placedBed) {
        const block = b.blockAt(s.placedBed);
        if (!block || !block.name.endsWith('_bed')) {
          s.placedBed = null;
          return;
        }
        if (b.entity.position.distanceTo(s.placedBed) > 4) return;

        s.busy = true;
        try {
          b.pathfinder.setGoal(null);
          s.goal = null;
          await b.dig(block);
          s.placedBed = null;
        } catch (e) {
          log(`Bed pickup: ${e.message}`);
        } finally {
          s.busy = false;
        }
        return;
      }

      if (!night || !beds['place-night'] || b.isSleeping ||
          Date.now() - lastSleepAttempt < 60000) return;

      lastSleepAttempt = Date.now();
      s.busy = true;

      try {
        b.pathfinder.setGoal(null);
        s.goal = null;

        let bed = b.findBlock({
          matching: block => block.name.endsWith('_bed'),
          maxDistance: 4
        });

        if (!bed) {
          const item = b.inventory.items().find(i => i.name.endsWith('_bed'));
          if (item) {
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const spot = safeGround(
                b,
                b.entity.position.x + dx,
                b.entity.position.z + dz,
                b.entity.position.y
              );
              if (!spot) continue;

              const floor = b.blockAt(new Vec3(spot.x, spot.y - 1, spot.z));
              if (!floor || b.entity.position.distanceTo(
                new Vec3(spot.x, spot.y, spot.z)
              ) > 4) continue;

              try {
                await b.equip(item, 'hand');
                await b.placeBlock(floor, new Vec3(0, 1, 0));
                const placed = b.blockAt(new Vec3(spot.x, spot.y, spot.z));
                if (placed && placed.name.endsWith('_bed')) {
                  bed = placed;
                  s.placedBed = placed.position.clone();
                  break;
                }
              } catch (_) {}
            }
          }
        }

        if (active(s) && bed) {
          try {
            await b.sleep(bed);
            s.mode = 'sleeping';
          } catch (_) {}
        }
      } catch (e) {
        log(`Bed: ${e.message}`);
      } finally {
        s.busy = false;
      }
    });

    b.on('wake', () => {
      if (active(s)) {
        s.mode = 'observing';
        s.pauseUntil = Date.now() + 2000;
      }
    });
  }

  if (modules.chat && utils['chat-log']) {
    b.on('messagestr', message => {
      if (session === s && !s.closed) log(`[Chat] ${message}`);
    });
  }
}

// CONNECT
function connect() {
  if (shuttingDown || session) return;

  log(`Connecting to ${config.server.ip}:${config.server.port}`);

  let bot;
  try {
    bot = mineflayer.createBot({
      username: config['bot-account'].username,
      password: config['bot-account'].password || undefined,
      auth: config['bot-account'].type || 'offline',
      host: config.server.ip,
      port: Number(config.server.port),
      version: config.server.version,
      hideErrors: true,
      checkTimeoutInterval: 120000
    });
  } catch (e) {
    history.error = e.message;
    reconnect();
    return;
  }

  const s = {
    bot,
    intervals: new Set(),
    timeouts: new Set(),
    connectionTimer: null,
    closed: false,
    spawned: false,
    busy: false,
    mode: 'connecting',
    goal: null,
    goalOrigin: null,
    goalStart: 0,
    lastProgress: 0,
    progressPosition: null,
    pauseUntil: 0,
    heading: Math.random() * Math.PI * 2,
    progress: 0,
    distance: 0,
    jumps: 0,
    failures: 0,
    blocked: new Map(),
    visited: [],
    previousPosition: null,
    placedBed: null
  };

  session = s;

  try {
    bot.loadPlugin(pathfinder);
  } catch (e) {
    disconnect(s, e.message);
    try { bot.end(); } catch (_) {}
    return;
  }

  // Only login/register messages, never ordinary chat.
  let authSent = false;
  bot.on('messagestr', message => {
    if (!AUTO_AUTH || !PASSWORD || authSent || session !== s || s.closed) return;
    const text = String(message).toLowerCase();
    let cmd = null;
    if (text.includes('/register')) cmd = `/register ${PASSWORD} ${PASSWORD}`;
    else if (text.includes('/login')) cmd = `/login ${PASSWORD}`;
    if (!cmd) return;
    authSent = true;
    try {
      bot.chat(cmd);
      log('Authentication sent');
    } catch (e) {
      authSent = false;
      log(`Authentication: ${e.message}`);
    }
  });

  bot.once('spawn', () => {
    if (session !== s || s.closed) return;

    clearTimeout(s.connectionTimer);
    s.spawned = true;
    s.mode = 'observing';
    s.pauseUntil = Date.now() + rand(1500, 3500);

    log('Aevoris manifested. Silent long-range exploration enabled.');
    notify('Aevoris appeared in the world.', 'connect');

    timeout(s, 120000, () => { attempts = 0; });

    try {
      if (movement.enabled !== false) startExplorer(s);
      startSurvival(s);
    } catch (e) {
      history.error = e.message;
      log(`Initialization: ${e.message}`);
    }
  });

  bot.on('kicked', reason => {
    if (session !== s || s.closed) return;
    history.kick = typeof reason === 'string' ? reason : JSON.stringify(reason);
    log(`Kicked: ${history.kick}`);
  });

  bot.on('error', e => {
    if (session !== s || s.closed) return;
    history.error = e.message;
    log(`Network: ${e.code || e.message}`);
  });

  bot.once('end', reason => {
    disconnect(s, reason || 'socket closed');
  });

  s.connectionTimer = setTimeout(() => {
    if (s.closed || s.spawned) return;
    disconnect(s, 'connection timeout');
    try { bot.end(); } catch (_) {}
  }, 60000);
}

// CONSOLE COMMANDS
const cli = readline.createInterface({
  input: process.stdin,
  terminal: false
});

cli.on('line', line => {
  const text = line.trim();
  const s = session;

  if (text === 'status') {
    log(s && active(s)
      ? `${s.mode} | ${s.bot.entity.position} | ${Math.round(s.distance)} blocks`
      : 'Offline');
    return;
  }

  if (text === 'reconnect') {
    if (s) {
      disconnect(s, 'manual reconnect');
      try { s.bot.end(); } catch (_) {}
    } else reconnect();
    return;
  }

  if (!s || !active(s)) return;

  if (text === 'explore') {
    newHeading(s, true);
    if (s.goal) abandon(s, 'new expedition');
    s.pauseUntil = 0;
  }

  if (text === 'jump' && !s.goal && s.bot.entity.onGround) {
    s.bot.setControlState('jump', true);
    s.jumps++;
    timeout(s, 250, () => s.bot.setControlState('jump', false));
  }

  if (text.startsWith('say ')) {
    try { s.bot.chat(text.slice(4)); } catch (_) {}
  }

  if (text.startsWith('cmd ')) {
    try { s.bot.chat('/' + text.slice(4)); } catch (_) {}
  }
});

// SHUTDOWN
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(reconnectTimer);

  if (session) {
    const s = session;
    disconnect(s, 'shutdown', false);
    try { s.bot.end(); } catch (_) {}
  }

  webServer.close();
  setTimeout(() => process.exit(0), 1000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

process.on('unhandledRejection', e => {
  history.error = String(e);
  log(`Unhandled rejection: ${history.error}`);
});

// START
log('AEVORIS v3.0 — THE SILENT EXPLORER');
log(`Expedition distance: ${EXPEDITION} blocks`);
log(`Waypoint distance: ${WAYPOINT} blocks`);
log(`Jumping: ${movement['random-jump']?.enabled ? 'ON' : 'OFF'}`);
log(`Combat: ${ATTACK ? 'ON' : 'OFF'}`);
log('Automatic chat: OFF');

connect();
