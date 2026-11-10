const hostLabel = document.querySelector("#host");
const toggle = document.querySelector("#toggle");
const notice = document.querySelector("#notice");
const reload = document.querySelector("#reload");
let tabId;
let host;
let enabled;

async function request(type, details) {
  const result = await chrome.runtime.sendMessage({ type, tabId, host, ...details });
  if (!result || result.error) throw new Error("Request failed");
  return result;
}

function showState(state) {
  host = state.host;
  enabled = state.enabled;
  hostLabel.textContent = host || "설정할 수 없는 페이지";
  toggle.setAttribute("aria-checked", String(enabled));
  toggle.disabled = !host;
  notice.textContent = host
    ? "설정은 페이지를 새로 열거나 새로고침할 때 적용됩니다."
    : "이 페이지에서는 설정할 수 없습니다.";
}

async function openPopup() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab.id;
    showState(await request("site-state"));
    await refreshShorts();
  } catch {
    hostLabel.textContent = "사이트 확인 실패";
    notice.textContent = "팝업을 다시 열어 주세요.";
  }
}

toggle.addEventListener("click", async () => {
  toggle.disabled = true;
  reload.disabled = true;
  try {
    showState(await request("set-blocking", { enabled: !enabled }));
    notice.textContent = "설정을 저장했습니다. 새로고침하면 적용됩니다.";
    reload.hidden = false;
  } catch {
    notice.textContent = "설정을 변경하지 못했습니다. 팝업을 다시 열어 주세요.";
  } finally {
    toggle.disabled = false;
    reload.disabled = false;
  }
});

reload.addEventListener("click", async () => {
  reload.disabled = true;
  try {
    await request("reload-tab");
    window.close();
  } catch {
    notice.textContent = "탭을 직접 새로고침해 주세요.";
    reload.disabled = false;
  }
});

const find = selector => document.querySelector(selector);
let currentShort;
let entries = {};
let recording = false;

async function contextForTab(message = { type: "short-context" }) {
  return chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => null);
}
function showShorts() {
  const list = find("#short-list");
  list.replaceChildren();
  const selected = Object.entries(entries).filter(([key]) => key.startsWith(shortKeyPrefix));
  find("#short-count").textContent = "(" + selected.length + ")";
  for (const [key, title] of selected) {
    const id = key.slice(shortKeyPrefix.length);
    const row = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = title && title !== id ? title + " · " + id : id;
    const remove = document.createElement("button");
    remove.textContent = "해제";
    remove.setAttribute("aria-label", id + " 차단 해제");
    remove.onclick = () => saveShort(id, null);
    row.append(label, remove);
    list.append(row);
  }
  find("#current-short").hidden = !currentShort?.id;
  if (currentShort?.id) {
    find("#short-title").textContent = (currentShort.title || "쇼츠") + " · " + currentShort.id;
    find("#select-short").textContent = Object.hasOwn(entries, shortKeyPrefix + currentShort.id) ? "이 쇼츠 차단 해제" : "이 쇼츠 차단";
  }
}
async function refreshShorts() {
  currentShort = await contextForTab();
  entries = await chrome.storage.local.get(null);
  showShorts();
  find("#short-debug").hidden = !currentShort?.id && !currentShort?.recording && !currentShort?.records?.length;
  showRecording(currentShort);
}
async function saveShort(id, title) {
  const key = shortKeyPrefix + id;
  try {
    if (title === null) await chrome.storage.local.remove(key);
    else await chrome.storage.local.set({ [key]: title || id });
    entries = await chrome.storage.local.get(null);
    showShorts();
    find("#short-status").textContent = id + (title === null ? " 차단을 해제했습니다." : " 차단 목록에 추가했습니다.");
  } catch {
    find("#short-status").textContent = "저장하지 못했습니다. 다시 시도해 주세요.";
  }
}
find("#select-short").onclick = async () => {
  const actual = await contextForTab();
  if (!actual?.id || actual.id !== currentShort?.id) {
    await refreshShorts();
    find("#short-status").textContent = "영상이 바뀌었습니다. 현재 쇼츠를 확인해 주세요.";
    return;
  }
  await saveShort(actual.id, Object.hasOwn(entries, shortKeyPrefix + actual.id) ? null : actual.title || actual.id);
};
find("#short-form").onsubmit = async event => {
  event.preventDefault();
  const field = find("#short-url");
  const id = shortIdFromUrl(field.value.trim());
  if (!id) {
    find("#short-status").textContent = "유튜브 쇼츠 링크를 입력해 주세요.";
    return;
  }
  await saveShort(id, entries[shortKeyPrefix + id] || id);
  field.value = "";
};
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [key, change] of Object.entries(changes)) {
    if (change.newValue === undefined) delete entries[key];
    else entries[key] = change.newValue;
  }
  showShorts();
});
function showRecording(state) {
  recording = state?.recording === true;
  find("#record-shorts").textContent = recording ? "기록 중지" : "기록 시작";
  find("#short-log").value = state?.records?.join("\n") || "";
}
async function readRecording(message) {
  const state = await contextForTab(message);
  if (!state) { find("#short-status").textContent = "유튜브 탭을 새로고침해 주세요."; return; }
  showRecording(state);
  find("#short-log").hidden = false;
}
find("#record-shorts").onclick = () => readRecording({ type: "short-recording", enabled: !recording });
find("#refresh-log").onclick = () => readRecording();
openPopup();
