#ifndef PayloadRoot
  #error PayloadRoot is required
#endif
#ifndef AppVersion
  #define AppVersion "0.1.0-preview.3"
#endif
#ifndef AppId
  #define AppId "QuizForge.Desktop"
#endif
#ifndef AppName
  #define AppName "QuizForge"
#endif
#ifndef OutputPath
  #define OutputPath "."
#endif
#ifndef CompressionMethod
  #define CompressionMethod "lzma2"
#endif
#ifndef QBankExtension
  #define QBankExtension ".qbank"
#endif
#ifndef HubScheme
  #define HubScheme "quizforge"
#endif

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=QuizForge
AppPublisherURL=https://github.com/lear111/quizforge_web
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
AppMutex=Local\{#AppId}
CloseApplications=no
RestartApplications=no
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
UsePreviousAppDir=yes
WizardStyle=modern
OutputDir={#OutputPath}
OutputBaseFilename=QuizForge-{#AppVersion}-win-x64-setup
Compression={#CompressionMethod}
SolidCompression=yes
SetupIconFile=..\..\..\.temp\windows-launcher-build\quizforge.ico
UninstallDisplayIcon={app}\QuizForge.exe
UninstallDisplayName={#AppName}
UninstallLogMode=append
SetupLogging=yes
ChangesAssociations=yes
VersionInfoVersion=0.1.0.0

[Languages]
Name: "chinese"; MessagesFile: "compiler:Languages\ChineseSimplified.isl,ChineseSimplified.isl"

[Files]
Source: "{#PayloadRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

; These are program-only folders. PrepareToInstall refuses portable/source/data
; directories, and the launcher always keeps installed data outside {app}.
[InstallDelete]
Type: filesandordirs; Name: "{app}\core"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\defaults"
Type: filesandordirs; Name: "{app}\skills"

[Icons]
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\QuizForge.exe"; WorkingDir: "{app}"
Name: "{autoprograms}\{#AppName}\{#AppName}"; Filename: "{app}\QuizForge.exe"; WorkingDir: "{app}"
Name: "{autoprograms}\{#AppName}\卸载 {#AppName}"; Filename: "{uninstallexe}"

[Registry]
Root: HKCU; Subkey: "Software\Classes\{#AppId}.QBank"; ValueType: string; ValueData: "QuizForge 题库包"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\{#AppId}.QBank\DefaultIcon"; ValueType: string; ValueData: """{app}\QuizForge.exe"",0"
Root: HKCU; Subkey: "Software\Classes\{#AppId}.QBank\shell\open\command"; ValueType: string; ValueData: """{app}\QuizForge.exe"" --import ""%1"""
Root: HKCU; Subkey: "Software\Classes\{#QBankExtension}\OpenWithProgids"; ValueType: string; ValueName: "{#AppId}.QBank"; ValueData: ""; Flags: uninsdeletevalue uninsdeletekeyifempty

[Run]
Filename: "{app}\QuizForge.exe"; Description: "打开 QuizForge"; Flags: nowait postinstall skipifsilent

[Code]
procedure RegisterHubProtocol();
var
  Existing, Command, Key: String;
begin
  Key := 'Software\Classes\{#HubScheme}';
  Command := ExpandConstant('"{app}\QuizForge.exe" --open-url "%1"');
  if RegKeyExists(HKCR, '{#HubScheme}') then
    if not RegQueryStringValue(HKCR, '{#HubScheme}\shell\open\command', '', Existing) or (CompareText(Existing, Command) <> 0) then
    begin
      Log('Hub URI protocol is already owned by another program or installation; preserved.');
      SuppressibleMsgBox('Hub 一键导入协议已被其他程序或安装位置占用，已保留原设置。您仍可下载 .qbank 文件后导入。', mbInformation, MB_OK, IDOK);
      Exit;
    end;
  RegWriteStringValue(HKCU, Key, '', 'URL:QuizForge Hub Import');
  RegWriteStringValue(HKCU, Key, 'URL Protocol', '');
  RegWriteStringValue(HKCU, Key + '\DefaultIcon', '', ExpandConstant('"{app}\QuizForge.exe",0'));
  RegWriteStringValue(HKCU, Key + '\shell\open\command', '', Command);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Existing: String;
begin
  if CurStep = ssPostInstall then
  begin
    { HKCR includes machine-wide defaults as well as this user's choices. }
    if not RegQueryStringValue(HKCR, '{#QBankExtension}', '', Existing) or (Existing = '') then
      RegWriteStringValue(HKCU, 'Software\Classes\{#QBankExtension}', '', '{#AppId}.QBank');
    RegisterHubProtocol();
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Existing: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    if RegQueryStringValue(HKCU, 'Software\Classes\{#QBankExtension}', '', Existing) and (Existing = '{#AppId}.QBank') then
      RegDeleteValue(HKCU, 'Software\Classes\{#QBankExtension}', '');
    RegDeleteKeyIfEmpty(HKCU, 'Software\Classes\{#QBankExtension}');
    if RegQueryStringValue(HKCU, 'Software\Classes\{#HubScheme}\shell\open\command', '', Existing)
      and (CompareText(Existing, ExpandConstant('"{app}\QuizForge.exe" --open-url "%1"')) = 0) then
      RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Classes\{#HubScheme}');
  end;
end;

function InitializeSetup(): Boolean;
var
  Release: Cardinal;
begin
  Result := RegQueryDWordValue(HKLM, 'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full', 'Release', Release) and (Release >= 528040);
  if not Result then
    SuppressibleMsgBox('此电脑需要 .NET Framework 4.8。请先通过 Windows 更新安装该组件，再运行 QuizForge 安装程序。', mbError, MB_OK, IDOK);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  AppDir: String;
  Entries: TFindRec;
begin
  Result := '';
  AppDir := ExpandConstant('{app}');
  if DirExists(AppDir + '\.state') or DirExists(AppDir + '\question-banks') or DirExists(AppDir + '\extensions') then
  begin
    Result := '此目录含有题库或用户数据，不能用作安装目录。请选择空目录；旧解压版不会自动迁移或删除。';
    Exit;
  end;
  if not FileExists(AppDir + '\INSTALLATION.json') and DirExists(AppDir) then
    if FindFirst(AppDir + '\*', Entries) then
    begin
      try
        repeat
          if (Entries.Name <> '.') and (Entries.Name <> '..') then
          begin
            Result := '安装目录不是空目录，也不是已有的安装版 QuizForge。请使用默认安装位置或指定一个空目录。';
            Exit;
          end;
        until not FindNext(Entries);
      finally
        FindClose(Entries);
      end;
    end;
end;
