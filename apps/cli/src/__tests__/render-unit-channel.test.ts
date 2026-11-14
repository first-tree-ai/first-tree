import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultHome } from "@first-tree/shared/config";
import { describe, expect, it } from "vitest";
import { channelConfig } from "../core/channel.js";
import {
  renderLaunchdWrapper,
  renderPlist,
  renderSystemdUnit,
  renderWindowsSupervisorCmd,
  renderWindowsSupervisorLauncherVbs,
  renderWindowsTaskXml,
  windowsSupervisorLauncherPath,
  windowsSupervisorLogPath,
  windowsSupervisorWrapperLogPath,
} from "../core/service-install.js";
import { systemdExecQuote, systemdValueQuote } from "../core/supervisor/shared.js";

/**
 * Lock the channel → unit-file contract at the unit-template layer.
 *
 * Today's source tree is `CHANNEL=dev`, so the rendered unit / plist
 * must reference `first-tree-dev.service` / `first-tree-dev` and embed
 * the dev channel's home as `FIRST_TREE_HOME`. CI publishes for prod /
 * staging rewrite `build-info.ts`, so this test couples assertions to
 * whatever `channelConfig` currently reports — that way the same test
 * file pins behaviour across all three channels (CI runs publish
 * pipelines against the rewritten source; the published tarball's
 * assertions match the rewritten channel).
 *
 * Why this exists: prior to the multi-env refactor, `SYSTEMD_UNIT` and
 * `LAUNCHD_LABEL` derived from `deriveServiceSuffix(basename(HOME))` —
 * if a future PR replaces the `channelConfig.serviceUnitFile` /
 * `launchdLabel` references with hardcoded strings (or reintroduces a
 * home-basename derivation), this test catches it.
 */
const FAKE_BIN_INVOCATION = { kind: "bin", program: "/usr/local/bin/first-tree-dev" } as const; // The launchd plist points at the launcher script, not the CLI directly.
// Mirror `launchdWrapperPath()`: <home>/service/<display name>. The display
// name is what macOS shows in the background-items list.
const FAKE_WRAPPER_PATH = join(defaultHome(), "service", channelConfig.displayName);

function nonPortablePath(basePaths: readonly string[]): string {
  return [...new Set([dirname(process.execPath), ...basePaths])].join(":");
}

function extractPlistPathValue(plist: string): string {
  const match = /<key>PATH<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
  if (!match?.[1]) {
    throw new Error("Rendered plist does not contain a PATH environment value.");
  }
  return match[1];
}

function withExecPath(execPath: string, callback: () => void): void {
  const original = process.execPath;
  process.execPath = execPath;
  try {
    callback();
  } finally {
    process.execPath = original;
  }
}

describe("renderSystemdUnit — channel identity baked into unit text", () => {
  const unit = renderSystemdUnit(FAKE_BIN_INVOCATION, "user", nonPortablePath(["/usr/local/bin", "/usr/bin", "/bin"]));

  it("uses the channel's syslog identifier (bare name, no .service)", () => {
    expect(unit).toMatch(new RegExp(`SyslogIdentifier=${channelConfig.launchdLabel}\\b`));
  });

  it("embeds FIRST_TREE_HOME pointed at the resolved home", () => {
    // The unit embeds whatever `defaultHome()` resolves to at render
    // time (channel default unless the operator's FIRST_TREE_HOME env
    // overrides — see service-install.ts docblock about respecting
    // ad-hoc overrides). Assert the literal env line is present with
    // a path matching the current process's resolved home.
    expect(unit).toContain(`Environment="FIRST_TREE_HOME=${defaultHome()}"`);
  });

  it("does NOT reference the pre-multi-env hardcoded `first-tree-client` identifier", () => {
    // Sanity guard: the old `first-tree-client.service` name must not
    // re-appear via copy-paste regression.
    expect(unit).not.toContain("first-tree-client");
  });

  it("embeds the CLI program path in ExecStart", () => {
    expect(unit).toMatch(/ExecStart="\/usr\/local\/bin\/first-tree-dev" daemon start --no-interactive/);
  });

  it("includes the current Node binary directory in PATH", () => {
    const pathLine = unit.split("\n").find((line) => line.startsWith('Environment="PATH='));
    expect(pathLine).toBeDefined();
    expect(pathLine).toContain(dirname(process.execPath));
  });
});

