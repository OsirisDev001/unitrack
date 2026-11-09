import {
  DEFAULT_LIMIT, normalizeSkips, semesterStats, pendingSkips, semesterOf, groupBySemester, normalizeSchedule,
  lessonStatus, nextLesson, subjectsFrom, taskBucket, BUCKETS, sortTasks, relativeDue, sameDay,
  pluralHours, pluralPairs, lessonPhase, HALF, BREAK,
  normalizeTeachers, mondayOf, addDays, isoDate, buildWeek, weekLessons, forecastWeek, weekLabel, parseIsoDate,
} from "./logic.js";
import { demoBackend } from "./demo.js";
import {
  groupCatalog, shortGroup, diffWeeks, slotKey, changeText, durationText, whereNow,
  relinkTasks, subjectsWithTypes, occurrences, kindOf, lessonDue, slotLabel, dayTogether, predictLessonNumbers,
} from "./schedule.js";
import {
  normalizeProgress, progressBySemester, normalizeAttestation, normalizeRating, normalizeLibrary, normalizeHostel,
  normalizeOrders, normalizeGroups, normalizeProfile, shortFio, initials,
  normalizeCourses, courseUrl, currentSemesterNumber, currentCourses, normalizePerformance,
} from "./study.js";

/** Ссылки на сайт открываем во внешнем браузере (там пользователь уже залогинен). */
function openExternal(url) {
  const opener = window.__TAURI__?.opener;
  if (opener?.openUrl) opener.openUrl(url).catch(() => window.open(url, "_blank"));
  else window.open(url, "_blank", "noopener");
}

// ---------- бэкенд ----------

const tauri = window.__TAURI__?.core;
const api = tauri
  ? {
      savedUsername: () => tauri.invoke("saved_username"),
      login: (username, password) => tauri.invoke("login", { username, password }),
      logout: () => tauri.invoke("logout"),
      fetch: (method) => tauri.invoke("fetch_api", { method }),
      cached: (method) => tauri.invoke("cached_api", { method }),
      load: (key) => tauri.invoke("load_data", { key }),
      save: (key, value) => tauri.invoke("save_data", { key, value }),
      syncInfo: () => tauri.invoke("sync_info"),
      syncNow: (lastAddress, pin) => tauri.invoke("sync_now", { lastAddress, pin }),
      onTasksUpdated: (cb) => window.__TAURI__.event.listen("tasks-updated", cb),
      checkUpdate: () => tauri.invoke("check_update"),
      installUpdate: (url) => tauri.invoke("install_update", { url }),
      version: () => window.__TAURI__.app.getVersion(),
      fetchWeek: (monday, sunday) => tauri.invoke("fetch_week", { monday, sunday }),
      cachedWeek: (monday) => tauri.invoke("cached_week", { monday }),
      fetchTeachers: () => tauri.invoke("fetch_teachers"),
      cachedTeachers: () => tauri.invoke("cached_teachers"),
      lookupStudent: (login) => tauri.invoke("lookup_student", { login }),
      fetchSchedule: (kind, id, monday, sunday) => tauri.invoke("fetch_schedule", { kind, id, monday, sunday }),
      cachedSchedule: (kind, id, monday) => tauri.invoke("cached_schedule", { kind, id, monday }),
      fetchFaculties: () => tauri.invoke("fetch_faculties"),
      fetchGroups: (faculty, course) => tauri.invoke("fetch_groups", { faculty, course }),
      fetchPerformance: (kdisc, semester, year, lang) => tauri.invoke("fetch_performance", { kdisc, semester, year, lang }),
      cachedPerformance: (kdisc, semester, year) => tauri.invoke("cached_performance", { kdisc, semester, year }),
      setAppIcon: (name) => tauri.invoke("set_app_icon", { name }),
    }
  : demoBackend();

// ---------- состояние ----------

const state = {
  view: "today",
  username: null,
  skips: [],
  days: [],            // текущая + следующая неделя — для «Сегодня» и подсказок
  cabinetRaw: null,    // расписание из кабинета (запасной источник)
  weekRaw: new Map(),  // понедельник → ответ публичного API
  weekFetched: new Set(),
  teachers: new Map(),
  weekStart: null,     // какая неделя открыта в «Расписании»
  viewing: null,       // чьё расписание открыто: null — моё, иначе { kind, id, title, sub }
  otherRaw: new Map(), // чужие недели: "kind:id:понедельник" → ответ API
  favorites: [],       // синхронизируется между устройствами, как задачи
  skipMarks: [],       // свои записи о пропусках, пока деканат не внёс; тоже синхронизируются
  changes: {},         // понедельник → { list, seen } — что поменялось в моём расписании
  search: { tab: "group", faculties: null, catalogs: {}, openFaculty: null, openSpec: null, query: "", student: null, studentErr: "", busy: false },
  windowsWith: null,
  perf: new Map(),      // kdisc → { course, items } — журнал предмета
  perfIndex: new Map(), // "дата|время" → { kdisc, item } — чтобы найти номер и тему пары в расписании
  perfNext: new Map(),  // "дата|время" → { kdisc, item } — досчитанные номера пар, которых ещё нет в журнале
  journal: null,        // какой журнал открыт
  tasks: [],
  settings: { limit: DEFAULT_LIMIT },
  selectedDay: null,
  lastSync: null,
  syncing: false,
  syncError: null,
  editingId: null,
  study: {},
  detail: null,
};

// Разделы «Учёбы» — методы API кабинета (только чтение).
const STUDY_METHODS = ["getCoursesData", "getChoosenCourses", "getProgress", "getAttestation", "getStatistics", "getLibrary", "getHostel", "getStudentOrders", "getGroups"];

const $ = (s, root = document) => root.querySelector(s);

// el.html = "…" перерисовывает элемент только если разметка поменялась —
// так карточки не мигают и анимации не перезапускаются при каждом тике таймера.
Object.defineProperty(Element.prototype, "html", {
  set(v) {
    if (this._html === v) return;
    this._html = v;
    this.innerHTML = v;
    countUp(this);
  },
  get() { return this.innerHTML; },
});
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtDay = (d, o) => d.toLocaleDateString("ru-RU", o);

// ---------- хранение ----------

async function loadLocal() {
  try { state.tasks = JSON.parse((await api.load("tasks")) || "[]"); } catch { state.tasks = []; }
  try { Object.assign(state.settings, JSON.parse((await api.load("settings")) || "{}")); } catch {}
  try { state.lastSync = Number(await api.load("last_sync")) || null; } catch {}
  try { state.favorites = JSON.parse((await api.load("favorites")) || "[]"); } catch { state.favorites = []; }
  try { state.skipMarks = JSON.parse((await api.load("skip_marks")) || "[]"); } catch { state.skipMarks = []; }
  // 0.3.1: новый ключ — старые пометки копились и с выходных, пока неделю только заполняли; начинаем с чистого листа.
  try { state.changes = JSON.parse((await api.load("sched_changes2")) || "{}"); } catch { state.changes = {}; }
  const old = isoDate(addDays(mondayOf(new Date()), -7));
  for (const k of Object.keys(state.changes)) if (k < old) delete state.changes[k];
}
// Удалённые задачи остаются «надгробиями» (deleted: true), чтобы удаление доехало до другого устройства.
const liveTasks = () => state.tasks.filter((t) => !t.deleted);
const touch = (t) => { t.updated = Date.now(); return t; };
async function saveTasks() {
  await api.save("tasks", JSON.stringify(state.tasks));
  scheduleSync();
}
const saveSettings = () => api.save("settings", JSON.stringify(state.settings));
const saveChanges = () => api.save("sched_changes2", JSON.stringify(state.changes));

// ---------- избранное ----------

const favId = (who) => `${who.kind}:${who.id}`;
const liveFavs = () => state.favorites.filter((f) => !f.deleted);
const isFav = (who) => liveFavs().some((f) => f.id === favId(who));
async function saveFavorites() {
  await api.save("favorites", JSON.stringify(state.favorites));
  scheduleSync();
}
function toggleFavorite(who) {
  const id = favId(who);
  const f = state.favorites.find((x) => x.id === id);
  if (f && !f.deleted) { f.deleted = true; touch(f); toast("Убрано из избранного"); }
  else if (f) { Object.assign(f, { deleted: false, title: who.title, sub: who.sub }); touch(f); toast("Добавлено в избранное"); }
  else { state.favorites.push(touch({ id, kind: who.kind, refId: who.id, title: who.title, sub: who.sub || "", created: Date.now() })); toast("Добавлено в избранное"); }
  saveFavorites();
  renderSchedule();
}
const favToWho = (f) => ({ kind: f.kind, id: f.refId, title: f.title, sub: f.sub });

async function loadCache() {
  const [sk, sc] = await Promise.all([api.cached("getSkips"), api.cached("getStudentSchedule")]);
  if (sk) try { state.skips = normalizeSkips(JSON.parse(sk)); } catch {}
  if (sc) try { state.cabinetRaw = JSON.parse(sc); } catch {}
  const tc = await api.cachedTeachers?.();
  if (tc) try { state.teachers = normalizeTeachers(JSON.parse(tc)); } catch {}
  const cur = mondayOf(new Date());
  await Promise.all([addDays(cur, -7), cur, addDays(cur, 7)].map(async (m) => {
    const raw = await api.cachedWeek?.(isoDate(m));
    if (raw) try { state.weekRaw.set(isoDate(m), JSON.parse(raw)); } catch {}
  }));
  rebuildDays();
  const st = await Promise.all(STUDY_METHODS.map((m) => api.cached(m)));
  STUDY_METHODS.forEach((m, i) => { if (st[i]) try { state.study[m] = JSON.parse(st[i]); } catch {} });
  loadPerformance(false);
}

// ---------- журнал предмета: номера и темы пар ----------

function rebuildPerfIndex() {
  state.perfIndex.clear();
  for (const [kdisc, p] of state.perf) for (const item of p.items) state.perfIndex.set(`${item.date}|${item.start}`, { kdisc, item });
  rebuildPerfNext();
}

/** С какой недели нужно расписание, чтобы досчитать номера: с последней заполненной пары журнала (не дальше 8 недель назад). */
function perfFromMonday() {
  const cur = currentMonday();
  let from = cur;
  for (const p of state.perf.values()) {
    const last = p.items.at(-1);
    if (last) { const m = mondayOf(parseIsoDate(last.date)); if (m < from) from = m; }
  }
  return from < addDays(cur, -56) ? addDays(cur, -56) : from;
}

/** Досчитанные номера пар этой и следующей недели, которых ещё нет в журнале. */
function rebuildPerfNext() {
  state.perfNext.clear();
  if (!state.perf.size) return;
  const lessons = [];
  for (let m = perfFromMonday(); m <= addDays(currentMonday(), 7); m = addDays(m, 7)) {
    for (const d of weekDays(m, null)) for (const l of d.lessons) lessons.push({ l, date: isoDate(d.date) });
  }
  state.perfNext = predictLessonNumbers(lessons, new Map([...state.perf].map(([k, p]) => [k, p.items])));
}

/** Пара из моего расписания → строка журнала (по дате и времени), а если её ещё не внесли — досчитанный номер. */
const perfFor = (day, l) => state.perfIndex.get(`${isoDate(day.date)}|${l.start}`) || state.perfNext.get(`${isoDate(day.date)}|${l.start}`);

