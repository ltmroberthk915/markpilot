# MarkPilot for DSH 1.2.0

Documents that open on their own — a Markdown file you click in a conversation, or the note a working directory restores when you switch conversations — now open in the same workspace as clicking Markdown: the file list on the left and the two floating buttons in its top-left corner, ready to tuck the list away or close the editor. If you prefer the document alone, a new setting keeps the full-width view.

- **Same surface everywhere:** links in conversations and restored notes arrive with the file list, the recent-note list and the floating collapse/close buttons, so you can start writing where you were.
- **Your choice stays yours:** **Settings → Markdown 编辑器 → 打开与切换 → 被动打开的文档** switches between “与点 Markdown 相同” (default) and “全宽浮层（仅右上角关闭）”.
- **Closing still sticks:** closing the editor remembers the working directory as before, so a directory you finished with does not reopen by itself.

Install from npm:

```sh
dsh plugin --profile desktop add dsh-markdown-typora@1.2.0
```

You can also install the attached `dsh-markdown-typora-1.2.0.tgz` through DSH plugin management, then restart DSH.
