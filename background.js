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
  const desiredName = pendingFilenames.get(downloadItem.id);
  if (desiredName) {
    suggest({ filename: desiredName, conflictAction: "uniquify" });
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && (delta.state.current === "complete" || delta.state.current === "interrupted")) {
    pendingFilenames.delete(delta.id);
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

  // Chrome supports blob URL downloads natively — save to Flow_Images/ folder
  await new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: imgResult.blobUrl,
      filename: filename,
      saveAs: false,
      conflictAction: "uniquify"
    }, (downloadId) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      // Register the desired filename so onDeterminingFilename can enforce it
      pendingFilenames.set(downloadId, filename);
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

// ---- Batch Processing ----

async function runBatch(config) {
  const { prompts, settings, startIndex = 0 } = config;
  stopRequested = false;

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

  broadcast("BATCH_STARTED", { total: prompts.length });

  let completed = 0;
  let failed = 0;
  const delayMin = (settings.delayMin ?? 6) * 1000;
  const delayMax = (settings.delayMax ?? 12) * 1000;

  for (let i = startIndex; i < prompts.length; i++) {
    if (stopRequested) {
      broadcast("BATCH_PROGRESS", { index: i, total: prompts.length, status: "stopped", message: "Stopped by user." });
      break;
    }

    const prompt = prompts[i];
    const promptPreview = prompt.substring(0, 60) + (prompt.length > 60 ? "…" : "");

    broadcast("BATCH_PROGRESS", {
      index: i, total: prompts.length, status: "generating",
      message: `[${i + 1}/${prompts.length}] Generating: "${promptPreview}"`
    });

    try {
      const mediaId = await generateImage(tab.id, projectId, prompt, settings);

      broadcast("BATCH_PROGRESS", {
        index: i, total: prompts.length, status: "downloading",
        message: `[${i + 1}/${prompts.length}] Downloading...`
      });

      const folder = sanitizeFilename(settings.folder || "Flow_Images");
      const num = String(i + 1).padStart(3, "0");
      let filename;
      if (settings.fileNaming === "prompt") {
        const promptSlug = sanitizeFilename(prompt).substring(0, 30);
        filename = `${folder}/${num}-${promptSlug}.png`;
      } else {
        filename = `${folder}/${num}.png`;
      }

      await downloadImage(tab.id, mediaId, filename);

      completed++;
      
      // SAVE PROGRESS TO LOCAL STORAGE
      chrome.storage.local.set({
        batchPrompts: prompts,
        batchSettings: settings,
        batchIndex: i + 1
      });

      broadcast("BATCH_PROGRESS", {
        index: i, total: prompts.length, status: "done",
        message: `[${i + 1}/${prompts.length}] ✅ Saved: ${filename}`
      });

      if (i < prompts.length - 1 && !stopRequested) {
        const delay = delayMin + Math.random() * (delayMax - delayMin);
        const delaySec = Math.ceil(delay / 1000);
        broadcast("BATCH_PROGRESS", {
          index: i + 1, total: prompts.length, status: "waiting",
          message: `Waiting ${delaySec}s before next prompt...`
        });
        await sleep(delay);
      }

    } catch (err) {
      failed++;
      broadcast("BATCH_PROGRESS", {
        index: i, total: prompts.length, status: "failed",
        message: `[${i + 1}/${prompts.length}] ❌ ${err.message}`
      });

      if (err.message.includes("quota") || err.message.includes("auth") || err.message.includes("403")) {
        broadcast("BATCH_ERROR", { message: "⛔ Fatal: " + err.message });
        break;
      }
    }
  }

  broadcast("BATCH_DONE", { completed, failed, total: prompts.length });
  
  // CLEAR STORAGE WHEN ENTIRE QUEUE IS FINISHED
  if (!stopRequested && failed === 0) {
    chrome.storage.local.remove(['batchPrompts', 'batchSettings', 'batchIndex']);
  }

  if (completed > 0 && tab.id) {
    await sleep(300);
    chrome.tabs.reload(tab.id);
  }
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
