import ExcelJS from 'exceljs'
async function main() {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile('/home/oracle/staging/mar-close-2026/march closing/NetSuite_Template_Mar-2026 (0417-1420).xlsm')
  console.log('Sheets:', wb.worksheets.map(s => s.name))
  const sheet = wb.getWorksheet('Data Entry') || wb.worksheets[0]
  console.log('Using sheet:', sheet.name, 'rowCount=', sheet.rowCount, 'colCount=', sheet.columnCount)
  let formulaCells = 0
  const samples: string[] = []
  sheet.eachRow((row, rn) => {
    if (rn > 8) return
    row.eachCell((cell, cn) => {
      const v: any = cell.value
      if (v && typeof v === 'object' && 'formula' in v) {
        formulaCells++
        if (samples.length < 6) samples.push(`R${rn}C${cn}: =${v.formula?.slice(0,180)} → ${v.result}`)
      }
    })
  })
  console.log('formula cells in first 8 rows:', formulaCells)
  samples.forEach(s => console.log('  ' + s))
}
main().catch(e => { console.error(e); process.exit(1) })
