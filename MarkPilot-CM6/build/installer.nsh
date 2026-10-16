; Refuse installation/uninstallation while any MarkPilot process is running.
; The default electron-builder macro closes by executable name and escalates to
; force-kill. A different appId does not make that behavior safe for another copy.
; nsProcess 603 means no matching process; all other unknown results fail closed.
!ifndef nsProcess::FindProcess
  !include "nsProcess.nsh"
!endif

!macro customCheckAppRunning
  Push $R0
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 0
    IfSilent +2 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "请先保存文档并关闭所有 MarkPilot 窗口，再重新运行安装或卸载。"
    SetErrorLevel 2
    Quit
  ${ElseIf} $R0 != 603
    IfSilent +2 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "无法确认 MarkPilot 是否已退出。请关闭 MarkPilot 后重试。"
    SetErrorLevel 3
    Quit
  ${EndIf}
  Pop $R0
!macroend
