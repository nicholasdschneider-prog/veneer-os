# Mini Apps

This directory holds reproducible sources for the Cloudflare-hosted Mini Apps that
ship with a deployment.

A Mini App is a single `.mjs` module that exports a Cloudflare Workers-style
`fetch` handler. The server publishes it through the generic Mini Apps runtime
(`server/src/miniApps/`, exposed to agents as the `publish_app` tool), which
uploads the module to Cloudflare Workers and registers it in the app catalog.

Keeping the source here means a published app can be rebuilt or re-deployed from
version control instead of only existing in the database.

No Mini Apps ship in this repository today; add one file per app.
