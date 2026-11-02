import { expect, test, vi } from "vitest";
import { requireComputerAddress, ComputerResources, refKind } from "../src/computer-resources.ts";
import { computerEditRefusal } from "../src/provider.ts";
import { clickPlan, clipboardCommand, dragPlan, filesCommand, hoverPlan, openCommand, pressPlan, recordCommand, scrollPlan, selectPlan, timelinePlan, typePlan, waitCommand, windowCommand } from "../src/computer-tools.ts";
import type { WebBrowser, WebLauncher } from "../src/web-browser.ts";
import type { MachineHost } from "../src/machine-host.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computerAction, deleteComputer, presentComputerResult } from "../src/provider.ts";
import sharp from "sharp";
import { ComputerSession, type ComputerMode, type Driver } from "../src/session.ts";

const cwd = "/synthetic-computer-tools";
const at = (source: string) => requireComputerAddress(source);

// LPT-934: each typed tool turns its fields into exactly one existing command.
test("computer_open opens native apps or isolated desktops and rejects browser automation", () => {
  const machine = at("computer:machine/lab");
  expect(openCommand(machine, { at: "", app: "Notepad" })).toEqual({ action: "open", app: "Notepad" });
  expect(openCommand(machine, { at: "", path: "C:\\Tools\\app.exe", args: ["--x"] }))
    .toEqual({ action: "open", path: "C:\\Tools\\app.exe", args: ["--x"] });
  expect(openCommand(machine, { at: "", sandbox: { export: "C:\\out" } })).toEqual({ action: "open_sandbox", export: "C:\\out" });
  expect(openCommand(machine, { at: "", isolated_session: true })).toEqual({ action: "open_session" });
  expect(openCommand(at("computer:app/a1"), { at: "" })).toEqual({ action: "open" });
  expect(openCommand(at("computer:sandbox/s1"), { at: "", app: "Notepad" })).toEqual({ action: "open", app: "Notepad" });
  expect(() => openCommand(at("computer:window/w1"), { at: "" })).toThrow("Browser attachment is disabled");
  expect(() => openCommand(machine, { at: "", app: "Notepad", path: "C:\\app.exe" })).toThrow("Open one thing at a time");
  expect(() => openCommand(machine, { at: "", app: "Notepad", args: ["x"] })).toThrow("args requires path");
  expect(() => openCommand(machine, { at: "" })).toThrow("Name what to open");
  expect(() => openCommand(machine, { at: "", url: "https://example.com" } as never)).toThrow("Name what to open");
  expect(() => openCommand(at("computer:machine/lab/windows"), { at: "", app: "Notepad" })).toThrow("Open at computer:machine/<name>");
  expect(() => openCommand(at("computer:sandbox/s1"), { at: "", isolated_session: true })).toThrow("A sandbox opens apps by app or path");
});

test("computer_window takes exactly the fields of its action", () => {
  expect(windowCommand({ window: "w", action: "move", x: -5, y: 10 })).toEqual({ action: "move", x: -5, y: 10, unit: "windows_desktop_pixels" });
  expect(windowCommand({ window: "w", action: "resize", width: 800, height: 600 })).toEqual({ action: "resize", width: 800, height: 600, unit: "windows_desktop_pixels" });
  expect(windowCommand({ window: "w", action: "restore" })).toEqual({ action: "restore" });
  expect(() => windowCommand({ window: "w", action: "move", x: 1 })).toThrow("move needs x and y and nothing else.");
  expect(() => windowCommand({ window: "w", action: "minimize", width: 1 })).toThrow("minimize takes no coordinates, size or name.");
  expect(windowCommand({ window: "w", action: "name", as: "game" })).toEqual({ action: "name", as: "game" });
  expect(() => windowCommand({ window: "w", action: "name" })).toThrow("name needs as and nothing else.");
  expect(() => windowCommand({ window: "w", action: "move", x: 1, y: 2, as: "game" })).toThrow("move needs x and y and nothing else.");
});

