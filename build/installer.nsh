; electron-builder's default running-app check stops and eventually force-kills
; processes from the installation directory. EVB Viewer must finish its own
; save and worker shutdown pipeline, so upgrades wait or abort instead.
!macro customCheckAppRunning
  ${GetProcessInfo} 0 $pid $1 $2 $3 $4
  ${if} $3 != "${APP_EXECUTABLE_FILENAME}"
    StrCpy $R1 0

    evb_check_app_running:
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 == 0
        ${if} ${isUpdated}
          IntOp $R1 $R1 + 1
          IntCmp $R1 30 evb_update_app_still_running 0 evb_update_app_still_running
          Sleep 1000
          Goto evb_check_app_running

          evb_update_app_still_running:
            Abort '"${PRODUCT_NAME}" did not finish shutting down. The update was not installed.'
        ${else}
          ${if} ${Silent}
            Abort 'Close "${PRODUCT_NAME}" before installing this update.'
          ${else}
            MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
              'Close "${PRODUCT_NAME}", then choose Retry. The installer will not force-close the app because it may still be saving documents.' \
              IDRETRY evb_check_app_running
            Quit
          ${endIf}
        ${endIf}
      ${endIf}
  ${endIf}
!macroend

!macro customInstall
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\image\shell\EVBViewer.CombineToPdf" "" "Combine into PDF with EVB Viewer"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\image\shell\EVBViewer.CombineToPdf" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\image\shell\EVBViewer.CombineToPdf" "MultiSelectModel" "Player"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\image\shell\EVBViewer.CombineToPdf\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" %*'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\image\shell\EVBViewer.CombineToPdf"
!macroend
