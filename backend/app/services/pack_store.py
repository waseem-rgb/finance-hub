from __future__ import annotations

import json
from dataclasses import asdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional
from uuid import uuid4


@dataclass
class Pack:
    upload_id: str
    filename: str
    uploaded_at: str
    entity: Optional[str] = None
    sheets: list[str] = field(default_factory=list)
    periods: list[str] = field(default_factory=list)
    normalized_facts: list[dict] = field(default_factory=list)
    computed_metrics: Dict[str, Any] = field(default_factory=dict)
    sources: Dict[str, Any] = field(default_factory=dict)


class PackStore:
    def __init__(self) -> None:
        self._packs: Dict[str, Pack] = {}
        self._latest_id: Optional[str] = None
        self._storage_path = Path(__file__).resolve().parents[2] / "data" / "pack_store.json"
        self._load_from_disk()

    def _persist(self) -> None:
        self._storage_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "latest_id": self._latest_id,
            "packs": {upload_id: asdict(pack) for upload_id, pack in self._packs.items()},
        }
        self._storage_path.write_text(json.dumps(payload), encoding="utf-8")

    def _load_from_disk(self) -> None:
        if not self._storage_path.exists():
            return
        try:
            payload = json.loads(self._storage_path.read_text(encoding="utf-8"))
            packs_raw = payload.get("packs", {})
            packs: Dict[str, Pack] = {}
            for upload_id, pack_raw in packs_raw.items():
                if not isinstance(pack_raw, dict):
                    continue
                packs[upload_id] = Pack(
                    upload_id=pack_raw.get("upload_id", upload_id),
                    filename=pack_raw.get("filename", ""),
                    uploaded_at=pack_raw.get("uploaded_at", ""),
                    entity=pack_raw.get("entity"),
                    sheets=pack_raw.get("sheets", []) or [],
                    periods=pack_raw.get("periods", []) or [],
                    normalized_facts=pack_raw.get("normalized_facts", []) or [],
                    computed_metrics=pack_raw.get("computed_metrics", {}) or {},
                    sources=pack_raw.get("sources", {}) or {},
                )
            self._packs = packs
            latest_id = payload.get("latest_id")
            self._latest_id = latest_id if latest_id in self._packs else None
            if not self._latest_id and self._packs:
                # Keep the most recent pack if metadata is missing/corrupt.
                self._latest_id = max(
                    self._packs.values(),
                    key=lambda p: p.uploaded_at or "",
                ).upload_id
        except Exception:
            # Corrupt store should not crash the API; start clean in-memory.
            self._packs = {}
            self._latest_id = None

    def save_pack(self, parsed: dict, normalized: dict) -> str:
        upload_id = str(uuid4())
        uploaded_at = datetime.now(timezone.utc).isoformat()
        pack = Pack(
            upload_id=upload_id,
            filename=parsed.get("filename", ""),
            entity=parsed.get("entity"),
            uploaded_at=uploaded_at,
            sheets=parsed.get("sheets", []),
            periods=normalized.get("periods", []),
            normalized_facts=normalized.get("facts", []),
        )
        self._packs[upload_id] = pack
        self._latest_id = upload_id
        self._persist()
        return upload_id

    def get_latest_pack(self) -> Optional[Pack]:
        if not self._latest_id:
            return None
        return self._packs.get(self._latest_id)

    def get_pack(self, upload_id: str) -> Optional[Pack]:
        return self._packs.get(upload_id)

    def clear(self) -> None:
        self._packs = {}
        self._latest_id = None
        if self._storage_path.exists():
            self._storage_path.unlink()


PACK_STORE = PackStore()
