import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = "C:\\ftqa";
const projectTemplate = path.join(root, "project");
const workRoot = path.join(root, "work");
const workdirA = path.join(workRoot, "chat-a");
const workdirB = path.join(workRoot, "chat-b");
const home = path.join(root, "home");
const state = process.env.FTQA_JOB_STATE_DIR ?? path.join(root, "state");
const evidence = process.env.FTQA_EVIDENCE_DIR ?? path.join(root, "evidence");
const binary = path.join(root, "node_modules", "opencode-ai", "bin", "opencode.exe");
const providerScript = path.join(root, "qa-provider.mjs");
const backgroundScript = path.join(root, "windows", "background-child.ps1");
const providerLog = path.join(evidence, "windows-provider.jsonl");
const resultPath = path.join(evidence, "windows-result.json");
const readyPath = path.join(state, "windows-job-ready.json");
const controlRequestPath = path.join(state, "windows-job-control-request.json");
const backgroundRecordFile = path.join(state, "windows-background.json");
const database = path.join(home, "data", "opencode", "opencode.db");
const managedAgent = "slock";
const explicitModel = "ftqa/qa-model";
const clientID = "client-windows-cli-218a";
const agentID = "agent-windows-cli-218a";
const chatIDA = "chat-windows-cli-a-218a";
const chatIDB = "chat-windows-cli-b-218a";
const marker = "ft-opencode-windows-cli-218a";
const expectedNodeVersion = "v24.18.0";
const expectedOpenCodeVersion = "1.18.7";
const expectedNodeArchiveSha256 = "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821";
const expectedOpenCodeNpmIntegrity =
  "sha512-/C4Bc+mHbTK+GvhiZ83rguwVSNBs1sCzooQ3CCOz7G8SBYqbsXajlm0OtZ7RaMEUWxHWeMvOnGi4RC4OpAnC/g==";
const windowsBase =
  "mcr.microsoft.com/windows/servercore:ltsc2022@sha256:b841bb042e13a079f68fc82461f15abcefe8063fb9a3072120348252f13a6ce3";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function errorText(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function writeJsonAtomic(file, value, space = 0) {
  const temporary = `${file}.${randomBytes(5).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, space)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, file);
}

function persistResult(value) {
  mkdirSync(evidence, { recursive: true });
  writeJsonAtomic(resultPath, value, 2);
}

async function waitUntil(check, timeoutMs, label, intervalMs = 25) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${errorText(lastError)}` : ""}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  assert(port > 0, "failed to allocate loopback provider port");
  return port;
}

function environmentValue(name) {
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? process.env[key] : undefined;
}

function minimalEnvironment(extra = {}) {
  const env = {};
  for (const key of ["PATH", "SystemRoot", "ComSpec", "TEMP", "TMP", "PATHEXT", "USERNAME"]) {
    const value = environmentValue(key);
    if (value) env[key] = value;
  }
  return { ...env, ...extra };
}

function opencodeConfig(providerPort) {
  return {
    $schema: "https://opencode.ai/config.json",
    model: explicitModel,
    small_model: explicitModel,
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    enabled_providers: ["ftqa"],
    provider: {
      ftqa: {
        npm: "@ai-sdk/openai-compatible",
        name: "First Tree Windows per-turn CLI QA provider",
        options: {
          baseURL: `http://127.0.0.1:${providerPort}/v1`,
          apiKey: "qa-local-only",
        },
        models: {
          "qa-model": {
            name: "First Tree Windows per-turn CLI QA model",
            limit: { context: 131072, output: 4096 },
          },
        },
      },
    },
    agent: {
      [managedAgent]: {
        description: "First Tree managed Windows CLI QA agent",
        mode: "primary",
        prompt: "SLOCK_STANDING_PROMPT_MARKER_218A",
        model: explicitModel,
        permission: {
          edit: "deny",
          bash: "allow",
          webfetch: "deny",
          websearch: "deny",
        },
      },
    },
    permission: {
      edit: "deny",
      bash: "allow",
      webfetch: "deny",
      websearch: "deny",
    },
  };
}

