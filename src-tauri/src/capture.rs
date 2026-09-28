use std::sync::Mutex;
use tauri::ipc::Response;
use tauri::State;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

pub struct CaptureState {
    pub bounds: Mutex<Option<CaptureBounds>>,
}

#[derive(Clone, serde::Deserialize)]
pub struct CaptureBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Length of the frame header `capture_minimap` prefixes to its pixel data.
///
/// Wire format, shared with src/core/capture-frame.ts and only valid if both
/// sides change together: 4-byte little-endian width, 4-byte little-endian
/// height, then width * height * 4 bytes of top-down, row-major RGBA with no
/// row padding.
///
/// The dimensions travel with the pixels even though the frontend is the side
/// that set them (via `set_capture_bounds`): every CV read is indexed against
/// the frontend's own capture bounds, so a divergence has to be detectable
/// there rather than silently reinterpreted as a different row stride.
const HEADER_LEN: usize = 8;

#[tauri::command]
pub fn set_capture_bounds(state: State<CaptureState>, bounds: CaptureBounds) {
    *lock_bounds(&state.bounds) = Some(bounds);
}

/// Capture the configured screen region with Win32 GDI BitBlt.
/// Returns the raw frame described by HEADER_LEN.
#[tauri::command]
pub async fn capture_minimap(state: State<'_, CaptureState>) -> Result<Response, String> {
    let bounds = bounds_snapshot(&state.bounds)?;

    // The GDI work is blocking and runs 30x/second. On the shared async runtime
    // it would compete with the overlay's click-through hit-test loop (main.rs),
    // which has to answer every 33ms to keep the panel clickable.
    let frame = tauri::async_runtime::spawn_blocking(move || capture_frame(&bounds))
        .await
        .map_err(|e| format!("Capture task failed: {}", e))??;

    Ok(Response::new(frame))
}

/// Poisoning can only mean a previous holder panicked; the bounds are a plain
/// value with no invariant to uphold, so recovering beats taking the process
/// down from inside a command.
fn lock_bounds(
    bounds: &Mutex<Option<CaptureBounds>>,
) -> std::sync::MutexGuard<'_, Option<CaptureBounds>> {
    bounds.lock().unwrap_or_else(|e| e.into_inner())
}

/// Copy the bounds out of the mutex. Kept out of the async command so the
/// guard can never be held across an await point.
fn bounds_snapshot(bounds: &Mutex<Option<CaptureBounds>>) -> Result<CaptureBounds, String> {
    lock_bounds(bounds)
        .as_ref()
        .cloned()
        .ok_or_else(|| "Capture bounds not set. Call set_capture_bounds first.".to_string())
}

fn capture_frame(bounds: &CaptureBounds) -> Result<Vec<u8>, String> {
    let width = bounds.width;
    let height = bounds.height;

    if width <= 0 || height <= 0 {
        return Err("Invalid capture dimensions".into());
    }

    // Bounds off the virtual screen BitBlt to black rather than failing, which
    // downstream is indistinguishable from "the minimap isn't on screen". Say so.
    let virt = virtual_screen_bounds();
    if !rects_overlap((bounds.x, bounds.y, width, height), virt) {
        return Err(format!(
            "Capture bounds ({},{} {}x{}) lie outside the virtual screen ({},{} {}x{})",
            bounds.x, bounds.y, width, height, virt.0, virt.1, virt.2, virt.3
        ));
    }

    let pixel_len = (width as usize) * (height as usize) * 4;
    let mut out = vec![0u8; HEADER_LEN + pixel_len];
    out[0..4].copy_from_slice(&(width as u32).to_le_bytes());
    out[4..8].copy_from_slice(&(height as u32).to_le_bytes());

    capture_screen_region_into(bounds.x, bounds.y, width, height, &mut out[HEADER_LEN..])
        .map_err(|e| format!("Screen capture failed: {}", e))?;

    bgra_to_rgba_in_place(&mut out[HEADER_LEN..]);

    Ok(out)
}

/// GDI hands back BGRA with an undefined 4th byte. ImageData wants RGBA, and
/// the classifier's putImageData -> drawImage round trip premultiplies, so an
/// alpha of 0 would zero out every channel it reads.
fn bgra_to_rgba_in_place(px: &mut [u8]) {
    for p in px.chunks_exact_mut(4) {
        p.swap(0, 2);
        p[3] = 255;
    }
}

