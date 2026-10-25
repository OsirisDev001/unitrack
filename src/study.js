// Разбор ответов раздела «Учёба» (custom-api кабинета edu.grsu.by). Без DOM — тестируется в node.
import { parseRuDate, semesterOf } from "./logic.js";

const str = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

/** "СТЕПИН Ю.Г." -> "Степин Ю.Г." */
export function prettyName(s) {
  return str(s).replace(/[А-ЯЁA-Z]{2,}/g, (w) => w[0] + w.slice(1).toLowerCase());
}

/** "07.09.26" или "07.09.2026" -> Date */
export function parseShortDate(s) {
  const [d, m, y] = str(s).split(".").map(Number);
  if (!d || !m || !y) return null;
  return new Date(y < 100 ? 2000 + y : y, m - 1, d);
}

/** "9(девять)" -> 9, "зачтено" -> null */
export function gradeNumber(s) {
  const m = str(s).match(/^(\d{1,2})/);
  return m ? Number(m[1]) : null;
}

export function average(nums) {
  const xs = nums.filter((n) => typeof n === "number");
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null;
}

// ---------- успеваемость (сессии) ----------

export function normalizeProgress(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      const date = parseRuDate(r.DOCEN);
      const grade = str(r.OCENS || r.OCEN_STROKA);
      return {
        date,
        kind: str(r.NPOCEN),
        subject: str(r.NDISC),
        grade,
        gradeNum: gradeNumber(grade),
        teacher: prettyName(r.FIO_TN),
        semester: semesterOf(date),
      };
    })
    .filter((x) => x.subject && !Number.isNaN(x.date.getTime()))
    .sort((a, b) => b.date - a.date);
}

/** Сессии по семестрам, новые сверху, со средним баллом. */
export function progressBySemester(items) {
  const map = new Map();
  for (const it of items) {
    if (!map.has(it.semester.key)) map.set(it.semester.key, { ...it.semester, items: [] });
    map.get(it.semester.key).items.push(it);
  }
  return [...map.values()]
    .sort((a, b) => (a.key < b.key ? 1 : -1))
    .map((g) => ({ ...g, avg: average(g.items.map((i) => i.gradeNum)) }));
}

// ---------- промежуточная аттестация ----------

export function normalizeAttestation(raw) {
  if (!Array.isArray(raw)) return [];
  const map = new Map();
  for (const r of raw) {
    const sem = Number(r.SEMESTR) || 0;
    if (!map.has(sem)) map.set(sem, { semester: sem, items: [] });
    map.get(sem).items.push({
      subject: str(r.NAME_DISC),
      result: str(r.OCEN),
      attempts: (Array.isArray(r.childs) ? r.childs : []).map((c) => ({ n: Number(c.NN) || 1, date: str(c.DOCEN), result: str(c.OCEN) })),
    });
  }
  return [...map.values()].sort((a, b) => b.semester - a.semester);
}

// ---------- рейтинг ----------

export function normalizeRating(raw) {
  if (!Array.isArray(raw)) return null;
  const cur = raw.find((y) => y && y.general && typeof y.general === "object");
  if (!cur) return null;
  const g = cur.general;
  return {
    year: str(cur.year),
    score: Number(g.total_score) || 0,
    letter: str(g.letter),
    preliminary: g.preliminary === "1",
    placeFaculty: Number(g.place_fac) || null,
    placeUniversity: Number(g.place_univ) || null,
  };
}

// ---------- библиотека ----------

