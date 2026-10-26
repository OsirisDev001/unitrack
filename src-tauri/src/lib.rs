//! Бэкенд UniTrack: логин в Moodle ГрГУ, запросы к custom-api и локальное хранилище.

use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        LazyLock, Mutex,
    },
    time::Duration,
};

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

mod sync;

const LOGIN_URL: &str = "https://edu.grsu.by/login/index.php";
const API_URL: &str = "https://edu.grsu.by/custom-components/custom-api/ajax-router.php";

/// Методы API, которые приложению разрешено вызывать.
const ALLOWED_METHODS: &[&str] = &[
    "getSkips",
    "getStudentSchedule",
    // раздел «Учёба» — всё только чтение
    "getProgress",
    "getAttestation",
    "getGradeBookMarkup",
    "getStatistics",
    "getLibrary",
    "getHostel",
    "getStudentOrders",
    "getGroups",
    "getChoosenCourses",
    "getCoursesData",
];

const OFFLINE_MSG: &str =
    "Если включён VPN — добавь UniTrack в исключения или выключи VPN.";

static RE_FORM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<form\b([^>]*)>(.*?)</form>").unwrap());
static RE_INPUT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<input\b[^>]*>").unwrap());
/// Ошибка входа: Moodle (loginerrormessage) или SimpleSAMLphp (блок с классом error).
static RE_LOGIN_ERR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)(?:id="loginerrormessage"|class="[^"]*(?:error|alert)[^"]*")[^>]*>\s*(?:<[^>]+>\s*)*([^<]{3,})"#).unwrap()
});
static RE_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z_]{1,32}$").unwrap());

#[derive(Serialize, Deserialize, Clone)]
struct Credentials {
    username: String,
    password: String,
}

struct AppState {
    client: Mutex<reqwest::Client>,
    /// Номер текущей сессии: растёт после каждого успешного входа.
    session: AtomicU64,
    /// Входим строго по одному: параллельные входы с общими cookies ломают друг другу SAML.
    login_lock: tokio::sync::Mutex<()>,
    data_dir: PathBuf,
}

impl AppState {
    fn snapshot(&self) -> (reqwest::Client, u64) {
        (self.client.lock().unwrap().clone(), self.session.load(Ordering::SeqCst))
    }

    fn set_client(&self, client: reqwest::Client) {
        *self.client.lock().unwrap() = client;
        self.session.fetch_add(1, Ordering::SeqCst);
    }

    /// Перелогин после протухшей сессии. Если пока ждали очередь, кто-то другой уже вошёл —
    /// просто берём его сессию. Каждый вход — с чистыми cookies, как самый первый.
    async fn relogin(&self, creds: &Credentials, seen: u64) -> Result<(), String> {
        let _guard = self.login_lock.lock().await;
        if self.session.load(Ordering::SeqCst) != seen {
            return Ok(());
        }
        let fresh = new_client();
        if let Err(first) = moodle_login(&fresh, creds).await {
            // Сайт иногда отвечает формой входа повторно спросонья — одна повторная попытка.
            tokio::time::sleep(Duration::from_secs(2)).await;
            let again = new_client();
            moodle_login(&again, creds).await.map_err(|_| first)?;
            self.set_client(again);
            return Ok(());
        }
        self.set_client(fresh);
        Ok(())
    }
}

