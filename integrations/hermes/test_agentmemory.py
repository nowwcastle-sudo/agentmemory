from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


MODULE_PATH = Path(__file__).with_name("__init__.py")
SPEC = importlib.util.spec_from_file_location("agentmemory_hermes_under_test", MODULE_PATH)
assert SPEC and SPEC.loader
PLUGIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PLUGIN)


class HermesCaptureContractTests(unittest.TestCase):
    def test_project_identity_merges_worktrees_and_separates_same_basename_paths(self) -> None:
        saved = os.environ.pop("AGENTMEMORY_PROJECT_NAME", None)
        try:
            with tempfile.TemporaryDirectory(prefix="agentmemory-hermes-identity-") as directory:
                root = Path(directory)
                repo = root / "canonical"
                worktree = root / "linked"
                foreign_a = root / "foreign-a" / "same-name"
                foreign_b = root / "foreign-b" / "same-name"
                repo.mkdir()
                foreign_a.mkdir(parents=True)
                foreign_b.mkdir(parents=True)
                subprocess.run(["git", "init", "--quiet"], cwd=repo, check=True)
                subprocess.run(
                    [
                        "git",
                        "-c",
                        "user.name=AgentMemory Test",
                        "-c",
                        "user.email=agentmemory-test@example.invalid",
                        "commit",
                        "--quiet",
                        "--allow-empty",
                        "-m",
                        "fixture",
                    ],
                    cwd=repo,
                    check=True,
                )
                subprocess.run(
                    ["git", "worktree", "add", "--quiet", "--detach", str(worktree)],
                    cwd=repo,
                    check=True,
                )

                canonical_id = PLUGIN._resolve_project(str(repo))
                canonical_identity = PLUGIN._resolve_project_identity(str(repo))
                worktree_identity = PLUGIN._resolve_project_identity(str(worktree))
                self.assertRegex(canonical_id, r"^path:[0-9a-f]{32}$")
                self.assertEqual(PLUGIN._resolve_project(str(worktree)), canonical_id)
                self.assertEqual(canonical_identity["project_name"], "canonical")
                self.assertEqual(worktree_identity["project_name"], "canonical")
                self.assertNotEqual(
                    PLUGIN._resolve_project(str(foreign_a)),
                    PLUGIN._resolve_project(str(foreign_b)),
                )
        finally:
            if saved is not None:
                os.environ["AGENTMEMORY_PROJECT_NAME"] = saved

    def test_pairs_tool_calls_with_results_and_preserves_structured_input(self) -> None:
        messages = [
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": "call-1",
                        "function": {
                            "name": "read_file",
                            "arguments": json.dumps({"path": "src/graph.ts"}),
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call-1",
                "content": {"ok": True, "lines": 12},
            },
        ]

        observations = PLUGIN._extract_tool_observations(
            messages,
            session_id="hermes-session-1",
            project="shared-project",
            project_name="Shared Project",
            cwd="/work/shared-project",
            agent_id="researcher",
        )

        self.assertEqual(len(observations), 1)
        body = observations[0]
        self.assertEqual(body["captureId"], PLUGIN._capture_id("hermes-session-1", "call-1"))
        self.assertEqual(body["agentId"], "researcher")
        self.assertEqual(body["sourceClient"], "hermes")
        self.assertEqual(body["projectName"], "Shared Project")
        self.assertEqual(body["data"]["tool_name"], "read_file")
        self.assertEqual(body["data"]["tool_input"], {"path": "src/graph.ts"})
        self.assertEqual(body["data"]["tool_output"], {"ok": True, "lines": 12})

    def test_keeps_only_the_ten_newest_tool_results(self) -> None:
        calls = [
            {
                "id": f"call-{index}",
                "function": {"name": "tool", "arguments": json.dumps({"index": index})},
            }
            for index in range(12)
        ]
        messages = [{"role": "assistant", "tool_calls": calls}]
        messages.extend(
            {"role": "tool", "tool_call_id": f"call-{index}", "content": str(index)}
            for index in range(12)
        )

        observations = PLUGIN._extract_tool_observations(
            messages,
            session_id="hermes-session-2",
            project="project",
            project_name="Project",
            cwd="/work/project",
            agent_id=None,
        )

        self.assertEqual(len(observations), 10)
        self.assertEqual(observations[0]["data"]["call_id"], "call-2")
        self.assertEqual(observations[-1]["data"]["call_id"], "call-11")

    def test_spools_failed_capture_without_secret_then_replays_oldest_first(self) -> None:
        attempts: list[str] = []
        healthy = False

        def sender(_base: str, path: str, body: dict, _secret: str) -> bool:
            attempts.append(body["captureId"])
            return healthy

        with tempfile.TemporaryDirectory(prefix="agentmemory-hermes-") as directory:
            client = PLUGIN._DurableClient(
                base="http://localhost:3111",
                outbox_dir=Path(directory),
                secret="must-not-be-written",
                sender=sender,
            )
            first = {"captureId": "hermes:first", "data": {"text": "one"}}
            second = {"captureId": "hermes:second", "data": {"text": "two"}}

            self.assertFalse(client.deliver("observe", first))
            self.assertFalse(client.deliver("observe", second))
            pending = sorted(Path(directory).glob("*.json"))
            self.assertEqual(len(pending), 2)
            stored = "\n".join(path.read_text(encoding="utf-8") for path in pending)
            self.assertNotIn("must-not-be-written", stored)

            healthy = True
            self.assertEqual(client.replay(), 2)
            self.assertEqual(list(Path(directory).glob("*.json")), [])
            self.assertEqual(attempts[-2:], ["hermes:first", "hermes:second"])

    def test_legacy_session_start_is_upgraded_only_while_replaying(self) -> None:
        healthy = False
        delivered: list[tuple[str, dict]] = []

        def sender(_base: str, path: str, body: dict, _secret: str) -> bool:
            if not healthy:
                return False
            if path == "session/start" and body.get("includeContext") is not False:
                return False
            delivered.append((path, body))
            return True

        with tempfile.TemporaryDirectory(prefix="agentmemory-hermes-legacy-") as directory:
            client = PLUGIN._DurableClient(
                base="http://localhost:3111",
                outbox_dir=Path(directory),
                sender=sender,
            )
            self.assertFalse(client.deliver("session/start", {
                "sessionId": "hermes-legacy-session",
                "project": "agentmemory",
                "cwd": "/work/agentmemory",
            }))
            self.assertFalse(client.deliver("session/end", {
                "sessionId": "hermes-legacy-session",
            }))

            pending = sorted(Path(directory).glob("*.json"))
            self.assertEqual(len(pending), 2)
            start_envelope = next(
                json.loads(path.read_text(encoding="utf-8"))
                for path in pending
                if json.loads(path.read_text(encoding="utf-8"))["path"] == "session/start"
            )
            self.assertNotIn("includeContext", start_envelope["body"])

            healthy = True
            self.assertEqual(client.replay(), 2)
            self.assertEqual([path for path, _body in delivered], [
                "session/start",
                "session/end",
            ])
            self.assertIs(delivered[0][1]["includeContext"], False)
            self.assertEqual(list(Path(directory).glob("*.json")), [])

    def test_current_capture_does_not_wait_behind_an_older_failure(self) -> None:
        delivered: list[str] = []

        def sender(_base: str, _path: str, body: dict, _secret: str) -> bool:
            if body["captureId"] == "hermes:old":
                return False
            delivered.append(body["captureId"])
            return True

        with tempfile.TemporaryDirectory(prefix="agentmemory-hermes-current-") as directory:
            client = PLUGIN._DurableClient(
                base="http://localhost:3111",
                outbox_dir=Path(directory),
                sender=sender,
            )

            self.assertFalse(client.deliver("observe", {
                "captureId": "hermes:old",
                "sessionId": "hermes-session-old",
            }))
            self.assertTrue(client.deliver("observe", {
                "captureId": "hermes:current",
                "sessionId": "hermes-session-current",
            }))

            self.assertEqual(delivered, ["hermes:current"])
            pending = list(Path(directory).glob("*.json"))
            self.assertEqual(len(pending), 1)
            stored = json.loads(pending[0].read_text(encoding="utf-8"))
            self.assertEqual(stored["schemaVersion"], 2)
            self.assertEqual(stored["body"]["captureId"], "hermes:old")

    def test_initialize_registers_without_requesting_context(self) -> None:
        delivery = Mock()
        provider = PLUGIN.AgentMemoryProvider()

        with (
            patch.object(PLUGIN, "_DurableClient", return_value=delivery),
            patch.object(
                PLUGIN,
                "_resolve_project_identity",
                return_value={"project_id": "project-id", "project_name": "Project"},
            ),
        ):
            provider.initialize(
                "hermes-initialize-session",
                cwd="/work/project",
                agent_id="researcher",
            )

        delivery.deliver.assert_called_once_with("session/start", {
            "sessionId": "hermes-initialize-session",
            "project": "project-id",
            "projectName": "Project",
            "cwd": "/work/project",
            "agentId": "researcher",
            "sourceClient": "hermes",
            "includeContext": False,
        })

    def test_conversation_fallback_is_untruncated_and_stable(self) -> None:
        user = "u" * 800
        assistant = "a" * 3000
        body = PLUGIN._conversation_observation(
            user=user,
            assistant=assistant,
            session_id="hermes-session-3",
            project="project",
            project_name="Project",
            cwd="/work/project",
            agent_id=None,
            turn_id="turn-9",
        )

        self.assertEqual(body["data"]["tool_input"], user)
        self.assertEqual(body["data"]["tool_output"], assistant)
        self.assertEqual(
            body["captureId"],
            PLUGIN._capture_id("hermes-session-3", "turn-9"),
        )
        self.assertEqual(body["projectName"], "Project")
        self.assertEqual(body["sourceClient"], "hermes")

    def test_explicit_recall_and_save_use_the_same_project_scope_as_capture(self) -> None:
        provider = PLUGIN.AgentMemoryProvider()
        provider._base = "http://localhost:3111"
        provider._project = "git:0123456789abcdef0123456789abcdef"
        provider._project_name = "agentmemory"
        provider._agent_id = "researcher"
        calls: list[tuple[str, dict]] = []

        def fake_api(_base: str, path: str, body: dict, **_kwargs: object) -> dict:
            calls.append((path, body))
            return {"success": True, "results": []}

        with patch.object(PLUGIN, "_api", side_effect=fake_api):
            provider.handle_tool_call("memory_recall", {"query": "graph", "limit": 3})
            provider.handle_tool_call("memory_save", {"content": "graph fix", "type": "bug"})

        self.assertEqual(calls[0][0], "search")
        self.assertEqual(calls[0][1]["project"], provider._project)
        self.assertEqual(calls[0][1]["agentId"], "researcher")
        self.assertEqual(calls[1][0], "remember")
        self.assertEqual(calls[1][1]["project"], provider._project)
        self.assertEqual(calls[1][1]["projectName"], "agentmemory")
        self.assertEqual(calls[1][1]["agentId"], "researcher")


if __name__ == "__main__":
    unittest.main()
