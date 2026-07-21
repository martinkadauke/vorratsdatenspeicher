/* ============================================================================
 * SNIPY — endless barrel-multiplier horde shooter
 * Zero dependencies. Vanilla canvas. Just open index.html.
 * ==========================================================================*/
(() => {
'use strict';

// ---------------------------------------------------------------------------
// Canvas + responsive sizing
// ---------------------------------------------------------------------------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.floor(W * DPR);
  canvas.height = Math.floor(H * DPR);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const pick = arr => arr[randInt(0, arr.length - 1)];
const now = () => performance.now();
const fmt = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);

// ---------------------------------------------------------------------------
// Tiny procedural sound (WebAudio) — no asset files
// ---------------------------------------------------------------------------
const Sound = (() => {
  let actx = null, muted = false, lastShot = 0;
  function ensure() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; } }
    if (actx && actx.state === 'suspended') actx.resume();
  }
  function blip(freq, dur, type = 'square', vol = 0.15) {
    if (muted || !actx) return;
    const t = actx.currentTime;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(actx.destination);
    o.start(t); o.stop(t + dur);
  }
  return {
    init: ensure,
    toggle() { muted = !muted; return muted; },
    isMuted: () => muted,
    shot() { const t = now(); if (t - lastShot < 45) return; lastShot = t; blip(rand(680, 760), 0.05, 'square', 0.05); },
    hit() { blip(rand(180, 240), 0.04, 'sawtooth', 0.04); },
    kill() { blip(rand(90, 130), 0.12, 'triangle', 0.08); },
    barrel() { blip(880, 0.08, 'square', 0.12); setTimeout(() => blip(1320, 0.12, 'square', 0.12), 60); },
    crate() { blip(520, 0.1, 'sine', 0.14); setTimeout(() => blip(780, 0.14, 'sine', 0.14), 70); },
    hurt() { blip(140, 0.25, 'sawtooth', 0.18); },
    over() { blip(300, 0.2, 'sawtooth', 0.15); setTimeout(() => blip(160, 0.5, 'sawtooth', 0.15), 150); },
  };
})();

// ---------------------------------------------------------------------------
// Weapons — pattern definitions. `power` (bullet multiplier) scales on top.
// ---------------------------------------------------------------------------
const MAX_STREAMS = 22;               // visual cap on simultaneous bullets
const WEAPONS = {
  pistol:  { name: 'Pistol',   interval: 150, spread: 0.10, speed: 820, dmg: 1,   color: '#eaf2ff', size: 4 },
  smg:     { name: 'SMG',      interval: 90,  spread: 0.14, speed: 900, dmg: 1,   color: '#8be9fd', size: 3.5 },
  shotgun: { name: 'Shotgun',  interval: 420, spread: 0.42, speed: 820, dmg: 1.4, color: '#ffb86c', size: 4.5, pellets: 3 },
  minigun: { name: 'Minigun',  interval: 55,  spread: 0.18, speed: 980, dmg: 0.9, color: '#ffd23f', size: 3 },
  rocket:  { name: 'Rockets',  interval: 620, spread: 0.05, speed: 640, dmg: 3,   color: '#ff6b6b', size: 7, splash: 70 },
};
const WEAPON_CYCLE = ['smg', 'shotgun', 'minigun', 'rocket'];

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const State = { MENU: 0, PLAY: 1, OVER: 2 };
let state = State.MENU;

const game = {
  t: 0, elapsed: 0, spawnTimer: 0, barrelTimer: 0, crateTimer: 0, fireTimer: 0,
  score: 0, kills: 0, wave: 1, shake: 0, weaponUntil: 0,
};

const player = {
  x: 0, y: 0, r: 18, power: 1, hp: 3, maxHp: 3, weapon: 'pistol', invUntil: 0, aimX: 0,
};

