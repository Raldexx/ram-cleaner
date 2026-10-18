use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{Emitter, Manager};

mod icons;
mod smart;
use smart::{AppState, Settings};

use windows::core::w;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::ProcessStatus::{
    EmptyWorkingSet, EnumProcesses, GetModuleBaseNameA, GetPerformanceInfo, GetProcessMemoryInfo,
    PERFORMANCE_INFORMATION, PROCESS_MEMORY_COUNTERS,
};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_SET_QUOTA, PROCESS_VM_READ,
};

/// True while the main window is on screen (not hidden to the tray, not minimized).
/// The UI stops polling and animating while this is false.
static WINDOW_VISIBLE: AtomicBool = AtomicBool::new(true);

#[derive(Serialize, Clone)]
pub struct MemoryInfo {
    total_gb: f64,
    used_gb: f64,
    available_gb: f64,
    percent_used: f64,
}

#[derive(Serialize, Clone)]
pub struct ProcessInfo {
    pid: u32,
    name: String,
    memory_mb: f64,
}

#[derive(Serialize, Clone)]
pub struct CleanResult {
    cleaned: u32,
    failed: u32,
    skipped: u32,
    freed_mb: f64,
    /// Set when cleaning was refused because a critical process is running (value = its name).
    blocked_by: Option<String>,
}

pub(crate) fn read_memory_info() -> MemoryInfo {
    let mut perf_info = PERFORMANCE_INFORMATION::default();
    perf_info.cb = std::mem::size_of::<PERFORMANCE_INFORMATION>() as u32;

    unsafe {
        let _ = GetPerformanceInfo(&mut perf_info, perf_info.cb);
    }

    let total_bytes = perf_info.PhysicalTotal * perf_info.PageSize;
    let available_bytes = perf_info.PhysicalAvailable * perf_info.PageSize;
    let used_bytes = total_bytes.saturating_sub(available_bytes);

    let to_gb = |b: usize| b as f64 / 1024.0 / 1024.0 / 1024.0;

    let total_gb = to_gb(total_bytes);
    let available_gb = to_gb(available_bytes);
    let used_gb = to_gb(used_bytes);
    let percent_used = if total_gb > 0.0 { (used_gb / total_gb) * 100.0 } else { 0.0 };

    MemoryInfo {
        total_gb,
        used_gb,
        available_gb,
        percent_used,
    }
}

fn read_process_list() -> Vec<ProcessInfo> {
    let mut process_ids: [u32; 4096] = [0; 4096];
    let mut bytes_returned: u32 = 0;

    unsafe {
        let _ = EnumProcesses(
            process_ids.as_mut_ptr(),
            std::mem::size_of_val(&process_ids) as u32,
            &mut bytes_returned,
        );
    }

    let process_count = bytes_returned as usize / std::mem::size_of::<u32>();
    let mut result = Vec::with_capacity(process_count);

    for &pid in &process_ids[..process_count] {
        if pid == 0 {
            continue;
        }

        let handle_result =
            unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid) };

        if let Ok(handle) = handle_result {
            let mut name_buffer: [u8; 260] = [0; 260];
            let name_length = unsafe { GetModuleBaseNameA(handle, None, &mut name_buffer) };
            let process_name =
                String::from_utf8_lossy(&name_buffer[..name_length as usize]).to_string();

            let mut mem_counters = PROCESS_MEMORY_COUNTERS::default();
            unsafe {
                let _ = GetProcessMemoryInfo(
                    handle,
                    &mut mem_counters,
                    std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                );
            }

            let memory_mb = mem_counters.WorkingSetSize as f64 / 1024.0 / 1024.0;

            if !process_name.is_empty() {
                result.push(ProcessInfo {
                    pid,
                    name: process_name,
                    memory_mb,
                });
            }

            unsafe {
                let _ = CloseHandle(handle);
            }
        }
    }

    // most memory-consuming processes first
    result.sort_by(|a, b| b.memory_mb.partial_cmp(&a.memory_mb).unwrap());
    result
}

fn clean_own_memory() {
    unsafe {
        let handle = GetCurrentProcess();
        let _ = EmptyWorkingSet(handle);
    }
}

fn clean_process(pid: u32) -> bool {
    // EmptyWorkingSet needs PROCESS_SET_QUOTA, not PROCESS_VM_OPERATION.
    let handle_result =
        unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA, false, pid) };

    match handle_result {
        Ok(handle) => {
            let ok = unsafe { EmptyWorkingSet(handle).is_ok() };
            unsafe {
                let _ = CloseHandle(handle);
            }
            ok
        }
        Err(_) => false,
    }
}

