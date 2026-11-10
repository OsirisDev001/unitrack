// node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSkips, semesterStats, pendingSkips, taskReminders, attendanceSummary, semesterOf, normalizeSchedule, nextLesson, taskBucket, pluralPairs,
} from "../src/logic.js";

const P = "прогул";
const D = "заявление на имя декана";
const raw = [
  ["12.10.2026", 2, P], ["05.10.2026", 2, P], ["01.10.2026", 2, P], ["30.09.2026", 2, P],
  ["24.09.2026", 2, P], ["23.09.2026", 6, P], ["22.09.2026", 2, P], ["18.09.2026", 6, D],
  ["17.09.2026", 6, D], ["16.09.2026", 6, D], ["15.09.2026", 8, D], ["14.09.2026", 4, D],
  ["10.09.2026", 2, P], ["22.05.2026", 6, D], ["12.05.2026", 2, P],
].map(([NDATA, KOLVO, NPRICH], i) => ({ KATTENDANCE: String(i), NDATA, KOLVO: String(KOLVO), NPRICH, KOLO: "" }));

test("осенний семестр 2026: 20 из 36 неуважительных", () => {
  const skips = normalizeSkips(raw);
  const key = semesterOf(new Date(2026, 9, 25)).key;
  const s = semesterStats(skips, key, 36);
  assert.equal(s.unexcused, 20);
  assert.equal(s.excused, 30);
  assert.equal(s.left, 16);
  assert.equal(s.pairsLeft, 8);
  assert.equal(s.level, "warn");
});

test("весенние пропуски не попадают в осень", () => {
  const skips = normalizeSkips(raw);
  const spring = semesterStats(skips, semesterOf(new Date(2026, 4, 1)).key, 36);
  assert.equal(spring.unexcused, 2);
  assert.equal(spring.excused, 6);
});

test("отработанные часы вычитаются", () => {
  const skips = normalizeSkips([{ KATTENDANCE: "1", NDATA: "01.10.2026", KOLVO: "4", NPRICH: P, KOLO: "2" }]);
  const s = semesterStats(skips, semesterOf(new Date(2026, 9, 1)).key, 36);
  assert.equal(s.unexcused, 2);
});

test("январь относится к осеннему семестру прошлого года", () => {
  assert.equal(semesterOf(new Date(2027, 0, 15)).key, "2026-2");
  assert.equal(semesterOf(new Date(2027, 1, 2)).key, "2027-1");
  assert.ok(semesterOf(new Date(2026, 4, 1)).key < semesterOf(new Date(2026, 9, 1)).key);
});

test("ближайшая пара", () => {
  const days = normalizeSchedule({
    days: [
      { date: "2026-10-26", lessons: [
        { timeStart: "13:30", timeEnd: "14:55", title: "ТВиМС", teacher: {}, subgroup: { id: "0" } },
        { timeStart: "15:05", timeEnd: "16:30", title: "Сети", teacher: {}, subgroup: { id: "18764", title: "СДП-ПИ-251.3.2" } },
      ] },
    ],
  });
  const n = nextLesson(days, new Date(2026, 9, 26, 14, 0));
  assert.equal(n.lesson.title, "ТВиМС");
  assert.equal(n.isNow, true);
  const n2 = nextLesson(days, new Date(2026, 9, 26, 15, 0));
  assert.equal(n2.lesson.title, "Сети");
  assert.equal(n2.lesson.subgroup, "СДП-ПИ-251.3.2");
  assert.equal(nextLesson(days, new Date(2026, 9, 26, 17, 0)), null);
});

test("корзины задач", () => {
  const now = new Date(2026, 9, 25, 12, 0);
  assert.equal(taskBucket({ due: new Date(2026, 9, 24).toISOString() }, now), "overdue");
  assert.equal(taskBucket({ due: new Date(2026, 9, 26, 9).toISOString() }, now), "today");
  assert.equal(taskBucket({ due: new Date(2026, 9, 29).toISOString() }, now), "week");
  assert.equal(taskBucket({ due: new Date(2026, 10, 20).toISOString() }, now), "later");
  assert.equal(taskBucket({ done: true }, now), "done");
});

test("склонения", () => {
  assert.equal(pluralPairs(8), "8 пар");
  assert.equal(pluralPairs(2), "2 пары");
  assert.equal(pluralPairs(1), "1 пара");
});

