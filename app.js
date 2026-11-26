'use strict';
/* Misja: Dom: plan dnia domu. Rodzic układa zadania z godzinami, dziecko widzi swoje i je odhacza. */

const KEY = 'po-rowno-v1';
const COLORS = ['#e4572e', '#17a2a0', '#e0a800', '#6aa335', '#8d5cf6', '#e0568f'];
const WEIGHTS = { 1: 'Lekkie', 2: 'Średnie', 3: 'Ciężkie' };
const REPEATS = { daily: 'Codziennie', days: 'Wybrane dni tygodnia', weekly: 'Raz w tygodniu (dowolny dzień)', none: 'Jednorazowo' };
const ROLES = { parent: 'Rodzic', child: 'Dziecko' };
const DAY_SHORT = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const SAMPLE_TASKS = [
  // tytuł, ciężar, powtarzanie, godzina, dni
  ['Odkurzyć i umyć podłogi', 3, 'daily', '12:00'],
  ['Opróżnić zmywarkę', 2, 'daily', '14:00'],
  ['Nakarmić koty', 1, 'daily', '18:00'],
  ['Wynieść śmieci', 1, 'days', '19:00', [0, 3]],
  ['Zrobić pranie', 2, 'weekly', ''],
  ['Zakupy na tydzień', 3, 'weekly', ''],
];

