// Логика поверх расписаний: каталог групп, изменения, общие окна, «где препод», пары для задач.
// Всё чистые функции — их проверяют тесты.

import { sameDay, addDays, isoDate, mondayOf, parseIsoDate } from "./logic.js";

const hhmm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
/** «пн 13:30» */
export const slotLabel = (date, start) => `${WD[(typeof date === "string" ? parseIsoDate(date) : date).getDay()]} ${start}`;

// ---------- группы ----------

/** «СДП-ЭУ-241» → { spec: "ЭУ", code: "241", year: 2024, prefix: "СДП" }. */
export function parseGroupTitle(title) {
  const parts = String(title || "").trim().split("-");
  const code = parts.length >= 2 ? parts[parts.length - 1] : "";
  const m = /^(\d{2})(\d*)/.exec(code);
  return {
    title: String(title || "").trim(),
    prefix: parts.length >= 3 ? parts[0] : "",
    spec: parts.length >= 3 ? parts.slice(1, -1).join("-") : parts[0] || "",
    code,
    year: m ? 2000 + Number(m[1]) : null,
  };
}

/** Короткое имя для чипов: «ЭУ-241». */
export const shortGroup = (title) => {
  const g = parseGroupTitle(title);
  return g.spec && g.code ? `${g.spec}-${g.code}` : g.title;
};

/**
 * Каталог факультета: specialties → курсы → группы.
 * byCourse: { 1: [{id,title}], 2: [...] } → [{ spec, courses: [{ course, year, groups: [{id,title,code,label}] }] }]
 */
export function groupCatalog(byCourse) {
  const specs = new Map();
  for (const [course, groups] of Object.entries(byCourse)) {
    for (const g of groups || []) {
      const p = parseGroupTitle(g.title);
      if (!p.spec) continue;
      if (!specs.has(p.spec)) specs.set(p.spec, new Map());
      const courses = specs.get(p.spec);
      if (!courses.has(course)) courses.set(course, []);
      courses.get(course).push({ id: String(g.id), title: p.title, code: p.code, prefix: p.prefix, year: p.year });
    }
  }
  return [...specs.entries()]
    .map(([spec, courses]) => ({
      spec,
      courses: [...courses.entries()]
        .map(([course, groups]) => {
          groups.sort((a, b) => a.title.localeCompare(b.title, "ru"));
          // Если у одной специальности несколько форм (СДП/МДП) — показываем полное имя, иначе только номер.
          const dup = new Set(groups.map((g) => g.code)).size < groups.length;
          return {
            course: Number(course),
            year: groups.find((g) => g.year)?.year ?? null,
            groups: groups.map((g) => ({ ...g, label: dup ? `${g.prefix}-${g.code}` : g.code })),
          };
        })
        .sort((a, b) => a.course - b.course),
    }))
    .sort((a, b) => a.spec.localeCompare(b.spec, "ru"));
}

// ---------- изменения в расписании (A) ----------

const flat = (days) =>
  days.flatMap((d) => d.lessons.filter((l) => !l.forecast).map((l) => ({ ...l, date: isoDate(d.date) })));
const ident = (l) => `${l.title}|${l.type}|${l.subgroup}`;
const at = (l) => new Date(`${l.date}T${l.start.padStart(5, "0")}`);

/**
 * Что поменялось между сохранённой и новой версией недели (только будущие пары).
 * → [{ kind: "moved" | "room" | "cancelled" | "added", before?, after?, title, type }]
 * Пустой новый ответ сравнивать не с чем (сбой сайта или каникулы) — изменений нет.
 */
