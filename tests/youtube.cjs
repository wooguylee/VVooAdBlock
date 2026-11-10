const assert = require("node:assert/strict");

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
  await context.route("https://www.youtube.com/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture }));
  const page = await context.newPage();
  await page.goto(testUrl);
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
    return video.muted && video.playbackRate > 1.5 && getComputedStyle(video).visibility === "hidden";
  });
  assert.equal(await page.evaluate(() => window.skipCount), 0);
  await page.locator(".ytp-skip-ad-button").evaluate(button => { button.hidden = false; });
  await page.waitForFunction(() => window.skipCount > 0);
  await page.locator(".html5-video-player").evaluate(player => player.classList.remove("ad-showing"));
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return !video.muted && video.playbackRate === 1.5 && getComputedStyle(video).visibility === "visible";
  });
  assert.equal(await page.evaluate(() => window.nextCount), 0, "a tagged organic Short must not be skipped");
  await page.locator("ytd-reel-video-renderer").evaluate(reel => reel.append(document.createElement("ytd-ad-slot-renderer")));
  await page.waitForFunction(() => window.nextCount === 1);
  // The containing site's policy governs an embedded player, independently of the YouTube tab.
  const hostPage = await context.newPage();
  await hostPage.route("https://publisher.test/**", route => route.fulfill({
    contentType: "text/html", body: '<iframe src="https://www.youtube.com/embed/fixture"></iframe>'
  }));
  const settings = await context.newPage();
  await page.bringToFront();
  await settings.goto(popupUrl);
  await settings.getByText("www.youtube.com", { exact: true }).waitFor();
  await settings.getByRole("switch").click();
  await settings.waitForFunction(() => document.querySelector('[role="switch"]').getAttribute("aria-checked") === "false");
  await page.reload();
  assert(await product.isVisible());
  assert(await page.getByText("광고 카드").isVisible());
  await page.locator(".html5-video-player").evaluate(player => {
    player.classList.add("ad-showing");
    player.querySelector("button").hidden = false;
  });
  await page.waitForTimeout(800);
  assert.deepEqual(await page.evaluate(() => [window.skipCount, document.querySelector("video").muted]), [0, false]);
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
  console.log("PASS YouTube shopping, native controls, feed ads, Shorts ads, ad playback and site exception");
};
