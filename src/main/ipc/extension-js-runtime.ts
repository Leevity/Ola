type ExtensionJsExecutionResult = {
  success: boolean
  content?: string
  error?: string
}

// JavaScript extension packages are retained as metadata for migration only.
// Do not add a Node vm-based fallback here: node:vm is not a security boundary.
export async function executeJsExtensionToolInMain(
  _rawParams: unknown
): Promise<ExtensionJsExecutionResult> {
  return {
    success: false,
    error:
      'JavaScript extensions are quarantined pending migration to the isolated extension runtime.'
  }
}
