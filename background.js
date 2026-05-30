// ============================================================
// Auto Flow - Chrome/Chromium Version (Background Service Worker)
// Uses direct API calls to Google Flow — no DOM interaction.
// ============================================================

let cachedRecaptchaKey = null;

let cachedToken = null;
let tokenTimestamp = 0;
const TOKEN_TTL = 5 * 60 * 1000; // 5 minutes

let stopRequested = false;

// ---- Open Side Panel when extension icon is clicked ----

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---- Download filename enforcement ----
// Chrome ignores the `filename` param for blob URL downloads.
// This listener intercepts the download and forces the correct filename.
const pendingFilenames = new Map();

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const desiredName = pendingFilenames.get(downloadItem.url);
  if (desiredName) {
    pendingFilenames.delete(downloadItem.url);
    suggest({ filename: desiredName, conflictAction: "uniquify" });
  }
});



// ---- Utilities ----

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

function randomSeed() {
  return Math.floor(Math.random() * 300000);
}

function sanitizeFilename(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 40) || "image";
}

function isFlowUrl(url) {
  return /^https:\/\/labs\.google\/fx(\/[a-z]{2}(?:-[a-z]{2})?)?\/tools\/flow\//.test(url);
}

// ---- Send progress to side panel ----

function broadcast(type, data) {
  chrome.runtime.sendMessage({ type, ...data }).catch(() => {});
}

// ---- Find the active Flow tab ----

async function findFlowTab() {
  const patterns = [
    "https://labs.google/fx/tools/flow/*",
    "https://labs.google/fx/*/tools/flow/*"
  ];
  const allTabs = [];
  for (const pattern of patterns) {
    allTabs.push(...(await chrome.tabs.query({ url: pattern })));
  }
  const unique = [...new Map(allTabs.map(t => [t.id, t])).values()];
  unique.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return unique[0] || null;
}

// ---- Get auth token from the Flow page session ----

async function getAuthToken(tabId, forceRefresh = false) {
  if (!forceRefresh && cachedToken && Date.now() - tokenTimestamp < TOKEN_TTL) {
    return cachedToken;
  }

  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => {
      try {
        const res = await fetch("/fx/api/auth/session", { credentials: "include" });
        const data = await res.json();
        return data.access_token || null;
      } catch {
        return null;
      }
    }
  }).catch(() => null);

  const token = result?.[0]?.result || null;
  if (token) {
    cachedToken = token;
    tokenTimestamp = Date.now();
  }
  return token;
}

// ---- Get project ID from the Flow URL ----

async function getProjectId(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const match = window.location.href.match(/project\/([a-f0-9-]+)/);
      return match ? match[1] : null;
    }
  }).catch(() => null);

  return result?.[0]?.result || null;
}

// ---- Get reCAPTCHA site key dynamically ----

async function getDynamicSiteKey(tabId) {
  if (cachedRecaptchaKey) return cachedRecaptchaKey;

  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      // 1. Inspect script tags for the reCAPTCHA render parameter
      const scripts = Array.from(document.querySelectorAll("script"));
      for (const script of scripts) {
        const match = (script.src || "").match(/recaptcha\/enterprise\.js\?render=([A-Za-z0-9_-]+)/);
        if (match) return match[1];
      }
      // 2. We could add more scraping logic here if Google obfuscates it
      return null;
    }
  }).catch(() => null);

  let key = result?.[0]?.result;
  
  // Fallback to the last known working key if we couldn't find it
  if (!key) {
    key = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";
  }
  
  cachedRecaptchaKey = key;
  return key;
}

// ---- Get reCAPTCHA token from the page ----

async function getRecaptchaToken(tabId, action = "IMAGE_GENERATION") {
  const siteKey = await getDynamicSiteKey(tabId);

  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (key, recaptchaAction) => {
      const re = window.grecaptcha?.enterprise;
      // In Chrome, returning a Promise from executeScript works correctly
      return re ? re.execute(key, { action: recaptchaAction }) : Promise.resolve(null);
    },
    args: [siteKey, action]
  }).catch(() => null);

  return result?.[0]?.result || null;
}

