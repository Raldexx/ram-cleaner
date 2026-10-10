const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let settings = null;          
let allProcesses = [];        
let originalNames = new Map(); 
let sortKey = "memory_mb";    
let sortDir = "desc";         
let activeTab = "whitelist";  
const expanded = new Set();   
const rowCache = new Map();   
let el = {};                  

const $ = (selector) => document.querySelector(selector);


// Friendly names for common apps. Everything else is auto-capitalized ("discord.exe" -> "Discord").
const APP_NAMES = {
  chrome: "Google Chrome", msedge: "Microsoft Edge", msedgewebview2: "Edge WebView",
  firefox: "Firefox", brave: "Brave", opera: "Opera", vivaldi: "Vivaldi",
  discord: "Discord", spotify: "Spotify", steam: "Steam", steamwebhelper: "Steam Web Helper",
  code: "Visual Studio Code", devenv: "Visual Studio", explorer: "File Explorer",
  taskmgr: "Task Manager", teams: "Microsoft Teams", "ms-teams": "Microsoft Teams",
  slack: "Slack", zoom: "Zoom", notepad: "Notepad", onedrive: "OneDrive",
  outlook: "Outlook", winword: "Word", excel: "Excel", powerpnt: "PowerPoint",
  telegram: "Telegram", whatsapp: "WhatsApp", obs64: "OBS Studio", vlc: "VLC",
  dwm: "Desktop Window Manager", svchost: "Service Host", cmd: "Command Prompt",
  powershell: "PowerShell", windowsterminal: "Windows Terminal", node: "Node.js",
  "ram-cleaner": "RAM Cleaner", ram_cleaner: "RAM Cleaner",
};

function displayName(name) {
  const lower = name.toLowerCase();
  const key = lower.replace(/\.exe$/, "");
  if (APP_NAMES[key]) return APP_NAMES[key];
  const original = originalNames.get(lower) || name;
  const pretty = original
    .replace(/\.exe$/i, "")
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
  return pretty || name;
}

function paintAvatar(node, name) {
  const label = displayName(name);
  node.textContent = (label[0] || "?").toUpperCase();
  let hue = 0;
  for (const c of name.toLowerCase().replace(/\.exe$/, "")) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  node.style.background = `linear-gradient(145deg, hsl(${hue} 72% 58%), hsl(${(hue + 30) % 360} 70% 45%))`;
}

