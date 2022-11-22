import { existsSync } from 'fs'
import { readdir, stat } from 'fs/promises'

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


/**
 * Validate an artifact path.
 *
 * @param path - The artifact name.
 */
export async function validateArtifactPath(path: string) {
  if (!existsSync(path)) {
    throw Error('Artifact path does not exist.')
  }

  const stats = await stat(path)

  if (stats.isDirectory()) {
    if (!(await readdir(path)).length) {
      throw Error('Artifact path is an empty directory.')
    }
  }
}
