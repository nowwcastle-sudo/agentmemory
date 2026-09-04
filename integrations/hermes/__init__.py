"""
agentmemory memory provider for Hermes Agent.

Drop this folder into ~/.hermes/plugins/agentmemory/
or install via: hermes plugin install agentmemory

Requires agentmemory server running: npx @agentmemory/agentmemory
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import sys
import threading
import uuid
from pathlib import Path, PurePath


_project_identity_cache: dict[str, dict[str, str]] = {}
_git_project_id_cache: dict[str, str] = {}


def _canonical_project_path(value: str) -> str:
    return os.path.normcase(str(Path(value).resolve())).replace("\\", "/").rstrip("/")


def _git_repository(cwd: str) -> tuple[str, str] | None:
    current = Path(cwd).resolve()
    if not current.is_dir():
        return None
    for candidate in (current, *current.parents):
        dot_git = candidate / ".git"
        if dot_git.is_dir():
            return str(candidate), str(dot_git.resolve())
        if dot_git.is_file():
            try:
                match = re.search(
                    r"^gitdir:\s*(.+)\s*$",
                    dot_git.read_text(encoding="utf-8"),
                    flags=re.IGNORECASE | re.MULTILINE,
                )
                if not match:
                    return None
                git_dir = (candidate / match.group(1)).resolve()
                common_dir = git_dir
                common_file = git_dir / "commondir"
                if common_file.is_file():
                    common = common_file.read_text(encoding="utf-8").strip()
                    if common:
                        common_dir = (git_dir / common).resolve()
                return str(candidate), str(common_dir)
            except OSError:
                return None
    return None


def _project_hash(kind: str, value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:32]
    return f"{kind}:{digest}"


def _canonical_remote(remote: str, cwd: str) -> str | None:
    value = remote.strip()
    match = re.match(r"^(?:[^@/\s]+@)?([^:/\s]+):(.+)$", value)
    if match and "://" not in value and not re.match(r"^[A-Za-z]:[\\/]", value):
        path = re.sub(r"\.git$", "", match.group(2).strip("/"), flags=re.IGNORECASE)
        return f"{match.group(1).lower()}/{path}" if path else None
    try:
        parsed = urlparse(value)
        if parsed.scheme == "file":
            return f"file/{_canonical_project_path(unquote(parsed.path))}"
        if parsed.scheme and parsed.hostname:
            path = re.sub(r"\.git$", "", unquote(parsed.path).strip("/"), flags=re.IGNORECASE)
            port = f":{parsed.port}" if parsed.port else ""
            return f"{parsed.hostname.lower()}{port}/{path}" if path else None
    except Exception:
        pass
    return f"file/{_canonical_project_path(str(Path(cwd, value)))}" if value else None


def _git_remote_identity(common_dir: str, cwd: str) -> str | None:
    remotes: dict[str, str] = {}
    try:
        configured = Path(common_dir, "config").read_text(encoding="utf-8")
        remote_name: str | None = None
        for line in configured.splitlines():
            section = re.match(r'^\s*\[remote\s+"([^"]+)"\]\s*$', line, re.IGNORECASE)
            if section:
                remote_name = section.group(1)
                continue
            if re.match(r"^\s*\[", line):
                remote_name = None
                continue
            url = re.match(r"^\s*url\s*=\s*(.+?)\s*$", line, re.IGNORECASE) if remote_name else None
            if url and remote_name:
                remotes[remote_name] = url.group(1)
    except OSError:
        pass
    names = ["upstream", "origin"]
    for name in sorted(remotes):
        if name not in names:
            names.append(name)
    for name in names:
        remote = remotes.get(name)
        if remote:
            canonical = _canonical_remote(remote, cwd)
            if canonical:
                return canonical
    return None


def _resolve_project_identity(cwd: str) -> dict[str, str]:
    explicit = os.environ.get("AGENTMEMORY_PROJECT_NAME", "").strip()
    if explicit:
        return {"project_id": explicit, "project_name": explicit}
    cache_key = _canonical_project_path(cwd)
    cached = _project_identity_cache.get(cache_key)
    if cached:
        return cached
    repository = _git_repository(cwd)
    if repository:
        top, common = repository
        canonical_common = _canonical_project_path(common)
        name = (
            Path(canonical_common).parent.name
            if canonical_common.endswith("/.git")
            else PurePath(top).name
        ) or cwd
        project_id = _git_project_id_cache.get(canonical_common)
        if not project_id:
            remote = _git_remote_identity(common, cwd)
            project_id = (
                _project_hash("git", remote)
                if remote
                else _project_hash("path", canonical_common)
            )
            _git_project_id_cache[canonical_common] = project_id
        identity = {"project_id": project_id, "project_name": name}
    else:
        identity = {
            "project_id": _project_hash("path", cache_key),
            "project_name": PurePath(cache_key).name or cwd,
        }
    _project_identity_cache[cache_key] = identity
    return identity


def _resolve_project(cwd: str) -> str:
    """Stable project scope shared with hooks and other agent adapters."""
    return _resolve_project_identity(cwd)["project_id"]
import time
from typing import Any, Callable
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen
from urllib.error import URLError

try:
    from agent.memory_provider import MemoryProvider
except ImportError:
    from abc import ABC, abstractmethod

    class MemoryProvider(ABC):
        @property
        @abstractmethod
        def name(self) -> str: ...
        @abstractmethod
        def is_available(self) -> bool: ...
        @abstractmethod
        def initialize(self, session_id: str, **kwargs: Any) -> None: ...
        @abstractmethod
        def get_tool_schemas(self) -> list[dict]: ...
        @abstractmethod
        def handle_tool_call(self, name: str, args: dict) -> str: ...
        def get_config_schema(self) -> list[dict]: return []
        def save_config(self, values: dict, hermes_home: str) -> None: pass
        def system_prompt_block(self) -> str: return ""
        def prefetch(self, query: str, **kwargs: Any) -> str: return ""
        def queue_prefetch(self, query: str, **kwargs: Any) -> None: pass
        def sync_turn(self, user: str, assistant: str, **kwargs: Any) -> None: pass
        def on_session_end(self, messages: list, **kwargs: Any) -> None: pass
        def on_pre_compress(self, messages: list, **kwargs: Any) -> None: pass
        def on_memory_write(self, action: str, target: str, content: str, **kwargs: Any) -> None: pass
        def shutdown(self, **kwargs: Any) -> None: pass


DEFAULT_BASE_URL = "http://localhost:3111"
TIMEOUT = 5
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
_plaintext_bearer_warned = False

# agentmemory's documented runtime config lives at ~/.agentmemory/.env.
# When agentmemory is launched as a systemd user service (or any other
# process manager that loads that file directly), those values never
# reach an interactive shell. `hermes memory status` then reads
# os.environ in the Hermes CLI process, finds AGENTMEMORY_URL /
# AGENTMEMORY_SECRET unset, and reports the plugin as "Missing" even
# though the service is healthy and live sessions can use it (#250).
#
# Preload the file at plugin-import time using os.environ.setdefault so
# we never override anything the user explicitly set in the shell. The
# preload is best-effort and silent on any failure (file absent,
# unreadable, malformed) — the plugin falls back to its existing default
# (http://localhost:3111) and Hermes status reflects that.
def _preload_agentmemory_dotenv() -> None:
    candidates: list[Path] = []
    home = os.environ.get("HOME")
    if home:
        candidates.append(Path(home) / ".agentmemory" / ".env")
    xdg_config = os.environ.get("XDG_CONFIG_HOME")
    if xdg_config:
        candidates.append(Path(xdg_config) / "agentmemory" / ".env")
    for path in candidates:
        try:
            if not path.is_file():
                continue
            for raw in path.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key:
                    os.environ.setdefault(key, value)
        except (OSError, UnicodeDecodeError):
            continue
    # Guarantee AGENTMEMORY_URL is set so `hermes memory status` never
    # reports it as Missing when a user runs agentmemory at the default
    # localhost:3111 (or via systemd with the URL line commented out in
    # ~/.agentmemory/.env because it matches the default). #520.
    os.environ.setdefault("AGENTMEMORY_URL", DEFAULT_BASE_URL)


_preload_agentmemory_dotenv()


def _validate_url(base: str) -> bool:
    if not base:
        return False
    try:
        parsed = urlparse(base)
        # .port raises ValueError on a non-numeric or out-of-range port
        _ = parsed.port
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    return bool(parsed.hostname)


def _uses_plaintext_bearer_auth(base: str, secret: str = "") -> bool:
    if not secret:
        return False
    parsed = urlparse(base)
    return parsed.scheme == "http" and (parsed.hostname or "").lower() not in LOOPBACK_HOSTS


def _plaintext_bearer_auth_message(base: str) -> str:
    return f"agentmemory: AGENTMEMORY_SECRET is configured for plaintext HTTP to {base}. Bearer tokens and memory payloads can be observed on the network; use HTTPS or an SSH tunnel."


def _warn_plaintext_bearer_auth(message: str) -> None:
    print(message, file=sys.stderr)


def _check_plaintext_bearer_guard(
    base: str,
    secret: str = "",
    warn: Callable[[str], None] | None = None,
) -> None:
    global _plaintext_bearer_warned
    if not _uses_plaintext_bearer_auth(base, secret):
        return
    message = _plaintext_bearer_auth_message(base)
    if os.environ.get("AGENTMEMORY_REQUIRE_HTTPS") == "1":
        raise RuntimeError(message)
    if not _plaintext_bearer_warned:
        _plaintext_bearer_warned = True
        (warn or _warn_plaintext_bearer_auth)(message)


def _reset_plaintext_bearer_guard_for_tests() -> None:
    global _plaintext_bearer_warned
    _plaintext_bearer_warned = False


def _request(
    base: str,
    path: str,
    body: dict | None = None,
    method: str = "POST",
    secret: str = "",
) -> tuple[bool, dict | None]:
    if not _validate_url(base):
        return False, None
    url = f"{base}/agentmemory/{path}"
    headers = {"Content-Type": "application/json"}
    auth = secret or os.environ.get("AGENTMEMORY_SECRET", "")
    _check_plaintext_bearer_guard(base, auth)
    if auth:
        headers["Authorization"] = f"Bearer {auth}"

    data = json.dumps(body).encode() if body else None
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode()
            if not raw:
                return True, None
            try:
                return True, json.loads(raw)
            except json.JSONDecodeError:
                return True, None
    except (URLError, TimeoutError, OSError):
        return False, None


def _api(base: str, path: str, body: dict | None = None, method: str = "POST", secret: str = "") -> dict | None:
    ok, result = _request(base, path, body, method, secret)
    return result if ok else None


def _api_bg(base: str, path: str, body: dict | None = None) -> None:
    t = threading.Thread(target=_api, args=(base, path, body), daemon=True)
    t.start()


def _capture_id(session_id: str, locator: str) -> str:
    digest = hashlib.sha256(f"{session_id}\0{locator}".encode("utf-8")).hexdigest()
    return f"hermes:{digest[:32]}"


def _outbox_dir() -> Path:
    explicit = os.environ.get("AGENTMEMORY_OUTBOX_DIR", "").strip()
    if explicit:
        return Path(explicit)
    return Path.home() / ".agentmemory" / "outbox" / "hermes"


def _send_capture(base: str, path: str, body: dict, secret: str) -> bool:
    ok, _ = _request(base, path, body, secret=secret)
    return ok


class _DurableClient:
    def __init__(
        self,
        base: str,
        outbox_dir: Path | None = None,
        secret: str = "",
        sender: Callable[[str, str, dict, str], bool] | None = None,
    ) -> None:
        self._base = base
        self._outbox = outbox_dir or _outbox_dir()
        self._secret = secret
        self._sender = sender or _send_capture
        self._lock = threading.Lock()

    def _persist(self, path: str, body: dict) -> Path:
        self._outbox.mkdir(parents=True, exist_ok=True, mode=0o700)
        if isinstance(body.get("captureId"), str) and body["captureId"].strip():
            identity = {"path": path, "captureId": body["captureId"].strip()}
        elif isinstance(body.get("sessionId"), str) and body["sessionId"].strip():
            identity = {"path": path, "sessionId": body["sessionId"].strip()}
        else:
            identity = {"path": path, "body": body}
        key = hashlib.sha256(
            json.dumps(identity, sort_keys=True).encode("utf-8")
        ).hexdigest()
        target = self._outbox / f"{key}.json"
        if target.exists():
            return target
        temporary = self._outbox / f"{key}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        envelope = {
            "schemaVersion": 2,
            "path": path,
            "body": body,
            "createdAt": str(time.time_ns()),
        }
        with temporary.open("x", encoding="utf-8") as handle:
            json.dump(envelope, handle, ensure_ascii=False)
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        if target.exists():
            temporary.unlink(missing_ok=True)
            return target
        os.replace(temporary, target)
        return target

    def _deliver_envelope(self, path: Path) -> bool:
        try:
            envelope = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return False
        if not isinstance(envelope.get("path"), str) or not isinstance(envelope.get("body"), dict):
            return False
        body = envelope["body"]
        if envelope["path"] == "session/start" and "includeContext" not in body:
            body = {**body, "includeContext": False}
        if not self._sender(self._base, envelope["path"], body, self._secret):
            print(
                "agentmemory: Hermes capture remains queued after delivery failure",
                file=sys.stderr,
            )
            return False
        path.unlink(missing_ok=True)
        return True

    def _replay_unlocked(self) -> int:
        delivered = 0
        envelopes: list[tuple[str, Path, dict]] = []
        try:
            paths = list(self._outbox.glob("*.json"))
        except OSError:
            return 0
        for path in paths:
            try:
                envelope = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(envelope.get("path"), str) or not isinstance(envelope.get("body"), dict):
                    continue
                envelopes.append((str(envelope.get("createdAt", "")), path, envelope))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                continue
        envelopes.sort(key=lambda item: (item[0], item[1].name))
        for _, path, envelope in envelopes:
            body = envelope["body"]
            if (
                envelope["path"] == "session/start"
                and "includeContext" not in body
            ):
                body = {**body, "includeContext": False}
            if not self._sender(
                self._base,
                envelope["path"],
                body,
                self._secret,
            ):
                print(
                    "agentmemory: Hermes capture remains queued after delivery failure",
                    file=sys.stderr,
                )
                break
            path.unlink(missing_ok=True)
            delivered += 1
        return delivered

    def replay(self) -> int:
        with self._lock:
            return self._replay_unlocked()

    def deliver(self, path: str, body: dict) -> bool:
        with self._lock:
            target = self._persist(path, body)
            return self._deliver_envelope(target)


def _tool_arguments(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def _extract_tool_observations(
    messages: list,
    session_id: str,
    project: str,
    project_name: str,
    cwd: str,
    agent_id: str | None,
) -> list[dict]:
    calls: dict[str, dict] = {}
    results: list[dict] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        if message.get("role") == "assistant":
            for call in message.get("tool_calls") or []:
                if isinstance(call, dict) and isinstance(call.get("id"), str):
                    calls[call["id"]] = call
        elif message.get("role") == "tool" and isinstance(message.get("tool_call_id"), str):
            results.append(message)

    observations: list[dict] = []
    for result in results[-10:]:
        call_id = result["tool_call_id"]
        call = calls.get(call_id, {})
        function = call.get("function") if isinstance(call.get("function"), dict) else {}
        tool_name = function.get("name") or call.get("name") or result.get("name") or "unknown"
        body = {
            "captureId": _capture_id(session_id, call_id),
            "hookType": "post_tool_failure" if result.get("is_error") is True else "post_tool_use",
            "sourceClient": "hermes",
            "sessionId": session_id,
            "project": project,
            "projectName": project_name,
            "cwd": cwd,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "data": {
                "tool_name": tool_name,
                "call_id": call_id,
                "tool_input": _tool_arguments(function.get("arguments")),
                "tool_output": result.get("content"),
            },
        }
        if agent_id:
            body["agentId"] = agent_id
        observations.append(body)
    return observations


def _conversation_observation(
    user: str,
    assistant: str,
    session_id: str,
    project: str,
    project_name: str,
    cwd: str,
    agent_id: str | None,
    turn_id: str | None,
) -> dict:
    locator = turn_id or hashlib.sha256(
        f"{user}\0{assistant}".encode("utf-8")
    ).hexdigest()
    body = {
        "captureId": _capture_id(session_id, locator),
        "hookType": "post_tool_use",
        "sourceClient": "hermes",
        "sessionId": session_id,
        "project": project,
        "projectName": project_name,
        "cwd": cwd,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "data": {
            "tool_name": "conversation",
            "tool_input": user,
            "tool_output": assistant,
        },
    }
    if agent_id:
        body["agentId"] = agent_id
    return body


class AgentMemoryProvider(MemoryProvider):

    @property
    def name(self) -> str:
        return "agentmemory"

    def is_available(self) -> bool:
        # Hermes contract: no network calls in is_available.
        base = os.environ.get("AGENTMEMORY_URL", DEFAULT_BASE_URL)
        return _validate_url(base)

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._base = os.environ.get("AGENTMEMORY_URL", DEFAULT_BASE_URL)
        self._session_id = session_id.strip() if isinstance(session_id, str) else ""
        self._cwd = kwargs.get("cwd", os.getcwd())
        identity = _resolve_project_identity(self._cwd)
        self._project = identity["project_id"]
        self._project_name = identity["project_name"]
        raw_agent_id = kwargs.get("agent_id") or kwargs.get("agentId")
        self._agent_id = raw_agent_id.strip() if isinstance(raw_agent_id, str) and raw_agent_id.strip() else None
        self._delivery = _DurableClient(
            self._base,
            secret=os.environ.get("AGENTMEMORY_SECRET", ""),
        )
        if os.environ.get("AGENTMEMORY_REQUIRE_HTTPS") == "1":
            _check_plaintext_bearer_guard(self._base, os.environ.get("AGENTMEMORY_SECRET", ""))

        if not self._session_id:
            print(
                "agentmemory: Hermes initialize has no session identity; capture disabled",
                file=sys.stderr,
            )
            return
        self._delivery.deliver("session/start", {
            "sessionId": self._session_id,
            "project": self._project,
            "projectName": self._project_name,
            "cwd": self._cwd,
            **({"agentId": self._agent_id} if self._agent_id else {}),
            "sourceClient": "hermes",
            "includeContext": False,
        })

    def get_config_schema(self) -> list[dict]:
        return [
            {
                "key": "url",
                "description": "agentmemory server URL",
                "default": DEFAULT_BASE_URL,
                "env_var": "AGENTMEMORY_URL",
            },
            {
                "key": "secret",
                "description": "agentmemory auth secret (optional)",
                "secret": True,
                "required": False,
                "env_var": "AGENTMEMORY_SECRET",
            },
        ]

    def save_config(self, values: dict, hermes_home: str) -> None:
        config_path = Path(hermes_home) / "agentmemory.json"
        config_path.write_text(json.dumps(values, indent=2))

    def system_prompt_block(self) -> str:
        result = _api(self._base, "context", {
            "sessionId": self._session_id,
            "project": self._project,
            **({"agentId": self._agent_id} if self._agent_id else {}),
        })
        if result and result.get("context"):
            return result["context"]
        return ""

    def prefetch(self, query: str, **kwargs: Any) -> str:
        result = _api(self._base, "smart-search", {
            "query": query,
            "limit": 5,
            "project": self._project,
            **({"agentId": self._agent_id} if self._agent_id else {}),
        })
        if not result or not result.get("results"):
            return ""

        lines = []
        for r in result["results"][:5]:
            obs = r.get("observation", r)
            title = obs.get("title", "")
            narrative = obs.get("narrative", "")
            if title:
                lines.append(f"- {title}: {narrative[:200]}")
        return "\n".join(lines) if lines else ""

    def queue_prefetch(self, query: str, **kwargs: Any) -> None:
        _api_bg(self._base, "smart-search", {
            "query": query,
            "limit": 3,
            "project": self._project,
            **({"agentId": self._agent_id} if self._agent_id else {}),
        })

    def get_tool_schemas(self) -> list[dict]:
        return [
            {
                "name": "memory_recall",
                "description": "Search agentmemory for past observations by keyword",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search query"},
                        "limit": {"type": "integer", "description": "Max results", "default": 10},
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "memory_save",
                "description": "Save an insight, decision, or pattern to long-term memory",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string", "description": "What to remember"},
                        "type": {
                            "type": "string",
                            "enum": ["pattern", "preference", "architecture", "bug", "workflow", "fact"],
                            "description": "Memory type",
                        },
                    },
                    "required": ["content"],
                },
            },
            {
                "name": "memory_search",
                "description": "Hybrid semantic + keyword search across all memories",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "limit": {"type": "integer", "default": 5},
                    },
                    "required": ["query"],
                },
            },
        ]

    def handle_tool_call(self, name: str, args: dict) -> str:
        # Hermes stores the return value as the tool result `content` in the
        # session history. Anthropic-protocol providers reject non-string
        # content with a 400 on the next request, so always serialize to a
        # JSON string here — matches what agentmemory's main MCP server does
        # in src/mcp/standalone.ts (`{ type: "text", text: JSON.stringify(...) }`).
        if name == "memory_recall":
            result = _api(self._base, "search", {
                "query": args["query"],
                "limit": args.get("limit", 10),
                "project": self._project,
                **({"agentId": self._agent_id} if self._agent_id else {}),
            })
            if not result:
                return json.dumps({"results": []})
            items = []
            for r in result.get("results", []):
                obs = r.get("observation", r)
                items.append({
                    "title": obs.get("title", ""),
                    "type": obs.get("type", ""),
                    "narrative": obs.get("narrative", ""),
                    "importance": obs.get("importance", 0),
                    "timestamp": obs.get("timestamp", ""),
                })
            return json.dumps({"results": items})

        if name == "memory_save":
            result = _api(self._base, "remember", {
                "content": args["content"],
                "type": args.get("type", "fact"),
                "project": self._project,
                "projectName": self._project_name,
                **({"agentId": self._agent_id} if self._agent_id else {}),
            })
            return json.dumps(result or {"success": False})

        if name == "memory_search":
            result = _api(self._base, "smart-search", {
                "query": args["query"],
                "limit": args.get("limit", 5),
                "project": self._project,
                **({"agentId": self._agent_id} if self._agent_id else {}),
            })
            if not result:
                return json.dumps({"results": []})
            items = []
            for r in result.get("results", []):
                obs = r.get("observation", r)
                items.append({
                    "title": obs.get("title", ""),
                    "narrative": obs.get("narrative", "")[:300],
                    "score": r.get("combinedScore", r.get("score", 0)),
                })
            return json.dumps({"results": items})

        return json.dumps({"error": f"Unknown tool: {name}"})

    def sync_turn(self, user: str, assistant: str, **kwargs: Any) -> None:
        session_id = kwargs.get("session_id", self._session_id)
        if not isinstance(session_id, str) or not session_id.strip():
            print(
                "agentmemory: Hermes sync_turn has no session identity; capture skipped",
                file=sys.stderr,
            )
            return
        session_id = session_id.strip()
        agent_id = kwargs.get("agent_id") or kwargs.get("agentId") or self._agent_id
        if not isinstance(agent_id, str) or not agent_id.strip():
            agent_id = None
        else:
            agent_id = agent_id.strip()
        messages = kwargs.get("turn_messages") or kwargs.get("messages") or []
        observations = _extract_tool_observations(
            messages if isinstance(messages, list) else [],
            session_id,
            self._project,
            self._project_name,
            self._cwd,
            agent_id,
        )
        if not observations and (user or assistant):
            turn_id = kwargs.get("turn_id") or kwargs.get("message_id")
            observations = [
                _conversation_observation(
                    user,
                    assistant,
                    session_id,
                    self._project,
                    self._project_name,
                    self._cwd,
                    agent_id,
                    turn_id if isinstance(turn_id, str) and turn_id else None,
                )
            ]
        for observation in observations:
            self._delivery.deliver("observe", observation)
        if observations:
            self._delivery.deliver("session/checkpoint", {"sessionId": session_id})

    def on_session_end(self, messages: list, **kwargs: Any) -> None:
        session_id = kwargs.get("session_id", self._session_id)
        if isinstance(session_id, str) and session_id.strip():
            self._delivery.deliver("session/end", {
                "sessionId": session_id.strip(),
            })

    def on_pre_compress(self, messages: list, **kwargs: Any) -> None:
        result = _api(self._base, "context", {
            "sessionId": kwargs.get("session_id", self._session_id),
            "project": self._project,
            **({"agentId": self._agent_id} if self._agent_id else {}),
        })
        if result and result.get("context"):
            messages.insert(0, {
                "role": "user",
                "content": f"[agentmemory context before compaction]\n{result['context']}",
            })

    def on_memory_write(self, action: str, target: str, content: str, **kwargs: Any) -> None:
        if action in ("add", "update") and content:
            _api_bg(self._base, "remember", {
                "content": content,
                "type": "fact",
                "project": self._project,
                "projectName": self._project_name,
                **({"agentId": self._agent_id} if self._agent_id else {}),
            })

    def shutdown(self, **kwargs: Any) -> None:
        if hasattr(self, "_delivery"):
            self._delivery.replay()


def register(ctx: Any) -> None:
    ctx.register_memory_provider(AgentMemoryProvider())
