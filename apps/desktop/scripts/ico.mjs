import { readFile, writeFile } from 'node:fs/promises';

/** Packs PNG images into a Windows .ico (PNG-compressed entries, supported
 *  since Windows Vista). `pngs` maps pixel size → PNG file path. */
export async function writeIco(pngs, outFile) {
  const entries = [];
  for (const [size, file] of pngs) entries.push({ size, data: await readFile(file) });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o); // 0 means 256
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
    dir.writeUInt8(0, o + 2); // palette
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  await writeFile(outFile, Buffer.concat([header, dir, ...entries.map((e) => e.data)]));
}

// standalone: node scripts/ico.mjs → build/icon.ico from build/icons/*.png
if (process.argv[1]?.endsWith('ico.mjs')) {
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const sizes = [16, 32, 48, 64, 128, 256];
  await writeIco(
    sizes.map((s) => [s, join(root, 'build', 'icons', `${s}x${s}.png`)]),
    join(root, 'build', 'icon.ico'),
  );
  console.log('build/icon.ico written (16..256)');
}