/** Журналы предметов текущего семестра: сразу из сохранённого, потом с сайта (по 3 запроса за раз). */
async function loadPerformance(fetchFresh) {
  if (!api.cachedPerformance) return;
  const courses = currentCourses(study("getCoursesData"));
  const lang = study("getChoosenCourses")?.student?.K_LANGVICHEDU;
  for (const c of courses) {
    if (state.perf.has(c.kdisc)) continue;
    const raw = await api.cachedPerformance(c.kdisc, c.semestr, c.year);
    if (raw) try { state.perf.set(c.kdisc, { course: c, items: normalizePerformance(JSON.parse(raw)) }); } catch {}
  }
  rebuildPerfIndex();
  renderSchedule();
  if (!fetchFresh) return;
  const queue = [...courses];
  const worker = async () => {
    for (let c; (c = queue.shift());) {
      try {
        const raw = await api.fetchPerformance(c.kdisc, c.semestr, c.year, lang ? String(lang) : null);
        state.perf.set(c.kdisc, { course: c, items: normalizePerformance(JSON.parse(raw)) });
      } catch {}
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  rebuildPerfIndex();
  // Для досчёта номеров нужно расписание с последней заполненной пары — подгружаем эти недели (они кэшируются).
  for (let m = perfFromMonday(); m < currentMonday(); m = addDays(m, 7)) loadWeek(m, null);
  renderSchedule();
  renderToday();
  if (state.view === "journal") renderJournal();
}

/** Раздел «Учёба» тянем вторым заходом: он не должен тормозить главный экран. */
async function refreshStudy() {
  const res = await Promise.allSettled(STUDY_METHODS.map((m) => api.fetch(m)));
  res.forEach((r, i) => { if (r.status === "fulfilled") try { state.study[STUDY_METHODS[i]] = JSON.parse(r.value); } catch {} });
  renderStudy();
  renderToday();
  if (state.view === "detail") renderDetail();
  loadPerformance(true);
}

async function refresh() {
  if (state.syncing) return;
  state.syncing = true;
  renderSync();
  const [sk, sc] = await Promise.allSettled([api.fetch("getSkips"), api.fetch("getStudentSchedule")]);
  state.syncing = false;
  const errors = [];
  if (sk.status === "fulfilled") state.skips = normalizeSkips(JSON.parse(sk.value));
  else errors.push(String(sk.reason));
  if (sc.status === "fulfilled") state.cabinetRaw = JSON.parse(sc.value);
  else errors.push(String(sc.reason));
  rebuildDays();

  if (errors.some((e) => e.includes("Нужно войти") || e.includes("Неверный логин"))) {
    showLogin(errors[0]);
    return;
  }
  state.syncError = errors[0] || null;
  if (!errors.length) {
    state.lastSync = Date.now();
    api.save("last_sync", String(state.lastSync));
  }
  renderAll();
  refreshWeeks();
  if (!errors.length) refreshStudy();
}

// ---------- недели расписания ----------

const currentMonday = () => mondayOf(new Date());
const WEEK_MS = 7 * 864e5;
const whoKey = (who, monday) => (who ? `${who.kind}:${who.id}:` : "") + isoDate(monday);
const sameWho = (a, b) => (a?.kind ?? null) === (b?.kind ?? null) && (a?.id ?? null) === (b?.id ?? null);
const rawWeek = (who, monday) => (who ? state.otherRaw : state.weekRaw).get(whoKey(who, monday));

/** Дни недели. Моё: публичное расписание → кабинет. Будущая пустая неделя — прогноз по текущей. */
function weekDays(monday, who = state.viewing, allowForecast = true) {
  const raw = rawWeek(who, monday);
  const pub = raw ? normalizeSchedule(raw, state.teachers) : null;
  const cab = !who && state.cabinetRaw ? normalizeSchedule(state.cabinetRaw, state.teachers) : null;
  const days = buildWeek(monday, pub, cab);
  const cur = currentMonday();
  if (allowForecast && weekLessons(days) === 0 && monday > cur) {
    const base = weekDays(cur, who, false);
    if (weekLessons(base) > 0) return forecastWeek(base, Math.round((monday - cur) / WEEK_MS));
  }
  return days;
}

function rebuildDays() {
  const cur = currentMonday();
  state.days = [...weekDays(cur, null), ...weekDays(addDays(cur, 7), null)];
}

/** Моё расписание на 6 недель вперёд (с прогнозом) — для сроков задач «к паре». */
const planDays = () => [0, 1, 2, 3, 4, 5].flatMap((k) => weekDays(addDays(currentMonday(), 7 * k), null));

/** Неделю показываем сразу из сохранённого, а с сайта обновляем: свежие — всегда, старые — если ещё не скачаны. */
async function loadWeek(monday, who = state.viewing) {
  if (!api.fetchWeek) return;
  const map = who ? state.otherRaw : state.weekRaw;
  const key = whoKey(who, monday);
  const iso = isoDate(monday), sunday = isoDate(addDays(monday, 6));
  if (!map.has(key)) {
    const raw = await (who ? api.cachedSchedule(who.kind, who.id, iso) : api.cachedWeek(iso));
    if (raw) try { map.set(key, JSON.parse(raw)); renderWeekChange(); } catch {}
  }
  const recent = monday >= addDays(currentMonday(), -7);
  if (state.weekFetched.has(key) || (!recent && map.has(key))) return;
  state.weekFetched.add(key);
  state.weekLoading = key;
  if (sameWho(who, state.viewing) && +monday === +state.weekStart) renderSchedule();
  try {
    const fresh = JSON.parse(await (who ? api.fetchSchedule(who.kind, who.id, iso, sunday) : api.fetchWeek(iso, sunday)));
    if (!who) noteChanges(monday, map.get(key), fresh);
    map.set(key, fresh);
  } catch {
    state.weekFetched.delete(key); // нет сети — попробуем в следующий раз
  } finally {
    if (state.weekLoading === key) state.weekLoading = null;
    renderWeekChange();
  }
}

/** Сравниваем сохранённую неделю с новой и копим изменения (A). */
function noteChanges(monday, oldRaw, newRaw) {
  const key = isoDate(monday);
  const norm = (r) => buildWeek(monday, normalizeSchedule(r, state.teachers));
  const fresh = norm(newRaw);
  const found = oldRaw ? diffWeeks(norm(oldRaw), fresh) : [];
  const sig = (c) => `${c.kind}|${c.before ? slotKey(c.before.date, c.before) : ""}|${c.after ? slotKey(c.after.date, c.after) : ""}`;
  const prev = state.changes[key]?.list || [];
  const known = new Set(prev.map(sig));
  // До понедельника 6:00 неделю ещё заполняют: такие правки не считаем изменениями (не подсвечиваем),
  // но запоминаем тихо — по ним сдвигаются сроки задач.
  const quiet = Date.now() < +monday + 6 * 3600e3;
  const added = found.filter((c) => !known.has(sig(c))).map((c) => (quiet ? { ...c, quiet: true } : c));
  const loud = added.filter((c) => !c.quiet);
  // Изменение, которое потом откатили, больше не показываем.
  const slots = new Set(fresh.flatMap((d) => d.lessons.map((l) => slotKey(d.date, l))));
  const list = [...prev, ...added].filter((c) => (c.after ? slots.has(slotKey(c.after.date, c.after)) : !slots.has(slotKey(c.before.date, c.before))));
  if (!list.length) { if (state.changes[key]) { delete state.changes[key]; saveChanges(); } return; }
  state.changes[key] = { list, seen: loud.length ? false : state.changes[key]?.seen ?? !list.some((c) => !c.quiet) };
  saveChanges();
}

/** Изменения, которые показываем: только случившиеся после понедельника 6:00 своей недели. */
const shownChanges = (v) => (v?.list || []).filter((c) => !c.quiet);
const weekChanges = (monday) => shownChanges(state.changes[isoDate(monday)]);
const unseenChanges = () => Object.entries(state.changes).filter(([, v]) => !v.seen && shownChanges(v).length);

/** Пару, к которой привязана задача, перенесли — сдвигаем срок. */
function relinkMine() {
  const cur = currentMonday();
  const weeks = [-1, 0, 1, 2, 3, 4, 5].map((k) => addDays(cur, 7 * k));
  const real = new Set(weeks.filter((m) => weekLessons(weekDays(m, null, false)) > 0).map(isoDate));
  const changes = Object.values(state.changes).flatMap((c) => c.list);
  const moved = relinkTasks(state.tasks, weeks.flatMap((m) => weekDays(m, null, false)), changes, real);
  // Задачи «к следующей практике», когда практики ещё нет в расписании: как только появилась — ставим срок.
  const plan = planDays();
  const found = state.tasks.filter((t) => t.lesson?.pending && !t.done && !t.deleted).flatMap((t) => {
    const o = occurrences(plan, t.lesson.subject, t.lesson.type, new Date(), 1)[0];
    return o ? [linkTask(t, o, t.lesson.type)] : [];
  });
  if (found.length) {
    found.forEach(touch);
    saveTasks();
    const t = found[0];
    toast(found.length === 1 ? `«${t.title}»: пара появилась в расписании, срок — ${slotLabel(t.lesson.date, t.lesson.start)}` : `У ${found.length} задач появилась пара в расписании`);
  }
  if (moved.length) {
    saveTasks();
    toast(moved.length === 1 ? `Срок задачи «${moved[0].title}» сдвинут: пару перенесли` : `Сдвинуты сроки ${moved.length} задач: пары перенесли`);
  }
}

function renderWeekChange() {
  rebuildDays();
  rebuildPerfNext();
  relinkMine();
  renderSchedule();
  renderToday();
  if (state.view === "windows") renderWindows();
  if (state.view === "tasks") renderTasks();
}

async function refreshWeeks() {
  if (!api.fetchTeachers) return;
  try { state.teachers = normalizeTeachers(JSON.parse(await api.fetchTeachers())); } catch {}
  state.weekFetched.clear();
  const cur = currentMonday();
  await Promise.all([cur, addDays(cur, 7)].map((m) => loadWeek(m, null)));
  if (state.viewing || (state.weekStart && ![+cur, +addDays(cur, 7)].includes(+state.weekStart))) loadWeek(state.weekStart || cur);
  renderWeekChange();
}

// ---------- вход ----------

function showLogin(error) {
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#login-error").classList.toggle("hidden", !error);
  $("#login-error").textContent = error || "";
  if (state.username) $("#login-user").value = state.username;
  setTimeout(() => ($("#login-user").value ? $("#login-pass") : $("#login-user")).focus(), 30);
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#login-btn");
  btn.disabled = true;
  btn.textContent = "Входим…";
  $("#login-error").classList.add("hidden");
  try {
    const user = $("#login-user").value.trim();
    await api.login(user, $("#login-pass").value);
    state.username = user;
    $("#login-pass").value = "";
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    renderAll();
    refresh();
  } catch (err) {
    $("#login-error").textContent = String(err);
    $("#login-error").classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Войти";
  }
});

// ---------- навигация ----------

// История браузера = кнопка «Назад» на Android: из любого раздела она возвращает на «Сегодня»,
// а на «Сегодня» истории нет — второе нажатие закрывает приложение.
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function showView(view) {
  const prevView = state.view;
  const apply = () => {
    state.view = view;
    const navView = view === "detail" ? "study" : ["search", "windows", "journal"].includes(view) ? "schedule" : view;
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === navView));
    $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === view));
    if (view === "detail") renderDetail();
    if (view === "schedule" && state.weekStart && +state.weekStart !== +currentMonday() && !["search", "windows", "journal"].includes(prevView)) openWeek(currentMonday());
    $("#who-fab").classList.toggle("hidden", view !== "schedule");
    closeWhoSheet();
    if (view === "search") renderSearch();
    if (view === "journal") renderJournal();
    if (view === "windows") renderWindows();
    movePill();
    window.scrollTo({ top: 0 });
    animateIn($(`.view[data-view="${view}"]`));
  };
  if (document.startViewTransition && !reduceMotion && state.view !== view) document.startViewTransition(apply);
  else apply();
}

function go(view) {
  if (view === state.view) return;
  if (view === "today") {
    if (history.state?.view && history.state.view !== "today") history.back();
    else showView("today");
    return;
  }
  if (history.state?.view && history.state.view !== "today") history.replaceState({ view }, "");
  else history.pushState({ view }, "");
  showView(view);
}

window.addEventListener("popstate", (e) => showView(e.state?.view || "today"));

/** Подсвеченная «таблетка» в меню плавно переезжает под активный пункт. */
function movePill() {
  const nav = $(".nav");
  const active = $(".nav-btn.active");
  const pill = $(".nav-pill");
  if (!nav || !active || !pill) return;
  const n = nav.getBoundingClientRect();
  const a = active.getBoundingClientRect();
  pill.style.transform = `translate(${a.left - n.left}px, ${a.top - n.top}px)`;
  pill.style.width = `${a.width}px`;
  pill.style.height = `${a.height}px`;
  pill.style.opacity = "1";
}
addEventListener("resize", movePill);

/** Карточки появляются волной. */
function animateIn(root) {
  if (!root || reduceMotion) return;
  root.querySelectorAll(".rise, .task, .tile, .lesson, .skip-row, .row-item").forEach((el, i) => {
    el.style.animation = "none";
    void el.offsetWidth;
    el.style.animation = "";
    el.style.animationDelay = `${Math.min(i, 14) * 35}ms`;
  });
}

/** Число докручивается до значения, как баланс в банковском приложении. */
const shownNumbers = new Map();
function countUp(root = document) {
  root.querySelectorAll("[data-count]").forEach((el) => {
    const to = Number(el.dataset.count);
    const key = el.dataset.ck || null;
    const from = key && shownNumbers.has(key) ? shownNumbers.get(key) : 0;
    if (key) shownNumbers.set(key, to);
    if (reduceMotion || from === to) { el.textContent = el.dataset.fmt ? to.toFixed(2) : String(to); return; }
    const t0 = performance.now();
    const dur = 700;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      const v = from + (to - from) * e;
      el.textContent = el.dataset.fmt ? v.toFixed(2) : String(Math.round(v));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), 2600);
}

$$(".nav-btn").forEach((b) => b.addEventListener("click", () => go(b.dataset.view)));
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-go]");
  if (t) go(t.dataset.go);
});
$("#refresh-btn").addEventListener("click", refresh);

// ---------- рендер: общее ----------

/** «практ. зан.» → «практ», «лек.» → «лек»: везде без точек. */
const typeShort = (type) => String(type || "").replace(/\s*зан\.?/, "").replace(/\./g, "").trim();

/** Метка вида пары; с номером из журнала — «практ | 10», нажатие открывает журнал предмета. */
function typeTag(type, pf = null) {
  if (!type) return "";
  const t = type.toLowerCase();
  const cls = t.startsWith("лек") ? "lec" : t.startsWith("лаб") ? "lab" : t.startsWith("практ") ? "prac" : t.startsWith("сем") ? "sem" : "";
  if (!pf) return `<span class="tag tag-${cls}">${esc(typeShort(type))}</span>`;
  return `<button class="tag tag-${cls} tag-num" data-journal="${esc(pf.kdisc)}" data-at="${esc(`${pf.item.date}|${pf.item.start}`)}" title="${esc(pf.item.label)} №${pf.item.n}">${esc(typeShort(type))}<span class="n">${pf.item.n}</span></button>`;
}

const lowerFirst = (t) => t.charAt(0).toLowerCase() + t.slice(1);

function lessonHTML(day, l, now, change = null, mine = true) {
  const pf = mine ? perfFor(day, l) : null;
  // Номер — в метке вида пары («практ | 10»); тема — плашкой снизу, только когда её внесли в журнал.
  const marks = pf ? `${pf.item.absent ? `<i class="mark absent">${esc(pf.item.absent)}</i>` : ""}${pf.item.mark ? `<i class="mark">${esc(pf.item.mark)}</i>` : ""}` : "";
  const journal = pf?.item.topic
    ? `<button class="lesson-num" data-journal="${esc(pf.kdisc)}" data-at="${esc(`${pf.item.date}|${pf.item.start}`)}"><span>${esc(pf.item.topic)}</span>${marks}</button>`
    : "";
  const st = change?.kind === "cancelled" ? "cancelled" : lessonStatus(day, l, now);
  const room = l.room ? `ауд. ${change?.kind === "room" ? `<s>${esc(change.before.room)}</s> → <b class="chg">${esc(l.room)}</b>` : esc(l.room)}${l.address ? `, ${esc(l.address)}` : ""}` : "";
  const who = l.groups?.length
    ? `<span class="sub">${esc(l.groups.map(shortGroup).join(", "))}</span>`
    : l.teacher
      ? `<span class="${l.teacherId && state.teachers.has(l.teacherId) ? "t-link" : ""}" ${l.teacherId && state.teachers.has(l.teacherId) ? `data-teacher="${esc(l.teacherId)}"` : ""}>${esc(l.teacher)}${l.teacherPost ? `<em class="post">, ${esc(lowerFirst(l.teacherPost))}</em>` : ""}</span>`
      : "";
  return `<div class="lesson ${st} ${l.forecast ? "forecast" : ""} ${change && change.kind !== "cancelled" ? "changed" : ""}">
    <div class="lesson-time">${esc(l.start)}<span>${esc(l.end)}</span></div>
    <div>
      <div class="lesson-title">${typeTag(l.type, pf)}${pf && !pf.item.topic && marks ? `<span class="num-side">${marks}</span>` : ""}${esc(l.title)}</div>
      <div class="lesson-meta">
        ${room ? `<span>${room}</span>` : ""}
        ${who}
        ${l.subgroup ? `<span class="sub">подгр. ${esc(l.subgroup.split(".").slice(-2).join("."))}</span>` : ""}
      </div>
      ${journal}
      ${change ? `<div class="chg-note ${change.kind === "cancelled" && !change.ghostText ? "gone" : ""}">${esc(change.ghostText || changeText(change))}</div>` : ""}
    </div>
  </div>`;
}

