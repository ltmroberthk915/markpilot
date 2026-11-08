# MarkPilot for DSH 1.3.2

When another process edits a Markdown file you have open, the editor now picks the change up instead of showing stale text until you reopen it.

- **Automatic adopt (clean document):** the collaboration room pulls the new disk text on the change event and pushes the delta to the editor, usually within 1–2 s.
- **Visible conflict (unsaved draft):** the editor shows a “文件已在磁盘上更新” banner with **重载磁盘版本** (disk wins, the draft is discarded after confirmation) and **复制我的内容** (keep the draft, copy it out).
- **Same behaviour outside collaboration:** a dirty non-live document also surfaces the banner instead of a status line only.
- **Everything else unchanged:** file links, the × memory and the passive-open setting behave as in 1.3.1.

Install from npm:

```sh
dsh plugin --profile desktop add dsh-markdown-typora@1.3.2
```

You can also install the attached `dsh-markdown-typora-1.3.2.tgz` through DSH plugin management, then restart DSH.
