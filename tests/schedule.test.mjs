import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSchedule } from "../src/logic.js";
import {
  parseGroupTitle, shortGroup, groupCatalog, diffWeeks, changeText, dayTogether, whereNow,
  subjectsWithTypes, occurrences, relinkTasks, slotLabel, predictLessonNumbers,
} from "../src/schedule.js";

const L = (timeStart, timeEnd, title, type, room = "101", address = "Гаспадарчая, 23", sub = "") => ({
  timeStart, timeEnd, title, type, room, address, teacher: { id: 1, fullname: "X" },
  subgroup: sub ? { id: "9", title: sub } : { id: "0", title: "" },
});
const week = (byDate) => normalizeSchedule({ days: Object.entries(byDate).map(([date, lessons]) => ({ date, lessons })) });

test("группы: разбор названия и каталог", () => {
  assert.deepEqual(
    { ...parseGroupTitle("СДП-ПИ-251") },
    { title: "СДП-ПИ-251", prefix: "СДП", spec: "ПИ", code: "251", year: 2025 },
  );
  assert.equal(shortGroup("СДП-ПИ-251"), "ПИ-251");
  const cat = groupCatalog({
    1: [{ id: 1, title: "СДП-ПИ-261" }, { id: 2, title: "СДП-ЭУ-261" }],
    2: [{ id: 3, title: "СДП-ПИ-252" }, { id: 4, title: "СДП-ПИ-251" }],
  });
  const isit = cat.find((s) => s.spec === "ПИ");
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

test("когда освобождаетесь вместе", () => {
  const me = week({ "2026-11-02": [L("09:00", "10:25", "A", "лек."), L("13:30", "14:55", "B", "лек.")] })[0];
  const fr = week({ "2026-11-02": [L("11:40", "13:05", "C", "лек."), L("15:05", "16:30", "D", "лек.")] })[0];
  const r = dayTogether(me, fr);
  assert.equal(r.myEnd, "14:55");
  assert.equal(r.theirEnd, "16:30");
  assert.equal(r.together, "16:30");
  assert.equal(r.later, "them");
  assert.equal(r.wait, 95);
  // Утро до прихода друга (10:25–11:40) — не окно; посреди дня оба на парах — окон нет.
  assert.deepEqual(r.windows, []);
  const fr2 = week({ "2026-11-02": [L("09:00", "10:25", "C", "лек."), L("16:40", "18:05", "D", "лек.")] })[0];
  const r2 = dayTogether(me, fr2);
  assert.deepEqual(r2.windows.map((w) => [w.from, w.to]), [["10:25", "13:30"]]);
  assert.equal(r2.windows[0].place, "Гаспадарчая, 23");
  assert.equal(dayTogether({ lessons: [] }, { lessons: [] }).none, true);
  assert.equal(dayTogether(me, { lessons: [] }).only, "me");
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

test("номера пар, которых ещё нет в журнале", () => {
  const days = week({
    "2026-10-26": [L("13:30", "14:55", "Сети", "практ. зан."), L("15:05", "16:30", "Сети", "лек.")],
    "2026-10-30": [L("13:30", "14:55", "Сети", "практ. зан.")],
    "2026-11-02": [L("13:30", "14:55", "Сети", "практ. зан."), L("15:05", "16:30", "Сети", "лек.")],
    "2026-11-06": [L("13:30", "14:55", "Сети", "практ. зан.")],
  });
  const lessons = days.flatMap((d) => d.lessons.map((l) => ({ l, date: d.date.toISOString ? `${d.date.getFullYear()}-${String(d.date.getMonth() + 1).padStart(2, "0")}-${String(d.date.getDate()).padStart(2, "0")}` : d.date })));
  // В журнале заполнены пары только по 26 октября включительно.
  const journal = new Map([["777", [
    { date: "2026-10-26", start: "13:30", label: "Практика", n: 7 },
    { date: "2026-10-26", start: "15:05", label: "Лекция", n: 5 },
  ]]]);
  const p = predictLessonNumbers(lessons, journal);
  assert.equal(p.get("2026-10-30|13:30").item.n, 8);
  assert.equal(p.get("2026-11-02|13:30").item.n, 9);
  assert.equal(p.get("2026-11-02|15:05").item.label, "Лекция");
  assert.equal(p.get("2026-11-02|15:05").item.n, 6);
  assert.equal(p.get("2026-11-06|13:30").item.n, 10);
  assert.equal(p.has("2026-10-26|13:30"), false); // уже в журнале
  // Предмета без совпавших пар не досчитываем.
  assert.equal(predictLessonNumbers(lessons, new Map()).size, 0);
});
