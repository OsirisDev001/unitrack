//! Публичный API ГрГУ (api.grsu.by) — тот же, что у MyGRSU. Только чтение, без пароля:
//! личное расписание за любую неделю и справочник преподавателей с полными ФИО.

use std::{fs, path::Path, sync::LazyLock, time::Duration};

use regex::Regex;

const BASE: &str = "https://api.grsu.by/1.x/";
/// Справочник преподавателей обновляем раз в неделю.
const TEACHERS_TTL: Duration = Duration::from_secs(7 * 24 * 3600);

static RE_ISO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d{4})-(\d{2})-(\d{2})$").unwrap());
static RE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{1,12}$").unwrap());
static RE_LOGIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.\-]{2,64}$").unwrap());

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .user_agent("UniTrack")
        .build()
        .expect("не удалось создать HTTP-клиент")
}

/// GET к фиксированному методу API; ответ обязан быть JSON.
async fn get(path: &str, query: &[(&str, String)]) -> Result<String, String> {
    let text = client()
        .get(format!("{BASE}{path}"))
        .query(query)
        .send()
        .await
        .map_err(crate::net_err)?
        .error_for_status()
        .map_err(|e| format!("api.grsu.by ответил ошибкой {}", e.status().map_or(0, |s| s.as_u16())))?
        .text()
        .await
        .map_err(crate::net_err)?;
    serde_json::from_str::<serde_json::Value>(&text).map_err(|_| "api.grsu.by вернул не то, что ожидалось".to_string())?;
    Ok(text)
}

/// «2026-10-26» → «26.10.2026». Всё остальное отвергаем.
pub fn api_date(iso: &str) -> Option<String> {
    let c = RE_ISO.captures(iso)?;
    let (m, d): (u32, u32) = (c[2].parse().ok()?, c[3].parse().ok()?);
    ((1..=12).contains(&m) && (1..=31).contains(&d)).then(|| format!("{}.{}.{}", &c[3], &c[2], &c[1]))
}

/// id студента по логину — ищем один раз и запоминаем.
pub async fn student_id(dir: &Path, login: &str) -> Result<String, String> {
    let file = dir.join("public_student.json");
    if let Some(id) = fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .filter(|v| v["login"].as_str() == Some(login))
        .and_then(|v| v["id"].as_str().map(String::from))
    {
        return Ok(id);
    }
    let raw = get("app1/getStudent", &[("login", login.to_string())]).await?;
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
    let id = match &v["id"] {
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) if s.chars().all(|c| c.is_ascii_digit()) && !s.is_empty() => s.clone(),
        _ => return Err("Не нашёл тебя в расписании ГрГУ по логину".into()),
    };
    let _ = fs::write(&file, serde_json::json!({ "login": login, "id": id }).to_string());
    Ok(id)
}

fn week_file(dir: &Path, monday: &str) -> std::path::PathBuf {
    dir.join(format!("week_{monday}.json"))
}

/// Личное расписание на неделю [monday; sunday] с сайта; сохраняется для истории и офлайна.
pub async fn fetch_week(dir: &Path, login: &str, monday: &str, sunday: &str) -> Result<String, String> {
    let (start, end) = match (api_date(monday), api_date(sunday)) {
        (Some(a), Some(b)) => (a, b),
        _ => return Err("Плохая дата недели".into()),
    };
    let id = student_id(dir, login).await?;
    let raw = get(
        "app1/getGroupSchedule",
        &[("studentId", id), ("dateStart", start), ("dateEnd", end)],
    )
    .await?;
    keep_or_write(&week_file(dir, monday), raw)
}

/// Есть ли в ответе хоть одна пара.
fn has_lessons(raw: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|v| v.get("days").and_then(|d| d.as_array()).cloned())
        .map(|days| days.iter().any(|d| d.get("lessons").and_then(|l| l.as_array()).is_some_and(|l| !l.is_empty())))
        .unwrap_or(false)
}

/// Сохраняем свежую неделю, но не затираем сохранённые пары пустым ответом: при сбое сайт может отдать
/// пустую неделю, а прошлые недели повторно не скачиваются — копия пропала бы насовсем.
/// Такой ответ считаем ошибкой сети: приложение покажет сохранённое и попробует позже.
fn keep_or_write(file: &Path, raw: String) -> Result<String, String> {
    if !has_lessons(&raw) && fs::read_to_string(file).is_ok_and(|old| has_lessons(&old)) {
        return Err("Сайт вернул пустую неделю — оставляю сохранённую".into());
    }
    let _ = fs::write(file, &raw);
    Ok(raw)
}

