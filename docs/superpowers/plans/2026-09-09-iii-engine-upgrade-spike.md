# iii Engine Upgrade Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settle, against a throwaway copy of the real data, whether engine `0.23.1-rc.3` can read this store, parse this config, and route this HTTP contract — so that the migration plan that follows is written from measurements instead of guesses.

**Architecture:** Nothing in this plan touches the live runtime. Every task operates on `validation-runtime/capability-cohort-20260901/data-base/spike-instance-99`, a copy of `instance-25`, driven by a second engine binary on ports 5711 / 5712 / 51734. The live engine keeps running on 5611 / 5612 / 51634 throughout. Each task answers exactly one question and writes its answer into the spike report; a task that fails is a *result*, not a blocked task.

**Tech Stack:** Windows 11, PowerShell 7 + Git Bash, Node 24, `iii` engine (Rust binary), `iii-sdk` (npm), AgentMemory worker (TypeScript, built to `dist/`).

**Spec:** `records/core-recovery/verification/graph-backlog-provider-20260909.md` (why the upgrade), plus the S2/S3/S4 evidence entries dated 2026-09-09 in `.worktrees/reliability-spine/.swe-cycle/state.json` (root cause, decision, and the three unknowns this plan settles).

## Global Constraints

- Target engine version is exactly **0.23.1-rc.3**. Not 0.23.0: 0.23.0 ships the in-memory-trace fix (iii-hq/iii#2067) but its disk eviction never reclaimed space; iii-hq/iii#2068, which fixes that, is only in 0.23.1-rc.x.
- Engine asset: `https://github.com/iii-hq/iii/releases/download/iii/v0.23.1-rc.3/iii-x86_64-pc-windows-msvc.zip` (9,278,012 bytes). SDK: `iii-sdk@0.23.1-rc.3` on npm.
- The currently installed engine is `0.11.2`, sha256 `2447BC21906A6B5BE270868DA7E74A1C744A4644CF3BD4B37A228BA4E55478CA`, at `C:\Users\nasca\.agentmemory\bin\iii.exe`. **Never overwrite, move, or delete this file in this plan.** The new binary lives beside it under a different name.
- **Never point a 0.23.1 engine at `data-base/instance-25`.** A forward-migration of an embedded store is not reversible by copying files back once the engine has rewritten them. Only `spike-instance-99` is ever opened by the new binary.
- The live runtime on ports 5611 / 5612 / 51634 must stay up for the whole plan. If a step would need it stopped, the step is wrong — stop and report.
- Secrets: `AGENTMEMORY_SECRET` lives in `%USERPROFILE%\.agentmemory\.env`. Never print its value; report presence and length only.
- Every task appends one `evidence` entry to `.worktrees/reliability-spine/.swe-cycle/state.json`. The array is append-only — never remove or rewrite an entry.
- Tool calls are cut off at 600 s. Any command that could exceed that runs in the background with its output written to a file.

---

### Task 1: Stand up an isolated copy of the store and the new binary

**Files:**
- Create: `D:\AGENTMEMORY_FOR_ME\validation-runtime\capability-cohort-20260901\data-base\spike-instance-99\` (copy of `instance-25`, ~1.02 GB)
- Create: `C:\Users\nasca\.agentmemory\bin\iii-0.23.1-rc.3.exe`
- Create: `D:\AGENTMEMORY_FOR_ME\records\core-recovery\verification\iii-upgrade-spike-20260909.md`
- Read only: `D:\AGENTMEMORY_FOR_ME\validation-runtime\capability-cohort-20260901\data-base\instance-25\`

**Interfaces:**
- Consumes: nothing.
- Produces: `$SPIKE = D:/AGENTMEMORY_FOR_ME/validation-runtime/capability-cohort-20260901/data-base/spike-instance-99`, containing `iii-config.spike.yaml`, `state_store.db/`, `stream_store/`; and `$NEWENGINE = C:/Users/nasca/.agentmemory/bin/iii-0.23.1-rc.3.exe`. Tasks 2–4 use both.

- [ ] **Step 1: Confirm the live engine is up, and record what it is**

```bash
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='iii.exe'\" | ForEach-Object { '{0} started {1}' -f \$_.ProcessId, \$_.CreationDate }"
```
Expected: exactly one `iii.exe`. Write the pid down. If there is none, stop — this plan assumes the live runtime is running.

- [ ] **Step 2: Copy the instance directory**

Runs several minutes on ~1 GB, so background it and poll.

```bash
nohup cp -r "D:/AGENTMEMORY_FOR_ME/validation-runtime/capability-cohort-20260901/data-base/instance-25" "D:/AGENTMEMORY_FOR_ME/validation-runtime/capability-cohort-20260901/data-base/spike-instance-99" > /dev/null 2>&1 &
```

- [ ] **Step 3: Verify the copy is complete before using it**

```bash
du -sh "D:/AGENTMEMORY_FOR_ME/validation-runtime/capability-cohort-20260901/data-base/instance-25" "D:/AGENTMEMORY_FOR_ME/validation-runtime/capability-cohort-20260901/data-base/spike-instance-99"
```
Expected: both report ~1.0 GB and the file counts match. A copy still in progress reports a smaller size — wait and re-run rather than proceeding.

- [ ] **Step 4: Download and unpack the new engine beside the old one**

```bash
cd "C:/Users/nasca/AppData/Local/Temp/claude/D--/44bf9360-5382-452f-a678-e456098dbd67/scratchpad" && gh release download iii/v0.23.1-rc.3 --repo iii-hq/iii --pattern "iii-x86_64-pc-windows-msvc.*" --clobber
```

- [ ] **Step 5: Verify the download against its published checksum before running it**

```bash
cd "C:/Users/nasca/AppData/Local/Temp/claude/D--/44bf9360-5382-452f-a678-e456098dbd67/scratchpad" && cat iii-x86_64-pc-windows-msvc.sha256 && sha256sum iii-x86_64-pc-windows-msvc.zip
```
Expected: the hash in the `.sha256` file equals the computed hash. If they differ, stop — do not run the binary.

- [ ] **Step 6: Unpack and install under a version-qualified name**

```bash
cd "C:/Users/nasca/AppData/Local/Temp/claude/D--/44bf9360-5382-452f-a678-e456098dbd67/scratchpad" && unzip -o iii-x86_64-pc-windows-msvc.zip -d iii-new && find iii-new -name 'iii.exe' -exec cp {} "C:/Users/nasca/.agentmemory/bin/iii-0.23.1-rc.3.exe" \;
```

- [ ] **Step 7: Confirm both binaries exist and report different versions**

```bash
"C:/Users/nasca/.agentmemory/bin/iii.exe" --version; "C:/Users/nasca/.agentmemory/bin/iii-0.23.1-rc.3.exe" --version
```
Expected: `0.11.2` then `0.23.1-rc.3`. If the second does not run at all, that is a result — record it and stop the plan here.

- [ ] **Step 8: Write the spike config with copied paths and free ports**

Create `spike-instance-99/iii-config.spike.yaml` as a copy of `spike-instance-99/iii-config.native.yaml` with exactly four substitutions and nothing else:
`5611`→`5711`, `5612`→`5712`, `51634`→`51734`, and every `data-base/instance-25` path→`data-base/spike-instance-99`.

```bash
python -c "
import io
src='D:/AGENTMEMORY_FOR_ME/validation-runtime/capability-cohort-20260901/data-base/spike-instance-99/iii-config.native.yaml'
dst='D:/AGENTMEMORY_FOR_ME/validation-runtime/capability-cohort-20260901/data-base/spike-instance-99/iii-config.spike.yaml'
s=io.open(src,encoding='utf-8',newline='').read()
for a,b in [('5611','5711'),('5612','5712'),('51634','51734'),('data-base/instance-25','data-base/spike-instance-99')]:
    s=s.replace(a,b)
io.open(dst,'w',encoding='utf-8',newline='').write(s)
print('written')
"
```

- [ ] **Step 9: Prove the spike ports are free**

```bash
powershell.exe -NoProfile -Command "foreach (\$p in 5711,5712,51734) { '{0}: {1}' -f \$p, (Get-NetTCPConnection -State Listen -LocalPort \$p -ErrorAction SilentlyContinue | Measure-Object).Count }"
```
Expected: `0` for all three. A non-zero count means something else holds the port — pick another and update the config before continuing.

- [ ] **Step 10: Create the spike report and record Task 1**

Create `records/core-recovery/verification/iii-upgrade-spike-20260909.md` with a `## Task 1 — isolation` section stating: the live pid from Step 1, both `--version` outputs from Step 7, whether the checksum matched, and the three spike ports.

- [ ] **Step 11: Append evidence**

```bash
python -c "
import json,io,datetime
p='D:/AGENTMEMORY_FOR_ME/.worktrees/reliability-spine/.swe-cycle/state.json'
d=json.load(io.open(p,encoding='utf-8'))
d['evidence'].append({'stage':'S5','at':datetime.datetime.now().isoformat(timespec='seconds'),'kind':'spike-setup','detail':'Isolated spike stood up: spike-instance-99 copied from instance-25, engine 0.23.1-rc.3 installed as iii-0.23.1-rc.3.exe with checksum verified, spike ports 5711/5712/51734 confirmed free. Live runtime untouched on 5611/5612/51634.'})
io.open(p,'w',encoding='utf-8').write(json.dumps(d,ensure_ascii=False,indent=2)+chr(10))
print('evidence',len(d['evidence']))
"
```

---

### Task 2: Answer unknown 1 and 2 — does the store open, does the config parse

**Files:**
- Modify: `records/core-recovery/verification/iii-upgrade-spike-20260909.md` (add `## Task 2` section)
- Read only: everything under `spike-instance-99`
- Create: `C:/Users/nasca/AppData/Local/Temp/claude/D--/44bf9360-5382-452f-a678-e456098dbd67/scratchpad/spike-engine.log`

**Interfaces:**
- Consumes: `$SPIKE` and `$NEWENGINE` from Task 1.
- Produces: a yes/no on each of `config_parses` and `store_opens`, plus the verbatim first error if either is no. Task 3 only runs if both are yes.

- [ ] **Step 1: Record the store's pre-flight state so a rewrite is detectable**

```bash
python -c "
import os,hashlib
r='D:/AGENTMEMORY_FOR_ME/validation-runtime/capability-cohort-20260901/data-base/spike-instance-99/state_store.db'
n=0; tot=0; h=hashlib.sha256()
for f in sorted(os.listdir(r)):
    p=os.path.join(r,f); n+=1; tot+=os.path.getsize(p); h.update(f.encode())
print('files',n,'bytes',tot,'nameset',h.hexdigest()[:16])
"
```
Write these three numbers into the report — Step 6 compares against them.

- [ ] **Step 2: Start the new engine against the copy, in the background**

```bash
nohup "C:/Users/nasca/.agentmemory/bin/iii-0.23.1-rc.3.exe" --config "D:/AGENTMEMORY_FOR_ME/validation-runtime/capability-cohort-20260901/data-base/spike-instance-99/iii-config.spike.yaml" > "C:/Users/nasca/AppData/Local/Temp/claude/D--/44bf9360-5382-452f-a678-e456098dbd67/scratchpad/spike-engine.log" 2>&1 &
```

- [ ] **Step 3: Give it 60 seconds, then read what it said**

```bash
sleep 60; tail -40 "C:/Users/nasca/AppData/Local/Temp/claude/D--/44bf9360-5382-452f-a678-e456098dbd67/scratchpad/spike-engine.log"
```
Three outcomes, all of them results worth recording verbatim:
a) It is listening and logged no error → both unknowns answered yes, continue.
b) It exited complaining about the config (unknown keys, missing fields, schema) → unknown 2 is **no**; copy the exact message into the report.
c) It exited or errored on the store (adapter, format, version, corrupt) → unknown 1 is **no**; copy the exact message.