function formatMem(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

// Fuzzy match: returns a score (higher = better) or -1 if no match.
// Quality order: exact > starts with > contains > letters appear in order ("chm" -> "chrome").
function fuzzyScore(query, text) {
  query = query.toLowerCase();
  text = text.toLowerCase();
  if (!query) return 0;
  if (text === query) return 1000;
  if (text.startsWith(query)) return 800 - text.length;
  const idx = text.indexOf(query);
  if (idx >= 0) return 600 - idx;
  let qi = 0, gaps = 0, last = -1;
  for (let i = 0; i < text.length && qi < query.length; i++) {
    if (text[i] === query[qi]) {
      if (last >= 0) gaps += i - last - 1;
      last = i;
      qi++;
    }
  }
  return qi === query.length ? 300 - gaps : -1;
}

// Best score of a query against both the raw name and the friendly name
function appScore(query, key) {
  return Math.max(fuzzyScore(query, key.replace(/\.exe$/, "")), fuzzyScore(query, displayName(key)));
}

function setResult(text) {
  el.result.textContent = text;
  el.result.classList.remove("flash");
  void el.result.offsetWidth; 
  el.result.classList.add("flash");
}

function pulseGauge() {
  el.gauge.classList.remove("pulse");
  void el.gauge.offsetWidth;
  el.gauge.classList.add("pulse");
}


const CIRCUMFERENCE = 2 * Math.PI * 52; 
let shownPercent = 0;
let percentAnimId = 0;

function animatePercent(target) {
  const id = ++percentAnimId;
  const from = shownPercent;
  const start = performance.now();
  const duration = 800;
  function tick(now) {
    if (id !== percentAnimId) return; 
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    shownPercent = from + (target - from) * eased;
    el.percent.textContent = Math.round(shownPercent);
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

async function refreshMemory() {
  const info = await invoke("get_memory_info");
  const pct = info.percent_used;

  el.gaugeFill.style.strokeDashoffset = CIRCUMFERENCE * (1 - pct / 100);
  el.gauge.classList.toggle("warn", pct >= 80 && pct < 90); 
  el.gauge.classList.toggle("danger", pct >= 90);           
  animatePercent(pct);

  el.statUsed.textContent = `${info.used_gb.toFixed(1)} GB`;
  el.statFree.textContent = `${info.available_gb.toFixed(1)} GB`;
  el.statTotal.textContent = `${info.total_gb.toFixed(1)} GB`;
}


async function refreshProcesses() {
  allProcesses = await invoke("get_processes");
  originalNames = new Map(allProcesses.map((p) => [p.name.toLowerCase(), p.name]));
  renderProcesses();
  renderQuickAdd(false);
}

// 12 chrome.exe processes become ONE row: "Google Chrome - 1.8 GB"
function buildGroups() {
  const map = new Map();
  for (const p of allProcesses) {
    const key = p.name.toLowerCase();
    let g = map.get(key);
    if (!g) {
      g = { key, name: "", mb: 0, procs: [] };
      map.set(key, g);
    }
    g.mb += p.memory_mb;
    g.procs.push(p);
  }
  for (const g of map.values()) g.name = displayName(g.key);
  return [...map.values()];
}

function matchesQuery(query, g) {
  if (/^\d+$/.test(query) && g.procs.some((p) => String(p.pid).includes(query))) return true; // PID search
  return appScore(query, g.key) >= 0;
}

function createRow() {
  const row = document.createElement("div");
  row.className = "app-row enter";
  row.innerHTML = `
    <div class="app-main" tabindex="0" role="button" aria-expanded="false">
      <span class="chev">&rsaquo;</span>
      <div class="avatar"></div>
      <div class="app-info"><span class="app-name"></span><small class="app-sub"></small></div>
      <div class="app-mem"><span class="mem-val"></span><div class="mem-bar"><i></i></div></div>
      <div class="app-actions">
        <button type="button" class="btn ghost mini" data-act="clean">Clean</button>
        <button type="button" class="btn ghost mini" data-act="exclude" title="Add to whitelist">Exclude</button>
      </div>
    </div>
    <div class="app-details"><div class="app-details-inner"></div></div>`;

  const main = row.querySelector(".app-main");
  const toggle = () => {
    const key = row._g.key;
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    applyOpenState(row);
  };
  main.addEventListener("click", (e) => {
    if (!e.target.closest("button")) toggle();
  });
  main.addEventListener("keydown", (e) => {
    if (e.target === main && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      toggle();
    }
  });
  row.querySelector('[data-act="clean"]').addEventListener("click", (e) => cleanGroup(row._g, e.currentTarget));
  row.querySelector('[data-act="exclude"]').addEventListener("click", () => addToList("whitelist", row._g.key));
  row.addEventListener("animationend", (e) => {
    if (e.target === row) row.classList.remove("enter");
  });
  return row;
}

function applyOpenState(row) {
  const open = expanded.has(row._g.key);
  row.classList.toggle("open", open);
  row.querySelector(".app-main").setAttribute("aria-expanded", String(open));
  if (open) renderDetails(row);
}

// The expandable part: one line per PID
function renderDetails(row) {
  const g = row._g;
  const inner = row.querySelector(".app-details-inner");
  inner.replaceChildren();

  const head = document.createElement("div");
  head.className = "pid-head";
  head.textContent = g.procs.length > 1 ? `${g.procs.length} processes` : "1 process";
  inner.appendChild(head);

  for (const p of [...g.procs].sort((a, b) => b.memory_mb - a.memory_mb)) {
    const line = document.createElement("div");
    line.className = "pid-row";
    const pid = document.createElement("span");
    pid.textContent = `PID ${p.pid}`;
    const mem = document.createElement("span");
    mem.textContent = formatMem(p.memory_mb);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn ghost mini";
    btn.textContent = "Clean";
    btn.addEventListener("click", () => cleanPid(p, g, btn));
    line.append(pid, mem, btn);
    inner.appendChild(line);
  }
}

function updateRow(row, g, maxMb) {
  row._g = g;
  row.dataset.key = g.key;
  paintAvatar(row.querySelector(".avatar"), g.key);
  row.querySelector(".app-name").textContent = g.name;
  row.querySelector(".app-sub").textContent = g.procs.length > 1 ? `${g.procs.length} processes` : "";
  row.querySelector(".mem-val").textContent = formatMem(g.mb);
  row.querySelector(".mem-bar i").style.width = `${Math.max(2, (g.mb / maxMb) * 100)}%`;
  applyOpenState(row);
}

// Filters + sorts, then reconciles the DOM: existing rows are updated in place and only
// moved when the order really changed. That keeps hover, scroll position and animations steady.
function renderProcesses() {
  const query = el.filter.value.trim();
  let groups = buildGroups();
  if (query) groups = groups.filter((g) => matchesQuery(query, g));

  groups.sort((a, b) => {
    const cmp = sortKey === "name" ? a.name.localeCompare(b.name) : a.mb - b.mb;
    return sortDir === "asc" ? cmp : -cmp;
  });

  el.appsCount.textContent = groups.length;
  el.appsEmpty.hidden = groups.length > 0;

  const keep = new Set(groups.map((g) => g.key));
  for (const [key, row] of rowCache) {
    if (!keep.has(key)) {
      row.remove();
      rowCache.delete(key);
    }
  }

  const maxMb = Math.max(1, ...groups.map((g) => g.mb));
  groups.forEach((g, i) => {
    let row = rowCache.get(g.key);
    if (!row) {
      row = createRow();
      row._g = g;
      rowCache.set(g.key, row);
    }
    updateRow(row, g, maxMb);
    if (el.appList.children[i] !== row) el.appList.insertBefore(row, el.appList.children[i] || null);
  });
}

async function cleanGroup(g, btn) {
  btn.disabled = true;
  let ok = 0;
  for (const p of g.procs) {
    if (await invoke("clean_single", { pid: p.pid })) ok++;
  }
  setResult(`${g.name}: ${ok} of ${g.procs.length} ${g.procs.length === 1 ? "process" : "processes"} cleaned`);
  await refreshAll();
  btn.disabled = false;
}

async function cleanPid(p, g, btn) {
  btn.disabled = true;
  const ok = await invoke("clean_single", { pid: p.pid });
  setResult(ok ? `${g.name} (PID ${p.pid}) cleaned` : `${g.name} (PID ${p.pid}) could not be accessed`);
  await refreshAll();
  btn.disabled = false;
}

function setupSorting() {
  for (const btn of document.querySelectorAll(".sort-btn")) {
    btn.addEventListener("click", () => {
      const key = btn.dataset.sort;
      if (sortKey === key) {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortKey = key;
        sortDir = key === "name" ? "asc" : "desc"; // names read best A-Z, memory biggest-first
      }
      for (const b of document.querySelectorAll(".sort-btn")) {
        const active = b.dataset.sort === sortKey;
        b.classList.toggle("active", active);
        if (active) b.dataset.dir = sortDir;
        else delete b.dataset.dir;
      }
      renderProcesses();
    });
  }
}

function formatResult(r) {
  const parts = [`Freed about ${Math.round(r.freed_mb)} MB`, `${r.cleaned} processes cleaned`];
  if (r.skipped) parts.push(`${r.skipped} skipped`);
  if (r.failed) parts.push(`${r.failed} inaccessible`);
  return parts.join(" \u00b7 ");
}

async function refreshAll() {
  await Promise.all([refreshMemory(), refreshProcesses()]);
}

async function cleanAll() {
  el.cleanBtn.disabled = true;
  el.cleanBtn.textContent = "Cleaning...";

  try {
    let result = await invoke("clean_all");

    // Rust says "a critical app is running": ask first, then retry with force
    if (result.blocked_by) {
      const name = displayName(result.blocked_by);
      const ok = await confirmDialog(
        "Critical app is running",
        `${name} is on your critical list. Cleaning makes other apps reload memory and can cause a short stutter.`,
        "Clean anyway",
        "Cancel"
      );
      if (!ok) {
        setResult(`Cleaning cancelled: ${name} is running`);
        return;
      }
      result = await invoke("clean_all", { force: true });
    }

    setResult(formatResult(result));
    pulseGauge();
    await refreshAll();
  } finally {
    el.cleanBtn.disabled = false;
    el.cleanBtn.textContent = "Clean now";
  }
}

const LIST_HINTS = {
  whitelist: "Apps on this list are never cleaned.",
  blacklist: "When Clean mode is set to Blacklist only, just these apps are cleaned.",
  guard_list: "While any of these apps is running, cleaning pauses until you confirm.",
};
const LIST_LABELS = { whitelist: "the whitelist", blacklist: "the blacklist", guard_list: "the critical list" };
const MODE_HINTS = {
  all: "Cleans every app except the ones on your whitelist.",
  blacklist_only: "Cleans only the apps on your blacklist.",
};

async function loadSettings() {
  settings = await invoke("get_settings");
  renderSettings();
}

async function persistSettings() {
  settings = await invoke("save_settings", { settings });
  renderSettings();
}

async function addToList(listName, rawName) {
  if (!settings) return;
  const name = rawName.trim().toLowerCase();
  if (!name || settings[listName].includes(name)) return;
  settings[listName].push(name);
  setResult(`${displayName(name)} added to ${LIST_LABELS[listName]}`);
  await persistSettings();
}

function renderSettings() {
  if (!settings) return;

  el.autoEnabled.checked = settings.auto_enabled;
  el.autoBody.classList.toggle("off", !settings.auto_enabled);
  for (const r of document.querySelectorAll('input[name="auto-trigger"]')) r.checked = r.value === settings.auto_trigger;
  el.intervalInput.value = settings.interval_minutes;
  el.thresholdInput.value = settings.threshold_percent;
  el.intervalRow.hidden = settings.auto_trigger !== "interval";
  el.thresholdRow.hidden = settings.auto_trigger !== "threshold";

  for (const r of document.querySelectorAll('input[name="clean-mode"]')) r.checked = r.value === settings.mode;
  el.modeHint.textContent = MODE_HINTS[settings.mode];

  renderListPanel(false);
}

let lastRendered = { tab: null, items: [] };

function renderListPanel(tabChanged) {
  const items = settings[activeTab];

  for (const t of document.querySelectorAll(".tab")) {
    t.classList.toggle("active", t.dataset.list === activeTab);
    t.querySelector(".tab-count").textContent = settings[t.dataset.list].length;
  }
  el.listHint.textContent = LIST_HINTS[activeTab];

  // Only items that are NEW since the last render get the pop-in animation
  const previous = lastRendered.tab === activeTab ? new Set(lastRendered.items) : null;
  el.listItems.replaceChildren();
  if (tabChanged) {
    el.listItems.classList.remove("swap");
    void el.listItems.offsetWidth;
    el.listItems.classList.add("swap");
  }

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    empty.textContent = "No apps in this list yet.";
    el.listItems.appendChild(empty);
  }

  for (const name of items) {
    const row = document.createElement("div");
    row.className = "list-item";
    if (previous && !previous.has(name)) row.classList.add("enter");

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    paintAvatar(avatar, name);

    const text = document.createElement("div");
    text.className = "li-text";
    const title = document.createElement("strong");
    title.textContent = displayName(name);
    text.appendChild(title);
    const plain = name.replace(/\.exe$/, "");
    if (title.textContent.toLowerCase() !== plain) {
      const sub = document.createElement("small");
      sub.textContent = plain;
      text.appendChild(sub);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "x-btn";
    remove.title = "Remove";
    remove.setAttribute("aria-label", `Remove ${title.textContent}`);
    remove.textContent = "\u00d7";
    remove.addEventListener("click", async () => {
      settings[activeTab] = settings[activeTab].filter((n) => n !== name);
      await persistSettings();
    });

    row.append(avatar, text, remove);
    el.listItems.appendChild(row);
  }

  lastRendered = { tab: activeTab, items: [...items] };
  renderQuickAdd(true);
}


function runningApps() {
  const map = new Map();
  for (const p of allProcesses) {
    const key = p.name.toLowerCase();
    const entry = map.get(key) || { key, count: 0, mb: 0 };
    entry.count++;
    entry.mb += p.memory_mb;
    map.set(key, entry);
  }
  return [...map.values()];
}

let quickSignature = "";
function renderQuickAdd(force) {
  if (!settings) return;
  const already = new Set(settings[activeTab]);
  const top = runningApps()
    .filter((a) => !already.has(a.key))
    .sort((a, b) => b.mb - a.mb)
    .slice(0, 5);

  const signature = activeTab + "|" + top.map((a) => a.key).join(",");
  if (!force && signature === quickSignature) return;
  quickSignature = signature;

  el.quickChips.replaceChildren();
  el.quickAdd.hidden = top.length === 0;
  for (const a of top) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip-btn";
    chip.textContent = `+ ${displayName(a.key)}`;
    chip.addEventListener("click", () => addToList(activeTab, a.key));
    el.quickChips.appendChild(chip);
  }
}

let suggestionItems = [];
let suggestionActive = -1;

function hideSuggestions() {
  el.suggestions.hidden = true;
  suggestionActive = -1;
}

function computeSuggestions() {
  const query = el.listInput.value.trim();
  const already = new Set(settings ? settings[activeTab] : []);
  return runningApps()
    .filter((a) => !already.has(a.key))
    .map((a) => ({ ...a, score: appScore(query, a.key) }))
    .filter((a) => a.score >= 0)
    .sort((a, b) => (query ? b.score - a.score || a.key.localeCompare(b.key) : b.mb - a.mb))
    .slice(0, 8);
}

function showSuggestions() {
  suggestionItems = computeSuggestions();
  el.suggestions.replaceChildren();
  if (suggestionItems.length === 0) {
    hideSuggestions();
    return;
  }
  for (const a of suggestionItems) {
    const row = document.createElement("div");
    row.className = "suggestion";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    paintAvatar(avatar, a.key);
    const name = document.createElement("span");
    name.className = "s-name";
    name.textContent = displayName(a.key);
    const meta = document.createElement("small");
    meta.textContent = formatMem(a.mb);
    row.append(avatar, name, meta);
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      chooseApp(a.key);
    });
    el.suggestions.appendChild(row);
  }
  suggestionActive = -1;
  el.suggestions.hidden = false;
}

