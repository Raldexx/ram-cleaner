const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let ramText, ramBarFill, cleanBtn, refreshBtn, cleanResult, processTbody, filterInput, tableHeaders;

let settings = null;

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

let allProcesses = [];
let sortKey = "memory_mb"; 
let sortDir = "desc";      

async function refreshMemory() {
  const info = await invoke("get_memory_info");
  ramBarFill.style.width = `${info.percent_used.toFixed(1)}%`;
  ramText.textContent =
    `${info.used_gb.toFixed(2)} GB / ${info.total_gb.toFixed(2)} GB used ` +
    `(${info.percent_used.toFixed(1)}%)`;
}

async function refreshProcesses() {
  allProcesses = await invoke("get_processes");
  renderProcesses();
}

function renderProcesses() {
  const query = filterInput.value.trim().toLowerCase();

  let list = allProcesses;
  if (query) {
    list = list.filter((p) => fuzzyScore(query, p.name) >= 0 || String(p.pid).includes(query));
  }

  list = [...list].sort((a, b) => {
    const cmp =
      sortKey === "name"
        ? a.name.localeCompare(b.name)
        : a[sortKey] - b[sortKey]; 
    return sortDir === "asc" ? cmp : -cmp;
  });

  processTbody.innerHTML = "";
  for (const p of list) {
    const row = document.createElement("tr");

    const pidCell = document.createElement("td");
    pidCell.textContent = p.pid;

    const nameCell = document.createElement("td");
    nameCell.textContent = p.name;

    const memCell = document.createElement("td");
    memCell.textContent = p.memory_mb.toFixed(1);

    const actionCell = document.createElement("td");
    const rowBtn = document.createElement("button");
    rowBtn.textContent = "Clean";
    rowBtn.className = "row-clean-btn";
    rowBtn.addEventListener("click", async () => {
      rowBtn.disabled = true;
      await invoke("clean_single", { pid: p.pid });
      await refreshAll();
    });
    const excludeBtn = document.createElement("button");
    excludeBtn.textContent = "Exclude";
    excludeBtn.className = "row-clean-btn";
    excludeBtn.title = "Add to whitelist";
    excludeBtn.addEventListener("click", () => addToList("whitelist", p.name));
    actionCell.appendChild(rowBtn);
    actionCell.appendChild(excludeBtn);

    row.appendChild(pidCell);
    row.appendChild(nameCell);
    row.appendChild(memCell);
    row.appendChild(actionCell);
    processTbody.appendChild(row);
  }

  updateSortIndicators();
}

function updateSortIndicators() {
  for (const th of tableHeaders) {
    const key = th.dataset.sort;
    if (!key) continue; 
    const arrow = key === sortKey ? (sortDir === "asc" ? " ▲" : " ▼") : "";
    th.textContent = th.dataset.label + arrow;
  }
}

function handleHeaderClick(e) {
  const key = e.currentTarget.dataset.sort;
  if (!key) return;
  if (sortKey === key) {
    sortDir = sortDir === "asc" ? "desc" : "asc";
  } else {
    sortKey = key;
    sortDir = "desc";
  }
  renderProcesses(); 
}

async function refreshAll() {
  await refreshMemory();
  await refreshProcesses();
}

function formatResult(r) {
  return (
    `${r.cleaned} processes cleaned, ${r.failed} failed to access, ${r.skipped} skipped ` +
    `(~${r.freed_mb.toFixed(0)} MB freed)`
  );
}

async function cleanAll() {
  cleanBtn.disabled = true;
  cleanBtn.textContent = "Cleaning...";

  try {
    let result = await invoke("clean_all");

    if (result.blocked_by) {
      const ok = confirm(`${result.blocked_by} is running (critical process). Clean anyway?`);
      if (!ok) {
        cleanResult.textContent = `Blocked: ${result.blocked_by} is running`;
        return;
      }
      result = await invoke("clean_all", { force: true });
    }

    cleanResult.textContent = formatResult(result);
    await refreshAll();
  } finally {
    cleanBtn.disabled = false;
    cleanBtn.textContent = "Clean";
  }
}


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
  await persistSettings();
}

function renderSettings() {
  document.querySelector("#auto-enabled").checked = settings.auto_enabled;
  document.querySelector("#auto-trigger").value = settings.auto_trigger;
  document.querySelector("#interval-minutes").value = settings.interval_minutes;
  document.querySelector("#threshold-percent").value = settings.threshold_percent;
  document.querySelector("#clean-mode").value = settings.mode;

  const isInterval = settings.auto_trigger === "interval";
  document.querySelector("#interval-label").hidden = !isInterval;
  document.querySelector("#threshold-label").hidden = isInterval;

  for (const editor of document.querySelectorAll(".list-editor")) {
    const listName = editor.dataset.list;
    const chips = editor.querySelector(".chips");
    chips.innerHTML = "";
    for (const item of settings[listName]) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = item;
      const x = document.createElement("button");
      x.textContent = "×";
      x.addEventListener("click", async () => {
        settings[listName] = settings[listName].filter((n) => n !== item);
        await persistSettings();
      });
      chip.appendChild(x);
      chips.appendChild(chip);
    }
  }
}

