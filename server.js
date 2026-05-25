// ══════════════════════════════════════════════════════════════════
//  🐍 Snake Battle Arena — MODO FESTA — Servidor WebSocket
//  Node.js + ws
//  Instalação: npm install ws
//  Uso:        node server.js
// ══════════════════════════════════════════════════════════════════

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const fs   = require('fs');

const PORT = process.env.PORT || 3000;

// ── HTTP server — serve o HTML ────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'snake-festa.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('File not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

// ── WebSocket server ───────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

// ── Room state ─────────────────────────────────────────────────────
// rooms[code] = {
//   code, host, guest, state:'waiting'|'ability_pick'|'round'|'done',
//   round:0, wins:[0,0], hostAbility:null, guestAbility:null,
//   hostReady:false, guestReady:false,
//   gameState: null   ← autoritative server game state
// }
const rooms = {};

function genCode() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function uniqueCode() {
  let c;
  do { c = genCode(); } while (rooms[c]);
  return c;
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  if (room.host)  send(room.host,  obj);
  if (room.guest) send(room.guest, obj);
}

// ── Game constants (mirror of client) ─────────────────────────────
const COLS = 20, ROWS = 20;
const DIR = { UP:{x:0,y:-1}, DOWN:{x:0,y:1}, LEFT:{x:-1,y:0}, RIGHT:{x:1,y:0} };
const DIRS_LIST = [DIR.UP, DIR.DOWN, DIR.LEFT, DIR.RIGHT];
const TOTAL_ROUNDS = 3;

// Abilities available for player pick (no SPEED)
const PLAYER_ABILITIES = [
  { id:'phantom',   label:'👻 FANTASMA',   color:'#aaddff', desc:'A cada 4 comidas, atravessa paredes e corpos por 5s!' },
  { id:'vampire',   label:'🩸 VAMPIRO',    color:'#cc0044', desc:'A cada 8 comidas, drena 1 segmento do inimigo!' },
  { id:'ghost',     label:'🫥 DEFASAGEM',  color:'#88ffee', desc:'Pode atravessar a própria cauda temporariamente.' },
  { id:'shield',    label:'🛡 ESCUDO',     color:'#00e5ff', desc:'Sobrevive a 1 colisão fatal. Ativa ao colidir.' },
  { id:'bfs_sight', label:'🔭 VISÃO BFS',  color:'#44ff88', desc:'Vê o caminho ótimo até a comida destacado.' },
  { id:'none',      label:'🐍 SEM PODER',  color:'#555555', desc:'Sem habilidade especial. Cobra pura.' },
];

// ── Server-side minimal snake game ────────────────────────────────
function randPos(exclude) {
  let p;
  do { p = { x: Math.floor(Math.random()*COLS), y: Math.floor(Math.random()*ROWS) }; }
  while (exclude.some(e => e.x===p.x && e.y===p.y));
  return p;
}

const opp = d => d===DIR.UP?DIR.DOWN:d===DIR.DOWN?DIR.UP:d===DIR.LEFT?DIR.RIGHT:DIR.LEFT;

function initRound(room) {
  // Host = snake 0 (starts left side), Guest = snake 1 (starts right side)
  const s0 = { cells:[{x:4,y:10},{x:3,y:10},{x:2,y:10}], dir:DIR.RIGHT, alive:true, score:0, ability: room.hostAbility||'none', abilityCharge:0, abilityActive:false, abilityTimer:0 };
  const s1 = { cells:[{x:15,y:10},{x:16,y:10},{x:17,y:10}], dir:DIR.LEFT, alive:true, score:0, ability: room.guestAbility||'none', abilityCharge:0, abilityActive:false, abilityTimer:0 };
  const allCells = [...s0.cells, ...s1.cells];
  room.gameState = {
    snakes: [s0, s1],
    food: randPos(allCells),
    gameOver: false,
    winner: null,
    started: false,
    mines: [], traps: [],
  };
  room.hostDir  = DIR.RIGHT;
  room.guestDir = DIR.LEFT;
  room.lastTick = null;
  if (room.tickInterval) clearInterval(room.tickInterval);
}

function keyP(p) { return `${p.x},${p.y}`; }

function bfsPath(head, target, obstacles) {
  const visited = new Set([keyP(head)]);
  const queue = [[head,[]]];
  while (queue.length) {
    const [cur,path] = queue.shift();
    for (const d of DIRS_LIST) {
      const nx=cur.x+d.x, ny=cur.y+d.y;
      if (nx<0||nx>=COLS||ny<0||ny>=ROWS) continue;
      if (obstacles.some(o=>o.x===nx&&o.y===ny)) continue;
      const k=keyP({x:nx,y:ny});
      if (visited.has(k)) continue;
      const np=[...path,d];
      if (nx===target.x&&ny===target.y) return np;
      visited.add(k); queue.push([{x:nx,y:ny},np]);
    }
  }
  return null;
}

