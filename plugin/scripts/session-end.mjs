#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
//#region src/env-file.ts
function parseEnvFile(content) {
	const out = {};
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		const quoteChar = value[0] === "\"" || value[0] === "'" ? value[0] : "";
		if (quoteChar) {
			const closeIdx = value.indexOf(quoteChar, 1);
			if (closeIdx !== -1) value = value.slice(1, closeIdx);
		} else {
			const hashIdx = value.indexOf(" #");
			if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
		}
		out[key] = value;
	}
	return out;
}
//#endregion
//#region src/runtime-paths.ts
function resolvePathLayout(options = {}) {
	const env = options.env ?? process.env;
	const configRoot = join(options.home ?? homedir(), ".agentmemory");
	const runtimeDir = env["AGENTMEMORY_RUNTIME_DIR"] ? resolve(env["AGENTMEMORY_RUNTIME_DIR"]) : configRoot;
	return {
		configRoot,
		envFile: join(configRoot, ".env"),
		runtimeDir,
		backupsDir: join(configRoot, "backups"),
		snapshotsDir: env["SNAPSHOT_DIR"] ? resolve(env["SNAPSHOT_DIR"]) : join(configRoot, "snapshots"),
		hooksDir: join(configRoot, "hooks", "current")
	};
}
function agentMemoryOutboxPath(adapter, options = {}) {
	const env = options.env ?? process.env;
	return env["AGENTMEMORY_OUTBOX_DIR"] ? resolve(env["AGENTMEMORY_OUTBOX_DIR"]) : join(resolvePathLayout(options).configRoot, "outbox", adapter);
}
//#endregion
//#region src/hooks/_delivery.ts
let envelopeSequence = 0;
function defaultOutboxDir() {
	return agentMemoryOutboxPath("codex");
}
function hookTransportEnv() {
	try {
		return parseEnvFile(readFileSync(resolvePathLayout().envFile, "utf8"));
	} catch {
		return {};
	}
}
function nonEmpty(value) {
	return value?.trim() ? value : void 0;
}
function stableHookCaptureId(sessionId, eventType, locator) {
	return `codex:${createHash("sha256").update(JSON.stringify([
		sessionId,
		eventType,
		locator
	])).digest("hex").slice(0, 32)}`;
}
function hookSessionId(data) {
	const value = [
		data.session_id,
		data.sessionId,
		data.conversation_id
	].find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
	return typeof value === "string" ? value.trim() : null;
}
function createHookDelivery(options = {}) {
	const fileEnv = hookTransportEnv();
	const restUrl = (options.restUrl || nonEmpty(process.env["AGENTMEMORY_URL"]) || nonEmpty(fileEnv["AGENTMEMORY_URL"]) || "http://localhost:3111").replace(/\/+$/, "");
	const secret = options.secret ?? nonEmpty(process.env["AGENTMEMORY_SECRET"]) ?? nonEmpty(fileEnv["AGENTMEMORY_SECRET"]) ?? "";
	const outboxDir = options.outboxDir || defaultOutboxDir();
	const fetchImpl = options.fetchImpl || fetch;
	const timeoutMs = options.timeoutMs ?? 800;
	const priority = options.priority;
	let queue = Promise.resolve();
	const queuedFiles = /* @__PURE__ */ new Set();
	function headers() {
		const result = { "Content-Type": "application/json" };
		if (secret) result.Authorization = `Bearer ${secret}`;
		return result;
	}
	function bodyForTransmission(path, body) {
		if (path === "/agentmemory/session/start" && body.includeContext === void 0) return {
			...body,
			includeContext: false
		};
		return body;
	}
	async function transmit(path, body) {
		const response = await fetchImpl(`${restUrl}${path}`, {
			method: "POST",
			headers: headers(),
			body: JSON.stringify(bodyForTransmission(path, body)),
			signal: AbortSignal.timeout(timeoutMs)
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
	}
	async function persist(path, body) {
		await mkdir(outboxDir, {
			recursive: true,
			mode: 448
		});
		const identity = typeof body.captureId === "string" && body.captureId.trim() ? {
			path,
			captureId: body.captureId.trim()
		} : typeof body.sessionId === "string" && body.sessionId.trim() ? {
			path,
			sessionId: body.sessionId.trim()
		} : {
			path,
			body
		};
		const target = join(outboxDir, `${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}.json`);
		try {
			await access(target);
			return target;
		} catch {}
		const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, JSON.stringify({
			schemaVersion: 2,
			...priority ? { priority } : {},
			path,
			body,
			createdAt: (/* @__PURE__ */ new Date()).toISOString(),
			sequence: ++envelopeSequence
		}), {
			encoding: "utf8",
			mode: 384
		});
		try {
			await rename(temporary, target);
		} catch (error) {
			try {
				await access(target);
				await rm(temporary, { force: true });
			} catch {
				await rm(temporary, { force: true });
				throw error;
			}
		}
		return target;
	}
	async function deliverEnvelope(file) {
		try {
			const value = JSON.parse(await readFile(file, "utf8"));
			if (typeof value?.path !== "string" || !value.body || typeof value.body !== "object") return 0;
			await transmit(value.path, value.body);
			await rm(file);
			return 1;
		} catch {
			return 0;
		}
	}
	async function listEnvelopes() {
		let names;
		try {
			names = await readdir(outboxDir);
		} catch {
			return [];
		}
		const result = [];
		for (const name of names.filter((entry) => entry.endsWith(".json"))) {
			const file = join(outboxDir, name);
			try {
				const value = JSON.parse(await readFile(file, "utf8"));
				if (typeof value?.path === "string" && value.body && typeof value.body === "object") result.push({
					file,
					value
				});
			} catch {}
		}
		result.sort((a, b) => String(a.value.createdAt || "").localeCompare(String(b.value.createdAt || "")) || Number(a.value.sequence || 0) - Number(b.value.sequence || 0) || a.file.localeCompare(b.file));
		return result;
	}
	async function replayUnlocked(deadline = Number.POSITIVE_INFINITY) {
		let delivered = 0;
		for (const { file, value } of await listEnvelopes()) {
			if (Date.now() >= deadline) break;
			try {
				await transmit(value.path, value.body);
				await rm(file);
				delivered++;
			} catch {
				break;
			}
		}
		return delivered;
	}
	function serialized(task) {
		const run = queue.then(task, task);
		queue = run.then(() => void 0, () => void 0);
		return run;
	}
	return {
		enqueue(path, body) {
			return serialized(async () => {
				queuedFiles.add(await persist(path, body));
			});
		},
		deliver(path, body) {
			return serialized(async () => {
				return deliverEnvelope(await persist(path, body));
			});
		},
		replay() {
			return serialized(replayUnlocked);
		},
		replayFor(budgetMs) {
			const safeBudget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 0;
			return serialized(() => replayUnlocked(Date.now() + safeBudget));
		},
		replayQueuedFor(budgetMs) {
			const safeBudget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 0;
			return serialized(async () => {
				const deadline = Date.now() + safeBudget;
				let delivered = 0;
				for (const file of queuedFiles) {
					if (Date.now() >= deadline) break;
					try {
						const value = JSON.parse(await readFile(file, "utf8"));
						if (typeof value?.path !== "string" || !value.body || typeof value.body !== "object") break;
						await transmit(value.path, value.body);
						await rm(file);
						queuedFiles.delete(file);
						delivered++;
					} catch (error) {
						if (error.code === "ENOENT") {
							queuedFiles.delete(file);
							continue;
						}
						break;
					}
				}
				return delivered;
			});
		}
	};
}
//#endregion
//#region src/hooks/_project.ts
const projectIdentityCache = /* @__PURE__ */ new Map();
const gitProjectIdCache = /* @__PURE__ */ new Map();
function realPath(path) {
	try {
		return realpathSync.native(path);
	} catch {
		return resolve(path);
	}
}
function canonicalPath(path) {
	if (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(path)) return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	let canonical = realPath(path);
	canonical = canonical.replace(/\\/g, "/").replace(/\/+$/, "");
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
function portableBasename(path) {
	const parts = path.split(/[\\/]+/).filter(Boolean);
	return parts[parts.length - 1] || path;
}
function gitRepository(cwd) {
	let current = realPath(cwd);
	try {
		if (!statSync(current).isDirectory()) current = dirname(current);
	} catch {
		return null;
	}
	while (true) {
		const dotGit = join(current, ".git");
		try {
			const metadata = statSync(dotGit);
			if (metadata.isDirectory()) return {
				top: current,
				commonDir: realPath(dotGit)
			};
			if (metadata.isFile()) {
				const pointer = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/im)?.[1];
				if (!pointer) return null;
				const gitDir = realPath(resolve(current, pointer));
				let commonDir = gitDir;
				try {
					const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
					if (common) commonDir = realPath(resolve(gitDir, common));
				} catch {}
				return {
					top: current,
					commonDir
				};
			}
		} catch {}
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
function hashProject(kind, identity) {
	return `${kind}:${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}
function canonicalRemote(remote, cwd) {
	const value = remote.trim();
	if (!value) return null;
	const scp = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
	if (scp && !value.includes("://") && !/^[A-Za-z]:[\\/]/.test(value)) {
		const path = scp[2].replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
		return path ? `${scp[1].toLowerCase()}/${path}` : null;
	}
	try {
		const url = new URL(value);
		if (url.protocol === "file:") return `file/${canonicalPath(decodeURIComponent(url.pathname))}`;
		const host = url.hostname.toLowerCase();
		const port = url.port ? `:${url.port}` : "";
		const path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
		return host && path ? `${host}${port}/${path}` : null;
	} catch {
		return `file/${canonicalPath(resolve(cwd, value))}`;
	}
}
function gitRemoteIdentity(commonDir, cwd) {
	const remotes = /* @__PURE__ */ new Map();
	try {
		const configured = readFileSync(join(commonDir, "config"), "utf8");
		let remoteName = null;
		for (const line of configured.split(/\r?\n/)) {
			const section = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/i);
			if (section) {
				remoteName = section[1];
				continue;
			}
			if (/^\s*\[/.test(line)) {
				remoteName = null;
				continue;
			}
			const url = remoteName ? line.match(/^\s*url\s*=\s*(.+?)\s*$/i) : null;
			if (url) remotes.set(remoteName, url[1]);
		}
	} catch {}
	const names = ["upstream", "origin"];
	for (const name of [...remotes.keys()].sort()) if (!names.includes(name)) names.push(name);
	for (const name of names) {
		const remote = remotes.get(name);
		if (!remote) continue;
		const canonical = canonicalRemote(remote, cwd);
		if (canonical) return canonical;
	}
	return null;
}
function resolveProjectIdentity(cwd, options = {}) {
	const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
	if (options.useEnvOverride !== false && explicit && explicit.trim()) {
		const project = explicit.trim();
		return {
			projectId: project,
			projectName: project,
			legacyProjectIds: []
		};
	}
	const dir = cwd && cwd.trim() ? cwd : process.cwd();
	const cacheKey = canonicalPath(dir);
	const cached = projectIdentityCache.get(cacheKey);
	if (cached) return cached;
	const repository = gitRepository(dir);
	const canonicalCommonDir = repository ? canonicalPath(repository.commonDir) : null;
	const projectName = repository ? basename(canonicalCommonDir?.endsWith("/.git") ? dirname(canonicalCommonDir) : repository.top) : portableBasename(cacheKey);
	let identity;
	if (repository && canonicalCommonDir) {
		const cachedProjectId = gitProjectIdCache.get(canonicalCommonDir);
		if (cachedProjectId) {
			identity = {
				projectId: cachedProjectId,
				projectName,
				legacyProjectIds: [projectName]
			};
			projectIdentityCache.set(cacheKey, identity);
			return identity;
		}
		const remote = gitRemoteIdentity(repository.commonDir, dir);
		if (remote) identity = {
			projectId: hashProject("git", remote),
			projectName,
			legacyProjectIds: [projectName]
		};
		else identity = {
			projectId: hashProject("path", canonicalCommonDir),
			projectName,
			legacyProjectIds: [projectName]
		};
		gitProjectIdCache.set(canonicalCommonDir, identity.projectId);
	} else identity = {
		projectId: hashProject("path", cacheKey),
		projectName,
		legacyProjectIds: [projectName]
	};
	projectIdentityCache.set(cacheKey, identity);
	return identity;
}
function sourceClientFromArgs(args) {
	const flag = "--source-client";
	for (let index = args.length - 1; index >= 0; index--) {
		const value = args[index];
		if (value === flag) {
			const candidate = args[index + 1]?.trim();
			return candidate ? candidate.slice(0, 64) : void 0;
		}
		if (value?.startsWith(`${flag}=`)) {
			const candidate = value.slice(16).trim();
			return candidate ? candidate.slice(0, 64) : void 0;
		}
	}
}
function resolveProjectPayload(cwd, args = process.argv.slice(2)) {
	const identity = resolveProjectIdentity(cwd);
	const sourceClient = sourceClientFromArgs(args);
	return {
		project: identity.projectId,
		projectName: identity.projectName,
		...sourceClient ? { sourceClient } : {}
	};
}
function hookCwd(data) {
	if (!data || typeof data !== "object") return void 0;
	if (typeof data.cwd === "string" && data.cwd.trim()) return data.cwd;
	const roots = data.workspace_roots;
	if (Array.isArray(roots)) {
		for (const root of roots) if (typeof root === "string" && root.trim()) return root;
	}
	const projectDir = process.env["DEVIN_PROJECT_DIR"] || process.env["CLAUDE_PROJECT_DIR"];
	if (projectDir && projectDir.trim()) return projectDir;
}
//#endregion
//#region src/hooks/codex-transcript.ts
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function contentText(content) {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content.flatMap((item) => {
		const block = asRecord(item);
		if (!block) return [];
		const text = block.text;
		return typeof text === "string" ? [text] : [];
	}).join("\n").trim();
}
function parseArguments(value) {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}
function cursorPrompts(entry) {
	if (entry.role !== "user") return [];
	const text = contentText(asRecord(entry.message)?.content);
	const matches = [...text.matchAll(/<user_query>\n?([\s\S]*?)\n?<\/user_query>/g)].map((match) => match[1].trim()).filter(Boolean);
	if (matches.length > 0) return matches;
	const prompt = text.trim();
	return prompt ? [prompt] : [];
}
function readTranscriptTail(path) {
	if (!path.endsWith(".jsonl")) return {
		text: "",
		truncated: false
	};
	let fd = null;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
		const length = size - start;
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, start);
		let text = buffer.toString("utf8");
		if (start > 0) {
			const firstNewline = text.indexOf("\n");
			text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
		}
		return {
			text,
			truncated: start > 0
		};
	} catch {
		return {
			text: "",
			truncated: false
		};
	} finally {
		if (fd !== null) closeSync(fd);
	}
}
function parseCodexTranscriptText(text) {
	const entries = [];
	for (const [line, raw] of text.split(/\r?\n/).entries()) {
		if (!raw.trim()) continue;
		try {
			const entry = asRecord(JSON.parse(raw));
			if (entry) entries.push({
				line,
				entry
			});
		} catch {}
	}
	const calls = /* @__PURE__ */ new Map();
	for (const { entry } of entries) {
		if (entry.type !== "response_item") continue;
		const payload = asRecord(entry.payload);
		if (!payload) continue;
		const callId = typeof payload.call_id === "string" ? payload.call_id : "";
		if (!callId) continue;
		if (payload.type === "function_call" || payload.type === "custom_tool_call") calls.set(callId, {
			name: typeof payload.name === "string" ? payload.name : "unknown",
			input: parseArguments(payload.arguments ?? payload.input)
		});
		else if (payload.type === "local_shell_call") calls.set(callId, {
			name: "local_shell",
			input: payload.action ?? payload.command
		});
	}
	const captures = [];
	let currentTurnId = "";
	for (const { line, entry } of entries) {
		const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : void 0;
		if (entry.type === "turn_context") {
			const payload = asRecord(entry.payload);
			currentTurnId = typeof payload?.turn_id === "string" ? payload.turn_id : currentTurnId;
			continue;
		}
		if (entry.type === "response_item") {
			const payload = asRecord(entry.payload);
			if (!payload) continue;
			if (payload.type === "message") {
				const role = payload.role;
				const message = contentText(payload.content);
				if (!message) continue;
				if (role === "user") {
					if (message.startsWith("<environment_context>")) continue;
					captures.push({
						hookType: "prompt_submit",
						captureEvent: "prompt",
						locator: currentTurnId || message,
						timestamp,
						data: {
							prompt: message,
							archive_reconciled: true
						}
					});
				} else if (role === "assistant") captures.push({
					hookType: "post_tool_use",
					captureEvent: "assistant",
					locator: currentTurnId || message,
					timestamp,
					data: {
						tool_name: "assistant_response",
						tool_input: { turn_id: currentTurnId || void 0 },
						tool_output: message,
						archive_reconciled: true
					}
				});
				continue;
			}
			if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
				const callId = typeof payload.call_id === "string" ? payload.call_id : "";
				if (!callId) continue;
				const call = calls.get(callId) ?? {
					name: "unknown",
					input: void 0
				};
				const output = parseArguments(payload.output);
				const failed = asRecord(output)?.success === false;
				captures.push({
					hookType: failed ? "post_tool_failure" : "post_tool_use",
					captureEvent: "tool",
					locator: callId,
					timestamp,
					data: {
						tool_name: call.name,
						tool_input: call.input,
						tool_output: output,
						call_id: callId,
						archive_reconciled: true
					}
				});
			}
			continue;
		}
		if (entry.type === "event_msg") {
			const payload = asRecord(entry.payload);
			if (payload?.type !== "thread_name_updated") continue;
			const title = payload.thread_name ?? payload.name;
			if (typeof title !== "string" || !title.trim()) continue;
			captures.push({
				hookType: "notification",
				captureEvent: "title",
				locator: title.trim(),
				timestamp,
				data: {
					notification_type: "thread_name_updated",
					title: title.trim(),
					archive_reconciled: true
				}
			});
			continue;
		}
		for (const prompt of cursorPrompts(entry)) captures.push({
			hookType: "prompt_submit",
			captureEvent: "prompt",
			locator: prompt,
			timestamp,
			data: {
				prompt,
				archive_reconciled: true
			}
		});
	}
	return captures;
}
//#endregion
//#region src/hooks/session-end.ts
const MAX_ARCHIVE_CAPTURES = 50;
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data;
	try {
		data = JSON.parse(input);
	} catch {
		return;
	}
	if (!data || typeof data !== "object" || isSdkChildContext(data)) return;
	const sessionId = hookSessionId(data);
	if (!sessionId) return;
	const cwd = hookCwd(data) || process.cwd();
	const projectPayload = resolveProjectPayload(cwd);
	const rawAgentId = data.agent_id ?? data.agentId;
	const agentId = typeof rawAgentId === "string" && rawAgentId.trim() ? rawAgentId.trim().slice(0, 128) : void 0;
	const delivery = createHookDelivery({
		timeoutMs: 250,
		priority: "terminal"
	});
	const transcriptPath = typeof data.transcript_path === "string" ? data.transcript_path : "";
	const transcript = transcriptPath ? readTranscriptTail(transcriptPath) : {
		text: "",
		truncated: false
	};
	const captures = parseCodexTranscriptText(transcript.text).slice(-MAX_ARCHIVE_CAPTURES);
	for (const capture of captures) await delivery.enqueue("/agentmemory/observe", {
		captureId: stableHookCaptureId(sessionId, capture.captureEvent, capture.locator),
		hookType: capture.hookType,
		sessionId,
		...projectPayload,
		cwd,
		...agentId ? { agentId } : {},
		timestamp: capture.timestamp || (/* @__PURE__ */ new Date()).toISOString(),
		data: capture.data
	});
	if (transcript.truncated) await delivery.enqueue("/agentmemory/observe", {
		captureId: stableHookCaptureId(sessionId, "archive", "tail-truncated"),
		hookType: "notification",
		sessionId,
		...projectPayload,
		cwd,
		...agentId ? { agentId } : {},
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		data: {
			notification_type: "archive_reconcile_truncated",
			max_bytes: TRANSCRIPT_TAIL_BYTES
		}
	});
	await delivery.enqueue("/agentmemory/session/end", { sessionId });
	if (process.env["CLAUDE_MEMORY_BRIDGE"] === "true") await delivery.enqueue("/agentmemory/claude-bridge/sync", {});
	await delivery.replayQueuedFor(600);
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=session-end.mjs.map