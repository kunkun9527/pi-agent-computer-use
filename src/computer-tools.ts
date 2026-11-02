import { StringEnum, Type, type JsonValue, type Static } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ComputerRequestError, refKind, type ComputerResources, type InputPlan, type InputPoint } from "./computer-resources.ts";
import type { ComputerAddress } from "./computer-address.ts";
import { resourceRenderers, typedRenderers } from "./computer-renderers.ts";
import { parseComputerViews } from "./computer-views.ts";
import { COMPUTER_DELETE_HELP, computerAction, deleteComputer } from "./provider.ts";
import { fillToolNames, IDE_TOOL_NAMES, type ComputerToolNames } from "./tool-names.ts";

type Action = Awaited<ReturnType<typeof computerAction>>;

/**
 * The namespace every computer_* tool shares. It carries no instructions: the guide reaches the agent with the first
 * read of a computer address in both modes, and tool_search would index instructions into every tool's search text.
 */
export function computerNamespace() {
  return { name: "computer", description: "Read/control native Windows windows and displays using UIA, screenshots and input" };
}
/** Codemode scripts receive the receipt object for every outcome, so they branch on outcome without try/catch. */
export const receiptSchema = Type.Object({ outcome: Type.String(), effect: Type.String() }, { additionalProperties: true });

/** A tool result of one computer action: its summary and images for the model, its receipt for scripts. */
export function actionResult(action: Action) {
  // The receipt is plain data with a few untyped native fields; a JSON copy gives scripts exactly that.
  const receipt: JsonValue = JSON.parse(JSON.stringify(action.script));
  return { content: [{ type: "text" as const, text: action.summary }, ...("images" in action ? action.images ?? [] : [])],
    details: { results: [], metadata: { semanticAction: action.data } }, structuredContent: receipt, ...(action.data.ok ? {} : { isError: true }) };
}

const openParameters = Type.Object({
  at: Type.String({ description: "Machine/sandbox address to launch into, or installed app ref; no browser attachment." }),
  app: Type.Optional(Type.String({ description: "App name from {search} of machine /apps." })),
  path: Type.Optional(Type.String({ description: "Absolute Windows .exe path." })),
  args: Type.Optional(Type.Array(Type.String(), { maxItems: 32, description: "Arguments for path." })),
  sandbox: Type.Optional(Type.Object({
    import: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Object({ host: Type.String(), guest: Type.Optional(Type.String()), writable: Type.Optional(Type.Boolean()) }, { additionalProperties: false })]),
      { maxItems: 8, description: "Shared folders; read-only unless writable." })),
    export: Type.Optional(Type.String({ description: "Writable host output folder." })),
  }, { additionalProperties: false, description: "Disposable Windows Sandbox; {} for no shares." })),
  isolated_session: Type.Optional(Type.Boolean({ description: "Separate Windows desktop/session." })),
}, { additionalProperties: false });

/** Open a native app, Windows Sandbox or isolated desktop. Browser automation is disabled. */
export function openCommand(address: ComputerAddress, params: Static<typeof openParameters>): Record<string, unknown> {
  const { app, path, args, sandbox, isolated_session } = params;
  const chosen = [app !== undefined && "app", path !== undefined && "path",
    sandbox !== undefined && "sandbox", isolated_session === true && "isolated_session"].filter(Boolean);
  if (chosen.length > 1) throw new ComputerRequestError(`Open one thing at a time: ${chosen.join(" and ")} were both given.`);
  if (args !== undefined && path === undefined) throw new ComputerRequestError("args requires path.");
  const what = chosen[0];
  if (address.kind === "window") throw new ComputerRequestError("Browser attachment is disabled; use native window UIA or a browser extension.");
  if (address.kind === "app") {
    if (what) throw new ComputerRequestError("An app address opens that app; give a machine address to open another thing.");
    return { action: "open" };
  }
  if ((address.kind !== "machine" && address.kind !== "sandbox") || (address.kind === "machine" && address.part))
    throw new ComputerRequestError("Open at computer:machine/<name>, a sandbox address or an app address.");
  if (what === "app") return { action: "open", app };
  if (what === "path") return { action: "open", path, ...(args ? { args } : {}) };
  if (address.kind === "sandbox" && what) throw new ComputerRequestError("A sandbox opens apps by app or path.");
  if (what === "sandbox") return { action: "open_sandbox", ...sandbox };
  if (what === "isolated_session") return { action: "open_session" };
  throw new ComputerRequestError("Name what to open: app, path, sandbox or isolated_session.");
}

const windowParameters = Type.Object({
  window: Type.String({ description: "Window ref from {search}/{read} or named address." }),
  action: StringEnum(["move", "resize", "maximize", "minimize", "restore", "name"] as const,
    { description: "restore brings a minimized window back; name gives the window a short address computer:<as>." }),
  as: Type.Optional(Type.String({ description: "Name: 1–32 a-z0-9_-, starting with letter; valid until close." })),
  x: Type.Optional(Type.Integer({ description: "Move left in desktop px." })),
  y: Type.Optional(Type.Integer({ description: "Move top in desktop px." })),
  width: Type.Optional(Type.Integer({ minimum: 1, description: "Resize width in desktop px." })),
  height: Type.Optional(Type.Integer({ minimum: 1, description: "Resize height in desktop px." })),
}, { additionalProperties: false });

/** The window management command of computer_window. */
export function windowCommand(params: Static<typeof windowParameters>): Record<string, unknown> {
  const { window: _window, action, ...fields } = params;
  const wanted = action === "move" ? ["x", "y"] : action === "resize" ? ["width", "height"] : action === "name" ? ["as"] : [];
  const given = Object.keys(fields);
  if (given.some(key => !wanted.includes(key)) || wanted.some(key => !given.includes(key)))
    throw new ComputerRequestError(wanted.length ? `${action} needs ${wanted.join(" and ")} and nothing else.` : `${action} takes no coordinates, size or name.`);
  if (action === "name") return { action, ...fields };
  return { action, ...fields, ...(wanted.length ? { unit: "windows_desktop_pixels" } : {}) };
}

