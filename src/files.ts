import { join, resolve } from 'path'
import { stat } from 'fs/promises'

import * as glob from '@actions/glob'


export type FileEntry = {
  filepath: string
  size: number
}

export type ArtifactStats = {
  entries: FileEntry[]
  size: number
  count: number
}


/**
 * Retrieve stats for file(s) in provided artifact path.
 *
 * @param fileOrDirectory - The artifact path.
 * @param ignorePaths 
 */
export async function getLocalArtifactStats(fileOrDirectory: string, ignorePaths?: string[]): Promise<ArtifactStats> {
  const inputStats = await stat(fileOrDirectory)

  let entries: FileEntry[]
  let size: number
  let count: number

  if (inputStats.isDirectory()) {
    const includePath = join(fileOrDirectory, '**', '*')

    const globPaths = [includePath]

    if (ignorePaths) {
      globPaths.push(...ignorePaths.map((path) => `!${join(fileOrDirectory, path)}`))
    }

    debugger

    const globPath = globPaths.join('\n')

    const globber = await glob.create(globPath)
    const files = await globber.glob()

    const fileEntries: FileEntry[] = []

    await Promise.all(files.map(async (file) => {
      const stats = await stat(file)
      if (stats.isFile()) {

        fileEntries.push({
          filepath: resolve(file),
          size: stats.size,
        })
      }
    }))

    entries = fileEntries
    size = entries.reduce((i, { size }) => i + size, 0)
    count = entries.length

  } else {
    entries = [{
      filepath: resolve(fileOrDirectory),
      size: inputStats.size,
    }]
    size = inputStats.size
    count = 1
  }

  return { entries, size, count }
}
