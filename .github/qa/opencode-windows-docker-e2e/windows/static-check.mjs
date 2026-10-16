import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const windowsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(windowsDir);

function read(relative) {
  return readFileSync(path.join(root, relative), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function includesEvery(text, values, label) {
  for (const value of values) {
    assert(text.includes(value), `${label} missing ${JSON.stringify(value)}`);
  }
}

const packageJson = JSON.parse(read("package.json"));
const packageLock = JSON.parse(read("package-lock.json"));
assert(packageJson.dependencies?.["opencode-ai"] === "1.18.7", "opencode-ai must be exactly 1.18.7");
assert(
  !Object.hasOwn(packageJson.dependencies ?? {}, "@opencode-ai/sdk"),
  "Windows CLI candidate must not depend on the SDK",
);
assert(packageLock.lockfileVersion === 3, "package-lock must use lockfile v3");
assert(
  packageLock.packages?.["node_modules/opencode-ai"]?.version === "1.18.7",
  "package-lock must pin opencode-ai 1.18.7",
);
assert(
  packageLock.packages?.["node_modules/opencode-ai"]?.integrity ===
    "sha512-/C4Bc+mHbTK+GvhiZ83rguwVSNBs1sCzooQ3CCOz7G8SBYqbsXajlm0OtZ7RaMEUWxHWeMvOnGi4RC4OpAnC/g==",
  "package-lock has unexpected opencode-ai integrity",
);
for (const [packageName, integrity] of Object.entries({
  "opencode-windows-x64":
    "sha512-Jd6jOXLiKFaZO7aQ4+3CJvqkXca/jNFXuKIQQg9IIe8dMRQOaIib3qFVlNuuLQQ6stK/dkgrclgo/GIxX+UnxQ==",
  "opencode-windows-x64-baseline":
    "sha512-NBX3LBA5d0YHMNdibN3Xhu/zHgHyIHZcfzQdY9cBUW7HY10CaVISDdXa5QsIU/pEM1olXwltF5zSU9Wk4B6aGQ==",
})) {
  assert(
    packageLock.packages?.[`node_modules/${packageName}`]?.version === "1.18.7",
    `package-lock must pin ${packageName} 1.18.7`,
  );
  assert(
    packageLock.packages?.[`node_modules/${packageName}`]?.integrity === integrity,
    `package-lock has unexpected ${packageName} integrity`,
  );
}

const dockerfile = read("Dockerfile.windows");
const windowsBaseDigest = "sha256:b841bb042e13a079f68fc82461f15abcefe8063fb9a3072120348252f13a6ce3";
const expectedWindowsBase = `mcr.microsoft.com/windows/servercore:ltsc2022@${windowsBaseDigest}`;
includesEvery(
  dockerfile,
  [
    expectedWindowsBase,
    "node-v24.18.0-win-x64.zip",
    "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821",
    "COPY package.json package-lock.json",
    "COPY Dockerfile.windows compose.windows.yaml ./",
    "npm.cmd ci",
    "Unexpected OpenCode version",
    "windows\\static-check.mjs",
  ],
  "Dockerfile.windows",
);

const harness = read("windows/windows-harness.mjs");
includesEvery(
  harness,
  [
    '"runtime-version-gate"',
    '"db"',
    '"SELECT 1 AS ready"',
    '"run"',
    '"--format"',
    '"json"',
    '"--auto"',
    '"--agent"',
    '"--model"',
    '"--session"',
    "stdinText",
    "distinctSessionIDs",
    "terminal step_finish",
    "supervisor-owned Windows Job Object membership",
    "await delay(500)",
    "childRegistryIsAuthority: false",
    "failClosed: true",
    "expectedNodeArchiveSha256",
    "expectedOpenCodeNpmIntegrity",
    "backgroundRootProcessBeforeStop",
    "deterministicBarrier",
    "processOverlap",
    "barrier_arrival",
    "barrier_release",
    "writeJsonAtomic(resultPath, value, 2)",
    "background root command line missing",
    "background prompt leaked into the OpenCode process command line",
    "promptMarkerAbsent: true",
    "requiredArgumentsPresent: true",
    "background pid identity changed across OpenCode root exit",
    "background pid no longer identifies the child that wrote the evidence record",
    "$record = [ordered]@{",
    '.join("\\r\\n")',
    "windows-actions-runner-identity.json",
    "windows-runner-identity.json",
    "!currentRunIdentity",
    "providerCleanup",
    "harnessSupport",
  ],
  "windows/windows-harness.mjs",
);
assert(!harness.includes('"serve"'), "Windows candidate still launches opencode serve");
assert(!harness.includes("@opencode-ai/sdk"), "Windows candidate still imports the SDK");
assert(!harness.includes('execFileSync(binary, ["--version"]'), "OpenCode version probe bypasses Job pre-admission");
const processRecordSource = harness.slice(
  harness.indexOf("function processRecord(pid)"),
  harness.indexOf("async function jobRequest(action)"),
);
includesEvery(
  processRecordSource,
  [
    '";`,',
    '"if (-not $item) { exit 3 };",',
    "-ErrorAction Stop;`",
    '"$record = [ordered]@{",',
    '"};",',
    '"$record | ConvertTo-Json -Compress",',
    '.join("\\r\\n")',
  ],
  "processRecord PowerShell statement boundaries",
);
assert(
  !processRecordSource.includes('.join(" ")') && !processRecordSource.includes("[ordered]@{;"),
  "processRecord still emits ambiguous PowerShell statement boundaries",
);
const evidenceCleanupSource = harness.slice(
  harness.indexOf("for (const name of readdirSync(evidence))"),
  harness.indexOf("rmSync(workRoot"),
);
includesEvery(
  evidenceCleanupSource,
  [
    'name === "windows-actions-runner-identity.json"',
    'name === "windows-runner-identity.json"',
    'name.startsWith("windows-") && !currentRunIdentity',
  ],
  "current-run identity evidence preserve allowlist",
);
assert(
  harness.match(/const windowsBase\s*=\s*\n?\s*"([^"]+)"/u)?.[1] === expectedWindowsBase,
  "runtime receipt base digest differs from Dockerfile",
);
assert(
  dockerfile.match(/^FROM\s+(\S+)$/mu)?.[1] === expectedWindowsBase,
  "Dockerfile FROM does not equal the pinned Windows base",
);
const newObserveIndex = harness.indexOf("const newConcurrencyProof = await observeConcurrentBatch(");
const newCollectIndex = harness.indexOf("const [newARun, newBRun] = await Promise.all(");
const resumeObserveIndex = harness.indexOf("const resumeConcurrencyProof = await observeConcurrentBatch(");
const resumeCollectIndex = harness.indexOf("const [resumeARun, resumeBRun] = await Promise.all(");
assert(
  newObserveIndex >= 0 &&
    newCollectIndex > newObserveIndex &&
    resumeObserveIndex > newCollectIndex &&
    resumeCollectIndex > resumeObserveIndex,
  "new/resume concurrency barrier must precede collection",
);
assert(
  harness.indexOf("providerCleanup = await stopProvider();") < harness.indexOf('status: "PASS"'),
  "main PASS is written before local provider cleanup",
);

const qaProvider = read("qa-provider.mjs");
includesEvery(
  qaProvider,
  [
    "QA_CONCURRENCY_NEW_A_218A",
    "QA_CONCURRENCY_NEW_B_218A",
    "QA_CONCURRENCY_RESUME_A_218A",
    "QA_CONCURRENCY_RESUME_B_218A",
    "barriers",
    "barrier_arrival",
    "barrier_release",
    "lastUserMessageText",
  ],
  "qa-provider.mjs",
);
assert(
  qaProvider.includes("const userText = lastUserMessageText(body.messages);"),
  "provider does not select current-turn control markers from the last user message",
);
assert(
  !qaProvider.includes('messagesText(body.messages, "user")'),
  "provider still selects current-turn markers from concatenated user history",
);

const wrapper = read("windows/job-launch-wrapper.mjs");
includesEvery(
  wrapper,
  ["while (!existsSync(spec.goFile))", "spawn(spec.binary, spec.args", "child.stdin.end(spec.stdinText"],
  "windows/job-launch-wrapper.mjs",
);

const supervisor = read("windows/job-supervisor.ps1");
includesEvery(
  supervisor,
  [
    "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
    "AssignProcessToJobObject",
    "QueryInformationJobObject",
    "TerminateJobObject",
    "windows-job-launch-request-*.json",
    "[FirstTreeJob]::Assign($job, $wrapper.Handle)",
    'phase = "job-supervisor"',
    "failClosed = $true",
    "priorReceiptStatus",
    "windows-supervisor-result.json",
    'status = "PASS"',
    "mainReceiptStatus",
    "jobClosed = $true",
  ],
  "windows/job-supervisor.ps1",
);

const compose = read("compose.windows.yaml");
includesEvery(compose, ["Dockerfile.windows", "FTQA_EVIDENCE_DIR"], "compose.windows.yaml");

const runner = read("windows/run-windows.ps1");
includesEvery(
  runner,
  [
    'if ($osType -ne "windows")',
    "build",
    "run",
    "--rm",
    "finally",
    "down",
    "--remove-orphans",
    "--rmi local",
    "config",
    "--images",
    "docker image inspect",
    "windows-runner-identity.json",
    "windows-cleanup-result.json",
    "serviceImageReference",
    "serviceImageIDAlive",
    "serviceImageReferenceAlive",
    "baseCachePreserved",
    "com.docker.compose.project=",
  ],
  "windows/run-windows.ps1",
);
assert(
  runner.match(/^\$windowsBase\s*=\s*"([^"]+)"$/mu)?.[1] === expectedWindowsBase,
  "runner identity base digest differs from Dockerfile",
);
assert(
  !/^\s*images\s*`\s*$[\s\S]{0,80}^\s*-q\s*`/mu.test(runner),
  "runner still uses compose images -q before a service container exists",
);

