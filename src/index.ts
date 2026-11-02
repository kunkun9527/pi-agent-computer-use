import { basename } from "node:path";
import { registerVisualPreferences } from "./visual-preferences.ts";
import { VisualSettings } from "./native-visuals.ts";
import { CuaImageSettings } from "./cua-image-settings.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadComputerConfig } from "./config.ts";
import { McpDriver } from "./driver.ts";
import { registerComputerMode } from "./mode.ts";
import { registerSetupCommand } from "./setup-command.ts";
import { ComputerSession, type ComputerResult } from "./session.ts";
import { registerComputerProvider } from "./provider.ts";
import { fillToolNames, IDE_TOOL_NAMES, STANDALONE_TOOL_NAMES } from "./tool-names.ts";
import { registerStandaloneTools } from "./standalone-tools.ts";
import { computerNamespace, registerComputerTools } from "./computer-tools.ts";
import { registerToolOmission } from "./responses-tools.ts";
import { localRunner } from "./runner.ts";
import { MachineHost } from "./machine-host.ts";
import { machineFactory, sandboxFactory } from "./machine.ts";
import { HumanStop } from "./human-stop.ts";
import { registerComputerSettingsCommand } from "./computer-settings.ts";
import { PreferencesController } from "./preferences-controller.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Register native computer resources with ordinary IDE tools when Pi Agent IDE accepts them, otherwise as
 * deferred computer_* tools.
 */
export default async function computerUse(pi: ExtensionAPI): Promise<void> {
  let overviewKernel: "lanczos3" | "bilinear" = "lanczos3";
  const images = new CuaImageSettings(() => overviewKernel);
  const visuals = new VisualSettings();
  registerVisualPreferences(pi, visuals);
  let canEnterSafe = () => true;
  const humanStop = new HumanStop();
  const getMode = registerComputerMode(pi, async () => { visuals.clear(); }, () => canEnterSafe(), humanStop);
  const preferences = new PreferencesController(images, visuals, getMode);
  let currentContext: ExtensionContext | undefined;
  const restorePreferences = async (ctx: ExtensionContext) => {
    currentContext = ctx;
    if (!ctx.cwd || !ctx.isProjectTrusted) return;
    preferences.captureBaseline(ctx);
    await preferences.apply(ctx, true, true);
  };
  pi.on("session_start", (_event, ctx) => restorePreferences(ctx));
  pi.on("session_tree", (_event, ctx) => restorePreferences(ctx));
  const scopedEscapeStop = async () => currentContext?.cwd
    ? (await preferences.read(currentContext)).effective.escape ?? true : undefined;
  registerComputerSettingsCommand(pi, { mode: getMode, images, visuals, stop: humanStop, preferences });
  let cwdLabel: string | undefined;
  // The agent cursor names this session, or its project folder until the session has a name.
  const sessionLabel = () => pi.getSessionName()?.trim() || cwdLabel;
  registerSetupCommand(pi);
  let session: ComputerSession | undefined;
  let loading: Promise<ComputerSession> | undefined;
  async function getSession(cwd: string): Promise<ComputerSession> {
    if (session) return session;
    if (!loading) loading = loadComputerConfig(cwd).then(async config => {
      cwdLabel = basename(cwd);
      const escapeStop = await scopedEscapeStop();
      if (escapeStop !== undefined) config.escapeStop = escapeStop;
      const driver = new McpDriver(config, undefined, visuals, humanStop, sessionLabel);
      overviewKernel = driver.overviewKernel ?? "lanczos3";
      session = new ComputerSession(driver, getMode, () => images.settings(), undefined,
        undefined, // Desktop-only: no browser worker or Playwright launcher.
        driver.platform === "windows" ? new MachineHost(localRunner(config.interop)) : undefined);
      return session;
    });
    try { return await loading; }
    finally { loading = undefined; }
  }
  const openSandbox = sandboxFactory({ settings: () => images.settings(), visuals });
  const connectMachine = machineFactory({ getMode, settings: () => images.settings(), visuals, humanStop, sessionLabel, escapeStop: scopedEscapeStop });
  const provider = await registerComputerProvider(pi, getSession, async () => {
    const result: ComputerResult = session ? await session.close() : {
      content: [{ type: "text", text: "Not started." }],
      details: { status: "closed", mode: getMode() },
    };
    session = undefined;
    return result;
  }, openSandbox, connectMachine, getMode);
  canEnterSafe = () => !provider.resources.hasUnapprovedAgentBrowser();
  // Every extension has loaded by session_start, so an IDE that accepts the provider has done so by now.
  let registered = false;
  pi.on("session_start", () => {
    if (registered) return;
    registered = true;
    registerComputerTools(pi, provider.resources, provider.attached() ? IDE_TOOL_NAMES : STANDALONE_TOOL_NAMES);
    if (!provider.attached()) registerStandaloneTools(pi, provider.resources, fillToolNames(provider.guide, STANDALONE_TOOL_NAMES));
    const namespace = computerNamespace();
    provider.registerCapabilities(pi.getAllTools().filter(tool => tool.namespace?.name === namespace.name).map(tool => tool.name), namespace);
    // Deferred tools are reachable only through tool_search, which Pi registers inactive.
    const active = pi.getActiveTools();
    if (!active.includes("tool_search") && pi.getAllTools().some(tool => tool.name === "tool_search"))
      pi.setActiveTools([...active, "tool_search"]);
  });
  // Copilot's Responses route makes every optional field of a tool with unsaid strictness required (LPT-975).
  registerToolOmission(pi, computerNamespace().name);
  pi.on("session_shutdown", async () => {
    if (loading) await loading.catch(() => undefined);
    visuals.clear();
    await session?.close();
    session = undefined;
  });
}
