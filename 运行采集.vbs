' Run the collector with NO window (called by the scheduled task; no black flash).
'
' Two rules for this file:
'  1) It must stay PURE ASCII. Windows Script Host reads .vbs as GBK, and UTF-8
'     Chinese inside a comment can swallow the line break and break parsing
'     (this actually happened once: "'loop' without 'do'").  Keep it English/ASCII.
'  2) Prefer the bundled portable Node (runtime\node.exe) when it exists, because
'     release users may not have Node installed or on PATH. Fall back to "node".
Set sh = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base

q = Chr(34)
nodeExe = "node"
If fso.FileExists(base & "\runtime\node.exe") Then nodeExe = q & base & "\runtime\node.exe" & q

' Wrap the whole command in quotes so a path containing spaces still runs.
cmd = q & nodeExe & " collect.mjs >> data\collect.log 2>&1" & q
sh.Run "cmd /c " & cmd, 0, False
