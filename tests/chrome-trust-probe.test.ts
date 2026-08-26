import { beforeEach, describe, expect, it, vi } from "vitest";
import { runChromeTrustProbe } from "../src/chrome-trust-probe";
import type { ChromeStatus } from "../src/chrome-status";

const statusMock = vi.hoisted(() => ({
  checkChromeStatus: vi.fn<() => Promise<ChromeStatus>>(),
  formatChromeStatus: vi.fn(() => "formatted status"),
}));
const trustMock = vi.hoisted(() => ({
  persistTrustedAppServerVersion: vi.fn(async () => "/config/omp-codex-computer/trusted-app-servers.json"),
}));
const runtimeMock = vi.hoisted(() => {
  const instance = {
    beginAgent: vi.fn(async () => {}),
    open: vi.fn(async () => ({ kind: "snapshot" })),
    observe: vi.fn(async () => ({ kind: "snapshot" })),
    act: vi.fn(async () => ({ kind: "snapshot" })),
    endAgent: vi.fn(async () => {}),
  };
  const constructorArgs: unknown[] = [];
  return {
    instance,
    constructorArgs,
    ChromeRuntime: vi.fn(function (dependencies: unknown) {
      constructorArgs.push(dependencies);
      return instance;
    }),
  };
});
const transportMock = vi.hoisted(() => ({
  constructorOptions: [] as unknown[],
}));

vi.mock("../src/chrome-status", () => statusMock);
vi.mock("../src/chrome-trust", () => trustMock);
vi.mock("../src/chrome-runtime", () => ({ ChromeRuntime: runtimeMock.ChromeRuntime }));
vi.mock("../src/app-server-client", () => ({
  AppServerClient: vi.fn(function () {
    return {};
  }),
}));
vi.mock("../src/thread-manager", () => ({
  CodexThreadManager: vi.fn(function () {
    return {};
  }),
}));
vi.mock("../src/chrome-transport", () => ({
  ChromeTransport: vi.fn(function (_client: unknown, _threads: unknown, options: unknown) {
    transportMock.constructorOptions.push(options);
    return {};
  }),
  ChromeTransportError: class ChromeTransportError extends Error {
    constructor(readonly code: string, message = `Chrome error: ${code}`) {
      super(message);
    }
  },
}));

function status(overrides: Partial<ChromeStatus> = {}): ChromeStatus {
  return {
    status: "unavailable",
    reason: "unsupported_app_server_version",
    message: "untrusted",
    trustedAppServerVersions: ["0.149.0"],
    observedPluginVersions: ["26.818.61809"],
    observedAppServerVersion: "0.150.0",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  transportMock.constructorOptions.length = 0;
  statusMock.checkChromeStatus.mockResolvedValue(status());
  runtimeMock.instance.open.mockResolvedValue({ kind: "snapshot" });
  runtimeMock.instance.act.mockResolvedValue({ kind: "snapshot" });
  runtimeMock.instance.endAgent.mockResolvedValue(undefined);
});

describe("runChromeTrustProbe", () => {
  it("aborts without probing when the app-server version cannot be observed", async () => {
    statusMock.checkChromeStatus.mockResolvedValue(status({ observedAppServerVersion: undefined }));

    const report = await runChromeTrustProbe("/work");

    expect(report).toContain("could not be observed");
    expect(report).toContain("formatted status");
    expect(runtimeMock.instance.beginAgent).not.toHaveBeenCalled();
    expect(trustMock.persistTrustedAppServerVersion).not.toHaveBeenCalled();
  });

  it("aborts without probing when a non-version check fails", async () => {
    statusMock.checkChromeStatus.mockResolvedValue(status({ reason: "plugin_contract_mismatch" }));

    const report = await runChromeTrustProbe("/work");

    expect(report).toContain("non-version check");
    expect(runtimeMock.instance.beginAgent).not.toHaveBeenCalled();
    expect(trustMock.persistTrustedAppServerVersion).not.toHaveBeenCalled();
  });

  it("persists the candidate only after every live step succeeds", async () => {
    const report = await runChromeTrustProbe("/work");

    expect(transportMock.constructorOptions).toEqual([{ extraTrustedAppServerVersions: ["0.150.0"] }]);
    expect(runtimeMock.instance.open).toHaveBeenCalledWith(expect.anything(), "https://example.com/");
    expect(runtimeMock.instance.act).toHaveBeenNthCalledWith(1, expect.anything(), { kind: "reload" });
    expect(runtimeMock.instance.act).toHaveBeenNthCalledWith(2, expect.anything(), { kind: "close" });
    expect(runtimeMock.instance.endAgent).toHaveBeenCalledTimes(1);
    expect(trustMock.persistTrustedAppServerVersion).toHaveBeenCalledWith("0.150.0");
    expect(report).toContain("passed for Codex app-server 0.150.0");
    expect(report).toContain("open, observe, reload, close, cleanup");
    expect(report).toContain("/config/omp-codex-computer/trusted-app-servers.json");
  });

  it("does not persist an already trusted version after a green probe", async () => {
    statusMock.checkChromeStatus.mockResolvedValue(status({
      status: "ready",
      reason: "ready",
      observedAppServerVersion: "0.149.0",
    }));

    const report = await runChromeTrustProbe("/work");

    expect(trustMock.persistTrustedAppServerVersion).not.toHaveBeenCalled();
    expect(report).toContain("already trusted");
  });

  it("persists nothing when a probe step fails and still cleans up", async () => {
    runtimeMock.instance.act.mockRejectedValueOnce(new Error("boom with /private/path secrets"));

    const report = await runChromeTrustProbe("/work");

    expect(trustMock.persistTrustedAppServerVersion).not.toHaveBeenCalled();
    expect(runtimeMock.instance.endAgent).toHaveBeenCalledTimes(1);
    expect(report).toContain("nothing was trusted");
    expect(report).toContain("Completed steps: open, observe");
    expect(report).not.toContain("/private/path");
  });

  it("treats a cleanup failure as a probe failure", async () => {
    runtimeMock.instance.endAgent.mockRejectedValueOnce(new Error("cleanup broke"));

    const report = await runChromeTrustProbe("/work");

    expect(trustMock.persistTrustedAppServerVersion).not.toHaveBeenCalled();
    expect(report).toContain("nothing was trusted");
  });
});
