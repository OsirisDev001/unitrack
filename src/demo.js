// Демо-режим: когда страница открыта в обычном браузере, а не внутри приложения.
// Даёт посмотреть интерфейс без входа на edu.grsu.by.

const L = (timeStart, timeEnd, title, type, fullname, room, address = "Гаспадарчая, 23", sub = "") => ({
  timeStart, timeEnd, title, type, room, address, label: "",
  teacher: { fullname, post: "" },
  subgroup: sub ? { id: "1", title: `СДП-ИСИТ-251.${sub}` } : { id: "0", title: "" },
});

const WEEK = [
  [
    L("13:30", "14:55", "Теория вероятностей и математ. статистика", "лек.", "Ляликова В.И.", "101"),
    L("15:05", "16:30", "Экономика организаций сектора ИКТ", "лек.", "Саврас С.А.", "306"),
    L("18:15", "19:40", "Основы конструирования программ", "лаб.", "Локтевич В.М.", "303", "К.Маркса,31", "3.2"),
  ],
  [
    L("11:40", "13:05", "Физическая культура", "практ. зан.", "Войтишкин В.Л.", "Спорткомплекс", "Захарова, 32"),
    L("13:30", "14:55", "Объектно-ориентир. проектиров. и программир.", "лек.", "Игнатенко И.И.", "309"),
    L("15:05", "16:30", "Компьютерные сети", "лаб.", "Белов И.П.", "204", undefined, "3.2"),
    L("16:40", "18:05", "Компьютерные сети", "лек.", "Белов И.П.", "306"),
  ],
  [
    L("13:30", "14:55", "Социальная психология", "сем. зан.", "Морозенко А.А.", "101"),
    L("15:05", "16:30", "Системный анализ и проектир. информац. систем", "лек.", "Козловская Н.Ю.", "306"),
  ],
  [
    L("09:00", "10:25", "Скриптовые языки программирования", "лаб.", "Бурба А.В.", "201", undefined, "3.2"),
    L("15:05", "16:30", "Безопасность жизнедеятельности человека", "лек.", "Анисько П.Е.", "101"),
  ],
  [
    L("13:30", "14:55", "Теория вероятностей и математ. статистика", "практ. зан.", "Ляликова В.И.", "213"),
    L("15:05", "16:30", "Системный анализ и проектир. информац. систем", "лаб.", "Козловская Н.Ю.", "211", undefined, "3.2"),
  ],
  [],
];

function demoSchedule() {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const days = [];
  for (let w = 0; w < 2; w++) {
    for (let i = 0; i < 6; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + w * 7 + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      days.push({ num: String(i + 1), date: iso, count: WEEK[i].length, lessons: WEEK[i] });
    }
  }
  return { count: days.length, days };
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
    { id: "d1", title: "Лаба 4 — маршрутизация", subject: "Компьютерные сети", kind: "lab", due: h(20), notes: "", done: false, created: 1 },
    { id: "d2", title: "Отчёт по курсовому, глава 1", subject: "Системный анализ и проектир. информац. систем", kind: "course", due: h(24 * 5), notes: "", done: false, created: 2 },
    { id: "d3", title: "ДЗ: распределение Пуассона", subject: "Теория вероятностей и математ. статистика", kind: "hw", due: h(-5), notes: "", done: false, created: 3 },
    { id: "d4", title: "Сдать лабу 2 по ОКП", subject: "Основы конструирования программ", kind: "lab", due: h(-48), notes: "", done: true, created: 4 },
  ];
}

