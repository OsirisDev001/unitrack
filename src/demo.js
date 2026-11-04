// Демо-режим: когда страница открыта в обычном браузере, а не внутри приложения.
// Даёт посмотреть интерфейс без входа на edu.grsu.by.

// Все люди, группы и предметы здесь выдуманы.
const MY_GROUP = "СДП-ПИ-242";

const L = (timeStart, timeEnd, title, type, fullname, room, address = "Гаспадарчая, 23", sub = "") => ({
  timeStart, timeEnd, title, type, room, address, label: "",
  teacher: { id: DEMO_IDS[fullname] || "0", fullname, post: "" },
  subgroup: sub ? { id: "1", title: `${MY_GROUP}.${sub}` } : { id: "0", title: "" },
});

const DEMO_TEACHERS = [
  ["Соколова", "Елена", "Андреевна", "доц.", "e.sokolova@example.com"], ["Морозов", "Дмитрий", "Викторович", "ст. преп.", ""],
  ["Кузнецов", "Алексей", "Сергеевич", "ст. преп.", "a.kuznetsov@example.com"], ["Попов", "Николай", "Игоревич", "ст. преп.", ""],
  ["Волкова", "Ольга", "Петровна", "доц.", "o.volkova@example.com"], ["Лебедев", "Кирилл", "Андреевич", "ст. преп.", "k.lebedev@example.com"],
  ["Новикова", "Татьяна", "Сергеевна", "доц.", ""], ["Фёдорова", "Ирина", "Николаевна", "доц.", "i.fedorova@example.com"],
  ["Зайцев", "Павел", "Романович", "ст. преп.", "p.zaitsev@example.com"], ["Орлов", "Виктор", "Геннадьевич", "доц.", ""],
].map(([surname, name, patronym, post, email], i) => ({ id: String(100 + i), surname, name, patronym, post, email }));
const DEMO_IDS = Object.fromEntries(DEMO_TEACHERS.map((t) => [`${t.surname} ${t.name[0]}.${t.patronym[0]}.`, t.id]));

const WEEK = [
  [
    L("13:30", "14:55", "Высшая математика", "лек.", "Соколова Е.А.", "101"),
    L("15:05", "16:30", "Микроэкономика", "лек.", "Морозов Д.В.", "306"),
    L("18:15", "19:40", "Информатика", "лаб.", "Кузнецов А.С.", "303", "К.Маркса, 31", "2.1"),
  ],
  [
    L("11:40", "13:05", "Физическая культура", "практ. зан.", "Попов Н.И.", "Спорткомплекс", "Захарова, 32"),
    L("13:30", "14:55", "Маркетинг", "лек.", "Волкова О.П.", "309"),
    L("15:05", "16:30", "Базы данных", "лаб.", "Лебедев К.А.", "204", undefined, "2.1"),
    L("16:40", "18:05", "Базы данных", "лек.", "Лебедев К.А.", "306"),
  ],
  [
    L("13:30", "14:55", "Философия", "сем. зан.", "Новикова Т.С.", "101"),
    L("15:05", "16:30", "Менеджмент", "лек.", "Фёдорова И.Н.", "306"),
  ],
  [
    L("09:00", "10:25", "Веб-технологии", "лаб.", "Зайцев П.Р.", "201", undefined, "2.1"),
    L("15:05", "16:30", "Охрана труда", "лек.", "Орлов В.Г.", "101"),
  ],
  [
    L("13:30", "14:55", "Высшая математика", "практ. зан.", "Соколова Е.А.", "213"),
    L("15:05", "16:30", "Менеджмент", "практ. зан.", "Фёдорова И.Н.", "211", undefined, "2.1"),
  ],
  [],
];

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Неделя с понедельника monday ("YYYY-MM-DD"); будущее сайт ещё «не выложил». */
function demoWeek(monday) {
  const [y, m, d0] = monday.split("-").map(Number);
  const now = new Date();
  const curMon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  if (new Date(y, m - 1, d0) > curMon) return { count: 0, days: [] };
  const days = [];
  for (let i = 0; i < 5; i++) days.push({ num: String(i + 1), date: iso(new Date(y, m - 1, d0 + i)), count: WEEK[i].length, lessons: WEEK[i] });
  return { count: days.length, days };
}

