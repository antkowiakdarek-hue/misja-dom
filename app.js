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
let planMode = 'week';                 // 'week' | 'month'
let planAnchor = new Date(new Date().setHours(0, 0, 0, 0));   // pierwszy dzień oglądanego okna (7 lub 30 dni)
let planDay = new Date(new Date().setHours(0, 0, 0, 0));      // wybrany dzień w widoku 30 dni
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
        t.status = t.status === 'pending' ? 'pending' : 'active'; t.proposedBy = t.proposedBy || '';
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
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const MONTHS_SHORT = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
const MONTHS_GEN = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
const MONTHS_FULL = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
const sameDay = (a, b) => dayKey(a) === dayKey(b);
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

/* ---------- zatwierdzanie zadań ---------- */
/* Zadanie 'pending' czeka na potwierdzenie. Potwierdza ZAWSZE osoba, która dostaje zadanie (rodzic lub dziecko),
   a gdy zadanie jest dla autora albo wspólne (propozycja dziecka), którykolwiek rodzic. Autor sam nie potwierdza. */
function isPending(t) { return t.status === 'pending'; }
function memberRole(id) { return (member(id) || {}).role; }
/* Czy zadanie jest skierowane do konkretnej innej osoby (to ona decyduje)? */
function directRecipient(assigneeId, proposerId) {
  return assigneeId && assigneeId !== proposerId && member(assigneeId) ? member(assigneeId) : null;
}
function canApprove(t) {
  if (!isPending(t) || !Cloud.connected) return false;
  const me = meId();
  if (me && me === t.proposedBy) return false;
  if (directRecipient(t.assignee, t.proposedBy)) return Boolean(me) && me === t.assignee;
  return isParent();
}
function isAuthor(t) { return isPending(t) && Cloud.connected && Boolean(meId()) && t.proposedBy === meId(); }
/* Czy to, co teraz dodam dla tej osoby, będzie wymagało potwierdzenia? */
function needsApproval(assigneeId) {
  if (!Cloud.connected || !meId()) return false;
  if (!isParent()) return true;                                   // dziecko zawsze proponuje
  return memberRole(assigneeId) === 'parent' && assigneeId !== meId();   // rodzic tylko wobec innego rodzica
}
/* Kto potwierdzi zadanie, które autor (ja) kieruje do tej osoby. */
function approverText(assigneeId) {
  const m = directRecipient(assigneeId, meId());
  return m ? m.name : 'rodzic';
}
function approverOf(t) {
  const m = directRecipient(t.assignee, t.proposedBy);
  return m ? m.name : 'rodzic';
}
/* Kto może dodawać zadania: rodzic zawsze, dziecko (jako propozycje) tylko w podłączonym domu z wybranym profilem. */
function canAdd() { return isParent() || (Cloud.connected && Boolean(meId())); }

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
    if (isPending(t)) continue;                      // niepotwierdzone pokazujemy osobno
    if (t.skips && t.skips.includes(dk)) continue;   // dzisiaj pominięte
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

/* ---------- plan: zadania w wybranym dniu ---------- */
/* Czy zadanie wypada w danym dniu? "Raz w tygodniu" i "bez daty" pokazujemy osobno (blok tygodnia). */
function occursOn(t, d) {
  if (t.skips && t.skips.includes(dayKey(d))) return false;   // dzień pominięty przez rodzica
  if (t.repeat === 'daily') return true;
  if (t.repeat === 'days') return t.days.includes(weekdayIdx(d));
  if (t.repeat === 'none') return Boolean(t.date) && t.date === dayKey(d);
  return false;
}
function doneOn(t, d) {
  const a = startOfDay(d).getTime(), b = startOfDay(addDays(d, 1)).getTime();
  return state.log.find((l) => l.taskId === t.id && l.ts >= a && l.ts < b) || null;
}
function doneInWeek(t, d) {
  const a = startOfWeek(d).getTime(), b = addDays(startOfWeek(d), 7).getTime();
  return state.log.find((l) => l.taskId === t.id && l.ts >= a && l.ts < b) || null;
}
function visibleToMe(t) {
  if (isParent()) return !filterMember || t.assignee === filterMember;
  const me = meId();
  if (isPending(t)) return Boolean(me) && (t.proposedBy === me || t.assignee === me);   // własne propozycje i skierowane do mnie
  return !t.assignee || t.assignee === me;
}
function itemsOn(d, includePending = false) {
  const now = new Date(), today = startOfDay(now), ds = startOfDay(d);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const out = [];
  for (const t of state.tasks) {
    if (!visibleToMe(t) || !occursOn(t, ds)) continue;
    if (isPending(t)) {
      if (includePending && ds >= today) out.push({ t, done: null, status: 'pending' });
      continue;
    }
    const done = doneOn(t, ds);
    let status = 'upcoming';
    if (done) status = 'done';
    else if (ds < today) {
      // "zaległe" tylko gdy zadanie istniało już tego dnia
      if (!t.created || t.created > addDays(ds, 1).getTime()) continue;
      status = 'missed';
    } else if (sameDay(ds, today) && isTimed(t) && toMin(t.time) < nowMin) status = 'overdue';
    out.push({ t, done, status });
  }
  const key = (i) => (isTimed(i.t) ? toMin(i.t.time) : 24 * 60 + 1);
  return out.sort((a, b) => key(a) - key(b));
}
/* Zadania na tydzień bez konkretnego dnia: "raz w tygodniu" i (dla bieżącego tygodnia) bez daty. */
function weekFloating(weekStart) {
  const today = startOfDay(new Date());
  const isCurrent = sameDay(startOfWeek(today), weekStart);
  return state.tasks
    .filter((t) => visibleToMe(t) && (t.repeat === 'weekly' || (isCurrent && t.repeat === 'none' && !t.date)))
    .map((t) => ({ t, done: isPending(t) ? null : (t.repeat === 'weekly' ? doneInWeek(t, weekStart) : lastDone(t)) }))
    .map((i) => ({ ...i, status: isPending(i.t) ? 'pending' : (i.done ? 'done' : 'upcoming') }));
}

