' AI Quota Board - URL protocol handler (invoked by registry: aiquotaboard://)
' Example: wscript "RunProtocol.vbs" "aiquotaboard://suppress?platform=glm"
'
' !! KEEP THIS FILE PURE ASCII !!
' Windows Script Host reads .vbs with the system ANSI code page (GBK on this machine),
' NOT UTF-8. A UTF-8 Chinese comment can end on a lead byte that swallows the line
' break, merging the next line into the comment and breaking parsing
' (this actually happened: "Loop without Do"). Keep comments/messages ASCII-only.
'
' This handler lives in the program folder. "dir" is that folder (the scripts it
' spawns are its own siblings), and "root" is the board folder above it (data\,
' dashboard.html and the portable runtime live there). Both are derived from this
' file's own location, so no non-ASCII path is ever spelled out in this file.
Option Explicit
Dim sh, fso, dir, root, url, rest, p, q, action, params, platform, setcmd, pathval, nameval, nodeExe, kv, k, v, cmdline

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(dir)
If WScript.Arguments.Count = 0 Then WScript.Quit

url = WScript.Arguments(0)
rest = url
p = InStr(rest, "://")
If p > 0 Then rest = Mid(rest, p + 3)

q = InStr(rest, "?")
If q > 0 Then
  action = LCase(Left(rest, q - 1))
  params = Mid(rest, q + 1)
Else
  action = LCase(rest)
  params = ""
End If

' IMPORTANT: Windows ShellExecute (used by browser clicks and notification buttons)
' normalizes  aiquotaboard://openpath?path=X  into  aiquotaboard://openpath/?path=X
' -- it inserts a slash before the "?". Without stripping it, action becomes
' "openpath/" and matches no branch, so the handler exits silently.
' That silently broke EVERY dashboard/notification button; only direct wscript
' invocations worked. Keep this normalization.
Do While Len(action) > 0 And Right(action, 1) = "/"
  action = Left(action, Len(action) - 1)
Loop

platform = ""
setcmd = ""
pathval = ""
nameval = ""

' Prefer the bundled portable Node (runtime\node.exe) for anything we spawn:
' release users may have no Node installed at all, so a bare "node" would fail.
' A RELATIVE path is deliberate: every command below runs with the working
' directory set to this folder, and a relative path keeps working even when the
' board folder contains spaces (quoting it here would break the cmd /c lines).
nodeExe = "node"
If fso.FileExists(root & "\runtime\node.exe") Then nodeExe = "..\runtime\node.exe"
For Each kv In Split(params, "&")
  If InStr(kv, "=") > 0 Then
    k = LCase(Left(kv, InStr(kv, "=") - 1))
    v = Mid(kv, InStr(kv, "=") + 1)
    If k = "platform" Then platform = LCase(v)
    If k = "set" Then setcmd = v
    If k = "path" Then pathval = v
    If k = "name" Then nameval = LCase(v)
  End If
Next

If Left(action, 7) = "update-" Then
  ' Fixed action allowlist; never accept a URL or executable path from the browser.
  v = Mid(action, 8)
  Select Case v
    Case "check", "skip", "auto-on", "auto-off", "notify-on", "notify-off"
      sh.CurrentDirectory = dir
      sh.Run Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & dir & "\tools\update.mjs" & Chr(34) & " " & v, 0, False
    Case Else
      WScript.Quit
  End Select
  WScript.Quit
ElseIf action = "suppress" Then
  cmdline = "cmd /c " & nodeExe & " """ & dir & "\balance-mute.mjs"" suppress " & platform & " >> """ & root & "\data\protocol.log"" 2>&1"
ElseIf action = "resume" Then
  cmdline = "cmd /c " & nodeExe & " """ & dir & "\balance-mute.mjs"" off " & platform & " >> """ & root & "\data\protocol.log"" 2>&1"
ElseIf action = "config" Then
  ' dashboard threshold editor: aiquotaboard://config?set=codex5hWarn:75,glmLow:8
  cmdline = "cmd /c " & nodeExe & " """ & dir & "\tools\edit-config.mjs"" """ & setcmd & """ >> """ & root & "\data\protocol.log"" 2>&1"
ElseIf action = "backup" Then
  cmdline = "cmd /c " & nodeExe & " """ & dir & "\tools\backup.mjs"" >> """ & root & "\data\protocol.log"" 2>&1"
ElseIf action = "collect" Then
  cmdline = "cmd /c " & nodeExe & " """ & dir & "\collect.mjs"" >> """ & root & "\data\protocol.log"" 2>&1"
ElseIf action = "open" Then
  ' open the dashboard
  cmdline = "cmd /c start """" """ & root & "\dashboard.html"""
ElseIf action = "openfile" Then
  ' open a whitelisted config file in Notepad (secrets.json / config.json).
  ' The node side only accepts fixed names, never a path -- no arbitrary-file-open surface.
  If nameval = "" Then WScript.Quit
  cmdline = "cmd /c " & nodeExe & " """ & dir & "\tools\open-config-file.mjs"" " & nameval & " >> """ & root & "\data\protocol.log"" 2>&1"
ElseIf action = "connect" Then
  sh.CurrentDirectory = dir
  sh.Run Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & dir & "\tools\connections.mjs" & Chr(34) & " --platform=" & platform, 0, False
  WScript.Quit
ElseIf action = "openpath" Then
  ' open a project folder (dashboard quota-attribution rows); path is URI-encoded,
  ' decoded and root-checked on the node side
  If pathval = "" Then WScript.Quit
  cmdline = "cmd /c " & nodeExe & " """ & dir & "\tools\open-path.mjs"" """ & pathval & """ >> """ & root & "\data\protocol.log"" 2>&1"
ElseIf action = "opentc" Then
  ' launch the ThinCoder workbench in that project directory
  If pathval = "" Then WScript.Quit
  cmdline = "cmd /c " & nodeExe & " """ & dir & "\tools\open-tc.mjs"" """ & pathval & """ >> """ & root & "\data\protocol.log"" 2>&1"
ElseIf action = "setupcheck" Then
  ' dashboard first-run wizard: probe the machine, write data\setup-status.json.
  ' Fixed script, no parameters (same exposure class as collect / backup / openfile).
  cmdline = "cmd /c " & nodeExe & " """ & dir & "\tools\setup-check.mjs"" >> """ & root & "\data\protocol.log"" 2>&1"
ElseIf action = "setupinstall" Then
  ' dashboard first-run wizard: register the scheduled task / shortcuts / tray.
  ' Fixed script, no parameters; idempotent. --skip-verify because the wizard runs
  ' its own trial collect right after -- do not collect twice.
  cmdline = "cmd /c " & nodeExe & " """ & dir & "\tools\install.mjs"" --skip-verify >> """ & root & "\data\protocol.log"" 2>&1"
Else
  ' unknown action: record it so silent failures are diagnosable
  cmdline = "cmd /c echo %DATE% %TIME% unknown action [" & action & "] url=" & url & " >> """ & root & "\data\protocol.log"""
End If

sh.CurrentDirectory = dir
sh.Run cmdline, 0, False
