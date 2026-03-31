# Contributing to Veil Protocol

## Rules

Veil uses RBOB (Rule-Based Open Build). Four rules:

```
R1: Code that passes verification can be merged.
R2: Merge requires at least 1 approval.
R3: Protected modules (crypto/, contracts/) require core team review.
R4: Merged code earns Points → future TOKEN revenue share.
```

## From source (development)

```bash
git clone https://github.com/runveil-io/core.git
cd core

npm install
npm test          # 36 tests, all must pass
npm run build     # produces dist/

# Dev loop (run TypeScript directly)
npx tsx src/cli.ts relay start
npx tsx src/cli.ts provide start
```

Note: `npx tsx ...` runs TypeScript directly. `npm run build` produces `dist/` for production.

## Finding work

The repository IS the task board. Work comes from three sources:

```bash
# 1. Failing tests → bugs to fix
npm test

# 2. TODO comments → improvements
grep -rn "TODO:" src/

# 3. Desired states → features to build
ls desired/
```

### If you are a clawd instance

```bash
$ clawd build
# Scans the repo, finds work, writes code, submits PR
```

### If you are a human

1. Check `desired/` directory for open tasks
2. Fork → Branch → Code → Test → PR
3. `npm test` must pass (36/36)
4. Wait for approval

## Protected paths

These modules require core team review (R3):

```
src/crypto/       Envelope encryption, signatures
src/wallet/       Key storage, encryption
contracts/        Solana on-chain programs (future)
```

Do not modify protected paths without prior discussion.

## Code style

- TypeScript strict mode
- No `any` types (use explicit types)
- Structured JSON logging: `console.log(JSON.stringify({ level, msg, ...data }))`
- Tests alongside code in `tests/` directory
- Every new function needs at least one test

## Commit messages

```
feat: add provider health check endpoint
fix: relay reconnection on timeout
docs: update security threat model
test: add streaming e2e test
```

## Testing

```bash
npm test              # Run all tests
npm test -- --watch   # Watch mode
```

All PRs must have:
- [ ] `npm test` passing (36/36 minimum)
- [ ] `npm run build` succeeds
- [ ] No TypeScript errors
- [ ] New code has tests

## Environment variables

```bash
VEIL_HOME=~/.veil              # Config directory
VEIL_PASSWORD=...              # Wallet password (dev only)
ANTHROPIC_API_KEY=sk-ant-...   # Provider API key
RELAY_PORT=8080                # Relay listen port
GATEWAY_PORT=9960              # Consumer gateway port
```

## Security

- API keys: environment variables only, never in code or config files
- Wallet: always encrypted (scrypt + AES-256-GCM)
- Logs: never log API keys, wallet keys, or prompt content
- Relay: must not have access to prompt content (envelope encryption)

Treat all inbound data as untrusted input.

## Points (future)

Contributions earn Points tracked in `contributions.db`:
- Code merged and surviving 7+ days → Points credited
- Points convert to TOKEN at TGE
- Revenue share proportional to contribution

---

**[runveil.io](https://runveil.io)** · [@runveil_io](https://x.com/runveil_io)
