#!/usr/bin/env bun
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

// All browser bundles and declarations are generated here. Clean them so removed
// prototype profiles cannot survive as stale package or development-server files.
await rm(resolve(import.meta.dir, "../dist"), { recursive: true, force: true });
