import {
  DEFAULT_LIMIT, normalizeSkips, semesterStats, semesterOf, groupBySemester, normalizeSchedule,
  lessonStatus, nextLesson, subjectsFrom, taskBucket, BUCKETS, sortTasks, relativeDue, sameDay,
  pluralHours, pluralPairs, lessonPhase, HALF, BREAK,
  normalizeTeachers, mondayOf, addDays, isoDate, buildWeek, weekLessons, forecastWeek, weekLabel,
} from "./logic.js";
import { demoBackend } from "./demo.js";
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
}
// Удалённые задачи остаются «надгробиями» (deleted: true), чтобы удаление доехало до другого устройства.
const liveTasks = () => state.tasks.filter((t) => !t.deleted);
const touch = (t) => { t.updated = Date.now(); return t; };
async function saveTasks() {
  await api.save("tasks", JSON.stringify(state.tasks));
  scheduleSync();
}
const saveSettings = () => api.save("settings", JSON.stringify(state.settings));

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

/** Дни недели: публичное расписание → кабинет → для следующей недели прогноз по текущей. */
function weekDays(monday, allowForecast = true) {
  const key = isoDate(monday);
  const pub = state.weekRaw.has(key) ? normalizeSchedule(state.weekRaw.get(key), state.teachers) : null;
  const cab = state.cabinetRaw ? normalizeSchedule(state.cabinetRaw, state.teachers) : null;
  const days = buildWeek(monday, pub, cab);
  if (allowForecast && weekLessons(days) === 0 && +monday === +addDays(currentMonday(), 7)) {
    const cur = weekDays(currentMonday(), false);
    if (weekLessons(cur) > 0) return forecastWeek(cur);
  }
  return days;
}

function rebuildDays() {
  const cur = currentMonday();
  state.days = [...weekDays(cur), ...weekDays(addDays(cur, 7))];
}

/** Неделю показываем сразу из сохранённого, а с сайта обновляем: свежие — всегда, старые — если ещё не скачаны. */
async function loadWeek(monday) {
  if (!api.fetchWeek) return;
  const key = isoDate(monday);
  if (!state.weekRaw.has(key)) {
    const raw = await api.cachedWeek(key);
    if (raw) try { state.weekRaw.set(key, JSON.parse(raw)); renderWeekChange(); } catch {}
  }
  const recent = monday >= addDays(currentMonday(), -7);
  if (state.weekFetched.has(key) || (!recent && state.weekRaw.has(key))) return;
  state.weekFetched.add(key);
  state.weekLoading = key;
  if (+monday === +state.weekStart) renderSchedule();
  try {
    state.weekRaw.set(key, JSON.parse(await api.fetchWeek(key, isoDate(addDays(monday, 6)))));
  } catch {
    state.weekFetched.delete(key); // нет сети — попробуем в следующий раз
  } finally {
    if (state.weekLoading === key) state.weekLoading = null;
    renderWeekChange();
  }
}

function renderWeekChange() {
  rebuildDays();
  renderSchedule();
  renderToday();
}

async function refreshWeeks() {
  if (!api.fetchTeachers) return;
  try { state.teachers = normalizeTeachers(JSON.parse(await api.fetchTeachers())); } catch {}
  state.weekFetched.clear();
  const cur = currentMonday();
  await Promise.all([cur, addDays(cur, 7)].map(loadWeek));
  if (state.weekStart && ![+cur, +addDays(cur, 7)].includes(+state.weekStart)) loadWeek(state.weekStart);
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
  const apply = () => {
    state.view = view;
    const navView = view === "detail" ? "study" : view;
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === navView));
    $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === view));
    if (view === "detail") renderDetail();
    if (view === "schedule" && state.weekStart && +state.weekStart !== +currentMonday()) openWeek(currentMonday());
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

