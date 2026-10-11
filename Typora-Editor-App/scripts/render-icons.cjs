// Render the vector masters with Chromium at their actual output sizes.
// Called by build-icons.mjs in a hidden, isolated Electron process.
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
app.setPath('userData', path.join(root, '.perf/icon-profile'));

function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({size, png}, i) => {
    const entry = 6 + i * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(image => image.png)]);
}

async function run() {
  await app.whenReady();
  const win = new BrowserWindow({show:false, webPreferences:{sandbox:true, contextIsolation:true, nodeIntegration:false}});
  await win.loadURL('data:text/html,<meta charset="utf-8"><title>Icon export</title>');
  const output = path.join(root, '.perf/icon-sizes');fs.mkdirSync(output, {recursive:true});
  for (const [name, source] of [['icon', 'app-icon.svg'], ['markdown', 'markdown-icon.svg']]) {
    const master = fs.readFileSync(path.join(root, 'build', source), 'utf8');
    const images = [];
    for (const size of [...sizes, 512]) {
      // Strengthen fine paper edges at Windows' smallest list-view sizes.
      const svg = name === 'markdown' && size <= 24
        ? master.replace('</svg>', '<style>.paper,.fold{stroke-width:10}.mark{stroke-width:15}.rule{display:none}</style></svg>')
        : master;
      const data = await win.webContents.executeJavaScript(`(async()=>{
        const img = new Image();img.src = ${JSON.stringify('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'))};await img.decode();
        const canvas = document.createElement('canvas');canvas.width = canvas.height = ${size};
        canvas.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      const png = Buffer.from(data, 'base64');
      fs.writeFileSync(path.join(output, `${name}-${size}.png`), png);
      if (size <= 256) images.push({size, png});
      if (size === 256) fs.writeFileSync(path.join(root, 'build', name + '.png'), png);
    }
    fs.writeFileSync(path.join(root, 'build', name + '.ico'), ico(images));
  }
  win.destroy();
}
run().then(() => app.exit(0)).catch(error => {console.error(error);app.exit(1);});
