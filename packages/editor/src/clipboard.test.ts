// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { normalizePastedHtml } from "./clipboard.js";
describe("Word cleanup", () =>
  it("removes office styles", () => {
    const html = normalizePastedHtml(
      '<p class="MsoNormal" style="mso-bidi-font-weight:bold" onclick="x()">Hello</p>',
    );
    expect(html).not.toContain("mso-");
    expect(html).not.toContain("onclick");
  }));
