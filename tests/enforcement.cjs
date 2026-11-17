const assert = require("node:assert/strict");

const enforcement = {
  displayType: "ENFORCEMENT_MESSAGE_VIEW_MODEL_DISPLAY_TYPE_PLAYER", isVisible: true,
  title: { content: "동영상 플레이어가 차단되었습니다" }
};
const response = {
  playabilityStatus: { status: "OK" }, videoDetails: { videoId: "testContent" },
  streamingData: { formats: [{ url: "/media-test/main" }] },
  auxiliaryUi: { messageRenderers: { bkaEnforcementMessageViewModel: enforcement } }
};

module.exports = async function checkEnforcement(page, enabled) {
  await page.route("https://www.youtube.com/youtubei/v1/player?enforcement", route => route.fulfill({json:response}));
  const result = await page.evaluate(async payload => {
    const serialized = JSON.stringify(payload);
    window.ytInitialPlayerResponse = JSON.parse(serialized);
    const fetchResponse = await fetch("/youtubei/v1/player?enforcement");
    const values = [window.ytInitialPlayerResponse, await fetchResponse.clone().json(),
      await new Response(fetchResponse.body).json(), JSON.parse(serialized),
      await new Promise(resolve => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", "/youtubei/v1/player?enforcement");
        xhr.responseType = "json";
        xhr.onload = () => resolve(xhr.response);
        xhr.send();
      })];
    const before = values.map(value => JSON.stringify(value) === serialized);
    // The deployed YouTube response handler replaces status and clears videoDetails.
    for (const value of values) {
      value.playabilityStatus = { ...value.playabilityStatus, status: "ERROR",
        errorScreen: { enforcementMessageViewModel: value.auxiliaryUi.messageRenderers.bkaEnforcementMessageViewModel } };
      value.videoDetails = undefined;
    }
    const after = values.map(value => [value.playabilityStatus.status, value.videoDetails?.videoId]);
    const unrelated = JSON.parse(serialized);
    unrelated.playabilityStatus = {status:"ERROR", reason:"Network unavailable"};
    unrelated.videoDetails = undefined;
    const serverError = JSON.parse(JSON.stringify({...payload, playabilityStatus:{status:"LOGIN_REQUIRED"}, streamingData:undefined}));
    const listeners = new Map();
    const player = {
      stopped:false, getPlayerResponse:()=>payload, stopVideo(){this.stopped=true;},
      addEventListener(name, handler){listeners.set(name,handler);}
    };
    const originalListener = player.addEventListener;
    await Promise.resolve(player).then(instance => {
      instance.addEventListener("onAbnormalityDetected", () => instance.stopVideo());
      instance.addEventListener("onStateChange", () => { instance.stateChanged = true; });
      instance.initialized = true;
    });
    listeners.get("onAbnormalityDetected")?.();
    listeners.get("onStateChange")?.();
    return {before, after, unrelated:unrelated.playabilityStatus, unrelatedDetails:unrelated.videoDetails,
      serverStatus:serverError.playabilityStatus.status, stopped:player.stopped,
      initialized:player.initialized, stateChanged:player.stateChanged, listenerRestored:player.addEventListener===originalListener};
  }, response);
  assert.deepEqual(result.before, Array(5).fill(true), "signed renderer values remain unchanged before validation");
  assert.deepEqual(result.after, Array.from({length:5},()=>enabled?["OK","testContent"]:["ERROR",undefined]),
    "a playable response must survive the native ad-block enforcement handler across all response readers");
  assert.deepEqual(result.unrelated, {status:"ERROR",reason:"Network unavailable"});
  assert.equal(result.unrelatedDetails, undefined);
  assert.equal(result.serverStatus,"LOGIN_REQUIRED");
  assert.equal(result.stopped,!enabled,"the abnormality callback must not stop the playable video");
  assert(result.initialized && result.stateChanged && result.listenerRestored,"other callback work and player listeners are preserved");
  await page.unroute("https://www.youtube.com/youtubei/v1/player?enforcement");
};