test("computer_wait maps to wait_for or a single verify sample", () => {
  const conditions = [{ target: "getByRole('button', { name: 'Save' })", is: "enabled" as const }];
  expect(waitCommand({ window: "w", conditions, timeout_ms: 2000, stable: 2 })).toEqual({ action: "wait_for", conditions, timeout_ms: 2000, stable: 2 });
  expect(waitCommand({ window: "w", conditions, mode: "check" })).toEqual({ action: "verify", conditions });
  expect(() => waitCommand({ window: "w", conditions, mode: "check", timeout_ms: 10 })).toThrow("check takes one sample, so timeout_ms do not apply.");
});

test("computer_files maps put, get and list and takes only their fields", () => {
  expect(filesCommand({ machine: "m", action: "put", from: "a.txt" })).toEqual({ action: "put", from: "a.txt" });
  expect(filesCommand({ machine: "m", action: "put", from: "a.txt", name: "b.txt" })).toEqual({ action: "put", from: "a.txt", name: "b.txt" });
  expect(filesCommand({ machine: "m", action: "get", name: "b.txt", to: "out/b.txt" })).toEqual({ action: "get", name: "b.txt", to: "out/b.txt" });
  expect(filesCommand({ machine: "m", action: "list" })).toEqual({ action: "files" });
  expect(() => filesCommand({ machine: "m", action: "put" })).toThrow("put needs from.");
  expect(() => filesCommand({ machine: "m", action: "get", name: "b.txt" })).toThrow("get needs to.");
  expect(() => filesCommand({ machine: "m", action: "list", to: "x" })).toThrow("list takes no to.");
});

test("computer_clipboard reads with or without the image and writes exactly one of text or image", () => {
  expect(clipboardCommand({ machine: "m", action: "read" })).toEqual({ action: "clipboard_read" });
  expect(clipboardCommand({ machine: "m", action: "read", include_image: true })).toEqual({ action: "clipboard_read", image: true });
  expect(clipboardCommand({ machine: "m", action: "write", text: "hi" })).toEqual({ action: "clipboard_write", text: "hi" });
  expect(clipboardCommand({ machine: "m", action: "write", image: "a.png" })).toEqual({ action: "clipboard_write", image: "a.png" });
  expect(() => clipboardCommand({ machine: "m", action: "write" })).toThrow("write needs exactly one of text or image.");
  expect(() => clipboardCommand({ machine: "m", action: "write", text: "hi", image: "a.png" })).toThrow("write needs exactly one of text or image.");
  expect(() => clipboardCommand({ machine: "m", action: "read", text: "hi" })).toThrow("read takes no text.");
});

test("computer_record maps video and audio to machine commands and sequence to the Read view", () => {
  expect(recordCommand({ at: "m", action: "video_start", seconds: 30 })).toEqual({ command: { action: "record_start", seconds: 30 } });
  expect(recordCommand({ at: "m", action: "video_stop", to: "v.mp4" })).toEqual({ command: { action: "record_stop", to: "v.mp4" } });
  expect(recordCommand({ at: "m", action: "audio", seconds: 5, transcribe: true })).toEqual({ command: { action: "audio_record", seconds: 5, transcribe: true } });
  expect(recordCommand({ at: "w", action: "sequence", duration_ms: 2000, fps: 10, region: { x: 0, y: 0, width: 100, height: 50 } }))
    .toEqual({ views: ['sequence:{"duration_ms":2000,"fps":10,"region":{"x":0,"y":0,"width":100,"height":50}}'] });
  expect(() => recordCommand({ at: "m", action: "video_start" })).toThrow("video_start needs seconds.");
  expect(() => recordCommand({ at: "m", action: "audio", seconds: 400 })).toThrow("audio records at most 300 seconds.");
  expect(() => recordCommand({ at: "w", action: "sequence" })).toThrow("sequence needs duration_ms.");
  expect(() => recordCommand({ at: "w", action: "sequence", duration_ms: 5000, timeout_ms: 1000 })).toThrow("timeout_ms duration..");
  expect(() => recordCommand({ at: "m", action: "video_stop", seconds: 3 })).toThrow("video_stop takes no seconds.");
});

