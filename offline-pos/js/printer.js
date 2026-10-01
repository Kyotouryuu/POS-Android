const PRINTER_TRAY_BASE_URL = 'http://127.0.0.1:19613';
const ANDROID_BRIDGE_EVENT_NAME = 'zat-android-print-result';
const ANDROID_BLUETOOTH_PRINTERS_EVENT_NAME = 'zat-android-bluetooth-printers';
const ANDROID_USB_PRINTERS_EVENT_NAME = 'zat-android-usb-printers';
/** Event name the Android app uses when delivering the device list */
const ANDROID_APP_BLUETOOTH_DEVICES_EVENT = 'zat-android-bluetooth-devices';
const ANDROID_APP_USB_DEVICES_EVENT = 'zat-android-usb-devices';
const HTML2CANVAS_CDN_URL = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
const BLUETOOTH_THERMAL_WIDTH = 576;
const SUNMI_THERMAL_WIDTH = 384; // 58mm paper at 203dpi — default for most Sunmi handheld/countertop models
const BLUETOOTH_CAPTURE_WORKSPACE_WIDTH = 320;
let androidBluetoothPrintersCache = [];
let androidUsbPrintersCache = [];
/** Current Bluetooth printer selection for session (used when receipt has no name/address; also for window.print() routing in app). */
let selectedBluetoothPrinter = null;
let selectedUsbPrinter = null;
let html2CanvasLoaderPromise = null;
window.printerTray = window.printerTray || {};

async function fetchFromPrinterTray(endpoint, options = {}) {
    const url = `${PRINTER_TRAY_BASE_URL}${endpoint}`;
    const requestOptions = Object.assign(
        {
            headers: {
                Accept: 'application/json',
            },
            mode: 'cors',
        },
        options
    );

    try {
        const response = await fetch(url, requestOptions);
        if (!response.ok) {
            let detail = '';
            try {
                const contentType = response.headers.get('content-type') || '';
                if (contentType.includes('application/json')) {
                    const body = await response.json();
                    detail = body && body.error ? String(body.error) : '';
                } else {
                    detail = (await response.text() || '').trim();
                }
            } catch (_) { /* ignore parse errors */ }
            const message = detail
                ? `Printer tray error (${response.status}): ${detail}`
                : `Printer tray responded with status ${response.status}`;
            throw new Error(message);
        }
        return response;
    } catch (error) {
        console.error(`Printer tray request failed (${url})`, error);
        if (error && error.message && String(error.message).indexOf('Printer tray') === 0) {
            throw error;
        }
        throw new Error('Unable to reach the printer tray. Please ensure the ZAT Tray app is running.');
    }
}

function isAndroidBridgeAvailable() {
    return !!(window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function');
}

function getAndroidBridgeHealth() {
    return Promise.resolve({
        available: isAndroidBridgeAvailable(),
        status: isAndroidBridgeAvailable() ? 'connected' : 'unavailable',
    });
}

function normalizeBluetoothPrinterDevices(devices) {
    if (!Array.isArray(devices)) {
        return [];
    }

    return devices
        .map(function(device) {
            var address = (device && (device.address || device.macAddress)) ? String(device.address || device.macAddress).trim() : '';
            return {
                name: device && device.name ? String(device.name).trim() : '',
                address: address,
            };
        })
        .filter(function(device) {
            return !!device.address;
        });
}

function normalizeUsbPrinterDevices(devices) {
    if (!Array.isArray(devices)) {
        return [];
    }

    return devices
        .map(function(device) {
            var deviceName = device && device.deviceName ? String(device.deviceName).trim() : '';
            var vendorId = device && typeof device.vendorId === 'number' ? device.vendorId : null;
            var productId = device && typeof device.productId === 'number' ? device.productId : null;
            var manufacturerName = device && device.manufacturerName ? String(device.manufacturerName).trim() : '';
            var productName = device && device.productName ? String(device.productName).trim() : '';
            var friendlyName = device && device.friendlyName ? String(device.friendlyName).trim() : '';

            if (!friendlyName) {
                friendlyName = [manufacturerName, productName].filter(Boolean).join(' ').trim();
            }
            if (!friendlyName) {
                friendlyName = deviceName;
            }

            return {
                deviceName: deviceName,
                vendorId: vendorId,
                productId: productId,
                manufacturerName: manufacturerName,
                productName: productName,
                friendlyName: friendlyName,
            };
        })
        .filter(function(device) {
            return !!device.deviceName;
        });
}

function _setAvailableBluetoothPrintersImpl(devices, requestId = null, meta = null) {
    var raw = Array.isArray(devices) ? devices : [];
    androidBluetoothPrintersCache = normalizeBluetoothPrinterDevices(raw);
    console.log('Normalized bluetooth printers cache:', androidBluetoothPrintersCache);

    updateBluetoothScanDebug(raw, androidBluetoothPrintersCache.slice(), meta);

    if (window.printerTray && typeof window.printerTray.updateBluetoothDropdown === 'function') {
        window.printerTray.updateBluetoothDropdown(androidBluetoothPrintersCache.slice());
    }

    window.dispatchEvent(
        new CustomEvent(ANDROID_BLUETOOTH_PRINTERS_EVENT_NAME, {
            detail: {
                requestId: requestId,
                devices: androidBluetoothPrintersCache.slice(),
            },
        })
    );
    console.log('Dispatched bluetooth printers event:', ANDROID_BLUETOOTH_PRINTERS_EVENT_NAME, androidBluetoothPrintersCache);

    return androidBluetoothPrintersCache.slice();
}

function _setAvailableUsbPrintersImpl(devices, requestId = null) {
    androidUsbPrintersCache = normalizeUsbPrinterDevices(devices);
    console.log('Normalized USB printers cache:', androidUsbPrintersCache);

    if (window.printerTray && typeof window.printerTray.updateUsbDropdown === 'function') {
        window.printerTray.updateUsbDropdown(androidUsbPrintersCache.slice());
    }

    window.dispatchEvent(
        new CustomEvent(ANDROID_USB_PRINTERS_EVENT_NAME, {
            detail: {
                requestId: requestId,
                devices: androidUsbPrintersCache.slice(),
            },
        })
    );

    return androidUsbPrintersCache.slice();
}

function handleBluetoothPrintersMessage(payload) {
    if (!payload) {
        return;
    }
    var devices = payload.devices;
    if (payload.type === 'bluetooth_printers' && Array.isArray(devices)) {
        window.printerTray.setAvailableBluetoothPrinters(devices, payload.requestId || null);
        return;
    }
    if (Array.isArray(devices)) {
        window.printerTray.setAvailableBluetoothPrinters(devices, payload.requestId || null);
    }
}

function handleUsbPrintersMessage(payload) {
    if (!payload) {
        return;
    }
    var devices = payload.devices;
    if (payload.type === 'usb_printers' && Array.isArray(devices)) {
        window.printerTray.setAvailableUsbPrinters(devices, payload.requestId || null);
        return;
    }
    if (Array.isArray(devices) && devices.length && devices[0] && devices[0].deviceName) {
        window.printerTray.setAvailableUsbPrinters(devices, payload.requestId || null);
    }
}

/**
 * When the app sends a print result back, dispatch zat-android-print-result so the website and our Promise can listen.
 */
function handlePrintResultMessage(payload) {
    var type = payload && payload.type;
    if (type !== 'zat-android-print-result' && type !== 'bluetooth_print_result' && type !== 'usb_print_result') {
        return;
    }
    var detail = payload.detail != null ? payload.detail : payload;
    if (typeof window.__bluetoothPrintDebug === 'function') {
        try {
            window.__bluetoothPrintDebug({
                status: detail && detail.success === false
                    ? 'Android app reported failure: ' + (detail.error || detail.message || 'Unknown error')
                    : 'Android app reported print success',
                payload: {
                    request_id: detail && detail.requestId ? detail.requestId : null
                }
            });
        } catch (e) {
            console.warn('Bluetooth print result debug callback error', e);
        }
    }
    window.dispatchEvent(
        new CustomEvent(ANDROID_BRIDGE_EVENT_NAME, { detail: detail })
    );
}

function handleBridgeMessageEvent(event) {
    var rawData = event && typeof event.data !== 'undefined' ? event.data : null;
    if (!rawData) {
        return;
    }

    try {
        var payload = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
        handleBluetoothPrintersMessage(payload);
        handleUsbPrintersMessage(payload);
        handlePrintResultMessage(payload);
    } catch (error) {
        console.warn('Unable to parse bridge message.', error);
    }
}

function handleBluetoothPrintersMessageEvent(event) {
    handleBridgeMessageEvent(event);
}

window.printerTray.setAvailableBluetoothPrinters = function(devices, requestId, meta) {
    console.log('Received bluetooth printers:', devices);
    return _setAvailableBluetoothPrintersImpl(devices, requestId, meta);
};
window.printerTray.setAvailableUsbPrinters = function(devices, requestId) {
    console.log('Received USB printers:', devices);
    return _setAvailableUsbPrintersImpl(devices, requestId);
};

/**
 * Set the current Bluetooth printer for this session. After this, plain window.print() in the app can route through Bluetooth.
 * Call when the user picks a printer from the dropdown, e.g.:
 *   window.zatSetBluetoothPrinter({ name: selectedDevice.name, address: selectedDevice.address });
 */
window.zatSetBluetoothPrinter = function(device) {
    var address = device && (device.address || device.macAddress) ? String(device.address || device.macAddress).trim() : '';
    var name = device && device.name ? String(device.name).trim() : '';
    if (!address && !name) {
        selectedBluetoothPrinter = null;
        return;
    }
    selectedBluetoothPrinter = {
        name: name,
        address: address,
    };
    console.log('Bluetooth printer set:', selectedBluetoothPrinter);
};

window.zatSetUsbPrinter = function(device) {
    var deviceName = device && device.deviceName ? String(device.deviceName).trim() : '';
    var name = device && device.name ? String(device.name).trim() : '';
    if (!deviceName && !name) {
        selectedUsbPrinter = null;
        return;
    }
    selectedUsbPrinter = {
        name: name,
        deviceName: deviceName,
    };
    console.log('USB printer set:', selectedUsbPrinter);
};

window.setAvailableBluetoothPrinters = window.printerTray.setAvailableBluetoothPrinters;
window.setAvailableUsbPrinters = window.printerTray.setAvailableUsbPrinters;
window.addEventListener('message', handleBluetoothPrintersMessageEvent);
document.addEventListener('message', handleBluetoothPrintersMessageEvent);

function handleAppBluetoothDevicesEvent(event) {
    var detail = event && event.detail;
    if (!detail) {
        btScanDebugLog('JS: handleAppBluetoothDevicesEvent — no detail, returning');
        return;
    }
    var rawDevices = Array.isArray(detail.devices) ? detail.devices : (Array.isArray(detail) ? detail : []);
    btScanDebugLog('JS: handleAppBluetoothDevicesEvent — ' + rawDevices.length + ' device(s)');
    console.log('Bluetooth devices from app event:', rawDevices);
    window.printerTray.setAvailableBluetoothPrinters(rawDevices, detail.requestId || null, detail);
}
window.addEventListener(ANDROID_APP_BLUETOOTH_DEVICES_EVENT, handleAppBluetoothDevicesEvent);
document.addEventListener(ANDROID_APP_BLUETOOTH_DEVICES_EVENT, handleAppBluetoothDevicesEvent);

// Direct-call entry point for Java to bypass CustomEvent (which can fail silently for larger payloads).
// setTimeout(0) unwinds the evaluateJavascript call stack before processing to avoid stack overflow.
window.__onAndroidBluetoothDevices = function(detail) {
    btScanDebugLog('JS: __onAndroidBluetoothDevices called, devices=' + (detail && detail.devices ? detail.devices.length : '?'));
    setTimeout(function() {
        try {
            handleAppBluetoothDevicesEvent({ detail: detail });
        } catch(e) {
            btScanDebugLog('JS ERR in __onAndroidBluetoothDevices: ' + e.message);
        }
    }, 0);
};

function handleBtScanAckEvent() {}
window.addEventListener('zat-android-bt-scan-ack', handleBtScanAckEvent);
document.addEventListener('zat-android-bt-scan-ack', handleBtScanAckEvent);

window.addEventListener('zat-android-bt-scan-log', function(e) {
    var msg = e && e.detail && e.detail.msg ? e.detail.msg : String(e && e.detail);
    btScanDebugLog('<span style="color:#93c5fd;">Java: ' + msg + '</span>');
});
document.addEventListener('zat-android-bt-scan-log', function(e) {
    var msg = e && e.detail && e.detail.msg ? e.detail.msg : String(e && e.detail);
    btScanDebugLog('<span style="color:#93c5fd;">Java: ' + msg + '</span>');
});

function handleAppUsbDevicesEvent(event) {
    var detail = event && event.detail;
    if (!detail) {
        return;
    }
    var devices = Array.isArray(detail.devices) ? detail.devices : (Array.isArray(detail) ? detail : []);
    if (devices.length) {
        console.log('USB devices from app event:', devices);
        window.printerTray.setAvailableUsbPrinters(devices, detail.requestId || null);
    }
}
window.addEventListener(ANDROID_APP_USB_DEVICES_EVENT, handleAppUsbDevicesEvent);
document.addEventListener(ANDROID_APP_USB_DEVICES_EVENT, handleAppUsbDevicesEvent);

function applyZatAndroidBluetoothDevices(obj) {
    var data = obj !== undefined ? obj : (window.zatAndroidBluetoothDevices || window._zatAndroidBluetoothDevices);
    if (!data || typeof data !== 'object') {
        return;
    }
    var devices = Array.isArray(data.devices) ? data.devices : (Array.isArray(data) ? data : []);
    if (devices.length) {
        console.log('Bluetooth devices from window.zatAndroidBluetoothDevices:', devices);
        window.printerTray.setAvailableBluetoothPrinters(devices, null);
    }
}
var _initialBluetoothDevices = window.zatAndroidBluetoothDevices;
window._zatAndroidBluetoothDevices = _initialBluetoothDevices;
if (_initialBluetoothDevices) {
    applyZatAndroidBluetoothDevices(_initialBluetoothDevices);
}
try {
    Object.defineProperty(window, 'zatAndroidBluetoothDevices', {
        set: function(val) {
            window._zatAndroidBluetoothDevices = val;
            applyZatAndroidBluetoothDevices(val);
        },
        get: function() {
            return window._zatAndroidBluetoothDevices;
        },
        configurable: true
    });
} catch (e) {
    window.zatAndroidBluetoothDevices = window._zatAndroidBluetoothDevices;
}

function applyZatAndroidUsbDevices(obj) {
    var data = obj !== undefined ? obj : (window.zatAndroidUsbDevices || window._zatAndroidUsbDevices);
    if (!data || typeof data !== 'object') {
        return;
    }
    var devices = Array.isArray(data.devices) ? data.devices : (Array.isArray(data) ? data : []);
    if (devices.length) {
        console.log('USB devices from window.zatAndroidUsbDevices:', devices);
        window.printerTray.setAvailableUsbPrinters(devices, null);
    }
}
var _initialUsbDevices = window.zatAndroidUsbDevices;
window._zatAndroidUsbDevices = _initialUsbDevices;
if (_initialUsbDevices) {
    applyZatAndroidUsbDevices(_initialUsbDevices);
}
try {
    Object.defineProperty(window, 'zatAndroidUsbDevices', {
        set: function(val) {
            window._zatAndroidUsbDevices = val;
            applyZatAndroidUsbDevices(val);
        },
        get: function() {
            return window._zatAndroidUsbDevices;
        },
        configurable: true
    });
} catch (e) {
    window.zatAndroidUsbDevices = window._zatAndroidUsbDevices;
}

// Documented listener: website can listen for print results
window.addEventListener(ANDROID_BRIDGE_EVENT_NAME, function(e) {
    console.log('Print result:', e.detail);
});

function getAvailableBluetoothPrinters() {
    return Promise.resolve(androidBluetoothPrintersCache.slice());
}

function getAvailableUsbPrinters() {
    return Promise.resolve(androidUsbPrintersCache.slice());
}

/**
 * Ask the Android app to scan for Bluetooth printers and push the list via setAvailableBluetoothPrinters.
 * No Promise, no listeners. The page's permanent zat-android-bluetooth-printers listener will update the UI.
 */
function requestBluetoothScan() {
    console.log('Bridge available:', isAndroidBridgeAvailable());
    if (!isAndroidBridgeAvailable()) {
        console.warn('Android bridge not available');
        btScanDebugLog('<span style="color:#f87171;">Bridge not available — ReactNativeWebView missing</span>');
        return;
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'request_bluetooth_scan',
    }));
}

