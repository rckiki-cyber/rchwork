; ─────────────────────────────────────────────────────────────────────────────
; Custom NSIS hooks for the legalwork Windows installer.
;
; Why this exists:
;   legalwork is an Electron app that spawns child processes — the renderer/GPU/
;   utility processes share the legalwork.exe image, and it also launches the
;   agent backend, the data-compliance Python service, and MCP (node) helpers.
;   electron-builder's default app-running check kills only "legalwork.exe" by
;   image name WITHOUT /T, so those children survive, keep files under the install
;   directory locked, and the installer falls into the
;   "应用程序无法关闭，请手动关闭它，然后单击重试" retry loop.
;
; Fix:
;   Override customCheckAppRunning to force-kill the whole legalwork process tree
;   plus anything still running from $INSTDIR, then continue without prompting.
;
; Why the current version still hangs:
;   A legalwork.exe running elevated (the app is commonly launched as
;   Administrator on Windows) cannot be killed by a NON-elevated `taskkill /F`.
;   taskkill returns "Access is denied", nsExec swallows the exit code, and the
;   installer proceeds oblivious — then stalls on a file it cannot overwrite.
;   We now abort loudly instead of silently continuing into the hang.
; ─────────────────────────────────────────────────────────────────────────────

!macro customCheckAppRunning
  DetailPrint "正在关闭正在运行的 legalwork…"

  ; 1) Force-kill the entire process tree by image name: the main window plus all
  ;    Electron child processes (all named legalwork.exe) and anything they
  ;    spawned (/T = whole tree, /F = force).
  nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  ; taskkill returns 0 when it killed something, 128+ when it found nothing,
  ; and reports "Access is denied" through stderr when the target is elevated.
  ; NSIS cannot read stderr, so detect the elevated case by re-querying whether
  ; any legalwork.exe is still alive after the kill. If it is, we must not
  ; proceed — the overwrite would stall exactly as before.
  nsExec::Exec 'tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH'
  Pop $0
  StrCpy $1 $0
  ; tasklist 在无匹配进程时输出 "INFO: No tasks are running which match the
  ; specified criteria."；有存活进程则输出含镜像名的 CSV 行。据此只在确有
  ; legalwork.exe 存活(说明 taskkill 未能杀干净,多为以管理员运行的实例)时才中止,
  ; 避免误伤全新安装。
  ${If} $1 MATCHES "${APP_EXECUTABLE_FILENAME}"
    DetailPrint "已尝试强制关闭 legalwork，但仍有进程存活，安装中止。"
    MessageBox MB_ICONSTOP "无法关闭正在运行的 legalwork。请先退出 legalwork 再安装；若它以管理员身份运行，请用管理员身份重新运行安装程序。" /SD IDOK
    Abort
  ${EndIf}

  ; 2) Kill any orphaned child whose executable lives under the install directory
  ;    (helpers/agents whose image name is not legalwork.exe). Best-effort: if
  ;    PowerShell is unavailable or blocked, step 1 already handled the tree.
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0

  ; 3) Give Windows a moment to release file handles before files are overwritten.
  Sleep 1500
!macroend
