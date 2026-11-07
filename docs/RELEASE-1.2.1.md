# MarkPilot for DSH 1.2.1

Markdown files that DSH restores for a session when the app starts now open in the document workspace too. Previously those restored tabs stayed in the built-in file preview on the right, so clicking a conversation could look like nothing happened.

- **Restored notes are adopted:** at startup the plugin finds the Markdown files already open for the current session and brings them into the workspace, with the file list and the floating collapse/close buttons.
- **Your choice still applies:** **Settings → Markdown 编辑器 → 打开与切换 → 被动打开的文档** set to the full-width view keeps the previous behaviour.
- **Closing with × still sticks:** a working directory you closed stays closed, exactly as before.

Install from npm:

```sh
dsh plugin --profile desktop add dsh-markdown-typora@1.2.1
```

You can also install the attached `dsh-markdown-typora-1.2.1.tgz` through DSH plugin management, then restart DSH.