test("input tools build one plan for native windows and one for browser pages", () => {
  const w = "computer:w";
  expect(refKind("1:a")).toBe("hint");
  expect(refKind("2b:ac")).toBe("hint");
  expect(refKind("e12")).toBe("page");
  expect(refKind("f1e3")).toBe("page");
  expect(refKind("getByRole('button', { name: 'Save' })")).toBe("locator");
  expect(clickPlan({ window: w, target: "1:a" })).toEqual({ label: "click", target: "1:a", native: { action: "click" }, web: { action: "click" } });
  expect(clickPlan({ window: w, x: 10, y: 20, count: 2, modifiers: ["ctrl"] })).toMatchObject({ label: "click", point: { x: 10, y: 20 },
    native: { action: "double_click", modifiers: ["ctrl"] }, web: { action: "timeline" } });
  expect(clickPlan({ window: w, target: "e1", count: 2, modifiers: ["ctrl"] }).web).toEqual({ action: "click", click_count: 2, modifiers: ["Control"] });
  expect(clickPlan({ window: w, target: "e1", button: "right" }).native).toEqual({ action: "right_click" });
  // LPT-948: every multi-click goes to a native window as the driver's click with its button and count.
  expect(clickPlan({ window: w, target: "1:a", count: 3 }).native).toEqual({ action: "click", count: 3 });
  expect(clickPlan({ window: w, x: 1, y: 2, button: "right", count: 2, modifiers: ["shift"] }).native).toEqual({ action: "click", button: "right", count: 2, modifiers: ["shift"] });
  expect(clickPlan({ window: w, x: 1, y: 2, button: "middle", count: 3 }).native).toEqual({ action: "click", button: "middle", count: 3 });
  expect(() => clickPlan({ window: w })).toThrow("click needs a target or a point (x and y).");
  expect(() => clickPlan({ window: w, x: 1 })).toThrow("click needs both x and y for a point.");
  expect(() => clickPlan({ window: w, x: 1, y: 2, target: "1:a" })).toThrow("click takes a target or a point, not both.");
  expect(hoverPlan({ window: w, target: "1:a" }).native).toEqual({ action: "hover", dwell_ms: 300 });
  expect(dragPlan({ window: w, from: { target: "1:a" }, to: { x: 5, y: 6 }, via: [{ x: 3, y: 4 }] })).toMatchObject({ target: "1:a", end: { point: { x: 5, y: 6 } }, native: { action: "drag", via: [{ x: 3, y: 4 }] } });
  expect(scrollPlan({ window: w, delta_y: -2 })).toMatchObject({ native: { action: "scroll", delta_y: -2, unit: "wheel_detents" }, web: { action: "scroll", delta_y: -200 } });
  expect(scrollPlan({ window: w, target: "1:a", delta_x: 3 }).native).toEqual({ action: "scroll", direction: "right", amount: 3 });
  expect(() => scrollPlan({ window: w })).toThrow("scroll needs delta_x or delta_y.");
  const typed = typePlan({ window: w, target: "1:a", text: "Ada", replace: true, submit: true });
  expect(typed).toMatchObject({ native: { action: "set_value", text: "Ada" }, web: { action: "fill", text: "Ada" },
    then: { target: "1:a", native: { action: "key", key: "return" }, web: { action: "press", key: "Enter" } } });
  expect(() => typePlan({ window: w, text: "x", replace: true })).toThrow("replace needs the field as target.");
  expect(pressPlan({ window: w, key: "ctrl+shift+Tab" })).toMatchObject({ native: { action: "hotkey", keys: ["ctrl", "shift", "tab"] }, web: { action: "press", key: "Control+Shift+Tab" } });
  expect(pressPlan({ window: w, key: "Enter" }).native).toEqual({ action: "key", key: "enter" });
  expect(pressPlan({ window: w, key: "w", hold_ms: 500 }).native).toEqual({ action: "hold", keys: ["w"], duration_ms: 500 });
  expect(pressPlan({ window: w, key: "f5" }).web).toEqual({ action: "press", key: "F5" });
  expect(() => pressPlan({ window: w, key: "hyper+a" })).toThrow("Modifiers are ctrl, shift, alt and win.");
  expect(selectPlan({ window: w, target: "e3", values: ["Red"] })).toMatchObject({ native: { action: "select", option: "Red" }, web: { action: "select", values: ["Red"] } });
  expect(selectPlan({ window: w, target: "1:a", checked: false })).toMatchObject({ native: { action: "uncheck" }, web: { action: "uncheck" } });
  expect(selectPlan({ window: w, menu: ["File", "Save"] })).toMatchObject({ native: { action: "menu", path: ["File", "Save"] } });
  expect(() => selectPlan({ window: w, target: "1:a", checked: true, values: ["a"] })).toThrow("select takes one of values, checked or menu");
  const keyed = timelinePlan({ window: w, events: [{ at_ms: 0, type: "key_down", key: "ctrl" }, { at_ms: 5, type: "wheel", dy: 2 }, { at_ms: 9, type: "key_up", key: "ctrl" }] });
  expect(keyed.native).toMatchObject({ action: "timeline", events: [{ key: "ctrl" }, { dy: 2 }, { key: "ctrl" }] });
  expect(keyed.web).toEqual({ action: "timeline", events: [{ at_ms: 0, type: "key_down", key: "Control" }, { at_ms: 5, type: "wheel", dy: 200 }, { at_ms: 9, type: "key_up", key: "Control" }] });
  expect(pressPlan({ window: w, key: "shift+up", hold_ms: 300 }).web).toEqual({ action: "timeline", events: [
    { at_ms: 0, type: "key_down", key: "Shift" }, { at_ms: 0, type: "key_down", key: "ArrowUp" }, { at_ms: 300, type: "key_up", key: "ArrowUp" }, { at_ms: 300, type: "key_up", key: "Shift" }] });
  expect(dragPlan({ window: w, from: { target: "e2" }, to: { x: 50, y: 60 }, duration_ms: 200 }).web).toEqual({ action: "timeline", events: [
    { at_ms: 0, type: "move", target: { ref: "e2" } }, { at_ms: 0, type: "button_down", button: "left" },
    { at_ms: 200, type: "move", x: 50, y: 60, steps: 13 }, { at_ms: 200, type: "button_up", button: "left" }] });
  expect(scrollPlan({ window: w, x: 4, y: 5, delta_y: 1 }).web).toEqual({ action: "timeline", events: [{ at_ms: 0, type: "move", x: 4, y: 5 }, { at_ms: 0, type: "wheel", dy: 100 }] });
});

