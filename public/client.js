(() => {
  const $ = (id) => document.getElementById(id);
  const SESSION_KEY = 'collide:session';
  const NAME_KEY = 'collide:name';

  // The seat token lives per tab (survives refresh, but two tabs are two players);
  // the name is remembered across tabs as a convenience.
  const storageFor = (key) => (key === SESSION_KEY ? sessionStorage : localStorage);
  const store = {
    get(key) { try { return JSON.parse(storageFor(key).getItem(key)); } catch { return null; } },
    set(key, value) { try { storageFor(key).setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
    del(key) { try { storageFor(key).removeItem(key); } catch { /* private mode */ } },
  };

  const socket = io({ autoConnect: false });
  let state = null;
  let receivedAt = 0;
  let prevBoard = null;
  let overDismissed = false;

  // ---------- Setup ----------
  const tpl = $('rules-template');
  document.querySelectorAll('.rules-body').forEach((el) => el.appendChild(tpl.content.cloneNode(true)));

  const params = new URLSearchParams(location.search);
  const linkCode = (params.get('room') || '').toUpperCase().slice(0, 4);
  $('name').value = store.get(NAME_KEY) || '';
  $('code').value = linkCode;
  if (linkCode) {
    // Arrived from an invite link: joining is the main action, not creating.
    $('btn-join').classList.add('primary');
    $('btn-create').classList.remove('primary');
  }

  function show(screen) {
    for (const s of ['home', 'lobby', 'game']) $(`screen-${s}`).hidden = s !== screen;
  }

  let toastTimer;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  function myName() {
    const name = $('name').value.trim();
    if (!name) {
      toast('Enter your name first.');
      $('name').focus();
      return null;
    }
    store.set(NAME_KEY, name);
    return name;
  }

  function setRoomInUrl(code) {
    const url = new URL(location.href);
    if (code) url.searchParams.set('room', code); else url.searchParams.delete('room');
    history.replaceState(null, '', url);
  }

  function inviteLink() {
    const url = new URL(location.origin + location.pathname);
    url.searchParams.set('room', state.code);
    return url.toString();
  }

  // ---------- Home actions ----------
  $('btn-create').onclick = () => {
    const name = myName();
    if (name) socket.emit('create', { name });
  };

  function join() {
    const name = myName();
    const code = $('code').value.trim().toUpperCase();
    if (!name) return;
    if (code.length !== 4) {
      toast('Room codes are 4 letters.');
      $('code').focus();
      return;
    }
    socket.emit('join', { code, name });
  }
  $('btn-join').onclick = join;
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  $('code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
  $('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('code').value ? join() : $('btn-create').click()); });

  // ---------- Lobby / game actions ----------
  $('btn-share').onclick = async () => {
    const link = inviteLink();
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: 'Play Collide with me', text: `Room code ${state.code}`, url: link }); return; } catch { /* cancelled */ }
    }
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied!');
    } catch {
      toast(link);
    }
  };

  $('btn-start').onclick = () => socket.emit('start');
  $('btn-again').onclick = () => socket.emit('again');
  $('btn-view-board').onclick = () => { overDismissed = true; render(); };

  document.querySelectorAll('.btn-leave').forEach((btn) => {
    btn.onclick = () => {
      socket.emit('leave');
      store.del(SESSION_KEY);
      state = null;
      setRoomInUrl(null);
      $('code').value = '';
      show('home');
    };
  });

  $('board').addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell || !cell.classList.contains('legal')) return;
    socket.emit('pick', { cell: Number(cell.dataset.i) });
  });

  // ---------- Socket ----------
  socket.on('connect', () => {
    $('conn').hidden = true;
    const session = store.get(SESSION_KEY);
    if (session && (!linkCode || session.code === linkCode)) socket.emit('resume', session);
    else show('home');
  });

  socket.on('disconnect', () => { $('conn').hidden = false; });

  socket.on('resumeFailed', () => {
    store.del(SESSION_KEY);
    state = null;
    show('home');
  });

  socket.on('joined', ({ code, token }) => {
    store.set(SESSION_KEY, { code, token });
    setRoomInUrl(code);
  });

  socket.on('problem', ({ message }) => toast(message));

  socket.on('state', (s) => {
    // Cells that differ from the previous update get a claim/crack animation.
    prevBoard = state ? state.board : null;
    if (s.phase !== 'over') overDismissed = false;
    state = s;
    receivedAt = performance.now();
    render();
  });

  // ---------- Rendering ----------
  function playerMap() {
    return new Map(state.players.map((p) => [p.id, p]));
  }

  function nameTag(p) {
    const frag = document.createDocumentFragment();
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.setProperty('--c', p.color);
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name;
    frag.append(sw, name);
    if (p.id === state.you) frag.append(tag('you', 'you', p.color));
    if (p.id === state.hostId) frag.append(tag('host'));
    if (!p.connected) frag.append(tag('offline', 'off'));
    return frag;
  }

  function tag(text, extra = '', color) {
    const t = document.createElement('span');
    t.className = `tag ${extra}`;
    t.textContent = text;
    if (color) t.style.setProperty('--c', color);
    return t;
  }

  function render() {
    if (!state) return;
    const me = state.players.find((p) => p.id === state.you);
    if (me) document.documentElement.style.setProperty('--me', me.color);
    if (state.phase === 'lobby') renderLobby();
    else renderGame();
  }

  function renderLobby() {
    show('lobby');
    $('lobby-code').textContent = state.code;
    $('lobby-count').textContent = `(${state.players.length}/8)`;
    const list = $('lobby-players');
    list.replaceChildren(...state.players.map((p) => {
      const li = document.createElement('li');
      if (!p.connected) li.classList.add('offline');
      li.append(nameTag(p));
      return li;
    }));
    const isHost = state.hostId === state.you;
    const enough = state.players.length >= 2;
    $('btn-start').hidden = !isHost;
    $('btn-start').disabled = !enough;
    $('lobby-wait').hidden = isHost && enough;
    $('lobby-wait').textContent = enough
      ? 'Waiting for the host to start…'
      : 'Waiting for at least one more player. Share the code!';
  }

  function renderGame() {
    show('game');
    const players = playerMap();
    $('round').textContent = state.round;

    // Board
    const board = $('board');
    const n = state.size;
    if (board.childElementCount !== n * n) {
      board.style.setProperty('--n', n);
      board.replaceChildren(...Array.from({ length: n * n }, (_, i) => {
        const b = document.createElement('button');
        b.className = 'cell';
        b.dataset.i = i;
        b.type = 'button';
        return b;
      }));
      prevBoard = null;
    }

    const legal = new Set(state.legal);
    const revealByCell = new Map(state.reveal.map((r) => [r.cell, r]));
    const showReveal = state.phase === 'reveal' || state.phase === 'over';

    [...board.children].forEach((el, i) => {
      const v = state.board[i];
      const owner = v && v !== 'x' ? players.get(v) : null;
      const cls = ['cell'];
      el.replaceChildren();
      el.style.removeProperty('--c');
      let label;

      if (v === 'x') {
        cls.push('cracked');
        label = 'cracked';
      } else if (v) {
        cls.push('owned');
        if (v === state.you) cls.push('mine');
        el.style.setProperty('--c', owner ? owner.color : '#555');
        label = `owned by ${owner ? owner.name : 'a player who left'}`;
      } else if (state.phase === 'picking') {
        if (state.myPick === i) { cls.push('picked'); label = 'your pick'; }
        else if (legal.has(i)) { cls.push('legal'); label = 'empty, you can pick this'; }
        else { cls.push('dim'); label = 'empty'; }
      } else {
        label = 'empty';
      }

      const r = showReveal && revealByCell.get(i);
      const changed = prevBoard && prevBoard[i] !== v;
      if (r && changed) cls.push(r.result === 'claim' ? 'new-claim' : 'new-crack');
      if (r && r.result === 'crack') {
        const dots = document.createElement('span');
        dots.className = 'dots';
        for (const pid of r.players) {
          const d = document.createElement('i');
          d.style.setProperty('--c', players.get(pid)?.color || '#777');
          dots.append(d);
        }
        el.append(dots);
        label += `, ${r.players.map((pid) => players.get(pid)?.name || 'someone').join(' and ')} collided here`;
      }

      el.className = cls.join(' ');
      el.disabled = !cls.includes('legal');
      el.setAttribute('aria-label', `Row ${Math.floor(i / n) + 1}, column ${(i % n) + 1}: ${label}`);
    });

    // Scoreboard
    const sorted = [...state.players].sort((a, b) => b.cells - a.cells);
    $('scoreboard').replaceChildren(...sorted.map((p) => {
      const li = document.createElement('li');
      li.style.setProperty('--c', p.color);
      if (p.id === state.you) li.classList.add('me');
      if (!p.connected) li.classList.add('offline');
      const lock = document.createElement('span');
      lock.className = `lock${p.locked ? ' on' : ''}`;
      lock.textContent = state.phase === 'picking' ? (p.locked ? '✓' : '…') : '';
      lock.title = p.locked ? 'Locked in' : 'Still choosing';
      const score = document.createElement('span');
      score.className = 'score';
      score.textContent = p.cells;
      li.append(lock, nameTag(p), score);
      return li;
    }));

    renderStatus(players);
    renderOver(players);
  }

  function renderStatus(players) {
    const status = $('status');
    status.replaceChildren();
    const say = (html) => { status.innerHTML = html; };

    if (state.phase === 'picking') {
      const waiting = state.players.filter((p) => p.connected && !p.locked).length;
      if (state.myPick !== null) {
        say(`<b>Locked in.</b> Waiting for ${waiting} more ${waiting === 1 ? 'player' : 'players'}… <span class="muted">(tap another glowing cell to change)</span>`);
      } else if (state.players.find((p) => p.id === state.you)?.cells === 0) {
        say('Tap <b>any empty cell</b> to plant your first square.');
      } else {
        say('Tap a <b>glowing cell</b> next to your land. Avoid the cells others are going for!');
      }
      return;
    }

    if (state.phase === 'reveal' || state.phase === 'over') {
      const mine = state.reveal.find((r) => r.players.includes(state.you));
      if (!mine) {
        say(state.phase === 'over' ? 'The board is full!' : "<span class=\"muted\">You didn't pick in time.</span> Next round starting…");
      } else if (mine.result === 'claim') {
        say(`<b>+1 cell!</b> Nobody else picked it.${state.phase === 'over' ? '' : ' Next round starting…'}`);
      } else {
        const others = mine.players.filter((id) => id !== state.you).map((id) => players.get(id)?.name || 'someone');
        status.append(Object.assign(document.createElement('b'), { textContent: 'Collision! ' }));
        status.append(document.createTextNode(`You and ${others.join(', ')} picked the same cell. It cracked.`));
      }
      if (state.phase === 'over' && overDismissed) {
        const btn = Object.assign(document.createElement('button'), { className: 'btn small', textContent: 'Show results' });
        btn.style.marginLeft = '8px';
        btn.onclick = () => { overDismissed = false; render(); };
        status.append(btn);
      }
    }
  }

  function renderOver(players) {
    const over = state.phase === 'over';
    $('over').hidden = !over || overDismissed;
    if (!over) return;
    const top = state.standings[0];
    const tied = state.standings.filter((s) => s.cells === top.cells && s.region === top.region);
    const title = tied.length > 1
      ? "It's a tie!"
      : top.id === state.you ? 'You win! 🎉' : `${players.get(top.id)?.name || 'Someone'} wins!`;
    $('over-title').textContent = title;
    $('standings').replaceChildren(...state.standings.map((s) => {
      const p = players.get(s.id);
      const li = document.createElement('li');
      // Players with identical cells and region share a rank.
      const place = state.standings.findIndex((o) => o.cells === s.cells && o.region === s.region) + 1;
      if (place === 1) li.classList.add('first');
      const rank = Object.assign(document.createElement('span'), { className: 'rank', textContent: `${place}` });
      const score = Object.assign(document.createElement('span'), { className: 'score', textContent: `${s.cells} cells` });
      score.title = `Biggest connected area: ${s.region}`;
      li.append(rank, p ? nameTag(p) : document.createTextNode('(left)'), score);
      return li;
    }));
    const isHost = state.hostId === state.you;
    $('btn-again').hidden = !isHost;
    $('over-wait').hidden = isHost;
  }

  // Countdown runs locally from the server's remaining time, so clock skew doesn't matter.
  function tick() {
    if (state && state.phase === 'picking') {
      const left = Math.max(0, state.msLeft - (performance.now() - receivedAt));
      const frac = left / state.pickMs;
      $('timer-bar').style.transform = `scaleX(${frac})`;
      $('timer-bar').classList.toggle('low', left < 5000);
      $('timer-text').textContent = Math.ceil(left / 1000);
    } else if (state) {
      $('timer-bar').style.transform = 'scaleX(0)';
      $('timer-text').textContent = '';
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  socket.connect();
})();
