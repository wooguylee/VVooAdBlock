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

openPopup();
