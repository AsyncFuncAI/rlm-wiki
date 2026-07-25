#!/usr/bin/env bun
import { runCli } from "../src/cli.ts";

const code = await runCli();
process.exit(code);
