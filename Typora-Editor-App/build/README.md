# Editor icons

The vector masters are `app-icon.svg` and `markdown-icon.svg`. The slate-blue M is shared by the EXE, window/taskbar and VSIX. Associated Markdown files use a lighter paper silhouette with the same M, so repeated desktop icons remain quiet.

Run `npm run icons` to render the vectors locally using the bundled Electron/Chromium. It exports app and document PNGs and 32-bit transparent ICOs at 16, 20, 24, 32, 40, 48, 64, 96, 128 and 256 pixels. The 16–24 pixel document variants strengthen thin edges and omit the small text rule. No external image service, fonts or image libraries are required.

- `icon.png` / `icon.ico`: application and extension artwork.
- `markdown.png` / `markdown.ico`: Windows file-association artwork.
- `app/assets/icon.png`: packaged BrowserWindow icon, copied by the export and sync scripts.
- `../Typora-Editor/extension-src/icon.png`: VSIX artwork, copied by the export script.
- `.perf/icon-sizes/`: native-size exports for visual review (not packaged).

The NSIS installer installs `markdown.ico` into its resources folder and registers that icon for Markdown files opened with this application. The portable build does not register file associations.