/* ---------- stan ---------- */
let state = load();
let tab = 'tasks';
let range = 'week';
let filterMember = null;
let draftPeople = [];
let draftSample = true;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && Array.isArray(s.members) && Array.isArray(s.tasks) && Array.isArray(s.log)) {
      s.members.forEach((m) => { if (!m.role) m.role = 'parent'; });
      s.tasks.forEach((t) => {
        if (!REPEATS[t.repeat]) t.repeat = 'none';
        t.time = t.time || ''; t.days = Array.isArray(t.days) ? t.days : []; t.date = t.date || '';
      });
      return s;
    }
  } catch (e) { /* brak danych lub brak dostępu do localStorage */ }
  return { members: [], tasks: [], log: [] };
}
function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* tryb prywatny */ }
}
function save() {
  saveLocal();
  Cloud.changed();
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- role ---------- */
const isParent = () => !Cloud.connected || Cloud.role === 'parent';
const meId = () => (Cloud.connected ? Cloud.me : '');

/* ---------- pomocnicze ---------- */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const weekdayIdx = (d) => (d.getDay() + 6) % 7;   // pon = 0
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfWeek = (d) => { const s = startOfDay(d); s.setDate(s.getDate() - weekdayIdx(s)); return s; };
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const toMin = (hhmm) => { const [a, b] = hhmm.split(':').map(Number); return a * 60 + b; };
const member = (id) => state.members.find((m) => m.id === id);
const fmtTime = (ts) => {
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  if (startOfDay(d).getTime() === startOfDay(now).getTime()) return 'dziś ' + hm;
  return d.toLocaleDateString('pl-PL', { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + hm;
};
function who(m) {
  return h('span', { class: 'who' }, h('i', { class: 'dot', style: `--c:${m.color}` }), m.name);
}
function dots(w) { return h('span', { class: 'dots', 'aria-label': WEIGHTS[w] }, '●'.repeat(w) + '○'.repeat(3 - w)); }

/* ---------- harmonogram ---------- */
function periodStart(task) {
  const now = new Date();
  if (task.repeat === 'daily' || task.repeat === 'days') return startOfDay(now).getTime();
  if (task.repeat === 'weekly') return startOfWeek(now).getTime();
  return 0;
}
function lastDone(task) {
  const from = periodStart(task);
  let best = null;
  for (const l of state.log) if (l.taskId === task.id && l.ts >= from && (!best || l.ts > best.ts)) best = l;
  return best;
}
const isTimed = (t) => Boolean(t.time) && (t.repeat === 'daily' || t.repeat === 'days' || (t.repeat === 'none' && t.date));
function scheduleText(t) {
  if (t.repeat === 'daily') return 'Codziennie';
  if (t.repeat === 'weekly') return 'Raz w tygodniu';
  if (t.repeat === 'days') {
    const d = [...t.days].sort();
    if (d.length === 7) return 'Codziennie';
    if (d.join() === '0,1,2,3,4') return 'Pn–Pt';
    return d.map((i) => DAY_SHORT[i]).join(' ');
  }
  return t.date ? 'Jednorazowo, ' + new Date(t.date + 'T00:00').toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' }) : 'Jednorazowo';
}
/* Zadania, które dotyczą dzisiaj, z ich stanem. */
function todayItems(now) {
  const dk = dayKey(now), wd = weekdayIdx(now), nowMin = now.getHours() * 60 + now.getMinutes();
  const items = [];
  for (const t of state.tasks) {
    let show = false, late = false;
    if (t.repeat === 'daily' || t.repeat === 'weekly') show = true;
    else if (t.repeat === 'days') show = t.days.includes(wd);
    else if (!t.date) show = true;
    else if (t.date <= dk) { show = true; late = t.date < dk; }
    if (!show) continue;
    const done = lastDone(t);
    let status = 'upcoming';
    if (!done) {
      if (late) status = 'late';
      else if (isTimed(t)) {
        const diff = toMin(t.time) - nowMin;
        if (diff < 0) status = 'overdue'; else if (diff <= 30) status = 'soon';
      }
    }
    items.push({ t, done, status });
  }
  const key = (i) => (i.status === 'late' ? -1 : isTimed(i.t) ? toMin(i.t.time) : 24 * 60 + 1);
  return items.sort((a, b) => key(a) - key(b));
}

/* ---------- okna ---------- */
const dlg = document.getElementById('dlg');
function openDialog(title, ...body) {
  dlg.replaceChildren(h('h2', {}, title), ...body);
  if (!dlg.open) dlg.showModal();
}
const closeDialog = () => { if (dlg.open) dlg.close(); };
const cancelBtn = (label = 'Anuluj') => h('button', { type: 'button', class: 'btn ghost', onclick: closeDialog }, label);
function notice(title, text) {
  openDialog(title, h('p', {}, text), h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: closeDialog }, 'OK')));
}
function confirmDelete(question, onYes, yesLabel = 'Tak, usuń') {
  openDialog('Na pewno?', h('p', {}, question),
    h('div', { class: 'actions' }, cancelBtn(),
      h('button', { type: 'button', class: 'btn', onclick: () => { closeDialog(); onYes(); } }, yesLabel)));
}

/* ---------- akcje ---------- */
function complete(task, memberId) {
  state.log.push({ id: uid(), taskId: task.id, title: task.title, memberId, ts: Date.now(), points: task.weight });
  save(); render();
}
function undo(entry) {
  if (!isParent() && entry.memberId !== meId()) return;
  state.log = state.log.filter((l) => l.id !== entry.id);
  save(); render();
}
function onDone(task) {
  if (!isParent()) {
    const me = meId();
    if (me) return complete(task, me);
    return notice('Kim jesteś?', 'Wybierz swój profil w zakładce Dom, żeby odhaczać zadania.');
  }
  if (task.assignee && member(task.assignee)) return complete(task, task.assignee);
  askWho(task);
}
function askWho(task) {
  if (state.members.length === 1) return complete(task, state.members[0].id);
  const chips = state.members.map((m) =>
    h('button', { type: 'button', class: 'chip', onclick: () => { closeDialog(); complete(task, m.id); } }, who(m)));
  openDialog('Kto to zrobił?', h('p', { class: 'sub' }, task.title), h('div', { class: 'chips' }, chips),
    h('div', { class: 'actions' }, cancelBtn()));
}

