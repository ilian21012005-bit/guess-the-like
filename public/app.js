(function () {
  const origin = window.location.origin;
  const socket = io(origin, {
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: 15,
    reconnectionDelay: 2000,
  });
  let roomCode = '';
  let myPlayerId = null;
  let isHost = false;
  let players = [];
  let avatarDataUrl = '';
  /** Cache des vidéos préchargées (url -> Blob ou null si échec). Vidé quand la partie se termine. */
  let preloadCache = new Map();
  const ROOM_CODE_KEY = 'wholiked_room';
  const ROOM_PLAYER_ID_KEY = 'wholiked_playerId';

  const params = new URLSearchParams(window.location.search);
  if (params.get('room')) {
    const codeInput = document.getElementById('input-code');
    if (codeInput) { codeInput.value = params.get('room').toUpperCase().slice(0, 8); codeInput.focus(); }
  }

  function setConnectionStatus(connected) {
    const banner = document.getElementById('reconnect-banner');
    const joinBtn = document.getElementById('btn-join');
    if (banner) banner.classList.toggle('hidden', connected);
    if (joinBtn) joinBtn.disabled = !connected;
  }

  socket.on('connect', () => {
    setConnectionStatus(true);
    const savedCode = localStorage.getItem(ROOM_CODE_KEY);
    const savedPlayerId = localStorage.getItem(ROOM_PLAYER_ID_KEY);
    if (savedCode && savedPlayerId) {
      socket.emit('rejoin_room', { code: savedCode, playerId: savedPlayerId }, (res) => {
        if (res?.error) {
          localStorage.removeItem(ROOM_CODE_KEY);
          localStorage.removeItem(ROOM_PLAYER_ID_KEY);
          return;
        }
        if (res.reconnected) {
          roomCode = savedCode;
          myPlayerId = res.playerId;
          isHost = res.isHost === true;
          players = res.players || [];
          if (res.gameState) {
            show('screen-game');
          } else {
            showLobby();
            show('screen-lobby');
          }
        }
      });
    }
  });
  socket.on('disconnect', () => {
    setConnectionStatus(false);
  });
  setConnectionStatus(socket.connected);

  const $ = (id) => document.getElementById(id);
  function voteKeyHandler(e) {
    if (e.key < '1' || e.key > '9') return;
    const container = $('vote-buttons');
    if (!container || container.classList.contains('hidden')) return;
    const btn = container.querySelector('.vote-btn[data-key="' + e.key + '"]');
    if (btn) btn.click();
  }
  const show = (id) => {
    document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
    const el = $(id);
    if (el) el.classList.remove('hidden');
  };
  const setError = (id, msg) => {
    const el = $(id);
    if (el) { el.textContent = msg || ''; el.classList.toggle('hidden', !msg); }
  };

  function getVideoId(url) {
    const m = (url || '').match(/\/video\/(\d+)/);
    return m ? m[1] : null;
  }

  function getAvatarUrl() {
    if (avatarDataUrl) return avatarDataUrl;
    const u = $('input-avatar') && $('input-avatar').value.trim();
    return u || '';
  }

  const avatarPreview = $('avatar-preview');
  const avatarFileInput = $('input-avatar-file');
  if (avatarFileInput) {
    avatarFileInput.addEventListener('change', function () {
      const f = this.files && this.files[0];
      if (!f || !f.type.startsWith('image/')) { avatarDataUrl = ''; if (avatarPreview) { avatarPreview.src = ''; avatarPreview.classList.add('hidden'); } return; }
      const r = new FileReader();
      r.onload = function () { avatarDataUrl = r.result; if (avatarPreview) { avatarPreview.src = avatarDataUrl; avatarPreview.classList.remove('hidden'); } };
      r.readAsDataURL(f);
    });
  }
  if ($('input-avatar')) {
    $('input-avatar').addEventListener('input', function () {
      avatarDataUrl = '';
      const u = this.value.trim();
      if (avatarPreview) { if (u) { avatarPreview.src = u; avatarPreview.classList.remove('hidden'); } else { avatarPreview.src = ''; avatarPreview.classList.add('hidden'); } }
    });
  }

  // --- Home
  $('btn-create').addEventListener('click', () => {
    const username = $('input-username').value.trim();
    setError('home-error', '');
    if (!username) { setError('home-error', 'Entre un pseudo'); return; }
    const tiktokUsername = $('input-tiktok').value.trim() || username;
    const avatarUrl = getAvatarUrl();
    socket.emit('create_room', { username, tiktokUsername, avatarUrl: avatarUrl || undefined }, (res) => {
      if (res?.error) { setError('home-error', res.error); return; }
      roomCode = res.code;
      myPlayerId = res.playerId;
      isHost = true;
      players = res.players || [];
      localStorage.setItem(ROOM_CODE_KEY, roomCode);
      localStorage.setItem(ROOM_PLAYER_ID_KEY, String(myPlayerId));
      showLobby();
      show('screen-lobby');
    });
  });

  $('btn-join').addEventListener('click', () => {
    const username = $('input-username').value.trim();
    const code = $('input-code').value.trim().toUpperCase();
    setError('home-error', '');
    if (!username) { setError('home-error', 'Entre un pseudo'); return; }
    if (!code) { setError('home-error', 'Entre le code du salon'); return; }
    if (!socket.connected) {
      setError('home-error', 'Connexion au serveur en cours… Attends quelques secondes (bannière « Reconnexion » en haut) puis réessaie.');
      return;
    }
    const tiktokUsername = $('input-tiktok').value.trim() || username;
    const avatarUrl = getAvatarUrl();
    const joinBtn = $('btn-join');
    const prevText = joinBtn ? joinBtn.textContent : '';
    if (joinBtn) { joinBtn.disabled = true; joinBtn.textContent = 'Connexion…'; }
    const timeoutId = setTimeout(function () {
      setError('home-error', 'Le serveur met trop de temps à répondre. Sur un hébergement gratuit il peut mettre jusqu’à 1 min à démarrer — réessaie dans un moment.');
      if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = prevText; }
    }, 65000);
    socket.emit('join_room', { code, username, tiktokUsername, avatarUrl: avatarUrl || undefined }, (res) => {
      clearTimeout(timeoutId);
      if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = prevText; }
      if (res?.error) { setError('home-error', res.error); return; }
      roomCode = code;
      myPlayerId = res.playerId;
      isHost = false;
      players = res.players || [];
      localStorage.setItem(ROOM_CODE_KEY, roomCode);
      localStorage.setItem(ROOM_PLAYER_ID_KEY, String(myPlayerId));
      showLobby();
      show('screen-lobby');
    });
  });

  function showLobby() {
    $('lobby-code').textContent = roomCode;
    const opts = $('lobby-options');
    if (opts) opts.classList.toggle('hidden', !isHost);
    $('lobby-players').innerHTML = (players || []).map(p => {
      const readyStr = p.isReady ? '✓ Prêt' : '...';
      const countStr = (p.playableCount !== undefined && p.playableCount !== null) ? ` · ${p.playableCount} vidéo(s) jouable(s)` : '';
      return `<li>
        <span>${escapeHtml(p.username)}</span>
        <span class="${p.isReady ? 'ready' : ''}">${readyStr}${countStr}</span>
      </li>`;
    }).join('');
    $('lobby-status').textContent = '';
    setError('lobby-error', '');
    const hostBtn = $('btn-start');
    if (hostBtn) {
      hostBtn.classList.toggle('host-only', !isHost);
      hostBtn.classList.toggle('hidden', !isHost);
    }
  }

  socket.on('room_updated', (data) => {
    if (data.players) players = data.players;
    if (document.getElementById('screen-lobby') && !document.getElementById('screen-lobby').classList.contains('hidden')) {
      showLobby();
    }
  });

  $('btn-copy-code').addEventListener('click', () => {
    if (!roomCode) return;
    navigator.clipboard.writeText(roomCode).then(() => {
      const btn = $('btn-copy-code');
      if (btn) { btn.textContent = '✓ Copié !'; setTimeout(() => { btn.textContent = '📋 Copier'; }, 2000); }
    });
  });

  const stepsDetail = document.getElementById('steps-detail');
  const btnToggleSteps = document.getElementById('btn-toggle-steps');
  if (btnToggleSteps && stepsDetail) {
    btnToggleSteps.addEventListener('click', () => {
      const hidden = stepsDetail.hidden;
      stepsDetail.hidden = !hidden;
      btnToggleSteps.textContent = hidden ? 'Masquer le détail' : 'Voir le détail';
      btnToggleSteps.setAttribute('aria-expanded', !!hidden);
    });
  }

  const TIKTOK_SCRIPT = [
    "(function(){",
    "  var links = Array.from(document.querySelectorAll('a[href*=\"/video/\"]')).map(function(a){ return a.href; });",
    "  var urls = [...new Set(links)];",
    "  var text = urls.join('\\n');",
    "  function fallback(){",
    "    var ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;'; document.body.appendChild(ta); ta.select();",
    "    try { document.execCommand('copy'); alert('Copié ! ' + urls.length + ' liens. Reviens au jeu et colle (Ctrl+V).'); }",
    "    catch(e) { var w = window.open('','_blank'); w.document.write('<pre style=\"padding:1rem;white-space:pre-wrap\">' + text.replace(/</g,'&lt;') + '</pre><p>Copie tout (Ctrl+A Ctrl+C) puis colle dans le jeu.</p>'); }",
    "    document.body.removeChild(ta);",
    "  }",
    "  if (navigator.clipboard && navigator.clipboard.writeText) {",
    "    navigator.clipboard.writeText(text).then(function(){ alert('Copié ! ' + urls.length + ' liens. Reviens au jeu et colle (Ctrl+V).'); }).catch(fallback);",
    "  } else { fallback(); }",
    "})();"
  ].join("");

  const copyFeedback = document.getElementById('copy-script-feedback');
  $('btn-copy-script').addEventListener('click', () => {
    navigator.clipboard.writeText(TIKTOK_SCRIPT).then(() => {
      if (copyFeedback) {
        copyFeedback.textContent = 'Script copié ! Va sur TikTok → F12 → Console → Ctrl+V → Entrée.';
        copyFeedback.classList.remove('hidden');
        copyFeedback.className = 'copy-feedback';
        setTimeout(() => { copyFeedback.classList.add('hidden'); }, 5000);
      }
    }).catch(() => {
      if (copyFeedback) {
        copyFeedback.textContent = 'Copie manuelle : sélectionne le script affiché dans la console du navigateur.';
        copyFeedback.classList.remove('hidden');
      }
    });
  });

  $('btn-import-links').addEventListener('click', () => {
    const text = ($('import-links') && $('import-links').value) || '';
    setError('lobby-error', '');
    $('lobby-status').textContent = '';
    socket.emit('import_likes', { code: roomCode, urlsText: text }, (res) => {
      if (res?.error) {
        setError('lobby-error', res.error);
        return;
      }
      $('lobby-status').textContent = '✓ ' + (res.count || 0) + ' lien(s) importés. Tu peux lancer la partie.';
    });
  });

  socket.on('harvest_done', (data) => {
    $('lobby-status').textContent = (data.count ? `✓ ${data.count} likes récupérés.` : '✓ C\'est bon.') + ' Tu peux repasser en privé.';
  });

  $('btn-start').addEventListener('click', () => {
    setError('lobby-error', '');
    const totalRounds = parseInt($('select-rounds')?.value, 10) || 50;
    socket.emit('start_game', { code: roomCode, totalRounds }, (res) => {
      if (res?.error) {
        setError('lobby-error', res.error);
        return;
      }
    });
  });

  socket.on('game_preparing', (data) => {
    const total = data.totalRounds || (data.roundUrls || []).length;
    const preloadTotal = data.preloadTotal != null ? data.preloadTotal : total;
    if (total === 0) return;
    preloadCache.clear();
    const progressEl = $('preload-progress');
    const barEl = $('preload-bar');
    show('screen-preload');
    if (progressEl) progressEl.textContent = '0 / ' + preloadTotal;
    if (barEl) {
      barEl.style.width = '0%';
      barEl.setAttribute('aria-valuenow', 0);
      barEl.setAttribute('aria-valuemax', preloadTotal);
    }
    const bgMsg = $('preload-background-msg');
    if (bgMsg) bgMsg.classList.add('hidden');
  });

  socket.on('preload_progress', (data) => {
    if ((data.roomCode || '').toUpperCase() !== roomCode) return;
    const progressEl = $('preload-progress');
    const barEl = $('preload-bar');
    const loaded = data.loaded != null ? data.loaded : 0;
    const total = data.total != null ? data.total : 0;
    if (barEl) {
      barEl.setAttribute('aria-valuenow', loaded);
      barEl.setAttribute('aria-valuemax', total || 1);
    }
    if (progressEl) progressEl.textContent = loaded + ' / ' + (total || 1);
    if (barEl) barEl.style.width = (total ? Math.round((loaded / total) * 100) : 0) + '%';
    if (loaded >= 2 && total > 2) {
      const bgMsg = $('preload-background-msg');
      if (bgMsg) bgMsg.classList.remove('hidden');
    }
  });

  socket.on('game_started', (data) => {
    players = data.players || [];
    show('screen-countdown');
    startCountdown();
  });

  // Premier round : envoyé une seule fois à la fin du décompte (guard anti-double).
  function startCountdown() {
    const el = $('countdown-number');
    let n = 3;
    el.textContent = n;
    var firstRoundRequested = false;
    const t = setInterval(() => {
      n--;
      if (n <= 0) {
        clearInterval(t);
        if (!firstRoundRequested && isHost && roomCode) {
          firstRoundRequested = true;
          socket.emit('request_next_round', { code: roomCode });
        }
        return;
      }
      el.textContent = n;
      el.style.animation = 'none';
      el.offsetHeight;
      el.style.animation = 'pulse 0.8s ease-out';
    }, 1000);
  }

  socket.on('next_round', (data) => {
    const { roundIndex, totalRounds, videoUrl, ownerId, players: p } = data;
    if (p) players = p;
    $('round-num').textContent = (roundIndex + 1);
    $('round-total').textContent = totalRounds;
    const videoId = getVideoId(videoUrl);
    const videoEl = $('tiktok-video');
    const iframe = $('tiktok-embed');
    const iframeWrap = document.querySelector('.video-fallback-embed');
    const loadingEl = $('video-loading');
    const linkOpen = $('video-open-tiktok');
    const volumeControl = $('volume-control');
    const btnVolume = $('btn-volume');

    if (videoEl) { videoEl.src = ''; videoEl.style.display = 'none'; videoEl.onerror = null; videoEl.muted = true; }
    if (volumeControl) volumeControl.style.display = 'none';
    if (iframeWrap) iframeWrap.style.display = 'none';
    if (loadingEl) { loadingEl.textContent = 'Extraction de la vidéo en cours…'; loadingEl.classList.remove('hidden'); loadingEl.style.display = 'block'; }
    if (linkOpen) linkOpen.style.display = 'none';
    if (iframe) iframe.src = '';

    if (!videoUrl) {
      if (loadingEl) { loadingEl.classList.add('hidden'); loadingEl.style.display = 'none'; }
      if (linkOpen) { linkOpen.href = '#'; linkOpen.style.display = 'none'; }
    } else {
      if (linkOpen) { linkOpen.href = videoUrl; linkOpen.style.display = 'block'; }
      if (videoEl) {
        const cached = preloadCache.get(videoUrl);
        function applyBlob(blob) {
          if (!blob) {
            if (loadingEl) { loadingEl.textContent = 'Vidéo indisponible. Ouvre le lien ci-dessous.'; loadingEl.classList.remove('hidden'); }
            if (linkOpen) { linkOpen.style.display = 'block'; linkOpen.href = videoUrl; }
            return;
          }
          const blobUrl = URL.createObjectURL(blob);
          videoEl.src = blobUrl;
          videoEl.onloadeddata = function () {
            if (loadingEl) { loadingEl.classList.add('hidden'); loadingEl.style.display = 'none'; }
            if (iframeWrap) iframeWrap.style.display = 'none';
            videoEl.style.display = 'block';
            if (volumeControl) volumeControl.style.display = 'flex';
            if (window.applyStoredVolumeToVideo) window.applyStoredVolumeToVideo();
            videoEl.play().catch(() => {
              if (videoEl) videoEl.title = 'Clique pour lancer la lecture';
            });
          };
          videoEl.onerror = function () {
            videoEl.style.display = 'none';
            if (loadingEl) { loadingEl.textContent = 'Vidéo illisible. Ouvre le lien ci-dessous.'; loadingEl.classList.remove('hidden'); loadingEl.style.display = 'block'; }
            if (linkOpen) { linkOpen.href = videoUrl; linkOpen.style.display = 'block'; }
            if (iframeWrap) iframeWrap.style.display = 'none';
            if (socket && roomCode != null && roundIndex != null && videoUrl) {
              socket.emit('video_play_failed', { code: roomCode, roundIndex, videoUrl });
            }
          };
          videoEl.load();
        }
        if (cached !== undefined) {
          if (cached === null) {
            if (loadingEl) { loadingEl.textContent = 'Vidéo indisponible. Lien TikTok ci-dessous.'; loadingEl.classList.remove('hidden'); loadingEl.style.display = 'block'; }
          } else {
            if (loadingEl) { loadingEl.classList.add('hidden'); loadingEl.style.display = 'none'; }
            applyBlob(cached);
          }
        } else {
          const apiUrl = '/api/tiktok-video?url=' + encodeURIComponent(videoUrl) + '&room=' + encodeURIComponent(roomCode) + '&index=' + roundIndex;
          fetch(apiUrl)
            .then(function (res) {
              if (!res.ok) {
                var msg = res.status === 403 ? 'TikTok bloque la lecture (403). Ouvre le lien ci-dessous.' : 'Vidéo indisponible (serveur ' + res.status + '). Lien TikTok ci-dessous.';
                if (loadingEl) { loadingEl.textContent = msg; loadingEl.classList.remove('hidden'); }
                return null;
              }
              var ct = res.headers.get('Content-Type') || '';
              // Fallback JSON : le serveur renvoie { fallbackUrl } si l'extraction MP4 a échoué / time-out.
              if (ct.indexOf('application/json') !== -1) {
                return res.json().then(function (data) {
                  if (data && data.fallbackUrl) {
                    if (loadingEl) { loadingEl.textContent = 'Vidéo indisponible. Ouvre le lien ci-dessous.'; loadingEl.classList.remove('hidden'); loadingEl.style.display = 'block'; }
                    if (linkOpen) { linkOpen.href = data.fallbackUrl; linkOpen.style.display = 'block'; }
                    if (videoEl) videoEl.style.display = 'none';
                    if (iframeWrap) iframeWrap.style.display = 'none';
                  } else if (loadingEl) {
                    loadingEl.textContent = 'Vidéo indisponible. Ouvre le lien ci-dessous.';
                    loadingEl.classList.remove('hidden');
                  }
                  return null;
                });
              }
              return res.blob();
            })
            .then(applyBlob)
            .catch(function () {
              if (loadingEl) { loadingEl.textContent = 'Vidéo indisponible (réseau). Ouvre le lien ci-dessous.'; loadingEl.classList.remove('hidden'); loadingEl.style.display = 'block'; }
              if (linkOpen) { linkOpen.href = videoUrl; linkOpen.style.display = 'block'; }
            });
        }
      }
    }
    const isOwner = myPlayerId === ownerId;
    const isSolo = (players || []).length === 1;
    const canVote = isSolo || !isOwner;
    const waitOwnerEl = $('wait-owner');
    if (waitOwnerEl) {
      waitOwnerEl.classList.add('hidden');
      if (isOwner && !isSolo) waitOwnerEl.classList.remove('hidden');
    }
    const ownerHint = $('vote-owner-hint');
    const voteFeedback = $('vote-feedback');
    if (ownerHint) ownerHint.classList.add('hidden');
    if (voteFeedback) voteFeedback.classList.add('hidden');
    const container = $('vote-buttons');
    container.classList.toggle('hidden', !canVote);
    if (canVote) {
      const list = isSolo ? (players || []) : (players || []).filter(p => p.playerId !== myPlayerId);
      container.innerHTML = list.map((pl, idx) => `
        <button type="button" class="vote-btn" data-player-id="${escapeAttr(pl.playerId)}" data-username="${escapeAttr(pl.username)}" data-key="${idx + 1}">${escapeHtml(pl.username)}</button>
      `).join('');
      container.querySelectorAll('button').forEach(btn => {
        btn.onclick = () => {
          const targetName = btn.dataset.username || '';
          socket.emit('submit_vote', { code: roomCode, targetPlayerId: btn.dataset.playerId, roundIndex });
          container.innerHTML = '';
          container.classList.add('hidden');
          if (voteFeedback) { voteFeedback.textContent = 'Tu as voté pour ' + targetName; voteFeedback.classList.remove('hidden'); }
          if (navigator.vibrate) navigator.vibrate(50);
        };
      });
      document.addEventListener('keydown', voteKeyHandler);
    } else {
      document.removeEventListener('keydown', voteKeyHandler);
    }
    const scoresEl = $('scores-inline');
    if (scoresEl) scoresEl.innerHTML = (players || []).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5).map((pl, i) => {
      const str = (pl.streak && pl.streak > 1) ? ` (×${pl.streak})` : '';
      return `${i + 1}. ${pl.username} ${pl.score || 0}${str}`;
    }).join(' · ');
    show('screen-game');
  });

  let rouletteTimer = null;
  socket.on('start_reveal', (data) => {
    document.removeEventListener('keydown', voteKeyHandler);
    show('screen-reveal');
    const avatarEl = $('roulette-avatar');
    const nameEl = $('roulette-name');
    nameEl.textContent = '...';
    let index = 0;
    const container = $('roulette-container');
    const cycle = () => {
      if (rouletteTimer === null) return;
      if (container) { container.classList.add('roulette-tick'); setTimeout(() => container.classList.remove('roulette-tick'), 80); }
      const p = players[index % players.length];
      nameEl.textContent = p.username;
      avatarEl.src = p.avatarUrl || 'https://api.dicebear.com/7.x/avataaars/svg?seed=' + encodeURIComponent(p.username);
      avatarEl.alt = p.username;
      index++;
      rouletteTimer = setTimeout(cycle, 120);
    };
    rouletteTimer = setTimeout(cycle, 80);
  });

  socket.on('reveal_winner', (data) => {
    if (rouletteTimer) { clearTimeout(rouletteTimer); rouletteTimer = null; }
    if (navigator.vibrate) navigator.vibrate([50, 30, 50]);
    const { ownerId, scores, hasNextRound } = data;
    const owner = (players || []).find(p => p.playerId === ownerId);
    if (owner) {
      $('roulette-name').textContent = owner.username;
      $('roulette-avatar').src = owner.avatarUrl || 'https://api.dicebear.com/7.x/avataaars/svg?seed=' + encodeURIComponent(owner.username);
      $('roulette-avatar').alt = owner.username;
    }
    const scoresEl = $('reveal-scores');
    if (scoresEl) scoresEl.innerHTML = (scores || []).sort((a, b) => (b.score || 0) - (a.score || 0)).map(s => {
      const streakStr = (s.streak && s.streak > 1) ? ` <small>(×${s.streak})</small>` : '';
      const ptsGained = (s.pointsThisRound != null && s.pointsThisRound > 0) ? ` <small class="pts-gained">(+${s.pointsThisRound})</small>` : '';
      return `<div><span>${escapeHtml(s.username)}${streakStr}</span><span>${s.score || 0} pts${ptsGained}</span></div>`;
    }).join('');
    const btnNext = $('btn-next-round');
    const waitHostEl = $('reveal-wait-host');
    if (btnNext) btnNext.classList.add('hidden');
    if (waitHostEl) waitHostEl.classList.add('hidden');
    if (hasNextRound) {
      let msg = $('reveal-auto-msg');
      if (!msg) {
        msg = document.createElement('p');
        msg.id = 'reveal-auto-msg';
        msg.className = 'reveal-auto-next';
        if ($('reveal-next-area')) $('reveal-next-area').appendChild(msg);
      }
      if (msg) { msg.textContent = 'Prochaine vidéo dans 1 seconde…'; msg.classList.remove('hidden'); }
    }
  });

  let lastGameOver = null;
  socket.on('game_over', (data) => {
    preloadCache.clear();
    localStorage.removeItem(ROOM_CODE_KEY);
    localStorage.removeItem(ROOM_PLAYER_ID_KEY);
    const scores = (data.scores || []).sort((a, b) => (b.score || 0) - (a.score || 0));
    lastGameOver = { scores, totalRounds: data.totalRounds || 0 };
    const totalRounds = lastGameOver.totalRounds || scores.length;
    const myScore = scores.find(s => s.playerId === myPlayerId);
    const statsEl = $('gameover-stats');
    if (statsEl && myScore) {
      const correct = myScore.correctCount ?? 0;
      const streak = myScore.maxStreak ?? 0;
      statsEl.innerHTML = '<p>Tu as deviné <strong>' + correct + '</strong> / ' + totalRounds + ' — Meilleure série : <strong>' + streak + '</strong></p>';
      statsEl.classList.remove('hidden');
    }
    $('podium-list').innerHTML = scores.map((s, i) => `
      <li><span>${i + 1}. ${escapeHtml(s.username)}</span><span>${s.score || 0} pts</span></li>
    `).join('');
    show('screen-gameover');
    document.removeEventListener('keydown', voteKeyHandler);
  });

  $('btn-share-score').addEventListener('click', () => {
    const myScore = lastGameOver?.scores?.find(s => s.playerId === myPlayerId);
    const text = myScore
      ? 'WhoLiked — ' + myScore.username + ' : ' + (myScore.score || 0) + ' pts (deviné ' + (myScore.correctCount ?? 0) + '/' + (lastGameOver.totalRounds || 0) + ')'
      : 'WhoLiked — Devine qui a liké ce TikTok !';
    const url = window.location.href.split('?')[0];
    if (navigator.share) {
      navigator.share({ title: 'WhoLiked', text, url })
        .then(() => {
          const btn = $('btn-share-score');
          if (btn) { btn.textContent = '✓ Partagé !'; setTimeout(() => { btn.textContent = 'Partager mon score'; }, 2000); }
        })
        .catch(() => {
          navigator.clipboard.writeText(text + ' ' + url).then(() => {
            const btn = $('btn-share-score');
            if (btn) { btn.textContent = '✓ Copié !'; setTimeout(() => { btn.textContent = 'Partager mon score'; }, 2000); }
          });
        });
    } else {
      navigator.clipboard.writeText(text + ' ' + url).then(() => {
        const btn = $('btn-share-score');
        if (btn) { btn.textContent = '✓ Copié !'; setTimeout(() => { btn.textContent = 'Partager mon score'; }, 2000); }
      });
    }
  });

  $('btn-replay').addEventListener('click', () => {
    show('screen-lobby');
    showLobby();
  });

  $('btn-lobby').addEventListener('click', () => {
    show('screen-lobby');
    showLobby();
  });

  function quitGame() {
    if (roomCode) socket.emit('leave_room', { code: roomCode });
    localStorage.removeItem(ROOM_CODE_KEY);
    localStorage.removeItem(ROOM_PLAYER_ID_KEY);
    roomCode = '';
    myPlayerId = null;
    players = [];
    isHost = false;
    document.removeEventListener('keydown', voteKeyHandler);
    show('screen-home');
  }
  const btnQuitGame = $('btn-quit-game');
  const btnQuitGameReveal = $('btn-quit-game-reveal');
  if (btnQuitGame) btnQuitGame.addEventListener('click', quitGame);
  if (btnQuitGameReveal) btnQuitGameReveal.addEventListener('click', quitGame);

  (function () {
    const btn = $('btn-volume');
    const slider = $('volume-slider');
    const video = $('tiktok-video');
    const VOLUME_KEY = 'guess-the-like-volume';
    const MUTED_KEY = 'guess-the-like-muted';
    function getStoredVolume() {
      var v = localStorage.getItem(VOLUME_KEY);
      if (v != null) { var n = parseInt(v, 10); if (!isNaN(n) && n >= 0 && n <= 100) return n; }
      return 100;
    }
    function getStoredMuted() {
      var v = localStorage.getItem(MUTED_KEY);
      if (v === null) return true;
      return v === '1';
    }
    function setStoredVolume(n) { localStorage.setItem(VOLUME_KEY, String(n)); }
    function setStoredMuted(m) { localStorage.setItem(MUTED_KEY, m ? '1' : '0'); }
    function updateIcon() {
      if (!btn || !video) return;
      if (video.muted) {
        btn.textContent = '🔇';
        btn.title = 'Activer le son';
      } else {
        var pct = Math.round(video.volume * 100);
        if (pct <= 0) { btn.textContent = '🔇'; btn.title = 'Volume'; }
        else if (pct < 50) { btn.textContent = '🔈'; btn.title = 'Volume ' + pct + '%'; }
        else { btn.textContent = '🔊'; btn.title = 'Volume ' + pct + '%'; }
      }
    }
    function applyStoredToVideo() {
      if (!video) return;
      var vol = getStoredVolume();
      var muted = getStoredMuted();
      video.volume = vol / 100;
      video.muted = muted;
      if (slider) slider.value = vol;
      updateIcon();
    }
    window.applyStoredVolumeToVideo = applyStoredToVideo;
    if (btn && video) {
      applyStoredToVideo();
      btn.addEventListener('click', function () {
        video.muted = !video.muted;
        setStoredMuted(video.muted);
        if (!video.muted && slider) video.volume = parseInt(slider.value, 10) / 100;
        updateIcon();
      });
    }
    if (slider && video) {
      slider.addEventListener('input', function () {
        var val = parseInt(slider.value, 10);
        video.volume = val / 100;
        if (val > 0) { video.muted = false; setStoredMuted(false); }
        else { video.muted = true; setStoredMuted(true); }
        setStoredVolume(val);
        updateIcon();
      });
    }
  })();

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[app] Service Worker registration failed:', err?.message || err);
    });
  }
})();
