# DjVu fidelity corpus

This directory contains the deterministic eight-class DjVu conversion
fidelity corpus. Goldens are rendered and compared at the same physical
page size (points derived from each page's own DPI), never at equal raw pixel
dimensions.

Run `node scripts/generate-djvu-fidelity-corpus.mjs` with DjVuLibre installed to
recreate every source and golden. The generated images use geometric patterns
and a deterministic pseudo-photo gradient, so no third-party artwork or fonts
enter the repository. `corpus-manifest.json` records SHA-256 hashes and CC0
provenance. Missing-tool and ENOSPC behavior is simulated around the checked-in
corrupt fixture by the contract tests.
