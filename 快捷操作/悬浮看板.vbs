' AI Quota Board - show the floating panel (run it again to bring it back)
'
' Three rules for this file (same shape as the collector entry script, proven on real machines):
'  1) It must stay PURE ASCII. Windows Script Host reads .vbs as GBK, and UTF-8
'     Chinese inside a comment can swallow the line break and break parsing
'     (this actually happened once in RunProtocol.vbs: "Loop without Do").
'  2) Prefer the bundled portable Node (runtime\node.exe) when it exists, because
'     release users may not have Node installed or on PATH. Fall back to "node".
'  3) This file lives in the "quick actions" subfolder while the program code lives
'     in a sibling subfolder whose name is NOT ASCII; that folder is found by
'     content (the one holding tools\panel.mjs), never spelled out here.
'
' Double-click = show the panel. It also turns the switch back on, so a panel the
' user closed from the dashboard button / tray menu / its own right-click menu can
' come back with one double-click. The switch lives in config.json (panel.enabled)
' and is written by exactly one tool: <prog>\tools\panel.mjs.
Option Explicit
Dim sh, fso, root, prog, fld, q, nodeExe, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root

prog = ""
For Each fld In fso.GetFolder(root).SubFolders
  If fso.FileExists(fld.Path & "\tools\panel.mjs") Then prog = fld.Path
Next
If prog = "" Then WScript.Quit 1

q = Chr(34)
nodeExe = "node"
If fso.FileExists(root & "\runtime\node.exe") Then nodeExe = q & root & "\runtime\node.exe" & q

' Wrap the whole command in quotes so a path containing spaces still runs.
' The log path stays relative: the working directory is already the board root.
cmd = q & nodeExe & " " & q & prog & "\tools\panel.mjs" & q & " on >> data\protocol.log 2>&1" & q
sh.Run "cmd /c " & cmd, 0, False
