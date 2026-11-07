# MarkPilot for DSH 1.1.1

Opening a conversation now restores your note without interrupting the chat. The editor comes back only when that conversation’s working directory has a note you were writing; a fresh directory stays a fresh conversation, and the working-directory file list waits until you ask for it.

- **Quiet conversation switching:** switching to a directory without a previous note leaves the conversation view alone — no file list, no placeholder document, and a document from another directory steps aside instead of following you across projects.
- **Closing with × is remembered:** closing the editor with its × marks that working directory as closed — later conversations open there without the editor or the file list, until you open Markdown again.
- **Explicit opening:** the Files panel or a blank note opens when you click **Markdown** on the left sidebar, following the opening choice in **Settings → Markdown 编辑器 → 打开与切换**.
- **The same directory still remembers:** switching conversations inside one working directory keeps the current document, unsaved edits included.
- **Follow or keep:** across directories, follow each project’s note, or keep the current document open.

Install from npm:

```sh
dsh plugin --profile desktop add dsh-markdown-typora@1.1.1
```

You can also install the attached `dsh-markdown-typora-1.1.1.tgz` through DSH plugin management, then restart DSH.