export function diffWeeks(oldDays, newDays, now = new Date()) {
  const future = (l) => at(l) > now || l.date === isoDate(now);
  const o = flat(oldDays).filter(future);
  const n = flat(newDays).filter(future);
  if (!n.length || !o.length) return [];
  const changes = [];
  const restO = [], usedN = new Set();
  for (const a of o) {
    const i = n.findIndex((b, j) => !usedN.has(j) && ident(b) === ident(a) && b.date === a.date && b.start === a.start);
    if (i < 0) { restO.push(a); continue; }
    usedN.add(i);
    const b = n[i];
    if (b.room !== a.room || b.address !== a.address) changes.push({ kind: "room", before: a, after: b, title: a.title, type: a.type });
  }
  const restN = n.map((b, j) => [b, j]).filter(([, j]) => !usedN.has(j));
  for (const a of restO) {
    const cands = restN.filter(([b, j]) => !usedN.has(j) && ident(b) === ident(a));
    cands.sort(([x], [y]) => Math.abs(at(x) - at(a)) - Math.abs(at(y) - at(a)));
    if (cands.length) {
      usedN.add(cands[0][1]);
      changes.push({ kind: "moved", before: a, after: cands[0][0], title: a.title, type: a.type });
    } else {
      changes.push({ kind: "cancelled", before: a, title: a.title, type: a.type });
    }
  }
  for (const [b, j] of restN) if (!usedN.has(j)) changes.push({ kind: "added", after: b, title: b.title, type: b.type });
  return changes;
}

/** Ключ пары в расписании, чтобы подсветить изменение на месте. */
export const slotKey = (date, l) => `${typeof date === "string" ? date : isoDate(date)}|${l.start}|${l.title}`;

/** Текст изменения для подсветки и плашки. */
export function changeText(c) {
  if (c.kind === "room") return `Аудитория: ${c.before.room || "—"} → ${c.after.room || "—"}`;
  if (c.kind === "moved") return `Перенесли: было ${slotLabel(c.before.date, c.before.start)} → стало ${slotLabel(c.after.date, c.after.start)}`;
  if (c.kind === "cancelled") return "Пару отменили";
  return "Новая пара";
}

// ---------- общие окна (C) ----------

/**
 * День двоих: когда каждый заканчивает и с какого времени свободны оба (главное),
 * плюс окна посреди дня — только пока оба уже на парах (до пар окна не считаем).
 * → { none } | { only: "me" | "them", end } | { myEnd, theirEnd, together, wait, later: "me" | "them" | "both", windows: [...] }
 */
export function dayTogether(myDay, theirDay, minMinutes = 30) {
  const busy = (d) => (d?.lessons || []).filter((l) => !l.cancelled).map((l) => [l.startMin, l.endMin, l]);
  const mine = busy(myDay), theirs = busy(theirDay);
  if (!mine.length && !theirs.length) return { none: true };
  const last = (list) => Math.max(...list.map((x) => x[1]));
  const first = (list) => Math.min(...list.map((x) => x[0]));
  if (!mine.length) return { only: "them", end: hhmm(last(theirs)) };
  if (!theirs.length) return { only: "me", end: hhmm(last(mine)) };
  const myEnd = last(mine), theirEnd = last(theirs);
  const together = Math.max(myEnd, theirEnd);
  // Окна посреди дня: от момента, когда оба уже пришли, до момента, когда кто-то закончил.
  const from = Math.max(first(mine), first(theirs)), to = Math.min(myEnd, theirEnd);
  const all = [...mine, ...theirs].sort((a, b) => a[0] - b[0]);
  const windows = [];
  let end = -1;
  for (const [s, e] of all) {
    const a = Math.max(end, from), b = Math.min(s, to);
    if (end >= 0 && b - a >= minMinutes) {
      const before = (list) => list.filter(([, e2]) => e2 <= b).sort((x, y) => y[1] - x[1])[0]?.[2];
      const pm = before(mine), pt = before(theirs);
      windows.push({ from: hhmm(a), to: hhmm(b), minutes: b - a, place: pm && pt && pm.address && pm.address === pt.address ? pm.address : "" });
    }
    end = Math.max(end, e);
  }
  return {
    myEnd: hhmm(myEnd), theirEnd: hhmm(theirEnd), together: hhmm(together), wait: Math.abs(myEnd - theirEnd),
    later: myEnd === theirEnd ? "both" : myEnd > theirEnd ? "me" : "them", windows,
  };
}