test("typed input refuses mismatched targets before anything reaches the machine", async () => {
  const f = fixture("closed");
  const window = at(`computer:window/${await f.window()}`);
  await expect(f.resources.input(at("computer:machine/local"), cwd, clickPlan({ window: "x", target: "1:a" }))).rejects.toThrow("Give the window address");
  await expect(f.resources.input(window, cwd, clickPlan({ window: "x", target: "e4" }))).rejects.toThrow("e4 is a page ref from a DOM Read; this window is not a browser page");
  await expect(f.resources.input(window, cwd, clickPlan({ window: "x", x: 1, y: 2, space: "page" }))).rejects.toThrow("space applies to browser windows only");
  await expect(f.resources.input(window, cwd, clickPlan({ window: "x", target: "9:z" }))).rejects.toThrow("9:z is not a ref of this window's latest Read");
});

/** A Chrome window (pid 4100) attached to a fake Playwright worker that records page actions. */
function browserFixture() {
  const target = { pid: 4100, window_id: 77, title: "Page - Google Chrome", app_name: "chrome.exe" };
  const driver: Driver = {
    identity: vi.fn(async () => "life-77") as Driver["identity"], close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async name => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [target] } };
      throw new Error(`Unexpected native call ${name}`);
    }),
  };
  const page = vi.fn(async (_kind: string, _action?: unknown) => ({ url: "https://example.com/next", title: "Next", snapshot: "- heading \"Next\" [ref=e1]", tabs: [], events: [] }));
  const browser = { close: vi.fn(async () => {}), page } as unknown as WebBrowser;
  const launch = vi.fn<WebLauncher>(async () => ({ browser,
    opened: { pid: target.pid, version: "155", url: "https://example.com", title: "Page", via: "cdp" } }));
  const session = new ComputerSession(driver, () => "yolo", undefined, undefined, launch);
  const resources = new ComputerResources(async () => session, async () => session.close());
  const window = async () => {
    const ref = ((await resources.search(at("computer:machine/local/windows"), cwd, "Chrome")).details.state!.windows as { window_ref: string }[])[0].window_ref;
    expect((await session.attachBrowser(ref)).details.status).toBe("delivered");
    return at(`computer:window/${ref}`);
  };
  return { resources, page, window, browser };
}

