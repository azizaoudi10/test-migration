import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { writeIco } from './ico.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const svg = await readFile(join(root, 'build', 'icon.svg'));
const sizes = [16, 32, 48, 64, 128, 256, 512];
const iconsDir = join(root, 'build', 'icons');
await mkdir(iconsDir, { recursive: true });
for (const size of sizes) {
  await sharp(svg)
    .resize(size, size)
    .png()
    .toFile(join(iconsDir, `${size}x${size}.png`));
}
await sharp(svg)
  .resize(512, 512)
  .png()
  .toFile(join(root, 'build', 'icon.png'));
// Windows: exe, installer and shortcut icons need a multi-size .ico
await writeIco(
  [16, 32, 48, 64, 128, 256].map((s) => [s, join(iconsDir, `${s}x${s}.png`)]),
  join(root, 'build', 'icon.ico'),
);
console.log('build/icon.png written (512x512); build/icons/ written (16..512); build/icon.ico written');