describe("renderPlist — channel identity baked into plist text", () => {
  const plist = renderPlist(
    FAKE_WRAPPER_PATH,
    nonPortablePath(["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"]),
  );

  it("uses the channel's launchd label", () => {
    // Label tag — exact match in the <key>Label</key><string>…</string> pair.
    expect(plist).toContain(`<string>${channelConfig.launchdLabel}</string>`);
  });

  it("embeds FIRST_TREE_HOME pointed at the resolved home", () => {
    // Same rationale as the systemd unit test: the plist embeds the
    // value `defaultHome()` resolves to at render time (which respects
    // any ad-hoc FIRST_TREE_HOME override). XML escape is a no-op for
    // typical home paths.
    expect(plist).toContain("<key>FIRST_TREE_HOME</key>");
    expect(plist).toContain(`<string>${defaultHome()}</string>`);
  });

  it("does NOT reference the pre-multi-env hardcoded `dev.first-tree.client` label", () => {
    expect(plist).not.toContain("dev.first-tree.client");
  });

  it("launches via the display-name wrapper script in ProgramArguments", () => {
    // ProgramArguments[0] is the launcher script path, whose basename is the
    // channel display name. macOS shows that basename in the background-items
    // list, so this is what keeps the daemon from appearing as `index.mjs`.
    expect(plist).toContain(`<string>${FAKE_WRAPPER_PATH}</string>`);
    expect(plist).toContain(`/service/${channelConfig.displayName}`);
  });

  it("includes the current Node binary directory in PATH", () => {
    const pathEntries = extractPlistPathValue(plist).split(":");
    expect(pathEntries[0]).toBe(dirname(process.execPath));
  });

  it("keeps launchd fallback paths in PATH", () => {
    const pathEntries = extractPlistPathValue(plist).split(":");
    expect(pathEntries).toEqual(expect.arrayContaining(["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"]));
  });

  it("does not emit duplicate PATH entries", () => {
    const pathEntries = extractPlistPathValue(plist).split(":");
    expect(new Set(pathEntries).size).toBe(pathEntries.length);
  });

  it("does not duplicate launchd fallback paths that match the current Node binary directory", () => {
    withExecPath("/usr/local/bin/node", () => {
      const pathEntries = extractPlistPathValue(
        renderPlist(FAKE_WRAPPER_PATH, nonPortablePath(["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"])),
      ).split(":");
      expect(pathEntries[0]).toBe("/usr/local/bin");
      expect(pathEntries.filter((entry) => entry === "/usr/local/bin")).toHaveLength(1);
    });
  });
});

