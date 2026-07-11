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
//!   4. Caps Lock LED workaround: after acting on a Caps Lock event we send
//!      synthetic key-down+up via SendInput to flip the LED back, so the
//!      keyboard light doesn't toggle on every PTT press.

use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicU32, Ordering};
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

const VK_CAPITAL: u32 = 0x14;

/// Currently-bound PTT virtual-key code. Default = Caps Lock. (v0.5.6 tried
/// defaulting to unbound to stop PTT eating the Caps Lock key, but that left
/// push-to-talk users unable to transmit — no key bound — so v0.5.7 restored
/// the Caps Lock default. A migration that fixes the key capture without
/// stranding PTT users is the proper follow-up. See #27.)
static PTT_VK: AtomicU32 = AtomicU32::new(VK_CAPITAL);

/// Currently-bound toggle-self-mute virtual-key code. 0 = unbound.
static TOGGLE_VK: AtomicU32 = AtomicU32::new(0);

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

        // Ignore synthetic / injected events so our own SendInput-based
        // Caps Lock LED workaround doesn't recursively re-enter the hook
        // (would produce 2-3 spurious PttDown/PttUp pairs per physical
        // keypress). LLKHF_INJECTED = 0x10 in KBDLLHOOKSTRUCT.flags.
        if kb.flags.0 & 0x10 != 0 {
            return CallNextHookEx(*HOOK.0.get(), code, wparam, lparam);
        }

        let msg = wparam.0 as u32;
        let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
        let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;

        let ptt = PTT_VK.load(Ordering::Relaxed);
        let toggle = TOGGLE_VK.load(Ordering::Relaxed);

        if let Some(tx) = EVENT_TX.get() {
            if kb.vkCode == ptt {
                if is_down {
                    let _ = tx.send(KeyEvent::PttDown);
                } else if is_up {
                    let _ = tx.send(KeyEvent::PttUp);
                }
                // LED flip-back: send synthetic down+up to cancel the OS's
                // pending toggle of the Caps Lock light. Has to fire on BOTH
                // edges — pressing AND releasing the key both toggle the LED.
                // The injected-filter above keeps this from recursing.
                if ptt == VK_CAPITAL && (is_down || is_up) {
                    flip_caps_lock_back();
                }
            } else if toggle != 0 && kb.vkCode == toggle && is_down {
                let _ = tx.send(KeyEvent::ToggleMute);
            }
        }
    }
    CallNextHookEx(*HOOK.0.get(), code, wparam, lparam)
}

/// Send synthetic Caps Lock down+up via SendInput. The OS toggled the LED
/// when the user physically pressed Caps Lock; this synthetic press toggles
/// it right back, so the keyboard light stays in whatever state it was
/// before PTT started. Standard Discord trick.
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
    std::thread::spawn(|| unsafe {
        let h = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[global_keys] SetWindowsHookExW failed: {:?}", e);
                return;
            }
        };
        *HOOK.0.get() = h;

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

/// JS-callable: rebind the PTT key by Win32 virtual-key code.
#[tauri::command]
pub fn set_ptt_key(vk: u32) {
    PTT_VK.store(vk, Ordering::Relaxed);
}

/// JS-callable: rebind the toggle-self-mute key by Win32 virtual-key code.
/// Pass 0 to unbind.
#[tauri::command]
pub fn set_toggle_key(vk: u32) {
    TOGGLE_VK.store(vk, Ordering::Relaxed);
}
