// Runs in the player world. Only advertising instructions in playback/Shorts data are filtered.
function vvooInstallPlaybackFilter(isEnabled) {
  const playerFields = ["adPlacements", "playerAds", "adSlots", "adBreakHeartbeatParams"];
  const apiPath = /^\/youtubei\/v1\/(?:player|next|get_watch|playlist|reel\/reel_watch_sequence|reel_watch_sequence|navigation\/resolve_url)\/?$/;
  function playbackUrl(value) {
    if (!value) return false;
    const url = new URL(value, location.href);
    return (url.origin === location.origin || url.hostname === "youtubei.googleapis.com") && apiPath.test(url.pathname);
  }

  function clean(data) {
    if (!data || typeof data !== "object") return false;
    if (Array.isArray(data)) {
      let changed = false;
      for (const item of data) if (clean(item)) changed = true;
      return changed;
    }
    let changed = false;
    const prefetch = data.endpoint?.watchEndpoint?.unserializedPrefetchData;
    for (const player of [data, data.playerResponse, prefetch?.playerResponse]) {
      if (!player || typeof player !== "object") continue;
      for (const field of playerFields) {
        if (Object.hasOwn(player, field) && Reflect.deleteProperty(player, field)) changed = true;
      }
    }
    for (const sequence of [data, data.reelWatchSequenceResponse]) {
      if (!Array.isArray(sequence?.entries)) continue;
      const items = sequence.entries.filter(entry => {
        const reel = entry?.command?.reelWatchEndpoint;
        if (reel?.adClientParams?.isAd !== true) return true;
        if (document.documentElement?.hasAttribute("data-vvoo-shorts-debug")) {
          document.dispatchEvent(new CustomEvent("vvoo-feed-ad", { detail: reel.videoId || "" }));
        }
        return false;
      });
      if (items.length !== sequence.entries.length) {
        sequence.entries = items;
        changed = true;
      }
    }
    return changed;
  }

  function cleanText(raw) {
    if (!/"(?:adPlacements|playerAds|adSlots|adBreakHeartbeatParams|adClientParams)"/.test(raw)) return raw;
    const prefix = raw.match(/^\)\]\}'[^\n]*\n/)?.[0] || "";
    try {
      const parsed = JSON.parse(raw.slice(prefix.length));
      return clean(parsed) ? prefix + JSON.stringify(parsed) : raw;
    } catch {
      return raw;
    }
  }

  // Inline HTML assigns these globals before starting the player on a direct navigation.
  for (const key of ["ytInitialPlayerResponse", "ytInitialData"]) {
    const original = Object.getOwnPropertyDescriptor(window, key);
    if (original && (!original.configurable || original.get || original.set)) continue;
    let value = window[key];
    Object.defineProperty(window, key, {
      configurable: true, enumerable: true,
      get() { if (isEnabled()) clean(value); return value; },
      set(next) { value = next; if (isEnabled()) clean(value); }
    });
  }

  function preserveMetadata(response, original) {
    Object.defineProperties(response, {
      url: { value: original.url }, redirected: { value: original.redirected }, type: { value: original.type },
      clone: { value() { return preserveMetadata(Response.prototype.clone.call(this), original); } }
    });
    return response;
  }
  // Some player clients consume the body stream instead of calling response.json().
  const fetchResponse = window.fetch;
  window.fetch = async function (...args) {
    const response = await fetchResponse.apply(this, args);
    if (!isEnabled() || !response.ok || !playbackUrl(response.url) ||
        !/json|text\/plain/i.test(response.headers.get("content-type") || "")) return response;
    let raw;
    try { raw = await response.clone().text(); }
    catch { return response; }
    const value = cleanText(raw);
    if (value === raw) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return preserveMetadata(new Response(value, { status: response.status, statusText: response.statusText, headers }), response);
  };

  // XHR clients read the same response repeatedly or consume it as a parsed JSON object.
  const textCache = new WeakMap();
  for (const key of ["response", "responseText"]) {
    const descriptor = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, key);
    if (!descriptor?.get || !descriptor.configurable) continue;
    Object.defineProperty(XMLHttpRequest.prototype, key, { ...descriptor, get() {
      const raw = descriptor.get.call(this);
      if (this.readyState !== 4 || !isEnabled() || !playbackUrl(this.responseURL)) return raw;
      if (typeof raw === "string") {
        const cached = textCache.get(this);
        if (cached?.raw === raw) return cached.value;
        const value = cleanText(raw);
        textCache.set(this, { raw, value });
        return value;
      }
      if (this.responseType === "json") clean(raw);
      return raw;
    } });
  }
}
