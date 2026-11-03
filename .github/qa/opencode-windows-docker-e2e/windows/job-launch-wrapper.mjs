import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const specPath = process.argv[2];
if (!specPath) throw new Error("launch spec path is required");

const spec = JSON.parse(readFileSync(specPath, "utf8").replace(/^\uFEFF/, ""));
const deadline = Date.now() + 30_000;
while (!existsSync(spec.goFile)) {
  if (Date.now() >= deadline) {
    throw new Error("timed out waiting for Job Object admission");
  }
  await delay(10);
}

const stdoutFd = openSync(spec.stdoutPath, "w");
const stderrFd = openSync(spec.stderrPath, "w");
const startedAt = new Date().toISOString();
const child = spawn(spec.binary, spec.args, {
  cwd: spec.cwd,
  env: spec.env,
  stdio: ["pipe", stdoutFd, stderrFd],
  windowsHide: true,
});

writeFileSync(spec.pidFile, `${child.pid}\n`, { mode: 0o600 });
child.stdin.end(spec.stdinText ?? "");

let forcedByWrapper = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) {
      forcedByWrapper = true;
      child.kill();
    }
  });
}

const result = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    closeSync(stdoutFd);
    closeSync(stderrFd);
    resolve({
      startedAt,
      exitedAt: new Date().toISOString(),
      childPid: child.pid,
      exitCode: code,
      signal,
      forcedByWrapper,
    });
  });
});

writeFileSync(spec.resultPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
process.exitCode = Number.isInteger(result.exitCode) && result.exitCode >= 0 ? result.exitCode : 1;
