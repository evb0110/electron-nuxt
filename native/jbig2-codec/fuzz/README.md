# jbig2-codec fuzzing

Install `cargo-fuzz`, then run the persisted decoder corpus from the crate
directory:

```sh
cargo +nightly fuzz run decode
```

The default corpus is `fuzz/corpus/decode/`. Keep minimized decoder regressions
there; keep the complete corpus below 100 KB so normal source checkouts remain
small. The roundtrip target can be run with
`cargo +nightly fuzz run roundtrip`.

CI runs both targets as short nightly canaries. Longer local runs remain useful
before changing the decoder or encoder.
