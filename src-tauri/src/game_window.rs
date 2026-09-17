//! Locates the League of Legends *game* window and reports its client rect.
//!
//! Every capture coordinate in the app hangs off this rect: the minimap is
//! anchored to the game window's bottom-right corner, which is only the primary
//! monitor's corner when League happens to run borderless at native resolution
//! on the primary display.
//!
//! This module reports raw facts and refuses only the physically meaningless
//! cases (invisible / minimized windows). Whether a rect is *plausible* is
//! decided in `src/core/game-window.ts`, where jest can cover it — CI runs no
//! cargo step and this crate only builds on Windows.
//!
//! `FindWindowW` + `GetClientRect` are read-only window-manager queries against
//! an HWND — the same calls every overlay makes to position itself. No memory
//! read, no injection, and the rect never leaves the machine.

use std::sync::Mutex;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, BOOL, HANDLE, HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::MapWindowPoints;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowW, GetClientRect, GetSystemMetrics, GetWindowTextW, GetWindowThreadProcessId,
    IsIconic, IsWindowVisible, SM_CXSCREEN, SM_CXVIRTUALSCREEN, SM_CYSCREEN, SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

/// The game client's window class. The League *client* (store, lobby, champ
/// select) is a different process and class — `LeagueClientUx.exe` / RCLIENT —
/// so this can never match it, which is what keeps the lookup safe to run
/// whenever the app is open.
const GAME_WINDOW_CLASS: &str = "RiotWindowClass";

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameWindowInfo {
    pub found: bool,
    /// Client area in screen (virtual-desktop) coordinates. Negative x/y are
    /// legitimate — they address a monitor left of / above the primary one.
    pub rect: Option<Rect>,
    pub matched_by: Option<String>,
    /// Title and owning executable of whatever we matched. Logged so a user
    /// report can distinguish "the class-name lookup found the wrong window"
    /// from "the geometry is wrong", which is otherwise indistinguishable.
    pub window_title: Option<String>,
    pub process_name: Option<String>,
    pub virtual_screen: Rect,
    pub primary_screen: Rect,
    pub error: Option<String>,
}

/// Last line written by `log_geometry`, so the 5 s poll only logs on change.
static LAST_GEOMETRY_LINE: Mutex<Option<String>> = Mutex::new(None);

#[tauri::command]
pub fn get_game_window_info(app: tauri::AppHandle) -> GameWindowInfo {
    let located = unsafe { locate_game_window() };
    let info = GameWindowInfo {
        found: located.rect.is_some(),
        rect: located.rect,
        matched_by: located.matched_by,
        window_title: located.window_title,
        process_name: located.process_name,
        virtual_screen: virtual_screen_rect(),
        primary_screen: primary_screen_rect(),
        error: located.error,
    };
    log_geometry(&app, &info);
    info
}

struct Located {
    rect: Option<Rect>,
    matched_by: Option<String>,
    window_title: Option<String>,
    process_name: Option<String>,
    error: Option<String>,
}

impl Located {
    fn failed(error: String) -> Self {
        Located { rect: None, matched_by: None, window_title: None, process_name: None, error: Some(error) }
    }
}

unsafe fn locate_game_window() -> Located {
    let class: Vec<u16> = GAME_WINDOW_CLASS
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    let hwnd = match FindWindowW(PCWSTR(class.as_ptr()), PCWSTR::null()) {
        Ok(h) => h,
        // FindWindowW returns NULL both when the class is absent and on a real
        // failure, and does not reliably set last-error — so lead with the
        // likely cause and keep the Win32 detail behind it.
        Err(e) => {
            return Located::failed(format!(
                "no window of class {} (League not in a game?): {}",
                GAME_WINDOW_CLASS, e
            ))
        }
    };

    let title = window_title(hwnd);
    let proc = process_name(hwnd);

    if !IsWindowVisible(hwnd).as_bool() {
        return Located {
            window_title: title,
            process_name: proc,
            ..Located::failed("game window is not visible".to_string())
        };
    }
    // A minimized window's rect is (-32000, -32000), which would otherwise look
    // exactly like a legitimate monitor up and to the left of the primary one.
    if IsIconic(hwnd).as_bool() {
        return Located {
            window_title: title,
            process_name: proc,
            ..Located::failed("game window is minimized".to_string())
        };
    }

    let mut rc = RECT::default();
    if let Err(e) = GetClientRect(hwnd, &mut rc) {
        return Located {
            window_title: title,
            process_name: proc,
            ..Located::failed(format!("GetClientRect failed: {}", e))
        };
    }

    // The CLIENT area, not GetWindowRect: in windowed mode the minimap is
    // anchored to the client corner, so the title bar and borders must not
    // count. In borderless the two are identical.
    let mut pts = [
        POINT { x: rc.left, y: rc.top },
        POINT { x: rc.right, y: rc.bottom },
    ];
    MapWindowPoints(hwnd, HWND(std::ptr::null_mut()), &mut pts);

    Located {
        rect: Some(Rect {
            x: pts[0].x,
            y: pts[0].y,
            width: pts[1].x - pts[0].x,
            height: pts[1].y - pts[0].y,
        }),
        matched_by: Some("class".to_string()),
        window_title: title,
        process_name: proc,
        error: None,
    }
}