test("computer_browser runs a page action on the window and returns the page's next snapshot", async () => {
  const f = browserFixture();
  const window = await f.window();
  const result = await f.resources.browserAction(window, cwd, { action: "navigate", url: "https://example.com/next" });
  expect(result.details).toMatchObject({ status: "delivered", machine: "local" });
  expect(f.page).toHaveBeenLastCalledWith("act", { action: "navigate", url: "https://example.com/next" }, undefined);
  // The snapshot is the window's current observation, so its refs ground the next action.
  const id = result.details.observation_id!;
  expect((await f.resources.read(at(`computer:observation/${id}`), cwd))?.details.status).toBe("observed");
  await expect(f.resources.browserAction(window, cwd, { action: "click", target: { ref: "e1" } })).rejects.toThrow("computer_browser runs navigate, back");
  await expect(f.resources.browserAction(window, cwd, { action: "navigate", url: "file:///etc/passwd" })).rejects.toThrow("url must be HTTP(S)");
  await expect(f.resources.browserAction(at("computer:machine/local"), cwd, { action: "reload" })).rejects.toThrow("computer_browser needs the window address");
  // Refused requests never reach Playwright.
  expect(f.page).toHaveBeenCalledTimes(1);
});

// LPT-928: a page action shows its visual change too, from Playwright screenshots of the page before and after it.
test("a page action compares page screenshots and puts the change at its point first", async () => {
  const f = browserFixture();
  const white = await sharp({ create: { width: 400, height: 300, channels: 3, background: "white" } }).png().toBuffer();
  const marked = await sharp(white).composite([{ input: { create: { width: 20, height: 20, channels: 3, background: "black" } }, left: 90, top: 140 }]).png().toBuffer();
  const shots = [white, marked];
  (f.browser as unknown as { request: unknown }).request = vi.fn(async (kind: string, args: { css?: boolean }) => {
    expect(kind).toBe("screenshot");
    expect(args.css).toBe(true);
    return { url: "https://example.com/next", title: "Next", png: (shots.shift() ?? marked).toString("base64") };
  });
  const window = await f.window();
  // The first action makes a page snapshot current; the next one is compared with it.
  await f.resources.input(window, cwd, clickPlan({ window: "x", target: "e1" }));
  const clicked = await f.resources.input(window, cwd, clickPlan({ window: "x", x: 100, y: 150 }));
  expect(clicked.details.successor?.diff?.pixels).toMatchObject({ space: "page", overview: true, areas: [{ x: 90, y: 140, width: 20, height: 20, at_input: true }] });
  expect(presentComputerResult(clicked)).toMatch(/Pixels changed in 1 area \(CSS pixels of the page; [\d.]+% of the page\); image 1 outlines and numbers them on the page:\n  1\. x=90 y=140 w=20 h=20 \(at the input point\); images 2 and 3 show/);
  expect(clicked.content.filter(block => block.type === "image")).toHaveLength(3);
});

