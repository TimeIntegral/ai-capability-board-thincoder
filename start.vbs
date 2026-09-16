' Unified portable and installed launcher. Keep this file ASCII.
Option Explicit
Dim sh, fso, root, exe, code
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = root & "\runtime\node.exe"
If Not fso.FileExists(exe) Then exe = "node"
sh.CurrentDirectory = root
code = sh.Run("""" & exe & """ """ & root & "\tools\launch.mjs""", 0, True)
If code <> 0 Then sh.Run """" & root & "\dashboard.html""", 1, False
