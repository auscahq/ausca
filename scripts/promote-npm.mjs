import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

// Promotion changes tags only. Versions and package bytes have already been
// published and independently verified; the caller supplies their commitments.
const checkOnly = process.argv.slice(2).join(" ") === "--check";
assert(process.argv.length === 2 || checkOnly, "Only --check is supported.");
const plan = JSON.parse(process.env.NPM_PROMOTION_PLAN ?? "null");
const directories = ["sdk", "ausca", "ai-sdk", "langchain-ausca"];
assert(Array.isArray(plan) && plan.length === directories.length, "Supply every public npm package.");
const candidates = new Map();
for (const entry of plan) {
  assert(entry && Object.keys(entry).sort().join() === "integrity,name,version", "Each commitment has name, version and integrity only.");
  assert(typeof entry.name === "string" && typeof entry.version === "string" && typeof entry.integrity === "string", "Commitments must be strings.");
  assert(!candidates.has(entry.name), "Duplicate package.");
  candidates.set(entry.name, entry);
}

async function readRegistry(path) {
  const response = await fetch(`https://registry.npmjs.org/${path}`, {
    signal: AbortSignal.timeout(20_000),
    headers: { "cache-control": "no-cache" },
  });
  assert(response.ok, `Registry read failed: HTTP ${response.status}.`);
  return await response.json();
}

async function verifyLatest(entry) {
  // A successful tag write can reach npm's read replicas later. Retry reads
  // only; repeating the write would obscure an ambiguous provider outcome.
  const deadline = Date.now() + 120_000;
  let delay = 1_000;
  for (;;) {
    const tags = await readRegistry(`-/package/${encodeURIComponent(entry.name)}/dist-tags`);
    if (tags.latest === entry.version) return;
    assert(Date.now() < deadline, `Latest tag for ${entry.name} remained ${tags.latest}; expected ${entry.version}.`);
    await setTimeout(Math.min(delay, deadline - Date.now()));
    delay = Math.min(delay * 2, 10_000);
  }
}

// Admit the entire set before the first tag write. The SDK goes first because
// the front door consumes it. No version is repeated in this release script.
const admitted = [];
for (const directory of directories) {
  const manifest = JSON.parse(await readFile(new URL(`../packages/${directory}/package.json`, import.meta.url), "utf8"));
  const expected = candidates.get(manifest.name);
  assert(expected && !manifest.private && expected.version === manifest.version, "Promotion must match the checked-out package manifests.");
  const version = await readRegistry(`${encodeURIComponent(expected.name)}/${encodeURIComponent(expected.version)}`);
  assert.equal(version.name, expected.name);
  assert.equal(version.version, expected.version);
  assert.equal(version.dist?.integrity, expected.integrity, "Published bytes differ from the verified commitment.");
  const tags = await readRegistry(`-/package/${encodeURIComponent(expected.name)}/dist-tags`);
  admitted.push({ ...expected, previous_latest: tags.latest });
}

if (!checkOnly) {
  const [major, minor] = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim().split(".").map(Number);
  assert(major > 12 || major === 12 && minor >= 2 || major === 11 && minor >= 21, "npm must support OIDC dist-tag authentication.");
  for (const entry of admitted) {
    if (entry.previous_latest !== entry.version) {
      execFileSync("npm", ["dist-tag", "add", `${entry.name}@${entry.version}`, "latest", "--registry=https://registry.npmjs.org"], { stdio: "inherit" });
    }
    await verifyLatest(entry);
  }
}
console.log(JSON.stringify({ status: checkOnly ? "ready" : "verified", packages: admitted }));
