import { mkdir, readFile, writeFile } from "node:fs/promises";

// Mirrors the canonical service skills from ausca.com into skills/ so skill
// directories and plugin crawlers that key on a public repository can index
// them. The live site stays the single authority: `--verify` fails when the
// mirror drifts, and the sync rewrites it from the origin.

const ORIGIN = "https://ausca.com";
const SKILLS = [
  "document-ocr",
  "document-analysis",
  "media-transcription",
  "browser-session",
  "agent-inbox",
];

const verify = process.argv.includes("--verify");
let drifted = false;

for (const name of SKILLS) {
  const response = await fetch(`${ORIGIN}/skills/${name}/SKILL.md`);
  if (!response.ok) {
    throw new Error(`${name}: origin answered ${response.status}`);
  }
  const live = await response.text();
  const path = new URL(`../skills/${name}/SKILL.md`, import.meta.url);
  if (verify) {
    const mirrored = await readFile(path, "utf8").catch(() => null);
    if (mirrored !== live) {
      drifted = true;
      console.error(`${name}: mirror differs from ${ORIGIN}/skills/${name}/SKILL.md`);
    }
    continue;
  }
  await mkdir(new URL(`../skills/${name}/`, import.meta.url), { recursive: true });
  await writeFile(path, live);
  console.log(`${name}: synced`);
}

if (drifted) {
  process.exit(1);
}
if (verify) {
  console.log("skill mirror matches the live origin");
}