pub fn cached_week(dir: &Path, monday: &str) -> Option<String> {
    api_date(monday)?;
    fs::read_to_string(week_file(dir, monday)).ok()
}

/// Справочник преподавателей: из кэша, если он свежий, иначе с сайта.
pub async fn teachers(dir: &Path) -> Result<String, String> {
    let file = dir.join("public_teachers.json");
    let fresh = fs::metadata(&file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < TEACHERS_TTL);
    if fresh {
        if let Ok(s) = fs::read_to_string(&file) {
            return Ok(s);
        }
    }
    match get("app2/getTeachers", &[]).await {
        Ok(raw) => {
            let _ = fs::write(&file, &raw);
            Ok(raw)
        }
        // Нет сети — старый справочник лучше, чем никакого.
        Err(e) => fs::read_to_string(&file).map_err(|_| e),
    }
}

pub fn cached_teachers(dir: &Path) -> Option<String> {
    fs::read_to_string(dir.join("public_teachers.json")).ok()
}

// ---------- поиск и чужие расписания ----------

/// Чьё расписание: студент (по id), группа или преподаватель.
#[derive(Clone, Copy)]
pub enum Kind {
    Student,
    Group,
    Teacher,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "student" => Some(Self::Student),
            "group" => Some(Self::Group),
            "teacher" => Some(Self::Teacher),
            _ => None,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Student => "student",
            Self::Group => "group",
            Self::Teacher => "teacher",
        }
    }
}

fn sched_file(dir: &Path, kind: Kind, id: &str, monday: &str) -> std::path::PathBuf {
    dir.join(format!("sched_{}_{id}_{monday}.json", kind.name()))
}

/// Найти студента по логину: ФИО, группа, id для расписания.
pub async fn lookup_student(login: &str) -> Result<String, String> {
    let login = login.trim();
    if !RE_LOGIN.is_match(login) {
        return Err("Логин выглядит как Ivanov_II_25 — латиница, цифры и _".into());
    }
    let raw = get("app1/getStudent", &[("login", login.to_string())]).await?;
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
    let found = match &v["id"] {
        serde_json::Value::Number(n) => n.as_u64().unwrap_or(0) > 0,
        serde_json::Value::String(s) => s != "0" && !s.is_empty(),
        _ => false,
    };
    if !found {
        return Err("Студента с таким логином нет".into());
    }
    Ok(raw)
}

/// Расписание студента / группы / преподавателя на неделю; сохраняется для офлайна.
pub async fn fetch_schedule(dir: &Path, kind: Kind, id: &str, monday: &str, sunday: &str) -> Result<String, String> {
    let (start, end) = match (api_date(monday), api_date(sunday)) {
        (Some(a), Some(b)) => (a, b),
        _ => return Err("Плохая дата недели".into()),
    };
    if !RE_ID.is_match(id) {
        return Err("Плохой id".into());
    }
    let (path, key) = match kind {
        Kind::Student => ("app1/getGroupSchedule", "studentId"),
        Kind::Group => ("app1/getGroupSchedule", "groupId"),
        Kind::Teacher => ("app1/getTeacherSchedule", "teacherId"),
    };
    let raw = get(path, &[(key, id.to_string()), ("dateStart", start), ("dateEnd", end)]).await?;
    keep_or_write(&sched_file(dir, kind, id, monday), raw)
}

pub fn cached_schedule(dir: &Path, kind: Kind, id: &str, monday: &str) -> Option<String> {
    api_date(monday)?;
    RE_ID.is_match(id).then_some(())?;
    fs::read_to_string(sched_file(dir, kind, id, monday)).ok()
}

/// Справочники для каталога групп. Меняются редко — храним, сеть только если кэша нет или он старше недели.
async fn cached_get(dir: &Path, file: &str, path: &str, query: &[(&str, String)]) -> Result<String, String> {
    let f = dir.join(file);
    let fresh = fs::metadata(&f)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < TEACHERS_TTL);
    if fresh {
        if let Ok(s) = fs::read_to_string(&f) {
            return Ok(s);
        }
    }
    match get(path, query).await {
        Ok(raw) => {
            let _ = fs::write(&f, &raw);
            Ok(raw)
        }
        Err(e) => fs::read_to_string(&f).map_err(|_| e),
    }
}

