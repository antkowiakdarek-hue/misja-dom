'use strict';
/* Synchronizacja ze Supabase: anonimowe konto + wspólny dom z kodem zaproszenia.
   Model: lokalny stan (state z app.js) jest źródłem prawdy dla UI. Po każdej zmianie
   wysyłamy różnicę względem ostatniego znanego stanu chmury (snapshot), potem pobieramy
   stan zdalny. Zmiany zdalne dochodzą przez Realtime, które tylko wyzwala ponowną synchronizację. */
const Cloud = (() => {
  const CFG = window.PO_ROWNO_CONFIG || {};
  const SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
  const META_KEY = 'po-rowno-cloud-v1';
  const SNAP_KEY = 'po-rowno-snap-v1';
  const LOG_DAYS = 14;   // tyle dni historii trzymamy (starsze kasuje się automatycznie)
  const configured = Boolean(CFG.url && CFG.anonKey);

  const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* brak miejsca */ } };

  let meta = read(META_KEY, {});            // { householdId, code }
  let snapshot = read(SNAP_KEY, null);      // { members:{id:json}, tasks:{...}, log:{...} }
  let sb = null, channel = null, timer = null, accessChecked = false;
  let queue = Promise.resolve();

  /* Mapowanie obiektów aplikacji <-> wiersze bazy. */
  const COLS = {
    members: {
      toRow: (o, h, i) => ({ id: o.id, household_id: h, name: o.name, color: o.color, role: o.role || 'parent', pos: i }),
      fromRow: (r) => ({ id: r.id, name: r.name, color: r.color, role: r.role || 'parent' }),
    },
    tasks: {
      toRow: (o, h, i) => ({
        id: o.id, household_id: h, title: o.title, weight: o.weight, recurrence: o.repeat,
        task_time: o.time || null, days: o.days && o.days.length ? o.days : null, due_date: o.date || null,
        skip_dates: o.skips && o.skips.length ? o.skips : null,
        status: o.status === 'pending' ? 'pending' : 'active', proposed_by: o.proposedBy || null,
        transfer_of: o.transferOf || null, transfer_day: o.transferDay || null,
        assignee: o.assignee || null, pos: i,
      }),
      fromRow: (r) => ({
        id: r.id, title: r.title, weight: r.weight, repeat: r.recurrence,
        time: r.task_time || '', days: r.days || [], date: r.due_date || '', assignee: r.assignee || null,
        skips: r.skip_dates || [],
        status: r.status === 'pending' ? 'pending' : 'active', proposedBy: r.proposed_by || '',
        transferOf: r.transfer_of || '', transferDay: r.transfer_day || '',
        created: r.created_at ? Date.parse(r.created_at) : 0,   // do oznaczania zaległości w planie
      }),
    },
    log: {
      toRow: (o, h) => ({ id: o.id, household_id: h, task_id: o.taskId, title: o.title, member_id: o.memberId, ts: o.ts, points: o.points }),
      fromRow: (r) => ({ id: r.id, taskId: r.task_id, title: r.title, memberId: r.member_id, ts: Number(r.ts), points: r.points }),
    },
  };
  const emptyState = () => ({ members: [], tasks: [], log: [] });
  const canon = (c, o) => JSON.stringify(c.fromRow(c.toRow(o, '', 0)));
  function snapOf(st) {
    const s = {};
    for (const [n, c] of Object.entries(COLS)) { s[n] = {}; for (const o of st[n]) s[n][o.id] = canon(c, o); }
    return s;
  }
  const snapStr = (s) => JSON.stringify(Object.keys(COLS).map((n) => Object.keys(s[n]).sort().map((id) => [id, s[n][id]])));

  const api = {
    configured,
    status: meta.householdId ? 'syncing' : 'off',
    lastError: '',
    onUpdate() {},
    get connected() { return Boolean(meta.householdId); },
    get householdId() { return meta.householdId || ''; },
    get role() { return meta.role || 'parent'; },
    get me() { return meta.memberId || ''; },
    get code() { return meta.code || ''; },              // kod dla rodziców
    get childCode() { return meta.childCode || ''; },    // kod dla dzieci
  };
  function setStatus(s) {
    if (api.status === s) return;
    api.status = s;
    api.onUpdate(true);
  }

  /* ---------- klient ---------- */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('sdk: nie udało się pobrać biblioteki'));
      document.head.append(s);
    });
  }
  async function ensureClient() {
    if (sb) return sb;
    if (!configured) throw new Error('Synchronizacja nie jest skonfigurowana');
    if (!window.supabase) await loadScript(SDK);
    const client = window.supabase.createClient(CFG.url, CFG.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
    const { data } = await client.auth.getSession();
    if (!data.session) {
      const { error } = await client.auth.signInAnonymously();
      if (error) throw error;
    }
    sb = client;
    return sb;
  }
  async function checkAccess() {
    if (accessChecked) return;
    const { data, error } = await sb.from('household_users').select('role, member_id').eq('household_id', meta.householdId);
    if (error) throw error;
    if (!data.length) throw new Error('no-access');
    meta.role = data[0].role;
    meta.memberId = data[0].member_id || '';
    if (meta.role === 'parent' && (!meta.code || !meta.childCode)) {
      const r = await sb.rpc('household_codes', { hid: meta.householdId });
      if (!r.error && r.data) { meta.code = r.data.code; meta.childCode = r.data.child_code; }
    }
    write(META_KEY, meta);
    accessChecked = true;
  }

  /* ---------- wysyłanie i pobieranie ---------- */
  async function push() {
    const hid = meta.householdId;
    for (const [name, c] of Object.entries(COLS)) {
      const isChild = api.role === 'child';
      if (isChild && name === 'members') continue;   // dziecko nie zmienia domowników
      const snap = snapshot[name];
      const all = new Map(state[name].map((o, i) => [o.id, { o, i }]));
      // dziecko wysyła tylko własne propozycje zadań (czekające na potwierdzenie) oraz własne odhaczenia
      // własne propozycje oraz własne zadania dla siebie (działają jak przypomnienia, bez potwierdzenia)
      const ownPending = (o) => Boolean(api.me) && o.proposedBy === api.me && (o.status === 'pending' || o.assignee === api.me);
      const snapObj = (id) => { try { return JSON.parse(snap[id]); } catch (e) { return null; } };
      const forMe = (p) => p && p.status === 'pending' && p.assignee && p.assignee === api.me;   // zadanie czekające na moje potwierdzenie
      let cur = all;
      let accepts = [];
      if (isChild && name === 'tasks') {
        cur = new Map([...all].filter(([, v]) => ownPending(v.o)));
        // potwierdzone przeze mnie zadania skierowane do mnie (wysyłamy tylko zmianę statusu)
        accepts = [...all].filter(([id, v]) => v.o.assignee === api.me && v.o.status === 'active' && forMe(snapObj(id))).map(([id]) => id);
      }
      const up = [];
      for (const [id, { o, i }] of cur) if (snap[id] !== canon(c, o)) up.push(c.toRow(o, hid, i));
      let del = Object.keys(snap).filter((id) => !all.has(id));
      if (isChild && name === 'tasks') {
        // wolno usuwać tylko własne propozycje i odrzucone zadania skierowane do mnie (po stanie z ostatniej synchronizacji)
        del = del.filter((id) => {
          const p = snapObj(id);
          if (!p) return false;
          const selfTask = p.assignee === api.me && p.proposedBy === api.me;
          return selfTask || (p.status === 'pending' && (p.proposedBy === api.me || p.assignee === api.me));
        });
      }
      if (up.length) {
        let { error } = await sb.from(name).upsert(up);
        // baza bez nowych kolumn (jeszcze nie zaktualizowana): zapisz bez nich zamiast psuć synchronizację
        if (error && /column/i.test(error.message || '') && /(skip_dates|proposed_by|status|transfer_of|transfer_day)/.test(error.message || '')) {
          up.forEach((r) => { delete r.skip_dates; delete r.proposed_by; delete r.status; delete r.transfer_of; delete r.transfer_day; });
          ({ error } = await sb.from(name).upsert(up));
        }
        if (error) throw error;
      }
      for (const id of accepts) {
        const { error } = await sb.from('tasks').update({ status: 'active' }).eq('id', id);
        if (error) throw error;
      }
      if (del.length) { const { error } = await sb.from(name).delete().in('id', del); if (error) throw error; }
      const next = (isChild && name === 'tasks') ? { ...snap } : {};
      for (const id of del) delete next[id];
      for (const [id, { o }] of cur) next[id] = canon(c, o);
      for (const id of accepts) next[id] = canon(c, all.get(id).o);
      snapshot[name] = next;
    }
    write(SNAP_KEY, snapshot);
  }
  async function pull() {
    const hid = meta.householdId;
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const since = d0.getTime() - LOG_DAYS * 864e5;
    const [m, t, l] = await Promise.all([
      sb.from('members').select('*').eq('household_id', hid).order('pos').order('id'),
      sb.from('tasks').select('*').eq('household_id', hid).order('pos').order('id'),
      sb.from('log').select('*').eq('household_id', hid).gte('ts', since).order('ts', { ascending: false }).limit(2000),
    ]);
    for (const r of [m, t, l]) if (r.error) throw r.error;
    return {
      members: m.data.map(COLS.members.fromRow),
      tasks: t.data.map(COLS.tasks.fromRow),
      log: l.data.map(COLS.log.fromRow).sort((a, b) => a.ts - b.ts),
    };
  }

  async function doSync() {
    if (!meta.householdId) return;
    setStatus(navigator.onLine ? 'syncing' : 'offline');
    try {
      await ensureClient();
      await checkAccess();
      if (!channel) subscribe();
      if (!snapshot) snapshot = snapOf(emptyState());
      await push();
      const before = snapStr(snapOf(state));
      const remote = await pull();
      if (snapStr(snapOf(state)) !== before) { scheduleSync(50); return; }   // użytkownik coś zmienił w trakcie
      const rs = snapOf(remote);
      if (snapStr(rs) !== before) { state = remote; saveLocal(); api.onUpdate(false); }
      snapshot = rs;
      write(SNAP_KEY, snapshot);
      api.lastError = '';
      setStatus('online');
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (msg === 'no-access') { api.lastError = 'Utracono dostęp do domu. Dołącz ponownie kodem.'; setStatus('noaccess'); }
      else if (!navigator.onLine || /fetch|network|sdk/i.test(msg)) setStatus('offline');
      else { api.lastError = msg; setStatus('error'); }
    }
  }
  const runSync = () => (queue = queue.then(doSync).catch(() => {}));
  function scheduleSync(ms = 400) {
    if (!meta.householdId) return;
    clearTimeout(timer);
    timer = setTimeout(runSync, ms);
  }

  function subscribe() {
    unsubscribe();
    const ch = sb.channel('po-rowno');
    for (const table of Object.keys(COLS)) ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => scheduleSync(250));
    ch.subscribe();
    channel = ch;
  }
  function unsubscribe() {
    if (channel && sb) sb.removeChannel(channel);
    channel = null;
  }

  /* ---------- API dla UI ---------- */
  api.changed = () => scheduleSync(400);

  api.create = async () => {
    await ensureClient();
    const { data, error } = await sb.rpc('create_household');
    if (error) throw error;
    meta = { householdId: data.id, role: 'parent', code: data.code, childCode: data.child_code, memberId: '' }; write(META_KEY, meta);
    snapshot = snapOf(emptyState());                 // cały lokalny stan trafi do chmury
    accessChecked = false;
    await runSync();
  };

  api.join = async (rawCode) => {
    await ensureClient();
    const code = String(rawCode).trim().toUpperCase();
    const { data, error } = await sb.rpc('join_household', { p_code: code });
    if (error) throw error;
    state = emptyState(); saveLocal();               // dane domu zastąpią lokalne
    meta = { householdId: data.id, role: data.role, code: data.role === 'parent' ? code : '', childCode: '', memberId: '' };
    write(META_KEY, meta);
    snapshot = snapOf(emptyState());
    accessChecked = false;
    unsubscribe();
    await runSync();
    api.onUpdate(false);
  };

  /* Wywołanie funkcji bazy (np. zapis subskrypcji push). */
  api.rpc = async (fn, args) => {
    await ensureClient();
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw error;
    return data;
  };

  /* Przypisuje to urządzenie do profilu domownika (kim jestem). */
  api.claim = async (memberId) => {
    await ensureClient();
    const { error } = await sb.rpc('claim_member', { p_member_id: memberId });
    if (error) throw error;
    meta.memberId = memberId; write(META_KEY, meta);
    api.onUpdate(false);
  };

  api.leave = async () => {
    unsubscribe();
    try {
      if (sb) {
        const { data } = await sb.auth.getSession();
        if (data.session) await sb.from('household_users').delete().eq('household_id', meta.householdId).eq('user_id', data.session.user.id);
      }
    } catch (e) { /* offline: i tak odłączamy lokalnie */ }
    meta = {}; snapshot = null; accessChecked = false;
    try { localStorage.removeItem(META_KEY); localStorage.removeItem(SNAP_KEY); } catch (e) { /* nic */ }
    api.lastError = '';
    setStatus('off');
    api.onUpdate(false);
  };

  api.init = () => {
    window.addEventListener('online', () => scheduleSync(0));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(0); });
    if (configured && meta.householdId) runSync();
  };
  api.retry = () => runSync();

  return api;
})();
