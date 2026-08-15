# Rota icon — single paste-ready brief for Claude Code

Copy everything below the line into Claude Code in your repo. It contains the
full artwork as text, so nothing needs to be downloaded or dragged in.

---

Add the new Rota app icon to this project. All artwork is given below as
source — **do not redraw, redesign, or "improve" it**. Reproduce the path data
and gradient stops exactly as written.

## 1. Create `public/icons/rota-icon.svg`

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="Rota">
  <defs><linearGradient id="v" gradientUnits="userSpaceOnUse" x1="77.87" y1="147.24" x2="125.09" y2="81.49"><stop offset="0" stop-color="#8B5CF6"/><stop offset="0.36" stop-color="#FBF8F2"/><stop offset="0.64" stop-color="#FBF8F2"/><stop offset="1" stop-color="#A3E635"/></linearGradient></defs>
  <rect width="200" height="200" rx="44" fill="#0B1120"/>
  <path d="M87.52 147.24Q82.81 147.24 80.76 145.82Q78.71 144.41 78.29 142.08Q77.87 139.76 77.87 137.26V91.92Q77.87 89.29 78.34 87.08Q78.81 84.87 80.86 83.53Q82.91 82.2 87.65 82.2Q92.27 82.2 94.28 83.44Q96.29 84.67 96.78 86.3Q97.27 87.92 97.27 89.09L95.71 89.87Q96.03 89.32 97.14 87.99Q98.25 86.66 100.21 85.14Q102.18 83.63 104.94 82.56Q107.7 81.49 111.34 81.49Q112.74 81.49 114.5 81.73Q116.25 81.97 118.13 82.53Q120.02 83.08 121.6 84.06Q123.17 85.03 124.13 86.49Q125.09 87.95 125.09 90Q125.09 95.3 122.64 99Q120.18 102.71 116.48 102.71Q114.27 102.71 113.31 102.35Q112.35 102 111.81 101.59Q111.28 101.18 110.45 100.83Q109.62 100.47 107.64 100.47Q105.69 100.47 103.88 101.02Q102.08 101.57 100.62 102.68Q99.16 103.78 98.31 105.39Q97.47 107 97.47 109.02V137.52Q97.47 140.02 96.99 142.28Q96.52 144.54 94.46 145.89Q92.39 147.24 87.52 147.24Z" fill="url(#v)"/>
  <circle cx="128" cy="62" r="12" fill="#A3E635"/>
</svg>
```

## 2. Create `public/icons/rota-icon-maskable.svg`

Identical, except `rx="44"` becomes `rx="0"` — full-bleed, because Android and
PWA launchers apply their own mask shape.

## 3. Create `public/icons/rota-icon-foreground.svg`

For the Android adaptive-icon foreground layer: transparent background, artwork
scaled into the centre safe zone.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 432 432">
  <defs><linearGradient id="v" gradientUnits="userSpaceOnUse" x1="77.87" y1="147.24" x2="125.09" y2="81.49"><stop offset="0" stop-color="#8B5CF6"/><stop offset="0.36" stop-color="#FBF8F2"/><stop offset="0.64" stop-color="#FBF8F2"/><stop offset="1" stop-color="#A3E635"/></linearGradient></defs>
  <g transform="translate(72 72) scale(1.44)">
    <path d="M87.52 147.24Q82.81 147.24 80.76 145.82Q78.71 144.41 78.29 142.08Q77.87 139.76 77.87 137.26V91.92Q77.87 89.29 78.34 87.08Q78.81 84.87 80.86 83.53Q82.91 82.2 87.65 82.2Q92.27 82.2 94.28 83.44Q96.29 84.67 96.78 86.3Q97.27 87.92 97.27 89.09L95.71 89.87Q96.03 89.32 97.14 87.99Q98.25 86.66 100.21 85.14Q102.18 83.63 104.94 82.56Q107.7 81.49 111.34 81.49Q112.74 81.49 114.5 81.73Q116.25 81.97 118.13 82.53Q120.02 83.08 121.6 84.06Q123.17 85.03 124.13 86.49Q125.09 87.95 125.09 90Q125.09 95.3 122.64 99Q120.18 102.71 116.48 102.71Q114.27 102.71 113.31 102.35Q112.35 102 111.81 101.59Q111.28 101.18 110.45 100.83Q109.62 100.47 107.64 100.47Q105.69 100.47 103.88 101.02Q102.08 101.57 100.62 102.68Q99.16 103.78 98.31 105.39Q97.47 107 97.47 109.02V137.52Q97.47 140.02 96.99 142.28Q96.52 144.54 94.46 145.89Q92.39 147.24 87.52 147.24Z" fill="url(#v)"/>
    <circle cx="128" cy="62" r="12" fill="#A3E635"/>
  </g>
</svg>
```

## 4. Generate the PNG sizes from those SVGs

Add `sharp` as a dev dependency, write `scripts/gen-icons.mjs`, run it once,
then keep the script in the repo so sizes can be regenerated later.

