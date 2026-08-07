; Uninstalling must leave nothing behind — but the leftovers here are the household's ENTIRE
; archive (bundled database, receipt photos, the Tailscale node's keys), and "I only wanted to
; reinstall" is a very ordinary reason to run an uninstaller. So we remove everything, and ask once
; before doing so. Saying no leaves the data in place and a fresh install picks it straight back up.
;
; electron-builder's own `deleteAppDataOnUninstall` would do this unconditionally and silently;
; that is the same switch minus the question.
!macro customUnInstall
  ${ifNot} ${isUpdated}          ; an in-place update also runs the uninstaller — never touch data there
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Auch alle Daten löschen?$\r$\n$\r$\nDas entfernt die Datenbank mit allen Belegen, die gespeicherten Fotos und die Verbindungs-Einstellungen unwiderruflich.$\r$\n$\r$\nNein = Daten behalten (eine Neuinstallation findet sie wieder)." \
      /SD IDNO IDNO keepData
      RMDir /r "$APPDATA\vorratsdatenspeicher-desktop"
      RMDir /r "$LOCALAPPDATA\vorratsdatenspeicher-desktop"
    keepData:
  ${endIf}
!macroend
