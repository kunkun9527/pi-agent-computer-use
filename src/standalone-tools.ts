import { Type, type JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ComputerResources } from "./computer-resources.ts";
import { resourceRenderers } from "./computer-renderers.ts";
import { computerNamespace, registerComputerDelete } from "./computer-tools.ts";
import { COMPUTER_SEARCH_HELP, computerPathHelp, computerViewsHelp, presentComputerResult, readComputer } from "./provider.ts";
import { STANDALONE_TOOL_NAMES } from "./tool-names.ts";

const GUIDE = "docs:computer";
/** Marks a result that carried the guide, the way Pi Agent IDE marks its guide attachments. */
const GUIDE_MARK = { kind: "attachment", ids: ["computer"] } as const;
const image = Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() });

/**
 * Offer computer use without Pi Agent IDE: computer_read, computer_search and computer_delete stand in for the IDE's Read,
 * Search and Delete. Like the other computer_* tools they are deferred, off the model's tool list until tool_search loads them.
 */
export function registerStandaloneTools(pi: ExtensionAPI, resources: ComputerResources, guide: string): void {
  const describe = (source: string) => resources.describe(source);
  const namespace = computerNamespace();
  deliverGuide(pi, guide);
  pi.registerTool({
    name: "computer_read", label: "Computer read", exposure: "deferred", namespace,
    description: "Read computer: resources and UI snapshots.",
    parameters: Type.Object({
      path: Type.String({ description: computerPathHelp(STANDALONE_TOOL_NAMES) }),
      views: Type.Optional(Type.Array(Type.String(), { description: computerViewsHelp(STANDALONE_TOOL_NAMES) })),
      offset: Type.Optional(Type.Integer({ description: "First line (1-based, negative from end)." })),
      limit: Type.Optional(Type.Integer({ minimum: 0, description: "Line count." })),
    }, { additionalProperties: false }),
    // Scripts receive an image block, or several frames, like an IDE image Read; text reads stay strings.
    outputSchema: Type.Union([
      Type.Object({ ...image.properties, note: Type.String() }),
      Type.Object({ type: Type.Literal("images"), note: Type.String(), images: Type.Array(image) }),
    ]),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...resourceRenderers("computer_read", describe),
    async execute(_id, params, signal, _update, ctx) {
      if (params.path === GUIDE) {
        const lines = guide.replace(/\n$/, "").split("\n"), offset = params.offset ?? 1;
        const start = offset < 0 ? Math.max(0, lines.length + offset) : Math.max(0, offset - 1);
        const end = params.limit === undefined ? lines.length : Math.min(lines.length, start + params.limit);
        const rest = end < lines.length ? `\n\n[${lines.length - end} more lines in source. Read "${GUIDE}" with offset=${end + 1} to continue.]` : "";
        return { content: [{ type: "text", text: lines.slice(start, end).join("\n") + rest }],
          details: { source: GUIDE, startLine: start + 1, endLine: end, totalLines: lines.length } };
      }
      const read = await readComputer(resources, params.path, ctx.cwd, params, false, signal);
      const note = read.canonical.find(block => block.type === "text")?.text ?? "";
      const images = read.canonical.filter(block => block.type === "image").map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }));
      const [first] = images;
      const value: JsonValue | undefined = first === undefined ? undefined : images.length === 1 ? { ...first, note } : { type: "images", note, images };
      return { content: read.content, details: read.details, ...(read.isError ? { isError: true } : {}), ...(value === undefined ? {} : { structuredContent: value }) };
    },
  });
  pi.registerTool({
    name: "computer_search", label: "Computer search", exposure: "deferred", namespace,
    description: "Find windows/apps or search an observation.",
    parameters: Type.Object({
      path: Type.String({ description: COMPUTER_SEARCH_HELP }),
      query: Type.String({ description: "Name/text; regex:<pattern> (case-insensitive)." }),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Result count." })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...resourceRenderers("computer_search", describe),
    async execute(_id, params, signal, _update, ctx) {
      const result = await resources.search(resources.address(params.path), ctx.cwd, params.query, params.limit, signal);
      return { content: [{ type: "text", text: resources.shorten(presentComputerResult(result)) }], details: result.details, ...(result.isError ? { isError: true } : {}) };
    },
  });
  registerComputerDelete(pi, resources);
}

/**
 * Bring the guide with the first computer_read or computer_search of a computer address on a session branch, as Pi
 * Agent IDE does. A call made by a script owes the guide to the call that ran the script, so the model sees it even
 * when the script prints nothing. A new session, another branch or a compaction looks at the branch again.
 */
function deliverGuide(pi: ExtensionAPI, guide: string): void {
  let shown: boolean | undefined;
  const owed = new Set<string>();
  const forget = () => { shown = undefined; };
  pi.on("session_start", forget);
  pi.on("session_tree", forget);
  pi.on("session_compact", forget);
  pi.on("tool_result", (event, ctx) => {
    shown ??= ctx.sessionManager.getBranch().some(carriesGuide);
    let owes = owed.delete(event.toolCallId);
    const path = event.input.path;
    if (event.toolName === "computer_read" && path === GUIDE && event.parentToolCallId === undefined) { shown = true; return; }
    if (!shown && (event.toolName === "computer_read" || event.toolName === "computer_search") && typeof path === "string" && path.startsWith("computer:")) {
      shown = true;
      owes = true;
    }
    if (!owes) return;
    if (event.parentToolCallId !== undefined) { owed.add(event.parentToolCallId); return; }
    const details = (event as { details?: unknown }).details;
    return { content: [...event.content, { type: "text", text: `\n\n---\n\n# Guide: computer\n\n${guide.trim()}` }], structuredContent: event.structuredContent,
      details: { ...(typeof details === "object" && details !== null ? details : {}), documentation: GUIDE_MARK }, isError: event.isError };
  });
}

/** Whether a session entry is a tool result that carried the guide: an attachment, or a read of docs:computer. */
function carriesGuide(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || !("message" in entry)) return false;
  const message = entry.message as { role?: string; details?: { documentation?: { ids?: unknown }; source?: unknown } } | undefined;
  if (message?.role !== "toolResult") return false;
  const ids = message.details?.documentation?.ids;
  return (Array.isArray(ids) && ids.includes("computer")) || message.details?.source === GUIDE;
}
