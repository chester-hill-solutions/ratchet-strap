import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";

type OperationName = "ratchet.apply" | "ratchet.verify" | "ratchet.reference"
  | "ratchet.commit" | "ratchet.checker" | "ratchet.snapshot";

/** Observe synchronous local tooling without letting telemetry repeat an effect. */
export function observeOperation<T>(name: OperationName, work: () => T): T {
  let outcome: { value: T } | { error: unknown } | undefined;
  const run = (span?: Span): T => {
    try {
      if (!outcome) {
        try { outcome = { value: work() }; }
        catch (error) { outcome = { error }; }
      }
      try {
        span?.setStatus({ code: "error" in outcome ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      } catch { /* telemetry cannot change the operation outcome */ }
      if ("error" in outcome) throw outcome.error;
      return outcome.value;
    } finally {
      try { span?.end(); } catch { /* preserve the operation outcome */ }
    }
  };
  try {
    trace.getTracer("ratchet-strap").startActiveSpan(name, run);
  } catch { /* use the captured outcome, including the original operation error */ }
  if (!outcome) return run();
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
