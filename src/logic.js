// Чистая логика без DOM — считается одинаково в приложении и в тестах.

export const DEFAULT_LIMIT = 36;

/** "12.10.2026" -> Date (локальная полночь) */
export function parseRuDate(s) {
  const [d, m, y] = String(s).split(".").map(Number);
  return new Date(y, m - 1, d);
}

/** "2026-10-19" -> Date (локальная полночь, без сдвига часового пояса) */
export function parseIsoDate(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Семестр по дате: осенний — сентябрь…январь, весенний — февраль…август.
 * key сортируется как строка по времени: "2026-1" весна 2026, "2026-2" осень 2026/27.
 */
export function semesterOf(date) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  if (m >= 9) return { key: `${y}-2`, label: `Осенний семестр ${y}/${String(y + 1).slice(2)}` };
  if (m === 1) return { key: `${y - 1}-2`, label: `Осенний семестр ${y - 1}/${String(y).slice(2)}` };
  return { key: `${y}-1`, label: `Весенний семестр ${y - 1}/${String(y).slice(2)}` };
}

/** Прогул (или пустая причина) — неуважительно, всё остальное (заявление, справка…) — уважительно. */
export function isUnexcused(reason) {
  const r = String(reason || "").trim().toLowerCase();
  return r === "" || r.includes("прогул");
}

/** Приводит ответ getSkips к удобному виду. */
export function normalizeSkips(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      const date = parseRuDate(r.NDATA);
      const hours = Number(r.KOLVO) || 0;
      const worked = Number(String(r.KOLO || "").replace(",", ".")) || 0;
      return {
        id: String(r.KATTENDANCE ?? `${r.NDATA}-${r.KOLVO}`),
        date,
        hours,
        worked,
        reason: String(r.NPRICH || "").trim(),
        unexcused: isUnexcused(r.NPRICH),
        semester: semesterOf(date),
      };
    })
    .filter((s) => !Number.isNaN(s.date.getTime()))
    .sort((a, b) => b.date - a.date);
}

/**
 * Свои записи о пропусках, которых ещё нет на портале.
 * Портал знает только часы за день, а не пары. Поэтому, когда за день записи на портале появляются часы,
 * запись не исчезает молча: помечаем её ask («на портале N ч за этот день — это она?») и перестаём считать,
 * чтобы не задвоить. Ответ «нет, это другая пара» запоминается в other (сколько часов было на портале) —
 * тогда запись снова считается, а спросим ещё раз, только если часов на портале прибавится.
 * marks: [{ id, date: "YYYY-MM-DD", start, subject, excused?, other?, deleted? }]
 * → те же записи по порядку с полями ask и portal (часы на портале за день)
 */
export function pendingSkips(marks, skips) {
  const portal = new Map();
  for (const s of skips) {
    const k = isoDate(s.date);
    portal.set(k, (portal.get(k) || 0) + s.hours);
  }
  const at = (m) => m.date + m.start.padStart(5, "0");
  const pool = new Map();
  return [...marks].filter((m) => !m.deleted).sort((a, b) => at(a).localeCompare(at(b))).map((m) => {
    const hours = portal.get(m.date) || 0;
    const left = pool.has(m.date) ? pool.get(m.date) : Math.floor(hours / 2);
    const ask = left > 0 && (m.other || 0) < hours;
    pool.set(m.date, ask ? left - 1 : left);
    return { ...m, ask, portal: hours };
  });
}

/** Сводка по семестру: сколько неуважительных часов идёт в лимит (вместе с ещё не внесёнными). */
export function semesterStats(skips, semesterKey, limit = DEFAULT_LIMIT, pending = []) {
  const list = skips.filter((s) => s.semester.key === semesterKey);
  let unexcused = 0;
  let excused = 0;
  let worked = 0;
  for (const s of list) {
    if (s.unexcused) {
      const counted = Math.max(0, s.hours - s.worked);
      unexcused += counted;
      worked += Math.min(s.worked, s.hours);
    } else {
      excused += s.hours;
    }
  }
  const pend = pending.filter((p) => semesterOf(new Date(`${p.date}T12:00`)).key === semesterKey);
  const counted = pend.filter((p) => !p.ask); // под вопросом — не считаем, чтобы не задвоить с порталом
  const pendingHours = counted.filter((p) => !p.excused).length * 2;
  unexcused += pendingHours;
  excused += counted.filter((p) => p.excused).length * 2;
  const left = Math.max(0, limit - unexcused);
  const ratio = limit > 0 ? unexcused / limit : 0;
  const level = ratio >= 1 ? "over" : ratio >= 0.75 ? "danger" : ratio >= 0.5 ? "warn" : "ok";
  return { list, unexcused, excused, worked, limit, left, pairsLeft: Math.floor(left / 2), ratio, level, pending: pend, pendingHours };
}