async function chooseApp(key) {
  await addToList(activeTab, key);
  el.listInput.value = "";
  hideSuggestions();
  el.listInput.focus();
}

function resolveTyped(text) {
  const typed = text.trim().toLowerCase();
  if (!typed) return "";
  const best = computeSuggestions()[0];
  if (best && best.score >= 700) return best.key; // exact or starts-with match
  return typed.includes(".") ? typed : `${typed}.exe`;
}

function setupListEditor() {
  el.listInput.addEventListener("input", showSuggestions);
  el.listInput.addEventListener("focus", showSuggestions);
  el.listInput.addEventListener("blur", hideSuggestions);
  el.listInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (el.suggestions.hidden) showSuggestions();
      if (suggestionItems.length === 0) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      suggestionActive = (suggestionActive + step + suggestionItems.length) % suggestionItems.length;
      [...el.suggestions.children].forEach((node, i) => node.classList.toggle("active", i === suggestionActive));
    } else if (e.key === "Enter") {
      const key = suggestionActive >= 0 ? suggestionItems[suggestionActive].key : resolveTyped(el.listInput.value);
      if (key) chooseApp(key);
    } else if (e.key === "Escape") {
      hideSuggestions();
    }
  });
  el.listAddBtn.addEventListener("click", () => {
    const key = resolveTyped(el.listInput.value);
    if (key) chooseApp(key);
  });

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      if (activeTab === tab.dataset.list) return;
      activeTab = tab.dataset.list;
      el.listInput.value = "";
      hideSuggestions();
      renderListPanel(true);
    });
  }
}

