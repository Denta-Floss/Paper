'use strict';

const PDFDocument = require('pdfkit');

// ---------------------------------------------------------------------------
// Invoices: bills raised against challans.
//
// An invoice is a header and its lines; a line may name the challan it bills.
// Holds the DTOs, list and read, the numbering, createInvoice (its own
// transaction), the amount-in-words helper and the invoice PDF.
//
// Takes {get, all, run} plus, by name: the client lookup, the company profile
// (the seller block on the PDF), and the challan readers the PDF quotes from,
// which stay in server.js until the challan core moves.
// ---------------------------------------------------------------------------

function createInvoiceService({
  get,
  all,
  run,
  getClientRowById,
  rowToCompanyProfileDto,
  getActiveCompanyProfile,
  rowToDeliveryChallanDto,
  normalizeChallanDate,
  getDeliveryChallanRowById,
}) {
  function rowToInvoiceLineDto(row) {
    return {
      id: Number(row.id || 0),
      invoiceId: Number(row.invoice_id || 0),
      orderId: row.order_id || null,
      challanId: row.challan_id || null,
      challanItemId: row.challan_item_id || null,
      itemId: row.item_id || null,
      variationLeafNodeId: Number(row.variation_leaf_node_id || 0),
      itemName: row.item_name || '',
      hsnCode: row.hsn_code || '',
      quantity: Number(row.quantity || 0),
      unitPrice: Number(row.unit_price || 0),
      taxableValue: Number(row.taxable_value || 0),
      cgstRate: Number(row.cgst_rate || 0),
      sgstRate: Number(row.sgst_rate || 0),
      cgstAmount: Number(row.cgst_amount || 0),
      sgstAmount: Number(row.sgst_amount || 0),
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
    };
  }

  async function rowToInvoiceHeaderDto(row, { includeLines = true } = {}) {
    const lines = includeLines
      ? await all(
          `
          SELECT *
          FROM invoice_lines
          WHERE invoice_id = ?
          ORDER BY id ASC
          `,
          [row.id],
        )
      : [];
    return {
      id: Number(row.id || 0),
      invoiceNo: row.invoice_no || '',
      clientId: row.client_id || null,
      clientName: row.client_name || '',
      gstin: row.gstin || '',
      status: row.status || 'draft',
      invoiceDate: row.invoice_date || '',
      totalQuantity: Number(row.total_quantity || 0),
      taxableValue: Number(row.taxable_value || 0),
      cgstAmount: Number(row.cgst_amount || 0),
      sgstAmount: Number(row.sgst_amount || 0),
      totalAmount: Number(row.total_amount || 0),
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
      lines: lines.map(rowToInvoiceLineDto),
    };
  }

  async function listInvoices({ includeLines = true } = {}) {
    const rows = await all(
      `
      SELECT *
      FROM invoice_headers
      ORDER BY date(invoice_date) DESC, id DESC
      `,
    );
    return Promise.all(rows.map((row) => rowToInvoiceHeaderDto(row, { includeLines })));
  }

  async function getInvoiceDtoById(id) {
    const row = await get('SELECT * FROM invoice_headers WHERE id = ?', [Number(id)]);
    if (!row) {
      return null;
    }
    return rowToInvoiceHeaderDto(row);
  }

  async function generateInvoiceNumber() {
    const row = await get(
      `
      SELECT invoice_no
      FROM invoice_headers
      WHERE invoice_no LIKE 'INV-%'
      ORDER BY id DESC
      LIMIT 1
      `,
    );
    const match = String(row?.invoice_no || '').match(/(\d+)$/);
    const next = match ? Number(match[1]) + 1 : 1;
    return `INV-${String(next).padStart(5, '0')}`;
  }

  function normalizePositiveNumber(value, fieldName, { allowZero = false } = {}) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || (!allowZero && number === 0)) {
      const error = new Error(`${fieldName} must be ${allowZero ? 'zero or positive' : 'positive'}.`);
      error.statusCode = 400;
      throw error;
    }
    return number;
  }

  async function createInvoice(input = {}) {
    const linesInput = Array.isArray(input.lines) ? input.lines : [];
    if (linesInput.length === 0) {
      const error = new Error('Add at least one invoice line.');
      error.statusCode = 400;
      throw error;
    }
    const invoiceNo = String(input.invoiceNo ?? input.invoice_no ?? '').trim() || await generateInvoiceNumber();
    const duplicate = await get(
      'SELECT id FROM invoice_headers WHERE LOWER(TRIM(invoice_no)) = LOWER(TRIM(?))',
      [invoiceNo],
    );
    if (duplicate) {
      const error = new Error(`Invoice number [${invoiceNo}] is already in use.`);
      error.statusCode = 409;
      throw error;
    }
    const now = new Date().toISOString();
    const invoiceDate = normalizeChallanDate(input.invoiceDate ?? input.invoice_date ?? now);
    const normalizedLines = [];
    for (const rawLine of linesInput) {
      const quantity = normalizePositiveNumber(rawLine.quantity ?? rawLine.qty, 'Invoice quantity');
      const unitPrice = normalizePositiveNumber(rawLine.unitPrice ?? rawLine.unit_price ?? 0, 'Unit price', { allowZero: true });
      const cgstRate = normalizePositiveNumber(rawLine.cgstRate ?? rawLine.cgst_rate ?? 0, 'CGST rate', { allowZero: true });
      const sgstRate = normalizePositiveNumber(rawLine.sgstRate ?? rawLine.sgst_rate ?? 0, 'SGST rate', { allowZero: true });
      const taxableValue = quantity * unitPrice;
      normalizedLines.push({
        orderId: Number(rawLine.orderId ?? rawLine.order_id ?? 0) || null,
        challanId: Number(rawLine.challanId ?? rawLine.challan_id ?? 0) || null,
        challanItemId: Number(rawLine.challanItemId ?? rawLine.challan_item_id ?? 0) || null,
        itemId: Number(rawLine.itemId ?? rawLine.item_id ?? 0) || null,
        variationLeafNodeId: Number(rawLine.variationLeafNodeId ?? rawLine.variation_leaf_node_id ?? 0) || 0,
        itemName: String(rawLine.itemName ?? rawLine.item_name ?? '').trim(),
        hsnCode: String(rawLine.hsnCode ?? rawLine.hsn_code ?? '').trim(),
        quantity,
        unitPrice,
        taxableValue,
        cgstRate,
        sgstRate,
        cgstAmount: taxableValue * cgstRate / 100,
        sgstAmount: taxableValue * sgstRate / 100,
      });
    }
    const totalQuantity = normalizedLines.reduce((sum, line) => sum + line.quantity, 0);
    const taxableValue = normalizedLines.reduce((sum, line) => sum + line.taxableValue, 0);
    const cgstAmount = normalizedLines.reduce((sum, line) => sum + line.cgstAmount, 0);
    const sgstAmount = normalizedLines.reduce((sum, line) => sum + line.sgstAmount, 0);
    await run('BEGIN TRANSACTION');
    try {
      const result = await run(
        `
        INSERT INTO invoice_headers (
          invoice_no, client_id, client_name, gstin, status, invoice_date,
          total_quantity, taxable_value, cgst_amount, sgst_amount, total_amount,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          invoiceNo,
          Number(input.clientId ?? input.client_id ?? 0) || null,
          String(input.clientName ?? input.client_name ?? '').trim(),
          String(input.gstin ?? input.customerGstin ?? input.customer_gstin ?? '').trim(),
          String(input.status || 'draft').trim() || 'draft',
          invoiceDate,
          totalQuantity,
          taxableValue,
          cgstAmount,
          sgstAmount,
          taxableValue + cgstAmount + sgstAmount,
          now,
          now,
        ],
      );
      for (const line of normalizedLines) {
        await run(
          `
          INSERT INTO invoice_lines (
            invoice_id, order_id, challan_id, challan_item_id, item_id, variation_leaf_node_id,
            item_name, hsn_code, quantity, unit_price, taxable_value, cgst_rate, sgst_rate,
            cgst_amount, sgst_amount, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            result.lastID,
            line.orderId,
            line.challanId,
            line.challanItemId,
            line.itemId,
            line.variationLeafNodeId,
            line.itemName,
            line.hsnCode,
            line.quantity,
            line.unitPrice,
            line.taxableValue,
            line.cgstRate,
            line.sgstRate,
            line.cgstAmount,
            line.sgstAmount,
            now,
            now,
          ],
        );
      }
      await run('COMMIT');
      return getInvoiceDtoById(result.lastID);
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
  }

  function numberToIndianWords(num) {
    if (num === null || num === undefined || isNaN(num)) return '';
    const absoluteNum = Math.abs(num);
    const rupees = Math.floor(absoluteNum);
    const paise = Math.round((absoluteNum - rupees) * 100);

    const ones = [
      '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
      'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'
    ];

    const tens = [
      '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'
    ];

    function convertLessThanThousand(n) {
      if (n === 0) return '';
      let temp = '';
      if (n >= 100) {
        temp += ones[Math.floor(n / 100)] + ' Hundred ';
        n %= 100;
      }
      if (n >= 20) {
        temp += tens[Math.floor(n / 10)] + ' ';
        n %= 10;
      }
      if (n > 0) {
        temp += ones[n] + ' ';
      }
      return temp.trim();
    }

    function convertToWords(n) {
      if (n === 0) return 'Zero';
      let word = '';
    
      // Crores (1,00,00,000)
      if (n >= 10000000) {
        word += convertLessThanThousand(Math.floor(n / 10000000)) + ' Crore ';
        n %= 10000000;
      }
      // Lakhs (1,00,000)
      if (n >= 100000) {
        word += convertLessThanThousand(Math.floor(n / 100000)) + ' Lakh ';
        n %= 100000;
      }
      // Thousands (1,000)
      if (n >= 1000) {
        word += convertLessThanThousand(Math.floor(n / 1000)) + ' Thousand ';
        n %= 1000;
      }
      // Remaining
      if (n > 0) {
        word += convertLessThanThousand(n);
      }
      return word.trim();
    }

    let result = 'Rupees ' + convertToWords(rupees);
    if (paise > 0) {
      result += ' and Paise ' + convertToWords(paise);
    }
    result += ' Only';
    return result;
  }

  async function generateInvoicePdf(invoiceId) {
    const invoice = await getInvoiceDtoById(invoiceId);
    if (!invoice) {
      const error = new Error('Invoice not found.');
      error.statusCode = 404;
      throw error;
    }

    const companyProfileRow = await getActiveCompanyProfile();
    const companyProfile = companyProfileRow ? rowToCompanyProfileDto(companyProfileRow) : null;

    let clientAddress = '';
    if (invoice.clientId) {
      const client = await getClientRowById(invoice.clientId);
      if (client) {
        clientAddress = client.address || '';
      }
    }

    function formatDate(dateStr) {
      if (!dateStr) return '';
      try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        return `${day}/${month}/${year}`;
      } catch (e) {
        return dateStr;
      }
    }

    const doc = new PDFDocument({ size: 'A4', margin: 30 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    const finished = new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    // Render Page 1 - TAX INVOICE
    // Draw border for page 1
    doc.rect(30, 30, 535.28, 781.89).stroke('#CCCCCC');

    // Supplier info (Left)
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#0F172A')
       .text(companyProfile?.company_name || 'SUPPLIER COMPANY', 35, 35, { width: 280 });
    doc.font('Helvetica').fontSize(9).fillColor('#334155')
       .text(companyProfile?.address || '', 35, 55, { width: 280 })
       .text(`Mobile: ${companyProfile?.mobile || ''}`, 35, 95, { width: 280 })
       .text(`GSTIN: ${companyProfile?.gstin || ''}`, 35, 110, { width: 280 })
       .text(`State Code: ${companyProfile?.state_code || ''}`, 35, 125, { width: 280 });

    // Right side: Invoice Title and Invoice info
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#0F172A')
       .text('TAX INVOICE', 320, 35, { width: 240, align: 'right' });

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#334155')
       .text(`Invoice No: `, 320, 65, { width: 100, align: 'left' })
       .font('Helvetica').text(invoice.invoiceNo, 420, 65, { width: 140, align: 'right' });

    doc.font('Helvetica-Bold')
       .text(`Invoice Date: `, 320, 80, { width: 100, align: 'left' })
       .font('Helvetica').text(formatDate(invoice.invoiceDate), 420, 80, { width: 140, align: 'right' });

    doc.font('Helvetica-Bold')
       .text(`Status: `, 320, 95, { width: 100, align: 'left' })
       .font('Helvetica').text(invoice.status.toUpperCase(), 420, 95, { width: 140, align: 'right' });

    // Horizontal line
    doc.moveTo(30, 145).lineTo(565.28, 145).stroke('#CCCCCC');

    // Billed To & Shipped To
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#0F172A')
       .text('BILLED TO (BUYER):', 35, 155, { width: 250 });
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#334155')
       .text(invoice.clientName, 35, 170, { width: 250 });
    doc.font('Helvetica').fontSize(9)
       .text(clientAddress, 35, 185, { width: 250 });
    doc.font('Helvetica-Bold')
       .text(`GSTIN: `, 35, 220, { width: 50, align: 'left' })
       .font('Helvetica').text(invoice.gstin || 'N/A', 85, 220, { width: 200 });

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#0F172A')
       .text('SHIPPED TO:', 320, 155, { width: 240 });
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#334155')
       .text(invoice.clientName, 320, 170, { width: 240 });
    doc.font('Helvetica').fontSize(9)
       .text(clientAddress, 320, 185, { width: 240 });
    doc.font('Helvetica-Bold')
       .text(`State Code: `, 320, 220, { width: 100, align: 'left' })
       .font('Helvetica').text(invoice.gstin ? invoice.gstin.substring(0, 2) : 'N/A', 420, 220, { width: 140, align: 'right' });

    // Table header
    const tableHeaderY = 235;
    const tableHeaderHeight = 25;
    doc.rect(30, tableHeaderY, 535.28, tableHeaderHeight).fill('#F1F5F9');
    doc.fillColor('#0F172A');

    const columns = [
      { label: 'Sl', width: 25, align: 'center' },
      { label: 'Description of Goods', width: 140, align: 'left' },
      { label: 'HSN', width: 50, align: 'center' },
      { label: 'Qty', width: 40, align: 'right' },
      { label: 'Rate', width: 50, align: 'right' },
      { label: 'Taxable Val', width: 60, align: 'right' },
      { label: 'CGST', width: 55, align: 'right' },
      { label: 'SGST', width: 55, align: 'right' },
      { label: 'Total', width: 60, align: 'right' }
    ];

    let colX = [];
    let currentX = 30;
    for (let i = 0; i < columns.length; i++) {
      colX.push(currentX);
      currentX += columns[i].width;
    }

    columns.forEach((col, idx) => {
      doc.font('Helvetica-Bold').fontSize(8);
      doc.text(col.label, colX[idx] + 2, tableHeaderY + 8, { width: col.width - 4, align: col.align });
    });

    doc.moveTo(30, tableHeaderY + tableHeaderHeight).lineTo(565.28, tableHeaderY + tableHeaderHeight).stroke('#CCCCCC');

    let currentY = tableHeaderY + tableHeaderHeight;
    let sl = 1;
    for (const line of invoice.lines) {
      const itemDesc = line.itemName;
      const descHeight = doc.heightOfString(itemDesc, { width: 140 - 4, fontSize: 8 });
      const rowHeight = Math.max(25, descHeight + 8);

      doc.font('Helvetica').fontSize(8).fillColor('#334155');
    
      // Sl No
      doc.text(String(sl++), colX[0] + 2, currentY + 6, { width: columns[0].width - 4, align: 'center' });
      // Particulars
      doc.font('Helvetica-Bold').text(itemDesc, colX[1] + 2, currentY + 6, { width: columns[1].width - 4, align: 'left' });
      // HSN
      doc.font('Helvetica').text(line.hsnCode || 'N/A', colX[2] + 2, currentY + 6, { width: columns[2].width - 4, align: 'center' });
      // Qty
      doc.text(Number(line.quantity).toFixed(2), colX[3] + 2, currentY + 6, { width: columns[3].width - 4, align: 'right' });
      // Rate
      doc.text(Number(line.unitPrice).toFixed(2), colX[4] + 2, currentY + 6, { width: columns[4].width - 4, align: 'right' });
      // Taxable Value
      doc.text(Number(line.taxableValue).toFixed(2), colX[5] + 2, currentY + 6, { width: columns[5].width - 4, align: 'right' });
      // CGST
      const cgstText = `${line.cgstRate}%\n${Number(line.cgstAmount).toFixed(2)}`;
      doc.text(cgstText, colX[6] + 2, currentY + 4, { width: columns[6].width - 4, align: 'right' });
      // SGST
      const sgstText = `${line.sgstRate}%\n${Number(line.sgstAmount).toFixed(2)}`;
      doc.text(sgstText, colX[7] + 2, currentY + 4, { width: columns[7].width - 4, align: 'right' });
      // Total
      const lineTotal = line.taxableValue + line.cgstAmount + line.sgstAmount;
      doc.text(Number(lineTotal).toFixed(2), colX[8] + 2, currentY + 6, { width: columns[8].width - 4, align: 'right' });

      currentY += rowHeight;
      doc.moveTo(30, currentY).lineTo(565.28, currentY).stroke('#E2E8F0');
    }

    // Draw vertical borders for table
    for (let i = 1; i < colX.length; i++) {
      doc.moveTo(colX[i], tableHeaderY).lineTo(colX[i], currentY).stroke('#E2E8F0');
    }

    // Totals Box
    let summaryY = currentY + 10;
    doc.rect(30, summaryY, 535.28, 60).stroke('#CCCCCC');

    doc.font('Helvetica-Bold').fontSize(8).fillColor('#0F172A')
       .text('Total Amount in Words:', 35, summaryY + 8, { width: 300 });
    const words = numberToIndianWords(invoice.totalAmount);
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#334155')
       .text(words, 35, summaryY + 20, { width: 300 });

    const rightLabelsX = 350;
    const rightValuesX = 460;
    const labelWidth = 110;
    const valueWidth = 100;

    doc.font('Helvetica-Bold').fontSize(8).fillColor('#0F172A');
    doc.text('Total Taxable Value:', rightLabelsX, summaryY + 8, { width: labelWidth, align: 'left' });
    doc.text('Total CGST Amount:', rightLabelsX, summaryY + 20, { width: labelWidth, align: 'left' });
    doc.text('Total SGST Amount:', rightLabelsX, summaryY + 32, { width: labelWidth, align: 'left' });
    doc.text('Total Amount (GST Inc):', rightLabelsX, summaryY + 45, { width: labelWidth, align: 'left' });

    doc.font('Helvetica').fontSize(8).fillColor('#334155');
    doc.text(Number(invoice.taxableValue).toFixed(2), rightValuesX, summaryY + 8, { width: valueWidth, align: 'right' });
    doc.text(Number(invoice.cgstAmount).toFixed(2), rightValuesX, summaryY + 20, { width: valueWidth, align: 'right' });
    doc.text(Number(invoice.sgstAmount).toFixed(2), rightValuesX, summaryY + 32, { width: valueWidth, align: 'right' });

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#0F172A');
    doc.text(Number(invoice.totalAmount).toFixed(2), rightValuesX, summaryY + 44, { width: valueWidth, align: 'right' });

    // GST Breakdown table
    const gstGroups = {};
    for (const line of invoice.lines) {
      const hsn = line.hsnCode || 'N/A';
      if (!gstGroups[hsn]) {
        gstGroups[hsn] = {
          hsn,
          taxableValue: 0,
          cgstRate: line.cgstRate,
          cgstAmount: 0,
          sgstRate: line.sgstRate,
          sgstAmount: 0,
          totalTax: 0
        };
      }
      gstGroups[hsn].taxableValue += line.taxableValue;
      gstGroups[hsn].cgstAmount += line.cgstAmount;
      gstGroups[hsn].sgstAmount += line.sgstAmount;
      gstGroups[hsn].totalTax += line.cgstAmount + line.sgstAmount;
    }

    let breakdownY = summaryY + 80;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#0F172A')
       .text('GST Tax Breakdown Table:', 30, breakdownY);

    breakdownY += 15;
    const gstCols = [
      { label: 'HSN/SAC', width: 85, align: 'center' },
      { label: 'Taxable Val', width: 90, align: 'right' },
      { label: 'CGST Rate', width: 65, align: 'right' },
      { label: 'CGST Amt', width: 80, align: 'right' },
      { label: 'SGST Rate', width: 65, align: 'right' },
      { label: 'SGST Amt', width: 80, align: 'right' },
      { label: 'Total Tax', width: 70, align: 'right' }
    ];

    let gstColX = [];
    let gstCurrentX = 30;
    for (let i = 0; i < gstCols.length; i++) {
      gstColX.push(gstCurrentX);
      gstCurrentX += gstCols[i].width;
    }

    doc.rect(30, breakdownY, 535.28, 20).fill('#F8FAFC');
    doc.fillColor('#0F172A').stroke('#CCCCCC');

    gstCols.forEach((col, idx) => {
      doc.font('Helvetica-Bold').fontSize(8);
      doc.text(col.label, gstColX[idx] + 2, breakdownY + 6, { width: col.width - 4, align: col.align });
    });

    let gstRowY = breakdownY + 20;
    Object.values(gstGroups).forEach((group) => {
      doc.rect(30, gstRowY, 535.28, 20).stroke('#CCCCCC');
      doc.font('Helvetica').fontSize(8).fillColor('#334155');
    
      doc.text(group.hsn, gstColX[0] + 2, gstRowY + 6, { width: gstCols[0].width - 4, align: 'center' });
      doc.text(Number(group.taxableValue).toFixed(2), gstColX[1] + 2, gstRowY + 6, { width: gstCols[1].width - 4, align: 'right' });
      doc.text(`${group.cgstRate}%`, gstColX[2] + 2, gstRowY + 6, { width: gstCols[2].width - 4, align: 'right' });
      doc.text(Number(group.cgstAmount).toFixed(2), gstColX[3] + 2, gstRowY + 6, { width: gstCols[3].width - 4, align: 'right' });
      doc.text(`${group.sgstRate}%`, gstColX[4] + 2, gstRowY + 6, { width: gstCols[4].width - 4, align: 'right' });
      doc.text(Number(group.sgstAmount).toFixed(2), gstColX[5] + 2, gstRowY + 6, { width: gstCols[5].width - 4, align: 'right' });
      doc.text(Number(group.totalTax).toFixed(2), gstColX[6] + 2, gstRowY + 6, { width: gstCols[6].width - 4, align: 'right' });
    
      for (let i = 1; i < gstColX.length; i++) {
        doc.moveTo(gstColX[i], gstRowY).lineTo(gstColX[i], gstRowY + 20).stroke('#E2E8F0');
      }
    
      gstRowY += 20;
    });

    // Footer and Signature
    const signatureY = 720;
    doc.moveTo(30, signatureY).lineTo(565.28, signatureY).stroke('#E2E8F0');

    doc.font('Helvetica-Bold').fontSize(8).fillColor('#0F172A')
       .text('Declaration & Terms:', 35, signatureY + 8);
    doc.font('Helvetica').fontSize(7).fillColor('#64748B')
       .text('1. Interest @ 18% p.a. will be charged if payment is not made within due date.\n2. Goods once sold will not be taken back or exchanged.\n3. Subject to jurisdiction of local courts.', 35, signatureY + 20, { width: 250 });

    doc.font('Helvetica-Bold').fontSize(8).fillColor('#0F172A')
       .text(`For ${companyProfile?.company_name || 'SUPPLIER COMPANY'}`, 350, signatureY + 8, { width: 210, align: 'right' });

    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#64748B')
       .text('Authorized Signatory', 350, signatureY + 65, { width: 210, align: 'right' });

    // Pages 2+: Referenced Delivery Challans
    const uniqueChallanIds = [...new Set(invoice.lines.map(line => line.challanId).filter(Boolean))];
    for (const challanId of uniqueChallanIds) {
      const challanRow = await getDeliveryChallanRowById(challanId);
      if (!challanRow) continue;
      const challanDto = await rowToDeliveryChallanDto(challanRow);
    
      doc.addPage({ size: 'A4', margin: 30 });
    
      // Draw border
      doc.rect(30, 30, 535.28, 781.89).stroke('#CCCCCC');
    
      // Supplier Info
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#0F172A')
         .text(companyProfile?.company_name || 'SUPPLIER COMPANY', 35, 35, { width: 280 });
      doc.font('Helvetica').fontSize(8).fillColor('#334155')
         .text(companyProfile?.address || '', 35, 50, { width: 280 })
         .text(`Mobile: ${companyProfile?.mobile || ''}`, 35, 80, { width: 280 })
         .text(`GSTIN: ${companyProfile?.gstin || ''}`, 35, 92, { width: 280 });

      // Challan Heading
      doc.font('Helvetica-Bold').fontSize(14).fillColor('#0F172A')
         .text('DELIVERY CHALLAN', 320, 35, { width: 240, align: 'right' });
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#64748B')
         .text('(PROOF OF DELIVERY - NO COMMERCIAL VALUE)', 320, 50, { width: 240, align: 'right' });
    
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#334155')
         .text('Challan No: ', 320, 75, { width: 100, align: 'left' })
         .font('Helvetica').text(challanDto.challan_no, 420, 75, { width: 140, align: 'right' });
      doc.font('Helvetica-Bold')
         .text('Challan Date: ', 320, 88, { width: 100, align: 'left' })
         .font('Helvetica').text(formatDate(challanDto.date), 420, 88, { width: 140, align: 'right' });
      doc.font('Helvetica-Bold')
         .text('Order/Ref No: ', 320, 101, { width: 100, align: 'left' })
         .font('Helvetica').text(challanDto.order_no || 'N/A', 420, 101, { width: 140, align: 'right' });

      doc.moveTo(30, 125).lineTo(565.28, 125).stroke('#CCCCCC');

      // Customer Info
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#0F172A')
         .text('DELIVERED TO (CONSIGNEE):', 35, 135, { width: 250 });
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#334155')
         .text(challanDto.customer_name, 35, 148, { width: 250 });
      doc.font('Helvetica').fontSize(8)
         .text(clientAddress || '', 35, 160, { width: 250 });
      doc.font('Helvetica-Bold')
         .text(`GSTIN: `, 35, 195, { width: 50, align: 'left' })
         .font('Helvetica').text(challanDto.customer_gstin || 'N/A', 85, 195, { width: 200 });

      // Dispatch Details
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#0F172A')
         .text('DISPATCH DETAILS:', 320, 135, { width: 240 });
      doc.font('Helvetica').fontSize(8).fillColor('#334155')
         .text(`Notes: ${challanDto.notes || 'N/A'}`, 320, 148, { width: 240, height: 40 });

      doc.moveTo(30, 210).lineTo(565.28, 210).stroke('#CCCCCC');

      // Challan Items Table
      const challanTableY = 210;
      const challanHeaderH = 20;
      doc.rect(30, challanTableY, 535.28, challanHeaderH).fill('#F8FAFC');
      doc.fillColor('#0F172A');
    
      const challanCols = [
        { label: 'Sl No', width: 40, align: 'center' },
        { label: 'Particulars / Description of Goods', width: 295, align: 'left' },
        { label: 'HSN Code', width: 80, align: 'center' },
        { label: 'Qty (Pcs)', width: 60, align: 'right' },
        { label: 'Weight (Kg)', width: 60, align: 'right' }
      ];
      let challanColX = [];
      let currentChallanX = 30;
      for (let i = 0; i < challanCols.length; i++) {
        challanColX.push(currentChallanX);
        currentChallanX += challanCols[i].width;
      }

      challanCols.forEach((col, idx) => {
        doc.font('Helvetica-Bold').fontSize(8);
        doc.text(col.label, challanColX[idx] + 4, challanTableY + 6, { width: col.width - 8, align: col.align });
      });
      doc.moveTo(30, challanTableY + challanHeaderH).lineTo(565.28, challanTableY + challanHeaderH).stroke('#CCCCCC');

      let itemY = challanTableY + challanHeaderH;
      let rowSl = 1;
      for (const item of challanDto.items) {
        const itemDesc = item.particulars || 'Item';
        const note = item.note ? `\nNote: ${item.note}` : '';
        const fullText = itemDesc + note;
        const descHeight = doc.heightOfString(fullText, { width: 295 - 8, fontSize: 8 });
        const rowHeight = Math.max(20, descHeight + 6);
      
        doc.font('Helvetica').fontSize(8).fillColor('#334155');
        doc.text(String(rowSl++), challanColX[0] + 4, itemY + 6, { width: challanCols[0].width - 8, align: 'center' });
        doc.font('Helvetica-Bold').text(itemDesc, challanColX[1] + 4, itemY + 6, { width: challanCols[1].width - 8, align: 'left' });
        if (item.note) {
          doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#64748B').text(item.note, challanColX[1] + 4, itemY + 16, { width: challanCols[1].width - 8, align: 'left' });
        }
        doc.font('Helvetica').fontSize(8).fillColor('#334155');
        doc.text(item.hsn_code || 'N/A', challanColX[2] + 4, itemY + 6, { width: challanCols[2].width - 8, align: 'center' });
        doc.text(Number(item.quantity_pcs).toFixed(2), challanColX[3] + 4, itemY + 6, { width: challanCols[3].width - 8, align: 'right' });
        doc.text(Number(item.weight).toFixed(2), challanColX[4] + 4, itemY + 6, { width: challanCols[4].width - 8, align: 'right' });
      
        itemY += rowHeight;
        doc.moveTo(30, itemY).lineTo(565.28, itemY).stroke('#E2E8F0');
      }

      for (let i = 1; i < challanColX.length; i++) {
        doc.moveTo(challanColX[i], challanTableY).lineTo(challanColX[i], itemY).stroke('#E2E8F0');
      }

      const footerY = 720;
      doc.moveTo(30, footerY).lineTo(565.28, footerY).stroke('#E2E8F0');
    
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#0F172A')
         .text("Receiver's Signature & Stamp:", 35, footerY + 10);
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#64748B')
         .text('(Sign below upon receipt of goods)', 35, footerY + 20)
         .text('Date: ____/____/________', 35, footerY + 50);

      doc.font('Helvetica-Bold').fontSize(8).fillColor('#0F172A')
         .text(`For ${companyProfile?.company_name || 'SUPPLIER COMPANY'}`, 350, footerY + 10, { width: 210, align: 'right' });
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#64748B')
         .text('Authorised Signatory / Despatched By', 350, footerY + 55, { width: 210, align: 'right' });
    }

    doc.end();
    return finished;
  }

  return {
    rowToInvoiceLineDto,
    rowToInvoiceHeaderDto,
    listInvoices,
    getInvoiceDtoById,
    generateInvoiceNumber,
    normalizePositiveNumber,
    createInvoice,
    numberToIndianWords,
    generateInvoicePdf,
  };
}

module.exports = { createInvoiceService };
