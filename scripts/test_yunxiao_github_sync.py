from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("yunxiao_github_sync.py")
SPEC = importlib.util.spec_from_file_location("yunxiao_github_sync", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class YunxiaoSyncTests(unittest.TestCase):
    def test_source_key_includes_repository(self) -> None:
        item = {"number": 42, "title": "Fix scheduler"}
        self.assertEqual(
            MODULE.build_source_key("issue", item, "MemTensor/memmy-agent"),
            "[GitHub MemTensor/memmy-agent Issue #42]",
        )

    def test_title_includes_source_key(self) -> None:
        item = {"number": 42, "title": "Fix scheduler"}
        self.assertEqual(
            MODULE.build_title("issue", item, "MemTensor/memmy-agent"),
            "[GitHub MemTensor/memmy-agent Issue #42] Fix scheduler",
        )

    def test_source_status(self) -> None:
        self.assertEqual(MODULE.source_status("issue", {"state": "open"}), "待处理")
        self.assertEqual(
            MODULE.source_status("pr", {"state": "closed", "merged": True}),
            "已完成",
        )
        self.assertEqual(
            MODULE.source_status("issue", {"state": "closed"}),
            "已取消",
        )

    def test_create_payload_contains_parent(self) -> None:
        calls = []

        def transport(method, path, body=None):
            calls.append((method, path, body))
            if "search" in path:
                return {"data": {"workitems": []}}
            return {"id": "new-id"}

        cfg = {
            "project_id": "project",
            "workitem_category": "Req",
            "type_id": "type",
            "assignee_id": "assignee",
            "priority_id": "priority",
            "parent_id": "directory",
            "statuses": {"待处理": "pending", "已取消": "cancelled"},
        }
        item = {
            "number": 1,
            "title": "Test",
            "html_url": "https://github.com/MemTensor/memmy-agent/issues/1",
            "body": "Details",
            "created_at": "2026-09-10T00:00:00Z",
            "state": "open",
            "labels": [],
        }
        result = MODULE.sync_one(
            "org",
            cfg,
            "issue",
            item,
            repository="MemTensor/memmy-agent",
            apply=True,
            label_ids={},
            days_to_finish=7,
            create_closed=False,
            client=MODULE.YunxiaoClient(transport),
        )
        self.assertEqual(result, "created")
        self.assertEqual(calls[2][2]["parentId"], "directory")
        self.assertIn("Details", calls[2][2]["description"])

    def test_reopened_item_updates_to_pending(self) -> None:
        calls = []

        def transport(method, path, body=None):
            calls.append((method, path, body))
            if "search" in path:
                return {"data": {"workitems": [{"id": "existing"}]}}
            return {}

        cfg = {
            "project_id": "project",
            "workitem_category": "Req",
            "type_id": "type",
            "assignee_id": "assignee",
            "priority_id": "priority",
            "parent_id": "",
            "statuses": {"待处理": "pending", "已取消": "cancelled"},
        }
        result = MODULE.sync_one(
            "org",
            cfg,
            "issue",
            {
                "number": 2,
                "title": "Reopen",
                "html_url": "https://github.com/MemTensor/memmy-agent/issues/2",
                "created_at": "2026-09-10T00:00:00Z",
                "state": "open",
                "labels": [],
            },
            repository="MemTensor/memmy-agent",
            apply=True,
            label_ids={},
            days_to_finish=7,
            create_closed=False,
            client=MODULE.YunxiaoClient(transport),
        )
        self.assertEqual(result, "updated-status")
        self.assertEqual(calls[-1][2], {"status": "pending"})

    def test_all_state_backfill_can_create_closed_item(self) -> None:
        calls = []

        def transport(method, path, body=None):
            calls.append((method, path, body))
            if "search" in path:
                return {"data": {"workitems": []}}
            return {"id": "new-id"}

        cfg = {
            "project_id": "project",
            "workitem_category": "Req",
            "type_id": "type",
            "assignee_id": "assignee",
            "priority_id": "priority",
            "parent_id": "",
            "statuses": {"待处理": "pending", "已取消": "cancelled"},
        }
        result = MODULE.sync_one(
            "org",
            cfg,
            "issue",
            {
                "number": 3,
                "title": "Closed before rollout",
                "html_url": "https://github.com/MemTensor/memmy-agent/issues/3",
                "created_at": "2026-09-10T00:00:00Z",
                "state": "closed",
                "labels": [],
            },
            repository="MemTensor/memmy-agent",
            apply=True,
            label_ids={},
            days_to_finish=7,
            create_closed=True,
            client=MODULE.YunxiaoClient(transport),
        )
        self.assertEqual(result, "created")
        self.assertEqual(calls[-1][2]["status"], "cancelled")


if __name__ == "__main__":
    unittest.main()