- [ ] **Step 4: Confirm whether it is actually listening**

```bash
powershell.exe -NoProfile -Command "foreach (\$p in 5711,5712,51734) { '{0}: {1}' -f \$p, (Get-NetTCPConnection -State Listen -LocalPort \$p -ErrorAction SilentlyContinue | Measure-Object).Count }"
```
Expected on outcome (a): `1` for 5711 and 51734 at minimum. Ports reported as free while the process is alive means it started but did not bind — record that too.

- [ ] **Step 5: Confirm the live runtime is still healthy and was not disturbed**

```bash
S=$(grep -m1 '^\s*AGENTMEMORY_SECRET\s*=' "$USERPROFILE/.agentmemory/.env" | sed 's/^[^=]*=//' | sed 's/[[:space:]]\+#.*$//' | tr -d '"'"'"'\r'); curl -s -m 60 -H "Authorization: Bearer $S" http://127.0.0.1:5611/agentmemory/graph/stats -o /dev/null -w 'live REST: HTTP %{http_code} in %{time_total}s\n'
```
Expected: `HTTP 200`. Anything else means the spike disturbed the live runtime — stop the spike engine immediately and report.

- [ ] **Step 6: Check whether the new engine rewrote the copied store**

```bash
python -c "
import os,hashlib
r='D:/AGENTMEMORY_FOR_ME/validation-runtime/capability-cohort-20260901/data-base/spike-instance-99/state_store.db'
n=0; tot=0; h=hashlib.sha256()
for f in sorted(os.listdir(r)):
    p=os.path.join(r,f); n+=1; tot+=os.path.getsize(p); h.update(f.encode())
print('files',n,'bytes',tot,'nameset',h.hexdigest()[:16])
"
```
Compare with Step 1. A changed file count or name set means the new engine performed a forward migration — which is the single most important fact for the migration plan, because it means the cutover is not reversible by restarting the old binary.

