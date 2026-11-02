import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin, READ_PROTOCOL, READ_API_VERSION } from "pi-agent-ide/api/read";
import { connectSearchPlugin, SEARCH_PROTOCOL, SEARCH_API_VERSION } from "pi-agent-ide/api/search";
import { connectTextEditorPlugin, TEXT_EDITOR_PROTOCOL, TEXT_EDITOR_API_VERSION } from "pi-agent-ide/api/text-editor";
import type { ResourceResolver } from "pi-agent-ide/api/resource";
import { connectAgentDocumentation } from "pi-agent-ide/api/documentation";
import { registerIdeCapability } from "pi-agent-ide/api/capabilities";
import { readFile } from "node:fs/promises";
import { ComputerResources, computerResultText, ComputerRequestError, FORCE, LOCAL_MACHINE, type SandboxFactory, type MachineFactory } from "./computer-resources.ts";
import { computerSource, displaySource, type ComputerAddress } from "./computer-address.ts";
import { REMOTE_DESKTOP_DISPLAY } from "./display-mode.ts";
import type { WebLogEntry } from "./web-browser.ts";
import { diffIsEmpty, type PixelReport, type StateDiff } from "./successor.ts";
import type { PixelBox } from "./pixel-diff.ts";
import { computerActionRenderer, computerReadRenderer, computerSearchRenderer } from "./computer-renderers.ts";
import type { ComputerSession, ComputerResult, ComputerMode, Content } from "./session.ts";
import { fillToolNames, IDE_TOOL_NAMES, type ComputerToolNames } from "./tool-names.ts";

const owns = (source: unknown): source is string => typeof source === "string" && source.startsWith("computer:");
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (value: unknown) => typeof value === "string" ? value.replace(/[\r\n\t]/g, " ").slice(0, 1024) : "";

/** Agent guidance shared by the IDE plugin and the standalone tools, one form per line like the IDE's own field lines. */
export const computerPathHelp = (names: ComputerToolNames) => [
  `computer:machine/<name> — machine; /windows and /apps via ${names.search}; /displays for screens.`,
  `computer:window/… — window from ${names.search}; UI tree and screenshot. Named: computer:<name>.`,
  `computer:window/…/<viewport> — named cropped view from computer_view.`,
  `computer:observation/… — prior ${names.read}; computer:sequence/… — frames.`,
  "computer:session — current resources. Use fresh refs; docs:computer explains more.",
].join("\n");
export const computerViewsHelp = (names: ComputerToolNames) => [
  "Window: full (default), image, ui, aria, changes; state alone. No browser DOM.",
  "Extras: ocr, regions, element:inspect|scope|highlight|crop|text,<ref>, region:x,y,w,h.",
  `Capture: capture:{maxLongEdge,scale,max_elements,max_depth,hints} in ${names.read}.`,
  "Frames: frames:first|last|all|endpoints|changed or frames:{indexes|from,to,as:sheet|max|min}.",
].join("\n");
export const COMPUTER_SEARCH_HELP = "computer:machine/<name>/windows or /apps, or an observation address.";
export const COMPUTER_DELETE_HELP = "computer:window/… closes that window (?force=true kills its hung app if this session opened it); computer:sandbox/…, computer:machine/<name> and computer:session release what they name.";
/** Each Insert command the typed tools replaced, by the tool that does it now. */
const REPLACED: [RegExp, string][] = [
  [/^(click|double_click|right_click|invoke|check|uncheck)$/, "computer_click"], [/^(type_text|type|fill|set_value)$/, "computer_type"],
  [/^(key|hotkey|press)$/, "computer_press"], [/^hold$/, "computer_press with hold_ms"], [/^(scroll|wheel)$/, "computer_scroll"], [/^drag$/, "computer_drag"], [/^(hover|move_pointer)$/, "computer_hover"],
  [/^(select|select_option|menu)$/, "computer_select"], [/^(timeline|sequence)$/, "computer_timeline"],
  [/^(open|open_sandbox|open_session)$/, "computer_open"],
  [/^(move|resize|minimize|maximize|restore|name)$/, "computer_window (a pointer move: computer_hover; resize of a display: computer_display)"], [/^(wait_for|verify)$/, "computer_wait"],
  [/^(put|get|files)$/, "computer_files"], [/^clipboard_/, "computer_clipboard"], [/^(record_start|record_stop|audio_record)$/, "computer_record"],
  [/^(close|kill)$/, "Delete (kill: Delete with ?force=true)"], [/^setup$/, "/computer-setup, which only the user runs (ask them)"], [/^batch$/, "Codemode: a script that calls the computer_* tools in order"],
];
/** Why Write or Insert refuses a computer address, naming the tool that does what it was sent. */
export function computerEditRefusal(tool: "write" | "insert", input: Record<string, unknown>): string {
  let action: unknown = tool === "write" ? "type_text" : undefined;
  if (tool === "insert" && typeof input.text === "string") try { action = (JSON.parse(input.text) as { action?: unknown })?.action; } catch { /* no action to map */ }
  const replacement = typeof action === "string" ? REPLACED.find(([pattern]) => pattern.test(action as string))?.[1] : undefined;
  return `${tool === "write" ? "Write" : "Insert"} does not act on computer resources; nothing was sent. ${replacement ? `Use ${replacement}. ` : ""}Each operation has its own computer_* tool: tool_search loads them with "computer open window", "computer click hover drag scroll", "computer type press select timeline", "computer wait browser", "computer files clipboard record" or "computer view viewport".`;
}

