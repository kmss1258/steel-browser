import { describe, expect, it } from "vitest";

import { isRetryableCastCaptureError } from "./casting.handler.js";

describe("isRetryableCastCaptureError", () => {
  it("treats navigation-churn target/session errors as retryable", () => {
    expect(isRetryableCastCaptureError("Target closed")) .toBe(true);
    expect(isRetryableCastCaptureError("Session closed. Most likely the page has been closed.")) .toBe(true);
    expect(isRetryableCastCaptureError("Execution context was destroyed, most likely because of a navigation.")) .toBe(true);
    expect(isRetryableCastCaptureError("Frame was detached")) .toBe(true);
  });

  it("does not treat unrelated failures as retryable", () => {
    expect(isRetryableCastCaptureError("Screenshot payload was empty.")) .toBe(false);
    expect(isRetryableCastCaptureError("Protocol error: invalid parameters")) .toBe(false);
  });
});
