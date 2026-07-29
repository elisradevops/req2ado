from __future__ import annotations

import json

import redis.asyncio as redis


class RedisChatPublisher:
    """Publishes chat-turn events to Redis for orchestrator's ChatGateway to
    relay over WebSocket, and checks/clears the per-turn abort flag a user's
    'stop generating' action sets. Channel: chat:{job_id}:{local_id}. Abort
    key: chat:abort:{job_id}:{local_id} (set by orchestrator's ChatService,
    short TTL, cleared here on read so a stale flag can't abort a future
    turn on the same item)."""

    def __init__(self, redis_url: str) -> None:
        self._redis = redis.from_url(redis_url)

    def _channel(self, job_id: str, local_id: str) -> str:
        return f"chat:{job_id}:{local_id}"

    async def publish_chunk(self, job_id: str, local_id: str, delta: str) -> None:
        await self._redis.publish(self._channel(job_id, local_id), json.dumps({"type": "chunk", "delta": delta}))

    async def publish_reasoning_chunk(self, job_id: str, local_id: str, delta: str) -> None:
        await self._redis.publish(self._channel(job_id, local_id), json.dumps({"type": "reasoning_chunk", "delta": delta}))

    async def publish_done(
        self,
        job_id: str,
        local_id: str,
        message: str,
        proposed_title: str | None,
        proposed_description: str | None,
        model: str,
    ) -> None:
        payload = {
            "type": "done",
            "message": message,
            "proposedTitle": proposed_title,
            "proposedDescription": proposed_description,
            "model": model,
        }
        await self._redis.publish(self._channel(job_id, local_id), json.dumps(payload))

    async def publish_error(self, job_id: str, local_id: str, reason: str) -> None:
        await self._redis.publish(self._channel(job_id, local_id), json.dumps({"type": "error", "reason": reason}))

    async def is_aborted(self, job_id: str, local_id: str) -> bool:
        key = f"chat:abort:{job_id}:{local_id}"
        value = await self._redis.get(key)
        if value:
            await self._redis.delete(key)
            return True
        return False
