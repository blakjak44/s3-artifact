import { relative, resolve } from 'path'
import * as core from '@actions/core'

import {
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  S3Client,
  ListPartsCommand,
} from "@aws-sdk/client-s3"

import type { S3ClientConfig } from "@aws-sdk/client-s3"

import { getLocalArtifactStats } from './files'
import { compressIfPossible } from './compression'
import { validateArtifactName, validateArtifactPath } from './validation'
import { StatusReporter } from './status-reporter'


type GithubContext = {
  repo: {
    owner: string
    repo: string
  }
  runId: number
  [key: string]: any
}

type UploadedPart = {
  PartNumber: number
  ETag: string
}


const configMultipartThreshold = 8 * 1024 ** 2  // 8MB
const configMultipartChunksize = 8 * 1024 ** 2  // 8MB


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

  async upload(
    bucket: string,
    scope: string,
    name: string,
    path: string,
    context: GithubContext,
    ignore?: string[],
  ) {
    try {
      validateArtifactPath(path)

      const { entries, count } = await getLocalArtifactStats(path, ignore)

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
        let { filepath, size } = entry

        core.debug(`Processing file: ${filepath}`)

        const absolutePath = resolve(filepath)
        const tempFilepath = absolutePath + '.artifact.gzip'
        const relativePath = relative(path, filepath)

        const key = `${artifactPrefix}/${relativePath}`

        const uploadSource = await compressIfPossible(
          absolutePath,
          size,
          tempFilepath,
        )

        if (uploadSource.size > configMultipartThreshold) {
          await this._uploadMultipart(uploadSource, bucket, key)
        } else {
          const { stream, encoding } = uploadSource

          const command = new PutObjectCommand({
            ContentEncoding: encoding,
            Bucket: bucket,
            Key: key,
            Body: stream.read(),
            // ChecksumSHA256: ,
          })

          await this._client.send(command)
        }

        uploadSource.stream.close()

        this._statusReporter.incrementProcessedCount()
      }
    } catch (error) {
      core.error(`Failed to upload artifact: ${error}`)
    } finally {
      this._statusReporter.stop()
    }
  }

  async _uploadMultipart(
    source: UploadSource,
    bucket: string,
    key: string,
  ) {
    const { filepath, stream, size, encoding } = source

    return new Promise<void>(async (resolve, reject) => {
      const command = new CreateMultipartUploadCommand({
        ContentEncoding: encoding,
        Bucket: bucket,
        Key: key,
      })

      const response = await this._client.send(command)

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
      const multipartUploadContainer = { Parts: <UploadedPart[]>[] }

      const uploadPart = async () => {
        stream.pause()

        const chunk = Buffer.concat(chunkBuffer)
        const { length } = chunk

        chunkByteCount = 0
        chunkBuffer.length = 0

        const command = new UploadPartCommand({
          Body: chunk,
          ContentLength: length,
          PartNumber: partNumber++,
          // ChecksumSHA256: ,
          ...multipartConfig,
        })

        const response = await this._client.send(command)

        multipartUploadContainer.Parts.push({ ETag: response.ETag!, PartNumber: command.input.PartNumber! })

        core.debug(`Part upload response: ${JSON.stringify(response)}`)

        this._statusReporter.updateLargeFileStatus(
          filepath,
          byteCount,
          byteCount += length,
          size,
        )

        stream.resume()
      }

      stream.on('data', async (data) => {
        chunkBuffer.push(data as Buffer)

        const { length } = data as Buffer
        chunkByteCount += length

        if (chunkByteCount >= configMultipartChunksize) {
          uploadPart()
        }
      })

      stream.on('end', async () => {
        if (chunkBuffer.length) {
          await uploadPart()
        }

        const complete = new CompleteMultipartUploadCommand({
          MultipartUpload: multipartUploadContainer,
          ...multipartConfig,
        })

        try {
          await this._client.send(complete)
        } catch (err) {
          console.error(err)
          reject(err)
        }

        resolve()
      })

      stream.on('error', async (err) => {
        console.error(err)
        core.error('Aborting multipart upload.')

        let retry = 1
        let retryMax = 10

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
        } catch (err) {
          console.error(err)
          core.warning('Failed to properly abort multipart upload, manual cleanup may be required.')
          core.warning(`Multipart Upload Properties: ${JSON.stringify(multipartConfig)}`)
        } finally {
          reject(err)
        }
      })
    })
  }
}