function setupSettingsUi() {
  el.autoEnabled.addEventListener("change", () => {
    settings.auto_enabled = el.autoEnabled.checked;
    persistSettings();
  });
  for (const r of document.querySelectorAll('input[name="auto-trigger"]')) {
    r.addEventListener("change", () => {
      settings.auto_trigger = r.value;
      persistSettings();
    });
  }
  el.intervalInput.addEventListener("change", () => {
    settings.interval_minutes = parseInt(el.intervalInput.value, 10) || 30;
    persistSettings();
  });
  el.thresholdInput.addEventListener("change", () => {
    settings.threshold_percent = parseInt(el.thresholdInput.value, 10) || 85;
    persistSettings();
  });
  for (const r of document.querySelectorAll('input[name="clean-mode"]')) {
    r.addEventListener("change", () => {
      settings.mode = r.value;
      persistSettings();
    });
  }
  setupListEditor();
}


const THEMES = ["auto", "light", "dark"];

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === "auto") delete root.dataset.theme;
  else root.dataset.theme = mode;
  el.themeBtn.dataset.mode = mode;
  el.themeBtn.title = `Theme: ${mode[0].toUpperCase()}${mode.slice(1)}`;
}

function setupTheme() {
  let mode = "auto";
  try {
    const saved = localStorage.getItem("theme");
    if (THEMES.includes(saved)) mode = saved;
  } catch (e) {}
  applyTheme(mode);

  el.themeBtn.addEventListener("click", () => {
    mode = THEMES[(THEMES.indexOf(mode) + 1) % THEMES.length];
    try {
      localStorage.setItem("theme", mode);
    } catch (e) {}
    applyTheme(mode);
    el.themeBtn.classList.remove("spin");
    void el.themeBtn.offsetWidth;
    el.themeBtn.classList.add("spin");
  });
}

