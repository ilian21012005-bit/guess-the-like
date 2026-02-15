(function () {
  const socket = io(window.location.origin);
  let roomCode = '';
  let myPlayerId = null;
  let isHost = false;
  let players = [];
  let avatarDataUrl = '';

  const params = new URLSearchParams(window.location.search);
  if (params.get('room')) {
    const codeInput = document.getElementById('input-code');
    if (codeInput) { codeInput.value = params.get('room').toUpperCase().slice(0, 8); codeInput.focus(); }
  }

  socket.on('connect', () => {
    const banner = document.getElementById('reconnect-banner');
    if (banner) banner.classList.add('hidden');
  });
  socket.on('disconnect', () => {
    const banner = document.getElementById('reconnect-banner');
    if (banner) banner.classList.remove('hidden');
  });

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
    const tiktokUsername = $('input-tiktok').value.trim() || username;
    const avatarUrl = getAvatarUrl();
    socket.emit('join_room', { code, username, tiktokUsername, avatarUrl: avatarUrl || undefined }, (res) => {
      if (res?.error) { setError('home-error', res.error); return; }
      roomCode = code;
      myPlayerId = res.playerId;
      isHost = false;
      players = res.players || [];
      showLobby();
      show('screen-lobby');
    });
  });

  function showLobby() {
    $('lobby-code').textContent = roomCode;
    const opts = $('lobby-options');
    if (opts) opts.classList.toggle('hidden', !isHost);
    $('lobby-players').innerHTML = (players || []).map(p => `
      <li>
        <span>${escapeHtml(p.username)}</span>
        <span class="${p.isReady ? 'ready' : ''}">${p.isReady ? '✓ Prêt' : '...'}</span>
      </li>
    `).join('');
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

  $('btn-ready').addEventListener('click', () => {
    $('lobby-status').textContent = 'Récupération de tes likes en cours…';
    setError('lobby-error', '');
    socket.emit('set_ready', { code: roomCode }, (res) => {
      if (res?.error) {
        $('lobby-status').textContent = '';
        if (res.error === 'PRIVACY_LOCKED') setError('lobby-error', 'Likes en privé. Passe-les en public sur TikTok puis réessaie.');
        else if (res.error === 'LOGIN_REQUIRED') setError('lobby-error', 'TikTok affiche les likes seulement quand on est connecté. Utilise l’import manuel (voir ci-dessous).');
        else setError('lobby-error', res.error || 'Erreur');
        return;
      }
      $('lobby-status').textContent = res.count ? `✓ ${res.count} likes récupérés. Tu peux repasser en privé.` : '✓ C\'est bon.';
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
      show('screen-countdown');
      startCountdown();
    });
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
    const btnVolume = $('btn-volume');

    if (videoEl) { videoEl.src = ''; videoEl.style.display = 'none'; videoEl.onerror = null; videoEl.muted = true; }
    if (btnVolume) { btnVolume.style.display = 'none'; btnVolume.textContent = '🔇'; }
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
        const loadStartMs = performance.now();
        videoEl.onloadeddata = function () {
          const loadEndMs = performance.now();
          const durationMs = Math.round(loadEndMs - loadStartMs);
          console.log('[MP4] Vidéo prête en ' + durationMs + ' ms (round ' + (roundIndex + 1) + ')');
          if (loadingEl) { loadingEl.classList.add('hidden'); loadingEl.style.display = 'none'; }
          if (iframeWrap) iframeWrap.style.display = 'none';
          videoEl.style.display = 'block';
          if (btnVolume) btnVolume.style.display = 'flex';
          videoEl.play().catch(() => {});
        };
        videoEl.onerror = function () {
          const durationMs = Math.round(performance.now() - loadStartMs);
          console.warn('[MP4] Échec chargement après ' + durationMs + ' ms (round ' + (roundIndex + 1) + ')');
          if (loadingEl) { loadingEl.textContent = 'Vidéo indisponible (MP4). Lien TikTok ci-dessous.'; loadingEl.classList.remove('hidden'); }
        };
        videoEl.src = '/api/tiktok-video?url=' + encodeURIComponent(videoUrl);
        videoEl.load();
      }
    }
    const isOwner = myPlayerId === ownerId;
    const isSolo = (players || []).length === 1;
    const canVote = isSolo || !isOwner;
    $('wait-owner').classList.toggle('hidden', canVote);
    const ownerHint = $('vote-owner-hint');
    const voteFeedback = $('vote-feedback');
    if (ownerHint) ownerHint.classList.add('hidden');
    if (voteFeedback) voteFeedback.classList.add('hidden');
    if (canVote && !isSolo) {
      const owner = (players || []).find(p => p.playerId === ownerId);
      if (ownerHint && owner) { ownerHint.textContent = 'C\'est le like de ' + owner.username + ' — devine qui a liké !'; ownerHint.classList.remove('hidden'); }
    }
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
    const cycle = () => {
      if (rouletteTimer === null) return;
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
      ? 'Guess The Like — ' + myScore.username + ' : ' + (myScore.score || 0) + ' pts (deviné ' + (myScore.correctCount ?? 0) + '/' + (lastGameOver.totalRounds || 0) + ')'
      : 'Guess The Like — Devine qui a liké ce TikTok !';
    const url = window.location.href.split('?')[0];
    if (navigator.share && navigator.canShare?.({ text, url })) {
      navigator.share({ title: 'Guess The Like', text, url }).catch(() => {});
    } else {
      navigator.clipboard.writeText(text + ' ' + url).then(() => {
        const btn = $('btn-share-score');
        if (btn) { btn.textContent = '✓ Lien copié !'; setTimeout(() => { btn.textContent = 'Partager mon score'; }, 2000); }
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

  (function () {
    const btn = $('btn-volume');
    const video = $('tiktok-video');
    if (btn && video) {
      btn.addEventListener('click', function () {
        video.muted = !video.muted;
        btn.textContent = video.muted ? '🔇' : '🔊';
        btn.title = video.muted ? 'Activer le son' : 'Couper le son';
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
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
