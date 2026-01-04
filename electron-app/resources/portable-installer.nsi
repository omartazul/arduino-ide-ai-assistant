!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"

!ifndef GWL_STYLE
  !define GWL_STYLE -16
!endif
!ifndef SS_CENTER
  !define SS_CENTER 0x00000001
!endif

!define PRODUCT_NAME "Arduino IDE AI Assistant"
!define PORTABLE_ROOT_FOLDER "Arduino-IDE-AI-Assistant"
!define GITHUB_URL "https://github.com/omartazul"
!define AUTHOR_NAME "Tazul Islam"

Name "${PRODUCT_NAME} (Portable)"
OutFile "${OUTPUT_EXE}"

; Portable installer must not request elevation.
RequestExecutionLevel user

; Replace the default "Nullsoft Install System vX.Y" footer.
BrandingText "${PRODUCT_NAME} (Portable)"

; User selects a destination (we create Arduino-IDE-AI-Assistant under it)
InstallDir "$DOCUMENTS"

; Branding
!define MUI_ICON "${__FILEDIR__}\\icon.ico"
!define MUI_UNICON "${__FILEDIR__}\\icon.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${__FILEDIR__}\\installerSidebar.bmp"
!define MUI_ABORTWARNING

; Simple UI: destination + progress
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${__FILEDIR__}\\eula.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
Page custom PortableFinishPageCreate
!insertmacro MUI_LANGUAGE "English"

Var Dialog
Var AvatarImage
Var AvatarHandle
Var AuthorLabel
Var GitHubButton
Var InstalledOk

Section "Install"
  StrCpy $0 "$INSTDIR\\${PORTABLE_ROOT_FOLDER}"

  CreateDirectory "$0"
  CreateDirectory "$0\\Application"
  CreateDirectory "$0\\Configuration"
  CreateDirectory "$0\\Data"
  CreateDirectory "$0\\Sketchbook"

  SetOutPath "$0\\Application"
  File /r "${APP_UNPACKED_DIR}\\*.*"
SectionEnd

Function .onInit
  InitPluginsDir
  ; Extract avatar image used by the custom finish page.
  File /oname=$PLUGINSDIR\\avatar.bmp "${__FILEDIR__}\\avatar.bmp"
FunctionEnd

Function PortableFinishPageCreate
  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}

  ; Use Dialog Units (DLUs) for perfect alignment with the wizard frame (300u width).
  ; This ensures the layout is centered regardless of screen resolution or scaling.

  ; --- Avatar ---
  ; Size: 80u x 75u (80u width approx 120px, 75u height approx 120px)
  ; This accounts for non-square Dialog Units to create a perfect square box.
  ; X: (300 - 80) / 2 = 110u
  ; Y: 6u
  ${NSD_CreateBitmap} 110u 6u 80u 75u ""
  Pop $AvatarImage
  ${NSD_SetImage} $AvatarImage "$PLUGINSDIR\\avatar.bmp" $AvatarHandle

  ; --- Name Label ---
  ; X: 0u
  ; Y: 6u + 75u + 10u (Gap 1) = 91u
  nsDialogs::CreateControl STATIC "${WS_CHILD}|${WS_VISIBLE}|${SS_CENTER}" ${__NSD_Label_EXSTYLE} 0u 91u 300u 15u "${AUTHOR_NAME}"
  Pop $AuthorLabel
  
  ; Font: Segoe UI, 12pt, Bold
  CreateFont $R9 "Segoe UI" 12 700
  SendMessage $AuthorLabel ${WM_SETFONT} $R9 1

  ; --- GitHub Button ---
  ; X: (300 - 90) / 2 = 105u
  ; Y: 91u + 15u + 10u (Gap 2) = 116u
  ${NSD_CreateButton} 105u 116u 90u 18u "Visit my GitHub"
  Pop $GitHubButton
  ${NSD_OnClick} $GitHubButton OnGitHubClick

  nsDialogs::Show
FunctionEnd

Function .onInstSuccess
  StrCpy $InstalledOk 1
FunctionEnd

Function OnGitHubClick
  ExecShell "open" "${GITHUB_URL}"
FunctionEnd

Function .onGUIEnd
  ; After the installer closes, open the installed portable folder (success only).
  ${If} $InstalledOk == 1
    ExecShell "open" "$INSTDIR\\${PORTABLE_ROOT_FOLDER}"
  ${EndIf}
FunctionEnd
