//! Low-level Windows keyboard hook for in-game PTT (issue #1).
//!
//! Replaces `tauri-plugin-global-shortcut` (which uses RegisterHotKey — LoL's
//! DirectInput layer intercepts those so F8 never fires in-game). Instead we
//! install a `WH_KEYBOARD_LL` hook, the same technique Discord/Mumble/OBS use.
//!
//! Architecture notes:
//!   1. The hook MUST be installed from a thread with a Win32 message pump.
//!      Tokio worker threads don't qualify. We spawn a dedicated std::thread
//!      that runs a manual GetMessageW loop.
//!   2. The hook callback has a hard deadline (~300ms). Every code path
//!      inside it must be O(1) and lock-free. We post to a tokio mpsc and
//!      return immediately; a worker tokio task drains the channel and
//!      calls `app_handle.emit(...)`.
//!   3. HHOOK wraps a raw pointer and isn't Send/Sync. The hook only lives
//!      on the dedicated thread so this is safe in practice; we wrap it in
//!      an UnsafeCell + manual `unsafe impl Sync` to satisfy the type
//!      checker for the static.
//!   4. Caps Lock workaround (#27): Windows toggles Caps Lock once per
//!      press, on the key-down transition only. When Caps Lock is the PTT
//!      bind we send one synthetic press via SendInput on that same down
//!      edge to cancel it, so a PTT press leaves Caps Lock (and its LED)
//!      exactly as it found it. `CAPS_HELD` keeps typematic repeats from
//!      firing a second, uncancelled flip. The decision itself lives in
//!      `key_decision` so it can be unit-tested off-Windows.

use crate::key_decision::{self, Decision, Edge, Emit, VK_CAPITAL};
use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, SetWindowsHookExW, UnhookWindowsHookEx, HHOOK,
    KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

/// Currently-bound PTT virtual-key code. Default = Caps Lock. (v0.5.6 tried
/// defaulting to unbound to stop PTT eating the Caps Lock key, but that left
/// push-to-talk users unable to transmit — no key bound — so v0.5.7 restored
/// the Caps Lock default. See #27; note 4 above covers how the key is left
/// alone without unbinding it.)
static PTT_VK: AtomicU32 = AtomicU32::new(VK_CAPITAL);

/// Currently-bound toggle-self-mute virtual-key code. 0 = unbound.
static TOGGLE_VK: AtomicU32 = AtomicU32::new(0);

/// True while Caps Lock is physically held down. Only ever touched from the
/// hook thread; the atomic is for the `static`, not for contention.
static CAPS_HELD: AtomicBool = AtomicBool::new(false);

/// Channel into the tokio worker that actually emits Tauri events. The hook
/// proc only ever does a non-blocking `send` on this — no allocations, no
/// locks.
static EVENT_TX: OnceLock<mpsc::UnboundedSender<KeyEvent>> = OnceLock::new();

/// Holds the HHOOK once installed. Only accessed from the dedicated hook
/// thread, but Rust needs a `Sync` static so we wrap accordingly.
struct HookSlot(UnsafeCell<HHOOK>);
// SAFETY: HOOK is only ever written once on the dedicated hook thread
// (inside setup_hook's std::thread::spawn) and only read by hook_proc which
// itself only runs on that same thread (the WH_KEYBOARD_LL callback fires
// on the thread that installed the hook). No cross-thread access in practice,
// so the missing data-race protection is moot — the unsafe impl Sync exists
// only to satisfy the type checker for use in a `static`.
unsafe impl Sync for HookSlot {}
static HOOK: HookSlot = HookSlot(UnsafeCell::new(HHOOK(std::ptr::null_mut())));

#[derive(Debug, Clone, Copy)]
enum KeyEvent {
    PttDown,
    PttUp,
    ToggleMute,
}