function serverTick(room) {
  const gs = room.gameState;
  if (!gs || gs.gameOver || !gs.started) return;

  const [s0, s1] = gs.snakes;

  // Apply buffered directions
  if (room.hostDir  && room.hostDir  !== opp(s0.dir)) s0.dir = room.hostDir;
  if (room.guestDir && room.guestDir !== opp(s1.dir)) s1.dir = room.guestDir;

  // Move each alive snake
  [s0, s1].forEach((sn, idx) => {
    if (!sn.alive) return;

    // Frozen check (electric ability future extension)
    if (sn.frozenTimer > 0) { sn.frozenTimer--; return; }

    const newHead = { x: sn.cells[0].x + sn.dir.x, y: sn.cells[0].y + sn.dir.y };

    // Ghost/phantom phase-through walls
    let phasing = sn.ability === 'phantom' && sn.abilityActive;

    // Wall collision
    if (newHead.x<0||newHead.x>=COLS||newHead.y<0||newHead.y>=ROWS) {
      if (phasing) {
        newHead.x = (newHead.x + COLS) % COLS;
        newHead.y = (newHead.y + ROWS) % ROWS;
      } else {
        sn.alive = false; sn._deadCells = [...sn.cells]; return;
      }
    }

    // Self-collision (phantom skips)
    if (!phasing && sn.cells.slice(1).some(c => c.x===newHead.x && c.y===newHead.y)) {
      sn.alive = false; sn._deadCells = [...sn.cells]; return;
    }

    // Enemy collision (phantom skips)
    const other = idx===0 ? s1 : s0;
    if (!phasing && other.alive && other.cells.some(c => c.x===newHead.x && c.y===newHead.y)) {
      // Shield check
      if (sn.ability === 'shield' && !sn.shieldUsed) {
        sn.shieldUsed = true;
        sn.shieldFlash = 10;
      } else {
        sn.alive = false; sn._deadCells = [...sn.cells]; return;
      }
    }

    // Move
    sn.cells.unshift(newHead);
    let ate = false;
    if (newHead.x===gs.food.x && newHead.y===gs.food.y) {
      sn.score++;
      ate = true;
      // Ability charge on eat
      processAbility(room, gs, sn, idx);
      const allC = gs.snakes.flatMap(s=>s.cells);
      gs.food = randPos(allC);
    } else {
      sn.cells.pop();
    }

    // Phantom timer
    if (sn.ability==='phantom') {
      if (ate) {
        sn.abilityCharge = (sn.abilityCharge||0)+1;
        if (sn.abilityCharge >= 4) { sn.abilityCharge=0; sn.abilityActive=true; sn.abilityTimer=36; }
      }
      if (sn.abilityActive) { sn.abilityTimer--; if (sn.abilityTimer<=0) sn.abilityActive=false; }
    }
    // Vampire timer
    if (sn.ability==='vampire') {
      if (ate) {
        sn.abilityCharge = (sn.abilityCharge||0)+1;
        if (sn.abilityCharge >= 8) {
          sn.abilityCharge=0;
          if (other.alive && other.cells.length > 3) {
            other.cells.pop(); if (other.score>0) other.score--;
            other.vampireFlash=8;
          }
        }
      }
    }
  });

  // Check game over: both dead, or one dead
  const alive = gs.snakes.filter(s=>s.alive);
  if (alive.length <= 1) {
    gs.gameOver = true;
    if (alive.length === 1) gs.winner = gs.snakes.indexOf(alive[0]);
    else {
      // Both dead simultaneously — compare score
      gs.winner = s0.score >= s1.score ? 0 : 1;
      if (s0.score === s1.score) gs.winner = null; // draw
    }
    clearInterval(room.tickInterval);
    room.tickInterval = null;
    handleRoundEnd(room);
  }

  broadcast(room, { type:'tick', gs: serializeGS(gs) });
}

function processAbility(room, gs, sn, idx) {
  // handled inline in serverTick for simplicity
}

function serializeGS(gs) {
  // Send minimal needed data
  return {
    snakes: gs.snakes.map(s => ({
      cells: s.cells,
      alive: s.alive,
      score: s.score,
      ability: s.ability,
      abilityCharge: s.abilityCharge||0,
      abilityActive: s.abilityActive||false,
      abilityTimer: s.abilityTimer||0,
      vampireFlash: s.vampireFlash||0,
      frozenTimer: s.frozenTimer||0,
      shieldFlash: s.shieldFlash||0,
    })),
    food: gs.food,
    gameOver: gs.gameOver,
    winner: gs.winner,
    started: gs.started,
  };
}

function handleRoundEnd(room) {
  const gs = room.gameState;
  if (gs.winner === 0) room.wins[0]++;
  else if (gs.winner === 1) room.wins[1]++;
  // else draw — no win

  const roundMsg = {
    type: 'round_end',
    winner: gs.winner, // 0=host, 1=guest, null=draw
    wins: room.wins,
    round: room.round,
  };
  broadcast(room, roundMsg);

  room.round++;
  if (room.round > TOTAL_ROUNDS) {
    // Series over
    let seriesWinner = null;
    if (room.wins[0] > room.wins[1]) seriesWinner = 'host';
    else if (room.wins[1] > room.wins[0]) seriesWinner = 'guest';
    else seriesWinner = 'draw';
    broadcast(room, { type:'series_end', wins: room.wins, winner: seriesWinner });
    room.state = 'done';
  } else {
    // Ask for ability picks again
    room.state = 'ability_pick';
    room.hostAbility = null; room.guestAbility = null;
    room.hostReady = false;  room.guestReady = false;
    broadcast(room, {
      type: 'ability_pick',
      round: room.round,
      wins: room.wins,
      abilities: PLAYER_ABILITIES,
    });
  }
}

