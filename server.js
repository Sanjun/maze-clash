// server.js
'use strict';

/**
 * Maze Clash - Node + Express + Socket.IO
 * Production-ready for Render.com
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');
const { Server } = require('socket.io');

const MAZE_LOGICAL = 7; // logical cells -> final grid 15x15
const TILE_EMPTY = 0;
const TILE_WALL = 1;

const app = express();
const server = http.createServer(app);

// Config from env
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const STATIC_DIR = process.env.STATIC_DIR || 'public';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// Socket.IO
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
});

// Middleware
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
if (NODE_ENV === 'development') app.use(morgan('dev'));

// Health check
app.get('/_health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

// Serve static frontend
const staticDirPath = path.join(__dirname, STATIC_DIR);
app.use(express.static(staticDirPath));

// SPA fallback
app.get('*', (req, res, next) => {
  const indexPath = path.join(staticDirPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) return next();
  });
});

/* ---------- Maze logic ---------- */

// Maze generator (DFS recursive backtracker)
function generateMaze(n) {
  const w = n, h = n;
  const gridW = w * 2 + 1, gridH = h * 2 + 1;
  const g = Array.from({ length: gridH }, () => Array(gridW).fill(TILE_WALL));
  const visited = Array.from({ length: h }, () => Array(w).fill(false));

  function carve(cx, cy) {
    visited[cy][cx] = true;
    g[cy * 2 + 1][cx * 2 + 1] = TILE_EMPTY;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx >= 0 && nx < w && ny >= 0 && ny < h && !visited[ny][nx]) {
        g[cy * 2 + 1 + dy][cx * 2 + 1 + dx] = TILE_EMPTY;
        g[ny * 2 + 1][nx * 2 + 1] = TILE_EMPTY;
        carve(nx, ny);
      }
    }
  }

  carve(0, 0);
  return { grid: g, width: gridW, height: gridH };
}

// pick random empty cell in a region
function pickRandomCell(grid, regionTest, attempts = 500) {
  const h = grid.length, w = grid[0].length;
  for (let i = 0; i < attempts; i++) {
    const x = Math.floor(Math.random() * w);
    const y = Math.floor(Math.random() * h);
    if (grid[y][x] === TILE_EMPTY && regionTest(x, y)) return { x, y };
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y][x] === TILE_EMPTY && regionTest(x, y)) return { x, y };
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y][x] === TILE_EMPTY) return { x, y };
    }
  }
  return { x: 1, y: 1 };
}

function distance(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

let waitingSocket = null;
const rooms = {};

function makeRoomId(a, b) {
  return `r-${a}-${b}-${Date.now()}`;
}

/* ---------- Socket.IO Events ---------- */

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on('findMatch', () => {
    if (!waitingSocket) {
      waitingSocket = socket;
      socket.emit('status', 'Waiting for an opponent...');
      return;
    }
    if (waitingSocket.id === socket.id) {
      socket.emit('status', 'Still waiting...');
      return;
    }

    const roomId = makeRoomId(waitingSocket.id, socket.id);
    const mazeObj = generateMaze(MAZE_LOGICAL);
    const grid = mazeObj.grid;
    const gridW = mazeObj.width, gridH = mazeObj.height;

    const leftTopTest = (x, y) => x <= Math.floor(gridW * 0.33) || y <= Math.floor(gridH * 0.33);
    const rightBottomTest = (x, y) => x >= Math.ceil(gridW * 0.66) || y >= Math.ceil(gridH * 0.66);

    let aStart = pickRandomCell(grid, leftTopTest);
    let bStart = pickRandomCell(grid, rightBottomTest);

    const minDist = Math.max(gridW, gridH) * 0.45;
    let tries = 0;
    while (distance(aStart, bStart) < minDist && tries < 200) {
      aStart = pickRandomCell(grid, leftTopTest);
      bStart = pickRandomCell(grid, rightBottomTest);
      tries++;
    }

    if (distance(aStart, bStart) < minDist) {
      let best = aStart, bestD = -1;
      for (let y = 0; y < gridH; y++) {
        for (let x = 0; x < gridW; x++) {
          if (grid[y][x] !== TILE_EMPTY) continue;
          const d = distance(aStart, { x, y });
          if (d > bestD) {
            bestD = d;
            best = { x, y };
          }
        }
      }
      bStart = best;
    }

    const pA = { id: waitingSocket.id, x: aStart.x, y: aStart.y, color: '#34ff72', exitX: bStart.x, exitY: bStart.y };
    const pB = { id: socket.id, x: bStart.x, y: bStart.y, color: '#ff4d9e', exitX: aStart.x, exitY: aStart.y };

    rooms[roomId] = { maze: mazeObj, players: {} };
    rooms[roomId].players[pA.id] = pA;
    rooms[roomId].players[pB.id] = pB;

    waitingSocket.join(roomId);
    socket.join(roomId);

    io.to(roomId).emit('matchFound', {
      roomId,
      maze: grid,
      width: gridW,
      height: gridH,
      players: {
        [pA.id]: { x: pA.x, y: pA.y, color: pA.color, exitX: pA.exitX, exitY: pA.exitY },
        [pB.id]: { x: pB.x, y: pB.y, color: pB.color, exitX: pB.exitX, exitY: pB.exitY },
      },
    });

    io.to(roomId).emit('status', 'Game started — reach the glowing exit!');
    waitingSocket = null;
  });

  socket.on('move', ({ roomId, dir }) => {
    const r = rooms[roomId];
    if (!r) return;
    const player = r.players[socket.id];
    if (!player) return;
    const deltas = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    const d = deltas[dir];
    if (!d) return;
    const nx = player.x + d[0], ny = player.y + d[1];
    if (nx < 0 || ny < 0 || nx >= r.maze.width || ny >= r.maze.height) return;
    if (r.maze.grid[ny][nx] === TILE_WALL) return;
    player.x = nx;
    player.y = ny;

    const state = {};
    for (const pid in r.players) {
      const p = r.players[pid];
      state[pid] = { x: p.x, y: p.y, color: p.color, exitX: p.exitX, exitY: p.exitY };
    }
    io.to(roomId).emit('state', state);

    if (player.x === player.exitX && player.y === player.exitY) {
      io.to(roomId).emit('gameOver', { winner: socket.id, winnerColor: player.color });
      io.to(roomId).emit('revealMaze', r.maze.grid);
      setTimeout(() => {
        try { io.in(roomId).socketsLeave(roomId); } catch {}
        delete rooms[roomId];
      }, 4500);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    if (waitingSocket && waitingSocket.id === socket.id) waitingSocket = null;

    for (const roomId in rooms) {
      if (rooms[roomId].players[socket.id]) {
        io.to(roomId).emit('opponentDisconnected');
        for (const pid in rooms[roomId].players) {
          try { io.sockets.sockets.get(pid)?.leave(roomId); } catch {}
        }
        delete rooms[roomId];
      }
    }
  });
});

/* ---------- Start Server ---------- */

server.listen(PORT, () => {
  console.log(`✅ Maze Clash server running on port ${PORT} (${NODE_ENV})`);
});
