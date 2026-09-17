use base64::Engine;
use std::sync::Mutex;
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

#[derive(serde::Serialize)]
pub struct CaptureResult {
    pub data_url: String,
    pub width: i32,
    pub height: i32,
}

#[tauri::command]
pub fn set_capture_bounds(state: State<CaptureState>, bounds: CaptureBounds) {
    *state.bounds.lock().unwrap() = Some(bounds);
}

/// Capture a region of the screen using Win32 GDI BitBlt.
/// Returns a base64-encoded BMP data URL that can be loaded as an Image in the webview.
#[tauri::command]
pub fn capture_minimap(state: State<CaptureState>) -> Result<CaptureResult, String> {
    let bounds = state.bounds.lock().unwrap();
    let bounds = bounds
        .as_ref()
        .ok_or("Capture bounds not set. Call set_capture_bounds first.")?;

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

    let pixels = capture_screen_region(bounds.x, bounds.y, width, height)
        .map_err(|e| format!("Screen capture failed: {}", e))?;

    // Build a BMP file in memory (BGR24, bottom-up)
    let row_stride = ((width * 3 + 3) / 4) * 4;
    let pixel_data_size = row_stride * height;
    let file_size = 54 + pixel_data_size;

    let mut bmp = Vec::with_capacity(file_size as usize);

    // BMP File Header (14 bytes)
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&(file_size as u32).to_le_bytes());
    bmp.extend_from_slice(&[0u8; 4]); // reserved
    bmp.extend_from_slice(&54u32.to_le_bytes()); // pixel data offset

    // DIB Header (BITMAPINFOHEADER, 40 bytes)
    bmp.extend_from_slice(&40u32.to_le_bytes());
    bmp.extend_from_slice(&(width as u32).to_le_bytes());
    bmp.extend_from_slice(&(height as u32).to_le_bytes()); // positive = bottom-up
    bmp.extend_from_slice(&1u16.to_le_bytes()); // planes
    bmp.extend_from_slice(&24u16.to_le_bytes()); // bpp
    bmp.extend_from_slice(&0u32.to_le_bytes()); // compression
    bmp.extend_from_slice(&(pixel_data_size as u32).to_le_bytes());
    bmp.extend_from_slice(&[0u8; 16]); // ppm + colors

    // Pixel data: BGRA from capture → BGR rows, bottom-up, padded
    for y in (0..height).rev() {
        let src_row = (y * width * 4) as usize;
        for x in 0..width {
            let i = src_row + (x * 4) as usize;
            bmp.push(pixels[i]);     // B
            bmp.push(pixels[i + 1]); // G
            bmp.push(pixels[i + 2]); // R
        }
        let padding = (row_stride - width * 3) as usize;
        bmp.extend(std::iter::repeat(0u8).take(padding));
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(&bmp);

    Ok(CaptureResult {
        data_url: format!("data:image/bmp;base64,{}", b64),
        width,
        height,
    })
}

/// Capture a region of the screen using Win32 GDI.
/// Returns BGRA pixel data (top-down, 4 bytes per pixel).
fn capture_screen_region(x: i32, y: i32, width: i32, height: i32) -> Result<Vec<u8>, String> {
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

        let buf_size = (width * height * 4) as usize;
        let mut pixels = vec![0u8; buf_size];

        let lines = GetDIBits(
            hdc_mem,
            hbmp,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut _),
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

        Ok(pixels)
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
    use super::rects_overlap;

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
}