export function normalizeLibrary(raw, now = new Date()) {
  const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
  return list
    .map((b) => {
      const due = parseShortDate(b.K_DATA);
      const daysLeft = due ? Math.ceil((due - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5) : null;
      return {
        title: str(b.N_PR),
        author: str(b.AVTOR),
        issued: parseShortDate(b.N_DATA),
        due,
        daysLeft,
        place: str(b.N_SAVE),
        address: str(b.ADR_SAVE),
        inv: str(b.I_N),
      };
    })
    .filter((b) => b.title)
    .sort((a, b) => (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity));
}

// ---------- общежитие ----------

export function normalizeHostel(raw) {
  const d = raw?.data;
  if (!d || typeof d !== "object") return null;
  return {
    name: str(d.N_OTDEL),
    address: str(d.ADRESS),
    room: str(d.NKW),
    debt: Number(String(d.itogo ?? d.SUMMA ?? "0").replace(",", ".")) || 0,
    penalty: Number(String(d.peny ?? "0").replace(",", ".")) || 0,
    lastPayment: str(d.date2),
    period: str(d.date),
  };
}

// ---------- приказы ----------

export function normalizeOrders(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o) => ({
      number: str(o.N_PRIKAZ),
      type: str(o.NTYPE),
      date: parseRuDate(o.D_PRIKAZ),
      dateText: str(o.D_PRIKAZ),
      text: str(o.SODER),
    }))
    .sort((a, b) => b.date - a.date);
}

// ---------- группы ----------

export function normalizeGroups(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((g) => ({
    name: str(g.GROUPINFO?.N_GRYP),
    type: str(g.GROUPINFO?.T_GRYP),
    members: (Array.isArray(g.LIST) ? g.LIST : [])
      .map((m) => ({ name: str(m.FIO), book: str(m.N_ZACH) }))
      .filter((m) => m.name)
      .sort((a, b) => a.name.localeCompare(b.name, "ru")),
  }));
}

// ---------- профиль ----------

export function normalizeProfile(raw) {
  const s = raw?.student;
  if (!s || typeof s !== "object") return null;
  const faculty = str(s.N_OTDEL);
  return {
    fio: str(s.FIO_R),
    group: str(s.N_GRYP),
    course: str(s.KURS),
    book: str(s.N_ZACH),
    speciality: str(s.NAME_SPEC),
    form: str(s.N_VOB),
    faculty: faculty ? `Факультет ${faculty}` : "",
    facultyShort: str(s.N_OTDEL_SOKR),
  };
}

export function initials(fio) {
  const p = str(fio).split(" ");
  return ((p[1]?.[0] || "") + (p[0]?.[0] || "")).toUpperCase() || "?";
}

/** Короткое ФИО: «Иванов И. И.» */
export function shortFio(fio) {
  const [last, first, mid] = str(fio).split(" ");
  if (!last) return "";
  return [last, first ? `${first[0]}.` : "", mid ? `${mid[0]}.` : ""].filter(Boolean).join(" ");
}

// ---------- зачётка ----------

/** Сайт отдаёт зачётку готовым HTML: собираем все HTML-куски из data в один документ. */
export function gradebookHtml(raw) {
  const d = raw?.data;
  if (!d) return "";
  const parts = typeof d === "string" ? [d] : Object.values(d).filter((v) => typeof v === "string");
  return parts.join("\n");
}

// ---------- курсы образовательной платформы ----------

/** Ответ getCoursesData: { "<курс>": { "<семестр>": [ {course_id, course_name_ru, ...} ] } } */
export function normalizeCourses(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw)
    .map(([kurs, sems]) => ({
      kurs: Number(kurs) || 0,
      semesters: Object.entries(sems && typeof sems === "object" ? sems : {})
        .map(([sem, list]) => ({
          semester: Number(sem) || 0,
          items: (Array.isArray(list) ? list : [])
            .map((c) => ({ id: str(c.course_id), name: str(c.course_name_ru || c.course_name_by || c.course_name_en) }))
            .filter((c) => c.id && c.name)
            .sort((a, b) => a.name.localeCompare(b.name, "ru")),
        }))
        .filter((s) => s.items.length)
        .sort((a, b) => a.semester - b.semester),
    }))
    .filter((k) => k.semesters.length)
    .sort((a, b) => a.kurs - b.kurs);
}

export const courseUrl = (id) => `https://edu.grsu.by/course/view.php?id=${encodeURIComponent(id)}`;

/** Текущий семестр по номеру курса: осенью нечётный, весной чётный. */
export function currentSemesterNumber(kurs, now = new Date()) {
  const m = now.getMonth() + 1;
  const autumn = m >= 9 || m === 1;
  return autumn ? kurs * 2 - 1 : kurs * 2;
}
