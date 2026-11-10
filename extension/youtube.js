(() => {
  const adPlayer = ".html5-video-player:is(.ad-showing, .ad-interrupting)";
  const skipButtons = "button.ytp-skip-ad-button, button.ytp-ad-skip-button-modern, button.ytp-ad-skip-button";
  const previousPlayback = new Map();
  const lastClick = new WeakMap();
  let lastSkippedReel = null;

  function clickable(button) {
    return button && !button.disabled && button.getAttribute("aria-disabled") !== "true" &&
      button.getClientRects().length > 0 && getComputedStyle(button).visibility === "visible";
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
    if (!location.pathname.startsWith("/shorts/") || document.hidden) return;
    const shorts = document.querySelector("ytd-shorts:not([hidden])");
    if (!shorts) return;
    const reel = [...shorts.querySelectorAll("ytd-reel-video-renderer")].find(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.top <= innerHeight / 2 && rect.bottom > innerHeight / 2;
    });
    if (!reel || !(reel.matches('[is-ad]:not([is-ad="false"])') ||
        reel.querySelector(":scope > ytd-ad-slot-renderer, :scope > #short-video-container > ytd-ad-slot-renderer"))) {
      lastSkippedReel = null;
      return;
    }
    const next = shorts.querySelector("#navigation-button-down button");
    if (lastSkippedReel !== reel && clickable(next)) {
      lastSkippedReel = reel;
      next.click();
    }
  }

  function refresh() {
    handlePlayerAds();
    skipShortsAd();
  }

  vvooBlockingReady.then(enabled => {
    if (!enabled) return;
    // The player and its buttons are reused across ad breaks and SPA navigation.
    // Polling also catches buttons becoming visible through a CSS transition.
    refresh();
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
