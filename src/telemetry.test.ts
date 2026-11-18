import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SpanStatusCode, context, propagation, trace, type Tracer } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { observeOperation } from "./telemetry.js";

afterEach(() => { trace.disable(); context.disable(); propagation.disable(); });

describe("local operation telemetry", () => {
  test("records success and original failure under the active caller without attributes", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();
    const failure = new Error("private file details");
    try {
      trace.getTracer("test").startActiveSpan("caller", parent => {
        expect(observeOperation("ratchet.apply", () => 42)).toBe(42);
        try { observeOperation("ratchet.verify", () => { throw failure; }); }
        catch (error) { expect(error).toBe(failure); }
        parent.end();
      });
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      const parent = spans.find(span => span.name === "caller")!;
      for (const [name, code] of [["ratchet.apply", SpanStatusCode.OK], ["ratchet.verify", SpanStatusCode.ERROR]] as const) {
        const operations = spans.filter(span => span.name === name);
        expect(operations).toHaveLength(1);
        expect(operations[0]!.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
        expect(operations[0]!.status.code).toBe(code);
        expect(operations[0]!.attributes).toEqual({});
        expect(operations[0]!.events).toEqual([]);
      }
    } finally { await provider.shutdown(); }
  });

  test("a broken tracer cannot skip or repeat business effects or change their outcome", () => {
    for (const mode of ["before", "after", "repeat", "swallow", "wrong-return", "span-methods"] as const) {
      const broken = new Error("tracer failure");
      const span = {
        setStatus: () => { if (mode === "span-methods") throw broken; },
        end: () => { if (mode === "span-methods") throw broken; },
      };
      const fake = {
        startActiveSpan: (_name: string, callback: (value: unknown) => unknown) => {
          if (mode === "before") throw broken;
          let value: unknown;
          try { value = callback(span); }
          catch (error) { if (mode !== "swallow") throw error; }
          if (mode === "repeat") callback(span);
          if (mode === "after") throw broken;
          return mode === "wrong-return" ? "wrong" : value;
        },
      };
      const spy = spyOn(trace, "getTracer").mockReturnValue(fake as unknown as Tracer);
      try {
        let calls = 0;
        expect(observeOperation("ratchet.apply", () => { calls++; return 17; })).toBe(17);
        expect(calls).toBe(1);
        for (const failure of [new Error("original"), undefined, null]) {
          calls = 0;
          let caught = false;
          try { observeOperation("ratchet.apply", () => { calls++; throw failure; }); }
          catch (error) { caught = true; expect(error).toBe(failure); }
          expect(caught).toBe(true);
          expect(calls).toBe(1);
        }
      } finally { spy.mockRestore(); }
    }
  });
});
