import { Blob, File } from 'node:buffer'

globalThis.Blob ||= Blob
globalThis.File ||= File

await import('./index.js')