fn new_client() -> reqwest::Client {
    reqwest::Client::builder()
        .cookie_store(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .user_agent("Mozilla/5.0 (UniTrack)")
        .build()
        .expect("не удалось создать HTTP-клиент")
}

/// Понятная ошибка сети с технической причиной в скобках — чтобы по скрину было видно, что именно не так.
fn net_err(e: reqwest::Error) -> String {
    let host = e.url().and_then(|u| u.host_str()).unwrap_or("сайт").to_string();
    let mut chain = Vec::new();
    let mut src: Option<&dyn std::error::Error> = std::error::Error::source(&e);
    while let Some(s) = src {
        chain.push(s.to_string());
        src = s.source();
    }
    let detail = chain.last().cloned().unwrap_or_else(|| e.to_string());
    let low = detail.to_lowercase();
    if low.contains("certificate") || low.contains("tls") || low.contains("handshake") {
        format!("Не удалось установить защищённое соединение с {host} ({detail})")
    } else if e.is_timeout() {
        format!("{host} не ответил за 30 секунд. {OFFLINE_MSG}")
    } else if e.is_connect() {
        format!("Нет соединения с {host}. {OFFLINE_MSG} ({detail})")
    } else {
        format!("Ошибка сети при обращении к {host}: {detail}")
    }
}

// ---------- хранение логина/пароля ----------

#[cfg(windows)]
mod secrets {
    use super::Credentials;
    use std::path::Path;

    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new("UniTrack", "edu.grsu.by").map_err(|e| e.to_string())
    }

    pub fn save(_dir: &Path, c: &Credentials) -> Result<(), String> {
        let json = serde_json::to_string(c).map_err(|e| e.to_string())?;
        entry()?.set_password(&json).map_err(|e| e.to_string())
    }

    pub fn load(_dir: &Path) -> Option<Credentials> {
        let json = entry().ok()?.get_password().ok()?;
        serde_json::from_str(&json).ok()
    }

    pub fn clear(_dir: &Path) {
        if let Ok(e) = entry() {
            let _ = e.delete_credential();
        }
    }
}

/// На Android папка приложения закрыта от других приложений, храним там.
#[cfg(not(windows))]
mod secrets {
    use super::Credentials;
    use std::{fs, path::Path};

    fn file(dir: &Path) -> std::path::PathBuf {
        dir.join("credentials.json")
    }

    pub fn save(dir: &Path, c: &Credentials) -> Result<(), String> {
        let json = serde_json::to_string(c).map_err(|e| e.to_string())?;
        fs::write(file(dir), json).map_err(|e| e.to_string())
    }

    pub fn load(dir: &Path) -> Option<Credentials> {
        let json = fs::read_to_string(file(dir)).ok()?;
        serde_json::from_str(&json).ok()
    }

    pub fn clear(dir: &Path) {
        let _ = fs::remove_file(file(dir));
    }
}

// ---------- Moodle ----------