let dialogEl, dialogTitle, dialogStep, dialogBody, dialogPrimary, dialogSecondary;
let dialogResolve = null;

function setupDialog() {
  dialogEl = $("#app-dialog");
  dialogTitle = $("#dialog-title");
  dialogStep = $("#dialog-step");
  dialogBody = $("#dialog-body");
  dialogPrimary = $("#dialog-primary");
  dialogSecondary = $("#dialog-secondary");

  dialogPrimary.addEventListener("click", () => dialogResolve?.("primary"));
  dialogSecondary.addEventListener("click", () => dialogResolve?.("secondary"));
  // Esc key: don't let the browser close it behind our back, report it as "dismiss"
  dialogEl.addEventListener("cancel", (e) => {
    e.preventDefault();
    dialogResolve?.("dismiss");
  });
}

function ask({ title, step = "", body, primary = "OK", secondary = null }) {
  dialogTitle.textContent = title;
  dialogStep.textContent = step;
  dialogStep.hidden = !step;

  if (typeof body === "string") {
    const p = document.createElement("p");
    p.textContent = body;
    body = p;
  }
  dialogBody.replaceChildren(body);
  dialogBody.classList.remove("swap");
  void dialogBody.offsetWidth;
  dialogBody.classList.add("swap");

  dialogPrimary.textContent = primary;
  dialogSecondary.textContent = secondary ?? "";
  dialogSecondary.hidden = !secondary;

  if (!dialogEl.open) dialogEl.showModal();
  dialogPrimary.focus();
  return new Promise((resolve) => {
    dialogResolve = resolve;
  });
}