/** Present native resources without dumping provenance; full receipts remain in structured data. */
export function presentComputerResult(result: ComputerResult, full = false): string {
  const d = result.details, state = d.state ?? {};
  // Every routed receipt names the machine (and sandbox) it ran on.
  const lines = [`Computer ${d.status} (${d.mode})${d.machine ? ` on ${d.machine}${d.sandbox ? `, sandbox ${d.sandbox}` : ""}` : ""}`];
  if (d.window_ref) lines.push(`Window: ${computerSource("window", d.window_ref)}`);
  if (d.viewport) lines.push(`Viewport: ${d.viewport.source}; points on it are pixels of its ${d.viewport.image.width}x${d.viewport.image.height} image`);
  if (d.window_state_id && d.status === "observed") {
    const sample = d.window_state_kind === "management" ? record(state.state) : state;
    lines.push(`Window state: minimized=${sample.minimized}, visible=${sample.visible}; foreground=${sample.foreground_at_target}, keyboard_focus=${sample.keyboard_focus_at_target}${d.window_state_kind === "management" ? `; maximized=${sample.maximized}` : ""}`);
    if (d.window_state_kind === "management") {
      lines.push(`Bounds: ${JSON.stringify(sample.bounds)}; source=${sample.bounds_source}; unit=${sample.coordinate_space}`,
        `Current virtual desktop: ${record(sample.virtual_desktop).on_current_desktop}`);
    }
  }
  const invalidManagement = state.code === "tool_output_invalid" ? record(state.invalid_output) : {};
  const management = typeof state.mutation_attempted === "boolean" ? state : invalidManagement;
  if (typeof management.mutation_attempted === "boolean") {
    const measured = record(management.observed), unvalidated = management === invalidManagement;
    lines.push(`${unvalidated ? "Unvalidated" : "Native"} management: ${management.operation}; mutation_attempted=${management.mutation_attempted}, mutation_accepted=${management.mutation_accepted}, postcondition_confirmed=${management.postcondition_confirmed}`,
      `Requested bounds: ${JSON.stringify(management.requested_bounds)}; observed bounds: ${JSON.stringify(measured.bounds ?? null)}; source=${measured.bounds_source ?? "unavailable"}`,
      `${unvalidated ? "Reported" : "Measured"} state: minimized=${measured.minimized}, maximized=${measured.maximized}, visible=${measured.visible}; foreground=${measured.foreground_at_target}, keyboard_focus=${measured.keyboard_focus_at_target}`);
    if (unvalidated) lines.push("The native schema rejected this payload. Keep outcome unknown; do not treat its reported completion as validated success.");
  }
  if (typeof state.restore_attempted === "boolean") {
    lines.push(`Native restore prefix: restore_attempted=${state.restore_attempted}, restore_requested=${state.restore_requested}, restored=${state.restored}`,
      `Activation: activation_attempted=${state.activation_attempted}, activation_succeeded=${state.activation_succeeded}; foreground_changed=${state.foreground_changed}`,
      `Measured state: visible=${state.visible}; foreground=${state.foreground_at_target}, keyboard_focus=${state.keyboard_focus_at_target}`);
  }
  const id = d.observation_id ?? d.agent_image?.image_id;
  if (typeof id === "string" && (d.status === "observed" || d.dom && d.status === "delivered")) lines.push(`Observation: ${computerSource("observation", id)}`);
  if (d.agent_image) {
    const image = d.agent_image, output = record(image.output), configuration = record(image.configuration);
    lines.push(`Image: ${output.width}x${output.height} ${label(output.mimeType)}; ${label(image.route)}; ${label(image.coordinate_space)}`);
    if (configuration.maxLongEdge !== undefined) lines.push(`Capture: maxLongEdge=${configuration.maxLongEdge}, scale=${configuration.scale}`);
  }
  if (d.source) lines.push(`Source: ${d.source.captured_at}; input=${d.source.capabilities.input}; paint freshness=${d.source.visibility.paint_freshness}`);
  if (d.element_text) {
    const e = d.element_text;
    lines.push(computerResultText(result).split("\n{", 1)[0], `Element: ${e.hint} | ${label(e.role)} | ${label(e.name)}`, ...e.text.split(/\r?\n/));
  } else if (d.verification) {
    const v = d.verification;
    lines.push(computerResultText(result).split("\n{", 1)[0]);
    if (d.dom) lines.push(`Page: ${label(d.dom.title)} | ${label(d.dom.url)} | tab ${d.dom.active ?? "none"}`);
    v.conditions.forEach((condition, i) => {
      const spec = v.spec.conditions[i];
      const check = spec.is ? (spec.is === "exists" || spec.is === "absent" ? spec.is : `is ${spec.is}`) : spec.value !== undefined ? `value = ${JSON.stringify(spec.value)}` : spec.contains !== undefined ? `contains ${JSON.stringify(spec.contains)}`
        : spec.count !== undefined ? `count = ${spec.count}` : spec.aria !== undefined ? "matches the aria snapshot"
        : spec.title !== undefined ? `title = ${JSON.stringify(spec.title)}` : `url contains ${JSON.stringify(spec.url_contains)}`;
      const target = spec.target === undefined ? "" : typeof spec.target === "string" ? spec.target + " " : JSON.stringify(spec.target) + " ";
      // A missed aria snapshot shows the received tree as YAML lines, the way Playwright's diff shows it.
      const tree = spec.aria !== undefined && condition.observed != null && condition.verdict !== "satisfied";
      const seen = condition.observed == null || tree ? "" : label(condition.observed).length > 200 ? label(condition.observed).slice(0, 200) + "…" : label(condition.observed);
      lines.push(`Condition ${i + 1}: ${target}${check} → ${condition.verdict}${condition.observed != null && !tree ? ` (observed ${JSON.stringify(seen)})` : ""}${condition.reason ? `; ${label(condition.reason)}` : ""}`);
      if (tree) lines.push("Received aria snapshot:", ...condition.observed!.split("\n"));
    });
    if (d.ui) lines.push(`UI: collected=${d.ui.collected}, complete=${d.ui.complete}, truncated=${d.ui.truncated}. Read or Search the observation for elements and hints.`);
    // A browser page's last sample is a fresh snapshot: show it like a dom Read, so the next step needs no Read.
    if (d.dom) {
      if (d.dom.truncated) lines.push("Snapshot truncated; Read the window with dom:{\"target\":...,\"depth\":...} to narrow it.");
      lines.push(...d.dom.snapshot.split("\n"));
    }
  } else if (d.dom) {
    if (d.status !== "observed") {
      const message = computerResultText(result).split("\n{", 1)[0];
      if (message) lines.push(message);
    }
    const dom = d.dom;
    lines.push(dom.active ? `Page: ${label(dom.title)} | ${label(dom.url)} | tab ${dom.active}` : "Page: none; no tab is active. Use computer_browser switch_tab.");
    for (const tab of dom.tabs ?? [])
      lines.push(`Tab ${tab.id}${tab.active ? " (active)" : ""}: ${label(tab.title)} | ${label(tab.url)} | ${tab.load}${tab.opener ? ` | opened by ${tab.opener}` : ""}${tab.dialog ? ` | ${tab.dialog} dialog open` : ""}`);
    if (dom.dialog) lines.push(`Dialog: ${dom.dialog.type} ${JSON.stringify(dom.dialog.message)}${dom.dialog.default_value !== undefined ? ` (default ${JSON.stringify(dom.dialog.default_value)})` : ""}. ` +
      "The page waits for it: answer with computer_browser dialog accept true or false; an accepted prompt takes text. Other page actions refuse until then.");
    for (const item of dom.downloads ?? [])
      lines.push(`Download ${item.id}: ${label(item.filename)} | ${item.state} | tab ${item.tab}${item.bytes !== undefined ? ` | ${item.bytes} bytes` : ""}${item.path ? ` | ${label(item.path)}` : ""}${item.error ? ` | ${label(item.error)}` : ""}`);
    for (const event of dom.events ?? []) lines.push(`Event: ${label(event)}`);
    const entry = (item: WebLogEntry) => `#${item.seq} ${item.at.slice(11, 23)} ${item.tab} ${item.kind}${item.kind === "console" ? `.${item.level}` : ` ${item.level}`}: ${label(item.text)}${item.url ? ` | ${label(item.url)}` : ""}`;
    if (dom.evaluation) lines.push(dom.evaluation.error !== undefined ? `Evaluation error: ${label(dom.evaluation.error)}`
      : `Evaluation result${dom.evaluation.truncated ? " (truncated to 20000 characters)" : ""}: ${dom.evaluation.value}`);
    for (const item of dom.log?.entries ?? []) lines.push(`Log ${entry(item)}`);
    if (dom.log?.omitted) lines.push(`Log: ${dom.log.omitted} more new entries; Read dom:{"log":true} for the retained history.`);
    if (dom.history) {
      lines.push(`Log history: ${dom.history.entries.length} retained entries from #${dom.history.first_seq}${dom.history.dropped ? `; ${dom.history.dropped} older entries were dropped, so earlier history is incomplete` : ""}.`);
      for (const item of dom.history.entries) lines.push(`History ${entry(item)}`);
    }
    if (d.dom.matches !== undefined) lines.push(`Matching snapshot lines: ${d.dom.matches}`);
    if (d.dom.truncated) lines.push("Snapshot truncated; narrow it with dom:{\"target\":...,\"depth\":...}.");
    // With a successor, the compact change list replaces the full snapshot; Read the observation for all of it.
    if (!d.successor) lines.push(...d.dom.snapshot.split("\n"));
  } else if (d.ui) {
    lines.push(`UI: collected=${d.ui.collected}, complete=${d.ui.complete}, truncated=${d.ui.truncated || d.ui.projection_truncated}`);
    // A changes Read lists only the difference; the observation still holds, and Search finds, the whole UI.
    if (d.changes?.diff) lines.push(`Since ${computerSource("observation", d.changes.since!)}:`, ...diffLines(d.changes.diff));
    else if (d.changes?.reason) lines.push(d.changes.reason);
    // An aria Read shows the tree as Playwright does; refs are this observation's hints.
    if (d.aria !== undefined) lines.push("Playwright aria snapshot; [ref=…] values are this observation's hints. Act with a target such as getByRole('button', { name: 'Save' }) on the window address, or a hint on this observation.", d.aria);
    else if (!d.changes?.diff) for (const e of d.ui.elements) lines.push(`${e.hint} | ${label(e.role)} | ${label(e.name)} | ${label(e.value)} | enabled=${e.enabled} | image_bounds=${JSON.stringify(e.bounds.window_image ?? null)}`);
  } else if (d.status === "listed") {
    if (state.remote_session === true) lines.push(`These displays belong to a Remote Desktop session: ${REMOTE_DESKTOP_DISPLAY}`);
    for (const kind of ["windows", "apps", "displays"] as const) {
      const rows = state[kind];
      if (!Array.isArray(rows)) continue;
      for (const raw of rows) {
        const row = record(raw);
        const ref = kind === "windows" ? row.window_ref : kind === "displays" ? row.display_ref : undefined;
        const source = typeof ref !== "string" ? undefined : kind === "windows" ? computerSource("window", ref) : displaySource(d.machine ?? LOCAL_MACHINE, ref);
        const shown = source !== undefined ? source
          : kind === "apps" && typeof row.app_ref === "string" ? computerSource("app", row.app_ref) : "(no controllable reference)";
        const metadata = Object.fromEntries(["pid", "window_id", "bounds", "minimized", "owned", "width", "height", "primary"]
          .filter(key => row[key] !== undefined).map(key => [key, row[key]]));
        lines.push(`${shown} | ${label(row.name ?? row.title ?? row.app)} | ${JSON.stringify(metadata)}`);
      }
    }
  } else {
    // ComputerSession puts its complete dispatch summary before the native JSON projection.
    const message = computerResultText(result).split("\n{", 1)[0];
    if (message) lines.push(message);
    for (const key of ["code", "native_message", "delivery_mode", "path", "effect"])
      if (typeof state[key] === "string") lines.push(`${key}: ${state[key]}`);
    if (state.unit === "wheel_detents") {
      lines.push(`Scroll: delta_x=${state.delta_x}, delta_y=${state.delta_y}; unit=wheel_detents`,
        `Native prefix: pointer_attempted=${state.pointer_attempted}, pointer_delivered=${state.pointer_delivered}; attempted_axes=${JSON.stringify(state.attempted_axes)}, delivered_axes=${JSON.stringify(state.delivered_axes)}`);
    }
  }
  if (d.sequence) {
    const sequence = d.sequence;
    lines.push(`Sequence: ${computerSource("sequence", sequence.sequence_id)}`,
      // A running watch has no stop reason or slots yet; a watch the agent stopped left no slots pending.
      "running" in sequence
        ? `Frames so far: ${sequence.frames.length}; running; elapsed_ms=${Math.round(sequence.elapsed_ms)}${sequence.actual_fps === null ? "" : `; actual_fps=${sequence.actual_fps}`}`
        : `Frames: ${sequence.frames.length}; stop=${sequence.stop_reason}; elapsed_ms=${Math.round(sequence.elapsed_ms)}; actual_fps=${sequence.actual_fps}; last_frame_age_ms=${sequence.last_frame_age_ms === null ? null : Math.round(sequence.last_frame_age_ms)}; skipped_slots=${sequence.skipped_slots.length}${sequence.stop_reason === "stopped" ? "" : `; pending_slots=${sequence.pending_slots}`}`);
  }
  if (d.watch) lines.push(d.watch.running
    ? `Watch: ${d.watch.watching} runs in the background as ${computerSource("sequence", d.watch.sequence_id)}; computer_record watch_stop at that address stops it`
    : `Watch: ${d.watch.watching} stopped; ${d.watch.changed_frames ?? 0} frames changed${d.watch.files ? `; files in ${d.watch.files.dir}` : ""}`);
  for (const span of d.watch_spans ?? [])
    lines.push(`Watch: ${span.label} ran ${Math.round(span.from_ms)}–${Math.round(span.to_ms)} ms into ${computerSource("sequence", span.sequence_id)}; ${span.frames ? `frames ${span.frames.from}–${span.frames.to}` : "no frame captured during it yet"}`);
  if (d.process) lines.push(d.process.responding
    ? `Process: ${d.process.name} (pid ${d.process.pid}) responds; ${d.process.memory_mb} MB memory, ${d.process.cpu_seconds} s CPU`
    : `Process: ${d.process.name} (pid ${d.process.pid}) is NOT responding; ${d.process.memory_mb} MB memory. Capture and input cannot recover a hung app: wait and read again, or close it.`);
  if (d.visual_regions) {
    lines.push(`Regions: ${d.visual_regions.length} icons and text areas found by Cua perception; boxes in this observation's overview pixels. Click a box center with pixel input on this observation. Detection can miss, split or merge items, and labels can be wrong.`);
    for (const r of d.visual_regions) lines.push(`${r.kind}${r.text || r.label ? ` "${label(r.text ?? r.label)}"` : ""} | x=${r.x} y=${r.y} w=${r.width} h=${r.height} | center ${Math.round(r.x + r.width / 2)},${Math.round(r.y + r.height / 2)} | confidence ${r.confidence}`);
  }
  if (d.text_lines) {
    lines.push(`OCR: ${d.text_lines.length} lines; boxes in ${d.viewport ? "pixels of the viewport's image" : "this observation's overview pixels"}. Recognised text can be wrong; confirm with pixels or UI before acting on it.`);
    for (const line of d.text_lines) lines.push(`"${label(line.text)}" | x=${line.x} y=${line.y} w=${line.width} h=${line.height}`);
  }
  if (d.successor) {
    const s = d.successor, diff = s.diff;
    lines.push(s.observation_id ? `Successor: ${computerSource("observation", s.observation_id)}` : `Successor: none. ${s.reason ?? ""}`);
    if (diff) lines.push(...diffLines(diff, true));
    // Without a successor, the reason already follows "Successor: none".
    else if (s.reason && s.observation_id) lines.push(s.reason);
  }
  if (d.selected_frames) lines.push(`Selected frames: ${d.selected_frames.map(frame => frame.index).join(", ")}; readonly, input=none`);
  lines.push(d.successor?.observation_id ? "Refs in this change list are current for the next input; Read the window for its full state."
    : d.verification ? (d.verification.verdict === "satisfied" ? "Conditions held; refs of this sample are current for input." : "Not verified: neither proof of success nor of failure beyond the listed verdicts. Never replay uncertain input blindly.")
    : d.dom ? "Act on the window with the computer_* input tools, a ref such as e2 as target. Read element:crop|highlight,<ref> or image for page pixels. Refs belong to the latest snapshot."
    : d.window_state_id ? "This Read only looks; computer_window changes the window's state."
    : d.watch && d.status === "observed" ? "A watch only looks: the window's refs and points stay as they were for input."
    : d.viewport && d.status === "observed" ? "Act in this viewport with the computer_* input tools at its address; a viewport Read gives no refs."
    : (d.selected_frames || d.sequence) && d.status === "observed" ? "Frames only look: a sequence grants no input. Read the window for refs and points."
    // A window overview without accessibility has points but no refs.
    : d.granularity && !d.ui?.elements.length && d.captured?.image && d.status === "observed" ? "Points of this image are current for the next input to its window; it has no refs."
    : d.status === "observed" ? "Refs of this Read are current for the next input to its window; detail and display Reads give none."
    : "Native delivery is not verified application state. Never replay unknown input; Read a fresh window overview/state before another action.");
  const text = lines.join("\n");
  if (full || !d.dom || Buffer.byteLength(text) <= 24_000) return text;
  // Read and Search share the same byte budget; retain whole lines and never split Unicode.
  const preview = fittingLines(lines, 24_000 - 300);
  // A Read of the observation renders slightly different header lines, so page it there rather than by these numbers.
  return `${preview.join("\n")}\nDOM text preview reached its byte limit after ${preview.length} of ${lines.length} lines. Read this observation with offset and limit to page through it (each page names the next offset), or Search it; omitted lines are not absence.`;
}


