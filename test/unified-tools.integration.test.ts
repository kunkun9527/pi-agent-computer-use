import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionDetails, getToolResultText,
  PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("production Pi exposes only computer tools, with no direct or Codemode browser route", async () => {
  await mkdir(".tmp/unified-tools", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/unified-tools/pi-contract-"));
  const log = path.join(cwd, "driver-calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/fake-driver.mjs"), log],
  }));
  try {
    const result = await new PiIntegrationTest({
      testName: "unified-production-tools", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/unified-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "registered_ui_tools"],
      conversation: [
        assistantMessage([toolCall({ id: "registry", name: "registered_ui_tools", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "direct-browser", name: "browser_tabs", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "nested-browser", name: "codemode",
          arguments: { code: "text(await tools.browser_tabs({}));" } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "apps", name: "codemode",
          arguments: { code: 'text(await tools.computer_search({path:"computer:machine/local/apps",query:"Notepad"}));' } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "codemode",
          arguments: { code: 'text((await tools.computer_delete({path:"computer:session"})).outcome);' } })], { stopReason: "toolUse" }),
        assistantMessage([text("Unified tool loadout checked.")]),
      ],
    }).run("Check the production loadout. Only discover apps; never open a window or send input.");
    // Without Pi Agent IDE, production computer use offers deferred tools that tool_search loads.
    const standalone = ["computer_click", "computer_clipboard", "computer_delete", "computer_display", "computer_drag", "computer_files", "computer_hover", "computer_open",
      "computer_press", "computer_read", "computer_record", "computer_scroll", "computer_search", "computer_select", "computer_timeline", "computer_type", "computer_view", "computer_wait", "computer_window"];
    expect(getToolExecutionDetails(getToolExecution(result, "registry"))).toEqual({
      names: standalone,
      exposure: Object.fromEntries(standalone.map(name => [name, "deferred"])),
      callable: standalone, active: [],
    });
    for (const id of ["direct-browser", "nested-browser"]) {
      expect(getToolExecution(result, id).isError).toBe(true);
      expect(getToolResultText(result, id)).toContain(id === "direct-browser" ? "browser_tabs" : "No tool calls were made.");
    }
    expect(getToolExecution(result, "apps").isError, getToolResultText(result, "apps")).toBe(false);
    expect(getToolResultText(result, "apps")).toContain("Notepad");
    expect(getToolExecution(result, "close").isError, getToolResultText(result, "close")).toBe(false);
    expect(getToolResultText(result, "close")).toContain("closed");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.name)).toEqual([{ name: "list_apps", arguments: {} }]);
    expect(calls).toContainEqual({ event: "stdin-eof" });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
