/**
 * ZAT Receipt Print Router
 * Sets window.zatReceiptPrintRouter used by app.js to dispatch print jobs.
 *
 * Routing priority:
 *   bluetooth_android  → Android BT bridge
 *   usb_android        → Android USB bridge
 *   wifi_android       → Android Wi-Fi bridge
 *   printer (zat_tray) → ZAT Tray local service (http://127.0.0.1:19613)
 *   browser / *        → window.open + window.print() fallback
 */
(function () {
    'use strict';

    // Receipts/invoices are always rendered in Arabic regardless of the app UI language.
    var t = function (k, v) {
        var dict = (window.I18N && window.I18N.ar) || {};
        var s = dict[k] || k;
        return v ? s.replace(/\{(\w+)\}/g, function (_, x) { return (x in v) ? v[x] : '{' + x + '}'; }) : s;
    };

    async function browserPrint(receipt) {
        var html = receipt && receipt.html_content;
        if (!html) throw new Error(t('no_content_to_print'));
        var win = window.open('', '_blank', 'width=800,height=600');
        if (!win) throw new Error(t('cant_open_print_window'));
        win.document.write(html);
        win.document.close();
        win.focus();
        win.print();
        win.onafterprint = function () { win.close(); };
    }

    window.zatReceiptPrintRouter = {
        print: async function (receipt) {
            var type = (receipt && receipt.print_type) || 'browser';
            var tray = window.printerTray || {};

            if (type === 'bluetooth_android' && typeof tray.printViaAndroidBridge === 'function') {
                return tray.printViaAndroidBridge(receipt);
            }
            if (type === 'usb_android' && typeof tray.printViaAndroidUsbBridge === 'function') {
                return tray.printViaAndroidUsbBridge(receipt);
            }
            if (type === 'wifi_android' && typeof tray.printViaAndroidWifiBridge === 'function') {
                return tray.printViaAndroidWifiBridge(receipt);
            }
            if (type === 'printer' && typeof tray.printReceipt === 'function') {
                var cfg = (receipt && receipt.printer_config) || {};
                // Prefer the Windows/tray device name over a friendly display label.
                var deviceName = cfg.tray_printer_name || cfg.name || '';
                return tray.printReceipt(receipt, deviceName);
            }
            // Fallback: browser print
            return browserPrint(receipt);
        }
    };
})();