/* Zadania dnia do oglądania w "Dziś" (dni minione i jutro). Dla dni minionych dokładamy też wpisy
   zadań, które nie wypadają cyklicznie tego dnia (np. "raz w tygodniu") i zadań już usuniętych. */
function itemsFor(d) {
  const ds = startOfDay(d), today = startOfDay(new Date());
  const base = itemsOn(ds);
  if (ds > today) return base;
  const seen = new Set(base.map((i) => i.t.id));
  const a = ds.getTime(), b = addDays(ds, 1).getTime();
  const extra = [];
  for (const l of state.log) {
    if (l.ts < a || l.ts >= b) continue;
    let t = state.tasks.find((x) => x.id === l.taskId);
    if (t) {
      if (seen.has(t.id) || !visibleToMe(t)) continue;
    } else {
      t = { id: l.taskId, title: l.title, weight: l.points, repeat: 'none', time: '', days: [], date: '', assignee: l.memberId, deleted: true };
      if (seen.has(t.id)) continue;
      if (!isParent() && t.assignee !== meId()) continue;
      if (isParent() && filterMember && t.assignee !== filterMember) continue;
    }
    seen.add(t.id);
    extra.push({ t, done: l, status: 'done' });
  }
  const key = (i) => (isTimed(i.t) ? toMin(i.t.time) : 24 * 60 + 1);
  return base.concat(extra).sort((x, y) => key(x) - key(y));
}