test("половины пары и перерыв", async () => {
  const { lessonPhase } = await import("../src/logic.js");
  const l = { startMin: 9 * 60, endMin: 10 * 60 + 25 }; // 09:00–10:25
  assert.deepEqual(lessonPhase(l, 9 * 60 + 10), { phase: "first", left: 30 });
  assert.deepEqual(lessonPhase(l, 9 * 60 + 41), { phase: "break", left: 4 });
  assert.deepEqual(lessonPhase(l, 9 * 60 + 45), { phase: "second", left: 40 });
  assert.deepEqual(lessonPhase({ startMin: 600, endMin: 690 }, 610), { phase: "whole", left: 80 });
});

test("недели: понедельник, 7 дней, прогноз и полные ФИО", async () => {
  const m = await import("../src/logic.js");
  const tue = new Date(2026, 9, 27); // вторник 27 октября
  const mon = m.mondayOf(tue);
  assert.equal(m.isoDate(mon), "2026-10-26");
  assert.equal(m.isoDate(m.mondayOf(new Date(2026, 10, 1))), "2026-10-26"); // воскресенье → тот же понедельник

  const teachers = m.normalizeTeachers({ items: [{ id: "130544", surname: "Зайцев", name: "Павел", patronym: "Романович", post: "ст. преп." }] });
  const raw = { days: [{ date: "2026-10-27", lessons: [
    { timeStart: "09:00", timeEnd: "10:25", title: "Скрипты", teacher: { id: 130544, fullname: "Зайцев П.Р.", post: "" } },
    { timeStart: "11:40", timeEnd: "13:05", title: "Физра", teacher: { id: 1, fullname: "Попов Н.И.", post: "доц." } },
  ] }] };
  const days = m.normalizeSchedule(raw, teachers);
  assert.equal(days[0].lessons[0].teacher, "Зайцев Павел Романович");
  assert.equal(days[0].lessons[0].teacherPost, "ст. преп.");
  assert.equal(days[0].lessons[1].teacher, "Попов Н.И."); // нет в справочнике — как прислал сайт

  const week = m.buildWeek(mon, days);
  assert.equal(week.length, 7);
  assert.equal(m.weekLessons(week), 2);
  assert.equal(week[1].lessons.length, 2);
  assert.equal(week[0].lessons.length, 0);

  const next = m.forecastWeek(week);
  assert.equal(m.isoDate(next[1].date), "2026-11-03");
  assert.ok(next[1].forecast && next[1].lessons.every((l) => l.forecast));
  assert.ok(!week[1].lessons[0].forecast); // исходная неделя не испорчена
});

test("свои записи о пропусках, которых ещё нет на портале", () => {
  const marks = [
    { id: "a", date: "2026-11-09", start: "15:05", subject: "Экономика" },
    { id: "b", date: "2026-11-09", start: "13:30", subject: "Философия" },
    { id: "c", date: "2026-11-10", start: "9:00", subject: "Сети", excused: true },
    { id: "d", date: "2026-11-11", start: "11:40", subject: "Право", deleted: true },
  ];
  // Портал пуст — все записи считаются.
  let p = pendingSkips(marks, []);
  assert.deepEqual(p.map((x) => `${x.id}${x.ask ? "?" : ""}`), ["b", "a", "c"]);
  let s = semesterStats([], "2026-2", 36, p);
  assert.equal(s.unexcused, 4);
  assert.equal(s.excused, 2);
  assert.equal(s.pendingHours, 4);

  // 9 нояб на портале появилось 2 часа: одна запись этого дня под вопросом и в счётчик не идёт (не задваиваем).
  const portal = normalizeSkips([{ NDATA: "09.11.2026", KOLVO: "2", NPRICH: "прогул" }]);
  p = pendingSkips(marks, portal);
  assert.deepEqual(p.map((x) => `${x.id}${x.ask ? "?" : ""}`), ["b?", "a", "c"]);
  assert.equal(p[0].portal, 2);
  s = semesterStats(portal, "2026-2", 36, p);
  assert.equal(s.unexcused, 4); // 2 на портале + 2 своих (15:05)

  // Ответ «нет, на портале другая пара»: запись снова считается и больше не спрашивает…
  const said = marks.map((m) => (m.id === "b" ? { ...m, other: 2 } : m));
  p = pendingSkips(said, portal);
  assert.deepEqual(p.map((x) => `${x.id}${x.ask ? "?" : ""}`), ["b", "a?", "c"]);
  // …пока часов на портале не прибавится.
  const more = normalizeSkips([{ NDATA: "09.11.2026", KOLVO: "4", NPRICH: "прогул" }]);
  assert.deepEqual(pendingSkips(said, more).map((x) => `${x.id}${x.ask ? "?" : ""}`), ["b?", "a?", "c"]);
});

