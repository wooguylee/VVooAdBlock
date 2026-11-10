// Each explicit selection has its own storage key so independent edits never overwrite each other.
const shortKeyPrefix = "blockedShort:";
function shortIdFromUrl(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) ||
        !["www.youtube.com", "youtube.com", "m.youtube.com"].includes(url.hostname)) return null;
    return /^\/shorts\/([\w-]{11})\/?$/.exec(url.pathname)?.[1] || null;
  } catch {
    return null;
  }
}