/** Lines of a compact UI, DOM or pixel change list; changed and added rows carry the new observation's hints. */
function diffLines(diff: StateDiff, afterAction = false): string[] {
  const page = diff.page ?? {};
  const total = diff.counts.changed + diff.counts.added + diff.counts.removed;
  const omitted = total - diff.changed.length - diff.added.length - diff.removed.length;
  const pixels = diff.pixels;
  const subject = diff.kind === "dom" ? "on the page" : diff.kind === "pixels" ? "in the window's pixels" : pixels ? "in the UI or the window's pixels" : "in the UI";
  const nothing = !afterAction ? `Nothing changed ${subject} since that observation.`
    : `Nothing changed ${subject}${diff.waited_ms !== undefined ? ` within ${diff.waited_ms} ms` : ""} after the action. Check that the target was right before acting again; do not replay blindly.`;
  const uiChanged = total > 0 || Object.keys(page).length > 0;
  return [...Object.entries(page).map(([key, change]) => `Changed ${key}: ${JSON.stringify(change![0])} → ${JSON.stringify(change![1])}`),
    ...(diffIsEmpty(diff) ? [nothing] : diff.kind === "pixels" ? [] : [`Changes: ${diff.counts.changed} changed, ${diff.counts.added} added, ${diff.counts.removed} removed`]),
    ...diff.changed.map(line => `~ ${label(line)}`), ...diff.added.map(line => `+ ${label(line)}`), ...diff.removed.map(line => `- ${label(line)}`),
    ...(omitted > 0 ? [`${omitted} more changes are not listed; Search or Read the new observation for them.`] : []),
    ...(pixels && !diffIsEmpty(diff) ? pixelLines(pixels, uiChanged) : []),
    ...(afterAction && !pixels && diff.kind === "ui" ? ["Pixels were not compared: the input observation had no pixels."] : []),
    ...(diff.unsettled ? [`The window was still changing ${diff.waited_ms} ms after the action; the successor shows it at that moment.`] : []),
    ...(diff.note ? [diff.note] : [])];
}

