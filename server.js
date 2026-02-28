try { require('dotenv').config(); } catch (e) { console.warn('[env] dotenv non chargé:', e?.message || e); }
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const config = require('./config');
const { getTikTokMp4Url } = require('./scraper');
const db = require('./db');
const rooms = require('./lib/rooms');
const preload = require('./lib/preload');
const rateLimit = require('./lib/rate-limit');
const playwrightQueue = require('./lib/playwright-queue');
const apiRoutes = require('./routes/api');
const socketHandlers = require('./socket/handlers');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: config.ALLOWED_ORIGIN },
  transports: ['polling', 'websocket'],
  pingTimeout: 20000,
  pingInterval: 10000,
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "connect-src 'self'",
    "img-src 'self' data: https:",
    "media-src 'self' blob:",
    "frame-src 'self' https://www.tiktok.com",
  ].join('; '));
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

apiRoutes.register(app, {
  config,
  getTikTokMp4Url,
  playwrightEnqueue: playwrightQueue.enqueue,
  checkVideoRateLimit: rateLimit.check,
  getRoomByCode: rooms.getRoomByCode,
  getPreloadCache: preload.getCache,
  bookmarkletTokens: rooms.bookmarkletTokens,
  roomLikes: rooms.roomLikes,
  io,
  emitRoomUpdated: rooms.createEmitRoomUpdated(io),
  cleanupBookmarkletTokens: rooms.cleanupBookmarkletTokens,
  setPlaywrightMissingLogged: playwrightQueue.setPlaywrightMissingLogged,
  getPlaywrightMissingLogged: playwrightQueue.getPlaywrightMissingLogged,
});

socketHandlers.attach(io, {
  rooms: rooms.rooms,
  roomLikes: rooms.roomLikes,
  roomPlayed: rooms.roomPlayed,
  lastNextRoundSent: rooms.lastNextRoundSent,
  bookmarkletTokens: rooms.bookmarkletTokens,
  touchRoom: rooms.touchRoom,
  cleanupBookmarkletTokens: rooms.cleanupBookmarkletTokens,
  generateCode: rooms.generateCode,
  getRoomByCode: rooms.getRoomByCode,
  getPlayerListForRoom: rooms.getPlayerListForRoom,
  createEmitRoomUpdated: rooms.createEmitRoomUpdated,
  runServerPreload: preload.runServerPreload,
  preloadDeleteFromCache: preload.deleteFromCache,
});

const PORT = config.PORT;
if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => console.log('Guess The Like — http://localhost:' + PORT));
}
module.exports = { app, server };
