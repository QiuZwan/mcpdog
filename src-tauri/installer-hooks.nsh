; MCPDog 安装器自定义钩子。
;
; 背景：daemon 以 <安装目录>\node\node.exe 为进程镜像（tauri resources 映射
; "resources/node" -> "node"，即 $INSTDIR\node\；旧版可能是 $INSTDIR\resources\node\）。
; Windows 锁定运行中的进程镜像；被「接管」的 daemon（EXTERNAL_PID）不在 MCPDog.exe
; 的进程树里，模板的 taskkill /T 与托盘停机都覆盖不到它 —— 不在这里兜底，
; 覆盖安装必弹「无法打开要写入的文件: <安装目录>\node\node.exe」。
; 完整诊断见 doc/bug-diagnosis-node-exe-locked-during-update-20260924.md。
; 实机验证：-like "$INSTDIR\*" 过滤能命中 daemon，强杀后镜像锁释放（2026-09-24）。
;
; 两条铁律：
; 1) 变量必须用 $INSTDIR（NSIS 内建、安装时已是目标目录）—— 自定义变量 $dir 无值，
;    展开成空串会让 -like 匹配一切 node.exe，误杀用户系统 Node。
; 2) 只按「映像名 node.exe 且 ExecutablePath 位于 $INSTDIR 下」过滤 —— 绝不按映像名全杀。

!macro _mcpdog_kill_embedded_node
  ; 结束壳（含其进程树内由它 spawn 的 daemon）。失败无害：壳可能本来就没在跑。
  nsExec::Exec 'taskkill /F /T /IM MCPDog.exe'
  ; 清理脱离进程树的残留 daemon / 孤儿子服务器 node 进程：
  ; ExecutablePath 位于 $INSTDIR 任意层级（覆盖 node\ 与 resources\node\ 两种布局）。
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "$inst = '$INSTDIR'; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.ExecutablePath -like ($inst + '\*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  ; 等镜像锁释放（进程退出后句柄清理可达数百 ms）
  Sleep 1500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro _mcpdog_kill_embedded_node
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro _mcpdog_kill_embedded_node
!macroend
