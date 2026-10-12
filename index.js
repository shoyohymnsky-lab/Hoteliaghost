
'use strict';

// ============================================================
// AEVORIS v3.1 — THE SILENT EXPLORER
// Minecraft Java Edition 1.15.1
// ============================================================

const mineflayer = require('mineflayer');
const {
  pathfinder,
  Movements,
  goals
} = require('mineflayer-pathfinder');
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

const EXPEDITION = Math.max(
  128,
  Number(movement['expedition-distance']) || 3000
);

const WAYPOINT = Math.max(
  10,
  Math.min(
    28,
    Number(movement['waypoint-distance']) || 22
  )
);

// FIXED: AUTO_AUTH is now defined.
const AUTO_AUTH =
  utils['auto-auth']?.enabled === true;

const PASSWORD =
  process.env.MC_AUTH_PASSWORD ||
  utils['auto-auth']?.password ||
  '';

// Combat is disabled unless explicitly enabled.
const ATTACK =
  modules.combat === true &&
  combat['attack-mobs'] === true &&
  process.env.AEVORIS_COMBAT === 'true';

const rand = (a, b) =>
  Math.floor(Math.random() * (b - a + 1)) + a;

const log = text =>
  console.log(`[Aevoris] ${text}`);

let session = null;
let reconnectTimer = null;
let attempts = 0;
let shuttingDown = false;

const started = Date.now();

const history = {
  kick: null,
  error: null
};

// ============================================================
// WEB DASHBOARD
// ============================================================

const app = express();

app.get('/ping', (_req, res) => {
  res.send('pong');
});

app.get('/health', (_req, res) => {
  const s = session;
  const online = !!s && active(s);

  const p = online
    ? s.bot.entity.position
    : null;

  res.json({
    name: config['bot-account'].username,
    connected: online,
    mode: online ? s.mode : 'offline',

    coordinates: p
      ? {
          x: Math.round(p.x),
          y: Math.round(p.y),
          z: Math.round(p.z)
        }
      : null,

    distance: online
      ? Math.round(s.distance)
      : 0,

    jumps: online ? s.jumps : 0,

    expedition: online
      ? Math.round(s.progress)
      : 0,

    reconnectAttempts: attempts,

    uptime: Math.floor(
      (Date.now() - started) / 1000
    ),

    lastKick: history.kick,
    lastError: history.error
  });
});

