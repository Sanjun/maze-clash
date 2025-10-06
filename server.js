// server.js
'use strict';

/**
 * Maze Clash - Node + Express + Socket.IO
 * Production-ready for Render.com (or similar PaaS)
 *
 * Environment variables:
 *  - PORT (provided by Render)
 *  - NODE_ENV (development|production)
 *  - STATIC_DIR (default: 'public') -> where frontend build lives
 *  - CORS_ORIGIN (optional) -> allowed origin for websocket requests, default '*'
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

// Socket.IO with CORS configured
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
  // Optional: path: '/socket.io' (default) - keep unless your client uses a custom path
});

// Middleware
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
if (NODE_ENV === 'development') app.use(morgan('dev'));

// Health check (Render will use this)
app.get('/_health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

// Serve static frontend (SPA)
const staticDirPath = path.join(__dirname, STATIC_DIR);
app.use(express.static(staticDirPath));

// SPA fallback — only if index.html exists
app.get('*', (req, res, next) => {
  const indexPath = path.join(staticDirPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) return next(); // let express handle 404 if no index.html
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
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    // Fisher-Yates shuffle in-place
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }
    for (const [dx,dy] of dirs) {
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
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (grid[y][x] === TILE_EMPTY && regionTest(x, y)) return { x, y };
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (grid[y][x] === TILE_EMPTY) return { x,_