/** How the window's pixels changed, in overview pixels, and what the attached crops show. */
function pixelLines(pixels: PixelReport, uiChanged: boolean): string[] {
  const since = pixels.since ? ` since ${computerSource("observation", pixels.since)}` : "";
  if (pixels.size_changed) return [`The window's overview size changed${since} from ${pixels.size_changed.width}x${pixels.size_changed.height} to ${pixels.width}x${pixels.height}; pixels were not compared.`];
  if (!pixels.box) return uiChanged ? [`No visible pixel change${since}.`] : [];
  const share = pixels.share * 100, percent = share < 0.1 ? share.toFixed(2) : share.toFixed(1), crops = pixels.crops ?? [];
  const rect = (b: PixelBox) => `x=${b.x} y=${b.y} w=${b.width} h=${b.height}`;
  const chrome = pixels.chrome ? [`Browser chrome outside the page also changed (${rect(pixels.chrome.box)}, ${pixels.chrome.regions} ${pixels.chrome.regions === 1 ? "area" : "areas"}): tab strip, address bar or loading state; not listed.`] : [];
  const page = pixels.space === "page", viewport = pixels.space === "viewport";
  const whole = page ? "page" : viewport ? "viewport" : "window", unit = page ? "CSS pixels of the page" : viewport ? "pixels of the viewport's image" : "overview pixels";
  if (pixels.full) return [pixels.navigated ? `The page navigated (${percent}% of its pixels changed): image 1 shows the whole page after the action.`
    : `Most of the ${whole} changed${since} (${percent}% of its pixels): image 1 shows the whole ${whole} after the action.`, ...chrome];
  if (!pixels.areas.length) return chrome;
  // The overview, when attached, is image 1 and numbers the areas as listed; each crop pair follows it.
  const first = pixels.overview ? 2 : 1;
  const lines = [`Pixels changed${since} in ${pixels.regions} ${pixels.regions === 1 ? "area" : "areas"} (${unit}; ${percent}% of the ${whole})${pixels.overview ? `; image 1 outlines and numbers them on the ${whole}` : ""}:`,
    ...pixels.areas.map((area, i) => {
      const crop = crops[i], zoom = crop && crop.scale > 1 ? `, enlarged ${crop.scale}x` : "";
      return `  ${i + 1}. ${rect(area)}${area.at_input ? " (at the input point)" : ""}${crop ? `; images ${first + 2 * i} and ${first + 2 * i + 1} show ${rect(crop)} before and after${zoom}` : ""}`;
    })];
  if (pixels.regions > pixels.areas.length) lines.push(`  …and ${pixels.regions - pixels.areas.length} more areas, not listed; Read the window for all of it.`);
  return [...lines, ...chrome];
}

