import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { readLocalDocument } from '../../src/runtime/host/local-file-service'

async function createDocx(path: string): Promise<void> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  )
  zip
    .folder('_rels')
    ?.file(
      '.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    )
  zip
    .folder('word')
    ?.file(
      'document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>First paragraph</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'
    )
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
}

describe('local document read host', () => {
  it('keeps the legacy text-document response shape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-document-read-'))
    try {
      const textPath = join(root, 'note.txt')
      await writeFile(textPath, 'hello\n', 'utf8')
      await expect(readLocalDocument({ path: textPath, maxFileReadBytes: 1024 })).resolves.toEqual({
        content: 'hello\n',
        name: 'note.txt',
        error: null
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('extracts DOCX text in the Main TS host without a Native Worker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ola-document-docx-'))
    try {
      const docxPath = join(root, 'note.docx')
      await createDocx(docxPath)
      const result = await readLocalDocument({ path: docxPath, maxFileReadBytes: 1024 * 1024 })
      expect(result).toMatchObject({ name: 'note.docx', error: null })
      expect(result.content).toContain('First paragraph')
      expect(result.content).toContain('Second paragraph')
      expect(result.content).toContain('Table cell')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
