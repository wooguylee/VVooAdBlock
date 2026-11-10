const assert = require("node:assert/strict");

// The watch page schedules both the dialog and PAUSE_PLAYER from this message.
const inactivityMessage = { youThereRenderer: { configData: { youThereData: {
  lactThresholdMs: "0", promptDelaySec: 0, playbackPauseDelayMs: 0,
  showPausedActions: [
    { openPopupAction: { popupType: "DIALOG", popup: { confirmDialogRenderer: {
      dialogMessages: [{ runs: [{ text: "동영상이 일시중지되었습니다. 이어서 시청하시겠어요?" }] }]
    } } } },
    { signalAction: { signal: "PAUSE_PLAYER" } }
  ]
} } } };
const ordinaryMessage = { mealbarPromoRenderer: { message: "ordinary notice" } };
const playerPayload = { videoDetails: {videoId:"testContent"}, streamingData: {url:"/media-test/main"},
  playabilityStatus: {status:"OK"}, adPlacements:[{url:"/media-test/ad"}], adSlots:[{}], playerAds:[{}],
  messages: [inactivityMessage, ordinaryMessage] };
const feedPayload = {entries: [
  {command:{reelWatchEndpoint:{videoId:"organicVideo"}}},
  {command:{reelWatchEndpoint:{videoId:"feedAdVideo",adClientParams:{isAd:true}}}},
  {continuation:"next-page"}
]};
const startPlayer = `<script>
  // Same two assignments as the Shorts bootstrap: serialized global, then parsed global.
  var ytInitialReelWatchSequenceResponse = ${JSON.stringify(JSON.stringify({...feedPayload, continuationEndpoint:{token:"more"}}))};
  window["ytInitialReelWatchSequenceResponse"] = JSON.parse(ytInitialReelWatchSequenceResponse);
  window.firstQueue = ytInitialReelWatchSequenceResponse.entries.map(e => e.command?.reelWatchEndpoint.videoId || e.continuation);
  window.ytInitialPlayerResponse = ${JSON.stringify(playerPayload)};
  window.inactivityActions = [];
  async function play(data) {
    for (const message of data.messages || []) {
      const actions = message.youThereRenderer?.configData?.youThereData?.showPausedActions || [];
      for (const action of actions) window.inactivityActions.push(action.signalAction?.signal || action.openPopupAction?.popupType);
    }
    if (data.adPlacements?.length) await fetch(data.adPlacements[0].url);
    await fetch(data.streamingData.url);
  }
  window.startup = (async () => {
    await play(window.ytInitialPlayerResponse);
    const res = await fetch("/youtubei/v1/player");
    const streamed = await new Response(res.clone().body).json();
    await play(streamed);
    const xhrData = await new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET","/youtubei/v1/player");
      xhr.responseType = "json";
      xhr.onload = () => resolve(xhr.response);
      xhr.send();
    });
    await play(xhrData);
    const feed = await (await fetch("/youtubei/v1/reel/reel_watch_sequence")).json();
    return [streamed.playabilityStatus.status, feed.entries.map(e => e.command?.reelWatchEndpoint.videoId || e.continuation)];
  })();
</script>`;

const fixture = `<!doctype html><meta charset="utf-8">
<style>
  ytd-reel-video-renderer { display:block; position:fixed; inset:20% 45%; pointer-events:none }
  button, a { pointer-events:auto }
</style>
<ytd-shorts>
  <ytd-reel-video-renderer>
    <div id="sticker-layer"><yt-overlay-sticker><div class="ytOverlayProductStickerHost">
      <a href="#product">상품 이미지</a><a href="#product">쇼핑하기</a>
    </div></yt-overlay-sticker><yt-overlay-sticker>투표</yt-overlay-sticker></div>
  </ytd-reel-video-renderer>
  <div id="navigation-button-down"><button onclick="window.nextCount++">다음 동영상</button></div>
</ytd-shorts>
<ytd-rich-item-renderer><div id="content"><ytd-ad-slot-renderer>광고 카드</ytd-ad-slot-renderer></div></ytd-rich-item-renderer>
<ytd-rich-item-renderer>일반 영상</ytd-rich-item-renderer>
<div class="html5-video-player"><video></video>
  <button class="ytp-skip-ad-button" hidden onclick="window.skipCount++">건너뛰기</button>
</div>
<button>좋아요</button><button>댓글</button>
<script>window.skipCount=0; window.nextCount=0;</script>`;

