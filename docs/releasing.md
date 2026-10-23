# Releasing to npm

The `.github/workflows/publish-npm.yml` workflow publishes a stable GitHub
Release to npm. The release tag must match the package version exactly, for
example `v0.1.0` for `"version": "0.1.0"` in `package.json`. Prereleases are
not published.

The workflow uses npm Trusted Publishing (OIDC), runs the build and test suite,
checks the package contents, and then publishes `opencode-muse`. It does not
use or require a long-lived npm token in GitHub Actions.

## One-time setup for the first version

npm requires a package to exist before a Trusted Publisher can be configured
in that package's settings. Therefore the first version must be published
manually by the npm package owner. Subsequent releases can use the workflow.

1. Run the release checks locally: `npm ci`, `npm run build`, `npm test`, and
   `npm pack --dry-run`.
2. From the repository root, publish the initial version with the owner account
   (currently `pgquiles`): `npm publish`. The `prepublishOnly` script also runs
   the build. Do not publish until the release is explicitly approved.
3. On the npm package page, open **Settings → Trusted Publisher** and add:
   - Provider: **GitHub Actions**
   - GitHub owner: `pgarciaq`
   - Repository: `opencode-muse`
   - Workflow filename: `publish-npm.yml`
   - Environment: leave blank
   - Allow direct `npm publish` for this publisher
4. Keep two-factor authentication enabled on the npm owner account. Do not add
   an npm token to GitHub secrets.

The npm username (`pgquiles`) owns the package; the Trusted Publisher uses the
GitHub repository identity (`pgarciaq/opencode-muse`). They are separate
accounts.

## Publishing later versions

1. Update the package version in `package.json` and `package-lock.json`.
2. Push the versioned commit to `main` and create a GitHub Release with a
   matching `v<version>` tag, such as `v0.2.0`.
3. Publishing the GitHub Release triggers the workflow. It checks out that
   tag, verifies the tag/package version match, installs dependencies, builds,
   runs tests, checks the npm package contents, and publishes to npm using OIDC.
4. Verify the version on the npm package page after the workflow succeeds.

Creating a GitHub Release before the first manual npm publish will not work:
the OIDC trust relationship cannot be configured until the package exists.

References: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
and [npm's first-publish limitation](https://github.com/npm/cli/issues/8544).