/** Пары дня вместе с изменениями: подсветка на месте и «призраки» отменённых. */
function dayLessonsHTML(day, now, changes) {
  const d = isoDate(day.date);
  const byAfter = new Map(changes.filter((c) => c.after && c.after.date === d).map((c) => [slotKey(d, c.after), c]));
  const mine = !state.viewing;
  const rows = day.lessons.map((l) => [l.startMin, lessonHTML(day, l, now, byAfter.get(slotKey(d, l)), mine)]);
  for (const c of changes) {
    if (c.kind === "cancelled" && c.before.date === d) rows.push([c.before.startMin, lessonHTML(day, c.before, now, c)]);
    // На старом месте перенесённой пары — бледная строка «перенесли на …».
    if (c.kind === "moved" && c.before.date === d && c.after.date !== d) {
      rows.push([c.before.startMin, lessonHTML(day, c.before, now, { kind: "cancelled", ghostText: `Перенесли на ${slotLabel(c.after.date, c.after.start)}` })]);
    }
  }
  return rows.sort((a, b) => a[0] - b[0]).map((r) => r[1]).join("");
}

function ringHTML(s) {
  const pct = Math.min(100, Math.round(s.ratio * 100));
  return `<div class="ring lvl-${s.level}" style="--p:${pct}"><b><span data-count="${s.unexcused}" data-ck="ring-${s.limit}">0</span><small>/${s.limit}</small></b></div>`;
}

function meterVerdict(s) {
  if (s.level === "over") return `<span class="danger">Лимит превышен на ${pluralHours(s.unexcused - s.limit)}</span>`;
  const txt = `Можно пропустить ещё ${pluralPairs(s.pairsLeft)}`;
  if (s.level === "danger") return `<span class="danger">${txt}. Осторожно</span>`;
  if (s.level === "warn") return `<span class="warn">${txt}</span>`;
  return `<span>${txt}</span>`;
}

function currentStats(now = new Date()) {
  return semesterStats(state.skips, semesterOf(now).key, state.settings.limit, pendingSkips(state.skipMarks, state.skips));
}

// ---------- свои записи о пропусках (пока деканат не внёс) ----------

async function saveSkipMarks() {
  await api.save("skip_marks", JSON.stringify(state.skipMarks));
  scheduleSync();
}
function setSkipMark(date, l, patch) {
  const id = `${date}|${l.start}`;
  let m = state.skipMarks.find((x) => x.id === id);
  if (!m) state.skipMarks.push((m = { id, date, start: l.start, subject: l.title || l.subject, type: l.type || "", created: Date.now() }));
  Object.assign(m, patch);
  touch(m);
  saveSkipMarks();
}
const sd = { date: null };
/** Прошедшие дни (2 недели) с моими парами — самые свежие первыми. */
function skipDays(now = new Date()) {
  const out = [];
  for (let k = 0; k <= 14; k++) {
    const d = addDays(now, -k);
    const day = weekDays(mondayOf(d), null, false).find((x) => sameDay(x.date, d));
    const lessons = (day?.lessons || []).filter((l) => k > 0 || lessonStatus(day, l, now) !== "upcoming");
    if (lessons.length) out.push({ date: isoDate(d), d, lessons });
  }
  return out;
}
function renderSkipDialog() {
  const days = skipDays();
  if (!days.some((x) => x.date === sd.date)) sd.date = days[0]?.date || null;
  $("#sd-days").html = days.map((x) => `<button type="button" class="pchip ${x.date === sd.date ? "on" : ""}" data-sd-day="${x.date}">${esc(fmtDay(x.d, { weekday: "short", day: "numeric", month: "short" }))}</button>`).join("")
    || `<span class="muted small">За последние две недели пар не нашлось.</span>`;
  const day = days.find((x) => x.date === sd.date);
  $("#sd-lessons").html = (day?.lessons || []).map((l) => {
    const on = state.skipMarks.some((m) => m.id === `${day.date}|${l.start}` && !m.deleted);
    return `<button type="button" class="opt sd-lesson ${on ? "on" : ""}" data-sd-start="${esc(l.start)}"><span class="t">${esc(l.start)}</span>
      <span class="s"><b>${esc(l.title)}</b><small>${esc(typeWords(l.type)[0] || "")}</small></span><span class="tick">✓</span></button>`;
  }).join("");
}
$("#skip-add-btn").addEventListener("click", () => {
  sd.date = null;
  // прошлая неделя — если ещё не загружена
  loadWeek(addDays(currentMonday(), -7), null)?.then(() => { if ($("#skip-dialog").open) renderSkipDialog(); }).catch(() => {});
  renderSkipDialog();
  $("#skip-dialog").showModal();
});
$("#skip-dialog").addEventListener("click", (e) => {
  const d = e.target.closest("[data-sd-day]");
  if (d) { sd.date = d.dataset.sdDay; renderSkipDialog(); return; }
  const b = e.target.closest("[data-sd-start]");
  if (!b) return;
  const day = skipDays().find((x) => x.date === sd.date);
  const l = day?.lessons.find((x) => x.start === b.dataset.sdStart);
  if (!l) return;
  const on = state.skipMarks.some((m) => m.id === `${sd.date}|${l.start}` && !m.deleted);
  setSkipMark(sd.date, l, on ? { deleted: true } : { deleted: false, excused: false });
  renderSkipDialog();
});
$("#skip-dialog").addEventListener("close", () => renderAll());
document.addEventListener("click", (e) => {
  const r = e.target.closest("[data-pend-act]");
  if (!r) return;
  const m = state.skipMarks.find((x) => x.id === r.dataset.pendId);
  if (!m) return;
  if (r.dataset.pendAct === "excused") m.excused = !m.excused;
  else { m.deleted = true; toast("Запись удалена"); }
  touch(m);
  saveSkipMarks();
  renderAll();
});

