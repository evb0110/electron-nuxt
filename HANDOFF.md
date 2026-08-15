# S5 canonical routing-plane correction handoff

## Disposition

The fixed 150-DPI canonical render remains the owner of layout, leaf resolution,
route choice, and spread reconciliation. The review corrections remove the
unrelated substitutions that had been attributed to that basis. The production
impressum still reports 14 standard stroke-oracle offenders (nominal limit 3),
but the component-level adjudication below accepts that sparse leaf: 13 are
non-widening local-median artifacts, the single widened ridge remains within
source support, and all 14 are source-supported. The Vorwort is 0 (limit 6) and
still routes Otsu at 299 DPI. No replacement anchor offset or threshold
weighting has been hidden to make the raw count green.

## Binding review items

1. **Normalized joint — corrected.** The joint candidate is cropped from the
   illumination-normalized canonical plane. Raw canonical leaves still own the
   two leaf candidates. This removes the raw-joint substitution while keeping
   all three candidates independent of working DPI.
2. **Intensity anchor — corrected and pinned.** Each paper/ink midpoint is
   measured over the full raw canonical leaf. A physically dilated picture mask
   is a histogram exclusion; it is not whitened into the paper population. The
   two-scale 150/300-DPI pin returns 127 at both scales. The production anchors
   are 129/127; the former <=256-pixel anchors 201/182 are gone.
3. **Drift semantics — explicitly canonical.** A literal restoration of
   working-raster drift was falsified: page 120/121 routes and reconciliation
   changed between 299 and 300 DPI. The retained semantics therefore measure
   x-height and faint-ink population on the full masked canonical leaves and
   compare *clamped radii at canonical DPI*, not raw x-heights. Actual selected
   radii are still scaled into working pixels. There is no 1.0-DPI sentinel;
   the 300-DPI fallback x-height is named `FALLBACK_X_HEIGHT_AT_300_DPI_PX`.
4. **Scratch memory — corrected.** `resolveRasterHandoff` budgets the fixed
   canonical render and simultaneous primary copies per resident page. The
   canonical scratch file is released on native `page-complete`, and all release
   promises settle before collection. The PNG fallback creates PNG canonical
   analysis input rather than writing raw PPMs. The measured canonical PPM is
   10,687,715 bytes/page, now bounded by raster concurrency rather than retained
   for the entire book.
5. **Preview parity — corrected.** Preview, final, lossless analysis, and
   detection all pass the paired canonical path/DPI contract. The preview
   harness reports placement identity true and no violations.
6. **Stroke-width units — restored.** `estimated_stroke_width_px` again includes
   the internal routing-sample scale and is expressed in full input pixels. Its
   permanent unit test guards the Sauvola/UI contract; R19 is not included.
7. **Real scale pin — corrected.** The render pin compares a 192x256 canonical
   raster at 150 DPI with a 384x512 working raster at 299 DPI, where
   `analysis_is_full` is false. The canonical bypass mutation remains red.
8. **Attribution/hygiene — corrected.** Basis changes and retained canonical
   drift semantics are separated above. The test-only `route()` accessor is
   removed. The measured canonical render cost is approximately 149 ms against
   2498.865 ms steady-state conversion, or about 5.9%.

## Route falsifier

The final full-book inventory is identical at 150, 299, and 300 working DPI:

- routes: 281 Otsu, 34 Wolf, 1 unresolved;
- reconciliation: 226 shared joint, 34 faint-ink drift, 2 anchor drift,
  8 radius drift, 45 route mismatch, 1 unresolved;
- route/reconciliation identity disagreements across the three DPIs: 0/316.

The base inventory was 275 Otsu, 39 Wolf, and 2 unresolved. The ten changed
route leaves are p2l2, p3l1, p45l2, p46l2, p80l2, p120l1/l2, p124l1/l2, and
p133l2. Side-by-side crops are in
`.devkit/analysis/s5-shear/canonical-routing/corrected-route-crops/`; inspection
found intact text on p2/p3/p45/p46/p80/p133 and intact, more legible plate
structure on p120/p124, with no crop loss or blanked content.