export const durationText = (min) => (min >= 60 ? `${Math.floor(min / 60)} ч${min % 60 ? ` ${min % 60} мин` : ""}` : `${min} мин`);

// ---------- где сейчас преподаватель (B) ----------

/** Текущая и следующая пара по расписанию человека. */
export function whereNow(days, now = new Date()) {
  const cur = now.getHours() * 60 + now.getMinutes();
  let current = null, next = null;
  for (const d of [...days].sort((a, b) => a.date - b.date)) {
    if (d.date < new Date(now.getFullYear(), now.getMonth(), now.getDate())) continue;
    const today = sameDay(d.date, now);
    for (const l of d.lessons) {
      if (today && l.startMin <= cur && cur < l.endMin) current = { ...l, date: d.date };
      else if (!next && (!today || l.startMin > cur)) next = { ...l, date: d.date };
    }
    if (next) break;
  }
  return { current, next };
}

// ---------- пары для задач ----------

/** Предметы с видами пар, в порядке ближайшей пары. */
export function subjectsWithTypes(days, now = new Date()) {
  const map = new Map();
  for (const l of flat(days.map((d) => ({ ...d, lessons: d.lessons.map((x) => ({ ...x, forecast: false })) })))) {
    if (!l.title) continue;
    const t = at(l);
    const e = map.get(l.title) || { subject: l.title, types: new Set(), next: Infinity };
    e.types.add(l.type);
    if (t > now && t < e.next) e.next = t;
    map.set(l.title, e);
  }
  return [...map.values()].sort((a, b) => a.next - b.next || a.subject.localeCompare(b.subject, "ru"));
}

/** Ближайшие n пар предмета (и вида, если задан) после момента from. */
export function occurrences(days, subject, type, from = new Date(), n = 3) {
  return days
    .flatMap((d) => d.lessons.map((l) => ({ ...l, date: isoDate(d.date), forecast: !!(l.forecast || d.forecast) })))
    .filter((l) => l.title === subject && (!type || l.type === type) && at(l) > from)
    .sort((a, b) => at(a) - at(b))
    .slice(0, n);
}

export const lessonDue = (l) => at(l).toISOString();

/**
 * Пару, к которой привязана задача, перенесли или отменили → переносим срок.
 * Сверяемся только с настоящим расписанием недели (не с прогнозом), иначе срок прыгал бы зря.
 * realWeeks: Set ключей понедельников, по которым есть настоящее расписание.
 * Возвращает список изменённых задач (их нужно сохранить).
 */
export function relinkTasks(tasks, days, changes, realWeeks, now = new Date()) {
  const changed = [];
  const all = days.flatMap((d) => d.lessons.map((l) => ({ ...l, date: isoDate(d.date), forecast: !!(l.forecast || d.forecast) })));
  for (const t of tasks) {
    const k = t.lesson;
    if (!k || t.done || t.deleted) continue;
    if (new Date(`${k.date}T${k.start.padStart(5, "0")}`) < addDays(now, -1)) continue;
    if (!realWeeks.has(isoDate(mondayOf(parseIsoDate(k.date))))) continue;
    const same = (l) => l.title === k.subject && (!k.type || l.type === k.type);
    if (all.some((l) => same(l) && l.date === k.date && l.start === k.start)) continue;
    const moved = changes.find((c) => c.kind === "moved" && c.before.date === k.date && c.before.start === k.start && c.title === k.subject);
    const target = moved?.after || all.filter((l) => same(l) && l.date >= k.date).sort((a, b) => at(a) - at(b))[0];
    if (!target) continue;
    t.moved = { from: slotLabel(k.date, k.start), to: slotLabel(target.date, target.start), cancelled: !moved };
    t.lesson = { ...k, date: target.date, start: target.start };
    t.due = lessonDue(target);
    t.updated = Date.now();
    changed.push(t);
  }
  return changed;
}