function renderSync() {
  const el = $("#sync-status");
  el.classList.toggle("err", !!state.syncError);
  if (state.syncing) el.textContent = "Обновляю…";
  else if (state.lastSync) {
    const m = Math.round((Date.now() - state.lastSync) / 6e4);
    el.textContent = m < 1 ? "Обновлено только что" : m < 60 ? `Обновлено ${m} мин назад` : `Обновлено ${new Date(state.lastSync).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
  } else el.textContent = "Ещё не обновлялось";
  $("#refresh-btn").disabled = state.syncing;

  const banner = $("#banner");
  banner.classList.toggle("hidden", !state.syncError);
  banner.textContent = state.syncError ? `${state.syncError} Показываю сохранённые данные.` : "";
}

// ---------- рендер: сегодня ----------

function renderToday(now = new Date()) {
  $("#today-date").textContent = fmtDay(now, { weekday: "long", day: "numeric", month: "long" });
  const h = now.getHours();
  $("#today-title").textContent = h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";

  // изменения в расписании
  const unseen = unseenChanges();
  const cb = $("#chg-banner-today");
  cb.classList.toggle("hidden", !unseen.length);
  if (unseen.length) {
    const list = unseen.flatMap(([, v]) => shownChanges(v));
    const days = [...new Set(list.map((c) => slotLabel((c.after || c.before).date, "").trim()))].join(", ");
    cb.dataset.week = unseen[0][0];
    cb.html = `<b>Расписание изменилось</b><span>${list.length} ${list.length === 1 ? "изменение" : list.length < 5 ? "изменения" : "изменений"} · ${esc(days)} — посмотреть</span>`;
  }

  // следующая пара
  const n = nextLesson(state.days, now);
  const nc = $("#next-card");
  if (!n) {
    nc.html = `<div class="next-label">Пары</div><div class="next-title">${state.days.length ? "На ближайшие дни пар нет" : "Расписание ещё не загружено"}</div>`;
  } else {
    const { day, lesson: l, isNow } = n;
    const cur = now.getHours() * 60 + now.getMinutes();
    let label, big = "", bar = "";
    if (isNow) {
      const { phase } = lessonPhase(l, cur);
      const len = l.endMin - l.startMin;
      const left = l.endMin - cur;
      const pct = Math.round(((cur - l.startMin) / len) * 100);
      const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      const hint = {
        first: " · 1-я полупара",
        break: ` · перерыв до ${hhmm(l.startMin + HALF + BREAK)}`,
        second: " · 2-я полупара",
        whole: "",
      }[phase];
      label = `<div class="next-label live">Идёт сейчас</div>`;
      big = `<div class="countdown">${left} мин</div><div class="muted small">до конца пары${hint}</div>`;
      const gap = phase === "whole" ? "" :
        `<b class="progress-gap" style="left:${(HALF / len) * 100}%;width:${(BREAK / len) * 100}%"></b>`;
      bar = `<div class="progress"><i style="width:${pct}%"></i>${gap}</div>`;
    } else if (sameDay(day.date, now)) {
      const until = l.startMin - cur;
      label = `<div class="next-label">Следующая пара</div>`;
      big = until <= 180
        ? `<div class="countdown">${until >= 60 ? `${Math.floor(until / 60)} ч ${until % 60} мин` : `${until} мин`}</div><div class="muted small">до начала, в ${esc(l.start)}</div>`
        : `<div class="countdown">${esc(l.start)}</div>`;
    } else {
      label = `<div class="next-label">Следующая пара${l.forecast ? ` · <span class="pre">предварительно</span>` : ""}</div>`;
      big = `<div class="countdown">${esc(l.start)}</div><div class="muted small">${fmtDay(day.date, { weekday: "long", day: "numeric", month: "long" })}</div>`;
    }
    nc.html = `${label}
      <div class="next-title">${typeTag(l.type)}${esc(l.title)}</div>
      <div class="next-meta">
        ${l.room ? `<span>ауд. ${esc(l.room)} · ${esc(l.address)}</span>` : ""}
        ${l.teacher ? `<span>${esc(l.teacher)}</span>` : ""}
      </div>
      ${big}${bar}`;
  }

  // пропуски
  const s = currentStats(now);
  $("#meter-card").html = `
    <div class="card-head"><h2>Пропуски за семестр</h2><button class="link" data-go="skips">Подробнее →</button></div>
    <div class="meter">${ringHTML(s)}
      <div class="meter-text">
        <strong>${pluralHours(s.unexcused)} неуважит.</strong>
        ${meterVerdict(s)}
        <span class="muted small">${s.pendingHours ? `Из них ${pluralHours(s.pendingHours)} ещё нет на портале. ` : ""}По заявлению: ${pluralHours(s.excused)}, в лимит не идут</span>
      </div>
    </div>`;

  // пары сегодня
  const today = state.days.find((d) => sameDay(d.date, now));
  $("#today-lessons").html = today?.lessons.length
    ? today.lessons.map((l) => lessonHTML(today, l, now)).join("")
    : `<div class="empty">Сегодня пар нет${now.getDay() === 0 ? " — воскресенье" : ""}.</div>`;

  // горящие задачи
  const hot = sortTasks(liveTasks()).filter((t) => !t.done && t.due && ["overdue", "today", "week"].includes(taskBucket(t, now))).slice(0, 5);
  const books = libraryBooks(now).filter((b) => b.daysLeft !== null && b.daysLeft <= 14);
  $("#today-tasks").html = hot.length || books.length
    ? hot.map((t) => taskHTML(t, now)).join("") + books.map(bookDueHTML).join("")
    : `<div class="empty">Ничего не горит на неделе. <button class="link" id="today-add">Добавить задачу</button></div>`;
}

// ---------- рендер: расписание ----------

const MAX_BACK_WEEKS = 60;

function weekSub(monday) {
  const diff = Math.round((monday - currentMonday()) / (7 * 86400_000));
  if (diff === 0) return "эта неделя";
  if (diff === 1) return "следующая неделя";
  if (diff === -1) return "прошлая неделя";
  const n = -diff;
  return `${n} ${n % 10 === 1 && n % 100 !== 11 ? "неделю" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "недели" : "недель"} назад`;
}

function renderSchedule(now = new Date()) {
  const cur = mondayOf(now);
  if (!state.weekStart) state.weekStart = cur;
  const monday = state.weekStart;
  const days = weekDays(monday);
  const forecast = days.some((d) => d.forecast);

  renderWhoBar(now);
  const changes = state.viewing ? [] : weekChanges(monday);
  const changedDates = new Set(changes.map((c) => (c.after || c.before).date).concat(changes.filter((c) => c.before).map((c) => c.before.date)));
  const sb = $("#chg-banner");
  sb.classList.toggle("hidden", !changes.length);
  if (changes.length) {
    sb.html = `<b>Расписание изменилось</b><span>${changes.length} ${changes.length === 1 ? "изменение" : changes.length < 5 ? "изменения" : "изменений"} на этой неделе</span>`;
    if (state.view === "schedule" && state.changes[isoDate(monday)] && !state.changes[isoDate(monday)].seen) {
      state.changes[isoDate(monday)].seen = true;
      saveChanges();
      setTimeout(() => renderToday(), 0);
    }
  }

  $("#week-label").textContent = weekLabel(monday);
  $("#week-sub").html = esc(weekSub(monday)) + (forecast ? ` · <span class="pre">предварительно</span>` : "");
  $("#week-prev").disabled = monday <= addDays(cur, -7 * MAX_BACK_WEEKS);
  $("#week-next").disabled = monday >= addDays(cur, 7);
  $("#week-today").classList.toggle("hidden", +monday === +cur);

  // Воскресенье показываем, только если в него есть пары.
  const shown = days.filter((d, i) => i < 6 || d.lessons.length);
  if (!shown.some((d) => +d.date === state.selectedDay)) {
    const t = shown.find((d) => sameDay(d.date, now)) || shown.find((d) => d.date > now && d.lessons.length) || shown.find((d) => d.lessons.length) || shown[0];
    state.selectedDay = +t.date;
  }
  const strip = $("#day-strip");
  strip.style.setProperty("--cols", shown.length);
  strip.html = shown.map((d) => `
    <button class="day-chip ${sameDay(d.date, now) ? "today" : ""} ${+d.date === state.selectedDay ? "active" : ""} ${d.lessons.length ? "" : "empty-day"} ${d.forecast ? "forecast" : ""}"
      role="tab" aria-selected="${+d.date === state.selectedDay}" data-day="${+d.date}">
      <small>${fmtDay(d.date, { weekday: "short" })}</small><b>${d.date.getDate()}</b><small>${d.lessons.length ? pluralPairs(d.lessons.length) : "выходной"}</small>
      ${changedDates.has(isoDate(d.date)) ? `<i class="chg-dot"></i>` : ""}
    </button>`).join("");
  const day = shown.find((d) => +d.date === state.selectedDay);
  const loading = state.weekLoading === whoKey(state.viewing, monday) && !weekLessons(days);
  $("#day-lessons").html = loading
    ? `<div class="empty">Загружаю неделю…</div>`
    : (day.forecast ? `<div class="pre-note">Предварительно: сайт ещё не выложил эту неделю, показана копия текущей.</div>` : "") +
      (day.lessons.length || changes.some((c) => c.before && c.before.date === isoDate(day.date))
        ? dayLessonsHTML(day, now, changes)
        : `<div class="empty">В этот день пар нет.</div>`);
}

/** Строка избранного и карточка «чьё расписание» над неделей. */
function renderWhoBar(now = new Date()) {
  const v = state.viewing;
  const favs = liveFavs();
  // Кнопка внизу под большим пальцем: чьё расписание сейчас открыто.
  $("#who-fab").html = `<span class="who-dot ${v ? v.kind : "me"}"></span><b>${esc(v ? v.title : "Моё")}</b><i>▾</i>`;
  const kindName = { student: "студент", group: "группа", teacher: "преподаватель" };
  $("#who-list").html = `<button class="who-row ${!v ? "on" : ""}" data-who="me"><span class="who-dot me"></span><span><b>Моё расписание</b><small>${esc(myProfile()?.group ? shortGroup(myProfile().group) : "")}</small></span>${!v ? "<i>✓</i>" : ""}</button>` +
    favs.map((f) => `<button class="who-row ${v && favId(v) === f.id ? "on" : ""}" data-who="${esc(f.id)}"><span class="who-dot ${f.kind}"></span><span><b>${esc(f.title)}</b><small>${esc(kindName[f.kind] || "")}</small></span>${v && favId(v) === f.id ? "<i>✓</i>" : ""}</button>`).join("") +
    (v && !isFav(v) ? `<button class="who-row on" data-who="current"><span class="who-dot ${v.kind}"></span><span><b>${esc(v.title)}</b><small>открыто сейчас, не в избранном</small></span><i>✓</i></button>` : "") +
    (!favs.length ? `<p class="muted small" style="margin:8px 0 0">Добавь кого-нибудь в избранное — он появится здесь.</p>` : "");
  const card = $("#who-card");
  card.classList.toggle("hidden", !v);
  if (!v) { card.html = ""; return; }
  const t = v.kind === "teacher" ? state.teachers.get(v.id) : null;
  const buttons = [
    `<button class="btn btn-sm ${isFav(v) ? "" : "btn-primary"}" data-fav>${isFav(v) ? "★ В избранном" : "☆ В избранное"}</button>`,
    t?.email ? `<button class="btn btn-sm" data-mail="${esc(t.email)}">✉ Написать</button>` : "",
    v.kind === "teacher" ? "" : `<button class="btn btn-sm" data-windows>Когда освобождаетесь</button>`,
  ].join("");
  let where = "";
  if (v.kind === "teacher") {
    const cur = currentMonday();
    const w = whereNow([...weekDays(cur, v, false), ...weekDays(addDays(cur, 7), v, false)], now);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const place = (l) => `ауд. ${esc(l.room || "—")}`;
    const nextLine = w.next
      ? `<div class="where-next"><span class="muted small">${w.current ? "Дальше" : "Следующая пара"}</span><b>${sameDay(w.next.date, now) ? "" : `${esc(fmtDay(w.next.date, { weekday: "short", day: "numeric", month: "short" }))} · `}${esc(w.next.start)} · ${place(w.next)}</b><span class="muted small">${esc(w.next.address || "")} · ${esc(w.next.title)}${w.next.groups.length ? `, ${esc(w.next.groups.map(shortGroup).join(", "))}` : ""}</span></div>`
      : "";
    where = w.current
      ? `<article class="card where"><div class="next-label live">Где сейчас</div>
          <div class="where-room">${place(w.current)}</div>
          <div class="muted">${esc(w.current.address || "")} · до ${esc(w.current.end)}</div>
          <div class="small" style="margin-top:6px">${esc(w.current.title)}${w.current.groups.length ? ` · ${esc(w.current.groups.map(shortGroup).join(", "))}` : ""}</div>
          <div class="progress" style="margin-top:12px"><i style="width:${Math.round(((nowMin - w.current.startMin) / (w.current.endMin - w.current.startMin)) * 100)}%"></i></div>
          ${nextLine}</article>`
      : `<article class="card where idle"><div class="next-label">Где сейчас</div><div class="where-room small-room">Сейчас без пары</div>${nextLine}</article>`;
  }
  card.html = `<article class="card t-card">
      <div class="avatar">${esc(initials(v.title))}</div>
      <div><div class="profile-name">${esc(t?.name || v.title)}</div><div class="muted small">${esc(t?.post || v.sub || "")}</div></div>
      <div class="btn-row" style="grid-column:1/-1">${buttons}</div>
    </article>${where}`;
}

/** Открыть чьё-то расписание (или своё — who = null). */
function openPerson(who) {
  state.viewing = who;
  state.selectedDay = null;
  state.weekStart = currentMonday();
  if (state.view !== "schedule") go("schedule");
  renderSchedule();
  loadWeek(state.weekStart, who);
  if (who) loadWeek(addDays(state.weekStart, 7), who);
}

const whoSheet = $("#who-sheet");
const closeWhoSheet = () => whoSheet.classList.add("hidden");
$("#who-fab").addEventListener("click", () => { renderWhoBar(); whoSheet.classList.remove("hidden"); });
whoSheet.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) return closeWhoSheet();
  if (e.target.closest("[data-sheet-search]")) { closeWhoSheet(); return go("search"); }
  const b = e.target.closest("[data-who]");
  if (!b) return;
  closeWhoSheet();
  if (b.dataset.who === "current") return;
  if (b.dataset.who === "me") return openPerson(null);
  const f = liveFavs().find((x) => x.id === b.dataset.who);
  if (f) openPerson(favToWho(f));
});
$("#who-card").addEventListener("click", (e) => {
  if (e.target.closest("[data-fav]")) toggleFavorite(state.viewing);
  const m = e.target.closest("[data-mail]");
  if (m) openExternal(`mailto:${m.dataset.mail}`);
  if (e.target.closest("[data-windows]")) { state.windowsWith = state.viewing; go("windows"); }
});
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-teacher]");
  if (!t) return;
  const info = state.teachers.get(t.dataset.teacher);
  if (info) openPerson({ kind: "teacher", id: info.id, title: shortFio(info.name), sub: info.post });
});
$("#chg-banner-today").addEventListener("click", () => {
  const k = $("#chg-banner-today").dataset.week;
  state.viewing = null;
  go("schedule");
  if (k) openWeek(mondayOf(new Date(`${k}T12:00`)));
});

function openWeek(monday) {
  state.weekStart = monday;
  state.selectedDay = null;
  renderSchedule();
  loadWeek(monday);
}

$("#day-strip").addEventListener("click", (e) => {
  const b = e.target.closest("[data-day]");
  if (!b) return;
  state.selectedDay = Number(b.dataset.day);
  renderSchedule();
});
$("#week-prev").addEventListener("click", () => openWeek(addDays(state.weekStart, -7)));
$("#week-next").addEventListener("click", () => openWeek(addDays(state.weekStart, 7)));
$("#week-today").addEventListener("click", () => openWeek(currentMonday()));

// ---------- журнал предмета ----------

function renderJournal() {
  const j = state.journal && state.perf.get(state.journal.kdisc);
  const body = $("#journal-body");
  if (!j) { $("#journal-title").textContent = "Журнал"; body.html = `<div class="empty">Журнал ещё загружается…</div>`; return; }
  $("#journal-title").textContent = j.course.name;
  const now = new Date();
  const today = isoDate(now);
  const kinds = [...new Set(j.items.map((x) => x.label))];
  const absents = j.items.filter((x) => x.absent).length;
  const marks = j.items.map((x) => Number(String(x.mark).replace(",", "."))).filter((x) => x > 0);
  const avg = marks.length ? (marks.reduce((a, b) => a + b, 0) / marks.length).toFixed(1) : null;
  const upcoming = [...state.perfNext.values()].filter((x) => x.kdisc === state.journal.kdisc).map((x) => x.item);
  const rowsAll = [...j.items, ...upcoming];
  body.html = `<div class="stats journal-stats">
      ${kinds.map((k) => `<div class="stat"><b>${j.items.filter((x) => x.label === k && x.date <= today).length}</b><span>${esc({ Лекция: "лекций", Практика: "практик", Лаба: "лаб", Семинар: "семинаров" }[k] || k.toLowerCase())} прошло</span></div>`).join("")}
      <div class="stat"><b>${absents}</b><span>пропусков</span></div>
      ${avg ? `<div class="stat"><b>${avg}</b><span>средняя</span></div>` : ""}
    </div>
    <div class="card" style="padding:4px 18px">${rowsAll.map((x) => `
      <div class="j-row ${x.date > today ? "future" : ""} ${state.journal.at === `${x.date}|${x.start}` ? "hl" : ""}" data-row="${esc(`${x.date}|${x.start}`)}">
        <div class="j-date">${esc(fmtDay(parseIsoDate(x.date), { day: "numeric", month: "short" }))}<span>${esc(fmtDay(parseIsoDate(x.date), { weekday: "short" }))} ${esc(x.start)}</span></div>
        <div><div class="j-title"><b>${esc(x.label)} №${x.n}</b>${x.seq ? `<small>тема ${esc(x.seq)}</small>` : ""}</div>
          ${x.topic ? `<div class="j-topic">${esc(x.topic)}</div>` : x.next ? `<div class="j-topic">тема появится, когда пару внесут в журнал</div>` : ""}</div>
        <div class="j-marks">${x.absent ? `<i class="mark absent">${esc(x.absent)}</i>` : ""}${x.mark ? `<i class="mark">${esc(x.mark)}</i>` : ""}</div>
      </div>`).join("") || `<div class="empty">В журнале пока пусто.</div>`}</div>`;
  const hl = body.querySelector(".j-row.hl");
  if (hl) setTimeout(() => hl.scrollIntoView({ block: "center" }), 60);
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-journal]");
  if (!b) return;
  state.journal = { kdisc: b.dataset.journal, at: b.dataset.at };
  go("journal");
});

// ---------- поиск ----------

const SEARCH_ICO = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`;
const myProfile = () => normalizeProfile(study("getChoosenCourses"));

async function loadFaculties() {
  const S = state.search;
  if (S.faculties || !api.fetchFaculties) return;
  try {
    S.faculties = (JSON.parse(await api.fetchFaculties()).items || []).filter((f) => f.id !== "1");
    // Свой факультет — сразу раскрыт.
    const mine = myProfile()?.faculty?.toLowerCase();
    const f = mine && S.faculties.find((x) => x.title.toLowerCase() === mine);
    if (f && !S.openFaculty) openFaculty(f.id);
  } catch (e) { S.error = String(e); }
  renderSearch();
}

async function openFaculty(id) {
  const S = state.search;
  S.openFaculty = S.openFaculty === id ? null : id;
  renderSearch();
  if (!S.openFaculty || S.catalogs[id]) return;
  const res = await Promise.allSettled([1, 2, 3, 4, 5].map((c) => api.fetchGroups(id, c)));
  const byCourse = {};
  res.forEach((r, i) => { if (r.status === "fulfilled") try { byCourse[i + 1] = JSON.parse(r.value).items || []; } catch {} });
  S.catalogs[id] = groupCatalog(byCourse);
  renderSearch();
}

function renderSearch() {
  const S = state.search;
  $$("#search-tabs .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === S.tab));
  const input = $("#search-input");
  input.placeholder = { student: "Логин, например Ivanov_II_25", group: "Группа, например ЭУ-24", teacher: "Фамилия преподавателя" }[S.tab];
  const body = $("#search-body");
  const q = S.query.trim().toLowerCase();

  if (S.tab === "student") {
    const st = S.student;
    body.html = S.busy ? `<div class="empty">Ищу…</div>`
      : S.studentErr ? `<div class="empty">${esc(S.studentErr)}</div>`
      : st ? `<article class="card row-card" data-open-student>
          <div class="avatar">${esc(initials(st.fullname))}</div>
          <div><div class="row-title">${esc(st.fullname)}</div><div class="row-sub">${esc(st.grouptitle)} · ${esc(st.studenttype || "студент")}</div></div>
          <span class="muted">›</span></article>`
      : `<p class="muted small">Введи логин человека с образовательного портала и нажми Enter. Пароль не нужен — расписание открытое, как в MyGRSU.</p>`;
    return;
  }

  if (S.tab === "teacher") {
    if (!state.teachers.size) { body.html = `<div class="empty">Список преподавателей ещё загружается…</div>`; return; }
    if (q.length < 2) { body.html = `<p class="muted small">Начни вводить фамилию — например «Иванов».</p>`; return; }
    const words = q.split(/\s+/);
    const found = [...state.teachers.values()].filter((t) => words.every((w) => t.name.toLowerCase().includes(w))).slice(0, 40);
    body.html = found.length
      ? `<div class="card list-card">${found.map((t) => `<button class="row-btn" data-open-teacher="${esc(t.id)}">
          <span class="avatar sm">${esc(initials(t.name))}</span><span><b>${esc(t.name)}</b><small>${esc(t.post)}</small></span><span class="muted">›</span></button>`).join("")}</div>`
      : `<div class="empty">Никого не нашёл.</div>`;
    return;
  }

  // Группы: факультет → специальность → курс → группа
  if (!S.faculties) { body.html = `<div class="empty">${esc(S.error || "Загружаю факультеты…")}</div>`; loadFaculties(); return; }
  const myGroup = myProfile()?.group;
  const groupBtn = (g, course) => `<button class="grp-btn ${g.title === myGroup ? "mine" : ""}" data-open-group="${esc(g.id)}" data-title="${esc(g.title)}" data-course="${course}">${esc(g.label)}${g.title === myGroup ? " · моя" : ""}</button>`;
  if (q.length >= 2) {
    const hits = Object.entries(S.catalogs).flatMap(([fid, cat]) => cat.flatMap((sp) => sp.courses.flatMap((c) => c.groups
      .filter((g) => g.title.toLowerCase().includes(q) || `${sp.spec}-${g.code}`.toLowerCase().includes(q))
      .map((g) => ({ g, c, fac: S.faculties.find((f) => f.id === fid)?.title || "" })))));
    body.html = hits.length
      ? `<div class="card list-card">${hits.slice(0, 50).map(({ g, c, fac }) => `<button class="row-btn" data-open-group="${esc(g.id)}" data-title="${esc(g.title)}" data-course="${c.course}">
          <span><b>${esc(g.title)}</b><small>${c.course} курс · ${esc(fac)}</small></span><span class="muted">›</span></button>`).join("")}</div>`
      : `<div class="empty">Не нашёл. Поиск идёт по открытым факультетам — раскрой нужный ниже.</div>` + facultyList();
    return;
  }
  body.html = facultyList();

  function facultyList() {
    return `<div class="card cat-card">${S.faculties.map((f) => {
      const open = S.openFaculty === f.id;
      const cat = S.catalogs[f.id];
      return `<button class="cat-row ${open ? "open" : ""}" data-faculty="${esc(f.id)}"><span>${esc(f.title)}</span><i>${open ? "⌄" : "›"}</i></button>` +
        (open ? `<div class="cat-body">${!cat ? `<div class="muted small" style="padding:8px 0">Загружаю группы…</div>`
          : !cat.length ? `<div class="muted small" style="padding:8px 0">Групп дневной формы нет.</div>`
          : cat.map((sp) => {
            const so = S.openSpec === `${f.id}:${sp.spec}`;
            return `<button class="spec-row ${so ? "open" : ""}" data-spec="${esc(`${f.id}:${sp.spec}`)}"><b>${esc(sp.spec)}</b><small>${sp.courses.map((c) => `${c.course} к.`).join(" · ")}</small><i>${so ? "⌄" : "›"}</i></button>` +
              (so ? `<div class="years">${sp.courses.map((c) => `<div class="year"><span>${c.course} курс${c.year ? ` · набор ${c.year}` : ""}</span><div class="grp">${c.groups.map((g) => groupBtn(g, c.course)).join("")}</div></div>`).join("")}</div>` : "");
          }).join("")}</div>` : "");
    }).join("")}</div>`;
  }
}

$("#search-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  state.search.tab = b.dataset.tab;
  state.search.query = "";
  $("#search-input").value = "";
  renderSearch();
});
$("#search-input").addEventListener("input", (e) => {
  state.search.query = e.target.value;
  if (state.search.tab !== "student") renderSearch();
});
$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const S = state.search;
  if (S.tab !== "student") return;
  const login = S.query.trim();
  if (!login || !api.lookupStudent) return;
  Object.assign(S, { busy: true, student: null, studentErr: "" });
  renderSearch();
  try { S.student = JSON.parse(await api.lookupStudent(login)); }
  catch (err) { S.studentErr = String(err); }
  S.busy = false;
  renderSearch();
});
$("#search-body").addEventListener("click", (e) => {
  const S = state.search;
  const f = e.target.closest("[data-faculty]");
  if (f) return openFaculty(f.dataset.faculty);
  const sp = e.target.closest("[data-spec]");
  if (sp) { S.openSpec = S.openSpec === sp.dataset.spec ? null : sp.dataset.spec; return renderSearch(); }
  const g = e.target.closest("[data-open-group]");
  if (g) return openPerson({ kind: "group", id: g.dataset.openGroup, title: shortGroup(g.dataset.title), sub: `Группа ${g.dataset.title} · ${g.dataset.course} курс` });
  const t = e.target.closest("[data-open-teacher]");
  if (t) { const info = state.teachers.get(t.dataset.openTeacher); if (info) openPerson({ kind: "teacher", id: info.id, title: shortFio(info.name), sub: info.post }); return; }
  if (e.target.closest("[data-open-student]") && S.student) {
    const st = S.student;
    openPerson({ kind: "student", id: String(st.id), title: shortFio(st.fullname), sub: `${st.fullname} · ${st.grouptitle}` });
  }
});

