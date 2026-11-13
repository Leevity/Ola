// Evidence probe for Phase 2.2: does getDisplayMedia work without a user gesture,
// and does Main's handler honour the requested display? Unattended capture starts
// from an effect with no click behind it, so a transient-activation requirement
// would silently break it. Run: electron docs/qa/2026-11-12-display-capture-probe.mjs <out.json>
import { app, BrowserWindow, desktopCapturer, screen, session, systemPreferences } from 'electron'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const outPath = process.argv[2]
const result = {
  platform: process.platform,
  screenPermission:
    process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'n/a',
  displays: [],
  attempts: []
}

let requestedDisplayId = null

const captureAllowed = (permission) => permission === 'media' || permission === 'display-capture'

app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

app
  .whenReady()
  .then(async () => {
    session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
      captureAllowed(permission)
    )
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(captureAllowed(permission))
    )
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      void desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const primaryDisplayId = String(screen.getPrimaryDisplay().id)
          const selected =
            sources.find((source) => source.display_id === requestedDisplayId) ??
            sources.find((source) => source.display_id === primaryDisplayId) ??
            sources[0]
          result.attempts.push({
            step: 'handler',
            requestedDisplayId,
            grantedDisplayId: selected?.display_id ?? null,
            sourceCount: sources.length
          })
          callback(selected ? { video: selected } : {})
        })
        .catch((error) => {
          result.attempts.push({ step: 'handler-error', message: String(error) })
          callback({})
        })
    })

    let sources = []
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 }
      })
    } catch (error) {
      // TCC denial lands here. Keep going: the renderer's error message still
      // distinguishes "no screen recording grant" from "needs a user gesture".
      result.attempts.push({ step: 'getSources', ok: false, message: String(error) })
    }
    const primaryDisplayId = String(screen.getPrimaryDisplay().id)
    result.displays = screen.getAllDisplays().map((display) => ({
      id: String(display.id),
      primary: String(display.id) === primaryDisplayId,
      bounds: display.bounds,
      scaleFactor: display.scaleFactor
    }))

    const dir = mkdtempSync(join(tmpdir(), 'ola-capture-probe-'))
    const page = join(dir, 'probe.html')
    writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>capture probe</title>')
    const win = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    })
    await win.loadFile(page)

    const run = (label, js) =>
      win.webContents
        .executeJavaScript(js, true)
        .then((value) => result.attempts.push({ step: label, ...value }))
        .catch((error) => result.attempts.push({ step: label, ok: false, message: String(error) }))

    // No click, no key press: exactly the situation unattended capture is in.
    const displayMediaJs = `(async () => {
    if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
      return { ok: false, reason: 'getDisplayMedia unavailable' }
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      const track = stream.getVideoTracks()[0]
      const settings = track ? track.getSettings() : {}
      const info = { ok: true, width: settings.width ?? null, height: settings.height ?? null,
                     label: track ? track.label : null, displaySurface: settings.displaySurface ?? null }
      stream.getTracks().forEach((t) => t.stop())
      return info
    } catch (error) {
      return { ok: false, name: error.name, message: error.message }
    }
  })()`

    const targets = [primaryDisplayId]
    const secondary = result.displays.find((display) => !display.primary)
    if (secondary) targets.push(secondary.id)

    for (const displayId of targets) {
      requestedDisplayId = displayId
      await run(`getDisplayMedia:${displayId}`, displayMediaJs)
    }

    requestedDisplayId = null
    const legacySource =
      sources.find((source) => source.display_id === primaryDisplayId) ?? sources[0]
    if (legacySource) {
      await run(
        'legacy getUserMedia',
        `(async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { mandatory: { chromeMediaSource: 'desktop',
                     chromeMediaSourceId: ${JSON.stringify(legacySource.id)} } },
            audio: false
          })
          const track = stream.getVideoTracks()[0]
          const settings = track ? track.getSettings() : {}
          const info = { ok: true, width: settings.width ?? null, height: settings.height ?? null }
          stream.getTracks().forEach((t) => t.stop())
          return info
        } catch (error) {
          return { ok: false, name: error.name, message: error.message }
        }
      })()`
      )
    }

    // A display id that no longer exists must fall back to primary, not hang.
    requestedDisplayId = 'display-that-does-not-exist'
    await run('getDisplayMedia:stale-id', displayMediaJs)

    if (outPath) writeFileSync(outPath, JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
    win.destroy()
    app.quit()
  })
  .catch((error) => {
    result.attempts.push({ step: 'fatal', ok: false, message: String(error) })
    if (outPath) writeFileSync(outPath, JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
    app.exit(1)
  })

setTimeout(() => {
  result.attempts.push({ step: 'timeout', ok: false })
  if (outPath) writeFileSync(outPath, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  app.exit(1)
}, 25000)