describe("renderLaunchdWrapper — launcher script supervises the resolved CLI", () => {
  it("starts with a /bin/sh shebang", () => {
    expect(renderLaunchdWrapper(FAKE_BIN_INVOCATION)).toMatch(/^#!\/bin\/sh\n/);
  });

  it("invokes the bin with the daemon args", () => {
    expect(renderLaunchdWrapper(FAKE_BIN_INVOCATION)).toContain(
      "/usr/local/bin/first-tree-dev daemon start --no-interactive",
    );
  });

  it("invokes the node interpreter + script for the node invocation", () => {
    const wrapper = renderLaunchdWrapper({
      kind: "node",
      program: "/usr/bin/node",
      args: ["/opt/first-tree/dist/cli/index.mjs"],
    });
    expect(wrapper).toContain("/usr/bin/node /opt/first-tree/dist/cli/index.mjs daemon start --no-interactive");
  });

  it.skipIf(process.platform === "win32")(
    "does not execute command substitution baked into the resolved CLI path",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "first-tree-launchd-quote-"));
      const marker = join(dir, "pwned");
      const wrapperPath = join(dir, "wrapper");
      try {
        // SEC-028: a path carrying `$(...)` must stay inert text in the
        // launcher. Double quotes plus backslash escaping are not enough.
        writeFileSync(wrapperPath, renderLaunchdWrapper({ kind: "bin", program: `$(touch ${marker})` }), {
          mode: 0o755,
        });
        // The wrapper restarts on every failure; one iteration is enough for a
        // substitution that was left unescaped to run.
        spawnSync("/bin/sh", [wrapperPath], { timeout: 1500, encoding: "utf8" });
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "reloads an atomically replaced wrapper after exit 75 without waiting for launchd to respawn it",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "first-tree-launchd-wrapper-"));
      const oldDaemon = join(dir, "old daemon");
      const newDaemon = join(dir, "new daemon");
      const wrapperPath = join(dir, "First Tree");
      const replacementPath = join(dir, "First Tree.next");
      const markerPath = join(dir, "invocations");
      try {
        writeFileSync(
          oldDaemon,
          `#!/bin/sh
if [ -f "$FIRST_TREE_TEST_MARKER" ]; then
  printf 'old-again\n' >> "$FIRST_TREE_TEST_MARKER"
  exit 9
fi
printf 'old\n' > "$FIRST_TREE_TEST_MARKER"
mv "$FIRST_TREE_TEST_REPLACEMENT" "$FIRST_TREE_TEST_WRAPPER"
exit 75
`,
          { mode: 0o755 },
        );
        writeFileSync(
          newDaemon,
          `#!/bin/sh
printf 'new\n' >> "$FIRST_TREE_TEST_MARKER"
exit 0
`,
          { mode: 0o755 },
        );
        writeFileSync(wrapperPath, renderLaunchdWrapper({ kind: "bin", program: oldDaemon }), { mode: 0o755 });
        writeFileSync(replacementPath, renderLaunchdWrapper({ kind: "bin", program: newDaemon }), { mode: 0o755 });

        const result = spawnSync("/bin/sh", [wrapperPath], {
          env: {
            ...process.env,
            FIRST_TREE_TEST_MARKER: markerPath,
            FIRST_TREE_TEST_REPLACEMENT: replacementPath,
            FIRST_TREE_TEST_WRAPPER: wrapperPath,
          },
          encoding: "utf8",
        });

        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(markerPath, "utf8")).toBe("old\nnew\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("renderWindowsTaskXml — channel identity baked into Task Scheduler text", () => {
  const launcherPath = join(defaultHome(), "service", `${channelConfig.launchdLabel}-supervisor.vbs`);
  const taskXml = renderWindowsTaskXml(launcherPath, "ACME\\developer");

  it("declares the UTF-16 encoding used for the imported task XML file", () => {
    expect(taskXml).toMatch(/^<\?xml version="1\.0" encoding="UTF-16"\?>/u);
  });

  it("uses an interactive least-privilege logon trigger", () => {
    expect(taskXml).toContain("<LogonTrigger>");
    expect(taskXml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(taskXml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  });

  it("launches a hidden script host launcher and avoids RestartOnFailure", () => {
    expect(taskXml).toContain("wscript.exe");
    expect(taskXml).toContain(launcherPath);
    expect(taskXml).toContain(`${channelConfig.launchdLabel}-supervisor.vbs`);
    expect(taskXml).not.toContain(`${channelConfig.launchdLabel}-supervisor.cmd`);
    expect(taskXml).not.toContain("RestartOnFailure");
  });
});

describe("renderWindowsSupervisorLauncherVbs — hidden launcher wraps the supervisor cmd", () => {
  it("runs the cmd wrapper hidden and waits for its exit code", () => {
    const wrapperPath = join(defaultHome(), "service", `${channelConfig.launchdLabel}-supervisor.cmd`);
    const launcher = renderWindowsSupervisorLauncherVbs(wrapperPath);

    expect(windowsSupervisorLauncherPath()).toContain(`${channelConfig.launchdLabel}-supervisor.vbs`);
    expect(launcher).toContain('Set shell = CreateObject("WScript.Shell")');
    expect(launcher).toContain(`shell.Run("""${wrapperPath}""", 0, True)`);
  });
});

describe("renderWindowsSupervisorCmd — wrapper enters the hidden supervisor command", () => {
  it("pins FIRST_TREE_HOME and preserves node script invocation order", () => {
    const wrapper = renderWindowsSupervisorCmd({
      kind: "node",
      program: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\First Tree\\index.mjs"],
    });
    expect(wrapper).toContain(`set "FIRST_TREE_HOME=${defaultHome()}"`);
    expect(wrapper).toContain('"C:\\Program Files\\nodejs\\node.exe" "C:\\First Tree\\index.mjs" "daemon" "supervise"');
    expect(wrapper).toContain(`>>"${windowsSupervisorWrapperLogPath()}" 2>&1`);
    expect(wrapper).not.toContain(`>>"${windowsSupervisorLogPath()}"`);
    expect(wrapper).toContain(" 2>&1");
  });
});

/**
 * SEC-028 follow-up: the launchd wrapper is `/bin/sh`, the systemd unit is parsed
 * by systemd itself. They need different serializers — POSIX single quotes for
 * the former, C-style escapes inside one quoted item for the latter. These tests
 * round-trip awkward paths through a decoder written to systemd's documented
 * rules, so a serializer that silently mangles a path fails here.
 */
describe("systemd unit quoting", () => {
  function systemdUnquote(item: string, options: { expandable: boolean }): string {
    if (!(item.startsWith('"') && item.endsWith('"'))) throw new Error(`expected one quoted item, got ${item}`);
    const body = item.slice(1, -1);
    let out = "";
    for (let i = 0; i < body.length; i += 1) {
      const char = body[i];
      if (char === "\\") {
        const next = body[i + 1];
        i += 1;
        out += next === "n" ? "\n" : next === "t" ? "\t" : next;
        continue;
      }
      if (char === "$" && options.expandable && body[i + 1] === "$") {
        out += "$";
        i += 1;
        continue;
      }
      if (char === "%" && body[i + 1] === "%") {
        out += "%";
        i += 1;
        continue;
      }
      out += char;
    }
    return out;
  }

  const AWKWARD = [
    "/Users/Me/First Tree/bin/first-tree",
    "/opt/O'Brien tools/cli",
    "C:\\tools\\node\\node.exe",
    "/srv/100% ready/bin",
    "/tmp/$HOME/bin",
    '/tmp/he said "hi"/bin',
  ];

  it("round-trips ExecStart arguments", () => {
    for (const value of AWKWARD) {
      expect(systemdUnquote(systemdExecQuote(value), { expandable: true })).toBe(value);
    }
  });

  it("round-trips full Environment assignments as one item", () => {
    for (const value of AWKWARD) {
      const item = systemdValueQuote(`FIRST_TREE_HOME=${value}`);
      expect(item.startsWith('"')).toBe(true);
      expect(systemdUnquote(item, { expandable: false })).toBe(`FIRST_TREE_HOME=${value}`);
    }
  });

  it("does not leave a bare dollar or specifier for systemd to expand", () => {
    expect(systemdExecQuote("/tmp/$HOME/bin")).not.toMatch(/(?<!\$)\$HOME/u);
    expect(systemdExecQuote("/srv/100%/bin")).toContain("%%");
    expect(systemdValueQuote("PATH=/srv/100%")).toContain("%%");
  });

  it("renders the unit with one quoted item per argument and assignment", () => {
    const unit = renderSystemdUnit(
      { kind: "bin", program: "/usr/local/bin/first tree" },
      "user",
      "/opt/node/bin:/usr/bin",
    );
    expect(unit).toContain('ExecStart="/usr/local/bin/first tree" daemon start --no-interactive');
    expect(unit).toContain(`Environment="FIRST_TREE_HOME=${defaultHome()}"`);
    expect(unit).toContain('Environment="PATH=/opt/node/bin:/usr/bin"');
  });
});