/// Одна HTML-форма: куда отправлять и какие поля в ней есть.
struct Form {
    action: reqwest::Url,
    fields: Vec<(String, String)>,
    password_field: Option<String>,
    user_field: Option<String>,
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let re = Regex::new(&format!(r#"(?i)\b{name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#)).ok()?;
    let c = re.captures(tag)?;
    let v = c.get(1).or(c.get(2)).or(c.get(3))?.as_str();
    Some(html_unescape(v))
}

fn html_unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#x3D;", "=")
        .replace("&#61;", "=")
        .replace("&#x2F;", "/")
        .replace("&amp;", "&")
}

/// Разбирает все формы на странице (без полноценного HTML-парсера, но для Moodle/SimpleSAMLphp хватает).
fn parse_forms(html: &str, base: &reqwest::Url) -> Vec<Form> {
    RE_FORM
        .captures_iter(html)
        .filter_map(|c| {
            let open = c.get(1)?.as_str();
            let body = c.get(2)?.as_str();
            let action = attr(open, "action").unwrap_or_default();
            let action = base.join(&action).ok()?;
            let mut fields = Vec::new();
            let mut password_field = None;
            let mut user_field = None;
            for m in RE_INPUT.find_iter(body) {
                let tag = m.as_str();
                let Some(name) = attr(tag, "name") else { continue };
                let ty = attr(tag, "type").unwrap_or_else(|| "text".into()).to_lowercase();
                match ty.as_str() {
                    "password" => password_field = Some(name),
                    "text" | "email" if user_field.is_none() => user_field = Some(name),
                    "submit" | "button" | "image" | "checkbox" | "radio" => {}
                    _ => fields.push((name, attr(tag, "value").unwrap_or_default())),
                }
            }
            Some(Form { action, fields, password_field, user_field })
        })
        .collect()
}

/// Пароль отправляем только на страницы входа ГрГУ по HTTPS — никуда больше, даже если сайт перенаправит.
const LOGIN_HOSTS: &[&str] = &["edu.grsu.by", "idp.grsu.by"];

fn is_trusted_login_target(url: &reqwest::Url) -> bool {
    url.scheme() == "https" && url.host_str().is_some_and(|h| LOGIN_HOSTS.contains(&h))
}

fn is_logged_in_url(url: &reqwest::Url) -> bool {
    url.host_str() == Some("edu.grsu.by") && !url.path().starts_with("/login") && !url.path().starts_with("/auth/")
}

/// Вход: Moodle перенаправляет на единый вход idp.grsu.by (SAML).
/// Идём по цепочке форм: форма логина -> автоформа с SAMLResponse -> обратно в Moodle.
async fn moodle_login(client: &reqwest::Client, c: &Credentials) -> Result<(), String> {
    let resp = client.get(LOGIN_URL).send().await.map_err(net_err)?;
    let mut url = resp.url().clone();
    let mut html = resp.text().await.map_err(net_err)?;
    let mut creds_sent_to: Vec<String> = Vec::new();

    for _ in 0..8 {
        if is_logged_in_url(&url) {
            return Ok(());
        }
        let forms = parse_forms(&html, &url);

        let next = if let Some(f) = forms.iter().find(|f| f.password_field.is_some()) {
            // Форма логина. Если уже отправляли сюда пароль и снова видим её — пароль неверный.
            let key = format!("{}{}", f.action.host_str().unwrap_or(""), f.action.path());
            if creds_sent_to.contains(&key) {
                let msg = RE_LOGIN_ERR
                    .captures(&html)
                    .map(|m| m[1].trim().to_string())
                    .filter(|s| !s.is_empty() && s.len() < 200)
                    .unwrap_or_else(|| "Неверный логин или пароль".to_string());
                return Err(msg);
            }
            if !is_trusted_login_target(&f.action) {
                return Err(format!(
                    "Форма входа ведёт на чужой адрес ({}). Пароль не отправлен.",
                    f.action.host_str().unwrap_or("?")
                ));
            }
            creds_sent_to.push(key);
            let mut fields = f.fields.clone();
            fields.push((f.user_field.clone().unwrap_or_else(|| "username".into()), c.username.clone()));
            fields.push((f.password_field.clone().unwrap(), c.password.clone()));
            (f.action.clone(), fields)
        } else if let Some(f) = forms.iter().find(|f| f.fields.iter().any(|(n, _)| n == "SAMLResponse" || n == "SAMLRequest")) {
            // Автоотправляемая форма SAML (в браузере её жмёт JavaScript).
            if !is_trusted_login_target(&f.action) {
                return Err("Ответ единого входа ведёт на чужой адрес. Вход остановлен.".into());
            }
            (f.action.clone(), f.fields.clone())
        } else {
            return Err("Не удалось пройти вход на сайте ГрГУ: страница входа изменилась. Напиши разработчику.".into());
        };

        let resp = client.post(next.0).form(&next.1).send().await.map_err(net_err)?;
        url = resp.url().clone();
        html = resp.text().await.map_err(net_err)?;
    }
    Err("Слишком длинная цепочка входа. Попробуй ещё раз.".into())
}

async fn api_call(client: &reqwest::Client, method: &str) -> Result<Option<String>, String> {
    let text = client
        .post(API_URL)
        .form(&[("method", method), ("args", "production")])
        .send()
        .await
        .map_err(net_err)?
        .text()
        .await
        .map_err(net_err)?;

    // Если сессия протухла, сервер вернёт HTML вместо JSON.
    if serde_json::from_str::<serde_json::Value>(&text).is_ok() {
        Ok(Some(text))
    } else {
        Ok(None)
    }
}

// ---------- команды для интерфейса ----------

#[tauri::command]
async fn login(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<(), String> {
    let creds = Credentials {
        username: username.trim().to_string(),
        password,
    };
    let client = new_client();
    let _guard = state.login_lock.lock().await;
    moodle_login(&client, &creds).await?;
    secrets::save(&state.data_dir, &creds)?;
    state.set_client(client);
    Ok(())
}

#[tauri::command]
fn saved_username(state: State<'_, AppState>) -> Option<String> {
    secrets::load(&state.data_dir).map(|c| c.username)
}

#[tauri::command]
fn logout(state: State<'_, AppState>) {
    secrets::clear(&state.data_dir);
    state.set_client(new_client());
    for m in ALLOWED_METHODS {
        let _ = fs::remove_file(state.data_dir.join(format!("cache_{m}.json")));
    }
}

/// Тянет данные с сайта. При протухшей сессии логинится заново и повторяет запрос.
#[tauri::command]
async fn fetch_api(state: State<'_, AppState>, method: String) -> Result<String, String> {
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err("Неизвестный метод".into());
    }
    let creds = secrets::load(&state.data_dir).ok_or("Нужно войти")?;
    let (client, seen) = state.snapshot();

    let data = match api_call(&client, &method).await? {
        Some(d) => d,
        None => {
            state.relogin(&creds, seen).await?;
            let (client, _) = state.snapshot();
            api_call(&client, &method)
                .await?
                .ok_or("Сайт вернул не то, что ожидалось. Попробуй позже.")?
        }
    };

    let _ = fs::write(state.data_dir.join(format!("cache_{method}.json")), &data);
    Ok(data)
}

/// Последний успешный ответ сайта — чтобы приложение открывалось мгновенно и без сети.
#[tauri::command]
fn cached_api(state: State<'_, AppState>, method: String) -> Option<String> {
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return None;
    }
    fs::read_to_string(state.data_dir.join(format!("cache_{method}.json"))).ok()
}

