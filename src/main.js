const { invoke } = window.__TAURI__.core;

let ramText, ramBarFill, cleanBtn, refreshBtn, cleanResult, processTbody, filterInput, tableHeaders;


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
    list = list.filter((p) => p.name.toLowerCase().includes(query));
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
    rowBtn.textContent = "Temizle";
    rowBtn.className = "row-clean-btn";
    rowBtn.addEventListener("click", async () => {
      rowBtn.disabled = true;
      await invoke("clean_single", { pid: p.pid });
      await refreshAll();
    });
    actionCell.appendChild(rowBtn);

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

async function cleanAll() {
  cleanBtn.disabled = true;
  cleanBtn.textContent = "Temizleniyor...";

  const result = await invoke("clean_all");
  cleanResult.textContent =
    `${result.cleaned} processes cleaned, ${result.failed} failed to access ` +
    `(~${result.freed_mb.toFixed(0)} MB freed)`;

  cleanBtn.disabled = false;
  cleanBtn.textContent = "Clean";
  await refreshAll();
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

  refreshAll();
  setInterval(refreshMemory, 2000);
  setInterval(refreshProcesses, 3000); 
});
