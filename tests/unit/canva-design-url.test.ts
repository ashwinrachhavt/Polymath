import { describe, expect, it } from "vitest";
import { safeCanvaDesignUrl } from "@/domains/integrations/canva/import";

/*
 * The review card's design link renders only a URL the provider itself
 * returned, verbatim. https alone is not provider identity: lookalike hosts,
 * embedded credentials, and script-bearing schemes all drop the link. The
 * provider's own answer is preserved untouched - never assembled, never
 * "corrected".
 */
describe("safeCanvaDesignUrl", () => {
  it("preserves the provider-returned canva.com URL verbatim", () => {
    const url = "https://www.canva.com/design/DAFabc123/edit?utm_source=polymath";
    expect(safeCanvaDesignUrl(url)).toBe(url);
    expect(safeCanvaDesignUrl("https://canva.com/design/DAFabc123")).toBe("https://canva.com/design/DAFabc123");
  });

  it("drops lookalike hosts", () => {
    expect(safeCanvaDesignUrl("https://canva.com.evil.example/design/x")).toBeNull();
    expect(safeCanvaDesignUrl("https://notcanva.com/design/x")).toBeNull();
    expect(safeCanvaDesignUrl("https://canvacom/design/x")).toBeNull();
  });

  it("drops credential-bearing and non-https URLs", () => {
    expect(safeCanvaDesignUrl("https://user:pw@www.canva.com/design/x")).toBeNull();
    expect(safeCanvaDesignUrl("http://www.canva.com/design/x")).toBeNull();
    expect(safeCanvaDesignUrl("javascript:alert(1)")).toBeNull();
    expect(safeCanvaDesignUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("drops non-strings, empties, and junk", () => {
    expect(safeCanvaDesignUrl(null)).toBeNull();
    expect(safeCanvaDesignUrl(undefined)).toBeNull();
    expect(safeCanvaDesignUrl(42)).toBeNull();
    expect(safeCanvaDesignUrl("")).toBeNull();
    expect(safeCanvaDesignUrl("not a url")).toBeNull();
  });
});
