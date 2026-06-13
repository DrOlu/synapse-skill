# Governance Charter

This document defines how the Synapse protocol evolves, who can make changes, and what guarantees are made to users.

---

## Status

This charter is a **proposed governance framework** for the Synapse protocol. It is not ratified by any formal community body. Adoption is voluntary.

---

## Versioning Policy

Synapse uses semantic versioning (semver.org) for all artifacts:

| Artifact | Version Example | Meaning |
|----------|----------------|---------|
| **Protocol Spec** | v1.2.0 | Envelope format, subject namespace, primitives |
| **SDKs (TS/Python/Go)** | v1.2.0 | Public API surface (classes, methods) |
| **Adapters** | v1.2.0 | Framework-specific integration code |

### Version Bump Rules

- **Major (x.0.0)**: Breaking changes to the protocol spec or SDK public API
  - e.g., Adding a required field to the envelope
  - e.g., Removing a public method from the SDK
  - **Requires**: Full RFC process, 6-month deprecation window
  - **Commitment**: v1.x agents remain compatible with v1.y indefinitely

- **Minor (0.x.0)**: Backward-compatible additions
  - e.g., Adding an optional field to the envelope (old agents ignore it)
  - e.g., Adding new utility methods to the SDK
  - **Requires**: Pull request + review by maintainer

- **Patch (0.0.x)**: Bug fixes, no API changes
  - **Requires**: Pull request (can self-merge if single maintainer)

---

## Backward Compatibility Guarantees

### Protocol Spec v1.x

The following are guaranteed stable within v1.x:

| Guarantee | Details |
|-----------|---------|
| Envelope field names | `v`, `id`, `type`, `ts`, `from`, `to`, `task_id`, `trace`, `payload`, `error` will not change |
| Required fields | `v`, `id`, `type`, `ts`, `from` will remain required |
| Envelope types | `register`, `deregister`, `discover`, `request`, `respond`, `emit` will not be renamed |
| Error code ranges | 1000s = transport, 2000s = validation, 3000s = routing, 4000s = rate limit, 5000s = internal |
| Subject namespace | `mesh.registry.*`, `mesh.agent.*.inbox`, `mesh.event.*`, `mesh.heartbeat.*` stable |
| Task state machine | 7 states and valid transitions will not change |

### What May Change

- Adding new optional envelope fields (old agents ignore them)
- Adding new envelope types (e.g., `mesh.registry.health`)
- Adding new subject prefixes
- Bug fixes in SDKs

---

## RFC Process for Protocol Changes

### When an RFC is Required

- Adding a new primitive (e.g., `stream` as a 7th primitive)
- Changing the semantics of an existing primitive
- Deprecating a field or changing its meaning
- Changing the subject namespace in backward-incompatible ways

### RFC Template

```markdown
# RFC: [Title]

## Status
Draft | Proposed | Accepted | Rejected

## Summary
One paragraph describing the change.

## Motivation
Why is this change needed? What problem does it solve?

## Proposal
Detailed description of the change.

## Impact
- Backward compatibility: compatible / breaking / deprecation
- Migration required: yes/no
- Effort to adopt: low/medium/high

## Alternatives Considered
What else was considered and why was this proposal chosen?

## Implementation Plan
Steps to implement, timeline, who will do it.

## Open Questions
Items still being discussed.
```

### RFC Lifecycle

1. **Draft**: Author writes the RFC in `docs/rfcs/rfc-NNN.md`
2. **Proposed**: Open PR to the governance repo
3. **Review Period**: Minimum 2 weeks for community feedback
4. **Accepted**: Maintainer merges with `Accepted` status
5. **Implementation**: PR(s) implementing the RFC, linked to the RFC PR
6. **Shipped**: Available in a released SDK version, RFC status updated to `Shipped`

---

## Maintainer Responsibilities

### Current Maintainers

| Name | GitHub | Role |
|------|--------|------|
| drolu | @drolu | Core maintainer, protocol owner |

### Becoming a Maintainer