// ---------- общие окна (C) ----------

function renderWindows() {
  const who = state.windowsWith || favToWho(liveFavs()[0] || {});
  const body = $("#win-body");
  const favs = liveFavs().filter((f) => f.kind !== "teacher");
  $("#win-pick").html = `<span class="who me">Ты</span><span class="plus">+</span>` +
    (favs.length || who?.id
      ? [...(who?.id && !favs.some((f) => f.id === favId(who)) ? [{ id: favId(who), title: who.title }] : []), ...favs]
        .map((f) => `<button class="who friend ${who?.id && f.id === favId(who) ? "on" : ""}" data-win="${esc(f.id)}">${esc(f.title)}</button>`).join("")
      : `<span class="muted small">Добавь кого-нибудь в избранное</span>`);
  if (!who?.id) { body.html = `<div class="empty">Открой расписание друга или группы и нажми «Когда освобождаетесь».</div>`; return; }
  const monday = state.weekStart || currentMonday();
  $("#win-label").textContent = weekLabel(monday);
  if (!rawWeek(who, monday)) loadWeek(monday, who);
  const mine = weekDays(monday, null), theirs = weekDays(monday, who);
  const name = who.title;
  const now = new Date();
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const r = dayTogether(mine[i], theirs[i]);
    if (r.none && i >= 5) continue;
    const day = fmtDay(mine[i].date, { weekday: "short", day: "numeric", month: "short" });
    const past = mine[i].date < new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let main, sub = "";
    if (r.none) main = `<span class="muted">пар нет ни у кого</span>`;
    else if (r.only === "me") main = `<b>свободны с ${r.end}</b>`, sub = `у ${esc(name)} пар нет, ты до ${r.end}`;
    else if (r.only === "them") main = `<b>свободны с ${r.end}</b>`, sub = `у тебя пар нет, ${esc(name)} до ${r.end}`;
    else if (r.later === "both") main = `<b>освобождаетесь вместе в ${r.together}</b>`;
    else {
      main = `<b>вместе с ${r.together}</b>`;
      sub = `ты до ${r.myEnd} · ${esc(name)} до ${r.theirEnd} · ${r.later === "them" ? "тебе" : esc(name)} ждать ${durationText(r.wait)}`;
    }
    const mids = (r.windows || []).map((w) => `окно ${w.from}–${w.to} (${durationText(w.minutes)})${w.place ? `, оба на ${esc(w.place)}` : ""}`);
    rows.push(`<div class="win ${past ? "past" : ""} ${sameDay(mine[i].date, now) ? "today" : ""}">
      <div class="win-day">${esc(day)}</div>
      <div><div class="win-main">${main}</div>${sub ? `<div class="muted small">${sub}</div>` : ""}
      ${mids.length ? `<div class="win-mid">${mids.join("<br>")}</div>` : ""}</div></div>`);
  }
  const forecast = mine.some((d) => d.forecast) || theirs.some((d) => d.forecast);
  body.html = `${forecast ? `<div class="pre-note">Предварительно: часть недели — прогноз по текущей.</div>` : ""}
    <div class="card" style="padding:4px 18px">${rows.join("")}</div>`;
}

$("#win-pick").addEventListener("click", (e) => {
  const b = e.target.closest("[data-win]");
  if (!b) return;
  const f = liveFavs().find((x) => x.id === b.dataset.win);
  if (f) { state.windowsWith = favToWho(f); renderWindows(); }
});
$("#win-prev").addEventListener("click", () => { state.weekStart = addDays(state.weekStart || currentMonday(), -7); renderWindows(); loadWeek(state.weekStart, null); });
$("#win-next").addEventListener("click", () => { state.weekStart = addDays(state.weekStart || currentMonday(), 7); renderWindows(); loadWeek(state.weekStart, null); });

// ---------- рендер: задачи ----------

const KIND = { lab: "Лаба", hw: "Домашка", course: "Курсовой", test: "Контрольная", exam: "Экзамен", other: "" };

const NOUN = (type) => {
  const t = String(type || "").toLowerCase();
  return t.startsWith("лек") ? "лекции" : t.startsWith("лаб") ? "лабе" : t.startsWith("практ") ? "практике" : t.startsWith("сем") ? "семинару" : "паре";
};
/** Неделя с настоящим расписанием (а не прогнозом). */
const isRealDate = (iso) => weekLessons(weekDays(mondayOf(parseIsoDate(iso)), null, false)) > 0;

function taskHTML(t, now) {
  const b = taskBucket(t, now);
  const sub = [KIND[t.kind], t.subject].filter(Boolean).join(" · ");
  let due = esc(relativeDue(t.due, now));
  if (t.lesson?.pending && !t.done) {
    due = `к ${esc(NOUN(t.lesson.type))}<small class="pre">ждёт расписания</small>`;
  } else if (t.lesson && !t.done) {
    const when = `к ${NOUN(t.lesson.at || t.lesson.type)}, ${slotLabel(t.lesson.date, t.lesson.start)}`;
    due = `${esc(when)}<small class="${isRealDate(t.lesson.date) ? "" : "pre"}">${isRealDate(t.lesson.date) ? esc(relativeDue(t.due, now)) : "предварительно"}</small>`;
  }
  const moved = t.moved && !t.done
    ? `<div class="chg-note ${t.moved.cancelled ? "gone" : ""}">${t.moved.cancelled ? `Пару ${esc(t.moved.from)} отменили — срок перенесён на ${esc(t.moved.to)}` : `Пару перенесли: была ${esc(t.moved.from)} → стала ${esc(t.moved.to)}`}</div>`
    : "";
  return `<div class="task ${b}" data-task="${esc(t.id)}">
    <button class="check ${t.done ? "on" : ""}" data-toggle="${esc(t.id)}" aria-label="${t.done ? "Вернуть в работу" : "Отметить сделанной"}"></button>
    <div><div class="task-title">${esc(t.title)}</div>${sub ? `<div class="task-sub">${esc(sub)}</div>` : ""}${moved}</div>
    <div class="task-due">${t.done ? "" : due}</div>
  </div>`;
}

function renderTasks(now = new Date()) {
  const sorted = sortTasks(liveTasks());
  const groups = Object.fromEntries(BUCKETS.map(([k]) => [k, []]));
  for (const t of sorted) groups[taskBucket(t, now)].push(t);
  const html = BUCKETS.filter(([k]) => groups[k].length).map(([k, title]) => {
    const items = k === "done" ? groups[k].slice(0, 15) : groups[k];
    return `<section class="bucket ${k}"><h3>${title} · ${groups[k].length}</h3>${items.map((t) => taskHTML(t, now)).join("")}</section>`;
  }).join("");
  $("#task-list").html = html || `<div class="empty">Задач пока нет. Добавь первую — лабу, курсач или зачёт.</div>`;
  const plan = planDays();
  $("#quick-chips").html = subjectsWithTypes(plan, now).slice(0, 4).map((x) => {
    const o = occurrences(plan, x.subject, null, now, 1)[0];
    return o ? `<button class="pchip" data-quick-subj="${esc(x.subject)}" title="Добавить к следующей паре">к след. паре: ${esc(shortSubject(x.subject))}<small>${esc(slotLabel(o.date, o.start))}</small></button>` : "";
  }).join("");

  const urgent = groups.overdue.length + groups.today.length;
  $("#tasks-badge").textContent = urgent;
  $("#tasks-badge").classList.toggle("hidden", !urgent);
}

document.addEventListener("click", (e) => {
  const tog = e.target.closest("[data-toggle]");
  if (tog) {
    e.stopPropagation();
    const t = state.tasks.find((x) => x.id === tog.dataset.toggle);
    if (t) { t.done = !t.done; t.doneAt = t.done ? Date.now() : null; touch(t); saveTasks(); renderAll(); }
    return;
  }
  const row = e.target.closest("[data-task]");
  if (row) openTask(row.dataset.task);
  if (e.target.id === "today-add") openTask(null);
});

$("#quick-add").addEventListener("submit", (e) => {
  e.preventDefault();
  const title = $("#quick-title").value.trim();
  if (!title) return $("#quick-title").focus();
  state.tasks.push({ id: crypto.randomUUID(), title, subject: guessSubject(title), kind: guessKind(title), due: null, notes: "", done: false, created: Date.now(), updated: Date.now() });
  saveTasks();
  $("#quick-title").value = "";
  renderAll();
});
$("#quick-chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-quick-subj]");
  if (!b) return;
  const title = $("#quick-title").value.trim();
  if (!title) { toast("Сначала напиши, что сделать"); return $("#quick-title").focus(); }
  const o = occurrences(planDays(), b.dataset.quickSubj, null, new Date(), 1)[0];
  if (!o) return;
  state.tasks.push(linkTask({ id: crypto.randomUUID(), title, subject: o.title, kind: guessKind(title), notes: "", done: false, created: Date.now(), updated: Date.now() }, o, null));
  saveTasks();
  $("#quick-title").value = "";
  toast(`Добавлено к ${NOUN(o.type)} ${slotLabel(o.date, o.start)}`);
  renderAll();
});

/** «Объектно-ориентир. проектиров. и программир.» → короче для чипов. */
const shortSubject = (s) => (s.length > 22 ? s.split(/\s+/).map((w, i) => (i === 0 ? w : w[0] ? `${w[0]}.` : "")).join(" ").slice(0, 24) : s);

function linkTask(t, o, type) {
  t.lesson = { subject: o.title, type: type || null, at: o.type, date: o.date, start: o.start };
  t.due = lessonDue(o);
  delete t.moved;
  return t;
}

function guessKind(title) {
  const t = title.toLowerCase();
  if (/лаб/.test(t)) return "lab";
  if (/курсов|курсач/.test(t)) return "course";
  if (/экзам/.test(t)) return "exam";
  if (/зач[её]т|контрол|кр\b|тест/.test(t)) return "test";
  if (/дз|домаш/.test(t)) return "hw";
  return "other";
}

function guessSubject(title) {
  const t = title.toLowerCase();
  const subjects = subjectsFrom(state.days);
  return subjects.find((s) => s.toLowerCase().split(/[\s.]+/).filter((w) => w.length > 4).some((w) => t.includes(w.slice(0, 5)))) || "";
}

// ---------- диалог задачи ----------

const dlg = $("#task-dialog");
const toLocalInput = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
};

const KINDS = [["lab", "Лаба"], ["hw", "Домашка"], ["course", "Курсовой"], ["test", "Контрольная"], ["exam", "Экзамен"], ["other", "Другое"]];
/**
 * Какие виды пар у предмета бывали: в расписании (загруженные недели и прогноз) и в журнале за семестр.
 * → Set из «лек» / «практ» / «лаб» / «сем».
 */
function subjectKinds(subject, planTypes) {
  const kinds = new Set([...planTypes].map(kindOf));
  const kdiscs = new Set();
  for (const key of state.weekRaw.keys()) {
    for (const d of weekDays(parseIsoDate(key), null, false)) for (const l of d.lessons) {
      if (l.title !== subject) continue;
      kinds.add(kindOf(l.type));
      const pf = state.perfIndex.get(`${isoDate(d.date)}|${l.start}`);
      if (pf) kdiscs.add(pf.kdisc);
    }
  }
  const name = subject.toLowerCase();
  for (const [kdisc, p] of state.perf) {
    if (!kdiscs.has(kdisc) && !p.items.some((x) => x.subject.toLowerCase() === name)) continue;
    for (const x of p.items) kinds.add(kindOf(x.kind));
  }
  return kinds;
}
const KIND_TYPE = { "лек": "лек.", "практ": "практ. зан.", "лаб": "лаб.", "сем": "сем." };

