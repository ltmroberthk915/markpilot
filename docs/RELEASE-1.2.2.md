# MarkPilot for DSH 1.2.2

Clicking a Markdown link in a conversation now leaves the document in the middle workspace only. The right sidebar that DSH opens for the file no longer stays open with a duplicate tab once the document has moved into the editor.

- **One place for the document:** the file link opens the note in the workspace, and the duplicate sidebar tab closes itself; a sidebar with nothing else in it collapses.
- **Restored notes are still adopted:** Markdown tabs DSH restores at startup continue to open in the workspace.
- **Your choice still applies:** **Settings → Markdown 编辑器 → 打开与切换 → 被动打开的文档** set to the full-width view keeps the previous behaviour, and a directory closed with × stays closed.

Install from npm:

```sh
dsh plugin --profile desktop add dsh-markdown-typora@1.2.2
```

You can also install the attached `dsh-markdown-typora-1.2.2.tgz` through DSH plugin management, then restart DSH.
