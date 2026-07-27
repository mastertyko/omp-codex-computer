import { describe, expect, it } from "vitest";
import {
  formatAppTargetResolution,
  formatInvalidAppDiagnostic,
  parseComputerUseAppList,
  resolveAppTargetFromList,
  resolveAppTargetFromStructuredList,
} from "../src/app-target-resolver";

const LEGACY_LIST_APPS_TEXT = [
  "Dudo CUA Test — /tmp/DudoCUATest.app/ — dev.dudo.cua-smoke [running]",
  "Google Chrome — /Applications/Google Chrome.app/ — com.google.Chrome [running]",
  "cmux — /Applications/cmux.app — com.cmuxterm.app [last-used=2026-07-06]",
].join("\n");

const SKY_LIST_APPS = [
  {
    id: "com.openai.codex",
    displayName: "Codex",
    isRunning: true,
    lastUsedDate: 1_785_150_985_211,
    useCount: 37,
  },
  {
    id: "com.google.Chrome",
    displayName: "Google Chrome",
    isRunning: false,
    lastUsedDate: "2026-07-26T19:02:14.289Z",
    useCount: 144,
  },
  {
    id: "com.apple.finder",
    isRunning: true,
    lastUsedDate: 1_785_151_102_044,
    useCount: 329,
  },
  {
    id: "com.openai.codex",
    displayName: "Duplicate Codex entry",
    isRunning: false,
    lastUsedDate: 1_785_140_000_000,
    useCount: 2,
  },
];

const SKY_LIST_APPS_JSON = JSON.stringify(SKY_LIST_APPS);