const viewParameters = Type.Object({
  viewport: Type.String({ description: "Window/<name> (1–32 a-z0-9_-, starts with letter). New: x,y,width,height; existing: changed fields." }),
  x: Type.Optional(Type.Integer({ minimum: 0, description: "Left in latest image px." })),
  y: Type.Optional(Type.Integer({ minimum: 0, description: "Top in latest image px." })),
  width: Type.Optional(Type.Integer({ minimum: 1, description: "Width in latest image px." })),
  height: Type.Optional(Type.Integer({ minimum: 1, description: "Height in latest image px." })),
}, { additionalProperties: false });

const displayParameters = Type.Object({
  display: Type.String({ description: "Machine /display/primary or display ref from {read}." }),
  width: Type.Integer({ minimum: 640, maximum: 16384, description: "Width in physical px." }),
  height: Type.Integer({ minimum: 480, maximum: 16384, description: "Height in physical px." }),
}, { additionalProperties: false });

/** Native UIA wait target: a locator string or matching accessibility properties. */
const targetSchema = (description: string) => Type.Union([
  Type.String({ description: "UIA locator, e.g. getByRole('button',{name:'Save'})." }),
  Type.Object({
    ref: Type.Optional(Type.String({ description: "Native ref from latest UI observation." })),
    role: Type.Optional(Type.String()), name: Type.Optional(Type.String({ description: "Accessible name; needs role." })),
    label: Type.Optional(Type.String()), text: Type.Optional(Type.String()), placeholder: Type.Optional(Type.String()), test_id: Type.Optional(Type.String()),
    exact: Type.Optional(Type.Boolean({ description: "Exact match; default case-insensitive substring." })),
  }, { additionalProperties: false }),
], { description });

const waitParameters = Type.Object({
  window: Type.String({ description: "Native window ref/name." }),
  conditions: Type.Array(Type.Object({
    target: Type.Optional(targetSchema("The element the check applies to; omit for aria on the whole window or page, and for url_contains and title.")),
    is: Type.Optional(StringEnum(["exists", "absent", "visible", "hidden", "enabled", "disabled", "selected", "checked", "unchecked", "focused"] as const, { description: "State the target is in." })),
    value: Type.Optional(Type.String({ description: "Exact value/name/text." })),
    contains: Type.Optional(Type.String({ description: "Value/name/text contains." })),
    count: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000, description: "Exact matching element count." })),
    aria: Type.Optional(Type.String({ description: "ARIA snapshot template (target subtree or whole window)." })),
          }, { additionalProperties: false }), { minItems: 1, maxItems: 16, description: "All conditions must hold. One check per condition; whole-window aria needs no target." }),
  mode: Type.Optional(StringEnum(["wait", "check"] as const, { description: "wait (default) polls; check samples once (no timing fields)." })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000, description: "Wait max ms; default 5000." })),
  interval_ms: Type.Optional(Type.Integer({ minimum: 50, maximum: 5000, description: "Poll interval ms; default 250." })),
  stable: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Consecutive matches; default 1." })),
}, { additionalProperties: false });

/** The wait_for or verify command of computer_wait. */
export function waitCommand(params: Static<typeof waitParameters>): Record<string, unknown> {
  const { window: _window, mode, conditions, ...timing } = params;
  if (mode === "check" && Object.keys(timing).length) throw new ComputerRequestError(`check takes one sample, so ${Object.keys(timing).join(", ")} do not apply.`);
  return { action: mode === "check" ? "verify" : "wait_for", conditions, ...timing };
}

const machineSchema = Type.String({ description: "computer:machine/<name>; computer:machine/local is this machine." });

/** A machine address itself, the one place files, clipboard, video and audio commands run. */
function machineAddress(resources: ComputerResources, source: string): ComputerAddress {
  const address = resources.address(source);
  if (address.kind !== "machine" || address.part) throw new ComputerRequestError("Give a machine address such as computer:machine/local or computer:machine/<name>.");
  return address;
}

/** Fields an action takes; any other given field, or a missing required one, refuses the request. */
function fieldsFor(action: string, fields: Record<string, unknown>, allowed: string[], required: string[] = []) {
  const extra = Object.keys(fields).filter(key => fields[key] !== undefined && !allowed.includes(key));
  if (extra.length) throw new ComputerRequestError(`${action} takes no ${extra.join(", ")}.`);
  const missing = required.filter(key => fields[key] === undefined);
  if (missing.length) throw new ComputerRequestError(`${action} needs ${missing.join(" and ")}.`);
}

const filesParameters = Type.Object({
  machine: machineSchema,
  action: StringEnum(["put", "get", "list"] as const, { description: [
    "put: workspace -> session; get: session -> workspace; list: session files/path.",
    "Session folder is temporary.",
  ].join("\n") }),
  from: Type.Optional(Type.String({ description: "put source in workspace." })),
  name: Type.Optional(Type.String({ description: "put: destination name (defaults from); get: source name." })),
  to: Type.Optional(Type.String({ description: "get destination in workspace." })),
}, { additionalProperties: false });

/** The machine command of computer_files. */
export function filesCommand(params: Static<typeof filesParameters>): Record<string, unknown> {
  const { machine: _machine, action, ...fields } = params;
  if (action === "put") fieldsFor(action, fields, ["from", "name"], ["from"]);
  else if (action === "get") fieldsFor(action, fields, ["name", "to"], ["name", "to"]);
  else fieldsFor(action, fields, []);
  return { action: action === "list" ? "files" : action, ...fields };
}

