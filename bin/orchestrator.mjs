#!/usr/bin/env node
import { main } from "../src/main.ts";
import { runCli } from "../src/cli-entry.ts";

process.exitCode = await runCli(() => main());