let bullets = [], enemies = [], barrels = [], crates = [], particles = [], floaters = [];

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------
function spawnEnemy() {
  const diff = game.elapsed / 1000;
  const roll = Math.random();
  let type;
  if (roll < 0.12 && diff > 15) type = 'tank';
  else if (roll < 0.32) type = 'fast';
  else type = 'grunt';

  const base = {
    grunt: { r: 15, hp: 2, speed: 44, color: '#c3d0e8', worth: 10 },
    fast:  { r: 12, hp: 1, speed: 88, color: '#ff9db4', worth: 14 },
    tank:  { r: 26, hp: 12, speed: 30, color: '#7d8bb0', worth: 40 },
  }[type];

  const hpScale = 1 + diff * 0.06;
  enemies.push({
    type, x: rand(30, W - 30), y: -30,
    r: base.r, hp: base.hp * hpScale, maxHp: base.hp * hpScale,
    speed: base.speed * (1 + diff * 0.012), color: base.color, worth: base.worth,
    wobble: rand(0, Math.PI * 2), flash: 0,
  });
}

function spawnBarrel() {
  // Two flavours: multiply (×) or add (+). Multiply is rarer/juicier.
  const isMul = Math.random() < 0.55;
  const val = isMul ? pick([2, 2, 2, 3, 3, 5, 10]) : pick([5, 10, 15, 25]);
  // Barrels stay poppable at any firepower: HP scales gently with your streams,
  // so a fresh pistol pops a small barrel in ~1.5s and never gets locked out.
  const streams = clamp(player.power, 1, MAX_STREAMS);
  const hp = Math.round((isMul ? 8 + val : 10 + val) * (0.6 + 0.55 * Math.sqrt(streams)));
  barrels.push({
    x: rand(60, W - 60), y: -40, r: 30,
    op: isMul ? 'mul' : 'add', val, hp, maxHp: hp,
    speed: rand(46, 58), flash: 0,
  });
}

function spawnCrate() {
  crates.push({
    x: rand(60, W - 60), y: -40, r: 26,
    hp: 22, maxHp: 22, speed: 50,
    weapon: pick(WEAPON_CYCLE), flash: 0, spin: 0,
  });
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------
function fire() {
  const w = WEAPONS[player.weapon];
  const streams = clamp(player.power, 1, MAX_STREAMS);
  // damage-per-bullet absorbs power beyond the visual cap
  const dmgMul = Math.max(1, player.power / MAX_STREAMS);
  const pellets = w.pellets || 1;

  for (let p = 0; p < pellets; p++) {
    for (let i = 0; i < streams; i++) {
      const centre = (streams - 1) / 2;
      const off = streams === 1 ? 0 : (i - centre) / centre; // -1..1
      const ang = -Math.PI / 2 + off * w.spread + rand(-0.02, 0.02) + (pellets > 1 ? rand(-w.spread, w.spread) : 0);
      const spd = w.speed * rand(0.96, 1.04);
      bullets.push({
        x: player.x + off * player.r * 0.8, y: player.y - player.r,
        vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
        dmg: w.dmg * dmgMul, size: w.size, color: w.color,
        splash: w.splash || 0, life: 1.6,
      });
    }
  }
  Sound.shot();
  game.shake = Math.min(game.shake + (player.weapon === 'rocket' ? 3 : 0.6), 8);
}

// ---------------------------------------------------------------------------
// Damage application
// ---------------------------------------------------------------------------
function damageEnemy(e, dmg, hx, hy) {
  e.hp -= dmg; e.flash = 1;
  spawnParticles(hx, hy, e.color, 3, 2);
  Sound.hit();
  if (e.hp <= 0) killEnemy(e);
}
function killEnemy(e) {
  e.dead = true;
  game.score += e.worth;
  game.kills++;
  spawnParticles(e.x, e.y, e.color, e.type === 'tank' ? 22 : 12, 4);
  Sound.kill();
}

function explode(x, y, radius, dmg) {
  spawnParticles(x, y, '#ffce6b', 20, 6);
  game.shake = Math.min(game.shake + 5, 12);
  for (const e of enemies) {
    if (e.dead) continue;
    const d = Math.hypot(e.x - x, e.y - y);
    if (d < radius) damageEnemy(e, dmg * (1 - d / radius) + 1, e.x, e.y);
  }
  for (const b of barrels) { if (Math.hypot(b.x - x, b.y - y) < radius) b.hp -= dmg; }
  for (const c of crates) { if (Math.hypot(c.x - x, c.y - y) < radius) c.hp -= dmg; }
}

// ---------------------------------------------------------------------------
// Particles + floating text
// ---------------------------------------------------------------------------
function spawnParticles(x, y, color, count, spd) {
  for (let i = 0; i < count; i++) {
    const a = rand(0, Math.PI * 2), s = rand(0.3, 1) * spd * 40;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.3, 0.7), max: 0.7, color, size: rand(1.5, 4) });
  }
}
function floater(x, y, text, color, big) {
  floaters.push({ x, y, text, color, life: 1, vy: -46, size: big ? 34 : 18 });
}

