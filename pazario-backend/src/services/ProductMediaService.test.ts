import { describe, it, expect } from 'vitest'
import { buildMediaOverrides, effectiveProductMedia, inspectMediaUpload, mediaInput } from './ProductMediaService'
const xml = 'https://example.com/xml.jpg'
const manual = 'https://example.com/manual.png'
const video = 'https://example.com/video.mp4'

describe('manual product media', () => {
  it('uses XML unchanged before a manual edit', () => {
    expect(effectiveProductMedia({ images: [xml] })).toEqual({ images: [xml], videos: [] })
  })
  it('keeps manual ordering and video across XML refreshes', () => {
    const manualMedia = buildMediaOverrides({ images: [xml] }, [manual, xml], [video])
    expect(effectiveProductMedia({ images: [xml, 'https://example.com/new.jpg'], manualMedia }))
      .toEqual({ images: [manual, xml, 'https://example.com/new.jpg'], videos: [video] })
  })
  it('does not bring back a removed XML image on refresh', () => {
    const manualMedia = buildMediaOverrides({ images: [xml] }, [manual], [])
    expect(effectiveProductMedia({ images: [xml], manualMedia }).images).toEqual([manual])
  })
  it('does not pin obsolete XML images but retains explicit manual images', () => {
    const manualMedia = buildMediaOverrides({ images: [xml] }, [xml, manual], [])
    expect(effectiveProductMedia({ images: [], manualMedia }).images).toEqual([manual])
  })
  it('can restore a hidden image and remove manual assets without deleting shared files', () => {
    const original = { images: [xml], manualMedia: buildMediaOverrides({ images: [xml] }, [manual], [video]) }
    expect(effectiveProductMedia({ images: [xml], manualMedia: buildMediaOverrides(original, [xml], []) }))
      .toEqual({ images: [xml], videos: [] })
  })
  it('rejects executable, insecure and private URLs', () => {
    for (const url of ['javascript:alert(1)', 'http://example.com/a.jpg', 'https://127.0.0.1/a.jpg', 'https://localhost/a.jpg', 'https://u:p@example.com/a.jpg']) {
      expect(mediaInput.safeParse({ images: [url], videos: [], version: 0 }).success).toBe(false)
    }
  })
  it('validates video format and media count', () => {
    expect(mediaInput.safeParse({ images: [xml], videos: [video], version: 0 }).success).toBe(true)
    expect(mediaInput.safeParse({ images: [], videos: [xml], version: 0 }).success).toBe(false)
    expect(mediaInput.safeParse({ images: Array(21).fill(xml), videos: [], version: 0 }).success).toBe(false)
  })
  it('checks uploaded binary signatures and size rather than trusting the filename', () => {
    expect(inspectMediaUpload(Buffer.from([255,216,255,0]), 'image/jpeg')).toBe('jpg')
    expect(inspectMediaUpload(Buffer.from([137,80,78,71,13,10,26,10]), 'image/png')).toBe('png')
    const mp4 = Buffer.alloc(24); mp4.write('ftyp', 4); mp4.write('isom', 8)
    expect(inspectMediaUpload(mp4, 'video/mp4')).toBe('mp4')
    expect(() => inspectMediaUpload(Buffer.from('<html>'), 'image/jpeg')).toThrow()
    expect(() => inspectMediaUpload(Buffer.alloc(9 * 1024 * 1024), 'image/png')).toThrow()
  })
})
