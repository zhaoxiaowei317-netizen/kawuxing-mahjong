import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, extname, sep, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { exec } from 'node:child_process';
import { Rooms } from './core/rooms.js';

const PORT = Number(process.env.PORT || 8789);
const HOST = '0.0.0.0';
const DATA_DIR = resolve('data');
mkdirSync(DATA_DIR, { recursive: true });
const roomsFile = resolve(DATA_DIR, 'rooms.json');

let snapshot = [];
try {
  snapshot = JSON.parse(readFileSync(roomsFile, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('读取房间存档警告:', e.message);
}

const rooms = new Rooms(snapshot);
const gameRoot = resolve('game');

function saveRooms() {
  try {
    writeFileSync(roomsFile + '.tmp', JSON.stringify([...rooms.rooms]));
    renameSync(roomsFile + '.tmp', roomsFile);
  } catch (err) {
    console.error('保存房间状态失败:', err.message);
  }
}

const sendJson = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

function getLocalIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

const server = createServer(async (req, res) => {
  try {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // API 路由 (房间管理与对局通信)
    if (url.pathname.startsWith('/api/')) {
      let body = {};
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 8192) throw Error('请求数据包过大');
        }
        body = JSON.parse(raw || '{}');
      }
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      let data;
      if (url.pathname === '/api/create' && req.method === 'POST') {
        data = rooms.create(body);
      } else if (url.pathname === '/api/join' && req.method === 'POST') {
        data = rooms.join(String(body.code), body);
      } else if (url.pathname === '/api/leave' && req.method === 'POST') {
        data = rooms.leave(String(body.code), token);
      } else if (url.pathname === '/api/room' && req.method === 'GET') {
        const r = rooms.rooms.get(url.searchParams.get('code'));
        if (!r) throw Error('房间不存在');
        data = rooms.view(r, token);
      } else if (url.pathname === '/api/action' && req.method === 'POST') {
        data = rooms.action(String(body.code), token, body);
      } else {
        return sendJson(res, 404, { error: '接口不存在' });
      }

      if (req.method === 'POST') saveRooms();
      return sendJson(res, 200, data);
    }

    // 静态资源路由
    let requestPath = decodeURIComponent(url.pathname);
    if (requestPath === '/' || requestPath === '') {
      requestPath = '/lobby.html';
    } else if (requestPath === '/single') {
      requestPath = '/index.html';
    } else if (requestPath === '/online') {
      requestPath = '/online.html';
    }

    const filePath = resolve(gameRoot, '.' + requestPath);
    if (!filePath.startsWith(gameRoot + sep) && filePath !== gameRoot) {
      return sendJson(res, 403, { error: '禁止越界访问' });
    }

    if (existsSync(filePath)) {
      const ext = extname(filePath).toLowerCase();
      res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.end(readFileSync(filePath));
    }

    sendJson(res, 404, { error: '资源未找到: ' + requestPath });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
});

const timer = setInterval(() => {
  if (rooms.tick()) saveRooms();
}, 250);

server.listen(PORT, HOST, () => {
  const localIp = getLocalIp();
  console.log('===============================================================');
  console.log('       🀄 湖北卡五星麻将 电脑单机/联机游戏服务器启动成功 🀄');
  console.log('===============================================================');
  console.log(`  👉 本机直接游玩:   http://localhost:${PORT}`);
  console.log(`  👉 好友联机开房:   http://localhost:${PORT}/online.html`);
  console.log(`  👉 局域网同游:     http://${localIp}:${PORT}/online.html`);
  console.log('===============================================================');
  console.log('  提示: 按 Ctrl + C 可关闭游戏服务。');

  if (process.env.AUTO_OPEN !== '0') {
    openDesktopWindow(`http://localhost:${PORT}`);
  }
});

function openDesktopWindow(targetUrl) {
  // 优先寻找 Edge 或 Chrome 启动独立 App 模式窗口（无浏览器工具栏，纯正 PC 客户端质感）
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  if (existsSync(edgePath)) {
    exec(`"${edgePath}" --app="${targetUrl}" --window-size=1280,820`);
  } else if (existsSync(chromePath)) {
    exec(`"${chromePath}" --app="${targetUrl}" --window-size=1280,820`);
  } else {
    // 调用系统默认浏览器
    exec(`start "" "${targetUrl}"`);
  }
}

function stop() {
  clearInterval(timer);
  server.close(() => {
    console.log('\n游戏服务已安全退出。');
    process.exit(0);
  });
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