function lessonHTML(day, l, now) {
  const st = lessonStatus(day, l, now);
  return `<div class="lesson ${st} ${l.forecast ? "forecast" : ""}">
    <div class="lesson-time">${esc(l.start)}<span>${esc(l.end)}</span></div>
    <div>
      <div class="lesson-title">${typeTag(l.type)}${esc(l.title)}</div>
      <div class="lesson-meta">
        ${l.room ? `<span>ауд. ${esc(l.room)}${l.address ? `, ${esc(l.address)}` : ""}</span>` : ""}
        ${l.teacher ? `<span>${esc(l.teacher)}${l.teacherPost ? `<em class="post">, ${esc(l.teacherPost.charAt(0).toLowerCase() + l.teacherPost.slice(1))}</em>` : ""}</span>` : ""}
        ${l.subgroup ? `<span class="sub">подгр. ${esc(l.subgroup.split(".").slice(-2).join("."))}</span>` : ""}
      </div>
    </div>
  </div>`;
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
    </button>`).join("");
  const day = shown.find((d) => +d.date === state.selectedDay);
  const loading = state.weekLoading === isoDate(monday) && !weekLessons(days);
  $("#day-lessons").html = loading
    ? `<div class="empty">Загружаю неделю…</div>`
    : (day.forecast ? `<div class="pre-note">Предварительно: сайт ещё не выложил эту неделю, показана копия текущей.</div>` : "") +
      (day.lessons.length ? day.lessons.map((l) => lessonHTML(day, l, now)).join("") : `<div class="empty">В этот день пар нет.</div>`);
}

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

// ---------- рендер: задачи ----------

const KIND = { lab: "Лаба", hw: "Домашка", course: "Курсовой", test: "Контрольная", exam: "Экзамен", other: "" };

function taskHTML(t, now) {
  const b = taskBucket(t, now);
  const sub = [KIND[t.kind], t.subject].filter(Boolean).join(" · ");
  return `<div class="task ${b}" data-task="${esc(t.id)}">
    <button class="check ${t.done ? "on" : ""}" data-toggle="${esc(t.id)}" aria-label="${t.done ? "Вернуть в работу" : "Отметить сделанной"}"></button>
    <div><div class="task-title">${esc(t.title)}</div>${sub ? `<div class="task-sub">${esc(sub)}</div>` : ""}</div>
    <div class="task-due">${t.done ? "" : esc(relativeDue(t.due, now))}</div>
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
  const dueVal = $("#quick-due").value;
  state.tasks.push({ id: crypto.randomUUID(), title, subject: guessSubject(title), kind: guessKind(title), due: dueVal ? new Date(dueVal).toISOString() : null, notes: "", done: false, created: Date.now(), updated: Date.now() });
  saveTasks();
  $("#quick-title").value = "";
  $("#quick-due").value = "";
  renderAll();
});

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

function openTask(id) {
  state.editingId = id;
  const t = id ? state.tasks.find((x) => x.id === id) : null;
  $("#task-dialog-title").textContent = t ? "Задача" : "Новая задача";
  $("#t-title").value = t?.title || "";
  $("#t-subject").value = t?.subject || "";
  $("#t-kind").value = t?.kind || "lab";
  $("#t-due").value = toLocalInput(t?.due);
  $("#t-notes").value = t?.notes || "";
  $("#t-delete").classList.toggle("hidden", !t);
  $("#subjects").html = subjectsFrom(state.days).map((s) => `<option value="${esc(s)}">`).join("");
  dlg.showModal();
  $("#t-title").focus();
}

$("#task-add-btn").addEventListener("click", () => openTask(null));
$("#t-cancel").addEventListener("click", () => dlg.close());
$("#task-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const title = $("#t-title").value.trim();
  if (!title) return;
  const data = {
    title,
    subject: $("#t-subject").value.trim(),
    kind: $("#t-kind").value,
    due: $("#t-due").value ? new Date($("#t-due").value).toISOString() : null,
    notes: $("#t-notes").value.trim(),
  };
  const t = state.tasks.find((x) => x.id === state.editingId);
  if (t) touch(Object.assign(t, data));
  else state.tasks.push({ id: crypto.randomUUID(), ...data, done: false, created: Date.now(), updated: Date.now() });
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
      renderAll();
      toast("Задачи обновлены с телефона");
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