/// Capture a region of the screen using Win32 GDI into `dst`, which must hold
/// exactly width * height * 4 bytes. Writes top-down BGRA.
fn capture_screen_region_into(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    dst: &mut [u8],
) -> Result<(), String> {
    unsafe {
        // GetDC(NULL) is the DC for the whole VIRTUAL screen. The desktop
        // window's DC is clipped to the primary monitor, so a game on a second
        // display — source coordinates that are negative or past the primary's
        // width — cannot be read through it.
        let hwnd = HWND(std::ptr::null_mut());
        let hdc_screen = GetDC(hwnd);
        if hdc_screen.is_invalid() {
            return Err("GetDC failed".into());
        }

        let hdc_mem = CreateCompatibleDC(hdc_screen);
        if hdc_mem.is_invalid() {
            ReleaseDC(hwnd, hdc_screen);
            return Err("CreateCompatibleDC failed".into());
        }

        let hbmp = CreateCompatibleBitmap(hdc_screen, width, height);
        if hbmp.is_invalid() {
            let _ = DeleteDC(hdc_mem);
            ReleaseDC(hwnd, hdc_screen);
            return Err("CreateCompatibleBitmap failed".into());
        }

        let old_bmp = SelectObject(hdc_mem, hbmp);

        // BitBlt the screen region
        let success = BitBlt(hdc_mem, 0, 0, width, height, hdc_screen, x, y, SRCCOPY);
        if success.is_err() {
            SelectObject(hdc_mem, old_bmp);
            let _ = DeleteObject(hbmp);
            let _ = DeleteDC(hdc_mem);
            ReleaseDC(hwnd, hdc_screen);
            return Err("BitBlt failed".into());
        }

        // Extract pixel data
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // negative = top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0 as u32,
                ..Default::default()
            },
            ..Default::default()
        };

        let lines = GetDIBits(
            hdc_mem,
            hbmp,
            0,
            height as u32,
            Some(dst.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        // Cleanup
        SelectObject(hdc_mem, old_bmp);
        let _ = DeleteObject(hbmp);
        let _ = DeleteDC(hdc_mem);
        ReleaseDC(hwnd, hdc_screen);

        if lines == 0 {
            return Err("GetDIBits failed".into());
        }

        Ok(())
    }
}

/// (x, y, width, height) of the virtual screen — the union of every monitor.
/// Origin is the primary monitor's top-left, so x/y are negative when a display
/// sits left of / above it.
fn virtual_screen_bounds() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

fn rects_overlap(a: (i32, i32, i32, i32), b: (i32, i32, i32, i32)) -> bool {
    a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3
}

#[cfg(test)]
mod tests {
    use super::{bgra_to_rgba_in_place, rects_overlap};

    // A capture square on a monitor left of the primary one has a negative
    // origin and must still count as on-screen — rejecting it would break the
    // very case the virtual-screen DC exists to serve.
    #[test]
    fn negative_origin_inside_the_virtual_screen_overlaps() {
        let virt = (-1920, 0, 3840, 1080);
        assert!(rects_overlap((-378, 702, 378, 378), virt));
    }

    // A minimized window's (-32000, -32000) rect, and a rect past the right
    // edge, are the two shapes that used to BitBlt silently to black.
    #[test]
    fn rects_fully_outside_do_not_overlap() {
        let virt = (0, 0, 1920, 1080);
        assert!(!rects_overlap((-32378, -32378, 378, 378), virt));
        assert!(!rects_overlap((1920, 702, 378, 378), virt));
        assert!(!rects_overlap((1542, 1080, 378, 378), virt));
    }

    // Touching edges share no pixels, one pixel of overlap does.
    #[test]
    fn overlap_is_exclusive_at_the_far_edge() {
        let virt = (0, 0, 1920, 1080);
        assert!(!rects_overlap((-378, 0, 378, 100), virt));
        assert!(rects_overlap((-377, 0, 378, 100), virt));
    }

    // The teal ally border the CV keys on (r<100, g>120, b>120) reads as red
    // if the channels are left in GDI's order, so every icon blob disappears
    // and tracking never leaves SCANNING.
    #[test]
    fn bgra_becomes_rgba_with_opaque_alpha() {
        // Teal (30,200,190) and red (200,60,60) as GDI delivers them.
        let mut px = vec![190, 200, 30, 0, 60, 60, 200, 7];
        bgra_to_rgba_in_place(&mut px);
        assert_eq!(px, vec![30, 200, 190, 255, 200, 60, 60, 255]);
    }

    // Applied twice the swap is its own inverse — the failure mode of "fix it
    // on both sides of the wire".
    #[test]
    fn swapping_twice_restores_the_original_channel_order() {
        let mut px = vec![190, 200, 30, 255];
        bgra_to_rgba_in_place(&mut px);
        bgra_to_rgba_in_place(&mut px);
        assert_eq!(&px[0..3], &[190, 200, 30]);
    }

    // A truncated tail must not panic: chunks_exact_mut leaves it alone.
    #[test]
    fn a_trailing_partial_pixel_is_ignored() {
        let mut px = vec![190, 200, 30, 0, 1, 2];
        bgra_to_rgba_in_place(&mut px);
        assert_eq!(px, vec![30, 200, 190, 255, 1, 2]);
    }

    #[test]
    fn an_empty_buffer_is_a_no_op() {
        let mut px: Vec<u8> = Vec::new();
        bgra_to_rgba_in_place(&mut px);
        assert!(px.is_empty());
    }
}
