//! Microphone access for our own pages.
//!
//! WebView2 answers a getUserMedia call with its own Allow/Block prompt and
//! remembers the answer in the profile. One player in the 2026-10-07 test hit
//! "Permission denied" within milliseconds of every session start: a block
//! remembered from an earlier prompt (or Windows' own privacy switch, which
//! nothing here can override). The app only ever loads its own bundled pages,
//! so the microphone is granted here instead of asked for.

use tauri::{Manager, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Profile4, ICoreWebView2_13, COREWEBVIEW2_PERMISSION_KIND,
    COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
};
use webview2_com::{PermissionRequestedEventHandler, SetPermissionStateCompletedHandler};
use windows_core::{Interface, HSTRING};

use crate::rust_log;

/// Where release builds serve the bundled pages from on Windows. Used when the
/// window has not navigated to an http(s) page yet at setup time.
const RELEASE_ORIGIN: &str = "http://tauri.localhost";

pub fn allow_microphone(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let origin = window
        .url()
        .ok()
        .filter(|u| u.scheme() == "http" || u.scheme() == "https")
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_else(|| RELEASE_ORIGIN.to_string());

    let app_for_closure = app.clone();
    let result = window.with_webview(move |webview| unsafe {
        let app = app_for_closure;
        let core = match webview.controller().CoreWebView2() {
            Ok(core) => core,
            Err(e) => {
                rust_log(&app, format!("mic-permission: {label}: no CoreWebView2: {e}"));
                return;
            }
        };

        // Any future prompt is answered Allow without being shown.
        let mut token = 0i64;
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
            }
            Ok(())
        }));
        if let Err(e) = core.add_PermissionRequested(&handler, &mut token) {
            rust_log(&app, format!("mic-permission: {label}: add_PermissionRequested failed: {e}"));
        }

        // A Block saved by an earlier prompt is not re-asked, so overwrite it.
        let profile = core
            .cast::<ICoreWebView2_13>()
            .and_then(|c| c.Profile())
            .and_then(|p| p.cast::<ICoreWebView2Profile4>());
        match profile {
            Ok(profile) => {
                let done_app = app.clone();
                let done_label = label.clone();
                let done_origin = origin.clone();
                let done = SetPermissionStateCompletedHandler::create(Box::new(move |result| {
                    rust_log(
                        &done_app,
                        format!(
                            "mic-permission: {done_label}: microphone allowed for {done_origin}: {}",
                            match result {
                                Ok(()) => "ok".to_string(),
                                Err(e) => format!("failed ({e})"),
                            }
                        ),
                    );
                    Ok(())
                }));
                if let Err(e) = profile.SetPermissionState(
                    COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                    &HSTRING::from(origin.as_str()),
                    COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                    &done,
                ) {
                    rust_log(&app, format!("mic-permission: {label}: SetPermissionState failed: {e}"));
                }
            }
            // Older WebView2 runtimes lack Profile4; the handler above still covers new prompts.
            Err(e) => rust_log(&app, format!("mic-permission: {label}: no Profile4 ({e}) — prompt handler only")),
        }
    });
    if let Err(e) = result {
        rust_log(&app, format!("mic-permission: {}: with_webview failed: {e}", window.label()));
    }
}
