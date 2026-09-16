' AI Quota Board - launch the tray icon (hidden PowerShell window)
'
' !! KEEP THIS FILE PURE ASCII !!
' Windows Script Host reads .vbs with the system ANSI code page, NOT UTF-8.
' A UTF-8 Chinese comment can end on a lead byte that swallows the line break,
' silently breaking parsing (this already happened once in RunProtocol.vbs).
'
' This file lives in the "quick actions" subfolder of the board. The program
' code lives in a SIBLING subfolder whose name is NOT ASCII, so that folder is
' located BY CONTENT (it is the one holding tools\install.mjs).
Option Explicit
Dim sh, fso, here, root, prog, fld, ps1
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)

prog = ""
For Each fld In fso.GetFolder(root).SubFolders
  If fso.FileExists(fld.Path & "\tools\install.mjs") Then prog = fld.Path
Next
If prog = "" Then
  MsgBox "Cannot find the program folder (the one holding tools\install.mjs). Run this file from inside the board folder.", 16, "AI Quota Board"
  WScript.Quit 1
End If

ps1 = prog & "\tools\tray.ps1"
If Not fso.FileExists(ps1) Then
  MsgBox "Cannot find tools\tray.ps1 in the program folder.", 16, "AI Quota Board"
  WScript.Quit 1
End If
sh.CurrentDirectory = root
' -WindowStyle Hidden avoids a console flash; -ExecutionPolicy Bypass avoids script policy blocks
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