// ---- Core API call (auth + recaptcha + fetch) ----

async function callFlowAPI(tabId, url, body, action = "IMAGE_GENERATION", retryCount = 0) {
  const authToken = await getAuthToken(tabId);
  if (!authToken) throw new Error("No auth token — refresh the Flow page and try again.");

  const recaptchaToken = await getRecaptchaToken(tabId, action);
  if (!recaptchaToken) throw new Error("No reCAPTCHA token — refresh the Flow page and try again.");

  // Inject the recaptcha token into the body
  if (body.clientContext?.recaptchaContext) {
    body.clientContext.recaptchaContext.token = recaptchaToken;
  }
  if (Array.isArray(body.requests)) {
    for (const req of body.requests) {
      if (req.clientContext?.recaptchaContext) {
        req.clientContext.recaptchaContext.token = recaptchaToken;
      }
    }
  }

  const bodyStr = JSON.stringify(body);

  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (fetchUrl, fetchBody, token, timeout) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(fetchUrl, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain;charset=UTF-8",
            "Authorization": "Bearer " + token
          },
          body: fetchBody,
          signal: controller.signal
        });
        clearTimeout(timer);
        const text = await response.text();
        if (!response.ok) {
          return { error: "HTTP " + response.status, status: response.status, errText: text.substring(0, 500) };
        }
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        return { success: true, data };
      } catch (e) {
        clearTimeout(timer);
        return { error: e.name === "AbortError" ? "Request timed out" : e.message, isTimeout: e.name === "AbortError" };
      }
    },
    args: [url, bodyStr, authToken, 60000]
  }).catch(() => null);

  const response = result?.[0]?.result;
  if (!response) throw new Error("Flow tab lost — is it still open?");

  if (response.error) {
    if (response.status === 403 && retryCount === 0) {
      await sleep(1500);
      cachedToken = null;
      return callFlowAPI(tabId, url, body, action, 1);
    }
    if (response.status === 429 || response.errText?.includes("RESOURCE_EXHAUSTED")) {
      if (retryCount === 0) {
        broadcast("BATCH_PROGRESS", { status: "waiting", message: "⚠️ Rate limited (429). Pausing pipeline for 30s before retrying..." });
        await sleep(30000);
        return callFlowAPI(tabId, url, body, action, 1);
      }
      throw new Error("Daily quota reached — try a different model or wait until tomorrow.");
    }
    if (response.status === 400) {
      let msg = "Bad request";
      try {
        const parsed = JSON.parse(response.errText);
        msg = parsed?.error?.message || parsed?.message || response.errText.substring(0, 200);
      } catch {
        msg = response.errText?.substring(0, 200) || "Unknown";
      }
      throw new Error("Rejected (400): " + msg);
    }
    if ((response.isTimeout || response.status >= 500) && retryCount === 0) {
      await sleep(3000);
      return callFlowAPI(tabId, url, body, action, 1);
    }
    throw new Error(response.error);
  }

  return response.data;
}

// ---- Generate a single image ----

async function generateImage(tabId, projectId, prompt, settings) {
  const url = `https://aisandbox-pa.googleapis.com/v1/projects/${projectId}/flowMedia:batchGenerateImages`;
  const batchId = generateUUID();
  const sessionId = ";" + Date.now() + Math.random().toString(36).slice(2);
  const modelName = settings.model || "NARWHAL";

  const requestBody = {
    clientContext: {
      recaptchaContext: {
        applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
        token: "PLACEHOLDER"
      },
      projectId: projectId,
      tool: "PINHOLE",
      sessionId: sessionId
    },
    mediaGenerationContext: { batchId },
    useNewMedia: true,
    requests: [{
      clientContext: {
        recaptchaContext: {
          applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
          token: "PLACEHOLDER"
        },
        projectId: projectId,
        tool: "PINHOLE",
        sessionId: sessionId
      },
      imageAspectRatio: settings.aspectRatio || "IMAGE_ASPECT_RATIO_LANDSCAPE",
      imageInputs: [],
      imageModelName: modelName,
      seed: randomSeed(),
      structuredPrompt: {
        parts: [{ text: prompt }]
      }
    }]
  };

  const data = await callFlowAPI(tabId, url, requestBody);

  console.log("=== FLOW API RESPONSE DATA ===");
  console.log(JSON.stringify(data, null, 2));

  let mediaId = null;
  if (data?.workflows) {
    for (const w of data.workflows) {
      const id = w?.metadata?.primaryMediaId;
      if (id) { mediaId = id; break; }
    }
  }
  if (!mediaId && data?.media) {
    for (const m of data.media) {
      const id = m?.name || m?.mediaId;
      if (id) { mediaId = id; break; }
    }
  }
  if (!mediaId) throw new Error("No mediaId returned from generation.");

  return mediaId;
}