/// The actual low-level hook callback. Runs on the hook thread under a tight
/// (~300ms) deadline, so we do the absolute minimum work and bail.
unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);

        // Synthetic / injected events (our own Caps Lock flip among them) must
        // not re-enter the decision — see key_decision::decide.
        // LLKHF_INJECTED = 0x10 in KBDLLHOOKSTRUCT.flags.
        let injected = kb.flags.0 & 0x10 != 0;

        let msg = wparam.0 as u32;
        let edge = if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
            Edge::Down
        } else if msg == WM_KEYUP || msg == WM_SYSKEYUP {
            Edge::Up
        } else {
            Edge::Other
        };

        let Decision { emit, flip_caps, caps_held } = key_decision::decide(
            kb.vkCode,
            edge,
            PTT_VK.load(Ordering::Relaxed),
            TOGGLE_VK.load(Ordering::Relaxed),
            injected,
            CAPS_HELD.load(Ordering::Relaxed),
        );
        CAPS_HELD.store(caps_held, Ordering::Relaxed);

        if let Some(tx) = EVENT_TX.get() {
            match emit {
                Emit::PttDown => { let _ = tx.send(KeyEvent::PttDown); }
                Emit::PttUp => { let _ = tx.send(KeyEvent::PttUp); }
                Emit::ToggleMute => { let _ = tx.send(KeyEvent::ToggleMute); }
                Emit::None => {}
            }
        }

        if flip_caps {
            flip_caps_lock_back();
        }
    }
    CallNextHookEx(*HOOK.0.get(), code, wparam, lparam)
}

/// Send synthetic Caps Lock down+up via SendInput — one full press, so one
/// toggle. The OS toggles Caps Lock when the user physically presses the key;
/// this cancels that, leaving the state and the LED where they were before
/// PTT started. Only ever called on a down edge (see `key_decision::decide`).
unsafe fn flip_caps_lock_back() {
    let inputs = [
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(VK_CAPITAL as u16),
                    wScan: 0,
                    dwFlags: KEYBD_EVENT_FLAGS(0),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(VK_CAPITAL as u16),
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
    ];
    SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
}

/// Install the keyboard hook and wire up event emission to the JS side.
/// Must be called once during Tauri `setup`.
pub fn setup_hook(app: AppHandle) {
    let (tx, mut rx) = mpsc::unbounded_channel::<KeyEvent>();
    let _ = EVENT_TX.set(tx);

    // Cloned before the emit task below takes ownership of `app`.
    let app_for_hook = app.clone();

    // Drain the channel on the tokio runtime and emit Tauri events.
    // We preserve the existing `global_shortcut` event name + string payload
    // contract that src/background/background.ts already listens for, so no
    // JS-side changes are needed.
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let payload: &'static str = match ev {
                KeyEvent::PttDown => "pttDown",
                KeyEvent::PttUp => "pttUp",
                KeyEvent::ToggleMute => "toggleMute",
            };
            let _ = app.emit("global_shortcut", payload);
        }
    });

    // Dedicated OS thread with its own message pump. SetWindowsHookExW
    // requires this — tokio worker threads don't pump messages.
    std::thread::spawn(move || unsafe {
        let h = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[global_keys] SetWindowsHookExW failed: {:?}", e);
                crate::rust_log(
                    &app_for_hook,
                    format!(
                        "global_keys: SetWindowsHookExW FAILED: {e:?} — push-to-talk and the \
                         mute hotkey will not work"
                    ),
                );
                return;
            }
        };
        *HOOK.0.get() = h;
        // The binds can't be reported here: the overlay pushes any stored
        // ones well after setup, so PTT_VK/TOGGLE_VK still hold the compiled
        // defaults. set_ptt_key/set_toggle_key log the real ones when they
        // arrive.
        crate::rust_log(
            &app_for_hook,
            "global_keys: WH_KEYBOARD_LL hook installed; PTT default=CapsLock until the \
             overlay pushes the stored bind",
        );

        let mut msg = MSG::default();
        // GetMessageW returns BOOL; the hook fires on its own off the
        // raw input queue — we just need a pumping loop alive on this
        // thread to keep the hook installed.
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            // No translation/dispatch needed for the hook itself.
        }
        let _ = UnhookWindowsHookEx(h);
    });
}

/// JS-callable: rebind the PTT key by Win32 virtual-key code. The raw VK is
/// logged (not a name) so the log never disagrees with `core/keymap.ts`,
/// which owns the human-readable table. `app` is injected by Tauri and is
/// invisible to the JS call shape.
#[tauri::command]
pub fn set_ptt_key(app: tauri::AppHandle, vk: u32) {
    PTT_VK.store(vk, Ordering::Relaxed);
    crate::rust_log(&app, format!("global_keys: PTT rebound to VK 0x{vk:02X}"));
}

/// JS-callable: rebind the toggle-self-mute key by Win32 virtual-key code.
/// Pass 0 to unbind.
#[tauri::command]
pub fn set_toggle_key(app: tauri::AppHandle, vk: u32) {
    TOGGLE_VK.store(vk, Ordering::Relaxed);
    crate::rust_log(&app, format!("global_keys: toggle-mute rebound to VK 0x{vk:02X}"));
}
