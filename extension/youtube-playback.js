// Runs in the player world. Filter ads and inactivity interruptions before playback consumes them.
function vvooInstallPlaybackFilter(isEnabled) {
  const playerFields = ["adPlacements", "playerAds", "adSlots", "adBreakHeartbeatParams"];
  const apiPath = /^\/youtubei\/v1\/(?:player|next|get_watch|playlist|reel\/reel_watch_sequence|reel_watch_sequence|navigation\/resolve_url)\/?$/;
  const guardedPlayers = new WeakSet();
  const nativeThen = Promise.prototype.then;
  const functionSource = Function.prototype.toString;

  function hasMedia(player) {
    const streams = player.streamingData;
    return !!(streams?.formats?.length || streams?.adaptiveFormats?.length || streams?.serverAbrStreamingUrl);
  }

  function guardPlayer(player) {
    if (!player || typeof player !== "object" || guardedPlayers.has(player)) return;
    const renderers = player.auxiliaryUi?.messageRenderers;
    const enforcement = renderers?.bkaEnforcementMessageViewModel || renderers?.enforcementMessageViewModel;
    if (!enforcement || player.playabilityStatus?.status !== "OK" || !player.videoDetails?.videoId || !hasMedia(player)) return;
    const statusDescriptor = Object.getOwnPropertyDescriptor(player, "playabilityStatus");
    const detailsDescriptor = Object.getOwnPropertyDescriptor(player, "videoDetails");
    if (![statusDescriptor, detailsDescriptor].every(d => d?.configurable && d.writable && Object.hasOwn(d, "value"))) return;
    let status = statusDescriptor.value;
    let details = detailsDescriptor.value;
    let keepDetails = false;
    // YouTube validates signed renderer values before enforcing a block. Preserve
    // those values; only reject the later client-side replacement of playable data.
    Object.defineProperties(player, {
      playabilityStatus: { configurable: true, enumerable: statusDescriptor.enumerable,
        get() { return status; },
        set(next) {
          keepDetails = false;
          const error = next?.errorScreen?.enforcementMessageViewModel || next?.errorScreen?.bkaEnforcementMessageViewModel;
          if (isEnabled() && status?.status === "OK" && details?.videoId && hasMedia(player) &&
              next?.status === "ERROR" && error === enforcement &&
              enforcement.displayType === "ENFORCEMENT_MESSAGE_VIEW_MODEL_DISPLAY_TYPE_PLAYER") {
            keepDetails = true;
            return;
          }
          status = next;
        } },
      videoDetails: { configurable: true, enumerable: detailsDescriptor.enumerable,
        get() { return details; },
        set(next) {
          if (!(keepDetails && next === undefined && isEnabled())) details = next;
          keepDetails = false;
        } }
    });
    guardedPlayers.add(player);
  }

  function guardResponses(data) {
    if (!isEnabled() || !data || typeof data !== "object") return data;
    if (Array.isArray(data)) {
      for (const item of data) guardResponses(item);
    } else {
      guardPlayer(data);
      guardPlayer(data.playerResponse);
      guardPlayer(data.endpoint?.watchEndpoint?.unserializedPrefetchData?.playerResponse);
    }
    return data;
  }

  // Body streams and Response.json() create new objects after fetch filtering.
  // Guard the parsed object, without rewriting signed enforcement metadata.
  JSON.parse = new Proxy(JSON.parse, { apply(target, receiver, args) {
    return guardResponses(Reflect.apply(target, receiver, args));
  } });
  Response.prototype.json = new Proxy(Response.prototype.json, { apply(target, receiver, args) {
    return Reflect.apply(nativeThen, Reflect.apply(target, receiver, args), [guardResponses]);
  } });

  // The native player-ready continuation registers a stopVideo/pauseVideo handler.
  // Run all its other work, suppressing only this anti-adblock listener registration.
  Promise.prototype.then = new Proxy(nativeThen, { apply(target, receiver, args) {
    const callback = args[0];
    if (typeof callback === "function" && /\.addEventListener\(\s*["']onAbnormalityDetected["']/.test(Reflect.apply(functionSource, callback, []))) {
      args[0] = function (...values) {
        const player = values[0];
        if (!isEnabled() || typeof player?.getPlayerResponse !== "function" || typeof player?.addEventListener !== "function") {
          return Reflect.apply(callback, this, values);
        }
        const descriptor = Object.getOwnPropertyDescriptor(player, "addEventListener");
        const addListener = player.addEventListener;
        const installed = Reflect.defineProperty(player, "addEventListener", { configurable: true, writable: true,
          value: function (name, ...rest) {
            if (name === "onAbnormalityDetected") return;
            return Reflect.apply(addListener, this, [name, ...rest]);
          } });
        try { return Reflect.apply(callback, this, values); }
        finally {
          if (installed) {
            if (descriptor) Object.defineProperty(player, "addEventListener", descriptor);
            else Reflect.deleteProperty(player, "addEventListener");
          }
        }
      };
    }
    return Reflect.apply(target, receiver, args);
  } });
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
      guardPlayer(player);
      for (const field of playerFields) {
        if (Object.hasOwn(player, field) && Reflect.deleteProperty(player, field)) changed = true;
      }
      // The watch page schedules both the confirmation dialog and PAUSE_PLAYER from
      // youThereRenderer. Removing only this message prevents the timer from starting;
      // hiding the dialog alone would leave the video paused. Keep all other notices.
      if (Array.isArray(player.messages)) {
        const messages = player.messages.filter(message => !message?.youThereRenderer);
        if (messages.length !== player.messages.length) {
          player.messages = messages;
          changed = true;
        }
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
    if (!/"(?:adPlacements|playerAds|adSlots|adBreakHeartbeatParams|adClientParams|youThereRenderer)"/.test(raw)) return raw;
    const prefix = raw.match(/^\)\]\}'[^\n]*\n/)?.[0] || "";
    try {
      const parsed = JSON.parse(raw.slice(prefix.length));
      return clean(parsed) ? prefix + JSON.stringify(parsed) : raw;
    } catch {
      return raw;
    }
  }

  // Inline HTML assigns these globals before starting the player on a direct navigation.
  for (const key of ["ytInitialPlayerResponse", "ytInitialData", "ytInitialReelWatchSequenceResponse"]) {
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