// ---- Download an image as PNG (Chrome-native approach) ----

async function downloadImage(tabId, mediaId, filename) {
  const mediaUrl = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${mediaId}`;

  // Fetch image as blob directly in the main world context to bypass CORS/canvas restrictions (with retry logic)
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (url) => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      let retries = 3;
      let delay = 2000;

      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          const response = await fetch(url);
          if (response.status === 429) {
            if (attempt < retries - 1) {
              await wait(delay);
              delay *= 2; // Exponential backoff (2s, 4s, 8s)
              continue;
            }
            throw new Error("HTTP error! status: 429 (Rate limit exceeded after retries)");
          }
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          const blob = await response.blob();
          
          const headersObj = {};
          for (const [key, val] of response.headers.entries()) {
            headersObj[key] = val;
          }
          
          return { blobUrl: URL.createObjectURL(blob), size: blob.size, debugHeaders: headersObj, debugUrl: response.url };
        } catch (e) {
          if (attempt === retries - 1) {
            return { error: e.message };
          }
          await wait(delay);
          delay *= 2;
        }
      }
    },
    args: [mediaUrl]
  }).catch(() => null);

  const imgResult = result?.[0]?.result;
  
  console.log("=== IMAGE DOWNLOAD HEADERS ===");
  console.log("Final URL:", imgResult?.debugUrl);
  console.log("Headers:", JSON.stringify(imgResult?.debugHeaders, null, 2));
  
  if (!imgResult?.blobUrl) {
    throw new Error("Download failed: " + (imgResult?.error || "unknown"));
  }

  // Register the desired filename BEFORE starting the download
  // so onDeterminingFilename can enforce it (no race condition)
  pendingFilenames.set(imgResult.blobUrl, filename);

  // Chrome supports blob URL downloads natively — save to Flow_Images/ folder
  await new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: imgResult.blobUrl,
      filename: filename,
      saveAs: false,
      conflictAction: "uniquify"
    }, (downloadId) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(downloadId);
    });
  });

  // Clean up the blob URL
  chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (url) => URL.revokeObjectURL(url),
    args: [imgResult.blobUrl]
  }).catch(() => {});
}

// ---- Manifest Helpers ----

function buildManifest(prompts, settings) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    settings,
    prompts: prompts.map((prompt, i) => ({
      imageNum: i + 1,
      prompt,
      status: "pending"
    }))
  };
}

function saveManifest(manifest) {
  chrome.storage.local.set({ manifest });
}

function applyVariables(prompt, variables) {
  let result = prompt;
  for (const [key, value] of Object.entries(variables)) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\[${escapedKey}\\]`, 'gi');
    result = result.replace(regex, value);
  }
  return result;
}

function parseVariables(variablesText) {
  const variables = {};
  if (variablesText && variablesText.trim() !== "") {
    const lines = variablesText.split("\n");
    for (const line of lines) {
      const match = line.match(/^\[(.*?)\]\s*=\s*(.*)$/);
      if (match) {
        variables[match[1].trim().toLowerCase()] = match[2].trim();
      }
    }
  }
  return variables;
}

