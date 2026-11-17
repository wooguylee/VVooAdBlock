const assert = require("node:assert/strict");

module.exports = async function checkEnforcementPopup(page, enabled) {
  // Use a real playing media element, so closing DOM alone cannot satisfy the test.
  const result = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d");
    const draw = setInterval(() => { ctx.fillStyle = "green"; ctx.fillRect(0, 0, 32, 32); }, 25);
    const stream = canvas.captureStream(30);
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = stream;
    document.body.append(video);
    const outcomes = [];
    let reusableNotice;
    let visibleNotice;
    let nativeClosedNotice;
    try {
      for (const scenario of ["immediate", "visible", "reused-after-visible", "native-close", "reused-after-native-close", "after-close", "reused-after-close", "manual-paused", "unrelated", "no-close", "changed-callback", "no-notice"]) {
        await video.play();
        if (scenario === "manual-paused") video.pause();
        const notice = scenario === "reused-after-close" ? reusableNotice : scenario === "reused-after-visible" ? visibleNotice :
          scenario === "reused-after-native-close" ? nativeClosedNotice : document.createElement("ytd-enforcement-message-view-model");
        if (scenario === "after-close") reusableNotice = notice;
        if (scenario === "visible") visibleNotice = notice;
        if (scenario === "native-close") nativeClosedNotice = notice;
        notice.style.display = "block";
        notice.innerHTML = '<div id="title">동영상 3개가 재생된 후 동영상 플레이어가 차단됩니다</div>' +
          '<ul id="body"><li>' + (scenario === "unrelated" ? "일반 알림입니다." : "광고 차단 프로그램을 사용 중인 것 같습니다.") + '</li></ul>' +
          (scenario === "no-close" ? "" : '<div id="dismiss-button"><button>닫기</button></div>');
        notice.querySelector("button")?.addEventListener("click", () => notice.remove());
        if (["visible", "native-close"].includes(scenario)) notice.querySelector("button").disabled = true;
        if (scenario !== "no-notice") document.body.append(notice);
        const q = {JSC$18686_playerManager: {pause() { video.pause(); }}};
        function probe() {}
        const opened = ["immediate", "visible", "native-close"].includes(scenario) ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, 200));
        if (scenario === "changed-callback") {
          // Do not suppress a changed callback that may have additional responsibilities.
          await Promise.all([opened]).then(() => { probe(); q.JSC$18686_playerManager && q.JSC$18686_playerManager.pause(); q.extra = true; });
        } else {
          // Same callback shape as the deployed SnP popup handler, including its post-open pause.
          await Promise.all([opened]).then(() => { probe(); q.JSC$18686_playerManager && q.JSC$18686_playerManager.pause(); });
        }
        if (scenario === "visible") {
          notice.querySelector("button").disabled = false;
          notice.append(document.createElement("span"));
        }
        if (scenario === "native-close") notice.remove();
        await new Promise(resolve => setTimeout(resolve, 100));
        const paused = video.paused;
        const start = video.currentTime;
        await new Promise(resolve => setTimeout(resolve, 150));
        outcomes.push({scenario, paused, advanced:video.currentTime > start, closed:!notice.isConnected, extra:q.extra});
        // A user's pause must work even immediately after an intercepted callback.
        video.pause();
        outcomes.at(-1).manualPauseWorks = video.paused;
        notice.remove();
      }
      return outcomes;
    } finally {
      clearInterval(draw);
      for (const track of stream.getTracks()) track.stop();
      video.remove();
    }
  });
  for (const row of result) {
    const protectedPlayback = enabled && ["immediate", "visible", "reused-after-visible", "native-close", "reused-after-native-close", "after-close", "reused-after-close"].includes(row.scenario);
    assert.equal(row.paused, !protectedPlayback, `popup ${row.scenario}: native callback must not pause dismissed ad warnings`);
    assert.equal(row.advanced, protectedPlayback, `popup ${row.scenario}: actual media playback must continue`);
    assert(row.manualPauseWorks, `popup ${row.scenario}: manual pause is preserved`);
    assert.equal(row.closed, ["no-notice", "native-close"].includes(row.scenario) || enabled && !["unrelated", "no-close"].includes(row.scenario));
    if (row.scenario === "changed-callback") assert.equal(row.extra, true);
  }
};