/**
 * Ask the Android app to send the current Bluetooth printer list once (e.g. on page load).
 * No Promise, no listeners. The app should call setAvailableBluetoothPrinters(devices); the page listener will update the UI.
 */
function requestBluetoothPrintersOnLoad() {
    console.log('Bridge available on load:', isAndroidBridgeAvailable());
    if (!isAndroidBridgeAvailable()) {
        console.warn('Android bridge not available during bluetooth printer load');
        return;
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'get_bluetooth_printers',
    }));
}

function requestUsbPrinterScan() {
    console.log('Bridge available for USB scan:', isAndroidBridgeAvailable());
    if (!isAndroidBridgeAvailable()) {
        console.warn('Android bridge not available');
        return;
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'request_usb_scan',
    }));
}

function requestUsbPrintersOnLoad() {
    console.log('Bridge available on load for USB printers:', isAndroidBridgeAvailable());
    if (!isAndroidBridgeAvailable()) {
        console.warn('Android bridge not available during USB printer load');
        return;
    }
    window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'get_usb_printers',
    }));
}

// Retrieve tray health; returns object with status text and optional payload
async function getPrinterTrayHealth() {
    const response = await fetchFromPrinterTray('/health', { method: 'GET' });

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        return response.json();
    }

    return {
        status: await response.text(),
    };
}

// Retrieve available printers from the tray service
async function getAvailablePrinters() {
    const response = await fetchFromPrinterTray('/printers', { method: 'GET' });
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
        return response.json();
    }

    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch (error) {
        console.warn('Unexpected printers payload, returning empty list', error);
        return [];
    }
}

// Print receipt - handles HTML receipt from server
async function printReceipt(receipt, printerName) {
    const htmlContent = receipt && receipt.html_content ? receipt.html_content : receipt;
    const marginSettings = receipt && receipt.margin_settings ? receipt.margin_settings : null;
    return printHTML(htmlContent, printerName, marginSettings);
}

// Sanitize margin value to ensure it's not negative
function sanitizeMarginValue(value) {
    if (!value || value === '') {
        return '0';
    }
    
    // Convert to string if not already
    const valueStr = String(value);
    
    // Extract numeric value from string (e.g., "16px" -> 16, "0.5cm" -> 0.5, "-10px" -> -10)
    const numericMatch = valueStr.match(/-?\d+\.?\d*/);
    if (numericMatch) {
        const numericValue = parseFloat(numericMatch[0]);
        // If negative, replace with 0 while preserving units if present
        if (numericValue < 0) {
            return valueStr.replace(/-?\d+\.?\d*/, '0');
        }
    }
    return valueStr;
}

// Print HTML content using the tray service
async function printHTML(htmlContent, printerName, marginSettings = null) {
    if (!htmlContent) {
        alert('Print failed: Missing HTML content.');
        return false;
    }

    // Default margin settings
    const defaultMarginSettings = {
        margin_type: 'none',
    };

    // Use provided margin settings or defaults
    const margins = marginSettings || defaultMarginSettings;
    
    // Build margin payload based on margin_type
    let marginType = margins.margin_type || 'default';
    let marginsObj = null;

    if (marginType === 'custom') {
        // Sanitize all margin values to ensure they're not negative
        marginsObj = {
            top: sanitizeMarginValue(margins.margin_top || '0'),
            right: sanitizeMarginValue(margins.margin_right || '0'),
            bottom: sanitizeMarginValue(margins.margin_bottom || '0'),
            left: sanitizeMarginValue(margins.margin_left || '0')
        };
    }

    try {
        // ZAT Tray expects camelCase `printerName` (not `printername`).
        // Wrong casing is ignored → silent print hits the default printer and fails.
        const payload = {
            html: htmlContent,
            printerName: printerName || '',
            marginType: marginType
        };

        // Only add margins object if marginType is 'custom'
        if (marginsObj) {
            payload.margins = marginsObj;
        }

        await fetchFromPrinterTray('/print', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify(payload),
        });

        console.log('✓ Printed successfully', payload.printerName ? `to: ${payload.printerName}` : '(default printer)');
        return true;
    } catch (error) {
        console.error('Print error:', error);
        alert('Print failed: ' + error.message);
        return false;
    }
}

function loadHtml2Canvas() {
    if (window.html2canvas) {
        return Promise.resolve(window.html2canvas);
    }

    if (html2CanvasLoaderPromise) {
        return html2CanvasLoaderPromise;
    }

    html2CanvasLoaderPromise = new Promise(function(resolve, reject) {
        var script = document.createElement('script');
        script.src = HTML2CANVAS_CDN_URL;
        script.async = true;
        script.onload = function() {
            if (window.html2canvas) {
                resolve(window.html2canvas);
                return;
            }
            reject(new Error('html2canvas loaded but is not available on window.'));
        };
        script.onerror = function() {
            reject(new Error('Failed to load html2canvas.'));
        };
        document.head.appendChild(script);
    });

    return html2CanvasLoaderPromise;
}

