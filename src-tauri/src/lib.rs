use windows::Win32::System::ProcessStatus::{GetPerformanceInfo, PERFORMANCE_INFORMATION, EnumProcesses, GetModuleBaseNameA, PROCESS_MEMORY_COUNTERS, GetProcessMemoryInfo, EmptyWorkingSet};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ, GetCurrentProcess};

fn get_memory_info() {
    let mut perf_info = PERFORMANCE_INFORMATION::default();
    perf_info.cb = std::mem::size_of::<PERFORMANCE_INFORMATION>() as u32;

    unsafe {
        let _ = GetPerformanceInfo(&mut perf_info, perf_info.cb);
    }

    let total_ram_bytes = perf_info.PhysicalTotal * perf_info.PageSize;
    let available_ram_bytes = perf_info.PhysicalAvailable * perf_info.PageSize;
    
    let total_ram_gb = total_ram_bytes as f64 / 1024.0 / 1024.0 / 1024.0;
let available_ram_gb = available_ram_bytes as f64 / 1024.0 / 1024.0 / 1024.0;

    println!("Total RAM: {:.2} GB", total_ram_gb);
    println!("Empty RAM: {:.2} GB", available_ram_gb);
}

fn get_process_list() {
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

    for i in 0..process_count {
        println!("PID: {}", process_ids[i]);

        let pid = process_ids[i];

let handle_result = unsafe {
    OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid)
};

match handle_result {
    Ok(handle) => {
        let mut name_buffer: [u8; 260] = [0; 260];

        let name_length = unsafe {
            GetModuleBaseNameA(handle, None, &mut name_buffer)
        };

        let process_name = String::from_utf8_lossy(&name_buffer[..name_length as usize]);

        let mut mem_counters = PROCESS_MEMORY_COUNTERS::default();
        unsafe {
       let _ = GetProcessMemoryInfo(
           handle,
           &mut mem_counters,
           std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
       );
   }

   let ram_usage_mb = mem_counters.WorkingSetSize as f64 / 1024.0 / 1024.0;
   println!("  -> PID: {} | Name: {} | RAM: {:.2} MB", pid, process_name, ram_usage_mb);
   
   unsafe {
    let _ = EmptyWorkingSet(handle);
}

    unsafe {
    let _ = CloseHandle(handle);
}
   
    }
    Err(_) => println!("  -> Handle failed (PID: {})", pid),
}
    } // for loop closed
} // get_process_list fonction closed

fn clean_own_memory() {
    unsafe {
        let handle = GetCurrentProcess();
        let _ = EmptyWorkingSet(handle);
    }
    println!("Clean done");
}


#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::tray::TrayIconBuilder;
    use tauri::menu::{Menu, MenuItem};
    use tauri::Manager;

    clean_own_memory();
    get_process_list();
    get_memory_info();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            use tauri_plugin_autostart::ManagerExt;
            let _ = app.autolaunch().enable();
            
            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
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
                    }
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
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}