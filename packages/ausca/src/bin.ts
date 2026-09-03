#!/usr/bin/env node
import process from "node:process";

import { processEnvironment, runCli } from "./cli.js";

runCli(process.argv.slice(2), processEnvironment()).then(
  (code) => {
    // The MCP verb never resolves; every other verb exits deliberately.
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
