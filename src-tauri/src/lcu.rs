use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GameState {
    pub is_league_running: bool,
    pub is_in_game: bool,
    pub summoner_name: Option<String>,
    pub is_dead: bool,
    pub game_flow_phase: String,
}

/// Common install locations, tried when no LeagueClient process is visible.
const DEFAULT_INSTALL_PATHS: [&str; 4] = [
    r"C:\Riot Games\League of Legends",
    r"D:\Riot Games\League of Legends",
    r"C:\Program Files\Riot Games\League of Legends",
    r"C:\Program Files (x86)\Riot Games\League of Legends",
];

/// Enumerating the whole process table costs tens of milliseconds on a machine
/// that is also running League and a 30 FPS capture loop, so a rescan is only
/// allowed this often. The last known directory is still served between
/// rescans, so League starting up in an already-known install is picked up on
/// the next poll; only League moving to a *different* install has to wait for
/// this window to expire.
const RESCAN_MIN_INTERVAL: Duration = Duration::from_secs(10);

/// One `pollGameState` tick issues three loopback requests (gameflow-phase,
/// allgamedata here, allgamedata again via `get_live_client_data`), so the
/// per-request budget has to be a third of the frontend's 3s poll interval.
/// A healthy LCU answers in tens of milliseconds.
const REQUEST_TIMEOUT: Duration = Duration::from_millis(1000);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);

/// A gameflow-phase request that times out is not evidence that the game
/// ended, but the frontend tears the voice session down on the first poll that
/// reports not-in-game. The LCU can stall past the request timeout during
/// asset load, so the phase it last reported is reused for this long rather
/// than dropping everyone's voice over one slow request.
const PHASE_GRACE: Duration = Duration::from_secs(15);

/// Logs a resolution only when it changes: an idle client rescans every
/// `RESCAN_MIN_INTERVAL` forever, and identical lines would bury everything
/// else in the log.
fn log_install_dir(branch: &str, dir: Option<&Path>) {
    static LAST: Mutex<Option<String>> = Mutex::new(None);
    let line = match dir {
        Some(p) => format!("[lcu] install dir via {}: {}", branch, p.display()),
        None => format!("[lcu] no install dir found ({})", branch),
    };
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if last.as_deref() != Some(line.as_str()) {
        eprintln!("{}", line);
        *last = Some(line);
    }
}

/// The test a directory has to pass to count as a League install. Used both
/// when accepting a scan result and when re-validating a cached one, so a
/// directory can never be accepted by one and rejected by the other.
fn looks_like_install_dir(dir: &Path) -> bool {
    dir.join("lockfile").exists() || dir.join("LeagueClient.exe").exists()
}

fn first_install_dir_in(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|p| looks_like_install_dir(p))
        .cloned()
}

/// Locate the LeagueClient.exe install directory by querying the running
/// process. Falls back to a few common default install paths if the process
/// query fails (permissions / sysinfo platform quirks).
fn scan_for_league_dir() -> Option<PathBuf> {
    // exe and cwd are opt-in in sysinfo 0.33: without them `proc.exe()` and
    // `proc.cwd()` return None and every non-default install would silently
    // fall through to DEFAULT_INSTALL_PATHS.
    let kind = ProcessRefreshKind::nothing()
        .with_exe(UpdateKind::Always)
        .with_cwd(UpdateKind::Always);
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);

    for proc in sys.processes().values() {
        let name = proc.name().to_string_lossy();
        if name.contains("LeagueClient") {
            if let Some(parent) = proc.exe().and_then(|exe| exe.parent()) {
                log_install_dir("process exe", Some(parent));
                return Some(parent.to_path_buf());
            }
            if let Some(cwd) = proc.cwd() {
                log_install_dir("process cwd", Some(cwd));
                return Some(cwd.to_path_buf());
            }
            eprintln!(
                "[lcu] found process {} but neither its exe path nor its cwd is readable",
                name
            );
        }
    }

    // No running process — try common defaults. Used during transient process
    // states or when sysinfo can't read the exe path due to permissions.
    let candidates: Vec<PathBuf> = DEFAULT_INSTALL_PATHS.iter().map(PathBuf::from).collect();
    let found = first_install_dir_in(&candidates);
    log_install_dir("defaults", found.as_deref());
    found
}

