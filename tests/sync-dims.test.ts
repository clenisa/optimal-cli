import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseNetSuiteXml, classifyProgramSource } from '../lib/returnpro/sync-dims.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL_XML = `<?xml version="1.0" encoding="utf-8"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="MasterProgramProgramResults">
<Table>
<Row>
<Cell ss:StyleID="header"><Data ss:Type="String">Name</Data></Cell>
<Cell ss:StyleID="header"><Data ss:Type="String">filter by "ProgramID"</Data></Cell>
</Row>
<Row><Cell ss:StyleID="s__text"><Data ss:Type="String">Costco Liquidation (Finished)</Data></Cell>
<Cell ss:StyleID="s__text"><Data ss:Type="String">FRAKY-COSTCO-PILOT</Data></Cell>
</Row>
<Row><Cell ss:StyleID="s__text"><Data ss:Type="String">Amazon Returns (As-Is)</Data></Cell>
<Cell ss:StyleID="s__text"><Data ss:Type="String">FORTX-AMAZON,BENAR-AMAZON-RMA</Data></Cell>
</Row>
</Table>
</Worksheet>
</Workbook>`

const ENTITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="MasterProgramProgramResults">
<Table>
<Row>
<Cell><Data ss:Type="String">Name</Data></Cell>
<Cell><Data ss:Type="String">ProgramID</Data></Cell>
</Row>
<Row><Cell><Data ss:Type="String">Walmart Canada TVs Over 32&quot; (Finished)</Data></Cell>
<Cell><Data ss:Type="String">MILON-WM-RMA,MILON-WM-TV</Data></Cell>
</Row>
<Row><Cell><Data ss:Type="String">Leslie&apos;s Pool Liquidation</Data></Cell>
<Cell><Data ss:Type="String">FORTX-LESLIES</Data></Cell>
</Row>
<Row><Cell><Data ss:Type="String">Lowes Liquidation (Liquidation &amp; Flipped)</Data></Cell>
<Cell><Data ss:Type="String">FORTX-LOWES,MILON-WM-L&amp;S</Data></Cell>
</Row>
<Row><Cell><Data ss:Type="String">Test &lt;Special&gt; Program</Data></Cell>
<Cell><Data ss:Type="String">FORTX-TEST</Data></Cell>
</Row>
</Table>
</Worksheet>
</Workbook>`

const EMPTY_XML = `<?xml version="1.0" encoding="utf-8"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="MasterProgramProgramResults">
<Table>
<Row>
<Cell><Data ss:Type="String">Name</Data></Cell>
<Cell><Data ss:Type="String">ProgramID</Data></Cell>
</Row>
</Table>
</Worksheet>
</Workbook>`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseNetSuiteXml', () => {
  it('parses minimal XML with header row skipped', () => {
    const rows = parseNetSuiteXml(MINIMAL_XML)
    assert.equal(rows.length, 2)

    assert.equal(rows[0].masterProgram, 'Costco Liquidation (Finished)')
    assert.deepEqual(rows[0].programIds, ['FRAKY-COSTCO-PILOT'])

    assert.equal(rows[1].masterProgram, 'Amazon Returns (As-Is)')
    assert.deepEqual(rows[1].programIds, ['FORTX-AMAZON', 'BENAR-AMAZON-RMA'])
  })

  it('returns empty array for XML with only a header', () => {
    const rows = parseNetSuiteXml(EMPTY_XML)
    assert.equal(rows.length, 0)
  })

  it('decodes &quot; entity in master program names', () => {
    const rows = parseNetSuiteXml(ENTITY_XML)
    assert.equal(rows[0].masterProgram, 'Walmart Canada TVs Over 32" (Finished)')
  })

  it('decodes &apos; entity in master program names', () => {
    const rows = parseNetSuiteXml(ENTITY_XML)
    assert.equal(rows[1].masterProgram, "Leslie's Pool Liquidation")
  })

  it('decodes &amp; entity in both names and program codes', () => {
    const rows = parseNetSuiteXml(ENTITY_XML)
    assert.equal(rows[2].masterProgram, 'Lowes Liquidation (Liquidation & Flipped)')
    assert.ok(rows[2].programIds.includes('MILON-WM-L&S'))
  })

  it('decodes &lt; and &gt; entities', () => {
    const rows = parseNetSuiteXml(ENTITY_XML)
    assert.equal(rows[3].masterProgram, 'Test <Special> Program')
  })

  it('trims whitespace from master program names', () => {
    const xml = `<?xml version="1.0"?>
<Workbook xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="Sheet1"><Table>
<Row><Cell><Data ss:Type="String">Name</Data></Cell><Cell><Data ss:Type="String">ProgramID</Data></Cell></Row>
<Row><Cell><Data ss:Type="String">  Padded Name  </Data></Cell><Cell><Data ss:Type="String">FORTX-TEST</Data></Cell></Row>
</Table></Worksheet></Workbook>`
    const rows = parseNetSuiteXml(xml)
    assert.equal(rows[0].masterProgram, 'Padded Name')
  })

  it('splits comma-separated program IDs correctly', () => {
    const rows = parseNetSuiteXml(MINIMAL_XML)
    assert.equal(rows[1].programIds.length, 2)
    assert.equal(rows[1].programIds[0], 'FORTX-AMAZON')
    assert.equal(rows[1].programIds[1], 'BENAR-AMAZON-RMA')
  })
})