function taskForm(task) {
  const isNew = !task;
  const t = task || { title: '', weight: 2, repeat: 'daily', time: '', days: [], date: '', assignee: null };
  let weight = t.weight, repeat = t.repeat;
  const days = new Set(t.days.length ? t.days : ALL_DAYS);

  const title = h('input', { type: 'text', id: 'f-title', value: t.title, maxlength: 60, required: true, placeholder: 'np. Opróżnić zmywarkę' });
  const time = h('input', { type: 'time', id: 'f-time', value: t.time });
  const date = h('input', { type: 'date', id: 'f-date', value: t.date, oninput: () => drawDynamic() });
  const dayBox = h('div', { class: 'chips', role: 'group', 'aria-label': 'Dni tygodnia' });
  const weightBox = h('div', { class: 'chips', role: 'group', 'aria-label': 'Ciężar zadania' });
  const timeWrap = h('div', {}, h('label', { for: 'f-time' }, 'O której godzinie?'), time);
  const dayWrap = h('div', {}, h('label', {}, 'W które dni?'), dayBox);
  const dateWrap = h('div', {}, h('label', { for: 'f-date' }, 'Data (puste = do skutku)'), date);
  const repeatSel = h('select', { id: 'f-repeat', onchange: (e) => { repeat = e.target.value; if (repeat === 'days' && days.size === 0) ALL_DAYS.forEach((d) => days.add(d)); drawDynamic(); } },
    Object.entries(REPEATS).map(([v, l]) => h('option', { value: v, selected: v === t.repeat }, l)));
  const assignee = h('select', { id: 'f-assignee' },
    h('option', { value: '' }, 'Dla wszystkich (wspólne)'),
    state.members.map((m) => h('option', { value: m.id, selected: m.id === t.assignee }, `${m.name} (${ROLES[m.role].toLowerCase()})`)));

  function drawDynamic() {
    dayBox.replaceChildren(...ALL_DAYS.map((d) => h('button', {
      type: 'button', class: 'chip small', 'aria-pressed': String(days.has(d)),
      onclick: () => { if (days.has(d)) days.delete(d); else days.add(d); drawDynamic(); },
    }, DAY_SHORT[d])));
    weightBox.replaceChildren(...[1, 2, 3].map((w) =>
      h('button', { type: 'button', class: 'chip', 'aria-pressed': String(w === weight), onclick: () => { weight = w; drawDynamic(); } }, dots(w), ' ', WEIGHTS[w])));
    dayWrap.hidden = repeat !== 'days';
    dateWrap.hidden = repeat !== 'none';
    timeWrap.hidden = repeat === 'weekly' || (repeat === 'none' && !date.value);
  }
  drawDynamic();

  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      const name = title.value.trim();
      if (!name) return;
      if (repeat === 'days' && days.size === 0) return notice('Wybierz dni', 'Zaznacz przynajmniej jeden dzień tygodnia.');
      const data = {
        title: name, weight, repeat,
        time: timeWrap.hidden ? '' : time.value,
        days: repeat === 'days' ? [...days].sort() : [],
        date: repeat === 'none' ? date.value : '',
        assignee: assignee.value || null,
      };
      if (isNew) state.tasks.push({ id: uid(), ...data }); else Object.assign(task, data);
      save(); closeDialog(); render();
    },
  },
    h('label', { for: 'f-title' }, 'Co trzeba zrobić?'), title,
    h('label', { for: 'f-assignee' }, 'Dla kogo?'), assignee,
    h('label', { for: 'f-repeat' }, 'Jak często?'), repeatSel,
    dayWrap, dateWrap, timeWrap,
    h('label', {}, 'Ile wysiłku to wymaga?'), weightBox,
    h('div', { class: 'actions' },
      !isNew && h('button', { type: 'button', class: 'btn danger', onclick: () => confirmDelete(`Usunąć zadanie „${task.title}”?`, () => {
        state.tasks = state.tasks.filter((x) => x.id !== task.id); save(); render();
      }) }, 'Usuń'),
      h('span', { class: 'spacer' }),
      cancelBtn(), h('button', { type: 'submit', class: 'btn' }, 'Zapisz')));
  openDialog(isNew ? 'Nowe zadanie' : 'Edytuj zadanie', form);
  title.focus();
}