function closeDialog() {
  dialogResolve = null;
  dialogEl.close();
}

async function confirmDialog(title, message, primary = "OK", secondary = "Cancel") {
  const result = await ask({ title, body: message, primary, secondary });
  closeDialog();
  return result === "primary";
}

function readableTextOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  // perceived brightness: bright accent -> black text, dark accent -> white text
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#000000" : "#ffffff";
}

async function applyAccent() {
  const hex = await invoke("get_accent_color"); // null if Windows doesn't tell us
  if (!hex) return;
  const root = document.documentElement.style;
  root.setProperty("--accent", hex);
  root.setProperty("--accent-fg", readableTextOn(hex));
}


function infoBody(...paragraphs) {
  const box = document.createElement("div");
  for (const text of paragraphs) {
    const p = document.createElement("p");
    p.textContent = text;
    box.appendChild(p);
  }
  return box;
}

function radioOption(name, value, label, checked, onPick) {
  const wrap = document.createElement("label");
  wrap.className = "option";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.checked = checked;
  input.addEventListener("change", () => onPick(value));
  wrap.append(input, document.createTextNode(label));
  return wrap;
}

async function runOnboarding() {
  // choices are collected here and only applied when the user presses Finish
  const choice = {
    auto: settings.auto_enabled ? settings.auto_trigger : "off",
    autostart: await invoke("get_autostart"),
  };

  const steps = [
    {
      title: "Welcome to RAM Cleaner",
      build: () =>
        infoBody(
          "RAM Cleaner trims the memory that background apps are holding on to, so more RAM is free when you need it.",
          "This 30-second tour sets up the basics."
        ),
    },
    {
      title: "What to expect",
      build: () =>
        infoBody(
          "Windows gives memory back to apps when they ask for it, so freed RAM can slowly creep back as apps wake up.",
          "Cleaning helps most right before something heavy: a game, a build, a render. It won't speed up a PC that is already idle."
        ),
    },
    {
      title: "Protect your apps",
      build: () =>
        infoBody(
          "Add apps to the whitelist and they are never touched.",
          "Add games or editors to the critical list and cleaning pauses while they are running.",
          "Both live in the Protection card, and the search box suggests apps as you type."
        ),
    },
    {
      title: "Auto clean and startup",
      build: () => {
        const box = document.createElement("div");
        box.append(
          radioOption("tour-auto", "off", "Don't clean automatically", choice.auto === "off", (v) => (choice.auto = v)),
          radioOption("tour-auto", "interval", "Clean every 30 minutes", choice.auto === "interval", (v) => (choice.auto = v)),
          radioOption("tour-auto", "threshold", "Clean when RAM goes above 85%", choice.auto === "threshold", (v) => (choice.auto = v))
        );
        const startup = document.createElement("label");
        startup.className = "option";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = choice.autostart;
        cb.addEventListener("change", () => (choice.autostart = cb.checked));
        startup.append(cb, document.createTextNode("Start RAM Cleaner with Windows"));
        box.appendChild(startup);

        const note = document.createElement("p");
        note.className = "note";
        note.textContent =
          "Closing the window keeps RAM Cleaner running in the system tray. Use the tray icon, then Quit, to exit.";
        box.appendChild(note);
        return box;
      },
    },
  ];

  let i = 0;
  while (true) {
    const step = steps[i];
    const isLast = i === steps.length - 1;
    const result = await ask({
      title: step.title,
      step: `Step ${i + 1} of ${steps.length}`,
      body: step.build(),
      primary: isLast ? "Finish" : "Next",
      secondary: i === 0 ? "Skip" : "Back",
    });

    if (result === "primary" && !isLast) {
      i++;
    } else if (result === "primary") {
      // Finish: apply what the user picked
      settings.auto_enabled = choice.auto !== "off";
      if (choice.auto !== "off") settings.auto_trigger = choice.auto;
      const real = await invoke("set_autostart", { enabled: choice.autostart });
      el.autostart.checked = real;
      break;
    } else if (result === "secondary" && i > 0) {
      i--;
    } else {
      break; // Skip button or Esc
    }
  }

  closeDialog();
  settings.onboarded = true; // never show again (also when skipped)
  await persistSettings();
}