module.exports = async function checkYouTube(context, popupUrl) {
  const testUrl = "https://www.youtube.com/shorts/fixture";
  const requests = [];
  await context.route("https://www.youtube.com/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/media-test/")) {
      requests.push(path);
      return route.fulfill({body:"media"});
    }
    if (path.endsWith("/next")) {
      const player = { messages: [inactivityMessage, ordinaryMessage], playabilityStatus: {status:"OK"} };
      return route.fulfill({ json: { playerResponse: player,
        endpoint: { watchEndpoint: { unserializedPrefetchData: { playerResponse: player } } } } });
    }
    if (path.startsWith("/youtubei/")) return route.fulfill({json:path.endsWith("/player") ? playerPayload : feedPayload});
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture.replace("<meta", startPlayer + "<meta") });
  });
  const page = await context.newPage();
  await page.goto(testUrl);
  assert.deepEqual(await page.evaluate(() => [window.firstQueue, ytInitialReelWatchSequenceResponse.continuationEndpoint.token]),
    [["organicVideo","next-page"],"more"], "no sponsored Short reaches the first playback queue");
  assert.deepEqual(await page.evaluate(() => window.startup), ["OK", ["organicVideo","next-page"]]);
  assert.deepEqual(await page.evaluate(() => window.inactivityActions), [],
    "neither the inactivity dialog nor automatic pause is scheduled across inline, fetch and XHR");
  assert.deepEqual(await page.evaluate(() => window.ytInitialPlayerResponse.messages), [ordinaryMessage],
    "unrelated player notices survive");
  // Ad-free playback responses still carry inactivity instructions, including prefetched navigation.
  assert.deepEqual(await page.evaluate(async () => {
    const data = await (await fetch("/youtubei/v1/next")).json();
    return [data.playerResponse.messages, data.endpoint.watchEndpoint.unserializedPrefetchData.playerResponse.messages];
  }), [[ordinaryMessage], [ordinaryMessage]]);
  assert.deepEqual(requests, Array(3).fill("/media-test/main"), "zero creative requests across inline, fetch stream and XHR");
  await page.waitForSelector("html[data-vvoo-adblock]", { state: "attached" });
  const product = page.getByText("쇼핑하기", { exact: true });
  assert.equal(await product.count(), 1);
  assert(await product.isHidden(), "the YouTube product sticker should be hidden");
  for (const name of ["투표", "좋아요", "댓글", "일반 영상"]) assert(await page.getByText(name, { exact: true }).isVisible(), name);
  assert(await page.getByText("광고 카드").isHidden());
  await page.evaluate(() => {
    const sticker = document.querySelector("yt-overlay-sticker");
    sticker.replaceWith(sticker.cloneNode(true));
    const player = document.querySelector(".html5-video-player");
    player.querySelector("video").playbackRate = 1.5;
    player.classList.add("ad-showing");
  });
  assert(await product.isHidden(), "replacement sticker on SPA navigation");
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video.muted && video.playbackRate > 1.5 && getComputedStyle(video.parentElement).opacity === "0";
  });
  assert.equal(await page.evaluate(() => window.skipCount), 0);
  await page.locator(".ytp-skip-ad-button").evaluate(button => { button.hidden = false; });
  await page.waitForFunction(() => window.skipCount > 0);
  await page.locator(".html5-video-player").evaluate(player => player.classList.remove("ad-showing"));
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return !video.muted && video.playbackRate === 1.5 && getComputedStyle(video.parentElement).opacity === "1";
  });
  assert.equal(await page.evaluate(() => window.nextCount), 0, "a tagged organic Short must not be skipped");
  const reel = page.locator("ytd-reel-video-renderer").first();
  await reel.evaluate(el => {
    const preloaded = el.parentElement.appendChild(document.createElement("ytd-reel-video-renderer"));
    preloaded.style.transform = "translateY(150vh)";
    preloaded.setAttribute("is-ads-overlay", "");
    el.setAttribute("is-ads-overlay", "false");
  });
  await page.waitForTimeout(850);
  assert.deepEqual(await reel.evaluate(el => [getComputedStyle(el).opacity, window.nextCount]), ["1", 0],
    "an offscreen ad must not advance the visible organic Short even with no social controls");
  assert.equal(await reel.evaluate(el => {
    el.setAttribute("is-ads-overlay", "");
    return getComputedStyle(el).opacity;
  }), "0", "a prepared sponsored reel is concealed before the next paint");
  await page.waitForFunction(() => window.nextCount === 1);
  await reel.evaluate(el => {
    el.removeAttribute("is-ads-overlay");
    el.parentElement.querySelector('ytd-reel-video-renderer[is-ads-overlay]').remove();
    window.nextCount = 0;
  });
  await page.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", '<ytd-enforcement-message-view-model><h2 id="title">광고 차단 프로그램은 YouTube에서 허용되지 않습니다</h2><div id="dismiss-button"><button onclick="this.closest(\'ytd-enforcement-message-view-model\').remove()">닫기</button></div></ytd-enforcement-message-view-model><dialog open><button>닫기</button></dialog>');
  });
  await page.locator("ytd-enforcement-message-view-model").waitFor({state:"detached"});
  assert(await page.locator("dialog[open]").isVisible());
  await page.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", '<ytd-enforcement-message-view-model id="no-close" style="display:block"><h2 id="title">광고 차단 프로그램 안내</h2></ytd-enforcement-message-view-model>');
    window.ytInitialPlayerResponse = { playabilityStatus: { status: "ERROR", reason: "Unavailable" } };
  });
  assert(await page.locator("#no-close").isVisible());
  assert.deepEqual(await page.evaluate(() => window.ytInitialPlayerResponse.playabilityStatus), {status:"ERROR",reason:"Unavailable"});
  await page.locator("ytd-reel-video-renderer").evaluate(reel => reel.append(document.createElement("ytd-ad-slot-renderer")));
  await page.waitForFunction(() => window.nextCount === 1);
  // Same reel element, new URL, no sponsored-slot markup (as on the reported public Short).
  const reportedUrl = "https://www.youtube.com/shorts/GJbi9T0wtRI?feature=share";
  await page.evaluate(url => {
    document.querySelector("ytd-reel-video-renderer > ytd-ad-slot-renderer").remove();
    document.querySelector("#navigation-button-down button").onclick = () => {
      window.nextCount++;
      history.pushState(null, "", "/shorts/anotherShort");
    };
    history.pushState(null, "", url);
  }, reportedUrl);
  const settings = await context.newPage();
  await page.bringToFront();
  await settings.goto(popupUrl);
  await settings.getByRole("button", {name:"이 쇼츠 차단", exact:true}).waitFor();
  assert.equal(page.url(), reportedUrl, "previously hard-coded example stays unblocked");
  await settings.locator("#short-debug summary").click();
  await settings.getByRole("button", {name:"기록 시작"}).click();
  await settings.getByRole("button", {name:"기록 중지"}).waitFor();
  await page.evaluate(() => fetch("/youtubei/v1/reel/reel_watch_sequence").then(r=>r.json()));
  await settings.getByRole("button", {name:"기록 보기"}).click();
  assert.match(await settings.locator("#short-log").inputValue(), /"feedAd":true/);
  await settings.getByRole("button", {name:"이 쇼츠 차단", exact:true}).click();
  await page.waitForURL("**/shorts/anotherShort", { timeout: 4000, waitUntil: "commit" });
  await page.waitForTimeout(850);
  assert.equal(await page.evaluate(() => window.nextCount), 2, "advance once and leave the next organic Short playing");
  await settings.reload();
  await settings.locator("#manage-shorts summary").click();
  await settings.getByRole("button", {name:"GJbi9T0wtRI 차단 해제"}).click();
  await page.goto(reportedUrl);
  await page.waitForTimeout(850);
  assert.equal(await page.evaluate(() => window.nextCount), 0, "unblocked from another Short");
  await settings.locator("#short-url").fill(reportedUrl);
  await settings.getByRole("button", {name:"추가", exact:true}).click();
  await page.waitForFunction(() => window.nextCount === 1);
  // The containing site's policy governs an embedded player, independently of the YouTube tab.
  const hostPage = await context.newPage();
  await hostPage.route("https://publisher.test/**", route => route.fulfill({
    contentType: "text/html", body: '<iframe src="https://www.youtube.com/embed/fixture"></iframe>'
  }));
  await page.bringToFront();
  await settings.goto(popupUrl);
  await settings.getByText("www.youtube.com", { exact: true }).waitFor();
  await settings.getByRole("switch").click();
  await settings.waitForFunction(() => document.querySelector('[role="switch"]').getAttribute("aria-checked") === "false");
  requests.length = 0;
  await page.goto(reportedUrl);
  assert.deepEqual(await page.evaluate(() => window.firstQueue), ["organicVideo","feedAdVideo","next-page"]);
  const allowedReel = page.locator("ytd-reel-video-renderer");
  await allowedReel.evaluate(el => el.setAttribute("is-ads-overlay", ""));
  assert.equal(await allowedReel.evaluate(el => getComputedStyle(el).opacity), "1", "ads remain visible on an excepted site");
  assert.deepEqual(await page.evaluate(() => window.startup), ["OK", ["organicVideo","feedAdVideo","next-page"]]);
  assert.deepEqual(await page.evaluate(() => window.inactivityActions),
    ["DIALOG", "PAUSE_PLAYER", "DIALOG", "PAUSE_PLAYER", "DIALOG", "PAUSE_PLAYER"],
    "an excepted site retains its native inactivity behavior");
  assert.deepEqual(requests, ["/media-test/ad","/media-test/main","/media-test/ad","/media-test/main","/media-test/ad","/media-test/main"]);
  assert(await product.isVisible());
  assert(await page.getByText("광고 카드").isVisible());
  await page.locator(".html5-video-player").evaluate(player => {
    player.classList.add("ad-showing");
    player.querySelector("button").hidden = false;
  });
  await page.waitForTimeout(800);
  assert.deepEqual(await page.evaluate(() => [window.nextCount, window.skipCount, document.querySelector("video").muted]), [0, 0, false]);
  await hostPage.goto("https://publisher.test/watch");
  const embeddedPlayer = hostPage.frameLocator("iframe");
  await embeddedPlayer.locator("html[data-vvoo-adblock]").waitFor({ state: "attached" });
  assert(await embeddedPlayer.getByText("광고 카드").isHidden());
  await hostPage.bringToFront();
  await settings.reload();
  await settings.getByText("publisher.test", { exact: true }).waitFor();
  await settings.getByRole("switch").click();
  await settings.waitForFunction(() => document.querySelector('[role="switch"]').getAttribute("aria-checked") === "false");
  await hostPage.reload();
  await embeddedPlayer.getByText("광고 카드").waitFor();
  await hostPage.close();
  await settings.close();
  await page.close();
  await context.unroute("https://www.youtube.com/**");
  console.log("PASS YouTube creative requests (enabled 0, disabled 3, main media 3 in both), feed selection, user block/unblock, diagnostics, dismissible notice and site exceptions");
};