const MONTH_IN = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре"];

/**
 * Сводка посещаемости для экрана: часы без уважительной причины за семестр и за текущий месяц
 * и ориентиры, которые студент задал сам (официальных цифр в кабинете нет; у кого-то это 36 ч за семестр,
 * у кого-то 20 ч в месяц). Ориентир 0 или пустой — не задан.
 * main — тот ориентир, к которому ближе всего (по доле), или null.
 */
export function attendanceSummary({ skips, pending = [], now = new Date(), semesterLimit = 0, monthLimit = 0 }) {
  const sem = semesterStats(skips, semesterOf(now).key, semesterLimit || 0, pending);
  const inMonth = (d) => d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  let monthUnexcused = 0, monthExcused = 0;
  for (const s of skips) {
    if (!inMonth(s.date)) continue;
    if (s.unexcused) monthUnexcused += Math.max(0, s.hours - s.worked);
    else monthExcused += s.hours;
  }
  for (const p of pending) {
    if (p.ask || !inMonth(new Date(`${p.date}T12:00`))) continue;
    if (p.excused) monthExcused += 2; else monthUnexcused += 2;
  }
  const gauge = (kind, used, limit) => (limit > 0 ? { kind, used, limit, ratio: used / limit } : null);
  const gauges = [gauge("month", monthUnexcused, monthLimit), gauge("semester", sem.unexcused, semesterLimit)].filter(Boolean);
  const main = gauges.sort((a, b) => b.ratio - a.ratio)[0] || null;
  const level = !main ? "ok" : main.ratio >= 1 ? "over" : main.ratio >= 0.75 ? "near" : "ok";
  return {
    semester: sem, monthName: MONTH_IN[now.getMonth()],
    month: { unexcused: monthUnexcused, excused: monthExcused, limit: monthLimit || 0 },
    main, level,
  };
}

/** Группирует пропуски по семестрам, новые сверху. */
export function groupBySemester(skips) {
  const map = new Map();
  for (const s of skips) {
    if (!map.has(s.semester.key)) map.set(s.semester.key, { ...s.semester, items: [] });
    map.get(s.semester.key).items.push(s);
  }
  return [...map.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
}

// ---------- расписание ----------

function minutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

/** Преподаватели из публичного API ГрГУ: id → { name: «Фамилия Имя Отчество», post }. */
export function normalizeTeachers(raw) {
  const map = new Map();
  for (const t of Array.isArray(raw?.items) ? raw.items : []) {
    const name = [t.surname, t.name, t.patronym].map((x) => String(x || "").trim()).filter(Boolean).join(" ");
    if (t.id && name) map.set(String(t.id), { id: String(t.id), name, post: String(t.post || "").trim(), email: String(t.email || "").trim() });
  }
  return map;
}

export function normalizeSchedule(raw, teachers = new Map()) {
  const days = Array.isArray(raw?.days) ? raw.days : [];
  return days
    .map((d) => ({
      date: parseIsoDate(d.date),
      lessons: (Array.isArray(d.lessons) ? d.lessons : [])
        .map((l) => ({
          start: l.timeStart,
          end: l.timeEnd,
          startMin: minutes(l.timeStart),
          endMin: minutes(l.timeEnd),
          title: String(l.title || "").trim(),
          type: String(l.type || "").trim(),
          // Полное ФИО из справочника, если нашли преподавателя по id; иначе как прислал сайт.
          teacher: teachers.get(String(l.teacher?.id ?? ""))?.name || l.teacher?.fullname || "",
          teacherPost: l.teacher?.post || teachers.get(String(l.teacher?.id ?? ""))?.post || "",
          room: l.room || "",
          address: l.address || "",
          subgroup: l.subgroup?.id && l.subgroup.id !== "0" ? l.subgroup.title : "",
          teacherId: String(l.teacher?.id ?? ""),
          // У расписания преподавателя вместо препода — группы.
          groups: (Array.isArray(l.groups) ? l.groups : []).map((g) => String(g.title || "")).filter(Boolean),
          label: l.label || "",
        }))
        .sort((a, b) => a.startMin - b.startMin),
    }))
    .filter((d) => !Number.isNaN(d.date.getTime()))
    .sort((a, b) => a.date - b.date);
}

// ---------- недели ----------

export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** Понедельник недели, в которую попадает дата. */
export const mondayOf = (d) => addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -((d.getDay() + 6) % 7));
export const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Ровно 7 дней недели с понедельника. Пары берутся из первого источника, где этот день есть:
 * так публичное расписание дополняется данными из кабинета, а пустые дни становятся выходными.
 */
