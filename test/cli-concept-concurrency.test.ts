/**
 * `graft build --deep -j <n>` bounds the concept pass's per-file summary calls,
 * not only the wiring graph's (`src/cli.ts`, `src/engine.ts`,
 * `src/graph/workspace-cli.ts`).
 *
 * The concept pass summarizes up to 8 files at once by default, so a `-j` that
 * stops at the graph pass leaves the first phase of every `--deep` build at that
 * default -- the phase a rate-limited or single-slot endpoint sees first. Both
 * entry points are pinned: the single-repo CLI path against a local stand-in
 * gateway, and the workspace path that builds each child through its own engine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runWorkspaceBuild } from "../src/graph/workspace-cli.js";
import type { Summarizer } from "../src/index.js";
import { BracketSynthesizer, tmpRepo } from "./helpers.js";

const FILES = 4;

function writeModules(dir: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  for (let i = 0; i < FILES; i++) {
    writeFileSync(join(dir, "src", `module${i}.ts`), `export function module${i}(): number {\n  return ${i};\n}\n`);
  }
}

test("the CLI applies -j 1 to the concept pass's summary calls", async () => {
  const dir = tmpRepo("concept-j");
  writeModules(dir);
  let calls = 0;
  let active = 0;
  let peak = 0;
  // Every call holds its slot long enough for an unbounded pass to overlap, then
  // answers the way an exhausted quota does, so the build stops after phase 1.
  const gateway = createServer((_req, res) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active--;
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Request exceeds your current quota", type: "insufficient_quota" } }));
    }, 150);
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  try {
    const addr = gateway.address();
    assert.ok(addr && typeof addr !== "string");
    // Spawned asynchronously: the gateway runs on this process's event loop.
    const child = spawn(
      process.execPath,
      [
        "--import", "tsx", "src/cli.ts",
        "--provider", "openai",
        "--api-key", "test-key",
        "--base-url", `http://127.0.0.1:${addr.port}/v1`,
        "--model", "test-model",
        "build", dir, "--deep", "-j", "1",
      ],
      { env: { ...process.env, GRAFT_LLM_RETRIES: "0", DO_NOT_TRACK: "1" } },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.stdout.resume();
    const status = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(status, 1, stderr);
    assert.ok(calls >= 1, "the concept pass made no model call");
    assert.equal(peak, 1, `-j 1 let ${peak} concept summary calls run at once`);
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Records the high-water mark of summary calls in flight. */
class PeakSummarizer implements Summarizer {
  active = 0;
  peak = 0;
  calls = 0;

  async summarize(code: string): Promise<string> {
    this.calls++;
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return code;
    } finally {
      this.active--;
    }
  }
}

test("a workspace build applies its concurrency to every child's concept pass", async () => {
  const parent = tmpRepo("concept-j-workspace");
  for (const name of ["repoA", "repoB"]) {
    mkdirSync(join(parent, name, ".git"), { recursive: true });
    writeModules(join(parent, name));
  }
  const summarizer = new PeakSummarizer();
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await runWorkspaceBuild(parent, {
      deep: true,
      concurrency: 1,
      childConfig: {
        summarizer,
        synthesizer: new BracketSynthesizer(),
        cruxSummarizer: { async describeFile() { return []; } },
      },
    });
  } finally {
    console.log = log;
    console.error = error;
    rmSync(parent, { recursive: true, force: true });
  }
  assert.equal(summarizer.calls, 2 * FILES);
  assert.equal(summarizer.peak, 1, `concurrency 1 let ${summarizer.peak} concept summary calls run at once`);
});
