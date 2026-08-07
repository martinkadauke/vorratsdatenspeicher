; Uninstalling must leave nothing behind — but the leftovers here are the household's ENTIRE
; archive (bundled database, receipt photos, the Tailscale node's keys), and "I only wanted to
; reinstall" is a very ordinary reason to run an uninstaller. So we remove everything, and ask once
; before doing so. Saying no leaves the data in place and a fresh install picks it straight back up.
;
; electron-builder's own `deleteAppDataOnUninstall` would do this unconditionally and silently;
; that is the same switch minus the question.
!macro customUnInstall
  ; ⚠️ An in-place update runs the uninstaller too — ${isUpdated} is how electron-builder's own
  ; deleteAppDataOnUninstall tells the two apart, and getting it wrong would wipe a household's
  ; archive on a routine update. /SD IDNO makes a SILENT uninstall keep the data: unattended means
  ; nobody is there to answer, and the safe answer to an unasked question is "don't delete".
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Auch alle Daten löschen?$\r$\n$\r$\nDas entfernt die Datenbank mit allen Belegen, die gespeicherten Fotos und die Verbindungs-Einstellungen unwiderruflich.$\r$\n$\r$\nNein = Daten behalten (eine Neuinstallation findet sie wieder)." \
      /SD IDNO IDNO keepData
      ; APP_PACKAGE_NAME is package.json's `name` — the same string app.setName() pins, so this
      ; cannot drift apart from the directory Electron actually writes to.
      !ifdef APP_PACKAGE_NAME
        RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
        RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}"
      !endif
    keepData:
  ${endIf}
!macroend