function elementHasPrintableContent(element) {
    if (!element) {
        return false;
    }

    if ((element.innerText || '').trim().length > 0) {
        return true;
    }

    return !!element.querySelector('img, canvas, svg, table, [data-receipt]');
}

function isVisiblePrintableElement(element) {
    if (!element || !(element instanceof Element)) {
        return false;
    }

    var style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
        return false;
    }

    var rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return false;
    }

    return elementHasPrintableContent(element);
}

function getPrintableRoot(scope) {
    var searchRoot = scope && scope.querySelectorAll ? scope : document;
    var selectors = [
        '.invoice-container',
        '.ticket',
        '[data-receipt]',
        '.receipt',
        '.invoice',
        '#receipt_section',
        '.modal-content'
    ];
    var candidates = [];

    if (searchRoot !== document && isVisiblePrintableElement(searchRoot)) {
        candidates.push(searchRoot);
    }

    selectors.forEach(function(selector) {
        var nodes = searchRoot.querySelectorAll(selector);
        Array.prototype.forEach.call(nodes, function(node) {
            if (isVisiblePrintableElement(node)) {
                candidates.push(node);
            }
        });
    });

    candidates.sort(function(a, b) {
        var aRect = a.getBoundingClientRect();
        var bRect = b.getBoundingClientRect();
        return (bRect.width * bRect.height) - (aRect.width * aRect.height);
    });

    return candidates.length ? candidates[0] : null;
}

function createTemporaryPrintableHost(htmlContent, targetWidthPx) {
    // targetWidthPx lets the caller lay out at the actual thermal width (e.g. 384 for
    // 58mm, 576 for 80mm) instead of the default 320px workspace. When our own compact
    // template is used, laying out at native thermal width avoids browser wrapping the
    // Arabic text one-char-per-line and then html2canvas scaling it up fuzzily.
    var workspaceWidth = (typeof targetWidthPx === 'number' && targetWidthPx >= 200)
        ? Math.floor(targetWidthPx)
        : BLUETOOTH_CAPTURE_WORKSPACE_WIDTH;
    var host = document.createElement('div');
    host.setAttribute('data-receipt-capture-host', 'true');
    host.style.cssText = [
        'position:fixed',
        'left:-10000px',
        'top:0',
        'width:' + workspaceWidth + 'px',
        'min-width:' + workspaceWidth + 'px',
        'max-width:' + workspaceWidth + 'px',
        'background:#fff',
        'color:#000',
        'display:block',
        'visibility:visible',
        'opacity:1',
        'pointer-events:none',
        'z-index:-1',
        'padding:0',
        'margin:0'
    ].join(';');

    var parser = new DOMParser();
    var parsed = parser.parseFromString(htmlContent || '', 'text/html');
    var styleContainer = document.createElement('div');
    var contentRoot = document.createElement('div');
    var sourceRoot = parsed.body && parsed.body.childNodes.length ? parsed.body : parsed.documentElement;
    var parsedDir = (parsed.body && parsed.body.getAttribute('dir')) || parsed.documentElement.getAttribute('dir') || 'rtl';

    contentRoot.setAttribute('data-receipt-capture-root', 'true');
    contentRoot.setAttribute('dir', parsedDir);
    contentRoot.style.cssText = [
        'display:block',
        'visibility:visible',
        'opacity:1',
        'width:' + workspaceWidth + 'px',
        'min-width:' + workspaceWidth + 'px',
        'max-width:' + workspaceWidth + 'px',
        'margin:0 auto',
        'padding:0',
        'box-sizing:border-box',
        'background:#fff',
        'overflow:visible',
        'direction:' + parsedDir
    ].join(';');

    Array.prototype.forEach.call(parsed.head ? parsed.head.querySelectorAll('style') : [], function(styleNode) {
        styleContainer.appendChild(document.importNode(styleNode, true));
    });

    Array.prototype.forEach.call(sourceRoot.childNodes, function(node) {
        contentRoot.appendChild(document.importNode(node, true));
    });

    host.appendChild(styleContainer);
    host.appendChild(contentRoot);
    document.body.appendChild(host);
    var tickets = contentRoot.querySelectorAll('.ticket');
    /* Slim (80mm) can render customer + company copy as two .ticket siblings; capturing only the first
       dropped the company copy on Wi‑Fi / thermal raster paths. */
    var printableRoot = tickets.length > 1
        ? contentRoot
        : (tickets.length ? tickets[0] : (getPrintableRoot(contentRoot) || contentRoot));
    prepareCaptureDom(printableRoot);

    return {
        host: host,
        root: printableRoot,
        cleanup: function() {
            if (host && host.parentNode) {
                host.parentNode.removeChild(host);
            }
        }
    };
}

function prepareCaptureDom(root) {
    if (!root) {
        return;
    }

    if (!root.getAttribute('dir')) {
        root.setAttribute('dir', 'rtl');
    }

    root.style.display = 'block';
    root.style.visibility = 'visible';
    root.style.opacity = '1';
    root.style.position = 'relative';
    root.style.left = '0';
    root.style.top = '0';
    root.style.margin = '0';
    root.style.padding = '0';
    root.style.boxSizing = 'border-box';
    root.style.background = '#FFFFFF';
    root.style.color = '#000000';
    root.style.overflow = 'visible';
    root.style.transform = 'none';
    root.style.direction = root.getAttribute('dir') || 'rtl';

    var nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
    nodes.forEach(function(node) {
        if (!(node instanceof Element)) {
            return;
        }

        var className = typeof node.className === 'string' ? node.className : '';
        var shouldForceVisible = node.hasAttribute('hidden') ||
            /\bhide\b|\bhidden\b|\bd-none\b/i.test(className);

        if (shouldForceVisible) {
            node.removeAttribute('hidden');
            node.style.display = 'block';
            node.style.visibility = 'visible';
            node.style.opacity = '1';
            node.style.maxHeight = 'none';
            node.style.overflow = 'visible';
        }

        if (node.tagName === 'IMG' || node.tagName === 'CANVAS' || node.tagName === 'SVG') {
            node.style.display = 'block';
            node.style.maxWidth = '100%';
            node.style.height = 'auto';
            node.style.marginLeft = 'auto';
            node.style.marginRight = 'auto';
        }

        if (node.matches && node.matches('.invoice-container, .ticket, .receipt, .invoice, [data-receipt], table')) {
            node.style.marginLeft = '0';
            node.style.marginRight = '0';
            node.style.boxSizing = 'border-box';
        }

        if (node.matches && node.matches('body, .invoice-container, .ticket')) {
            node.style.direction = root.getAttribute('dir') || 'rtl';
        }

        if (node.tagName === 'IMG') {
            var imgHint = ((node.getAttribute('alt') || '') + ' ' + className).toLowerCase();
            if (imgHint.indexOf('qr') !== -1 || imgHint.indexOf('barcode') !== -1) {
                node.style.maxWidth = '320px';
                node.style.width = '100%';
            }
        }

        if (node.tagName === 'HR') {
            node.style.border = 'none';
            node.style.borderTop = '1px solid #000';
            node.style.height = '0';
            node.style.margin = '6px 0';
            node.style.display = 'block';
            node.style.visibility = 'visible';
        }

        var cs = window.getComputedStyle ? window.getComputedStyle(node) : null;
        if (cs) {
            var hasBorder = (cs.borderTopWidth && cs.borderTopWidth !== '0px') ||
                            (cs.borderBottomWidth && cs.borderBottomWidth !== '0px');
            if (hasBorder) {
                if (cs.borderTopWidth && cs.borderTopWidth !== '0px') {
                    node.style.borderTopStyle = cs.borderTopStyle === 'none' ? 'solid' : cs.borderTopStyle;
                    node.style.borderTopColor = cs.borderTopColor || '#000';
                }
                if (cs.borderBottomWidth && cs.borderBottomWidth !== '0px') {
                    node.style.borderBottomStyle = cs.borderBottomStyle === 'none' ? 'solid' : cs.borderBottomStyle;
                    node.style.borderBottomColor = cs.borderBottomColor || '#000';
                }
            }
        }
    });
}

function resizeCanvasToThermalWidth(canvas, targetWidth) {
    var resizedCanvas = document.createElement('canvas');
    resizedCanvas.width = targetWidth;
    resizedCanvas.height = Math.ceil((canvas.height / canvas.width) * targetWidth);

    var ctx = resizedCanvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, resizedCanvas.width, resizedCanvas.height);
    ctx.drawImage(canvas, 0, 0, resizedCanvas.width, resizedCanvas.height);

    return resizedCanvas;
}

function cropCanvasToContent(canvas, padding) {
    var ctx = canvas.getContext('2d');
    var width = canvas.width;
    var height = canvas.height;
    var imageData = ctx.getImageData(0, 0, width, height).data;
    var top = height;
    var left = width;
    var right = -1;
    var bottom = -1;
    var threshold = 245;

    for (var y = 0; y < height; y++) {
        for (var x = 0; x < width; x++) {
            var index = (y * width + x) * 4;
            var alpha = imageData[index + 3];
            var red = imageData[index];
            var green = imageData[index + 1];
            var blue = imageData[index + 2];
            var hasContent = alpha > 10 && (red < threshold || green < threshold || blue < threshold);

            if (!hasContent) {
                continue;
            }

            if (x < left) {
                left = x;
            }
            if (x > right) {
                right = x;
            }
            if (y < top) {
                top = y;
            }
            if (y > bottom) {
                bottom = y;
            }
        }
    }

    if (right === -1 || bottom === -1) {
        return canvas;
    }

    var pad = typeof padding === 'number' ? padding : 16;
    left = Math.max(0, left - pad);
    top = Math.max(0, top - pad);
    right = Math.min(width - 1, right + pad);
    bottom = Math.min(height - 1, bottom + pad);

    var croppedWidth = right - left + 1;
    var croppedHeight = bottom - top + 1;
    var croppedCanvas = document.createElement('canvas');
    var croppedCtx = croppedCanvas.getContext('2d');
    croppedCanvas.width = croppedWidth;
    croppedCanvas.height = croppedHeight;

    croppedCtx.fillStyle = '#FFFFFF';
    croppedCtx.fillRect(0, 0, croppedWidth, croppedHeight);
    croppedCtx.drawImage(canvas, left, top, croppedWidth, croppedHeight, 0, 0, croppedWidth, croppedHeight);

    return croppedCanvas;
}

function uint8ToBase64EscPos(u8) {
    var CHUNK = 0x8000;
    var s = '';
    for (var i = 0; i < u8.length; i += CHUNK) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(s);
}

/**
 * ESC/POS GS v 0 (m=0) monochrome raster from a canvas (thermal Wi‑Fi / html2canvas path).
 */
