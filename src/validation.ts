/**
 * Validate an artifact name.
 *
 * @param name - The artifact name.
 */
export function validateArtifactName(name: string) {
  const byteLength = Buffer.byteLength(name, 'utf8')

  if (byteLength > 1024) {
    throw Error('Artifact name is too long.')
  }
}
