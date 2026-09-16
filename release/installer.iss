#ifndef StageDir
  #error StageDir required
#endif
#ifndef AppVersion
  #error AppVersion required
#endif
[Setup]
AppId=AI-Capability-Board-ThinCoder{code:TestSuffix}
AppName=AI 能力看板
AppVersion={#AppVersion}
AppPublisher=独立产品开发-Shinehey
AppPublisherURL=https://github.com/TimeIntegral/ai-capability-board-thincoder
AppSupportURL=https://github.com/TimeIntegral/ai-capability-board-thincoder/blob/main/docs/community.md
DefaultDirName={localappdata}\AICapabilityBoard
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
UsePreviousLanguage=no
UsePreviousPrivileges=no
ArchitecturesAllowed=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=ai-capability-board-v{#AppVersion}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile={#StageDir}\icon.ico
UninstallDisplayIcon={app}\icon.ico
CloseApplications=no
RestartApplications=no
Uninstallable=yes
LicenseFile={#StageDir}\LICENSE

[Languages]
Name: "zhcn"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\runtime\node.exe"; DestDir: "{tmp}"; DestName: "board-maintenance.exe"; Flags: dontcopy

[Icons]
Name: "{autoprograms}\AI 能力看板"; Filename: "{app}\start.vbs"; IconFilename: "{app}\icon.ico"; Check: NotIsolated
Name: "{autoprograms}\卸载 AI 能力看板"; Filename: "{uninstallexe}"; Check: NotIsolated

[Run]
Filename: "{app}\start.vbs"; Description: "打开看板，开始配置"; Flags: postinstall shellexec skipifsilent; Check: NotIsolated
Filename: "https://github.com/TimeIntegral/ai-capability-board-thincoder/blob/main/docs/community.md"; Description: "了解用户群与反馈方式"; Flags: postinstall shellexec skipifsilent unchecked; Check: NotIsolated

[Code]
var
  Prepared, Completed, IntegrationFailed, DeleteUserData: Boolean;

function NotIsolated: Boolean;
begin
  Result := ExpandConstant('{param:BOARDISOLATED|0}') <> '1';
end;

function TestSuffix(Param: String): String;
begin
  if NotIsolated then Result := '' else Result := '-Isolated-Test';
end;

function ModeArg: String;
begin
  if NotIsolated then Result := '' else Result := ' --isolated';
end;

function Lifecycle(Action: String): Boolean;
var Code: Integer;
begin
  Result := Exec(ExpandConstant('{tmp}\board-maintenance.exe'),
    '"' + ExpandConstant('{app}\tools\upgrade-lifecycle.mjs') + '" ' + Action + ModeArg,
    ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var OldVersion: AnsiString;
    OldPacked, NewPacked: Int64;
begin
  Result := '';
  ExtractTemporaryFile('board-maintenance.exe');
  if FileExists(ExpandConstant('{app}\VERSION')) then begin
    if LoadStringFromFile(ExpandConstant('{app}\VERSION'), OldVersion) then
      if StrToVersion(Trim(String(OldVersion)), OldPacked) and StrToVersion('{#AppVersion}', NewPacked) and (ComparePackedVersion(OldPacked, NewPacked) > 0) then begin
        Result := '已安装较新版本，请使用最新安装包。'; exit;
      end;
    if not FileExists(ExpandConstant('{app}\tools\upgrade-lifecycle.mjs')) then begin
      Result := '旧便携目录请先备份，安装到新目录后再迁移配置与历史。'; exit;
    end;
    if not Prepared then begin
      if Lifecycle('prepare') then Prepared := True
      else Result := '升级前备份未完成，已停止安装。请确认目录可写后重试。';
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var Code: Integer;
begin
  if CurStep = ssPostInstall then begin
    if NotIsolated then begin
      if not Exec(ExpandConstant('{app}\runtime\node.exe'),
        '"' + ExpandConstant('{app}\tools\install.mjs') + '" --skip-verify',
        ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then begin
        IntegrationFailed := True;
        if Prepared then Lifecycle('rollback');
        RaiseException('系统集成未完成，请重试安装或联系维护者。已有的配置和历史不会删除。');
      end;
    end;
    if Prepared and not Lifecycle('finish') then begin
      IntegrationFailed := True;
      RaiseException('升级收尾未完成，请保留备份并联系维护者。');
    end;
    Completed := True;
  end;
end;

procedure DeinitializeSetup;
begin
  if Prepared and not Completed then Lifecycle('rollback');
end;

function GetCustomSetupExitCode: Integer;
begin
  if IntegrationFailed then Result := 1 else Result := 0;
end;

function InitializeUninstall: Boolean;
var Code: Integer;
begin
  Result := True;
  if NotIsolated then
    DeleteUserData := SuppressibleMsgBox('是否同时删除配置、密钥、历史记录及备份？选择“否”可在重装后继续使用这些数据。', mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES;
  if not Exec(ExpandConstant('{app}\runtime\node.exe'), '"' + ExpandConstant('{app}\tools\uninstall.mjs') + '"' + ModeArg,
    ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then begin
    Result := False;
    SuppressibleMsgBox('后台清理未完成，请稍后重试卸载。', mbError, MB_OK, IDOK);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and DeleteUserData then begin
    { Fixed children of the Inno-resolved application directory only. No computed user paths. }
    DelTree(ExpandConstant('{app}\data'), True, True, True);
    DelTree(ExpandConstant('{app}\backups'), True, True, True);
    DeleteFile(ExpandConstant('{app}\config.json'));
    DeleteFile(ExpandConstant('{app}\secrets.json'));
    DeleteFile(ExpandConstant('{app}\dashboard-data.js'));
    DeleteFile(ExpandConstant('{app}\update-data.js'));
  end;
end;