function setupSettingsUi() {
  document.querySelector("#auto-enabled").addEventListener("change", (e) => {
    settings.auto_enabled = e.target.checked;
    persistSettings();
  });
  document.querySelector("#auto-trigger").addEventListener("change", (e) => {
    settings.auto_trigger = e.target.value;
    persistSettings();
  });
  document.querySelector("#interval-minutes").addEventListener("change", (e) => {
    settings.interval_minutes = parseInt(e.target.value, 10) || 30;
    persistSettings();
  });
  document.querySelector("#threshold-percent").addEventListener("change", (e) => {
    settings.threshold_percent = parseInt(e.target.value, 10) || 85;
    persistSettings();
  });
  document.querySelector("#clean-mode").addEventListener("change", (e) => {
    settings.mode = e.target.value;
    persistSettings();
  });

  // Three list editors share the same code: type -> suggestions appear -> pick or press Enter
  for (const editor of document.querySelectorAll(".list-editor")) {
    setupListEditor(editor);
  }
}

// Distinct running app names with how many instances are running and their total RAM.
function runningApps() {
  const map = new Map();
  for (const p of allProcesses) {
    const key = p.name.toLowerCase();
    const entry = map.get(key) || { name: key, count: 0, mb: 0 };
    entry.count++;
    entry.mb += p.memory_mb;
    map.set(key, entry);
  }
  return [...map.values()];
}

function setupListEditor(editor) {
  const listName = editor.dataset.list;
  const input = editor.querySelector(".list-add input");
  const addBtn = editor.querySelector(".list-add button");
  const box = editor.querySelector(".suggestions");
  let items = [];   // currently shown suggestions
  let active = -1;  // keyboard-highlighted index

  const hide = () => {
    box.hidden = true;
    active = -1;
  };

  const choose = async (name) => {
    await addToList(listName, name);
    input.value = "";
    hide();
    input.focus();
  };

  const highlight = () => {
    [...box.children].forEach((el, i) => el.classList.toggle("active", i === active));
  };

  const show = () => {
    const query = input.value.trim();
    const already = new Set(settings ? settings[listName] : []);
    items = runningApps()
      .filter((a) => !already.has(a.name))
      .map((a) => ({ ...a, score: fuzzyScore(query, a.name) }))
      .filter((a) => a.score >= 0)
      .sort((a, b) => (query ? b.score - a.score || a.name.localeCompare(b.name) : b.mb - a.mb))
      .slice(0, 8);

    box.innerHTML = "";
    if (items.length === 0) {
      hide();
      return;
    }
    items.forEach((a) => {
      const row = document.createElement("div");
      row.className = "suggestion";
      const label = document.createElement("span");
      label.textContent = a.name;
      const meta = document.createElement("small");
      meta.textContent = `${a.count > 1 ? a.count + " processes · " : ""}${a.mb.toFixed(0)} MB`;
      row.append(label, meta);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(a.name);
      });
      box.appendChild(row);
    });
    active = -1;
    box.hidden = false;
  };

  input.addEventListener("input", show);
  input.addEventListener("focus", show);
  input.addEventListener("blur", hide);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (box.hidden) show();
      if (items.length === 0) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      active = (active + step + items.length) % items.length;
      highlight();
    } else if (e.key === "Enter") {
      // highlighted suggestion wins; otherwise add exactly what was typed
      choose(active >= 0 ? items[active].name : input.value);
    } else if (e.key === "Escape") {
      hide();
    }
  });
  addBtn.addEventListener("click", () => choose(input.value));
}

window.addEventListener("DOMContentLoaded", () => {
  ramText = document.querySelector("#ram-text");
  ramBarFill = document.querySelector("#ram-bar-fill");
  cleanBtn = document.querySelector("#clean-btn");
  refreshBtn = document.querySelector("#refresh-btn");
  cleanResult = document.querySelector("#clean-result");
  processTbody = document.querySelector("#process-tbody");
  filterInput = document.querySelector("#filter-input");
  tableHeaders = document.querySelectorAll("#process-table th[data-sort]");


  for (const th of tableHeaders) {
    th.dataset.label = th.textContent;
    th.addEventListener("click", handleHeaderClick);
  }

  cleanBtn.addEventListener("click", cleanAll);
  refreshBtn.addEventListener("click", refreshAll);
  filterInput.addEventListener("input", renderProcesses);

  setupSettingsUi();
  loadSettings();

  listen("auto-cleaned", (e) => {
    cleanResult.textContent = "[Auto] " + formatResult(e.payload);
    refreshAll();
  });
  listen("auto-clean-blocked", (e) => {
    cleanResult.textContent = `[Auto] Skipped: ${e.payload} is running (protected)`;
  });

  refreshAll();
  setInterval(refreshMemory, 2000);
  setInterval(refreshProcesses, 3000);
});
