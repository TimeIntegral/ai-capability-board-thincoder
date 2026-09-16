Option Explicit
Dim sh, fso, root, node
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
node = "node"
If fso.FileExists(root & "\runtime\node.exe") Then node = root & "\runtime\node.exe"
sh.CurrentDirectory = root
sh.Run Chr(34) & node & Chr(34) & " " & Chr(34) & root & "\tools\connections.mjs" & Chr(34), 0, False
