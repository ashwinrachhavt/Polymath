"use client";

/*
 * Replaces the root layout when it crashes, so no provider, theme, font, or
 * stylesheet is guaranteed to be mounted. Everything here is inline for that
 * reason: the app stylesheet cannot be assumed to have loaded.
 *
 * The copy never asserts what was or was not saved. A render failure says
 * nothing about whether an earlier write committed, so it tells the person to
 * reload and check instead.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          background: "#ffffff",
          color: "#111111",
          fontFamily:
            "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        }}
      >
        <main style={{ maxWidth: "32rem" }}>
          <h1 style={{ margin: 0, fontSize: "18px", fontWeight: 500 }}>
            Polymath could not start
          </h1>
          <p style={{ margin: "12px 0 0", fontSize: "13px", lineHeight: 1.6 }}>
            Something failed before the app could render. Any change you already
            submitted may still have gone through; reload and check before
            submitting it again.
          </p>
          <div
            style={{
              marginTop: "16px",
              display: "flex",
              alignItems: "center",
              gap: "12px",
            }}
          >
            <button
              type="button"
              onClick={reset}
              style={{
                fontSize: "13px",
                padding: "6px 12px",
                borderRadius: "6px",
                border: "1px solid #cccccc",
                background: "#ffffff",
                color: "inherit",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                fontSize: "13px",
                padding: "6px 12px",
                borderRadius: "6px",
                border: "1px solid #cccccc",
                background: "#ffffff",
                color: "inherit",
                cursor: "pointer",
              }}
            >
              Reload
            </button>
            {error.digest ? (
              <span
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  fontSize: "12px",
                }}
              >
                {error.digest}
              </span>
            ) : null}
          </div>
        </main>
      </body>
    </html>
  );
}