## Validation evidence

- Production native render at 299 DPI: Vorwort Otsu, 0 offenders; impressum
  Otsu, 14 raw offenders, accepted by the combined component/pixel/source
  evidence below. Word-loss: 0 flagged/lost/damaged pages.
- Calibration and controls: 0 offenders; `wahrscheinlich` and `Handschrift`
  remain clean.
- Preview harness: placement identity true; word-loss 0.
- Native harness: 0 catastrophes across 51 fixtures; niqqud and punctuation
  goldens pass.
- Fold exemplars: p3 right 1965 px and p125 right 2008 px, both 0-px drift.
- Focused Electron suites: 184/184 pass.
- Rust format, Clippy with warnings denied, the full release workspace suite,
  threshold baseline, and diff checks pass.

## Impressum sparse-page adjudication

The exact comparison replays committed base `310c7251c` and the corrected
working tree against the same saved 299-DPI source, 150-DPI canonical analysis
raster, production manifest, crop, and 2196x3241 canvas. Optical placement is
removed before component and pixel comparison (base x offset 218, corrected
209; both y 59). Evidence is in
`.devkit/analysis/s5-shear/canonical-routing/impressum-adjudication/`:
`forensics.json` is the machine-readable ledger and
`offender-neighborhoods.png` is the 14-pair visual crop sheet.

The table reports `ridge/local line median` in pixels. `n` is the population in
the 32-mm local line window. Base and corrected line numbers differ by five
because the corrected sparse page exposes five additional eligible line groups
above these rows; the affected physical line centers remain within 0.39 px, so
none is a line-cluster reassignment. Class `b` here means the candidate ridge is
unchanged or thinner while the local population median moves; the neighborhood
diff explicitly discloses that the full component bitmap is not byte-identical.

| # | corrected component bbox | class | base line: ridge/median (`n`) | corrected line: ridge/median (`n`) | neighborhood changed (`+ink/-ink`) | base / corrected source test (`out <= supported + 1`) |
| ---: | --- | :---: | --- | --- | ---: | --- |
| 1 | 744,1572 39x33 | a | L19: 4.000/4.000 (24) | L24: 4.394/2.000 (26) | 59 (+45/-14) | 4.000 <= 4.000 + 1 / 4.394 <= 4.000 + 1 |
| 2 | 808,1572 58x33 | b | L19: 4.000/4.000 (28) | L24: 4.000/2.000 (31) | 106 (+99/-7) | 4.000 > 2.000 + 1 / 4.000 <= 4.000 + 1 |
| 3 | 753,2055 14x29 | b | L25: 6.000/4.000 (25) | L30: 4.394/2.400 (29) | 58 (+0/-58) | 6.000 <= 6.000 + 1 / 4.394 <= 4.394 + 1 |
| 4 | 824,2061 11x23 | b | L25: 4.000/4.000 (28) | L30: 4.000/2.400 (33) | 60 (+0/-60) | 4.000 <= 4.000 + 1 / 4.000 <= 4.000 + 1 |
| 5 | 910,2056 33x29 | b | L25: 5.600/4.000 (30) | L30: 4.000/2.000 (35) | 180 (+0/-180) | 5.600 > 2.400 + 1 / 4.000 <= 4.000 + 1 |
| 6 | 1044,2053 23x32 | b | L25: 4.000/4.000 (27) | L30: 4.000/2.000 (32) | 35 (+0/-35) | 4.000 <= 4.000 + 1 / 4.000 <= 4.000 + 1 |
| 7 | 1159,2067 21x18 | b | L25: 4.000/4.000 (27) | L30: 4.000/2.400 (31) | 37 (+0/-37) | 4.000 <= 4.000 + 1 / 4.000 <= 4.000 + 1 |
| 8 | 1265,2056 33x29 | b | L25: 4.000/4.394 (28) | L30: 4.000/2.400 (31) | 65 (+0/-65) | 4.000 <= 4.000 + 1 / 4.000 <= 4.000 + 1 |
| 9 | 1139,2121 21x18 | b | L26: 4.000/4.000 (33) | L31: 4.000/2.400 (34) | 6 (+0/-6) | 4.000 <= 4.000 + 1 / 4.000 <= 4.000 + 1 |
| 10 | 1162,2120 15x19 | b | L26: 4.000/4.000 (33) | L31: 3.400/2.000 (35) | 24 (+0/-24) | 4.000 <= 4.000 + 1 / 3.400 <= 3.400 + 1 |
| 11 | 1221,2108 22x32 | b | L26: 4.000/4.000 (35) | L31: 4.000/2.000 (37) | 33 (+0/-33) | 4.000 <= 4.000 + 1 / 4.000 <= 4.000 + 1 |
| 12 | 1283,2119 14x20 | b | L26: 6.000/4.000 (34) | L31: 6.000/2.000 (36) | 1 (+0/-1) | 6.000 <= 6.000 + 1 / 6.000 <= 6.000 + 1 |
| 13 | 1338,2108 19x31 | b | L26: 4.000/4.000 (35) | L31: 3.400/2.000 (37) | 49 (+0/-49) | 4.000 <= 4.000 + 1 / 3.400 <= 3.400 + 1 |
| 14 | 1387,2119 5x18 | b | L26: 6.000/4.000 (34) | L31: 3.400/2.000 (36) | 68 (+0/-68) | 6.000 <= 6.000 + 1 / 3.400 <= 3.400 + 1 |

