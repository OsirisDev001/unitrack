// node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSkips, semesterStats, semesterOf, normalizeSchedule, nextLesson, taskBucket, pluralPairs,
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
        { timeStart: "15:05", timeEnd: "16:30", title: "Сети", teacher: {}, subgroup: { id: "18764", title: "СДП-ИСИТ-251.3.2" } },
      ] },
    ],
  });
  const n = nextLesson(days, new Date(2026, 9, 26, 14, 0));
  assert.equal(n.lesson.title, "ТВиМС");
  assert.equal(n.isNow, true);
  const n2 = nextLesson(days, new Date(2026, 9, 26, 15, 0));
  assert.equal(n2.lesson.title, "Сети");
  assert.equal(n2.lesson.subgroup, "СДП-ИСИТ-251.3.2");
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

  const teachers = m.normalizeTeachers({ items: [{ id: "130544", surname: "Бурба", name: "Александр", patronym: "Владимирович", post: "ст. преп." }] });
  const raw = { days: [{ date: "2026-10-27", lessons: [
    { timeStart: "09:00", timeEnd: "10:25", title: "Скрипты", teacher: { id: 130544, fullname: "Бурба А.В.", post: "" } },
    { timeStart: "11:40", timeEnd: "13:05", title: "Физра", teacher: { id: 1, fullname: "Войтишкин В.Л.", post: "доц." } },
  ] }] };
  const days = m.normalizeSchedule(raw, teachers);
  assert.equal(days[0].lessons[0].teacher, "Бурба Александр Владимирович");
  assert.equal(days[0].lessons[0].teacherPost, "ст. преп.");
  assert.equal(days[0].lessons[1].teacher, "Войтишкин В.Л."); // нет в справочнике — как прислал сайт

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
