const db = require('../db');

const rooms = new Map();
const roomLikes = new Map();
const roomPlayed = new Map();
const lastNextRoundSent = new Map();
const bookmarkletTokens = new Map();

const BOOKMARKLET_TOKEN_TTL_MS = 15 * 60 * 1000;
const ROOM_EXPIRE_MS = 2 * 60 * 60 * 1000;

function touchRoom(room) {
  if (room) room.lastActivity = Date.now();
}

function cleanupExpiredRooms() {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - (room.lastActivity || now) > ROOM_EXPIRE_MS) {
      rooms.delete(code);
      roomPlayed.delete(code);
      roomLikes.delete(code);
      lastNextRoundSent.delete(code);
    }
  }
}

function cleanupBookmarkletTokens() {
  const now = Date.now();
  for (const [t, data] of bookmarkletTokens.entries()) {
    if (now - data.createdAt > BOOKMARKLET_TOKEN_TTL_MS) bookmarkletTokens.delete(t);
  }
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getRoomByCode(code) {
  return rooms.get((code || '').toUpperCase());
}

function getPlayerListForRoom(room, playableCounts = null) {
  return room.players.map((p) => ({
    socketId: p.socketId,
    playerId: p.playerId,
    username: p.username,
    tiktokUsername: p.tiktokUsername,
    avatarUrl: p.avatarUrl,
    isReady: p.isReady,
    score: p.score ?? 0,
    streak: p.streak ?? 0,
    isHost: room.hostSocketId === p.socketId,
    playableCount: playableCounts && playableCounts[p.playerId] !== undefined ? playableCounts[p.playerId] : null,
  }));
}

async function getRoomUpdatedPayload(room) {
  const playerIds = room.players.map((p) => p.playerId);
  let playableCounts = {};
  if (db.pool && playerIds.length) {
    try {
      playableCounts = await db.getPlayableVideoCount(playerIds);
    } catch (_) {}
  }
  return { players: getPlayerListForRoom(room, playableCounts) };
}

function createEmitRoomUpdated(io) {
  return function emitRoomUpdated(room) {
    getRoomUpdatedPayload(room).then((payload) => io.to(room.code).emit('room_updated', payload));
  };
}

setInterval(cleanupExpiredRooms, 5 * 60 * 1000);

module.exports = {
  rooms,
  roomLikes,
  roomPlayed,
  lastNextRoundSent,
  bookmarkletTokens,
  BOOKMARKLET_TOKEN_TTL_MS,
  touchRoom,
  cleanupBookmarkletTokens,
  generateCode,
  getRoomByCode,
  getPlayerListForRoom,
  getRoomUpdatedPayload,
  createEmitRoomUpdated,
};