function escPosGsV0RasterFromCanvas(canvas) {
    var ctx = canvas.getContext('2d');
    var w = canvas.width;
    var h = canvas.height;
    var img = ctx.getImageData(0, 0, w, h).data;
    var widthBytes = Math.ceil(w / 8);
    var out = [];
    out.push(0x1b, 0x40);
    out.push(0x1d, 0x76, 0x30, 0x00);
    out.push(widthBytes & 0xff, (widthBytes >> 8) & 0xff);
    out.push(h & 0xff, (h >> 8) & 0xff);
    for (var y = 0; y < h; y += 1) {
        for (var bx = 0; bx < widthBytes; bx += 1) {
            var byte = 0;
            for (var bit = 0; bit < 8; bit += 1) {
                var x = bx * 8 + bit;
                var ink = 0;
                if (x < w) {
                    var idx = (y * w + x) * 4;
                    var r = img[idx];
                    var g = img[idx + 1];
                    var b = img[idx + 2];
                    var a = img[idx + 3];
                    var lum = (0.299 * r + 0.587 * g + 0.114 * b) * (a / 255);
                    ink = lum < 195 ? 1 : 0;
                }
                if (ink) {
                    byte |= 1 << (7 - bit);
                }
            }
            out.push(byte);
        }
    }
    out.push(0x1b, 0x64, 0x03);
    return new Uint8Array(out);
}

function isQrBarcodeOnlyCommands(commands) {
    if (!Array.isArray(commands) || commands.length === 0) {
        return false;
    }
    for (var i = 0; i < commands.length; i += 1) {
        var t = commands[i] && commands[i].type;
        t = typeof t === 'string' ? t.toLowerCase() : '';
        if (t !== 'qr' && t !== 'barcode') {
            return false;
        }
    }
    return true;
}

function waitForPrintableAssets(root) {
    if (!root) {
        return Promise.resolve();
    }

    var images = Array.prototype.slice.call(root.querySelectorAll('img'));
    var imagePromises = images.map(function(img) {
        if (img.complete) {
            return Promise.resolve();
        }
        return new Promise(function(resolve) {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
        });
    });

    var fontsPromise = document.fonts && typeof document.fonts.ready === 'object'
        ? document.fonts.ready.catch(function() { return null; })
        : Promise.resolve();

    return Promise.all([fontsPromise].concat(imagePromises)).then(function() {
        return new Promise(function(resolve) {
            window.requestAnimationFrame(function() {
                window.requestAnimationFrame(resolve);
            });
        });
    });
}

async function renderReceiptToThermalCanvas(receipt, thermalWidth) {
    if (!thermalWidth || thermalWidth < 100) thermalWidth = BLUETOOTH_THERMAL_WIDTH;
    await loadHtml2Canvas();

    var cleanup = null;
    var root = null;
    var savedTransform;
    var savedTransformOrigin;

    if (receipt && receipt.html_content) {
        // Lay out at the actual thermal width so the compact template renders natively
        // (no shrinking of text below readable) and no fuzzy upscale by html2canvas.
        var tempRender = createTemporaryPrintableHost(receipt.html_content, thermalWidth);
        cleanup = tempRender.cleanup;
        root = tempRender.root;
    } else {
        var pageRoot = getPrintableRoot(document);
        if (pageRoot) {
            var tempRender = createTemporaryPrintableHost(pageRoot.outerHTML);
            cleanup = tempRender.cleanup;
            root = tempRender.root;
        }
    }

    if (!root || !elementHasPrintableContent(root)) {
        if (cleanup) {
            cleanup();
        }
        throw new Error('Could not find a printable receipt container to capture.');
    }

    try {
        await waitForPrintableAssets(root);
        var captureId = 'bt-capture-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
        root.setAttribute('data-bt-capture-id', captureId);

        var originalWidth = root.getBoundingClientRect().width;
        var scale = originalWidth > 0 ? thermalWidth / originalWidth : 1;
        savedTransform = root.style.transform;
        savedTransformOrigin = root.style.transformOrigin;

        root.style.transformOrigin = 'top left';
        root.style.transform = 'scale(' + scale + ')';
        root.offsetHeight;

        var canvas = await window.html2canvas(root, {
            backgroundColor: '#FFFFFF',
            scale: 2,
            useCORS: true,
            logging: false,
            imageTimeout: 0,
            width: thermalWidth,
            windowWidth: Math.ceil(originalWidth),
            onclone: function(clonedDoc) {
                var fixStyle = clonedDoc.createElement('style');
                var is58mm = thermalWidth <= 400;
                // Shared thermal legibility overrides: pure black on white, larger
                // minimum font, heavier weight to compensate for faint thermal head burn.
                var rules = [
                    'hr{border:none!important;border-top:2px solid #000!important;height:0!important;margin:8px 0!important;display:block!important;visibility:visible!important;opacity:1!important}',
                    'table,th,td{border-color:#000!important}',
                    'body,p,div,span,td,th,li,strong,em{color:#000!important;font-weight:600!important;-webkit-text-stroke:0.15px #000!important}',
                    'h1,h2,h3,h4,strong,b{font-weight:800!important;-webkit-text-stroke:0.4px #000!important}',
                    'img{filter:contrast(1.6) brightness(0.85)!important;max-width:100%!important;height:auto!important}',
                    '*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color:#000!important}'
                ];
                if (is58mm) {
                    // 58mm (~384px @ 203dpi, ~32 chars/line). Conventions:
                    //   - No side-by-side tabular columns beyond 2 — stack numeric rows vertically
                    //   - Tighter padding (paper is narrow, wasted margins hurt)
                    //   - QR max ~130px so it fits with breathing room
                    //   - Slightly smaller base font than 80mm since content must reflow narrower
                    rules.push('body{font-size:13px!important;line-height:1.35!important;padding:2px!important;margin:0!important}');
                    rules.push('th,td{padding:2px 3px!important;font-size:13px!important;line-height:1.3!important;word-break:break-word!important;white-space:normal!important}');
                    rules.push('small,.f-8{font-size:10px!important}');
                    // Force item tables to single-column stack: any table with >2 cols in the row
                    // typically means qty/price/total — hide separator cells and rely on slim2's
                    // built-in flex numeric row.
                    rules.push('svg{max-width:130px!important;height:auto!important;display:block!important;margin:6px auto!important}');
                    rules.push('.slim2-numeric-row{gap:6px!important;font-size:12px!important}');
                    rules.push('.slim-line-items-header,.slim-line-items-table th{font-size:11px!important;padding:2px!important}');
                } else {
                    // 80mm (~576px @ 203dpi, ~48 chars/line): more breathing room, larger baseline.
                    rules.push('body{font-size:14px!important;line-height:1.4!important}');
                    rules.push('th,td{padding:4px 5px!important;font-size:14px!important;line-height:1.35!important}');
                    rules.push('small{font-size:12px!important}');
                    rules.push('svg{max-width:180px!important;height:auto!important}');
                }
                fixStyle.textContent = rules.join('');
                clonedDoc.head.appendChild(fixStyle);
                var clonedRoot = clonedDoc.querySelector('[data-bt-capture-id="' + captureId + '"]');
                if (clonedRoot) {
                    prepareCaptureDom(clonedRoot);
                    clonedRoot.style.transformOrigin = 'top left';
                    clonedRoot.style.transform = 'scale(' + scale + ')';
                }
            }
        });

        root.style.transform = savedTransform;
        root.style.transformOrigin = savedTransformOrigin;
        root.removeAttribute('data-bt-capture-id');
        var croppedCanvas = cropCanvasToContent(canvas, 20);
        return resizeCanvasToThermalWidth(croppedCanvas, thermalWidth);
    } finally {
        if (root) {
            if (root.removeAttribute) {
                root.removeAttribute('data-bt-capture-id');
            }
            if (typeof savedTransform !== 'undefined') {
                root.style.transform = savedTransform;
                root.style.transformOrigin = savedTransformOrigin;
            }
        }
        if (cleanup) {
            cleanup();
        }
    }
}

async function captureReceiptImage(receipt) {
    var resizedCanvas = await renderReceiptToThermalCanvas(receipt);
    var dataUrl = resizedCanvas.toDataURL('image/png');
    return dataUrl.replace(/^data:image\/png;base64,/, '');
}

/**
 * PNG + GS v 0 raster ESC/POS (base64) for Wi‑Fi thermal when the server sends slim HTML + QR/barcode-only commands.
 */
async function captureReceiptWifiThermalPayloads(receipt) {
    var resizedCanvas = await renderReceiptToThermalCanvas(receipt);
    var png = resizedCanvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
    var escpos = uint8ToBase64EscPos(escPosGsV0RasterFromCanvas(resizedCanvas));
    return { raster_png_base64: png, escpos_base64: escpos };
}

function printDebugLog() {}
function updatePrintStatus() {}
function showPrintDebugPanel() {}
function showBluetoothPrintDebug() {}

window.__bluetoothPrintDebug = showBluetoothPrintDebug;
window.showBluetoothPrintDebug = showBluetoothPrintDebug;
window.showPrintDebugPanel = showPrintDebugPanel;
window.printDebugLog = printDebugLog;
window.updatePrintStatus = updatePrintStatus;

function btScanDebugLog() {}
function showBluetoothScanDebug() {}
function updateBluetoothScanDebug() {}

window.showBluetoothScanDebug = showBluetoothScanDebug;
window.updateBluetoothScanDebug = updateBluetoothScanDebug;