const clipboardParameters = Type.Object({
  machine: machineSchema,
  action: StringEnum(["read", "write"] as const, { description: "read — its formats and text.\nwrite — replace it with text or an image." }),
  include_image: Type.Optional(Type.Boolean({ description: "read: include PNG." })),
  text: Type.Optional(Type.String({ description: "write: text." })),
  image: Type.Optional(Type.String({ description: "write: image workspace path." })),
}, { additionalProperties: false });

/** The machine command of computer_clipboard. */
export function clipboardCommand(params: Static<typeof clipboardParameters>): Record<string, unknown> {
  const { machine: _machine, action, ...fields } = params;
  if (action === "read") {
    fieldsFor(action, fields, ["include_image"]);
    return { action: "clipboard_read", ...(fields.include_image ? { image: true } : {}) };
  }
  fieldsFor(action, fields, ["text", "image"]);
  if ((fields.text === undefined) === (fields.image === undefined)) throw new ComputerRequestError("write needs exactly one of text or image.");
  return { action: "clipboard_write", ...(fields.text !== undefined ? { text: fields.text } : { image: fields.image }) };
}

const recordParameters = Type.Object({
  at: Type.String({ description: "video/audio: machine; sequence: window/display; watch: window/view; watch_stop: returned sequence." }),
  action: StringEnum(["video_start", "video_stop", "audio", "sequence", "watch", "watch_stop"] as const, { description: [
    "video_start/stop: screen recording; audio: playback recording.",
    "sequence: timed window/display frames ({read} frames:); watch: background frames.",
    "watch_stop: end watch and return marked frames.",
  ].join("\n") }),
  seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: "video_start: seconds (1–600); audio: 1–300." })),
  to: Type.Optional(Type.String({ description: "video_stop/audio: output file; watch_stop: frame folder (default temp)." })),
  transcribe: Type.Optional(Type.Boolean({ description: "audio: speech transcript (fallible)." })),
  video: Type.Optional(Type.Boolean({ description: "watch_stop: also save watch.webp." })),
  duration_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 60000, description: "sequence: capture length." })),
  fps: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "sequence/watch FPS; default 4/10." })),
  max_frames: Type.Optional(Type.Integer({ minimum: 1, maximum: 300, description: "sequence: frame limit, default 40." })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 300000, description: "sequence timeout ms >=duration_ms, <=90000, default 15000; watch default 60000." })),
  maxLongEdge: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096, description: "Max frame edge px; watch default 800." })),
  scale: Type.Optional(Type.Number({ minimum: 0.05, maximum: 1, description: "sequence: scale instead of maxLongEdge." })),
  region: Type.Optional(Type.Object({ x: Type.Integer({ minimum: 0 }), y: Type.Integer({ minimum: 0 }), width: Type.Integer({ minimum: 1 }), height: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false, description: "sequence region in local px." })),
}, { additionalProperties: false });

const SEQUENCE_FIELDS = ["duration_ms", "fps", "max_frames", "timeout_ms", "maxLongEdge", "scale", "region"];

/** What computer_record runs: a machine command for video and audio, the Read sequence view of a window or display, or a watch start or stop. */
export type RecordRun = { command: Record<string, unknown> } | { views: string[] }
  | { watch: { fps?: number; timeout_ms?: number; maxLongEdge?: number } } | { stop: { to?: string; video?: boolean } };
export function recordCommand(params: Static<typeof recordParameters>): RecordRun {
  const { at: _at, action, ...fields } = params;
  if (action === "watch") {
    fieldsFor(action, fields, ["fps", "timeout_ms", "maxLongEdge"]);
    return { watch: fields };
  }
  if (action === "watch_stop") {
    fieldsFor(action, fields, ["to", "video"]);
    return { stop: fields };
  }
  if (action === "sequence") {
    fieldsFor(action, fields, SEQUENCE_FIELDS, ["duration_ms"]);
    const views = [`sequence:${JSON.stringify(fields)}`];
    try { parseComputerViews(views); }
    catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
    return { views };
  }
  if (action === "video_start") {
    fieldsFor(action, fields, ["seconds"], ["seconds"]);
    return { command: { action: "record_start", seconds: fields.seconds } };
  }
  if (action === "video_stop") {
    fieldsFor(action, fields, ["to"]);
    return { command: { action: "record_stop", ...fields } };
  }
  fieldsFor(action, fields, ["seconds", "to", "transcribe"], ["seconds"]);
  if (fields.seconds! > 300) throw new ComputerRequestError("audio records at most 300 seconds.");
  return { command: { action: "audio_record", ...fields } };
}

const inputWindow = Type.String({ description: "Window/viewport address from {read}/{search}." });
const inputTarget = (what: string) => Type.Optional(Type.String({ description: `${what}: fresh UIA ref (1:a) or getByRole/getByText locator.` }));
const coordinate = (description: string) => Type.Optional(Type.Number({ minimum: 0, description }));
const pointX = "With y, point in latest window image pixels or browser CSS pixels. Native point input uses foreground.";
const pointY = "With x, point instead of target.";
const pointSpace = Type.Optional(StringEnum(["page", "window"] as const, { description: "Browser: page (default) for DOM; window for native UI." }));
const modifiersField = Type.Optional(Type.Array(StringEnum(["ctrl", "shift", "alt", "win"] as const), { maxItems: 4, description: "Modifier keys." }));
const locatorTimeout = Type.Optional(Type.Integer({ minimum: 0, maximum: 60000, description: "Locator wait ms; default 5000." }));
const PAGE_MODIFIERS: Record<string, string> = { ctrl: "Control", shift: "Shift", alt: "Alt", win: "Meta" };

