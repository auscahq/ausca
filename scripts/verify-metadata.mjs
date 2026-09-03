import { readFile } from "node:fs/promises";

const readJSON = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const fail = (message) => {
  throw new Error(`distribution metadata: ${message}`);
};

const [server, frontDoor, sdk, lockfile, context7, glama] = await Promise.all([
  readJSON("../server.json"),
  readJSON("../packages/ausca/package.json"),
  readJSON("../packages/sdk/package.json"),
  readJSON("../package-lock.json"),
  readJSON("../context7.json"),
  readJSON("../glama.json"),
]);

if (server.name !== frontDoor.mcpName || server.websiteUrl !== "https://ausca.com") {
  fail("MCP identity differs from the npm package or public origin");
}
if (server.repository?.url !== "https://github.com/auscahq/ausca-integrations") {
  fail("MCP repository is not the public integration repository");
}
if (server.remotes?.length !== 1 || server.remotes[0]?.type !== "streamable-http" ||
    server.remotes[0]?.url !== "https://ausca.com/mcp") {
  fail("MCP remote transport is incomplete");
}
const npmPackage = server.packages?.find((entry) => entry.registryType === "npm");
if (!npmPackage || npmPackage.identifier !== frontDoor.name || npmPackage.version !== frontDoor.version ||
    npmPackage.runtimeHint !== "npx" || npmPackage.transport?.type !== "stdio" ||
    npmPackage.packageArguments?.length !== 1 || npmPackage.packageArguments[0]?.value !== "mcp") {
  fail("MCP npm transport differs from the front-door package");
}
if (frontDoor.dependencies?.["@ausca/sdk"] !== `^${sdk.version}`) {
  fail("front-door dependency does not select the released SDK version");
}
if (lockfile.packages?.["packages/ausca"]?.version !== frontDoor.version ||
    lockfile.packages?.["packages/sdk"]?.version !== sdk.version) {
  fail("package-lock versions differ from package manifests");
}
if (context7.$schema !== "https://context7.com/schema/context7.json" ||
    !context7.folders?.includes("packages") || !context7.folders?.includes("python")) {
  fail("Context7 parsing metadata is incomplete");
}
if (glama.$schema !== "https://glama.ai/mcp/schemas/server.json" ||
    glama.maintainers?.length !== 1 || glama.maintainers[0] !== "auscaster") {
  fail("Glama ownership metadata is incomplete");
}

process.stdout.write("distribution metadata verified\n");
