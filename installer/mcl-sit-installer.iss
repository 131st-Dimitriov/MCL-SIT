;; ============================================================================
;; MCL-SIT — Inno Setup installer
;; ============================================================================
;; Prerequis : avoir lance `npm run build:installer` AVANT de compiler ce .iss
;;   -> ca genere dist\win-unpacked\ qui contient l'app Electron deja packagee
;;
;; Compilation :
;;   Ouvrir ce fichier dans Inno Setup Compiler (https://jrsoftware.org/isdl.php)
;;   Appuyer sur F9 (Build)
;;   Le setup final est ecrit dans installer\output\MCL-SIT-Setup-X.Y.Z.exe
;; ============================================================================

#define AppName "MCL-SIT"
#define AppVersion "17.0.0"
#define AppPublisher "131st-Dimitriov"
#define AppExeName "MCL-SIT.exe"
#define SourceDir "..\dist\win-unpacked"
#define HookSourceFile "..\src\lua\SIT_WorldHook.lua"

[Setup]
AppId={{A4F3B280-9C2E-4D8F-B6D1-7E5A0F1C2E3D}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL=https://github.com/131st-Dimitriov/mcl-sit
AppSupportURL=https://github.com/131st-Dimitriov/mcl-sit/issues
AppUpdatesURL=https://github.com/131st-Dimitriov/mcl-sit/releases
DefaultDirName={localappdata}\Programs\MCL-SIT
DefaultGroupName=MCL-SIT
DisableProgramGroupPage=auto
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=output
OutputBaseFilename=MCL-SIT-Setup-{#AppVersion}
SetupIconFile=..\build\icon.ico
UninstallDisplayIcon={app}\{#AppExeName}
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64
ArchitecturesAllowed=x64

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
french.WelcomeLabel2=Cet assistant va installer [name/ver] sur votre ordinateur.%n%nMCL-SIT est un Système d'Information Tactique pour DCS World.%n%nL'installation va :%n  • Installer l'application dans votre dossier utilisateur (pas besoin d'admin)%n  • Copier le hook DCS (script Lua) dans le dossier Saved Games de votre choix%n  • Ajouter une règle de pare-feu pour le port SIT 5026 (TCP/UDP)%n  • Créer raccourcis bureau et menu Démarrer%n%nIl est recommandé de fermer DCS World avant de continuer.
english.WelcomeLabel2=This wizard will install [name/ver] on your computer.%n%nMCL-SIT is a Tactical Information System for DCS World.%n%nThe installer will:%n  • Install the application in your user folder (no admin needed)%n  • Copy the DCS hook (Lua script) into the Saved Games folder of your choice%n  • Add a firewall rule for the SIT port 5026 (TCP/UDP)%n  • Create desktop and Start menu shortcuts%n%nIt is recommended to close DCS World before continuing.

french.DCSPagePrompt=Sélectionnez les installations DCS sur lesquelles installer le hook
french.DCSPageDesc=Le hook est un petit script Lua qui permet la communication entre DCS et MCL-SIT.
french.DCSPageInfo=Cochez les installations DCS pour lesquelles vous voulez installer le hook. Vous pouvez n'en cocher aucune (par exemple sur un PC client seul sans DCS), ou les deux (PC avec DCS classique ET DCS serveur dédié).%n%nLe sous-dossier Scripts\Hooks\ sera créé automatiquement.
french.DCSClassiqueCheck=Installation DCS classique (Saved Games\DCS ou DCS.openbeta)
french.DCSClassiqueFolder=Dossier :
french.DCSServerCheck=Installation DCS Dedicated Server (Saved Games\DCS_Serverrelease)
french.DCSServerFolder=Dossier :

french.NodePageTitle=Information technique
french.NodePageDesc=Communication réseau et pare-feu
french.NodePageInfo=MCL-SIT utilise Node.js (intégré à l'application — aucune installation séparée nécessaire) pour faire transiter les données entre votre client SIT et le serveur SIT sur un réseau local fermé.%n%nLes ports utilisés sont :%n  • 5026 (TCP) — communication client SIT ↔ serveur SIT%n  • 9089 (UDP) — communication hook DCS → serveur SIT%n%nAucune donnée n'est transmise sur Internet (sauf vérification de mises à jour de MCL-SIT lui-même).
french.NodeAddFirewall=Ajouter automatiquement une règle de pare-feu Windows pour le port 5026 (recommandé)

french.FirewallNote=Note : Si vous rencontrez des problèmes de connexion entre clients SIT sur votre réseau ou via Internet, vous devrez peut-être également ouvrir le port 5026 (TCP/UDP) dans votre box Internet et/ou dans votre antivirus.

[Files]
; All Electron app files
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Lua hook — copied at install time into the DCS folder chosen by the user
Source: "{#HookSourceFile}"; DestDir: "{tmp}"; Flags: deleteafterinstall

[Icons]
Name: "{group}\MCL-SIT"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\{#AppExeName}"
Name: "{group}\Désinstaller MCL-SIT"; Filename: "{uninstallexe}"
Name: "{userdesktop}\MCL-SIT"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Lancer MCL-SIT"; Flags: nowait postinstall skipifsilent

;; ============================================================================
;; UninstallRun: remove firewall rule on uninstall
;; ============================================================================
[UninstallRun]
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""MCL-SIT SIT (TCP 5026)"""; Flags: runhidden
Filename: "netsh"; Parameters: "advfirewall firewall delete rule name=""MCL-SIT SIT (UDP 5026)"""; Flags: runhidden

;; ============================================================================
;; Pascal scripting: custom page for DCS folder + firewall toggle + hook copy
;; ============================================================================
[Code]
var
  DCSPage: TWizardPage;
  CkClassique, CkServer: TNewCheckBox;
  EdClassique, EdServer: TNewEdit;
  BtnBrowseClassique, BtnBrowseServer: TNewButton;
  NodePage: TWizardPage;
  AddFirewallCheck: TNewCheckBox;

procedure BrowseClassiqueClick(Sender: TObject);
var
  Dir: String;
begin
  Dir := EdClassique.Text;
  if Dir = '' then Dir := ExpandConstant('{userdocs}\..\Saved Games');
  if BrowseForFolder('Sélectionnez le dossier Saved Games\DCS classique', Dir, True) then
    EdClassique.Text := Dir;
end;

procedure BrowseServerClick(Sender: TObject);
var
  Dir: String;
begin
  Dir := EdServer.Text;
  if Dir = '' then Dir := ExpandConstant('{userdocs}\..\Saved Games');
  if BrowseForFolder('Sélectionnez le dossier Saved Games\DCS_Serverrelease', Dir, True) then
    EdServer.Text := Dir;
end;

procedure ClassiqueCheckClick(Sender: TObject);
begin
  EdClassique.Enabled := CkClassique.Checked;
  BtnBrowseClassique.Enabled := CkClassique.Checked;
end;

procedure ServerCheckClick(Sender: TObject);
begin
  EdServer.Enabled := CkServer.Checked;
  BtnBrowseServer.Enabled := CkServer.Checked;
end;

procedure InitializeWizard;
var
  InfoLabel: TNewStaticText;
  PageInfo: TNewStaticText;
  AutoCl, AutoSr: String;
begin
  // ============================================================
  // Custom page 1 — DCS folder selection (2 separate checkboxes)
  // ============================================================
  DCSPage := CreateCustomPage(wpSelectDir,
    ExpandConstant('{cm:DCSPagePrompt}'),
    ExpandConstant('{cm:DCSPageDesc}'));

  PageInfo := TNewStaticText.Create(DCSPage);
  PageInfo.Parent := DCSPage.Surface;
  PageInfo.Caption := ExpandConstant('{cm:DCSPageInfo}');
  PageInfo.AutoSize := False;
  PageInfo.WordWrap := True;
  PageInfo.Left := 0;
  PageInfo.Top := 0;
  PageInfo.Width := DCSPage.SurfaceWidth;
  PageInfo.Height := ScaleY(70);

  // Auto-detect classical DCS install
  AutoCl := '';
  if DirExists(ExpandConstant('{userdocs}\..\Saved Games\DCS.openbeta')) then
    AutoCl := ExpandConstant('{userdocs}\..\Saved Games\DCS.openbeta')
  else if DirExists(ExpandConstant('{userdocs}\..\Saved Games\DCS')) then
    AutoCl := ExpandConstant('{userdocs}\..\Saved Games\DCS');

  // Auto-detect dedicated server install
  AutoSr := '';
  if DirExists(ExpandConstant('{userdocs}\..\Saved Games\DCS_Serverrelease')) then
    AutoSr := ExpandConstant('{userdocs}\..\Saved Games\DCS_Serverrelease');

  // --- Classique block ---
  CkClassique := TNewCheckBox.Create(DCSPage);
  CkClassique.Parent := DCSPage.Surface;
  CkClassique.Left := 0;
  CkClassique.Top := PageInfo.Top + PageInfo.Height + ScaleY(10);
  CkClassique.Width := DCSPage.SurfaceWidth;
  CkClassique.Height := ScaleY(20);
  CkClassique.Caption := ExpandConstant('{cm:DCSClassiqueCheck}');
  CkClassique.Checked := (AutoCl <> '');
  CkClassique.OnClick := @ClassiqueCheckClick;

  EdClassique := TNewEdit.Create(DCSPage);
  EdClassique.Parent := DCSPage.Surface;
  EdClassique.Left := ScaleX(20);
  EdClassique.Top := CkClassique.Top + CkClassique.Height + ScaleY(2);
  EdClassique.Width := DCSPage.SurfaceWidth - ScaleX(110);
  EdClassique.Height := ScaleY(23);
  EdClassique.Text := AutoCl;
  EdClassique.Enabled := CkClassique.Checked;

  BtnBrowseClassique := TNewButton.Create(DCSPage);
  BtnBrowseClassique.Parent := DCSPage.Surface;
  BtnBrowseClassique.Left := DCSPage.SurfaceWidth - ScaleX(85);
  BtnBrowseClassique.Top := EdClassique.Top - ScaleY(1);
  BtnBrowseClassique.Width := ScaleX(85);
  BtnBrowseClassique.Height := ScaleY(25);
  BtnBrowseClassique.Caption := '&Parcourir...';
  BtnBrowseClassique.OnClick := @BrowseClassiqueClick;
  BtnBrowseClassique.Enabled := CkClassique.Checked;

  // --- Dedicated Server block ---
  CkServer := TNewCheckBox.Create(DCSPage);
  CkServer.Parent := DCSPage.Surface;
  CkServer.Left := 0;
  CkServer.Top := EdClassique.Top + EdClassique.Height + ScaleY(18);
  CkServer.Width := DCSPage.SurfaceWidth;
  CkServer.Height := ScaleY(20);
  CkServer.Caption := ExpandConstant('{cm:DCSServerCheck}');
  CkServer.Checked := (AutoSr <> '');
  CkServer.OnClick := @ServerCheckClick;

  EdServer := TNewEdit.Create(DCSPage);
  EdServer.Parent := DCSPage.Surface;
  EdServer.Left := ScaleX(20);
  EdServer.Top := CkServer.Top + CkServer.Height + ScaleY(2);
  EdServer.Width := DCSPage.SurfaceWidth - ScaleX(110);
  EdServer.Height := ScaleY(23);
  EdServer.Text := AutoSr;
  EdServer.Enabled := CkServer.Checked;

  BtnBrowseServer := TNewButton.Create(DCSPage);
  BtnBrowseServer.Parent := DCSPage.Surface;
  BtnBrowseServer.Left := DCSPage.SurfaceWidth - ScaleX(85);
  BtnBrowseServer.Top := EdServer.Top - ScaleY(1);
  BtnBrowseServer.Width := ScaleX(85);
  BtnBrowseServer.Height := ScaleY(25);
  BtnBrowseServer.Caption := '&Parcourir...';
  BtnBrowseServer.OnClick := @BrowseServerClick;
  BtnBrowseServer.Enabled := CkServer.Checked;

  // ============================================================
  // Custom page 2 — Node + firewall info
  // ============================================================
  NodePage := CreateCustomPage(DCSPage.ID,
    ExpandConstant('{cm:NodePageTitle}'),
    ExpandConstant('{cm:NodePageDesc}'));

  InfoLabel := TNewStaticText.Create(NodePage);
  InfoLabel.Parent := NodePage.Surface;
  InfoLabel.Caption := ExpandConstant('{cm:NodePageInfo}');
  InfoLabel.AutoSize := False;
  InfoLabel.WordWrap := True;
  InfoLabel.Left := 0;
  InfoLabel.Top := 0;
  InfoLabel.Width := NodePage.SurfaceWidth;
  InfoLabel.Height := ScaleY(180);

  AddFirewallCheck := TNewCheckBox.Create(NodePage);
  AddFirewallCheck.Parent := NodePage.Surface;
  AddFirewallCheck.Left := 0;
  AddFirewallCheck.Top := InfoLabel.Top + InfoLabel.Height + ScaleY(12);
  AddFirewallCheck.Width := NodePage.SurfaceWidth;
  AddFirewallCheck.Height := ScaleY(40);
  AddFirewallCheck.Caption := ExpandConstant('{cm:NodeAddFirewall}');
  AddFirewallCheck.Checked := True;
end;

function ShouldAddFirewall(): Boolean;
begin
  Result := AddFirewallCheck.Checked;
end;

procedure InstallHookTo(DCSPath: String);
var
  HookDir, HookFile: String;
begin
  if Trim(DCSPath) = '' then exit;
  HookDir := DCSPath + '\Scripts\Hooks';
  HookFile := HookDir + '\SIT_WorldHook.lua';
  if not DirExists(HookDir) then begin
    if not ForceDirectories(HookDir) then begin
      MsgBox('Impossible de créer le dossier :' #13#10 + HookDir + #13#10 +
             'Le hook n''a pas été installé à cet emplacement.',
             mbError, MB_OK);
      exit;
    end;
  end;
  if not FileCopy(ExpandConstant('{tmp}\SIT_WorldHook.lua'), HookFile, False) then begin
    MsgBox('Impossible de copier le hook DCS vers :' #13#10 + HookFile,
           mbError, MB_OK);
  end;
end;

procedure InstallHooks();
begin
  if CkClassique.Checked then InstallHookTo(EdClassique.Text);
  if CkServer.Checked then InstallHookTo(EdServer.Text);
end;

procedure AddFirewallRules();
var
  ResultCode: Integer;
  ExePath: String;
begin
  ExePath := ExpandConstant('{app}\{#AppExeName}');
  Exec('netsh',
    'advfirewall firewall add rule name="MCL-SIT SIT (TCP 5026)" dir=in action=allow protocol=TCP localport=5026 program="' + ExePath + '" enable=yes',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('netsh',
    'advfirewall firewall add rule name="MCL-SIT SIT (UDP 5026)" dir=in action=allow protocol=UDP localport=5026 program="' + ExePath + '" enable=yes',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('netsh',
    'advfirewall firewall add rule name="MCL-SIT SIT (UDP 9089)" dir=in action=allow protocol=UDP localport=9089 program="' + ExePath + '" enable=yes',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure WriteHookPathsToConfig();
var
  ConfigDir, ConfigFile, Json: String;
  PathCl, PathSr: String;
begin
  ConfigDir := ExpandConstant('{userappdata}\MCL-SIT');
  if not DirExists(ConfigDir) then
    if not ForceDirectories(ConfigDir) then exit;
  ConfigFile := ConfigDir + '\config.json';
  PathCl := '';
  PathSr := '';
  if CkClassique.Checked and (Trim(EdClassique.Text) <> '') then begin
    PathCl := EdClassique.Text + '\Scripts\Hooks';
    StringChangeEx(PathCl, '\', '\\', True);
  end;
  if CkServer.Checked and (Trim(EdServer.Text) <> '') then begin
    PathSr := EdServer.Text + '\Scripts\Hooks';
    StringChangeEx(PathSr, '\', '\\', True);
  end;
  // dcsHookPath: kept for the app's hook-check (the classical install if present,
  // otherwise the server install). dcsHookPathServer is added for completeness.
  Json := '{' + #13#10;
  if PathCl <> '' then
    Json := Json + '  "dcsHookPath": "' + PathCl + '",' + #13#10
  else if PathSr <> '' then
    Json := Json + '  "dcsHookPath": "' + PathSr + '",' + #13#10;
  if PathSr <> '' then
    Json := Json + '  "dcsHookPathServer": "' + PathSr + '",' + #13#10;
  // Trailing comma cleanup (Inno's Pascal is limited — we strip the last comma)
  if (Length(Json) > 4) and (Json[Length(Json)-2] = ',') then
    Delete(Json, Length(Json)-2, 1);
  Json := Json + '}' + #13#10;
  SaveStringToFile(ConfigFile, Json, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    InstallHooks();
    WriteHookPathsToConfig();
    if AddFirewallCheck.Checked then AddFirewallRules();
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  HookFile: String;
begin
  if CurUninstallStep = usUninstall then begin
    // Always remove the DCS hook from known Saved Games locations.
    if DirExists(ExpandConstant('{userdocs}\..\Saved Games\DCS\Scripts\Hooks')) then begin
      HookFile := ExpandConstant('{userdocs}\..\Saved Games\DCS\Scripts\Hooks\SIT_WorldHook.lua');
      if FileExists(HookFile) then DeleteFile(HookFile);
    end;
    if DirExists(ExpandConstant('{userdocs}\..\Saved Games\DCS.openbeta\Scripts\Hooks')) then begin
      HookFile := ExpandConstant('{userdocs}\..\Saved Games\DCS.openbeta\Scripts\Hooks\SIT_WorldHook.lua');
      if FileExists(HookFile) then DeleteFile(HookFile);
    end;
    if DirExists(ExpandConstant('{userdocs}\..\Saved Games\DCS_Serverrelease\Scripts\Hooks')) then begin
      HookFile := ExpandConstant('{userdocs}\..\Saved Games\DCS_Serverrelease\Scripts\Hooks\SIT_WorldHook.lua');
      if FileExists(HookFile) then DeleteFile(HookFile);
    end;
  end;
  if CurUninstallStep = usPostUninstall then begin
    // Wipe user data unconditionally (per spec: clean uninstall)
    DelTree(ExpandConstant('{userappdata}\MCL-SIT'), True, True, True);
    // The {app} folder is normally cleaned by Inno itself, but DelTree as a final sweep
    // makes sure no leftover (logs, cached files) remains.
    DelTree(ExpandConstant('{app}'), True, True, True);
  end;
end;
end.