type Endpoint = { target?: string; x?: number; y?: number };
/** The target or point of an action; required unless the action can go to the focused element. */
function aim(params: Endpoint, label: string, required: boolean): Pick<InputPlan, "target" | "point"> {
  if ((params.x === undefined) !== (params.y === undefined)) throw new ComputerRequestError(`${label} needs both x and y for a point.`);
  const point = params.x !== undefined ? { x: params.x, y: params.y! } : undefined;
  if (point && params.target !== undefined) throw new ComputerRequestError(`${label} takes a target or a point, not both.`);
  if (required && !point && params.target === undefined) throw new ComputerRequestError(`${label} needs a target or a point (x and y).`);
  return { ...(params.target !== undefined ? { target: params.target } : {}), ...(point ? { point } : {}) };
}
/** Fields every input plan shares. */
const shared = (params: { space?: "page" | "window" }) => ({ ...(params.space ? { space: params.space } : {}) });
const timeout = (params: { timeout_ms?: number }) => params.timeout_ms !== undefined ? { timeout_ms: params.timeout_ms } : {};
const pageModifiers = (modifiers?: string[]) => modifiers?.length ? { modifiers: modifiers.map(key => PAGE_MODIFIERS[key]) } : {};
/** A Playwright key name for a key the native tools also take, such as ctrl, return, up or f5. */
function pageKey(key: string): string {
  const lower = key.toLowerCase();
  return PAGE_MODIFIERS[lower === "control" ? "ctrl" : lower] ?? PAGE_KEYS[lower] ?? (/^f\d{1,2}$/.test(lower) ? lower.toUpperCase() : key);
}
/** A target inside a page timeline: a page ref, or a Playwright locator string. */
const pageTarget = (target: string) => refKind(target) === "page" ? { ref: target } : target;
/** A move of a page timeline to a point or to the centre of a target. */
const pageMove = (at_ms: number, to: { target?: string; point?: InputPoint }, steps?: number) =>
  ({ at_ms, type: "move", ...(to.target !== undefined ? { target: pageTarget(to.target) } : to.point), ...(steps ? { steps } : {}) });
/** Keys held around a page timeline's events. */
function holding(modifiers: string[] | undefined, start: number, end: number, events: Record<string, unknown>[]) {
  const keys = (modifiers ?? []).map(key => PAGE_MODIFIERS[key]);
  return [...keys.map(key => ({ at_ms: start, type: "key_down", key })), ...events, ...keys.reverse().map(key => ({ at_ms: end, type: "key_up", key }))];
}

const clickParameters = Type.Object({
  window: inputWindow, target: inputTarget("The element to click"), x: coordinate(pointX), y: coordinate(pointY), space: pointSpace,
  button: Type.Optional(StringEnum(["left", "right", "middle"] as const, { description: "Default left." })),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: "Click count; default 1." })),
  modifiers: modifiersField, timeout_ms: locatorTimeout,
}, { additionalProperties: false });

/** What computer_click sends to a native window and to a browser page. */
export function clickPlan(params: Static<typeof clickParameters>): InputPlan {
  const count = params.count ?? 1, button = params.button ?? "left", modifiers = params.modifiers?.length ? { modifiers: params.modifiers } : {};
  // A native window gets the driver's own single, right and double clicks; every other multi-click is its click with a count.
  const native = count === 1 ? button === "right" ? { action: "right_click", ...modifiers, ...timeout(params) } : { action: "click", ...(button === "middle" ? { button } : {}), ...modifiers, ...timeout(params) }
    : count === 2 && button === "left" ? { action: "double_click", ...modifiers, ...timeout(params) }
    : { action: "click", ...(button !== "left" ? { button } : {}), count, ...modifiers, ...timeout(params) };
  const aimed = aim(params, "click", true);
  // A point of a page gets the presses Playwright's mouse.click sends, numbered so the page sees double and triple clicks.
  const presses = Array.from({ length: count }, (_, index) => [{ at_ms: 0, type: "button_down", button, click_count: index + 1 }, { at_ms: 0, type: "button_up", button, click_count: index + 1 }]).flat();
  return { label: "click", ...aimed, ...shared(params), native,
    web: aimed.point ? { action: "timeline", events: holding(params.modifiers, 0, 0, [pageMove(0, aimed), ...presses]) }
      : { action: "click", ...(button !== "left" ? { button } : {}), ...(count > 1 ? { click_count: count } : {}), ...pageModifiers(params.modifiers), ...timeout(params) } };
}

const hoverParameters = Type.Object({
  window: inputWindow, target: inputTarget("The element to point at"), x: coordinate(pointX), y: coordinate(pointY), space: pointSpace,
  dwell_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000, description: "Native dwell ms; default 300." })),
  timeout_ms: locatorTimeout,
}, { additionalProperties: false });

/** What computer_hover sends; on a native window it moves the real pointer, so it runs in the foreground. */
export function hoverPlan(params: Static<typeof hoverParameters>): InputPlan {
  const aimed = aim(params, "hover", true);
  return { label: "hover", ...aimed, ...shared(params), native: { action: "hover", dwell_ms: params.dwell_ms ?? 300, ...timeout(params) },
    web: aimed.point ? { action: "timeline", events: [pageMove(0, aimed)] } : { action: "hover", ...timeout(params) } };
}