const workflowPath = path.join(root, "..", "..", "workflows", "opencode-windows-docker-e2e.yml");
if (existsSync(workflowPath)) {
  const workflow = readFileSync(workflowPath, "utf8");
  includesEvery(
    workflow,
    [
      "config `",
      "--images",
      "docker image inspect",
      "serviceImageReference",
      "serviceImageIDAlive",
      "serviceImageReferenceAlive",
      "--rmi local",
      "exit 0",
    ],
    ".github/workflows/opencode-windows-docker-e2e.yml",
  );
  assert(!/^\s*images\s*`\s*$[\s\S]{0,80}^\s*-q\s*`/mu.test(workflow), "workflow cleanup still uses compose images -q");
  assert(
    workflow.indexOf('if ($receipt.status -ne "PASS")') < workflow.indexOf("exit 0"),
    "workflow cleanup PASS does not explicitly exit zero after the fail-closed guard",
  );
}

const redactor = read("windows/redact-evidence.ps1");
includesEvery(
  redactor,
  [
    "windows-result.json",
    "windows-supervisor-result.json",
    "windows-runner-identity.json",
    "windows-actions-runner-identity.json",
    "windows-cleanup-result.json",
    "windows-actions-cleanup-result.json",
    'Properties.Remove("body")',
    "rawEvidenceUploaded = $false",
  ],
  "windows/redact-evidence.ps1",
);

