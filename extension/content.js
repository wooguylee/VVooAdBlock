chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === "page-url") respond(location.origin);
});

// Embedded players follow the exception for the page containing the player.
const ancestors = location.ancestorOrigins;
const vvooBlockingReady = chrome.runtime.sendMessage({
  type: "page-state",
  topOrigin: ancestors.length ? ancestors[ancestors.length - 1] : undefined
}).then(async state => {
  const enabled = state?.enabled === true;
  if (!document.documentElement) await new Promise(resolve => {
    const observer = new MutationObserver(() => {
      if (document.documentElement) { observer.disconnect(); resolve(); }
    });
    observer.observe(document, { childList: true });
  });
  document.documentElement.toggleAttribute("data-vvoo-adblock", enabled);
  return enabled;
}).catch(() => false);