describe("app target resolver", () => {
  it("parses legacy list_apps output with canonical upstream addresses", () => {
    expect(parseComputerUseAppList(LEGACY_LIST_APPS_TEXT)).toEqual([
      {
        displayName: "Dudo CUA Test",
        appPath: "/tmp/DudoCUATest.app/",
        bundleId: "dev.dudo.cua-smoke",
        upstreamAddress: "dev.dudo.cua-smoke",
      },
      {
        displayName: "Google Chrome",
        appPath: "/Applications/Google Chrome.app/",
        bundleId: "com.google.Chrome",
        upstreamAddress: "com.google.Chrome",
      },
      {
        displayName: "cmux",
        appPath: "/Applications/cmux.app",
        bundleId: "com.cmuxterm.app",
        upstreamAddress: "com.cmuxterm.app",
      },
    ]);
  });

  it("parses current Sky JSON, accepts live metadata types, and deduplicates by app id", () => {
    expect(parseComputerUseAppList(SKY_LIST_APPS_JSON)).toEqual([
      {
        displayName: "Codex",
        upstreamAddress: "com.openai.codex",
      },
      {
        displayName: "Google Chrome",
        upstreamAddress: "com.google.Chrome",
      },
      {
        displayName: "com.apple.finder",
        upstreamAddress: "com.apple.finder",
      },
    ]);
  });

  it("resolves structured Sky arrays whose pretty text would exceed 50 KiB", () => {
    const oversizedMetadata = "x".repeat(50 * 1024 + 1);
    const structuredList = [
      {
        id: "com.openai.codex",
        displayName: "Codex",
        isRunning: "not-a-boolean",
        lastUsedDate: oversizedMetadata,
        useCount: { unexpected: true },
      },
      ...SKY_LIST_APPS,
    ];

    expect(oversizedMetadata.length).toBeGreaterThan(50 * 1024);
    expect(resolveAppTargetFromStructuredList("com.openai.codex", structuredList)).toMatchObject({
      status: "resolved",
      registeredAppCount: 3,
      target: {
        kind: "app_id",
        displayName: "Codex",
        appPath: undefined,
        bundleId: undefined,
        upstreamAddress: "com.openai.codex",
      },
    });
  });

  it("falls back to legacy text when structured Sky content is malformed", () => {
    const malformedStructuredContent = { apps: SKY_LIST_APPS };
    expect(resolveAppTargetFromStructuredList("Dudo CUA Test", malformedStructuredContent)).toBeUndefined();

    const diagnostic = formatInvalidAppDiagnostic(
      "Invalid app: Dudo CUA Test",
      "Dudo CUA Test",
      LEGACY_LIST_APPS_TEXT,
      undefined,
      malformedStructuredContent,
    );

    expect(diagnostic).toContain("match: display_name");
    expect(diagnostic).toContain("recommendedAddress: dev.dudo.cua-smoke");
  });

  it("formats invalid-app diagnosis from structured Sky data before legacy text", () => {
    const diagnostic = formatInvalidAppDiagnostic(
      "Invalid app: com.openai.codex",
      "com.openai.codex",
      LEGACY_LIST_APPS_TEXT,
      undefined,
      SKY_LIST_APPS,
    );

    expect(diagnostic).toContain("Plugin diagnosis:\nResolved app target.");
    expect(diagnostic).toContain("match: app_id");
    expect(diagnostic).toContain("displayName: Codex");
    expect(diagnostic).toContain("appPath: (not provided)");
    expect(diagnostic).toContain("recommendedAddress: com.openai.codex");
  });

  it("resolves exact Sky app ids and display names without fabricating app paths", () => {
    const idMatch = resolveAppTargetFromList("com.openai.codex", SKY_LIST_APPS_JSON);
    expect(idMatch).toMatchObject({
      status: "resolved",
      registeredAppCount: 3,
      target: {
        kind: "app_id",
        displayName: "Codex",
        appPath: undefined,
        bundleId: undefined,
        upstreamAddress: "com.openai.codex",
      },
    });

    const displayNameMatch = resolveAppTargetFromList("Google Chrome", SKY_LIST_APPS_JSON);
    expect(displayNameMatch).toMatchObject({
      status: "resolved",
      registeredAppCount: 3,
      target: {
        kind: "display_name",
        displayName: "Google Chrome",
        appPath: undefined,
        bundleId: undefined,
        upstreamAddress: "com.google.Chrome",
      },
    });

    const text = formatAppTargetResolution(idMatch);
    expect(text).toContain("appPath: (not provided)");
    expect(text).toContain("recommendedAddress: com.openai.codex");
    expect(text).not.toContain("/Applications/Codex.app");
  });

  it("offers Sky app-id candidates without inventing legacy fields", () => {
    const resolution = resolveAppTargetFromList("Chrome", SKY_LIST_APPS_JSON);
    expect(resolution).toMatchObject({
      status: "unresolved",
      registeredAppCount: 3,
      candidates: [
        {
          kind: "registered_app",
          displayName: "Google Chrome",
          appPath: undefined,
          bundleId: undefined,
          upstreamAddress: "com.google.Chrome",
        },
      ],
    });
    expect(formatAppTargetResolution(resolution)).toContain("Google Chrome — (not provided) — recommended: com.google.Chrome");
  });

  it("rejects malformed Sky JSON entries", () => {
    const malformed = JSON.stringify([
      null,
      "Codex",
      [],
      {},
      { displayName: "Missing id" },
      { id: "" },
      { id: "   " },
      { id: 42, displayName: "Numeric id" },
      { id: "invalid-display-name", displayName: 42 },
    ]);

    expect(parseComputerUseAppList(malformed)).toEqual([]);
  });

  it("resolves exact legacy bundle id, app path, and display name matches", () => {
    const bundleMatch = resolveAppTargetFromList("dev.dudo.cua-smoke", LEGACY_LIST_APPS_TEXT);
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

    const appPathMatch = resolveAppTargetFromList("/tmp/DudoCUATest.app", LEGACY_LIST_APPS_TEXT);
    expect(appPathMatch).toMatchObject({
      status: "resolved",
      target: {
        kind: "app_path",
        upstreamAddress: "dev.dudo.cua-smoke",
      },
    });

    const displayNameMatch = resolveAppTargetFromList("Dudo CUA Test", LEGACY_LIST_APPS_TEXT);
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
    const resolution = resolveAppTargetFromList("/repo/target/debug/dudo", LEGACY_LIST_APPS_TEXT);
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
    const resolution = resolveAppTargetFromList("pid:29156", LEGACY_LIST_APPS_TEXT);
    const text = formatAppTargetResolution(resolution);
    expect(resolution).toMatchObject({
      status: "unsupported",
      unsupportedKind: "pid",
    });
    expect(text).toContain("PID targets are not supported");
    expect(text).toContain("bundle id or .app bundle path");
  });

  it("keeps unresolved legacy apps as diagnostics with candidate hints", () => {
    const resolution = resolveAppTargetFromList("Dudo", LEGACY_LIST_APPS_TEXT);
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
