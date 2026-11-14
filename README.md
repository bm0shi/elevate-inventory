# Elevate Inventory

Warehouse inventory and finance app for an Amazon FBA seller: receive and scan
product, prep it, ship it to FBA, and see what it earned.

Node + Express + Postgres, no build step. Deployed on Railway from `main`.

```
npm install
DATABASE_URL=postgres://... npm start     # http://localhost:3000
npm test                                  # unit tests, no database needed
```

Where to read next:

- `CLAUDE.md` — how the app is laid out, the login model, and the rules to
  follow when changing it.
- `docs/screens.md` — each front-end file in full.
- `docs/lib.md` — each helper module in `lib/`.
- `docs/rules.md` — the long domain rules, with the reason behind each.