- [ ] **Step 7: Stop the spike engine**

```bash
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='iii-0.23.1-rc.3.exe'\" | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue; 'stopped ' + \$_.ProcessId }"
```

- [ ] **Step 8: Write the Task 2 section of the report**

Record: the two pre/post store fingerprints, which of the three outcomes occurred, the verbatim error if any, whether the live runtime stayed at HTTP 200, and a one-line verdict for unknown 1 and unknown 2 each.

- [ ] **Step 9: Append evidence**

```bash
python -c "
import json,io,datetime
p='D:/AGENTMEMORY_FOR_ME/.worktrees/reliability-spine/.swe-cycle/state.json'
d=json.load(io.open(p,encoding='utf-8'))
d['evidence'].append({'stage':'S5','at':datetime.datetime.now().isoformat(timespec='seconds'),'kind':'spike-result','detail':'REPLACE WITH THE ACTUAL VERDICT: config parses yes/no, store opens yes/no, store rewritten yes/no, verbatim first error if any, live runtime undisturbed yes/no.'})
io.open(p,'w',encoding='utf-8').write(json.dumps(d,ensure_ascii=False,indent=2)+chr(10))
print('evidence',len(d['evidence']))
"
```

---

### Task 3: Answer unknown 3 — does the HTTP trigger contract still route