function memberForm(m) {
  const input = h('input', { type: 'text', id: 'm-name', value: m.name, maxlength: 24, required: true });
  const roleSel = h('select', { id: 'm-role' }, Object.entries(ROLES).map(([v, l]) => h('option', { value: v, selected: v === m.role }, l)));
  openDialog('Domownik', h('form', {
    onsubmit: (e) => { e.preventDefault(); const n = input.value.trim(); if (n) { m.name = n; m.role = roleSel.value; save(); closeDialog(); render(); } },
  },
    h('label', { for: 'm-name' }, 'Imię'), input,
    h('label', { for: 'm-role' }, 'Rola'), roleSel,
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn danger', onclick: () => confirmDelete(
        `Usunąć ${m.name}? Jego wcześniejsze wpisy znikną z podziału.`, () => {
          state.members = state.members.filter((x) => x.id !== m.id);
          state.tasks.forEach((t) => { if (t.assignee === m.id) t.assignee = null; });
          if (filterMember === m.id) filterMember = null;
          save(); render();
        }) }, 'Usuń'),
      h('span', { class: 'spacer' }), cancelBtn(), h('button', { type: 'submit', class: 'btn' }, 'Zapisz'))));
  input.select();
}

function nextColor() {
  const used = new Set(state.members.map((m) => m.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[state.members.length % COLORS.length];
}

/* ---------- wspólny dom (chmura) ---------- */
const STATUS_TEXT = {
  online: 'Zsynchronizowano', syncing: 'Synchronizacja…',
  offline: 'Brak internetu. Zmiany wyślą się później.', error: 'Błąd synchronizacji', noaccess: 'Utracono dostęp do domu',
};
function friendlyError(e) {
  const m = (e && e.message) || '';
  if (/anonymous/i.test(m)) return 'W Supabase włącz „Allow anonymous sign-ins” (Authentication → Sign In / Providers).';
  if (/kod|profil|dostęp|rodzic/i.test(m)) return m;
  if (/fetch|network|sdk/i.test(m)) return 'Brak połączenia z internetem lub z Supabase.';
  return m || 'Nieznany błąd.';
}
async function withBusy(label, fn) {
  openDialog(label, h('p', { class: 'sub' }, 'Chwileczkę…'));
  try { await fn(); closeDialog(); render(); return true; } catch (e) { notice('Nie udało się', friendlyError(e)); return false; }
}
function copyText(text) {
  const done = () => notice('Skopiowano', 'Kod jest w schowku.');
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => notice('Kod', text)); else notice('Kod', text);
}
function chooseMeDialog() {
  const cands = state.members.filter((m) => Cloud.role !== 'child' || m.role === 'child');
  if (!cands.length) {
    return notice('Brak profili', Cloud.role === 'child'
      ? 'Poproś rodzica, żeby dodał Twoje imię w zakładce Dom.' : 'Najpierw dodaj domowników.');
  }
  const chips = cands.map((m) => h('button', {
    type: 'button', class: 'chip' + (m.id === Cloud.me ? ' sug' : ''),
    onclick: () => { closeDialog(); withBusy('Zapisywanie…', () => Cloud.claim(m.id)); },
  }, who(m), ' · ', ROLES[m.role]));
  openDialog('Kim jesteś na tym urządzeniu?', h('p', { class: 'sub' }, 'Dzięki temu zadania odhaczysz jako ta osoba.'),
    h('div', { class: 'chips' }, chips), h('div', { class: 'actions' }, cancelBtn()));
}
function joinDialog() {
  const input = h('input', { type: 'text', id: 'j-code', maxlength: 12, autocomplete: 'off', autocapitalize: 'characters', placeholder: 'np. K7M2QX9A', required: true });
  openDialog('Dołącz do wspólnego domu', h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      const code = input.value.trim();
      if (!code) return;
      const go = async () => {
        const ok = await withBusy('Dołączanie…', () => Cloud.join(code));
        if (ok && !Cloud.me) chooseMeDialog();
      };
      if (state.members.length > 0) {
        confirmDelete('Dane z tego urządzenia zostaną zastąpione danymi wspólnego domu.', go, 'Tak, dołącz');
      } else go();
    },
  },
    h('label', { for: 'j-code' }, 'Kod zaproszenia (od rodzica)'), input,
    h('div', { class: 'actions' }, cancelBtn(), h('button', { type: 'submit', class: 'btn' }, 'Dołącz'))));
  input.focus();
}
function codeCard(label, code) {
  return h('div', { class: 'card' },
    h('div', { class: 'body' }, h('div', { class: 'sub' }, label), h('div', { class: 'code' }, code)),
    h('button', { class: 'btn ghost small', onclick: () => copyText(code) }, 'Kopiuj'));
}
function cloudSection() {
  const title = h('h2', {}, 'Wspólny dom');
  if (!Cloud.configured) {
    return [title, h('p', { class: 'sub' }, 'Synchronizacja między telefonami nie jest jeszcze skonfigurowana (instrukcja w folderze po-rowno-setup).')];
  }
  if (!Cloud.connected) {
    return [title,
      h('p', { class: 'sub' }, 'Połącz telefony domowników, żeby wszyscy widzieli ten sam plan dnia.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', onclick: async () => {
          const ok = await withBusy('Tworzenie domu…', () => Cloud.create());
          if (ok && !Cloud.me) chooseMeDialog();
        } }, 'Utwórz wspólny dom'),
        h('button', { class: 'btn ghost', onclick: joinDialog }, 'Dołącz kodem'))];
  }
  const st = Cloud.status;
  const meM = member(Cloud.me);
  return [title,
    h('div', { class: 'card' },
      h('div', { class: 'body' },
        h('div', { class: 'sub' }, 'To urządzenie (' + ROLES[Cloud.role].toLowerCase() + ')'),
        h('div', { class: 'title' }, meM ? who(meM) : 'Nie wybrano profilu'),
        h('div', { class: 'meta' }, STATUS_TEXT[st] || '', st === 'error' && Cloud.lastError ? ` (${Cloud.lastError})` : '')),
      h('button', { class: 'btn ghost small', onclick: chooseMeDialog }, meM ? 'Zmień' : 'Wybierz')),
    isParent() && Cloud.code && codeCard('Kod dla rodziców', Cloud.code),
    isParent() && Cloud.childCode && codeCard('Kod dla dzieci (widzą tylko swoje zadania)', Cloud.childCode),
    h('div', { class: 'row wrap' },
      (st === 'error' || st === 'offline') && h('button', { class: 'btn ghost', onclick: () => Cloud.retry() }, 'Spróbuj ponownie'),
      st === 'noaccess' && h('button', { class: 'btn ghost', onclick: joinDialog }, 'Dołącz kodem'),
      h('button', { class: 'btn danger', onclick: () => confirmDelete(
        'To urządzenie przestanie się synchronizować. Dane zostaną tu jako kopia lokalna.', () => Cloud.leave(), 'Tak, odłącz') }, 'Odłącz to urządzenie'))];
}

