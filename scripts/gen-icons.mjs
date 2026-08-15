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