```js
// scripts/gen-icons.mjs
import sharp from "sharp";
import { mkdir } from "node:fs/promises";

const OUT = "public/icons";
await mkdir(`${OUT}/android`, { recursive: true });

const rounded = [32, 48, 96, 180, 192, 512, 1024];
for (const size of rounded) {
  await sharp(`${OUT}/rota-icon.svg`, { density: 384 })
    .resize(size, size).png()
    .toFile(`${OUT}/icon-${size}.png`);
}

await sharp(`${OUT}/rota-icon-maskable.svg`, { density: 384 })
  .resize(512, 512).png()
  .toFile(`${OUT}/icon-maskable-512.png`);

await sharp(`${OUT}/rota-icon-foreground.svg`, { density: 384 })
  .resize(432, 432).png()
  .toFile(`${OUT}/android/adaptive-foreground-432.png`);

await sharp({
  create: { width: 432, height: 432, channels: 4,
            background: { r: 11, g: 17, b: 32, alpha: 1 } },
}).png().toFile(`${OUT}/android/adaptive-background-432.png`);

console.log("icons generated");
```

Run with `node scripts/gen-icons.mjs`. Confirm every file lands before moving on.

## 5. Create `public/manifest.webmanifest`

```json
{
  "name": "Rota",
  "short_name": "Rota",
  "description": "Money, on schedule.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#0B1120",
  "theme_color": "#0B1120",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" },
    { "src": "/icons/rota-icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" }
  ]
}
```

## 6. Create `src/components/RotaMark.jsx`

```jsx
import { useId } from "react";

/**
 * The Rota mark — lowercase "r" with its lime ball.
 * The letterform is a baked outline, so it renders identically
 * without needing any font installed.
 */
export default function RotaMark({ size = 32, background = true, radius = 44, ...rest }) {
  const gid = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" role="img" aria-label="Rota" {...rest}>
      <defs>
        <linearGradient id={gid} gradientUnits="userSpaceOnUse"
          x1="77.87" y1="147.24" x2="125.09" y2="81.49">
          <stop offset="0" stopColor="#8B5CF6" />
          <stop offset="0.36" stopColor="#FBF8F2" />
          <stop offset="0.64" stopColor="#FBF8F2" />
          <stop offset="1" stopColor="#A3E635" />
        </linearGradient>
      </defs>
      {background && <rect width="200" height="200" rx={radius} fill="#0B1120" />}
      <path d="M87.52 147.24Q82.81 147.24 80.76 145.82Q78.71 144.41 78.29 142.08Q77.87 139.76 77.87 137.26V91.92Q77.87 89.29 78.34 87.08Q78.81 84.87 80.86 83.53Q82.91 82.2 87.65 82.2Q92.27 82.2 94.28 83.44Q96.29 84.67 96.78 86.3Q97.27 87.92 97.27 89.09L95.71 89.87Q96.03 89.32 97.14 87.99Q98.25 86.66 100.21 85.14Q102.18 83.63 104.94 82.56Q107.7 81.49 111.34 81.49Q112.74 81.49 114.5 81.73Q116.25 81.97 118.13 82.53Q120.02 83.08 121.6 84.06Q123.17 85.03 124.13 86.49Q125.09 87.95 125.09 90Q125.09 95.3 122.64 99Q120.18 102.71 116.48 102.71Q114.27 102.71 113.31 102.35Q112.35 102 111.81 101.59Q111.28 101.18 110.45 100.83Q109.62 100.47 107.64 100.47Q105.69 100.47 103.88 101.02Q102.08 101.57 100.62 102.68Q99.16 103.78 98.31 105.39Q97.47 107 97.47 109.02V137.52Q97.47 140.02 96.99 142.28Q96.52 144.54 94.46 145.89Q92.39 147.24 87.52 147.24Z" fill={`url(#${gid})`} />
      <circle cx="128" cy="62" r="12" fill="#A3E635" />
    </svg>
  );
}
```

## 7. Update `index.html`

Add inside `<head>`:

```html
<link rel="icon" type="image/svg+xml" href="/icons/rota-icon.svg" />
<link rel="icon" type="image/png" sizes="96x96" href="/icons/icon-96.png" />
<link rel="apple-touch-icon" sizes="180x180" href="/icons/icon-180.png" />
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#0B1120" />
```

## 8. Use the mark in the app

In `src/App.jsx` there are two places where a `Wallet` lucide icon sits inside
a violet circle as a stand-in logo. Replace both with the real mark:

- `SideNav` — the 30px circle at the top of the desktop sidebar → `<RotaMark size={30} />`
- `WelcomeScreen` — the 34px circle beside the "Rota" title → `<RotaMark size={34} />`

Import with `import RotaMark from "./components/RotaMark.jsx";`

`RotaMark` draws its own dark rounded background, so remove the wrapping violet
circle `div` in each case — but keep the surrounding flex layout and gap
spacing exactly as they are.

Afterwards, check whether `Wallet` is still used anywhere in the file (the
Profile tab's "Currency" row may still use it). Remove it from the
`lucide-react` import only if it has genuinely become unused.

## 9. Constraints

- Change nothing else: no colour changes, no layout changes, no refactors.
- `.gitignore` must not exclude `public/icons/` — the PNGs need to be committed.
- Run `npm run build` and confirm it compiles cleanly.

## 10. Then

Show me a summary of the diff and a preview of the icon before committing.
Once I approve, commit with a clear message and push to `origin/main`.

## Colour reference

| Role | Hex |
|---|---|
| Dark ground | `#0B1120` |
| Violet — letter base | `#8B5CF6` |
| Off-white — letter core | `#FBF8F2` |
| Lime — letter top and ball | `#A3E635` |
