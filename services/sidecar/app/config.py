"""Runtime configuration. Fail closed: without SIDECAR_TOKEN the service
refuses to serve /v1/* (see app.auth)."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://axiom:axiom@localhost:5432/axiom"
    sidecar_token: str | None = None
    app_env: str = "development"


@lru_cache
def get_settings() -> Settings:
    return Settings()
