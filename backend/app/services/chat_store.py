from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Optional
from uuid import uuid4


@dataclass
class ChatSession:
    session_id: str
    created_at: str
    memory: Dict[str, Any] = field(default_factory=dict)
    messages: list[dict] = field(default_factory=list)


class ChatStore:
    def __init__(self) -> None:
        self._sessions: Dict[str, ChatSession] = {}

    def create_session(self) -> ChatSession:
        session_id = str(uuid4())
        session = ChatSession(
            session_id=session_id,
            created_at=datetime.now(timezone.utc).isoformat(),
            memory={},
            messages=[],
        )
        self._sessions[session_id] = session
        return session

    def get_session(self, session_id: str) -> Optional[ChatSession]:
        return self._sessions.get(session_id)

    def add_message(self, session_id: str, role: str, content: str) -> None:
        session = self._sessions.get(session_id)
        if not session:
            return
        session.messages.append({"role": role, "content": content})

    def clear(self) -> None:
        self._sessions = {}


CHAT_STORE = ChatStore()