// Send receipt payload to Android app (ReactNative WebView bridge) for bluetooth printing.
// Prefers print-ready image from POST /print/receipt when receipt.transaction_id is present.
function printViaAndroidBridge(receipt) {
    return new Promise(function(resolve, reject) {
        if (!isAndroidBridgeAvailable()) {
            reject(new Error('Android bridge is not available.'));
            return;
        }

        window.__bluetoothPrintActive = true;
        var requestId = 'android-print-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
        var timeout = null;

        function clearActiveLater() {
            setTimeout(function() {
                window.__bluetoothPrintActive = false;
            }, 2500);
        }

        function onBridgeResult(event) {
            var detail = event && event.detail ? event.detail : {};
            if (!detail.requestId || detail.requestId !== requestId) {
                return;
            }

            clearTimeout(timeout);
            window.removeEventListener(ANDROID_BRIDGE_EVENT_NAME, onBridgeResult);
            clearActiveLater();

            if (detail.success === false) {
                reject(new Error(detail.error || detail.message || 'Android bluetooth printing failed.'));
                return;
            }

            resolve(detail);
        }

        // Bluetooth connection uses MAC address only; device name alone will not work.
        var address = (receipt && receipt.bluetooth_printer_address) ? String(receipt.bluetooth_printer_address).trim() : (selectedBluetoothPrinter && selectedBluetoothPrinter.address) ? String(selectedBluetoothPrinter.address).trim() : '';
        var name = (receipt && receipt.bluetooth_printer_name) ? receipt.bluetooth_printer_name : (selectedBluetoothPrinter && selectedBluetoothPrinter.name) ? selectedBluetoothPrinter.name : null;
        if (!address) {
            window.__bluetoothPrintActive = false;
            reject(new Error('Bluetooth printer MAC address is required. Select a printer with a valid MAC address.'));
            return;
        }

        var htmlContent = (receipt && receipt.html_content) ? receipt.html_content : (typeof receipt === 'string' ? receipt : '');
        if (!htmlContent && !(receipt && receipt.transaction_id)) {
            window.__bluetoothPrintActive = false;
            reject(new Error('Receipt HTML content or transaction_id is missing.'));
            return;
        }

        var fetchAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;

        function sendPayload(payload, opts) {
            opts = opts || {};
            // Remove before adding so we never accumulate duplicate listeners.
            window.removeEventListener(ANDROID_BRIDGE_EVENT_NAME, onBridgeResult);
            window.addEventListener(ANDROID_BRIDGE_EVENT_NAME, onBridgeResult);
            clearTimeout(timeout);
            timeout = setTimeout(function() {
                window.removeEventListener(ANDROID_BRIDGE_EVENT_NAME, onBridgeResult);
                // Abort any in-flight fetch so it doesn't call sendPayload a second time.
                if (fetchAbortController) fetchAbortController.abort();
                clearActiveLater();
                resolve({ requestId: requestId, status: 'sent' });
            }, 4000);
            if (typeof window.__bluetoothPrintDebug === 'function') {
                try {
                    var cmdCount = Array.isArray(payload.commands) ? payload.commands.length : 0;
                    var status = opts.status || (cmdCount ? 'Sent ' + cmdCount + ' command(s) to app' : (payload.image_content ? 'Image payload sent to app' : 'HTML fallback sent to app'));
                    window.__bluetoothPrintDebug({
                        printer_name: name,
                        printer_address: address,
                        bridge_available: isAndroidBridgeAvailable(),
                        status: status,
                        payload: {
                            bluetooth_printer_name: name,
                            bluetooth_printer_address: address,
                            thermal_width: payload.thermal_width || BLUETOOTH_THERMAL_WIDTH,
                            command_count: cmdCount,
                            request_id: payload.requestId || requestId,
                            server_commands: opts.server_commands,
                            source: opts.source
                        }
                    });
                } catch (e) {
                    console.warn('Bluetooth print debug callback error', e);
                }
            }
            window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        }

        // If receipt already has commands (e.g. from backend), send them without a second request
        var existingCommands = receipt && Array.isArray(receipt.commands) ? receipt.commands : null;
        if (existingCommands && existingCommands.length > 0) {
            var payload = {
                type: 'bluetooth_print_receipt',
                requestId: requestId,
                address: address,
                name: name,
                bluetooth_printer_mac: address,
                bluetooth_printer_name: name,
                commands: existingCommands
            };
            sendPayload(payload, {
                status: 'Using ' + existingCommands.length + ' command(s) from receipt (no fetch)',
                source: 'receipt'
            });
            return;
        }

        // If caller explicitly said to use local HTML (mobile compact template), render
        // client-side and skip /print/receipt — the server returns the A4 layout which
        // renders as bordered tables and side-by-side QR on thermal paper.
        if (receipt && receipt.use_local_html && htmlContent) {
            if (typeof window.__bluetoothPrintDebug === 'function') {
                try {
                    window.__bluetoothPrintDebug({
                        printer_name: name,
                        printer_address: address,
                        bridge_available: isAndroidBridgeAvailable(),
                        status: 'use_local_html — rendering compact template client-side, skipping /print/receipt'
                    });
                } catch (e) {}
            }
            captureReceiptWifiThermalPayloads({ html_content: htmlContent }).then(function(payloads) {
                var fallback = {
                    type: 'bluetooth_print_receipt',
                    requestId: requestId,
                    address: address,
                    name: name,
                    bluetooth_printer_mac: address,
                    bluetooth_printer_name: name,
                    escpos_base64: payloads.escpos_base64,
                    thermal_width: BLUETOOTH_THERMAL_WIDTH
                };
                var kb = Math.round((payloads.escpos_base64.length * 0.75) / 1024);
                sendPayload(fallback, { status: 'Sent ESC/POS raster (' + kb + ' KB) to app', source: 'local-html' });
            }).catch(function(renderErr) {
                window.__bluetoothPrintActive = false;
                reject(renderErr instanceof Error ? renderErr : new Error(String(renderErr)));
            });
            return;
        }

        var transactionId = receipt && receipt.transaction_id;
        if (transactionId && typeof fetch === 'function') {
            if (typeof window.__bluetoothPrintDebug === 'function') {
                try {
                    window.__bluetoothPrintDebug({
                        printer_name: name,
                        printer_address: address,
                        bridge_available: isAndroidBridgeAvailable(),
                        status: 'Fetching /print/receipt for transaction_id ' + transactionId + '...'
                    });
                } catch (e) {}
            }
            var printUrl = (typeof window.__printReceiptUrl === 'string' && window.__printReceiptUrl) ? window.__printReceiptUrl : '/print/receipt';
            var csrfMeta = document.querySelector('meta[name="csrf-token"]');
            var csrfToken = csrfMeta ? csrfMeta.getAttribute('content') : (document.querySelector('input[name="_token"]') && document.querySelector('input[name="_token"]').value);
            var headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
            if (csrfToken) { headers['X-CSRF-TOKEN'] = csrfToken; }
            fetch(printUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ transaction_id: transactionId }),
                credentials: 'same-origin',
                signal: fetchAbortController ? fetchAbortController.signal : undefined
            }).then(function(res) { return res.json(); }).then(function(data) {
                var cmdCount = Array.isArray(data.commands) ? data.commands.length : 0;
                if (data.success && cmdCount > 0) {
                    if (typeof window.__bluetoothPrintDebug === 'function') {
                        try {
                            window.__bluetoothPrintDebug({
                                printer_name: name,
                                printer_address: address,
                                bridge_available: isAndroidBridgeAvailable(),
                                status: 'Server returned ' + cmdCount + ' command(s). Sending to app...',
                                payload: { server_commands: cmdCount, source: '/print/receipt' }
                            });
                        } catch (e) {}
                    }
                    var payload = {
                        type: 'bluetooth_print_receipt',
                        requestId: requestId,
                        address: address,
                        name: name,
                        bluetooth_printer_mac: address,
                        bluetooth_printer_name: name,
                        commands: data.commands
                    };
                    sendPayload(payload, {
                        status: 'Sent ' + cmdCount + ' command(s) to app',
                        server_commands: cmdCount,
                        source: '/print/receipt'
                    });
                } else {
                    if (typeof window.__bluetoothPrintDebug === 'function') {
                        try {
                            window.__bluetoothPrintDebug({
                                printer_name: name,
                                printer_address: address,
                                bridge_available: isAndroidBridgeAvailable(),
                                status: 'Server returned no commands (success=' + !!data.success + '). Rendering HTML → ESC/POS raster client-side...'
                            });
                        } catch (e) {}
                    }
                    var fallbackHtml = htmlContent || (data && data.html_content) || '';
                    captureReceiptWifiThermalPayloads({ html_content: fallbackHtml }).then(function(payloads) {
                        var fallback = {
                            type: 'bluetooth_print_receipt',
                            requestId: requestId,
                            address: address,
                            name: name,
                            bluetooth_printer_mac: address,
                            bluetooth_printer_name: name,
                            escpos_base64: payloads.escpos_base64,
                            thermal_width: BLUETOOTH_THERMAL_WIDTH
                        };
                        var kb = Math.round((payloads.escpos_base64.length * 0.75) / 1024);
                        sendPayload(fallback, { status: 'Sent ESC/POS raster (' + kb + ' KB) to app', source: '/print/receipt-render' });
                    }).catch(function(renderErr) {
                        window.__bluetoothPrintActive = false;
                        reject(renderErr instanceof Error ? renderErr : new Error(String(renderErr)));
                    });
                }
            }).catch(function(err) {
                // AbortError = timeout already resolved and cancelled us; stay silent.
                if (err && err.name === 'AbortError') return;
                console.warn('Bluetooth: /print/receipt failed, rendering HTML fallback client-side', err);
                if (typeof window.__bluetoothPrintDebug === 'function') {
                    try {
                        window.__bluetoothPrintDebug({
                            printer_name: name,
                            printer_address: address,
                            bridge_available: isAndroidBridgeAvailable(),
                            status: 'Fetch failed: ' + (err && err.message ? err.message : err) + '. Rendering HTML → ESC/POS raster client-side...'
                        });
                    } catch (e2) {}
                }
                captureReceiptWifiThermalPayloads({ html_content: htmlContent }).then(function(payloads) {
                    var fallback = {
                        type: 'bluetooth_print_receipt',
                        requestId: requestId,
                        address: address,
                        name: name,
                        bluetooth_printer_mac: address,
                        bluetooth_printer_name: name,
                        escpos_base64: payloads.escpos_base64,
                        thermal_width: BLUETOOTH_THERMAL_WIDTH
                    };
                    var kb = Math.round((payloads.escpos_base64.length * 0.75) / 1024);
                    sendPayload(fallback, { status: 'Sent ESC/POS raster (' + kb + ' KB) to app', source: 'inline-render' });
                }).catch(function(renderErr) {
                    window.__bluetoothPrintActive = false;
                    reject(renderErr instanceof Error ? renderErr : new Error(String(renderErr)));
                });
            });
            return;
        }

        if (typeof window.__bluetoothPrintDebug === 'function') {
            try {
                window.__bluetoothPrintDebug({
                    printer_name: name,
                    printer_address: address,
                    bridge_available: isAndroidBridgeAvailable(),
                    status: 'No transaction_id; rendering HTML → ESC/POS raster client-side...'
                });
            } catch (e) {}
        }
        captureReceiptWifiThermalPayloads({ html_content: htmlContent }).then(function(payloads) {
            var payload = {
                type: 'bluetooth_print_receipt',
                requestId: requestId,
                address: address,
                name: name,
                bluetooth_printer_mac: address,
                bluetooth_printer_name: name,
                escpos_base64: payloads.escpos_base64,
                thermal_width: BLUETOOTH_THERMAL_WIDTH
            };
            var kb = Math.round((payloads.escpos_base64.length * 0.75) / 1024);
            sendPayload(payload, { status: 'Sent ESC/POS raster (' + kb + ' KB) to app', source: 'inline-render' });
        }).catch(function(renderErr) {
            window.__bluetoothPrintActive = false;
            if (typeof window.__bluetoothPrintDebug === 'function') {
                try {
                    window.__bluetoothPrintDebug({
                        printer_name: name,
                        printer_address: address,
                        bridge_available: isAndroidBridgeAvailable(),
                        status: 'Client-side render failed: ' + (renderErr && renderErr.message ? renderErr.message : renderErr)
                    });
                } catch (e2) {}
            }
            reject(renderErr instanceof Error ? renderErr : new Error(String(renderErr)));
        });
    });
}