#[tauri::command]
fn load_data(state: State<'_, AppState>, key: String) -> Option<String> {
    if !RE_KEY.is_match(&key) {
        return None;
    }
    fs::read_to_string(state.data_dir.join(format!("data_{key}.json"))).ok()
}

#[tauri::command]
fn save_data(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    if !RE_KEY.is_match(&key) {
        return Err("Плохой ключ".into());
    }
    let _guard = (key == "tasks").then(|| sync::TASKS_LOCK.lock().unwrap());
    let path = state.data_dir.join(format!("data_{key}.json"));
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, value).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Что показать в настройках синхронизации: на ноуте — адрес и код, на телефоне — форму подключения.
#[tauri::command]
fn sync_info(state: State<'_, AppState>) -> sync::SyncInfo {
    if cfg!(mobile) {
        sync::SyncInfo { role: "client", ip: None, port: sync::PORT, pin: None }
    } else {
        sync::SyncInfo {
            role: "server",
            ip: sync::local_ip(),
            port: sync::PORT,
            pin: Some(sync::pin(&state.data_dir)),
        }
    }
}

#[derive(serde::Serialize)]
struct SyncResult {
    count: usize,
    address: String,
}

/// Телефон: найти ноутбук в сети, отправить свои задачи и забрать общий итог.
#[tauri::command]
async fn sync_now(state: State<'_, AppState>, last_address: Option<String>, pin: String) -> Result<SyncResult, String> {
    let (count, address) = sync::sync_auto(&state.data_dir, last_address, &pin).await?;
    Ok(SyncResult { count, address })
}

// ---------- обновления через GitHub Releases ----------

const REPO: &str = "OsirisDev001/unitrack";

#[derive(Serialize)]
struct UpdateInfo {
    current: String,
    latest: Option<String>,
    available: bool,
    notes: String,
    page: String,
    asset: Option<String>,
}

/// "0.10.2" > "0.9.9" — сравниваем числами, а не строкой.
fn version_newer(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim().trim_start_matches('v').split(['.', '-']).take(3).map(|x| x.parse().unwrap_or(0)).collect()
    };
    parse(latest) > parse(current)
}