/** Whole lines from the start that fit a byte budget, never splitting Unicode. */
function fittingLines(lines: readonly string[], budget: number): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > budget) break;
    kept.push(line); bytes += size;
  }
  return kept;
}

/** Preserve uncertainty when a later refusal follows an already-delivered action prefix. */
export function computerEffect(result: ComputerResult): "applied" | "not-applied" | "unknown" {
  if (!result.isError && ["delivered", "observed", "closed"].includes(result.details.status)) return "applied";
  const sequence = record(result.details.state?.sequence);
  const delivered = typeof sequence.completed === "number" && sequence.completed > 0;
  return result.details.status === "refused" && !delivered ? "not-applied" : "unknown";
}

/**
 * The value a Codemode script receives from a computer_* tool. Every outcome resolves with this
 * shape, so scripts branch on `outcome` instead of catching errors. Delivery never verifies application state.
 */
export interface ComputerReceipt {
  /** `refused` sent nothing; `unknown` may have reached the target, so never replay it blindly. */
  outcome: "delivered" | "refused" | "unknown" | "observed" | "closed";
  /** Input effect: `not-applied` only when nothing was delivered, including no earlier sequence step. */
  effect: "applied" | "not-applied" | "unknown";
  /** `validation`: rejected before reaching the target; `target`: the session, browser or native driver answered. */
  stage: "validation" | "target";
  action: string | null;
  source: string;
  window: string | null;
  /** The viewport a Read showed or an input went to. */
  viewport?: string;
  /** The sandbox address computer_open started. */
  sandbox?: string;
  /** The sequence address of a watch this call started or stopped. */
  watch?: string;
  /** The action's span in each running watch of its window, in that watch's milliseconds, with the frames captured during it. */
  watch_spans?: { sequence: string; from_ms: number; to_ms: number; frames: { from: number; to: number } | null }[];
  /** The new current observation issued by this call, such as a DOM action's next snapshot. */
  observation: string | null;
  /** Whether the addressed observation can no longer be used for input. */
  input_consumed: boolean;
  application_effect: "unverified";
  reason: string | null;
  code: string | null;
  /** Page state after a browser action. */
  page?: { url: string; title: string; tab: string | null; dialog: string | null };
  evaluation?: { value?: string; error?: string; truncated?: boolean };
  /** Verdict of a wait_for/verify command, with one entry per requested condition. */
  verification?: { verdict: "satisfied" | "unsatisfied" | "unknown"; timed_out: boolean; samples: number; elapsed_ms: number; reason?: string;
    conditions: { index: number; verdict: "satisfied" | "unsatisfied" | "unknown"; observed?: string | null; reason?: string }[] };
  /** Per-step results of a native sequence. */
  steps?: { index: number; action: unknown; status: unknown; verdict?: string; reason?: string }[];
  /** Compact change list from the action's input observation to `observation`. */
  changes?: { kind: string; changed: string[]; added: string[]; removed: string[]; counts: { changed: number; added: number; removed: number };
    page?: Record<string, unknown>; note?: string };
  /** The same receipt the model sees. */
  text: string;
}
/** Build the script receipt for one computer action, or for a request rejected before dispatch. */
export function computerReceipt(source: string, action: string | null, outcome: { result: ComputerResult; inputConsumed: boolean; text: string }
  | { error: unknown; inputConsumed: boolean }): ComputerReceipt {
  if ("error" in outcome) {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    const validation = outcome.error instanceof ComputerRequestError;
    return { outcome: validation ? "refused" : "unknown", effect: validation ? "not-applied" : "unknown", stage: validation ? "validation" : "target",
      action, source, window: null, observation: null, input_consumed: outcome.inputConsumed, application_effect: "unverified",
      reason: message, code: validation ? "COMPUTER_INVALID_REQUEST" : "COMPUTER_UNKNOWN", text: message };
  }
  const d = outcome.result.details, state = d.state ?? {};
  const id = d.observation_id ?? d.agent_image?.image_id;
  const issued = typeof id === "string" && d.status !== "refused" && d.status !== "unknown" && (d.status === "observed" || d.dom !== undefined || d.ui !== undefined);
  const next = d.successor?.observation_id ?? (issued ? id : undefined);
  const sequence = record(state.sequence);
  const failed = d.status === "refused" || d.status === "unknown";
  return {
    outcome: d.status === "listed" ? "observed" : d.status, effect: computerEffect(outcome.result), stage: "target", action, source,
    window: typeof d.window_ref === "string" ? computerSource("window", d.window_ref) : null,
    ...(d.viewport ? { viewport: d.viewport.source } : {}),
    ...(typeof d.sandbox_ref === "string" ? { sandbox: computerSource("sandbox", d.sandbox_ref) } : {}),
    ...(d.watch ? { watch: computerSource("sequence", d.watch.sequence_id) } : {}),
    ...(d.watch_spans ? { watch_spans: d.watch_spans.map(span => ({ sequence: computerSource("sequence", span.sequence_id), from_ms: span.from_ms, to_ms: span.to_ms, frames: span.frames })) } : {}),
    observation: next ? computerSource("observation", next) : null,
    input_consumed: outcome.inputConsumed, application_effect: "unverified",
    reason: failed ? computerResultText(outcome.result).split("\n{", 1)[0] : null,
    code: typeof state.code === "string" ? state.code : null,
    ...(d.dom ? { page: { url: d.dom.url, title: d.dom.title, tab: d.dom.active ?? null, dialog: d.dom.dialog?.type ?? null } } : {}),
    ...(d.dom?.evaluation ? { evaluation: d.dom.evaluation } : {}),
    ...(d.verification ? { verification: { verdict: d.verification.verdict, timed_out: d.verification.timed_out, samples: d.verification.samples,
      elapsed_ms: d.verification.elapsed_ms, ...(d.verification.reason ? { reason: d.verification.reason } : {}), conditions: d.verification.conditions } } : {}),
    ...(Array.isArray(sequence.steps) ? { steps: (sequence.steps as Record<string, unknown>[]).map(step => ({ index: step.index as number, action: step.action, status: step.status })) } : {}),
    ...(d.successor?.diff ? { changes: d.successor.diff } : {}),
    text: outcome.text,
  };
}
/** One computer Read: native blocks for the model, canonical blocks for scripts and the details renderers use. */
export async function readComputer(resources: ComputerResources, source: string, cwd: string,
  request: { readonly views?: readonly string[]; readonly offset?: number; readonly limit?: number }, script: boolean, signal?: AbortSignal) {
  const address = resources.address(source);
  const result = await resources.read(address, cwd, request.views, signal);
  const paged = request.offset !== undefined || request.limit !== undefined;
  // The agent sees this run's short addresses; the long ones stay in structured details.
  let body = resources.shorten(result ? presentComputerResult(result, paged) : resources.descriptor(address));
  const lines = body.split("\n"), offset = request.offset ?? 1;
  const start = offset < 0 ? Math.max(0, lines.length + offset) : Math.max(0, offset - 1);
  if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 0)) throw new ComputerRequestError("limit must be a nonnegative text line count.");
  if (!Number.isSafeInteger(offset)) throw new ComputerRequestError("offset must be an integer text line offset.");
  const end = request.limit === undefined ? lines.length : Math.min(lines.length, start + request.limit);
  body = lines.slice(start, end).join("\n");
  // Paging reads cached text only; the footer gives a deterministic next offset or end.
  if (paged)
    body += `\n[Lines ${start + 1}-${end} of ${lines.length}. ${end < lines.length ? `Continue with offset=${end + 1}.` : "End of this observation's text."} The text belongs to this observation; Read the window again for a fresh one.]`;
  const uiOnly = !!result?.details.dom && !result.details.agent_image || (request.views?.includes("ui") ?? false);
  const canonical = nativeBlocks(body, result, uiOnly);
  const truncated = !script && Buffer.byteLength(body) > 24_000;
  const kept = truncated ? fittingLines(body.split("\n"), 24_000 - 300) : [];
  const preview = truncated ? `${kept.join("\n")}\n[Presentation truncated after ${kept.length} lines. Read again with offset=${start + kept.length + 1} to continue, or narrow with Search. Native script data retains the requested projection.]` : body;
  return { content: nativeBlocks(preview, result, uiOnly), canonical, isError: result?.isError,
    details: { source: address.source, resolvedBy: "computer", presentationTruncated: truncated, ...(result ? { computer: result.details } : {}) } };
}