/** Вид пары словами: название и варианты «к какой сдавать». */
const typeWords = (type) => {
  const t = String(type || "").toLowerCase();
  if (t.startsWith("лек")) return ["Лекция", "Следующей лекции", "Через одну лекцию", "Через две лекции"];
  if (t.startsWith("лаб")) return ["Лаба", "Следующей лабе", "Через одну лабу", "Через две лабы"];
  if (t.startsWith("практ")) return ["Практика", "Следующей практике", "Через одну практику", "Через две практики"];
  if (t.startsWith("сем")) return ["Семинар", "Следующему семинару", "Через один семинар", "Через два семинара"];
  return [typeShort(type), "Следующей паре", "Через одну пару", "Через две пары"];
};
const whenLabels = (type) => typeWords(type).slice(1);
const dstate = { subject: "", custom: false, type: null, when: "none", kind: "lab", kindTouched: false, showAll: false, occ: [], keep: null };

function openTask(id) {
  state.editingId = id;
  const t = id ? state.tasks.find((x) => x.id === id) : null;
  $("#task-dialog-title").textContent = t ? "Задача" : "Новая задача";
  $("#t-title").value = t?.title || "";
  $("#t-notes").value = t?.notes || "";
  $("#t-due").value = toLocalInput(t?.due);
  $("#t-delete").classList.toggle("hidden", !t);
  const subjects = subjectsWithTypes(planDays()).map((x) => x.subject);
  Object.assign(dstate, {
    subject: t?.lesson?.subject || t?.subject || "",
    type: t?.lesson?.type || null,
    kind: t?.kind || "lab",
    kindTouched: !!t,
    showAll: false,
    keep: t?.lesson && !t.lesson.pending ? { ...t.lesson } : null,
    typeAuto: true,
    moreKinds: false,
    when: t?.lesson?.pending ? "wait" : t?.lesson ? "keep" : t?.due ? "custom" : "first",
  });
  dstate.custom = !!dstate.subject && !subjects.includes(dstate.subject);
  $("#t-subject").value = dstate.custom ? dstate.subject : "";
  renderTaskForm();
  dlg.showModal();
  if (!t) $("#t-title").focus();
}

function renderTaskForm() {
  const now = new Date();
  const plan = planDays();
  const subs = subjectsWithTypes(plan, now);
  const known = subs.find((x) => x.subject === dstate.subject);
  let shown = dstate.showAll ? subs : subs.slice(0, 5);
  if (known && !shown.includes(known)) shown = [...shown, known];
  $("#t-subjects").html = shown.map((x) => `<button type="button" class="pchip ${!dstate.custom && x.subject === dstate.subject ? "on" : ""}" data-subj="${esc(x.subject)}" title="${esc(x.subject)}">${esc(shortSubject(x.subject))}</button>`).join("") +
    (subs.length > shown.length ? `<button type="button" class="pchip more" data-subj-more>ещё…</button>` : "") +
    `<button type="button" class="pchip more ${dstate.custom ? "on" : ""}" data-subj-custom>Другой…</button>`;
  $("#t-subject").classList.toggle("hidden", !dstate.custom);

  // Виды пар — только те, что у предмета есть.
  // Виды пар: те, что у предмета бывали за семестр. Остальные — под «Другая…» (например, практику ещё не ставили).
  const own = known && !dstate.custom ? subjectKinds(dstate.subject, known.types) : new Set();
  const rest = known && !dstate.custom ? ["лек", "практ", "лаб"].filter((k) => !own.has(k)) : [];
  const shownKinds = [...own].filter((k) => KIND_TYPE[k]).concat(dstate.moreKinds ? rest : []);
  if (dstate.type && !shownKinds.includes(kindOf(dstate.type))) {
    if (rest.includes(kindOf(dstate.type))) dstate.moreKinds = true, shownKinds.push(...rest.filter((k) => !shownKinds.includes(k)));
    else dstate.type = null;
  }
  if (!dstate.type && known && known.types.size === 1 && own.size === 1 && dstate.typeAuto !== false) dstate.type = [...known.types][0];
  $("#t-types-wrap").classList.toggle("hidden", !known || dstate.custom);
  $("#t-types").html = `<button type="button" class="pchip ${!dstate.type ? "on" : ""}" data-type="">Любая</button>` +
    shownKinds.map((k) => `<button type="button" class="pchip ${dstate.type && kindOf(dstate.type) === k ? "on" : ""}" data-type="${esc(KIND_TYPE[k])}">${esc(typeWords(KIND_TYPE[k])[0])}</button>`).join("") +
    (rest.length && !dstate.moreKinds ? `<button type="button" class="pchip more" data-kinds-more title="Если такой пары у предмета ещё не было">Другая…</button>` : "");

  // К какой паре сдавать.
  dstate.occ = known && !dstate.custom ? occurrences(plan, dstate.subject, dstate.type, now, 3) : [];
  const keepIdx = dstate.keep ? dstate.occ.findIndex((o) => o.date === dstate.keep.date && o.start === dstate.keep.start && o.title === dstate.keep.subject) : -1;
  if (dstate.when === "keep" && keepIdx >= 0) dstate.when = keepIdx;
  const canWait = known && !dstate.custom && dstate.type && !dstate.occ.length;
  if (dstate.when === "first") dstate.when = dstate.occ.length ? 0 : canWait ? "wait" : "none";
  if (dstate.when === "wait" && !canWait) dstate.when = dstate.occ.length ? 0 : "none";
  if (typeof dstate.when === "number" && dstate.when >= dstate.occ.length) dstate.when = dstate.occ.length ? 0 : "none";
  if (dstate.when === "keep" && (!dstate.keep || dstate.keep.subject !== dstate.subject)) dstate.when = dstate.occ.length ? 0 : "none";
  const optHTML = (key, title, line, note, pre) => `<button type="button" class="opt ${dstate.when === key ? "on" : ""}" data-when="${key}"><b>${title}</b>${line ? `<span>${line}</span>` : ""}${note ? `<em class="${pre ? "pre" : ""}">${note}</em>` : ""}</button>`;
  const fmtO = (o) => `${esc(fmtDay(parseIsoDate(o.date), { weekday: "short", day: "numeric", month: "short" }))} · ${esc(o.start)}${o.room ? ` · ауд. ${esc(o.room)}` : ""}`;
  $("#t-when").html = dstate.occ.map((o, i) => optHTML(i, whenLabels(dstate.type)[i], fmtO(o), o.forecast ? "предварительно" : esc(relativeDue(lessonDue(o), now)), o.forecast)).join("") +
    (canWait ? optHTML("wait", whenLabels(dstate.type)[0], "пока нет в расписании", "срок появится сам") : "") +
    (dstate.when === "keep" ? optHTML("keep", "Как было", `${esc(slotLabel(dstate.keep.date, dstate.keep.start))}`, "") : "") +
    optHTML("custom", "Своя дата…", "", "") + optHTML("none", "Без срока", "", "");
  $("#t-due").classList.toggle("hidden", dstate.when !== "custom");

  // Тип задания: по виду пары, пока не выбрали сами.
  if (!dstate.kindTouched) {
    const ty = String(dstate.type || dstate.occ[0]?.type || "").toLowerCase();
    dstate.kind = guessKind($("#t-title").value) !== "other" ? guessKind($("#t-title").value) : ty.startsWith("лаб") ? "lab" : ty.startsWith("практ") || ty.startsWith("сем") ? "hw" : "other";
  }
  $("#t-kinds").html = KINDS.map(([k, label]) => `<button type="button" class="pchip ${k === dstate.kind ? "on" : ""}" data-kind="${k}">${label}</button>`).join("");
}

$("#task-dialog").addEventListener("click", (e) => {
  const q = (sel) => e.target.closest(sel);
  if (q("[data-subj]")) { Object.assign(dstate, { subject: q("[data-subj]").dataset.subj, custom: false, type: null, typeAuto: true, moreKinds: false, when: "first" }); }
  else if (q("[data-subj-more]")) dstate.showAll = true;
  else if (q("[data-subj-custom]")) { Object.assign(dstate, { custom: true, subject: $("#t-subject").value.trim(), type: null, when: dstate.when === "none" ? "none" : "custom" }); setTimeout(() => $("#t-subject").focus(), 0); }
  else if (q("[data-kinds-more]")) dstate.moreKinds = true;
  else if (q("[data-type]")) { dstate.type = q("[data-type]").dataset.type || null; dstate.typeAuto = false; dstate.when = "first"; }
  else if (q("[data-when]")) { const w = q("[data-when]").dataset.when; dstate.when = /^\d$/.test(w) ? Number(w) : w; }
  else if (q("[data-kind]")) { dstate.kind = q("[data-kind]").dataset.kind; dstate.kindTouched = true; }
  else return;
  renderTaskForm();
});
$("#t-title").addEventListener("input", () => { if (!dstate.kindTouched) renderTaskForm(); });

$("#task-add-btn").addEventListener("click", () => openTask(null));
$("#t-cancel").addEventListener("click", () => dlg.close());
$("#task-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const title = $("#t-title").value.trim();
  if (!title) return;
  const t = state.tasks.find((x) => x.id === state.editingId);
  const data = {
    title,
    subject: dstate.custom ? $("#t-subject").value.trim() : dstate.subject,
    kind: dstate.kind,
    notes: $("#t-notes").value.trim(),
  };
  const target = t ? Object.assign(t, data) : { id: crypto.randomUUID(), ...data, done: false, created: Date.now() };
  if (typeof dstate.when === "number") linkTask(target, dstate.occ[dstate.when], dstate.type);
  else if (dstate.when === "keep") { /* срок и пара прежние */ delete target.moved; }
  else if (dstate.when === "wait") { target.lesson = { subject: dstate.subject, type: dstate.type, pending: true }; target.due = null; delete target.moved; }
  else {
    delete target.lesson; delete target.moved;
    target.due = dstate.when === "custom" && $("#t-due").value ? new Date($("#t-due").value).toISOString() : null;
  }
  touch(target);
  if (!t) state.tasks.push(target);
  saveTasks();
  dlg.close();
  renderAll();
});
$("#t-delete").addEventListener("click", () => {
  const t = state.tasks.find((x) => x.id === state.editingId);
  if (t) { for (const k of Object.keys(t)) if (k !== "id") delete t[k]; Object.assign(t, { deleted: true, updated: Date.now() }); }
  saveTasks();
  dlg.close();
  renderAll();
});

// ---------- рендер: пропуски ----------

function renderSkips(now = new Date()) {
  const s = currentStats(now);
  const sem = semesterOf(now);
  $("#skips-summary").html = `
    <div class="card">
      <div class="skips-hero">${ringHTML(s)}
        <div class="meter-text">
          <span class="muted small">${esc(sem.label)}</span>
          <strong style="font-size:20px">${pluralHours(s.unexcused)} из ${s.limit} неуважительных</strong>
          ${meterVerdict(s)}
          ${s.pendingHours ? `<span class="muted small">Из них ${pluralHours(s.pendingHours)} ещё нет на портале</span>` : ""}
        </div>
      </div>
      <div class="stats">
        <div class="stat"><b>${s.left}</b><span>часов до лимита</span></div>
        <div class="stat"><b>${s.excused}</b><span>по заявлению</span></div>
        <div class="stat"><b>${s.worked}</b><span>отработано</span></div>
      </div>
    </div>`;

  const pend = s.pending;
  const pendHTML = pend.length ? `<div class="sem-title"><span>Ещё нет на портале</span><span>${pend.length} ${pend.length === 1 ? "пара" : pend.length < 5 ? "пары" : "пар"} · уже в счётчике</span></div>
    <div class="skip-list">${pend.map((x) => `
      <div class="skip-row pend-row">
        <span>${fmtDay(parseIsoDate(x.date), { day: "numeric", month: "short", weekday: "short" })} · ${esc(x.start)}</span>
        <span class="pend-subj">${esc(x.subject)}</span>
        <span class="pend-acts">
          <button class="pchip ${x.excused ? "on" : ""}" data-pend-act="excused" data-pend-id="${esc(x.id)}">уваж.</button>
          <button class="icon-btn sm" data-pend-act="remove" data-pend-id="${esc(x.id)}" aria-label="Удалить">×</button>
        </span>
      </div>`).join("")}</div>
    <p class="muted small pend-hint">Исчезнут сами, когда деканат внесёт пропуск на портал.</p>` : "";
  const groups = groupBySemester(state.skips);
  $("#skips-list").html = pendHTML + (groups.length
    ? groups.map((g) => {
        const gs = semesterStats(state.skips, g.key, state.settings.limit);
        return `<div class="sem-title"><span>${esc(g.label)}</span><span>${gs.unexcused} неуваж. · ${gs.excused} уваж.</span></div>
          <div class="skip-list">${g.items.map((x) => `
            <div class="skip-row">
              <span>${fmtDay(x.date, { day: "numeric", month: "short", weekday: "short" })}</span>
              <span class="skip-h">${x.hours} ч${x.worked ? ` <small class="muted">−${x.worked}</small>` : ""}</span>
              <span class="skip-reason ${x.unexcused ? "bad" : "good"}">${esc(x.reason || "без причины")}</span>
            </div>`).join("")}</div>`;
      }).join("")
    : pend.length ? "" : `<div class="empty">Пропусков нет — или данные ещё не загрузились.</div>`);

  $("#limit-input").value = state.settings.limit;
  $("#account-line").textContent = state.username ? `Вход выполнен как ${state.username}` : "";
}

$("#limit-input").addEventListener("change", (e) => {
  const v = Math.round(Number(e.target.value));
  if (v > 0 && v <= 200) { state.settings.limit = v; saveSettings(); renderAll(); }
});
$("#logout-btn").addEventListener("click", async () => {
  await api.logout();
  state.skips = []; state.days = []; state.lastSync = null; state.username = null;
  state.cabinetRaw = null; state.weekRaw.clear(); state.weekFetched.clear(); state.weekStart = null;
  state.otherRaw.clear(); state.viewing = null; state.favorites = []; state.changes = {}; state.skipMarks = [];
  state.perf.clear(); state.perfIndex.clear();
  api.save("favorites", "[]"); api.save("sched_changes2", "{}"); api.save("skip_marks", "[]");
  api.save("last_sync", "");
  showLogin();
});