function getFilename(imageNum, prompt, settings) {
  const folder = sanitizeFilename(settings.folder || "Flow_Images");
  const num = String(imageNum).padStart(3, "0");
  if (settings.fileNaming === "prompt") {
    const promptSlug = sanitizeFilename(prompt).substring(0, 30);
    return `${folder}/${num}-${promptSlug}.png`;
  }
  return `${folder}/${num}.png`;
}

// ---- Process a list of manifest entries ----

async function processEntries(entries, manifest, settings, logPrefix = "") {
  const tab = await findFlowTab();
  if (!tab?.id) {
    broadcast("BATCH_ERROR", { message: "No Google Flow tab found. Open a Flow project first!" });
    return;
  }

  const projectId = await getProjectId(tab.id);
  if (!projectId) {
    broadcast("BATCH_ERROR", { message: "No Flow project open. Create or open a project in Flow first!" });
    return;
  }

  const variables = parseVariables(settings.variablesText);
  const delayMin = (settings.delayMin ?? 6) * 1000;
  const delayMax = (settings.delayMax ?? 12) * 1000;
  const total = entries.length;
  let completed = 0;

  broadcast("BATCH_STARTED", { total });

  for (let i = 0; i < entries.length; i++) {
    if (stopRequested) {
      broadcast("BATCH_PROGRESS", { index: i, total, status: "stopped", message: "Stopped by user." });
      // Mark remaining entries as pending so they can be resumed
      for (let j = i; j < entries.length; j++) {
        if (entries[j].status !== "done") entries[j].status = "pending";
      }
      saveManifest(manifest);
      break;
    }

    const entry = entries[i];
    const prompt = applyVariables(entry.prompt, variables);
    const label = logPrefix ? `[${logPrefix} ${entry.imageNum}]` : `[${entry.imageNum}/${manifest.prompts.length}]`;
    const promptPreview = prompt.substring(0, 60) + (prompt.length > 60 ? "…" : "");

    broadcast("BATCH_PROGRESS", {
      index: i, total, status: "generating",
      message: `${label} Generating: "${promptPreview}"`
    });

    try {
      const mediaId = await generateImage(tab.id, projectId, prompt, settings);

      broadcast("BATCH_PROGRESS", {
        index: i, total, status: "downloading",
        message: `${label} Downloading...`
      });

      const filename = getFilename(entry.imageNum, prompt, settings);
      await downloadImage(tab.id, mediaId, filename);

      completed++;
      entry.status = "done";
      delete entry.error;
      saveManifest(manifest);

      broadcast("BATCH_PROGRESS", {
        index: i, total, status: "done",
        message: `${label} ✅ Saved: ${filename}`
      });

      if (i < entries.length - 1 && !stopRequested) {
        const delay = delayMin + Math.random() * (delayMax - delayMin);
        const delaySec = Math.ceil(delay / 1000);
        broadcast("BATCH_PROGRESS", {
          index: i + 1, total, status: "waiting",
          message: `Waiting ${delaySec}s before next prompt...`
        });
        await sleep(delay);
      }

    } catch (err) {
      entry.status = "failed";
      entry.error = err.message;
      saveManifest(manifest);

      // Fatal errors: stop immediately
      if (err.message.includes("quota") || err.message.includes("auth") || err.message.includes("403")) {
        broadcast("BATCH_PROGRESS", {
          index: i, total, status: "failed",
          message: `${label} ❌ ${err.message}`
        });
        broadcast("BATCH_ERROR", { message: "⛔ Fatal: " + err.message });
        // Mark remaining entries as pending
        for (let j = i + 1; j < entries.length; j++) {
          if (entries[j].status !== "done") entries[j].status = "pending";
        }
        saveManifest(manifest);
        break;
      }

      // Non-fatal: skip and continue
      broadcast("BATCH_PROGRESS", {
        index: i, total, status: "failed",
        message: `${label} ❌ Skipped — ${err.message}`
      });

      if (i < entries.length - 1 && !stopRequested) {
        const delay = delayMin + Math.random() * (delayMax - delayMin);
        const delaySec = Math.ceil(delay / 1000);
        broadcast("BATCH_PROGRESS", {
          index: i + 1, total, status: "waiting",
          message: `Waiting ${delaySec}s before next prompt...`
        });
        await sleep(delay);
      }
    }
  }

  // Build final report from manifest
  const doneCount = manifest.prompts.filter(p => p.status === "done").length;
  const failedEntries = manifest.prompts.filter(p => p.status === "failed");
  const pendingEntries = manifest.prompts.filter(p => p.status === "pending");
  const failedNums = failedEntries.map(f => f.imageNum);
  const pendingNums = pendingEntries.map(p => p.imageNum);

  broadcast("BATCH_DONE", {
    completed,
    doneCount,
    failed: failedEntries.length,
    pending: pendingEntries.length,
    total: manifest.prompts.length,
    failedNums,
    pendingNums
  });

  // Only clear manifest if everything is done
  if (failedEntries.length === 0 && pendingEntries.length === 0) {
    chrome.storage.local.remove(['manifest']);
  }

  if (completed > 0 && tab.id) {
    await sleep(300);
    chrome.tabs.reload(tab.id);
  }
}