/** Write or Insert on a computer address: a refused receipt that names the computer_* tool to use instead. */
export function refuseComputerEdit(resources: ComputerResources, tool: "write" | "insert", source: string, input: Record<string, unknown>) {
  return computerAction(resources, source, null, () => { throw new ComputerRequestError(computerEditRefusal(tool, input)); }, () => Promise.reject(new Error("unreachable")));
}
/**
 * Run one computer operation and present its outcome as an action result: the shortened summary, any images, and the
 * receipt that scripts branch on. `resolve` validates the request; its refusal is a not-applied receipt.
 */
export async function computerAction(resources: ComputerResources, source: string, action: string | null,
  resolve: () => ComputerAddress, run: (address: ComputerAddress) => Promise<ComputerResult>) {
  let address: ComputerAddress | undefined;
  try {
    address = resolve();
    const result = await run(address);
    const effect = computerEffect(result);
    // Completion of the native request is separate from application-effect certainty.
    const ok = !result.isError && ["delivered", "observed", "closed"].includes(result.details.status);
    const summary = resources.shorten(presentComputerResult(result));
    // Images of an action result, such as before/after crops of its pixel change, follow the summary for the model.
    const images = result.content.filter((block): block is Extract<Content, { type: "image" }> => block.type === "image");
    return { source, summary, ...(images.length ? { images } : {}), data: { kind: "computer-action", ok,
      effect, ...result.details,
      receipt: computerResultText(result),
      ...(!ok ? { error: { code: typeof result.details.state?.code === "string" ? result.details.state.code : `COMPUTER_${effect.toUpperCase().replace("-", "_")}`,
        message: computerResultText(result) } } : {}) },
      script: { ...shortReceipt(resources, computerReceipt(source, action, { result, inputConsumed: !resources.grantsAuthority(address), text: summary })) } };
  } catch (error) {
    const message = resources.shorten(error instanceof Error ? error.message : String(error));
    return { source, summary: message, data: { kind: "computer-action", ok: false,
      effect: error instanceof ComputerRequestError ? "not-applied" : "unknown", error: { message } },
      script: { ...shortReceipt(resources, computerReceipt(source, action, { error, inputConsumed: address ? !resources.grantsAuthority(address) : false })) } };
  }
}
/** Close what a computer address names through Delete. */
export function deleteComputer(resources: ComputerResources, source: string, input: Record<string, unknown>, cwd: string, signal?: AbortSignal) {
  return computerAction(resources, source, "close", () => {
    if (Object.keys(input).some(key => key !== "path")) throw new ComputerRequestError("Delete of a computer address takes only its path; it closes the whole resource.");
    return resources.address(source.endsWith(FORCE) ? source.slice(0, -FORCE.length) : source);
  }, () => resources.delete(source, cwd, signal));
}
/** A receipt whose window, sandbox and observation addresses are this run's short aliases. */
function shortReceipt(resources: ComputerResources, receipt: ComputerReceipt): ComputerReceipt {
  const short = (value: string | null | undefined) => value ? resources.shorten(value) : value;
  return { ...receipt, window: short(receipt.window) ?? null, observation: short(receipt.observation) ?? null,
    ...(receipt.sandbox ? { sandbox: short(receipt.sandbox)! } : {}), ...(receipt.viewport ? { viewport: short(receipt.viewport)! } : {}), ...(receipt.reason ? { reason: resources.shorten(receipt.reason) } : {}), text: resources.shorten(receipt.text) };
}
function nativeBlocks(body: string, result: ComputerResult | undefined, uiOnly: boolean): Content[] {
  return [{ type: "text", text: body }, ...(uiOnly || !result ? [] : result.details.selected_frames
    ? result.content.slice(1) : result.content.filter(block => block.type === "image"))];
}
/**
 * Extend ordinary IDE tools; CUA and ComputerSession remain the sole native backend and policy owner.
 * `attached()` reports whether a loaded IDE accepted all three plugins. An IDE that is absent or refuses
 * this plugin API version leaves it false, so the caller can offer the standalone tools instead.
 */
