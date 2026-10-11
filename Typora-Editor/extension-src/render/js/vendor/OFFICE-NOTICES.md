# Office export dependencies

Loaded only when exporting Word documents; no dependency on Pandoc or Microsoft Office.

- `fflate.mjs`: fflate 0.8.3, unmodified `esm/browser.js`, MIT. Source: https://github.com/101arrowz/fflate . License in fflate-LICENSE.txt.
- `mathml2omml.mjs`: mathml2omml 0.5.0, unmodified readable `dist/index.js`, LGPL-3.0-or-later. Source and build instructions: https://github.com/fiduswriter/mathml2omml/tree/0ddeb8b59ff1a97796b25d8f682dfb410febde1d . License in mathml2omml-LICENSE.txt. The separate ES module can be replaced/relinked with a compatible modified version; the application imposes no restriction on debugging such modifications. Distribution source archive is included alongside this module.

Both original packages can be obtained from the public npm registry by the exact versions above.
