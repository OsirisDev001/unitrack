import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSchedule } from "../src/logic.js";
import {
  parseGroupTitle, shortGroup, groupCatalog, diffWeeks, changeText, freeWindows, whereNow,
  subjectsWithTypes, occurrences, relinkTasks, slotLabel,
} from "../src/schedule.js";

const L = (timeStart, timeEnd, title, type, room = "101", address = "Гаспадарчая, 23", sub = "") => ({
  timeStart, timeEnd, title, type, room, address, teacher: { id: 1, fullname: "X" },
  subgroup: sub ? { id: "9", title: sub } : { id: "0", title: "" },
});
const week = (byDate) => normalizeSchedule({ days: Object.entries(byDate).map(([date, lessons]) => ({ date, lessons })) });

test("группы: разбор названия и каталог", () => {
  assert.deepEqual(
    { ...parseGroupTitle("СДП-ИСИТ-251") },
    { title: "СДП-ИСИТ-251", prefix: "СДП", spec: "ИСИТ", code: "251", year: 2025 },
  );
  assert.equal(shortGroup("СДП-ИСИТ-251"), "ИСИТ-251");
  const cat = groupCatalog({
    1: [{ id: 1, title: "СДП-ИСИТ-261" }, { id: 2, title: "СДП-ЭУ-261" }],
    2: [{ id: 3, title: "СДП-ИСИТ-252" }, { id: 4, title: "СДП-ИСИТ-251" }],
  });
  const isit = cat.find((s) => s.spec === "ИСИТ");
  assert.deepEqual(isit.courses.map((c) => c.course), [1, 2]);
  assert.deepEqual(isit.courses[1].groups.map((g) => g.label), ["251", "252"]);
  assert.equal(isit.courses[1].year, 2025);
});

test("изменения: аудитория, перенос, отмена, новая пара", () => {
  const now = new Date(2026, 10, 2, 8, 0);
  const old = week({
    "2026-11-02": [L("13:30", "14:55", "ООП", "лек.", "309"), L("15:05", "16:30", "Сети", "лаб.")],
    "2026-11-03": [L("11:40", "13:05", "Физра", "практ. зан.")],
  });
  const neu = week({
    "2026-11-02": [L("13:30", "14:55", "ООП", "лек.", "204")],
    "2026-11-04": [L("15:05", "16:30", "Сети", "лаб."), L("09:00", "10:25", "Скрипты", "лаб.")],
  });
  const ch = diffWeeks(old, neu, now);
  const kinds = ch.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["added", "cancelled", "moved", "room"]);
  assert.equal(changeText(ch.find((c) => c.kind === "room")), "Аудитория: 309 → 204");
  assert.equal(changeText(ch.find((c) => c.kind === "moved")), "Перенесли: было пн 15:05 → стало ср 15:05");
  // Пустой ответ сайта — не «всё отменили».
  assert.deepEqual(diffWeeks(old, week({}), now), []);
  // Прошедшие пары не сравниваем.
  assert.deepEqual(diffWeeks(old, neu, new Date(2026, 10, 9)), []);
});

test("общие окна", () => {
  const me = week({ "2026-11-02": [L("09:00", "10:25", "A", "лек."), L("13:30", "14:55", "B", "лек.")] })[0];
  const fr = week({ "2026-11-02": [L("09:00", "10:25", "C", "лек."), L("11:40", "13:05", "D", "лек.", "1", "Захарова, 32")] })[0];
  const r = freeWindows(me, fr);
  assert.equal(r.allFree, false);
  assert.deepEqual(r.windows.map((w) => [w.from, w.to]), [["10:25", "11:40"]]);
  assert.equal(r.windows[0].place, "Гаспадарчая, 23"); // оба после пары на Гаспадарчей
  assert.equal(freeWindows({ lessons: [] }, { lessons: [] }).allFree, true);
});

test("где сейчас преподаватель", () => {
  const days = week({ "2026-11-02": [L("09:00", "10:25", "A", "лек.", "201"), L("11:40", "13:05", "B", "лаб.", "309")], "2026-11-03": [L("08:30", "09:55", "C", "лек.")] });
  let w = whereNow(days, new Date(2026, 10, 2, 9, 40));
  assert.equal(w.current.room, "201");
  assert.equal(w.next.room, "309");
  w = whereNow(days, new Date(2026, 10, 2, 14, 0));
  assert.equal(w.current, null);
  assert.equal(w.next.title, "C");
});

test("задачи к паре: ближайшие пары и перенос срока", () => {
  const now = new Date(2026, 10, 2, 8, 0);
  const days = week({
    "2026-11-02": [L("15:05", "16:30", "Сети", "лаб."), L("16:40", "18:05", "Сети", "лек.")],
    "2026-11-09": [L("15:05", "16:30", "Сети", "лаб.")],
  });
  const subs = subjectsWithTypes(days, now);
  assert.equal(subs[0].subject, "Сети");
  assert.deepEqual([...subs[0].types].sort(), ["лаб.", "лек."]);
  const occ = occurrences(days, "Сети", "лаб.", now, 3);
  assert.deepEqual(occ.map((o) => o.date), ["2026-11-02", "2026-11-09"]);

  // Лабу с понедельника перенесли на вторник — задача едет за ней.
  const task = { id: "t", title: "Отчёт", lesson: { subject: "Сети", type: "лаб.", date: "2026-11-02", start: "15:05" }, due: "x" };
  const moved = week({ "2026-11-03": [L("11:40", "13:05", "Сети", "лаб.")] });
  const changes = diffWeeks(days.slice(0, 1), moved, now);
  const out = relinkTasks([task], moved, changes, new Set(["2026-11-02"]), now);
  assert.equal(out.length, 1);
  assert.deepEqual(task.lesson, { subject: "Сети", type: "лаб.", date: "2026-11-03", start: "11:40" });
  assert.equal(task.moved.from, "пн 15:05");
  assert.equal(task.moved.to, "вт 11:40");
  // По прогнозу (неделя без настоящего расписания) ничего не двигаем.
  const t2 = { id: "u", lesson: { subject: "Сети", type: "лаб.", date: "2026-11-16", start: "15:05" } };
  assert.equal(relinkTasks([t2], moved, [], new Set(["2026-11-02"]), now).length, 0);
  assert.equal(slotLabel("2026-11-04", "15:05"), "ср 15:05");
});