fn release_asset_allowed(url: &str) -> bool {
    url.starts_with(&format!("https://github.com/{REPO}/releases/download/"))
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let page = format!("https://github.com/{REPO}/releases");
    let resp = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("UniTrack-updater")
        .build()
        .map_err(|e| e.to_string())?
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "Не удалось связаться с GitHub. Проверь интернет.".to_string())?;
    if resp.status().as_u16() == 404 {
        return Ok(UpdateInfo { current, latest: None, available: false, notes: String::new(), page, asset: None });
    }
    if !resp.status().is_success() {
        return Err(format!("GitHub ответил ошибкой {}", resp.status().as_u16()));
    }
    let v: serde_json::Value = serde_json::from_str(&resp.text().await.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let latest = v["tag_name"].as_str().unwrap_or("").trim_start_matches('v').to_string();
    let want = if cfg!(target_os = "android") { ".apk" } else { "-setup.exe" };
    let asset = v["assets"].as_array().and_then(|a| {
        a.iter()
            .filter_map(|x| x["browser_download_url"].as_str())
            .find(|u| u.ends_with(want) && release_asset_allowed(u))
            .map(String::from)
    });
    Ok(UpdateInfo {
        available: !latest.is_empty() && version_newer(&latest, &current),
        current,
        latest: (!latest.is_empty()).then_some(latest),
        notes: v["body"].as_str().unwrap_or("").chars().take(2000).collect(),
        page: v["html_url"].as_str().unwrap_or(&page).to_string(),
        asset,
    })
}

/// Скачивает файл релиза из этого репозитория.
async fn download_release(url: &str) -> Result<Vec<u8>, String> {
    let bytes = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .user_agent("UniTrack-updater")
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|_| "Не удалось скачать обновление. Проверь интернет.".to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|_| "Скачивание оборвалось. Попробуй ещё раз.".to_string())?;
    Ok(bytes.to_vec())
}

/// Обновление: Windows — скачать установщик и запустить его; Android — скачать APK
/// и показать системное окно установки. Данные приложения в обоих случаях сохраняются.
#[tauri::command]
async fn install_update(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !release_asset_allowed(&url) {
        return Err("Адрес обновления не из репозитория UniTrack".into());
    }
    #[cfg(windows)]
    {
        if !url.ends_with("-setup.exe") {
            return Err("Это не установщик UniTrack".into());
        }
        let bytes = download_release(&url).await?;
        // Настоящий установщик NSIS начинается с «MZ» и весит больше мегабайта.
        if bytes.len() < 1_000_000 || &bytes[..2] != b"MZ" {
            return Err("Скачанный файл не похож на установщик".into());
        }
        let path = std::env::temp_dir().join("UniTrack-update-setup.exe");
        fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        std::process::Command::new(&path).args(["/P", "/R"]).spawn().map_err(|e| e.to_string())?;
        app.exit(0);
        Ok(())
    }
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_apk_installer::{ApkInstallerExt, NEED_PERMISSION};
        if !url.ends_with(".apk") {
            return Err("Это не APK UniTrack".into());
        }
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("updates");
        let path = dir.join("UniTrack-update.apk");
        // Уже скачан в этом запуске (например, ждали разрешение на установку) — второй раз не качаем.
        if !(path.is_file() && app.state::<UpdateState>().same_url(&url)) {
            let bytes = download_release(&url).await?;
            // APK — это zip: начинается с «PK». Подпись Android проверит сам при установке.
            if bytes.len() < 1_000_000 || &bytes[..4] != b"PK\x03\x04" {
                return Err("Скачанный файл не похож на APK".into());
            }
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            fs::write(&path, &bytes).map_err(|e| e.to_string())?;
            app.state::<UpdateState>().remember(&url);
        }
        app.apk_installer().install(&path).map_err(|e| {
            if e.contains(NEED_PERMISSION) {
                "Разреши UniTrack устанавливать приложения (настройки уже открыты), вернись и нажми «Обновить» ещё раз".to_string()
            } else {
                e
            }
        })
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _ = (app, download_release);
        Err("Автообновление есть только на Windows и Android".into())
    }
}

/// Какой APK уже лежит в кэше — чтобы после выдачи разрешения не качать заново.
#[derive(Default)]
struct UpdateState(Mutex<Option<String>>);