// ---------- синхронизация ноутбук ↔ телефон ----------

const sync = { role: null, cfg: {}, timer: null, busy: false };

function renderSyncCard() {
  $("#sync-server").classList.toggle("hidden", sync.role !== "server");
  $("#sync-client").classList.toggle("hidden", sync.role !== "client");
  if (sync.role === "server") $("#sync-pin").textContent = sync.info?.pin || "——————";
  else if (document.activeElement !== $("#sync-code")) $("#sync-code").value = sync.cfg.pin || "";
}

function scheduleSync() {
  if (sync.role !== "client" || !sync.cfg.pin) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => runSync(true), 1500);
}

async function runSync(silent) {
  if (sync.role !== "client" || !sync.cfg.pin || sync.busy) return;
  sync.busy = true;
  if (!silent) $("#sync-msg").textContent = "Ищу ноутбук в сети…";
  try {
    const res = await api.syncNow(sync.cfg.addr || null, sync.cfg.pin);
    try { state.tasks = JSON.parse((await api.load("tasks")) || "[]"); } catch {}
    try { state.favorites = JSON.parse((await api.load("favorites")) || "[]"); } catch {}
    try { state.skipMarks = JSON.parse((await api.load("skip_marks")) || "[]"); } catch {}
    Object.assign(sync.cfg, { addr: res.address, last: Date.now() });
    api.save("sync", JSON.stringify(sync.cfg));
    $("#sync-msg").textContent = `Синхронизировано: ${res.count} задач. Последний раз — ${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}.`;
    if (!silent) toast("Задачи синхронизированы");
    renderAll();
  } catch (err) {
    if (!silent) $("#sync-msg").textContent = String(err);
  } finally {
    sync.busy = false;
    renderSyncCard();
  }
}

$("#sync-client").addEventListener("submit", (e) => {
  e.preventDefault();
  sync.cfg.pin = $("#sync-code").value.trim();
  api.save("sync", JSON.stringify(sync.cfg));
  runSync(false);
});

async function initSync() {
  try { sync.cfg = JSON.parse((await api.load("sync")) || "{}"); } catch { sync.cfg = {}; }
  try {
    sync.info = await api.syncInfo();
    sync.role = sync.info.role;
  } catch { sync.role = null; }
  if (sync.role === "server" && api.onTasksUpdated) {
    api.onTasksUpdated(async () => {
      try { state.tasks = JSON.parse((await api.load("tasks")) || "[]"); } catch {}
      try { state.favorites = JSON.parse((await api.load("favorites")) || "[]"); } catch {}
      try { state.skipMarks = JSON.parse((await api.load("skip_marks")) || "[]"); } catch {}
      renderAll();
      toast("Обновлено с телефона");
    });
  }
  renderSyncCard();
  runSync(true);
}

// ---------- Учёба ----------

const study = (m) => state.study[m];
const libraryBooks = (now = new Date()) => normalizeLibrary(study("getLibrary"), now);

function bookDueHTML(b) {
  const cls = b.daysLeft < 0 ? "overdue" : b.daysLeft <= 3 ? "today" : "week";
  const when = b.daysLeft < 0 ? `просрочено на ${-b.daysLeft} дн.` : b.daysLeft === 0 ? "вернуть сегодня" : `вернуть через ${b.daysLeft} дн.`;
  return `<div class="task ${cls} book-due" data-go-detail="library">
    <span class="book-ico" aria-hidden="true"></span>
    <div><div class="task-title">${esc(b.title)}</div><div class="task-sub">Библиотека · ${esc(b.place)}</div></div>
    <div class="task-due">${esc(when)}</div>
  </div>`;
}

const pluralBooks = (n) => { const a = n % 100, b = n % 10; return `${n} ${a > 10 && a < 20 ? "книг" : b === 1 ? "книга" : b >= 2 && b <= 4 ? "книги" : "книг"}`; };

/** Плитки раздела «Учёба»: показываем только то, на что сайт реально отдал данные. */
/** Раздел «Учёба»: крупно — успеваемость; рядом — рейтинг и библиотека; курсы строкой; редкое — списком. */
function studyHTML(now = new Date()) {
  const parts = [];
  const prog = normalizeProgress(study("getProgress"));
  const sems = progressBySemester(prog);
  if (sems.length) {
    const last = sems[0];
    const chrono = sems.filter((g) => g.avg).slice(0, 8).reverse();
    const lo = 4, hi = 10;
    const bars = chrono.map((g, i) => {
      const h = Math.max(8, Math.round(((g.avg - lo) / (hi - lo)) * 100));
      return `<div class="sx-bar ${i === chrono.length - 1 ? "now" : ""}"><i style="height:${h}%"></i><span>${g.avg.toFixed(1)}</span></div>`;
    }).join("");
    parts.push(`<button class="sx-card sx-hero" data-go-detail="progress">
      <span class="sx-k"><span class="ico ico-cap"></span>Успеваемость</span>
      <span class="sx-big">${last.avg ? `<b data-count="${last.avg}" data-fmt="1" data-ck="avg">0</b><small>средний балл · ${esc(last.label.split(" ")[0].toLowerCase())}</small>` : `<b>${prog.length}</b><small>оценок</small>`}</span>
      ${chrono.length > 1 ? `<span class="sx-bars">${bars}</span>` : ""}
    </button>`);
  }
  const small = [];
  const r = normalizeRating(study("getStatistics"));
  if (r) small.push(`<button class="sx-card" data-go-detail="rating">
      <span class="sx-k"><span class="ico ico-chart"></span>Рейтинг</span>
      <span class="sx-mid"><b data-count="${r.score}" data-ck="score">0</b>${r.letter ? `<em class="sx-letter">${esc(r.letter)}</em>` : ""}</span>
      <small class="sx-sub">баллов за год</small></button>`);
  const books = libraryBooks(now);
  if (books.length) {
    const soon = books.find((b) => b.daysLeft !== null);
    const hot = soon && soon.daysLeft <= 7;
    small.push(`<button class="sx-card" data-go-detail="library">
      <span class="sx-k"><span class="ico ico-shelf"></span>Библиотека</span>
      <span class="sx-mid"><b>${books.length}</b><small>${pluralBooks(books.length).split(" ")[1]}</small></span>
      <small class="sx-sub ${hot ? "hot" : ""}">${soon ? `вернуть до ${soon.due.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}` : "на руках"}</small></button>`);
  }
  if (small.length) parts.push(`<div class="sx-pair">${small.join("")}</div>`);

  const courses = normalizeCourses(study("getCoursesData"));
  if (courses.length) {
    const prof = normalizeProfile(study("getChoosenCourses"));
    const sem = prof ? currentSemesterNumber(Number(prof.course) || 1, now) : null;
    const cur = courses.flatMap((k) => k.semesters).find((x) => x.semester === sem);
    parts.push(`<button class="sx-card sx-wide" data-go-detail="courses">
      <span class="sx-k"><span class="ico ico-layers"></span>Курсы на платформе</span>
      <span class="sx-row"><b>${cur ? cur.items.length : "—"}</b><small>${cur ? `предметов в ${sem} семестре` : "материалы предметов"}</small><i class="sx-go">›</i></span>
    </button>`);
  }

  const rows = [];
  const orders = normalizeOrders(study("getStudentOrders"));
  if (orders.length) rows.push(["orders", "doc", "Приказы", `${orders.length} · последний ${orders[0].dateText}`]);
  const groups = normalizeGroups(study("getGroups"));
  if (groups.length) rows.push(["group", "people", "Группа", `${groups[0].name} · ${groups[0].members.length} чел.`]);
  // Общежитие — только тем, кто там живёт или жил: у городских раздела нет.
  const h = normalizeHostel(study("getHostel"));
  if (h?.room) rows.push(["hostel", "home", "Общежитие", `комната ${h.room}${h.name ? ` · ${h.name}` : ""}`]);
  if (rows.length) parts.push(`<div class="sx-card sx-list">${rows.map(([key, icon, title, sub]) => `
      <button class="sx-li" data-go-detail="${key}"><span class="sx-ico"><span class="ico ico-${icon}"></span></span>
        <span><b>${esc(title)}</b><small>${esc(sub)}</small></span><i class="sx-go">›</i></button>`).join("")}</div>`);
  return parts.join("");
}

function renderStudy(now = new Date()) {
  const p = normalizeProfile(study("getChoosenCourses"));
  $("#profile-card").html = p
    ? `<div class="avatar">${esc(initials(p.fio))}</div>
       <div class="profile-main">
         <div class="profile-name">${esc(shortFio(p.fio))}</div>
         <div class="muted small">${esc(p.group)} · ${esc(p.course)} курс · ${esc(p.form)}</div>
       </div>
       <details class="profile-more">
         <summary aria-label="Подробнее"></summary>
         <dl>
           <div><dt>ФИО</dt><dd>${esc(p.fio)}</dd></div>
           <div><dt>Студенческий</dt><dd>${esc(p.book)}</dd></div>
           <div><dt>Специальность</dt><dd>${esc(p.speciality)}</dd></div>
           <div><dt>Факультет</dt><dd>${esc(p.faculty)}</dd></div>
         </dl>
       </details>`
    : `<div class="avatar">?</div><div class="profile-main"><div class="profile-name">${esc(state.username || "")}</div><div class="muted small">Данные профиля появятся после обновления</div></div>`;

  $("#study-tiles").html = studyHTML(now) || `<div class="empty">Разделы появятся после первого обновления данных.</div>`;
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-go-detail]");
  if (!t) return;
  state.detail = t.dataset.goDetail;
  if (state.view === "detail") renderDetail();
  else go("detail");
});

function semesterLabel(n) {
  return `${n} семестр · ${Math.ceil(n / 2)} курс`;
}

function renderDetail(now = new Date()) {
  const key = state.detail;
  const body = $("#detail-body");
  const titles = { courses: "Курсы", progress: "Успеваемость", rating: "Рейтинг", library: "Библиотека", hostel: "Общежитие", orders: "Приказы", group: "Группа" };
  $("#detail-title").textContent = titles[key] || "";

  if (key === "courses") {
    const courses = normalizeCourses(study("getCoursesData"));
    const prof = normalizeProfile(study("getChoosenCourses"));
    const sem = prof ? currentSemesterNumber(Number(prof.course) || 1, now) : null;
    body.html = `<p class="muted small">Материалы предметов на образовательной платформе. Открываются в браузере.</p>` +
      courses.map((k) => k.semesters.map((g) => `
        <details class="sem-block" ${g.semester === sem ? "open" : ""}>
          <summary class="sem-title"><span>${g.semester} семестр · ${k.kurs} курс${g.semester === sem ? ' <i class="now-badge">сейчас</i>' : ""}</span><span>${g.items.length}</span></summary>
          <div class="list">${g.items.map((c) => `
            <button class="row-item link-row" data-url="${esc(courseUrl(c.id))}">
              <span class="course-dot" aria-hidden="true"></span>
              <div class="row-title">${esc(c.name)}</div>
              <span class="row-end ext" aria-hidden="true">↗</span>
            </button>`).join("")}</div>
        </details>`).join("")).join("");
  } else if (key === "progress") {
    const sems = progressBySemester(normalizeProgress(study("getProgress")));
    const att = normalizeAttestation(study("getAttestation"));
    body.html = `<div class="seg" role="tablist">
        <button class="seg-btn active" data-seg="sessions">Сессии</button>
        <button class="seg-btn" data-seg="attestation">Аттестация</button>
      </div>
      <div data-pane="sessions">${sems.map((g) => `
        <div class="sem-title"><span>${esc(g.label)}</span>${g.avg ? `<span>средний <b class="accent">${g.avg.toFixed(2)}</b></span>` : ""}</div>
        <div class="list">${g.items.map((i) => `
          <div class="row-item">
            <div class="grade ${i.gradeNum ? `g${Math.min(10, i.gradeNum)}` : "pass"}">${i.gradeNum ?? "✓"}</div>
            <div><div class="row-title">${esc(i.subject)}</div><div class="row-sub">${esc(i.kind)} · ${i.date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}${i.teacher ? ` · ${esc(i.teacher)}` : ""}</div></div>
          </div>`).join("")}</div>`).join("") || `<div class="empty">Оценок пока нет.</div>`}</div>
      <div data-pane="attestation" class="hidden">${att.map((s) => `
        <div class="sem-title"><span>${semesterLabel(s.semester)}</span></div>
        <div class="list">${s.items.map((i) => `
          <div class="row-item">
            <div class="grade ${/^\d/.test(i.result) ? `g${Math.min(10, parseInt(i.result))}` : "pass"}">${/^\d/.test(i.result) ? esc(parseInt(i.result)) : "✓"}</div>
            <div><div class="row-title">${esc(i.subject)}</div><div class="row-sub">${esc(i.result)}${i.attempts.length ? ` · ${i.attempts.map((a) => esc(a.date)).join(", ")}` : ""}${i.attempts.length > 1 ? ` · попыток: ${i.attempts.length}` : ""}</div></div>
          </div>`).join("")}</div>`).join("") || `<div class="empty">Данных аттестации нет.</div>`}</div>`;
  } else if (key === "rating") {
    const r = normalizeRating(study("getStatistics"));
    body.html = r ? `<div class="card hero-num rise">
        <div class="muted small">${esc(r.year)}${r.preliminary ? " · предварительный" : ""}</div>
        <div class="big"><span data-count="${r.score}" data-ck="score-big">0</span><small> баллов</small></div>
        ${r.letter ? `<div class="letter">категория <b>${esc(r.letter)}</b></div>` : ""}
        ${r.placeFaculty ? `<div class="muted">место на факультете: <b>${r.placeFaculty}</b></div>` : ""}
        ${r.placeUniversity ? `<div class="muted">место в университете: <b>${r.placeUniversity}</b></div>` : ""}
      </div>` : `<div class="empty">Рейтинг пока не сформирован.</div>`;
  } else if (key === "library") {
    const books = libraryBooks(now);
    body.html = `<div class="list">${books.map((b) => `
      <div class="row-item">
        <span class="book-ico" aria-hidden="true"></span>
        <div><div class="row-title">${esc(b.title)}</div>
          <div class="row-sub">${esc(b.author)}</div>
          <div class="row-sub">${esc(b.place)}${b.address ? ` · ${esc(b.address)}` : ""}</div></div>
        <div class="row-end ${b.daysLeft !== null && b.daysLeft <= 3 ? "danger" : b.daysLeft !== null && b.daysLeft <= 14 ? "warn" : ""}">
          ${b.due ? `до ${b.due.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "2-digit" })}` : ""}
          ${b.daysLeft !== null ? `<small>${b.daysLeft < 0 ? `просрочено ${-b.daysLeft} дн.` : `${b.daysLeft} дн.`}</small>` : ""}
        </div>
      </div>`).join("") || `<div class="empty">Книг на руках нет.</div>`}</div>`;
  } else if (key === "hostel") {
    const h = normalizeHostel(study("getHostel"));
    body.html = h ? `<div class="card stack rise">
        <div class="big-row"><span class="muted">Общежитие</span><b>${esc(h.name)}</b></div>
        <div class="big-row"><span class="muted">Комната</span><b>${esc(h.room)}</b></div>
        <div class="big-row"><span class="muted">Адрес</span><b>${esc(h.address)}</b></div>
        <div class="big-row"><span class="muted">Задолженность</span><b class="${h.debt > 0 ? "danger" : "ok"}">${h.debt > 0 ? `${h.debt.toFixed(2)} р.` : "нет"}</b></div>
        ${h.penalty > 0 ? `<div class="big-row"><span class="muted">Пеня</span><b class="danger">${h.penalty.toFixed(2)} р.</b></div>` : ""}
        ${h.lastPayment ? `<div class="big-row"><span class="muted">Последняя оплата</span><b>${esc(h.lastPayment)}</b></div>` : ""}
      </div>` : `<div class="empty">Данных нет.</div>`;
  } else if (key === "orders") {
    body.html = `<div class="list">${normalizeOrders(study("getStudentOrders")).map((o) => `
      <details class="row-item order">
        <summary><div><div class="row-title">${esc(o.type)}</div><div class="row-sub">${esc(o.number)} от ${esc(o.dateText)}</div></div></summary>
        <p class="order-text">${esc(o.text)}</p>
      </details>`).join("")}</div>`;
  } else if (key === "group") {
    const me = normalizeProfile(study("getChoosenCourses"));
    body.html = normalizeGroups(study("getGroups")).map((g) => `
      <div class="sem-title"><span>${esc(g.name)}</span><span>${g.members.length} чел.</span></div>
      <div class="list cols">${g.members.map((m, i) => `
        <div class="row-item ${me && m.name === me.fio ? "me" : ""}"><span class="num">${i + 1}</span><div class="row-title">${esc(m.name)}</div></div>`).join("")}</div>`).join("");
  } else {
    body.html = "";
  }
  animateIn(body);
}

