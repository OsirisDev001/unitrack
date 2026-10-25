//! Синхронизация задач между ноутом и телефоном по локальной сети, без облаков и без Moodle.
//!
//! Ноутбук держит маленький HTTP-сервер на порту 47321 и пускает только с PIN-кодом.
//! Телефон отправляет свои задачи, сервер сливает их со своими и возвращает итог.
//! Побеждает более свежая правка (поле `updated`), удаления передаются «надгробиями».

use std::{
    collections::BTreeMap,
    fs,
    net::UdpSocket,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use serde::Serialize;
use serde_json::Value;

pub const PORT: u16 = 47321;
/// UDP-порт для поиска ноутбука в сети: телефон спрашивает «UNITRACK?», ноутбук отвечает.
pub const DISCOVERY_PORT: u16 = 47322;
const HELLO: &[u8] = b"UNITRACK?";
const REPLY_PREFIX: &str = "UNITRACK!";
const TOMBSTONE_TTL_MS: f64 = 60.0 * 24.0 * 3600.0 * 1000.0;

/// Один замок на файл задач: его пишут и интерфейс, и сервер синхронизации.
pub static TASKS_LOCK: Mutex<()> = Mutex::new(());

pub fn tasks_path(dir: &Path) -> PathBuf {
    dir.join("data_tasks.json")
}

pub fn read_tasks(dir: &Path) -> Vec<Value> {
    fs::read_to_string(tasks_path(dir))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok())
        .unwrap_or_default()
}

pub fn write_tasks(dir: &Path, tasks: &[Value]) -> Result<(), String> {
    let path = tasks_path(dir);
    let tmp = path.with_extension("tmp");
    let json = serde_json::to_string(tasks).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn stamp(v: &Value) -> f64 {
    v.get("updated")
        .and_then(Value::as_f64)
        .or_else(|| v.get("created").and_then(Value::as_f64))
        .unwrap_or(0.0)
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Сливает два списка задач: по каждому id остаётся самая свежая версия.
pub fn merge(a: &[Value], b: &[Value]) -> Vec<Value> {
    let mut map: BTreeMap<String, Value> = BTreeMap::new();
    for v in a.iter().chain(b) {
        let Some(id) = v.get("id").and_then(Value::as_str) else { continue };
        match map.get(id) {
            Some(old) if stamp(old) >= stamp(v) => {}
            _ => {
                map.insert(id.to_string(), v.clone());
            }
        }
    }
    let cutoff = now_ms() - TOMBSTONE_TTL_MS;
    map.into_values()
        .filter(|v| !(v.get("deleted").and_then(Value::as_bool) == Some(true) && stamp(v) < cutoff))
        .collect()
}

/// PIN хранится в папке приложения и не меняется между запусками.
pub fn pin(dir: &Path) -> String {
    let path = dir.join("sync_pin.txt");
    if let Ok(p) = fs::read_to_string(&path) {
        let p = p.trim().to_string();
        if p.len() == 6 {
            return p;
        }
    }
    // Криптостойкий генератор ОС, а не время/pid.
    let mut b = [0u8; 8];
    let _ = getrandom::getrandom(&mut b);
    let n = u64::from_le_bytes(b) % 1_000_000;
    let p = format!("{n:06}");
    let _ = fs::write(&path, &p);
    p
}

/// Адрес в локальной сети. Пакет не отправляется — UDP «connect» только выбирает интерфейс.
pub fn local_ip() -> Option<String> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.168.1.1:80").ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then(|| ip.to_string())
}

/// Пускаем только устройства из домашней сети: 10/8, 172.16/12, 192.168/16, link-local, свой компьютер.
pub fn is_local_network(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        std::net::IpAddr::V6(v6) => {
            let seg = v6.segments()[0];
            v6.is_loopback() || (seg & 0xfe00) == 0xfc00 || (seg & 0xffc0) == 0xfe80
        }
    }
}

/// Сравнение кода без утечки по времени ответа.
fn same_secret(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Защита от подбора кода: после 5 ошибок подряд сервер минуту никого не пускает.
struct Lockout {
    fails: u32,
    until: Option<std::time::Instant>,
}

#[derive(Serialize)]
pub struct SyncInfo {
    pub role: &'static str,
    pub ip: Option<String>,
    pub port: u16,
    pub pin: Option<String>,
}

// ---------- сервер (только ноутбук) ----------

/// Отвечает на широковещательные запросы телефона своим HTTP-портом.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn start_discovery_responder(discovery_port: u16, http_port: u16) {
    std::thread::spawn(move || {
        let Ok(sock) = UdpSocket::bind(("0.0.0.0", discovery_port)) else { return };
        let reply = format!("{REPLY_PREFIX}{http_port}");
        let mut buf = [0u8; 64];
        while let Ok((n, from)) = sock.recv_from(&mut buf) {
            if &buf[..n] == HELLO && is_local_network(from.ip()) {
                let _ = sock.send_to(reply.as_bytes(), from);
            }
        }
    });
}