test("a page action that navigates shows the whole page after it, even when the pages look alike", async () => {
  const f = browserFixture();
  const white = await sharp({ create: { width: 400, height: 300, channels: 3, background: "white" } }).png().toBuffer();
  const lined = await sharp(white).composite([{ input: { create: { width: 200, height: 10, channels: 3, background: "black" } }, left: 10, top: 10 }]).png().toBuffer();
  const shots = [white, lined];
  (f.browser as unknown as { request: unknown }).request = vi.fn(async () => ({ url: "https://example.com/next", title: "Next", png: (shots.shift() ?? lined).toString("base64") }));
  const window = await f.window();
  await f.resources.input(window, cwd, clickPlan({ window: "x", target: "e1" }));
  f.page.mockImplementation(async () => ({ url: "https://example.com/other", title: "Other", snapshot: "- heading \"Other\" [ref=e1]", tabs: [], events: [] }));
  const left = await f.resources.input(window, cwd, clickPlan({ window: "x", target: "e1" }));
  expect(left.details.successor?.diff?.pixels).toMatchObject({ full: true, navigated: true });
  expect(presentComputerResult(left)).toMatch(/The page navigated \([\d.]+% of its pixels changed\): image 1 shows the whole page after the action\./);
  expect(left.content.filter(block => block.type === "image")).toHaveLength(1);
});

// LPT-962: a crop needs no fresh DOM Read: the window's Read takes a locator, or a ref of its latest snapshot, against the live page.
test("a browser window's Read crops an element by locator or latest ref, and a replaced observation names the current one", async () => {
  const f = browserFixture();
  const png = (await sharp({ create: { width: 30, height: 20, channels: 3, background: "red" } }).png().toBuffer()).toString("base64");
  const request = vi.fn(async (_kind: string, _args: unknown) => ({ url: "https://example.com/next", title: "Next", png }));
  (f.browser as unknown as { request: unknown }).request = request;
  const window = await f.window();
  const first = (await f.resources.read(window, cwd, ["dom"]))!;
  // A click issues the page's next snapshot, which replaces the first one.
  const clicked = await f.resources.input(window, cwd, clickPlan({ window: "x", target: "e1" }));
  const byLocator = (await f.resources.read(window, cwd, ["element:crop,getByRole('button', { name: 'Verify, now' })"]))!;
  expect(byLocator.content.filter(block => block.type === "image")).toHaveLength(1);
  expect(request.mock.calls.at(-1)).toEqual(["screenshot", { target: { locator: "internal:role=button[name=\"Verify, now\"i]" }, highlight: false }, undefined]);
  const byRef = (await f.resources.read(window, cwd, ["element:highlight,e1"]))!;
  expect(byRef.content.filter(block => block.type === "image")).toHaveLength(1);
  expect(request.mock.calls.at(-1)).toEqual(["screenshot", { target: { ref: "e1" }, highlight: true }, undefined]);
  await expect(f.resources.read(at(`computer:observation/${first.details.observation_id}`), cwd, ["element:crop,e1"]))
    .rejects.toThrow(`computer:observation/${clicked.details.observation_id}`);
});

