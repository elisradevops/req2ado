def test_the_suite_does_not_point_the_app_at_a_real_redis() -> None:
    # Importing the app opens its Redis clients from settings. With the default (localhost:6379) a test run on a developer machine
    # writes its fake jobs' narration into the Redis the running dev stack uses, and the orchestrator then logs a foreign-key error
    # for each of them at every restart.
    from app.config import settings

    assert settings.redis_url.startswith("redis://127.0.0.1:1"), settings.redis_url
