"""Server-to-server auth. The browser never reaches this service; the Next
app calls it with a shared bearer secret (same pattern as CRON_SECRET on the
internal cron route). Fail closed when unconfigured."""

from fastapi import Header, HTTPException, Request, status


async def require_token(request: Request, authorization: str | None = Header(default=None)) -> None:
    token = request.app.state.settings.sidecar_token
    if not token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="sidecar not configured: SIDECAR_TOKEN is unset",
        )
    if authorization != f"Bearer {token}":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid bearer token"
        )
