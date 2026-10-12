
'use strict';

// AEVORIS — The Silent Wanderer
// Minecraft Java 1.15.1
// Requires: mineflayer, mineflayer-pathfinder,
// minecraft-data, vec3, express

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;
const Vec3 = require('vec3');
const express = require('express');
const http = require('http');
const https = require('https');
const readline = require('readline');
const config = require('./settings.json');

const options = config.utils || {};
const movement = config.movement || {};
const features = config.modules || {};
const combat = config.combat || {};
const sleeping = config.beds || {};

const PORT = Number(process.env.PORT) || 8080;
const MAX_RADIUS = Math.max(
  8,
  Math.min(32, Number(movement['wander-radius']) || 18)
);

const AUTO_RECONNECT = options['auto-reconnect'] !== false;

const ATTACK =
  features.combat &&
  combat['attack-mobs'] &&
  process.env.AEVORIS_COMBAT === 'true';

const AUTH_PASSWORD =
  process.env.MC_AUTH_PASSWORD ||
  options['auto-auth']?.password ||
  '';

const now = () => Date.now();
const rand = (a, b) =>
  Math.floor(a + Math.random() * (b - a + 1));

const announce = text =>
  console.log(`[Aevoris] ${text}`);

let session = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let closing = false;

const startedAt = now();

const history = {
  lastKick: null,
  lastError: null
};

// ============================================================
// DASHBOARD
// ============================================================

const app = express();

app.get('/health', (_req, res) => {
  const live = session && isLive(session);
  const p = live ? session.bot.entity.position : null;

  res.json({
    name: config['bot-account'].username,
    connected: !!live,
    mode: live ? session.mode : 'offline',
    position: p
      ? {
          x: +p.x.toFixed(1),
          y: +p.y.toFixed(1),
          z: +p.z.toFixed(1)
        }
      : null,
    uptimeSeconds: Math.floor((now() - startedAt) / 1000),
    reconnectAttempts,
    lastKick: history.lastKick,
    lastError: history.lastError
  });
});

app.get('/ping', (_req, res) => res.send('pong'));

