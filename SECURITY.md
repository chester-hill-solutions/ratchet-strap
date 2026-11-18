# Security policy

## Reporting

Use GitHub's private vulnerability reporting: open the **Security** tab and
choose **Report a vulnerability**. Do not open a public issue for a suspected
vulnerability.

Include the affected version, the smallest reproduction you can, and the impact
you believe it has. You will get an acknowledgement, a triage decision and a
remediation timeline.

## Supported versions

The latest published minor release receives security fixes. Pre-release versions
are supported on a best-effort basis.

## Scope

RatchetStrap reads ESLint reports, writes baseline files and runs the
consumer's installed ESLint. Reports that matter include:

- a baseline write that can lose or corrupt unrelated entries;
- a comparison that accepts new debt or a raised allowance;
- a path traversal or command injection through CLI arguments, a report path or
  a baseline path;
- a secret or credential written to output, a log or a span.

The engine never downloads ESLint, executes a remote rule or sends report
content off the machine.
