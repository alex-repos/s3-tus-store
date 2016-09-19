import initDebug from 'debug'
import toObject from 'to-object-reducer'
import MeterStream from 'meterstream'
import { PassThrough } from 'stream'
import { SizeStream } from 'common-streams'

import writePartByPart from './write-part-by-part'

// Inspired by https://github.com/tus/tusd/blob/master/s3store/s3store.go
//
// Configuration
//
// In order to allow this backend to function properly, the user accessing the
// bucket must have at least following AWS IAM policy permissions for the
// bucket and all of its subresources:
// 	s3:AbortMultipartUpload
// 	s3:DeleteObject
// 	s3:GetObject
// 	s3:ListMultipartUploadParts
// 	s3:PutObject//
// Implementation
//
// Once a new tus upload is initiated, multiple objects in S3 are created:
//
// First of all, a new info object is stored which contains a JSON-encoded blob
// of general information about the upload including its size and meta data.
// This kind of objects have the suffix ".info" in their key.
//
// In addition a new multipart upload
// (http://docs.aws.amazon.com/AmazonS3/latest/dev/uploadobjusingmpu.html) is
// created. Whenever a new chunk is uploaded to tusd using a PATCH request, a
// new part is pushed to the multipart upload on S3.
//
// If meta data is associated with the upload during creation, it will be added
// to the multipart upload and after finishing it, the meta data will be passed
// to the final object. However, the metadata which will be attached to the
// final object can only contain ASCII characters and every non-ASCII character
// will be replaced by a question mark (for example, "Menü" will be "Men?").
// However, this does not apply for the metadata returned by the GetInfo
// function since it relies on the info object for reading the metadata.
// Therefore, HEAD responses will always contain the unchanged metadata, Base64-
// encoded, even if it contains non-ASCII characters.

const debug = initDebug('s3-tus-store')

const defaults = {
	// MaxPartSize specifies the maximum size of a single part uploaded to S3
	// in bytes. This value must be bigger than minPartSize! In order to
	// choose the correct number, two things have to be kept in mind:
	//
	// If this value is too big and uploading the part to S3 is interrupted
	// unexpectedly, the entire part is discarded and the end user is required
	// to resume the upload and re-upload the entire big part.
	//
	// If this value is too low, a lot of requests to S3 may be made, depending
	// on how fast data is coming in. This may result in an eventual overhead.
  maxPartSize: 6 * 1024 * 1024, // 6 MB
	// MinPartSize specifies the minimum size of a single part uploaded to S3
	// in bytes. This number needs to match with the underlying S3 backend or else
	// uploaded parts will be reject. AWS S3, for example, uses 5MB for this value.
  minPartSize: 5 * 1024 * 1024,
}

// TODO: optional TTL?
export default ({
  client,
  bucket,
  minPartSize = defaults.minPartSize,
  maxPartSize = defaults.maxPartSize,
}) => {
  const buildParams = (key, extra) => ({
    Key: key,
    Bucket: bucket,
    ...extra,
  })

  const infoKey = (key) => `${key}.info`

  const buildS3Metadata = (uploadMetadata = {}) => {
    const metadata = uploadMetadata
    // Values must be strings... :(
    // TODO: test what happens with non ASCII keys/values
    return Object
      .keys(metadata)
      .map(key => ([key, `${metadata[key]}`]))
      .reduce(toObject, {})
  }

  const setKeyInfo = (key, info) => Promise.resolve().then(() => {
    const infoJson = JSON.stringify(info)
    return client
      .putObject(buildParams(infoKey(key), {
        Body: infoJson,
        ContentLength: infoJson.length,
      }))
      .promise()
  })

  const getKeyInfo = key => client
    .getObject(buildParams(infoKey(key)))
    .promise()
    .then(({ Body }) => {
      const info = JSON.parse(Body.toString())
      return info
    })

  const getKeyOffset = (key, uploadId) => client
    .listParts(buildParams(key, {
      UploadId: uploadId,
    }))
    .promise()
    // get size of all parts
    .then(({ Parts }) => Parts.map(({ Size }) => Size))
    // sum size of all parts
    .then(sizes => sizes.reduce((total, size) => total + size, 0))

  const info = (key) => getKeyInfo(key)
    .then((infoObj) => (
      getKeyOffset(key, infoObj.uploadId)
        .then(uploadOffset => {
          debug(uploadOffset)
          const result = {
            ...infoObj,
            uploadOffset,
          }
          return result
        })
    ))

  // TODO: make sure not already created?
  // TODO: save uploadMetadata in a JSON string?
  // in case it might contain a uploadLength key...
  const create = (key, {
    uploadLength,
    uploadMetadata = {},
  }) => Promise.resolve()
    .then(() => (
      client.createMultipartUpload(buildParams(key, {
        Metadata: buildS3Metadata(uploadMetadata),
      })).promise()
    ))
    .then((data) => {
      debug(data)
      // data.AbortDate
      // data.UploadId
      const uploadId = data.UploadId
      const infoObj = { uploadId, uploadLength, uploadMetadata }
      return setKeyInfo(key, infoObj)
    })

  const getWriteInfo = (key) => info(key)
    .then(({ uploadId, uploadOffset, uploadLength }) => (
      client
        .listParts(buildParams(key, {
          UploadId: uploadId,
        }))
        .promise()
        .then(({ Parts }) => {
          debug(Parts)
          if (!Parts.length) return 1 // parts are 1-indexed
          const lastPart = Parts[Parts.length - 1]
          const nextPartNumber = lastPart.PartNumber + 1
          return nextPartNumber
        })
        .then((nextPartNumber) => ({
          uploadId,
          uploadOffset,
          uploadLength,
          nextPartNumber,
        }))
    ))

  const write = (key, rs) => getWriteInfo(key)
    .then(({ uploadId, uploadOffset, uploadLength, nextPartNumber }) => {
      // TODO: only do this if uploadLength is set
      const bytesRemaining = uploadLength - uploadOffset
      // Ensure total upload doesn't exeedd uploadLength
      const meter = new MeterStream(bytesRemaining)
      let bytesUploaded
      // Count how many bytes have been uploaded
      const sizeStream = new SizeStream((size) => {
        bytesUploaded = size
      })
      const body = new PassThrough()

      return new Promise((resolve, reject) => {
        let done = false
        // This should only happen with a "malicious" client
        meter.on('error', (err) => {
          done = true
          // TODO: make sure we need to call .end() on body
          body.end()
          reject(err)
        })
        // Splits body into multiple consecutive part uploads
        writePartByPart(body, client, bucket, key, uploadId, nextPartNumber, maxPartSize)
          .then(() => {
            if (done) return
            resolve()
          }, (err) => {
            if (done) return
            reject(err)
          })
        rs.pipe(meter).pipe(sizeStream).pipe(body)
      })
      .then(() => {
        debug(`uploaded ${bytesUploaded} bytes`)
        // Upload completed!
        if (uploadOffset + bytesUploaded === uploadLength) {
          debug('todo: complete upload!')
          return
        } else if (bytesUploaded < minPartSize) {
          debug('oops, didnt write enough bytes...')
          // throw error?
          return
        }
      })
    })

  return {
    info,
    create,
    write,
  }
}