/** Чужое расписание в демо: друг — сдвинутая версия моей недели, преподаватель — пары с группами. */
function demoOther(kind, monday) {
  const w = demoWeek(monday);
  if (kind === "teacher") {
    w.days = w.days.map((d, i) => ({ ...d, lessons: [
      { ...L("09:00", "10:25", "Веб-технологии", "лаб.", "Зайцев П.Р.", "201", undefined, "2.1"), groups: [{ title: MY_GROUP }] },
      { ...L("11:40", "13:05", "Программирование", "лаб.", "Зайцев П.Р.", "309"), groups: [{ title: "СДП-ПИ-251" }] },
    ].slice(0, i % 2 ? 1 : 2) }));
  } else {
    w.days = w.days.map((d, i) => ({ ...d, lessons: WEEK[(i + 1) % 5].map((l) => ({ ...l })) }));
  }
  return w;
}

function demoChanged(w, monday) {
  const now = new Date();
  const cur = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)));
  if (monday !== cur || w.days.length < 3) return w;
  const days = w.days.map((d) => ({ ...d, lessons: d.lessons.map((l) => ({ ...l })) }));
  const tue = days[1].lessons;
  const mk = tue.find((l) => l.title === "Маркетинг");
  if (mk) mk.room = "204";
  const lab = tue.findIndex((l) => l.title === "Базы данных" && l.type === "лаб.");
  if (lab >= 0) days[2].lessons.push({ ...tue.splice(lab, 1)[0], timeStart: "16:40", timeEnd: "18:05" });
  return { ...w, days };
}

function demoSchedule() {
  const now = new Date();
  return demoWeek(iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7))));
}

const P = "прогул";
const D = "заявление на имя декана";
const DEMO_SKIPS = [
  ["12.10.2026", 2, P], ["05.10.2026", 2, P], ["01.10.2026", 2, P], ["30.09.2026", 2, P],
  ["24.09.2026", 2, P], ["23.09.2026", 6, P], ["22.09.2026", 2, P], ["18.09.2026", 6, D],
  ["17.09.2026", 6, D], ["16.09.2026", 6, D], ["15.09.2026", 8, D], ["14.09.2026", 4, D],
  ["10.09.2026", 2, P], ["22.05.2026", 6, D], ["21.05.2026", 8, D], ["20.05.2026", 6, D],
  ["19.05.2026", 8, D], ["18.05.2026", 6, D], ["12.05.2026", 2, P],
].map(([NDATA, KOLVO, NPRICH], i) => ({ KATTENDANCE: String(i), NDATA, KOLVO: String(KOLVO), NPRICH, KOLO: "" }));

function demoTasks() {
  const h = (hours) => new Date(Date.now() + hours * 36e5).toISOString();
  return [
    { id: "d1", title: "Лаба 4 — индексы", subject: "Базы данных", kind: "lab", due: h(20), notes: "", done: false, created: 1 },
    { id: "d2", title: "Реферат, глава 1", subject: "Менеджмент", kind: "course", due: h(24 * 5), notes: "", done: false, created: 2 },
    { id: "d3", title: "ДЗ: пределы функций", subject: "Высшая математика", kind: "hw", due: h(-5), notes: "", done: false, created: 3 },
    { id: "d4", title: "Сдать лабу 2 по информатике", subject: "Информатика", kind: "lab", due: h(-48), notes: "", done: true, created: 4 },
  ];
}

/** Предметы текущего семестра с id журнала (учебный год начинается в сентябре). */
function demoAcad() {
  const now = new Date();
  const m = now.getMonth() + 1;
  return { year: m >= 9 ? now.getFullYear() : now.getFullYear() - 1, sem: m >= 9 || m === 1 ? 5 : 6 };
}
const SUBJECTS = ["Высшая математика", "Микроэкономика", "Информатика", "Маркетинг", "Базы данных", "Философия", "Менеджмент", "Веб-технологии", "Охрана труда", "Физическая культура"];
const KDISC = Object.fromEntries(SUBJECTS.map((s, i) => [s, String(901 + i)]));
const TOPICS = ["Введение и основные понятия", "Модели и методы", "Практическое применение", "Анализ и оценка", "Проектирование", "Обзор и повторение"];
const KIND = { "лек.": "Лекция", "практ. зан.": "Практическое занятие", "лаб.": "Лабораторное занятие", "сем. зан.": "Семинарское занятие" };

