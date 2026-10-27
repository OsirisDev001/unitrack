//! Публичный API ГрГУ (api.grsu.by) — тот же, что у MyGRSU. Только чтение, без пароля:
//! личное расписание за любую неделю и справочник преподавателей с полными ФИО.

use std::{fs, path::Path, sync::LazyLock, time::Duration};

use regex::Regex;

const BASE: &str = "https://api.grsu.by/1.x/";
/// Справочник преподавателей обновляем раз в неделю.
const TEACHERS_TTL: Duration = Duration::from_secs(7 * 24 * 3600);

static RE_ISO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d{4})-(\d{2})-(\d{2})$").unwrap());

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
async fn student_id(dir: &Path, login: &str) -> Result<String, String> {
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
    let _ = fs::write(week_file(dir, monday), &raw);
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

/// Личное — удаляем при выходе из аккаунта. Справочник преподавателей общий, его оставляем.
pub fn forget_personal(dir: &Path) {
    let _ = fs::remove_file(dir.join("public_student.json"));
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with("week_") {
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
    }
}

#[cfg(test)]
mod live {
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
    }
}
