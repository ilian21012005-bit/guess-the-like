(function () {
  const socket = io(window.location.origin);
  let roomCode = '';
  let myPlayerId = null;
  let isHost = false;
  let players = [];

  const $ = (id) => document.getElementById(id);
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

  // --- Home
  $('btn-create').addEventListener('click', () => {
    const username = $('input-username').value.trim();
    setError('home-error', '');
    if (!username) { setError('home-error', 'Entre un pseudo'); return; }
    const tiktokUsername = $('input-tiktok').value.trim() || username;
    socket.emit('create_room', { username, tiktokUsername }, (res) => {
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
    socket.emit('join_room', { code, username, tiktokUsername }, (res) => {
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
    socket.emit('start_game', { code: roomCode }, (res) => {
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

    if (videoEl) { videoEl.src = ''; videoEl.style.display = 'none'; videoEl.onerror = null; }
    if (iframe) iframe.src = '';
    if (iframeWrap) iframeWrap.style.display = 'none';
    if (loadingEl) { loadingEl.textContent = 'Chargement de la vidéo…'; loadingEl.classList.remove('hidden'); loadingEl.style.display = 'block'; }

    var loadingSafety = null;
    var proxyFallbackTimer = null;
    let loadingSafetyDone = false;
    function showIframeFallback() {
      if (loadingSafetyDone) return;
      loadingSafetyDone = true;
      if (loadingSafety) { clearTimeout(loadingSafety); loadingSafety = null; }
      if (proxyFallbackTimer) { clearTimeout(proxyFallbackTimer); proxyFallbackTimer = null; }
      if (loadingEl) loadingEl.style.display = 'none';
      if (videoEl) { videoEl.src = ''; videoEl.style.display = 'none'; videoEl.onerror = null; }
      if (videoId && iframe) {
        iframe.src = 'https://www.tiktok.com/embed/v2/' + videoId + '?lang=fr-FR&autoplay=1';
        if (iframeWrap) iframeWrap.style.display = 'block';
      }
      if (linkOpen && videoUrl) { linkOpen.href = videoUrl; linkOpen.style.display = 'block'; }
    }

    if (!videoUrl) {
      if (loadingEl) loadingEl.style.display = 'none';
      if (linkOpen) { linkOpen.href = '#'; linkOpen.style.display = 'none'; }
    } else {
      if (linkOpen) { linkOpen.href = videoUrl; linkOpen.style.display = 'block'; }
      loadingSafety = setTimeout(function () {
        loadingSafety = null;
        if (!loadingSafetyDone) showIframeFallback();
      }, 8000);
      const ac = new AbortController();
      const fetchTimeout = setTimeout(() => ac.abort(), 8000);
      fetch('/api/tiktok-mp4?url=' + encodeURIComponent(videoUrl), { signal: ac.signal })
        .then(function (r) { clearTimeout(fetchTimeout); return r.json(); })
        .then(function (j) {
          if (!j.url || !j.url.startsWith('http')) { showIframeFallback(); return; }
          if (!videoEl) { showIframeFallback(); return; }
          videoEl.onloadeddata = function () {
            if (loadingSafety) { clearTimeout(loadingSafety); loadingSafety = null; }
            if (proxyFallbackTimer) { clearTimeout(proxyFallbackTimer); proxyFallbackTimer = null; }
            loadingSafetyDone = true;
            if (loadingEl) loadingEl.style.display = 'none';
            if (iframeWrap) iframeWrap.style.display = 'none';
            videoEl.style.display = 'block';
            videoEl.play().catch(() => {});
          };
          videoEl.onerror = function () { showIframeFallback(); };
          videoEl.src = '/api/tiktok-video-proxy?url=' + encodeURIComponent(j.url);
          videoEl.load();
          proxyFallbackTimer = setTimeout(function () {
            proxyFallbackTimer = null;
            if (!loadingSafetyDone && videoEl.readyState < 2) showIframeFallback();
          }, 5000);
        })
        .catch(function () {
          clearTimeout(fetchTimeout);
          showIframeFallback();
        });
    }
    // Phase test : tout le monde peut voter, y compris pour soi (propriétaire du like).
    const canVote = true;
    $('wait-owner').classList.add('hidden');
    const container = $('vote-buttons');
    container.classList.remove('hidden');
    container.innerHTML = (players || []).map(pl => `
      <button type="button" data-player-id="${escapeAttr(pl.playerId)}">${escapeHtml(pl.username)}</button>
    `).join('');
    container.querySelectorAll('button').forEach(btn => {
      btn.onclick = () => {
        socket.emit('submit_vote', { code: roomCode, targetPlayerId: btn.dataset.playerId, roundIndex });
        container.innerHTML = '';
        container.classList.add('hidden');
      };
    });
    const scoresEl = $('scores-inline');
    if (scoresEl) scoresEl.innerHTML = (players || []).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5).map((pl, i) => `${i + 1}. ${pl.username} ${pl.score || 0}`).join(' · ');
    show('screen-game');
  });

  let rouletteTimer = null;
  socket.on('start_reveal', (data) => {
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
    const { ownerId, scores, hasNextRound } = data;
    const owner = (players || []).find(p => p.playerId === ownerId);
    if (owner) {
      $('roulette-name').textContent = owner.username;
      $('roulette-avatar').src = owner.avatarUrl || 'https://api.dicebear.com/7.x/avataaars/svg?seed=' + encodeURIComponent(owner.username);
      $('roulette-avatar').alt = owner.username;
    }
    const scoresEl = $('reveal-scores');
    if (scoresEl) scoresEl.innerHTML = (scores || []).sort((a, b) => (b.score || 0) - (a.score || 0)).map(s => `
      <div><span>${escapeHtml(s.username)}</span><span>${s.score || 0} pts</span></div>
    `).join('');
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
      if (msg) { msg.textContent = 'Prochaine vidéo dans 3 secondes…'; msg.classList.remove('hidden'); }
    }
  });

  socket.on('game_over', (data) => {
    const scores = (data.scores || []).sort((a, b) => (b.score || 0) - (a.score || 0));
    $('podium-list').innerHTML = scores.map((s, i) => `
      <li><span>${i + 1}. ${escapeHtml(s.username)}</span><span>${s.score || 0} pts</span></li>
    `).join('');
    show('screen-gameover');
  });

  $('btn-lobby').addEventListener('click', () => {
    show('screen-lobby');
    showLobby();
  });

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
})();
