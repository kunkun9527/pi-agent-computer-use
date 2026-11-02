import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computerPathHelp, computerViewsHelp } from "../src/provider.ts";
import { registerComputerTools } from "../src/computer-tools.ts";
import { STANDALONE_TOOL_NAMES } from "../src/tool-names.ts";

const quick = readFileSync(new URL("../docs/computer-resources.md", import.meta.url), "utf8");
const full = readFileSync(new URL("../docs/computer-resources-reference.md", import.meta.url), "utf8");

describe("lean computer-use guidance", () => {
  it("keeps the injected guide small while retaining full reference", () => {
    expect(quick.length).toBeLessThan(3500);
    expect(full.length).toBeGreaterThan(quick.length);
    expect(quick).toContain("computer-resources-reference.md");
  });

  it("keeps safety, freshness and delivery boundaries explicit", () => {
    for (const term of ["human_stop", "unknown", "Safe mode", "foreground", "latest", "Playwright", "close only", "getByTitle", "fall back"]) {
      expect(quick.toLowerCase()).toContain(term.toLowerCase());
    }
  });

  it("keeps discovery addresses and view syntax in the schema hints", () => {
    const paths = computerPathHelp(STANDALONE_TOOL_NAMES);
    const views = computerViewsHelp(STANDALONE_TOOL_NAMES);
    for (const term of ["computer:machine/", "computer:window/", "computer:session", "computer_read", "computer_search"]) {
      expect(paths).toContain(term);
    }
    for (const term of ["aria", "capture:", "element:", "frames:", "alone"]) {
      expect(views).toContain(term);
    }
  });

  it("keeps the 17 typed action tools deferred and key calling instructions visible", () => {
    const registered: { name: string; exposure?: string; parameters?: { properties?: Record<string, { description?: string }> } }[] = [];
    const pi = { registerTool(tool: typeof registered[number]) { registered.push(tool); } };
    const resources = { describe: () => undefined };
    registerComputerTools(pi as never, resources as never, STANDALONE_TOOL_NAMES);
    expect(registered).toHaveLength(16);
    expect(registered.some(tool => tool.name === "computer_browser")).toBe(false);
    expect(registered.every(tool => tool.exposure === "deferred")).toBe(true);
    const desc = (name: string, field: string) => registered.find(tool => tool.name === name)?.parameters?.properties?.[field]?.description ?? "";
    expect(desc("computer_view", "viewport")).toContain("1–32");
    expect(desc("computer_type", "text")).toContain("UIA");
    const openProps = registered.find(tool => tool.name === "computer_open")?.parameters?.properties ?? {};
    for (const field of ["browser", "url", "profile", "webview2_debugging", "debugging"]) expect(openProps).not.toHaveProperty(field);
    expect(desc("computer_record", "action")).toContain("watch_stop");
    expect(desc("computer_wait", "mode")).toContain("check samples once");
    expect(desc("computer_click", "target")).toContain("UIA");
  });
});
