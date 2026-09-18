// ─── Receipt building utilities ───────────────────────────────────────────────
// All functions are pure (no Vue refs). Callers pass .value of reactive state.

// Receipts/invoices are always rendered in Arabic regardless of the app UI language.
const t = (k, v) => {
    const dict = (window.I18N && window.I18N.ar) || {};
    const s = dict[k] || k;
    return v ? s.replace(/\{(\w+)\}/g, (_, x) => (x in v ? v[x] : '{' + x + '}')) : s;
};

// ── ZATCA QR SVG builder ─────────────────────────────────────────────────────
// Renders the ZATCA TLV base64 as an inline SVG QR code for receipt embedding.
// design: 'classic' | 'slim' | 'slim2' | 'elegant' | 'detailed' | 'columnize-taxes'
function buildZatcaQrSvg(tlvBase64, design) {
    if (!tlvBase64 || typeof qrcode === 'undefined') return '';
    try {
        const qr = qrcode(0, 'M');
        qr.addData(tlvBase64);
        qr.make();

        if (design === 'classic') {
            // Classic A4: QR replaces the header alignment cell — use a larger size for readability.
            const svg = qr.createSvgTag({ scalable: true })
                .replace('<svg ', '<svg style="width:200px;height:200px;display:block;" ');
            return `<div style="text-align:center;">`
                + svg
                + `<p style="font-size:9px;margin:3px 0 0;color:#666;">${t('zatca_qr_caption')}</p>`
                + `</div>`;
        }

        if (['elegant', 'detailed', 'columnize-taxes'].includes(design)) {
            // A4 footer: centred, larger QR for readability.
            const svg = qr.createSvgTag({ scalable: true })
                .replace('<svg ', '<svg style="width:180px;height:180px;" ');
            return `<div style="text-align:center;margin:12px 0;">`
                + svg
                + `<p style="font-size:9px;margin:3px 0 0;color:#666;">${t('zatca_qr_caption')}</p>`
                + `</div>`;
        }

        // Slim / slim2 thermal: 120px fits the narrow receipt width.
        const svg = qr.createSvgTag({ scalable: true })
            .replace('<svg ', '<svg style="width:120px;height:120px;" ');
        return `<div style="text-align:center;margin:10px 0;">`
            + svg
            + `<p style="font-size:9px;margin:3px 0 0;color:#666;">${t('zatca_qr_caption')}</p>`
            + `</div>`;
    } catch (e) { return ''; }
}

const RECEIPT_PRINT_TYPE_BY_CONNECTION = {
    zat_tray:  'printer',
    bluetooth: 'bluetooth_android',
    usb:       'usb_android',
    wifi:      'wifi_android',
};

function getLocationForSale(sale, locations, settings) {
    const locationId = sale?.location_id || settings.locationId;
    return locations.find(l => String(l.id) === String(locationId)) || null;
}

function getPrinterForLocation(location, printers) {
    const printerId = location?.printer_id;
    return printers.find(p => String(p.id) === String(printerId)) || null;
}

function getInvoiceLayoutForSale(sale, locations, invoiceLayouts, settings) {
    const location = getLocationForSale(sale, locations, settings) || {};
    const layoutId = location.invoice_layout_id;
    return (invoiceLayouts || []).find(l => String(l.id) === String(layoutId)) || null;
}

function getResolvedPrintType(location, printer) {
    const explicitType = location?.receipt_printer_type;
    if (explicitType) return explicitType;
    const connectionType = printer?.connection_type;
    return RECEIPT_PRINT_TYPE_BY_CONNECTION[connectionType] || 'browser';
}

function primePrinterSelection(receipt) {
    if (!receipt) return;
    if (receipt.print_type === 'bluetooth_android' && typeof window.zatSetBluetoothPrinter === 'function') {
        window.zatSetBluetoothPrinter({
            name:    receipt.bluetooth_printer_name    || '',
            address: receipt.bluetooth_printer_address || '',
        });
    }
    if (receipt.print_type === 'usb_android' && typeof window.zatSetUsbPrinter === 'function') {
        window.zatSetUsbPrinter({
            name:       receipt.usb_printer_name || '',
            deviceName: receipt.usb_device_name  || '',
        });
    }
}

