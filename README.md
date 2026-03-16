# co-opt (Collaborative Optical Tool)

co-opt is a browser-based optical design tool for editing lens data, visualizing ray paths, and iterating on optical systems with plain JSON data.

## Overview
The app is published at https://yassan8.github.io/co-opt/ and built with Vite, React, and a Rust+WASM backend used by the web runtime.

## Usage
1. Open https://yassan8.github.io/co-opt/ in a browser.
2. If no sample appears on startup, use Clear Cache once to reload the default data.
3. Edit the table rows and inspect the rendered optical system in the browser.

## Local development
- Start the web app: `npm run dev`
- Start the desktop app: `npm run dev:desktop`
- Rebuild the Rust+WASM package: `npm run wasm:rebuild`
- Build the web app: `npm run build`
- Preview the built web app: `npm run preview`

## GitHub Pages deployment
- Deployment workflow: `.github/workflows/pages.yml`
- Deploy target: https://yassan8.github.io/co-opt/
- Pages build path: `dist/`
- The workflow rebuilds `public/rust-wasm/pkg` with `npm run wasm:rebuild` before the Vite build.
- Generated folders such as `dist/`, `src-tauri/target/`, and `rust-wasm/target/` are excluded from git.

## Repository workflow
For the existing automation that creates a branch, commits, opens a PR, and merges:

- `npm run pr:all`

Optional environment variables:

- `BASE_BRANCH` default `main`
- `BRANCH_NAME` default `chore/all-files-pr-<timestamp>`
- `COMMIT_MESSAGE` default `chore: update all pending files`
- `PR_TITLE` and `PR_BODY`
- `MERGE_METHOD` values: `merge`, `squash`, `rebase`
- `ALLOW_ADMIN_MERGE` values: `1`, `0`

## License
MIT