app.get('/', (_req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport"
content="width=device-width, initial-scale=1">

<title>Aevoris — The Silent Explorer</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #080b13;
  color: #e9f0ff;
  font: 16px Arial, sans-serif;
  min-height: 100vh;
  display: grid;
  place-items: center;
}

main {
  background: #182033;
  padding: 30px;
  border-radius: 20px;
  width: min(460px, 90%);
  box-shadow: 0 0 45px #b0c4de22;
  border: 1px solid #38445b;
}

h1 {
  letter-spacing: 5px;
  text-align: center;
}

.subtitle {
  text-align: center;
  color: #9facc6;
}

p {
  color: #bdc9dc;
  margin: 17px 0;
}

b {
  color: #fff;
}

footer {
  text-align: center;
  margin-top: 25px;
  font-size: 12px;
  color: #70809d;
}
</style>
</head>

<body>
<main>

<h1>AEVORIS</h1>
<p class="subtitle">The Silent Explorer</p>

<p>Status: <b id="status">Loading...</b></p>
<p>Behaviour: <b id="mode">Unknown</b></p>
<p>Coordinates: <b id="pos">Unknown</b></p>
<p>Distance travelled: <b id="distance">0</b></p>
<p>Expedition progress: <b id="expedition">0</b></p>
<p>Jumps: <b id="jumps">0</b></p>
<p>Reconnect attempts: <b id="attempts">0</b></p>

<footer>Aevoris v3.1</footer>
</main>

<script>
async function refresh() {
  try {
    const response = await fetch('/health');
    const d = await response.json();

    document.getElementById('status').textContent =
      d.connected ? 'Manifested' : 'Absent';

    document.getElementById('mode').textContent =
      d.mode;

    document.getElementById('pos').textContent =
      d.coordinates
        ? Object.values(d.coordinates).join(', ')
        : 'Unknown';

    document.getElementById('distance').textContent =
      d.distance + ' blocks';

    document.getElementById('expedition').textContent =
      d.expedition + ' blocks';

    document.getElementById('jumps').textContent =
      d.jumps;

    document.getElementById('attempts').textContent =
      d.reconnectAttempts;

  } catch (error) {
    document.getElementById('status').textContent =
      'Dashboard unavailable';
  }
}

refresh();
setInterval(refresh, 3000);
</script>

</body>
</html>
  `);
});

const webServer = app.listen(
  PORT,
  '0.0.0.0',
  () => log(`Dashboard listening on port ${PORT}`)
);

// ============================================================
// DISCORD NOTIFICATIONS
// ============================================================

function notify(message, event, color = 0xb0c4de) {
  const discord = config.discord || {};

  if (!discord.enabled) return;

  if (
    event &&
    discord.events?.[event] === false
  ) return;

  // Use environment variable, not an exposed webhook.
  const webhook = process.env.DISCORD_WEBHOOK_URL;

  if (!webhook) return;

  try {
    const url = new URL(webhook);

    if (url.protocol !== 'https:') return;

    const body = JSON.stringify({
      username: 'Aevoris',
      embeds: [{
        description: message,
        color,
        timestamp: new Date().toISOString()
      }]
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

    }, response => response.resume());

    req.on('error', error => {
      log(`Discord error: ${error.message}`);
    });

    req.end(body);

  } catch (error) {
    log(`Discord error: ${error.message}`);
  }
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

function current(s) {
  return (
    session === s &&
    !s.closed &&
    !shuttingDown
  );
}

function active(s) {
  return (
    current(s) &&
    s.spawned &&
    !!s.bot.entity
  );
}

function interval(s, milliseconds, fn) {
  const id = setInterval(() => {
    if (!active(s)) return;

    try {
      Promise.resolve(fn()).catch(error => {
        log(`Module error: ${error.message}`);
      });

    } catch (error) {
      log(`Module error: ${error.message}`);
    }

  }, milliseconds);

  s.intervals.add(id);
}

function timeout(s, milliseconds, fn) {
  const id = setTimeout(() => {
    s.timeouts.delete(id);

    if (!active(s)) return;

    try {
      Promise.resolve(fn()).catch(error => {
        log(`Timer error: ${error.message}`);
      });

    } catch (error) {
      log(`Timer error: ${error.message}`);
    }

  }, milliseconds);

  s.timeouts.add(id);
}

function cleanup(s) {
  if (s.closed) return;

  s.closed = true;

  if (s.connectionTimer) {
    clearTimeout(s.connectionTimer);
  }

  for (const id of s.intervals) {
    clearInterval(id);
  }

  for (const id of s.timeouts) {
    clearTimeout(id);
  }

  s.intervals.clear();
  s.timeouts.clear();

  try {
    s.bot.pathfinder.setGoal(null);
  } catch (_) {}

  try {
    s.bot.clearControlStates();
  } catch (_) {}
}

// ============================================================
// FIXED AUTOMATIC RECONNECT
// ============================================================

function reconnect() {
  if (
    shuttingDown ||
    utils['auto-reconnect'] === false ||
    reconnectTimer ||
    session
  ) return;

  attempts++;

  // FIX: minimum one-minute reconnection interval.
  const base = Math.max(
    60000,
    Number(utils['auto-reconnect-delay']) || 60000
  );

  const maximum = Math.max(
    base,
    Number(utils['max-reconnect-delay']) || 300000
  );

  const exponential = Math.min(
    maximum,
    base * Math.pow(
      2,
      Math.min(attempts - 1, 6)
    )
  );

  // Extra cooldown when the server throttles connections.
  const throttled =
    history.kick &&
    /throttl|too many connections|connect too fast/i.test(
      history.kick
    );

  const delay = throttled
    ? Math.max(300000, exponential)
    : exponential;

  log(
    `Reconnect scheduled in ${Math.ceil(delay / 1000)}s ` +
    `(attempt ${attempts})`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function disconnect(s, reason, shouldRetry = true) {
  if (s.closed) return;

  const wasOnline = s.spawned;

  log(`Disconnected: ${reason}`);

  cleanup(s);

  if (session === s) {
    session = null;

    if (wasOnline) {
      notify(
        `Aevoris vanished: ${reason}`,
        'disconnect',
        0xe48c9b
      );
    }

    if (shouldRetry) {
      reconnect();
    }
  }
}

// ============================================================
// SAFE TERRAIN DETECTION
// ============================================================

const hazards =
  /lava|fire|magma|cactus|campfire|sweet_berry|cobweb/;

function safeGround(bot, x, z, approximateY) {
  x = Math.floor(x);
  z = Math.floor(z);

  for (const offset of [
    0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5
  ]) {
    const y = Math.floor(approximateY) + offset;

    const feet = bot.blockAt(
      new Vec3(x, y, z)
    );

    const head = bot.blockAt(
      new Vec3(x, y + 1, z)
    );

    const floor = bot.blockAt(
      new Vec3(x, y - 1, z)
    );

    if (!feet || !head || !floor) continue;

    if (
      feet.boundingBox !== 'empty' ||
      head.boundingBox !== 'empty'
    ) continue;

    if (floor.boundingBox !== 'block') continue;

    if (
      hazards.test(feet.name) ||
      hazards.test(head.name) ||
      hazards.test(floor.name)
    ) continue;

    if (
      /water/.test(feet.name) ||
      /water/.test(head.name)
    ) continue;

    return { x, y, z };
  }

  return null;
}

// ============================================================
// HOSTILE MOB DETECTION
// ============================================================

function findThreat(s) {
  if (!modules.avoidMobs) return null;

  const hostile = new Set([
    'zombie',
    'skeleton',
    'creeper',
    'spider',
    'drowned',
    'husk',
    'stray',
    'witch',
    'phantom',
    'pillager',
    'slime',
    'magma_cube'
  ]);

  const position = s.bot.entity.position;

  return Object.values(s.bot.entities)
    .filter(entity =>
      entity &&
      entity.position &&
      hostile.has(entity.name) &&
      position.distanceTo(entity.position) < 9
    )
    .sort((a, b) =>
      position.distanceTo(a.position) -
      position.distanceTo(b.position)
    )[0] || null;
}

// ============================================================
// LONG-DISTANCE EXPEDITION PLANNER
// ============================================================

function newHeading(s, major = false) {
  const direction =
    Math.random() < 0.5 ? -1 : 1;

  s.heading += direction * (
    major
      ? 2 + Math.random() * 2
      : 0.2 + Math.random() * 0.6
  );

  s.progress = 0;
  s.failures = 0;

  s.mode = 'choosing a new direction';

  log('New exploration direction selected');
}

function chooseWaypoint(s, threat = null) {
  const position = s.bot.entity.position;

  for (let attempt = 0; attempt < 48; attempt++) {
    let angle =
      s.heading +
      (Math.random() - 0.5) *
      (attempt < 24 ? 1 : 2.8);

    if (threat) {
      angle =
        Math.atan2(
          position.z - threat.position.z,
          position.x - threat.position.x
        ) +
        (Math.random() - 0.5) * 0.8;
    }

    const distance = Math.max(
      6,
      WAYPOINT - Math.floor(attempt / 12) * 4
    );

    const target = safeGround(
      s.bot,
      position.x + Math.cos(angle) * distance,
      position.z + Math.sin(angle) * distance,
      position.y
    );

    if (!target) continue;

    const key =
      `${target.x},${target.y},${target.z}`;

    if (s.blocked.get(key) > Date.now()) {
      continue;
    }

    if (
      threat &&
      Math.hypot(
        target.x - threat.position.x,
        target.z - threat.position.z
      ) < 9
    ) continue;

    if (
      s.visited.some(point =>
        Math.hypot(
          target.x - point.x,
          target.z - point.z
        ) < 5
      )
    ) continue;

    return target;
  }

  return null;
}

// ============================================================
// PATHFINDER GOALS
// ============================================================

function setGoal(s, target, mode = 'exploring') {
  if (!active(s) || !target) return false;

  try {
    s.bot.setControlState('sneak', false);

    s.bot.pathfinder.setGoal(
      new GoalNear(
        target.x,
        target.y,
        target.z,
        2
      )
    );

    s.goal = target;
    s.goalOrigin =
      s.bot.entity.position.clone();

    s.goalStart = Date.now();
    s.lastProgress = Date.now();

    s.progressPosition =
      s.bot.entity.position.clone();

    s.mode = mode;

    return true;

  } catch (error) {
    log(`Navigation error: ${error.message}`);
    return false;
  }
}

function abandon(s, reason) {
  if (!active(s) || !s.goal) return;

  const target = s.goal;

  s.blocked.set(
    `${target.x},${target.y},${target.z}`,
    Date.now() + 120000
  );

  s.goal = null;
  s.failures++;

  try {
    s.bot.pathfinder.setGoal(null);
  } catch (_) {}

  try {
    s.bot.clearControlStates();
  } catch (_) {}

  if (s.failures >= 3) {
    newHeading(s, true);
  }

  s.mode = 'finding another route';

  s.pauseUntil =
    Date.now() + rand(1000, 2400);

  log(`Rerouting: ${reason}`);
}

// ============================================================
// SILENT OBSERVATION OF PLAYERS
// ============================================================

function observePlayer(s) {
  const position = s.bot.entity.position;

  const players = Object.values(s.bot.players)
    .map(player => player.entity)
    .filter(entity =>
      entity &&
      entity.position &&
      entity.id !== s.bot.entity.id &&
      position.distanceTo(entity.position) < 13
    );

  if (
    players.length === 0 ||
    Math.random() > 0.22
  ) return false;

  const target =
    players[rand(0, players.length - 1)];

  s.mode = 'watching silently';

  s.pauseUntil =
    Date.now() + rand(3000, 8000);

  try {
    Promise.resolve(
      s.bot.lookAt(
        target.position.offset(0, 1.5, 0),
        true
      )
    ).catch(() => {});

  } catch (_) {}

  return true;
}

// ============================================================
// INTELLIGENT EXPLORATION SYSTEM
// ============================================================

function startExplorer(s) {
  const bot = s.bot;

  const mcData =
    require('minecraft-data')(config.server.version);

  const moves = new Movements(bot, mcData);

  // Allow normal one-block jumping.
  // Disable risky parkour jumps over gaps.
  moves.canDig = false;
  moves.allow1by1towers = false;
  moves.allowParkour = false;
  moves.maxDropDown = 1;
  moves.liquidCost = 50;
  moves.canOpenDoors = false;
  moves.allowSprinting = true;

  bot.pathfinder.setMovements(moves);

  bot.pathfinder.thinkTimeout = 4500;
  bot.pathfinder.tickTimeout = 30;

  // ----------------------------------------------------------
  // DESTINATION REACHED
  // ----------------------------------------------------------

  bot.on('goal_reached', () => {
    if (!active(s) || !s.goal) return;

    const target = s.goal;

    const travelled = Math.hypot(
      target.x - s.goalOrigin.x,
      target.z - s.goalOrigin.z
    );

    s.progress += travelled;

    s.visited.push(target);

    if (s.visited.length > 8) {
      s.visited.shift();
    }

    s.goal = null;
    s.failures = 0;
    s.mode = 'observing';

    s.pauseUntil =
      Date.now() + rand(400, 3000);

    if (s.progress >= EXPEDITION) {
      newHeading(s, true);

    } else if (Math.random() < 0.15) {
      s.heading +=
        (Math.random() - 0.5) * 0.7;
    }
  });

  // ----------------------------------------------------------
  // PATHFINDER FAILURE
  // ----------------------------------------------------------

  bot.on('path_update', result => {
    if (!active(s) || !s.goal) return;

    if (
      result.status === 'noPath' ||
      result.status === 'timeout'
    ) {
      abandon(s, result.status);
    }
  });

  bot.on('path_reset', reason => {
    if (
      active(s) &&
      s.goal &&
      reason === 'stuck'
    ) {
      abandon(s, 'pathfinder stuck');
    }
  });

  // ----------------------------------------------------------
  // MAIN EXPLORATION BRAIN
  // ----------------------------------------------------------

  interval(s, 1400, () => {
    if (
      s.busy ||
      bot.isSleeping
    ) return;

    const threat = findThreat(s);

    if (threat && s.mode !== 'fleeing') {
      const escape = chooseWaypoint(s, threat);

      if (escape) {
        setGoal(s, escape, 'fleeing');
      }
    }

    if (s.goal) return;

    if (Date.now() < s.pauseUntil) {
      bot.setControlState(
        'sneak',
        !!utils['anti-afk']?.sneak
      );

      return;
    }

    bot.setControlState('sneak', false);

    if (observePlayer(s)) return;

    const target = chooseWaypoint(s, threat);

    if (target) {
      setGoal(
        s,
        target,
        threat ? 'fleeing' : 'exploring far away'
      );

    } else {
      newHeading(s, true);

      s.pauseUntil =
        Date.now() + 2000;
    }
  });

  // ----------------------------------------------------------
  // TRACK WALKING DISTANCE
  // ----------------------------------------------------------

  interval(s, 1000, () => {
    const position = bot.entity.position;

    if (s.previousPosition) {
      const delta =
        position.distanceTo(s.previousPosition);

      if (delta < 9) {
        s.distance += delta;
      }
    }

    s.previousPosition = position.clone();
  });

  // ----------------------------------------------------------
  // STUCK DETECTION AND RECOVERY
  // ----------------------------------------------------------

  interval(s, 2400, () => {
    if (
      !s.goal ||
      s.busy ||
      bot.isSleeping
    ) return;

    const position = bot.entity.position;

    if (
      position.distanceTo(s.progressPosition) >= 1.1
    ) {
      s.progressPosition = position.clone();
      s.lastProgress = Date.now();
    }

    const stuckFor =
      Date.now() - s.lastProgress;

    if (
      stuckFor > 8500 ||
      Date.now() - s.goalStart > 65000
    ) {
      abandon(s, 'movement timeout');
    }

    for (const [key, expiry] of s.blocked) {
      if (expiry < Date.now()) {
        s.blocked.delete(key);
      }
    }
  });

  // ----------------------------------------------------------
  // NATURAL JUMPING
  // ----------------------------------------------------------

  if (movement['random-jump']?.enabled) {
    const jumpInterval = Math.max(
      9000,
      Number(
        movement['random-jump'].interval
      ) || 10000
    );

    interval(s, jumpInterval, () => {
      if (
        s.goal ||
        s.busy ||
        bot.isSleeping ||
        !bot.entity.onGround ||
        Math.random() > 0.35
      ) return;

      bot.setControlState('jump', true);
      s.jumps++;

      timeout(s, 250, () => {
        bot.setControlState('jump', false);
      });
    });
  }

  // ----------------------------------------------------------
  // LOOK AROUND
  // ----------------------------------------------------------

  if (movement['look-around']?.enabled) {
    const lookInterval = Math.max(
      3000,
      Number(
        movement['look-around'].interval
      ) || 5000
    );

    interval(s, lookInterval, () => {
      if (
        s.goal ||
        s.busy ||
        s.mode === 'watching silently'
      ) return;

      try {
        Promise.resolve(
          bot.look(
            Math.random() * Math.PI * 2,
            (Math.random() - 0.5) * 0.35,
            true
          )
        ).catch(() => {});

      } catch (_) {}
    });
  }
}

// ============================================================
// SURVIVAL FEATURES
// ============================================================

function startSurvival(s) {
  const bot = s.bot;

  const mcData =
    require('minecraft-data')(config.server.version);

  // ----------------------------------------------------------
  // AUTO EAT
  // ----------------------------------------------------------

  if (
    modules.combat &&
    combat['auto-eat']
  ) {
    interval(s, 6000, async () => {
      if (
        s.busy ||
        bot.isSleeping ||
        bot.food === undefined ||
        bot.food >= 14
      ) return;

      const food =
        bot.inventory.items().find(item => {
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
        bot.pathfinder.setGoal(null);
        s.goal = null;

        await bot.equip(food, 'hand');

        if (active(s)) {
          await bot.consume();
        }

      } catch (error) {
        log(`Auto-eat: ${error.message}`);

      } finally {
        s.busy = false;
      }
    });
  }

  // ----------------------------------------------------------
  // OPTIONAL COMBAT
  // ----------------------------------------------------------

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

    interval(s, 2200, () => {
      if (
        s.busy ||
        Date.now() - lastAttack < 2000
      ) return;

      const target =
        Object.values(bot.entities).find(entity =>
          entity &&
          entity.type === 'mob' &&
          allowed.has(entity.name) &&
          entity.position &&
          entity.id !== bot.entity.id &&
          bot.entities[entity.id] === entity &&
          bot.entity.position.distanceTo(
            entity.position
          ) < 2.8
        );

      if (!target) return;

      try {
        bot.attack(target);
        lastAttack = Date.now();

      } catch (error) {
        log(`Combat: ${error.message}`);
      }
    });
  }

  // ----------------------------------------------------------
  // BED SYSTEM
  // ----------------------------------------------------------

  if (
    modules.beds &&
    (
      beds['place-night'] ||
      beds['pick-up-day']
    )
  ) {
    let lastSleepAttempt = 0;

    interval(s, 13000, async () => {
      if (
        s.busy ||
        !bot.time ||
        !bot.entity
      ) return;

      const time = bot.time.timeOfDay;

      const night =
        time >= 12500 &&
        time <= 23500;

      // Pick up beds placed by the bot.
      if (
        !night &&
        beds['pick-up-day'] &&
        s.placedBed
      ) {
        const block =
          bot.blockAt(s.placedBed);

        if (
          !block ||
          !block.name.endsWith('_bed')
        ) {
          s.placedBed = null;
          return;
        }

        if (
          bot.entity.position.distanceTo(
            s.placedBed
          ) > 4
        ) return;

        s.busy = true;

        try {
          bot.pathfinder.setGoal(null);
          s.goal = null;

          await bot.dig(block);

          s.placedBed = null;

        } catch (error) {
          log(`Bed pickup: ${error.message}`);

        } finally {
          s.busy = false;
        }

        return;
      }

      // Sleep at night.
      if (
        !night ||
        !beds['place-night'] ||
        bot.isSleeping ||
        Date.now() - lastSleepAttempt < 60000
      ) return;

      lastSleepAttempt = Date.now();
      s.busy = true;

      try {
        bot.pathfinder.setGoal(null);
        s.goal = null;

        let bed = bot.findBlock({
          matching: block =>
            block.name.endsWith('_bed'),
          maxDistance: 4
        });

        // Place a bed if one is in inventory.
        if (!bed) {
          const bedItem =
            bot.inventory.items().find(item =>
              item.name.endsWith('_bed')
            );

          if (bedItem) {
            for (const [dx, dz] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1]
            ]) {
              const spot = safeGround(
                bot,
                bot.entity.position.x + dx,
                bot.entity.position.z + dz,
                bot.entity.position.y
              );

              if (!spot) continue;

              const ground = bot.blockAt(
                new Vec3(
                  spot.x,
                  spot.y - 1,
                  spot.z
                )
              );

              if (!ground) continue;

              if (
                bot.entity.position.distanceTo(
                  new Vec3(
                    spot.x,
                    spot.y,
                    spot.z
                  )
                ) > 4
              ) continue;

              try {
                await bot.equip(
                  bedItem,
                  'hand'
                );

                await bot.placeBlock(
                  ground,
                  new Vec3(0, 1, 0)
                );

                const placed = bot.blockAt(
                  new Vec3(
                    spot.x,
                    spot.y,
                    spot.z
                  )
                );

                if (
                  placed &&
                  placed.name.endsWith('_bed')
                ) {
                  bed = placed;

                  s.placedBed =
                    placed.position.clone();

                  break;
                }

              } catch (_) {}
            }
          }
        }

        if (active(s) && bed) {
          try {
            await bot.sleep(bed);
            s.mode = 'sleeping';

          } catch (_) {}
        }

      } catch (error) {
        log(`Bed: ${error.message}`);

      } finally {
        s.busy = false;
      }
    });

    bot.on('wake', () => {
      if (active(s)) {
        s.mode = 'observing';

        s.pauseUntil =
          Date.now() + 2000;
      }
    });
  }

  // Silent chat logging.
  if (
    modules.chat &&
    utils['chat-log']
  ) {
    bot.on('messagestr', message => {
      if (current(s)) {
        log(`[Server chat] ${message}`);
      }
    });
  }
}

// ============================================================
// CONNECT TO MINECRAFT SERVER
// ============================================================

function connect() {
  if (shuttingDown || session) return;

  log(
    `Connecting to ${config.server.ip}:` +
    `${config.server.port}`
  );

  let bot;

  try {
    bot = mineflayer.createBot({
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

  } catch (error) {
    history.error = error.message;

    log(`Creation error: ${error.message}`);

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

    heading:
      Math.random() * Math.PI * 2,

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

  } catch (error) {
    history.error = error.message;

    disconnect(s, error.message);

    try {
      bot.end();
    } catch (_) {}

    return;
  }

  // ----------------------------------------------------------
  // FIXED AUTO AUTHENTICATION
  // ----------------------------------------------------------

  let authSent = false;

  bot.on('messagestr', message => {
    if (
      !AUTO_AUTH ||
      !PASSWORD ||
      authSent ||
      session !== s ||
      s.closed
    ) return;

    const text =
      String(message).toLowerCase();

    let authCommand = null;

    if (text.includes('/register')) {
      authCommand =
        `/register ${PASSWORD} ${PASSWORD}`;

    } else if (text.includes('/login')) {
      authCommand = `/login ${PASSWORD}`;
    }

    if (!authCommand) return;

    authSent = true;

    try {
      bot.chat(authCommand);

      log('Authentication command sent');

    } catch (error) {
      authSent = false;

      log(
        `Authentication error: ${error.message}`
      );
    }
  });

  // ----------------------------------------------------------
  // SPAWN
  // ----------------------------------------------------------

  bot.once('spawn', () => {
    if (session !== s || s.closed) return;

    clearTimeout(s.connectionTimer);

    s.spawned = true;
    s.mode = 'observing';

    s.pauseUntil =
      Date.now() + rand(1500, 3500);

    // Clear an old throttle message after a
    // successful connection.
    history.kick = null;

    log(
      'Aevoris spawned successfully! ' +
      'Silent exploration enabled.'
    );

    notify(
      'Aevoris appeared in the world.',
      'connect'
    );

    timeout(s, 120000, () => {
      attempts = 0;
    });

    try {
      if (movement.enabled !== false) {
        startExplorer(s);
      }

      startSurvival(s);

    } catch (error) {
      history.error = error.message;

      log(
        `Initialization error: ${error.message}`
      );
    }

    // Optional periodic rejoin.
    if (utils['periodic-rejoin']?.enabled) {
      const settings =
        utils['periodic-rejoin'];

      const minimum = Math.max(
        10,
        Number(settings['min-interval']) || 20
      );

      const maximum = Math.max(
        minimum,
        Number(settings['max-interval']) || 60
      );

      timeout(
        s,
        rand(minimum, maximum) * 60000,
        () => {
          log('Scheduled rejoin');

          disconnect(
            s,
            'scheduled rejoin'
          );

          try {
            bot.end();
          } catch (_) {}
        }
      );
    }
  });

  // ----------------------------------------------------------
  // KICK HANDLER
  // ----------------------------------------------------------

  bot.on('kicked', reason => {
    if (session !== s || s.closed) return;

    history.kick =
      typeof reason === 'string'
        ? reason
        : JSON.stringify(reason);

    log(`Kicked: ${history.kick}`);

    if (
      /throttl|too many connections|connect too fast/i.test(
        history.kick
      )
    ) {
      log(
        'Server connection limit detected. ' +
        'Next reconnect will use a longer cooldown.'
      );
    }
  });

  // ----------------------------------------------------------
  // NETWORK ERROR HANDLER
  // ----------------------------------------------------------

  bot.on('error', error => {
    if (session !== s || s.closed) return;

    history.error = error.message;

    log(
      `Network: ${error.code || error.message}`
    );
  });

  // ----------------------------------------------------------
  // DISCONNECT HANDLER
  // ----------------------------------------------------------

  bot.once('end', reason => {
    disconnect(
      s,
      reason || 'socket closed'
    );
  });

  // ----------------------------------------------------------
  // CONNECTION TIMEOUT
  // ----------------------------------------------------------

  s.connectionTimer = setTimeout(() => {
    if (s.closed || s.spawned) return;

    disconnect(
      s,
      'connection timeout'
    );

    try {
      bot.end();
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
  const text = line.trim();
  const s = session;

  if (text === 'status') {
    log(
      s && active(s)
        ? `${s.mode} | ${s.bot.entity.position} | ` +
          `${Math.round(s.distance)} blocks`
        : 'Offline'
    );

    return;
  }

  if (text === 'reconnect') {
    if (s) {
      disconnect(
        s,
        'manual reconnect'
      );

      try {
        s.bot.end();
      } catch (_) {}

    } else {
      reconnect();
    }

    return;
  }

  if (!s || !active(s)) return;

  if (
    text === 'explore' ||
    text === 'wander'
  ) {
    newHeading(s, true);

    if (s.goal) {
      abandon(
        s,
        'manual new expedition'
      );
    }

    s.pauseUntil = 0;
    return;
  }

  if (
    text === 'jump' &&
    !s.goal &&
    s.bot.entity.onGround
  ) {
    s.bot.setControlState(
      'jump',
      true
    );

    s.jumps++;

    timeout(s, 250, () => {
      s.bot.setControlState(
        'jump',
        false
      );
    });

    return;
  }

  if (text.startsWith('say ')) {
    try {
      s.bot.chat(text.slice(4));
    } catch (_) {}
  }

  if (text.startsWith('cmd ')) {
    try {
      s.bot.chat('/' + text.slice(4));
    } catch (_) {}
  }
});

// ============================================================
// SHUTDOWN
// ============================================================

function shutdown() {
  if (shuttingDown) return;

  shuttingDown = true;

  clearTimeout(reconnectTimer);

  if (session) {
    const s = session;

    disconnect(
      s,
      'shutdown',
      false
    );

    try {
      s.bot.end();
    } catch (_) {}
  }

  webServer.close();

  setTimeout(() => {
    process.exit(0);
  }, 1000).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

process.on('unhandledRejection', error => {
  history.error = String(error);

  log(
    `Unhandled rejection: ${history.error}`
  );
});

// ============================================================
// START
// ============================================================

log('==========================================');
log('AEVORIS v3.1 — THE SILENT EXPLORER');
log('==========================================');

log(`Expedition distance: ${EXPEDITION} blocks`);
log(`Waypoint distance: ${WAYPOINT} blocks`);

log(
  `Jumping: ${
    movement['random-jump']?.enabled ? 'ON' : 'OFF'
  }`
);

log(`Combat: ${ATTACK ? 'ON' : 'OFF'}`);
log(`Auto-authentication: ${AUTO_AUTH ? 'ON' : 'OFF'}`);
log('Automatic chat: OFF');
log('Reconnect cooldown: minimum 60 seconds');

log('==========================================');

connect();
