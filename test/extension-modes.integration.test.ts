import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage, getToolCallNames, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { IDE_EXTENSION, PI_COMMAND } from "./fixtures/pi-agent-ide.ts";

const root = path.resolve(import.meta.dirname, "..");
const computerUse = path.join(root, "src/index.ts");
const ide = IDE_EXTENSION;

async function run(name: string, extensions: string[], tools: string[], calls: { id: string; name: string; arguments: Record<string, unknown> }[]) {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/extension-modes-"));
  try {
    return await new PiIntegrationTest({
      testName: name, artifactsDir: testArtifactsDir(import.meta.filename), cwd, isolateUserResources: true,
      piCommand: PI_COMMAND, extensions, tools, timeoutMs: 90_000,
      conversation: [
        ...calls.map(call => assistantMessage([toolCall({ ...call, delayMs: 0 })], { stopReason: "toolUse" })),
        assistantMessage([text("Done.")]),
      ],
    }).run("Use computer use only through the session address; operate no desktop window.");
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

test("without Pi Agent IDE, tool_search finds the deferred computer tools and they work", async () => {
  const result = await run("standalone", ["builtin:tool-search", computerUse], ["read"], [
    { id: "find", name: "tool_search", arguments: { query: "computer read windows displays" } },
    // The input queries run while most typed tools are still unloaded, so they must win against all of them.
    { id: "input", name: "tool_search", arguments: { query: "computer click hover drag scroll" } },
    { id: "keys", name: "tool_search", arguments: { query: "computer type press select timeline" } },
    { id: "guide", name: "computer_read", arguments: { path: "docs:computer" } },
    { id: "session", name: "computer_read", arguments: { path: "computer:session" } },
    { id: "close", name: "computer_delete", arguments: { path: "computer:session" } },
    { id: "open", name: "tool_search", arguments: { query: "computer open window" } },
    { id: "more", name: "tool_search", arguments: { query: "computer wait" } },
    { id: "display", name: "computer_display", arguments: { display: "computer:display/primary", width: 1920, height: 1080 } },
    { id: "files", name: "tool_search", arguments: { query: "computer files clipboard record" } },
    { id: "view", name: "tool_search", arguments: { query: "computer view viewport" } },
    { id: "list", name: "computer_files", arguments: { machine: "computer:session", action: "list" } },
    { id: "sequence", name: "computer_record", arguments: { at: "computer:machine/local/display/primary", action: "sequence" } },
    { id: "click", name: "computer_click", arguments: { window: "computer:machine/local", target: "1:a" } },
    { id: "delete", name: "computer_delete", arguments: { path: "computer:session" } },
  ]);
  expect(getToolCallNames(result)).toEqual(["tool_search", "tool_search", "tool_search", "computer_read", "computer_read", "computer_delete", "tool_search", "tool_search", "computer_display", "tool_search", "tool_search", "computer_files", "computer_record", "computer_click", "computer_delete"]);
  for (const tool of ["computer_click", "computer_hover", "computer_drag", "computer_scroll", "computer_type", "computer_press", "computer_select", "computer_timeline"])
    expect(["find", "input", "keys"].map(id => getToolResultText(result, id)).join("\n")).toContain(`- ${tool}:`);
  for (const id of ["find", "guide", "session", "close", "delete"])
    expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
  expect(getToolResultText(result, "find")).toContain("computer_read");
  // tool_search loads the best matches of each query, at most 8 by default, so the guide names one query per cluster.
  // A query lists only tools it newly loads; together the guide's cluster queries load every computer tool.
  const loaded = ["find", "open", "more", "files", "view", "input", "keys"].map(id => getToolResultText(result, id)).join("\n");
  for (const tool of ["computer_search", "computer_delete", "computer_open", "computer_window", "computer_view", "computer_display",
    "computer_wait", "computer_files", "computer_clipboard", "computer_record", "computer_click", "computer_hover", "computer_drag",
    "computer_scroll", "computer_type", "computer_press", "computer_select", "computer_timeline"]) expect(loaded).toContain(`- ${tool}:`);
  // Input goes to a window address and refuses anything else before native work.
  expect(getToolExecution(result, "click").isError).toBe(true);
  expect(getToolResultText(result, "click")).toContain("Give the window address");
  // Files, clipboard and recording run on a machine address, and a sequence needs its length; both refuse before native work.
  expect(getToolResultText(result, "list")).toContain("Give a machine address");
  expect(getToolResultText(result, "sequence")).toContain("sequence needs duration_ms.");
  for (const id of ["list", "sequence"]) expect(getToolExecution(result, id).isError).toBe(true);
  // A typed tool refuses a bad address with a receipt before any native work.
  expect(getToolExecution(result, "display").isError).toBe(true);
  expect(getToolResultText(result, "display")).not.toContain("unknown");
  expect(getToolResultText(result, "display")).toContain("Display addresses name their machine");
  expect(getToolResultText(result, "delete")).toContain("Computer closed");
  expect(getToolResultText(result, "guide")).toMatch(/^# Computer use\n/);
  // The guide names the standalone tools, never a placeholder.
  expect(getToolResultText(result, "guide")).toContain("computer_read");
  expect(getToolResultText(result, "guide")).not.toMatch(/\{(read|search|delete)\}/);
  expect(getToolResultText(result, "session")).toContain("computer:machine/local");
  // The guide was read already, so the first computer address does not bring it again.
  expect(getToolResultText(result, "session")).not.toContain("# Guide: computer");
  expect(getToolResultText(result, "close")).toContain("Computer closed");
}, 120_000);

test("an IDE that refuses this plugin API version leaves computer use standalone", async () => {
  const result = await run("incompatible-ide", ["builtin:tool-search", path.join(root, "test/fixtures/incompatible-ide-extension.ts"), computerUse], ["read"], [
    { id: "find", name: "tool_search", arguments: { query: "computer read windows displays" } },
    { id: "session", name: "computer_read", arguments: { path: "computer:session" } },
    { id: "again", name: "computer_read", arguments: { path: "computer:session" } },
  ]);
  expect(getToolCallNames(result)).toEqual(["tool_search", "computer_read", "computer_read"]);
  expect(getToolExecution(result, "session").isError, getToolResultText(result, "session")).toBe(false);
  expect(getToolResultText(result, "session")).toContain("computer:machine/local");
  // As with the IDE, the first read of a computer address brings the guide with the standalone names, and only once.
  expect(getToolResultText(result, "session")).toContain("# Guide: computer");
  expect(getToolResultText(result, "session")).toContain("Native window/viewport points");
  expect(getToolResultText(result, "again")).not.toContain("# Guide: computer");
}, 120_000);

test("without Pi Agent IDE, a script's first computer_read brings the guide to the script's own result", async () => {
  const result = await run("standalone-codemode", [path.join(root, "test/fixtures/codemode-extension.ts"), computerUse], ["codemode"], [
    // The script prints nothing of what it read; the guide still reaches the model once.
    { id: "script", name: "codemode", arguments: { code: `await tools.computer_read({ path: "computer:session" }); await tools.computer_read({ path: "computer:session" }); text("read twice");` } },
    { id: "after", name: "codemode", arguments: { code: `text(await tools.computer_read({ path: "computer:session" }));` } },
    { id: "close", name: "codemode", arguments: { code: `await tools.computer_delete({ path: "computer:session" }); text("closed");` } },
  ]);
  expect(getToolExecution(result, "script").isError, getToolResultText(result, "script")).toBe(false);
  expect(getToolResultText(result, "script")).toContain("read twice");
  expect(getToolResultText(result, "script").split("# Guide: computer").length).toBe(2);
  expect(getToolResultText(result, "script")).toContain("Native window/viewport points");
  expect(getToolResultText(result, "after")).toContain("computer:machine/local");
  expect(getToolResultText(result, "after")).not.toContain("# Guide: computer");
}, 120_000);

test("with Pi Agent IDE, computer use extends Read, Search and Delete, refuses Write and Insert, and adds only the typed computer tools", async () => {
  for (const extensions of [[ide, computerUse, "builtin:tool-search"], [computerUse, ide, "builtin:tool-search"]]) {
    const result = await run("with-ide", extensions, ["read", "write", "insert", "delete", "tool_search"], [
      { id: "find", name: "tool_search", arguments: { query: "computer read windows displays" } },
      { id: "open", name: "tool_search", arguments: { query: "computer open window" } },
      { id: "more", name: "tool_search", arguments: { query: "computer wait" } },
      { id: "files", name: "tool_search", arguments: { query: "computer files clipboard record" } },
      { id: "view", name: "tool_search", arguments: { query: "computer view viewport" } },
      { id: "input", name: "tool_search", arguments: { query: "computer click hover drag scroll" } },
      { id: "keys", name: "tool_search", arguments: { query: "computer type press select timeline" } },
      { id: "session", name: "read", arguments: { path: "computer:session" } },
      { id: "insert", name: "insert", arguments: { path: "computer:machine/local", text: '{"action":"open","app":"Notepad"}' } },
      { id: "write", name: "write", arguments: { path: "computer:machine/local", content: "hello" } },
      { id: "close", name: "delete", arguments: { path: "computer:session" } },
      { id: "force", name: "delete", arguments: { path: "computer:machine/local?force=true" } },
      { id: "delete", name: "delete", arguments: { path: "computer:session" } },
    ]);
    // The force option reaches computer use through the IDE's resolver, which then refuses it for a machine.
    expect(getToolResultText(result, "force")).toContain("?force=true applies to window addresses only.");
    // The IDE's own tools read and delete computer resources; the cluster queries load every typed tool.
    const loaded = ["find", "open", "more", "files", "view", "input", "keys"].map(id => getToolResultText(result, id)).join("\n");
    expect(loaded).not.toContain("computer_read");
    expect(loaded).not.toContain("computer_delete");
    for (const tool of ["computer_open", "computer_window", "computer_view", "computer_display", "computer_wait", "computer_files", "computer_clipboard", "computer_record",
      "computer_click", "computer_hover", "computer_drag", "computer_scroll", "computer_type", "computer_press", "computer_select", "computer_timeline"]) expect(loaded).toContain(`- ${tool}:`);
    for (const id of ["session", "close", "delete"])
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
    expect(getToolResultText(result, "session")).toContain("computer:machine/local");
    // The first Read of a computer address brings the guide, with the IDE's tool names filled in.
    expect(getToolResultText(result, "session")).toContain("# Guide: computer");
    expect(getToolResultText(result, "session")).toContain("Native window/viewport points");
    expect(getToolResultText(result, "session")).not.toMatch(/\{(read|search|delete)\}|computer_read/);
    // Write and Insert only name the typed tool that does what they were sent; nothing reaches a machine.
    for (const id of ["insert", "write"]) expect(getToolExecution(result, id).isError).toBe(true);
    expect(getToolResultText(result, "insert")).toContain("Insert does not act on computer resources; nothing was sent. Use computer_open.");
    expect(getToolResultText(result, "write")).toContain("Write does not act on computer resources; nothing was sent. Use computer_type.");
    expect(getToolResultText(result, "close")).toContain("Computer closed");
    expect(getToolResultText(result, "delete")).toContain("Computer closed");
  }
}, 240_000);
