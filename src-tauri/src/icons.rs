//! Extracts the icon of a running app so the UI can show it next to the app name.
//!
//! Flow: PID -> exe path -> shell icon (HICON) -> raw RGBA pixels -> UI draws them on a canvas.
//! Results are cached per exe path, so each icon is only extracted once per session.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC,
};
use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

#[derive(Serialize, Clone)]
pub struct IconData {
    width: u32,
    height: u32,
    /// width * height * 4 bytes, RGBA order
    rgba: Vec<u8>,
}

static CACHE: OnceLock<Mutex<HashMap<String, Option<IconData>>>> = OnceLock::new();

fn exe_path(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if ok {
            Some(String::from_utf16_lossy(&buffer[..length as usize]))
        } else {
            None
        }
    }
}

/// Copies a bitmap's pixels as 32-bit BGRA, top row first.
unsafe fn read_pixels(hdc: HDC, bitmap: HBITMAP, width: i32, height: i32) -> Option<Vec<u8>> {
    if bitmap.is_invalid() {
        return None;
    }
    let mut info: BITMAPINFO = std::mem::zeroed();
    info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = width;
    info.bmiHeader.biHeight = -height; // negative height = top-down rows
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB.0;

    let mut pixels = vec![0u8; (width * height * 4) as usize];
    let lines = GetDIBits(
        hdc,
        bitmap,
        0,
        height as u32,
        Some(pixels.as_mut_ptr() as *mut c_void),
        &mut info,
        DIB_RGB_COLORS,
    );
    if lines == 0 {
        None
    } else {
        Some(pixels)
    }
}

unsafe fn pixels_from_icon_info(info: &ICONINFO) -> Option<IconData> {
    if info.hbmColor.is_invalid() {
        return None; // monochrome cursor-style icon, not worth drawing
    }

    let mut bitmap: BITMAP = std::mem::zeroed();
    let got = GetObjectW(
        info.hbmColor.into(),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bitmap as *mut BITMAP as *mut c_void),
    );
    let (width, height) = (bitmap.bmWidth, bitmap.bmHeight);
    if got == 0 || width <= 0 || height <= 0 || width > 256 || height > 256 {
        return None;
    }

    let hdc = GetDC(None);
    let color = read_pixels(hdc, info.hbmColor, width, height);
    let mask = read_pixels(hdc, info.hbmMask, width, height);
    ReleaseDC(None, hdc);

    let mut rgba = color?;
    // Newer icons carry their own alpha channel. Old ones don't: for those, the
    // separate mask bitmap says which pixels are see-through.
    let has_alpha = rgba.chunks_exact(4).any(|px| px[3] != 0);
    for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
        px.swap(0, 2); // BGRA -> RGBA
        if !has_alpha {
            let see_through = mask.as_ref().map(|m| m[i * 4] != 0).unwrap_or(false);
            px[3] = if see_through { 0 } else { 255 };
        }
    }

    Some(IconData {
        width: width as u32,
        height: height as u32,
        rgba,
    })
}

fn extract_icon(path: &str) -> Option<IconData> {
    unsafe {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut file_info: SHFILEINFOW = std::mem::zeroed();
        let found = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut file_info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if found == 0 || file_info.hIcon.is_invalid() {
            return None;
        }

        let icon: HICON = file_info.hIcon;
        let mut icon_info: ICONINFO = std::mem::zeroed();
        let result = if GetIconInfo(icon, &mut icon_info).is_ok() {
            let data = pixels_from_icon_info(&icon_info);
            // GetIconInfo hands us copies of the bitmaps; we must free them.
            let _ = DeleteObject(icon_info.hbmColor.into());
            let _ = DeleteObject(icon_info.hbmMask.into());
            data
        } else {
            None
        };
        let _ = DestroyIcon(icon);
        result
    }
}

/// Returns the icon of the app that owns `pid`, or None if it can't be read
/// (protected system processes, apps without an icon). The UI then keeps its letter avatar.
#[tauri::command(async)]
pub fn get_app_icon(pid: u32) -> Option<IconData> {
    let path = exe_path(pid)?;
    let key = path.to_lowercase();

    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().unwrap().get(&key) {
        return hit.clone();
    }

    let icon = extract_icon(&path);
    cache.lock().unwrap().insert(key, icon.clone());
    icon
}
