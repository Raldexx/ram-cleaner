use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// User settings, stored on disk as settings.json.
/// `#[serde(default)]` fills any missing field with its default, so adding a new
/// setting later never breaks an older settings.json.
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    /// Whitelist: these processes are never cleaned.
    pub whitelist: Vec<String>,
    /// Blacklist: when mode is "blacklist_only", only these are cleaned.
    pub blacklist: Vec<String>,
    /// "all" = everything except the whitelist, "blacklist_only" = only the blacklist.
    pub mode: String,
    /// Critical processes (games, renders...): while one is running, cleaning pauses until confirmed.
    pub guard_list: Vec<String>,
    pub auto_enabled: bool,
    /// "interval" = every X minutes, "threshold" = when RAM usage passes a percentage.
    pub auto_trigger: String,
    pub interval_minutes: u32,
    pub threshold_percent: u32,
    /// Whether the welcome tour was finished or skipped. While false, the UI shows it.
    pub onboarded: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            whitelist: Vec::new(),
            blacklist: Vec::new(),
            mode: "all".into(),
            guard_list: Vec::new(),
            auto_enabled: false,
            auto_trigger: "interval".into(),
            interval_minutes: 30,
            threshold_percent: 85,
            onboarded: false,
        }
    }
}

impl Settings {
    /// Tidies incoming data: lowercase, trim, drop duplicates, clamp numbers.
    pub fn sanitize(&mut self) {
        fn norm(v: &mut Vec<String>) {
            let mut out: Vec<String> = Vec::new();
            for s in v.iter() {
                let s = s.trim().to_lowercase();
                if !s.is_empty() && !out.contains(&s) {
                    out.push(s);
                }
            }
            *v = out;
        }
        norm(&mut self.whitelist);
        norm(&mut self.blacklist);
        norm(&mut self.guard_list);
        if self.mode != "blacklist_only" {
            self.mode = "all".into();
        }
        if self.auto_trigger != "threshold" {
            self.auto_trigger = "interval".into();
        }
        self.interval_minutes = self.interval_minutes.clamp(1, 1440);
        self.threshold_percent = self.threshold_percent.clamp(50, 99);
    }

    /// Should this process be cleaned? (`lname` must be lowercase)
    pub fn should_clean(&self, lname: &str) -> bool {
        if self.whitelist.iter().any(|w| w == lname) {
            return false;
        }
        if self.mode == "blacklist_only" {
            return self.blacklist.iter().any(|b| b == lname);
        }
        true
    }

    /// Is any critical process running? Returns the name of the first one found.
    pub fn find_guard_hit(&self, running_names: &[String]) -> Option<String> {
        running_names
            .iter()
            .find(|n| self.guard_list.contains(&n.to_lowercase()))
            .cloned()
    }
}

/// Shared state registered with Tauri's `manage()`; commands reach it through `State`.
pub struct AppState {
    pub settings: Mutex<Settings>,
    pub path: PathBuf,
}

impl AppState {
    pub fn load(path: PathBuf) -> Self {
        let mut settings = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
            .unwrap_or_default();
        settings.sanitize();
        AppState {
            settings: Mutex::new(settings),
            path,
        }
    }

    pub fn save(&self) {
        let snapshot = self.settings.lock().unwrap().clone();
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(&snapshot) {
            let _ = std::fs::write(&self.path, text);
        }
    }
}

/// Background thread: keeps running while the window is hidden in the tray,
/// which is why the timer lives in Rust and not in JavaScript.
pub fn start_auto_cleaner(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_clean = Instant::now();
        loop {
            std::thread::sleep(Duration::from_secs(5));

            let state = app.state::<AppState>();
            let settings = state.settings.lock().unwrap().clone();

            if !settings.auto_enabled {
                last_clean = Instant::now(); // keep the clock at zero while disabled
                continue;
            }

            let elapsed = last_clean.elapsed();
            let due = if settings.auto_trigger == "threshold" {
                // 60 s cooldown: if RAM stays above the threshold after a clean, don't loop
                elapsed >= Duration::from_secs(60)
                    && crate::read_memory_info().percent_used >= settings.threshold_percent as f64
            } else {
                elapsed >= Duration::from_secs(settings.interval_minutes as u64 * 60)
            };
            if !due {
                continue;
            }

            last_clean = Instant::now();
            let result = crate::clean_all_processes(&settings, false);
            match result.blocked_by.clone() {
                Some(name) => {
                    let _ = app.emit("auto-clean-blocked", name);
                }
                None => {
                    let _ = app.emit("auto-cleaned", result);
                }
            }
        }
    });
}
