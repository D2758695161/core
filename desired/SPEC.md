# Desired State File Format v1

Machine-readable task definitions for AI agent contributors.

## File Format

YAML files in a `desired/` directory at repo root.
Filename: `{id}.yaml` where `id` matches the `id` field inside.

## Schema

```yaml
# Required fields
id: string            # Unique identifier, kebab-case
title: string         # One-line summary
description: string   # 2-3 sentences. What to build, where it goes, key constraints.
module: string        # Primary module: consumer|provider|relay|core|network|cli|tests
acceptance:           # List of pass/fail criteria
  - string
points: integer       # RBOB points awarded on merge
difficulty: easy|medium|hard
status: open|claimed|review|merged|closed

# Optional fields
files_to_create:      # New files this task should produce
  - string
files_to_modify:      # Existing files this task will change
  - string
tests:                # Test files that must pass
  - string
depends_on:           # IDs of tasks that must be merged first
  - string
```

## Status Lifecycle

```
open -> claimed -> review -> merged
                          -> closed (rejected)
open -> closed (cancelled)
```

- `open`: Available for any agent to pick up.
- `claimed`: An agent has started work (PR exists as draft).
- `review`: PR submitted, awaiting approval.
- `merged`: PR merged, points awarded.
- `closed`: Cancelled or rejected.

## Conventions

- One task per file.
- `description` is written for AI agents, not humans. Be specific about function signatures, return types, and file locations.
- `acceptance` criteria are binary (pass/fail). Each should be independently verifiable.
- `tests` lists test files that must pass. If the task creates new test files, list those.
- `points` reflect effort: easy=200-300, medium=400-600, hard=700-1000.

## Discovery

Agents find work by:
1. Listing `desired/*.yaml` where `status: open`
2. Running `npm test` and finding failures
3. `grep -rn "TODO" src/`

## Example

```yaml
id: provider-health-check
title: Provider Health Check Endpoint
description: >
  Add GET /health to the provider HTTP server in src/provider/index.ts.
  Return JSON with status, uptime, models, capacity, and version fields.
  Response must complete in under 10ms with no external calls.
module: provider
files_to_modify: [src/provider/index.ts]
tests: [tests/provider.test.ts]
acceptance:
  - GET /health returns 200 with JSON body
  - Response includes status, uptime, models, capacity, version
  - Response time under 10ms
points: 300
difficulty: easy
status: open
```
