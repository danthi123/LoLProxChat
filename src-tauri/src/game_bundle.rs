//! One zip per game, for bug reports: that game's log lines plus the minimap
//! snapshots and classifier crops the tracker saved, in
//! `<log dir>/games/<lobby>_<start time>.zip`.
//!
//! Only started while the panel's Debug toggle is on (the frontend decides).
//! A game's files collect in `games/.inprogress-<name>/` and are zipped when
//! the game ends; one left behind by a crash or a quit mid-game is zipped at
//! the next launch, so a game is never lost to how the app closed.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::Manager;

const IN_PROGRESS: &str = ".inprogress-";
/// Per game. A snapshot is ~100 KB and a crop ~2 KB; this is room for a long
/// game at the frontend's cadence, and a hard stop if that cadence is wrong.
const MAX_BUNDLE_BYTES: u64 = 40 * 1024 * 1024;
/// Zips kept in `games/`, newest first.
const KEEP_ZIPS: usize = 20;

struct Active {
    dir: PathBuf,
    name: String,
    log: File,
    bytes: u64,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);

fn games_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("games");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Lobby ids and timestamps only: no separators, nothing that leaves the folder.
fn sanitize_name(name: &str) -> Option<String> {
    let clean: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(80)
        .collect();
    if clean.is_empty() { None } else { Some(clean) }
}

/// A relative path inside the bundle: plain segments of [A-Za-z0-9._-].
fn sanitize_rel_path(path: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for seg in path.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.starts_with('.') {
            return None;
        }
        if !seg.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.') {
            return None;
        }
        out.push(seg);
    }
    if out.as_os_str().is_empty() { None } else { Some(out) }
}

/// Copy log lines into the active game's log. Called by every log writer.
pub fn tee(lines: &[String]) {
    let Ok(mut guard) = ACTIVE.lock() else { return };
    let Some(active) = guard.as_mut() else { return };
    for line in lines {
        let _ = writeln!(active.log, "{}", line);
    }
    let _ = active.log.flush();
}

#[tauri::command(async)]
pub fn bundle_start(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let name = sanitize_name(&name).ok_or("bad bundle name")?;
    let games = games_dir(&app)?;
    // A game that never saw its end (the session was replaced) is closed
    // first — outside the lock, which every log write also takes.
    let previous = ACTIVE.lock().map_err(|e| e.to_string())?.take();
    if let Some(previous) = previous {
        finish(&games, previous);
    }
    let dir = games.join(format!("{IN_PROGRESS}{name}"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let log = File::options()
        .create(true)
        .append(true)
        .open(dir.join("lolproxchat.log"))
        .map_err(|e| e.to_string())?;
    *ACTIVE.lock().map_err(|e| e.to_string())? = Some(Active { dir, name, log, bytes: 0 });
    Ok(())
}

/// Raw body = the file's bytes; header `x-path` = where in the bundle.
#[tauri::command(async)]
pub fn bundle_add_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("expected a raw body".into());
    };
    let rel = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .and_then(sanitize_rel_path)
        .ok_or("bad x-path")?;
    // Snapshots and crops are screen pixels: with another window over the
    // minimap (an alt-tab to a browser or a chat) they would show that window,
    // in a file the player is asked to post. Only League's own are kept.
    if !crate::game_window::league_is_foreground() {
        return Ok(());
    }
    let mut guard = ACTIVE.lock().map_err(|e| e.to_string())?;
    let Some(active) = guard.as_mut() else { return Ok(()) };
    if active.bytes + data.len() as u64 > MAX_BUNDLE_BYTES {
        return Ok(());
    }
    let path = active.dir.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, data).map_err(|e| e.to_string())?;
    active.bytes += data.len() as u64;
    Ok(())
}

/// Zip the active game, if any. Returns the zip's file name.
#[tauri::command(async)]
pub fn bundle_finish(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(active) = ACTIVE.lock().map_err(|e| e.to_string())?.take() else {
        return Ok(None);
    };
    let games = games_dir(&app)?;
    Ok(finish(&games, active))
}

fn finish(games: &Path, active: Active) -> Option<String> {
    let Active { dir, name, log, .. } = active;
    drop(log);
    let zip_name = zip_dir(games, &dir, &name);
    prune(games);
    zip_name
}