/** Журнал предмета: все его пары с 1 сентября до конца следующей недели, с выдуманными темами и оценками. */
function demoPerformance(kdisc) {
  const subject = Object.keys(KDISC).find((s) => KDISC[s] === kdisc);
  const { year } = demoAcad();
  const rows = [];
  const start = new Date(year, 8, 1);
  const first = new Date(start.getFullYear(), start.getMonth(), start.getDate() - ((start.getDay() + 6) % 7));
  const now = new Date();
  const until = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14);
  let k = 0;
  for (let d = new Date(first); d < until; d.setDate(d.getDate() + 1)) {
    const wd = (d.getDay() + 6) % 7;
    if (d < start || wd > 4) continue;
    for (const l of WEEK[wd]) {
      if (l.title !== subject) continue;
      k++;
      const past = d < now;
      rows.push({
        DATE_ACADEMIC: `${iso(d)} ${l.timeStart}:00`, NPOCEN: KIND[l.type] || "Лекция", SSEQUENCE: `${Math.ceil(k / 2)}.${((k - 1) % 2) + 1}.`,
        NUPCONTENT: `<p>${TOPICS[Math.floor((k - 1) / 2) % TOPICS.length]}</p>`, NDISC: subject, FIO_PREP: l.teacher.fullname,
        IMARK: past && l.type !== "лек." && k % 3 === 0 ? String(6 + (k % 4)) : "", SABSENT: past && k % 7 === 3 ? "н" : " ",
      });
    }
  }
  return rows;
}

const DEMO_STUDY = {
  getCoursesData: {
    "1": { "1": [{ course_id: "31001", course_name_ru: "Математический анализ" }, { course_id: "31002", course_name_ru: "Основы программирования" }], "2": [{ course_id: "31003", course_name_ru: "Дискретная математика" }] },
    "2": { "3": [{ course_id: "32001", course_name_ru: "Алгоритмы и структуры данных" }], "4": [{ course_id: "32002", course_name_ru: "Операционные системы" }] },
    "3": { [demoAcad().sem]: SUBJECTS.map((name, i) => ({ course_id: String(33001 + i), course_name_ru: name, kdisc: KDISC[name], semestr: String(demoAcad().sem), year: String(demoAcad().year) })) },
  },
  getChoosenCourses: { student: { FIO_R: "Иванов Иван Иванович", N_ZACH: "2024-0001 ", KURS: "3", N_GRYP: MY_GROUP, NAME_SPEC: "Программная инженерия", N_VOB: "дневная", N_OTDEL: " математики и информатики" } },
  getProgress: [
    { DOCEN: "20.06.2026", NPOCEN: "Экзамен", NDISC: "Операционные системы", OCENS: "8(восемь)", FIO_TN: "ПЕТРОВ Ю.Г." },
    { DOCEN: "15.06.2026", NPOCEN: "Экзамен", NDISC: "Английский язык", OCENS: "9(девять)", FIO_TN: "СИДОРОВА А.С." },
    { DOCEN: "10.06.2026", NPOCEN: "Зачет", NDISC: "Физическая культура", OCENS: "зачтено", FIO_TN: "ПОПОВ Н.И." },
    { DOCEN: "20.01.2026", NPOCEN: "Экзамен", NDISC: "Алгоритмы и структуры данных", OCENS: "7(семь)", FIO_TN: "КУЗНЕЦОВ А.С." },
    { DOCEN: "15.01.2026", NPOCEN: "Экзамен", NDISC: "Математический анализ", OCENS: "6(шесть)", FIO_TN: "СОКОЛОВА Е.А." },
  ],
  getAttestation: [
    { SEMESTR: "4", NAME_DISC: "Операционные системы", OCEN: "4", childs: [{ NN: "1", DOCEN: "01.06.2026", OCEN: "4" }] },
    { SEMESTR: "4", NAME_DISC: "Английский язык", OCEN: "зачтено", childs: [{ NN: "1", DOCEN: "27.05.2026", OCEN: "зачтено" }] },
  ],
  getStatistics: [{ year: "2025/2026", sections: [], general: { total_score: "112", letter: "B", preliminary: "1", place_fac: "0", place_univ: "0" } }],
  getLibrary: { status: 200, data: [
    { N_PR: "Высшая математика: учебное пособие", AVTOR: "Соколова Е. А.", N_SAVE: "Филиал № 2", ADR_SAVE: "ул. Ожешко, 22", N_DATA: "07.09.26", K_DATA: "12.01.27" },
    { N_PR: "Базы данных: практикум", AVTOR: "Лебедев К. А.", N_SAVE: "Филиал № 2", ADR_SAVE: "ул. Ожешко, 22", N_DATA: "07.09.26", K_DATA: "05.11.26" },
  ] },
  getHostel: { status: 200, data: { N_OTDEL: "Общежитие №1", ADRESS: "Гродно", NKW: "12", itogo: "0.00", peny: "0.00", date2: "22.09.2025" } },
  getStudentOrders: [
    { N_PRIKAZ: "расп. 2", NTYPE: "Перевести на 5 семестр", D_PRIKAZ: "26.08.2026", SODER: "Перевести студента 2 курса на 3 курс." },
    { N_PRIKAZ: "1024-с", NTYPE: "Зачислить", D_PRIKAZ: "01.08.2024", SODER: "Зачислить на 1 курс дневной формы получения образования." },
  ],
  getGroups: [{ GROUPINFO: { N_GRYP: MY_GROUP, T_GRYP: "учебная группа" }, LIST: ["Алексеев А.", "Белова Б.", "Иванов Иван Иванович", "Григорьев Г.", "Дмитриева Д.", "Егоров Е."].map((FIO, i) => ({ FIO, N_ZACH: String(i) })) }],
  getGradeBookMarkup: { error: 0, data: { title: "<h2 style='text-align:center'>Зачётная книжка</h2><p style='text-align:center'>Иванов Иван Иванович · 2024-0001</p><table border=1 cellpadding=6 style='border-collapse:collapse;width:100%'><tr><td>Математический анализ</td><td>6 (шесть)</td><td>15.01.2026</td></tr><tr><td>Английский язык</td><td>9 (девять)</td><td>15.06.2026</td></tr></table>" } },
};