const DEMO_STUDY = {
  getCoursesData: {
    "1": { "1": [{ course_id: "35848", course_name_ru: "Математический анализ" }, { course_id: "37187", course_name_ru: "Основы алгоритмизации и программирования" }], "2": [{ course_id: "38146", course_name_ru: "Основы компьютерной графики" }] },
    "2": { "3": [{ course_id: "52880", course_name_ru: "Скриптовые языки программирования" }, { course_id: "52873", course_name_ru: "Основы машинного обучения" }, { course_id: "54559", course_name_ru: "Экономика организаций сектора ИКТ" }, { course_id: "53407", course_name_ru: "Курсовой проект «Системный анализ и проектирование ИС»" }], "4": [] },
  },
  getChoosenCourses: { student: { FIO_R: "Иванов Иван Иванович", N_ZACH: "2025-0001 ", KURS: "2", N_GRYP: "СДП-ИСИТ-251", NAME_SPEC: "Информационные системы и технологии (6-05-0611-01)", N_VOB: "дневная", N_OTDEL: " экономики и управления" } },
  getProgress: [
    { DOCEN: "07.07.2026", NPOCEN: "Учебная практика", NDISC: "Ознакомительная практика", OCENS: "9(девять)", FIO_TN: "ПЕТРОВ Ю.Г." },
    { DOCEN: "19.06.2026", NPOCEN: "Экзамен", NDISC: "Иностранный язык (английский)", OCENS: "10(десять)", FIO_TN: "СИДОРОВА А.С." },
    { DOCEN: "15.06.2026", NPOCEN: "Экзамен", NDISC: "Основы алгоритмизации и программирования", OCENS: "6(шесть)", FIO_TN: "КУЗНЕЦОВА Е.Н." },
    { DOCEN: "10.06.2026", NPOCEN: "Экзамен", NDISC: "Математический анализ", OCENS: "7(семь)", FIO_TN: "ОРЛОВ В.И." },
    { DOCEN: "25.05.2026", NPOCEN: "Зачет", NDISC: "Объектно-ориентированное проектирование и программирование", OCENS: "зачтено", FIO_TN: "СМИРНОВ И.И." },
    { DOCEN: "22.01.2026", NPOCEN: "Экзамен", NDISC: "Дискретная математика", OCENS: "8(восемь)", FIO_TN: "ОРЛОВ В.И." },
    { DOCEN: "16.01.2026", NPOCEN: "Экзамен", NDISC: "История белорусской государственности", OCENS: "9(девять)", FIO_TN: "ВОЛКОВ А.А." },
  ],
  getAttestation: [
    { SEMESTR: "2", NAME_DISC: "Математический анализ", OCEN: "3", childs: [{ NN: "1", DOCEN: "01.06.2026", OCEN: "3" }] },
    { SEMESTR: "2", NAME_DISC: "Основы алгоритмизации и программирования", OCEN: "4", childs: [{ NN: "1", DOCEN: "12.06.2026", OCEN: "4" }] },
    { SEMESTR: "2", NAME_DISC: "Введение в разработку ПО", OCEN: "зачтено", childs: [{ NN: "1", DOCEN: "27.05.2026", OCEN: "зачтено" }] },
  ],
  getStatistics: [{ year: "2025/2026", sections: [], general: { total_score: "112", letter: "B", preliminary: "1", place_fac: "0", place_univ: "0" } }],
  getLibrary: { status: 200, data: [
    { N_PR: "Теория вероятностей и математическая статистика", AVTOR: "Ляликова В. И., Зенькова А. В.", N_SAVE: "Филиал № 6 (ф-т экономики и управления)", ADR_SAVE: "ул. Гаспадарчая, 23 — 217, 218", N_DATA: "07.09.26", K_DATA: "12.01.27" },
    { N_PR: "Беларуская мова. Прафесійная лексіка", AVTOR: "Асіпчук А. М. и др.", N_SAVE: "Филиал № 6 (ф-т экономики и управления)", ADR_SAVE: "ул. Гаспадарчая, 23", N_DATA: "07.09.26", K_DATA: "05.11.26" },
  ] },
  getHostel: { status: 200, data: { N_OTDEL: "Общежитие №3", ADRESS: "230015 Гродно БЛК 3", NKW: "98", itogo: "0.00", peny: "0.00", date2: "22.09.2025" } },
  getStudentOrders: [
    { N_PRIKAZ: "расп. 2", NTYPE: "Перевести на 2 семестр", D_PRIKAZ: "26.01.2026", SODER: "Перевести студента 1 курса факультета экономики и управления на 2 семестр." },
    { N_PRIKAZ: "1024-с", NTYPE: "Зачислить", D_PRIKAZ: "01.08.2025", SODER: "Зачислить на 1 курс дневной формы получения образования." },
  ],
  getGroups: [{ GROUPINFO: { N_GRYP: "СДП-ИСИТ-251", T_GRYP: "учебная группа" }, LIST: ["Алексеев А.", "Белова Б.", "Иванов Иван Иванович", "Григорьев Г.", "Дмитриева Д.", "Егоров Е."].map((FIO, i) => ({ FIO, N_ZACH: String(i) })) }],
  getGradeBookMarkup: { error: 0, data: { title: "<h2 style='text-align:center'>Зачётная книжка</h2><p style='text-align:center'>Иванов Иван Иванович · 2025-0001</p><table border=1 cellpadding=6 style='border-collapse:collapse;width:100%'><tr><td>Дискретная математика</td><td>8 (восемь)</td><td>22.01.2026</td></tr><tr><td>Иностранный язык</td><td>10 (десять)</td><td>19.06.2026</td></tr></table>" } },
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
    load: async (k) => get(k),
    save: async (k, v) => set(k, v),
    syncInfo: async () => ({ role: "server", ip: "192.168.0.5", port: 47321, pin: "482913" }),
    syncNow: async () => { throw new Error("в демо синхронизации нет"); },
  };
}
