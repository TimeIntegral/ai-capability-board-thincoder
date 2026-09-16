' AI Quota Board - first-run helper: enable automatic collection SILENTLY (no console window).
' Double-click it when the dashboard wizard says the system side is not ready yet.
'
' !! KEEP THIS FILE PURE ASCII !!
' Windows Script Host reads .vbs with the system ANSI code page (GBK on this machine), NOT UTF-8.
' A UTF-8 Chinese comment can end on a lead byte that swallows the line break and break parsing
' (this actually happened once in RunProtocol.vbs). Chinese text lives in the program folder's
' tools\setup-notify.mjs (UTF-8, fine) and - as a fallback - in the three base64 payloads embedded below.
'
' This file lives in the "quick actions" subfolder of the board. The program code lives in a
' SIBLING subfolder whose name is NOT ASCII; because this file must stay pure ASCII, that folder
' is located BY CONTENT (it is the subfolder holding tools\install.mjs) instead of spelled out here.
Option Explicit
Dim sh, fso, here, root, prog, fld, q, nodeExe, cmd, rc, rc2, notified, notifyCmd, notifyArg, psExe, b64, b64Ok, b64Fail, b64NoInstall

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)
q = Chr(34)
psExe = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"

' Embedded notices (each payload is ONE single-line literal): b64Ok / b64Fail for the degraded
' Tier 2 path below, b64NoInstall for the missing-tools guard right after them.
' b64Ok: base64(UTF-16LE) of the Chinese success notice, same copy as the program folder's tools\setup-notify.mjs --ok.
' Regenerate after any copy change: node <program folder>\tools\setup-notify.mjs --emit-b64
b64Ok = "QQBkAGQALQBUAHkAcABlACAALQBBAHMAcwBlAG0AYgBsAHkATgBhAG0AZQAgAFMAeQBzAHQAZQBtAC4AVwBpAG4AZABvAHcAcwAuAEYAbwByAG0AcwAKAFsAUwB5AHMAdABlAG0ALgBXAGkAbgBkAG8AdwBzAC4ARgBvAHIAbQBzAC4ATQBlAHMAcwBhAGcAZQBCAG8AeABdADoAOgBTAGgAbwB3ACgAJwDqgahSx5HGlvJdAF8vVAz/votuf19O3U9YW31Zhk4CMAoACgDeVjBSC3d/Z7lwAE4LTgwwzZGwZcBoS20NMAz/MVz9gAt3MFLHkcaW036cZxv/5U4OVINbGk/qgfFdx5EM/w1OKHWhewIwJwAsACAAJwBBAEkAIAD9gJtSC3d/ZycAKQAgAHwAIABPAHUAdAAtAE4AdQBsAGwA"
' b64Fail: base64(UTF-16LE) of the Chinese failure notice, same copy as tools\setup-notify.mjs --fail.
b64Fail = "QQBkAGQALQBUAHkAcABlACAALQBBAHMAcwBlAG0AYgBsAHkATgBhAG0AZQAgAFMAeQBzAHQAZQBtAC4AVwBpAG4AZABvAHcAcwAuAEYAbwByAG0AcwAKAFsAUwB5AHMAdABlAG0ALgBXAGkAbgBkAG8AdwBzAC4ARgBvAHIAbQBzAC4ATQBlAHMAcwBhAGcAZQBCAG8AeABdADoAOgBTAGgAbwB3ACgAJwDqgahSx5HGlqFs/YCMW2hRxYh9WQj/CWdla6SaoWwQYp9SCf8CMAoACgC+i25/8l3Pft1PWFsb//NgC3fqVABOZWsxWSWNDP/MU/tReZjudsyRhHYMMIlbxYiaW/Zl+06hUi4AYgBhAHQADTAM/xZi3lYLd39nzZHViwBOIWsCMCcALAAgACcAQQBJACAA/YCbUgt3f2cnACkAIAB8ACAATwB1AHQALQBOAHUAbABsAA=="
' b64NoInstall: base64(UTF-16LE) of the Chinese "install script not found" guard notice, same copy as tools\setup-notify.mjs noinstall.
b64NoInstall = "QQBkAGQALQBUAHkAcABlACAALQBBAHMAcwBlAG0AYgBsAHkATgBhAG0AZQAgAFMAeQBzAHQAZQBtAC4AVwBpAG4AZABvAHcAcwAuAEYAbwByAG0AcwAKAFsAUwB5AHMAdABlAG0ALgBXAGkAbgBkAG8AdwBzAC4ARgBvAHIAbQBzAC4ATQBlAHMAcwBhAGcAZQBCAG8AeABdADoAOgBTAGgAbwB3ACgAJwChbH5iMFKBiSh1hHaJW8WIGoEsZwz/2Y8ha6FsCWcAX8tZiVvFiAIwCgAKAPeLimIMMC9UKHXqgahSx5HGli4AdgBiAHMADTA+Zd5WiVvFiO52VV+Edgww6193Y81kXE8NMIdl9k45WcyRDP+NUcxT+1EATiFrAjAnACwAIAAnAEEASQAgAP2Am1ILd39nJwApACAAfAAgAE8AdQB0AC0ATgB1AGwAbAA="