test("typed input on a browser window goes to Playwright with page refs and locators", async () => {
  const f = browserFixture();
  const window = await f.window();
  const clicked = await f.resources.input(window, cwd, clickPlan({ window: "x", target: "e1", modifiers: ["shift"] }));
  expect(clicked.details).toMatchObject({ status: "delivered", machine: "local" });
  expect(f.page).toHaveBeenLastCalledWith("act", { action: "click", target: { ref: "e1" }, modifiers: ["Shift"] }, undefined);
  // The snapshot of the first action is the window's current observation, so the next one compares with it.
  await f.resources.input(window, cwd, typePlan({ window: "x", target: "getByLabel('Name')", text: "Ada", submit: true }));
  expect(f.page.mock.calls.slice(-2).map(call => call[1])).toEqual([
    { action: "type", text: "Ada", target: { locator: "internal:label=\"Name\"i" } },
    { action: "press", key: "Enter", target: { locator: "internal:label=\"Name\"i" } }]);
  // A point of a page is a timeline in CSS pixels, with the click numbered like Playwright's mouse.click.
  await f.resources.input(window, cwd, clickPlan({ window: "x", x: 5, y: 6, count: 2, modifiers: ["ctrl"] }));
  expect(f.page.mock.calls.at(-1)![1]).toEqual({ action: "timeline", events: [
    { at_ms: 0, type: "key_down", key: "Control" }, { at_ms: 0, type: "move", x: 5, y: 6 },
    { at_ms: 0, type: "button_down", button: "left", click_count: 1 }, { at_ms: 0, type: "button_up", button: "left", click_count: 1 },
    { at_ms: 0, type: "button_down", button: "left", click_count: 2 }, { at_ms: 0, type: "button_up", button: "left", click_count: 2 },
    { at_ms: 0, type: "key_up", key: "Control" }] });
  await expect(f.resources.input(window, cwd, timelinePlan({ window: "x", events: [{ at_ms: 0, type: "move_relative", dx: 5, dy: 0 }] }))).rejects.toThrow("move_relative needs native input");
  await expect(f.resources.input(window, cwd, timelinePlan({ window: "x", events: [{ at_ms: 0, type: "key_down", key: "a" }] }))).rejects.toThrow("The timeline leaves a down");
  await expect(f.resources.input(window, cwd, selectPlan({ window: "x", menu: ["File"] }))).rejects.toThrow("menu works on native windows");
  expect(f.page).toHaveBeenCalledTimes(4);
});

/** One window (pid 10, id 7) a session can list and observe; the host decides how a close request ends. */
function fixture(outcome: "closed" | "open" | "refused") {
  let open = true, mode: ComputerMode = "yolo";
  const driver: Driver = {
    identity: vi.fn(async () => open ? "life-7" : undefined) as Driver["identity"],
    close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async name => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: open ? [{ pid: 10, window_id: 7, title: "Editor" }] : [] } };
      throw new Error(`Unexpected native call ${name}`);
    }),
  };
  const closeWindow = vi.fn(async () => { if (outcome === "closed") open = false; return outcome; });
  const session = new ComputerSession(driver, () => mode, undefined, undefined, undefined, { closeWindow, removeFiles: async () => {} } as unknown as MachineHost);
  const resources = new ComputerResources(async () => session, async () => session.close());
  const window = async () => ((await resources.search(at("computer:machine/local/windows"), cwd, "Editor")).details.state!.windows as { window_ref: string }[])[0].window_ref;
  const remove = (source: string) => deleteComputer(resources, source, { path: source }, cwd);
  return { resources, closeWindow, window, remove, safe: () => { mode = "safe"; } };
}

test("Delete closes a window like its close button, and its address expires", async () => {
  const f = fixture("closed");
  const ref = await f.window();
  const closed = await f.remove(`computer:window/${ref}`);
  expect(closed.data).toMatchObject({ ok: true, status: "closed", machine: "local" });
  expect(closed.script).toMatchObject({ action: "close", outcome: "closed" });
  expect(f.closeWindow).toHaveBeenCalledWith(10, 7, 5000);
  expect((await f.remove(`computer:window/${ref}`)).summary).toContain("Unknown or closed window reference");
});