document.addEventListener("click", (e) => {
  const u = e.target.closest("[data-url]");
  if (u) { openExternal(u.dataset.url); toast("Открываю в браузере…"); }
});

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-seg]");
  if (!b) return;
  const root = b.closest("#detail-body");
  $$(".seg-btn", root).forEach((x) => x.classList.toggle("active", x === b));
  $$("[data-pane]", root).forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== b.dataset.seg));
  animateIn($(`[data-pane="${b.dataset.seg}"]`, root));
});

// ---------- обновления ----------

const isAndroid = /Android/i.test(navigator.userAgent);
const upd = { info: null, busy: false };

async function checkUpdates(manual) {
  if (!api.checkUpdate || upd.busy) return;
  upd.busy = true;
  const msg = $("#update-msg");
  if (manual) { msg.textContent = "Проверяю…"; $("#update-check").disabled = true; }
  try {
    const u = await api.checkUpdate();
    upd.info = u;
    api.save("update_checked", String(Date.now()));
    const has = u.available;
    $("#update-install").classList.toggle("hidden", !has);
    ["#update-dot", "#update-dot-m"].forEach((s) => $(s)?.classList.toggle("hidden", !has));
    // Плашка на главном экране: видно сразу, без захода в настройки.
    const ub = $("#upd-banner");
    ub.classList.toggle("hidden", !has);
    if (has) ub.html = `<span><b>Доступна версия ${esc(u.latest)}</b><small>у тебя ${esc(u.current)}</small></span><i>Обновить</i>`;
    if (has) {
      // Описание релиза от GitHub — это ссылки и разметка, в окошке они только ломают вёрстку.
      msg.textContent = `Доступна версия ${u.latest}.`;
      $("#update-install").textContent = "Обновить";
      if (!manual) toast(`Вышла версия ${u.latest}`);
    } else if (manual) {
      msg.textContent = u.latest ? `У тебя последняя версия (${u.current}).` : "Релизов пока нет.";
    }
  } catch (err) {
    if (manual) msg.textContent = String(err);
  } finally {
    upd.busy = false;
    $("#update-check").disabled = false;
  }
}

$("#update-check").addEventListener("click", () => checkUpdates(true));
$("#upd-banner").addEventListener("click", () => {
  go("settings");
  setTimeout(() => $("#update-install").click(), 350);
});
$("#update-install").addEventListener("click", async () => {
  const u = upd.info;
  if (!u?.available) return;
  if (!u.asset) { openExternal(u.page); return; }
  $("#update-install").disabled = true;
  $("#update-msg").textContent = isAndroid
    ? "Скачиваю обновление… Потом Android спросит «Установить?» — задачи сохранятся."
    : "Скачиваю установщик… Приложение перезапустится само.";
  try {
    await api.installUpdate(u.asset);
    if (isAndroid) $("#update-msg").textContent = "Нажми «Установить» в окне Android.";
  } catch (err) { $("#update-msg").textContent = String(err); }
  finally { $("#update-install").disabled = false; }
});

async function initUpdates() {
  if (!api.version) { $("#app-version").textContent = "демо"; return; }
  try { $("#app-version").textContent = `версия ${await api.version()}`; } catch {}
  // Проверяем при каждом запуске и потом раз в 6 часов — это один короткий запрос к GitHub.
  setTimeout(() => checkUpdates(false), 4000);
  setInterval(() => { if (!document.hidden) checkUpdates(false); }, 6 * 3600_000);
}

// ---------- темы оформления ----------
// [id, название, фон, карточка, акцент]; «Как в системе» — тёмная лиловая или светлая вслед за ОС.
const THEMES = [
  ["system", "Как в системе"],
  ["lilac", "Лиловая", "#110f16", "#1b1823", "#c7b3ff"],
  ["amoled", "Чёрная", "#000000", "#0b0a0e", "#c7b3ff"],
  ["midnight", "Полночь", "#0e1017", "#171a24", "#a9c1ff"],
  ["ocean", "Океан", "#0c1215", "#141b1f", "#8ee3f0"],
  ["mint", "Мята", "#0d1312", "#151d1b", "#9be8cf"],
  ["sakura", "Сакура", "#140f13", "#1d161c", "#ffb7d5"],
  ["sunset", "Закат", "#151010", "#1e1716", "#ffb59a"],
  ["amber", "Янтарь", "#12100c", "#1b1813", "#ffd27a"],
  ["graphite", "Графит", "#0f0f11", "#18181b", "#e6e6ea"],
  ["light", "Светлая", "#f6f3fc", "#ffffff", "#7a55e8"],
  ["light-mint", "Светлая мята", "#f2f8f6", "#ffffff", "#1f9c78"],
  ["light-sand", "Песочная", "#f8f4ec", "#fffdf8", "#b5701c"],
];
const CARD_STYLES = [
  ["soft", "Обычные"], ["frost", "Матовое стекло"], ["gradient", "Градиент"], ["pastel", "Пастель"], ["neon", "Неон"], ["tint", "Цветные"],
  ["pixel", "Пиксель"], ["brutal", "Брутал"], ["sticker", "Стикеры"], ["paper", "Тетрадь"], ["blueprint", "Чертёж"], ["corners", "Уголки"], ["sharp", "Строгие"],
];
const APP_ICONS = [
  ["lilac", "Сирень"], ["night", "Ночь"], ["minimal", "Минимал"], ["mint", "Мята"], ["sunset", "Закат"], ["letter", "Буква U"], ["cap", "Выпускник"],
  ["book", "Книга"], ["owl", "Сова"], ["planet", "Планета"], ["rocket", "Ракета"], ["bulb", "Идея"], ["pencil", "Карандаш"], ["coffee", "Кофе"],
];
/** Значок в шапке приложения — тот же, что выбран иконкой. */
const applyBrand = () => document.documentElement.style.setProperty("--brand-icon", `url("icons/${state.settings.icon || "lilac"}.svg")`);
const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)");

function applyTheme() {
  let id = state.settings.theme || "lilac";
  if (id === "system") id = systemDark && !systemDark.matches ? "light" : "lilac";
  if (id === "lilac") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
  // Стили, убранные в 0.3.1 (стекло, аура, голограмма, объём, контур), → обычные.
  if (state.settings.cards && !CARD_STYLES.some((c) => c[0] === state.settings.cards)) state.settings.cards = "soft";
  const cards = state.settings.cards || "soft";
  if (cards === "soft") delete document.documentElement.dataset.cards;
  else document.documentElement.dataset.cards = cards;
  try { localStorage.setItem("unitrack_theme_applied", id); localStorage.setItem("unitrack_cards_applied", cards); } catch {}
  const light = id.startsWith("light");
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", light ? "light" : "dark");
}
systemDark?.addEventListener?.("change", () => { if (state.settings.theme === "system") applyTheme(); });
// Тема из прошлого запуска — сразу, до загрузки настроек, чтобы не мигало.
try {
  const t = localStorage.getItem("unitrack_theme_applied"); if (t && t !== "lilac") document.documentElement.dataset.theme = t;
  const c = localStorage.getItem("unitrack_cards_applied"); if (c && c !== "soft") document.documentElement.dataset.cards = c;
} catch {}

function renderThemes() {
  const cur = state.settings.theme || "lilac";
  $("#theme-name").textContent = THEMES.find((t) => t[0] === cur)?.[1] || "";
  $("#theme-grid").html = THEMES.map(([id, name, bg, card, acc]) => {
    const dot = id === "system"
      ? `<span class="theme-dot" style="background:linear-gradient(135deg,#110f16 50%,#f6f3fc 50%)"><i style="background:#c7b3ff"></i></span>`
      : `<span class="theme-dot" style="background:${bg}"><b style="background:${card}"></b><i style="background:${acc}"></i></span>`;
    return `<button class="theme-sw ${id === cur ? "on" : ""}" data-theme-id="${id}" aria-pressed="${id === cur}">${dot}<span>${esc(name)}</span></button>`;
  }).join("");
  const curCards = state.settings.cards || "soft";
  $("#cards-name").textContent = CARD_STYLES.find((c) => c[0] === curCards)?.[1] || "";
  $("#cards-grid").html = CARD_STYLES.map(([id, name]) => `<button class="pchip ${id === curCards ? "on" : ""}" data-cards-id="${id}">${esc(name)}</button>`).join("");
}
function renderIcons() {
  const cur = state.settings.icon || "lilac";
  $("#icon-name").textContent = APP_ICONS.find((i) => i[0] === cur)?.[1] || "";
  $("#icon-grid").html = APP_ICONS.map(([id, name]) => `<button class="icon-sw ${id === cur ? "on" : ""}" data-icon-id="${id}" aria-pressed="${id === cur}">
    <img src="icons/${id}.svg" alt="" loading="lazy"><span>${esc(name)}</span></button>`).join("");
  $("#icon-note").textContent = /Android/i.test(navigator.userAgent)
    ? "Иконка на рабочем столе сменится через пару секунд. На некоторых телефонах ярлык придётся вынести на экран заново."
    : "На Windows меняется иконка окна и панели задач, пока приложение открыто. Ярлык в «Пуске» остаётся прежним.";
}
$("#icon-grid").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-icon-id]");
  if (!b || b.dataset.iconId === (state.settings.icon || "lilac")) return;
  const prev = state.settings.icon || "lilac";
  state.settings.icon = b.dataset.iconId;
  // Иконки, убранные после 0.3.0, — возвращаем «Сирень» (на Android это же выключит старый ярлык).
  if (state.settings.icon && !APP_ICONS.some((i) => i[0] === state.settings.icon)) {
    state.settings.icon = "lilac"; saveSettings();
    if (/Android/i.test(navigator.userAgent)) api.setAppIcon?.("lilac").catch(() => {});
  }
  applyBrand();
  renderIcons();
  try {
    await api.setAppIcon?.(state.settings.icon);
    saveSettings();
    toast("Иконка сменена");
  } catch (err) {
    state.settings.icon = prev;
    applyBrand();
    renderIcons();
    toast(String(err));
  }
});
$("#cards-grid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cards-id]");
  if (!b) return;
  state.settings.cards = b.dataset.cardsId;
  saveSettings();
  const swap = () => { applyTheme(); renderThemes(); };
  if (document.startViewTransition && !reduceMotion) document.startViewTransition(swap);
  else swap();
});
$("#theme-grid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-theme-id]");
  if (!b) return;
  state.settings.theme = b.dataset.themeId;
  saveSettings();
  const swap = () => { applyTheme(); renderThemes(); };
  if (document.startViewTransition && !reduceMotion) document.startViewTransition(swap);
  else swap();
});

// ---------- без масштабирования ----------
// Щипок на тачпаде и Ctrl+колёсико приходят в WebView как wheel с ctrlKey; Ctrl +/−/0 — клавишами.
window.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && ["+", "=", "-", "_", "0"].includes(e.key)) e.preventDefault();
});
for (const ev of ["gesturestart", "gesturechange"]) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
document.addEventListener("touchmove", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

// ---------- запуск ----------

function renderAll() {
  const now = new Date();
  renderSync();
  renderToday(now);
  renderSchedule(now);
  renderTasks(now);
  renderSkips(now);
  renderStudy(now);
}

async function boot() {
  history.replaceState({ view: "today" }, "");
  await loadLocal();
  applyTheme();
  renderThemes();
  applyBrand();
  renderIcons();
  // На Windows иконка окна не сохраняется между запусками — ставим заново. На Android ярлык помнит её сам.
  if (state.settings.icon && state.settings.icon !== "lilac" && !/Android/i.test(navigator.userAgent)) api.setAppIcon?.(state.settings.icon).catch(() => {});
  await initSync();
  initUpdates();
  state.username = await api.savedUsername();
  showView("today");
  if (!state.username) return showLogin();
  $("#app").classList.remove("hidden");
  await loadCache();
  renderAll();
  requestAnimationFrame(() => { movePill(); animateIn($(".view.active")); });
  refresh();
}

setInterval(() => { if (!document.hidden) { renderToday(); renderSync(); } }, 30_000);
setInterval(() => { if (!document.hidden && state.username) refresh(); }, 30 * 60_000);
setInterval(() => { if (!document.hidden) runSync(true); }, 5 * 60_000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) runSync(true);
  if (!document.hidden && state.username && (!state.lastSync || Date.now() - state.lastSync > 15 * 60_000)) refresh();
});

boot();