pub(crate) fn clean_all_processes(settings: &Settings, force: bool) -> CleanResult {
    let before = read_memory_info();
    let processes = read_process_list();

    // Critical process guard: if one is running (and the caller didn't force), touch nothing.
    if !force {
        let names: Vec<String> = processes.iter().map(|p| p.name.clone()).collect();
        if let Some(name) = settings.find_guard_hit(&names) {
            return CleanResult {
                cleaned: 0,
                failed: 0,
                skipped: 0,
                freed_mb: 0.0,
                blocked_by: Some(name),
            };
        }
    }

    let mut cleaned = 0u32;
    let mut failed = 0u32;
    let mut skipped = 0u32;

    for p in &processes {
        // whitelist / blacklist decision happens here
        if !settings.should_clean(&p.name.to_lowercase()) {
            skipped += 1;
            continue;
        }
        if clean_process(p.pid) {
            cleaned += 1;
        } else {
            failed += 1;
        }
    }

    let after = read_memory_info();
    let freed_mb = ((after.available_gb - before.available_gb) * 1024.0).max(0.0);

    CleanResult {
        cleaned,
        failed,
        skipped,
        freed_mb,
        blocked_by: None,
    }
}

/// Reads one DWORD from HKEY_CURRENT_USER\<subkey>\<value>.
fn read_dword(subkey: windows::core::PCWSTR, value: windows::core::PCWSTR) -> Option<u32> {
    let mut data: u32 = 0;
    let mut size: u32 = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey,
            value,
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut std::ffi::c_void),
            Some(&mut size),
        )
    };
    if status.0 == 0 { Some(data) } else { None }
}

/// Tells the UI whether the window is on screen, so it can stop polling while in the tray.
/// Only emits when the state actually changes (resizing fires many events).
fn publish_visibility(app: &tauri::AppHandle, visible: bool) {
    if WINDOW_VISIBLE.swap(visible, Ordering::Relaxed) != visible {
        let _ = app.emit("window-visibility", visible);
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        publish_visibility(app, true);
    }
}

#[tauri::command]
fn get_memory_info() -> MemoryInfo {
    read_memory_info()
}

// `(async)` runs a plain function on a worker thread instead of the main (UI) thread,
// so enumerating hundreds of processes can't freeze the window.
#[tauri::command(async)]
fn get_processes() -> Vec<ProcessInfo> {
    read_process_list()
}

#[tauri::command(async)]
fn clean_all(force: Option<bool>, app: tauri::AppHandle) -> CleanResult {
    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    clean_all_processes(&settings, force.unwrap_or(false))
}

#[tauri::command(async)]
fn clean_single(pid: u32) -> bool {
    clean_process(pid)
}

#[tauri::command]
fn get_settings(state: tauri::State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(mut settings: Settings, state: tauri::State<AppState>) -> Settings {
    settings.sanitize();
    *state.settings.lock().unwrap() = settings.clone();
    state.save();
    settings
}

/// Windows accent color as "#rrggbb", or None when it can't be read (the UI keeps its default blue).
#[tauri::command]
fn get_accent_color() -> Option<String> {
    let key = w!("Software\\Microsoft\\Windows\\DWM");

    // AccentColor is stored as 0xAABBGGRR (channels reversed)
    if let Some(v) = read_dword(key, w!("AccentColor")) {
        return Some(format!("#{:02x}{:02x}{:02x}", v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF));
    }
    // Fallback: ColorizationColor, stored as 0xAARRGGBB
    read_dword(key, w!("ColorizationColor"))
        .map(|v| format!("#{:02x}{:02x}{:02x}", (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF))
}

#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(enabled: bool, app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let _ = if enabled { manager.enable() } else { manager.disable() };
    manager.is_enabled().unwrap_or(false)
}

#[tauri::command]
fn is_window_visible() -> bool {
    WINDOW_VISIBLE.load(Ordering::Relaxed)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    clean_own_memory();

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            // Windows starts us with this flag at login, so we can stay in the tray quietly.
            Some(vec!["--minimized"]),
        ))
        .setup(|app| {
            use tauri_plugin_autostart::ManagerExt;

            // Settings live in %APPDATA%\<identifier>\settings.json
            let config_dir = app.path().app_config_dir()?;
            app.manage(AppState::load(config_dir.join("settings.json")));

            // Only on the very first run, start with Windows by default.
            // After onboarding the user's own choice is never overridden.
            let first_run = !app.state::<AppState>().settings.lock().unwrap().onboarded;
            if first_run {
                let _ = app.autolaunch().enable();
            }
            smart::start_auto_cleaner(app.handle().clone());

            // The window is created hidden (see tauri.conf.json) so a login start
            // doesn't flash a window on screen. Show it unless we were asked to stay quiet.
            let start_hidden = std::env::args().any(|a| a == "--minimized");
            if start_hidden {
                WINDOW_VISIBLE.store(false, Ordering::Relaxed);
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }

            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("RAM Cleaner")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
                publish_visibility(window.app_handle(), false);
                clean_own_memory();
            }
            tauri::WindowEvent::Resized(_) => {
                // Minimizing arrives as a resize; treat a minimized window like a hidden one.
                let on_screen = window.is_visible().unwrap_or(true)
                    && !window.is_minimized().unwrap_or(false);
                publish_visibility(window.app_handle(), on_screen);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_memory_info,
            get_processes,
            clean_all,
            clean_single,
            get_settings,
            save_settings,
            get_accent_color,
            get_autostart,
            set_autostart,
            is_window_visible,
            icons::get_app_icon
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
