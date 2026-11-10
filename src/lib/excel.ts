import ExcelJS from 'exceljs';

export type ExcelValue = string | number | boolean | Date | null | undefined;
export type ExcelValueType = 'text' | 'money' | 'number' | 'date' | 'datetime';

export interface ExcelColumn {
  header: string;
  key: string;
  width?: number;
  type?: ExcelValueType;
}

export interface ExcelSheet {
  name: string;
  title?: string;
  subtitle?: string;
  columns: ExcelColumn[];
  rows: Record<string, ExcelValue>[];
  totals?: Record<string, number>;
}

function normalizeValue(value: ExcelValue): string | number | boolean | Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    const candidate = value as unknown as { toNumber?: () => number; toString: () => string };
    if (typeof candidate.toNumber === 'function') return candidate.toNumber();
    return candidate.toString();
  }
  return value;
}

function applyColumnFormat(column: ExcelJS.Column, type: ExcelValueType): void {
  if (type === 'money') column.numFmt = '#,##0.00';
  if (type === 'date') column.numFmt = 'dd/mm/yyyy';
  if (type === 'datetime') column.numFmt = 'dd/mm/yyyy hh:mm';
}

/** Construit un classeur Excel professionnel (en-tetes verts, filtres, totaux). */
export async function buildExcel(sheets: ExcelSheet[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Depot Boissons';
  workbook.created = new Date();

  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name, {
      views: [{ state: 'frozen', ySplit: sheet.title ? 3 : 2 }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    });

    const columnCount = Math.max(sheet.columns.length, 1);

    if (sheet.title) {
      const row = worksheet.addRow([sheet.title]);
      row.font = { bold: true, size: 15, color: { argb: 'FF14532D' } };
      worksheet.mergeCells(row.number, 1, row.number, columnCount);

      const subtitle = worksheet.addRow([sheet.subtitle ?? '']);
      subtitle.font = { size: 9, color: { argb: 'FF6B7280' } };
      worksheet.mergeCells(subtitle.number, 1, subtitle.number, columnCount);
      subtitle.height = 16;
    }

    const headerRow = worksheet.addRow(sheet.columns.map((column) => column.header));
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14532D' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    headerRow.height = 24;

    sheet.columns.forEach((column, index) => {
      const excelColumn = worksheet.getColumn(index + 1);
      excelColumn.width = column.width ?? 18;
      excelColumn.key = column.key;
      applyColumnFormat(excelColumn, column.type ?? 'text');
    });

    for (const rowData of sheet.rows) {
      const row = worksheet.addRow(sheet.columns.map((column) => normalizeValue(rowData[column.key])));
      sheet.columns.forEach((column, index) => {
        const cell = row.getCell(index + 1);
        if (column.type === 'money' || column.type === 'number') cell.alignment = { horizontal: 'right' };
        if (column.type === 'date' || column.type === 'datetime') cell.alignment = { horizontal: 'center' };
      });
      if (row.number % 2 === 0) {
        row.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F8F7' } };
        });
      }
    }

    const totals = sheet.totals;
    if (totals) {
      const values = sheet.columns.map((column) => {
        if (!(column.key in totals)) return null;
        return totals[column.key] ?? null;
      });
      const totalRow = worksheet.addRow(values);
      totalRow.font = { bold: true };
      totalRow.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F1EA' } };
        cell.border = { top: { style: 'thin', color: { argb: 'FF14532D' } } };
      });
      const labelIndex = sheet.columns.findIndex((column) => column.key !== '') + 1;
      totalRow.getCell(labelIndex).value = 'TOTAL';
    }

    worksheet.autoFilter = {
      from: { row: headerRow.number, column: 1 },
      to: { row: Math.max(headerRow.number + sheet.rows.length, headerRow.number + 1), column: columnCount },
    };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
