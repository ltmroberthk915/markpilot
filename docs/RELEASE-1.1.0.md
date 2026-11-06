# MarkPilot for DSH 1.1.0

Pick up your writing in the right workspace. Markdown now remembers the most recently opened note in each conversation's working directory, with flexible choices for opening files and starting fresh.

- **Workspace memory:** return to the last Markdown note opened in the current working directory.
- **Your preferred start:** choose a recent note, the native Files panel, or a blank document. Choose a separate fallback when there is no recent note.
- **Conversation switching:** follow a different working directory automatically, or keep the current document open. Switching conversations within the same directory preserves your document.
- **Blank notes:** write immediately, then press Ctrl/Cmd+S to save a new Markdown file directly in that directory. Later edits autosave.
- **Quiet save feedback:** “未保存” stays visible while changes remain unsaved; “已保存” disappears after three seconds.

Find these choices in **Settings → Markdown 编辑器 → 打开与切换**. Existing themes, editing tools and preferences remain available. The bundled MarkPilot editor core remains 3.6.17; Windows is the validated desktop platform.

Install from npm:

```sh
dsh plugin --profile desktop add dsh-markdown-typora@1.1.0
```

You can also install the attached `dsh-markdown-typora-1.1.0.tgz` through DSH plugin management, then restart DSH.