A contributor may be invited to become a maintainer if they:

1. Have made at least 10 non-trivial commits to the SDK or examples
2. Have reviewed at least 5 pull requests
3. Have demonstrated understanding of the protocol spec
4. Are endorsed by an existing maintainer

### Maintainer Duties

- Review and merge pull requests in a timely manner (target: 7 days)
- Respond to issues within 7 days (can be "triaged, will address later")
- Run the RFC process for protocol changes
- Keep documentation current with releases
- Coordinate security responses (see below)

### Maintainer Removal

A maintainer may be removed by unanimous vote of remaining maintainers for:
- Extended inactivity (6+ months without engagement)
- Violating the security disclosure policy
- Conduct violations

---

## Security Disclosure

### Reporting Vulnerabilities

Do NOT open a public GitHub issue for security problems.

Instead, email: `security@synapse-protocol.example.com` (placeholder — set up a real address)

### Response Timeline

| Severity | Initial Response | Patch Released |
|----------|-----------------|----------------|
| Critical (RCE, auth bypass) | 24 hours | 7 days |
| High (DoS, data leak) | 72 hours | 14 days |
| Medium | 7 days | 30 days |
| Low | Best effort | Next minor release |

### Disclosure Process

1. Report received, maintainer acknowledges
2. Severity assessed
3. Fix developed (private branch)
4. Notification sent to known deployments (users who have opted in)
5. Patch released across all SDKs
6. Public disclosure after 7 days
7. CVE requested if applicable

---

## Specification Stability

### What "Stable" Means

When the Synapse protocol reaches v1.0.0 of the spec:

- **Envelope format frozen**: No changes to field names, required fields, or types in a v1.x release
- **Subject namespace frozen**: `mesh.registry.*`, `mesh.agent.*`, `mesh.event.*` will not change meaning
- **Error code stable**: New codes may be added, existing codes will not change meaning
- **Primitives stable**: New primitives may be added (e.g., primitive #7), existing ones will not change semantics

### What "Stable" Does Not Mean

- SDK public API may evolve (methods added, deprecated — but not removed in minor releases)
- Implementation details (internal classes, file structure) may change freely
- Examples and guides will evolve with best practices

---

## Decision Making

### When There Is One Maintainer

The single maintainer makes all decisions with community input. RFCs are optional for non-protocol-breaking changes.

### When There Are 2–5 Maintainers

Decisions are made by simple majority vote. All maintainers must be given 48 hours to review before merging.

### When There Are 6+ Maintainers

A steering committee of 3 (rotating annually) makes final calls on disagreements. Otherwise, decisions are made by lazy consensus (approve unless objection within 72 hours).

---

## Release Cadence

| Artifact | Target Cadence | Exceptions |
|----------|---------------|-----------|
| Protocol spec | Major every 12 months | Security fixes |
| TypeScript SDK | Monthly minor | Security fixes anytime |
| Python SDK | Monthly minor | Security fixes anytime |
| Go SDK | Monthly minor | Security fixes anytime |
| Documentation | Continuous | — |
| Examples | As needed | — |

---

## Contributing

### Accepting Pull Requests

1. All PRs must pass CI (tests, lint, type-check)
2. Protocol spec changes require RFC (see above)
3. SDK changes require tests
4. Example additions must be self-contained and runnable
5. Documentation updates for any public API changes

### Contribution Guidelines

- Follow existing code style (TS: Prettier + ESLint, Python: Black + Ruff, Go: gofmt)
- One logical change per PR
- Link related issues in PR description
- Update CHANGELOG.md for notable changes

---

## Licensing

The Synapse protocol spec is licensed under **CC-BY-4.0**.

All SDK implementations and examples are licensed under **MIT**.

Adapters and integrations may use any OSI-approved license.

---

## This Charter Itself

Amendments to this charter require:

- If one maintainer: maintainer decision + 2-week comment period
- If multiple maintainers: unanimous vote

The charter version at https://github.com/drolu/synapse-skill/blob/main/governance.md is authoritative.
