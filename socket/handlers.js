const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { harvestLikes } = require('../scraper');

function attach(io, deps) {
  const {
    rooms: roomsMap,
    roomLikes,
    roomPlayed,
    lastNextRoundSent,
    bookmarkletTokens,
    touchRoom,
    cleanupBookmarkletTokens,
    generateCode,
    getRoomByCode,
    getPlayerListForRoom,
    createEmitRoomUpdated,
    runServerPreload,
    preloadDeleteFromCache,
  } = deps;

  const emitRoomUpdated = createEmitRoomUpdated(io);

  io.on('connection', (socket) => {
    socket.on('create_room', async (data, ack) => {
      const { username, tiktokUsername, avatarUrl } = data || {};
      if (!username?.trim()) return ack?.({ error: 'Username required' });
      let player = { id: socket.id, username: username.trim(), tiktok_username: (tiktokUsername || username).trim(), avatar_url: null };
      if (db.pool) {
        try {
          player = await db.getOrCreatePlayer(username.trim(), (tiktokUsername || username).trim()) || player;
        } catch (err) {
          console.error('[create_room] getOrCreatePlayer failed:', err?.message || err);
          return ack?.({ error: 'Erreur base de données. Réessaie ou lance sans DATABASE_URL.' });
        }
      }
      const playerId = player?.id ?? socket.id;
      if (avatarUrl && typeof avatarUrl === 'string' && avatarUrl.length > 500000) return ack?.({ error: 'Image de profil trop lourde (max ~500 Ko).' });
      const avatar = (avatarUrl && typeof avatarUrl === 'string' && (avatarUrl.startsWith('http') || avatarUrl.startsWith('data:'))) ? avatarUrl : (player?.avatar_url || null);
      let code = generateCode();
      while (roomsMap.has(code)) code = generateCode();
      let roomId = null;
      if (db.pool) {
        try {
          const created = await db.createRoom(code);
          if (created) roomId = created.id;
        } catch (err) {
          console.error('[create_room] createRoom failed:', err?.message || err);
          return ack?.({ error: 'Erreur base de données. Réessaie.' });
        }
      }
      const room = {
        roomId,
        code,
        hostSocketId: socket.id,
        players: [{ socketId: socket.id, playerId, username: player?.username ?? username, tiktokUsername: player?.tiktok_username ?? (tiktokUsername || username), avatarUrl: avatar, isReady: false, score: 0, streak: 0 }],
        status: 'lobby',
        gameState: null,
        lastActivity: Date.now(),
      };
      roomsMap.set(code, room);
      if (db.pool && roomId) {
        try {
          await db.addPlayerToRoom(roomId, playerId, socket.id);
        } catch (err) {
          console.error('[create_room] addPlayerToRoom failed:', err?.message || err);
          roomsMap.delete(code);
          return ack?.({ error: 'Erreur base de données. Réessaie.' });
        }
      }
      socket.join(code);
      touchRoom(room);
      ack?.({ code, playerId, players: getPlayerListForRoom(room) });
    });

    socket.on('join_room', async (data, ack) => {
      const { code, username, tiktokUsername, avatarUrl } = data || {};
      const roomCode = (code || '').toUpperCase().trim();
      const room = getRoomByCode(roomCode);
      if (!room) return ack?.({ error: 'Room not found' });
      if (room.status !== 'lobby') return ack?.({ error: 'Game already started' });
      if (!username?.trim()) return ack?.({ error: 'Username required' });
      if (avatarUrl && typeof avatarUrl === 'string' && avatarUrl.length > 500000) return ack?.({ error: 'Image de profil trop lourde (max ~500 Ko).' });
      let player = { id: socket.id, username: username.trim(), tiktok_username: (tiktokUsername || username).trim(), avatar_url: null };
      if (db.pool) {
        try {
          player = await db.getOrCreatePlayer(username.trim(), (tiktokUsername || username).trim()) || player;
        } catch (err) {
          console.error('[join_room] getOrCreatePlayer failed:', err?.message || err);
          return ack?.({ error: 'Erreur base de données. Réessaie ou lance sans DATABASE_URL.' });
        }
      }
      const playerId = player?.id ?? socket.id;
      const avatar = (avatarUrl && typeof avatarUrl === 'string' && (avatarUrl.startsWith('http') || avatarUrl.startsWith('data:'))) ? avatarUrl : (player?.avatar_url || null);
      if (room.players.some((p) => p.playerId === playerId || p.socketId === socket.id)) return ack?.({ error: 'Already in room' });
      room.players.push({ socketId: socket.id, playerId, username: player?.username ?? username, tiktokUsername: player?.tiktok_username ?? (tiktokUsername || username), avatarUrl: avatar, isReady: false, score: 0, streak: 0 });
      if (db.pool && room.roomId) {
        try {
          await db.addPlayerToRoom(room.roomId, playerId, socket.id);
        } catch (err) {
          console.error('[join_room] addPlayerToRoom failed:', err?.message || err);
          room.players.pop();
          return ack?.({ error: 'Erreur base de données. Réessaie.' });
        }
      }
      socket.join(roomCode);
      touchRoom(room);
      emitRoomUpdated(room);
      ack?.({ playerId, players: getPlayerListForRoom(room) });
    });

    socket.on('create_bookmarklet_token', (data, ack) => {
      const { code } = data || {};
      const room = getRoomByCode((code || '').toUpperCase());
      if (!room) return ack?.({ error: 'Room not found' });
      const me = room.players.find((p) => p.socketId === socket.id);
      if (!me) return ack?.({ error: 'Not in room' });
      cleanupBookmarkletTokens();
      const token = crypto.randomBytes(16).toString('hex');
      bookmarkletTokens.set(token, { roomCode: room.code, playerId: me.playerId, socketId: socket.id, createdAt: Date.now() });
      ack?.({ token });
    });

    socket.on('set_ready', async (data, ack) => {
      const { code } = data || {};
      const room = getRoomByCode((code || '').toUpperCase());
      if (!room) return ack?.({ error: 'Room not found' });
      const me = room.players.find((p) => p.socketId === socket.id);
      if (!me) return ack?.({ error: 'Not in room' });
      const tiktokUser = (me.tiktokUsername || me.username || '').replace(/^@/, '');
      if (!tiktokUser) return ack?.({ error: 'TikTok username required' });
      me.isReady = true;
      emitRoomUpdated(room);
      ack?.({ status: 'scraping' });

      let result;
      try {
        console.log('[set_ready] Début récupération likes pour @%s…', tiktokUser);
        result = await harvestLikes(tiktokUser, 150);
      } catch (err) {
        console.error('[set_ready] Erreur scraper:', err.message || err);
        me.isReady = false;
        emitRoomUpdated(room);
        const msg = (err.message || String(err)).toLowerCase();
        const friendly = msg.includes('user data') || msg.includes('already in use')
          ? 'Profil Chrome déjà utilisé. Ferme toutes les fenêtres Chrome puis réessaie.'
          : (err.message || 'Erreur lors de la récupération.');
        return ack?.({ error: friendly });
      }

      const count = result.videos?.length ?? 0;
      if (count === 0 && !result.error) console.log('[set_ready] Scraper a renvoyé 0 vidéos pour @%s', tiktokUser);
      if (result.error) {
        me.isReady = false;
        emitRoomUpdated(room);
        console.log('[set_ready] Erreur retournée:', result.error);
        let errMsg = result.error;
        if (config.CHROME_DEBUG_URL && /ECONNREFUSED|127\.0\.0\.1:9222/.test(result.error)) {
          errMsg = 'Chrome n\'écoute pas sur le port 9222. Ferme TOUTES les fenêtres Chrome, puis lance uniquement : .\\scripts\\launch-chrome-debug.ps1 — garde cette fenêtre ouverte et réessaie Prêt.';
        }
        return ack?.({ error: errMsg });
      }
      if (count === 0) {
        me.isReady = false;
        emitRoomUpdated(room);
        return ack?.({ error: 'Aucun like récupéré. Vérifie ton @ TikTok et que tes likes sont bien en public.' });
      }
      if (db.pool && me.playerId) {
        try {
          await db.saveLikes(me.playerId, result.videos);
        } catch (err) {
          console.error('[set_ready] saveLikes failed:', err?.message || err);
        }
      }
      if (me.playerId) {
        const key = (room.code || '').toUpperCase();
        if (!roomLikes.has(key)) roomLikes.set(key, {});
        const list = result.videos.map((url, i) => ({
          id: `mem-${me.playerId}-${i}-${Date.now()}`,
          video_url: url,
          owner_id: me.playerId,
        }));
        roomLikes.get(key)[me.playerId] = list;
        console.log('[set_ready] Stored %s likes for room=%s playerId=%s', list.length, key, me.playerId);
      }
      emitRoomUpdated(room);
      socket.emit('harvest_done', { count });
      ack?.({ ok: true, count });
    });

    socket.on('import_likes', async (data, ack) => {
      const { code, urlsText } = data || {};
      const room = getRoomByCode((code || '').toUpperCase());
      if (!room) return ack?.({ error: 'Room not found' });
      const me = room.players.find((p) => p.socketId === socket.id);
      if (!me) return ack?.({ error: 'Not in room' });
      const lines = String(urlsText || '').split(/\n/).map((s) => s.trim()).filter(Boolean);
      const urls = [];
      const seen = new Set();
      for (const line of lines) {
        const m = line.match(/https?:\/\/[^\s]+/g);
        if (m) for (const u of m) {
          if (u.includes('/video/') && !seen.has(u)) {
            seen.add(u);
            urls.push(u);
          }
        }
      }
      if (urls.length === 0) return ack?.({ error: 'Aucun lien TikTok trouvé (format: .../video/...). Colle un lien par ligne.' });
      const key = (room.code || '').toUpperCase();
      if (db.pool && me.playerId) {
        try {
          await db.saveLikes(me.playerId, urls);
        } catch (err) {
          console.error('[import_likes] saveLikes failed:', err?.message || err);
        }
      }
      if (!roomLikes.has(key)) roomLikes.set(key, {});
      const list = urls.map((url, i) => ({
        id: `mem-${me.playerId}-${i}-${Date.now()}`,
        video_url: url,
        owner_id: me.playerId,
      }));
      roomLikes.get(key)[me.playerId] = list;
      me.isReady = true;
      touchRoom(room);
      emitRoomUpdated(room);
      console.log('[import_likes] Stored %s links for room=%s playerId=%s', list.length, key, me.playerId);
      ack?.({ ok: true, count: list.length });
    });

    socket.on('start_game', async (data, ack) => {
      const roomCode = (data?.code || '').toUpperCase();
      const totalRounds = Math.min(Math.max(parseInt(data?.totalRounds, 10) || config.PRELOAD_INITIAL_VIDEOS, 10), config.PRELOAD_INITIAL_VIDEOS);
      const room = getRoomByCode(roomCode);
      if (!room) return ack?.({ error: 'Room not found' });
      if (room.hostSocketId !== socket.id) return ack?.({ error: 'Only host can start' });
      if (room.status !== 'lobby') return ack?.({ error: 'Game already started' });
      touchRoom(room);
      const playerIds = room.players.map((p) => p.playerId);
      if (!roomPlayed.has(roomCode)) roomPlayed.set(roomCode, new Set());
      const played = roomPlayed.get(roomCode);
      let rounds = [];
      let pool = [];
      if (db.pool) {
        try {
          const limit = Math.min(100, totalRounds + 50);
          const fromDb = await db.getVideosForRoom(roomCode, playerIds, limit);
          const available = fromDb.filter((r) => !played.has(r.id));
          for (let i = available.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [available[i], available[j]] = [available[j], available[i]];
          }
          rounds = available.slice(0, totalRounds);
          pool = available.slice(totalRounds);
        } catch (err) {
          console.error('[start_game] getVideosForRoom failed:', err?.message || err);
        }
      }
      if (!rounds.length) {
        const memLikes = roomLikes.get((roomCode || '').toUpperCase()) || {};
        let all = [];
        for (const pid of playerIds) {
          const arr = memLikes[pid] || [];
          for (const v of arr) if (!played.has(v.id)) all.push(v);
        }
        for (let i = all.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [all[i], all[j]] = [all[j], all[i]];
        }
        rounds = all.slice(0, totalRounds);
        pool = all.slice(totalRounds);
      }
      if (!rounds.length) {
        const mem = roomLikes.get((roomCode || '').toUpperCase());
        const total = mem ? Object.values(mem).reduce((s, arr) => s + (arr?.length || 0), 0) : 0;
        console.log('[start_game] Aucune vidéo. roomCode=%s playerIds=%s roomLikes total=%s', roomCode, playerIds.length, total);
        let playableCounts = {};
        if (db.pool && playerIds.length) {
          try {
            playableCounts = await db.getPlayableVideoCount(playerIds);
          } catch (_) {}
        }
        const parts = room.players.map((p) => {
          const n = playableCounts[p.playerId] ?? 0;
          return `${p.username} : ${n} vidéo(s) jouable(s)`;
        });
        const msg = parts.length
          ? `Aucune vidéo pour lancer cette partie. ${parts.join(' — ')}. Choisis ce nombre de manches ou moins, ou importe plus de liens TikTok.`
          : 'Aucune vidéo. Importe des liens TikTok dans le lobby (voir les 3 étapes ci-dessus).';
        return ack?.({ error: msg, playableCounts });
      }
      room.status = 'preparing';
      room.gameState = {
        rounds,
        currentIndex: 0,
        votes: {},
        roundStartTime: null,
      };
      room.players.forEach((p) => {
        p.score = 0;
        p.streak = 0;
        p.correctCount = 0;
        p.maxStreak = 0;
      });
      const playersForClient = getPlayerListForRoom(room);
      const preloadTotal = rounds.length;
      io.to(roomCode).emit('game_preparing', { roundUrls: rounds.map((r) => r.video_url), totalRounds: rounds.length, preloadTotal, players: playersForClient });
      ack?.({ ok: true });
      runServerPreload(io, getRoomByCode, getPlayerListForRoom, roomCode, rounds, pool);
    });

    socket.on('preload_done', (data) => {
      const roomCode = (data?.code || '').toUpperCase();
      const room = getRoomByCode(roomCode);
      if (!room || room.status !== 'preparing') return;
      if (room.hostSocketId !== socket.id) return;
      room.status = 'playing';
      const playersForClient = getPlayerListForRoom(room);
      io.to(roomCode).emit('game_started', { players: playersForClient, totalRounds: room.gameState.rounds.length });
    });

    function sendNextRound(roomCode) {
      const room = getRoomByCode(roomCode);
      if (!room?.gameState) return;
      const { rounds, currentIndex } = room.gameState;
      const last = lastNextRoundSent.get(roomCode);
      const now = Date.now();
      if (last && last.index === currentIndex && now - last.at < 2500) return;
      lastNextRoundSent.set(roomCode, { index: currentIndex, at: now });
      if (currentIndex >= rounds.length) {
        const totalRoundsPlayed = rounds.length;
        const finalScores = room.players.map((p) => ({
          playerId: p.playerId,
          username: p.username,
          score: p.score,
          correctCount: p.correctCount ?? 0,
          maxStreak: p.maxStreak ?? 0,
        }));
        io.to(roomCode).emit('game_over', { scores: finalScores, totalRounds: totalRoundsPlayed });
        preloadDeleteFromCache(roomCode);
        room.status = 'lobby';
        room.gameState = null;
        lastNextRoundSent.delete(roomCode);
        return;
      }
      const round = rounds[currentIndex];
      room.gameState.votes = {};
      room.gameState.roundStartTime = Date.now();
      io.to(roomCode).emit('next_round', {
        roundIndex: currentIndex,
        totalRounds: rounds.length,
        videoUrl: round.video_url,
        ownerId: round.owner_id,
        players: getPlayerListForRoom(room),
      });
    }

    socket.on('video_play_failed', (data) => {
      const { code, roundIndex, videoUrl } = data || {};
      const roomCode = (code || '').toUpperCase();
      console.warn('[video] client signale lecture impossible round=%s url=%s room=%s', roundIndex, (videoUrl || '').slice(0, 120), roomCode);
    });

    socket.on('submit_vote', (data) => {
      const { code, targetPlayerId, roundIndex } = data || {};
      const room = getRoomByCode((code || '').toUpperCase());
      if (!room?.gameState) return;
      const { rounds, currentIndex, votes } = room.gameState;
      if (roundIndex !== currentIndex) return;
      const currentRound = rounds[currentIndex];
      const ownerId = currentRound.owner_id;
      const connectedPlayers = room.players.filter((p) => p.socketId);
      const isSolo = connectedPlayers.length === 1;
      if (!isSolo && socket.id === room.players.find((p) => p.playerId === ownerId)?.socketId) return;
      if (votes[socket.id] !== undefined) return;
      const responseTime = room.gameState.roundStartTime ? Date.now() - room.gameState.roundStartTime : 0;
      votes[socket.id] = { targetPlayerId, responseTime };
      const connectedNonOwner = room.players.filter((p) => p.socketId && String(p.playerId) !== String(ownerId));
      const votersExpected = isSolo ? 1 : connectedNonOwner.length;
      if (Object.keys(votes).length < votersExpected) return;
      const BASE_POINTS = 100;
      const STREAK_BONUS = 50;
      const pointsThisRoundByPlayer = {};
      room.players.forEach((p) => {
        const v = p.socketId ? votes[p.socketId] : null;
        if (!v) {
          pointsThisRoundByPlayer[p.playerId] = 0;
          return;
        }
        const correct = String(v.targetPlayerId) === String(ownerId);
        if (correct) {
          p.streak = (p.streak || 0) + 1;
          p.correctCount = (p.correctCount || 0) + 1;
          p.maxStreak = Math.max(p.maxStreak || 0, p.streak);
          const points = BASE_POINTS + (p.streak - 1) * STREAK_BONUS;
          p.score = (p.score || 0) + points;
          pointsThisRoundByPlayer[p.playerId] = points;
        } else {
          p.streak = 0;
          pointsThisRoundByPlayer[p.playerId] = 0;
        }
      });
      touchRoom(room);
      const roundId = currentRound.id;
      const isDbRound = typeof roundId === 'number';
      if (db.pool && isDbRound) {
        db.recordPlayedVideo(room.code, roundId).catch((err) => console.error('[submit_vote] recordPlayedVideo failed:', err?.message || err));
      }
      const playedSet = roomPlayed.get(room.code);
      if (playedSet) playedSet.add(roundId);
      io.to(room.code).emit('start_reveal', { ownerId, roundIndex });
      const nextIndex = currentIndex + 1;
      const hasNext = nextIndex < rounds.length;
      setTimeout(() => {
        io.to(room.code).emit('reveal_winner', {
          ownerId,
          scores: getPlayerListForRoom(room).map((p) => ({
            playerId: p.playerId,
            username: p.username,
            score: p.score,
            streak: p.streak,
            pointsThisRound: pointsThisRoundByPlayer[p.playerId] ?? 0,
          })),
          hasNextRound: hasNext,
        });
        room.gameState.currentIndex = nextIndex;
        setTimeout(() => sendNextRound(room.code), 1500);
      }, 2500);
    });

    socket.on('request_next_round', (data) => {
      const roomCode = (data?.code || '').toUpperCase();
      const room = getRoomByCode(roomCode);
      if (!room?.gameState) return;
      if (room.hostSocketId !== socket.id) return;
      sendNextRound(roomCode);
    });

    socket.on('disconnect', () => {
      for (const [code, room] of roomsMap.entries()) {
        const p = room.players.find((pl) => pl.socketId === socket.id);
        if (!p) continue;
        p.socketId = null;
        const connected = room.players.filter((pl) => pl.socketId);
        if (connected.length === 0) {
          roomsMap.delete(code);
        } else {
          if (room.hostSocketId === socket.id) room.hostSocketId = connected[0].socketId;
          emitRoomUpdated(room);
        }
        break;
      }
    });

    socket.on('rejoin_room', (data, ack) => {
      const { code, playerId } = data || {};
      const roomCode = (code || '').toUpperCase().trim();
      const room = getRoomByCode(roomCode);
      if (!room) return ack?.({ error: 'Room not found' });
      const me = room.players.find((p) => String(p.playerId) === String(playerId));
      if (!me) return ack?.({ error: 'Player not in this room' });
      if (me.socketId) return ack?.({ error: 'Already connected' });
      me.socketId = socket.id;
      socket.join(roomCode);
      touchRoom(room);
      const { rounds, currentIndex } = room.gameState || {};
      const currentRound = rounds && rounds[currentIndex];
      ack?.({
        ok: true,
        playerId: me.playerId,
        players: getPlayerListForRoom(room),
        reconnected: true,
        isHost: room.hostSocketId === socket.id,
        gameState: room.status === 'playing' || room.status === 'preparing' ? {
          roundIndex: currentIndex,
          totalRounds: rounds?.length || 0,
          videoUrl: currentRound?.video_url,
          ownerId: currentRound?.owner_id,
        } : null,
      });
      emitRoomUpdated(room);
      if (room.status === 'playing' && currentRound) {
        socket.emit('next_round', {
          roundIndex: currentIndex,
          totalRounds: rounds.length,
          videoUrl: currentRound.video_url,
          ownerId: currentRound.owner_id,
          players: getPlayerListForRoom(room),
        });
      }
    });

    socket.on('leave_room', (data) => {
      const roomCode = (data?.code || '').toUpperCase().trim();
      const room = getRoomByCode(roomCode);
      if (!room) return;
      const idx = room.players.findIndex((p) => p.socketId === socket.id);
      if (idx === -1) return;
      room.players.splice(idx, 1);
      socket.leave(roomCode);
      if (room.players.length === 0) {
        roomsMap.delete(roomCode);
      } else {
        if (room.hostSocketId === socket.id) room.hostSocketId = room.players[0].socketId;
        emitRoomUpdated(room);
      }
    });
  });
}

module.exports = { attach };
