import {
  DEFAULT_LIMIT, normalizeSkips, semesterStats, semesterOf, groupBySemester, normalizeSchedule,
  lessonStatus, nextLesson, subjectsFrom, taskBucket, BUCKETS, sortTasks, relativeDue, sameDay,
  pluralHours, pluralPairs, lessonPhase, HALF, BREAK,
  normalizeTeachers, mondayOf, addDays, isoDate, buildWeek, weekLessons, forecastWeek, weekLabel, parseIsoDate,
} from "./logic.js";
import { demoBackend } from "./demo.js";
import {
  groupCatalog, shortGroup, diffWeeks, slotKey, changeText, freeWindows, durationText, whereNow,
  relinkTasks, subjectsWithTypes, occurrences, lessonDue, slotLabel,
} from "./schedule.js";
import {
  normalizeProgress, progressBySemester, normalizeAttestation, normalizeRating, normalizeLibrary, normalizeHostel,
  normalizeOrders, normalizeGroups, normalizeProfile, gradebookHtml, shortFio, initials,
  normalizeCourses, courseUrl, currentSemesterNumber,
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
  changes: {},         // понедельник → { list, seen } — что поменялось в моём расписании
  search: { tab: "group", faculties: null, catalogs: {}, openFaculty: null, openSpec: null, query: "", student: null, studentErr: "", busy: false },
  windowsWith: null,
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
const STUDY_METHODS = ["getCoursesData", "getChoosenCourses", "getProgress", "getAttestation", "getStatistics", "getLibrary", "getHostel", "getStudentOrders", "getGroups", "getGradeBookMarkup"];

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
  try { state.changes = JSON.parse((await api.load("sched_changes")) || "{}"); } catch { state.changes = {}; }
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
const saveChanges = () => api.save("sched_changes", JSON.stringify(state.changes));

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
}

/** Раздел «Учёба» тянем вторым заходом: он не должен тормозить главный экран. */
async function refreshStudy() {
  const res = await Promise.allSettled(STUDY_METHODS.map((m) => api.fetch(m)));
  res.forEach((r, i) => { if (r.status === "fulfilled") try { state.study[STUDY_METHODS[i]] = JSON.parse(r.value); } catch {} });
  renderStudy();
  renderToday();
  if (state.view === "detail") renderDetail();
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
  const added = found.filter((c) => !known.has(sig(c)));
  // Изменение, которое потом откатили, больше не показываем.
  const slots = new Set(fresh.flatMap((d) => d.lessons.map((l) => slotKey(d.date, l))));
  const list = [...prev, ...added].filter((c) => (c.after ? slots.has(slotKey(c.after.date, c.after)) : !slots.has(slotKey(c.before.date, c.before))));
  if (!list.length) { if (state.changes[key]) { delete state.changes[key]; saveChanges(); } return; }
  state.changes[key] = { list, seen: added.length ? false : state.changes[key]?.seen ?? false };
  saveChanges();
}

const weekChanges = (monday) => state.changes[isoDate(monday)]?.list || [];
const unseenChanges = () => Object.entries(state.changes).filter(([, v]) => !v.seen && v.list.length);

/** Пару, к которой привязана задача, перенесли — сдвигаем срок. */
function relinkMine() {
  const cur = currentMonday();
  const weeks = [-1, 0, 1, 2, 3, 4, 5].map((k) => addDays(cur, 7 * k));
  const real = new Set(weeks.filter((m) => weekLessons(weekDays(m, null, false)) > 0).map(isoDate));
  const changes = Object.values(state.changes).flatMap((c) => c.list);
  const moved = relinkTasks(state.tasks, weeks.flatMap((m) => weekDays(m, null, false)), changes, real);
  if (moved.length) {
    saveTasks();
    toast(moved.length === 1 ? `Срок задачи «${moved[0].title}» сдвинут: пару перенесли` : `Сдвинуты сроки ${moved.length} задач: пары перенесли`);
  }
}