/* ---------- widoki ---------- */
function renderSetup() {
  const nameInput = h('input', { type: 'text', id: 's-name', maxlength: 24, placeholder: 'Imię domownika', autocomplete: 'off' });
  const roleSel = h('select', { id: 's-role', 'aria-label': 'Rola' },
    Object.entries(ROLES).map(([v, l]) => h('option', { value: v, selected: v === (draftPeople.length ? 'child' : 'parent') }, l)));
  const add = () => {
    const n = nameInput.value.trim();
    if (!n || draftPeople.length >= COLORS.length) return;
    draftPeople.push({ name: n, role: roleSel.value }); render();
    document.getElementById('s-name').focus();
  };
  const list = h('ul', { class: 'setup-list' }, draftPeople.map((p, i) =>
    h('li', {}, h('span', {}, who({ name: p.name, color: COLORS[i % COLORS.length] }), ' · ', ROLES[p.role]),
      h('button', { class: 'btn ghost small', onclick: () => { draftPeople.splice(i, 1); render(); } }, 'Usuń'))));
  const form = h('form', { onsubmit: (e) => { e.preventDefault(); add(); } },
    h('div', { class: 'row' }, nameInput, roleSel, h('button', { type: 'submit', class: 'btn ghost' }, 'Dodaj')));
  return h('section', {},
    h('h1', {}, 'Misja: Dom'),
    h('p', { class: 'sub' }, 'Plan dnia domu: rodzic układa zadania z godzinami, dzieci widzą swoje. Zacznij od dodania domowników.'),
    form, list,
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: draftSample, onchange: (e) => { draftSample = e.target.checked; } }),
      'Dodaj przykładowe zadania (odkurzanie, zmywarka, koty…)'),
    h('button', {
      class: 'btn', disabled: draftPeople.length === 0,
      onclick: () => {
        state.members = draftPeople.map((p, i) => ({ id: uid(), name: p.name, role: p.role, color: COLORS[i % COLORS.length] }));
        if (draftSample) {
          state.tasks = SAMPLE_TASKS.map(([title, weight, repeat, time, days]) =>
            ({ id: uid(), title, weight, repeat, time, days: days || [], date: '', assignee: null }));
        }
        draftPeople = []; save(); render();
      },
    }, 'Zaczynamy'),
    Cloud.configured && h('div', { class: 'sub', style: 'margin-top:24px' },
      'Ktoś z domowników już założył dom? ',
      h('button', { class: 'btn ghost small', onclick: joinDialog }, 'Mam kod zaproszenia')));
}

