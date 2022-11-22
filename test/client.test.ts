import process from 'process'
import { rm, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { test, expect, afterEach } from '@jest/globals'

import { S3ArtifactClient } from '../src/client'
import { createFile } from './utils'

// Parameters
const region = 'us-west-2'
const accessKeyId = process.env.AWS_ACCESS_KEY_ID
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
const bucket = 'github-action-upload-test'
const name = 'upload-test'
const context = {
  repo: {
    owner: 'blakjak44',
    repo: 's3-upload-artifact',
  },
  runId: Math.round(Math.random() * 100),
}


//test('upload multifile run scope', async () => {
//  await createFile(`${artifactPath}/a.txt`, 100)
//  await createFile(`${artifactPath}/b.txt`, 150)
//  await createFile(`${artifactPath}/large.txt`, 100 * 1024 ** 2)
//  await createFile(`${artifactPath}/sub/a.txt`, 160)
//  await createFile(`${artifactPath}/sub/b.txt`, 100)
//  await createFile(`${artifactPath}/sub/large.txt`, 100 * 1024 ** 2)
//
//  await upload(
//    region,
//    bucket,
//    'run',
//    name,
//    artifactPath,
//    context,
//    accessKeyId,
//    secretAccessKey,
//  )
//})
//
//test('upload singlefile', async () => {
//  await createFile(singleFilePath, 100)
//
//  await upload(
//    region,
//    bucket,
//    'run',
//    name,
//    singleFilePath,
//    context,
//    accessKeyId,
//    secretAccessKey,
//  )
//
//  await unlink(singleFilePath)
//})

// test('upload real archive', async () => {
//   const client = new S3ArtifactClient(
//     region,
//     accessKeyId,
//     secretAccessKey,
//   )
// 
//   const ignore = [
//     'bundled',
//     'mac-arm64',
//   ]
// 
//   await client.upload(
//     bucket,
//     'global',
//     name,
//     'dist_electron/**/*.dylib',
//     context,
//     true,
//   )
// }, 500000)

test('download real archive', async () => {
  const client = new S3ArtifactClient(
    region,
    accessKeyId,
    secretAccessKey,
  )

  const result = await client.download(
    bucket,
    'global',
    name,
    'downloaded_artifact',
    context,
  )

  expect(result).not.toBeUndefined()
}, 500000)
