# Project instructions

Read `CLAUDE.md` for the shared project conventions. It is the source of truth for both coding agents. Use Bun for installation, execution, builds, and tests.

Agent integrations share workflow templates and queues. Keep backend-specific command syntax, permissions, and transcript parsing inside their adapters. Unsupported capabilities must be reported explicitly.

Run `bun test`, `bun run typecheck`, `bun run lint`, and `bun run format:check` when changing runtime behavior. Generate template manifests with `bun run gen:templates`; do not edit generated files by hand.