/// Zip `dir` into `games/<name>.zip` (a numbered name if that exists) and
/// remove it. Leaves the folder in place if zipping fails.
fn zip_dir(games: &Path, dir: &Path, name: &str) -> Option<String> {
    let mut zip_name = format!("{name}.zip");
    let mut n = 2;
    while games.join(&zip_name).exists() {
        zip_name = format!("{name}-{n}.zip");
        n += 1;
    }
    let result = (|| -> std::io::Result<()> {
        let file = File::create(games.join(&zip_name))?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut stack = vec![dir.to_path_buf()];
        let mut buf = Vec::new();
        while let Some(d) = stack.pop() {
            for entry in fs::read_dir(&d)? {
                let path = entry?.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let rel = path.strip_prefix(dir).unwrap_or(&path);
                let rel = rel.to_string_lossy().replace('\\', "/");
                zip.start_file(rel, options)?;
                buf.clear();
                File::open(&path)?.read_to_end(&mut buf)?;
                zip.write_all(&buf)?;
            }
        }
        zip.finish()?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            let _ = fs::remove_dir_all(dir);
            Some(zip_name)
        }
        Err(_) => {
            let _ = fs::remove_file(games.join(&zip_name));
            None
        }
    }
}

fn prune(games: &Path) {
    let Ok(entries) = fs::read_dir(games) else { return };
    let mut zips: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "zip"))
        .filter_map(|p| Some((fs::metadata(&p).ok()?.modified().ok()?, p)))
        .collect();
    zips.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in zips.into_iter().skip(KEEP_ZIPS) {
        let _ = fs::remove_file(path);
    }
}

/// At startup, before any game can begin: the unfinished games a crash or a
/// mid-game quit left behind. Listed up front so the zipping (`recover`, on a
/// worker thread) cannot pick up a game that starts meanwhile.
pub fn unfinished(app: &tauri::AppHandle) -> Vec<(PathBuf, String)> {
    let Ok(games) = games_dir(app) else { return Vec::new() };
    let Ok(entries) = fs::read_dir(&games) else { return Vec::new() };
    entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter_map(|p| {
            let name = p.file_name()?.to_str()?.strip_prefix(IN_PROGRESS)?.to_string();
            Some((p, name))
        })
        .collect()
}

/// Zip the games `unfinished` found.
pub fn recover(app: &tauri::AppHandle, found: Vec<(PathBuf, String)>) {
    let Ok(games) = games_dir(app) else { return };
    for (path, name) in found {
        if let Some(zip) = zip_dir(&games, &path, &name) {
            crate::rust_log(app, format!("game-bundle: zipped an unfinished game as {zip}"));
        }
    }
    prune(&games);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_paths_stay_inside_the_bundle() {
        assert_eq!(sanitize_name("vrb9uf_2026-10-07_17-05").as_deref(), Some("vrb9uf_2026-10-07_17-05"));
        assert_eq!(sanitize_name("../x/y").as_deref(), Some("xy"));
        assert_eq!(sanitize_name("/\\.."), None);
        assert!(sanitize_rel_path("minimap/0001_lock.png").is_some());
        assert!(sanitize_rel_path("../escape.png").is_none());
        assert!(sanitize_rel_path("a/../b").is_none());
        assert!(sanitize_rel_path("/abs.png").is_none());
        assert!(sanitize_rel_path("C:\\x.png").is_none());
        assert!(sanitize_rel_path(".hidden").is_none());
    }

    #[test]
    fn zips_a_folder_and_removes_it() {
        let root = std::env::temp_dir().join(format!("lpc-bundle-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let dir = root.join(".inprogress-abc");
        fs::create_dir_all(dir.join("crops")).unwrap();
        fs::write(dir.join("lolproxchat.log"), "hello").unwrap();
        fs::write(dir.join("crops/1.png"), [1u8, 2, 3]).unwrap();
        assert_eq!(zip_dir(&root, &dir, "abc").as_deref(), Some("abc.zip"));
        assert!(!dir.exists());
        let mut archive = zip::ZipArchive::new(File::open(root.join("abc.zip")).unwrap()).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["crops/1.png", "lolproxchat.log"]);
        // A second game in the same lobby gets its own file.
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("lolproxchat.log"), "again").unwrap();
        assert_eq!(zip_dir(&root, &dir, "abc").as_deref(), Some("abc-2.zip"));
        let _ = fs::remove_dir_all(&root);
    }
}
