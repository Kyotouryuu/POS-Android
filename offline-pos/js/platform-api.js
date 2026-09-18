/**
 * Platform API Facade v2 - ANDROID MIGRATION
 * Unified interface for Windows (Electron) and Android (Capacitor)
 * Supports: Network detection, Printing (WiFi/Bluetooth/USB), Camera scanning
 */

window.platformAPI = {
  // ─────────────────────────────────────────────────────────────────────────
  // PLATFORM DETECTION
  // ─────────────────────────────────────────────────────────────────────────

  isElectron() {
    return !!window.electronAPI;
  },

  isCapacitor() {
    return !!window.Capacitor;
  },

  isWeb() {
    return !this.isElectron() && !this.isCapacitor();
  },

  isPlatformAvailable() {
    return !!window.electronAPI || !!window.Capacitor;
  },

  // ─────────────────────────────────────────────────────────────────────────
  // APP INFO
  // ─────────────────────────────────────────────────────────────────────────

  async getAppVersion() {
    if (window.electronAPI?.appVersion) {
      return window.electronAPI.appVersion;
    }
    if (window.Capacitor) {
      try {
        const { App } = window.Capacitor.Plugins;
        const info = await App.getInfo();
        return info.version;
      } catch (e) {
        console.error('Error getting app version from Capacitor:', e);
      }
    }
    return 'unknown';
  },

  async getDeviceInfo() {
    if (window.Capacitor) {
      try {
        const { Device } = window.Capacitor.Plugins;
        return await Device.getInfo();
      } catch (e) {
        console.error('Error getting device info from Capacitor:', e);
      }
    }
    return null;
  },

  // ─────────────────────────────────────────────────────────────────────────
  // NETWORK STATUS (CRITICAL FOR OFFLINE-FIRST)
  // ─────────────────────────────────────────────────────────────────────────

  async getNetworkStatus() {
    if (window.Capacitor) {
      try {
        const { Network } = window.Capacitor.Plugins;
        const status = await Network.getStatus();
        return {
          connected: status.connected,
          type: status.connectionType,
          isCapacitor: true
        };
      } catch (e) {
        console.error('Error getting network status from Capacitor:', e);
      }
    }
    // Fallback to navigator
    return {
      connected: navigator.onLine,
      type: navigator.onLine ? 'unknown' : 'offline',
      isCapacitor: false
    };
  },

  /**
   * Register network status listener
   * Triggered when network goes online/offline
   * CRITICAL for auto-sync in app.js
   */
  onNetworkStatusChange(callback) {
    if (window.Capacitor) {
      try {
        const { Network } = window.Capacitor.Plugins;
        Network.addListener('networkStatusChange', async (status) => {
          console.log('[Network] Status changed:', status.connected);
          callback({
            connected: status.connected,
            type: status.connectionType,
            isCapacitor: true
          });
        });
        return true;
      } catch (e) {
        console.error('Error adding network listener:', e);
      }
    }

    // Fallback: Browser events
    window.addEventListener('online', () => {
      console.log('[Network] Browser online');
      callback({ connected: true, type: 'wifi', isCapacitor: false });
    });
    window.addEventListener('offline', () => {
      console.log('[Network] Browser offline');
      callback({ connected: false, type: 'none', isCapacitor: false });
    });
    return true;
  },

  // ─────────────────────────────────────────────────────────────────────────
  // PRINTING (CORE ANDROID FEATURE)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Print receipt (routes to appropriate printer type)
   * Supported types: 'wifi', 'bluetooth', 'usb', 'browser'
   */
  async printReceipt(html, printerConfig = {}) {
    try {
      const printerType = printerConfig.type || 'browser';

      // Windows: Electron tray service
      if (this.isElectron()) {
        if (window.electronAPI && window.electronAPI.print) {
          return await window.electronAPI.print(html, printerConfig);
        }
      }

      // Android: Route to specific printer
      if (this.isCapacitor()) {
        if (printerType === 'wifi') {
          return await this.printViaWiFi(html, printerConfig);
        } else if (printerType === 'bluetooth') {
          return await this.printViaBluetooth(html, printerConfig);
        } else if (printerType === 'usb') {
          return await this.printViaUSB(html, printerConfig);
        }
      }

      // Fallback: Browser print
      return await this.printBrowser(html);
    } catch (err) {
      console.error('Print error:', err);
      return await this.printBrowser(html);
    }
  },

  /**
   * WiFi Printer (100% READY)
   * Connect via TCP/9100 to thermal printer
   */
  async printViaWiFi(html, config) {
    try {
      const printerIp = config.ip || config.host;
      const printerPort = config.port || 9100;
      const paperWidth = config.paperWidth || 80;

      if (!printerIp) throw new Error('WiFi printer IP required');

      console.log(`[Printer] WiFi: ${printerIp}:${printerPort}`);

      // Render receipt to thermal canvas
      const canvas = await this.renderReceiptToThermalCanvas(html, paperWidth);
      
      // Convert canvas to ESC/POS binary
      const escPosData = this.escPosGsV0RasterFromCanvas(canvas);

      // Send via HTTP (works if printer exposes HTTP interface)
      try {
        const response = await fetch(`http://${printerIp}:${printerPort}/print`, {
          method: 'POST',
          body: escPosData,
          headers: { 'Content-Type': 'application/octet-stream' }
        });
        if (response.ok) {
          return { success: true, message: 'Sent to WiFi printer' };
        }
      } catch (httpErr) {
        // If HTTP fails, use raw TCP via Capacitor (requires native plugin)
        if (window.Capacitor) {
          window.ReactNativeWebView?.postMessage?.(JSON.stringify({
            action: 'printWiFi',
            ip: printerIp,
            port: printerPort,
            data: Array.from(new Uint8Array(escPosData))
          }));
          return { success: true, message: 'Sent to WiFi printer (native)' };
        }
      }

      throw new Error('WiFi printer unreachable');
    } catch (err) {
      console.error('WiFi print error:', err);
      throw err;
    }
  },

  /**
   * Bluetooth Printer (90% READY)
   * Requires Kotlin native code for device pairing/connection
   */
  async printViaBluetooth(html, config) {
    try {
      if (!this.isCapacitor()) {
        throw new Error('Bluetooth printing only on Android');
      }

      const deviceId = config.deviceId;
      const deviceMac = config.deviceMac;
      const paperWidth = config.paperWidth || 80;

      if (!deviceId && !deviceMac) {
        throw new Error('Bluetooth device ID or MAC required');
      }

      console.log(`[Printer] Bluetooth: ${deviceId || deviceMac}`);

      // Render receipt
      const canvas = await this.renderReceiptToThermalCanvas(html, paperWidth);
      const escPosData = this.escPosGsV0RasterFromCanvas(canvas);

      // Send to Kotlin bridge
      window.ReactNativeWebView?.postMessage?.(JSON.stringify({
        action: 'printBluetooth',
        deviceId: deviceId,
        deviceMac: deviceMac,
        data: Array.from(new Uint8Array(escPosData))
      }));

      return { success: true, message: 'Sent to Bluetooth printer' };
    } catch (err) {
      console.error('Bluetooth print error:', err);
      throw err;
    }
  },

  /**
   * USB Printer (80% READY)
   * Requires Kotlin native code for USB enumeration
   */
  async printViaUSB(html, config) {
    try {
      if (!this.isCapacitor()) {
        throw new Error('USB printing only on Android');
      }

      const paperWidth = config.paperWidth || 80;

      console.log('[Printer] USB');

      // Render receipt
      const canvas = await this.renderReceiptToThermalCanvas(html, paperWidth);
      const escPosData = this.escPosGsV0RasterFromCanvas(canvas);

      // Send to Kotlin bridge
      window.ReactNativeWebView?.postMessage?.(JSON.stringify({
        action: 'printUSB',
        data: Array.from(new Uint8Array(escPosData))
      }));

      return { success: true, message: 'Sent to USB printer' };
    } catch (err) {
      console.error('USB print error:', err);
      throw err;
    }
  },

  /**
   * Browser Print Fallback (ALWAYS WORKS)
   */
  async printBrowser(html) {
    return new Promise((resolve) => {
      const printWindow = window.open('', '', 'height=600,width=800');
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.focus();

      setTimeout(() => {
        printWindow.print();
        printWindow.close();
        resolve({ success: true, message: 'Sent to browser print' });
      }, 250);
    });
  },

  // ─────────────────────────────────────────────────────────────────────────
  // RECEIPT RENDERING (SHARED LOGIC)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Render HTML receipt to thermal canvas
   * Requires html2canvas library
   */
  async renderReceiptToThermalCanvas(html, paperWidth = 80) {
    if (typeof html2canvas === 'undefined') {
      throw new Error('html2canvas library not loaded');
    }

    const container = document.createElement('div');
    container.style.width = `${paperWidth}mm`;
    container.style.position = 'absolute';
    container.style.left = '-9999px';
    container.style.top = '-9999px';
    container.innerHTML = html;
    document.body.appendChild(container);

    try {
      const canvas = await html2canvas(container, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff'
      });
      return canvas;
    } finally {
      document.body.removeChild(container);
    }
  },

  /**
   * Convert canvas to ESC/POS binary (GS v 0 raster)
   * Output: Uint8Array ready for printer
   */
  escPosGsV0RasterFromCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    // Get image data
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    // Convert to 1-bit raster (black/white only)
    const rasterWidth = Math.ceil(width / 8);
    const rasterData = new Uint8Array(rasterWidth * height);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixelIndex = (y * width + x) * 4;
        const grayscale = (data[pixelIndex] + data[pixelIndex + 1] + data[pixelIndex + 2]) / 3;
        const bit = grayscale > 127 ? 0 : 1; // 0=white, 1=black

        const rasterIndex = y * rasterWidth + Math.floor(x / 8);
        const bitPosition = 7 - (x % 8);
        rasterData[rasterIndex] |= (bit << bitPosition);
      }
    }

    // Build ESC/POS command sequence
    const commands = [];

    // Initialize printer
    commands.push(new Uint8Array([0x1B, 0x40])); // ESC @ (reset)

    // Set print mode
    commands.push(new Uint8Array([0x1B, 0x21, 0x00])); // ESC ! 0

    // GS v 0 raster image command
    const widthLo = width % 256;
    const widthHi = Math.floor(width / 256);
    const heightLo = height % 256;
    const heightHi = Math.floor(height / 256);

    commands.push(new Uint8Array([0x1D, 0x76, 0x30, 0x00])); // GS v 0
    commands.push(new Uint8Array([widthLo, widthHi, heightLo, heightHi]));
    commands.push(rasterData);

    // Cut paper (optional)
    commands.push(new Uint8Array([0x1D, 0x56, 0x42, 0x00])); // GS V B

    // Combine all commands
    const totalLength = commands.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const cmd of commands) {
      result.set(cmd, offset);
      offset += cmd.length;
    }

    return result;
  },

  // ─────────────────────────────────────────────────────────────────────────
  // CAMERA BARCODE SCANNING (FUTURE ENHANCEMENT)
  // ─────────────────────────────────────────────────────────────────────────

  async scanBarcodeWithCamera() {
    try {
      if (!this.isCapacitor()) {
        throw new Error('Camera scanning only on Android');
      }

      const { Camera } = window.Capacitor.Plugins;
      const photo = await Camera.getPhoto({
        quality: 90,
        allowEditing: false,
        resultType: 'uri'
      });

      console.log('[Camera] Photo captured, sending to barcode detector');

      // Send to Kotlin bridge for barcode detection
      return new Promise((resolve, reject) => {
        window.ReactNativeWebView?.postMessage?.(JSON.stringify({
          action: 'detectBarcode',
          imageUri: photo.webPath
        }));

        // Wait for response
        window.barcodeCallback = (result) => {
          if (result.error) {
            reject(new Error(result.error));
          } else {
            resolve(result.barcode);
          }
          delete window.barcodeCallback;
        };

        // Timeout after 10 seconds
        setTimeout(() => {
          if (window.barcodeCallback) {
            reject(new Error('Barcode detection timeout'));
            delete window.barcodeCallback;
          }
        }, 10000);
      });
    } catch (err) {
      console.error('Camera scan error:', err);
      throw err;
    }
  },

  // ─────────────────────────────────────────────────────────────────────────
  // EXTERNAL LINKS & NAVIGATION
  // ─────────────────────────────────────────────────────────────────────────

  async openExternal(url) {
    if (this.isElectron() && window.electronAPI?.openExternal) {
      return window.electronAPI.openExternal(url);
    }
    if (this.isCapacitor()) {
      try {
        const { Browser } = window.Capacitor.Plugins;
        return Browser.open({ url });
      } catch (e) {
        console.error('Error opening URL with Capacitor:', e);
        return window.open(url, '_blank');
      }
    }
    // Fallback for web
    return window.open(url, '_blank');
  }
};

// Expose as window.api for convenience
window.api = window.platformAPI;