app.get('/', (_req, res) => {
  res.send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aevoris</title>
<style>
body {
  background:#090b10;
  color:#e5e7eb;
  font:16px Arial;
  min-height:95vh;
  display:grid;
  place-items:center;
}
main {
  border:1px solid #3d4756;
  border-radius:18px;
  padding:28px;
  max-width:430px;
  width:82%;
  box-shadow:0 0 55px #aab5d015;
}
h1 {
  letter-spacing:5px;
  color:#edf4ff;
}
p { color:#aab5c9; }
b { color:#fff; }
</style>
</head>
<body>
<main>
<h1>AEVORIS</h1>
<p>The Silent Wanderer</p>
<p>Presence: <b id="status">...</b></p>
<p>Behaviour: <b id="mode">...</b></p>
<p>Location: <b id="xyz">...</b></p>
<p>Reconnects: <b id="tries">...</b></p>
</main>
<script>
async function refresh() {
  try {
    const r = await fetch('/health');
    const s = await r.json();
    document.getElementById('status').textContent =
      s.connected ? 'Manifested' : 'Absent';
    document.getElementById('mode').textContent = s.mode;
    document.getElementById('xyz').textContent =
      s.position
        ? Object.values(s.position).join(', ')
        : 'Unknown';
    document.getElementById('tries').textContent =
      s.reconnectAttempts;
  } catch (e) {
    document.getElementById('status').textContent =
      'Unknown';
  }
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>
  `);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  announce(`Dashboard on port ${PORT}`);
});

// Optional web monitoring.
// This cannot keep an Aternos server running.

if (process.env.MONITOR_PING_URL) {
  setInterval(() => {
    try {
      const uri = new URL(process.env.MONITOR_PING_URL);
      const client =
        uri.protocol === 'https:' ? https : http;

      const request = client.get(
        uri,
        response => response.resume()
      );

      request.setTimeout(8000, () => request.destroy());

      request.on('error', error => {
        announce(`Monitoring ping: ${error.message}`);
      });
    } catch (error) {
      announce(`Monitoring ping: ${error.message}`);
    }
  }, 10 * 60 * 1000);
}

// ============================================================
// DISCORD
// ============================================================

function sendDiscord(text, color = 0xb0c4de, event) {
  const discord = config.discord || {};

  if (
    !discord.enabled ||
    (event && discord.events?.[event] === false)
  ) return;

  const urlText =
    process.env.DISCORD_WEBHOOK_URL ||
    discord.webhookUrl;

  if (
    !urlText ||
    urlText.includes('YOUR_DISCORD')
  ) return;

  try {
    const uri = new URL(urlText);

    if (uri.protocol !== 'https:') return;

    const body = JSON.stringify({
      username: 'Aevoris',
      embeds: [{
        description: text,
        color,
        timestamp: new Date().toISOString()
      }]
    });

    const req = https.request({
      hostname: uri.hostname,
      port: uri.port || 443,
      path: uri.pathname + uri.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, response => response.resume());

    req.on('error', err => {
      announce(`Discord: ${err.message}`);
    });

    req.end(body);

  } catch (err) {
    announce(`Discord: ${err.message}`);
  }
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

function isCurrent(s) {
  return session === s && !s.closed && !closing;
}

function isLive(s) {
  return (
    isCurrent(s) &&
    s.spawned &&
    !!s.bot.entity
  );
}

function every(s, ms, fn) {
  const id = setInterval(() => {
    if (!isLive(s)) return;

    try {
      Promise.resolve(fn()).catch(err => {
        announce(`Module: ${err.message}`);
      });
    } catch (err) {
      announce(`Module: ${err.message}`);
    }
  }, ms);

  s.intervals.add(id);
  return id;
}

function later(s, ms, fn) {
  const id = setTimeout(() => {
    s.timeouts.delete(id);

    if (!isLive(s)) return;

    try {
      Promise.resolve(fn()).catch(err => {
        announce(`Timer: ${err.message}`);
      });
    } catch (err) {
      announce(`Timer: ${err.message}`);
    }
  }, ms);

  s.timeouts.add(id);
  return id;
}

function cleanup(s) {
  if (s.closed) return;

  s.closed = true;

  for (const id of s.intervals) {
    clearInterval(id);
  }

  for (const id of s.timeouts) {
    clearTimeout(id);
  }

  s.intervals.clear();
  s.timeouts.clear();

  if (s.connectTimer) {
    clearTimeout(s.connectTimer);
  }

  try {
    s.bot.pathfinder.setGoal(null);
  } catch (_) {}

  try {
    s.bot.clearControlStates();
  } catch (_) {}
}

// ============================================================
// AUTOMATIC RECONNECTION
// ============================================================

function reconnect() {
  if (
    closing ||
    !AUTO_RECONNECT ||
    reconnectTimer
  ) return;

  reconnectAttempts++;

  const base = Math.max(
    2000,
    Number(options['auto-reconnect-delay']) || 3000
  );

  const cap = Math.max(
    base,
    Number(options['max-reconnect-delay']) || 60000
  );

  const delay = Math.min(
    cap,
    base * 2 ** Math.min(6, reconnectAttempts - 1)
  );

  announce(
    `Reconnect in ${Math.round(delay / 1000)}s ` +
    `(#${reconnectAttempts})`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function finish(s, reason, deliberate = false) {
  if (s.closed) return;

  announce(`Disconnected: ${reason}`);

  const wasSpawned = s.spawned;

  cleanup(s);

  if (session === s) {
    session = null;

    if (wasSpawned) {
      sendDiscord(
        `Aevoris vanished: ${reason}`,
        0xd77b83,
        'disconnect'
      );
    }

    if (!deliberate) reconnect();
  }
}

function chatCommand(s, text) {
  if (!isLive(s)) return;

  try {
    s.bot.chat(text);
  } catch (err) {
    announce(`Command failed: ${err.message}`);
  }
}

// ============================================================
// TERRAIN SAFETY SCANNER
// ============================================================

const hazardous =
  /lava|fire|magma|cactus|sweet_berry|campfire|powder_snow/;

function footSafe(bot, x, y, z) {
  const here = bot.blockAt(new Vec3(x, y, z));
  const head = bot.blockAt(new Vec3(x, y + 1, z));
  const floor = bot.blockAt(new Vec3(x, y - 1, z));

  if (!here || !head || !floor) return false;

  if (
    here.boundingBox !== 'empty' ||
    head.boundingBox !== 'empty'
  ) return false;

  if (
    floor.boundingBox !== 'block' ||
    hazardous.test(floor.name)
  ) return false;

  if (
    hazardous.test(here.name) ||
    hazardous.test(head.name)
  ) return false;

  if (
    here.name.includes('water') ||
    head.name.includes('water')
  ) return false;

  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ]) {
    const beside = bot.blockAt(
      new Vec3(x + dx, y, z + dz)
    );

    if (
      beside &&
      hazardous.test(beside.name)
    ) return false;
  }

  return true;
}

function findFoot(bot, x, z, suggestedY) {
  x = Math.floor(x);
  z = Math.floor(z);

  const y0 = Math.floor(suggestedY);

  for (const dy of [
    0, 1, -1, 2, -2, 3, -3, 4, -4
  ]) {
    const y = y0 + dy;

    if (footSafe(bot, x, y, z)) {
      return { x, y, z };
    }
  }

  return null;
}

// ============================================================
// MOB DETECTION
// ============================================================

function nearbyThreat(s) {
  if (!features.avoidMobs) return null;

  const p = s.bot.entity.position;

  const dangerous = new Set([
    'zombie',
    'skeleton',
    'spider',
    'creeper',
    'drowned',
    'husk',
    'stray',
    'witch',
    'enderman',
    'phantom',
    'pillager'
  ]);

  return Object.values(s.bot.entities)
    .filter(e =>
      e &&
      e.position &&
      dangerous.has(e.name) &&
      p.distanceTo(e.position) < 9
    )
    .sort((a, b) =>
      p.distanceTo(a.position) -
      p.distanceTo(b.position)
    )[0] || null;
}

// ============================================================
// SMART DESTINATION SYSTEM
// ============================================================

function setDestination(s, dest, mode) {
  if (!isLive(s) || !dest) return false;

  try {
    s.bot.pathfinder.setGoal(
      new GoalNear(
        dest.x,
        dest.y,
        dest.z,
        1
      )
    );

    s.goal = dest;
    s.mode = mode;
    s.lastProgress = now();
    s.lastPosition =
      s.bot.entity.position.clone();
    s.goalSince = now();

    s.bot.setControlState('sneak', false);

    return true;

  } catch (err) {
    announce(`Path planning: ${err.message}`);
    return false;
  }
}

function abandon(s, why) {
  if (!isLive(s)) return;

  const old = s.goal;

  s.goal = null;
  s.mode = 'searching';
  s.pauseUntil = now() + rand(1500, 3500);

  try {
    s.bot.pathfinder.setGoal(null);
  } catch (_) {}

  try {
    s.bot.clearControlStates();
  } catch (_) {}

  if (old) {
    s.badSpots.set(
      `${old.x},${old.y},${old.z}`,
      now() + 120000
    );
  }

  announce(`Finding another route (${why})`);
}

function chooseDestination(s, threat = null) {
  const b = s.bot;
  const p = b.entity.position;

  const landmark =
    config.position?.enabled
      ? config.position
      : null;

  const useLandmark =
    landmark &&
    Math.hypot(
      p.x - landmark.x,
      p.z - landmark.z
    ) < 26 &&
    Math.abs(p.y - landmark.y) < 7 &&
    Math.random() < 0.10;

  for (let attempt = 0; attempt < 45; attempt++) {
    let x, z;

    if (useLandmark && attempt < 12) {
      x = landmark.x + rand(-7, 7);
      z = landmark.z + rand(-7, 7);

    } else if (threat) {
      const away =
        Math.atan2(
          p.z - threat.position.z,
          p.x - threat.position.x
        ) +
        (Math.random() - 0.5);

      const r = rand(8, 14);

      x = p.x + Math.cos(away) * r;
      z = p.z + Math.sin(away) * r;

    } else {
      const angle =
        Math.random() * Math.PI * 2;

      const r = rand(6, MAX_RADIUS);

      x = p.x + Math.cos(angle) * r;
      z = p.z + Math.sin(angle) * r;
    }

    const candidate =
      findFoot(b, x, z, p.y);

    if (!candidate) continue;

    if (
      s.badSpots.get(
        `${candidate.x},${candidate.y},${candidate.z}`
      ) > now()
    ) continue;

    if (
      threat &&
      Math.hypot(
        candidate.x - threat.position.x,
        candidate.z - threat.position.z
      ) < 9
    ) continue;

    return candidate;
  }

  return null;
}

// ============================================================
// SILENT PLAYER OBSERVATION
// ============================================================

function watchSomeone(s) {
  if (!isLive(s)) return false;

  const p = s.bot.entity.position;

  const strangers = Object.values(s.bot.players)
    .map(player => player.entity)
    .filter(e =>
      e &&
      e.id !== s.bot.entity.id &&
      e.position &&
      p.distanceTo(e.position) < 14
    );

  if (
    !strangers.length ||
    Math.random() > 0.32
  ) return false;

  const target =
    strangers[rand(0, strangers.length - 1)];

  s.mode = 'watching';
  s.pauseUntil =
    now() + rand(3500, 8000);

  try {
    s.bot.pathfinder.setGoal(null);
  } catch (_) {}

  s.goal = null;

  try {
    Promise.resolve(
      s.bot.lookAt(
        target.position.offset(0, 1.45, 0),
        true
      )
    ).catch(() => {});
  } catch (_) {}

  return true;
}

// ============================================================
// INTELLIGENT WANDERING BRAIN
// ============================================================

function startBrain(s) {
  const b = s.bot;

  const mcData =
    require('minecraft-data')(config.server.version);

  const moves =
    new Movements(b, mcData);

  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowParkour = false;
  moves.maxDropDown = 1;
  moves.infiniteLiquidDropdownDistance = false;
  moves.allowFreeMotion = false;
  moves.allowSprinting = true;
  moves.liquidCost = 25;

  b.pathfinder.setMovements(moves);

  b.pathfinder.thinkTimeout = 4000;
  b.pathfinder.tickTimeout = 30;

  b.on('goal_reached', () => {
    if (!isLive(s) || !s.goal) return;

    s.goal = null;
    s.mode = 'observing';

    s.pauseUntil =
      now() + rand(3000, 13000);
  });

  b.on('path_update', result => {
    if (!isLive(s) || !s.goal) return;

    if (
      result.status === 'noPath' ||
      result.status === 'timeout'
    ) {
      abandon(s, result.status);
    }
  });

  every(s, 1400, () => {
    if (b.isSleeping || !b.entity) return;
    if (s.busy) return;

    const threat = nearbyThreat(s);

    if (
      threat &&
      s.mode !== 'fleeing'
    ) {
      const escape =
        chooseDestination(s, threat);

      if (escape) {
        setDestination(
          s,
          escape,
          'fleeing'
        );
      }
    }

    if (s.goal) return;

    if (now() < s.pauseUntil) {
      b.setControlState(
        'sneak',
        !!options['anti-afk']?.sneak
      );
      return;
    }

    b.setControlState('sneak', false);

    if (watchSomeone(s)) return;

    const dest =
      chooseDestination(s, threat);

    if (!dest) {
      s.mode = 'searching';
      s.pauseUntil = now() + 4500;
      return;
    }

    setDestination(
      s,
      dest,
      threat ? 'fleeing' : 'wandering'
    );
  });

  // Stuck detection

  every(s, 2500, () => {
    if (
      !s.goal ||
      !b.entity ||
      b.isSleeping
    ) return;

    if (
      b.entity.position.distanceTo(
        s.lastPosition
      ) >= 1.1
    ) {
      s.lastPosition =
        b.entity.position.clone();

      s.lastProgress = now();
    }

    if (
      now() - s.lastProgress > 12000 ||
      now() - s.goalSince > 50000
    ) {
      abandon(
        s,
        'stuck or unreachable'
      );
    }

    for (const [key, expiry] of s.badSpots) {
      if (expiry < now()) {
        s.badSpots.delete(key);
      }
    }
  });

  // Look around while idle

  if (movement['look-around']?.enabled) {
    every(
      s,
      Math.max(
        3000,
        Number(
          movement['look-around'].interval
        ) || 5000
      ),
      () => {
        if (
          s.goal ||
          s.mode === 'watching' ||
          b.isSleeping
        ) return;

        try {
          Promise.resolve(
            b.look(
              Math.random() * Math.PI * 2,
              (Math.random() - 0.5) * 0.35,
              true
            )
          ).catch(() => {});
        } catch (_) {}
      }
    );
  }

  // Occasional idle jumping

  if (
    movement['random-jump']?.enabled &&
    options['anti-afk']?.enabled
  ) {
    every(
      s,
      Math.max(
        9000,
        Number(
          movement['random-jump'].interval
        ) || 12000
      ),
      () => {
        if (
          s.goal ||
          s.mode === 'watching' ||
          !b.entity.onGround ||
          b.isSleeping ||
          Math.random() > 0.22
        ) return;

        b.setControlState('jump', true);

        later(s, 230, () => {
          b.setControlState(
            'jump',
            false
          );
        });
      }
    );
  }
}

// ============================================================
// SURVIVAL, COMBAT AND BEDS
// ============================================================

function startSurvival(s) {
  const b = s.bot;
  const mcData =
    require('minecraft-data')(config.server.version);

  // Auto-eat

  if (
    features.combat &&
    combat['auto-eat']
  ) {
    every(s, 6000, async () => {
      if (
        s.busy ||
        b.isSleeping ||
        b.food === undefined ||
        b.food >= 14
      ) return;

      const food =
        b.inventory.items().find(item => {
          const data =
            mcData.itemsByName[item.name];

          return data &&
            (
              data.foodPoints > 0 ||
              data.food
            );
        });

      if (!food) return;

      s.busy = true;

      try {
        await b.equip(food, 'hand');

        if (isLive(s)) {
          await b.consume();
        }

      } catch (err) {
        announce(`Eating: ${err.message}`);
      } finally {
        s.busy = false;
      }
    });
  }

  // Optional safe combat

  if (ATTACK) {
    const allowed = new Set([
      'zombie',
      'skeleton',
      'spider',
      'drowned',
      'husk',
      'stray'
    ]);

    let lastAttack = 0;

    every(s, 2000, () => {
      if (
        s.busy ||
        now() - lastAttack < 2000
      ) return;

      const target =
        Object.values(b.entities).find(e =>
          e &&
          e.type === 'mob' &&
          allowed.has(e.name) &&
          e.position &&
          b.entities[e.id] === e &&
          e.id !== b.entity.id &&
          b.entity.position.distanceTo(
            e.position
          ) < 3
        );

      if (!target) return;

      try {
        b.attack(target);
        lastAttack = now();
      } catch (err) {
        announce(`Combat: ${err.message}`);
      }
    });
  }

  // Nighttime beds and daytime recovery

  if (
    features.beds &&
    (
      sleeping['place-night'] ||
      sleeping['pick-up-day']
    )
  ) {
    let lastAttempt = 0;

    every(s, 10000, async () => {
      if (
        s.busy ||
        !b.time ||
        !b.entity
      ) return;

      const time = b.time.timeOfDay;
      const night =
        time >= 12500 &&
        time <= 23500;

      // Recover only beds placed by Aevoris.

      if (
        !night &&
        sleeping['pick-up-day'] &&
        s.placedBed
      ) {
        const p = s.placedBed;
        const block = b.blockAt(p);

        if (
          !block ||
          !block.name.endsWith('_bed')
        ) {
          s.placedBed = null;
          return;
        }

        if (
          b.entity.position.distanceTo(p) > 4.5
        ) return;

        s.busy = true;

        try {
          b.pathfinder.setGoal(null);
          s.goal = null;

          await b.dig(block);

          s.placedBed = null;

        } catch (err) {
          announce(
            `Bed pickup: ${err.message}`
          );
        } finally {
          s.busy = false;
        }

        return;
      }

      if (
        !night ||
        !sleeping['place-night'] ||
        b.isSleeping ||
        now() - lastAttempt < 45000
      ) return;

      lastAttempt = now();
      s.busy = true;

      try {
        b.pathfinder.setGoal(null);
        s.goal = null;

        let bed = b.findBlock({
          matching: block =>
            block.name.endsWith('_bed'),
          maxDistance: 5
        });

        if (!bed) {
          const bedItem =
            b.inventory.items().find(i =>
              i.name.endsWith('_bed')
            );

          if (bedItem) {
            const pos = b.entity.position;

            for (const [dx, dz] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1]
            ]) {
              const spot = findFoot(
                b,
                pos.x + dx,
                pos.z + dz,
                pos.y
              );

              if (!spot) continue;

              if (
                b.entity.position.distanceTo(
                  new Vec3(
                    spot.x,
                    spot.y,
                    spot.z
                  )
                ) > 4.4
              ) continue;

              const floor = b.blockAt(
                new Vec3(
                  spot.x,
                  spot.y - 1,
                  spot.z
                )
              );

              if (!floor) continue;

              try {
                await b.equip(
                  bedItem,
                  'hand'
                );

                await b.placeBlock(
                  floor,
                  new Vec3(0, 1, 0)
                );

                bed = b.blockAt(
                  new Vec3(
                    spot.x,
                    spot.y,
                    spot.z
                  )
                );

                if (
                  bed &&
                  bed.name.endsWith('_bed')
                ) {
                  s.placedBed =
                    bed.position.clone();
                }

                break;
              } catch (_) {}
            }
          }
        }

        if (
          isLive(s) &&
          bed &&
          bed.name.endsWith('_bed')
        ) {
          try {
            await b.sleep(bed);
            s.mode = 'sleeping';
          } catch (_) {}
        }

      } catch (err) {
        announce(`Bed: ${err.message}`);
      } finally {
        s.busy = false;
      }
    });
  }

  b.on('wake', () => {
    if (isLive(s)) {
      s.mode = 'observing';
      s.pauseUntil = now() + 3000;
    }
  });

  // Read chat, never automatically reply.

  if (
    features.chat &&
    options['chat-log']
  ) {
    b.on('messagestr', message => {
      if (isCurrent(s)) {
        announce(
          `[Server chat] ${String(message)}`
        );
      }
    });
  }
}

// ============================================================
// CONNECTION
// ============================================================

function connect() {
  if (closing || session) return;

  announce(
    `Connecting ${config.server.ip}:` +
    `${config.server.port} as ` +
    config['bot-account'].username
  );

  let b;

  try {
    b = mineflayer.createBot({
      username:
        config['bot-account'].username,
      password:
        config['bot-account'].password ||
        undefined,
      auth:
        config['bot-account'].type ||
        'offline',
      host: config.server.ip,
      port: Number(config.server.port),
      version: config.server.version,
      hideErrors: true,
      checkTimeoutInterval: 120000
    });
  } catch (err) {
    history.lastError = err.message;

    announce(
      `Creation failed: ${err.message}`
    );

    reconnect();
    return;
  }

  const s = {
    bot: b,
    spawned: false,
    closed: false,
    intervals: new Set(),
    timeouts: new Set(),
    connectTimer: null,
    busy: false,
    goal: null,
    mode: 'connecting',
    pauseUntil: 0,
    goalSince: 0,
    lastProgress: 0,
    lastPosition: null,
    badSpots: new Map(),
    placedBed: null
  };

  session = s;

  try {
    b.loadPlugin(pathfinder);
  } catch (err) {
    history.lastError = err.message;

    finish(s, err.message);

    try {
      b.end();
    } catch (_) {}

    return;
  }

  // Authentication only — no normal chat messages.

  let authenticated = false;

  b.on('messagestr', message => {
    if (
      !isCurrent(s) ||
      !options['auto-auth']?.enabled ||
      !AUTH_PASSWORD ||
      authenticated
    ) return;

    const msg =
      String(message).toLowerCase();

    let command = null;

    if (msg.includes('/register')) {
      command =
        `/register ${AUTH_PASSWORD} ` +
        AUTH_PASSWORD;
    } else if (msg.includes('/login')) {
      command =
        `/login ${AUTH_PASSWORD}`;
    }

    if (command) {
      authenticated = true;

      try {
        b.chat(command);

        announce(
          'Authentication command sent'
        );
      } catch (err) {
        authenticated = false;

        announce(
          `Authentication: ${err.message}`
        );
      }
    }
  });

  b.once('spawn', () => {
    if (!isCurrent(s)) return;

    s.spawned = true;

    if (s.connectTimer) {
      clearTimeout(s.connectTimer);
    }

    s.mode = 'observing';
    s.pauseUntil =
      now() + rand(1500, 4500);

    announce(
      'Aevoris has manifested. ' +
      'In-game speech disabled.'
    );

    sendDiscord(
      'Aevoris appeared in the world.',
      0xb0c4de,
      'connect'
    );

    later(s, 120000, () => {
      reconnectAttempts = 0;
    });

    try {
      if (movement.enabled !== false) {
        startBrain(s);
      }

      startSurvival(s);

    } catch (err) {
      history.lastError = err.message;

      announce(
        `Module initialization: ${err.message}`
      );
    }
  });

  b.on('kicked', reason => {
    if (!isCurrent(s)) return;

    const text =
      typeof reason === 'string'
        ? reason
        : JSON.stringify(reason);

    history.lastKick = text;

    announce(`Kicked: ${text}`);
  });

  b.on('error', err => {
    if (!isCurrent(s)) return;

    history.lastError = err.message;

    announce(
      `Network: ${err.code || err.message}`
    );
  });

  b.once('end', reason => {
    finish(
      s,
      reason || 'socket closed'
    );
  });

  s.connectTimer = setTimeout(() => {
    if (s.closed || s.spawned) return;

    finish(s, 'spawn timeout');

    try {
      b.end();
    } catch (_) {}

  }, 60000);
}

// ============================================================
// CONSOLE COMMANDS
// ============================================================

const cli = readline.createInterface({
  input: process.stdin,
  terminal: false
});

cli.on('line', line => {
  const command = line.trim();
  const s = session;

  if (command === 'status') {
    return announce(
      s && isLive(s)
        ? `ONLINE, ${s.mode}, ` +
          s.bot.entity.position
        : 'OFFLINE'
    );
  }

  if (command === 'reconnect') {
    if (s) {
      finish(
        s,
        'console reconnect'
      );

      try {
        s.bot.end();
      } catch (_) {}
    }

    if (!reconnectTimer) {
      reconnect();
    }

    return;
  }

  if (!s || !isLive(s)) {
    return announce('Not connected');
  }

  if (command.startsWith('say ')) {
    chatCommand(
      s,
      command.slice(4)
    );

  } else if (command.startsWith('cmd ')) {
    chatCommand(
      s,
      '/' + command.slice(4)
    );

  } else if (command === 'wander') {
    abandon(s, 'console');
    s.pauseUntil = 0;
  }
});

// ============================================================
// SHUTDOWN
// ============================================================

function shutdown() {
  if (closing) return;

  closing = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  if (session) {
    const s = session;

    cleanup(s);
    session = null;

    try {
      s.bot.end();
    } catch (_) {}
  }

  server.close();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

process.on('unhandledRejection', err => {
  history.lastError = String(err);

  announce(
    `Unhandled rejection: ${err}`
  );
});

// ============================================================
// START AEVORIS
// ============================================================

announce('AEVORIS — The Silent Wanderer');

announce(
  'Smart wandering ON | ' +
  'Chat OFF | ' +
  `Combat ${ATTACK ? 'ON' : 'OFF'}`
);

connect();
