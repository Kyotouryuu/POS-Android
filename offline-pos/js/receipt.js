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
function buildZatcaQrSvg(tlvBase64, design, size) {
    if (!tlvBase64 || typeof qrcode === 'undefined') return '';
    try {
        // Error correction 'L' (7%) — ZATCA TLV is small and prints on clean thermal
        // paper, so we don't need the higher redundancy of 'M'. Lower EC = lower QR
        // version = fewer, chunkier modules → cleaner scan target at the same size.
        const qr = qrcode(0, 'L');
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

        // Slim / slim2 thermal: embed explicit inline size so html2canvas lays out the
        // SVG at the correct dimensions before CSS is applied (avoids prepareCaptureDom's
        // maxWidth:100% causing the container to be sized at the full paper width).
        const inlineSz = typeof size === 'number' ? `width:${size}px;height:${size}px;` : 'width:120px;height:120px;';
        const svg = qr.createSvgTag({ scalable: true })
            .replace('<svg ', `<svg style="${inlineSz}display:inline-block;" `);
        return `<div style="text-align:center;margin:10px 0;direction:ltr;">`
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

function modifiersSummary(item) {
    const mods = (item.selected_modifiers || []).filter(m => m.option_name);
    if (!mods.length) return '';
    return '(' + mods.map(m => m.option_name).join(', ') + ')';
}

function modifiersLineTotal(item) {
    return (item.selected_modifiers || []).reduce((s, m) => s + (m.price || 0), 0)
        * (parseFloat(item.quantity) || 1);
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
        const modSummary = modifiersSummary(item);
        const modHtml = !hidePrices && modSummary ? `<br><span class="f-8">${modSummary}</span>` : '';
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
            + `<p class="text-right m-0 mt-5" style="flex:1;text-align:right;">${item.name}${noteHtml}${modHtml}</p>`
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
        const modSummary = modifiersSummary(item);
        const modRow = modSummary
            ? `<tr>`
                + `<td></td>`
                + `<td class="description text-right receipt-desc-text" colspan="3"><span class="f-8">${modSummary}</span></td>`
                + `<td class="price text-right"><span class="f-8">${f(modifiersLineTotal(item))}</span></td>`
                + `</tr>`
            : '';
        return `<tr>`
            + `<td class="serial_number" style="vertical-align:top;">${idx + 1}</td>`
            + `<td class="description text-right receipt-desc-text">${item.name}${noteHtml}${discNote}</td>`
            + `<td class="quantity text-right">${qtyCell}</td>`
            + `<td class="unit_price text-right">${f(unitPriceDisplay)}</td>`
            + `<td class="price text-right">${f(total)}</td>`
            + `</tr>`
            + modRow;
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
        const modSummary = modifiersSummary(item);
        const modRow = modSummary
            ? `<tr>`
                + `<td style="border:1px solid #ccc;padding:8px 10px;text-align:center;">&nbsp;</td>`
                + `<td style="border:1px solid #ccc;padding:8px 10px;width:${productColW}%;"><small>${modSummary}</small></td>`
                + `<td style="border:1px solid #ccc;padding:8px 10px;" colspan="4">&nbsp;</td>`
                + `<td style="border:1px solid #ccc;padding:8px 10px;text-align:right;">${f(modifiersLineTotal(item))}</td>`
                + `</tr>`
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
            + `</tr>`
            + modRow;
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
        const modSummary = modifiersSummary(item);
        const modRow = modSummary
            ? `<tr>`
                + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:center;">&nbsp;</td>`
                + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;"><small>${modSummary}</small></td>`
                + `<td style="border:1px solid #ccc;padding:6px 8px;" colspan="2">&nbsp;</td>`
                + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${f(modifiersLineTotal(item))}</td>`
                + `</tr>`
            : '';
        return `<tr>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:center;">${idx + 1}</td>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${item.name}${note}</td>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${fQty(item.quantity)}</td>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${f(unitPriceExc)}</td>`
            + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${f(totalExc)}</td>`
            + `</tr>`
            + modRow;
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
        const modSummary = modifiersSummary(item);
        const modRow = modSummary
            ? `<tr>`
                + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:center;">&nbsp;</td>`
                + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;"><small>${modSummary}</small></td>`
                + `<td style="border:1px solid #ccc;padding:6px 8px;" colspan="6">&nbsp;</td>`
                + `<td style="border:1px solid #ccc;padding:6px 8px;text-align:right;">${f(modifiersLineTotal(item))}</td>`
                + `</tr>`
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
            + `</tr>`
            + modRow;
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
        const modSummary = modifiersSummary(item);
        const modRow = modSummary
            ? `<tr>`
                + `<td class="text-center">&nbsp;</td>`
                + `<td class="text-right" style="word-break:break-all;"><small>${modSummary}</small></td>`
                + `<td class="text-right" colspan="3">&nbsp;</td>`
                + `<td class="text-right">${f(modifiersLineTotal(item))}</td>`
                + `</tr>`
            : '';
        return `<tr>`
            + `<td class="text-center">${idx + 1}</td>`
            + `<td class="text-right" style="word-break:break-all;">${item.name}${note}</td>`
            + `<td class="text-right">${fQty(item.quantity)}</td>`
            + `<td class="text-right">${f(unitPriceExc)}</td>`
            + `<td class="text-right">${f(taxableValue)}</td>`
            + `<td class="text-right">${f(total)}</td>`
            + `</tr>`
            + modRow;
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

    const isReturn = sale.type === 'sell_return';

    let html = templateHtml
        .replace(/ZAT_INVOICE_NO/g,   invoiceNo)
        .replace(/ZAT_INVOICE_DATE/g,  invoiceDate)
        .replace(/ZAT_CUSTOMER_INFO/g, customerInfo);

    if (isReturn) {
        const returnBadge = `<div style="text-align:center;font-weight:900;font-size:1.3em;border:2px solid #000;padding:4px 0;margin:6px 0;">مرتجع بيع</div>`;
        const parentLine  = sale.return_parent_invoice_no
            ? `<div style="font-size:0.9em;margin-top:2px;">الفاتورة الأصلية: ${sale.return_parent_invoice_no}</div>`
            : '';
        html = returnBadge + html + parentLine;
    }

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

// ─── Self-contained mobile thermal receipt ────────────────────────────────────
// Bypasses receiptTemplate.value (the cloud-synced A4 wrapper) entirely.
//
// Design rules (both 58mm and 80mm):
//   - Strict 2-column layout: labels on right (Arabic RTL), values on left (LTR)
//   - NO 3-column table rows, NO middle columns
//   - Font size ~14-15px on BOTH widths — content wraps to more lines on 58mm
//     rather than shrinking, so it stays legible without a magnifying glass
//   - Item = 2 rows: line1 "name | total", line2 (small) "qty × unit_price"
//   - QR at very bottom in its own centered block
function buildMobileThermalReceiptHtml(sale, settings, business, locations, invoiceLayouts, thermalWidthPx, applyLayoutSettings) {
    const is58mm = (thermalWidthPx || 384) <= 400;
    const isReturn = sale.type === 'sell_return';
    const location = getLocationForSale(sale, locations, settings) || {};
    const layout = getInvoiceLayoutForSale(sale, locations, invoiceLayouts, settings) || {};
    const csRaw = layout.common_settings || {};
    const cs = typeof csRaw === 'string' ? (() => { try { return JSON.parse(csRaw || '{}'); } catch { return {}; } })() : csRaw;
    const hidePrices = !!cs.hide_price;
    const biz = business || {};
    const f = makeFormatter();

    // When applyLayoutSettings is true, honor the dashboard-configured invoice-layout
    // fields (show_* flags, header_text, footer_text, sub_heading_lines, logo, custom
    // labels). When false, the receipt renders the serverless default header/footer
    // regardless of what the layout says — baseline behavior preserved exactly.
    const useLayout = !!applyLayoutSettings;
    const flagOn = (v) => v == 1 || v === true || v === '1';

    const invoiceNo   = sale.server_invoice_no || sale.invoice_no || '';
    const includeTime = !useLayout || layout.show_time == null || flagOn(layout.show_time);
    const invoiceDate = new Date(sale.created_at).toLocaleString('ar-SA', includeTime
        ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
        : { year: 'numeric', month: '2-digit', day: '2-digit' });
    const cashCustomerLabel = t('receipt_cash_customer');
    const customerName = (sale.customer_name || cashCustomerLabel)
        .replace('Walk-In Customer', cashCustomerLabel)
        .replace('Walk In Customer', cashCustomerLabel);

    const rawBizName = biz.name || '';
    const bizName = useLayout ? (flagOn(layout.show_business_name) ? rawBizName : '') : rawBizName;
    const rawBizVat = biz.tax_number_1 || '';
    const rawBizCr  = biz.tax_number_2 || '';
    // show_tax_1 defaults to 1, show_tax_2 defaults to 0 — mirror the dashboard semantics.
    const bizVat = useLayout
        ? ((layout.show_tax_1 == null || flagOn(layout.show_tax_1)) ? rawBizVat : '')
        : rawBizVat;
    const bizCr  = useLayout
        ? (flagOn(layout.show_tax_2) ? rawBizCr : '')
        : rawBizCr;
    const bizCrLabel = biz.tax_label_2 || 'CR';
    // Suppress the location line when it duplicates the business name (common for
    // single-location tenants where both fields hold the same string).
    const rawLocName = location.name || '';
    const dedupedLocName = (rawLocName && rawLocName.trim() !== rawBizName.trim()) ? rawLocName : '';
    const locName = useLayout
        ? (flagOn(layout.show_location_name) ? dedupedLocName : '')
        : dedupedLocName;

    // Address assembly honors invoice-layout show_* flags when enabled, otherwise
    // keeps the serverless default of "address_line_1 + city".
    let addrParts;
    if (useLayout) {
        addrParts = [];
        if (flagOn(layout.show_landmark) && location.landmark) addrParts.push(location.landmark);
        if (flagOn(layout.show_city)     && location.city)     addrParts.push(location.city);
        if (flagOn(layout.show_state)    && location.state)    addrParts.push(location.state);
        if (flagOn(layout.show_zip_code) && location.zip_code) addrParts.push(location.zip_code);
        if (flagOn(layout.show_country)  && location.country)  addrParts.push(location.country);
    } else {
        addrParts = [location.address_line_1, location.city].filter(Boolean);
    }
    const locAddr = addrParts.join('، ');

    const rawLocPhone = location.mobile || location.landline || '';
    const locPhone = useLayout
        ? (flagOn(layout.show_mobile_number) ? rawLocPhone : '')
        : rawLocPhone;
    const locEmail = useLayout && flagOn(layout.show_email) ? (location.email || '') : '';

    // Logo: only when the layout says show_logo and we can build an absolute URL from
    // the configured server. If the fetch fails on-device (CORS / offline), html2canvas
    // will capture an empty space — same visual result as the toggle being off.
    const serverUrl = (settings && settings.serverUrl) || '';
    const logoUrl = (useLayout && flagOn(layout.show_logo) && layout.logo && serverUrl)
        ? `${String(serverUrl).replace(/\/$/, '')}/uploads/invoice_logos/${layout.logo}`
        : '';

    const headerText    = useLayout ? (layout.header_text    || '') : '';
    const footerText    = useLayout ? (layout.footer_text    || '') : '';
    const invoiceHeading = useLayout ? (layout.invoice_heading || '') : '';
    const invoiceNoLabel = (useLayout && layout.invoice_no_prefix)
        ? String(layout.invoice_no_prefix).replace(/Invoice No\.?/gi, 'رقم الفاتورة')
        : 'رقم الفاتورة';
    const subHeadingLines = useLayout
        ? [1, 2, 3, 4, 5]
            .map((n) => String(layout['sub_heading_line' + n] || '').trim())
            .filter(Boolean)
        : [];

    // Label overrides from dashboard invoice-layout edit page. When useLayout is on
    // and the field is non-empty, use the configured string; otherwise fall back to
    // the serverless Arabic defaults so the baseline template is byte-identical.
    const pick = (field, fallback) => (useLayout && layout[field]) ? layout[field] : fallback;
    const dateLabel        = pick('date_label', 'التاريخ');
    const customerLabel    = pick('customer_label', 'العميل');
    const productLabel     = pick('table_product_label', 'المنتج');
    const qtyLabel         = pick('table_qty_label', 'كمية');
    const unitPriceLabel   = pick('table_unit_price_label', 'سعر');
    const subtotalColLabel = pick('table_subtotal_label', 'إجمالي');
    const subTotalRowLabel = pick('sub_total_label', 'المجموع قبل الضريبة');
    const taxRowLabel      = pick('tax_label', 'ضريبة القيمة المضافة');
    const totalRowLabel    = pick('total_label', 'الإجمالي شامل الضريبة');
    const changeRowLabel   = pick('change_return_label', 'الباقي');
    // show_customer defaults to visible when the field is absent to preserve baseline.
    const showCustomer     = !useLayout || layout.show_customer == null || flagOn(layout.show_customer);

    const baseFont     = is58mm ? '26px' : '34px';
    const smallFont    = is58mm ? '24px' : '32px';
    const grandFont    = is58mm ? '32px' : '42px';
    const headerFont   = is58mm ? '26px' : '34px';
    const tableRowFont = is58mm ? '22px' : '28px'; // table data rows — smaller than header for hierarchy

    // 58mm: 2-row div layout (name+total / qty×price). 80mm: slim 5-column table.
    let itemsHtml;
    if (is58mm) {
        itemsHtml = (sale.items || []).map((item) => {
            const unitPrice = parseFloat(item.unit_price) || 0;
            const total     = lineTotal(item);
            const qty       = fQty(item.quantity);
            const noteHtml  = item.line_note ? `<div class="item-note">${item.line_note}</div>` : '';
            const modSummary = modifiersSummary(item);
            const modHtml = !hidePrices && modSummary ? `<div class="item-note">${modSummary}</div>` : '';
            const row1 = hidePrices
                ? `<div class="row"><span class="right name">${item.name}</span></div>`
                : `<div class="row"><span class="right name">${item.name}</span><span class="left total">${f(total)}</span></div>`;
            const row2 = hidePrices
                ? `<div class="row sub"><span class="right sub-text">${qty}</span></div>`
                : `<div class="row sub"><span class="right sub-text">${qty} × ${f(unitPrice)}</span></div>`;
            return `<div class="item">${row1}${row2}${noteHtml}${modHtml}</div>`;
        }).join('');
    } else {
        const thStyle  = `font-size:${baseFont};padding:10px 4px;`;
        const tdStyle  = `font-size:${tableRowFont};padding:8px 4px;vertical-align:top;`;
        const colsHeader = hidePrices
            ? `<tr style="border-bottom:2px solid #000;">
                <th style="text-align:center;${thStyle}width:7%;">#</th>
                <th style="text-align:right;${thStyle}">${productLabel}</th>
                <th style="text-align:right;${thStyle}width:15%;">${qtyLabel}</th>
               </tr>`
            : `<tr style="border-bottom:2px solid #000;">
                <th style="text-align:center;${thStyle}width:6%;">#</th>
                <th style="text-align:right;${thStyle}">${productLabel}</th>
                <th style="text-align:center;${thStyle}width:11%;">${qtyLabel}</th>
                <th style="text-align:left;${thStyle}width:20%;white-space:nowrap;direction:ltr;">${unitPriceLabel}</th>
                <th style="text-align:left;${thStyle}width:21%;white-space:nowrap;direction:ltr;">${subtotalColLabel}</th>
               </tr>`;
        const rows = (sale.items || []).map((item, idx) => {
            const unitPriceDisplay = item.unit_price_exc_tax ?? item.unit_price;
            const disc    = lineDisc(item);
            const total   = lineTotal(item);
            const qty     = fQty(item.quantity);
            const noteHtml = item.line_note
                ? `<br><span style="font-size:${smallFont};font-weight:600;">${item.line_note}</span>` : '';
            const discNote = disc > 0
                ? `<br><span style="font-size:${smallFont};font-weight:600;">${item.line_discount_type === 'percentage'
                    ? `خصم ${item.line_discount_amount}٪` : `خصم ${f(disc)}`}</span>`
                : '';
            if (hidePrices) {
                return `<tr style="border-bottom:1px dashed #000;">
                    <td style="text-align:center;${tdStyle}padding-left:2px;padding-right:2px;">${idx + 1}</td>
                    <td style="text-align:right;${tdStyle}">${item.name}${noteHtml}</td>
                    <td style="text-align:center;${tdStyle}">${qty}</td>
                </tr>`;
            }
            const modSummary = modifiersSummary(item);
            const modNote = modSummary ? `<br><span style="font-size:${smallFont};font-weight:600;">${modSummary}</span>` : '';
            return `<tr style="border-bottom:1px dashed #000;">
                <td style="text-align:center;${tdStyle}padding-left:2px;padding-right:2px;">${idx + 1}</td>
                <td style="text-align:right;${tdStyle}">${item.name}${discNote}${noteHtml}${modNote}</td>
                <td style="text-align:center;${tdStyle}font-weight:800;">${qty}</td>
                <td style="text-align:left;${tdStyle}white-space:nowrap;direction:ltr;">${f(unitPriceDisplay)}</td>
                <td style="text-align:left;${tdStyle}white-space:nowrap;direction:ltr;font-weight:900;">${f(total)}</td>
            </tr>`;
        }).join('');
        itemsHtml = `<table style="width:100%;border-collapse:collapse;direction:rtl;font-weight:700;">
            <thead>${colsHeader}</thead><tbody>${rows}</tbody>
        </table>`;
    }

    // Totals: strict 2-column label/value pairs, no tables.
    const agg = saleAggregates(sale);
    const change = Math.max(0, agg.paid - agg.total);
    // Derive VAT locally: sale.tax is often 0 on offline records even when items have
    // tax_percent > 0. Use the gap between total (inc-tax) and subtotal (ex-tax) as the
    // effective VAT amount when the sale-level field is missing.
    const derivedTax = agg.tax > 0.005 ? agg.tax : Math.max(0, agg.total - agg.subtotal);
    // Show a single VAT % label when all taxed items share the same rate.
    const itemTaxPcts = [...new Set((sale.items || []).map(i => Number(i.tax_percent) || 0).filter(p => p > 0))];
    const vatPctLabel = itemTaxPcts.length === 1 ? ` (${itemTaxPcts[0]}%)` : '';
    const totalsRows = [];
    if (!hidePrices) {
        totalsRows.push(`<div class="row"><span class="right">${subTotalRowLabel}</span><span class="left">${f(agg.subtotal)}</span></div>`);
        if (derivedTax > 0.005) {
            totalsRows.push(`<div class="row"><span class="right">${taxRowLabel}${vatPctLabel}</span><span class="left">${f(derivedTax)}</span></div>`);
        }
        totalsRows.push(`<div class="row grand"><span class="right">${totalRowLabel}</span><span class="left">${f(agg.total)}</span></div>`);
        // Payment breakdown — only shown when it adds info beyond the grand total:
        //   - Multiple payments (split tender): list each
        //   - Single payment that doesn't fully cover the total: show it + "paid"
        //   - Change due: show it
        // A single full-coverage payment with no change is redundant with the grand
        // total, so we skip it entirely.
        const payments = sale.payments || [];
        const singleFullPayment = payments.length === 1
            && Math.abs((parseFloat(payments[0].amount) || 0) - agg.total) < 0.005
            && change < 0.005;
        if (payments.length > 1 || !singleFullPayment) {
            payments.forEach((p) => {
                totalsRows.push(`<div class="row sub"><span class="right sub-text">${arPayMethod(p.method)}</span><span class="left sub-text">${f(p.amount)}</span></div>`);
            });
            if (change > 0.005) {
                totalsRows.push(`<div class="row"><span class="right">${changeRowLabel}</span><span class="left">${f(change)}</span></div>`);
            }
        }
    }
    const totalsHtml = totalsRows.join('');
    // Explicit inline size on the SVG prevents prepareCaptureDom's maxWidth:100% from
    // confusing the layout pass (without it the SVG tries to be 576px wide, then gets
    // capped to 250px by CSS max-width but the containing box was already sized at 576px).
    // When applyLayoutSettings is on, honor the invoice layout's show_qr_code flag.
    // (Default template behavior: always render if the sale has a ZATCA QR.)
    // When useLayout: honor show_qr_code; additionally respect common_settings.zatca_qr
    // if present (dashboard exposes a dedicated ZATCA QR toggle under common settings).
    const showQr = useLayout
        ? (flagOn(layout.show_qr_code) && (cs.zatca_qr == null || flagOn(cs.zatca_qr)))
        : true;
    const qrHtml = showQr
        ? buildZatcaQrSvg(sale.zatca_qr_code || null, 'slim2', is58mm ? 120 : 250)
        : '';

    const bodyWidth = thermalWidthPx + 'px';
    const qrSize    = is58mm ? (thermalWidthPx - 30) + 'px' : '250px';

    // CSS scoped to .rcp — createTemporaryPrintableHost extracts body.childNodes into
    // its own wrapper div, so a bare `body {}` selector never matches. Everything must
    // be scoped to the wrapping .rcp div.
    const css = `
        .rcp,.rcp *{box-sizing:border-box;color:#000;-webkit-text-stroke:0.3px #000}
        .rcp{width:${bodyWidth};max-width:${bodyWidth};font-family:'Tahoma','Arial',sans-serif;font-size:${baseFont};line-height:${is58mm ? '1.5' : '1.7'};padding:${is58mm ? '6px' : '10px'};direction:rtl;text-align:right;font-weight:700;background:#fff}
        .rcp hr{border:none!important;border-top:2px solid #000!important;margin:${is58mm ? '10px' : '14px'} 0!important;display:block!important;width:100%!important}
        .rcp .center{text-align:center}
        .rcp .small{font-size:${smallFont}}
        .rcp .header-name{font-size:${headerFont};font-weight:900;text-align:center;margin:${is58mm ? '6px' : '8px'} 0!important;-webkit-text-stroke:0.6px #000}
        .rcp .header-line{text-align:center;margin:${is58mm ? '4px' : '6px'} 0!important;font-size:${baseFont};font-weight:700}
        .rcp .header-line.small{font-size:${smallFont}}
        .rcp .row{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin:${is58mm ? '5px' : '8px'} 0!important;width:100%;direction:rtl}
        .rcp .row > .right{text-align:right;flex:1;min-width:0;word-break:break-word;font-weight:700}
        .rcp .row > .left{text-align:left;white-space:nowrap;font-weight:800;direction:ltr}
        .rcp .row.sub{margin:${is58mm ? '2px 0 6px' : '3px 0 8px'}!important}
        .rcp .row.sub .sub-text{font-size:${smallFont};font-weight:700}
        .rcp .row.grand{font-size:${grandFont};font-weight:900;margin:${is58mm ? '10px' : '14px'} 0!important;-webkit-text-stroke:0.7px #000}
        .rcp .row.grand .left,.rcp .row.grand .right{font-size:${grandFont};font-weight:900}
        .rcp .item{padding:${is58mm ? '6px' : '10px'} 0!important;border-bottom:1px dashed #000}
        .rcp .item:last-child{border-bottom:none}
        .rcp .item .name{font-weight:800}
        .rcp .item .total{font-weight:900;font-size:${baseFont}}
        .rcp .item-note{font-size:${smallFont};margin-top:${is58mm ? '3px' : '4px'}!important;text-align:right}
        .rcp .zatca-qr-block{padding-bottom:10px!important;margin:0!important;width:100%;display:block!important;text-align:center}
        .rcp .zatca-qr-block svg{display:inline-block!important;width:${qrSize}!important;max-width:${qrSize}!important;height:${qrSize}!important}
        .rcp .zatca-qr-block p{font-size:${smallFont}!important;font-weight:700!important;color:#000!important;margin-top:6px!important;text-align:center!important}
        .rcp .return-banner{text-align:center;font-size:${grandFont};font-weight:900;border:3px solid #000;padding:6px 0;margin:8px 0;-webkit-text-stroke:0.7px #000}
    `.replace(/\s+/g, ' ');

    const logoMaxWidth = is58mm ? '220px' : '340px';
    const subHeadingHtml = subHeadingLines
        .map((line) => `<div class="header-line small">${line}</div>`)
        .join('');
    const headerTextHtml = headerText
        ? `<div class="header-line small" style="white-space:pre-line;">${headerText}</div>`
        : '';
    const footerTextHtml = footerText
        ? `<hr><div class="header-line small" style="white-space:pre-line;">${footerText}</div>`
        : '';
    const invoiceHeadingHtml = invoiceHeading
        ? `<div class="header-line" style="font-weight:900;">${invoiceHeading}</div>`
        : '';
    const logoHtml = logoUrl
        ? `<div style="text-align:center;margin:${is58mm ? '4px' : '6px'} 0;"><img src="${logoUrl}" alt="logo" crossorigin="anonymous" style="max-width:${logoMaxWidth};max-height:${is58mm ? '120px' : '160px'};display:inline-block;" /></div>`
        : '';

    const body = `<div class="rcp" dir="rtl">`
        + logoHtml
        + (bizName  ? `<div class="header-name">${bizName}</div>` : '')
        + headerTextHtml
        + subHeadingHtml
        + (locName  ? `<div class="header-line">${locName}</div>` : '')
        + (locAddr  ? `<div class="header-line small">${locAddr}</div>` : '')
        + (locPhone ? `<div class="header-line small" dir="ltr">${locPhone}</div>` : '')
        + (locEmail ? `<div class="header-line small" dir="ltr">${locEmail}</div>` : '')
        + (bizVat   ? `<div class="header-line">الرقم الضريبي: <span dir="ltr">${bizVat}</span></div>` : '')
        + (bizCr    ? `<div class="header-line">السجل التجاري: <span dir="ltr">${bizCr}</span></div>` : '')
        + `<hr>`
        + (isReturn ? `<div class="return-banner">مرتجع بيع</div>` : '')
        + invoiceHeadingHtml
        + (invoiceNo    ? `<div class="row"><span class="right">${invoiceNoLabel}</span><span class="left">${invoiceNo}</span></div>` : '')
        + (isReturn && sale.return_parent_invoice_no ? `<div class="row"><span class="right">الفاتورة الأصلية</span><span class="left">${sale.return_parent_invoice_no}</span></div>` : '')
        + (invoiceDate  ? `<div class="row"><span class="right">${dateLabel}</span><span class="left">${invoiceDate}</span></div>` : '')
        + (showCustomer && customerName ? `<div class="row" style="align-items:flex-start;"><span class="right" style="flex:none;white-space:nowrap;">${customerLabel}</span><span class="left" style="white-space:normal;word-break:break-word;direction:rtl;">${customerName}</span></div>` : '')
        + (showCustomer && sale.customer_tax_number ? `<div class="row"><span class="right">الرقم الضريبي للعميل</span><span class="left" dir="ltr">${sale.customer_tax_number}</span></div>` : '')
        + `<hr>`
        + itemsHtml
        + `<hr>`
        + totalsHtml
        + (qrHtml ? `<hr><div class="zatca-qr-block" style="padding-top:${is58mm ? '60px' : '50px'}">${qrHtml}</div>` : '')
        + footerTextHtml
        + `</div>`;

    return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}

// ─── Kitchen-style COMPANY COPY (second receipt) ─────────────────────────────
// Design mirrors pos-offline's buildKitchenCompanyCopyTicketHtml: small centered
// title ("نسخة الشركة"), customer name inline underneath, invoice no + date in a
// top-bordered box, and a 3-col items table (# / name+notes+modifiers / qty).
// Qty is a pre-rasterized rounded black PNG pill with a white digit — this is
// the kitchen-ticket signature. Rendering as PNG avoids html2canvas's RTL
// table-cell layout bugs (same lesson as the QR fix). Fonts sized up ~2.5× from
// pos-offline's screen CSS so thermal output is legible after html2canvas scale.
function buildMobileCompanyCopyHtml(sale, settings, business, locations, thermalWidthPx) {
    const is58mm = (thermalWidthPx || 384) <= 400;

    const invoiceNo = sale.server_invoice_no || sale.invoice_no || '';
    const invoiceDate = new Date(sale.created_at).toLocaleString('ar-SA', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const cashCustomerLabel = t('receipt_cash_customer');
    const customerName = (sale.customer_name || cashCustomerLabel)
        .replace('Walk-In Customer', cashCustomerLabel)
        .replace('Walk In Customer', cashCustomerLabel);

    const titleFont = is58mm ? '34px' : '42px';
    const baseFont  = is58mm ? '26px' : '32px';
    const rowFont   = is58mm ? '24px' : '30px';
    const smallFont = is58mm ? '20px' : '26px';

    const rows = (sale.items || []).map((item, idx) => {
        const noteHtml = item.line_note
            ? `<br><span style="font-size:${smallFont};">${item.line_note}</span>` : '';
        const modSummary = modifiersSummary(item);
        const modHtml = modSummary
            ? `<br><span style="font-size:${smallFont};">${modSummary}</span>` : '';
        const qtyBadge = buildCompanyCopyQtyBadge(fQty(item.quantity), is58mm);
        const cell = `padding:6px 4px;font-size:${rowFont};line-height:1.4;`;
        return `<tr>`
            + `<td style="${cell}text-align:right;vertical-align:top;width:12%;">${idx + 1}</td>`
            + `<td style="${cell}text-align:right;vertical-align:top;">${item.name}${noteHtml}${modHtml}</td>`
            + `<td style="${cell}text-align:center;vertical-align:middle;width:24%;">${qtyBadge}</td>`
            + `</tr>`;
    }).join('');

    const theadCell = `padding:6px 4px;font-size:${baseFont};`;
    const theadHtml = `<thead><tr style="border-bottom:1px solid #000;">`
        + `<th style="${theadCell}text-align:right;width:12%;">#</th>`
        + `<th style="${theadCell}text-align:right;">${t('receipt_item') || 'المنتج'}</th>`
        + `<th style="${theadCell}text-align:center;width:24%;">${t('receipt_qty') || 'الكمية'}</th>`
        + `</tr></thead>`;

    const tableHtml = `<table style="width:100%;border-collapse:collapse;direction:rtl;font-weight:700;">`
        + theadHtml + `<tbody>${rows}</tbody></table>`;

    // Header: centered title, customer name under it, then an invoice info block
    // with a top border separating it from the title. Mirrors pos-offline's
    // .textbox-info rows (invoice no, date) as two-column flex rows.
    const infoRow = (label, value) => value
        ? `<div style="display:flex;justify-content:space-between;align-items:baseline;margin:4px 0;direction:rtl;font-size:${baseFont};">`
            + `<span style="font-weight:800;">${label}</span>`
            + `<span style="font-weight:700;direction:ltr;">${value}</span>`
          + `</div>`
        : '';

    const headerHtml = ''
        + `<div style="text-align:center;margin:0 0 ${is58mm ? '6px' : '10px'};">`
            + `<div style="font-size:${titleFont};font-weight:900;-webkit-text-stroke:0.5px #000;">${t('company_copy')}</div>`
            + (customerName
                ? `<div style="font-size:${baseFont};font-weight:700;margin-top:4px;">`
                    + `${t('receipt_customer_label') || 'العميل'} <span>${customerName}</span>`
                  + `</div>`
                : '')
        + `</div>`
        + `<div style="border-top:1px solid #000;padding-top:${is58mm ? '6px' : '8px'};margin-bottom:${is58mm ? '6px' : '8px'};">`
            + infoRow(t('receipt_invoice_no') || 'رقم الفاتورة', invoiceNo)
            + infoRow(t('receipt_date') || 'التاريخ', invoiceDate)
        + `</div>`;

    const bodyWidth = thermalWidthPx + 'px';
    const css = `
        body,html{margin:0;padding:0;background:#fff}
        .rcp,.rcp *{box-sizing:border-box;color:#000;-webkit-text-stroke:0.3px #000}
        .rcp{width:${bodyWidth};max-width:${bodyWidth};font-family:'Tahoma','Arial',sans-serif;line-height:1.4;padding:${is58mm ? '6px' : '10px'};direction:rtl;text-align:right;font-weight:700;background:#fff}
    `.replace(/\s+/g, ' ');

    const body = `<div class="rcp" dir="rtl">${headerHtml}${tableHtml}</div>`;
    return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}

// Renders the company-copy quantity badge as a pre-rasterized PNG <img> — a
// rounded black pill with a centered white digit. Ported from pos-offline:
// nested inline-block spans in RTL table cells get mispositioned by
// html2canvas, so pre-rasterizing to a PNG means capture just blits pixels.
function buildCompanyCopyQtyBadge(qtyText, is58mm) {
    const label = String(qtyText == null ? '' : qtyText);
    try {
        const scale  = 4;                       // super-sample for crisp thermal output
        const h      = is58mm ? 24 : 30;        // CSS px height (thermal-scaled vs pos-offline's 16px screen size)
        const padX   = is58mm ? 7  : 9;
        const fontPx = is58mm ? 18 : 22;
        const measureCtx = document.createElement('canvas').getContext('2d');
        measureCtx.font = `800 ${fontPx}px Arial, Helvetica, "Segoe UI", sans-serif`;
        const textW = Math.ceil(measureCtx.measureText(label).width);
        const w = Math.max(h, textW + padX * 2);

        const canvas = document.createElement('canvas');
        canvas.width  = w * scale;
        canvas.height = h * scale;
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);

        // Pill
        const r = h / 2;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.moveTo(r, 0);
        ctx.lineTo(w - r, 0);
        ctx.arc(w - r, r, r, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(r, h);
        ctx.arc(r, r, r, Math.PI / 2, -Math.PI / 2);
        ctx.closePath();
        ctx.fill();

        // Digit
        ctx.fillStyle = '#fff';
        ctx.font = `800 ${fontPx}px Arial, Helvetica, "Segoe UI", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, w / 2, h / 2 + 1);

        return `<img class="company-copy-qty-badge-img" alt="qty" src="${canvas.toDataURL('image/png')}" style="display:inline-block;vertical-align:middle;width:${w}px;height:${h}px;">`;
    } catch (e) {
        return `<span style="display:inline-block;background:#000;color:#fff;border-radius:999px;padding:2px 10px;font-weight:800;">${label}</span>`;
    }
}

// ─── Close-register Z-report receipt ─────────────────────────────────────────
// Same .rcp design as the sale receipt: strict 2-column RTL rows, identical font
// sizes, no tables — designed for 58mm / 80mm thermal paper.
function buildCloseRegisterReceiptHtml(snapshot, form, business, thermalWidthPx) {
    const reg  = snapshot?.register || {};
    const summ = reg.summary || {};
    const biz  = business || {};
    const f    = makeFormatter();

    const fmtHijri = (d) => d
        ? new Date(d).toLocaleString('ar-SA-u-ca-islamic-umalqura', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: 'numeric', minute: '2-digit', hour12: false,
          })
        : '';

    const bizName   = biz.name || '';
    const bizVat    = biz.tax_number_1 || '';
    const bizCr     = biz.tax_number_2 || '';
    const locName   = summ.location_name || '';
    const cashier   = summ.user_name || '';

    const openTime  = fmtHijri(reg.open_time);
    const closeTime = fmtHijri(new Date());

    const bodyWidth = (thermalWidthPx || 384) + 'px';
    const baseFont  = '26px';
    const smallFont = '24px';
    const grandFont = '32px';

    // ── helpers ──────────────────────────────────────────────────────────────
    const row = (label, value) =>
        `<div class="row"><span class="right">${label}</span><span class="left">${value}</span></div>`;
    const subrow = (label, value) =>
        `<div class="row sub"><span class="right sub-text">${label}</span><span class="left sub-text">${value}</span></div>`;
    const grandRow = (label, value) =>
        `<div class="row grand"><span class="right">${label}</span><span class="left">${value}</span></div>`;
    const sectionTitle = (label) =>
        `<div class="section-title">${label}</div>`;

    // payment method row: main amount + optional expense sub-row
    const payRow = (label, salesKey, expenseKey) => {
        const sales   = +(summ[salesKey]   || 0);
        const expense = +(summ[expenseKey] || 0);
        if (sales <= 0 && expense <= 0) return '';
        return row(label, f(sales))
            + (expense > 0 ? subrow('  (مصاريف)', f(expense)) : '');
    };

    // ── payment methods section ───────────────────────────────────────────────
    const payRows = [];
    payRows.push(row('رصيد الافتتاح', f(+(summ.cash_in_hand || 0))));
    payRows.push(payRow('نقداً',          'total_cash',          'total_cash_expense'));
    payRows.push(payRow('شيك',            'total_cheque',        'total_cheque_expense'));
    payRows.push(payRow('بطاقة',          'total_card',          'total_card_expense'));
    payRows.push(payRow('تحويل بنكي',     'total_bank_transfer', 'total_bank_transfer_expense'));
    payRows.push(payRow('سلفة',           'total_advance',       'total_advance_expense'));
    for (let n = 1; n <= 7; n++) {
        const name = reg.payment_types?.['custom_pay_' + n];
        if (name) payRows.push(payRow(name, 'total_custom_pay_' + n, 'total_custom_pay_' + n + '_expense'));
    }
    payRows.push(payRow('أخرى', 'total_other', 'total_other_expense'));

    // ── financial summary section ─────────────────────────────────────────────
    const td           = reg.transaction_breakdown?.transaction_details;
    const totalSale    = +(summ.total_sale    || 0);
    const totalRefund  = +(summ.total_refund  || 0);
    const totalExpense = +(summ.total_expense || 0);
    const cashCollected = +(summ.cash_in_hand || 0) + +(summ.total_cash || 0) - +(summ.total_cash_refund || 0);
    const creditSales  = td ? ((+(td.total_sales || 0)) - totalSale) : null;
    const grandTotal   = td ? +(td.total_sales || 0) : null;
    const sellReturnTotal = +(reg.sell_return?.total_sales || 0);

    const summRows = [];
    summRows.push(grandRow('إجمالي المبيعات', f(totalSale)));
    if (sellReturnTotal > 0)
        summRows.push(row('مرتجعات بيع', f(sellReturnTotal)));
    if (totalRefund > 0)
        summRows.push(row('إجمالي المسترد', f(totalRefund)));
    summRows.push(row('النقد المحصّل', f(cashCollected)));
    if (creditSales !== null && creditSales > 0.005)
        summRows.push(row('مبيعات الآجل', f(creditSales)));
    if (grandTotal !== null && grandTotal !== totalSale)
        summRows.push(row('الإجمالي الكلي', f(grandTotal)));
    if (totalExpense > 0)
        summRows.push(row('إجمالي المصاريف', f(totalExpense)));

    // ── closing section ───────────────────────────────────────────────────────
    const closingRows = [];
    closingRows.push(grandRow('المبلغ الختامي', f(+(form?.closing_amount || 0))));
    const slips   = +(form?.total_card_slips || 0);
    const cheques = +(form?.total_cheques    || 0);
    if (slips   > 0) closingRows.push(row('إيصالات بطاقة', String(slips)));
    if (cheques > 0) closingRows.push(row('شيكات', String(cheques)));

    // ── denominations ─────────────────────────────────────────────────────────
    const denomValues = reg.cash_denomination_values || [];
    const denomCounts = form?.denominationCounts || {};
    const denomRows = denomValues.map(dv => {
        const qty = +(denomCounts[String(dv)] || 0);
        if (!qty) return '';
        return row(`${f(+dv)} × ${qty}`, f((+dv) * qty));
    }).filter(Boolean);
    const denomTotal = Object.entries(denomCounts)
        .reduce((s, [k, v]) => s + (+k) * (+(v) || 0), 0);

    // ── reconciliation formula ────────────────────────────────────────────────
    const reconciled = +(summ.cash_in_hand || 0) + totalSale - totalRefund - totalExpense;
    const reconLine  = `<div class="recon">`
        + `${f(+(summ.cash_in_hand||0))} + ${f(totalSale)} − ${f(totalRefund)} − ${f(totalExpense)}`
        + ` = <strong>${f(reconciled)}</strong></div>`;

    // ── note ──────────────────────────────────────────────────────────────────
    const note = (form?.closing_note || '').trim();

    // ── CSS ───────────────────────────────────────────────────────────────────
    const css = `
        .rcp,.rcp *{box-sizing:border-box;color:#000;-webkit-text-stroke:0.3px #000}
        .rcp{width:${bodyWidth};max-width:${bodyWidth};font-family:'Tahoma','Arial',sans-serif;font-size:${baseFont};line-height:1.5;padding:6px;direction:rtl;text-align:right;font-weight:700;background:#fff}
        .rcp hr{border:none;border-top:2px solid #000;margin:10px 0;display:block;width:100%}
        .rcp .header-name{font-size:${baseFont};font-weight:900;text-align:center;margin:6px 0;-webkit-text-stroke:0.6px #000}
        .rcp .header-line{text-align:center;margin:4px 0;font-size:${smallFont};font-weight:700}
        .rcp .title{text-align:center;font-size:${baseFont};font-weight:900;margin:8px 0;-webkit-text-stroke:0.5px #000}
        .rcp .section-title{font-size:${smallFont};font-weight:900;margin:8px 0 4px;border-bottom:1px solid #000;padding-bottom:3px}
        .rcp .row{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin:5px 0;width:100%;direction:rtl}
        .rcp .row > .right{text-align:right;flex:1;min-width:0;word-break:break-word;font-weight:700}
        .rcp .row > .left{text-align:left;white-space:nowrap;font-weight:800;direction:ltr}
        .rcp .row.sub{margin:2px 0 4px}
        .rcp .row.sub .sub-text{font-size:${smallFont};font-weight:600}
        .rcp .row.grand{font-size:${grandFont};font-weight:900;margin:10px 0;-webkit-text-stroke:0.7px #000}
        .rcp .row.grand .left,.rcp .row.grand .right{font-size:${grandFont};font-weight:900}
        .rcp .recon{font-size:${smallFont};font-weight:600;text-align:center;direction:ltr;margin:6px 0}
    `.replace(/\s+/g, ' ');

    // ── body ──────────────────────────────────────────────────────────────────
    const body = `<div class="rcp" dir="rtl">`
        + (bizName  ? `<div class="header-name">${bizName}</div>` : '')
        + (locName  ? `<div class="header-line">${locName}</div>` : '')
        + (bizVat   ? `<div class="header-line">الرقم الضريبي: <span dir="ltr">${bizVat}</span></div>` : '')
        + (bizCr    ? `<div class="header-line">السجل التجاري: <span dir="ltr">${bizCr}</span></div>` : '')
        + `<hr>`
        + `<div class="title">تقرير إغلاق الكاشير</div>`
        + (cashier  ? `<div class="header-line">الكاشير: ${cashier}</div>` : '')
        + `<hr>`
        + (openTime  ? row('وقت الفتح',   openTime)  : '')
        + (closeTime ? row('وقت الإغلاق', closeTime) : '')
        + `<hr>`
        + sectionTitle('طرق الدفع')
        + payRows.join('')
        + `<hr>`
        + sectionTitle('الملخص المالي')
        + summRows.join('')
        + `<hr>`
        + sectionTitle('الإغلاق')
        + closingRows.join('')
        + (denomRows.length ? `<hr>${sectionTitle('الأوراق النقدية')}${denomRows.join('')}${grandRow('الإجمالي', f(denomTotal))}` : '')
        + `<hr>`
        + reconLine
        + (note ? `<hr>${row('ملاحظة', `<span style="white-space:normal;direction:rtl;">${note}</span>`)}` : '')
        + `</div>`;

    return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}

function buildCloseRegisterReceiptHtmlDetailed(snapshot, form, business, thermalWidthPx) {
    const reg  = snapshot?.register || {};
    const summ = reg.summary || {};
    const biz  = business || {};
    const f    = makeFormatter();

    const fmtHijri = (d) => d
        ? new Date(d).toLocaleString('ar-SA-u-ca-islamic-umalqura', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: 'numeric', minute: '2-digit', hour12: false,
          })
        : '';

    const bizName   = biz.name || '';
    const bizVat    = biz.tax_number_1 || '';
    const bizCr     = biz.tax_number_2 || '';
    const locName   = summ.location_name || '';
    const cashier   = summ.user_name || '';

    const openTime  = fmtHijri(reg.open_time);
    const closeTime = fmtHijri(new Date());

    const bodyWidth = (thermalWidthPx || 384) + 'px';
    const baseFont  = '26px';
    const smallFont = '24px';
    const grandFont = '32px';
    const tinyFont  = '22px';

    const row = (label, value) =>
        `<div class="row"><span class="right">${label}</span><span class="left">${value}</span></div>`;
    const subrow = (label, value) =>
        `<div class="row sub"><span class="right sub-text">${label}</span><span class="left sub-text">${value}</span></div>`;
    const grandRow = (label, value) =>
        `<div class="row grand"><span class="right">${label}</span><span class="left">${value}</span></div>`;
    const sectionTitle = (label) =>
        `<div class="section-title">${label}</div>`;

    const payRow = (label, salesKey, expenseKey) => {
        const sales   = +(summ[salesKey]   || 0);
        const expense = +(summ[expenseKey] || 0);
        if (sales <= 0 && expense <= 0) return '';
        return row(label, f(sales))
            + (expense > 0 ? subrow('  (مصاريف)', f(expense)) : '');
    };

    const payRows = [];
    payRows.push(row('رصيد الافتتاح', f(+(summ.cash_in_hand || 0))));
    payRows.push(payRow('نقداً',          'total_cash',          'total_cash_expense'));
    payRows.push(payRow('شيك',            'total_cheque',        'total_cheque_expense'));
    payRows.push(payRow('بطاقة',          'total_card',          'total_card_expense'));
    payRows.push(payRow('تحويل بنكي',     'total_bank_transfer', 'total_bank_transfer_expense'));
    payRows.push(payRow('سلفة',           'total_advance',       'total_advance_expense'));
    for (let n = 1; n <= 7; n++) {
        const name = reg.payment_types?.['custom_pay_' + n];
        if (name) payRows.push(payRow(name, 'total_custom_pay_' + n, 'total_custom_pay_' + n + '_expense'));
    }
    payRows.push(payRow('أخرى', 'total_other', 'total_other_expense'));

    const td           = reg.transaction_breakdown?.transaction_details;
    const totalSale    = +(summ.total_sale    || 0);
    const totalRefund  = +(summ.total_refund  || 0);
    const totalExpense = +(summ.total_expense || 0);
    const cashCollected = +(summ.cash_in_hand || 0) + +(summ.total_cash || 0) - +(summ.total_cash_refund || 0);
    const creditSales  = td ? ((+(td.total_sales || 0)) - totalSale) : null;
    const grandTotal   = td ? +(td.total_sales || 0) : null;
    const sellReturnTotal = +(reg.sell_return?.total_sales || 0);

    const summRows = [];
    summRows.push(grandRow('إجمالي المبيعات', f(totalSale)));
    if (sellReturnTotal > 0)
        summRows.push(row('مرتجعات بيع', f(sellReturnTotal)));
    if (totalRefund > 0)
        summRows.push(row('إجمالي المسترد', f(totalRefund)));
    summRows.push(row('النقد المحصّل', f(cashCollected)));
    if (creditSales !== null && creditSales > 0.005)
        summRows.push(row('مبيعات الآجل', f(creditSales)));
    if (grandTotal !== null && grandTotal !== totalSale)
        summRows.push(row('الإجمالي الكلي', f(grandTotal)));
    if (totalExpense > 0)
        summRows.push(row('إجمالي المصاريف', f(totalExpense)));

    const closingRows = [];
    closingRows.push(grandRow('المبلغ الختامي', f(+(form?.closing_amount || 0))));
    const slips   = +(form?.total_card_slips || 0);
    const cheques = +(form?.total_cheques    || 0);
    if (slips   > 0) closingRows.push(row('إيصالات بطاقة', String(slips)));
    if (cheques > 0) closingRows.push(row('شيكات', String(cheques)));

    const denomValues = reg.cash_denomination_values || [];
    const denomCounts = form?.denominationCounts || {};
    const denomRows = denomValues.map(dv => {
        const qty = +(denomCounts[String(dv)] || 0);
        if (!qty) return '';
        return row(`${f(+dv)} × ${qty}`, f((+dv) * qty));
    }).filter(Boolean);
    const denomTotal = Object.entries(denomCounts)
        .reduce((s, [k, v]) => s + (+k) * (+(v) || 0), 0);

    const reconciled = +(summ.cash_in_hand || 0) + totalSale - totalRefund - totalExpense;
    const reconLine  = `<div class="recon">`
        + `${f(+(summ.cash_in_hand||0))} + ${f(totalSale)} − ${f(totalRefund)} − ${f(totalExpense)}`
        + ` = <strong>${f(reconciled)}</strong></div>`;

    // product details table
    const productDetails = reg.transaction_breakdown?.product_details || [];
    let productSection = '';
    if (productDetails.length) {
        const totalQty = productDetails.reduce((s, r) => s + (+r.total_quantity || 0), 0);
        const rows = productDetails.map((pd, i) => {
            const varPart = pd.product_type === 'variable'
                ? ` (${[pd.product_variation_name, pd.variation_name].filter(Boolean).join(' - ')})`
                : '';
            return `<tr>`
                + `<td class="tbl-idx">${i + 1}.</td>`
                + `<td class="tbl-sku">${pd.sku || ''}</td>`
                + `<td class="tbl-name">${pd.product_name || ''}${varPart}</td>`
                + `<td class="tbl-num">${pd.total_quantity}</td>`
                + `<td class="tbl-num">${f(pd.total_amount)}</td>`
                + `</tr>`;
        }).join('');
        const taxVal     = td ? +(td.total_tax || 0) : 0;
        const discVal    = td ? +(td.total_discount || 0) : 0;
        const shipVal    = td ? +(td.total_shipping_charges || 0) : 0;
        const totalSales = td ? +(td.total_sales || 0) : 0;
        const footerExtra = (taxVal  > 0 ? `<div class="tbl-foot-sub">ضريبة: (+) ${f(taxVal)}</div>` : '')
            + (discVal > 0 ? `<div class="tbl-foot-sub">خصم: (−) ${f(discVal)}</div>` : '')
            + (shipVal > 0 ? `<div class="tbl-foot-sub">شحن: (+) ${f(shipVal)}</div>` : '')
            + (td ? `<div class="tbl-foot-grand">الإجمالي: ${f(totalSales)}</div>` : '');
        productSection = `<hr>${sectionTitle('تفاصيل المنتجات المباعة')}`
            + `<table class="tbl"><thead><tr>`
            + `<th>#</th><th>SKU</th><th>المنتج</th><th class="num">الكمية</th><th class="num">الإجمالي</th>`
            + `</tr></thead><tbody>${rows}</tbody>`
            + `<tfoot><tr>`
            + `<td colspan="3"></td>`
            + `<td class="tbl-num">${totalQty}</td>`
            + `<td class="num">${footerExtra}</td>`
            + `</tr></tfoot></table>`;
    }

    // brand breakdown table
    const brandDetails = reg.transaction_breakdown?.product_details_by_brand || [];
    let brandSection = '';
    if (brandDetails.length) {
        const totalQty = brandDetails.reduce((s, r) => s + (+r.total_quantity || 0), 0);
        const totalAmt = td ? +(td.total_sales || 0) : 0;
        const rows = brandDetails.map((bd, i) =>
            `<tr>`
            + `<td class="tbl-idx">${i + 1}.</td>`
            + `<td class="tbl-name">${bd.brand_name || '—'}</td>`
            + `<td class="tbl-num">${bd.total_quantity}</td>`
            + `<td class="tbl-num">${f(bd.total_amount)}</td>`
            + `</tr>`
        ).join('');
        brandSection = `<hr>${sectionTitle('المنتجات حسب الماركة')}`
            + `<table class="tbl"><thead><tr>`
            + `<th>#</th><th>الماركة</th><th class="num">الكمية</th><th class="num">الإجمالي</th>`
            + `</tr></thead><tbody>${rows}</tbody>`
            + `<tfoot><tr><td colspan="2"></td>`
            + `<td class="tbl-num">${totalQty}</td>`
            + `<td class="tbl-num">${td ? f(totalAmt) : ''}</td>`
            + `</tr></tfoot></table>`;
    }

    // types of service table
    const serviceDetails = reg.transaction_breakdown?.types_of_service_details || [];
    let serviceSection = '';
    if (serviceDetails.length) {
        const rows = serviceDetails.map((sv, i) =>
            `<tr>`
            + `<td class="tbl-idx">${i + 1}.</td>`
            + `<td class="tbl-name">${sv.types_of_service_name || '—'}</td>`
            + `<td class="tbl-num">${f(sv.total_sales)}</td>`
            + `</tr>`
        ).join('');
        serviceSection = `<hr>${sectionTitle('تفاصيل أنواع الخدمة')}`
            + `<table class="tbl"><thead><tr>`
            + `<th>#</th><th>نوع الخدمة</th><th class="num">الإجمالي</th>`
            + `</tr></thead><tbody>${rows}</tbody></table>`;
    }

    const note = (form?.closing_note || '').trim();

    const css = `
        .rcp,.rcp *{box-sizing:border-box;color:#000;-webkit-text-stroke:0.3px #000}
        .rcp{width:${bodyWidth};max-width:${bodyWidth};font-family:'Tahoma','Arial',sans-serif;font-size:${baseFont};line-height:1.5;padding:6px;direction:rtl;text-align:right;font-weight:700;background:#fff}
        .rcp hr{border:none;border-top:2px solid #000;margin:10px 0;display:block;width:100%}
        .rcp .header-name{font-size:${baseFont};font-weight:900;text-align:center;margin:6px 0;-webkit-text-stroke:0.6px #000}
        .rcp .header-line{text-align:center;margin:4px 0;font-size:${smallFont};font-weight:700}
        .rcp .title{text-align:center;font-size:${baseFont};font-weight:900;margin:8px 0;-webkit-text-stroke:0.5px #000}
        .rcp .section-title{font-size:${smallFont};font-weight:900;margin:8px 0 4px;border-bottom:1px solid #000;padding-bottom:3px}
        .rcp .row{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin:5px 0;width:100%;direction:rtl}
        .rcp .row > .right{text-align:right;flex:1;min-width:0;word-break:break-word;font-weight:700}
        .rcp .row > .left{text-align:left;white-space:nowrap;font-weight:800;direction:ltr}
        .rcp .row.sub{margin:2px 0 4px}
        .rcp .row.sub .sub-text{font-size:${smallFont};font-weight:600}
        .rcp .row.grand{font-size:${grandFont};font-weight:900;margin:10px 0;-webkit-text-stroke:0.7px #000}
        .rcp .row.grand .left,.rcp .row.grand .right{font-size:${grandFont};font-weight:900}
        .rcp .recon{font-size:${smallFont};font-weight:600;text-align:center;direction:ltr;margin:6px 0}
        .rcp .tbl{width:100%;border-collapse:collapse;margin-bottom:4px;font-size:${tinyFont}}
        .rcp .tbl th{font-weight:800;border-bottom:1.5px solid #000;padding:2px 3px;text-align:start}
        .rcp .tbl th.num,.rcp .tbl td.num{text-align:end}
        .rcp .tbl td{padding:2px 3px;vertical-align:top;font-weight:500}
        .rcp .tbl tfoot td{font-weight:800;border-top:1.5px solid #000}
        .rcp .tbl .tbl-idx{width:2em;white-space:nowrap}
        .rcp .tbl .tbl-sku{color:#555;white-space:nowrap}
        .rcp .tbl .tbl-name{word-break:break-word}
        .rcp .tbl .tbl-num{text-align:end;font-variant-numeric:tabular-nums;white-space:nowrap}
        .rcp .tbl-foot-sub{font-size:${tinyFont};font-weight:600}
        .rcp .tbl-foot-grand{font-weight:900}
    `.replace(/\s+/g, ' ');

    const body = `<div class="rcp" dir="rtl">`
        + (bizName  ? `<div class="header-name">${bizName}</div>` : '')
        + (locName  ? `<div class="header-line">${locName}</div>` : '')
        + (bizVat   ? `<div class="header-line">الرقم الضريبي: <span dir="ltr">${bizVat}</span></div>` : '')
        + (bizCr    ? `<div class="header-line">السجل التجاري: <span dir="ltr">${bizCr}</span></div>` : '')
        + `<hr>`
        + `<div class="title">تقرير إغلاق الكاشير</div>`
        + (cashier  ? `<div class="header-line">الكاشير: ${cashier}</div>` : '')
        + `<hr>`
        + (openTime  ? row('وقت الفتح',   openTime)  : '')
        + (closeTime ? row('وقت الإغلاق', closeTime) : '')
        + `<hr>`
        + sectionTitle('طرق الدفع')
        + payRows.join('')
        + `<hr>`
        + sectionTitle('الملخص المالي')
        + summRows.join('')
        + `<hr>`
        + sectionTitle('الإغلاق')
        + closingRows.join('')
        + (denomRows.length ? `<hr>${sectionTitle('الأوراق النقدية')}${denomRows.join('')}${grandRow('الإجمالي', f(denomTotal))}` : '')
        + `<hr>`
        + reconLine
        + productSection
        + brandSection
        + serviceSection
        + (note ? `<hr>${row('ملاحظة', `<span style="white-space:normal;direction:rtl;">${note}</span>`)}` : '')
        + `</div>`;

    return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}