function printViaAndroidUsbBridge(receipt) {
    return new Promise(function(resolve, reject) {
        if (!isAndroidBridgeAvailable()) {
            reject(new Error('Android bridge is not available.'));
            return;
        }

        window.__bluetoothPrintActive = true;
        var requestId = 'android-usb-print-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
        var timeout = null;

        function clearActiveLater() {
            setTimeout(function() {
                window.__bluetoothPrintActive = false;
            }, 2500);
        }

        function onBridgeResult(event) {
            var detail = event && event.detail ? event.detail : {};
            if (!detail.requestId || detail.requestId !== requestId) {
                return;
            }

            clearTimeout(timeout);
            window.removeEventListener(ANDROID_BRIDGE_EVENT_NAME, onBridgeResult);
            clearActiveLater();

            if (detail.success === false) {
                reject(new Error(detail.error || detail.message || 'Android USB printing failed.'));
                return;
            }

            resolve(detail);
        }

        var deviceName = (receipt && receipt.usb_device_name) ? String(receipt.usb_device_name).trim() : (selectedUsbPrinter && selectedUsbPrinter.deviceName) ? String(selectedUsbPrinter.deviceName).trim() : '';
        var name = (receipt && receipt.usb_printer_name) ? receipt.usb_printer_name : (receipt && receipt.printer_config && receipt.printer_config.name) ? receipt.printer_config.name : (selectedUsbPrinter && selectedUsbPrinter.name) ? selectedUsbPrinter.name : null;
        if (!deviceName) {
            window.__bluetoothPrintActive = false;
            reject(new Error('USB printer device name is required. Select a USB printer from the Android app.'));
            return;
        }

        var htmlContent = (receipt && receipt.html_content) ? receipt.html_content : (typeof receipt === 'string' ? receipt : '');
        if (!htmlContent && !(receipt && receipt.transaction_id)) {
            window.__bluetoothPrintActive = false;
            reject(new Error('Receipt HTML content or transaction_id is missing.'));
            return;
        }

        var fetchAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;

        function sendPayload(payload, opts) {
            opts = opts || {};
            window.removeEventListener(ANDROID_BRIDGE_EVENT_NAME, onBridgeResult);
            window.addEventListener(ANDROID_BRIDGE_EVENT_NAME, onBridgeResult);
            clearTimeout(timeout);
            timeout = setTimeout(function() {
                window.removeEventListener(ANDROID_BRIDGE_EVENT_NAME, onBridgeResult);
                if (fetchAbortController) fetchAbortController.abort();
                clearActiveLater();
                resolve({ requestId: requestId, status: 'sent' });
            }, 4000);
            if (typeof window.__bluetoothPrintDebug === 'function') {
                try {
                    var cmdCount = Array.isArray(payload.commands) ? payload.commands.length : 0;
                    var status = opts.status || (cmdCount ? 'Sent ' + cmdCount + ' USB command(s) to app' : 'USB HTML fallback sent to app');
                    window.__bluetoothPrintDebug({
                        printer_name: name || 'USB',
                        printer_address: deviceName,
                        bridge_available: isAndroidBridgeAvailable(),
                        status: status,
                        payload: {
                            usb_printer_name: name,
                            usb_device_name: deviceName,
                            command_count: cmdCount,
                            request_id: payload.requestId || requestId,
                            server_commands: opts.server_commands,
                            source: opts.source
                        }
                    });
                } catch (e) {
                    console.warn('USB print debug callback error', e);
                }
            }
            window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        }

        var existingCommands = receipt && Array.isArray(receipt.commands) ? receipt.commands : null;
        if (existingCommands && existingCommands.length > 0) {
            sendPayload({
                type: 'usb_print_receipt',
                requestId: requestId,
                deviceName: deviceName,
                usb_device_name: deviceName,
                name: name,
                usb_printer_name: name,
                commands: existingCommands
            }, {
                status: 'Using ' + existingCommands.length + ' USB command(s) from receipt (no fetch)',
                source: 'receipt'
            });
            return;
        }

        var transactionId = receipt && receipt.transaction_id;
        if (transactionId && typeof fetch === 'function') {
            var printUrl = (typeof window.__printReceiptUrl === 'string' && window.__printReceiptUrl) ? window.__printReceiptUrl : '/print/receipt';
            var csrfMeta = document.querySelector('meta[name="csrf-token"]');
            var csrfToken = csrfMeta ? csrfMeta.getAttribute('content') : (document.querySelector('input[name="_token"]') && document.querySelector('input[name="_token"]').value);
            var headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
            if (csrfToken) { headers['X-CSRF-TOKEN'] = csrfToken; }
            fetch(printUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ transaction_id: transactionId }),
                credentials: 'same-origin',
                signal: fetchAbortController ? fetchAbortController.signal : undefined
            }).then(function(res) { return res.json(); }).then(function(data) {
                var cmdCount = Array.isArray(data.commands) ? data.commands.length : 0;
                if (data.success && cmdCount > 0) {
                    sendPayload({
                        type: 'usb_print_receipt',
                        requestId: requestId,
                        deviceName: deviceName,
                        usb_device_name: deviceName,
                        name: name,
                        usb_printer_name: name,
                        commands: data.commands
                    }, {
                        status: 'Sent ' + cmdCount + ' USB command(s) to app',
                        server_commands: cmdCount,
                        source: '/print/receipt'
                    });
                } else {
                    sendPayload({
                        type: 'usb_print_receipt',
                        requestId: requestId,
                        deviceName: deviceName,
                        usb_device_name: deviceName,
                        name: name,
                        usb_printer_name: name,
                        html_content: htmlContent || (data && data.html_content) || ''
                    }, {
                        status: 'USB HTML fallback sent to app',
                        source: '/print/receipt'
                    });
                }
            }).catch(function(err) {
                console.warn('USB: /print/receipt failed, sending HTML fallback', err);
                sendPayload({
                    type: 'usb_print_receipt',
                    requestId: requestId,
                    deviceName: deviceName,
                    usb_device_name: deviceName,
                    name: name,
                    usb_printer_name: name,
                    html_content: htmlContent
                }, {
                    status: 'USB HTML fallback sent to app',
                    source: 'inline'
                });
            });
            return;
        }

        sendPayload({
            type: 'usb_print_receipt',
            requestId: requestId,
            deviceName: deviceName,
            usb_device_name: deviceName,
            name: name,
            usb_printer_name: name,
            html_content: htmlContent
        }, {
            status: 'USB HTML payload sent to app',
            source: 'inline'
        });
    });
}