function taskCard({ t, done, status }) {
  const parent = isParent();
  const m = done ? member(done.memberId) : member(t.assignee);
  const timed = isTimed(t);
  const canUndo = done && (parent || done.memberId === meId());
  const badge = status === 'late' || status === 'overdue' ? h('span', { class: 'badge bad' }, 'Spóźnione')
    : status === 'soon' ? h('span', { class: 'badge soon' }, 'Zaraz') : null;
  return h('div', { class: `card st-${status}` + (done ? ' done' : '') },
    h('div', { class: 'time' + (timed ? '' : ' small') }, timed ? t.time : t.repeat === 'weekly' ? 'w tygodniu' : 'w ciągu dnia'),
    h('button', { class: 'body', disabled: !parent, onclick: () => taskForm(t), 'aria-label': parent ? `Edytuj: ${t.title}` : t.title },
      h('div', { class: 'title' }, t.title),
      h('div', { class: 'meta' }, dots(t.weight), h('span', {}, scheduleText(t)),
        done ? h('span', {}, '✓ ', m ? m.name : 'ktoś', ' · ', fmtTime(done.ts)) : (m && who(m)), badge)),
    done
      ? (canUndo && h('button', { class: 'btn ghost small', onclick: () => undo(done) }, 'Cofnij'))
      : h('button', { class: 'btn', onclick: () => onDone(t) }, 'Zrobione'));
}