const endpoint = (what: string) => Type.Object({
  target: Type.Optional(Type.String({ description: `${what}: fresh element ref or page locator.` })),
  x: Type.Optional(Type.Number({ minimum: 0 })), y: Type.Optional(Type.Number({ minimum: 0 })),
}, { additionalProperties: false, description: `${what}: target or x,y point (window image/browser CSS pixels).` });
const dragParameters = Type.Object({
  window: inputWindow, from: endpoint("Where the drag starts"), to: endpoint("Where the drag ends"), space: pointSpace,
  via: Type.Optional(Type.Array(Type.Object({ x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }) }, { additionalProperties: false }),
    { minItems: 1, maxItems: 254, description: "Points the pointer passes through on the way, in order, for a path rather than a straight line; left button only." })),
  duration_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000, description: "Drag duration ms; default 500." })),
  button: Type.Optional(StringEnum(["left", "right", "middle"] as const, { description: "Default left." })),
  modifiers: modifiersField,
}, { additionalProperties: false });

/** What computer_drag sends: a native drag, or a page timeline that presses, moves and releases. */
export function dragPlan(params: Static<typeof dragParameters>): InputPlan {
  const start = aim(params.from, "from", true), end = aim(params.to, "to", true);
  // On a page the drag is a timeline: press at the start, move through via to the end over duration_ms, release.
  const duration = params.duration_ms ?? 500, button = params.button ?? "left";
  const stops = [...(params.via ?? []).map(point => ({ point })), end];
  const steps = Math.max(1, Math.round(duration / stops.length / 16));
  const web = { action: "timeline", events: holding(params.modifiers, 0, duration, [pageMove(0, start), { at_ms: 0, type: "button_down", button },
    ...stops.map((stop, index) => pageMove(Math.round(duration * (index + 1) / stops.length), stop, steps)), { at_ms: duration, type: "button_up", button }]) };
  return { label: "drag", ...start, end, ...shared(params), web,
    native: { action: "drag", ...(params.duration_ms !== undefined ? { duration_ms: params.duration_ms } : {}), ...(params.button && params.button !== "left" ? { button: params.button } : {}),
      ...(params.modifiers?.length ? { modifiers: params.modifiers } : {}), ...(params.via ? { via: params.via } : {}) } };
}

const scrollParameters = Type.Object({
  window: inputWindow, target: inputTarget("The element to scroll; omit for the middle of the window or page"), x: coordinate(pointX), y: coordinate(pointY), space: pointSpace,
  delta_x: Type.Optional(Type.Integer({ minimum: -50, maximum: 50, description: "Wheel notches: positive right." })),
  delta_y: Type.Optional(Type.Integer({ minimum: -50, maximum: 50, description: "Wheel notches: positive down; browser notch ≈100px." })),
  timeout_ms: locatorTimeout,
}, { additionalProperties: false });

/** What computer_scroll sends: wheel notches at a point, or an accessibility scroll of a native element target. */
export function scrollPlan(params: Static<typeof scrollParameters>): InputPlan {
  const dx = params.delta_x ?? 0, dy = params.delta_y ?? 0;
  if (!dx && !dy) throw new ComputerRequestError("scroll needs delta_x or delta_y.");
  const aimed = aim(params, "scroll", false);
  const native = aimed.target === undefined ? { action: "scroll", ...(dx ? { delta_x: dx } : {}), ...(dy ? { delta_y: dy } : {}), unit: "wheel_detents" }
    : dx && dy ? "Scroll a native element along one axis at a time, or give a point."
    : { action: "scroll", direction: dy > 0 ? "down" : dy < 0 ? "up" : dx > 0 ? "right" : "left", amount: Math.abs(dx || dy), ...timeout(params) };
  return { label: "scroll", ...aimed, ...shared(params), native,
    web: aimed.point ? { action: "timeline", events: [pageMove(0, aimed), { at_ms: 0, type: "wheel", ...(dx ? { dx: dx * 100 } : {}), ...(dy ? { dy: dy * 100 } : {}) }] }
      : { action: "scroll", ...(dx ? { delta_x: dx * 100 } : {}), ...(dy ? { delta_y: dy * 100 } : {}), ...timeout(params) } };
}

const typeParameters = Type.Object({
  window: inputWindow, text: Type.String({ maxLength: 20000, description: "Literal text. Native typing uses foreground keys (max 2000 chars); replace uses UIA." }),
  target: inputTarget("The field to type into; omit for the focused element"), space: pointSpace,
  replace: Type.Optional(Type.Boolean({ description: "Replace whole value; requires target." })),
  submit: Type.Optional(Type.Boolean({ description: "Enter after typing." })),
  delay_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 200, description: "Native inter-key delay ms." })),
  timeout_ms: locatorTimeout,
}, { additionalProperties: false });

/** What computer_type sends, with Enter as a second step when submit is set. */
export function typePlan(params: Static<typeof typeParameters>): InputPlan {
  if (params.replace && params.target === undefined) throw new ComputerRequestError("replace needs the field as target.");
  // Enter goes to the same field: a semantic replace does not move the keyboard focus there.
  const enter: InputPlan = { label: "submit", ...(params.target !== undefined ? { target: params.target } : {}), ...shared(params), native: { action: "key", key: "return", ...timeout(params) }, web: { action: "press", key: "Enter", ...timeout(params) } };
  return { label: "type", ...aim(params, "type", false), ...shared(params),
    native: params.replace ? { action: "set_value", text: params.text, ...timeout(params) } : { action: "type_text", text: params.text, ...(params.delay_ms !== undefined ? { delay_ms: params.delay_ms } : {}), ...timeout(params) },
    web: params.delay_ms !== undefined ? "delay_ms applies to native windows." : { action: params.replace ? "fill" : "type", text: params.text, ...timeout(params) },
    ...(params.submit ? { then: enter } : {}) };
}