function printViaAndroidWifiBridge(receipt) {
    return new Promise(function(resolve, reject) {
        if (!isAndroidBridgeAvailable()) {
            reject(new Error('Android bridge is not available.'));
            return;
        }

        function pickWifiIp(r) {
            if (!r) return '';
            var keys = ['wifi_printer_ip_address', 'printer_ip', 'printerIp', 'ip_address', 'address', 'host', 'ip'];
            for (var k = 0; k < keys.length; k++) {
                var v = r[keys[k]];
                if (typeof v === 'string' && v.trim()) return v.trim();
            }
            if (r.printer_config && r.printer_config.ip_address) {
                return String(r.printer_config.ip_address).trim();
            }
            return '';
        }

        function buildWifiEscposMessage(requestId, name, ipAddress, portNum, extra) {
            return Object.assign({
                type: 'wifi_print_escpos',
                requestId: requestId,
                wifi_printer_name: name,
                wifi_printer_ip_address: ipAddress,
                wifi_printer_port: portNum,
                printer_ip: ipAddress,
                address: ipAddress,
                host: ipAddress,
                ip: ipAddress
            }, extra || {});
        }

        window.__bluetoothPrintActive = true;
        var requestId = 'android-wifi-print-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
        var timeout = null;

        function clearActiveLater() {
            setTimeout(function() {
                window.__bluetoothPrintActive = false;
            }, 2500);
        }

        function onBridgeResult(event) {
            var detail = event && event.detail ? event.detail : {};
            if (!detail.requestId || detail.requestId !== requestId) {
                return;
            }

            clearTimeout(timeout);
            window.removeEventListener(ANDROID_BRIDGE_EVENT_NAME, onBridgeResult);
            clearActiveLater();

            if (detail.success === false) {
                reject(new Error(detail.error || detail.message || 'Android Wi-Fi printing failed.'));
                return;
            }

            resolve(detail);
        }

        var ipAddress = pickWifiIp(receipt);
        var name = (receipt && receipt.wifi_printer_name)
            ? receipt.wifi_printer_name
            : (receipt && receipt.printer_config && receipt.printer_config.name)
                ? receipt.printer_config.name
                : 'Wi-Fi';
        var portRaw = (receipt && receipt.wifi_printer_port != null)
            ? receipt.wifi_printer_port
            : (receipt && receipt.printer_config && receipt.printer_config.wifi_port != null)
                ? receipt.printer_config.wifi_port
                : null;
        var portNum = portRaw != null && portRaw !== '' ? parseInt(String(portRaw), 10) : 9100;
        if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) {
            portNum = 9100;
        }

        if (!ipAddress) {
            window.__bluetoothPrintActive = false;
            reject(new Error('Wi-Fi printer IP address is required.'));
            return;
        }

        var htmlContent = (receipt && receipt.html_content) ? receipt.html_content : (typeof receipt === 'string' ? receipt : '');
        var transactionId = receipt && receipt.transaction_id;

        var inlineEscU = receipt && (receipt.escpos_url || receipt.escposUrl)
            ? String(receipt.escpos_url || receipt.escposUrl).trim()
            : '';
        var inlineEscB = receipt && (receipt.escpos_base64 || receipt.escposBase64)
            ? String(receipt.escpos_base64 || receipt.escposBase64).trim()
            : '';

        if (!htmlContent && !transactionId && !inlineEscU && !inlineEscB) {
            window.__bluetoothPrintActive = false;
            reject(new Error('Receipt HTML content, transaction_id, or escpos_url/escpos_base64 is missing.'));
            return;
        }

        function sendPayload(payload, opts) {
            opts = opts || {};
            window.addEventListener(ANDROID_BRIDGE_EVENT_NAME, onBridgeResult);
            timeout = setTimeout(function() {
                window.removeEventListener(ANDROID_BRIDGE_EVENT_NAME, onBridgeResult);
                clearActiveLater();
                resolve({ requestId: requestId, status: 'sent' });
            }, 12000);

            if (typeof window.__bluetoothPrintDebug === 'function') {
                try {
                    var cmdCount = Array.isArray(payload.commands) ? payload.commands.length : 0;
                    var status = opts.status || (cmdCount ? 'Sent ' + cmdCount + ' ESC/POS command(s) to app' : 'HTML/text ESC/POS payload sent to app');
                    window.__bluetoothPrintDebug({
                        printer_name: name || 'Wi-Fi',
                        printer_address: ipAddress + ':' + portNum,
                        bridge_available: isAndroidBridgeAvailable(),
                        status: status,
                        payload: {
                            wifi_printer_name: name,
                            wifi_printer_ip_address: ipAddress,
                            wifi_printer_port: portNum,
                            request_id: payload.requestId || requestId,
                            server_commands: opts.server_commands,
                            source: opts.source
                        }
                    });
                } catch (e) {
                    console.warn('Wi-Fi print debug callback error', e);
                }
            }

            window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        }

        if (inlineEscU || inlineEscB) {
            return captureReceiptWifiThermalPayloads(htmlContent ? { html_content: htmlContent } : {}).then(function(payloads) {
                sendPayload(buildWifiEscposMessage(requestId, name, ipAddress, portNum, {
                    escpos_base64: payloads.escpos_base64,
                    raster_png_base64: payloads.raster_png_base64,
                    thermal_width: BLUETOOTH_THERMAL_WIDTH
                }), {
                    status: 'Client-rendered thermal raster (bypassed inline escpos binary)',
                    source: 'receipt'
                });
            }).catch(function(capErr) {
                console.warn('Wi-Fi: client-side render failed, falling back to inline escpos', capErr);
                var inlineExtra = {};
                if (inlineEscU) inlineExtra.escpos_url = inlineEscU;
                if (inlineEscB) inlineExtra.escpos_base64 = inlineEscB;
                sendPayload(buildWifiEscposMessage(requestId, name, ipAddress, portNum, inlineExtra), {
                    status: 'Using escpos_url / escpos_base64 from receipt (client render failed)',
                    source: 'receipt'
                });
            });
        }

        var existingCommands = receipt && Array.isArray(receipt.commands) ? receipt.commands : null;
        if (existingCommands && existingCommands.length > 0) {
            sendPayload(buildWifiEscposMessage(requestId, name, ipAddress, portNum, {
                commands: existingCommands
            }), {
                status: 'Using ' + existingCommands.length + ' command(s) from receipt (no fetch)',
                source: 'receipt'
            });
            return;
        }

        if (transactionId && typeof fetch === 'function') {
            if (typeof window.__bluetoothPrintDebug === 'function') {
                try {
                    window.__bluetoothPrintDebug({
                        printer_name: name || 'Wi-Fi',
                        printer_address: ipAddress + ':' + portNum,
                        bridge_available: isAndroidBridgeAvailable(),
                        status: 'Fetching /print/receipt for transaction_id ' + transactionId + '...'
                    });
                } catch (e) {}
            }
            var printUrl = (typeof window.__printReceiptUrl === 'string' && window.__printReceiptUrl) ? window.__printReceiptUrl : '/print/receipt';
            var csrfMeta = document.querySelector('meta[name="csrf-token"]');
            var csrfToken = csrfMeta ? csrfMeta.getAttribute('content') : (document.querySelector('input[name="_token"]') && document.querySelector('input[name="_token"]').value);
            var headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
            if (csrfToken) { headers['X-CSRF-TOKEN'] = csrfToken; }
            fetch(printUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ transaction_id: transactionId }),
                credentials: 'same-origin'
            }).then(function(res) { return res.json(); }).then(function(data) {
                data = data || {};
                var cmdCount = Array.isArray(data.commands) ? data.commands.length : 0;
                var escU = (data.escpos_url || data.escposUrl || '').toString().trim();
                var escB = (data.escpos_base64 || data.escposBase64 || '').toString().trim();
                var legPdfU = (data.pdf_url || data.pdfUrl || '').toString().trim();
                var legPdfB = (data.pdf_base64 || data.pdfBase64 || '').toString().trim();

                if (data.success && escU) {
                    var clientHtmlForUrl = ((data.html_content || '') + '').trim() || htmlContent;
                    if (typeof window.__bluetoothPrintDebug === 'function') {
                        try {
                            window.__bluetoothPrintDebug({
                                printer_name: name || 'Wi-Fi',
                                printer_address: ipAddress + ':' + portNum,
                                bridge_available: isAndroidBridgeAvailable(),
                                status: clientHtmlForUrl
                                    ? 'Server returned escpos_url; rendering client-side from HTML for correct thermal sizing...'
                                    : 'Server returned escpos_url; rendering client-side from page DOM for correct thermal sizing...',
                                payload: { source: '/print/receipt' }
                            });
                        } catch (e) {}
                    }
                    return captureReceiptWifiThermalPayloads(clientHtmlForUrl ? { html_content: clientHtmlForUrl } : {}).then(function(payloads) {
                        sendPayload(buildWifiEscposMessage(requestId, name, ipAddress, portNum, {
                            escpos_base64: payloads.escpos_base64,
                            raster_png_base64: payloads.raster_png_base64,
                            thermal_width: BLUETOOTH_THERMAL_WIDTH
                        }), {
                            status: 'Sent client-rendered thermal raster (bypassed server escpos_url)',
                            source: '/print/receipt'
                        });
                    }).catch(function(capErr) {
                        console.warn('Wi-Fi: client-side render failed, falling back to server escpos_url', capErr);
                        sendPayload(buildWifiEscposMessage(requestId, name, ipAddress, portNum, { escpos_url: escU }), {
                            status: 'Sent escpos_url binary job to app (client render failed)',
                            source: '/print/receipt'
                        });
                    });
                }
                if (data.success && escB) {
                    var clientHtml = ((data.html_content || '') + '').trim() || htmlContent;
                    if (typeof window.__bluetoothPrintDebug === 'function') {
                        try {
                            window.__bluetoothPrintDebug({
                                printer_name: name || 'Wi-Fi',
                                printer_address: ipAddress + ':' + portNum,
                                bridge_available: isAndroidBridgeAvailable(),
                                status: clientHtml
                                    ? 'Server returned escpos_base64; rendering client-side from HTML for correct thermal sizing...'
                                    : 'Server returned escpos_base64; rendering client-side from page DOM for correct thermal sizing...',
                                payload: { source: '/print/receipt' }
                            });
                        } catch (e) {}
                    }
                    return captureReceiptWifiThermalPayloads(clientHtml ? { html_content: clientHtml } : {}).then(function(payloads) {
                        sendPayload(buildWifiEscposMessage(requestId, name, ipAddress, portNum, {
                            escpos_base64: payloads.escpos_base64,
                            raster_png_base64: payloads.raster_png_base64,
                            thermal_width: BLUETOOTH_THERMAL_WIDTH
                        }), {
                            status: 'Sent client-rendered thermal raster (bypassed server binary)',
                            source: '/print/receipt'
                        });
                    }).catch(function(capErr) {
                        console.warn('Wi-Fi: client-side render failed, falling back to server escpos_base64', capErr);
                        sendPayload(buildWifiEscposMessage(requestId, name, ipAddress, portNum, { escpos_base64: escB }), {
                            status: 'Sent escpos_base64 binary job to app (client render failed)',
                            source: '/print/receipt'
                        });
                    });
                }
                if (data.success && cmdCount > 0 && isQrBarcodeOnlyCommands(data.commands) && (data.html_content || '').trim()) {
                    return captureReceiptWifiThermalPayloads({ html_content: data.html_content }).then(function(payloads) {
                        if (typeof window.__bluetoothPrintDebug === 'function') {
                            try {
                                window.__bluetoothPrintDebug({
                                    printer_name: name || 'Wi-Fi',
                                    printer_address: ipAddress + ':' + portNum,
                                    bridge_available: isAndroidBridgeAvailable(),
                                    status: 'Slim receipt rendered to raster (ESC/POS + PNG) for Wi‑Fi...',
                                    payload: { server_commands: cmdCount, source: '/print/receipt' }
                                });
                            } catch (e) {}
                        }
                        sendPayload(buildWifiEscposMessage(requestId, name, ipAddress, portNum, {
                            escpos_base64: payloads.escpos_base64,
                            raster_png_base64: payloads.raster_png_base64,
                            thermal_width: BLUETOOTH_THERMAL_WIDTH
                        }), {
                            status: 'Sent Wi‑Fi thermal raster (slim receipt)',
                            server_commands: cmdCount,
                            source: '/print/receipt'
                        });
                    }).catch(function(capErr) {
                        console.warn('Wi‑Fi: receipt raster capture failed, sending QR/barcode commands only', capErr);
                        if (typeof window.__bluetoothPrintDebug === 'function') {
                            try {
                                window.__bluetoothPrintDebug({
                                    printer_name: name || 'Wi-Fi',
                                    printer_address: ipAddress + ':' + portNum,
                                    bridge_available: isAndroidBridgeAvailable(),
                                    status: 'Raster capture failed; falling back to server commands only.'
                                });
                            } catch (e) {}
                        }
                        sendPayload(buildWifiEscposMessage(requestId, name, ipAddress, portNum, {
                            commands: data.commands
                        }), {
                            status: 'Sent ' + cmdCount + ' command(s) to app (raster fallback)',
                            server_commands: cmdCount,
                            source: '/print/receipt'
                        });
                    });
                }
                if (data.success && cmdCount > 0) {
                    if (typeof window.__bluetoothPrintDebug === 'function') {
                        try {
                            window.__bluetoothPrintDebug({
                                printer_name: name || 'Wi-Fi',
                                printer_address: ipAddress + ':' + portNum,
                                bridge_available: isAndroidBridgeAvailable(),
                                status: 'Server returned ' + cmdCount + ' ESC/POS command(s). Sending to app...',
                                payload: { server_commands: cmdCount, source: '/print/receipt' }
                            });
                        } catch (e) {}
                    }
                    sendPayload(buildWifiEscposMessage(requestId, name, ipAddress, portNum, {
                        commands: data.commands
                    }), {
                        status: 'Sent ' + cmdCount + ' command(s) to app',
                        server_commands: cmdCount,
                        source: '/print/receipt'
                    });
                    return;
                }
                if (data.success && (legPdfU || legPdfB)) {
                    var legExtra = {};
                    if (legPdfU) legExtra.pdf_url = legPdfU;
                    if (legPdfB) legExtra.pdf_base64 = legPdfB;
                    if (typeof window.__bluetoothPrintDebug === 'function') {
                        try {
                            window.__bluetoothPrintDebug({
                                printer_name: name || 'Wi-Fi',
                                printer_address: ipAddress + ':' + portNum,
                                bridge_available: isAndroidBridgeAvailable(),
                                status: 'Server returned legacy pdf_* raw blob; sending to app...',
                                payload: { source: '/print/receipt' }
                            });
                        } catch (e) {}
                    }
                    sendPayload(buildWifiEscposMessage(requestId, name, ipAddress, portNum, legExtra), {
                        status: 'Sent legacy pdf_url/pdf_base64 raw job to app',
                        source: '/print/receipt'
                    });
                    return;
                }
                if (typeof window.__bluetoothPrintDebug === 'function') {
                    try {
                        window.__bluetoothPrintDebug({
                            printer_name: name || 'Wi-Fi',
                            printer_address: ipAddress + ':' + portNum,
                            bridge_available: isAndroidBridgeAvailable(),
                            status: 'Server returned no binary job or commands (success=' + !!data.success + '). Using HTML ESC/POS fallback.'
                        });
                    } catch (e) {}
                }
                sendPayload(buildWifiEscposMessage(requestId, name, ipAddress, portNum, {
                    html_content: htmlContent || (data && data.html_content) || '',
                    thermal_width: BLUETOOTH_THERMAL_WIDTH
                }), { status: 'HTML fallback sent to app', source: '/print/receipt' });
            }).catch(function(err) {
                console.warn('Wi-Fi: /print/receipt failed, sending HTML ESC/POS fallback', err);
                if (typeof window.__bluetoothPrintDebug === 'function') {
                    try {
                        window.__bluetoothPrintDebug({
                            printer_name: name || 'Wi-Fi',
                            printer_address: ipAddress + ':' + portNum,
                            bridge_available: isAndroidBridgeAvailable(),
                            status: 'Fetch failed: ' + (err && err.message ? err.message : err) + '. Using HTML fallback.'
                        });
                    } catch (e2) {}
                }
                sendPayload(buildWifiEscposMessage(requestId, name, ipAddress, portNum, {
                    html_content: htmlContent,
                    thermal_width: BLUETOOTH_THERMAL_WIDTH
                }), { status: 'HTML fallback after fetch error', source: 'inline' });
            });
            return;
        }

        sendPayload(buildWifiEscposMessage(requestId, name, ipAddress, portNum, {
            html_content: htmlContent
        }), { status: 'Wi-Fi ESC/POS HTML payload sent to app', source: 'inline' });
    });
}

