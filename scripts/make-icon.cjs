// Draws the app icon (a glossy Aero tile with the two deck rings) and writes assets/icon.png
// (512 px) and assets/icon.ico. Run:  npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" style="display:block;width:100vw;height:100vh">
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1689e6"/><stop offset=".5" stop-color="#63c4fb"/><stop offset=".8" stop-color="#bdf0e0"/><stop offset="1" stop-color="#8fdc55"/></linearGradient>
  <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity=".08"/></linearGradient>
  <linearGradient id="ra" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd27a"/><stop offset=".5" stop-color="#ff9a1f"/><stop offset="1" stop-color="#e86a00"/></linearGradient>
  <linearGradient id="rb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b9f0ff"/><stop offset=".5" stop-color="#1fb3ff"/><stop offset="1" stop-color="#0072d6"/></linearGradient>
  <radialGradient id="rim" cx="50%" cy="50%" r="50%"><stop offset=".55" stop-color="#fff" stop-opacity="0"/><stop offset=".9" stop-color="#fff" stop-opacity=".25"/><stop offset="1" stop-color="#fff" stop-opacity=".8"/></radialGradient>
  <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#003a78" flood-opacity=".45"/></filter>
  <clipPath id="tile"><rect x="24" y="24" width="464" height="464" rx="108"/></clipPath>
</defs>
<rect x="24" y="24" width="464" height="464" rx="108" fill="url(#sky)"/>
<g clip-path="url(#tile)">
  <ellipse cx="256" cy="520" rx="330" ry="120" fill="#6fd13c" opacity=".7"/>
  <circle cx="96" cy="400" r="46" fill="url(#rim)"/><circle cx="430" cy="118" r="30" fill="url(#rim)"/><circle cx="400" cy="420" r="20" fill="url(#rim)"/>
  <g filter="url(#sh)">
    <circle cx="196" cy="262" r="92" fill="none" stroke="url(#ra)" stroke-width="44"/>
    <circle cx="316" cy="262" r="92" fill="none" stroke="url(#rb)" stroke-width="44"/>
    <path d="M196 170a92 92 0 0 1 79 45" fill="none" stroke="url(#ra)" stroke-width="44"/>
  </g>
  <path d="M120 232a80 80 0 0 1 130-52" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="10" stroke-linecap="round"/>
  <path d="M262 200a80 80 0 0 1 112-10" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="10" stroke-linecap="round"/>
  <path d="M24 24h464v170C380 250 150 150 24 230Z" fill="url(#gloss)"/>
</g>
<rect x="26" y="26" width="460" height="460" rx="106" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="4"/>
</svg>`;

app.commandLine.appendSwitch('ozone-platform', 'headless'); // never opens a window on the desktop
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, useContentSize: true, frame: false, transparent: true });
  const page = path.join(app.getPath('temp'), 'oscardj-icon.html');
  fs.writeFileSync(page, `<!doctype html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body>`);
  await win.loadFile(page);
  await new Promise((r) => setTimeout(r, 800));
  let img = await win.webContents.capturePage();
  fs.rmSync(page, { force: true });
  if (img.getSize().width !== 512) img = img.resize({ width: 512, height: 512, quality: 'best' });
  const assets = path.join(__dirname, '..', 'assets');
  fs.writeFileSync(path.join(assets, 'icon.png'), img.toPNG());
  // .ico with PNG-compressed entries.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map((s) => img.resize({ width: s, height: s, quality: 'best' }).toPNG());
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(s === 256 ? 0 : s, e); head.writeUInt8(s === 256 ? 0 : s, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.concat([head, ...pngs]));
  console.log('icon written', img.getSize());
  app.exit(0);
});