const pressParameters = Type.Object({
  window: inputWindow, key: Type.String({ maxLength: 64, description: "Key/chord, e.g. Enter, ctrl+s, shift+Tab. Native keys take foreground." }),
  target: inputTarget("The element to focus first; omit for the focused element"), space: pointSpace,
  hold_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000, description: "Native key-hold ms." })),
}, { additionalProperties: false });
const PAGE_KEYS: Record<string, string> = { enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape", tab: "Tab", space: "Space", backspace: "Backspace", delete: "Delete", del: "Delete",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", pgup: "PageUp", pgdn: "PageDown" };

/** What computer_press sends: one key or chord, or keys held for hold_ms on a native window. */
export function pressPlan(params: Static<typeof pressParameters>): InputPlan {
  const parts = params.key.split("+").map(part => part.trim());
  if (parts.some(part => !part)) throw new ComputerRequestError("key joins a key and its modifiers with +, such as ctrl+s.");
  const key = parts.at(-1)!, held = parts.slice(0, -1).map(part => part.toLowerCase().replace(/^(control)$/, "ctrl").replace(/^(meta|windows|cmd)$/, "win"));
  if (held.some(part => !PAGE_MODIFIERS[part])) throw new ComputerRequestError("Modifiers are ctrl, shift, alt and win.");
  const native = params.hold_ms !== undefined ? { action: "hold", keys: [...held, key.toLowerCase()], duration_ms: params.hold_ms }
    // A chord goes as a hotkey: posted key messages do not carry modifier state, so the app would see the bare key.
    : held.length ? { action: "hotkey", keys: [...held, key.toLowerCase()] } : { action: "key", key: key.toLowerCase() };
  const keys = [...held.map(part => PAGE_MODIFIERS[part]), pageKey(key)];
  const aimed = aim(params, "press", false);
  if (params.hold_ms !== undefined && aimed.target !== undefined) throw new ComputerRequestError("hold_ms goes to the focused element; focus it with computer_click first.");
  return { label: "press", ...aimed, ...shared(params), native,
    web: params.hold_ms !== undefined ? { action: "timeline", events: [...keys.map(name => ({ at_ms: 0, type: "key_down", key: name })), ...[...keys].reverse().map(name => ({ at_ms: params.hold_ms!, type: "key_up", key: name }))] }
      : { action: "press", key: keys.join("+") } };
}

const selectParameters = Type.Object({
  window: inputWindow, target: inputTarget("The list, select, checkbox or option; not used with menu"), space: pointSpace,
  values: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 64, description: "Option labels/values; native list accepts one. Omit to select target." })),
  checked: Type.Optional(Type.Boolean({ description: "Desired checkbox/radio/toggle state." })),
  menu: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 16, description: "Native menu path, e.g. [\"File\",\"Save As...\"]." })),
  timeout_ms: locatorTimeout,
}, { additionalProperties: false });

/** What computer_select sends: options of a list, a checked state, or a menu item. */
export function selectPlan(params: Static<typeof selectParameters>): InputPlan {
  const chosen = [params.values && "values", params.checked !== undefined && "checked", params.menu && "menu"].filter(Boolean);
  if (chosen.length > 1) throw new ComputerRequestError(`select takes one of values, checked or menu, not ${chosen.join(" and ")}.`);
  if (params.menu) {
    if (params.target !== undefined) throw new ComputerRequestError("menu names its item by path; omit target.");
    return { label: "select", ...shared(params), native: { action: "menu", path: params.menu }, web: "menu works on native windows; use a target on browser pages." };
  }
  if (params.target === undefined) throw new ComputerRequestError("select needs a target.");
  const base = { label: "select", target: params.target, ...shared(params) };
  if (params.checked !== undefined) return { ...base, native: { action: params.checked ? "check" : "uncheck", ...timeout(params) }, web: { action: params.checked ? "check" : "uncheck", ...timeout(params) } };
  if (params.values) return { ...base, native: params.values.length > 1 ? "A native list takes one value at a time." : { action: "select", option: params.values[0], ...timeout(params) },
    web: { action: "select", values: params.values, ...timeout(params) } };
  return { ...base, native: { action: "select", ...timeout(params) }, web: "Give values: the options to choose in this select element." };
}

