const consumer = (detector) => ({ kind: "consumer", detector });

export const goldenProfiles = Object.freeze({
    typescript: Object.freeze([
      Object.freeze({
        id: "ts.strict",
        title: "Strict compiler",
        rule: "TypeScript projects enable strict, noUncheckedIndexedAccess, noImplicitOverride and noImplicitReturns.",
        enforcement: [consumer("the project's TypeScript configuration gate")],
      }),
      Object.freeze({
        id: "ts.no-escape",
        title: "No silent type escapes",
        rule: "No @ts-ignore or @ts-nocheck in active code; @ts-expect-error carries a description; `as any` and `as unknown as` are ratcheted.",
        enforcement: [consumer("a type-escape scanner or compiler gate")],
      }),
    ]),
    react: Object.freeze([
      Object.freeze({
        id: "react.state-machine",
        title: "Explicit state machines",
        rule: "Lifecycle state changes go through a named event reducer or transition table; no literal state setters.",
        enforcement: [consumer("a lifecycle-state scanner")],
      }),
      Object.freeze({
        id: "react.effects",
        title: "No bare effects",
        rule: "Every useEffect or useLayoutEffect documents its purpose, dependencies, side effects and why it cannot be a loader, fetcher or derived value — or is marked CANDIDATE-REMOVE.",
        enforcement: [consumer("an effects-strictness scanner")],
      }),
    ]),
    "react-router": Object.freeze([
      Object.freeze({
        id: "router.loaders",
        title: "Loaders and actions first",
        rule: "Data loading and mutation go through loaders, actions or fetchers; an effect must justify why it cannot.",
        enforcement: [consumer("the route and effect checks")],
      }),
      Object.freeze({
        id: "router.authorization",
        title: "Route authorization",
        rule: "Membership and role checks go through the route's typed middleware or handler factory; no ad-hoc inline authentication.",
        enforcement: [consumer("the route authorization checks")],
      }),
      Object.freeze({
        id: "router.request-integrity",
        title: "Request integrity",
        rule: "A request body is consumed once, and signed webhooks verify their signature before processing.",
        enforcement: [consumer("the request-body and webhook checks")],
      }),
    ]),
    web: Object.freeze([
      Object.freeze({
        id: "web.client-bundle",
        title: "Client bundle purity",
        rule: "Built client assets contain no server module, database import or credential marker.",
        enforcement: [consumer("a client-bundle scanner")],
      }),
    ]),
    ui: Object.freeze([
      Object.freeze({
        id: "ui.design-system",
        title: "Use the design system",
        rule: "Build from the consumer's design system and tokens; do not hand-roll styles or components the system already provides.",
        enforcement: [consumer("the consumer's design review or registry check")],
      }),
    ]),
    quality: Object.freeze([
      Object.freeze({
        id: "quality.duplication",
        title: "Duplication ceilings",
        rule: "Clone and duplicated-line counts stay at or below the reviewed ceilings.",
        enforcement: [consumer("a jscpd-style duplication scan")],
      }),
      Object.freeze({
        id: "quality.file-size",
        title: "File-size ceilings",
        rule: "No file grows past its reviewed line ceiling.",
        enforcement: [consumer("a file-size scan")],
      }),
      Object.freeze({
        id: "quality.async-sequencing",
        title: "Explicit async sequencing",
        rule: "Sequential awaits and repeated awaits in loops are explicit and reviewed; dependency and callback boundaries stay visible.",
        enforcement: [consumer("an async-sequencing scan")],
      }),
      Object.freeze({
        id: "quality.test-signal",
        title: "Honest test signals",
        rule: "Tests use the real dependency, await a signal instead of a sleep or poll, run once, keep their declared timeout, and fail on unhandled network requests.",
        enforcement: [consumer("the chs-testing-honesty@1 ESLint policy")],
      }),
    ]),
    telemetry: Object.freeze([
      Object.freeze({
        id: "telemetry.boundaries",
        title: "Telemetry boundaries",
        rule: "Every production effect boundary is observed or recorded; no unobserved error reporting.",
        enforcement: [consumer("a telemetry-boundary scanner")],
      }),
    ]),
    release: Object.freeze([
      Object.freeze({
        id: "release.versioned",
        title: "Versioned releases",
        rule: "A published change carries a version bump and a changelog line.",
        enforcement: [consumer("the consumer's release gate")],
      }),
      Object.freeze({
        id: "release.adr",
        title: "Format changes need ADRs",
        rule: "A format change ships an ADR, a dual-read window and a rollback.",
        enforcement: [consumer("the consumer's ADR review")],
      }),
    ]),
 });

/**
 * The profiles CHS enables in most of its repositories. A consumer is free to
 * enable only the profiles that fit its stack; CHS documents its own
 * thresholds and enforcement in `docs/chs-house-rules.md`.
 */
export const enabledProfiles = Object.freeze([
  "typescript",
  "react",
  "react-router",
  "web",
  "ui",
  "quality",
  "telemetry",
  "release",
]);


/** The starter composition. Copy this directory and edit it for your project. */
export const houseGoldenProfiles = goldenProfiles;