window.addEventListener("DOMContentLoaded", () => {
  el = {
    gauge: $("#gauge"),
    gaugeFill: $("#gauge-fill"),
    percent: $("#gauge-percent"),
    statUsed: $("#stat-used"),
    statFree: $("#stat-free"),
    statTotal: $("#stat-total"),
    cleanBtn: $("#clean-btn"),
    refreshBtn: $("#refresh-btn"),
    result: $("#clean-result"),
    filter: $("#filter-input"),
    appList: $("#app-list"),
    appsCount: $("#apps-count"),
    appsEmpty: $("#apps-empty"),
    listHint: $("#list-hint"),
    listInput: $("#list-input"),
    listAddBtn: $("#list-add-btn"),
    suggestions: $("#list-suggestions"),
    quickAdd: $("#quick-add"),
    quickChips: $("#quick-chips"),
    listItems: $("#list-items"),
    modeHint: $("#mode-hint"),
    autoEnabled: $("#auto-enabled"),
    autoBody: $("#auto-body"),
    intervalRow: $("#interval-row"),
    thresholdRow: $("#threshold-row"),
    intervalInput: $("#interval-minutes"),
    thresholdInput: $("#threshold-percent"),
    autostart: $("#autostart-enabled"),
    tourBtn: $("#tour-btn"),
    themeBtn: $("#theme-btn"),
  };

  setupTheme();
  setupDialog();
  setupSorting();
  setupSettingsUi();

  el.cleanBtn.addEventListener("click", cleanAll);
  el.refreshBtn.addEventListener("click", refreshAll);
  el.filter.addEventListener("input", renderProcesses);

  // Load settings first, then decide whether this is a first run
  loadSettings().then(() => {
    if (!settings.onboarded) runOnboarding();
  });

  // "Start with Windows" switch + welcome tour replay
  invoke("get_autostart").then((on) => (el.autostart.checked = on));
  el.autostart.addEventListener("change", async () => {
    el.autostart.checked = await invoke("set_autostart", { enabled: el.autostart.checked });
  });
  el.tourBtn.addEventListener("click", () => runOnboarding());

  // Follow the Windows accent color (also picks up changes made while the app is open)
  applyAccent();
  setInterval(applyAccent, 5000);

  // Rust's background thread (auto clean) sends events; we show them here
  listen("auto-cleaned", (e) => {
    setResult("Auto clean: " + formatResult(e.payload));
    pulseGauge();
    refreshAll();
  });
  listen("auto-clean-blocked", (e) => {
    setResult(`Auto clean skipped: ${displayName(e.payload)} is running`);
  });

  refreshAll();
  setInterval(refreshMemory, 2000);
  setInterval(refreshProcesses, 3000); // the process list is heavier, 3 seconds is enough
});
