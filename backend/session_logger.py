import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from queue import Empty, Queue


class SessionLogger:
    def __init__(self, log_path: Path):
        self.log_path = log_path
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self.session_id = str(uuid.uuid4())
        self._entries = []
        self._entries_lock = threading.Lock()
        self._queue: Queue = Queue()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._writer_loop, daemon=True)
        self._write_entries([])
        self._thread.start()

    def log(self, event_type: str, data: dict | None = None):
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": event_type,
            "data": data or {},
            "session_id": self.session_id,
        }
        self._queue.put_nowait(entry)

    def get_entries(self):
        with self._entries_lock:
            return list(self._entries)

    def close(self):
        self._stop.set()
        self._thread.join(timeout=1.0)

    def _writer_loop(self):
        while not self._stop.is_set():
            try:
                entry = self._queue.get(timeout=0.2)
            except Empty:
                continue

            with self._entries_lock:
                self._entries.append(entry)
                snapshot = list(self._entries)

            self._write_entries(snapshot)
            self._queue.task_done()

    def _write_entries(self, entries):
        payload = {
            "session_id": self.session_id,
            "entries": entries,
        }
        self.log_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")