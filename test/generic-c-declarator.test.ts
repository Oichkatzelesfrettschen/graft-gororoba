/**
 * C function scopes behind pointer and parenthesized declarators
 * (`defScope` in `src/graph/generic.ts`).
 *
 * The C grammar tags the `function_declarator`, and a pointer return type or a
 * function-pointer return wraps that declarator in `pointer_declarator` /
 * `parenthesized_declarator` nodes. Climbing only through `DEF_CONTAINER` stops
 * at the wrapper, so the symbol's span, body text and call attribution cover the
 * declarator alone. The scope follows the declarator spine to its definition or
 * declaration instead, and a parameter declaration ends the spine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { warmGenericGrammars, extractGeneric, isWarm } from "../src/graph/generic.js";
import { resolveEdges } from "../src/graph/resolve.js";

const definitions = [
  ["pointer", "char *\npointer(void)\n{\n    helper();\n    return 0;\n}"],
  ["double_pointer", "char **\ndouble_pointer(void)\n{\n    helper();\n    return 0;\n}"],
  ["factory", "int (*\nfactory(void))(int)\n{\n    helper();\n    return 0;\n}"],
  ["callback_host", "void\ncallback_host(int callback(void))\n{\n    helper();\n}"],
] as const;

for (const [name, definition] of definitions) {
  test(`C ${name} owns its complete definition and body calls`, async () => {
    await warmGenericGrammars(["c"]);
    assert.equal(isWarm("c"), true);
    const source = `void helper(void) {}\n${definition}\n`;
    const { nodes, rawEdges } = extractGeneric("scope.c", source, "c");
    const symbol = nodes.find((node) => node.name === name);
    assert.ok(symbol);
    assert.equal(symbol.span, `L2-L${definition.split("\n").length + 1}`);
    assert.equal(symbol.body_text, definition.replace(/\s+/g, " "));
    assert.equal(symbol.signature, definition.split("\n")[0]);
    const calls = resolveEdges(nodes, rawEdges).filter((edge) => edge.relation === "calls");
    assert.deepEqual(calls.map((edge) => [edge.source, edge.target]), [[`scope.c#${name}`, "scope.c#helper"]]);
    if (name === "callback_host") {
      const parameter = nodes.find((node) => node.name === "callback");
      assert.ok(parameter);
      assert.equal(parameter.body_text?.includes("helper();"), false);
    }
  });
}

test("C pointer prototypes remain declarations with their own spans", async () => {
  await warmGenericGrammars(["c"]);
  const { nodes, rawEdges } = extractGeneric("declarations.h", "char *prototype(void);\nint (*factory_prototype(void))(int);\n", "c");
  assert.deepEqual(nodes.filter((node) => node.kind === "function").map((node) => [node.name, node.span, node.body_text]), [
    ["prototype", "L1-L1", "char *prototype(void);"],
    ["factory_prototype", "L2-L2", "int (*factory_prototype(void))(int);"],
  ]);
  assert.equal(rawEdges.filter((edge) => edge.relation === "calls").length, 0);
});
