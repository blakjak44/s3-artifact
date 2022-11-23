import { dirname, resolve, normalize, sep, join } from 'path'
import { stat } from 'fs/promises'

import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import * as core from '@actions/core'
import * as glob from '@actions/glob'


export type FileEntry = {
  filepath: string
  size: number
}

export type LocalArtifactStats = {
  root: string
  entries: FileEntry[]
  size: number
  count: number
}

export type S3FileEntry = {
  Key?: string
  LastModified?: Date
  ETag?: string
  Size?: number
  StorageClass?: string
}

export type RemoteArtifactStats = {
  entries: S3FileEntry[]
  count: number
}


/** Taken from: https://github.com/actions/upload-artifact/blob/main/src/search.ts **/
/**
 * If multiple paths are specific, the least common ancestor (LCA) of the search paths is used as
 * the delimiter to control the directory structure for the artifact. This function returns the LCA
 * when given an array of search paths
 *
 * Example 1: The patterns `/foo/` and `/bar/` returns `/`
 *
 * Example 2: The patterns `~/foo/bar/*` and `~/foo/voo/two/*` and `~/foo/mo/` returns `~/foo`
 */
function getMultiPathLCA(searchPaths: string[]): string {
  if (searchPaths.length < 2) {
    throw new Error('At least two search paths must be provided')
  }

  const commonPaths = new Array<string>()
  const splitPaths = new Array<string[]>()
  let smallestPathLength = Number.MAX_SAFE_INTEGER

  // split each of the search paths using the platform specific separator
  for (const searchPath of searchPaths) {
    core.debug(`Using search path ${searchPath}`)

    const splitSearchPath = normalize(searchPath).split(sep)

    // keep track of the smallest path length so that we don't accidentally later go out of bounds
    smallestPathLength = Math.min(smallestPathLength, splitSearchPath.length)
    splitPaths.push(splitSearchPath)
  }

  // on Unix-like file systems, the file separator exists at the beginning of the file path, make sure to preserve it
  if (searchPaths[0].startsWith(sep)) {
    commonPaths.push(sep)
  }

  let splitIndex = 0
  // function to check if the paths are the same at a specific index
  function isPathTheSame(): boolean {
    const compare = splitPaths[0][splitIndex]
    for (let i = 1; i < splitPaths.length; i++) {
      if (compare !== splitPaths[i][splitIndex]) {
        // a non-common index has been reached
        return false
      }
    }
    return true
  }

  // loop over all the search paths until there is a non-common ancestor or we go out of bounds
  while (splitIndex < smallestPathLength) {
    if (!isPathTheSame()) {
      break
    }
    // if all are the same, add to the end result & increment the index
    commonPaths.push(splitPaths[0][splitIndex])
    splitIndex++
  }
  return join(...commonPaths)
}


/**
 * Gather stats for local artifact file(s).
 *
 * @param path - Array of glob patterns joined by newlines.
 */
export async function getLocalArtifactStats(path: string): Promise<LocalArtifactStats> {
  const entries: FileEntry[] = []
  let totalSize = 0

  const globber = await glob.create(path)
  const files = await globber.glob()

  for (const file of files) {
    const stats = await stat(file)

    if (stats.isFile()) {
      const filepath = resolve(file)
      const { size } = stats
      totalSize += size
      entries.push({ filepath, size })
    }
  }

  if (!entries.length) {
    throw Error('No files found within artifact path(s).')
  }

  /** Taken and modified from: https://github.com/actions/upload-artifact/blob/main/src/search.ts **/
  // Calculate the root directory for the artifact using the search paths that were utilized
  const searchPaths: string[] = globber.getSearchPaths()

  if (searchPaths.length > 1) {
    core.info(
      `Multiple search paths detected. Calculating the least common ancestor of all paths`
    )
    const lcaSearchPath = getMultiPathLCA(searchPaths)
    core.info(
      `The least common ancestor is ${lcaSearchPath}. This will be the root directory of the artifact`
    )

    return {
      root: lcaSearchPath,
      entries,
      count: entries.length,
      size: totalSize,
    }
  }

  /*
    Special case for a single file artifact that is uploaded without a directory or wildcard pattern. The directory structure is
    not preserved and the root directory will be the single files parent directory
  */
  if (files.length === 1 && searchPaths[0] === files[0]) {
    return {
      root: dirname(files[0]),
      entries,
      count: entries.length,
      size: totalSize,
    }
  }

  return {
    root: files[0],
    entries,
    count: entries.length,
    size: totalSize,
  }
}


/**
 * Retrieve stats for remote files in existing artifact.
 */
export async function getRemoteArtifactStats(client: S3Client, bucket: string, artifactPath: string): Promise<RemoteArtifactStats> {
  const entries = []

  const list = new ListObjectsV2Command({ Bucket: bucket, Prefix: artifactPath })

  for (;;) {
    const response = await client.send(list)

    const { Contents, NextContinuationToken } = response

    if (!Contents) break

    entries.push(...Contents)

    if (!NextContinuationToken) break

    list.input.ContinuationToken = NextContinuationToken
  }

  return { entries, count: entries.length }
}


/**
 * Ensure path is S3 compatible.
 */
 export function toKey(path: string): string {
    return path.replace('\\', '/')
 }


/**
 * Ensure path is platform compatible.
 */
 export function toPlatformPath(key: string): string {
   if (process.platform === 'win32') {
     return key.replace('/', '\\')
   }
   return key
 }

