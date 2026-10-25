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

/** Сводка по семестру: сколько неуважительных часов идёт в лимит. */
export function semesterStats(skips, semesterKey, limit = DEFAULT_LIMIT) {
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
  const left = Math.max(0, limit - unexcused);
  const ratio = limit > 0 ? unexcused / limit : 0;
  const level = ratio >= 1 ? "over" : ratio >= 0.75 ? "danger" : ratio >= 0.5 ? "warn" : "ok";
  return { list, unexcused, excused, worked, limit, left, pairsLeft: Math.floor(left / 2), ratio, level };
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

export function normalizeSchedule(raw) {
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
          teacher: l.teacher?.fullname || "",
          teacherPost: l.teacher?.post || "",
          room: l.room || "",
          address: l.address || "",
          subgroup: l.subgroup?.id && l.subgroup.id !== "0" ? l.subgroup.title : "",
          label: l.label || "",
        }))
        .sort((a, b) => a.startMin - b.startMin),
    }))
    .filter((d) => !Number.isNaN(d.date.getTime()))
    .sort((a, b) => a.date - b.date);
}

/** Статус пары относительно момента now: past | now | next | later */
export function lessonStatus(day, lesson, now = new Date()) {
  if (!sameDay(day.date, now)) return day.date < now ? "past" : "later";
  const cur = now.getHours() * 60 + now.getMinutes();
  if (cur >= lesson.endMin) return "past";
  if (cur >= lesson.startMin) return "now";
  return "later";
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
