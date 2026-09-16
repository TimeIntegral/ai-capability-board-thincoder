' Run the collector with NO window (called by the scheduled task; no black flash).
'
' Three rules for this file:
'  1) It must stay PURE ASCII. Windows Script Host reads .vbs as GBK, and UTF-8
'     Chinese inside a comment can swallow the line break and break parsing
'     (this actually happened once: "'loop' without 'do'").  Keep it English/ASCII.
'  2) Prefer the bundled portable Node (runtime\node.exe) when it exists, because
'     release users may not have Node installed or on PATH. Fall back to "node".
'  3) This file lives in the "quick actions" subfolder while the program code
'     lives in a sibling subfolder whose name is NOT ASCII. That folder is found
'     by content (it is the one holding tools\install.mjs), not spelled out here.
Set sh = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root

prog = ""
For Each fld In fso.GetFolder(root).SubFolders
  If fso.FileExists(fld.Path & "\tools\install.mjs") Then prog = fld.Path
Next
If prog = "" Then WScript.Quit 1

q = Chr(34)
nodeExe = "node"
If fso.FileExists(root & "\runtime\node.exe") Then nodeExe = q & root & "\runtime\node.exe" & q

' Wrap the whole command in quotes so a path containing spaces still runs.
' The log path stays relative: the working directory is already the board root.
cmd = q & nodeExe & " " & q & prog & "\collect.mjs" & q & " >> data\collect.log 2>&1" & q
sh.Run "cmd /c " & cmd, 0, False