function renderTasks() {
  const parent = isParent();
  const me = meId();
  let items = todayItems(new Date());
  if (!parent) items = items.filter((i) => !i.t.assignee || i.t.assignee === me);
  else if (filterMember) items = items.filter((i) => i.t.assignee === filterMember);
  const todo = items.filter((i) => !i.done), done = items.filter((i) => i.done);
  const total = items.length;
  const pct = total ? Math.round((done.length / total) * 100) : 0;
  const today = new Date().toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });
  const meM = member(me);
  return h('section', {},
    h('h1', {}, parent ? 'Dziś w domu' : meM ? `Cześć, ${meM.name}` : 'Moje zadania'),
    h('p', { class: 'sub' }, today),
    parent && state.members.length > 1 && h('div', { class: 'chips filter', role: 'group', 'aria-label': 'Filtr osoby' },
      h('button', { class: 'chip small', 'aria-pressed': String(!filterMember), onclick: () => { filterMember = null; render(); } }, 'Wszyscy'),
      state.members.map((m) => h('button', { class: 'chip small', 'aria-pressed': String(filterMember === m.id), onclick: () => { filterMember = m.id; render(); } }, who(m)))),
    !parent && !me && h('div', { class: 'note' }, 'Nie wybrano Twojego profilu. ',
      h('button', { class: 'btn small', onclick: chooseMeDialog }, 'Wybierz, kim jesteś')),
    total > 0 && h('div', {},
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${pct}%` })),
      h('small', { class: 'sub' }, `${done.length} z ${total} zrobione`)),
    total === 0 && h('div', { class: 'empty' }, parent ? 'Brak zadań na dziś. Dodaj plan przyciskiem +.' : 'Na dziś nic do zrobienia.'),
    todo.length > 0 && h('h2', {}, 'Do zrobienia'),
    todo.map(taskCard),
    done.length > 0 && h('h2', {}, 'Zrobione'),
    done.map(taskCard),
    parent && h('button', { class: 'fab', onclick: () => taskForm(null), 'aria-label': 'Dodaj zadanie' }, '+'));
}

function renderStats() {
  const now = new Date();
  const from = (range === 'week' ? startOfWeek(now) : startOfMonth(now)).getTime();
  const entries = state.log.filter((l) => l.ts >= from && member(l.memberId));
  const pts = new Map(state.members.map((m) => [m.id, 0]));
  entries.forEach((l) => pts.set(l.memberId, pts.get(l.memberId) + l.points));
  const total = [...pts.values()].reduce((a, b) => a + b, 0);
  const rows = state.members.map((m) => ({ m, p: pts.get(m.id), pct: total ? Math.round((pts.get(m.id) / total) * 100) : 0 }))
    .sort((a, b) => b.p - a.p);
  const max = rows.length ? Math.max(1, rows[0].p) : 1;

  let note;
  if (total === 0) note = 'Na razie pusto. Pierwsze odhaczone zadanie pojawi się tutaj.';
  else if (rows.length < 2) note = 'Dodaj kolejnych domowników, żeby zobaczyć podział.';
  else {
    const low = rows[rows.length - 1], high = rows[0];
    note = high.pct - low.pct > 20
      ? `${low.m.name} ma na razie najmniej punktów (${low.pct}%). Może przejąć coś z ciężkich zadań?`
      : 'Podział wygląda uczciwie. Tak trzymać!';
  }
  const recent = [...state.log].filter((l) => member(l.memberId)).sort((a, b) => b.ts - a.ts).slice(0, 8);

  return h('section', {},
    h('h1', {}, 'Podział'),
    h('p', { class: 'sub' }, 'Punkty zależą od wysiłku zadania, nie od liczby odhaczeń.'),
    h('div', { class: 'seg', role: 'group' },
      h('button', { 'aria-pressed': String(range === 'week'), onclick: () => { range = 'week'; render(); } }, 'Ten tydzień'),
      h('button', { 'aria-pressed': String(range === 'month'), onclick: () => { range = 'month'; render(); } }, 'Ten miesiąc')),
    rows.map(({ m, p, pct }) => h('div', { class: 'bar-row' },
      h('div', { class: 'bar-head' }, who(m), h('span', {}, `${p} pkt · ${pct}%`)),
      h('div', { class: 'bar' }, h('i', { style: `--c:${m.color};width:${(p / max) * 100}%` })))),
    h('div', { class: 'note' }, note),
    recent.length > 0 && h('h2', {}, 'Ostatnio zrobione'),
    recent.length > 0 && h('ul', { class: 'log' }, recent.map((l) => {
      const m = member(l.memberId);
      return h('li', {}, h('span', {}, who(m), ' · ', l.title), h('time', {}, fmtTime(l.ts)));
    })));
}

function renderHome() {
  const parent = isParent();
  const input = h('input', { type: 'text', id: 'h-name', maxlength: 24, placeholder: 'Imię nowego domownika', autocomplete: 'off' });
  const roleSel = h('select', { id: 'h-role', 'aria-label': 'Rola' }, Object.entries(ROLES).map(([v, l]) => h('option', { value: v, selected: v === 'child' }, l)));
  return h('section', {},
    h('h1', {}, 'Dom'),
    h('p', { class: 'sub' }, parent ? 'Domownicy i ustawienia.' : 'Twoje urządzenie i ustawienia.'),
    cloudSection(),
    parent && h('h2', {}, 'Domownicy'),
    parent && state.members.map((m) => h('div', { class: 'card' },
      h('button', { class: 'body', onclick: () => memberForm(m) }, h('div', { class: 'title' }, who(m)), h('div', { class: 'meta' }, ROLES[m.role])),
      h('button', { class: 'btn ghost small', onclick: () => memberForm(m) }, 'Edytuj'))),
    parent && state.members.length < COLORS.length && h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const n = input.value.trim();
        if (!n) return;
        state.members.push({ id: uid(), name: n, role: roleSel.value, color: nextColor() });
        save(); render();
      },
    }, h('div', { class: 'row' }, input, roleSel, h('button', { type: 'submit', class: 'btn' }, 'Dodaj'))),
    parent && h('h2', {}, 'Dane'),
    parent && h('button', { class: 'btn danger', onclick: () => confirmDelete(
      'Wszystkie dane (domownicy, zadania, historia) zostaną skasowane z tego urządzenia.', () => {
        state = { members: [], tasks: [], log: [] }; save(); tab = 'tasks'; render();
      }) }, 'Usuń wszystkie dane'));
}

function renderNav() {
  const items = [['tasks', '✓', 'Dziś']];
  if (isParent()) items.push(['stats', '◔', 'Podział']);
  items.push(['home', '⌂', 'Dom']);
  return items.map(([id, icon, label]) =>
    h('button', { 'aria-current': tab === id ? 'page' : null, onclick: () => { tab = id; render(); window.scrollTo(0, 0); } },
      h('span', { 'aria-hidden': 'true' }, icon), label));
}

function render() {
  const app = document.getElementById('app');
  const nav = document.getElementById('nav');
  if (state.members.length === 0) {
    app.replaceChildren(renderSetup());
    nav.replaceChildren(); nav.hidden = true;
    return;
  }
  if (tab === 'stats' && !isParent()) tab = 'tasks';
  nav.hidden = false;
  app.replaceChildren(tab === 'stats' ? renderStats() : tab === 'home' ? renderHome() : renderTasks());
  nav.replaceChildren(...renderNav());
}

/* ---------- start ---------- */
const idle = () => { const a = document.activeElement; return !document.hidden && !dlg.open && !(a && (a.tagName === 'INPUT' || a.tagName === 'SELECT')); };
Cloud.onUpdate = (statusOnly) => {
  if (statusOnly && tab !== 'home') return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT') && !dlg.open) return;   // nie psuj pisania
  render();
};
render();
Cloud.init();
setInterval(() => { if (tab === 'tasks' && state.members.length && idle()) render(); }, 60000);   // przeliczanie „Zaraz” i „Spóźnione”
document.addEventListener('visibilitychange', () => { if (idle() && tab === 'tasks') render(); });
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