pub async fn faculties(dir: &Path) -> Result<String, String> {
    cached_get(dir, "public_faculties.json", "app1/getFaculties", &[]).await
}

/// Группы факультета на курсе (дневная форма).
pub async fn groups(dir: &Path, faculty: &str, course: u8) -> Result<String, String> {
    if !RE_ID.is_match(faculty) || !(1..=6).contains(&course) {
        return Err("Плохой факультет или курс".into());
    }
    cached_get(
        dir,
        &format!("public_groups_{faculty}_{course}.json"),
        "app1/getGroups",
        &[("facultyId", faculty.to_string()), ("departmentId", "2".into()), ("course", course.to_string())],
    )
    .await
}

/// Личное — удаляем при выходе из аккаунта. Справочник преподавателей общий, его оставляем.
pub fn forget_personal(dir: &Path) {
    let _ = fs::remove_file(dir.join("public_student.json"));
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with("week_") || name.starts_with("sched_") || name.starts_with("perf_") {
                let _ = fs::remove_file(e.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_strict() {
        assert_eq!(api_date("2026-10-26").as_deref(), Some("26.10.2026"));
        assert_eq!(api_date("2026-13-01"), None);
        assert_eq!(api_date("2026-10-26&x=1"), None);
        assert_eq!(api_date("../../etc"), None);
        assert_eq!(cached_week(Path::new("/nonexistent"), "../secret"), None);
        assert!(RE_LOGIN.is_match("Ivanov_II_25"));
        assert!(!RE_LOGIN.is_match("a&b=c"));
        assert!(!RE_ID.is_match("1;2"));
        assert_eq!(cached_schedule(Path::new("/nonexistent"), Kind::Group, "../x", "2026-10-26"), None);
    }
}

#[cfg(test)]
mod live {
    #[test]
    fn empty_week_never_overwrites_saved_lessons() {
        use super::keep_or_write;
        use std::fs;
        let dir = std::env::temp_dir().join(format!("unitrack-keep-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let f = dir.join("week_test.json");
        let full = r#"{"days":[{"date":"2026-11-09","lessons":[{"title":"Сети"}]}]}"#.to_string();
        let empty = r#"{"days":[{"date":"2026-11-09","lessons":[]}]}"#.to_string();
        let _ = fs::remove_file(&f);
        assert!(keep_or_write(&f, empty.clone()).is_ok()); // сохранённого нет — пустую неделю пишем
        assert!(keep_or_write(&f, full.clone()).is_ok());
        assert!(keep_or_write(&f, empty).is_err()); // пары не затираем
        assert_eq!(fs::read_to_string(&f).unwrap(), full);
        assert!(keep_or_write(&f, r#"{"days":[]}"#.to_string()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    /// Реальный запрос к api.grsu.by: `UNITRACK_LOGIN=... cargo test -- --ignored live`
    #[tokio::test]
    #[ignore]
    async fn live_week_and_teachers() {
        let login = std::env::var("UNITRACK_LOGIN").expect("UNITRACK_LOGIN");
        let dir = std::env::temp_dir().join("unitrack-live");
        let _ = std::fs::create_dir_all(&dir);
        let w = super::fetch_week(&dir, &login, "2026-10-12", "2026-10-18").await.unwrap();
        let v: serde_json::Value = serde_json::from_str(&w).unwrap();
        println!("days={} first={}", v["days"].as_array().map_or(0, |a| a.len()), v["days"][0]["date"]);
        let t = super::teachers(&dir).await.unwrap();
        let tv: serde_json::Value = serde_json::from_str(&t).unwrap();
        println!("teachers={}", tv["items"].as_array().map_or(0, |a| a.len()));
        assert!(super::cached_week(&dir, "2026-10-12").is_some());
        let st = super::lookup_student(&login).await.unwrap();
        assert!(st.contains("k_sgryp"));
        assert!(super::lookup_student("nonexistent_xx_99").await.is_err());
        // Любой преподаватель из справочника — его расписание за текущую неделю должно прийти.
        let first_id = tv["items"][0]["id"].as_str().unwrap().to_string();
        assert!(super::fetch_schedule(&dir, super::Kind::Teacher, &first_id, "2026-10-26", "2026-11-01").await.is_ok());
        let g = super::groups(&dir, "30", 2).await.unwrap();
        assert!(g.contains("items"));
        assert!(super::faculties(&dir).await.unwrap().contains("Факультет"));
    }
}
