# Amplify

## Using bun

```bash
bunx degit daggerok/Amplify#main ./12345 && cd $_
bunx parcel ./index.html
open http://0:1234
```

## Update static data API

The app reads its ETF catalog and holdings from `./api/data.json`.
Regenerate it with bun:

```bash
bun ./scripts/update-data.js
```

A manually triggered GitHub Actions workflow is included to refresh `api/data.json` and commit the update back to the repository.