// ---- Batch Processing ----

async function runBatch(config) {
  const { prompts, settings } = config;
  stopRequested = false;

  // Build or resume manifest
  let manifest;
  if (config.manifest) {
    // Imported or resumed manifest
    manifest = config.manifest;
  } else {
    manifest = buildManifest(prompts, settings);
    saveManifest(manifest);
  }

  // Process only pending entries
  const pendingEntries = manifest.prompts.filter(p => p.status === "pending");
  if (pendingEntries.length === 0) {
    broadcast("BATCH_ERROR", { message: "No pending images to generate." });
    return;
  }

  await processEntries(pendingEntries, manifest, manifest.settings);
}

// ---- Retry Failed Images ----

async function retryFailed(manifest) {
  stopRequested = false;

  const failedEntries = manifest.prompts.filter(p => p.status === "failed");
  if (failedEntries.length === 0) {
    broadcast("BATCH_ERROR", { message: "No failed images to retry." });
    return;
  }

  await processEntries(failedEntries, manifest, manifest.settings, "Retry");
}

// ---- Message Handler ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "RUN_BATCH") {
    sendResponse({ ok: true });
    runBatch(message).catch(err => {
      broadcast("BATCH_ERROR", { message: "Fatal error: " + err.message });
    });
    return false;
  }

  if (message.type === "RETRY_FAILED") {
    sendResponse({ ok: true });
    chrome.storage.local.get(['manifest'], (data) => {
      if (!data.manifest) {
        broadcast("BATCH_ERROR", { message: "No manifest found. Nothing to retry." });
        return;
      }
      retryFailed(data.manifest).catch(err => {
        broadcast("BATCH_ERROR", { message: "Fatal error during retry: " + err.message });
      });
    });
    return false;
  }

  if (message.type === "EXPORT_MANIFEST") {
    chrome.storage.local.get(['manifest'], (data) => {
      sendResponse({ manifest: data.manifest || null });
    });
    return true; // async sendResponse
  }

  if (message.type === "IMPORT_MANIFEST") {
    const manifest = message.manifest;
    if (manifest && manifest.prompts) {
      saveManifest(manifest);
      sendResponse({ ok: true, pending: manifest.prompts.filter(p => p.status !== "done").length });
    } else {
      sendResponse({ ok: false, error: "Invalid manifest file." });
    }
    return false;
  }

  if (message.type === "STOP_BATCH") {
    stopRequested = true;
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "CHECK_CONNECTION") {
    (async () => {
      try {
        const tab = await findFlowTab();
        if (!tab) return sendResponse({ connected: false, reason: "No Flow tab open." });
        const projectId = await getProjectId(tab.id);
        if (!projectId) return sendResponse({ connected: false, reason: "No project open in Flow." });
        sendResponse({ connected: true, tabId: tab.id, projectId });
      } catch (e) {
        sendResponse({ connected: false, reason: e.message });
      }
    })();
    return true;
  }

  return false;
});
