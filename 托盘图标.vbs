' AI Quota Board - launch the tray icon (hidden PowerShell window)
'
' !! KEEP THIS FILE PURE ASCII !!
' Windows Script Host reads .vbs with the system ANSI code page, NOT UTF-8.
' A UTF-8 Chinese comment can end on a lead byte that swallows the line break,
' silently breaking parsing (this already happened once in RunProtocol.vbs).
Option Explicit
Dim sh, fso, dir, ps1
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = dir & "\tools\tray.ps1"
If Not fso.FileExists(ps1) Then
  MsgBox "Cannot find tools\tray.ps1", 16, "AI Quota Board"
  WScript.Quit 1
End If
sh.CurrentDirectory = dir
' -WindowStyle Hidden avoids a console flash; -ExecutionPolicy Bypass avoids script policy blocks
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
