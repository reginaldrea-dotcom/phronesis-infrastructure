# share-viewer — public dossier viewer (separate Cloudflare Pages project)

The public, token-gated dossier viewer, served on a **dedicated public subdomain** (e.g.
`share.clarev.ai`) from its **own** Cloudflare Pages project — deliberately separate from the
gated `clarev.ai` site.

## Why separate (not just a subdomain on the main project)

`clarev.ai` is a Cloudflare Pages static site behind a whole-domain Cloudflare Access gate. A
path-scoped Access "Bypass" for `/d.html` did **not** reliably win over the domain gate (known
Cloudflare path-precedence flakiness). Hostname matching is reliable, so the viewer moves to its own
hostname. But a subdomain pointed at the **same** project would serve *every* file publicly, including
the internal pages — breaking the rule that internal tooling / navigators / `theo.html` / real-person
research stay gated. So the public viewer is its **own** project containing **only** the viewer + the
render assets it loads. Internal pages are not in it and cannot leak.

`build.sh` copies those files from `navigator/` on every deploy, so the public copy never drifts from
the gated site.

## Cloudflare Pages project settings

- Repository: this repo (Git-connected, auto-deploy on push)
- Build command: `bash share-viewer/build.sh`
- Build output directory: `share-viewer/dist`
- Custom domain: `share.clarev.ai` (or `d.clarev.ai`)
- Cloudflare Access: **none** on this hostname (it is public; the per-dossier token is the gate). If the
  `clarev.ai` gate app is a wildcard (`*.clarev.ai`), add a hostname-scoped **Bypass** app for
  `share.clarev.ai` — hostname matching is deterministic, unlike the path case.

## Shape

```
share-viewer/dist/
  d.html                    (from navigator/d.html)
  primes/theo-render.js       (legacy research-session view — default)
  primes/theo-display.css
  primes/theo-config.js
  primes/prime-core.v1.css
  primes/dossier-render.js    (universal Dossier view — served with &view=dossier)
  primes/dossier.css
```

`d.html` uses relative asset paths, so it works unchanged on any hostname. Share links become
`https://share.clarev.ai/d.html?t=<token>` for the legacy session view, or
`https://share.clarev.ai/d.html?t=<token>&view=dossier` for the universal Dossier page
(§-section descent + grounded-source cards). The `view=dossier` opt-in keeps every already-distributed
link (e.g. the ECHR interview-prep slice) rendering unchanged on the default theo-render.js path. The confidentiality notice, resolve/mint RPCs, and the
render EF are all unchanged and hostname-agnostic.

Do NOT weaken the `clarev.ai` gate. This project adds a public surface for the viewer only; everything
else stays behind Access.