/// Ищет ноутбук в локальной сети. Возвращает "ip:port" первого ответившего.
pub fn discover(discovery_port: u16) -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.set_broadcast(true).ok()?;
    sock.set_read_timeout(Some(Duration::from_millis(700))).ok()?;
    let mut targets = vec![format!("255.255.255.255:{discovery_port}")];
    if let Some(ip) = local_ip() {
        // Широковещание в свою подсеть /24 — некоторые роутеры режут 255.255.255.255.
        if let Some((net, _)) = ip.rsplit_once('.') {
            targets.push(format!("{net}.255:{discovery_port}"));
        }
    }
    targets.push(format!("127.0.0.1:{discovery_port}"));
    let mut buf = [0u8; 64];
    for _ in 0..3 {
        for t in &targets {
            let _ = sock.send_to(HELLO, t);
        }
        if let Ok((n, from)) = sock.recv_from(&mut buf) {
            if let Some(port) = std::str::from_utf8(&buf[..n]).ok().and_then(|r| r.strip_prefix(REPLY_PREFIX)) {
                return Some(format!("{}:{}", from.ip(), port.trim()));
            }
        }
    }
    None
}

/// `on_change` вызывается после каждого слияния — интерфейс ноутбука перечитывает задачи.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn start_server(dir: PathBuf, port: u16, on_change: impl Fn() + Send + 'static) {
    std::thread::spawn(move || {
        let Ok(server) = tiny_http::Server::http(("0.0.0.0", port)) else { return };
        let json_header = tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap();
        let mut lock = Lockout { fails: 0, until: None };
        for mut req in server.incoming_requests() {
            if !req.remote_addr().map(|a| is_local_network(a.ip())).unwrap_or(false) {
                let _ = req.respond(tiny_http::Response::empty(403));
                continue;
            }
            if req.url() != "/sync" || *req.method() != tiny_http::Method::Post {
                let _ = req.respond(tiny_http::Response::empty(404));
                continue;
            }
            if lock.until.is_some_and(|t| std::time::Instant::now() < t) {
                let _ = req.respond(tiny_http::Response::empty(429));
                continue;
            }
            let ok_pin = req
                .headers()
                .iter()
                .find(|h| h.field.equiv("X-UniTrack-Pin"))
                .map(|h| same_secret(h.value.as_str(), &pin(&dir)))
                .unwrap_or(false);
            if !ok_pin {
                lock.fails += 1;
                if lock.fails >= 5 {
                    lock.until = Some(std::time::Instant::now() + Duration::from_secs(60));
                    lock.fails = 0;
                }
                let _ = req.respond(tiny_http::Response::empty(403));
                continue;
            }
            lock.fails = 0;
            let mut body = String::new();
            if std::io::Read::read_to_string(&mut std::io::Read::take(req.as_reader(), 5 << 20), &mut body).is_err() {
                let _ = req.respond(tiny_http::Response::empty(400));
                continue;
            }
            let Ok(remote) = serde_json::from_str::<Vec<Value>>(&body) else {
                let _ = req.respond(tiny_http::Response::empty(400));
                continue;
            };
            let merged = {
                let _g = TASKS_LOCK.lock().unwrap();
                let merged = merge(&read_tasks(&dir), &remote);
                let _ = write_tasks(&dir, &merged);
                merged
            };
            on_change();
            let out = serde_json::to_string(&merged).unwrap_or_else(|_| "[]".into());
            let _ = req.respond(tiny_http::Response::from_string(out).with_header(json_header.clone()));
        }
    });
}

// ---------- клиент (телефон) ----------

/// Синхронизация с ноутбуком: сначала по последнему известному адресу, если не вышло — ищем заново.
/// Возвращает (число задач, адрес, по которому получилось).
pub async fn sync_auto(dir: &Path, last_addr: Option<String>, pin: &str) -> Result<(usize, String), String> {
    if let Some(addr) = last_addr.filter(|a| !a.is_empty()) {
        match sync_with_port(dir, &addr, pin, PORT).await {
            Ok(n) => return Ok((n, addr)),
            Err(e) if e.contains("код") => return Err(e),
            Err(_) => {}
        }
    }
    let found = tauri::async_runtime::spawn_blocking(|| discover(DISCOVERY_PORT))
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Ноутбук не найден в сети. Он должен быть включён, UniTrack открыт, и оба устройства — в одной Wi-Fi сети.")?;
    let n = sync_with_port(dir, &found, pin, PORT).await?;
    Ok((n, found))
}

