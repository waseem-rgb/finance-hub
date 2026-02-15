from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
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


PACK_STORE = PackStore()