function opencodeEnvironment(providerPort, chatID = chatIDA) {
  const roaming = path.join(home, "AppData", "Roaming");
  const local = path.join(home, "AppData", "Local");
  return minimalEnvironment({
    HOME: home,
    USERPROFILE: home,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "state"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(providerPort)),
    FIRST_TREE_CLIENT_ID: clientID,
    FIRST_TREE_AGENT_ID: agentID,
    FIRST_TREE_CHAT_ID: chatID,
    FIRST_TREE_PROVIDER_MARKER: marker,
    FTQA_BACKGROUND_RECORD_FILE: backgroundRecordFile,
    npm_config_cache: path.join(home, "npm-cache"),
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processRecord(pid) {
  const script = [
    `$item = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = ${pid}";`,
    "if (-not $item) { exit 3 };",
    `$process = Get-Process -Id ${pid} -ErrorAction Stop;`,
    "$record = [ordered]@{",
    `pid = ${pid}`,
    "parentPid = [int]$item.ParentProcessId",
    "startedAt = $process.StartTime.ToUniversalTime().ToString('o')",
    "executablePath = [string]$item.ExecutablePath",
    "commandLine = [string]$item.CommandLine",
    "};",
    "$record | ConvertTo-Json -Compress",
  ].join("\r\n");
  return JSON.parse(
    execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", windowsHide: true },
    ).replace(/^\uFEFF/, ""),
  );
}

async function jobRequest(action) {
  const seq = `${Date.now()}-${randomBytes(5).toString("hex")}`;
  const responsePath = path.join(state, `windows-job-response-${seq}.json`);
  writeJsonAtomic(controlRequestPath, { seq, action });
  const response = await waitUntil(
    () => (existsSync(responsePath) ? readJson(responsePath) : undefined),
    8_000,
    `Job Object ${action}`,
  );
  rmSync(responsePath, { force: true });
  assert(!response.error, `Job Object ${action} failed: ${response.error}`);
  return response;
}

function launchPaths(name, seq) {
  const prefix = path.join(state, `windows-${name}-${seq}`);
  return {
    specPath: `${prefix}-spec.json`,
    goFile: `${prefix}-go`,
    pidFile: `${prefix}-child.pid`,
    resultPath: `${prefix}-result.json`,
    stdoutPath: path.join(evidence, `windows-${name}-${seq}.stdout`),
    stderrPath: path.join(evidence, `windows-${name}-${seq}.stderr`),
  };
}

async function admitLaunch({ name, args, cwd, stdinText, env }) {
  const seq = `${Date.now()}-${randomBytes(5).toString("hex")}`;
  const files = launchPaths(name, seq);
  const requestPath = path.join(state, `windows-job-launch-request-${seq}.json`);
  const responsePath = path.join(state, `windows-job-launch-response-${seq}.json`);
  const spec = {
    binary,
    args,
    cwd,
    stdinText,
    env,
    ...files,
  };
  writeJsonAtomic(files.specPath, spec);
  writeJsonAtomic(requestPath, { seq, specPath: files.specPath });
  const admission = await waitUntil(
    () => (existsSync(responsePath) ? readJson(responsePath) : undefined),
    10_000,
    `${name} wrapper Job admission`,
  );
  rmSync(responsePath, { force: true });
  assert(!admission.error, `${name} admission failed: ${admission.error}`);
  assert(admission.killOnJobClose === true, `${name} lacks KILL_ON_JOB_CLOSE`);
  assert(
    Number.isInteger(Number(admission.wrapperPid)) && Number(admission.wrapperPid) > 1,
    `${name} returned invalid wrapper pid`,
  );
  return {
    name,
    seq,
    args,
    cwd,
    stdinText,
    ...files,
    wrapperPid: Number(admission.wrapperPid),
    admission,
  };
}

async function admitBatch(specs) {
  const handles = await Promise.all(specs.map((spec) => admitLaunch(spec)));
  const snapshot = await jobRequest("snapshot");
  for (const handle of handles) {
    assert(snapshot.pids.includes(handle.wrapperPid), `${handle.name} wrapper was released outside the Job`);
  }
  for (const handle of handles) {
    writeFileSync(handle.goFile, "go\n", { mode: 0o600 });
  }
  return { handles, preReleaseJob: snapshot };
}

async function collectLaunch(handle, timeoutMs = 90_000) {
  const wrapperResult = await waitUntil(
    () => (existsSync(handle.resultPath) ? readJson(handle.resultPath) : undefined),
    timeoutMs,
    `${handle.name} completion`,
  );
  const stdout = readFileSync(handle.stdoutPath, "utf8");
  const stderr = readFileSync(handle.stderrPath, "utf8");
  return {
    ...handle,
    childPid: Number(wrapperResult.childPid),
    wrapperResult,
    stdout,
    stderr,
  };
}

async function launchPid(handle, timeoutMs = 10_000) {
  return waitUntil(
    () => {
      if (!existsSync(handle.pidFile)) return undefined;
      const value = Number(readFileSync(handle.pidFile, "utf8").trim());
      return Number.isInteger(value) && value > 1 ? value : undefined;
    },
    timeoutMs,
    `${handle.name} OpenCode root pid`,
  );
}

function parseJsonl(text, label) {
  const events = [];
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    if (!raw.trim()) continue;
    try {
      events.push(JSON.parse(raw));
    } catch (error) {
      throw new Error(`${label} invalid JSONL line ${index + 1}: ${errorText(error)}`);
    }
  }
  assert(events.length > 0, `${label} produced no JSONL events`);
  return events;
}

