/** Reject an unsafe embedded runtime before a release build changes files. */
export function assertSecureNode(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (
    !match ||
    Number(match[1]) !== 24 ||
    Number(match[2]) < 22 ||
    (Number(match[2]) === 22 && Number(match[3]) < 1)
  ) {
    throw new Error(`Release builds require Node.js >=24.22.1 <25.0.0; received ${version}`);
  }
}
