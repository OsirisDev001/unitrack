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