// ---------------------------------------------------------------------------
// Barrel / crate resolution
// ---------------------------------------------------------------------------
function popBarrel(b) {
  b.dead = true;
  if (b.op === 'mul') player.power = Math.min(player.power * b.val, 9999);
  else player.power = Math.min(player.power + b.val, 9999);
  floater(b.x, b.y - 20, (b.op === 'mul' ? '×' : '+') + b.val, '#ffd23f', true);
  spawnParticles(b.x, b.y, '#ffd23f', 26, 6);
  game.shake = Math.min(game.shake + 4, 10);
  Sound.barrel();
  bumpPower();
}
function popCrate(c) {
  c.dead = true;
  player.weapon = c.weapon;
  game.weaponUntil = game.t + 14000;
  floater(c.x, c.y - 20, WEAPONS[c.weapon].name.toUpperCase() + '!', '#ff8c42', true);
  spawnParticles(c.x, c.y, '#ff8c42', 24, 6);
  game.shake = Math.min(game.shake + 4, 10);
  Sound.crate();
  updateHud();
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------
function update(dt) {
  game.t += dt * 1000;
  game.elapsed += dt * 1000;
  game.wave = 1 + Math.floor(game.elapsed / 20000);

  // player follows aim target
  player.x += (player.aimX - player.x) * Math.min(1, dt * 14);
  player.x = clamp(player.x, player.r + 6, W - player.r - 6);

  // weapon timeout -> back to pistol
  if (player.weapon !== 'pistol' && game.t > game.weaponUntil) { player.weapon = 'pistol'; updateHud(); }

  // auto fire
  game.fireTimer -= dt * 1000;
  const interval = WEAPONS[player.weapon].interval;
  if (game.fireTimer <= 0) { fire(); game.fireTimer += interval; if (game.fireTimer < 0) game.fireTimer = 0; }

  // spawn cadence ramps with elapsed time
  const diff = game.elapsed / 1000;
  const spawnEvery = clamp(1050 - diff * 13, 240, 1050);
  game.spawnTimer -= dt * 1000;
  if (game.spawnTimer <= 0) { spawnEnemy(); game.spawnTimer += spawnEvery; if (diff > 40 && Math.random() < 0.4) spawnEnemy(); }

  game.barrelTimer -= dt * 1000;
  if (game.barrelTimer <= 0) { spawnBarrel(); game.barrelTimer += rand(4200, 6500); }

  game.crateTimer -= dt * 1000;
  if (game.crateTimer <= 0) { spawnCrate(); game.crateTimer += rand(9000, 13000); }

  // bullets
  for (const b of bullets) {
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if (b.y < -20 || b.x < -20 || b.x > W + 20 || b.life <= 0) { b.dead = true; continue; }
    // collide enemies
    for (const e of enemies) {
      if (e.dead) continue;
      if (Math.hypot(b.x - e.x, b.y - e.y) < e.r + b.size) {
        if (b.splash) explode(b.x, b.y, b.splash, b.dmg); else damageEnemy(e, b.dmg, b.x, b.y);
        b.dead = true; break;
      }
    }
    if (b.dead) continue;
    // collide barrels
    for (const bar of barrels) {
      if (bar.dead) continue;
      if (Math.hypot(b.x - bar.x, b.y - bar.y) < bar.r + b.size) {
        bar.hp -= b.dmg; bar.flash = 1;
        if (b.splash) explode(b.x, b.y, b.splash, b.dmg);
        spawnParticles(b.x, b.y, '#ffd23f', 2, 2);
        b.dead = true;
        if (bar.hp <= 0) popBarrel(bar);
        break;
      }
    }
    if (b.dead) continue;
    // collide crates
    for (const c of crates) {
      if (c.dead) continue;
      if (Math.hypot(b.x - c.x, b.y - c.y) < c.r + b.size) {
        c.hp -= b.dmg; c.flash = 1;
        spawnParticles(b.x, b.y, '#ff8c42', 2, 2);
        b.dead = true;
        if (c.hp <= 0) popCrate(c);
        break;
      }
    }
  }

  // enemies
  const lineY = player.y - player.r - 6;
  for (const e of enemies) {
    if (e.dead) continue;
    e.y += e.speed * dt;
    e.wobble += dt * 6;
    e.x += Math.sin(e.wobble) * 8 * dt * (e.type === 'fast' ? 3 : 1);
    if (e.flash > 0) e.flash -= dt * 6;
    if (e.y >= lineY) { e.dead = true; hurtPlayer(); }
  }

  // barrels & crates descend; if they pass the bottom they're missed
  for (const b of barrels) {
    if (b.dead) continue;
    b.y += b.speed * dt;
    if (b.flash > 0) b.flash -= dt * 6;
    if (b.y > H + 50) b.dead = true;
  }
  for (const c of crates) {
    if (c.dead) continue;
    c.y += c.speed * dt; c.spin += dt * 2;
    if (c.flash > 0) c.flash -= dt * 6;
    if (c.y > H + 50) c.dead = true;
  }

  // particles + floaters
  for (const p of particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy = p.vy * 0.92 + 30 * dt; p.life -= dt; if (p.life <= 0) p.dead = true; }
  for (const f of floaters) { f.y += f.vy * dt; f.vy *= 0.94; f.life -= dt * 0.8; if (f.life <= 0) f.dead = true; }

  // cull
  bullets = bullets.filter(b => !b.dead);
  enemies = enemies.filter(e => !e.dead);
  barrels = barrels.filter(b => !b.dead);
  crates = crates.filter(c => !c.dead);
  particles = particles.filter(p => !p.dead);
  floaters = floaters.filter(f => !f.dead);

  if (game.shake > 0) game.shake = Math.max(0, game.shake - dt * 30);

  updateHud();
}

function hurtPlayer() {
  if (game.t < player.invUntil) return;
  player.hp--;
  player.invUntil = game.t + 900;
  game.shake = Math.min(game.shake + 8, 16);
  spawnParticles(player.x, player.y, '#ff4d6d', 18, 5);
  Sound.hurt();
  if (player.hp <= 0) gameOver();
  renderHearts();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
let roadScroll = 0;
function drawBackground(dt) {
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(0, 0, W, H);

  // road
  const roadW = Math.min(W * 0.92, 620);
  const rx = (W - roadW) / 2;
  ctx.fillStyle = '#141a2e';
  ctx.fillRect(rx, 0, roadW, H);
  // side glow
  ctx.fillStyle = 'rgba(70,224,184,0.06)';
  ctx.fillRect(rx - 4, 0, 4, H);
  ctx.fillRect(rx + roadW, 0, 4, H);

  // scrolling lane dashes
  roadScroll = (roadScroll + dt * 220) % 60;
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 4;
  ctx.setLineDash([26, 34]);
  ctx.lineDashOffset = -roadScroll;
  for (let i = 1; i < 3; i++) {
    const lx = rx + (roadW / 3) * i;
    ctx.beginPath(); ctx.moveTo(lx, 0); ctx.lineTo(lx, H); ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawPlayer() {
  const blink = game.t < player.invUntil && Math.floor(game.t / 90) % 2 === 0;
  ctx.save();
  ctx.translate(player.x, player.y);
  if (blink) ctx.globalAlpha = 0.4;

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(0, player.r + 6, player.r, 6, 0, 0, Math.PI * 2); ctx.fill();

  // body
  ctx.fillStyle = '#46e0b8';
  ctx.beginPath(); ctx.arc(0, 0, player.r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0b1020';
  ctx.beginPath(); ctx.arc(0, -3, player.r * 0.5, 0, Math.PI * 2); ctx.fill();
  // gun
  ctx.fillStyle = '#eaf2ff';
  ctx.fillRect(-3, -player.r - 12, 6, 14);
  ctx.restore();
}

function drawEnemy(e) {
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.ellipse(0, e.r + 3, e.r * 0.9, 4, 0, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = e.flash > 0 ? '#ffffff' : e.color;
  ctx.beginPath(); ctx.arc(0, 0, e.r, 0, Math.PI * 2); ctx.fill();
  // eyes
  ctx.fillStyle = '#0b1020';
  ctx.beginPath(); ctx.arc(-e.r * 0.32, -e.r * 0.15, e.r * 0.16, 0, Math.PI * 2);
  ctx.arc(e.r * 0.32, -e.r * 0.15, e.r * 0.16, 0, Math.PI * 2); ctx.fill();

  // hp bar for tougher foes
  if (e.hp < e.maxHp && e.maxHp > 3) {
    const w = e.r * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(-w / 2, -e.r - 10, w, 4);
    ctx.fillStyle = '#ff4d6d'; ctx.fillRect(-w / 2, -e.r - 10, w * clamp(e.hp / e.maxHp, 0, 1), 4);
  }
  ctx.restore();
}

function drawBarrel(b) {
  ctx.save();
  ctx.translate(b.x, b.y);
  const isMul = b.op === 'mul';
  const col = b.flash > 0 ? '#ffffff' : (isMul ? '#ffd23f' : '#5bd6a0');
  // barrel body
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  roundRect(-b.r, -b.r + 4, b.r * 2, b.r * 2, 8); ctx.fill();
  ctx.fillStyle = col;
  roundRect(-b.r, -b.r, b.r * 2, b.r * 2, 8); ctx.fill();
  // label
  ctx.fillStyle = '#0b1020';
  ctx.font = '900 ' + Math.floor(b.r * 0.9) + 'px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText((isMul ? '×' : '+') + b.val, 0, 1);
  // hp bar
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(-b.r, b.r + 4, b.r * 2, 4);
  ctx.fillStyle = '#fff'; ctx.fillRect(-b.r, b.r + 4, b.r * 2 * clamp(b.hp / b.maxHp, 0, 1), 4);
  ctx.restore();
}

function drawCrate(c) {
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(Math.sin(c.spin) * 0.08);
  ctx.fillStyle = c.flash > 0 ? '#ffffff' : '#ff8c42';
  roundRect(-c.r, -c.r, c.r * 2, c.r * 2, 6); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(-c.r, 0); ctx.lineTo(c.r, 0); ctx.moveTo(0, -c.r); ctx.lineTo(0, c.r); ctx.stroke();
  ctx.fillStyle = '#0b1020';
  ctx.font = '900 ' + Math.floor(c.r * 1.1) + 'px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('?', 0, 1);
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(-c.r, c.r + 4, c.r * 2, 4);
  ctx.fillStyle = '#fff'; ctx.fillRect(-c.r, c.r + 4, c.r * 2 * clamp(c.hp / c.maxHp, 0, 1), 4);
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function render(dt) {
  ctx.save();
  if (game.shake > 0) ctx.translate(rand(-game.shake, game.shake), rand(-game.shake, game.shake));

  drawBackground(dt);

  for (const b of barrels) drawBarrel(b);
  for (const c of crates) drawCrate(c);
  for (const e of enemies) drawEnemy(e);

  // bullets
  for (const b of bullets) {
    ctx.fillStyle = b.color;
    ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.size, 0, Math.PI * 2); ctx.fill();
    // trail
    ctx.globalAlpha = 0.25;
    ctx.beginPath(); ctx.arc(b.x - b.vx * 0.012, b.y - b.vy * 0.012, b.size * 0.7, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  if (state === State.PLAY) drawPlayer();

  // particles
  for (const p of particles) {
    ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;

  // floaters
  for (const f of floaters) {
    ctx.globalAlpha = clamp(f.life, 0, 1);
    ctx.fillStyle = f.color;
    ctx.font = '900 ' + f.size + 'px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let last = now();
function loop() {
  const t = now();
  let dt = (t - last) / 1000;
  last = t;
  dt = Math.min(dt, 0.05); // clamp big frame gaps

  if (state === State.PLAY) update(dt);
  render(dt);
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const hud = document.getElementById('hud');
const scoreEl = document.getElementById('score');
const powerEl = document.getElementById('power');
const powerBox = document.getElementById('power-box');
const weaponNameEl = document.getElementById('weapon-name');
const heartsEl = document.getElementById('hp-hearts');

function updateHud() {
  scoreEl.textContent = fmt(game.score);
  powerEl.textContent = fmt(player.power);
  weaponNameEl.textContent = WEAPONS[player.weapon].name;
}
function renderHearts() {
  let s = '';
  for (let i = 0; i < player.maxHp; i++) s += i < player.hp ? '❤️' : '🖤';
  heartsEl.textContent = s;
}
let lastPower = 1;
function bumpPower() {
  powerBox.classList.remove('bump'); void powerBox.offsetWidth; powerBox.classList.add('bump');
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
let dragging = false;
function pointerMove(clientX) { if (state === State.PLAY) player.aimX = clientX; }

canvas.addEventListener('pointerdown', e => { dragging = true; Sound.init(); pointerMove(e.clientX); });
window.addEventListener('pointermove', e => { if (dragging) pointerMove(e.clientX); });
window.addEventListener('pointerup', () => { dragging = false; });

const keys = {};
window.addEventListener('keydown', e => {
  keys[e.key] = true;
  if (e.key === ' ' && state !== State.PLAY) { e.preventDefault(); startGame(); }
});
window.addEventListener('keyup', e => { keys[e.key] = false; });
// keyboard steering polled in update via aimX nudging
setInterval(() => {
  if (state !== State.PLAY) return;
  const step = 26;
  if (keys['ArrowLeft'] || keys['a'] || keys['A']) player.aimX = clamp(player.aimX - step, 0, W);
  if (keys['ArrowRight'] || keys['d'] || keys['D']) player.aimX = clamp(player.aimX + step, 0, W);
}, 16);

document.getElementById('mute-btn').addEventListener('click', () => {
  const m = Sound.toggle();
  document.getElementById('mute-btn').textContent = m ? '🔇' : '🔊';
});

// ---------------------------------------------------------------------------
// Flow: start / over
// ---------------------------------------------------------------------------
const startScreen = document.getElementById('start-screen');
const overScreen = document.getElementById('over-screen');
const BEST_KEY = 'snipy_best';

function startGame() {
  Sound.init();
  bullets = []; enemies = []; barrels = []; crates = []; particles = []; floaters = [];
  Object.assign(game, { t: 0, elapsed: 0, spawnTimer: 400, barrelTimer: 2500, crateTimer: 6000, fireTimer: 0, score: 0, kills: 0, wave: 1, shake: 0, weaponUntil: 0 });
  player.x = player.aimX = W / 2;
  player.y = H - Math.max(90, H * 0.14);
  player.power = 1; player.hp = player.maxHp = 3; player.weapon = 'pistol'; player.invUntil = 0;
  state = State.PLAY;
  startScreen.classList.add('hidden');
  overScreen.classList.add('hidden');
  hud.classList.remove('hidden');
  renderHearts();
  updateHud();
}

function gameOver() {
  state = State.OVER;
  Sound.over();
  const best = Math.max(Number(localStorage.getItem(BEST_KEY) || 0), game.score);
  localStorage.setItem(BEST_KEY, best);
  document.getElementById('final-score').textContent = fmt(game.score);
  document.getElementById('final-kills').textContent = fmt(game.kills);
  document.getElementById('final-wave').textContent = game.wave;
  document.getElementById('best-score').textContent = fmt(best);
  hud.classList.add('hidden');
  overScreen.classList.remove('hidden');
}

// Lightweight telemetry hook (handy for debugging / automated smoke tests)
window.SNIPY = {
  get stats() { return { state, score: game.score, kills: game.kills, power: player.power, weapon: player.weapon, hp: player.hp, enemies: enemies.length, bullets: bullets.length, barrels: barrels.length }; },
  get targets() {
    return {
      barrels: barrels.map(b => ({ x: b.x, y: b.y })),
      crates: crates.map(c => ({ x: c.x, y: c.y })),
      enemies: enemies.map(e => ({ x: e.x, y: e.y })),
    };
  },
  setAim(x) { player.aimX = x; },
};

document.getElementById('start-btn').addEventListener('click', startGame);
document.getElementById('restart-btn').addEventListener('click', startGame);
document.getElementById('best-score'); // referenced above

// show best on start screen tagline? keep simple.
loop();

})();
