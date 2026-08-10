# Brand assets

Where the public face of Vorratsdatenspeicher is kept. In this repository on purpose: three of
these existed only in a scratch directory and on nobody's backup, which is a bad way to store the
one image every link preview in the world will show.

| File | What it is | Used where |
|---|---|---|
| `og-cover.png` | link-preview card (Open Graph / Twitter) | `og:image` on vorratsdatenspeicher.com — every share on WhatsApp, Slack, X, Signal |
| `logo-hero.png` | the large logo | the landing page |
| `logo-wordmark.png` | name as a wordmark | for places where the icon alone is too little |
| `x-avatar.png` | profile picture | [@vorratsdaten](https://x.com/vorratsdaten) |
| `x-banner.png` | profile header | same |

The app's own icons live elsewhere and are shipped with the frontend:
`frontend/public/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`,
`favicon-16.png`, `favicon-32.png` — those are referenced by the manifest and by the installers,
so they belong next to the code that serves them.

⚠️ The website copies under `/opt/vds/landing/` on the Hetzner box are **deployed by hand**, like
the landing page itself. Change an image here and it does not travel anywhere on its own. Until
the site moves into this repository and onto the pipeline, both places have to be updated.
