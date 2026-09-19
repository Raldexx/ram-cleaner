const { invoke } = window.__TAURI__.core;

let ramText, ramBarFill, cleanBtn, refreshBtn, cleanResult, processTbody;

async function refreshMemory() {
  const info = await invoke("get_memory_info");
  ramBarFill.style.width = `${info.percent_used.toFixed(1)}%`;
  ramText.textContent =
    `${info.used_gb.toFixed(2)} GB / ${info.total_gb.toFixed(2)} GB used ` +
    `(${info.percent_used.toFixed(1)}%)`;
}

async function refreshProcesses() {
  const processes = await invoke("get_processes");
  processTbody.innerHTML = "";

  for (const p of processes) {
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

  cleanBtn.addEventListener("click", cleanAll);
  refreshBtn.addEventListener("click", refreshAll);

  refreshAll();
  setInterval(refreshMemory, 2000);
});
