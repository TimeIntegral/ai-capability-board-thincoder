' AI Capability Board - the "connect platforms" window. Keep this file ASCII.
'
' This file lives in the "quick actions" subfolder of the board. The program
' code lives in a SIBLING subfolder whose name is NOT ASCII, while this file
' must stay pure ASCII (Windows Script Host reads .vbs with the system ANSI
' code page, and a UTF-8 Chinese byte can swallow the line break and break
' parsing). So the program folder is located BY CONTENT - it is the subfolder
' that holds tools\install.mjs - instead of being spelled out here.
Option Explicit
Dim sh, fso, here, root, prog, fld, node
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)

prog = ""
For Each fld In fso.GetFolder(root).SubFolders
  If fso.FileExists(fld.Path & "\tools\install.mjs") Then prog = fld.Path
Next
If prog = "" Then
  MsgBox "Cannot find the program folder (the one holding tools\install.mjs). Run this file from inside the board folder.", 16, "AI Capability Board"
  WScript.Quit 1
End If

node = "node"
If fso.FileExists(root & "\runtime\node.exe") Then node = root & "\runtime\node.exe"
sh.CurrentDirectory = root
sh.Run Chr(34) & node & Chr(34) & " " & Chr(34) & prog & "\tools\connections.mjs" & Chr(34), 0, False