/* Automatyczne czyszczenie: historia starsza niż 14 dni oraz jednorazowe zadania z datą sprzed 14 dni. */
function pruneOld() {
  const base = addDays(startOfDay(new Date()), -14);
  const cutoff = base.getTime(), cutKey = dayKey(base);
  const before = state.log.length + state.tasks.length;
  state.log = state.log.filter((l) => l.ts >= cutoff);
  state.tasks = state.tasks.filter((t) => !(t.repeat === 'none' && t.date && t.date < cutKey));
  let skipsChanged = false;
  for (const t of state.tasks) {
    if (t.skips && t.skips.some((k) => k < cutKey)) { t.skips = t.skips.filter((k) => k >= cutKey); skipsChanged = true; }
  }
  return skipsChanged || state.log.length + state.tasks.length !== before;
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

function taskForm(task, preset) {
  const isNew = !task;
  const p = preset || {};
  const t = task || { title: '', weight: 2, repeat: p.date ? 'none' : 'daily', time: '', days: [], date: p.date || '', assignee: p.assignee || (!isParent() ? (meId() || null) : null) };
  let weight = t.weight, repeat = t.repeat;
  const days = new Set(t.days.length ? t.days : ALL_DAYS);
  const skips = new Set(t.skips || []);

  const title = h('input', { type: 'text', id: 'f-title', value: t.title, maxlength: 60, required: true, placeholder: 'np. Opróżnić zmywarkę' });
  const time = h('input', { type: 'time', id: 'f-time', value: t.time });
  const date = h('input', { type: 'date', id: 'f-date', value: t.date, oninput: () => drawDynamic() });
  const dayBox = h('div', { class: 'chips', role: 'group', 'aria-label': 'Dni tygodnia' });
  const weightBox = h('div', { class: 'chips', role: 'group', 'aria-label': 'Ciężar zadania' });
  const timeWrap = h('div', {}, h('label', { for: 'f-time' }, 'O której godzinie?'), time);
  const dayWrap = h('div', {}, h('label', {}, 'W które dni?'), dayBox);
  const dateWrap = h('div', {}, h('label', { for: 'f-date' }, 'Data (puste = do skutku)'), date);
  const skipBox = h('div', { class: 'chips' });
  const skipWrap = h('div', {}, h('label', {}, 'Pominięte dni (dotknij, żeby przywrócić)'), skipBox);
  const repeatSel = h('select', { id: 'f-repeat', onchange: (e) => { repeat = e.target.value; if (repeat === 'days' && days.size === 0) ALL_DAYS.forEach((d) => days.add(d)); drawDynamic(); } },
    Object.entries(REPEATS).map(([v, l]) => h('option', { value: v, selected: v === t.repeat }, l)));
  const hint = h('p', { class: 'sub hint', hidden: true });
  const submitBtn = h('button', { type: 'submit', class: 'btn' }, 'Zapisz');
  const assignee = h('select', { id: 'f-assignee', onchange: () => updateHint() },
    h('option', { value: '' }, 'Dla wszystkich (wspólne)'),
    state.members.map((m) => h('option', { value: m.id, selected: m.id === t.assignee }, `${m.name} (${ROLES[m.role].toLowerCase()})`)));
  /* Informacja, czy zadanie trafi do potwierdzenia, i odpowiednia etykieta przycisku. */
  function updateHint() {
    const a = assignee.value || null;
    const pend = !isNew && isPending(task) ? true : (needsApproval(a) && (isNew || a !== task.assignee));
    let text = '';
    if (!isNew && isPending(task)) text = 'To zadanie czeka na potwierdzenie.';
    else if (pend) text = `To zadanie wymaga potwierdzenia: ${approverText(a)}. Do tego czasu będzie blade i bez przypomnień.`;    hint.textContent = text;
    hint.hidden = !text;
    submitBtn.textContent = pend && (isNew || !isPending(task)) ? 'Wyślij do potwierdzenia' : 'Zapisz';
  }

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
    const todayKey = dayKey(new Date());
    const upcoming = [...skips].filter((k) => k >= todayKey).sort();
    skipBox.replaceChildren(...upcoming.map((k) => h('button', {
      type: 'button', class: 'chip small', onclick: () => { skips.delete(k); drawDynamic(); },
    }, `${k.slice(8, 10)}.${k.slice(5, 7)} ✕`)));
    skipWrap.hidden = upcoming.length === 0 || (repeat !== 'daily' && repeat !== 'days');
  }
  drawDynamic();
  updateHint();

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
        skips: [...skips].sort(),
      };
      // potwierdzanie: nowa propozycja albo zmiana osoby na innego rodzica
      if (isNew) {
        if (needsApproval(data.assignee)) { data.status = 'pending'; data.proposedBy = meId(); }
        else { data.status = 'active'; data.proposedBy = ''; }
      } else if (isPending(task)) {
        data.status = 'pending'; data.proposedBy = task.proposedBy;
      } else if (needsApproval(data.assignee) && data.assignee !== task.assignee) {
        data.status = 'pending'; data.proposedBy = meId();
      } else {
        data.status = 'active'; data.proposedBy = task.proposedBy || '';
      }
      if (isNew) state.tasks.push({ id: uid(), ...data, created: Date.now() }); else Object.assign(task, data);
      save(); closeDialog(); render();
    },
  },
    h('label', { for: 'f-title' }, 'Co trzeba zrobić?'), title,
    h('label', { for: 'f-assignee' }, 'Dla kogo?'), assignee, hint,
    h('label', { for: 'f-repeat' }, 'Jak często?'), repeatSel,
    dayWrap, dateWrap, timeWrap,
    h('label', {}, 'Ile wysiłku to wymaga?'), weightBox,
    skipWrap,
    h('div', { class: 'actions' },
      !isNew && (isParent()
        ? h('button', { type: 'button', class: 'btn danger', onclick: () => askDeleteTask(task, p.day) }, 'Usuń')
        : h('button', { type: 'button', class: 'btn danger', onclick: () => withdrawDialog(task) }, 'Wycofaj')),
      h('span', { class: 'spacer' }),
      cancelBtn(), submitBtn));
  openDialog(isNew ? (isParent() ? 'Nowe zadanie' : 'Zaproponuj zadanie') : 'Edytuj zadanie', form);
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
        'To urządzenie przestanie się synchronizować i dostawać powiadomienia. Dane zostaną tu jako kopia lokalna.',
        () => { Push.disable().finally(() => Cloud.leave()); }, 'Tak, odłącz') }, 'Odłącz to urządzenie'))];
}

const APP_VERSION = '2026-11-27-g';

/* Wymusza pobranie najnowszych plików i nowego service workera (przydatne na iPhonie). */
async function refreshApp() {
  openDialog('Odświeżanie…', h('p', { class: 'sub' }, 'Chwileczkę…'));
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.update().catch(() => {})));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (e) { /* i tak przeładuj */ }
  location.reload();
}
function infoSection() {
  const sw = h('span', {}, 'sprawdzanie…');
  if ('caches' in window) {
    caches.keys().then((k) => { sw.textContent = k.length ? k.join(', ') : 'brak'; }).catch(() => { sw.textContent = 'brak danych'; });
  } else sw.textContent = 'brak';
  return [h('h2', {}, 'Informacje'),
    h('p', { class: 'sub' }, 'Wersja aplikacji: ', APP_VERSION, h('br'), 'Pamięć podręczna (service worker): ', sw),
    'serviceWorker' in navigator && h('button', { class: 'btn ghost', onclick: refreshApp }, 'Odśwież aplikację')];
}

