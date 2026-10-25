# JavaScript packages by NUMOTEQ

npm packages by NUMOTEQ, maintained in a public pnpm monorepo and published under the `@numoteq` scope.

## Packages

| Package | Description | Status |
| --- | --- | --- |
| [`@numoteq/analytics-kit`](packages/analytics-kit) | First-party analytics for Cloudflare Workers and Astro: a proxy to self-hosted sGTM, server events, and a c15t preset. | Active |
| [`@numoteq/emdash-plugin-ahasend`](packages/emdash-plugin-ahasend) | EmDash plugin that delivers transactional email through the AhaSend API. | Active |

`@numoteq/sgtm-proxy` (formerly `@numoteq/emdash-plugin-sgtm`) was removed on 2026-10-25 and is deprecated on npm in favour of `@numoteq/analytics-kit`. `@numoteq/emdash-plugin-jetemail` and `@numoteq/emdash-plugin-forward-email` were removed on 2026-10-19 and are deprecated on npm in favour of `@numoteq/emdash-plugin-ahasend`.

## Development

Requires Node.js 24 and pnpm 11.

```sh
pnpm install
pnpm hooks:install
pnpm check
```

Each package lives in `packages/<package name without scope>`. EmDash plugins use the official `emdash-plugin` toolchain for validation, development and builds. `pnpm check` runs formatting, linting, type checks, tests and production builds across the workspace.

## Versioning

Packages are versioned independently with Changesets. A package goes to 1.0.0 once it runs in production; from then on breaking changes are major releases. Compatibility with frameworks and runtimes is declared through each package's `peerDependencies`.

Every user-visible package change must include a changeset:

```sh
pnpm changeset
```

## Releases

The repository lives on Forgejo and is mirrored to GitHub (`github.com/numoteq/js-packages`) by a Forgejo push mirror.

- Forgejo (`.forgejo/workflows`) runs CI and, on `main`, opens the version PR from pending changesets. After that PR is merged it tags every new package version, creates the Forgejo release and attaches the EmDash registry bundle.
- GitHub (`.github/workflows/release.yml`) only publishes versions that are not on npm yet, through npm Trusted Publishing. No npm token exists.

A brand-new package must be published once by hand (`npm publish --access public` in its directory after `pnpm build`), because npm can only configure a trusted publisher for an existing package. Then add the trusted publisher: `npm trust github <package> --file release.yml --repo numoteq/js-packages`.

Sandbox-compatible EmDash plugins are also published to the experimental EmDash Registry under the verified `numoteq.com` publisher identity.
