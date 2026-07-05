# Security Policy

Hoy is beta, pre-1.0 software. It stores your model API keys on your own disk
(`auth.json`, mode 0600, inside Hoy's directory) and never
sends them anywhere but the model provider you configure.

## Reporting a vulnerability

Please report security issues privately, not as a public issue. Open a
[GitHub security advisory](https://github.com/acidtib/hoy.chat/security/advisories/new)
for anything involving API keys, credential storage, auth, sandbox escape, or
data exposure.

We will acknowledge the report, work with you on a fix, and credit you unless you
prefer to stay anonymous.

## Scope

The supported version is the latest release. Because the project is pre-1.0, fixes
land in new releases rather than backports.
