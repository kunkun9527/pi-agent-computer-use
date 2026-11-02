import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computerPathHelp, computerViewsHelp } from "../src/provider.ts";
import { STANDALONE_TOOL_NAMES } from "../src/tool-names.ts";

const quick = readFileSync(new URL("../docs/computer-resources.md", import.meta.url), "utf8");
const full = readFileSync(new URL("../docs/computer-resources-reference.md", import.meta.url), "utf8");

describe("lean computer-use guidance", () => {
  it("keeps the injected guide small while retaining full reference", () => {
    expect(quick.length).toBeLessThan(3000);
    expect(full.length).toBeGreaterThan(quick.length);
    expect(quick).toContain("computer-resources-reference.md");
  });

  it("keeps safety, freshness and delivery boundaries explicit", () => {
    for (const term of ["human_stop", "unknown", "Safe mode", "foreground", "latest", "Playwright", "close only"]) {
      expect(quick.toLowerCase()).toContain(term.toLowerCase());
    }
  });

  it("keeps discovery addresses and view syntax in the schema hints", () => {
    const paths = computerPathHelp(STANDALONE_TOOL_NAMES);
    const views = computerViewsHelp(STANDALONE_TOOL_NAMES);
    for (const term of ["computer:machine/", "computer:window/", "computer:session", "computer_read", "computer_search"]) {
      expect(paths).toContain(term);
    }
    for (const term of ["dom", "aria", "capture:", "element:", "frames:"]) {
      expect(views).toContain(term);
    }
  });
});
