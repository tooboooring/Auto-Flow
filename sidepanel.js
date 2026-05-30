// ============================================================
// Auto Flow - Side Panel Script (Chrome)
// Handles UI interaction and communicates with the background
// ============================================================

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const clearBtn = document.getElementById("clearBtn");
const retryBtn = document.getElementById("retryBtn");
const exportBtn = document.getElementById("exportBtn");
const importBtn = document.getElementById("importBtn");
const importFileInput = document.getElementById("importFileInput");
const promptList = document.getElementById("promptList");
const variablesList = document.getElementById("variablesList");
const logContainer = document.getElementById("logContainer");
const summary = document.getElementById("summary");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const uploadBtn = document.getElementById("uploadBtn");
const fileInput = document.getElementById("fileInput");
const promptCount = document.getElementById("promptCount");

// ---- Prompt counter ----

function updatePromptCount() {
  const lines = promptList.value.split("\n").filter(p => p.trim() !== "");
  if (lines.length === 0) {
    promptCount.innerHTML = "";
  } else {
    promptCount.innerHTML = `<span>${lines.length}</span> prompt${lines.length === 1 ? "" : "s"} loaded`;
  }
}

promptList.addEventListener("input", updatePromptCount);

// ---- File upload ----

uploadBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    const text = event.target.result;
    let prompts;

    if (file.name.endsWith(".csv") || file.name.endsWith(".tsv")) {
      // CSV/TSV: take the first column (or the "prompt" column if headers exist)
      const sep = file.name.endsWith(".tsv") ? "\t" : ",";
      const rows = text.split("\n").map(r => r.trim()).filter(r => r !== "");
      if (rows.length === 0) return;

      // Check if first row is a header
      const firstRow = rows[0].toLowerCase();
      let promptCol = 0;
      if (firstRow.includes("prompt")) {
        const headers = firstRow.split(sep).map(h => h.trim().replace(/"/g, ""));
        promptCol = headers.findIndex(h => h === "prompt" || h === "prompts" || h === "text");
        if (promptCol === -1) promptCol = 0;
        rows.shift(); // remove header
      }

      prompts = rows.map(row => {
        const cols = row.split(sep).map(c => c.trim().replace(/^"|"$/g, ""));
        return cols[promptCol] || "";
      }).filter(p => p !== "");
    } else {
      // Plain text: one prompt per line
      prompts = text.split("\n").map(p => p.trim()).filter(p => p !== "");
    }

    promptList.value = prompts.join("\n");
    updatePromptCount();
    uploadBtn.textContent = `📄 ${prompts.length} loaded`;
    setTimeout(() => { uploadBtn.textContent = "📄 Load .txt"; }, 2000);
  };
  reader.readAsText(file);

  // Reset input so same file can be re-uploaded
  fileInput.value = "";
});

// ---- Check connection on load ----

chrome.runtime.sendMessage({ type: "CHECK_CONNECTION" }, (response) => {
  if (chrome.runtime.lastError || !response) {
    statusDot.className = "status-dot disconnected";
    statusText.textContent = "Extension error — reload the extension.";
    return;
  }
  if (response.connected) {
    statusDot.className = "status-dot connected";
    statusText.textContent = "Connected to Flow (Project: " + response.projectId.substring(0, 8) + "…)";
    startBtn.disabled = false;
  } else {
    statusDot.className = "status-dot disconnected";
    statusText.textContent = response.reason || "Not connected.";
    startBtn.disabled = true;
  }
});

// ---- Start batch ----

startBtn.addEventListener("click", () => {
  const prompts = promptList.value.split("\n").map(p => p.trim()).filter(p => p !== "");

  if (prompts.length === 0) {
    alert("Please enter at least one prompt.");
    return;
  }

  const settings = {
    model: document.getElementById("modelSelect").value,
    aspectRatio: document.getElementById("aspectSelect").value,
    fileNaming: document.getElementById("namingSelect").value,
    folder: document.getElementById("folderInput").value.trim() || "Flow_Images",
    delayMin: 6,
    delayMax: 12,
    variablesText: variablesList.value
  };

  // Clear previous log
  logContainer.innerHTML = "";
  logContainer.classList.add("visible");
  summary.classList.remove("visible");

  // Toggle buttons
  startBtn.style.display = "none";
  retryBtn.style.display = "none";
  stopBtn.style.display = "flex";
  clearBtn.style.display = "none";
  exportBtn.style.display = "none";
  promptList.disabled = true;

  // Check if we have a manifest to resume, or start fresh
  chrome.storage.local.get(['manifest'], (data) => {
    if (data.manifest && data.manifest.prompts.some(p => p.status === "pending")) {
      // Resume from existing manifest
      chrome.runtime.sendMessage({ type: "RUN_BATCH", manifest: data.manifest, prompts, settings });
    } else {
      // Start fresh
      chrome.runtime.sendMessage({ type: "RUN_BATCH", prompts, settings });
    }
  });
});

