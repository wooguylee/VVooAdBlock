import { readFile, writeFile } from "node:fs/promises";

// Pin the upstream revision so the shipped rules can be reproduced.
const revision = "f39ba0a523564447dfa94e40327c1a14c02304dc";
const response = await fetch("https://raw.githubusercontent.com/AdAway/adaway.github.io/" + revision + "/hosts.txt");
if (!response.ok) throw new Error("AdAway download failed: " + response.status);

const hosts = new Set();
for (const line of (await response.text()).split(/\r?\n/)) {
  const [address, host] = line.split("#")[0].trim().toLowerCase().split(/\s+/);
  if (address !== "127.0.0.1" || host === "localhost") continue;
  if (!/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/.test(host)) throw new Error("Invalid host: " + host);
  hosts.add(host);
}
const customRules = JSON.parse(await readFile(new URL("../extension/rules/advertising.json", import.meta.url), "utf8"));
if (!hosts.size || hosts.size * 2 + customRules.length > 30000) throw new Error("Unexpected rule count");

const rules = [];
for (const host of [...hosts].sort()) {
  for (const scheme of ["http", "https"]) {
    rules.push(JSON.stringify({
      id: rules.length + 1, action: { type: "block" },
      condition: {
        urlFilter: "|" + scheme + "://" + host + "^",
        domainType: "thirdParty",
        excludedResourceTypes: ["main_frame"]
      }
    }));
  }
}
await writeFile(new URL("../extension/rules/adaway.json", import.meta.url), "[\n" + rules.join(",\n") + "\n]\n");
console.log(hosts.size + " hosts, " + rules.length + " rules");