const actionsIdentity = read("windows/capture-runner-identity.ps1");
includesEvery(
  actionsIdentity,
  [
    "ImageOS",
    "ImageVersion",
    "Win32_OperatingSystem",
    'docker version --format "{{json .}}"',
    'docker info --format "{{json .}}"',
    "docker manifest inspect",
    windowsBaseDigest,
    "windows-actions-runner-identity.json",
  ],
  "windows/capture-runner-identity.ps1",
);

const result = {
  schema: "first-tree.opencode.windows-cli-static.v1",
  status: "PASS",
  checked: [
    "exact artifact pins",
    "per-turn CLI flags",
    "stdin prompt",
    "DB readiness gate",
    "deterministically concurrent new and resume",
    "JSONL terminal parser",
    "Job-admitted runtime version gate",
    "pre-admission Job assignment",
    "Job membership and termination",
    "double-zero interval",
    "local provider cleanup receipt",
    "valid PowerShell process observer statement boundaries",
    "current-run runner identity evidence preserve allowlist",
    "runner and Docker identity receipt",
    "Compose image-reference resolution and ID/reference cleanup readback",
    "redacted evidence allowlist",
    "fail-closed result",
    "one-command scoped Windows cleanup and readback",
    "explicit zero exit after Actions cleanup PASS",
  ],
  runtimeExecuted: false,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