// ---- Stop batch ----

stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP_BATCH" });
  stopBtn.disabled = true;
  stopBtn.textContent = "⏳ Stopping...";
});

// ---- Listen for progress from background ----

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "BATCH_PROGRESS") {
    addLogEntry(message.message, message.status);
  }

  if (message.type === "BATCH_ERROR") {
    addLogEntry(message.message, "failed");
    resetButtons();
  }

  if (message.type === "BATCH_DONE") {
    const { completed, doneCount, failed, pending, total, failedNums, pendingNums } = message;
    summary.classList.add("visible");

    if (failed === 0 && pending === 0) {
      summary.className = "summary visible success";
      summary.textContent = `🎉 All ${total} images generated and downloaded!`;
      startBtn.textContent = "🚀 Start Generating";
      retryBtn.style.display = "none";
      exportBtn.style.display = "none";
    } else {
      summary.className = "summary visible partial";

      let summaryText = `Done: ${doneCount !== undefined ? doneCount : completed} succeeded`;
      if (failed > 0) summaryText += `, ${failed} failed`;
      if (pending > 0) summaryText += `, ${pending} pending`;
      summaryText += ` out of ${total}.`;

      if (failedNums && failedNums.length > 0) {
        summaryText += ` Failed: ${failedNums.join(", ")}`;
      }
      if (pendingNums && pendingNums.length > 0) {
        summaryText += ` Pending: ${pendingNums.join(", ")}`;
      }
      summary.textContent = summaryText;

      // Show retry if there are failed images
      if (failed > 0) {
        retryBtn.style.display = "flex";
        retryBtn.textContent = `🔄 Retry Failed (${failedNums.join(", ")})`;
        retryBtn.disabled = false;
      }

      // Show resume if there are pending images
      if (pending > 0) {
        startBtn.textContent = `🚀 Resume (${pending} remaining)`;
      }

      // Always show export when there's progress to save
      exportBtn.style.display = "flex";
    }
    resetButtons();
  }
});

// ---- Helpers ----

function addLogEntry(text, status = "") {
  const entry = document.createElement("div");
  entry.className = "log-entry " + status;
  entry.textContent = text;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
}

function resetButtons() {
  startBtn.style.display = "flex";
  stopBtn.style.display = "none";
  clearBtn.style.display = "flex";
  stopBtn.disabled = false;
  stopBtn.textContent = "⏹ Stop";
  promptList.disabled = false;
}

// ---- Retry Failed ----

retryBtn.addEventListener("click", () => {
  // Clear previous log
  logContainer.innerHTML = "";
  logContainer.classList.add("visible");
  summary.classList.remove("visible");

  // Toggle buttons
  startBtn.style.display = "none";
  retryBtn.style.display = "none";
  stopBtn.style.display = "flex";
  clearBtn.style.display = "none";
  exportBtn.style.display = "none";
  promptList.disabled = true;

  chrome.runtime.sendMessage({ type: "RETRY_FAILED" });
});

// ---- Export Manifest ----

exportBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "EXPORT_MANIFEST" }, (response) => {
    if (chrome.runtime.lastError || !response?.manifest) {
      alert("No progress to export.");
      return;
    }

    const json = JSON.stringify(response.manifest, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "flow-progress.json";
    a.click();

    URL.revokeObjectURL(url);

    exportBtn.textContent = "✅ Exported!";
    setTimeout(() => { exportBtn.textContent = "📥 Export Progress"; }, 2000);
  });
});

// ---- Import Manifest ----

importBtn.addEventListener("click", () => importFileInput.click());

importFileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const manifest = JSON.parse(event.target.result);

      if (!manifest.prompts || !Array.isArray(manifest.prompts)) {
        alert("Invalid manifest file — missing prompts array.");
        return;
      }

      chrome.runtime.sendMessage({ type: "IMPORT_MANIFEST", manifest }, (response) => {
        if (chrome.runtime.lastError) {
          alert("Import failed: " + chrome.runtime.lastError.message);
          return;
        }

        if (response.ok) {
          // Populate the prompt list from manifest
          const allPrompts = manifest.prompts.map(p => p.prompt);
          promptList.value = allPrompts.join("\n");
          updatePromptCount();

          // Restore settings
          if (manifest.settings) {
            if (manifest.settings.model) document.getElementById("modelSelect").value = manifest.settings.model;
            if (manifest.settings.aspectRatio) document.getElementById("aspectSelect").value = manifest.settings.aspectRatio;
            if (manifest.settings.fileNaming) document.getElementById("namingSelect").value = manifest.settings.fileNaming;
            if (manifest.settings.folder) document.getElementById("folderInput").value = manifest.settings.folder;
            if (manifest.settings.variablesText) variablesList.value = manifest.settings.variablesText;
          }

          // Show status
          const done = manifest.prompts.filter(p => p.status === "done").length;
          const failed = manifest.prompts.filter(p => p.status === "failed").length;
          const pending = manifest.prompts.filter(p => p.status === "pending").length;

          summary.classList.add("visible");
          summary.className = "summary visible partial";
          summary.textContent = `📂 Imported: ${done} done, ${failed} failed, ${pending} pending out of ${manifest.prompts.length}`;

          if (pending > 0) {
            startBtn.textContent = `🚀 Resume (${pending} remaining)`;
          }
          if (failed > 0) {
            const failedNums = manifest.prompts.filter(p => p.status === "failed").map(p => p.imageNum).join(", ");
            retryBtn.style.display = "flex";
            retryBtn.textContent = `🔄 Retry Failed (${failedNums})`;
          }
          exportBtn.style.display = "flex";

          importBtn.textContent = "✅ Imported!";
          setTimeout(() => { importBtn.textContent = "📤 Import Progress"; }, 2000);
        } else {
          alert("Import failed: " + (response.error || "Unknown error"));
        }
      });
    } catch (err) {
      alert("Invalid JSON file: " + err.message);
    }
  };
  reader.readAsText(file);

  // Reset input so same file can be re-imported
  importFileInput.value = "";
});

// ---- Clear All ----

clearBtn.addEventListener("click", () => {
  if (confirm("Are you sure you want to clear all prompts and reset progress?")) {
    promptList.value = "";
    variablesList.value = "";
    updatePromptCount();
    logContainer.innerHTML = "";
    logContainer.classList.remove("visible");
    summary.classList.remove("visible");
    retryBtn.style.display = "none";
    exportBtn.style.display = "none";
    
    startBtn.textContent = "🚀 Start Generating";
    
    chrome.storage.local.remove(['manifest']);
  }
});

// ---- Check storage on load ----

chrome.storage.local.get(['manifest'], (data) => {
  if (!data.manifest) return;

  const manifest = data.manifest;
  const done = manifest.prompts.filter(p => p.status === "done").length;
  const failed = manifest.prompts.filter(p => p.status === "failed").length;
  const pending = manifest.prompts.filter(p => p.status === "pending").length;
  const total = manifest.prompts.length;

  // Only show resume UI if there's unfinished work
  if (failed === 0 && pending === 0) return;

  // Populate prompts from manifest
  promptList.value = manifest.prompts.map(p => p.prompt).join("\n");
  updatePromptCount();

  // Restore settings
  if (manifest.settings) {
    if (manifest.settings.model) document.getElementById("modelSelect").value = manifest.settings.model;
    if (manifest.settings.aspectRatio) document.getElementById("aspectSelect").value = manifest.settings.aspectRatio;
    if (manifest.settings.fileNaming) document.getElementById("namingSelect").value = manifest.settings.fileNaming;
    if (manifest.settings.folder) document.getElementById("folderInput").value = manifest.settings.folder;
    if (manifest.settings.variablesText) variablesList.value = manifest.settings.variablesText;
  }

  // Show status
  summary.classList.add("visible");
  summary.className = "summary visible partial";

  let summaryText = `Previous run: ${done} done`;
  if (failed > 0) summaryText += `, ${failed} failed`;
  if (pending > 0) summaryText += `, ${pending} pending`;
  summaryText += ` out of ${total}`;
  summary.textContent = summaryText;

  if (pending > 0) {
    startBtn.textContent = `🚀 Resume (${pending} remaining)`;
  }

  if (failed > 0) {
    const failedNums = manifest.prompts.filter(p => p.status === "failed").map(p => p.imageNum).join(", ");
    retryBtn.style.display = "flex";
    retryBtn.textContent = `🔄 Retry Failed (${failedNums})`;
  }

  exportBtn.style.display = "flex";
});