function analyzeTurn(run, { expectedSessionID } = {}) {
  assert(run.wrapperResult.exitCode === 0, `${run.name} exit ${run.wrapperResult.exitCode}`);
  const events = parseJsonl(run.stdout, run.name);
  const sessionIDs = new Set(events.flatMap((event) => [event.sessionID, event.part?.sessionID]).filter(Boolean));
  assert(sessionIDs.size === 1, `${run.name} emitted ambiguous session IDs`);
  const [sessionID] = sessionIDs;
  if (expectedSessionID) {
    assert(sessionID === expectedSessionID, `${run.name} resumed the wrong session`);
  }
  const terminalEvents = events.filter(
    (event) => event.type === "step_finish" && event.part?.reason && event.part.reason !== "tool-calls",
  );
  assert(terminalEvents.length > 0, `${run.name} emitted no terminal step_finish`);
  assert(!events.some((event) => event.type === "error"), `${run.name} emitted error`);
  return {
    name: run.name,
    wrapperPid: run.wrapperPid,
    childPid: run.childPid,
    exitCode: run.wrapperResult.exitCode,
    startedAt: run.wrapperResult.startedAt,
    exitedAt: run.wrapperResult.exitedAt,
    sessionID,
    eventTypes: events.map((event) => event.type),
    terminalReasons: terminalEvents.map((event) => event.part.reason),
    text: events
      .filter((event) => event.type === "text")
      .map((event) => event.part?.text ?? "")
      .join("\n"),
    toolEvents: events
      .filter((event) => event.type === "tool_use")
      .map((event) => ({
        tool: event.part?.tool,
        status: event.part?.state?.status,
        output: event.part?.state?.output,
        exit: event.part?.state?.metadata?.exit,
      })),
  };
}

function processIntervalsOverlap(turns, label) {
  assert(turns.length === 2, `${label} requires exactly two turns`);
  const intervals = turns.map((turn) => ({
    name: turn.name,
    startMs: Date.parse(turn.startedAt),
    endMs: Date.parse(turn.exitedAt),
  }));
  assert(
    intervals.every(
      (interval) =>
        Number.isFinite(interval.startMs) && Number.isFinite(interval.endMs) && interval.endMs >= interval.startMs,
    ),
    `${label} has invalid wrapper lifecycle timestamps`,
  );
  const overlapMs =
    Math.min(...intervals.map((interval) => interval.endMs)) -
    Math.max(...intervals.map((interval) => interval.startMs));
  assert(overlapMs > 0, `${label} wrapper lifecycles did not overlap`);
  return { intervals, overlapMs };
}

function runArgs({ workdir, sessionID, title }) {
  const args = [
    "run",
    "--format",
    "json",
    "--auto",
    "--agent",
    managedAgent,
    "--model",
    explicitModel,
    "--title",
    title,
    "--dir",
    workdir,
    "--print-logs",
    "--log-level",
    "ERROR",
  ];
  if (sessionID) args.push("--session", sessionID);
  return args;
}

function runSpec({ name, workdir, prompt, providerPort, chatID, sessionID, title = "First Tree Windows CLI QA" }) {
  return {
    name,
    args: runArgs({ workdir, sessionID, title }),
    cwd: workdir,
    stdinText: `${prompt}\n`,
    env: opencodeEnvironment(providerPort, chatID),
  };
}