struct CacheState {
    dir: Option<PathBuf>,
    /// Set when a lookup through the cached directory came up empty, which is
    /// either "League is closed" or "League moved"; only a scan tells those
    /// apart, and the rescan gate decides when that is worth paying for.
    stale: bool,
    last_scan: Option<Instant>,
}

/// Remembers the resolved install directory so the 3s game-state poll and the
/// 5s minimap-scale poll cost two `exists()` calls instead of a full process
/// enumeration each.
struct InstallDirCache {
    inner: Mutex<CacheState>,
}

impl InstallDirCache {
    const fn new() -> Self {
        Self {
            inner: Mutex::new(CacheState {
                dir: None,
                stale: false,
                last_scan: None,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CacheState> {
        // A panic elsewhere must not poison the cache into permanent failure.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `now` and `scan` are injected so the gate can be tested without sleeping
    /// and without a real process table.
    fn resolve(&self, now: Instant, scan: &dyn Fn() -> Option<PathBuf>) -> Option<PathBuf> {
        let (cached, needs_scan) = {
            let mut st = self.lock();
            // Drop a cached directory that no longer exists (uninstall, moved
            // install, unmounted drive) before deciding anything else.
            if let Some(dir) = st.dir.clone() {
                if !looks_like_install_dir(&dir) {
                    st.dir = None;
                }
            }
            let rescan_allowed = match st.last_scan {
                Some(t) => now.duration_since(t) >= RESCAN_MIN_INTERVAL,
                None => true,
            };
            let needs_scan = (st.dir.is_none() || st.stale) && rescan_allowed;
            if needs_scan {
                st.last_scan = Some(now);
            }
            (st.dir.clone(), needs_scan)
        };

        // The scan runs with the lock released so a slow process enumeration
        // can't block the other poll.
        if !needs_scan {
            if let Some(dir) = &cached {
                log_install_dir("cache", Some(dir));
            }
            return cached;
        }

        let found = scan();

        let mut st = self.lock();
        st.stale = false;
        match found {
            Some(dir) => {
                // Only cache what the validity check can confirm later: the cwd
                // fallback branch can return a directory holding neither marker,
                // and caching that would mean re-scanning on every poll anyway.
                if looks_like_install_dir(&dir) {
                    st.dir = Some(dir.clone());
                }
                Some(dir)
            }
            // A scan finding nothing does not discard a directory that is still
            // on disk: League being closed is not evidence that it moved.
            None => st.dir.clone(),
        }
    }

    fn mark_stale(&self) {
        self.lock().stale = true;
    }
}

static INSTALL_DIR: InstallDirCache = InstallDirCache::new();

fn find_league_install_dir() -> Option<PathBuf> {
    INSTALL_DIR.resolve(Instant::now(), &scan_for_league_dir)
}

/// Parse LCU lockfile contents: `name:pid:port:password:protocol`.
fn parse_lockfile(content: &str) -> Option<(u16, String)> {
    let parts: Vec<&str> = content.trim().split(':').collect();
    if parts.len() < 4 {
        return None;
    }
    let port = parts[2].trim().parse::<u16>().ok()?;
    // Trailing whitespace in the password field silently produces 401s that
    // surface as "League not in game".
    Some((port, parts[3].trim().to_string()))
}

fn read_lockfile_from(dir: &Path) -> Option<(u16, String)> {
    parse_lockfile(&std::fs::read_to_string(dir.join("lockfile")).ok()?)
}

/// Find and parse the LeagueClient lockfile. Returns (port, password).
fn find_lockfile() -> Option<(u16, String)> {
    find_lockfile_with(&INSTALL_DIR, Instant::now(), &scan_for_league_dir)
}

fn find_lockfile_with(
    cache: &InstallDirCache,
    now: Instant,
    scan: &dyn Fn() -> Option<PathBuf>,
) -> Option<(u16, String)> {
    let first = cache.resolve(now, scan);
    if let Some(dir) = &first {
        if let Some(hit) = read_lockfile_from(dir) {
            return Some(hit);
        }
    }

    // No lockfile under the directory we have. Flag it so that the next scan
    // the gate lets through re-derives it — that is what covers League being
    // restarted into a second install. While League is simply closed the gate
    // keeps this from turning every poll into a process enumeration.
    cache.mark_stale();
    let second = cache.resolve(now, scan);
    if second == first {
        return None;
    }
    read_lockfile_from(&second?)
}

/// Remembers the last phase the LCU actually reported, so a failed request can
/// be told apart from a game that ended. See `PHASE_GRACE`.
struct PhaseCache {
    inner: Mutex<Option<(Instant, String)>>,
}

impl PhaseCache {
    const fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<(Instant, String)>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn record(&self, now: Instant, phase: &str) {
        *self.lock() = Some((now, phase.to_string()));
    }

    fn recent(&self, now: Instant) -> Option<String> {
        let seen = self.lock();
        let (at, phase) = seen.as_ref()?;
        if now.duration_since(*at) < PHASE_GRACE {
            Some(phase.clone())
        } else {
            None
        }
    }
}

static LAST_PHASE: PhaseCache = PhaseCache::new();

static LCU_HTTP: OnceLock<Option<reqwest::Client>> = OnceLock::new();

/// One pooled client for both loopback endpoints; a fresh client per call meant
/// a fresh TCP connect and TLS handshake on every poll. Certificate validation
/// is disabled because the LCU serves a self-signed cert on 127.0.0.1 — that is
/// only acceptable because the scope is loopback, so this client must never be
/// used for the signaling server or the updater.
fn lcu_http() -> Option<&'static reqwest::Client> {
    LCU_HTTP
        .get_or_init(|| {
            match reqwest::Client::builder()
                .danger_accept_invalid_certs(true)
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(REQUEST_TIMEOUT)
                .build()
            {
                Ok(client) => Some(client),
                Err(e) => {
                    // Latched for the process lifetime, so every later LCU call
                    // will report "League not running" — say so once, loudly.
                    eprintln!("[lcu] failed to build HTTP client, League detection is disabled for this session: {}", e);
                    None
                }
            }
        })
        .as_ref()
}

/// Returns the absolute path to the League of Legends install directory if
/// detected, so the frontend can read other files in the install (e.g.
/// `Config/game.cfg` for minimap-scale calibration) regardless of install path.
#[tauri::command]
pub fn get_league_install_dir() -> Option<String> {
    find_league_install_dir().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn check_league_running() -> bool {
    find_lockfile().is_some()
}

async fn fetch_gameflow_phase(port: u16, password: &str) -> Option<String> {
    let client = lcu_http()?;
    let url = format!("https://127.0.0.1:{}/lol-gameflow/v1/gameflow-phase", port);
    match client
        .get(&url)
        .basic_auth("riot", Some(password))
        .send()
        .await
    {
        Ok(resp) => match resp.text().await {
            Ok(body) => Some(body.trim().trim_matches('"').to_string()),
            Err(e) => {
                eprintln!("[lcu] gameflow-phase response unreadable: {}", e);
                None
            }
        },
        Err(e) => {
            eprintln!("[lcu] gameflow-phase request failed: {}", e);
            None
        }
    }
}

async fn fetch_live_client_data() -> Option<serde_json::Value> {
    let client = lcu_http()?;
    match client
        .get("https://127.0.0.1:2999/liveclientdata/allgamedata")
        .send()
        .await
    {
        Ok(resp) => match resp.json::<serde_json::Value>().await {
            Ok(data) => Some(data),
            Err(e) => {
                eprintln!("[lcu] live client data unreadable: {}", e);
                None
            }
        },
        Err(e) => {
            eprintln!("[lcu] live client data request failed: {}", e);
            None
        }
    }
}

#[tauri::command]
pub async fn get_game_state() -> GameState {
    let mut state = GameState {
        is_league_running: false,
        is_in_game: false,
        summoner_name: None,
        is_dead: false,
        game_flow_phase: "None".into(),
    };

    let lockfile = find_lockfile();
    state.is_league_running = lockfile.is_some();

    if let Some((port, password)) = &lockfile {
        // Check gameflow phase via LCU API
        let fetched = fetch_gameflow_phase(*port, password).await;
        let now = Instant::now();
        let phase = match fetched {
            Some(phase) => {
                LAST_PHASE.record(now, &phase);
                Some(phase)
            }
            None => {
                let held = LAST_PHASE.recent(now);
                if let Some(phase) = &held {
                    eprintln!("[lcu] gameflow-phase unavailable, holding last reported phase {}", phase);
                }
                held
            }
        };
        if let Some(phase) = phase {
            state.is_in_game = phase == "InProgress";
            state.game_flow_phase = phase;
        }
    }

    // If in game, get live data (no auth needed)
    if state.is_in_game {
        if let Some(data) = fetch_live_client_data().await {
            if let Some(player) = data.get("activePlayer") {
                state.summoner_name = player
                    .get("riotId")
                    .or_else(|| player.get("summonerName"))
                    .and_then(|v| v.as_str())
                    .map(String::from);
                state.is_dead = player
                    .get("isDead")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
            }
        }
    }

    state
}

/// Get full live client data (all players, active player, events).
/// Only available during an active game on localhost:2999 with no auth.
#[tauri::command]
pub async fn get_live_client_data() -> Option<serde_json::Value> {
    fetch_live_client_data().await
}

/// Read the League client's `Config/game.cfg`. Path is computed Rust-side
/// from `find_league_install_dir()` so the frontend can't supply an arbitrary
/// path — this used to be a `read_text_file(path: String)` command which gave
/// JS arbitrary file-read capability if WebView2 ever got compromised.
#[tauri::command]
pub fn read_league_config_file() -> Result<String, String> {
    let dir = find_league_install_dir().ok_or("League install directory not detected".to_string())?;
    let path = dir.join("Config").join("game.cfg");
    std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Unique scratch directory per test, removed and recreated on entry so a
    /// crashed previous run can't leak state into this one.
    fn scratch(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("lolproxchat-lcu-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn write(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
    }

    // Asserts the canonical five-field lockfile yields the port and password.
    #[test]
    fn parses_canonical_lockfile() {
        assert_eq!(
            parse_lockfile("LeagueClient:12345:54321:abc123:https"),
            Some((54321, "abc123".to_string()))
        );
    }

    // Asserts line endings never leak into the password: a password carrying a
    // newline authenticates as a different string and 401s forever, which
    // surfaces as "League not running".
    #[test]
    fn strips_line_endings_from_password() {
        let expected = Some((2, "pw".to_string()));
        assert_eq!(parse_lockfile("LeagueClient:1:2:pw\n"), expected);
        assert_eq!(parse_lockfile("LeagueClient:1:2:pw\r\n"), expected);
        assert_eq!(parse_lockfile("LeagueClient:1:2:pw:https\r\n"), expected);
    }

    // Asserts malformed contents are rejected rather than half-parsed.
    #[test]
    fn rejects_malformed_lockfiles() {
        assert_eq!(parse_lockfile(""), None);
        assert_eq!(parse_lockfile("LeagueClient:1:2"), None);
        assert_eq!(parse_lockfile("LeagueClient:1:notaport:pw:https"), None);
        // 70000 does not fit in the u16 the rest of the code expects.
        assert_eq!(parse_lockfile("LeagueClient:1:70000:pw:https"), None);
    }

    // Asserts the default-path fallback accepts a directory on either marker
    // and rejects one with neither — the predicate the cache also validates
    // against, so a mismatch here would make the cache never hit.
    #[test]
    fn first_install_dir_accepts_either_marker() {
        let root = scratch("candidates");
        let empty = root.join("empty");
        let with_lockfile = root.join("lockfile-only");
        let with_exe = root.join("exe-only");
        for d in [&empty, &with_lockfile, &with_exe] {
            std::fs::create_dir_all(d).unwrap();
        }
        write(&with_lockfile, "lockfile", "LeagueClient:1:2:pw:https");
        write(&with_exe, "LeagueClient.exe", "");

        let all = vec![empty.clone(), with_lockfile.clone(), with_exe.clone()];
        assert_eq!(first_install_dir_in(&all), Some(with_lockfile));
        assert_eq!(
            first_install_dir_in(&[empty.clone(), with_exe.clone()]),
            Some(with_exe)
        );
        assert_eq!(first_install_dir_in(&[empty]), None);
    }

    struct CountingScan {
        calls: AtomicUsize,
        results: Vec<Option<PathBuf>>,
    }

    impl CountingScan {
        fn new(results: Vec<Option<PathBuf>>) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                results,
            }
        }

        fn run(&self) -> Option<PathBuf> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            self.results
                .get(n)
                .cloned()
                .unwrap_or_else(|| self.results.last().cloned().flatten())
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    // Asserts a resolved directory is served from the cache: without the cache
    // every call scanned the process table.
    #[test]
    fn second_resolve_does_not_rescan() {
        let dir = scratch("cache-hit");
        write(&dir, "LeagueClient.exe", "");
        let scan = CountingScan::new(vec![Some(dir.clone())]);
        let cache = InstallDirCache::new();
        let t0 = Instant::now();

        assert_eq!(cache.resolve(t0, &|| scan.run()), Some(dir.clone()));
        assert_eq!(
            cache.resolve(t0 + Duration::from_millis(10), &|| scan.run()),
            Some(dir)
        );
        assert_eq!(scan.calls(), 1);
    }

    // Asserts a directory that disappears is dropped and re-derived once the
    // rescan window allows it (League uninstalled or moved).
    #[test]
    fn vanished_directory_is_rescanned_after_the_window() {
        let gone = scratch("cache-gone");
        write(&gone, "LeagueClient.exe", "");
        let replacement = scratch("cache-replacement");
        write(&replacement, "LeagueClient.exe", "");
        let scan = CountingScan::new(vec![Some(gone.clone()), Some(replacement.clone())]);
        let cache = InstallDirCache::new();
        let t0 = Instant::now();

        assert_eq!(cache.resolve(t0, &|| scan.run()), Some(gone.clone()));
        std::fs::remove_dir_all(&gone).unwrap();

        // Inside the window there is nothing valid to return and no scan.
        assert_eq!(cache.resolve(t0 + Duration::from_secs(1), &|| scan.run()), None);
        assert_eq!(scan.calls(), 1);

        assert_eq!(
            cache.resolve(t0 + RESCAN_MIN_INTERVAL, &|| scan.run()),
            Some(replacement)
        );
        assert_eq!(scan.calls(), 2);
    }

    // Asserts a scan that finds nothing caches nothing but still arms the gate,
    // so "app started before League" costs one scan per window, not one per
    // poll, and still self-heals.
    #[test]
    fn failed_scan_is_rate_limited_but_not_latched() {
        let dir = scratch("cache-late-league");
        write(&dir, "LeagueClient.exe", "");
        let scan = CountingScan::new(vec![None, Some(dir.clone())]);
        let cache = InstallDirCache::new();
        let t0 = Instant::now();

        assert_eq!(cache.resolve(t0, &|| scan.run()), None);
        assert_eq!(cache.resolve(t0 + Duration::from_millis(100), &|| scan.run()), None);
        assert_eq!(scan.calls(), 1);

        assert_eq!(
            cache.resolve(t0 + RESCAN_MIN_INTERVAL, &|| scan.run()),
            Some(dir)
        );
        assert_eq!(scan.calls(), 2);
    }

    // Asserts a scan result that fails the validity predicate (the cwd fallback
    // branch can return one) is used but never cached, since a cached copy
    // could never be re-validated.
    #[test]
    fn unvalidatable_scan_result_is_not_cached() {
        let dir = scratch("cache-unvalidatable");
        let scan = CountingScan::new(vec![Some(dir.clone())]);
        let cache = InstallDirCache::new();
        let t0 = Instant::now();

        assert_eq!(cache.resolve(t0, &|| scan.run()), Some(dir));
        assert_eq!(cache.resolve(t0 + Duration::from_millis(10), &|| scan.run()), None);
        assert_eq!(scan.calls(), 1);
    }

    // Asserts the common idle state — League installed, not running, so no
    // lockfile — costs exactly one process scan per window and not one per
    // poll, which is the whole point of gating the post-invalidation retry.
    #[test]
    fn missing_lockfile_does_not_rescan_within_the_window() {
        let dir = scratch("lockfile-idle");
        write(&dir, "LeagueClient.exe", "");
        let scan = CountingScan::new(vec![Some(dir)]);
        let cache = InstallDirCache::new();
        let t0 = Instant::now();

        assert_eq!(find_lockfile_with(&cache, t0, &|| scan.run()), None);
        assert_eq!(scan.calls(), 1);

        assert_eq!(
            find_lockfile_with(&cache, t0 + Duration::from_secs(3), &|| scan.run()),
            None
        );
        assert_eq!(scan.calls(), 1);
    }

    // Asserts League restarting into a different install is picked up once the
    // rescan window expires, and that the credentials come from the new dir.
    #[test]
    fn lockfile_is_refound_after_league_moves_install() {
        let old = scratch("lockfile-old-install");
        write(&old, "LeagueClient.exe", "");
        let new = scratch("lockfile-new-install");
        write(&new, "LeagueClient.exe", "");
        write(&new, "lockfile", "LeagueClient:999:2999:secret:https\n");
        let scan = CountingScan::new(vec![Some(old), Some(new)]);
        let cache = InstallDirCache::new();
        let t0 = Instant::now();

        assert_eq!(find_lockfile_with(&cache, t0, &|| scan.run()), None);
        assert_eq!(
            find_lockfile_with(&cache, t0 + RESCAN_MIN_INTERVAL, &|| scan.run()),
            Some((2999, "secret".to_string()))
        );
        assert_eq!(scan.calls(), 2);
    }

    // Asserts a lockfile under the cached directory is read without any scan
    // beyond the first — the in-game steady state.
    #[test]
    fn lockfile_under_cached_dir_costs_no_scan() {
        let dir = scratch("lockfile-in-game");
        write(&dir, "lockfile", "LeagueClient:1:54321:pw:https\n");
        let scan = CountingScan::new(vec![Some(dir)]);
        let cache = InstallDirCache::new();
        let t0 = Instant::now();

        let expected = Some((54321, "pw".to_string()));
        assert_eq!(find_lockfile_with(&cache, t0, &|| scan.run()), expected);
        assert_eq!(
            find_lockfile_with(&cache, t0 + Duration::from_secs(30), &|| scan.run()),
            expected
        );
        assert_eq!(scan.calls(), 1);
    }

    // Asserts a phase survives a short request failure but not an open-ended
    // one: holding it forever would keep a finished game's session alive.
    #[test]
    fn phase_is_held_only_for_the_grace_window() {
        let cache = PhaseCache::new();
        let t0 = Instant::now();
        assert_eq!(cache.recent(t0), None);

        cache.record(t0, "InProgress");
        assert_eq!(
            cache.recent(t0 + Duration::from_secs(3)),
            Some("InProgress".to_string())
        );
        assert_eq!(cache.recent(t0 + PHASE_GRACE), None);
    }
}
