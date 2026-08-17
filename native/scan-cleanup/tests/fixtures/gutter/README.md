# Binding-fold ownership fixtures

`luther-p3-toc-spread.png` is source spread 3 of
`003319_luther_syr_chronik_josua_styllites.djvu` at the 150-DPI canonical
analysis scale, which is the plane picture qualification and output-mode
selection actually run on.

The spread is a blank verso plus the `Inhaltsverzeichnis` recto, and its
binding fold sits at x≈1218 rather than on the geometric page centre (x=1101),
because the two leaves are not the same width. Only the darkest foot of the
fold shadow clears binarization, so the component that reaches picture
qualification is a 112x248 fragment covering 16% of the page height.

It pins the whole consequence chain: a fold fragment must not become a picture
owner, so `pictureFraction` stays 0, Auto stays on the bilevel text route
instead of promoting the page to Mixed, and the recto's content crop keeps its
left edge inside the leaf instead of reaching back across the fold. A
regression on any link shows up as heavier text, a surviving gutter blob, or
both.
