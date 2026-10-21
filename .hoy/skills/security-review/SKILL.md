---
name: security-review
description: Audit a change or area for security vulnerabilities. Use when asked for a security review, audit, threat check, or before exposing something to the network.
user-invocable: true
argument-hint: "[commit, branch, or file paths]"
---

# Security review

Audit the change the user points at (working tree, commit range, branch, or paths). If they point at nothing, audit the uncommitted working tree.

## Workflow

1. **Map the attack surface.** What trust boundaries does the change touch: network input, auth and sessions, file paths, shell commands, serialization, secrets, permissions, crypto. Read the diff plus the code it calls.
2. **Check the usual suspects first:** injection (SQL, shell, template, XSS), broken access control, missing auth checks, secrets or tokens in code/logs, path traversal, SSRF, insecure deserialization, weak crypto or randomness, overly broad permissions, unvalidated redirects.
3. **Trace data, not patterns.** Follow untrusted input from entry to sink before calling it a finding. A sanitizer two frames up turns a finding into a non-issue; say which when you check.
4. **Verify exploitability.** For each real finding, show the path an attacker takes and the impact. Rank by severity: exploitable now, exploitable with preconditions, defense-in-depth hardening.

## Report shape

- Findings ordered by severity, each with file:line, the attacker path, impact, and a concrete fix.
- Separate hardening suggestions from real vulnerabilities. Never inflate: no finding without a traceable path gets reported as one.
- Close with what you checked and explicitly cleared, so the absence of a finding means coverage, not a skipped area.
