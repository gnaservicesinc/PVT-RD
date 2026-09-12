# PVT-RD artwork

PVT-RD.png is the supplied original. Browser icons in `public/icons` are square
PNG resamples at 16, 32, 48, 64, 128, 256 and 512 pixels. The build copies them
to every browser bundle; manifests, the page favicon and shared header use them.

To regenerate on macOS, from the repository root:

```sh
for size in 16 32 48 64 128 256 512; do
  sips -z "$size" "$size" artwork/PVT-RD.png --out "public/icons/icon-$size.png"
done
```