' Locate the program folder by content. On Error Resume Next keeps the guard below reachable:
' the user may have copied this .vbs outside the board folder, where no such subfolder exists.
prog = ""
On Error Resume Next
For Each fld In fso.GetFolder(root).SubFolders
  If fso.FileExists(fld.Path & "\tools\install.mjs") Then prog = fld.Path
Next
On Error GoTo 0

' Guard (a REACHABLE path: the user copied this .vbs outside the board folder, so the program
' folder is missing). tools\setup-notify.mjs is missing too, so Tier 1 cannot run - feed the
' embedded Chinese payload straight to PowerShell instead of an English MsgBox. The ASCII MsgBox
' below only fires if that PowerShell call itself fails - theoretical branch, unreachable on a real PC.
If prog = "" Then
  On Error Resume Next
  Err.Clear
  sh.Run q & psExe & q & " -NoProfile -WindowStyle Hidden -EncodedCommand " & b64NoInstall, 0, True
  If Err.Number <> 0 Then MsgBox "Cannot find tools\install.mjs - please keep this file inside the board folder.", 16, "AI Quota Board"
  On Error GoTo 0
  WScript.Quit 1
End If

sh.CurrentDirectory = root
If Not fso.FolderExists(root & "\data") Then fso.CreateFolder(root & "\data")

' Prefer the bundled portable Node (runtime\node.exe): release users may have no Node installed.
nodeExe = "node"
If fso.FileExists(root & "\runtime\node.exe") Then nodeExe = q & root & "\runtime\node.exe" & q

' Step 1: run the installer hidden and WAIT for its exit code (0 = all six steps succeeded).
cmd = "cmd /c " & nodeExe & " " & q & prog & "\tools\install.mjs" & q & " >> " & q & root & "\data\protocol.log" & q & " 2>&1"
rc = sh.Run(cmd, 0, True)

' Step 2: completion notice. It MUST be Chinese (user decision 2026-09-15), with three-tier degradation.
'   Tier 1 - normal: the program folder's tools\setup-notify.mjs pops the Chinese box (the copy lives there, UTF-8).
'   Tier 2 - degraded: feed the embedded base64 payloads straight to PowerShell -EncodedCommand.
'   Tier 3 - theoretical branch (unreachable on a real Windows PC): plain ASCII MsgBox, so it never fails silently.
notified = False
If fso.FileExists(prog & "\tools\setup-notify.mjs") Then
  notifyArg = "--fail"
  If rc = 0 Then notifyArg = "--ok"
  notifyCmd = "cmd /c " & nodeExe & " " & q & prog & "\tools\setup-notify.mjs" & q & " " & notifyArg
  On Error Resume Next
  Err.Clear
  rc2 = sh.Run(notifyCmd, 0, True)
  If Err.Number = 0 Then notified = (rc2 = 0)
  On Error GoTo 0
End If

If Not notified Then
  b64 = b64Ok
  If rc <> 0 Then b64 = b64Fail
  On Error Resume Next
  Err.Clear
  sh.Run q & psExe & q & " -NoProfile -WindowStyle Hidden -EncodedCommand " & b64, 0, True
  If Err.Number <> 0 Then
    MsgBox "AI Quota Board: setup finished with exit code " & rc & ". See data\protocol.log for details.", 64, "AI Quota Board"
  End If
  On Error GoTo 0
End If
