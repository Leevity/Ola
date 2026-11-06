const path = require('node:path')
const { pathToFileURL } = require('node:url')

// Ad-hoc by default: a build without a certificate still has to produce a bundle whose nested
// executables carry a signature, because the release rules below are the same rules a Developer ID
// build runs. Setting the identity makes the nested binaries join the app's own signature.
const signingIdentity = process.env.OLA_MAC_CODESIGN_IDENTITY || '-'

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)

  if (!require('node:fs').existsSync(appPath)) {
    throw new Error(`Expected macOS app bundle not found: ${appPath}`)
  }

  const sign = await import(
    pathToFileURL(path.join(__dirname, '..', 'scripts', 'agent-desktop-mac-sign.mjs')).href
  )
  // Sign the bundled accessibility CLI before the bundle itself, so the outer signature covers the
  // nested ones and `--deep` cannot silently leave an unsigned Mach-O inside a notarized app.
  await sign.signAgentDesktopBinaries({
    appPath,
    executable: context.packager.appInfo.productFilename,
    identity: signingIdentity
  })

  const { execFileSync } = require('node:child_process')
  const runCodesign = (args) => execFileSync('codesign', args, { stdio: 'inherit' })

  // Normalize the whole bundle to one ad-hoc signature before packaging.
  // If a real certificate is configured, electron-builder will sign again later.
  runCodesign(['--force', '--deep', '--sign', signingIdentity, '--timestamp=none', appPath])
  runCodesign(['--verify', '--deep', '--strict', '--verbose=2', appPath])
  await sign.verifyAgentDesktopSignatures({
    appPath,
    executable: context.packager.appInfo.productFilename,
    requireSignature: signingIdentity !== '-'
  })
}
