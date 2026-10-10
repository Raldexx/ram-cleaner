use serde::Serialize;

mod smart;
use smart::{AppState, Settings};

use windows::core::w;
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};

use windows::Win32::System::ProcessStatus::{
    GetPerformanceInfo, PERFORMANCE_INFORMATION, EnumProcesses, GetModuleBaseNameA,
    PROCESS_MEMORY_COUNTERS, GetProcessMemoryInfo, EmptyWorkingSet,
};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_SET_QUOTA, PROCESS_VM_READ,
    GetCurrentProcess,
};

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
    let mut process_ids: [u32; 1024] = [0; 1024];
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

    for i in 0..process_count {
        let pid = process_ids[i];
        if pid == 0 {
            continue;
        }


        let handle_result = unsafe {
            OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid)
        };

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
    let handle_result = unsafe {
        OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA, false, pid)
    };

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

    // critical process guard: whitelist/blacklist/guard_list controls which processes can be cleaned. If a guard process is running, cleaning is blocked.
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


#[tauri::command]
fn get_memory_info() -> MemoryInfo {
    read_memory_info()
}

#[tauri::command]
fn get_processes() -> Vec<ProcessInfo> {
    read_process_list()
}

#[tauri::command]
fn clean_all(force: Option<bool>, state: tauri::State<AppState>) -> CleanResult {
    let settings = state.settings.lock().unwrap().clone();
    clean_all_processes(&settings, force.unwrap_or(false))
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

#[tauri::command]
fn get_accent_color() -> Option<String> {
    let key = w!("Software\\Microsoft\\Windows\\DWM");

    if let Some(v) = read_dword(key, w!("AccentColor")) {
        return Some(format!("#{:02x}{:02x}{:02x}", v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF));
    }
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
fn clean_single(pid: u32) -> bool {
    clean_process(pid)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::tray::TrayIconBuilder;
    use tauri::menu::{Menu, MenuItem};
    use tauri::Manager;


    clean_own_memory();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            use tauri_plugin_autostart::ManagerExt;

            let config_dir = app.path().app_config_dir()?;
            app.manage(AppState::load(config_dir.join("settings.json")));

            let first_run = !app.state::<AppState>().settings.lock().unwrap().onboarded;
            if first_run {
                let _ = app.autolaunch().enable();
            }
            smart::start_auto_cleaner(app.handle().clone());

            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            window.show().unwrap();
                            window.set_focus().unwrap();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window.hide().unwrap();
                api.prevent_close();
            }
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
            set_autostart
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
