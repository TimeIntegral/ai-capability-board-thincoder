#ifndef StageDir
  #error StageDir required
#endif
#ifndef AppVersion
  #error AppVersion required
#endif
#ifndef FileList
  #error FileList required
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
; 安装文件清单由构建时生成：release/build-installer.mjs 从 release/publish-files.mjs 的发布层
; （L2）推导出安装层（L3）后，逐条列出每个要安装的文件。
; 这里**不再**用 Source: "{#StageDir}\*" 递归全装 —— 那样 stage 里任何东西都会被装进用户
; 机器，安装层就管不住了（开发文件漏进安装目录就是这么发生的）。清单之外的文件一律不装。
; 写法注意：#include 的参数是 ISPP **表达式**，不能写成 "{#FileList}" —— 那样只会拿到字面量
; `{#FileList}` 然后报 File not found；直接写变量名即可，值就是 /DFileList 传进来的路径。
#include FileList
Source: "{#StageDir}\runtime\node.exe"; DestDir: "{tmp}"; DestName: "board-maintenance.exe"; Flags: dontcopy

[Icons]
Name: "{autoprograms}\AI 能力看板"; Filename: "{app}\快捷操作\启动看板.vbs"; IconFilename: "{app}\icon.ico"; Check: NotIsolated
Name: "{autoprograms}\卸载 AI 能力看板"; Filename: "{uninstallexe}"; Check: NotIsolated

[Run]
Filename: "{app}\快捷操作\启动看板.vbs"; Description: "打开看板，开始配置"; Flags: postinstall shellexec skipifsilent; Check: NotIsolated

[Code]
var
  Prepared, Completed, IntegrationFailed, DeleteUserData: Boolean;

{ 用户数据清单在安装器里只有「删除」这几行（备份侧是 程序/tools/uninstall.mjs 的 用户数据，
  测试会把两边逐项对一遍）。下面三个常量是 uninstall.mjs --backup-user-data 的退出码。 }