// ─── Currency formatter ────────────────────────────────────────────────────────

function makeFormatter() {
    const cur = t('receipt_currency_symbol');
    return (n) => `${cur} ${(+(n || 0)).toFixed(2)}`;
}

function fQty(q) {
    const n = parseFloat(q) || 0;
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// ─── Arabic payment method labels ─────────────────────────────────────────────

const PAY_METHOD_KEYS = {
    cash:            'receipt_pay_cash',
    card:            'receipt_pay_card',
    'credit card':   'receipt_pay_credit_card',
    'debit card':    'receipt_pay_debit_card',
    bank_transfer:   'receipt_pay_bank_transfer',
    'bank transfer': 'receipt_pay_bank_transfer',
    cheque:          'receipt_pay_cheque',
    check:           'receipt_pay_cheque',
};

function arPayMethod(method) {
    const key = PAY_METHOD_KEYS[(method || '').toLowerCase()];
    return key ? t(key) : (method || '');
}

// ─── Items row builders (one per design) ──────────────────────────────────────

function lineDisc(item) {
    const gross = (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0);
    return item.line_discount_type === 'percentage'
        ? gross * ((parseFloat(item.line_discount_amount) || 0) / 100)
        : (parseFloat(item.line_discount_amount) || 0);
}

function lineTotal(item) {
    const gross = (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0);
    return gross - lineDisc(item);
}

// slim2 (58mm thermal): single-column layout with flex numeric row
function buildSlim2ItemsHtml(items, settings, hidePrices) {
    const f = makeFormatter();
    const headerRow = !hidePrices
        ? `<tr class="bb-lg slim2-line-items-header">`
            + `<td class="description" style="text-align:right;padding-bottom:6px;">`
            + `<div class="slim2-numeric-row slim2-numeric-header" dir="rtl">`
            + `<span dir="rtl">${t('receipt_currency_symbol')}</span>`
            + `<span dir="rtl">${t('receipt_unit_price')}</span>`
            + `<span dir="rtl">${t('receipt_qty')}</span>`
            + `</div></td></tr>`
        : '';
    const rows = (items || []).map((item, idx) => {
        const unitPriceDisplay = item.unit_price_exc_tax ?? item.unit_price;
        const disc  = lineDisc(item);
        const total = lineTotal(item);
        const noteHtml = item.line_note ? `<br><span class="f-8">${item.line_note}</span>` : '';
        const discHtml = disc > 0 ? ` <span class="f-8"> - ${f(disc)}</span>` : '';
        const numericRow = !hidePrices
            ? `<div class="slim2-numeric-row" dir="rtl">`
                + `<span class="bw" style="white-space:nowrap;">${f(total)}</span>`
                + `<span class="bw">${f(unitPriceDisplay)}${discHtml}</span>`
                + `<span class="bw" dir="ltr">${fQty(item.quantity)}</span>`
                + `</div>`
            : `<div class="slim2-numeric-row slim2-numeric-row-qty-only" dir="rtl">`
                + `<span class="bw" dir="ltr">${fQty(item.quantity)}</span>`
                + `</div>`;
        return `<tr class="bb-lg">`
            + `<td class="description receipt-desc-text" style="text-align:right;">`
            + `<div style="display:flex;width:100%;justify-content:flex-start;flex-direction:row-reverse;">`
            + `<p class="m-0 mt-5" style="white-space:nowrap;text-align:right;">#${idx + 1}.&nbsp;</p>`
            + `<p class="text-right m-0 mt-5" style="flex:1;text-align:right;">${item.name}${noteHtml}</p>`
            + `</div>`
            + numericRow
            + `</td></tr>`;
    }).join('');
    return headerRow + rows;
}

// slim (80mm thermal): #, product, qty, [unit_price, total]
function buildSlimItemsHtml(items, settings, hidePrices) {
    const f = makeFormatter();
    return (items || []).map((item, idx) => {
        const disc    = lineDisc(item);
        const total   = lineTotal(item);
        const noteHtml = item.line_note ? `<br><span class="f-8">${item.line_note}</span>` : '';
        const discNote = disc > 0
            ? `<br><span class="f-8">${item.line_discount_type === 'percentage'
                ? t('receipt_discount_percent', { value: item.line_discount_amount })
                : t('receipt_discount_amount', { value: f(disc) })}</span>`
            : '';
        const qtyCell = `<span class="company-copy-qty-badge">${fQty(item.quantity)}</span>`;
        if (hidePrices) {
            return `<tr>`
                + `<td class="serial_number" style="vertical-align:top;">${idx + 1}</td>`
                + `<td class="description text-right receipt-desc-text">${item.name}${noteHtml}</td>`
                + `<td class="quantity text-right">${qtyCell}</td>`
                + `</tr>`;
        }
        const unitPriceDisplay = item.unit_price_exc_tax ?? item.unit_price;
        return `<tr>`
            + `<td class="serial_number" style="vertical-align:top;">${idx + 1}</td>`
            + `<td class="description text-right receipt-desc-text">${item.name}${noteHtml}${discNote}</td>`
            + `<td class="quantity text-right">${qtyCell}</td>`
            + `<td class="unit_price text-right">${f(unitPriceDisplay)}</td>`
            + `<td class="price text-right">${f(total)}</td>`
            + `</tr>`;
    }).join('');
}

// classic (A4 7-col): # | اسم المنتج | الكمية | سعر الوحده | الخصم | ضريبة الوحده | السعر مع الضريبة
function buildClassicItemsHtml(items, settings) {
    const f = makeFormatter();
    const serialColW = 7;
    const productColW = 23;
    const colW = (100 - serialColW - productColW) / 5;
    return (items || []).map((item, idx) => {
        const disc         = lineDisc(item);
        const total        = lineTotal(item);
        const unitPriceExc = item.unit_price_exc_tax ?? item.unit_price;
        const taxPerUnit   = item.item_tax_per_unit  ?? 0;
        const note         = item.line_note
            ? `<br><small style="color:#555;">${t('receipt_note_prefix', { note: item.line_note })}</small>`
            : '';
        return `<tr>`
            + `<td style="border:1px solid #ccc;padding:8px 10px;text-align:center;vertical-align:top;width:${serialColW}%;word-wrap:break-word;overflow-wrap:break-word;">${idx + 1}</td>`
            + `<td style="border:1px solid #ccc;padding:8px 10px;vertical-align:top;width:${productColW}%;word-wrap:break-word;overflow-wrap:break-word;">`
            + `${item.name}${note}</td>`
            + `<td style="border:1px solid #ccc;padding:8px 10px;text-align:center;vertical-align:top;width:${colW}%;word-wrap:break-word;">${fQty(item.quantity)}</td>`
            + `<td style="border:1px solid #ccc;padding:8px 10px;text-align:right;vertical-align:top;width:${colW}%;word-wrap:break-word;">${f(unitPriceExc)}</td>`
            + `<td style="border:1px solid #ccc;padding:8px 10px;text-align:right;vertical-align:top;width:${colW}%;word-wrap:break-word;">${f(disc)}</td>`
            + `<td style="border:1px solid #ccc;padding:8px 10px;text-align:right;vertical-align:top;width:${colW}%;word-wrap:break-word;">${f(taxPerUnit)}</td>`
            + `<td style="border:1px solid #ccc;padding:8px 10px;text-align:right;vertical-align:top;width:${colW}%;word-wrap:break-word;">${f(total)}</td>`
            + `</tr>`;
    }).join('');
}

// elegant (A4): #, اسم المنتج, الكمية, سعر الوحدة (exc-tax), الإجمالي (exc-tax)
function buildElegantItemsHtml(items, settings) {
    const f = makeFormatter();
    return (items || []).map((item, idx) => {
        const unitPriceExc = item.unit_price_exc_tax ?? item.unit_price;
        // الإجمالي column in elegant blade = line_total_exc_tax (exc-tax net)
        const taxPercent  = item.tax_percent || 0;
        const totalInc    = lineTotal(item);
        const totalExc    = taxPercent > 0 ? totalInc / (1 + taxPercent / 100) : totalInc;
        const note        = item.line_note
            ? `<br><small>${item.line_note}</small>`
            : '';
        return `<tr>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:center;">${idx + 1}</td>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${item.name}${note}</td>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${fQty(item.quantity)}</td>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${f(unitPriceExc)}</td>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${f(totalExc)}</td>`
            + `</tr>`;
    }).join('');
}

// detailed (A4 9-col): #, name, qty, unit_price_exc, unit_price_inc (السعر بعد الخصم), item_disc, tax_per_unit, unit_price_inc, total_inc
function buildDetailedItemsHtml(items, settings) {
    const f = makeFormatter();
    return (items || []).map((item, idx) => {
        const disc         = lineDisc(item);
        const total        = lineTotal(item);
        const unitPriceExc = item.unit_price_exc_tax ?? item.unit_price;
        const taxPerUnit   = item.item_tax_per_unit  ?? 0;
        const unitPriceInc = parseFloat(item.unit_price) || 0;
        const note         = item.line_note
            ? `<br><small class="text-muted">${item.line_note}</small>`
            : '';
        return `<tr>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:center;">${idx + 1}</td>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${item.name}${note}</td>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${fQty(item.quantity)}</td>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${f(unitPriceExc)}</td>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${f(unitPriceInc)}</td>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${f(disc)}</td>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${f(taxPerUnit)}</td>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${f(unitPriceInc)}</td>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${f(total)}</td>`
            + `</tr>`;
    }).join('');
}

// columnize-taxes (A4): #, name, qty, unit_price (exc), taxable_value (exc), total (inc)
function buildColumnizeTaxesItemsHtml(items, settings) {
    const f = makeFormatter();
    return (items || []).map((item, idx) => {
        const total        = lineTotal(item);  // inc-tax
        const unitPriceExc = item.unit_price_exc_tax ?? item.unit_price;
        const taxableValue = (parseFloat(item.quantity) || 0) * unitPriceExc - lineDisc(item);
        const note         = item.line_note
            ? `<br><small class="text-muted">${item.line_note}</small>`
            : '';
        return `<tr>`
            + `<td class="text-center">${idx + 1}</td>`
            + `<td class="text-right" style="word-break:break-all;">${item.name}${note}</td>`
            + `<td class="text-right">${fQty(item.quantity)}</td>`
            + `<td class="text-right">${f(unitPriceExc)}</td>`
            + `<td class="text-right">${f(taxableValue)}</td>`
            + `<td class="text-right">${f(total)}</td>`
            + `</tr>`;
    }).join('');
}

function buildItemsHtml(items, design, settings, hidePrices) {
    switch (design) {
        case 'slim2':
            return buildSlim2ItemsHtml(items, settings, hidePrices);
        case 'slim':
            return buildSlimItemsHtml(items, settings, hidePrices);
        case 'elegant':
            return buildElegantItemsHtml(items, settings);
        case 'detailed':
            return buildDetailedItemsHtml(items, settings);
        case 'columnize-taxes':
            return buildColumnizeTaxesItemsHtml(items, settings);
        case 'classic':
        default:
            return buildClassicItemsHtml(items, settings);
    }
}

// ─── Totals HTML builders (one per design family) ─────────────────────────────

// Computes aggregated sale figures from sale object
function saleAggregates(sale) {
    const items = sale.items || [];
    const tax   = parseFloat(sale.tax)  || 0;
    const total = parseFloat(sale.total) || 0;

    // Exc-tax subtotal: sum of (line inc-tax net ÷ (1 + tax_rate)) for each item
    // Falls back to (total - tax) when items have no tax_percent stored (old records).
    const hasPerItemTax = items.some(i => (i.tax_percent || 0) > 0);
    const subtotal = hasPerItemTax
        ? items.reduce((sum, item) => {
            const lineNetInc = lineTotal(item);
            const tp = item.tax_percent || 0;
            return sum + (tp > 0 ? lineNetInc / (1 + tp / 100) : lineNetInc);
          }, 0)
        : total - tax;

    return {
        subtotal,
        orderDiscount: parseFloat(sale.discount)        || 0,
        totalLinDisc:  parseFloat(sale.total_line_disc) || 0,
        tax,
        total,
        paid:          parseFloat(sale.paid)            || 0,
    };
}

// slim / slim2 totals (flex-box rows)
function buildSlimTotalsHtml(sale, settings) {
    const f   = makeFormatter();
    const agg = saleAggregates(sale);
    const change = Math.max(0, agg.paid - agg.total);

    const payRows = (sale.payments || []).map(p => {
        const label = arPayMethod(p.method);
        const date  = p.created_at ? new Date(p.created_at).toLocaleDateString('ar-SA') : '';
        return `<div class="flex-box">`
            + `<p class="width-50 text-right">${label}${date ? ' (<span dir="ltr">' + date + '</span>)' : ''}</p>`
            + `<p class="width-50 text-right">${f(p.amount)}</p>`
            + `</div>`;
    }).join('');

    return ''
        + `<div class="flex-box"><p class="left text-right sub-headings">${t('receipt_subtotal')}</p><p class="width-50 text-right sub-headings">${f(agg.subtotal)}</p></div>`
        + (agg.tax > 0 ? `<div class="flex-box"><p class="width-50 text-right"><strong>${t('receipt_vat')}</strong></p><p class="width-50 text-right">(+) ${f(agg.tax)}</p></div>` : '')
        + `<div class="flex-box"><p class="width-50 text-right sub-headings"><bdi dir="rtl" lang="ar" class="slim-ar-header-text">${t('receipt_total')}</bdi></p><p class="width-50 text-right sub-headings">${f(agg.total)}</p></div>`
        + payRows
        + (agg.paid > 0 ? `<div class="flex-box"><p class="width-50 text-right">${t('receipt_total_paid')}</p><p class="width-50 text-right">${f(agg.paid)}</p></div>` : '')
        + (change > 0.005 ? `<div class="flex-box"><p class="width-50 text-right">${t('receipt_change')}</p><p class="width-50 text-right">${f(change)}</p></div>` : '');
}

// classic totals (invoice-pdf-summary-row structure)
function buildClassicTotalsHtml(sale, settings) {
    const f   = makeFormatter();
    const agg = saleAggregates(sale);

    const payRows = (sale.payments || []).map(p => {
        const colW = (100 / 3).toFixed(2);
        const date  = p.created_at ? new Date(p.created_at).toLocaleDateString('ar-SA') : '';
        return `<tr>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;width:${colW}%;word-wrap:break-word;">${arPayMethod(p.method)}</td>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;width:${colW}%;word-wrap:break-word;">${f(p.amount)}</td>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;width:${colW}%;word-wrap:break-word;">${date}</td>`
            + `</tr>`;
    }).join('');

    const paymentsHtml = (sale.payments || []).length
        ? `<div style="margin-bottom:1rem;">`
            + `<h4 style="border-bottom:1px solid #ccc;padding-bottom:0.3rem;font-weight:600;">${t('receipt_payment_details')}</h4>`
            + `<table style="width:100%;font-size:13px;border-collapse:collapse;table-layout:fixed;">`
            + `<thead><tr style="background-color:#f7f7f7;font-weight:600;">`
            + `<th style="border:1px solid #ccc;padding:6px 8px;">${t('receipt_payment_method')}</th>`
            + `<th style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${t('receipt_amount')}</th>`
            + `<th style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${t('receipt_date')}</th>`
            + `</tr></thead><tbody>${payRows}</tbody></table></div>`
        : '';

    // Derive VAT percentage label from items (e.g. "15%")
    const items = sale.items || [];
    const taxPcts = [...new Set(items.map(i => i.tax_percent || 0).filter(pct => pct > 0))];
    const vatPctLabel = taxPcts.length === 1 ? ` ${taxPcts[0]}٪` : '';
    const amountDue = Math.max(0, agg.total - agg.paid);

    return `<div class="invoice-pdf-summary-row" style="font-size:14px;display:flex;justify-content:space-between;gap:3rem;flex-wrap:wrap;margin-bottom:1rem;">`
        + `<div class="invoice-pdf-summary-col-a" style="min-width:180px;text-align:right;">`
        + `<p><strong>${t('receipt_subtotal_ex_tax')}</strong> ${f(agg.subtotal)}</p>`
        + (agg.orderDiscount > 0 ? `<p><strong>${t('receipt_discount_label')}</strong> ${f(agg.orderDiscount)}</p>` : '')
        + (agg.tax > 0 ? `<p><strong>${t('receipt_vat_with_pct', { pct: vatPctLabel })}</strong> ${f(agg.tax)}</p>` : '')
        + `<p style="font-weight:700;font-size:1.1rem;"><strong>${t('receipt_grand_total_inc_tax')}</strong> ${f(agg.total)}</p>`
        + `</div>`
        + `<div class="invoice-pdf-summary-col-b" style="min-width:160px;text-align:right;">`
        + `<p><strong>${t('receipt_amount_paid')}</strong> ${f(agg.paid)}</p>`
        + `<p><strong>${t('receipt_amount_due')}</strong> ${f(amountDue)}</p>`
        + `</div></div>`
        + paymentsHtml;
}

// elegant / detailed totals (2-col layout: payments left, summary right)
function buildA4TotalsHtml(sale, settings) {
    const f   = makeFormatter();
    const agg = saleAggregates(sale);

    const payRows = (sale.payments || []).map(p => {
        const date = p.created_at ? new Date(p.created_at).toLocaleDateString('ar-SA') : '';
        return `<tr>`
            + `<td style="padding:6px 8px;text-align:right;">${arPayMethod(p.method)}</td>`
            + `<td style="padding:6px 8px;text-align:right;">${f(p.amount)}</td>`
            + `<td style="padding:6px 8px;text-align:right;">${date}</td>`
            + `</tr>`;
    }).join('');

    const a4Items = sale.items || [];
    const a4TaxPcts = [...new Set(a4Items.map(i => i.tax_percent || 0).filter(pct => pct > 0))];
    const a4VatLabel = `${t('receipt_vat_full_label')}${a4TaxPcts.length === 1 ? ` ${a4TaxPcts[0]}٪` : ''}`;

    const summaryRows = ''
        + `<tr><td style="width:50%;text-align:right;">${t('receipt_subtotal')}</td><td style="text-align:right;">${f(agg.subtotal)}</td></tr>`
        + (agg.tax > 0 ? `<tr><td style="text-align:right;">${a4VatLabel}</td><td style="text-align:right;">(+) ${f(agg.tax)}</td></tr>` : '')
        + `<tr style="font-weight:700;"><th style="background-color:#357ca5;color:white;text-align:right;padding:10px;">${t('receipt_total')}</th><td style="text-align:right;background-color:#357ca5;color:white;padding:10px;">${f(agg.total)}</td></tr>`;

    return `<div class="row invoice-info" style="page-break-inside:avoid !important">`
        + `<div class="col-md-6 invoice-col width-50">`
        + `<table class="table table-slim" style="direction:rtl;">`
        + `<thead><tr style="background-color:#f7f7f7;font-weight:600;">`
        + `<th style="padding:6px 8px;text-align:right;">${t('receipt_payment_method')}</th>`
        + `<th style="padding:6px 8px;text-align:right;">${t('receipt_amount')}</th>`
        + `<th style="padding:6px 8px;text-align:right;">${t('receipt_date')}</th>`
        + `</tr></thead><tbody>${payRows}</tbody></table>`
        + `</div>`
        + `<div class="col-md-6 invoice-col width-50">`
        + `<table class="table-no-side-cell-border table-no-top-cell-border width-100 table-slim" style="direction:rtl;width:100%;">`
        + `<tbody>${summaryRows}</tbody></table>`
        + `</div></div>`;
}

// columnize-taxes totals (same 2-col layout as elegant/detailed)
function buildColumnizeTaxesTotalsHtml(sale, settings) {
    return buildA4TotalsHtml(sale, settings);
}

function buildTotalsHtml(sale, design, settings) {
    switch (design) {
        case 'slim':
        case 'slim2':
            return buildSlimTotalsHtml(sale, settings);
        case 'classic':
            return buildClassicTotalsHtml(sale, settings);
        case 'elegant':
        case 'detailed':
            return buildA4TotalsHtml(sale, settings);
        case 'columnize-taxes':
            return buildColumnizeTaxesTotalsHtml(sale, settings);
        default:
            return buildA4TotalsHtml(sale, settings);
    }
}

// ─── Fill a server-rendered receipt template with sale-specific data ──────────
// The template was pre-rendered by the Blade view with placeholder tokens.
function fillReceiptTemplate(templateHtml, sale, settings, locations, invoiceLayouts, design) {
    const resolvedDesign = design || 'slim';
    const layout = getInvoiceLayoutForSale(sale, locations, invoiceLayouts, settings) || {};
    const cs     = layout.common_settings || {};
    const hidePrices = !!(typeof cs === 'string' ? JSON.parse(cs || '{}') : cs).hide_price;

    const invoiceNo   = sale.server_invoice_no || sale.invoice_no || '';
    const invoiceDate = new Date(sale.created_at).toLocaleString('ar-SA', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const cashCustomerLabel = t('receipt_cash_customer');
    const customerInfo = (sale.customer_name || cashCustomerLabel)
        .replace('Walk-In Customer', cashCustomerLabel)
        .replace('Walk In Customer', cashCustomerLabel);

    let html = templateHtml
        .replace(/ZAT_INVOICE_NO/g,   invoiceNo)
        .replace(/ZAT_INVOICE_DATE/g,  invoiceDate)
        .replace(/ZAT_CUSTOMER_INFO/g, customerInfo);

    const itemsHtml  = buildItemsHtml(sale.items, resolvedDesign, settings, hidePrices);
    const totalsHtml = hidePrices && (resolvedDesign === 'slim' || resolvedDesign === 'slim2')
        ? ''
        : buildTotalsHtml(sale, resolvedDesign, settings);

    html = html.replace('<!-- ZAT_ITEMS_PLACEHOLDER -->', itemsHtml);
    html = html.replace('<!-- ZAT_TOTALS_PLACEHOLDER -->', totalsHtml);
    html = html.replace('<!-- ZAT_ZATCA_QR_PLACEHOLDER -->', buildZatcaQrSvg(sale.zatca_qr_code || null, resolvedDesign));

    return html;
}

function resolvePrinterForLocalPrint(location, printers, localPrinters, localPrinterName) {
    const locationPrinter = getPrinterForLocation(location, printers) || {};
    const selectedName = String(localPrinterName || '').trim();
    if (!selectedName) {
        return {
            printer: locationPrinter,
            printType: getResolvedPrintType(location, locationPrinter),
        };
    }

    const all = []
        .concat(Array.isArray(localPrinters) ? localPrinters : [])
        .concat(Array.isArray(printers) ? printers : []);
    const selected = all.find((p) => p && String(p.name || '').toLowerCase() === selectedName.toLowerCase()) || null;
    const trayDeviceName = (selected && (selected.tray_printer_name || selected.name)) || selectedName;

    return {
        // Local/explicit selection always goes through ZAT Tray.
        printer: {
            ...(selected || locationPrinter),
            name: selectedName,
            tray_printer_name: trayDeviceName,
            connection_type: 'zat_tray',
        },
        printType: 'printer',
    };
}

// ─── Build the full receipt payload for local (offline) printing ──────────────
// Returns null if no template is cached (user must pull data first).
function buildLocalReceiptPayload(sale, settings, locations, printers, invoiceLayouts, receiptTemplate, business, receiptTemplateDesign, localPrinterName, localPrinters) {
    if (!receiptTemplate) return null;

    const location  = getLocationForSale(sale, locations, settings) || {};
    const resolved  = resolvePrinterForLocalPrint(location, printers, localPrinters, localPrinterName);
    const printer   = resolved.printer || {};
    const printType = resolved.printType;
    const html      = fillReceiptTemplate(receiptTemplate, sale, settings, locations, invoiceLayouts, receiptTemplateDesign);
    const printerName = printer.tray_printer_name || printer.name || null;

    return {
        is_enabled:                 location.print_receipt_on_invoice !== 0 && location.print_receipt_on_invoice !== '0',
        print_type:                 printType,
        print_title:                sale.server_invoice_no || sale.invoice_no || 'Receipt',
        transaction_id:             sale.server_id || null,
        html_content:               html,
        printer_config:             printer,
        bluetooth_printer_name:     printerName,
        bluetooth_printer_address:  printer.bluetooth_address || null,
        usb_printer_name:           printerName,
        usb_device_name:            printer.usb_device_name   || null,
        wifi_printer_name:          printerName,
        wifi_printer_ip_address:    printer.ip_address        || null,
        wifi_printer_port:          printer.wifi_port         || 9100,
    };
}

function getReceiptPayloadForSale(sale) {
    if (sale?.server_receipt?.html_content) {
        return sale.server_receipt;
    }
    return null;
}