export function demoBackend() {
  const mem = new Map();
  const get = (k) => { try { return localStorage.getItem("unitrack_" + k); } catch { return mem.get(k) ?? null; } };
  const set = (k, v) => { try { localStorage.setItem("unitrack_" + k, v); } catch { mem.set(k, v); } };
  if (get("tasks") === null) set("tasks", JSON.stringify(demoTasks()));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    savedUsername: async () => "демо",
    login: async () => {},
    logout: async () => {},
    fetch: async (m) => {
      await wait(400);
      if (m === "getSkips") return JSON.stringify(DEMO_SKIPS);
      if (m === "getStudentSchedule") return JSON.stringify(demoSchedule());
      return JSON.stringify(DEMO_STUDY[m] ?? null);
    },
    cached: async () => null,
    // В демо «сайт» отдаёт изменённую текущую неделю, а «сохранённая» — исходная: видно фишку изменений.
    fetchWeek: async (monday) => { await wait(500); return JSON.stringify(demoChanged(demoWeek(monday), monday)); },
    cachedWeek: async (monday) => JSON.stringify(demoWeek(monday)),
    fetchTeachers: async () => JSON.stringify({ count: DEMO_TEACHERS.length, items: DEMO_TEACHERS }),
    cachedTeachers: async () => null,
    lookupStudent: async (login) => {
      await wait(400);
      if (!/^[A-Za-z0-9_.-]{2,64}$/.test(login)) throw new Error("Логин выглядит как Ivanov_II_25 — латиница, цифры и _");
      return JSON.stringify({ id: 1, fullname: "Петров Пётр Петрович", studenttype: "Студент", grouptitle: "СДП-ПИ-241", nzach: "", k_sgryp: 2 });
    },
    fetchSchedule: async (kind, id, monday) => { await wait(400); return JSON.stringify(demoOther(kind, monday)); },
    cachedSchedule: async () => null,
    fetchFaculties: async () => JSON.stringify({ items: [
      { id: "3", title: "Факультет математики и информатики" }, { id: "30", title: "Факультет экономики и управления" }, { id: "4673", title: "Физико-технический факультет" }] }),
    fetchGroups: async (fac, course) => JSON.stringify({ items: course > 4 ? [] : (fac === "3" ? ["ПИ", "ПМИ", "КБ"] : ["ЭУ", "М", "ФиК"])
      .flatMap((sp, i) => [1, 2].map((n) => ({ id: `${fac}${course}${i}${n}`, title: `СДП-${sp}-${27 - course}${n}` }))) }),
    fetchPerformance: async (kdisc) => { await wait(300); return JSON.stringify(demoPerformance(kdisc)); },
    cachedPerformance: async () => null,
    load: async (k) => get(k),
    save: async (k, v) => set(k, v),
    syncInfo: async () => ({ role: "server", ip: "192.168.0.5", port: 47321, pin: "482913" }),
    syncNow: async () => { throw new Error("в демо синхронизации нет"); },
  };
}