function providerRecords() {
  if (!existsSync(providerLog)) return [];
  return readFileSync(providerLog, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function observeConcurrentBatch(batch, barrier, providerPort) {
  const rootPids = await Promise.all(batch.handles.map((handle) => launchPid(handle)));
  const arrivals = await waitUntil(
    () => {
      const rows = providerRecords().filter(
        (record) => record.kind === "barrier_arrival" && record.barrier === barrier,
      );
      return rows.length === 2 ? rows : undefined;
    },
    20_000,
    `${barrier} provider concurrency barrier`,
  );
  const membership = await jobRequest("snapshot");
  for (const rootPid of rootPids) {
    assert(membership.pids.includes(rootPid), `${barrier} Job snapshot missed concurrent OpenCode root ${rootPid}`);
  }
  const releaseResponse = await fetch(`http://127.0.0.1:${providerPort}/ftqa/barriers/${barrier}/release`, {
    method: "POST",
    signal: AbortSignal.timeout(5_000),
  });
  const release = await releaseResponse.json();
  assert(releaseResponse.ok, `${barrier} provider barrier release failed: ${JSON.stringify(release)}`);
  return {
    barrier,
    arrivals: arrivals.map((record) => ({
      marker: record.marker,
      requestID: record.requestID,
      arrivedAt: record.arrivedAt,
    })),
    rootPids,
    membership,
    release,
  };
}

function barrierProof(records, name) {
  const arrivals = records.filter((record) => record.kind === "barrier_arrival" && record.barrier === name);
  const releases = records.filter((record) => record.kind === "barrier_release" && record.barrier === name);
  assert(arrivals.length === 2, `${name} barrier lacks two arrivals`);
  assert(releases.length === 2, `${name} barrier lacks two releases`);
  const arrivalTimes = arrivals.map((record) => Date.parse(record.arrivedAt));
  const releaseTimes = releases.map((record) => Date.parse(record.releasedAt));
  assert([...arrivalTimes, ...releaseTimes].every(Number.isFinite), `${name} barrier has invalid timestamps`);
  assert(
    Math.max(...arrivalTimes) <= Math.min(...releaseTimes),
    `${name} barrier released before both requests arrived`,
  );
  return {
    arrivals: arrivals.map((record) => ({
      marker: record.marker,
      requestID: record.requestID,
      arrivedAt: record.arrivedAt,
    })),
    releases: releases.map((record) => ({
      marker: record.marker,
      requestID: record.requestID,
      releasedAt: record.releasedAt,
    })),
    arrivalSpreadMs: Math.max(...arrivalTimes) - Math.min(...arrivalTimes),
  };
}

function providerAssertions() {
  const records = providerRecords();
  const requests = records.filter((record) => record.kind === "request");
  const responseModes = records.filter((record) => record.kind === "response").map((record) => record.responseMode);
  assert(requests.length >= 7, "provider observed too few real OpenCode requests");
  assert(
    requests.every((record) => record.model === "qa-model"),
    "provider observed a model other than explicit qa-model",
  );
  assert(
    requests.every((record) => record.markers?.slock === true),
    "managed agent prompt marker was missing",
  );
  for (const expected of ["tool_call", "background_tool_call", "background_hold"]) {
    assert(responseModes.includes(expected), `provider did not exercise ${expected}`);
  }
  return {
    requestCount: requests.length,
    models: [...new Set(requests.map((record) => record.model))],
    managedAgentMarkerEveryRequest: true,
    responseModes,
    concurrencyBarriers: {
      new: barrierProof(records, "new"),
      resume: barrierProof(records, "resume"),
    },
  };
}

let provider;
let providerError = "";
let jobTerminated = false;
let backgroundPid;
let backgroundRootPid;
let providerCleanup;
const timings = {};
const startedAt = Date.now();

async function failClosedCleanup() {
  const cleanup = { attempted: false, error: null, finalJobPids: null };
  if (!existsSync(readyPath)) return cleanup;
  cleanup.attempted = true;
  try {
    await jobRequest("terminate");
    jobTerminated = true;
    const final = await jobRequest("snapshot");
    cleanup.finalJobPids = final.pids;
  } catch (error) {
    cleanup.error = errorText(error);
  }
  return cleanup;
}

async function stopProvider() {
  if (!provider) {
    return {
      pid: null,
      requested: false,
      exitCode: null,
      signalCode: null,
      alive: false,
      exitObserved: true,
      error: null,
    };
  }
  const pid = provider.pid;
  let cleanupError = null;
  const exitObservation =
    provider.exitCode !== null || provider.signalCode !== null
      ? Promise.resolve(true)
      : new Promise((resolve) => provider.once("exit", () => resolve(true)));
  let exitObserved = false;
  try {
    if (processAlive(pid)) {
      provider.kill();
      try {
        await waitUntil(() => (!processAlive(pid) ? true : undefined), 3_000, "local QA provider exit", 50);
      } catch {
        execFileSync("taskkill.exe", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore", windowsHide: true });
        await waitUntil(() => (!processAlive(pid) ? true : undefined), 3_000, "forced local QA provider exit", 50);
      }
    }
    exitObserved = (await Promise.race([exitObservation, delay(3_000).then(() => false)])) === true;
    if (!exitObserved) {
      cleanupError = "local QA provider exit event was not observed";
    }
  } catch (error) {
    cleanupError = errorText(error);
  }
  return {
    pid,
    requested: true,
    exitCode: provider.exitCode,
    signalCode: provider.signalCode,
    alive: processAlive(pid),
    exitObserved,
    error: cleanupError,
  };
}

try {
  mkdirSync(state, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const name of readdirSync(state)) {
    if (name === path.basename(readyPath)) continue;
    if (name.startsWith("windows-")) {
      rmSync(path.join(state, name), { recursive: true, force: true });
    }
  }
  for (const name of readdirSync(evidence)) {
    const currentRunIdentity =
      name === "windows-actions-runner-identity.json" || name === "windows-runner-identity.json";
    if (name.startsWith("windows-") && !currentRunIdentity) {
      rmSync(path.join(evidence, name), { recursive: true, force: true });
    }
  }
  rmSync(workRoot, { recursive: true, force: true });
  cpSync(projectTemplate, workdirA, { recursive: true });
  cpSync(projectTemplate, workdirB, { recursive: true });
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });

  assert(process.platform === "win32", "Windows harness requires a Windows kernel");
  assert(process.arch === "x64", "pinned Windows image requires x64");
  assert(process.version === expectedNodeVersion, `unexpected Node ${process.version}`);
  const jobReady = await waitUntil(
    () => (existsSync(readyPath) ? readJson(readyPath) : undefined),
    10_000,
    "supervisor Job readiness",
  );
  assert(jobReady.killOnJobClose === true, "supervisor Job lacks KILL_ON_JOB_CLOSE");

  const runtimeVersionStarted = Date.now();
  const versionBatch = await admitBatch([
    {
      name: "runtime-version-gate",
      args: ["--version"],
      cwd: workdirA,
      stdinText: "",
      env: minimalEnvironment(),
    },
  ]);
  const versionRun = await collectLaunch(versionBatch.handles[0], 30_000);
  timings.runtimeVersionGateMs = Date.now() - runtimeVersionStarted;
  assert(versionRun.wrapperResult.exitCode === 0, `runtime version gate exit ${versionRun.wrapperResult.exitCode}`);
  const openCodeVersion = versionRun.stdout.trim();
  assert(openCodeVersion === expectedOpenCodeVersion, `unexpected OpenCode ${openCodeVersion}`);

  const providerPort = await freePort();
  const backgroundCommand = [
    "Start-Process",
    "-FilePath 'powershell.exe'",
    "-ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',",
    `'-File','${backgroundScript.replaceAll("'", "''")}')`,
    "-WindowStyle Hidden",
  ].join(" ");
  provider = spawn(process.execPath, [providerScript], {
    env: minimalEnvironment({
      QA_PROVIDER_PORT: String(providerPort),
      QA_PROVIDER_LOG: providerLog,
      FTQA_BACKGROUND_COMMAND: backgroundCommand,
      FTQA_SHELL_COMMAND: "echo QA_TOOL_RESULT_218A",
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let providerOutput = "";
  provider.stdout.on("data", (chunk) => {
    providerOutput += chunk.toString();
  });
  provider.stderr.on("data", (chunk) => {
    providerError += chunk.toString();
  });
  await waitUntil(() => providerOutput.includes("QA provider ready"), 5_000, "local OpenAI-compatible provider");

  const dbGateStarted = Date.now();
  const dbBatch = await admitBatch([
    {
      name: "db-gate",
      args: ["db", "SELECT 1 AS ready", "--format", "json", "--print-logs", "--log-level", "ERROR"],
      cwd: workdirA,
      stdinText: "",
      env: opencodeEnvironment(providerPort),
    },
  ]);
  const dbRun = await collectLaunch(dbBatch.handles[0], 60_000);
  timings.dbGateMs = Date.now() - dbGateStarted;
  assert(dbRun.wrapperResult.exitCode === 0, `DB gate exit ${dbRun.wrapperResult.exitCode}`);
  const dbGateOutput = JSON.parse(dbRun.stdout.replace(/^\uFEFF/, ""));
  assert(JSON.stringify(dbGateOutput).includes('"ready":1'), "DB gate did not return ready=1");
  assert(existsSync(database), "default isolated OpenCode database was not created");

  const concurrentStarted = Date.now();
  const newBatch = await admitBatch([
    runSpec({
      name: "new-a",
      workdir: workdirA,
      prompt: "QA_CONCURRENCY_NEW_A_218A FIRST_TURN_MARKER_218A CHAT_A",
      providerPort,
      chatID: chatIDA,
      title: "First Tree Windows CLI A",
    }),
    runSpec({
      name: "new-b",
      workdir: workdirB,
      prompt: "QA_CONCURRENCY_NEW_B_218A FIRST_TURN_MARKER_218A CHAT_B",
      providerPort,
      chatID: chatIDB,
      title: "First Tree Windows CLI B",
    }),
  ]);
  const newConcurrencyProof = await observeConcurrentBatch(newBatch, "new", providerPort);
  const [newARun, newBRun] = await Promise.all(newBatch.handles.map((handle) => collectLaunch(handle)));
  timings.concurrentNewMs = Date.now() - concurrentStarted;
  const newA = analyzeTurn(newARun);
  const newB = analyzeTurn(newBRun);
  const newProcessOverlap = processIntervalsOverlap([newA, newB], "concurrent new");
  assert(newA.sessionID !== newB.sessionID, "concurrent workdirs shared a session ID");
  assert(newA.text.includes("firstTurn=true"), "chat A provider history marker missing");
  assert(newB.text.includes("firstTurn=true"), "chat B provider history marker missing");

  const resumeStarted = Date.now();
  const resumeBatch = await admitBatch([
    runSpec({
      name: "resume-a",
      workdir: workdirA,
      prompt: "QA_CONCURRENCY_RESUME_A_218A RESUME_MARKER_A_218A",
      providerPort,
      chatID: chatIDA,
      sessionID: newA.sessionID,
    }),
    runSpec({
      name: "resume-b",
      workdir: workdirB,
      prompt: "QA_CONCURRENCY_RESUME_B_218A RESUME_MARKER_B_218A",
      providerPort,
      chatID: chatIDB,
      sessionID: newB.sessionID,
    }),
  ]);
  const resumeConcurrencyProof = await observeConcurrentBatch(resumeBatch, "resume", providerPort);
  const [resumeARun, resumeBRun] = await Promise.all(resumeBatch.handles.map((handle) => collectLaunch(handle)));
  timings.concurrentResumeMs = Date.now() - resumeStarted;
  const resumeA = analyzeTurn(resumeARun, { expectedSessionID: newA.sessionID });
  const resumeB = analyzeTurn(resumeBRun, { expectedSessionID: newB.sessionID });
  const resumeProcessOverlap = processIntervalsOverlap([resumeA, resumeB], "concurrent resume");
  assert(resumeA.text.includes("firstTurn=true"), "chat A resume lost history");
  assert(resumeB.text.includes("firstTurn=true"), "chat B resume lost history");

  const toolStarted = Date.now();
  const toolBatch = await admitBatch([
    runSpec({
      name: "shell-tool",
      workdir: workdirA,
      prompt: "QA_CALL_BASH",
      providerPort,
      chatID: chatIDA,
      sessionID: newA.sessionID,
    }),
  ]);
  const toolRun = await collectLaunch(toolBatch.handles[0]);
  timings.shellToolMs = Date.now() - toolStarted;
  const tool = analyzeTurn(toolRun, { expectedSessionID: newA.sessionID });
  const shellEvent = tool.toolEvents.find((event) => event.tool === "bash");
  assert(shellEvent, "OpenCode emitted no shell tool event");
  assert(shellEvent.status === "completed", "shell tool did not complete");
  assert(shellEvent.exit === 0, "shell tool returned non-zero");
  assert(String(shellEvent.output).includes("QA_TOOL_RESULT_218A"), "shell tool output marker missing");

  rmSync(backgroundRecordFile, { force: true });
  const backgroundStarted = Date.now();
  const backgroundBatch = await admitBatch([
    runSpec({
      name: "background-hold",
      workdir: workdirB,
      prompt: "QA_CALL_BACKGROUND_HOLD",
      providerPort,
      chatID: chatIDB,
      sessionID: newB.sessionID,
    }),
  ]);
  const backgroundHandle = backgroundBatch.handles[0];
  backgroundRootPid = await waitUntil(
    () => {
      if (!existsSync(backgroundHandle.pidFile)) return undefined;
      const value = Number(readFileSync(backgroundHandle.pidFile, "utf8").trim());
      return Number.isInteger(value) && value > 1 ? value : undefined;
    },
    10_000,
    "background OpenCode root pid",
  );
  const backgroundRecord = await waitUntil(
    () => (existsSync(backgroundRecordFile) ? readJson(backgroundRecordFile) : undefined),
    20_000,
    "detached Windows background child",
  );
  timings.backgroundAdmissionMs = Date.now() - backgroundStarted;
  backgroundPid = Number(backgroundRecord.pid);
  assert(Number.isInteger(backgroundPid) && backgroundPid > 1, "invalid background pid");
  assert(backgroundRecord.clientId === clientID, "background lost client attribution");
  assert(backgroundRecord.agentId === agentID, "background lost agent attribution");
  assert(backgroundRecord.chatId === chatIDB, "background lost chat attribution");
  assert(backgroundRecord.providerMarker === marker, "background marker mismatch");
  assert(backgroundRecord.parentPid !== backgroundRootPid, "background child remained a direct child of OpenCode root");
  assert(processAlive(backgroundRootPid), "OpenCode root exited before explicit stop");
  assert(processAlive(backgroundPid), "background child exited before root stop");

  const backgroundEventsBeforeStop = await waitUntil(
    () => {
      if (!existsSync(backgroundHandle.stdoutPath)) return undefined;
      const text = readFileSync(backgroundHandle.stdoutPath, "utf8");
      if (!text.includes('"type":"tool_use"')) return undefined;
      return parseJsonl(text, "background partial JSONL");
    },
    10_000,
    "background shell tool event",
  );
  const backgroundTool = backgroundEventsBeforeStop.find(
    (event) => event.type === "tool_use" && event.part?.tool === "bash",
  );
  assert(backgroundTool, "background run emitted no shell tool event");
  assert(backgroundTool.part?.state?.status === "completed", "background shell tool did not complete");

  const membershipBeforeRootStop = await jobRequest("snapshot");
  assert(
    membershipBeforeRootStop.pids.includes(backgroundHandle.wrapperPid),
    "Job missed background wrapper before root stop",
  );
  assert(membershipBeforeRootStop.pids.includes(backgroundRootPid), "Job missed OpenCode root before root stop");
  assert(
    membershipBeforeRootStop.pids.includes(backgroundPid),
    "Job missed detached background child before root stop",
  );
  const backgroundRootProcessBeforeStop = processRecord(backgroundRootPid);
  assert(
    path.normalize(backgroundRootProcessBeforeStop.executablePath).toLowerCase() ===
      path.normalize(binary).toLowerCase(),
    "root pid no longer identifies the admitted OpenCode binary",
  );
  const backgroundRootCommandLine = backgroundRootProcessBeforeStop.commandLine.toLowerCase();
  for (const expectedArguments of [
    " run ",
    "--format json",
    "--auto",
    `--agent ${managedAgent}`,
    `--model ${explicitModel}`,
    `--session ${newB.sessionID.toLowerCase()}`,
  ]) {
    assert(
      backgroundRootCommandLine.includes(expectedArguments),
      `background root command line missing ${expectedArguments.trim()}`,
    );
  }
  assert(
    !backgroundRootProcessBeforeStop.commandLine.includes("QA_CALL_BACKGROUND_HOLD"),
    "background prompt leaked into the OpenCode process command line",
  );
  const backgroundProcessBeforeRootStop = processRecord(backgroundPid);
  assert(
    backgroundProcessBeforeRootStop.startedAt === backgroundRecord.startedAt,
    "background pid no longer identifies the child that wrote the evidence record",
  );

  const rootStopStarted = Date.now();
  process.kill(backgroundRootPid, "SIGTERM");
  await waitUntil(
    () => !processAlive(backgroundRootPid) && !processAlive(backgroundHandle.wrapperPid),
    10_000,
    "OpenCode root and wrapper exit",
  );
  timings.rootStopMs = Date.now() - rootStopStarted;
  assert(processAlive(backgroundPid), "background did not survive OpenCode root exit");
  const membershipAfterRootStop = await waitUntil(
    async () => {
      const snapshot = await jobRequest("snapshot");
      return snapshot.pids.includes(backgroundPid) &&
        !snapshot.pids.includes(backgroundRootPid) &&
        !snapshot.pids.includes(backgroundHandle.wrapperPid)
        ? snapshot
        : undefined;
    },
    8_000,
    "detached child Job membership after root exit",
    50,
  );
  const backgroundProcessAfterRootStop = processRecord(backgroundPid);
  assert(
    backgroundProcessAfterRootStop.startedAt === backgroundProcessBeforeRootStop.startedAt,
    "background pid identity changed across OpenCode root exit",
  );

  const terminateStarted = Date.now();
  const terminateResponse = await jobRequest("terminate");
  jobTerminated = true;
  const zeroScan1 = await waitUntil(
    async () => {
      const snapshot = await jobRequest("snapshot");
      return snapshot.pids.length === 0 ? snapshot : undefined;
    },
    8_000,
    "first empty Job process list",
    50,
  );
  await delay(500);
  const zeroScan2 = await jobRequest("snapshot");
  assert(zeroScan2.pids.length === 0, "second Job process list was not empty");
  assert(!processAlive(backgroundPid), "background survived TerminateJobObject");
  timings.terminateAndDoubleZeroMs = Date.now() - terminateStarted;

  const providerProof = providerAssertions();
  providerCleanup = await stopProvider();
  assert(!providerCleanup.alive, "local QA provider remained alive after cleanup");
  assert(!providerCleanup.error, `local QA provider cleanup failed: ${providerCleanup.error}`);
  const binaryBytes = readFileSync(binary);
  const result = {
    schema: "first-tree.opencode.windows-cli-e2e.v1",
    status: "PASS",
    artifact: {
      windowsBase,
      windowsVersion: execFileSync("cmd.exe", ["/d", "/s", "/c", "ver"], {
        encoding: "utf8",
        windowsHide: true,
      }).trim(),
      nodeVersion: process.version,
      nodeArchiveSha256: expectedNodeArchiveSha256,
      opencodePackage: `opencode-ai@${openCodeVersion}`,
      opencodeNpmIntegrity: expectedOpenCodeNpmIntegrity,
      opencodeVersion: openCodeVersion,
      opencodeBinary: binary,
      opencodeBinarySha256: createHash("sha256").update(binaryBytes).digest("hex"),
      platform: process.platform,
      arch: process.arch,
    },
    configuration: {
      transport: "per-turn opencode run JSONL",
      promptTransport: "stdin+EOF",
      managedAgent,
      explicitModel,
      sessionBindings: [
        { chatID: chatIDA, workdir: workdirA },
        { chatID: chatIDB, workdir: workdirB },
      ],
      isolatedHome: home,
      opencodeDbOverridePresent: Object.hasOwn(opencodeEnvironment(providerPort), "OPENCODE_DB"),
      defaultDatabase: {
        path: database,
        bytes: statSync(database).size,
      },
    },
    dbGate: {
      query: "SELECT 1 AS ready",
      exitCode: dbRun.wrapperResult.exitCode,
      output: dbGateOutput,
      preReleaseJob: dbBatch.preReleaseJob,
      elapsedMs: timings.dbGateMs,
    },
    runtimeVersionGate: {
      version: openCodeVersion,
      exitCode: versionRun.wrapperResult.exitCode,
      rootPid: versionRun.childPid,
      preReleaseJob: versionBatch.preReleaseJob,
      elapsedMs: timings.runtimeVersionGateMs,
    },
    concurrency: {
      workdirs: [workdirA, workdirB],
      new: [newA, newB],
      distinctSessionIDs: newA.sessionID !== newB.sessionID,
      preReleaseJob: newBatch.preReleaseJob,
      deterministicBarrier: newConcurrencyProof,
      processOverlap: newProcessOverlap,
      elapsedMs: timings.concurrentNewMs,
    },
    resume: {
      sameDirectory: true,
      explicitSessionFlag: true,
      turns: [resumeA, resumeB],
      preReleaseJob: resumeBatch.preReleaseJob,
      deterministicBarrier: resumeConcurrencyProof,
      processOverlap: resumeProcessOverlap,
      elapsedMs: timings.concurrentResumeMs,
    },
    tool: {
      sessionID: tool.sessionID,
      event: shellEvent,
      preReleaseJob: toolBatch.preReleaseJob,
      elapsedMs: timings.shellToolMs,
    },
    provider: providerProof,
    job: {
      authority: "supervisor-owned Windows Job Object membership",
      killOnJobClose: jobReady.killOnJobClose,
      preAdmissionRaceClosed: true,
      childRegistryIsAuthority: false,
      background: {
        rootPid: backgroundRootPid,
        wrapperPid: backgroundHandle.wrapperPid,
        record: backgroundRecord,
        backgroundRootProcessBeforeStop,
        argvEvidence: {
          requiredArgumentsObserved: [
            "run",
            "--format json",
            "--auto",
            `--agent ${managedAgent}`,
            `--model ${explicitModel}`,
            `--session ${newB.sessionID}`,
          ],
          requiredArgumentsPresent: true,
          promptMarkerAbsent: true,
        },
        processBeforeRootStop: backgroundProcessBeforeRootStop,
        processAfterRootStop: backgroundProcessAfterRootStop,
        toolEvent: {
          tool: backgroundTool.part?.tool,
          status: backgroundTool.part?.state?.status,
          output: backgroundTool.part?.state?.output,
        },
        preReleaseJob: backgroundBatch.preReleaseJob,
        membershipBeforeRootStop,
        rootExited: true,
        childSurvivedRootExit: true,
        membershipAfterRootStop,
      },
      terminate: {
        response: terminateResponse,
        zeroScan1,
        zeroScan2,
        intervalMs: 500,
      },
    },
    timings: {
      ...timings,
      totalMs: Date.now() - startedAt,
    },
    finalResidue: {
      runtimeScope: {
        jobPids: zeroScan2.pids,
        backgroundAlive: processAlive(backgroundPid),
        rootAlive: processAlive(backgroundRootPid),
      },
      harnessSupport: {
        localProvider: providerCleanup,
      },
    },
    providerStderr: providerError,
  };
  persistResult(result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const cleanup = await failClosedCleanup();
  providerCleanup = await stopProvider();
  const failure = {
    schema: "first-tree.opencode.windows-cli-e2e.v1",
    status: "FAIL",
    failClosed: true,
    error: errorText(error),
    artifact: {
      expectedNodeVersion,
      expectedNodeArchiveSha256,
      expectedOpenCodeVersion,
      expectedOpenCodeNpmIntegrity,
      windowsBase,
      platform: process.platform,
      arch: process.arch,
    },
    partial: {
      backgroundPid,
      backgroundRootPid,
      jobTerminated,
      timings,
    },
    cleanup,
    finalResidue: {
      runtimeScope: {
        jobPids: cleanup.finalJobPids,
        backgroundAlive: Number.isInteger(backgroundPid) && backgroundPid > 1 ? processAlive(backgroundPid) : null,
        rootAlive:
          Number.isInteger(backgroundRootPid) && backgroundRootPid > 1 ? processAlive(backgroundRootPid) : null,
      },
      harnessSupport: {
        localProvider: providerCleanup,
      },
    },
    providerStderr: providerError,
  };
  try {
    persistResult(failure);
  } catch (receiptError) {
    failure.receiptWriteError = errorText(receiptError);
  }
  process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  if (!jobTerminated && existsSync(readyPath)) {
    await failClosedCleanup();
  }
  if (provider && Number.isInteger(provider.pid) && processAlive(provider.pid)) {
    await stopProvider();
  }
}
