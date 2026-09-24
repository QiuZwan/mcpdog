; MCPDog 安装器自定义钩子。
;
; 1) 更新占用兜底：daemon 以 <安装目录>\node\node.exe 为进程镜像（tauri resources
;    映射 "resources/node" -> "node"，即 $INSTDIR\node\）。Windows 锁定运行中的进程
;    镜像；被「接管」的 daemon（EXTERNAL_PID）不在 MCPDog.exe 的进程树里，模板的
;    taskkill /T 与托盘停机都覆盖不到它 —— 不在这里兜底，覆盖安装必弹
;    「无法打开要写入的文件」。诊断见 doc/bug-diagnosis-node-exe-locked-during-update-20260924.md。
;    实机验证：-like "$INSTDIR\*" 过滤能命中 daemon，强杀后镜像锁释放（2026-09-24）。
;
; 2) 自启设置保留：模板在卸载段（非 /UPDATE 模式）删除 HKCU Run 键的 MCPDog 值，
;    「卸载→重装」后用户要重新设置开机自启。这里在模板删除之前把值备份到
;    ~/.mcpdog/autostart.bak，安装时发现 Run 键缺失且备份存在则恢复。
;    静默更新（/UPDATE）路径模板本就不删，两条路径下自启都不丢。
;
; 铁律：
; - 变量必须用 $INSTDIR（NSIS 内建、安装/卸载时已是目标目录）—— 自定义变量无值，
;   展开成空串会让 -like 匹配一切 node.exe，误杀用户系统 Node。
; - 只按「映像名 node.exe 且 ExecutablePath 位于 $INSTDIR 下」过滤 —— 绝不按映像名全杀。

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
  ; 自启恢复：Run 键被卸载删除且存在备份时写回（用户意图以备份为准）。
  ; /UPDATE 静默更新路径 Run 键未被删，WriteRegStr 会写入相同值，幂等无害。
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MCPDog"
  ${If} $0 == ""
  ${AndIf} ${FileExists} "$PROFILE\.mcpdog\autostart.bak"
    ReadINIStr $1 "$PROFILE\.mcpdog\autostart.bak" "autostart" "command"
    ${If} $1 != ""
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MCPDog" $1
    ${EndIf}
    Delete "$PROFILE\.mcpdog\autostart.bak"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro _mcpdog_kill_embedded_node
  ; 自启备份：抢在模板删除 Run 值之前存下用户意图（含 --autostart 参数原样）。
  ; 无备份目录时创建；ReadRegStr 失败（值不存在）时 $0 为空，跳过写备份。
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MCPDog"
  ${If} $0 != ""
    CreateDirectory "$PROFILE\.mcpdog"
    FileOpen $1 "$PROFILE\.mcpdog\autostart.bak" w
    ${If} $1 != ""
      FileWrite $1 "[autostart]$\r$\ncommand=$0$\r$\n"
      FileClose $1
    ${EndIf}
  ${EndIf}
!macroend
