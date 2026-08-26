# Operations

Operational scripts remain deployment-neutral.

## Runtime bootstrap

```bash
./ops/bootstrap-runtime.sh
```

Creates runtime/profile/evidence directories with owner-only permissions.

## Browser account bootstrap

Use `npm run browser -- ...`. See `docs/12-W3-BROWSER-IDENTITY.md`.

Remote browser access must be private (for example Tailscale + SSH/private desktop). Do not expose VNC or Chromium DevTools to the public internet.
