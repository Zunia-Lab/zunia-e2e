# zunia-e2e

> End-to-end suites: Playwright (extension + web) and Maestro/Patrol (mobile).

**Status:** harness config only — no wallet flows until MVP exists.

## Layout

```
playwright/     Extension + dashboard + website
maestro/        Android / iOS flows (YAML)
```

## Prerequisites (later)

- Local chain (`gaiad`/`wasmd` Docker) for integration
- Packed extension under `zunia-extension/.output`
- Flutter build / simulator for Maestro

## Commands (placeholders)

```bash
pnpm install
pnpm test:web        # Playwright
# maestro test maestro/           # when mobile MVP exists
```

## License

Apache-2.0.