describe('classifyProgramSource', () => {
  it('classifies location-prefix programs as netsuite', () => {
    assert.equal(classifyProgramSource('FORTX-AMAZON'), 'netsuite')
    assert.equal(classifyProgramSource('BENAR-ALMO-RMA'), 'netsuite')
    assert.equal(classifyProgramSource('MILON-WM-TV'), 'netsuite')
    assert.equal(classifyProgramSource('FRAKY-COSTCO-PILOT'), 'netsuite')
    assert.equal(classifyProgramSource('BRTON-BASSPRO'), 'netsuite')
    assert.equal(classifyProgramSource('GREIN-TEST'), 'netsuite')
    assert.equal(classifyProgramSource('LVGNV-SOMETHING'), 'netsuite')
    assert.equal(classifyProgramSource('MIAFL-PROGRAM'), 'netsuite')
    assert.equal(classifyProgramSource('PALGA-PROG'), 'netsuite')
    assert.equal(classifyProgramSource('VEGNV-PROG'), 'netsuite')
    assert.equal(classifyProgramSource('WACTX-PROG'), 'netsuite')
    assert.equal(classifyProgramSource('WHIIN-PROG'), 'netsuite')
    assert.equal(classifyProgramSource('BEIHA-PROG'), 'netsuite')
    assert.equal(classifyProgramSource('CANAD-PROG'), 'netsuite')
    assert.equal(classifyProgramSource('FROFL-PROG'), 'netsuite')
    assert.equal(classifyProgramSource('MINKA-PROG'), 'netsuite')
    assert.equal(classifyProgramSource('ROGAR-PROG'), 'netsuite')
    assert.equal(classifyProgramSource('SPASC-PROG'), 'netsuite')
    assert.equal(classifyProgramSource('FTWTX-PROG'), 'netsuite')
  })

  it('classifies DS- FC- INSTO CDW-D US-B2 prefixes as netsuite', () => {
    assert.equal(classifyProgramSource('DS-BPS-ANCHORAGE1'), 'netsuite')
    assert.equal(classifyProgramSource('FC-SOMETHING'), 'netsuite')
    assert.equal(classifyProgramSource('INSTORE-PROG'), 'netsuite')
    assert.equal(classifyProgramSource('CDW-DIRECT'), 'netsuite')
    assert.equal(classifyProgramSource('US-B2C-CANCELLED-ORDERS'), 'netsuite')
  })

  it('classifies known FPA values as fpa', () => {
    assert.equal(classifyProgramSource('NULL'), 'fpa')
    assert.equal(classifyProgramSource('Consumables purchase only'), 'fpa')
    assert.equal(classifyProgramSource('R1 for WM'), 'fpa')
    assert.equal(classifyProgramSource('ReturnPro SaaS'), 'fpa')
    assert.equal(classifyProgramSource('MULTI-SELLER-DL'), 'fpa')
  })

  it('classifies unknown patterns as fpa', () => {
    assert.equal(classifyProgramSource('RANDOM-CODE'), 'fpa')
    assert.equal(classifyProgramSource('SOMETHING-ELSE'), 'fpa')
    assert.equal(classifyProgramSource(''), 'fpa')
  })

  it('requires a hyphen after location prefix', () => {
    // FORTX without hyphen should not match
    assert.equal(classifyProgramSource('FORTXNOHYPHEN'), 'fpa')
    // But with hyphen it should
    assert.equal(classifyProgramSource('FORTX-REAL'), 'netsuite')
  })
})