Run this task only if Task 2 answered yes to both unknowns. If either was no, skip to Task 4 and record that unknown 3 is untested and why.

**Files:**
- Create: `C:/Users/nasca/AppData/Local/Temp/claude/D--/44bf9360-5382-452f-a678-e456098dbd67/scratchpad/spike-http-probe.mjs`
- Modify: `records/core-recovery/verification/iii-upgrade-spike-20260909.md` (add `## Task 3` section)
- Read only: `src/triggers/api.ts` (for the exact registration shape being reproduced)

**Interfaces:**
- Consumes: `$SPIKE`, `$NEWENGINE`, and the running spike engine from Task 2.
- Produces: a yes/no on whether `registerTrigger({type:"http", config:{api_path, http_method}})` still routes a request to a registered function under 0.23.1-rc.3, and if no, what the new shape is.

- [ ] **Step 1: Write the probe — the smallest worker that exercises the exact contract AgentMemory uses**

This reproduces `sdk.registerFunction` + `sdk.registerTrigger` with `api_path` / `http_method`, which is how all 149 of AgentMemory's REST endpoints are declared.

```javascript
// spike-http-probe.mjs — minimal worker against the spike engine on 51734.
import { registerWorker } from "iii-sdk";

const sdk = registerWorker("http://127.0.0.1:51734");

sdk.registerFunction("spike::ping", async (req) => ({
  status_code: 200,
  body: { ok: true, sawBody: req?.body ?? null },
}));

sdk.registerTrigger({
  type: "http",
  function_id: "spike::ping",
  config: { api_path: "/spike/ping", http_method: "POST" },
});

console.log(JSON.stringify({ phase: "registered", client: typeof sdk }));
setTimeout(() => { console.log(JSON.stringify({ phase: "alive" })); }, 600000);
```