export async function registerComputerProvider(pi: ExtensionAPI, getSession: (cwd: string) => Promise<ComputerSession>,
  closeSession: () => Promise<ComputerResult>, openSandbox?: SandboxFactory, connectMachine?: MachineFactory, getMode?: () => ComputerMode,
): Promise<{ readonly resources: ComputerResources; readonly guide: string; readonly attached: () => boolean;
  readonly registerCapabilities: (tools: readonly string[], namespace: { name: string; description: string }) => void }> {
  const accepted = new Set<string>();
  const guide = await readFile(new URL("../docs/computer-resources.md", import.meta.url), "utf8");
  connectAgentDocumentation(pi, [{ id: "computer", description: "Native Windows UIA, screenshots and input; no browser DOM/CDP controls",
    markdown: fillToolNames(guide, IDE_TOOL_NAMES),
    triggers: ["read", "search"].map(tool => ({ tool, resourcePrefixes: ["computer:"] })) }]);
  const resources = new ComputerResources(getSession, closeSession, openSandbox, connectMachine, getMode);
  const describe = (source: string) => resources.describe(source);
  // Pi shutdown releases every machine, sandbox and session this computer use started.
  pi.on("session_shutdown", () => resources.closeAll().then(() => undefined));
  const resolver: ResourceResolver = {
    id: "computer",
    async tryResolve(source) {
      if (!owns(source)) return { kind: "not-handled" };
      try {
        // Delete's force option is not part of the address; Delete itself checks where it applies.
        const address = resources.address(source.endsWith(FORCE) ? source.slice(0, -FORCE.length) : source);
        return { kind: "resolved", resource: { source, skipPostEdit: true,
          // An expired reference still resolves, so Delete reaches its handler and returns a refused receipt.
          read: async () => {
            try { return [{ type: "text", text: resources.shorten(resources.descriptor(address)) }]; }
            catch (error) { if (error instanceof ComputerRequestError) return [{ type: "text", text: resources.shorten(`# Computer resource\nSource: ${source}\n${error.message}`) }]; throw error; }
          } } };
      } catch (error) { return { kind: "failed", error }; }
    },
  };
  // An IDE that refuses this plugin API version rejects here; computer use then stays standalone.
  const optional = (registration: void | Promise<void>) => Promise.resolve(registration).catch(() => undefined);
  await Promise.all([
    optional(connectReadPlugin(pi, { protocol: READ_PROTOCOL, apiVersion: READ_API_VERSION, id: "computer", setup(api) {
      accepted.add("read");
      api.addResolver({ resolver, priority: -250, renderResult: computerReadRenderer(describe) as never });
      for (const view of ["image", "ui", "full", "state", "region", "sequence", "frames", "capture", "element", "ocr", "changes", "regions", "aria"])
        api.addView({ view, contentKind: "any", presenter: { id: `computer-${view}`, present: document => document } });
      api.addHandler({ stage: "read", when: { resolvedBy: resolver.id, contentKind: "any" }, async handler(context) {
        const { request, resolverContext } = context;
        const read = await readComputer(resources, context.state!.source, resolverContext.cwd, request, context.audience === "script", resolverContext.signal);
        return { kind: "return", result: { content: read.content, isError: read.isError, details: read.details,
          script: { kind: "native", source: read.details.source, blocks: read.canonical } } };
      } });
    } })),
    optional(connectSearchPlugin(pi, { protocol: SEARCH_PROTOCOL, apiVersion: SEARCH_API_VERSION, id: "computer", setup(api) {
      accepted.add("search");
      api.addResolver({ priority: -250, resolver: { id: "computer", renderResult: computerSearchRenderer(describe) as never, readResources: request => owns(request.path) ? [request.path] : [],
        async tryResolve(request, context) {
          if (!owns(request.path)) return { kind: "not-handled" };
          try {
            if (request.include !== undefined || request.exclude !== undefined || ("navigation" in request && request.navigation !== undefined) || request.caseSensitive || request.wholeWord)
              throw new ComputerRequestError("Computer Search uses native discovery/UI text predicates, not file globs or symbol navigation.");
            const result = await resources.search(resources.address(request.path), context.cwd, request.query, request.limit, context.signal);
            return { kind: "resolved", payload: result };
          } catch (error) { return { kind: "failed", error }; }
        },
        format(payload) { const result = payload as ComputerResult; return { ...result, content: [{ type: "text", text: resources.shorten(presentComputerResult(result)) }] }; },
        toScriptData(payload) { return { kind: "custom", resolverId: "computer", value: (payload as ComputerResult).details }; },
      } });
    } })),
    optional(connectTextEditorPlugin(pi, { protocol: TEXT_EDITOR_PROTOCOL, apiVersion: TEXT_EDITOR_API_VERSION, id: "computer", setup(api) {
      accepted.add("text-editor");
      api.addResolver({ resolver, priority: -250 });
      // Compose over IDE's default renderers after every plugin has finished loading.
      let renderersRegistered = false;
      pi.on("session_start", () => {
        if (renderersRegistered) return;
        for (const tool of ["write", "insert", "delete"] as const) api.addToolRenderer(computerActionRenderer(tool, describe) as never);
        renderersRegistered = true;
      });
      // Write and Insert do not act on computer addresses; they refuse instead of treating the address as a file.
      for (const tool of ["write", "insert"] as const) api.tool(tool).addSemanticHandler({
        matches: input => owns(record(input).path),
        execute: (context, input) => refuseComputerEdit(resources, tool, context.sourceFor("path"), record(input)),
      });
      const deleteTool = api.tool("delete");
      deleteTool.addSemanticHandler({
        matches: input => owns(record(input).path),
        execute: (context, input) => deleteComputer(resources, context.sourceFor("path"), record(input), context.cwd, context.signal),
      });
    } })),
  ]);
  return { resources, guide, attached: () => accepted.size === 3,
    registerCapabilities(tools, namespace) {
      if (accepted.size === 0) return;
      registerIdeCapability(pi, {
        version: 1, id: "computer", tools,
        discovery: { name: "ide_capability_computer", namespace,
          description: "Use ide_capability_computer to load Computer Use resource syntax for Read, Search and Delete, including installed-app, existing-window and display discovery." },
        schemas: {
          ...(accepted.has("read") ? { read: { parameters: { path: computerPathHelp(IDE_TOOL_NAMES), views: computerViewsHelp(IDE_TOOL_NAMES) } } } : {}),
          ...(accepted.has("search") ? { search: { promptGuidelines: [COMPUTER_SEARCH_HELP] } } : {}),
          ...(accepted.has("text-editor") ? { delete: { parameters: { path: COMPUTER_DELETE_HELP } } } : {}),
        },
      });
    },
  };
}
