import { dirname, parse, relative, resolve } from 'path'
import { mkdir } from 'fs/promises'
import { createWriteStream } from 'fs'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream'
import { promisify } from 'util'
import zlib from 'zlib'

import * as core from '@actions/core'

import {
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  S3Client,
  ListPartsCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3"

import type { S3ClientConfig, CompletedPart } from "@aws-sdk/client-s3"

import {
  getLocalArtifactStats,
  getRemoteArtifactStats,
  toPlatformPath,
  toKey,
} from './files'

import { compressIfPossible } from './compression'
import { validateArtifactName } from './validation'
import { StatusReporter } from './status-reporter'
import { multipartThreshold, multipartChunksize } from './config'

import type { LocalArtifactStats, RemoteArtifactStats } from './files'
import type { CompressedSource} from './compression'

const pipe = promisify(pipeline)


export type GithubContext = {
  repo: {
    owner: string
    repo: string
  }
  runId: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}


type StreamPipeline = (NodeJS.ReadableStream | NodeJS.WritableStream | NodeJS.ReadWriteStream)[]


export class S3ArtifactClient {
  private _client: S3Client
  private _statusReporter: StatusReporter

  constructor(
    region?: string,
    accessKeyId?: string,
    secretAccessKey?: string,
  ) {
    const clientConfig: S3ClientConfig = {}

    if (region) {
      clientConfig.region = region
    }

    if (accessKeyId && secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId,
        secretAccessKey
      }
      core.debug('Using provided credentials.')
    } else if (accessKeyId === null) {
      core.warning(
        'AWS Access Key ID is required if providing an AWS Secret Access Key. '
        + 'Ignoring provided AWS Secret Access Key.'
      )
    } else if (secretAccessKey === null) {
      core.warning(
        'AWS Secret Access Key is required if providing an AWS Access Key ID. '
        + 'Ignoring provided AWS Access Key ID.'
      )
    }

    this._client = new S3Client(clientConfig)
    this._statusReporter = new StatusReporter(10000)
  }

  async download(
    bucket: string,
    scope: string,
    name: string,
    path: string,
    context: GithubContext,
  ): Promise<RemoteArtifactStats | undefined> {
    try {
      const { owner, repo } = context.repo

      const artifactPrefix = scope === 'global'
        ? `${owner}/${repo}/${name}`
        : `${owner}/${repo}/${context.runId}/${name}`

      // TODO - Validate artifact path
      // TODO - Validate extraction path

      const stats = await getRemoteArtifactStats(this._client, bucket, artifactPrefix)
      const { entries, count } = stats

      core.info(`Found artifact "${name}" with ${count} files.`)
      core.info('Starting download.')

      this._statusReporter.setTotalNumberOfFilesToProcess(count)
      this._statusReporter.start()

      for (const entry of entries) {
        if (!entry.Key) continue

        const relativePath = relative(artifactPrefix, entry.Key)

        const destPath = toPlatformPath(resolve(path, relativePath))
        const destDir = toPlatformPath(parse(destPath).dir)

        const get = new GetObjectCommand({
          Bucket: bucket,
          Key: entry.Key,
        })

        const response = await this._client.send(get)

        if (!response.Body) {
          throw Error(`No response body for file: ${relativePath}`)
        }

        await mkdir(destDir, { recursive: true })

        const destination = createWriteStream(destPath)

        const streams: StreamPipeline = [response.Body as NodeJS.ReadableStream]

        if (response.ContentEncoding === 'gzip') {
          streams.push(zlib.createGunzip())
        }

        streams.push(destination)

        core.debug(`Download pipeline: ${streams}`)

        await pipe(streams)

        core.debug(`Downloaded file: ${relativePath}`)

        this._statusReporter.incrementProcessedCount()
      }

      return stats
    } catch (err) {
      console.error(err)
    } finally {
      this._statusReporter.stop()
    }
  }

  async upload(
    bucket: string,
    scope: string,
    name: string,
    path: string,
    context: GithubContext,
    checksum = true,
  ): Promise<LocalArtifactStats | undefined> {
    try {
      const stats = await getLocalArtifactStats(path)
      const { root, entries, count } = stats

      core.info(`With the provided path, there will be ${count} files uploaded`)
      core.info('Starting artifact upload')

      validateArtifactName(name)

      core.info('Artifact name is valid!')

      // TODO - Validate bucket (e.g. exists and is writable)
      core.info(
        `Container for artifact "${name}" successfully created. `
        + 'Starting upload of file(s)'
      )

      const { owner, repo } = context.repo

      const artifactPrefix = scope === 'global'
        ? `${owner}/${repo}/${name}`
        : `${owner}/${repo}/${context.runId}/${name}`


      this._statusReporter.setTotalNumberOfFilesToProcess(count)
      this._statusReporter.start()

      for (const entry of entries) {
        const { filepath, size } = entry

        core.debug(`Processing file: ${filepath}`)

        const tempFilepath = filepath + '.artifact.gzip'
        const relativePath = relative(dirname(root), filepath)

        const key = toKey(`${artifactPrefix}/${relativePath}`)

        const uploadSource = await compressIfPossible(
          filepath,
          size,
          tempFilepath,
        )

        if (uploadSource.size > multipartThreshold) {
          await this._uploadMultipart(uploadSource, bucket, key, checksum)
        } else {
          await this._uploadSingle(uploadSource, bucket, key, checksum)
        }

        // Necessary to trigger auto cleanup of tempfile
        uploadSource.stream.close()

        this._statusReporter.incrementProcessedCount()
      }

      return stats
    } catch (error) {
      console.error(error)
    } finally {
      this._statusReporter.stop()
    }
  }

  async _uploadSingle(
    source: CompressedSource,
    bucket: string,
    key: string,
    checksum = true,
  ): Promise<void> {
    const { stream, encoding } = source

    return new Promise<void>((resolve, reject) => {
      const chunkBuffer: Buffer[] = []

      stream.on('data', (data) => { chunkBuffer.push(data as Buffer) })

      stream.on('end', async () => {
        try {
          const body = Buffer.concat(chunkBuffer)

          const sha256 = checksum
            ? createHash('sha256').update(body).digest('base64')
            : undefined

          const command = new PutObjectCommand({
            ContentEncoding: encoding,
            Bucket: bucket,
            Key: key,
            Body: body,
            ChecksumSHA256: sha256,
          })

          await this._client.send(command)

          resolve()
        } catch (err) {
          reject(err)
        }
      })

      stream.on('error', reject)
    })
  }

  // TODO - Parallelize
  async _uploadMultipart(
    source: CompressedSource,
    bucket: string,
    key: string,
    checksum = true,
  ): Promise<void> {
    const { filepath, stream, size, encoding } = source

    return new Promise<void>((resolve, reject) => {
      (async () => {
        const command = new CreateMultipartUploadCommand({
          ContentEncoding: encoding,
          Bucket: bucket,
          Key: key,
          ChecksumAlgorithm: 'sha256',
        })

        let response

        try {
          response = await this._client.send(command)
        } catch (err) {
          return reject(err)
        }

        const { UploadId } = response

        core.debug(`Multipart upload initiated with ID: ${UploadId}`)

        const multipartConfig = {
          UploadId,
          Bucket: bucket,
          Key: key,
        }

        let partNumber = 1
        let byteCount = 0
        let chunkByteCount = 0

        const chunkBuffer: Buffer[] = []
        const completedParts: CompletedPart[] = []

        const uploadPart = async (): Promise<void> => {
          if (!chunkBuffer.length) return

          try {
            stream.pause()

            const chunk = Buffer.concat(chunkBuffer)
            const { length } = chunk

            const sha256 = checksum
              ? createHash('sha256').update(chunk).digest('base64')
              : undefined

            const command = new UploadPartCommand({
              Body: chunk,
              ContentLength: length,
              PartNumber: partNumber,
              ChecksumSHA256: sha256,
              ...multipartConfig,
            })

            const { ETag } = await this._client.send(command)

            // TODO - Confirm whether ETag can be missing
            completedParts.push({ ETag: ETag!, PartNumber: partNumber++, ChecksumSHA256: sha256 })

            core.debug(`Uploaded part ETag: ${ETag}`)

            this._statusReporter.updateLargeFileStatus(
              filepath,
              byteCount,
              byteCount += length,
              size,
            )

            chunkByteCount = 0
            chunkBuffer.length = 0

            stream.resume()
          } catch (err) {
            return reject(err)
          }
        }

        stream.on('data', (data) => {
          chunkBuffer.push(data as Buffer)

          const { length } = data as Buffer
          chunkByteCount += length

          if (chunkByteCount >= multipartChunksize) {
            uploadPart()
          }
        })

        const abort = async (err: Error): Promise<void> => {
          const retryMax = 10
          let retry = 1

          const abort = new AbortMultipartUploadCommand(multipartConfig)
          const list = new ListPartsCommand(multipartConfig)

          try {
            for (;;) {
                await this._client.send(abort)

                const listResponse = await this._client.send(list)

                if (!listResponse.Parts || !listResponse.Parts.length) {
                  break
                } else if (++retry >= retryMax) {
                  throw Error(`Aborted upload part cleanup failed after ${retryMax} attempts.`)
                }

                // Wait for 1 second between retries
                await new Promise((res) => setTimeout(res, 1000))
            }
          } catch (err2) {
            console.error(err2)
            core.warning('Failed to properly abort multipart upload, manual cleanup may be required.')
            core.warning(`Multipart Upload Properties: ${JSON.stringify(multipartConfig)}`)
          } finally {
            reject(err)
          }
        }

        stream.on('end', async () => {
          try {
            if (chunkBuffer.length) {
              await uploadPart()
            }

            const complete = new CompleteMultipartUploadCommand({
              MultipartUpload: { Parts: completedParts },
              ...multipartConfig,
            })

            await this._client.send(complete)
          } catch (err) {
            core.error('Failed to complete multipart upload. Aborting.')
            abort(err as Error)
          }

          resolve()
        })

        stream.on('error', abort)
      })()
    })
  }
}