function printViaSunmiAndroidBridge(receipt) {
    return new Promise(function(resolve, reject) {
        if (!isAndroidBridgeAvailable()) {
            reject(new Error('Android bridge is not available.'));
            return;
        }

        window.__bluetoothPrintActive = true;
        var requestId = 'android-sunmi-print-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
        var timeout = null;
        var fetchAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;

        function onJavaDebugLog(event) {
            var d = event && event.detail ? event.detail : {};
            if (d.requestId === requestId && d.log) {
                printDebugLog('<span style="color:#93c5fd;">' + d.log + '</span>');
            }
        }
        window.addEventListener('zat-sunmi-debug-log', onJavaDebugLog);

        function onBridgeResult(event) {
            var detail = event && event.detail ? event.detail : {};
            if (!detail.requestId || detail.requestId !== requestId) {
                return;
            }
            clearTimeout(timeout);
            window.removeEventListener(ANDROID_BRIDGE_EVENT_NAME, onBridgeResult);
            if (detail.success === false) {
                var errMsg = detail.error || 'Sunmi inner print failed.';
                printDebugLog('<span style="color:#f87171;">Java: ' + errMsg + '</span>');
                updatePrintStatus('Failed: ' + errMsg, '#f87171');
                window.__bluetoothPrintActive = false;
                window.removeEventListener('zat-sunmi-debug-log', onJavaDebugLog);
                reject(new Error(errMsg));
            } else {
                printDebugLog('<span style="color:#86efac;">Java: print succeeded</span>');
                updatePrintStatus('Printed OK', '#86efac');
                window.removeEventListener('zat-sunmi-debug-log', onJavaDebugLog);
                setTimeout(function() { window.__bluetoothPrintActive = false; }, 3000);
                resolve(detail);
            }
        }

        // payload: { escpos_base64 } for server ESC/POS, { image_base64 } for PNG bitmap
        function sendSunmiPayload(payload) {
            var sizeKb = Math.round(((payload.image_base64 || payload.escpos_base64 || '').length * 0.75) / 1024);
            var mode = payload.image_base64 ? 'PNG bitmap' : 'ESC/POS';
            window.removeEventListener(ANDROID_BRIDGE_EVENT_NAME, onBridgeResult);
            window.addEventListener(ANDROID_BRIDGE_EVENT_NAME, onBridgeResult);
            clearTimeout(timeout);
            printDebugLog('Sending ' + sizeKb + ' KB ' + mode + ' to Sunmi service...');
            updatePrintStatus('Sending to Sunmi...', '#fbbf24');
            timeout = setTimeout(function() {
                window.removeEventListener(ANDROID_BRIDGE_EVENT_NAME, onBridgeResult);
                window.removeEventListener('zat-sunmi-debug-log', onJavaDebugLog);
                printDebugLog('<span style="color:#fbbf24;">No response from Sunmi service after 20s — resolving anyway</span>');
                updatePrintStatus('Timeout (no ack)', '#fbbf24');
                window.__bluetoothPrintActive = false;
                resolve({ requestId: requestId, status: 'sent' });
            }, 20000);
            window.ReactNativeWebView.postMessage(JSON.stringify(
                Object.assign({ type: 'sunmi_inner_print_receipt', requestId: requestId }, payload)
            ));
        }

        var sunmiThermalWidth = (receipt && receipt.thermal_width) ? parseInt(receipt.thermal_width) : SUNMI_THERMAL_WIDTH;

        function renderAndSend() {
            printDebugLog('Rendering receipt via html2canvas (' + sunmiThermalWidth + 'px)...');
            updatePrintStatus('Rendering receipt...', '#fbbf24');
            renderReceiptToThermalCanvas(receipt, sunmiThermalWidth).then(function(canvas) {
                printDebugLog('Canvas: ' + canvas.width + 'x' + canvas.height + 'px — encoding PNG...');
                // Send as PNG bitmap — Java uses printBitmap() which works on all Sunmi models.
                // sendRAWData with GS v 0 raster does not print on many Sunmi firmware versions.
                var pngB64 = canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
                printDebugLog('PNG encoded: ' + Math.round(pngB64.length * 0.75 / 1024) + ' KB');
                sendSunmiPayload({ image_base64: pngB64 });
            }).catch(function(err) {
                var msg = err && err.message ? err.message : String(err);
                console.error('Sunmi: receipt render failed', err);
                printDebugLog('<span style="color:#f87171;">Render failed: ' + msg + '</span>');
                updatePrintStatus('Render failed', '#f87171');
                window.__bluetoothPrintActive = false;
                reject(new Error('Sunmi receipt render failed: ' + msg));
            });
        }

        // 1. Inline escpos_base64 from receipt object (highest priority)
        var inlineB64 = receipt && (receipt.escpos_base64 || receipt.escposBase64)
            ? String(receipt.escpos_base64 || receipt.escposBase64).trim() : '';
        if (inlineB64) {
            printDebugLog('Using inline escpos_base64 (' + Math.round(inlineB64.length * 0.75 / 1024) + ' KB)');
            sendSunmiPayload({ escpos_base64: inlineB64 });
            return;
        }

        // 2. If caller explicitly said to use local HTML (mobile compact template),
        // render directly and skip the server fetch — the server returns the A4 layout.
        if (receipt && receipt.use_local_html && receipt.html_content) {
            printDebugLog('use_local_html flag set — rendering local html_content, skipping /print/receipt fetch');
            renderAndSend();
            return;
        }

        // 3. Fetch server-generated ESC/POS if we have a transaction_id
        var transactionId = receipt && receipt.transaction_id;
        if (transactionId && typeof fetch === 'function') {
            printDebugLog('Fetching /print/receipt for transaction ' + transactionId + '...');
            updatePrintStatus('Fetching from server...', '#fbbf24');
            var printUrl = (typeof window.__printReceiptUrl === 'string' && window.__printReceiptUrl) ? window.__printReceiptUrl : '/print/receipt';
            var csrfMeta = document.querySelector('meta[name="csrf-token"]');
            var csrfToken = csrfMeta ? csrfMeta.getAttribute('content') : (document.querySelector('input[name="_token"]') && document.querySelector('input[name="_token"]').value);
            var headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
            if (csrfToken) headers['X-CSRF-TOKEN'] = csrfToken;
            fetch(printUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ transaction_id: transactionId }),
                credentials: 'same-origin',
                signal: fetchAbortController ? fetchAbortController.signal : undefined
            }).then(function(res) { return res.json(); }).then(function(data) {
                if (data.success && data.escpos_base64) {
                    printDebugLog('Server returned escpos_base64 (' + Math.round(data.escpos_base64.length * 0.75 / 1024) + ' KB)');
                    sendSunmiPayload({ escpos_base64: data.escpos_base64 });
                } else {
                    printDebugLog('Server has no escpos_base64 — falling back to render');
                    renderAndSend();
                }
            }).catch(function(err) {
                if (err && err.name === 'AbortError') return;
                printDebugLog('Fetch failed (' + (err && err.message ? err.message : err) + ') — falling back to render');
                renderAndSend();
            });
            return;
        }

        // 3. No transaction_id — render directly
        renderAndSend();
    });
}

// Expose helpers globally for other modules
window.printerTray.getPrinterTrayHealth = getPrinterTrayHealth;
window.printerTray.getAvailablePrinters = getAvailablePrinters;
window.printerTray.printReceipt = printReceipt;
window.printerTray.printHTML = printHTML;
window.printerTray.getAndroidBridgeHealth = getAndroidBridgeHealth;
window.printerTray.isAndroidBridgeAvailable = isAndroidBridgeAvailable;
window.printerTray.getAvailableBluetoothPrinters = getAvailableBluetoothPrinters;
window.printerTray.getAvailableUsbPrinters = getAvailableUsbPrinters;
window.printerTray.requestBluetoothScan = requestBluetoothScan;
window.printerTray.requestBluetoothPrintersOnLoad = requestBluetoothPrintersOnLoad;
window.printerTray.requestUsbPrinterScan = requestUsbPrinterScan;
window.printerTray.requestUsbPrintersOnLoad = requestUsbPrintersOnLoad;
window.printerTray.printViaAndroidBridge = printViaAndroidBridge;
window.printerTray.printViaAndroidUsbBridge = printViaAndroidUsbBridge;
window.printerTray.printViaAndroidWifiBridge = printViaAndroidWifiBridge;
window.printerTray.printViaSunmiAndroidBridge = printViaSunmiAndroidBridge;
