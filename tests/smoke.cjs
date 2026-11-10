const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const checkYouTube = require("./youtube.cjs");

const extension = path.resolve(__dirname, "../extension");
const adHost = "pagead2.googlesyndication.com";
const site = "reader.test";
const otherSite = "second.reader.test";
const frameHost = "widget.test";
const requests = [];

const server = http.createServer((req, res) => {
  const host = req.headers.host.split(":")[0];
  requests.push([host, req.url]);
  res.setHeader("cache-control", "no-store");
  if (req.url === "/ad.js" || req.url === "/article.js") {
    res.setHeader("content-type", "text/javascript");
    res.end(req.url === "/ad.js" ? "window.adLoaded = true;" : "window.articleLoaded = true;");
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  const origin = "http://" + adHost + ":" + server.address().port;
  const adScript = '<script src="' + origin + '/ad.js"></script>';
  if (req.url === "/frame") {
    res.end(adScript);
    return;
  }
  res.end('<!doctype html><article>본문</article><ins class="adsbygoogle">광고</ins>' +
    '<script src="/article.js"></script>' + adScript +
    '<iframe src="http://' + frameHost + ':' + server.address().port + '/frame"></iframe>');
});

async function run() {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "vvoo-adblock-"));
  const profile = path.join(temp, "profile");
  const unpacked = path.join(temp, "extension");
  const url = hostname => "http://" + hostname + ":" + server.address().port;
  const frameAdLoaded = page => page.frame({ url: url(frameHost) + "/frame" }).evaluate(() => Boolean(window.adLoaded));
  const args = ["--no-proxy-server", "--host-resolver-rules=" +
    [site, otherSite, adHost, frameHost].map(host => "MAP " + host + " 127.0.0.1").join(",")];
  const options = { channel: "chromium", headless: true, args };
  if (process.env.CHROME_FOR_TESTING) options.executablePath = process.env.CHROME_FOR_TESTING;
  let context;
  try {
    context = await chromium.launchPersistentContext("", options);
    const baseline = await context.newPage();
    await baseline.goto(url(site));
    assert.equal(await baseline.evaluate(() => window.adLoaded), true, "baseline ad script reachable");
    assert(await frameAdLoaded(baseline));
    await context.close();
    await fs.cp(extension, unpacked, { recursive: true, filter: src => path.basename(src) !== "_metadata" });
    args.push("--disable-extensions-except=" + unpacked, "--load-extension=" + unpacked);
    context = await chromium.launchPersistentContext(profile, options);
    const page = await context.newPage();
    const blocked = [];
    page.on("requestfailed", req => blocked.push([req.url(), req.failure().errorText]));
    requests.length = 0;
    await page.goto(url(site));
    assert.equal(await page.evaluate(() => Boolean(window.adLoaded)), false, "ad script must be blocked");
    assert.equal(await frameAdLoaded(page), false);
    assert(blocked.some(([u, reason]) => u === url(adHost) + "/ad.js" && reason.includes("BLOCKED_BY_CLIENT")));
    assert(!requests.some(([host, route]) => host === adHost && route === "/ad.js"));
    assert.equal(await page.evaluate(() => window.articleLoaded), true);
    await page.locator("ins.adsbygoogle").waitFor({ state: "hidden" });
    assert(await page.locator("article").isVisible());
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<div id="div-gpt-ad-late">광고</div>'));
    assert(await page.locator("#div-gpt-ad-late").isHidden());
    console.log("PASS advertising request blocked before server, article delivered, ad slots hidden");

    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const cases = [
      ["https://gfp.veta.naver.com/ad.js", "script", "advertising"],
      ["https://t1.kakaocdn.net/kas/static/ba.min.js?v=1", "script", "advertising"],
      ["https://t1.kakaocdn.net/gameplay/gameplay-sdk.js", "script", null],
      ["https://iad.g.163.com/banner.jpg", "image", "adaway"],
      ["https://sibling.iad.g.163.com/banner.jpg", "image", null],
      ["https://pagead2.googlesyndication.com/", "main_frame", null],
      ["https://www.youtube.com/pagead/ads", "image", "advertising"],
      ["https://www.youtube.com/get_midroll_info?video=123", "xmlhttprequest", "advertising"],
      ["https://www.youtube.com/youtubei/v1/player/ad_break?prettyPrint=false", "xmlhttprequest", "advertising"],
      ["https://www.youtube.com/youtubei/v1/player?prettyPrint=false", "xmlhttprequest", null],
      ["https://r1.googlevideo.com/videoplayback?id=123", "media", null]
    ];
    for (const [url, type, expected] of cases) {
      const rulesets = await worker.evaluate(async ({ url, type }) => {
        const result = await chrome.declarativeNetRequest.testMatchOutcome({ url, type, initiator: "https://reader.test" });
        return result.matchedRules.map(rule => rule.rulesetId);
      }, { url, type });
      assert.deepEqual(rulesets, expected ? [expected] : [], url);
    }
    console.log("PASS Korean ad rules, shared CDN content, AdAway exact host and main navigation");
    const popupUrl = new URL("popup.html", worker.url()).href;
    await checkYouTube(context, popupUrl);
    // Load the packaged popup as a background page while the article is the active tab.
    const popup = await context.newPage();
    await page.bringToFront();
    await popup.goto(popupUrl);
    const toggle = popup.getByRole("switch");
    await popup.getByText(site, { exact: true }).waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    await toggle.click();
    await popup.waitForFunction(() => document.querySelector('[role="switch"]').getAttribute("aria-checked") === "false");
    await Promise.all([page.waitForEvent("load"), popup.getByRole("button", { name: "탭 새로고침" }).click()]);
    assert.equal(await page.evaluate(() => window.adLoaded), true);
    assert(await frameAdLoaded(page));
    assert(await page.locator("ins.adsbygoogle").isVisible());
    await page.goto(url(otherSite));
    assert.equal(await page.evaluate(() => Boolean(window.adLoaded)), false);
    console.log("PASS popup exception allows ads and slots only on the selected hostname");

    await context.close();
    context = await chromium.launchPersistentContext(profile, options);
    const restored = await context.newPage();
    await restored.goto(url(site));
    assert.equal(await restored.evaluate(() => window.adLoaded), true);
    const settings = await context.newPage();
    await restored.bringToFront();
    await settings.goto(popupUrl);
    await settings.getByText(site, { exact: true }).waitFor();
    assert.equal(await settings.getByRole("switch").getAttribute("aria-checked"), "false");
    await settings.getByRole("switch").click();
    await settings.waitForFunction(() => document.querySelector('[role="switch"]').getAttribute("aria-checked") === "true");
    await restored.reload();
    assert.equal(await restored.evaluate(() => Boolean(window.adLoaded)), false);
    await restored.locator("ins.adsbygoogle").waitFor({ state: "hidden" });
    await restored.goto("chrome://extensions");
    await restored.bringToFront();
    await settings.reload();
    await settings.getByText("이 페이지에서는 설정할 수 없습니다.").waitFor();
    assert(await settings.getByRole("switch").isDisabled());
    console.log("PASS exception persists across restart, re-enabling restores blocking, internal page handled");
  } finally {
    try {
      if (context) await context.close();
    } finally {
      server.close();
      await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
