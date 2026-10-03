/**
 * Which crux records fill a requested target (`collectFileCrux` in
 * `src/graph/enrich.ts`).
 *
 * A record counts only when its summary is nonblank and its id names a requested
 * target -- either the id itself or the whole target line the prompt listed,
 * echoed back with every field intact. A blank record keeps its target in the
 * bounded retry set, so the second attempt can still fill it; a bare symbol, an
 * invented suffix, or a different kind or span leaves the target pending.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichGraph } from "../src/graph/enrich.js";
import type { FileCruxInput, NodeCrux } from "../src/ai/crux.js";
import type { NodeV1 } from "../src/graph/types.js";

async function collect(reply: (input: FileCruxInput, attempt: number) => NodeCrux[], signature: string | null = null) {
  const nodes: NodeV1[] = [{
    id: "fixture.c#run", name: "run", kind: "function", path: "fixture.c",
    span: "L1-L3", signature, exported: true, origin: "generic", body_hash: "fixture",
    summary_state: "pending", summary: null, crux: null,
  }];
  const requested: string[][] = [];
  const stats = await enrichGraph(nodes, new Map(), new Map([["fixture.c", "void run(void) {\n helper();\n}\n"]]), {
    concurrency: 1,
    summarizer: {
      async describeFile(input) {
        requested.push(input.nodes.map((node) => node.id));
        return reply(input, requested.length);
      },
    },
  });
  return { nodes, requested, stats };
}

const record = (id: string, summary = "Runs the helper."): NodeCrux => ({ id, summary, crux_start: 2, crux_end: 2 });

test("a blank summary keeps its target in the retry set", async () => {
  const result = await collect((input, attempt) => [record(input.nodes[0].id, attempt === 1 ? "  " : "Runs the helper.")]);
  assert.equal(result.stats.computed, 1);
  assert.deepEqual(result.requested, [["fixture.c#run"], ["fixture.c#run"]]);
  assert.equal(result.nodes[0].crux?.code, " helper();");
});

test("malformed and blank duplicates cannot displace a usable record", async () => {
  const result = await collect((input) => [null as unknown as NodeCrux, record(input.nodes[0].id, ""), record(input.nodes[0].id)]);
  assert.equal(result.stats.computed, 1);
  assert.equal(result.requested.length, 1);
});

test("blank records on every attempt report blank summaries, not an empty reply", async () => {
  const result = await collect((input) => [record(input.nodes[0].id, " ")]);
  assert.equal(result.stats.computed, 0);
  assert.equal(result.requested.length, 2);
  assert.equal(result.stats.failedFiles, 1);
  assert.match(result.stats.errors[0] ?? "", /empty-parsed/);
  assert.equal(result.nodes[0].summary_state, "pending");
});

for (const signature of [null, "void run(void)"]) {
  test(`an exact echoed target line resolves with signature ${signature}`, async () => {
    const result = await collect(() => [record("fixture.c#run | function | lines L1-L3" + (signature ? ` | ${signature}` : ""))], signature);
    assert.equal(result.stats.computed, 1);
    assert.equal(result.requested.length, 1);
    assert.equal(result.nodes[0].summary, "Runs the helper.");
  });
}

test("an exact echoed kind and span resolves when the echo omits the signature", async () => {
  const result = await collect(() => [record("fixture.c#run | function | lines L1-L3")], "void run(void)");
  assert.equal(result.stats.computed, 1);
  assert.equal(result.requested.length, 1);
});

for (const id of [
  "run",
  "fixture.c#invented",
  "fixture.c#run | invented",
  "fixture.c#run | function | lines L1-L4",
  "fixture.c#run | class | lines L1-L3",
  "fixture.c#run | function | lines L1-L3 | invented",
]) {
  test(`an unrequested identity leaves the target pending: ${id}`, async () => {
    const result = await collect(() => [record(id)]);
    assert.equal(result.stats.computed, 0);
    assert.equal(result.requested.length, 2);
    assert.equal(result.nodes[0].summary_state, "pending");
  });
}
