; MCPDog 安装器自定义钩子。
;
; 背景：daemon 以 <安装目录>\resources\node\node.exe 为进程镜像（见
; src-tauri/src/supervisor.rs 的 spawn_daemon），Windows 会锁定运行中的进程镜像；
; 而被「接管」的 daemon（EXTERNAL_PID）不在 MCPDog.exe 的进程树里，托盘停机
; 与模板的 taskkill /T 都覆盖不到它 —— 不在这里兜底，覆盖安装必弹「文件被占用」。
; 完整诊断见 doc/bug-diagnosis-node-exe-locked-during-update-20260924.md。
;
; 两条清理都必须**按精确条件**过滤，绝不按映像名 node.exe 全杀 ——
; 用户系统 Node 与其他应用的 node.exe 不能碰。

!macro NSIS_HOOK_PREINSTALL
  ; 1) 结束壳（含其进程树内由它 spawn 的 daemon）。失败无害：壳可能本来就没在跑。
  nsExec::Exec 'taskkill /F /T /IM MCPDog.exe'

  ; 2) 清理脱离进程树的残留 daemon / 孤儿子服务器 node 进程：
  ;    仅 ExecutablePath 位于本安装目录 resources\node\ 下的进程。
  ;    PowerShell 逐个 Stop-Process；$installDir 由安装器展开为实际安装路径。
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "$dir = '$installDir'; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.ExecutablePath -like (Join-Path $dir 'resources\node\*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`

  ; 3) 等镜像锁释放（进程退出后句柄清理可达数百 ms）。
  Sleep 1500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 卸载同理：先停壳与安装目录内的 node 残留，否则 resources\node\node.exe 删不掉。
  nsExec::Exec 'taskkill /F /T /IM MCPDog.exe'
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "$dir = '$installDir'; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.ExecutablePath -like (Join-Path $dir 'resources\node\*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Sleep 1500
!macroend