export function buildWeek(monday, ...sources) {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(monday, i);
    for (const src of sources) {
      const hit = (src || []).find((d) => sameDay(d.date, date));
      if (hit) return { ...hit, date };
    }
    return { date, lessons: [] };
  });
}

export const weekLessons = (week) => week.reduce((n, d) => n + d.lessons.length, 0);

/** Прогноз: та же неделя, что и образец, сдвинутая на 7 дней, с пометкой «предварительно». */
export function forecastWeek(sample, weeks = 1) {
  return sample.map((d) => ({
    date: addDays(d.date, 7 * weeks),
    forecast: true,
    lessons: d.lessons.map((l) => ({ ...l, forecast: true })),
  }));
}

/** Подпись недели: «26 окт – 1 нояб». */
export function weekLabel(monday) {
  const sun = addDays(monday, 6);
  const f = (d, o) => d.toLocaleDateString("ru-RU", o).replace(".", "");
  return monday.getMonth() === sun.getMonth()
    ? `${monday.getDate()}–${f(sun, { day: "numeric", month: "short" })}`
    : `${f(monday, { day: "numeric", month: "short" })} – ${f(sun, { day: "numeric", month: "short" })}`;
}

/** Статус пары относительно момента now: past | now | next | later */
export function lessonStatus(day, lesson, now = new Date()) {
  if (!sameDay(day.date, now)) return day.date < now ? "past" : "later";
  const cur = now.getHours() * 60 + now.getMinutes();
  if (cur >= lesson.endMin) return "past";
  if (cur >= lesson.startMin) return "now";
  return "later";
}

/** Пара в ГрГУ — две половины по 40 минут с перерывом 5 минут (всего 85). */
export const HALF = 40;
export const BREAK = 5;

/**
 * Где мы внутри идущей пары: первая половина, перерыв или вторая.
 * Для пар нестандартной длины половин нет — просто до конца.
 * Возвращает { phase: "first" | "break" | "second" | "whole", left } — минут до смены фазы.
 */
export function lessonPhase(lesson, cur) {
  const { startMin: s, endMin: e } = lesson;
  if (e - s !== HALF * 2 + BREAK) return { phase: "whole", left: e - cur };
  if (cur < s + HALF) return { phase: "first", left: s + HALF - cur };
  if (cur < s + HALF + BREAK) return { phase: "break", left: s + HALF + BREAK - cur };
  return { phase: "second", left: e - cur };
}

/** Текущая или ближайшая пара во всём расписании. */
export function nextLesson(days, now = new Date()) {
  const cur = now.getHours() * 60 + now.getMinutes();
  for (const d of days) {
    const today = sameDay(d.date, now);
    if (!today && d.date < now) continue;
    for (const l of d.lessons) {
      if (today && cur >= l.endMin) continue;
      return { day: d, lesson: l, isNow: today && cur >= l.startMin };
    }
  }
  return null;
}

/** Уникальные названия предметов — для подсказок в задачах. */
export function subjectsFrom(days) {
  const set = new Set();
  for (const d of days) for (const l of d.lessons) if (l.title && !/час$/i.test(l.title)) set.add(l.title);
  return [...set].sort((a, b) => a.localeCompare(b, "ru"));
}