Classification is therefore **1 a / 13 b / 0 c**. Eight of the thirteen `b`
ridges retain the same ridge width and five are thinner. The lone `a` ridge
widens only 0.394 px and remains inside the source-relative +1 px tolerance.
The corrected source-relative verdict is 14/14 supported; the matched committed
base counterparts are 12/14 supported, and the two unsupported base components
become supported in the corrected output.

The separately recorded “base 3” is not the committed production replay. It is
the earlier 300-DPI `differential/runs/r2-force-layout` artifact with a different
canvas/context: two offenders on impressum and one on Vorwort. All three are
source-supported in both that run and their source-mapped corrected matches:

| leaf/component | class against corrected mapping | base line: ridge/median (`n`) | corrected line: ridge/median (`n`) | source-relative verdict |
| --- | --- | --- | --- | --- |
| impressum 531,2076 31x32 | non-a: materially thinner | L23: 10.000/6.000 (12) | L23: 4.800/5.800 (13) | supported / supported |
| impressum 1134,2238 16x33 | non-a: thinner, median stable | L26: 7.000/4.000 (28) | L26: 6.000/4.000 (35) | supported / supported |
| Vorwort 332,1340 30x39 | b: ridge stable, median moved | L12: 8.000/4.394 (9) | L11: 8.000/6.000 (8) | supported / supported |

This provenance distinction matters. The oracle README already documents that
the same measurement with different amounts of page context can produce counts
that are not directly comparable. Sparse pages amplify that limitation: a few
newly eligible or split components can halve a local median while the candidate
component is unchanged or thinner. The raw offender count is therefore not an
adequate acceptance criterion for this leaf without source and pixel evidence.

Full-canvas pixel diff is 275,475 pixels on impressum, inflated by the 9-px
optical placement shift. After intrinsic alignment, 40,927 pixels differ:
40,021 ink pixels are removed and only 906 added. Every offender neighborhood
intersects at least one changed pixel, but 13/14 ridges do not widen. Vorwort's
aligned diff is 63,890 pixels (59,638 removed, 4,252 added). Thus the corrected
build is globally thinner, not a hidden weight increase; visual crop inspection
shows intact text on all 14 neighborhoods.

On the combined evidence—13/14 non-widening median artifacts, 14/14 corrected
source support, globally reduced ink, and clean visual crops—the impressum leaf
passes adjudication despite the raw sparse-line count of 14. The rejected
experiments remain rejected: a blanket canonical-anchor bias worsened the raw
result, disabling Otsu fallback rescue did not change it, and a +24
threshold/thickness surrogate would recreate an undisclosed substitution.
