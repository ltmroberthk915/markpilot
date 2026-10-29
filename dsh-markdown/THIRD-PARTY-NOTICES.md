# Third-party notices

`dsh-markdown` is a DSH wrapper around the already-built MarkPilot CM6 renderer.
The following upstream projects are included in, or bundled by, that renderer:

- **MarkPilot** — MIT — <https://github.com/ltmroberthk915/markpilot>
- **CodeMirror 6** — MIT — <https://github.com/codemirror/dev>
- **Mermaid** — MIT — <https://github.com/mermaid-js/mermaid>
- **KaTeX** — MIT — <https://github.com/KaTeX/KaTeX>
- **KaTeX fonts** — SIL Open Font License 1.1 — <https://github.com/KaTeX/KaTeX/tree/main/fonts>

The plugin's own code (`lib/`, `renderer-cm6/index.html`,
`renderer-cm6/dsh-bridge.js`, `renderer-cm6/dsh-selection.js`) is MIT; see
[LICENSE](LICENSE). The built files under `renderer-cm6/cm6/` are copied
byte-for-byte from MarkPilot and retain their upstream notices.