// ── WebSocket message handler ─────────────────────────────────────
wss.on('connection', ws => {
  ws._roomCode = null;
  ws._role = null; // 'host' | 'guest'

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Create room ──────────────────────────────────────────────
      case 'create_room': {
        const code = uniqueCode();
        rooms[code] = {
          code, host: ws, guest: null,
          state: 'waiting',
          round: 1, wins: [0, 0],
          hostAbility: null, guestAbility: null,
          hostReady: false, guestReady: false,
          gameState: null, tickInterval: null,
        };
        ws._roomCode = code;
        ws._role = 'host';
        send(ws, { type:'room_created', code });
        console.log(`[ROOM] Created: ${code}`);
        break;
      }

      // ── Join room ────────────────────────────────────────────────
      case 'join_room': {
        const code = (msg.code||'').toLowerCase().trim();
        const room = rooms[code];
        if (!room) { send(ws, { type:'error', msg:'Sala não encontrada!' }); break; }
        if (room.guest) { send(ws, { type:'error', msg:'Sala cheia!' }); break; }
        if (room.state !== 'waiting') { send(ws, { type:'error', msg:'Partida já em andamento!' }); break; }
        room.guest = ws;
        ws._roomCode = code;
        ws._role = 'guest';
        room.state = 'ability_pick';
        // Tell both who they are
        send(room.host,  { type:'joined', role:'host', opponentName: msg.name||'Visitante' });
        send(room.guest, { type:'joined', role:'guest', opponentName: msg.hostName||'Anfitrião' });
        // Start ability pick phase
        broadcast(room, {
          type:'ability_pick',
          round: 1,
          wins: [0,0],
          abilities: PLAYER_ABILITIES,
        });
        console.log(`[ROOM] ${code} — guest joined`);
        break;
      }

      // ── Ability chosen ───────────────────────────────────────────
      case 'pick_ability': {
        const room = rooms[ws._roomCode];
        if (!room || room.state !== 'ability_pick') break;
        if (ws._role === 'host')  { room.hostAbility  = msg.ability; room.hostReady  = true; }
        if (ws._role === 'guest') { room.guestAbility = msg.ability; room.guestReady = true; }
        // Tell the other player we're waiting
        const other = ws._role==='host' ? room.guest : room.host;
        send(other, { type:'opponent_ready' });
        if (room.hostReady && room.guestReady) {
          // Both picked — init round + countdown
          room.state = 'round';
          initRound(room);
          broadcast(room, {
            type: 'round_start',
            round: room.round,
            wins:  room.wins,
            hostAbility:  room.hostAbility,
            guestAbility: room.guestAbility,
            gs: serializeGS(room.gameState),
          });
          // 3-2-1 countdown then start
          let count = 3;
          const cdInterval = setInterval(() => {
            broadcast(room, { type:'countdown', count });
            count--;
            if (count < 0) {
              clearInterval(cdInterval);
              room.gameState.started = true;
              broadcast(room, { type:'go' });
              room.tickInterval = setInterval(() => serverTick(room), 140);
            }
          }, 1000);
        }
        break;
      }

      // ── Player direction input ────────────────────────────────────
      case 'dir': {
        const room = rooms[ws._roomCode];
        if (!room || !room.gameState || !room.gameState.started) break;
        const d = msg.dir;
        if (!d || typeof d.x !== 'number' || typeof d.y !== 'number') break;
        if (ws._role === 'host')  room.hostDir  = d;
        if (ws._role === 'guest') room.guestDir = d;
        break;
      }

      // ── Next round / ready after series end ──────────────────────
      case 'play_again': {
        const room = rooms[ws._roomCode];
        if (!room || room.state !== 'done') break;
        room.round = 1; room.wins = [0,0];
        room.state = 'ability_pick';
        room.hostAbility = null; room.guestAbility = null;
        room.hostReady = false;  room.guestReady = false;
        broadcast(room, {
          type: 'ability_pick',
          round: 1,
          wins: [0,0],
          abilities: PLAYER_ABILITIES,
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    const code = ws._roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (room.tickInterval) clearInterval(room.tickInterval);
    // Notify remaining player
    const other = ws._role==='host' ? room.guest : room.host;
    send(other, { type:'opponent_left' });
    delete rooms[code];
    console.log(`[ROOM] ${code} closed (${ws._role} disconnected)`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`🐍 Snake Festa Server rodando em http://localhost:${PORT}`);
  console.log(`   Abra no navegador e clique em MODO FESTA!`);
});