// ---------- задачи ----------

export function taskBucket(task, now = new Date()) {
  if (task.done) return "done";
  if (!task.due) return "nodate";
  const due = new Date(task.due);
  if (due < now) return "overdue";
  const diffH = (due - now) / 36e5;
  if (sameDay(due, now) || diffH < 24) return "today";
  if (diffH < 24 * 7) return "week";
  return "later";
}

export const BUCKETS = [
  ["overdue", "Просрочено"],
  ["today", "Сегодня и завтра"],
  ["week", "На неделе"],
  ["later", "Позже"],
  ["nodate", "Без срока"],
  ["done", "Сделано"],
];

export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (!a.due && !b.due) return a.created - b.created;
    if (!a.due) return 1;
    if (!b.due) return -1;
    return new Date(a.due) - new Date(b.due);
  });
}

/**
 * Напоминания о задачах: накануне срока в заданный час, одно уведомление на день.
 * Берём несделанные задачи со сроком в ближайшие две недели; если «накануне» уже прошло — не напоминаем.
 * → [{ id, at: Date, title, body }] — id целый (ГГГГММДД дня срока), чтобы уведомление можно было заменить или отменить
 */
export function taskReminders(tasks, now = new Date(), hour = 19) {
  const byDay = new Map();
  for (const t of tasks) {
    if (t.done || t.deleted || !t.due) continue;
    const due = new Date(t.due);
    if (Number.isNaN(+due)) continue;
    const day = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1, hour, 0, 0);
    if (at <= now || at - now > 14 * 864e5) continue;
    const k = isoDate(day);
    if (!byDay.has(k)) byDay.set(k, { day, at, tasks: [] });
    byDay.get(k).tasks.push({ t, due });
  }
  return [...byDay.values()].sort((a, b) => a.at - b.at).map(({ day, at, tasks: list }) => {
    list.sort((a, b) => a.due - b.due);
    const time = (d) => d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    const n = list.length;
    const one = list[0];
    return {
      id: day.getFullYear() * 10000 + (day.getMonth() + 1) * 100 + day.getDate(),
      at,
      title: n === 1 ? `Завтра сдавать: ${one.t.title}` : `Завтра сдавать: ${n} ${n < 5 ? "задачи" : "задач"}`,
      body: n === 1
        ? `К ${time(one.due)}${one.t.subject ? ` · ${one.t.subject}` : ""}`
        : list.slice(0, 5).map(({ t, due }) => `${time(due)} · ${t.subject ? `${t.subject}: ` : ""}${t.title}`).join("\n") + (n > 5 ? `\nи ещё ${n - 5}` : ""),
    };
  });
}

/** "через 3 ч", "завтра 18:00", "просрочено на 2 дн." */
export function relativeDue(iso, now = new Date()) {
  if (!iso) return "без срока";
  const due = new Date(iso);
  const diffMin = Math.round((due - now) / 6e4);
  const time = due.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (diffMin < 0) {
    const ago = -diffMin;
    if (ago < 60) return `просрочено на ${ago} мин`;
    if (ago < 60 * 24) return `просрочено на ${Math.round(ago / 60)} ч`;
    return `просрочено на ${Math.round(ago / 1440)} дн.`;
  }
  if (diffMin < 60) return `через ${diffMin} мин`;
  if (sameDay(due, now)) return `сегодня ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(due, tomorrow)) return `завтра ${time}`;
  const days = Math.ceil(diffMin / 1440);
  if (days < 7) return `через ${days} дн. · ${due.toLocaleDateString("ru-RU", { weekday: "short" })} ${time}`;
  return due.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) + ` ${time}`;
}

export function pluralHours(n) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return `${n} часов`;
  if (b === 1) return `${n} час`;
  if (b >= 2 && b <= 4) return `${n} часа`;
  return `${n} часов`;
}

export function pluralPairs(n) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return `${n} пар`;
  if (b === 1) return `${n} пара`;
  if (b >= 2 && b <= 4) return `${n} пары`;
  return `${n} пар`;
}