test("Delete reports a window that stays open and refuses what it cannot close", async () => {
  const kept = fixture("open");
  const ref = await kept.window();
  const result = await kept.remove(`computer:window/${ref}`);
  expect(result.data).toMatchObject({ ok: true, status: "delivered" });
  expect(result.summary).toContain("still open after 5 s");
  // Force kills only processes this session started.
  expect((await kept.remove(`computer:window/${ref}?force=true`)).summary).toContain("Only windows this session opened can be force-closed");
  expect((await kept.remove("computer:machine/local?force=true")).summary).toContain("?force=true applies to window addresses only.");
  // A malformed address is refused before anything is sent, like an invalid field.
  expect((await kept.remove("computer:display/primary")).script).toMatchObject({ outcome: "refused", effect: "not-applied" });
  expect((await kept.remove("computer:machine/local/windows")).summary).toContain("Delete closes a window, a sandbox or isolated session, a machine or computer:session, or removes a viewport.");

  // Safe mode closes only windows this session opened, like any other input.
  const safe = fixture("closed");
  const foreign = await safe.window();
  safe.safe();
  const refused = await safe.remove(`computer:window/${foreign}`);
  expect(refused.data).toMatchObject({ ok: false, status: "refused" });
  expect(refused.summary).toContain("Safe mode allows only windows opened by this session.");
  expect(safe.closeWindow).not.toHaveBeenCalled();
  const session = await kept.remove("computer:session");
  expect(session.data).toMatchObject({ ok: true });
});

test("computer_record video_stop says where it fetched the video in the summary the model sees", async () => {
  const driver: Driver = {
    identity: vi.fn(async () => undefined) as Driver["identity"], close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async name => {
      if (name === "start_recording") return { content: [{ type: "text", text: "{}" }], structuredContent: { video_active: true } };
      if (name === "stop_recording") return { content: [{ type: "text", text: "{}" }], structuredContent: { video_active: false } };
      throw new Error(`Unexpected native call ${name}`);
    }),
  };
  const video = Buffer.from("mp4 bytes");
  const host = { files: async () => ({ windows: "C:\\pi", wsl: "/mnt/c/pi" }), rename: vi.fn(async () => {}), get: vi.fn(async () => video), removeFiles: async () => {} };
  const session = new ComputerSession(driver, () => "yolo", undefined, undefined, undefined, host as unknown as MachineHost);
  const resources = new ComputerResources(async () => session, async () => session.close());
  const workspace = await mkdtemp(join(tmpdir(), "pi-record-"));
  const run = (command: Record<string, unknown>) => computerAction(resources, "computer:machine/local", String(command.action), () => at("computer:machine/local"),
    address => resources.perform(address, workspace, JSON.stringify(command)));
  try {
    expect((await run({ action: "record_start", seconds: 30 })).summary).toContain("Stop it earlier with computer_record video_stop");
    const stopped = await run({ action: "record_stop", to: "out/run.mp4" });
    expect(stopped.summary).toContain("as recording-1.mp4 in the session folder.");
    expect(stopped.summary).toContain(`Fetched it (${video.length} bytes) into ${join(workspace, "out/run.mp4")}.`);
    expect(await readFile(join(workspace, "out/run.mp4"))).toEqual(video);
    expect((await run({ action: "record_stop" })).summary).toContain("list the session folder with computer_files");
  } finally {
    await session.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
test("Write and Insert on a computer address refuse and name the tool that does the operation now", () => {
  expect(computerEditRefusal("write", { path: "computer:observation/o1", content: "hi" })).toMatch(/^Write does not act on computer resources; nothing was sent\. Use computer_type\./);
  for (const [action, tool] of [["click", "computer_click"], ["fill", "computer_type"], ["hotkey", "computer_press"], ["menu", "computer_select"],
    ["open_browser", "computer_open"], ["restore", "computer_window"], ["verify", "computer_wait"], ["navigate", "computer_browser"],
    ["put", "computer_files"], ["clipboard_read", "computer_clipboard"], ["record_start", "computer_record"], ["kill", "Delete"],
    ["setup", "/computer-setup"], ["batch", "Codemode"], ["hold", "computer_press with hold_ms"], ["drag", "computer_drag"]])
    expect(computerEditRefusal("insert", { path: "computer:machine/local", text: JSON.stringify({ action }) })).toContain(`Use ${tool}`);
  // Unknown or unreadable commands still learn where the tools are.
  expect(computerEditRefusal("insert", { path: "computer:session", text: "not json" })).toMatch(/^Insert does not act on computer resources; nothing was sent\. Each operation has its own computer_\* tool: tool_search/);
});
