import { describe, expect, it } from "vitest";
import {
  formatAppTargetResolution,
  parseComputerUseAppList,
  resolveAppTargetFromList,
} from "../src/app-target-resolver";

const LIST_APPS_TEXT = [
  "Dudo CUA Test — /tmp/DudoCUATest.app/ — dev.dudo.cua-smoke [running]",
  "Google Chrome — /Applications/Google Chrome.app/ — com.google.Chrome [running]",
  "cmux — /Applications/cmux.app — com.cmuxterm.app [last-used=2026-07-06]",
].join("\n");

describe("app target resolver", () => {
  it("parses Computer Use list_apps output", () => {
    expect(parseComputerUseAppList(LIST_APPS_TEXT)).toEqual([
      {
        displayName: "Dudo CUA Test",
        appPath: "/tmp/DudoCUATest.app/",
        bundleId: "dev.dudo.cua-smoke",
      },
      {
        displayName: "Google Chrome",
        appPath: "/Applications/Google Chrome.app/",
        bundleId: "com.google.Chrome",
      },
      {
        displayName: "cmux",
        appPath: "/Applications/cmux.app",
        bundleId: "com.cmuxterm.app",
      },
    ]);
  });

  it("resolves exact bundle id, app path, and display name matches with bundle-id/path recommendations", () => {
    const bundleMatch = resolveAppTargetFromList("dev.dudo.cua-smoke", LIST_APPS_TEXT);
    expect(bundleMatch).toMatchObject({
      status: "resolved",
      target: {
        kind: "bundle_id",
        displayName: "Dudo CUA Test",
        appPath: "/tmp/DudoCUATest.app/",
        bundleId: "dev.dudo.cua-smoke",
        upstreamAddress: "dev.dudo.cua-smoke",
      },
    });

    const appPathMatch = resolveAppTargetFromList("/tmp/DudoCUATest.app", LIST_APPS_TEXT);
    expect(appPathMatch).toMatchObject({
      status: "resolved",
      target: {
        kind: "app_path",
        upstreamAddress: "dev.dudo.cua-smoke",
      },
    });

    const displayNameMatch = resolveAppTargetFromList("Dudo CUA Test", LIST_APPS_TEXT);
    expect(displayNameMatch).toMatchObject({
      status: "resolved",
      target: {
        kind: "display_name",
        upstreamAddress: "dev.dudo.cua-smoke",
      },
    });

    expect(formatAppTargetResolution(displayNameMatch)).toContain("bundleId: dev.dudo.cua-smoke");
    expect(formatAppTargetResolution(displayNameMatch)).toContain("appPath: /tmp/DudoCUATest.app/");
    expect(formatAppTargetResolution(displayNameMatch)).toContain("recommendedAddress: dev.dudo.cua-smoke");
  });

  it("diagnoses raw executable paths without pretending upstream can address them", () => {
    const resolution = resolveAppTargetFromList("/repo/target/debug/dudo", LIST_APPS_TEXT);
    const text = formatAppTargetResolution(resolution);
    expect(resolution).toMatchObject({
      status: "unsupported",
      unsupportedKind: "raw_executable",
    });
    expect(text).toContain("temporary .app bundle");
    expect(text).toContain("bundle id or .app bundle path");
    expect(text).toContain("raw executable paths");
  });

  it("diagnoses PID targets without pretending upstream can address them", () => {
    const resolution = resolveAppTargetFromList("pid:29156", LIST_APPS_TEXT);
    const text = formatAppTargetResolution(resolution);
    expect(resolution).toMatchObject({
      status: "unsupported",
      unsupportedKind: "pid",
    });
    expect(text).toContain("PID targets are not supported");
    expect(text).toContain("bundle id or .app bundle path");
  });

  it("keeps unresolved missing apps as diagnostics with candidate hints", () => {
    const resolution = resolveAppTargetFromList("Dudo", LIST_APPS_TEXT);
    expect(resolution).toMatchObject({
      status: "unresolved",
      candidates: [
        {
          displayName: "Dudo CUA Test",
          upstreamAddress: "dev.dudo.cua-smoke",
        },
      ],
    });
    expect(formatAppTargetResolution(resolution)).toContain("This does not prove the app is not running");
  });
});
