# Amplify

## Using bun

```bash
bunx degit daggerok/Amplify#main ./12345 && cd $_
bunx parcel ./index.html
open http://0:1234
```

## Update static data API

The app reads Amplify ETF catalog and holdings from `./api/data.json`.
Regenerate it with bun:

```bash
bun ./scripts/update-data.ts
```

The repository also includes a manually triggered GitHub Actions workflow that refreshes `api/data.json` and commits it back to the repository.

## TypeScript

Browser app source lives in `./src/main.ts`. Rebuild the browser bundle with bun:

```bash
bun build ./src/main.ts --outfile=./src/main.js --target=browser --format=esm
```
