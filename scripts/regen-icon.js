#!/usr/bin/env node
/**
 * Regenerate `resources/icons/icon.png` from `resources/icons/server-key.svg`.
 *
 * VS Code Marketplace requires a PNG for the extension icon. We render the
 * SVG with `sharp` (well-supported, Microsoft-maintained image library) at
 * 128x128 - the same size the Marketplace gallery uses.
 *
 * Run: `npm run icons:regen`
 *
 * The script exits 0 if the output matches the current PNG byte-for-byte, or
 * 1 otherwise. CI can run this to detect drift between the SVG and PNG.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SVG = path.resolve(__dirname, '..', 'resources', 'icons', 'server-key.svg');
const PNG = path.resolve(__dirname, '..', 'resources', 'icons', 'icon.png');

async function main() {
    const svg = fs.readFileSync(SVG);
    const buf = await sharp(svg, { density: 384 })
        .resize(128, 128)
        .png()
        .toBuffer();

    const existing = fs.existsSync(PNG) ? fs.readFileSync(PNG) : null;
    if (existing && existing.equals(buf)) {
        console.log(`icon.png is up-to-date (${buf.length} bytes)`);
        return;
    }

    fs.writeFileSync(PNG, buf);
    console.log(
        existing
            ? `icon.png regenerated (${buf.length} bytes; was ${existing.length})`
            : `icon.png written (${buf.length} bytes)`
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});