# zunia-e2e

> End-to-end suites: Playwright (extension + web) and Maestro/Patrol (mobile).

## Status

- **Playwright:** one unskipped dashboard smoke (`playwright/scaffold.spec.ts`) — home title + heading.
- **Maestro:** keep as-is (mobile MVP later).

## CI note

In GitHub Actions, start the dashboard (or point `E2E_BASE_URL` at a preview), install Playwright browsers, then run `pnpm test:web`. Example job fragment:

```yaml
- name: Dashboard smoke
  working-directory: zunia-e2e
  env:
    E2E_BASE_URL: http://127.0.0.1:3000
  run: |
    pnpm install
    pnpm exec playwright install --with-deps chromium
    # assume dashboard already serving, or:
    # (cd ../zunia-dashboard && pnpm dev &) && sleep 5
    pnpm test:web
```

Do not fail the monorepo on Maestro until mobile flows exist.

## Layout

```
playwright/     Extension + dashboard + website
maestro/        Android / iOS flows (YAML)
```

## Commands

```bash
pnpm install
pnpm test:web        # Playwright
# maestro test maestro/           # when mobile MVP exists
```

## License

Apache-2.0.
