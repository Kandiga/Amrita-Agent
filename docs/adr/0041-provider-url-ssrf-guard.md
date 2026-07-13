# ADR-0041 — SSRF guard on provider base URLs

- **Status:** accepted (2026-07-13)
- **Context:** a commit-review scanner flagged that provider base URLs reach
  `fetch()` unvalidated. They resolve from an operator env var
  (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `OPENROUTER_BASE_URL`) **or** the
  auth-gated `providers.endpoint.local` setting, then a chat turn (with the
  user's key) or the `/models` probe fetches them. Since the bearer token is now
  shared with the browser via the public link, an authenticated caller could aim
  the daemon at cloud metadata (`169.254.169.254`) or a non-http scheme.

## Decision

One SSOT validator, `assertSafeProviderUrl(url)` (packages/daemon/src/provider.ts),
is the single owner of the rule; every base URL passes through it. It refuses the
two vectors with **no legitimate LLM use**:

1. non-`http(s)` schemes (`file:`, `gopher:`, …);
2. the cloud-metadata link-local range — IPv4 `169.254.0.0/16`, IPv6 `fe80::/10`
   and `fd00:ec2::254`, and the metadata hostnames.

It runs at the **choke point** (adapter construction + the `/models` probe), so a
hostile URL fails closed before any fetch. The probe converts the refusal into
its normal safe fallback (never throws).

### Deliberately NOT blocked: loopback / RFC-1918

Blocking private IPs — the scanner's suggested fix — would delete the documented
local-endpoint feature, whose own default is `http://localhost:11434` (Ollama).
Loopback and RFC-1918 stay allowed on purpose. The residual "point fetch at my
LAN" capability is strictly weaker than what the same token already grants (real
lane **code execution**), so a general egress firewall here would be theatre.
DNS rebinding is out of scope for the same reason.

## Invariants & guards

- Tests prove: public HTTPS + loopback/RFC-1918 allowed (the local-model
  feature); metadata IPs, metadata hostnames, IPv6 link-local, and `file:`/
  `gopher:` refused; a metadata-aimed adapter throws at construction and never
  fetches; the `/models` probe returns a safe fallback (never throws) for a
  blocked URL.

## Rollback

Additive: delete `assertSafeProviderUrl` and its call sites to restore prior
behavior. No wire/schema change.
