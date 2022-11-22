import { resolve } from 'path'
import { stat } from 'fs/promises'

import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import * as glob from '@actions/glob'


export type FileEntry = {
  filepath: string
  size: number
}

export type LocalArtifactStats = {
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

  return { entries, count: entries.length, size: totalSize }
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
