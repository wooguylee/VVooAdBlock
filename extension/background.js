const dnr = chrome.declarativeNetRequest;

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
    const write = pendingWrite.then(() => setBlocking(host, message.enabled));
    pendingWrite = write.catch(() => {});
    return { host, enabled: await write };
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