unsafe fn window_title(hwnd: HWND) -> Option<String> {
    let mut buf = [0u16; 256];
    let len = GetWindowTextW(hwnd, &mut buf);
    if len <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

unsafe fn process_name(hwnd: HWND) -> Option<String> {
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return None;
    }
    // QUERY_LIMITED_INFORMATION is the least-privileged handle that can read an
    // image name, and it costs one open rather than a process-table walk.
    let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, BOOL(0), pid).ok()?;
    let mut buf = [0u16; 260];
    let mut size = buf.len() as u32;
    let result = QueryFullProcessImageNameW(
        handle,
        PROCESS_NAME_WIN32,
        PWSTR(buf.as_mut_ptr()),
        &mut size,
    );
    let _ = CloseHandle(handle);
    result.ok()?;
    let full = String::from_utf16_lossy(&buf[..size as usize]);
    Some(exe_file_name(&full))
}

/// Last path segment of a Win32 image path (`C:\...\League of Legends.exe`).
fn exe_file_name(full_path: &str) -> String {
    full_path
        .rsplit(|c| c == '\\' || c == '/')
        .next()
        .unwrap_or(full_path)
        .to_string()
}

fn virtual_screen_rect() -> Rect {
    unsafe {
        Rect {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

fn primary_screen_rect() -> Rect {
    unsafe {
        Rect {
            x: 0,
            y: 0,
            width: GetSystemMetrics(SM_CXSCREEN),
            height: GetSystemMetrics(SM_CYSCREEN),
        }
    }
}

fn describe(r: &Rect) -> String {
    format!("{}x{}@({},{})", r.width, r.height, r.x, r.y)
}

/// One line per *change*. This runs on the 5 s geometry poll and the rect is
/// stable for whole sessions, so logging it every call would bury everything
/// else in the debug log.
fn log_geometry(app: &tauri::AppHandle, info: &GameWindowInfo) {
    let line = format!(
        "game-window: found={} matchedBy={} title={:?} process={} rect={} virtual={} primary={}{}",
        info.found,
        info.matched_by.as_deref().unwrap_or("none"),
        info.window_title.as_deref().unwrap_or(""),
        info.process_name.as_deref().unwrap_or("unknown"),
        info.rect.as_ref().map(describe).unwrap_or_else(|| "none".to_string()),
        describe(&info.virtual_screen),
        describe(&info.primary_screen),
        info.error.as_ref().map(|e| format!(" error={}", e)).unwrap_or_default(),
    );

    let Ok(mut last) = LAST_GEOMETRY_LINE.lock() else { return };
    if last.as_deref() == Some(line.as_str()) {
        return;
    }
    *last = Some(line.clone());
    crate::rust_log(app, line);
}

#[cfg(test)]
mod tests {
    use super::*;

    // exe_file_name must return the bare executable, since that is what a reader
    // of the log compares against "League of Legends.exe".
    #[test]
    fn exe_file_name_takes_the_last_path_segment() {
        assert_eq!(
            exe_file_name(r"C:\Riot Games\League of Legends\Game\League of Legends.exe"),
            "League of Legends.exe"
        );
        assert_eq!(exe_file_name("League of Legends.exe"), "League of Legends.exe");
        assert_eq!(exe_file_name(""), "");
    }

    // describe() is what lands in the log; a silent format change would make old
    // and new user reports incomparable.
    #[test]
    fn describe_reports_size_then_origin_including_negatives() {
        let r = Rect { x: -1920, y: -400, width: 2560, height: 1440 };
        assert_eq!(describe(&r), "2560x1440@(-1920,-400)");
    }
}
