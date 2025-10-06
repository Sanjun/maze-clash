// public/index.js
// Fixed client that matches your server's events and payloads.
// - Fog radius = 2 (auto-updates on state messages)
// - Tile "target" size = 32 CSS px when space allows (scales down if needed)
// - Deterministic pastel floor palette, dark walls
// - Uses server events: matchFound, status, state, gameOver, revealMaze, opponentDisconnected

(() => {
  const socket = io();

  // UI refs
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const statusMain = document.getElementById('statusMain');
  const statusSmall = document.getElementById('statusSmall');
  const btnFind = document.getElementById('btnFind');
  const dirButtons = Array.from(document.querySelectorAll('.dir-btn[data-dir]'));
  const canvasWrap = document.getElementById('canvasWrap');

  // Visual constants
  const TARGET_TILE = 32; // desired tile size in CSS pixels (when room permits)
  const FOG_RADIUS = 2;   // requested reveal radius around player
  const PALETTE = ['#FF9AA2', '#FFB7B2', '#FFDAC1', '#E2F0CB', '#B5EAD7', '#C7CEEA', '#FFF3B0', '#F7D6FF'];
  const WALL_COLOR = '#0b0d10';
  const HIDDEN_COLOR = '#000000';

  // Game state
  let roomId = null;
  let maze = null;   // 2D array [y][x] with 0 empty, 1 wall
  let mazeW = 0, mazeH = 0;
  let players = {};  // id -> { x, y, color, exitX?, exitY? }
  let myId = null;
  let visible = null; // 2D boolean grid
  let revealAll = false;

  // helpers
  function setStatus(main, small) {
    statusMain.textContent = main || '';
    statusSmall.textContent = small || '';
  }

  function initVisible(w,h) {
    visible = Array.from({ length: h }, () => Array(w).fill(false));
  }

  function tileColorFor(x,y) {
    // deterministic index
    const idx = Math.abs((x * 31 + y * 17)) % PALETTE.length;
    return PALETTE[idx];
  }

  function revealAround(cx, cy) {
    if (!visible || !maze) return;
    const r = FOG_RADIUS;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && ny >= 0 && nx < mazeW && ny < mazeH) visible[ny][nx] = true;
      }
    }
  }

  // Canvas sizing: compute CSS width/height to fit within canvasWrap while preserving board aspect.
  function resizeCanvas() {
    const wrapRect = canvasWrap.getBoundingClientRect();
    if (!wrapRect.width || !wrapRect.height) return;
    // board logical size
    const wTiles = mazeW || 40;
    const hTiles = mazeH || 40;
    // target CSS tile size (try TARGET_TILE, but shrink if not enough room)
    const maxTileWidth = wrapRect.width / wTiles;
    const maxTileHeight = wrapRect.height / hTiles;
    const tileDisplay = Math.max(6, Math.floor(Math.min(TARGET_TILE, maxTileWidth, maxTileHeight)));
    const cssW = Math.floor(tileDisplay * wTiles);
    const cssH = Math.floor(tileDisplay * hTiles);

    // set CSS size
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    // set actual drawing buffer for crispness
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.max(1, Math.floor(cssH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // redraw
    draw();
  }

  window.addEventListener('resize', () => {
    clearTimeout(window.__mc_resize_timer);
    window.__mc_resize_timer = setTimeout(resizeCanvas, 60);
  });

  // DRAW: uses CSS tile size computed from canvas.style.width
  function draw() {
    // clear (in CSS pixels)
    const cssW = parseFloat(canvas.style.width) || 0;
    const cssH = parseFloat(canvas.style.height) || 0;
    if (!cssW || !cssH) {
      ctx.clearRect(0,0,canvas.width, canvas.height);
      return;
    }
    ctx.clearRect(0,0,canvas.width, canvas.height);

    if (!maze || !maze.length) {
      // placeholder
      ctx.fillStyle = '#0b0f14';
      ctx.fillRect(0,0, cssW, cssH);
      ctx.fillStyle = '#9aa';
      ctx.font = '16px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('No match — press Find Match', cssW/2, cssH/2);
      return;
    }

    const tileDisplay = cssW / mazeW;
    const offsetX = 0, offsetY = 0;

    // background
    ctx.fillStyle = '#0a0b0f';
    ctx.fillRect(0,0, cssW, cssH);

    // ensure we have my player
    const me = players[myId];

    // draw tiles with fog
    for (let y = 0; y < mazeH; y++) {
      for (let x = 0; x < mazeW; x++) {
        const px = offsetX + x * tileDisplay;
        const py = offsetY + y * tileDisplay;
        let isVisible = revealAll || (visible && visible[y] && visible[y][x]);
        // if we don't know our position yet, reveal nothing (but still draw some)
        if (!me) isVisible = false;

        if (!isVisible) {
          ctx.fillStyle = HIDDEN_COLOR;
          ctx.fillRect(px, py, tileDisplay, tileDisplay);
          continue;
        }

        if (maze[y][x] === 1) {
          // wall
          ctx.fillStyle = WALL_COLOR;
          ctx.fillRect(px, py, tileDisplay, tileDisplay);
          ctx.strokeStyle = 'rgba(255,255,255,0.02)';
          ctx.strokeRect(px+0.5, py+0.5, tileDisplay-1, tileDisplay-1);
        } else {
          // floor (darker toned candy)
          ctx.fillStyle = tileColorFor(x,y);
          ctx.fillRect(px, py, tileDisplay, tileDisplay);
          // inner soft highlight to emphasize floor tile (subtle)
          ctx.fillStyle = 'rgba(255,255,255,0.04)';
          ctx.fillRect(px + tileDisplay*0.06, py + tileDisplay*0.06, tileDisplay*0.88, tileDisplay*0.88);
        }
      }
    }

    // draw exits (glow) if visible
    for (const pid in players) {
      const p = players[pid];
      if (!p || p.exitX == null || p.exitY == null) continue;
      const ex = p.exitX, ey = p.exitY;
      const px = offsetX + ex * tileDisplay;
      const py = offsetY + ey * tileDisplay;
      const visExit = revealAll || (visible && visible[ey] && visible[ey][ex]);
      if (!visExit) continue;
      ctx.fillStyle = 'rgba(255,210,80,0.12)';
      ctx.fillRect(px - tileDisplay*0.06, py - tileDisplay*0.06, tileDisplay*1.12, tileDisplay*1.12);
      ctx.fillStyle = 'rgba(255,210,80,1)';
      ctx.fillRect(px + tileDisplay*0.15, py + tileDisplay*0.15, tileDisplay*0.7, tileDisplay*0.7);
    }

    // draw players: your player bright, opponent bright but only if visible
    for (const pid in players) {
      const p = players[pid];
      if (!p) continue;
      // determine visibility of that tile to you
      const tileVis = visible && visible[p.y] && visible[p.y][p.x];
      const show = revealAll || (pid === myId) || tileVis;
      if (!show) continue;
      const cx = offsetX + (p.x + 0.5) * tileDisplay;
      const cy = offsetY + (p.y + 0.5) * tileDisplay;
      const radius = Math.max(4, tileDisplay * 0.32);
      ctx.beginPath();
      ctx.fillStyle = (pid === myId) ? (p.color || '#00ff99') : (p.color || '#ff3b8a');
      ctx.arc(cx, cy, radius, 0, Math.PI*2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.stroke();

      // small glow ring for your player to emphasize
      if (pid === myId) {
        ctx.beginPath();
        ctx.arc(cx, cy, radius + 4, 0, Math.PI*2);
        ctx.strokeStyle = 'rgba(0,255,153,0.10)';
        ctx.lineWidth = 6;
        ctx.stroke();
      }
    }
  }

  // attach hold-repeat to directional buttons (emit {roomId, dir})
  function attachHold(button, dir) {
    let interval = null;
    const emitOnce = () => { if (!roomId) return; socket.emit('move', { roomId, dir }); };
    const start = (ev) => {
      ev.preventDefault();
      emitOnce();
      if (interval) clearInterval(interval);
      interval = setInterval(emitOnce, 180);
      document.addEventListener('pointerup', stop, { once:true });
      document.addEventListener('mouseup', stop, { once:true });
      document.addEventListener('touchend', stop, { once:true });
    };
    const stop = () => { if (interval) { clearInterval(interval); interval = null; } };
    button.addEventListener('pointerdown', start);
    button.addEventListener('touchstart', start, { passive:false });
    button.addEventListener('mousedown', start);
    button.addEventListener('contextmenu', (e)=>e.preventDefault());
  }

  dirButtons.forEach(b => attachHold(b, b.dataset.dir));

  // keyboard single-step
  const keyMap = { ArrowUp:'up', KeyW:'up', ArrowDown:'down', KeyS:'down', ArrowLeft:'left', KeyA:'left', ArrowRight:'right', KeyD:'right' };
  window.addEventListener('keydown', (ev) => {
    const dir = keyMap[ev.code];
    if (dir && roomId) {
      ev.preventDefault();
      socket.emit('move', { roomId, dir });
    }
  });

  // Find match
  btnFind.addEventListener('click', () => {
    socket.emit('findMatch');
    setStatus('Searching for opponent...', 'Open another tab to join.');
  });

  // Socket handlers (match server behavior)
  socket.on('connect', () => {
    myId = socket.id;
    setStatus('Connected', 'Press Find Match (or open another tab).');
  });

  socket.on('status', (s) => {
    setStatus(s, statusSmall.textContent || '');
  });

  socket.on('matchFound', (payload) => {
    // payload: { roomId, maze, width, height, players }
    roomId = payload.roomId;
    maze = payload.maze;
    mazeH = maze.length;
    mazeW = (maze[0]||[]).length;
    players = payload.players || {};

    // init visible grid and reveal around my start
    initVisible(mazeW, mazeH);
    if (players[myId]) revealAround(players[myId].x, players[myId].y);

    revealAll = false;
    setStatus('Match ready — go!', 'Find the exit. Opponent is hidden unless nearby.');
    resizeCanvas();
    draw();
  });

  socket.on('state', (state) => {
    // server sends mapping pid -> { x, y, color, exitX?, exitY? }
    for (const pid in state) {
      if (!players[pid]) players[pid] = {};
      players[pid].x = state[pid].x;
      players[pid].y = state[pid].y;
      if (state[pid].color) players[pid].color = state[pid].color;
      if (state[pid].exitX != null) players[pid].exitX = state[pid].exitX;
      if (state[pid].exitY != null) players[pid].exitY = state[pid].exitY;
    }
    // reveal around our current server position
    if (!revealAll && players[myId]) revealAround(players[myId].x, players[myId].y);
    draw();
  });

  socket.on('gameOver', ({ winner, winnerColor }) => {
    if (winner === myId) setStatus('You Win! 🎉', 'Maze revealed.');
    else setStatus('You Lose', 'Opponent reached the exit first.');
    revealAll = true;
    draw();
  });

  socket.on('revealMaze', (m) => {
    maze = m;
    if (!visible) initVisible(maze[0].length, maze.length);
    revealAll = true;
    draw();
  });

  socket.on('opponentDisconnected', () => {
    setStatus('Opponent disconnected', 'Match ended.');
    revealAll = true;
    draw();
  });

  // auto-find on load to make testing easy (optional)
  socket.emit('findMatch');
  setStatus('Searching for opponent...', 'Automatic matchmaking — open another tab to play.');

  // initial resize & draw
  setTimeout(resizeCanvas, 50);
  window.requestAnimationFrame(draw);

})();
