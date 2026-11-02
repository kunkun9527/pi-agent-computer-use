import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadComputerConfig, readMachineSettings, type ComputerConfig } from "./config.ts";
import { prepareRemoteRuntime } from "./remote-runtime.ts";
import { ComputerRequestError, machineGuide, type MachineFactory, type SandboxFactory } from "./computer-resources.ts";
import type { CuaVisionSettings } from "./cua-image-settings.ts";
import { McpDriver } from "./driver.ts";
import { MachineHost } from "./machine-host.ts";
import { localRunner, sshRunner, type CommandRunner } from "./runner.ts";
import { WindowsSandbox, runnerHost, sandboxOptions, waitForGuestDriver } from "./sandbox.ts";
import { IsolatedSession } from "./isolated-session.ts";
import { ComputerSession, type ComputerMode } from "./session.ts";
import type { VisualSettings } from "./native-visuals.ts";
import type { HumanStop } from "./human-stop.ts";

/** The configured machine for a connect command; unknown names refuse before any SSH work. */
export async function machineConfig(cwd: string, name: string): Promise<NonNullable<ComputerConfig["machines"]>[string]> {
  const machine = (await readMachineSettings(cwd)).machines[name];
  if (!machine) throw new ComputerRequestError(`No machine named ${name} is configured in .pi/computer-use.json.`);
  return machine;
}

/** The worker files whose version decides the remote browser's behavior, relative to its package copy. */
const WORKER_FILES: [string, string][] = [
  ["src/web-worker.ts", fileURLToPath(new URL("./web-worker.ts", import.meta.url))],
  ["src/agent-profile-lock.ts", fileURLToPath(new URL("./agent-profile-lock.ts", import.meta.url))],
  ["src/browser-command-line.ts", fileURLToPath(new URL("./browser-command-line.ts", import.meta.url))],
  ["src/aria-match.ts", fileURLToPath(new URL("./aria-match.ts", import.meta.url))],
  ["src/web-geometry.ts", fileURLToPath(new URL("./web-geometry.ts", import.meta.url))],
  ["node_modules/playwright-core/package.json", createRequire(import.meta.url).resolve("playwright-core/package.json")],
];

/**
 * Refuse a remote browser before launch when that machine's worker copy differs from this package, so an old
 * worker never silently ignores newer options. `refresh` is the setup command that updates the copy.
 */
export async function checkRemoteWorker(runner: CommandRunner, remotePackage: string, refresh: string, signal?: AbortSignal): Promise<void> {
  const local = await Promise.all(WORKER_FILES.map(async ([, file]) => createHash("sha256").update(await readFile(file)).digest("hex")));
  // A missing file fails sha256sum: then every file counts as stale.
  const output = await runner.run("sha256sum", WORKER_FILES.map(([name]) => `${remotePackage}/${name}`), { signal, timeoutMs: 10_000 })
    .catch(() => "");
  const remote = output.split("\n").map(line => line.split(" ")[0]);
  const stale = WORKER_FILES.filter((_, index) => remote[index] !== local[index]).map(([name]) => name);
  if (stale.length) throw new ComputerRequestError(`The browser worker on this machine is missing or out of date (${stale.join(", ")}); nothing was launched. `
    + `Refresh it from this package with ${refresh}, then open the browser again.`);
}

/**
 * Each sandbox or isolated agent session gets its own guest driver and session: no host overlay, no browser launch, every guest window is the agent's own.
 * On another machine the sandbox host and its files are reached over SSH, and the guest relays through SSH tunnels.
 */
export function sandboxFactory(options: { settings: () => CuaVisionSettings; visuals?: VisualSettings }): SandboxFactory {
  return async (cwd, command, signal, machineName) => {
    let parsed;
    try {
      if (command.action === "open_session" && Object.keys(command).some(key => key !== "action")) throw new Error("open_session takes no options.");
      parsed = command.action === "open_session" ? undefined : sandboxOptions(command);
    } catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
    const machine = machineName ? await machineConfig(cwd, machineName) : undefined;
    const config = machine ? undefined : await loadComputerConfig(cwd);
    const runner = machine ? sshRunner(machine.ssh) : localRunner(config!.interop);
    const commandPath = machine ? machine.command ?? await prepareRemoteRuntime(runner, signal) : config!.command;
    const runtime = machine ? machine.command ? machine.runtime : "windows-desktop" : config!.runtime;
    const sandbox = parsed ? await WindowsSandbox.open(runnerHost(runner), commandPath, parsed, signal)
      : await IsolatedSession.open(runnerHost(runner), commandPath, signal);
    // The endpoint selects the guest transport; ssh only makes the runtime hash check read the machine's own bytes.
    const override = machine ? machine.driverOverride : config!.driverOverride;
    const driver = new McpDriver({ command: commandPath, ...(runtime ? { runtime } : {}), ...(override ? { driverOverride: true as const } : {}),
      endpoint: sandbox.endpoint, ...(machine ? { ssh: machine.ssh } : {}) }, undefined, options.visuals);
    try { await waitForGuestDriver(driver, signal); }
    catch (error) { await driver.close().catch(() => undefined); await sandbox.close(); throw error; }
    const guest = new ComputerSession(driver, () => "yolo", options.settings);
    return { ref: sandbox.ref, session: guest, describe: source => sandbox.describe(source), ...(machineName ? { machine: machineName } : {}),
      close: async () => { try { await guest.close(); } finally { await sandbox.close(); } } };
  };
}

/**
 * Another machine's desktop gets its own driver and session over SSH. Safe/YOLO is the user's choice there too;
 * the host overlay is not shown, and browsers start on that machine.
 */
export function machineFactory(options: { getMode: () => ComputerMode; settings: () => CuaVisionSettings; visuals?: VisualSettings; humanStop?: HumanStop; sessionLabel?: () => string | undefined; escapeStop?: (cwd: string) => Promise<boolean | undefined> }): MachineFactory {
  return async (cwd, name, signal) => {
    const machine = await machineConfig(cwd, name);
    const escapeStop = options.escapeStop ? await options.escapeStop(cwd) : (await readMachineSettings(cwd)).escapeStop;
    const runner = sshRunner(machine.ssh);
    const command = machine.command ?? await prepareRemoteRuntime(runner, signal);
    const runtime = machine.command ? machine.runtime : "windows-desktop";
    const driver = new McpDriver({ command, ...(runtime ? { runtime } : {}), ...(machine.driverOverride ? { driverOverride: true as const } : {}), ...(escapeStop !== undefined ? { escapeStop } : {}), ssh: machine.ssh }, undefined, options.visuals, options.humanStop, options.sessionLabel);
    try { await waitForGuestDriver(driver, signal, 30_000); }
    catch (error) { await driver.close().catch(() => undefined); throw error; }
    // Remote machines expose native Windows UIA only.
    const remote = new ComputerSession(driver, options.getMode, options.settings, undefined, undefined, new MachineHost(runner));
    return { ref: name, session: remote,
      describe: source => [`# Machine ${name}`, `Address: ${source}`, `SSH: ${machine.ssh}`,
        "Native UIA only; browser page automation disabled", ...machineGuide(source)].join("\n"),
      close: () => remote.close() };
  };
}
