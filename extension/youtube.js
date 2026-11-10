(() => {
  const adPlayer = ".html5-video-player:is(.ad-showing, .ad-interrupting)";
  const skipButtons = "button.ytp-skip-ad-button, button.ytp-ad-skip-button-modern, button.ytp-ad-skip-button";
  const previousPlayback = new Map();
  const lastClick = new WeakMap();
  const blockedShortIds = new Set();
  let recording = false;
  const records = [];
  let lastSnapshot = "";
  let lastSkippedShort = null;

  function record(text) {
    records.push(new Date().toISOString().slice(11, 23) + "Z " + text);
    if (records.length > 60) records.shift();
  }
  document.addEventListener("vvoo-feed-ad", event => {
    if (recording) record(JSON.stringify({ feedAd: true, removed: true, videoId:
      typeof event.detail === "string" && /^[\w-]{11}$/.test(event.detail) ? event.detail : null }));
  });

  function clickable(button) {
    return button && !button.disabled && button.getAttribute("aria-disabled") !== "true" &&
      button.getClientRects().length > 0 && getComputedStyle(button).visibility === "visible";
  }

  function dismissAdNotice() {
    for (const notice of document.querySelectorAll("ytd-enforcement-message-view-model")) {
      const title = notice.querySelector("#title")?.textContent.trim() || "";
      if (!/광고\s*차단\s*프로그램|ad\s*blockers?/i.test(title)) continue;
      const button = notice.querySelector("#dismiss-button button");
      if (clickable(button) && performance.now() - (lastClick.get(button) ?? -Infinity) > 1000) {
        lastClick.set(button, performance.now());
        const dialog = notice.closest("tp-yt-paper-dialog, [role=dialog]") || notice;
        dialog.setAttribute("data-vvoo-dismissing-ad-notice", "");
        button.click();
        // A reused dialog or a failed native close must not leave an invisible modal.
        setTimeout(() => dialog.removeAttribute("data-vvoo-dismissing-ad-notice"), 300);
      }
    }
  }

  function restoreVideo(video, previous) {
    if (video.muted) video.muted = previous.muted;
    if (video.playbackRate === 16) video.playbackRate = previous.rate;
    previousPlayback.delete(video);
  }

  function handlePlayerAds() {
    for (const [video, previous] of previousPlayback) {
      if (!video.isConnected || !video.closest(adPlayer)) restoreVideo(video, previous);
    }
    for (const player of document.querySelectorAll(adPlayer)) {
      for (const video of player.querySelectorAll("video")) {
        if (previousPlayback.has(video)) continue;
        previousPlayback.set(video, { muted: video.muted, rate: video.playbackRate });
        video.muted = true;
        video.playbackRate = 16;
      }
      const button = [...player.querySelectorAll(skipButtons)].find(clickable);
      if (button && performance.now() - (lastClick.get(button) ?? -Infinity) > 1000) {
        lastClick.set(button, performance.now());
        button.click();
      }
    }
  }

  function skipShortsAd() {
    if (!location.pathname.startsWith("/shorts/")) {
      lastSkippedShort = null;
      return;
    }
    if (document.hidden) return;
    const shorts = document.querySelector("ytd-shorts:not([hidden])");
    if (!shorts) return;
    const reel = [...shorts.querySelectorAll("ytd-reel-video-renderer")].find(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.top <= innerHeight / 2 && rect.bottom > innerHeight / 2;
    });
    const videoId = shortIdFromUrl(location.href);
    const reported = blockedShortIds.has(videoId);
    const hasAdSlot = !!(reel?.matches('[is-ads-overlay]:not([is-ads-overlay="false"]), [is-ad]:not([is-ad="false"])') ||
      reel?.querySelector(":scope > ytd-ad-slot-renderer, :scope > #short-video-container > ytd-ad-slot-renderer"));
    if (recording) {
      const channel = reel?.querySelector('a[href^="/@"]');
      const snapshot = JSON.stringify({ videoId, reel: !!reel, channelVisible: !!channel?.getBoundingClientRect().width,
        adSlot: hasAdSlot, playerAd: !!shorts.querySelector(adPlayer), selected: reported,
        blocking: document.documentElement.hasAttribute("data-vvoo-adblock") });
      if (snapshot !== lastSnapshot) {
        lastSnapshot = snapshot;
        record(snapshot);
      }
    }
    if (!reel || !document.documentElement.hasAttribute("data-vvoo-adblock")) return;
    if (!reported && !hasAdSlot) {
      lastSkippedShort = null;
      return;
    }
    // YouTube can replace the reel element before updating the URL of a reported Short.
    const skipKey = reported ? videoId : reel;
    const next = shorts.querySelector("#navigation-button-down button");
    if (lastSkippedShort !== skipKey && clickable(next)) {
      lastSkippedShort = skipKey;
      next.click();
    }
  }

  function refresh() {
    if (document.documentElement?.hasAttribute("data-vvoo-adblock")) {
      dismissAdNotice();
      handlePlayerAds();
    }
    skipShortsAd();
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.url !== chrome.runtime.getURL("popup.html") || !["short-context", "short-recording"].includes(message.type)) return;
    if (message.type === "short-recording") {
      recording = message.enabled === true;
      document.documentElement.toggleAttribute("data-vvoo-shorts-debug", recording);
      if (recording) { records.length = 0; lastSnapshot = ""; refresh(); }
    }
    respond({ id: shortIdFromUrl(location.href), title: document.title.replace(/ - YouTube$/, ""),
      recording, records });
  });

  function updateKeys(changes) {
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(shortKeyPrefix)) continue;
      const id = key.slice(shortKeyPrefix.length);
      if (change.newValue === undefined) blockedShortIds.delete(id);
      else blockedShortIds.add(id);
    }
  }
  // Replay edits made while loading the initial snapshot in another tab.
  let loading = [];
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (loading) loading.push(changes);
    else updateKeys(changes);
  });
  Promise.all([vvooBlockingReady, chrome.storage.local.get(null)]).then(([, entries]) => {
    for (const key of Object.keys(entries)) if (key.startsWith(shortKeyPrefix)) blockedShortIds.add(key.slice(shortKeyPrefix.length));
    for (const changes of loading) updateKeys(changes);
    loading = null;
    // The player and its buttons are reused across ad breaks and SPA navigation.
    // Polling also catches buttons becoming visible through a CSS transition.
    refresh();
    // YouTube appends the native close control asynchronously. Dismiss it in the mutation turn.
    new MutationObserver(mutations => {
      if (!document.documentElement.hasAttribute("data-vvoo-adblock")) return;
      if (mutations.some(m => m.type === "attributes" && m.target.matches("ytd-reel-video-renderer"))) skipShortsAd();
      for (const m of mutations) {
        if (m.type !== "childList") continue;
        if ((m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest("ytd-enforcement-message-view-model") ||
            [...m.addedNodes].some(n => n.nodeType === 1 && (n.matches("ytd-enforcement-message-view-model") ||
              n.querySelector("ytd-enforcement-message-view-model")))) {
          dismissAdNotice();
          break;
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true,
      attributes: true, attributeFilter: ["is-ads-overlay", "is-ad"] });
    let timer = setInterval(refresh, 400);
    document.addEventListener("playing", refresh, true);
    window.addEventListener("pagehide", () => {
      clearInterval(timer);
      for (const [video, previous] of previousPlayback) restoreVideo(video, previous);
    });
    window.addEventListener("pageshow", event => {
      if (event.persisted) {
        refresh();
        timer = setInterval(refresh, 400);
      }
    });
  });
})();