test("напоминания о задачах накануне срока", () => {
  const now = new Date(2026, 10, 10, 12, 0); // вт 10 нояб, полдень
  const due = (d, h, m = 0) => new Date(2026, 10, d, h, m).toISOString();
  const tasks = [
    { id: "1", title: "Лаба 4", subject: "Сети", due: due(11, 13, 30) },
    { id: "2", title: "Задачи 1–5", subject: "Экономика", due: due(11, 9) },
    { id: "3", title: "Эссе", subject: "", due: due(13, 15, 5) },
    { id: "4", title: "Сделано", due: due(12, 9), done: true },
    { id: "5", title: "Удалено", due: due(12, 9), deleted: true },
    { id: "6", title: "Без срока", due: null },
    { id: "7", title: "Сегодня вечером", due: due(10, 18) }, // «накануне» уже прошло
    { id: "8", title: "Нескоро", due: new Date(2026, 11, 20, 9).toISOString() },
  ];
  const r = taskReminders(tasks, now, 19);
  assert.equal(r.length, 2);
  assert.equal(r[0].id, 20261111);
  assert.equal(+r[0].at, +new Date(2026, 10, 10, 19, 0));
  assert.equal(r[0].title, "Завтра сдавать: 2 задачи");
  assert.equal(r[0].body, "09:00 · Экономика: Задачи 1–5\n13:30 · Сети: Лаба 4");
  assert.equal(r[1].id, 20261113);
  assert.equal(+r[1].at, +new Date(2026, 10, 12, 19, 0));
  assert.equal(r[1].title, "Завтра сдавать: Эссе");
  assert.equal(r[1].body, "К 15:05");
  // После 19:00 накануне уже не напоминаем о завтрашнем.
  assert.deepEqual(taskReminders(tasks, new Date(2026, 10, 10, 19, 30), 19).map((x) => x.id), [20261113]);
  // Другой час.
  assert.equal(+taskReminders(tasks, now, 21)[0].at, +new Date(2026, 10, 10, 21, 0));
});

test("посещаемость: ориентиры за месяц и за семестр", () => {
  const skips = normalizeSkips([
    { NDATA: "03.11.2026", KOLVO: "4", NPRICH: "прогул" },
    { NDATA: "05.11.2026", KOLVO: "2", NPRICH: "прогул", KOLO: "2" }, // отработано — не считается
    { NDATA: "06.11.2026", KOLVO: "6", NPRICH: "заявление на имя декана" },
    { NDATA: "20.10.2026", KOLVO: "8", NPRICH: "прогул" },
  ]);
  const now = new Date(2026, 10, 10, 12);
  const pending = [{ id: "a", date: "2026-11-09", start: "15:05", ask: false }, { id: "b", date: "2026-11-09", start: "16:40", ask: true }];
  // Ориентиров нет — только цифры.
  let a = attendanceSummary({ skips, pending, now });
  assert.equal(a.month.unexcused, 6); // 4 + 2 своих (запись под вопросом не считаем)
  assert.equal(a.month.excused, 6);
  assert.equal(a.semester.unexcused, 14);
  assert.equal(a.main, null);
  assert.equal(a.level, "ok");
  assert.equal(a.monthName, "ноябре");
  // 20 ч в месяц и 36 за семестр: ближе к семестровому (14/36 < 6/20? нет: 0.39 > 0.3).
  a = attendanceSummary({ skips, pending, now, semesterLimit: 36, monthLimit: 20 });
  assert.equal(a.main.kind, "semester");
  // Только месячный ориентир 8 ч — почти дошли.
  a = attendanceSummary({ skips, pending, now, monthLimit: 8 });
  assert.equal(a.main.kind, "month");
  assert.equal(a.level, "near");
  a = attendanceSummary({ skips, pending, now, monthLimit: 6 });
  assert.equal(a.level, "over");
});
