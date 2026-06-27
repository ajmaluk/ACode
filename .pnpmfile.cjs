/**
 * pnpm hook: override monaco-editor's pinned dompurify@3.2.7 to a patched version.
 * monaco-editor@0.55.1 pins dompurify to exactly "3.2.7" (not a range),
 * so pnpm.overrides cannot redirect it. This hook modifies the manifest
 * at install time to use a semver range instead.
 */
function readPackage(pkg) {
  if (pkg.name === "monaco-editor" && pkg.dependencies?.dompurify === "3.2.7") {
    pkg.dependencies.dompurify = "^3.4.11";
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