function pushSection() {
  if (!Cloud.configured || !Cloud.connected || !Push.available) return null;
  const st = Push.state();
  const note = (text) => h('p', { class: 'sub' }, text);
  const out = [h('h2', {}, 'Powiadomienia'), note('Telefon da znać o nowym zadaniu i gdy zadanie jest spóźnione.')];
  if (!Cloud.me) out.push(note('Najpierw wybierz swój profil powyżej, żeby powiadomienia trafiały do Ciebie.'));
  if (st === 'install') {
    out.push(note('Na iPhonie powiadomienia działają tylko z aplikacji dodanej do ekranu początkowego (Safari → Udostępnij → Dodaj do ekranu początkowego, iOS 16.4 lub nowszy). Otwórz aplikację z ikony i włącz je tam.'));
  } else if (st === 'unsupported') {
    out.push(note('Ta przeglądarka nie obsługuje powiadomień push. Na Androidzie użyj Chrome.'));
  } else if (st === 'denied') {
    out.push(note('Powiadomienia są zablokowane. Odblokuj je w ustawieniach telefonu (iPhone: Ustawienia → Powiadomienia → Misja Dom; Android: ustawienia aplikacji → Powiadomienia).'));
  } else if (st === 'off') {
    out.push(h('div', { class: 'row wrap' },
      h('button', { class: 'btn', onclick: () => withBusy('Włączanie powiadomień…', () => Push.enable()) }, 'Włącz powiadomienia')));
  } else {
    out.push(h('div', { class: 'meta' }, '✓ Powiadomienia włączone na tym urządzeniu'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn ghost', onclick: () => Push.test().catch((e) => notice('Nie udało się', friendlyError(e))) }, 'Pokaż testowe'),
        h('button', { class: 'btn danger', onclick: () => withBusy('Wyłączanie…', () => Push.disable()) }, 'Wyłącz')));
  }
  return out;
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

function deleteTaskEverywhere(task) {
  state.tasks = state.tasks.filter((x) => x.id !== task.id);
  save(); render();
}
function skipTaskOn(task, d) {
  const k = dayKey(d);
  task.skips = [...new Set([...(task.skips || []), k])].sort();
  save(); render();
}
/* Usuwanie: przy zadaniu powtarzającym się (codziennie / wybrane dni) pytamy, czy tylko ten dzień, czy całość. */
function askDeleteTask(task, d) {
  const repeating = (task.repeat === 'daily' || task.repeat === 'days') && d;
  if (!repeating) {
    confirmDelete(
      `Usunąć zadanie „${task.title}”?` + (task.repeat === 'weekly' ? ' Zniknie z kolejnych tygodni.' : '') + ' Historia wykonanych zadań zostanie.',
      () => deleteTaskEverywhere(task));
    return;
  }
  const today = startOfDay(new Date());
  const days = Math.round((startOfDay(d) - today) / 864e5);
  const dayWord = days === 0 ? 'dzisiaj' : days === 1 ? 'jutro' : `${DAY_SHORT[weekdayIdx(d)]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  openDialog('Usunąć zadanie?',
    h('p', {}, `„${task.title}” powtarza się. Co chcesz usunąć?`),
    h('div', { class: 'actions stack' },
      h('button', { type: 'button', class: 'btn', onclick: () => { closeDialog(); skipTaskOn(task, d); } }, `Tylko ${dayWord}`),
      h('button', { type: 'button', class: 'btn danger', onclick: () => { closeDialog(); deleteTaskEverywhere(task); } }, 'Całe zadanie (wszystkie dni)'),
      cancelBtn()));
}

/* ---------- potwierdzanie propozycji ---------- */
function approveTask(t) {
  t.status = 'active';          // proposedBy zostaje (żeby autor dostał informację o potwierdzeniu)
  save(); render();
}
function rejectTask(t) {
  state.tasks = state.tasks.filter((x) => x.id !== t.id);
  save(); render();
}
function proposalText(t) {
  const who_ = member(t.proposedBy);
  const when = isTimed(t) ? ` o ${t.time}` : '';
  return `${who_ ? who_.name : 'Ktoś'} proponuje: „${t.title}” (${scheduleText(t)}${when}).`;
}
function approveDialog(t) {
  openDialog('Potwierdzić zadanie?', h('p', {}, proposalText(t)),
    h('div', { class: 'actions stack' },
      h('button', { type: 'button', class: 'btn', onclick: () => { closeDialog(); approveTask(t); } }, 'Potwierdź'),
      h('button', { type: 'button', class: 'btn danger', onclick: () => { closeDialog(); rejectTask(t); } }, 'Odrzuć (autor dostanie informację)'),
      cancelBtn()));
}
function withdrawDialog(t) {
  confirmDelete(`Wycofać propozycję „${t.title}”?`, () => rejectTask(t), 'Tak, wycofaj');
}
/* Karta zadania czekającego na potwierdzenie (blada, z przyciskami). */
function pendingCard(t) {
  const m = member(t.assignee), author = member(t.proposedBy);
  const approver = approverOf(t);
  const mine = canApprove(t), own = isAuthor(t);
  const timed = isTimed(t);
  const whenLabel = timed ? t.time : t.date ? t.date.slice(8, 10) + '.' + t.date.slice(5, 7) : 'bez godziny';
  return h('div', { class: 'card pending' },
    h('div', { class: 'time' + (timed ? '' : ' small') }, whenLabel),
    h('button', { class: 'body', disabled: !(own || (isParent() && !mine)), onclick: () => taskForm(t), 'aria-label': `Zadanie czeka na potwierdzenie: ${t.title}` },
      h('div', { class: 'title' }, t.title),
      h('div', { class: 'meta' }, dots(t.weight), h('span', {}, scheduleText(t)), m && who(m),
        h('span', { class: 'badge wait' }, 'Czeka na potwierdzenie'),
        author && h('span', {}, 'od: ', author.name),
        !mine && h('span', {}, `potwierdza: ${approver}`))),
    h('div', { class: 'pbtns' },
      mine && h('button', { class: 'btn small', onclick: () => approveTask(t) }, 'Potwierdź'),
      mine && h('button', { class: 'btn ghost small', onclick: () => confirmDelete(`Odrzucić propozycję „${t.title}”? Autor dostanie informację.`, () => rejectTask(t), 'Tak, odrzuć') }, 'Odrzuć'),
      !mine && own && h('button', { class: 'btn ghost small', onclick: () => withdrawDialog(t) }, 'Wycofaj')));
}
/* Wszystkie propozycje, które mnie dotyczą (rodzic: wszystkie w domu; dziecko: własne). */
function pendingForMe() {
  return state.tasks.filter((t) => isPending(t) && visibleToMe(t));
}

/* Dzień oglądany w zakładce "Dziś": 0 = dziś, -1 = wczoraj ... -14, +1 = jutro. */
const HISTORY_DAYS = 14;
let dayOffset = 0;

function dayLabel(offset) {
  if (offset === 0) return 'Dziś';
  if (offset === -1) return 'Wczoraj';
  if (offset === 1) return 'Jutro';
  const d = addDays(startOfDay(new Date()), offset);
  return `${DAY_SHORT[weekdayIdx(d)]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}
function shiftDay(n) {
  const next = Math.max(-HISTORY_DAYS, dayOffset + n);
  if (next === dayOffset) return false;
  dayOffset = next; render();
  return true;
}
/* Plan: tydzień o 7 dni albo miesiąc o 1. */
function shiftPlan(n) {
  planAnchor = addDays(startOfDay(planAnchor), (planMode === 'week' ? 7 : 30) * n);
  render();
  return true;
}
function dayNav() {
  const go = (n) => { shiftDay(n); };
  return h('div', { class: 'plan-nav daynav' },
    h('button', { class: 'btn ghost small', disabled: dayOffset <= -HISTORY_DAYS, onclick: () => go(-1), 'aria-label': 'Poprzedni dzień' }, '‹'),
    h('strong', {}, dayLabel(dayOffset)),
    h('div', { class: 'row' },
      dayOffset !== 0 && h('button', { class: 'btn ghost small', onclick: () => { dayOffset = 0; render(); } }, 'Dziś'),
      h('button', { class: 'btn ghost small', onclick: () => go(1), 'aria-label': 'Następny dzień' }, '›')));
}

function taskCard({ t, done, status }) {
  const parent = isParent();
  const m = done ? member(done.memberId) : member(t.assignee);
  const timed = isTimed(t);
  const isToday = dayOffset === 0, past = dayOffset < 0;
  const canUndo = isToday && done && (parent || done.memberId === meId());
  const badge = status === 'late' || status === 'overdue' ? h('span', { class: 'badge bad' }, 'Spóźnione')
    : status === 'missed' ? h('span', { class: 'badge bad' }, 'Niezrobione')
    : status === 'soon' ? h('span', { class: 'badge soon' }, 'Zaraz') : null;
  const editable = parent && !past && !t.deleted;
  const viewDay = addDays(startOfDay(new Date()), dayOffset);
  return h('div', { class: `card st-${status}` + (done ? ' done' : '') },
    h('div', { class: 'time' + (timed ? '' : ' small') }, timed ? t.time : t.repeat === 'weekly' ? 'w tygodniu' : 'w ciągu dnia'),
    h('button', { class: 'body', disabled: !editable, onclick: () => taskForm(t, { day: viewDay }), 'aria-label': editable ? `Edytuj: ${t.title}` : t.title },
      h('div', { class: 'title' }, t.title),
      h('div', { class: 'meta' }, dots(t.weight), t.deleted ? h('span', {}, 'zadanie usunięte') : h('span', {}, scheduleText(t)),
        done ? h('span', {}, '✓ ', m ? m.name : 'ktoś', ' · ', fmtTime(done.ts)) : (m && who(m)), badge)),
    editable && h('button', { class: 'icon-btn', 'aria-label': `Usuń zadanie: ${t.title}`, title: 'Usuń zadanie', onclick: () => askDeleteTask(t, viewDay) }, '✕'),
    isToday
      ? (done
        ? (canUndo && h('button', { class: 'btn ghost small', onclick: () => undo(done) }, 'Cofnij'))
        : h('button', { class: 'btn', onclick: () => onDone(t) }, 'Zrobione'))
      : null);
}

function renderTasks() {
  const parent = isParent();
  const me = meId();
  const viewDay = addDays(startOfDay(new Date()), dayOffset);
  const isToday = dayOffset === 0, past = dayOffset < 0;
  let items = isToday ? todayItems(new Date()) : itemsFor(viewDay);
  if (!parent) items = items.filter((i) => !i.t.assignee || i.t.assignee === me);
  else if (filterMember) items = items.filter((i) => i.t.assignee === filterMember);
  const todo = items.filter((i) => !i.done), done = items.filter((i) => i.done);
  const total = items.length;
  const pct = total ? Math.round((done.length / total) * 100) : 0;
  const dateText = viewDay.toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });
  const meM = member(me);
  const title = isToday ? (parent ? 'Dziś w domu' : meM ? `Cześć, ${meM.name}` : 'Moje zadania')
    : past ? (dayOffset === -1 ? 'Wczoraj' : 'Historia') : (dayOffset === 1 ? 'Jutro' : dayLabel(dayOffset));
  const emptyText = !isToday ? (past ? 'Brak zadań tego dnia.' : 'Nic nie zaplanowano na ten dzień.')
    : (parent ? 'Brak zadań na dziś. Dodaj plan przyciskiem +.' : 'Na dziś nic do zrobienia.');
  return h('section', {},
    h('h1', {}, title),
    h('p', { class: 'sub' }, dateText),
    dayNav(),
    past && h('div', { class: 'note' }, `Historia z ostatnich ${HISTORY_DAYS} dni. Starsze dni usuwają się automatycznie.`),
    parent && state.members.length > 1 && h('div', { class: 'chips filter', role: 'group', 'aria-label': 'Filtr osoby' },
      h('button', { class: 'chip small', 'aria-pressed': String(!filterMember), onclick: () => { filterMember = null; render(); } }, 'Wszyscy'),
      state.members.map((m) => h('button', { class: 'chip small', 'aria-pressed': String(filterMember === m.id), onclick: () => { filterMember = m.id; render(); } }, who(m)))),
    !parent && !me && h('div', { class: 'note' }, 'Nie wybrano Twojego profilu. ',
      h('button', { class: 'btn small', onclick: chooseMeDialog }, 'Wybierz, kim jesteś')),
    isToday && pendingForMe().length > 0 && h('div', { class: 'pending-block' },
      h('h2', {}, `Do potwierdzenia (${pendingForMe().length})`),
      pendingForMe().map(pendingCard)),
    total > 0 && h('div', {},
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${pct}%` })),
      h('small', { class: 'sub' }, `${done.length} z ${total} zrobione`)),
    total === 0 && h('div', { class: 'empty' }, emptyText),
    todo.length > 0 && h('h2', {}, isToday ? 'Do zrobienia' : past ? 'Niezrobione' : 'Zaplanowane'),
    todo.map(taskCard),
    done.length > 0 && h('h2', {}, 'Zrobione'),
    done.map(taskCard),
    canAdd() && !past && h('button', { class: 'fab', onclick: () => taskForm(null, isToday ? null : { date: dayKey(viewDay) }), 'aria-label': parent ? 'Dodaj zadanie' : 'Zaproponuj zadanie' }, '+'));
}

function renderStats() {
  const now = new Date();
  const from = (range === 'week' ? startOfWeek(now) : addDays(startOfDay(now), -HISTORY_DAYS)).getTime();
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
      h('button', { 'aria-pressed': String(range === 'month'), onclick: () => { range = 'month'; render(); } }, 'Ostatnie 2 tygodnie')),
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
    pushSection(),
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
      }) }, 'Usuń wszystkie dane'),
    infoSection());
}

/* ---------- plan: tydzień i miesiąc ---------- */
const MARK = { done: '✓', missed: '!', overdue: '!', upcoming: '', pending: '…' };
function planRow({ t, done, status }, d) {
  const parent = isParent();
  const m = done ? member(done.memberId) : member(t.assignee);
  const past = d && startOfDay(d) < startOfDay(new Date());
  const pending = status === 'pending';
  // propozycja: potwierdzający widzi okno potwierdzenia, autor może ją edytować, reszta tylko widzi
  const onTap = pending
    ? (canApprove(t) ? () => approveDialog(t) : isAuthor(t) || parent ? () => taskForm(t, d ? { day: d } : null) : null)
    : () => taskForm(t, d ? { day: d } : null);
  const disabled = pending ? !onTap : (!parent || past);
  return h('button', { class: `prow st-${status}`, disabled, onclick: onTap || undefined, 'aria-label': pending ? `${t.title} (czeka na potwierdzenie)` : t.title },
    h('span', { class: 'ptime' }, isTimed(t) ? t.time : ''),
    h('span', { class: 'ptitle' }, t.title),
    m && h('i', { class: 'dot', style: `--c:${m.color}`, title: m.name }),
    h('span', { class: 'pmark', 'aria-hidden': 'true' }, MARK[status]));
}
function dayBlock(d, { showHeader = true } = {}) {
  const parent = isParent();
  const today = new Date();
  const items = itemsOn(d, true);
  const done = items.filter((i) => i.status === 'done').length;
  return h('div', { class: 'dayblock' },
    showHeader && h('div', { class: 'dayhead' + (sameDay(d, today) ? ' today' : '') },
      h('strong', {}, `${DAY_SHORT[weekdayIdx(d)]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`),
      h('span', { class: 'sub' }, items.length ? `${done}/${items.length}` : ''),
      canAdd() && startOfDay(d) >= startOfDay(today) && h('button', { class: 'icon-btn add', 'aria-label': `Dodaj zadanie na ${dayKey(d)}`, onclick: () => taskForm(null, { date: dayKey(d) }) }, '+')),
    items.length ? items.map((i) => planRow(i, d)) : h('div', { class: 'empty-day' }, 'Brak zadań'));
}
function planNav(title, onPrev, onNext) {
  return h('div', { class: 'plan-nav' },
    h('button', { class: 'btn ghost small', onclick: onPrev, 'aria-label': 'Wstecz' }, '‹'),
    h('strong', {}, title),
    h('div', { class: 'row' },
      h('button', { class: 'btn ghost small', onclick: () => { planAnchor = startOfDay(new Date()); planDay = startOfDay(new Date()); render(); } }, 'Dziś'),
      h('button', { class: 'btn ghost small', onclick: onNext, 'aria-label': 'Dalej' }, '›')));
}
/* Okno kroczące: 7 dni licząc od wybranego dnia (domyślnie od dziś), przesuwane co 7 dni. */
function weekView() {
  const start = startOfDay(planAnchor);
  const end = addDays(start, 6);
  const title = `${start.getDate()} ${MONTHS_SHORT[start.getMonth()]} – ${end.getDate()} ${MONTHS_SHORT[end.getMonth()]} ${end.getFullYear()}`;
  const floating = weekFloating(startOfWeek(start));
  return [
    planNav(title, () => { planAnchor = addDays(start, -7); render(); }, () => { planAnchor = addDays(start, 7); render(); }),
    ...Array.from({ length: 7 }, (_, i) => dayBlock(addDays(start, i))),
    floating.length > 0 && h('div', { class: 'dayblock' },
      h('div', { class: 'dayhead' }, h('strong', {}, 'W ciągu tygodnia'), h('span', { class: 'sub' }, 'bez konkretnego dnia')),
      floating.map((i) => planRow(i, null)))];
}
/* Okno kroczące: 30 dni licząc od wybranego dnia (domyślnie od dziś), przesuwane co 30 dni. */
const MONTH_SPAN = 30;
function monthView() {
  const start = startOfDay(planAnchor);
  const end = addDays(start, MONTH_SPAN - 1);
  const title = `${start.getDate()} ${MONTHS_SHORT[start.getMonth()]} – ${end.getDate()} ${MONTHS_SHORT[end.getMonth()]} ${end.getFullYear()}`;
  const today = startOfDay(new Date());
  // wybrany dzień musi mieścić się w oknie: jeśli nie, wybierz dziś (gdy jest w oknie) albo pierwszy dzień okna
  if (planDay < start || planDay > end) planDay = (today >= start && today <= end) ? today : start;
  const days = Array.from({ length: MONTH_SPAN }, (_, i) => addDays(start, i));
  const lead = weekdayIdx(start);   // puste pola, żeby dni stały pod właściwymi dniami tygodnia
  const grid = h('div', { class: 'mgrid' },
    DAY_SHORT.map((n) => h('div', { class: 'mhead' }, n)),
    Array.from({ length: lead }, () => h('div', { class: 'mblank' })),
    days.map((d, i) => {
      const items = itemsOn(d, true);
      const colors = [...new Set(items.map((x) => (member(x.t.assignee) || { color: 'var(--muted)' }).color))].slice(0, 3);
      const cls = 'mcell' + (sameDay(d, today) ? ' today' : '') + (sameDay(d, planDay) ? ' sel' : '');
      const monthMark = (i === 0 || d.getDate() === 1) ? h('span', { class: 'mmon' }, MONTHS_SHORT[d.getMonth()]) : null;
      return h('button', { class: cls, onclick: () => { planDay = d; render(); }, 'aria-label': `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}, zadań: ${items.length}`, 'aria-pressed': String(sameDay(d, planDay)) },
        h('span', {}, d.getDate()),
        monthMark,
        h('span', { class: 'mdots' }, colors.map((c) => h('i', { style: `--c:${c}` }))),
        h('span', { class: 'mcount' }, items.length ? items.length : ''));
    }));
  return [
    planNav(title, () => { planAnchor = addDays(start, -MONTH_SPAN); render(); }, () => { planAnchor = addDays(start, MONTH_SPAN); render(); }),
    grid,
    h('h2', {}, `${DAY_SHORT[weekdayIdx(planDay)]} ${planDay.getDate()} ${MONTHS_GEN[planDay.getMonth()]}`),
    dayBlock(planDay, { showHeader: false }),
    canAdd() && startOfDay(planDay) >= startOfDay(new Date()) && h('button', { class: 'btn ghost', onclick: () => taskForm(null, { date: dayKey(planDay) }) }, isParent() ? '+ Dodaj zadanie na ten dzień' : '+ Zaproponuj zadanie na ten dzień')];
}
function renderPlan() {
  return h('section', {},
    h('h1', {}, 'Plan'),
    h('p', { class: 'sub' }, isParent() ? 'Zadania na kolejne dni. Dotknij zadania, żeby je zmienić, albo „+”, żeby dodać nowe.' : 'Twoje zadania na kolejne dni.'),
    isParent() && state.members.length > 1 && h('div', { class: 'chips filter', role: 'group', 'aria-label': 'Filtr osoby' },
      h('button', { class: 'chip small', 'aria-pressed': String(!filterMember), onclick: () => { filterMember = null; render(); } }, 'Wszyscy'),
      state.members.map((m) => h('button', { class: 'chip small', 'aria-pressed': String(filterMember === m.id), onclick: () => { filterMember = m.id; render(); } }, who(m)))),
    h('div', { class: 'seg', role: 'group' },
      h('button', { 'aria-pressed': String(planMode === 'week'), onclick: () => { planMode = 'week'; render(); } }, '7 dni'),
      h('button', { 'aria-pressed': String(planMode === 'month'), onclick: () => { planMode = 'month'; render(); } }, '30 dni')),
    planMode === 'week' ? weekView() : monthView());
}

function renderNav() {
  const items = [['tasks', '✓', 'Dziś'], ['plan', '▦', 'Plan']];
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
  app.replaceChildren(tab === 'stats' ? renderStats() : tab === 'home' ? renderHome() : tab === 'plan' ? renderPlan() : renderTasks());
  nav.replaceChildren(...renderNav());
}

/* ---------- gest przesunięcia palcem: w lewo = dalej, w prawo = wstecz ---------- */
(function enableSwipe() {
  const area = document.getElementById('app');
  let start = null;
  const interactive = (el) => el && el.closest && el.closest('input, select, textarea, dialog');
  area.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || dlg.open || interactive(e.target)) { start = null; return; }
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY, at: Date.now() };
  }, { passive: true });
  area.addEventListener('touchend', (e) => {
    if (!start || dlg.open) { start = null; return; }
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x, dy = t.clientY - start.y, dt = Date.now() - start.at;
    start = null;
    // wyraźnie poziomy, wystarczająco długi i szybki ruch (żeby nie mylić z przewijaniem)
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.6 || dt > 800) return;
    const n = dx < 0 ? 1 : -1;
    let moved = false;
    if (tab === 'tasks') moved = shiftDay(n);
    else if (tab === 'plan') moved = shiftPlan(n);
    if (moved && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const sec = area.firstElementChild;
      if (sec) sec.classList.add(n > 0 ? 'slide-from-right' : 'slide-from-left');
    }
  }, { passive: true });
})();

/* ---------- start ---------- */
const idle = () => { const a = document.activeElement; return !document.hidden && !dlg.open && !(a && (a.tagName === 'INPUT' || a.tagName === 'SELECT')); };
Cloud.onUpdate = (statusOnly) => {
  if (statusOnly && tab !== 'home') return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'SELECT') && !dlg.open) return;   // nie psuj pisania
  render();
};
if (pruneOld()) save();
render();
Cloud.init();
setTimeout(() => { Push.resave().catch(() => {}); }, 5000);   // odśwież zapis subskrypcji push po synchronizacji
setInterval(() => {
  if (pruneOld()) save();
  if ((tab === 'tasks' || tab === 'plan') && state.members.length && idle()) render();
}, 60000);   // przeliczanie „Zaraz” i „Spóźnione”
document.addEventListener('visibilitychange', () => { if (idle() && tab === 'tasks') render(); });
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
