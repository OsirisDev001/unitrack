import test from "node:test";
import assert from "node:assert/strict";
import {
  prettyName, gradeNumber, normalizeProgress, progressBySemester, normalizeAttestation, normalizeRating,
  normalizeLibrary, normalizeHostel, normalizeProfile, shortFio, initials, gradebookHtml, normalizeGroups, normalizeCourses, currentSemesterNumber, courseUrl,
} from "../src/study.js";

test("имена преподавателей и оценки", () => {
  assert.equal(prettyName("СТЕПИН Ю.Г."), "Степин Ю.Г.");
  assert.equal(gradeNumber("9(девять)"), 9);
  assert.equal(gradeNumber("зачтено"), null);
});

test("успеваемость: семестры и средний балл", () => {
  const items = normalizeProgress([
    { DOCEN: "19.06.2026", NPOCEN: "Экзамен", NDISC: "Английский", OCENS: "10(десять)", FIO_TN: "БОДРЕНКОВА А.С." },
    { DOCEN: "15.06.2026", NPOCEN: "Экзамен", NDISC: "ОАиП", OCENS: "6(шесть)", FIO_TN: "КАЛИНИНА Е.Н." },
    { DOCEN: "20.01.2026", NPOCEN: "Зачет", NDISC: "Физра", OCENS: "зачтено", FIO_TN: "" },
  ]);
  const sems = progressBySemester(items);
  assert.equal(sems.length, 2);
  assert.equal(sems[0].avg, 8);
  assert.equal(sems[0].items[0].teacher, "Бодренкова А.С.");
  assert.equal(sems[1].avg, null);
});

test("аттестация по семестрам", () => {
  const a = normalizeAttestation([
    { SEMESTR: "2", NAME_DISC: "Матанализ", OCEN: "3", childs: [{ NN: "1", DOCEN: "01.06.2026", OCEN: "3" }] },
    { SEMESTR: "1", NAME_DISC: "ООП", OCEN: "зачтено", childs: [] },
  ]);
  assert.deepEqual(a.map((s) => s.semester), [2, 1]);
  assert.equal(a[0].items[0].attempts[0].date, "01.06.2026");
});

test("рейтинг берёт год с данными", () => {
  const r = normalizeRating([
    { year: "2025/2026", general: { total_score: "112", letter: "B", preliminary: "1", place_fac: "0" } },
    { year: "2024/2025", general: false },
  ]);
  assert.equal(r.score, 112);
  assert.equal(r.letter, "B");
  assert.equal(r.preliminary, true);
  assert.equal(r.placeFaculty, null);
});

test("библиотека: срок возврата из двухзначного года", () => {
  const books = normalizeLibrary({ data: [{ N_PR: "ТВиМС", AVTOR: "Ляликова", N_DATA: "07.09.26", K_DATA: "12.01.27" }] }, new Date(2027, 0, 10));
  assert.equal(books[0].due.getFullYear(), 2027);
  assert.equal(books[0].daysLeft, 2);
});

test("общежитие и профиль", () => {
  const h = normalizeHostel({ data: { N_OTDEL: "Общежитие №3", NKW: "98", itogo: "0.00", date2: "22.09.2025" } });
  assert.equal(h.room, "98");
  assert.equal(h.debt, 0);
  const p = normalizeProfile({ student: { FIO_R: "Иванов Иван Иванович", N_ZACH: "2025-0000 ", KURS: "2", N_GRYP: "СДП-ИСИТ-251", N_OTDEL: " экономики и управления" } });
  assert.equal(p.book, "2025-0000");
  assert.equal(p.faculty, "Факультет экономики и управления");
  assert.equal(shortFio(p.fio), "Иванов И. И.");
  assert.equal(initials(p.fio), "ИИ");
});

test("зачётка и группа", () => {
  assert.equal(gradebookHtml({ data: { title: "<p>a</p>", body: "<p>b</p>", n: 1 } }), "<p>a</p>\n<p>b</p>");
  const g = normalizeGroups([{ GROUPINFO: { N_GRYP: "СДП-ИСИТ-251" }, LIST: [{ FIO: "Бобров М.", N_ZACH: "2" }, { FIO: "Апалайко А.", N_ZACH: "1" }] }]);
  assert.equal(g[0].members[0].name, "Апалайко А.");
});

test("курсы платформы по семестрам", () => {
  const c = normalizeCourses({ "1": { "2": [{ course_id: "2", course_name_ru: "Б" }], "1": [{ course_id: "1", course_name_ru: "А" }] }, "2": { "3": [] } });
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].semesters.map((s) => s.semester), [1, 2]);
  assert.equal(courseUrl("38584"), "https://edu.grsu.by/course/view.php?id=38584");
  assert.equal(currentSemesterNumber(2, new Date(2026, 9, 25)), 3);
  assert.equal(currentSemesterNumber(2, new Date(2027, 2, 1)), 4);
});
