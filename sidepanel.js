// ============================================================
// Auto Flow - Side Panel Script (Chrome)
// Handles UI interaction and communicates with the background
// ============================================================

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const clearBtn = document.getElementById("clearBtn");
const retryBtn = document.getElementById("retryBtn");
const promptList = document.getElementById("promptList");
const variablesList = document.getElementById("variablesList");
const logContainer = document.getElementById("logContainer");
const summary = document.getElementById("summary");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const uploadBtn = document.getElementById("uploadBtn");
const fileInput = document.getElementById("fileInput");
const promptCount = document.getElementById("promptCount");

let resumeIndex = 0;

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
    folder: "Flow_Images",
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
  stopBtn.style.display = "flex";
  clearBtn.style.display = "none";
  promptList.disabled = true;

  // Pass the startIndex parameter to the background script
  chrome.runtime.sendMessage({ type: "RUN_BATCH", prompts, settings, startIndex: resumeIndex });
  
  // Reset the index and button text so manual runs start fresh afterward
  resumeIndex = 0;
  startBtn.textContent = "🚀 Start Generating";
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
    const { completed, failed, total, failedNums } = message;
    summary.classList.add("visible");
    if (failed === 0) {
      summary.className = "summary visible success";
      summary.textContent = `🎉 All ${completed} images generated and downloaded!`;
      retryBtn.style.display = "none";
    } else {
      summary.className = "summary visible partial";
      const failedList = failedNums && failedNums.length > 0 ? failedNums.join(", ") : "";
      summary.textContent = `Done: ${completed} succeeded, ${failed} failed out of ${total}.`;
      if (failedList) {
        summary.textContent += ` Failed images: ${failedList}`;
      }
      retryBtn.style.display = "flex";
      retryBtn.textContent = `🔄 Retry Failed (${failedList})`;
      retryBtn.disabled = false;
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
  promptList.disabled = true;

  chrome.runtime.sendMessage({ type: "RETRY_FAILED" });
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
    
    resumeIndex = 0;
    startBtn.textContent = "🚀 Start Generating";
    
    chrome.storage.local.remove(['batchPrompts', 'batchSettings', 'batchIndex', 'failedImages']);
  }
});

// ---- Check storage on load ----

chrome.storage.local.get(['batchPrompts', 'batchSettings', 'batchIndex', 'failedImages'], (data) => {
  if (data.batchPrompts && data.batchIndex < data.batchPrompts.length) {
    promptList.value = data.batchPrompts.join("\n");
    updatePromptCount();
    document.getElementById("modelSelect").value = data.batchSettings.model;
    document.getElementById("aspectSelect").value = data.batchSettings.aspectRatio;
    if (data.batchSettings.variablesText) {
      variablesList.value = data.batchSettings.variablesText;
    }
    
    resumeIndex = data.batchIndex;
    startBtn.textContent = `🚀 Resume Generating (from #${resumeIndex + 1})`;
  }

  // Show retry button if there are persisted failed images
  if (data.failedImages && data.failedImages.length > 0) {
    const failedNums = data.failedImages.map(f => f.imageNum).join(", ");
    retryBtn.style.display = "flex";
    retryBtn.textContent = `🔄 Retry Failed (${failedNums})`;
    summary.classList.add("visible");
    summary.className = "summary visible partial";
    summary.textContent = `${data.failedImages.length} failed image(s) from previous run. Failed: ${failedNums}`;
  }
});