impl UpdateState {
    #[allow(dead_code)]
    fn same_url(&self, url: &str) -> bool {
        self.0.lock().unwrap().as_deref() == Some(url)
    }
    #[allow(dead_code)]
    fn remember(&self, url: &str) {
        *self.0.lock().unwrap() = Some(url.to_string());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(UpdateState::default());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_apk_installer::init());
    builder
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            fs::create_dir_all(&dir)?;
            #[cfg(desktop)]
            {
                use tauri::Emitter;
                let handle = app.handle().clone();
                sync::start_server(dir.clone(), sync::PORT, move || {
                    let _ = handle.emit("tasks-updated", ());
                });
                sync::start_discovery_responder(sync::DISCOVERY_PORT, sync::PORT);
            }
            app.manage(AppState {
                client: Mutex::new(new_client()),
                session: AtomicU64::new(0),
                login_lock: tokio::sync::Mutex::new(()),
                data_dir: dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            login,
            saved_username,
            logout,
            fetch_api,
            cached_api,
            load_data,
            save_data,
            sync_info,
            sync_now,
            check_update,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("ошибка запуска UniTrack");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simplesaml_login_form() {
        let html = r#"<form action="?" method="post" name="f">
            <input id="username" type="text" name="username" value="">
            <input id="password" type="password" name="password">
            <input type="hidden" name="AuthState" value="_abc&amp;x=1">
            <button type="submit">Войти</button></form>"#;
        let base = reqwest::Url::parse("https://idp.grsu.by/simplesaml/module.php/core/loginuserpass.php?AuthState=old").unwrap();
        let f = &parse_forms(html, &base)[0];
        assert_eq!(f.action.as_str(), "https://idp.grsu.by/simplesaml/module.php/core/loginuserpass.php?");
        assert_eq!(f.user_field.as_deref(), Some("username"));
        assert_eq!(f.password_field.as_deref(), Some("password"));
        assert_eq!(f.fields, vec![("AuthState".to_string(), "_abc&x=1".to_string())]);
    }

    #[test]
    fn parses_saml_autopost() {
        let html = r#"<body onload="document.forms[0].submit()"><form method='post' action='https://edu.grsu.by/auth/saml2/sp/saml2-acs.php/edu.grsu.by'>
            <input type="hidden" name="SAMLResponse" value="PHNhbWw+" />
            <input type="hidden" name="RelayState" value="https://edu.grsu.by/my/" />
            <noscript><input type="submit" value="Submit" /></noscript></form></body>"#;
        let base = reqwest::Url::parse("https://idp.grsu.by/simplesaml/x").unwrap();
        let f = &parse_forms(html, &base)[0];
        assert_eq!(f.action.host_str(), Some("edu.grsu.by"));
        assert_eq!(f.fields.len(), 2);
        assert!(f.password_field.is_none());
    }

    #[test]
    fn versions_and_update_urls() {
        assert!(version_newer("0.10.0", "0.9.9"));
        assert!(version_newer("v0.2.0", "0.1.0"));
        assert!(!version_newer("0.2.0", "0.2.0"));
        assert!(!version_newer("0.1.9", "0.2.0"));
        assert!(release_asset_allowed("https://github.com/OsirisDev001/unitrack/releases/download/v0.2.0/UniTrack-setup.exe"));
        assert!(!release_asset_allowed("https://github.com/evil/unitrack/releases/download/v1/UniTrack-setup.exe"));
        assert!(!release_asset_allowed("https://evil.com/OsirisDev001/unitrack/releases/download/x.exe"));
    }

    #[test]
    fn password_goes_only_to_grsu() {
        let ok = |u: &str| is_trusted_login_target(&reqwest::Url::parse(u).unwrap());
        assert!(ok("https://idp.grsu.by/simplesaml/module.php/core/loginuserpass.php?"));
        assert!(ok("https://edu.grsu.by/login/index.php"));
        assert!(!ok("http://idp.grsu.by/login"), "только https");
        assert!(!ok("https://idp.grsu.by.evil.com/login"));
        assert!(!ok("https://evil.com/?edu.grsu.by"));
    }

    #[test]
    fn logged_in_detection() {
        assert!(is_logged_in_url(&reqwest::Url::parse("https://edu.grsu.by/my/").unwrap()));
        assert!(!is_logged_in_url(&reqwest::Url::parse("https://edu.grsu.by/login/index.php").unwrap()));
        assert!(!is_logged_in_url(&reqwest::Url::parse("https://idp.grsu.by/simplesaml/").unwrap()));
    }
}