- [ ] **Step 2: Install the target SDK into a throwaway directory, not into the project**

```bash
mkdir -p "C:/Users/nasca/AppData/Local/Temp/claude/D--/44bf9360-5382-452f-a678-e456098dbd67/scratchpad/spike-sdk" && cd "C:/Users/nasca/AppData/Local/Temp/claude/D--/44bf9360-5382-452f-a678-e456098dbd67/scratchpad/spike-sdk" && npm init -y > /dev/null && npm install iii-sdk@0.23.1-rc.3 --silent && node -e "console.log(require('iii-sdk/package.json').version)"
```
Expected: prints `0.23.1-rc.3`. The project's own `node_modules` must not be touched by this plan.

- [ ] **Step 3: Restart the spike engine (Task 2 Step 7 stopped it)**

```bash
nohup "C:/Users/nasca/.agentmemory/bin/iii-0.23.1-rc.3.exe" --config "D:/AGENTMEMORY_FOR_ME/validation-runtime/capability-cohort-20260901/data-base/spike-instance-99/iii-config.spike.yaml" >> "C:/Users/nasca/AppData/Local/Temp/claude/D--/44bf9360-5382-452f-a678-e456098dbd67/scratchpad/spike-engine.log" 2>&1 & sleep 45; echo started
```

- [ ] **Step 4: Run the probe worker in the background**

```bash
cp "C:/Users/nasca/AppData/Local/Temp/claude/D--/44bf9360-5382-452f-a678-e456098dbd67/scratchpad/spike-http-probe.mjs" "C:/Users/nasca/AppData/Local/Temp/claude/D--/44bf9360-5382-452f-a678-e456098dbd67/scratchpad/spike-sdk/" && cd "C:/Users/nasca/AppData/Local/Temp/claude/D--/44bf9360-5382-452f-a678-e456098dbd67/scratchpad/spike-sdk" && nohup node spike-http-probe.mjs > probe.log 2>&1 & sleep 30; tail -20 "C:/Users/nasca/AppData/Local/Temp/claude/D--/44bf9360-5382-452f-a678-e456098dbd67/scratchpad/spike-sdk/probe.log"
```
Expected: `{"phase":"registered",...}` and no exception. A throw here is the answer to unknown 3 — record it verbatim.

- [ ] **Step 5: Call the route through the spike HTTP port**

```bash
curl -s -m 30 -H 'Content-Type: application/json' -X POST http://127.0.0.1:5711/spike/ping -d '{"hello":"world"}' -w '\n[HTTP %{http_code} in %{time_total}s]\n'
```
Expected on success: `{"ok":true,"sawBody":{"hello":"world"}}` and `HTTP 200`. A 404 means the trigger registered but the route shape changed. A connection failure means the HTTP worker did not bind.

- [ ] **Step 6: Stop the probe and the spike engine**

```bash
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'spike-http-probe' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }; Get-CimInstance Win32_Process -Filter \"Name='iii-0.23.1-rc.3.exe'\" | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue; 'stopped ' + \$_.ProcessId }"
```