pub async fn sync_with_port(dir: &Path, address: &str, pin: &str, port: u16) -> Result<usize, String> {
    let addr = address.trim().trim_start_matches("http://").trim_end_matches('/');
    if addr.is_empty() {
        return Err("Укажи адрес ноутбука".into());
    }
    let url = if addr.contains(':') { format!("http://{addr}/sync") } else { format!("http://{addr}:{port}/sync") };
    let local = {
        let _g = TASKS_LOCK.lock().unwrap();
        read_tasks(dir)
    };
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .header("X-UniTrack-Pin", pin.trim())
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&local).map_err(|e| e.to_string())?)
        .send()
        .await
        .map_err(|_| "Ноутбук не найден. Он должен быть включён, UniTrack открыт, и оба устройства — в одной Wi-Fi сети.".to_string())?;
    match resp.status().as_u16() {
        200 => {}
        403 => return Err("Неверный код синхронизации".into()),
        429 => return Err("Слишком много неверных кодов. Подожди минуту и попробуй снова.".into()),
        s => return Err(format!("Ноутбук ответил ошибкой {s}")),
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let remote: Vec<Value> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let merged = merge(&local, &remote);
    {
        let _g = TASKS_LOCK.lock().unwrap();
        // За время запроса интерфейс мог сохранить новые правки — сливаем и с ними.
        let fresh = merge(&read_tasks(dir), &merged);
        write_tasks(dir, &fresh)?;
        Ok(fresh.iter().filter(|v| v.get("deleted").and_then(Value::as_bool) != Some(true)).count())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn newer_wins_and_tombstones_propagate() {
        let now = now_ms();
        let a = vec![
            json!({"id": "1", "title": "старое", "updated": now - 1000.0}),
            json!({"id": "2", "title": "есть только тут", "created": now}),
        ];
        let b = vec![
            json!({"id": "1", "title": "новое", "updated": now}),
            json!({"id": "3", "deleted": true, "updated": now}),
            json!({"id": "4", "deleted": true, "updated": now - TOMBSTONE_TTL_MS - 1.0}),
        ];
        let m = merge(&a, &b);
        let get = |id: &str| m.iter().find(|v| v["id"] == id).cloned();
        assert_eq!(get("1").unwrap()["title"], "новое");
        assert!(get("2").is_some());
        assert_eq!(get("3").unwrap()["deleted"], true);
        assert!(get("4").is_none(), "старые надгробия чистятся");
        assert_eq!(merge(&b, &a).len(), m.len(), "порядок не важен");
    }

    /// Живой обмен: «ноутбук» и «телефон» в разных папках через настоящий HTTP.
    #[test]
    fn end_to_end_over_http() {
        let base = std::env::temp_dir().join(format!("unitrack-test-{}", std::process::id()));
        let (laptop, phone) = (base.join("laptop"), base.join("phone"));
        fs::create_dir_all(&laptop).unwrap();
        fs::create_dir_all(&phone).unwrap();
        let now = now_ms();
        write_tasks(&laptop, &[json!({"id": "a", "title": "с ноута", "updated": now})]).unwrap();
        write_tasks(&phone, &[json!({"id": "b", "title": "с телефона", "updated": now})]).unwrap();
        let code = pin(&laptop);
        let (tx, rx) = std::sync::mpsc::channel();
        start_server(laptop.clone(), 47399, move || { let _ = tx.send(()); });
        std::thread::sleep(Duration::from_millis(300));

        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        assert!(rt.block_on(sync_with_port(&phone, "127.0.0.1", "000000x", 47399)).unwrap_err().contains("код"));
        let n = rt.block_on(sync_with_port(&phone, "127.0.0.1", &code, 47399)).unwrap();
        assert_eq!(n, 2);
        rx.recv_timeout(Duration::from_secs(2)).expect("ноутбук узнал об изменениях");
        assert_eq!(read_tasks(&laptop).len(), 2);
        assert_eq!(read_tasks(&phone).len(), 2);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn local_network_only() {
        for ok in ["192.168.0.5", "10.1.2.3", "172.20.0.1", "127.0.0.1", "169.254.1.1", "fe80::1", "fd00::1"] {
            assert!(is_local_network(ok.parse().unwrap()), "{ok}");
        }
        for bad in ["8.8.8.8", "93.84.1.1", "2a00:1450::1"] {
            assert!(!is_local_network(bad.parse().unwrap()), "{bad}");
        }
        assert!(same_secret("123456", "123456") && !same_secret("123456", "123457") && !same_secret("1", "12"));
    }

    #[test]
    fn brute_force_is_locked_out() {
        let dir = std::env::temp_dir().join(format!("unitrack-lock-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let code = pin(&dir);
        start_server(dir.clone(), 47397, || {});
        std::thread::sleep(Duration::from_millis(200));
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for _ in 0..5 {
            assert!(rt.block_on(sync_with_port(&dir, "127.0.0.1", "000000", 47397)).unwrap_err().contains("код"));
        }
        let e = rt.block_on(sync_with_port(&dir, "127.0.0.1", &code, 47397)).unwrap_err();
        assert!(e.contains("минуту"), "{e}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn discovery_finds_responder() {
        start_discovery_responder(47398, 12345);
        std::thread::sleep(Duration::from_millis(200));
        let found = discover(47398).expect("ответчик найден");
        assert!(found.ends_with(":12345"), "{found}");
    }
}
