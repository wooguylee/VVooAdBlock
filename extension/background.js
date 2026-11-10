const dnr = chrome.declarativeNetRequest;
const youtubeMatches = chrome.runtime.getManifest().host_permissions;

// Persisted registration runs before the first inline player bootstrap, even with a sleeping worker.
async function syncPlayerFilters() {
  const rules = await dnr.getDynamicRules();
  const excluded = new Set();
  for (const rule of rules) {
    const host = /^\|https:\/\/([^/]+)\^$/.exec(rule.condition.urlFilter)?.[1];
    if (host && (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host) ||
      host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com"))) excluded.add("*://" + host + "/*");
  }
  const common = { matches: youtubeMatches, runAt: "document_start", world: "MAIN", persistAcrossSessions: true };
  const scripts = [
    { ...common, id: "youtube-playback", excludeMatches: [...excluded], js: ["youtube-playback.js", "youtube-top.js"] },
    { ...common, id: "youtube-embeds", allFrames: true, matches: youtubeMatches.map(m => m.endsWith("/embed/*") ? m : m.slice(0, -1) + "embed/*"),
      js: ["youtube-playback.js", "youtube-frame.js"] }
  ];
  const installed = await chrome.scripting.getRegisteredContentScripts();
  for (const script of scripts) {
    if (installed.some(s => s.id === script.id)) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  }
}

function supportedHost(rawUrl) {
  if (!rawUrl) return null;
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) return null;
  if (url.hostname === "chromewebstore.google.com" ||
      (url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore"))) return null;
  return url.hostname;
}

async function tabHost(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url) return supportedHost(tab.url);
  // Site access may be available through the content script without an activeTab grant.
  try {
    const url = await chrome.tabs.sendMessage(tabId, { type: "page-url" }, { frameId: 0 });
    return supportedHost(url);
  } catch {
    return null;
  }
}

function siteFilters(host) {
  // Match this exact hostname on any port, including HTTP and HTTPS.
  return ["|http://" + host + "^", "|https://" + host + "^"];
}

function exceptionIds(rules, filters) {
  return rules.filter(rule => filters.includes(rule.condition.urlFilter)).map(rule => rule.id);
}

async function blockingEnabled(host) {
  return exceptionIds(await dnr.getDynamicRules(), siteFilters(host)).length === 0;
}

async function setBlocking(host, enabled) {
  const rules = await dnr.getDynamicRules();
  const filters = siteFilters(host);
  const ids = exceptionIds(rules, filters);
  if (enabled) {
    if (ids.length) await dnr.updateDynamicRules({ removeRuleIds: ids });
  } else if (!ids.length) {
    const maxId = rules.reduce((max, rule) => Math.max(max, rule.id), 0);
    const addRules = filters.map((urlFilter, i) => ({
      id: maxId + i + 1,
      priority: 10,
      action: { type: "allowAllRequests" },
      condition: { urlFilter, resourceTypes: ["main_frame"] }
    }));
    await dnr.updateDynamicRules({ addRules });
  }
  return enabled;
}

// Chrome applies each rule update atomically. Serialize read-modify-write operations from separate windows.
let pendingWrite = Promise.resolve();
function enqueue(write) {
  const result = pendingWrite.then(write);
  pendingWrite = result.catch(() => {});
  return result;
}
chrome.runtime.onInstalled.addListener(() => enqueue(syncPlayerFilters));
chrome.runtime.onStartup.addListener(() => enqueue(syncPlayerFilters));
async function handle(message, sender) {
  if (message.type === "page-state" && sender.tab) {
    const host = supportedHost(sender.frameId === 0 ? sender.url : message.topOrigin);
    return { enabled: Boolean(host) && await blockingEnabled(host) };
  }
  if (sender.url !== chrome.runtime.getURL("popup.html")) throw new Error("Unknown sender");
  const host = await tabHost(message.tabId);
  if (message.type === "site-state") {
    return { host, enabled: Boolean(host) && await blockingEnabled(host) };
  }
  if (!host || host !== message.host) throw new Error("Tab changed");
  if (message.type === "set-blocking" && typeof message.enabled === "boolean") {
    return enqueue(async () => {
      const before = await blockingEnabled(host);
      await setBlocking(host, message.enabled);
      if (before === message.enabled || !youtubeMatches.some(m => m.includes("://" + host + "/")) &&
          host !== "youtube-nocookie.com" && !host.endsWith(".youtube-nocookie.com")) return { host, enabled: message.enabled };
      try {
        await syncPlayerFilters();
      } catch (error) {
        await setBlocking(host, before);
        await syncPlayerFilters();
        throw error;
      }
      return { host, enabled: message.enabled };
    });
  }
  if (message.type === "reload-tab") {
    await chrome.tabs.reload(message.tabId);
    return { host };
  }
  throw new Error("Unknown action");
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(respond, () => respond({ error: true }));
  return true;
});
