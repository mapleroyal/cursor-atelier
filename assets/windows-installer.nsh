; Preserve one authoritative path while retaining the established executable name.
!undef APP_FILENAME
!define APP_FILENAME "Cursor Atelier"

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Install Cursor Atelier"
  !define MUI_WELCOMEPAGE_TEXT "Setup will install Cursor Atelier for your Windows account.$\r$\n$\r$\nClick Next to install Cursor Atelier."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro runSetupAction MODE
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\cursor-atelier-setup.ps1" -InstallDirectory "$INSTDIR" -Mode "${MODE}" -StateFile "$PLUGINSDIR\cursor-atelier-setup.json" -InstallerKey "${INSTALL_REGISTRY_KEY}" -UninstallKey "${UNINSTALL_REGISTRY_KEY}"'
  Pop $0
!macroend

!macro customHeader
  ShowInstDetails hide
  !ifndef BUILD_UNINSTALLER
    Section "-Preserve previous installation"
      InitPluginsDir
      File /oname=$PLUGINSDIR\cursor-atelier-setup.ps1 "${BUILD_RESOURCES_DIR}\windows-installer.ps1"
      SetDetailsPrint both
      DetailPrint "Preparing Cursor Atelier..."
      !insertmacro runSetupAction Prepare
      ${If} $0 != 0
        MessageBox MB_OK|MB_ICONSTOP "Cursor Atelier could not prepare the update. Open the installation details for the error. The earlier installation has been retained."
        Abort
      ${EndIf}
    SectionEnd

    Function .onInstFailed
      !insertmacro runSetupAction Rollback
      ${If} $0 != 0
        MessageBox MB_OK|MB_ICONSTOP "Setup could not restore the earlier installation. Its recovery copy remains beside the install folder."
      ${EndIf}
    FunctionEnd
  !endif
!macroend

!macro customInstall
  SetDetailsPrint both
  DetailPrint "Verifying Cursor Atelier and updating the previous installation..."
  !insertmacro runSetupAction Complete
  ${If} $0 == 2
    MessageBox MB_OK|MB_ICONEXCLAMATION "Cursor Atelier is installed. Cleanup of the earlier installer needs attention; the details above explain the error."
  ${ElseIf} $0 != 0
    !insertmacro runSetupAction Rollback
    MessageBox MB_OK|MB_ICONSTOP "Cursor Atelier could not complete installation. Open the installation details for the error. The previous installation has been restored."
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    InitPluginsDir
    File /oname=$PLUGINSDIR\cursor-atelier-setup.ps1 "${BUILD_RESOURCES_DIR}\windows-installer.ps1"
    !insertmacro runSetupAction Uninstall
  ${EndIf}
!macroend