function renderWeekChange() {
  rebuildDays();
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
    const navView = view === "detail" ? "study" : ["search", "windows"].includes(view) ? "schedule" : view;
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === navView));
    $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === view));
    if (view === "detail") renderDetail();
    if (view === "schedule" && state.weekStart && +state.weekStart !== +currentMonday() && !["search", "windows"].includes(prevView)) openWeek(currentMonday());
    if (view === "search") renderSearch();
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

function typeTag(type) {
  if (!type) return "";
  const t = type.toLowerCase();
  const cls = t.startsWith("лек") ? "lec" : t.startsWith("лаб") ? "lab" : t.startsWith("практ") ? "prac" : t.startsWith("сем") ? "sem" : "";
  return `<span class="tag tag-${cls}">${esc(type.replace(/\.$/, "").replace(" зан", ""))}</span>`;
}

const lowerFirst = (t) => t.charAt(0).toLowerCase() + t.slice(1);

function lessonHTML(day, l, now, change = null) {
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
      <div class="lesson-title">${typeTag(l.type)}${esc(l.title)}</div>
      <div class="lesson-meta">
        ${room ? `<span>${room}</span>` : ""}
        ${who}
        ${l.subgroup ? `<span class="sub">подгр. ${esc(l.subgroup.split(".").slice(-2).join("."))}</span>` : ""}
      </div>
      ${change ? `<div class="chg-note ${change.kind === "cancelled" && !change.ghostText ? "gone" : ""}">${esc(change.ghostText || changeText(change))}</div>` : ""}
    </div>
  </div>`;
}

/** Пары дня вместе с изменениями: подсветка на месте и «призраки» отменённых. */
function dayLessonsHTML(day, now, changes) {
  const d = isoDate(day.date);
  const byAfter = new Map(changes.filter((c) => c.after && c.after.date === d).map((c) => [slotKey(d, c.after), c]));
  const rows = day.lessons.map((l) => [l.startMin, lessonHTML(day, l, now, byAfter.get(slotKey(d, l)))]);
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
  return semesterStats(state.skips, semesterOf(now).key, state.settings.limit);
}

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
    const list = unseen.flatMap(([, v]) => v.list);
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
        <span class="muted small">По заявлению: ${pluralHours(s.excused)}, в лимит не идут</span>
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
    sb.html = `<b>Расписание изменилось</b><span>${changes.length} ${changes.length === 1 ? "изменение" : changes.length < 5 ? "изменения" : "изменений"} на этой неделе — отмечены точками</span>`;
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
  $("#fav-row").html = `<button class="fav ${!v ? "active" : ""}" data-who="me">Моё</button>` +
    favs.map((f) => `<button class="fav ${v && favId(v) === f.id ? "active" : ""}" data-who="${esc(f.id)}">${esc(f.title)}</button>`).join("") +
    (v && !isFav(v) ? `<button class="fav active">${esc(v.title)}</button>` : "");
  const card = $("#who-card");
  card.classList.toggle("hidden", !v);
  if (!v) { card.html = ""; return; }
  const t = v.kind === "teacher" ? state.teachers.get(v.id) : null;
  const buttons = [
    `<button class="btn btn-sm ${isFav(v) ? "" : "btn-primary"}" data-fav>${isFav(v) ? "★ В избранном" : "☆ В избранное"}</button>`,
    t?.email ? `<button class="btn btn-sm" data-mail="${esc(t.email)}">✉ Написать</button>` : "",
    `<button class="btn btn-sm" data-windows>Общие окна</button>`,
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

$("#fav-row").addEventListener("click", (e) => {
  const b = e.target.closest("[data-who]");
  if (!b) return;
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
  input.placeholder = { student: "Логин, например Ivanov_II_25", group: "Группа, например ИСИТ-25", teacher: "Фамилия преподавателя" }[S.tab];
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
    if (q.length < 2) { body.html = `<p class="muted small">Начни вводить фамилию — например «Бурба».</p>`; return; }
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
  const who = state.windowsWith || favToWho(liveFavs()[0] || {}) ;
  const body = $("#win-body");
  const favs = liveFavs().filter((f) => f.kind !== "teacher");
  $("#win-pick").html = `<span class="who me">Ты</span><span class="plus">+</span>` +
    (favs.length || who?.id
      ? [...(who?.id && !favs.some((f) => f.id === favId(who)) ? [{ id: favId(who), title: who.title }] : []), ...favs]
        .map((f) => `<button class="who friend ${who?.id && f.id === favId(who) ? "on" : ""}" data-win="${esc(f.id)}">${esc(f.title)}</button>`).join("")
      : `<span class="muted small">Добавь кого-нибудь в избранное</span>`);
  if (!who?.id) { body.html = `<div class="empty">Открой расписание друга или группы и нажми «Общие окна».</div>`; return; }
  const monday = state.weekStart || currentMonday();
  $("#win-label").textContent = weekLabel(monday);
  if (!rawWeek(who, monday)) loadWeek(monday, who);
  const mine = weekDays(monday, null), theirs = weekDays(monday, who);
  const pct = (m) => `${Math.max(0, Math.min(100, ((m - 480) / 720) * 100))}%`;
  const w = (a, b) => `left:${pct(a)};width:calc(${pct(b)} - ${pct(a)})`;
  const rows = [], lines = [];
  for (let i = 0; i < 6; i++) {
    const r = freeWindows(mine[i], theirs[i]);
    const dayName = fmtDay(mine[i].date, { weekday: "short" });
    rows.push(`<div class="tl"><span>${dayName}</span><div class="bar">
      ${r.windows.map((x) => `<i class="both" style="${w(x.fromMin, x.toMin)}"></i>`).join("")}
      ${r.mine.map(([a, b]) => `<i class="me" style="${w(a, b)}"></i>`).join("")}
      ${r.theirs.map(([a, b]) => `<i class="fr" style="${w(a, b)}"></i>`).join("")}</div></div>`);
    if (r.allFree && i < 5) lines.push(`<div class="win"><b>${esc(fmtDay(mine[i].date, { weekday: "short", day: "numeric" }))} — весь день</b><span class="muted small">пар нет ни у кого</span></div>`);
    for (const x of r.windows) lines.push(`<div class="win"><b>${esc(fmtDay(mine[i].date, { weekday: "short", day: "numeric" }))} · ${x.from}–${x.to}</b><span class="muted small">оба свободны ${durationText(x.minutes)}${x.place ? ` · рядом: ${esc(x.place)}` : ""}</span></div>`);
  }
  const forecast = mine.some((d) => d.forecast) || theirs.some((d) => d.forecast);
  body.html = `<div class="legend"><span><i class="me"></i>ты занят</span><span><i class="fr"></i>${esc(who.title)} занят</span><span><i class="both"></i>оба свободны</span></div>
    <article class="card tl-card">${rows.join("")}<div class="tl-axis"><span>8:00</span><span>12:00</span><span>16:00</span><span>20:00</span></div></article>
    ${forecast ? `<div class="pre-note">Предварительно: часть недели — прогноз по текущей.</div>` : ""}
    <div class="card" style="padding:4px 18px">${lines.join("") || `<div class="empty">На этой неделе общих окон нет.</div>`}</div>`;
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
  if (t.lesson && !t.done) {
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
const WHEN = ["Следующей паре", "Через одну", "Через две"];
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
    keep: t?.lesson ? { ...t.lesson } : null,
    when: t?.lesson ? "keep" : t?.due ? "custom" : "first",
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
  const types = known && !dstate.custom ? [...known.types] : [];
  if (dstate.type && !types.includes(dstate.type)) dstate.type = null;
  if (!dstate.type && types.length === 1) dstate.type = types[0];
  $("#t-types-wrap").classList.toggle("hidden", types.length < 2);
  $("#t-types").html = types.map((ty) => `<button type="button" class="pchip ${ty === dstate.type ? "on" : ""}" data-type="${esc(ty)}">${esc(ty.replace(/\.$/, "").replace(" зан", ""))}</button>`).join("");

  // К какой паре сдавать.
  dstate.occ = known && !dstate.custom ? occurrences(plan, dstate.subject, dstate.type, now, 3) : [];
  const keepIdx = dstate.keep ? dstate.occ.findIndex((o) => o.date === dstate.keep.date && o.start === dstate.keep.start && o.title === dstate.keep.subject) : -1;
  if (dstate.when === "keep" && keepIdx >= 0) dstate.when = keepIdx;
  if (dstate.when === "first") dstate.when = dstate.occ.length ? 0 : "none";
  if (typeof dstate.when === "number" && dstate.when >= dstate.occ.length) dstate.when = dstate.occ.length ? 0 : "none";
  if (dstate.when === "keep" && (!dstate.keep || dstate.keep.subject !== dstate.subject)) dstate.when = dstate.occ.length ? 0 : "none";
  const optHTML = (key, title, line, note, pre) => `<button type="button" class="opt ${dstate.when === key ? "on" : ""}" data-when="${key}"><b>${title}</b>${line ? `<span>${line}</span>` : ""}${note ? `<em class="${pre ? "pre" : ""}">${note}</em>` : ""}</button>`;
  const fmtO = (o) => `${esc(fmtDay(parseIsoDate(o.date), { weekday: "short", day: "numeric", month: "short" }))} · ${esc(o.start)}${o.room ? ` · ауд. ${esc(o.room)}` : ""}`;
  $("#t-when").html = dstate.occ.map((o, i) => optHTML(i, WHEN[i], fmtO(o), o.forecast ? "предварительно" : esc(relativeDue(lessonDue(o), now)), o.forecast)).join("") +
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
  if (q("[data-subj]")) { Object.assign(dstate, { subject: q("[data-subj]").dataset.subj, custom: false, type: null, when: "first" }); }
  else if (q("[data-subj-more]")) dstate.showAll = true;
  else if (q("[data-subj-custom]")) { Object.assign(dstate, { custom: true, subject: $("#t-subject").value.trim(), type: null, when: dstate.when === "none" ? "none" : "custom" }); setTimeout(() => $("#t-subject").focus(), 0); }
  else if (q("[data-type]")) { const ty = q("[data-type]").dataset.type; dstate.type = dstate.type === ty ? null : ty; dstate.when = "first"; }
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
        </div>
      </div>
      <div class="stats">
        <div class="stat"><b>${s.left}</b><span>часов до лимита</span></div>
        <div class="stat"><b>${s.excused}</b><span>по заявлению</span></div>
        <div class="stat"><b>${s.worked}</b><span>отработано</span></div>
      </div>
    </div>`;

  const groups = groupBySemester(state.skips);
  $("#skips-list").html = groups.length
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
    : `<div class="empty">Пропусков нет — или данные ещё не загрузились.</div>`;

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
  state.otherRaw.clear(); state.viewing = null; state.favorites = []; state.changes = {};
  api.save("favorites", "[]"); api.save("sched_changes", "{}");
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
function studyTiles(now = new Date()) {
  const tiles = [];
  const courses = normalizeCourses(study("getCoursesData"));
  if (courses.length) {
    const prof = normalizeProfile(study("getChoosenCourses"));
    const sem = prof ? currentSemesterNumber(Number(prof.course) || 1, now) : null;
    const cur = courses.flatMap((k) => k.semesters).find((x) => x.semester === sem);
    tiles.push({ key: "courses", title: "Курсы", color: "lilac", icon: "layers", stat: cur ? `<b>${cur.items.length}</b><small>предметов в ${sem} семестре</small>` : `<small>материалы на платформе</small>` });
  }
  const prog = normalizeProgress(study("getProgress"));
  if (prog.length) {
    const last = progressBySemester(prog)[0];
    tiles.push({ key: "progress", title: "Успеваемость", color: "plum2", icon: "cap", stat: last.avg ? `<b data-count="${last.avg}" data-fmt="1" data-ck="avg">0</b><small>средний за ${last.label.split(" ")[0].toLowerCase()}</small>` : `<small>${prog.length} оценок</small>` });
  }
  if (gradebookHtml(study("getGradeBookMarkup"))) tiles.push({ key: "gradebook", title: "Зачётка", color: "rose", icon: "book", stat: "<small>электронная</small>" });
  const r = normalizeRating(study("getStatistics"));
  if (r) tiles.push({ key: "rating", title: "Рейтинг", color: "sky", icon: "chart", stat: `<b data-count="${r.score}" data-ck="score">0</b><small>баллов${r.letter ? ` · ${esc(r.letter)}` : ""}</small>` });
  const books = libraryBooks(now);
  if (books.length) {
    const soon = books.find((b) => b.daysLeft !== null);
    tiles.push({ key: "library", title: "Библиотека", color: "sage", icon: "shelf", stat: `<b>${books.length}</b><small>${pluralBooks(books.length).split(" ")[1]} на руках${soon ? ` · до ${soon.due.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}` : ""}</small>` });
  }
  const h = normalizeHostel(study("getHostel"));
  if (h) tiles.push({ key: "hostel", title: "Общежитие", color: "sand", icon: "home", stat: `<b>${esc(h.room)}</b><small>комната · ${h.debt > 0 ? `долг ${h.debt.toFixed(2)} р.` : "долгов нет"}</small>` });
  const orders = normalizeOrders(study("getStudentOrders"));
  if (orders.length) tiles.push({ key: "orders", title: "Приказы", color: "peach", icon: "doc", stat: `<b>${orders.length}</b><small>последний ${esc(orders[0].dateText)}</small>` });
  const groups = normalizeGroups(study("getGroups"));
  if (groups.length) tiles.push({ key: "group", title: "Группа", color: "plum", icon: "people", stat: `<b>${groups[0].members.length}</b><small>${esc(groups[0].name)}</small>` });
  return tiles;
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

  const tiles = studyTiles(now);
  $("#study-tiles").html = tiles.length
    ? tiles.map((t) => `<button class="tile tile-${t.color}" data-go-detail="${t.key}">
        <span class="tile-title">${t.title}</span>
        <span class="tile-ico ico ico-${t.icon}" aria-hidden="true"></span>
        <span class="tile-stat">${t.stat}</span>
      </button>`).join("")
    : `<div class="empty">Разделы появятся после первого обновления данных.</div>`;
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
  const titles = { courses: "Курсы", progress: "Успеваемость", gradebook: "Зачётка", rating: "Рейтинг", library: "Библиотека", hostel: "Общежитие", orders: "Приказы", group: "Группа" };
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
  } else if (key === "gradebook") {
    body.html = `<p class="muted small">Документ в том виде, в каком его отдаёт сайт.</p><iframe class="doc-frame" sandbox title="Зачётка"></iframe>`;
    const f = $(".doc-frame", body);
    f.srcdoc = `<!doctype html><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;margin:16px;color:#1b1722;background:#fbf9ff}</style>${gradebookHtml(study("getGradeBookMarkup"))}`;
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
    if (has) {
      msg.textContent = `Доступна версия ${u.latest}. ${u.notes ? u.notes.split("\n")[0].slice(0, 160) : ""}`;
      $("#update-install").textContent = "Обновить";
      if (!manual) toast(`Вышла версия ${u.latest} — обновить можно в настройках`);
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
  const last = Number(await api.load("update_checked")) || 0;
  if (Date.now() - last > 20 * 3600_000) setTimeout(() => checkUpdates(false), 4000);
}

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