- [ ] **Step 7: Write the Task 3 section and append evidence**

Record the probe's registration output, the exact HTTP status and body from Step 5, and a one-line verdict on unknown 3. Then append an `{stage:'S5', kind:'spike-result'}` evidence entry using the same Python snippet as Task 2 Step 9, with the verdict substituted.

---

### Task 4: Decide, and hand the decision to the migration plan

**Files:**
- Modify: `records/core-recovery/verification/iii-upgrade-spike-20260909.md` (add `## Verdict` section)
- Modify: `.worktrees/reliability-spine/.swe-cycle/state.json`
- Read only: Tasks 1–3 report sections

**Interfaces:**
- Consumes: the three verdicts.
- Produces: one of three named routes, which is the input the migration plan is written against.

- [ ] **Step 1: Classify the result into exactly one route**

- **Route A — clean:** config parses, store opens, HTTP routes. The migration is then only the SDK type rewiring already scoped (ISdk→IIIClient shim, local ApiRequest/HttpRequest/HttpResponse/Logger definitions) plus a supervised cutover.
- **Route B — data migration needed:** config and HTTP fine, but the store required a forward migration or failed to open. The migration plan must then add an export/reimport path and a rehearsed rollback, because restarting 0.11.2 on a migrated store is not a rollback.
- **Route C — contract break:** the config schema or the HTTP trigger shape changed. The migration plan must then rewrite the engine config and possibly the 149 trigger registrations, and the estimate changes materially.

- [ ] **Step 2: Write the verdict section**

State the route, the evidence for it (quoting the exact outputs), and the single largest remaining risk in one sentence.

- [ ] **Step 3: Append the closing evidence entry**

```bash
python -c "
import json,io,datetime
p='D:/AGENTMEMORY_FOR_ME/.worktrees/reliability-spine/.swe-cycle/state.json'
d=json.load(io.open(p,encoding='utf-8'))
d['evidence'].append({'stage':'S5','at':datetime.datetime.now().isoformat(timespec='seconds'),'kind':'spike-verdict','detail':'REPLACE: route A/B/C, the three verdicts, and the largest remaining risk.'})
io.open(p,'w',encoding='utf-8').write(json.dumps(d,ensure_ascii=False,indent=2)+chr(10))
print('evidence',len(d['evidence']))
"
```

- [ ] **Step 4: Leave the spike in place, and say so**

Do not delete `spike-instance-99` — the migration plan rehearses the cutover against it. Report its path and size, and that ~1 GB stays on disk until the migration completes.

- [ ] **Step 5: Commit the plan and the report**

```bash
cd "D:/AGENTMEMORY_FOR_ME/.worktrees/synthetic-core-integration" && git add -A && git diff --cached --name-only && git grep --cached -n -E 'sk-[A-Za-z0-9]{20,}|AGENTMEMORY_SECRET\s*=\s*[A-Za-z0-9]|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}' -- $(git diff --cached --name-only)
```
The credential scan must print nothing. Then commit with a message naming the route and the three verdicts.

---

## Self-Review

**Spec coverage.** The spec names three unknowns; Task 2 settles unknowns 1 and 2, Task 3 settles unknown 3, Task 4 converts them into the route the migration plan needs. The spec's constraint that the live runtime must not be touched is carried by Task 1 Step 1, Task 2 Step 5, and the global constraint forbidding the new binary from ever opening `instance-25`.

**Placeholder scan.** Two `REPLACE:` markers remain, in Task 2 Step 9 and Task 4 Step 3. They are deliberate: those strings are measurement results that cannot exist before the measurement runs, and each is accompanied by an explicit list of what must be substituted. Every command, path, port, hash and expected output elsewhere is literal.

**Type consistency.** `$SPIKE`, `$NEWENGINE`, the three ports 5711/5712/51734, the binary name `iii-0.23.1-rc.3.exe`, the report path `records/core-recovery/verification/iii-upgrade-spike-20260909.md`, and the state file path are spelled identically in every task that uses them.