const timelineParameters = Type.Object({
  window: inputWindow, space: pointSpace,
  events: Type.Array(Type.Object({
    at_ms: Type.Integer({ minimum: 0, maximum: 120000, description: "Time from the start; never decreases." }),
    type: StringEnum(["key_down", "key_up", "button_down", "button_up", "move", "move_relative", "wheel", "pen_down", "pen_move", "pen_up"] as const),
    key: Type.Optional(Type.String({ description: "key_down, key_up." })),
    button: Type.Optional(StringEnum(["left", "right", "middle", "x1", "x2"] as const, { description: "button_down, button_up; default left." })),
    x: Type.Optional(Type.Number({ minimum: 0, description: "move and pen events: pixels of the window's latest image." })),
    y: Type.Optional(Type.Number({ minimum: 0 })),
    dx: Type.Optional(Type.Integer({ description: "move_relative: raw mouse counts; wheel: notches." })),
    dy: Type.Optional(Type.Integer()),
    pressure: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Pen events." })),
    tilt_x: Type.Optional(Type.Integer({ minimum: -90, maximum: 90 })), tilt_y: Type.Optional(Type.Integer({ minimum: -90, maximum: 90 })),
    eraser: Type.Optional(Type.Boolean()), barrel: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 5000, description: "Timed events. Every key and button pressed must be released; anything still held is released when the call ends." }),
}, { additionalProperties: false });

/** What computer_timeline sends: native events in the foreground, or page events in CSS pixels through Playwright and CDP. */
export function timelinePlan(params: Static<typeof timelineParameters>): InputPlan {
  const native = params.events.find(event => event.type === "move_relative" || event.eraser || event.barrel || event.button === "x1" || event.button === "x2");
  const web = native ? `${native.type === "move_relative" ? "move_relative" : native.eraser ? "The pen eraser" : native.barrel ? "The pen barrel button" : `Button ${native.button}`} needs native input: give space: "window" and points in pixels of the window's latest image.`
    : { action: "timeline", events: params.events.map(({ eraser: _eraser, barrel: _barrel, ...event }) => ({ ...event,
      ...(event.key !== undefined ? { key: pageKey(event.key) } : {}),
      ...(event.type === "wheel" ? { ...(event.dx ? { dx: event.dx * 100 } : {}), ...(event.dy ? { dy: event.dy * 100 } : {}) } : {}) })) };
  return { label: "timeline", ...shared(params), native: { action: "timeline", events: params.events }, web };
}
/**
 * Register the typed computer_* tools, one per operation cluster. They are deferred: a
 * tool_search for computer loads them, so sessions that never use the computer pay nothing for them.
 */
export function registerComputerTools(pi: ExtensionAPI, resources: ComputerResources, names: ComputerToolNames = IDE_TOOL_NAMES): void {
  const namespace = computerNamespace();
  const common = { exposure: "deferred" as const, namespace, outputSchema: receiptSchema };
  const describe = (source: string) => resources.describe(source);
  const rendered = (name: string) => typedRenderers(name, describe);
  pi.registerTool({
    ...common, name: "computer_open", label: "Computer open",
    description: "Open native apps, Windows Sandbox or isolated sessions (no browser automation).",
    parameters: fillToolNames(openParameters, names),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    ...rendered("computer_open"),
    async execute(_id, params, signal, _update, ctx) {
      let command: Record<string, unknown> = {};
      return actionResult(await computerAction(resources, params.at, "open", () => {
        const address = resources.address(params.at);
        if (address.kind === "window") throw new ComputerRequestError("Browser attachment is disabled. Use native UIA tools or your browser extension.");
        command = openCommand(address, params);
        return address;
      }, address => resources.perform(address, ctx.cwd, JSON.stringify(command), signal)));
    },
  });
  pi.registerTool({
    ...common, name: "computer_window", label: "Computer window",
    description: "Move/resize/minimize/maximize/restore/name a window.",
    parameters: fillToolNames(windowParameters, names),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    ...rendered("computer_window"),
    async execute(_id, params, signal, _update, ctx) {
      let command: Record<string, unknown> = {};
      return actionResult(await computerAction(resources, params.window, params.action, () => {
        command = windowCommand(params);
        return resources.address(params.window);
      }, address => command.action === "name" ? resources.name(address, ctx.cwd, command.as, signal) : resources.manageWindow(address, ctx.cwd, command, signal)));
    },
  });
  pi.registerTool({
    ...common, name: "computer_view", label: "Computer view",
    description: fillToolNames("Create/update a named viewport; use its address for reads and input.", names),
    parameters: fillToolNames(viewParameters, names),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...rendered("computer_view"),
    async execute(_id, params, signal, _update, ctx) {
      const { viewport, ...rect } = params;
      return actionResult(await computerAction(resources, viewport, "view", () => resources.address(viewport),
        address => resources.view(address, ctx.cwd, rect, signal)));
    },
  });
  pi.registerTool({
    ...common, name: "computer_wait", label: "Computer wait",
    description: "Wait for UI conditions or check once; no input.",
    parameters: fillToolNames(waitParameters, names),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...rendered("computer_wait"),
    async execute(_id, params, signal, _update, ctx) {
      let command: Record<string, unknown> = {};
      return actionResult(await computerAction(resources, params.window, params.mode === "check" ? "verify" : "wait_for", () => {
        command = waitCommand(params);
        const address = resources.address(params.window);
        if (address.kind !== "window") throw new ComputerRequestError(`computer_wait needs a window address from ${names.search}, ${names.read} or a name.`);
        return address;
      }, address => resources.perform(address, ctx.cwd, JSON.stringify(command), signal)));
    },
  });
  pi.registerTool({
    ...common, name: "computer_files", label: "Computer files",
    description: "List or transfer session files.",
    parameters: fillToolNames(filesParameters, names),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    ...rendered("computer_files"),
    async execute(_id, params, signal, _update, ctx) {
      let command: Record<string, unknown> = {};
      return actionResult(await computerAction(resources, params.machine, params.action, () => {
        command = filesCommand(params);
        return machineAddress(resources, params.machine);
      }, address => resources.perform(address, ctx.cwd, JSON.stringify(command), signal)));
    },
  });
  pi.registerTool({
    ...common, name: "computer_clipboard", label: "Computer clipboard",
    description: "Read/write clipboard text or image.",
    parameters: fillToolNames(clipboardParameters, names),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    ...rendered("computer_clipboard"),
    async execute(_id, params, signal, _update, ctx) {
      let command: Record<string, unknown> = {};
      return actionResult(await computerAction(resources, params.machine, `clipboard_${params.action}`, () => {
        command = clipboardCommand(params);
        return machineAddress(resources, params.machine);
      }, address => resources.perform(address, ctx.cwd, JSON.stringify(command), signal)));
    },
  });
  pi.registerTool({
    ...common, name: "computer_record", label: "Computer record",
    description: "Record video/audio, timed frames or watch a window.",
    parameters: fillToolNames(recordParameters, names),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    ...rendered("computer_record"),
    async execute(_id, params, signal, _update, ctx) {
      let run: RecordRun = { command: {} };
      return actionResult(await computerAction(resources, params.at, params.action, () => {
        run = recordCommand(params);
        if ("watch" in run || "stop" in run) return resources.address(params.at);
        if ("views" in run) {
          const address = resources.address(params.at);
          if (address.kind !== "window" && address.kind !== "display") throw new ComputerRequestError("sequence captures a window or display address.");
          return address;
        }
        return machineAddress(resources, params.at);
      }, async address => "watch" in run ? resources.watch(address, ctx.cwd, run.watch, signal)
        : "stop" in run ? resources.stopWatch(address, ctx.cwd, run.stop, signal)
        : "views" in run ? (await resources.sequence(address, ctx.cwd, run.views, signal))!
        : resources.perform(address, ctx.cwd, JSON.stringify(run.command), signal)));
    },
  });
  /** Run one typed input on a window: the plan is built and checked before anything reaches the machine. */
  const input = async (window: string, action: string, build: () => InputPlan, cwd: string, signal?: AbortSignal) => {
    let plan: InputPlan | undefined;
    return actionResult(await computerAction(resources, window, action, () => { plan = build(); return resources.address(window); },
      address => resources.input(address, cwd, plan!, signal)));
  };
  const aimed = (args: Record<string, unknown>) => args.target !== undefined ? String(args.target) : args.x !== undefined ? `${args.x},${args.y}` : "";
  const inputAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  pi.registerTool({
    ...common, name: "computer_click", label: "Computer click",
    description: "Click a UI target or point.",
    parameters: fillToolNames(Type.Omit(clickParameters, ["space"]), names), annotations: inputAnnotations,
    ...rendered("computer_click"),
    async execute(_id, params, signal, _update, ctx) { return input(params.window, "click", () => clickPlan(params), ctx.cwd, signal); },
  });
  pi.registerTool({
    ...common, name: "computer_hover", label: "Computer hover",
    description: "Hover over target or point.",
    parameters: fillToolNames(Type.Omit(hoverParameters, ["space"]), names), annotations: inputAnnotations,
    ...rendered("computer_hover"),
    async execute(_id, params, signal, _update, ctx) { return input(params.window, "hover", () => hoverPlan(params), ctx.cwd, signal); },
  });
  pi.registerTool({
    ...common, name: "computer_drag", label: "Computer drag",
    description: "Drag between points/targets, optionally via path.",
    parameters: fillToolNames(Type.Omit(dragParameters, ["space"]), names), annotations: inputAnnotations,
    ...rendered("computer_drag"),
    async execute(_id, params, signal, _update, ctx) { return input(params.window, "drag", () => dragPlan(params), ctx.cwd, signal); },
  });
  pi.registerTool({
    ...common, name: "computer_scroll", label: "Computer scroll",
    description: "Scroll target, point or window/page.",
    parameters: fillToolNames(Type.Omit(scrollParameters, ["space"]), names), annotations: inputAnnotations,
    ...rendered("computer_scroll"),
    async execute(_id, params, signal, _update, ctx) { return input(params.window, "scroll", () => scrollPlan(params), ctx.cwd, signal); },
  });
  pi.registerTool({
    ...common, name: "computer_type", label: "Computer type",
    description: "Type or replace field text.",
    parameters: fillToolNames(Type.Omit(typeParameters, ["space"]), names), annotations: inputAnnotations,
    ...rendered("computer_type"),
    async execute(_id, params, signal, _update, ctx) { return input(params.window, "type", () => typePlan(params), ctx.cwd, signal); },
  });
  pi.registerTool({
    ...common, name: "computer_press", label: "Computer press",
    description: "Press a key/chord or hold keys.",
    parameters: fillToolNames(Type.Omit(pressParameters, ["space"]), names), annotations: inputAnnotations,
    ...rendered("computer_press"),
    async execute(_id, params, signal, _update, ctx) { return input(params.window, "press", () => pressPlan(params), ctx.cwd, signal); },
  });
  pi.registerTool({
    ...common, name: "computer_select", label: "Computer select",
    description: "Select options, toggle controls or open a menu.",
    parameters: fillToolNames(Type.Omit(selectParameters, ["space"]), names), annotations: inputAnnotations,
    ...rendered("computer_select"),
    async execute(_id, params, signal, _update, ctx) { return input(params.window, "select", () => selectPlan(params), ctx.cwd, signal); },
  });
  pi.registerTool({
    ...common, name: "computer_timeline", label: "Computer timeline",
    description: "Run timed key/pointer/wheel/pen events.",
    parameters: fillToolNames(Type.Omit(timelineParameters, ["space"]), names), annotations: inputAnnotations,
    ...rendered("computer_timeline"),
    async execute(_id, params, signal, _update, ctx) { return input(params.window, "timeline", () => timelinePlan(params), ctx.cwd, signal); },
  });
  pi.registerTool({
    ...common, name: "computer_display", label: "Computer display",
    description: "Change display resolution (restored on close).",
    parameters: fillToolNames(displayParameters, names),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    ...rendered("computer_display"),
    async execute(_id, params, signal, _update, ctx) {
      return actionResult(await computerAction(resources, params.display, "resize", () => resources.address(params.display),
        address => resources.perform(address, ctx.cwd, JSON.stringify({ action: "resize", width: params.width, height: params.height }), signal)));
    },
  });
}

/** Delete for computer resources when Pi Agent IDE is absent: the IDE's Delete handles them otherwise. */
export function registerComputerDelete(pi: ExtensionAPI, resources: ComputerResources): void {
  pi.registerTool({
    name: "computer_delete", label: "Computer delete", exposure: "deferred", namespace: computerNamespace(), outputSchema: receiptSchema,
    description: "Close windows or release computer resources.",
    parameters: Type.Object({ path: Type.String({ description: COMPUTER_DELETE_HELP }) }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    ...resourceRenderers("computer_delete", resource => resources.describe(resource)),
    async execute(_id, params, signal, _update, ctx) {
      return actionResult(await deleteComputer(resources, params.path, params, ctx.cwd, signal));
    },
  });
}