const
  BR_OK = 0;              { 备份已经落在安装目录之外：可以删 }
  BR_EMPTY = 20;          { 本来就没有数据：不备份、也不删 }
  BR_FAILED = 10;         { 备份没做成：一个文件都不许删 }

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
var Code: Integer; Exe, Script: String;
begin
  Exe := ExpandConstant('{tmp}\board-maintenance.exe');
  { 2026-09-17 安装目录整理：新结构把程序代码放在程序子目录的 tools 下，
    旧安装（小于等于 1.2.0）则是 tools 直接在根目录。升级时优先用新路径，
    旧安装尚未被覆盖时回退旧路径，否则老用户的升级会被直接挡下。
    注意：Pascal 的反斜杠花括号注释不嵌套，注释文字里不得出现那种符号。 }
  Script := ExpandConstant('{app}\程序\tools\\upgrade-lifecycle.mjs');
  if not FileExists(Script) then
    Script := ExpandConstant('{app}\tools\\upgrade-lifecycle.mjs');
  Result := Exec(Exe,
    '"' + Script + '" ' + Action + ModeArg,
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
    if not FileExists(ExpandConstant('{app}\tools\\upgrade-lifecycle.mjs'))
       and not FileExists(ExpandConstant('{app}\程序\tools\\upgrade-lifecycle.mjs')) then begin
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
        '"' + ExpandConstant('{app}\程序\tools\install.mjs') + '" --skip-verify',
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

{ 卸载时数据怎么处理 —— 2026-09-20 重写。旧文案「是否同时删除配置、密钥、历史记录及备份？」
  是个反向提问：用户按了「是」＝删，11 天历史连同 backups/ 一起没了。现在四条硬规矩：
    ① 两个按钮各写各的后果，没有需要二次翻译的是/否；
    ② 保留那一侧明标『推荐』、又是默认按钮（直接回车即此）—— 两个按钮长得一样重，用户就会随手选一个；
    ③ 只有明确点到「连同数据一起删除」才返回真 —— 其余任何返回值（含 Esc 关闭）都按保留处理；
    ④ 真要删，先让 uninstall.mjs 把数据打包到安装目录之外，备份没成就一个文件都不删。
  用的是 SuppressibleTaskDialogMsgBox（自定义按钮文字 + 可被静默模式抑制）；本套构建带的
  private/build-tools/inno/ISCC.exe 是 Inno Setup 7.1.0，这个函数可用。 }
function AskUserData: Boolean;
var Labels: TArrayOfString;
begin
  SetArrayLength(Labels, 2);
  { MB_YESNO 的第一个按钮是 IDYES，也就是默认按钮 —— 保留落在默认位置上。
    按钮文字里 #13#10 之后那一行是任务对话框的按钮注释（第二行小字）。 }
  Labels[0] := '保留数据并卸载（推荐）' + #13#10 + '下次安装还能接着用';
  Labels[1] := '连同数据一起删除' + #13#10 + '配置、密钥和历史记录一并删掉，无法恢复';
  Result := SuppressibleTaskDialogMsgBox('卸载 AI 能力看板', '卸载后本机保存的配置、密钥、历史记录和备份怎么处理？',
    mbConfirmation, MB_YESNO, Labels, 0, IDYES) = IDNO;
end;

{ 卸载前的备份（在安装目录之外留一份 zip）。只看退出码：
    BR_OK    备份已就位，可以删
    BR_EMPTY 本来就没有数据
    其它     备份没做成（含起不来）—— 调用方必须放弃删除 }
function BackupUserData: Integer;
var Code: Integer;
begin
  if Exec(ExpandConstant('{app}\runtime\node.exe'),
    '"' + ExpandConstant('{app}\程序\tools\\uninstall.mjs') + '" --backup-user-data',
    ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) then Result := Code
  else Result := BR_FAILED;
end;

function InitializeUninstall: Boolean;
var Code, Backup: Integer;
begin
  Result := True;
  if NotIsolated then DeleteUserData := AskUserData;
  if not Exec(ExpandConstant('{app}\runtime\node.exe'), '"' + ExpandConstant('{app}\程序\tools\\uninstall.mjs') + '"' + ModeArg,
    ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then begin
    Result := False;
    SuppressibleMsgBox('后台清理未完成，请稍后重试卸载。', mbError, MB_OK, IDOK);
    exit;
  end;
  { 后台清理走通了才轮到数据：先备份，备份只要没成就撤回删除的打算。
    真正的删除留在 usPostUninstall（见 CurUninstallStepChanged）—— 那之后卸载已经成了，
    中途放弃（在 Inno 的确认上点否、或者卸载没做成）都不会少一个文件。 }
  if DeleteUserData then begin
    Backup := BackupUserData;
    DeleteUserData := Backup = BR_OK;
    if Backup = BR_FAILED then
      SuppressibleMsgBox('备份没能完成，已经取消删除：配置、密钥和历史记录都还在安装目录里。', mbError, MB_OK, IDOK);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and DeleteUserData then begin
    { Fixed children of the Inno-resolved application directory only. No computed user paths.
      进得来 = 用户明确选了「连同数据一起删除」，而且备份已经在安装目录之外就位。 }
    DelTree(ExpandConstant('{app}\data'), True, True, True);
    DelTree(ExpandConstant('{app}\backups'), True, True, True);
    DeleteFile(ExpandConstant('{app}\config.json'));
    DeleteFile(ExpandConstant('{app}\secrets.json'));
    DeleteFile(ExpandConstant('{app}\dashboard-data.js'));
    DeleteFile(ExpandConstant('{app}\\update-data.js'));
    { 卸载完成时告诉用户备份在哪 —— 数据刚删掉，这句话是他唯一的退路。 }
    SuppressibleMsgBox('配置、密钥和历史记录已删除；卸载前的备份在 ' + ExpandConstant('{localappdata}\AICapabilityBoard-backups') + '，需要时解压那份 zip 就能取回。', mbInformation, MB_OK, IDOK);
  end;
end;
