import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMemoryRuntime, repairInstalledWindowsMemoryService, startInstalledMemoryService, stopInstalledMemoryService } from "../src/cli/runtime-installer.js";
import { runCommand } from "../src/cli/commands.js";

const lifecycle = vi.hoisted(() => vi.fn(() => ({ status: 0, stdout: "", stderr: "" })));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawnSync: lifecycle,
}));

let root: string;
let home: string;
let runtimeDirectory: string;
const realProcess = process;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "memmy-windows-launcher-"));
  home = join(root, "中文 home & data");
  runtimeDirectory = join(root, "runtime");
  fs.mkdirSync(join(runtimeDirectory, "dist", "src", "server"), { recursive: true });
  fs.writeFileSync(join(runtimeDirectory, "dist", "src", "server", "index.js"), "// fixture\n");
  fs.writeFileSync(join(runtimeDirectory, "memory-runtime.json"), JSON.stringify({
    version: "2.1.0", protocolVersion: 1, target: `windows-${process.arch}`,
  }));
  vi.stubGlobal("process", { ...realProcess, platform: "win32" });
  lifecycle.mockClear();
  lifecycle.mockReset();
  lifecycle.mockReturnValue({ status: 0, stdout: "", stderr: "" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

async function install(skipServiceRegistration = false) {
  return installMemoryRuntime({ home, runtimeDirectory, skipServiceRegistration, skipHealthCheck: true });
}

function registeredXml(): string {
  const call = lifecycle.mock.calls.find((args: unknown[]) => (args[1] as string[]).includes("/Create")) as unknown[] | undefined;
  expect(call, "scheduled task registration").toBeDefined();
  const args = call![1] as string[];
  expect(args).toContain("/XML");
  return fs.readFileSync(args[args.indexOf("/XML") + 1]!, "utf8");
}

describe("Windows standalone Memory service", () => {
  it("routes Desktop's repair command to the selected installation", async () => {
    const repairInstalledService = vi.fn().mockResolvedValue({ ok: true, repaired: false });
    await expect(runCommand({ argv: ["service", "repair-launcher", "--home", home], repairInstalledService }))
      .resolves.toEqual({ ok: true, repaired: false });
    expect(repairInstalledService).toHaveBeenCalledWith(home);
  });
  it("registers a console-free, supervised task without a runtime limit", async () => {
    await install();
    const xml = registeredXml();
    expect(xml).toContain("wscript.exe");
    expect(xml).toContain("/B /Nologo /E:JScript");
    expect(xml).toContain("memmy-memory-service.js");
    expect(xml).not.toContain(".cmd");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("&amp;");
    for (const call of lifecycle.mock.calls as unknown[][]) {
      expect(call[2]).toMatchObject({ windowsHide: true });
    }
  });

  it("keeps the hidden script host waiting and returns the runtime exit code", async () => {
    await install(true);
    const script = fs.readFileSync(join(home, "bin", "memmy-memory-service.js"), "utf8");
    // WSH's JScript encoding must not depend on the user's ANSI code page.
    expect(script).toMatch(/^[\x00-\x7f]*$/);
    const run = vi.fn(() => 7);
    const quit = vi.fn();
    const environment = { Item: vi.fn() };
    // COM property-put syntax is a JScript extension, exercised by the native
    // Windows integration test; V8 can execute the surrounding host lifecycle.
    expect(script).toContain('environment.Item("ELECTRON_RUN_AS_NODE") = "1";');
    runInNewContext(script.replace('environment.Item("ELECTRON_RUN_AS_NODE") = "1";', ""), {
      ActiveXObject: function () { return { Environment: () => environment, Run: run }; },
      WScript: { Quit: quit },
    });
    expect(run).toHaveBeenCalledWith(expect.stringContaining(`"${join(home, "bin", "memmy-memory-service.cjs")}"`), 0, true);
    expect(quit).toHaveBeenCalledWith(7);
  });

  it("appends stdout and stderr, hides the child, and waits for its exit", async () => {
    await install(true);
    const logs = join(home, "memory-service", "logs");
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(join(logs, "service.log"), "previous output\n");
    const child = new EventEmitter();
    const spawn = vi.fn((_executable, _args, options) => {
      expect(options).toMatchObject({ windowsHide: true, env: { MEMMY_HOME: home } });
      expect(options.detached).not.toBe(true);
      expect(options.stdio[0]).toBe("ignore");
      fs.writeSync(options.stdio[1], "background output\n");
      fs.writeSync(options.stdio[2], "background error\n");
      return child;
    });
    const exit = vi.fn();
    runInNewContext(fs.readFileSync(join(home, "bin", "memmy-memory-service.cjs"), "utf8"), {
      require: (id: string) => id === "node:child_process" ? { spawn } : id === "node:fs" ? fs : { join },
      process: { ...realProcess, platform: "win32", argv: [realProcess.execPath, "launcher.cjs"], exit },
      console,
    });
    expect(spawn).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    child.emit("exit", 7, null);
    expect(exit).toHaveBeenCalledWith(7);
    expect(fs.readFileSync(join(logs, "service.log"), "utf8")).toBe("previous output\nbackground output\n");
    expect(fs.readFileSync(join(logs, "service-error.log"), "utf8")).toContain("background error");
  });

  it.each(["invalid pointer", "spawn failure"])("records launcher errors without a console: %s", async (failure) => {
    await install(true);
    if (failure === "invalid pointer") fs.writeFileSync(join(home, "memory-service", "current.json"), "invalid json");
    const child = new EventEmitter();
    const exit = vi.fn();
    runInNewContext(fs.readFileSync(join(home, "bin", "memmy-memory-service.cjs"), "utf8"), {
      require: (id: string) => id === "node:child_process" ? { spawn: () => child } : id === "node:fs" ? fs : { join },
      process: { ...realProcess, platform: "win32", argv: [realProcess.execPath, "launcher.cjs"], exit },
      console,
    });
    if (failure === "spawn failure") child.emit("error", new Error("could not start runtime"));
    expect(exit).toHaveBeenCalledWith(1);
    expect(fs.readFileSync(join(home, "memory-service", "logs", "service-error.log"), "utf8"))
      .toContain(failure === "spawn failure" ? "could not start runtime" : "SyntaxError");
  });

  it("removes the hidden host and task XML after failed first activation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    await expect(installMemoryRuntime({ home, runtimeDirectory, healthCheckTimeoutMs: 10 }))
      .rejects.toThrow("activation health check");
    expect(fs.existsSync(join(home, "bin", "memmy-memory-service.js"))).toBe(false);
    expect(fs.existsSync(join(home, "memory-service", "service-task.xml"))).toBe(false);
    expect(fs.existsSync(join(home, "memory-service", "current.json"))).toBe(false);
  });

  it("leaves an existing installation untouched in reuse dry-run mode", async () => {
    await install(true);
    const script = join(home, "bin", "memmy-memory-service.cjs");
    fs.writeFileSync(script, "legacy launcher");
    lifecycle.mockClear();
    await installMemoryRuntime({ home, runtimeDirectory, preferInstalledCompatible: true, dryRun: true });
    expect(fs.readFileSync(script, "utf8")).toBe("legacy launcher");
    expect(lifecycle).not.toHaveBeenCalled();
  });

  it.each(["repair", "desktop reuse", "desktop upgrade"])("repairs a retained legacy task without starting it: %s", async (action) => {
    await install(true);
    const legacyCommand = `"${join(home, "bin", "memmy-memory-service.cmd")}"`;
    lifecycle.mockReturnValue({ status: 0, stdout: Buffer.from(legacyCommand, "utf8").toString("base64"), stderr: "" });
    lifecycle.mockClear();
    if (action === "repair") await repairInstalledWindowsMemoryService(home);
    else if (action === "desktop reuse") await installMemoryRuntime({ home, runtimeDirectory, preferInstalledCompatible: true, skipServiceRegistration: true, skipHealthCheck: true });
    else {
      fs.writeFileSync(join(runtimeDirectory, "memory-runtime.json"), JSON.stringify({ version: "2.2.0", protocolVersion: 1, target: `windows-${process.arch}` }));
      await install(true);
    }
    expect(registeredXml()).toContain("wscript.exe");
    const commands = (lifecycle.mock.calls as unknown[][]).map((call) => (call[1] as string[])[0]);
    expect(commands).toContain("/End");
    expect(commands).not.toContain("/Run");
  });

  it.each(["", "C:\\other\\memmy-memory-service.cmd", "wscript.exe"])("does not change unrelated or already hidden tasks: %s", async (command) => {
    await install(true);
    lifecycle.mockReturnValue({ status: 0, stdout: Buffer.from(command, "utf8").toString("base64"), stderr: "" });
    lifecycle.mockClear();
    await expect(repairInstalledWindowsMemoryService(home)).resolves.toMatchObject({ repaired: false });
    expect(lifecycle).toHaveBeenCalledOnce();
    expect((lifecycle.mock.calls as unknown[][])[0]).toEqual([
      "powershell.exe", expect.arrayContaining([expect.stringContaining(".Definition.Actions")]),
      expect.objectContaining({ windowsHide: true, timeout: 10_000 })
    ]);
  });

  it.each(["reuse", "start", "upgrade"])("repairs old launchers and stops the old task before %s", async (action) => {
    await install(true);
    const pointerPath = join(home, "memory-service", "current.json");
    const pointer = fs.readFileSync(pointerPath, "utf8");
    fs.writeFileSync(join(home, "config.yaml"), "# preserve config\n");
    fs.writeFileSync(join(home, "memory.sqlite"), "preserve data");
    fs.writeFileSync(join(home, "bin", "memmy-memory-service.cjs"), "old visible launcher");
    fs.writeFileSync(join(home, "bin", "memmy-memory-service.cmd"), "old visible command");
    lifecycle.mockClear();
    if (action === "start") await startInstalledMemoryService(home);
    else if (action === "reuse") await installMemoryRuntime({ home, runtimeDirectory, preferInstalledCompatible: true, skipHealthCheck: true });
    else {
      fs.writeFileSync(join(runtimeDirectory, "memory-runtime.json"), JSON.stringify({ version: "2.2.0", protocolVersion: 1, target: `windows-${process.arch}` }));
      await install();
    }
    expect(fs.readFileSync(join(home, "bin", "memmy-memory-service.cjs"), "utf8")).not.toContain("old visible");
    expect(fs.readFileSync(join(home, "bin", "memmy-memory-service.cmd"), "utf8")).not.toContain("old visible");
    expect(registeredXml()).not.toContain(".cmd");
    const commands = (lifecycle.mock.calls as unknown[][]).map((call) => (call[1] as string[])[0]);
    expect(commands.indexOf("/End")).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf("/End")).toBeLessThan(commands.indexOf("/Create"));
    expect(commands.indexOf("/Create")).toBeLessThan(commands.indexOf("/Run"));
    if (action !== "upgrade") expect(fs.readFileSync(pointerPath, "utf8")).toBe(pointer);
    expect(fs.readFileSync(join(home, "config.yaml"), "utf8")).toBe("# preserve config\n");
    expect(fs.readFileSync(join(home, "memory.sqlite"), "utf8")).toBe("preserve data");
  });

  it("ends the task and shuts down a surviving old service before starting again", async () => {
    await install(true);
    fs.writeFileSync(join(home, "memory-service", "runtime.json"), JSON.stringify({ endpoint: "http://127.0.0.1:18960" }));
    const request = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ protocolVersion: 1 }) })
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", request);
    await startInstalledMemoryService(home);
    expect(request).toHaveBeenCalledWith("http://127.0.0.1:18960/api/v1/admin/shutdown", expect.objectContaining({ method: "POST" }));
    await stopInstalledMemoryService(home);
    expect((lifecycle.mock.calls as unknown[][]).at(-1)?.[1]).toEqual(["/End", "/TN", "Memmy Memory Service"]);
  });
});
