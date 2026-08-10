import { extname } from 'node:path'

type ZipEntry = {
  name: string
  data: Buffer
}

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  crcTable = table
  return table
}

function crc32(data: Buffer): number {
  const table = getCrcTable()
  let crc = 0xffffffff
  for (const byte of data) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(1980, date.getFullYear())
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  }
}

function createZip(entries: ZipEntry[], now = new Date()): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  const stamp = dosDateTime(now)

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, entry.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(stamp.time, 12)
    central.writeUInt16LE(stamp.date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)

    offset += local.length + name.length + entry.data.length
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, ...centralParts, end])
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function cleanText(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code > 0x1f || code === 0x09 || code === 0x0a || code === 0x0d
    })
    .join('')
    .replaceAll('\t', '    ')
}

function paragraphXml(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(cleanText(text))}</w:t></w:r></w:p>`
}

/**
 * Markdown 脚注定义行：`[^1]: 脚注内容` 或 `[^1]：脚注内容`。
 */
const FOOTNOTE_DEFINITION = /^\s*\[\^(\d+)\]\s*[:：]\s*(.+)$/

/**
 * 解析脚注定义行与正文中的 `[^N]` 引用。
 * 返回：剔除定义行后的正文行、脚注表（按 id 升序，仅保留正文引用到的）。
 */
function parseFootnotes(lines: string[]): { body: string[]; footnotes: Array<{ id: number; text: string }> } {
  const definitions = new Map<number, string>()
  const body: string[] = []
  for (const line of lines) {
    const match = FOOTNOTE_DEFINITION.exec(line)
    if (match) {
      const id = Number(match[1])
      if (!definitions.has(id)) definitions.set(id, match[2].trim())
      continue
    }
    body.push(line)
  }
  const referenced = new Set<number>()
  for (const line of body) {
    for (const m of line.matchAll(/\[\^(\d+)\]/g)) referenced.add(Number(m[1]))
  }
  const usedIds = [...referenced].filter((id) => definitions.has(id)).sort((a, b) => a - b)
  return {
    body,
    footnotes: usedIds.map((id) => ({ id, text: definitions.get(id) ?? '' }))
  }
}

function footnoteRefXml(id: number): string {
  return (
    '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/><w:vertAlign w:val="superscript"/></w:rPr>' +
    `<w:footnoteReference w:id="${id}"/></w:r>`
  )
}

/** 把正文行里的 `[^N]` 替换为 Word 脚注引用（上标）；未定义的保留原样。 */
function inlineFootnoteRefs(text: string, definedIds: Set<number>): string {
  return text.replace(/\[\^(\d+)\]/g, (whole, idText: string) => {
    const id = Number(idText)
    return definedIds.has(id) ? footnoteRefXml(id) : whole
  })
}

function footnotesDocumentXml(footnotes: Array<{ id: number; text: string }>): string {
  const items = footnotes
    .map(
      (fn) =>
        `<w:footnote w:id="${fn.id}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>` +
        '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/><w:vertAlign w:val="superscript"/></w:rPr>' +
        '<w:footnoteRef/></w:r>' +
        `<w:r><w:t xml:space="preserve"> ${escapeXml(cleanText(fn.text))}</w:t></w:r></w:p></w:footnote>`
    )
    .join('')
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
    '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
    `${items}</w:footnotes>`
  )
}

export function isDocxPath(path: string): boolean {
  return extname(path).toLowerCase() === '.docx'
}

export function plainTextToDocxBuffer(content: string, options: { title?: string } = {}): Buffer {
  const title = escapeXml(cleanText(options.title?.trim() || 'Document'))
  const now = new Date().toISOString()
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const { body, footnotes } = parseFootnotes(lines)
  const definedIds = new Set(footnotes.map((fn) => fn.id))
  const paragraphs = body
    .map((line) => inlineFootnoteRefs(line, definedIds))
    .map(paragraphXml)
    .join('')
  const hasFootnotes = footnotes.length > 0
  const footnoteRels = hasFootnotes
    ? '<Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>'
    : ''
  const footnoteContentType = hasFootnotes
    ? '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>'
    : ''

  return createZip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${footnoteContentType}</Types>`,
        'utf8'
      )
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
        'utf8'
      )
    },
    {
      name: 'docProps/core.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${title}</dc:title><dc:creator>LegalWork</dc:creator><cp:lastModifiedBy>LegalWork</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
        'utf8'
      )
    },
    {
      name: 'docProps/app.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>LegalWork</Application></Properties>`,
        'utf8'
      )
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1588" w:right="1474" w:bottom="1418" w:left="1588" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
        'utf8'
      )
    },
    {
      name: 'word/styles.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="SimSun" w:hAnsi="SimSun" w:eastAsia="SimSun" w:cs="SimSun"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="360" w:lineRule="auto"/><w:autoSpaceDE w:val="true"/><w:autoSpaceDN w:val="true"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style></w:styles>`,
        'utf8'
      )
    },
    ...(hasFootnotes
      ? [
          {
            name: 'word/_rels/document.xml.rels',
            data: Buffer.from(
              `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${footnoteRels}</Relationships>`,
              'utf8'
            )
          },
          {
            name: 'word/footnotes.xml',
            data: Buffer.from(footnotesDocumentXml(footnotes), 'utf8')
          }
        ]
      : [])
  ])
}
