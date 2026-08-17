# Content-box detection fixtures

`luther-p1-right-leaf-speck-top.png` is the top 400 rows of the right leaf of
source spread 1 of `003319_luther_syr_chronik_josua_styllites.djvu`, taken from
the 150-DPI detection raster the app builds before it renders (rows 0..400,
columns 1231..2203 of the 2203x1573 raster).

Its only marks above the title are a faint smudge at rows 21..23 that the page
cleanup itself discards as dust. It pins that such a mark cannot set the crop
top: detection must report the title row, not the smudge row.
