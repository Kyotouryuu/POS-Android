package com.zatpos.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import android.util.Log;
import com.getcapacitor.Bridge;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;

/**
 * Wi-Fi (raw TCP :9100) ESC/POS printing for POS-Android.
 * JS sends a `wifi_print_escpos` message containing either:
 *   - raster_png_base64 (preferred): PNG rendered client-side at thermal width → convert to GS v 0 raster here
 *   - escpos_base64: pre-built ESC/POS bytes
 *   - commands: minimal JSON command list
 * See docs/wifi-png-escpos-print-flow.md in the POS-Mobile repo for the full flow.
 */
public class WifiPrinterManager {
    private static final String TAG = "ZatWifiPrint";

    private static final int DEFAULT_PORT = 9100;
    private static final int DEFAULT_THERMAL_WIDTH = 576;
    private static final int MAX_UPSCALE_PCT = 250; // 2.5x cap
    private static final int CROP_WHITE_LUMA = 245;
    private static final int CONNECT_TIMEOUT_MS = 10000;
    private static final int WRITE_CHUNK = 16384;
    private static final int POST_WRITE_DELAY_MS = 200;
    private static final int DEFAULT_FEED_LINES = 10;

    private final Context context;
    private final Bridge bridge;

    public WifiPrinterManager(Context context, Bridge bridge) {
        this.context = context;
        this.bridge = bridge;
    }

    /**
     * Multi-host variant: msg.targets is an array of
     *   { host, port, pngBase64List: [b64, ...] }
     * Each target gets its own TCP job, dispatched on its own worker thread so a
     * slow printer doesn't block the rest. Reports a single aggregate result once
     * all targets have completed (or any have failed).
     */
    public void handlePrintReceiptMulti(JSONObject msg) {
        new Thread(() -> {
            String requestId = msg.optString("requestId", null);
            JSONArray targets = msg.optJSONArray("targets");
            if (targets == null) targets = msg.optJSONArray("wifi_printer_targets");
            if (targets == null || targets.length() == 0) {
                sendPrintResult(requestId, false, "No Wi-Fi printer targets provided");
                return;
            }

            int thermalWidth = msg.optInt("thermal_width", DEFAULT_THERMAL_WIDTH);
            if (thermalWidth <= 0) thermalWidth = DEFAULT_THERMAL_WIDTH;
            final int tw = thermalWidth;
            final int feedLines = clamp(msg.optInt("wifi_feed_lines_before_partial_cut", DEFAULT_FEED_LINES), 0, 255);

            int targetCount = targets.length();
            final boolean[] successes = new boolean[targetCount];
            final String[] errors    = new String[targetCount];
            final Thread[] workers   = new Thread[targetCount];

            for (int i = 0; i < targetCount; i++) {
                final int idx = i;
                final JSONObject t = targets.optJSONObject(i);
                workers[i] = new Thread(() -> {
                    try {
                        if (t == null) throw new Exception("Target entry is null");
                        String host = firstNonEmpty(
                                t.optString("host", ""),
                                firstNonEmpty(t.optString("ip", ""), t.optString("ip_address", ""))).trim();
                        int port = t.optInt("port", DEFAULT_PORT);
                        if (port <= 0 || port > 65535) port = DEFAULT_PORT;
                        host = stripPortFromHost(host);
                        if (host.isEmpty()) throw new Exception("Target host is missing");

                        JSONArray pngList = t.optJSONArray("pngBase64List");
                        if (pngList == null) pngList = t.optJSONArray("raster_png_base64_list");
                        if (pngList == null || pngList.length() == 0) {
                            throw new Exception("Target has no PNGs to print");
                        }

                        for (int j = 0; j < pngList.length(); j++) {
                            String b64 = pngList.optString(j, "");
                            if (b64 == null || b64.isEmpty()) continue;
                            byte[] pngBytes = Base64.decode(stripDataUrlPrefix(b64), Base64.DEFAULT);
                            byte[] raster = pngBytesToGsV0Raster(pngBytes, tw);
                            byte[] job = buildRasterJob(raster, null, feedLines);
                            sendJobOverTcp(host, port, job);
                        }
                        successes[idx] = true;
                    } catch (Exception e) {
                        successes[idx] = false;
                        errors[idx] = (t != null ? t.optString("host", "?") : "?") + ": " + e.getMessage();
                        Log.e(TAG, "multi target " + idx + " error: " + e.getMessage(), e);
                    }
                });
                workers[i].start();
            }

            // Wait for all workers to finish, then report aggregate result.
            int okCount = 0;
            StringBuilder errMsg = new StringBuilder();
            for (int i = 0; i < targetCount; i++) {
                try { workers[i].join(); } catch (InterruptedException ignored) {}
                if (successes[i]) {
                    okCount++;
                } else if (errors[i] != null) {
                    if (errMsg.length() > 0) errMsg.append("; ");
                    errMsg.append(errors[i]);
                }
            }

            if (okCount == targetCount) {
                sendPrintResult(requestId, true, null);
            } else if (okCount == 0) {
                sendPrintResult(requestId, false, errMsg.length() > 0 ? errMsg.toString() : "All Wi-Fi targets failed");
            } else {
                // Partial success — report failure so the caller surfaces the error, but include
                // the partial-success context in the error string.
                sendPrintResult(requestId, false,
                        okCount + "/" + targetCount + " printers succeeded. Failed: " + errMsg);
            }
        }).start();
    }

    public void handlePrintReceipt(JSONObject msg) {
        new Thread(() -> {
            String requestId = msg.optString("requestId", null);
            String host = pickHost(msg);
            int port = pickPort(msg, host);
            host = stripPortFromHost(host);

            if (host == null || host.isEmpty()) {
                sendPrintResult(requestId, false, "Wi-Fi printer IP is missing");
                return;
            }

            try {
                int thermalWidth = msg.optInt("thermal_width", DEFAULT_THERMAL_WIDTH);
                if (thermalWidth <= 0) thermalWidth = DEFAULT_THERMAL_WIDTH;
                int feedLines = clamp(msg.optInt("wifi_feed_lines_before_partial_cut", DEFAULT_FEED_LINES), 0, 255);

                byte[] suffix = decodeOptionalBase64(firstNonEmpty(
                        msg.optString("escpos_suffix_base64", ""),
                        msg.optString("escposSuffixBase64", "")));
                // Printer is initialized once per job, so strip any leading ESC @ from suffix.
                suffix = stripLeadingInit(suffix);

                JSONArray pngList = collectPngList(msg);
                if (pngList != null && pngList.length() > 0) {
                    for (int i = 0; i < pngList.length(); i++) {
                        String b64 = pngList.optString(i, "");
                        if (b64 == null || b64.isEmpty()) continue;
                        byte[] pngBytes = Base64.decode(stripDataUrlPrefix(b64), Base64.DEFAULT);
                        byte[] raster = pngBytesToGsV0Raster(pngBytes, thermalWidth);
                        boolean isLast = i == pngList.length() - 1;
                        byte[] job = buildRasterJob(raster, isLast ? suffix : null, feedLines);
                        sendJobOverTcp(host, port, job);
                    }
                    sendPrintResult(requestId, true, null);
                    return;
                }

                // Fallback: pre-built ESC/POS bytes
                String escposB64 = firstNonEmpty(
                        msg.optString("escpos_base64", ""),
                        msg.optString("escposBase64", ""));
                if (!escposB64.isEmpty()) {
                    byte[] bytes = Base64.decode(stripDataUrlPrefix(escposB64), Base64.DEFAULT);
                    sendJobOverTcp(host, port, bytes);
                    sendPrintResult(requestId, true, null);
                    return;
                }

                // Fallback: JSON commands
                JSONArray commands = msg.optJSONArray("commands");
                if (commands != null && commands.length() > 0) {
                    byte[] bytes = buildFromCommands(commands, feedLines);
                    sendJobOverTcp(host, port, bytes);
                    sendPrintResult(requestId, true, null);
                    return;
                }

                sendPrintResult(requestId, false, "No printable data (raster_png_base64 / escpos_base64 / commands required)");
            } catch (Exception e) {
                Log.e(TAG, "handlePrintReceipt error: " + e.getMessage(), e);
                sendPrintResult(requestId, false, "Wi-Fi print error: " + e.getMessage());
            }
        }).start();
    }

    // ---------- Payload parsing ----------

    private String pickHost(JSONObject msg) {
        String[] keys = {"wifi_printer_ip_address", "printer_ip", "printerIp", "ip_address", "address", "host", "ip"};
        for (String k : keys) {
            String v = msg.optString(k, "").trim();
            if (!v.isEmpty()) return v;
        }
        return "";
    }

    private int pickPort(JSONObject msg, String hostMaybeWithPort) {
        String[] keys = {"wifi_printer_port", "printer_port", "printerPort", "port"};
        for (String k : keys) {
            int v = msg.optInt(k, -1);
            if (v > 0 && v <= 65535) return v;
            String s = msg.optString(k, "").trim();
            if (!s.isEmpty()) {
                try {
                    int n = Integer.parseInt(s);
                    if (n > 0 && n <= 65535) return n;
                } catch (NumberFormatException ignored) {}
            }
        }
        if (hostMaybeWithPort != null && hostMaybeWithPort.contains(":")) {
            try {
                int n = Integer.parseInt(hostMaybeWithPort.substring(hostMaybeWithPort.lastIndexOf(':') + 1));
                if (n > 0 && n <= 65535) return n;
            } catch (NumberFormatException ignored) {}
        }
        return DEFAULT_PORT;
    }

    private String stripPortFromHost(String host) {
        if (host == null) return null;
        int idx = host.lastIndexOf(':');
        if (idx > 0 && idx == host.indexOf(':')) {
            // IPv4 or hostname with port
            return host.substring(0, idx);
        }
        return host;
    }

    private JSONArray collectPngList(JSONObject msg) {
        String[] listKeys = {"wifi_raster_png_base64_list", "raster_png_base64_list", "rasterPngBase64List", "png_base64_list"};
        for (String k : listKeys) {
            JSONArray arr = msg.optJSONArray(k);
            if (arr != null && arr.length() > 0) return arr;
        }
        String[] singleKeys = {"wifi_raster_png_base64", "raster_png_base64", "png_base64", "pngBase64", "image_base64"};
        for (String k : singleKeys) {
            String v = msg.optString(k, "").trim();
            if (!v.isEmpty()) {
                JSONArray arr = new JSONArray();
                arr.put(v);
                return arr;
            }
        }
        // Also look inside `payload` for parity with POS-Mobile
        JSONObject payload = msg.optJSONObject("payload");
        if (payload != null) return collectPngList(payload);
        return null;
    }

    private String stripDataUrlPrefix(String s) {
        if (s == null) return "";
        int comma = s.indexOf(',');
        if (s.startsWith("data:") && comma > 0) return s.substring(comma + 1);
        return s;
    }

    private byte[] decodeOptionalBase64(String s) {
        if (s == null || s.isEmpty()) return null;
        try {
            return Base64.decode(stripDataUrlPrefix(s), Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private byte[] stripLeadingInit(byte[] bytes) {
        if (bytes == null || bytes.length < 2) return bytes;
        if (bytes[0] == 0x1B && bytes[1] == 0x40) {
            byte[] out = new byte[bytes.length - 2];
            System.arraycopy(bytes, 2, out, 0, out.length);
            return out;
        }
        return bytes;
    }

    private String firstNonEmpty(String a, String b) {
        if (a != null && !a.isEmpty()) return a;
        return b == null ? "" : b;
    }

    private int clamp(int v, int lo, int hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    // ---------- Job assembly ----------

    private byte[] buildRasterJob(byte[] raster, byte[] suffix, int feedLines) {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try {
            baos.write(new byte[]{0x1B, 0x40}); // ESC @ init
            baos.write(raster);
            if (suffix != null && suffix.length > 0) baos.write(suffix);
            baos.write(new byte[]{0x1B, 0x64, (byte) feedLines}); // ESC d n
            baos.write(new byte[]{0x1D, 0x56, 0x01});             // GS V 1 partial cut
        } catch (Exception e) {
            Log.e(TAG, "buildRasterJob error: " + e.getMessage());
        }
        return baos.toByteArray();
    }

    private byte[] buildFromCommands(JSONArray commands, int feedLines) {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try {
            baos.write(new byte[]{0x1B, 0x40});
            for (int i = 0; i < commands.length(); i++) {
                JSONObject cmd = commands.optJSONObject(i);
                if (cmd == null) continue;
                String type = cmd.optString("type", "").toLowerCase();
                if (type.equals("text") || type.equals("line")) {
                    String text = cmd.optString("text", cmd.optString("value", ""));
                    if (!text.isEmpty()) baos.write((text + "\n").getBytes("UTF-8"));
                }
            }
            baos.write(new byte[]{0x1B, 0x64, (byte) feedLines});
            baos.write(new byte[]{0x1D, 0x56, 0x01});
        } catch (Exception e) {
            Log.e(TAG, "buildFromCommands error: " + e.getMessage());
        }
        return baos.toByteArray();
    }

    // ---------- PNG → GS v 0 raster ----------

    byte[] pngBytesToGsV0Raster(byte[] pngBytes, int maxWidthDots) throws Exception {
        Bitmap bmp = BitmapFactory.decodeByteArray(pngBytes, 0, pngBytes.length);
        if (bmp == null) throw new Exception("PNG decode failed");

        try {
            int[] pixels = new int[bmp.getWidth() * bmp.getHeight()];
            bmp.getPixels(pixels, 0, bmp.getWidth(), 0, 0, bmp.getWidth(), bmp.getHeight());

            // 1) Crop near-white margins (fixes html2canvas padding)
            int w = bmp.getWidth();
            int h = bmp.getHeight();
            int[] bbox = findContentBBox(pixels, w, h);
            int x0 = bbox[0], y0 = bbox[1], x1 = bbox[2], y1 = bbox[3];
            if (x1 <= x0 || y1 <= y0) { x0 = 0; y0 = 0; x1 = w; y1 = h; }
            // 2 px padding, clamped
            x0 = Math.max(0, x0 - 2); y0 = Math.max(0, y0 - 2);
            x1 = Math.min(w, x1 + 2); y1 = Math.min(h, y1 + 2);
            int cw = x1 - x0;
            int ch = y1 - y0;

            // 2) Scale toward maxWidthDots, cap upscale 2.5x
            int targetW = maxWidthDots;
            // Don't upscale more than 2.5x
            int maxAllowedW = (cw * MAX_UPSCALE_PCT) / 100;
            if (targetW > maxAllowedW) targetW = maxAllowedW;
            if (targetW < 1) targetW = cw;
            int targetH = Math.max(1, (int) Math.round((double) ch * targetW / cw));

            // Build grayscale with nearest-neighbor sampling into target grid
            int[] gray = new int[targetW * targetH];
            for (int y = 0; y < targetH; y++) {
                int srcY = y0 + (int) ((long) y * ch / targetH);
                if (srcY >= h) srcY = h - 1;
                int srcRow = srcY * w;
                int dstRow = y * targetW;
                for (int x = 0; x < targetW; x++) {
                    int srcX = x0 + (int) ((long) x * cw / targetW);
                    if (srcX >= w) srcX = w - 1;
                    int argb = pixels[srcRow + srcX];
                    int a = (argb >>> 24) & 0xFF;
                    int r = (argb >>> 16) & 0xFF;
                    int g = (argb >>> 8) & 0xFF;
                    int b = argb & 0xFF;
                    // Composite on white for transparency
                    if (a < 255) {
                        int inv = 255 - a;
                        r = (r * a + 255 * inv) / 255;
                        g = (g * a + 255 * inv) / 255;
                        b = (b * a + 255 * inv) / 255;
                    }
                    // ITU-R BT.601 luma
                    int l = (299 * r + 587 * g + 114 * b) / 1000;
                    gray[dstRow + x] = l;
                }
            }

            // 3) Floyd–Steinberg dither in-place
            floydSteinberg(gray, targetW, targetH);

            // 4) Pack bits (MSB = leftmost, 1 = black)
            int widthBytes = (targetW + 7) / 8;
            byte[] row = new byte[widthBytes * targetH];
            for (int y = 0; y < targetH; y++) {
                int gRow = y * targetW;
                int bRow = y * widthBytes;
                for (int x = 0; x < targetW; x++) {
                    if (gray[gRow + x] < 128) {
                        row[bRow + (x >> 3)] |= (byte) (0x80 >> (x & 7));
                    }
                }
            }

            // 5) Wrap in GS v 0
            ByteArrayOutputStream out = new ByteArrayOutputStream(8 + row.length);
            out.write(new byte[]{0x1D, 0x76, 0x30, 0x00});
            out.write(widthBytes & 0xFF);
            out.write((widthBytes >> 8) & 0xFF);
            out.write(targetH & 0xFF);
            out.write((targetH >> 8) & 0xFF);
            out.write(row);
            return out.toByteArray();
        } finally {
            bmp.recycle();
        }
    }

    private int[] findContentBBox(int[] pixels, int w, int h) {
        int minX = w, minY = h, maxX = -1, maxY = -1;
        for (int y = 0; y < h; y++) {
            int row = y * w;
            for (int x = 0; x < w; x++) {
                int argb = pixels[row + x];
                int a = (argb >>> 24) & 0xFF;
                if (a <= 10) continue;
                int r = (argb >>> 16) & 0xFF;
                int g = (argb >>> 8) & 0xFF;
                int b = argb & 0xFF;
                int l = (299 * r + 587 * g + 114 * b) / 1000;
                if (l < CROP_WHITE_LUMA) {
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) return new int[]{0, 0, w, h};
        return new int[]{minX, minY, maxX + 1, maxY + 1};
    }

    private void floydSteinberg(int[] gray, int w, int h) {
        for (int y = 0; y < h; y++) {
            int row = y * w;
            boolean notLast = y + 1 < h;
            int nextRow = row + w;
            for (int x = 0; x < w; x++) {
                int old = gray[row + x];
                if (old < 0) old = 0; else if (old > 255) old = 255;
                int nw = old < 128 ? 0 : 255;
                int err = old - nw;
                gray[row + x] = nw;
                if (x + 1 < w) gray[row + x + 1] += err * 7 / 16;
                if (notLast) {
                    if (x > 0) gray[nextRow + x - 1] += err * 3 / 16;
                    gray[nextRow + x] += err * 5 / 16;
                    if (x + 1 < w) gray[nextRow + x + 1] += err * 1 / 16;
                }
            }
        }
    }

    // ---------- TCP transport ----------

    private void sendJobOverTcp(String host, int port, byte[] data) throws Exception {
        Socket socket = new Socket();
        try {
            socket.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
            OutputStream out = socket.getOutputStream();
            int offset = 0;
            while (offset < data.length) {
                int n = Math.min(WRITE_CHUNK, data.length - offset);
                out.write(data, offset, n);
                offset += n;
            }
            out.flush();
            Thread.sleep(POST_WRITE_DELAY_MS);
        } finally {
            try { socket.close(); } catch (Exception ignored) {}
        }
    }

    // ---------- Result dispatch ----------

    private void sendPrintResult(String requestId, boolean success, String error) {
        try {
            JSONObject detail = new JSONObject();
            if (requestId != null) detail.put("requestId", requestId);
            detail.put("success", success);
            if (error != null) detail.put("error", error);
            dispatchCustomEvent("zat-android-print-result", detail);
        } catch (Exception e) {
            Log.e(TAG, "sendPrintResult error: " + e.getMessage());
        }
    }

    private void dispatchCustomEvent(String eventName, JSONObject detail) {
        String js = "window.dispatchEvent(new CustomEvent(" +
                JSONObject.quote(eventName) + ", { detail: " + detail.toString() + " }))";
        android.app.Activity act = bridge.getActivity();
        if (act != null) {
            act.runOnUiThread(() -> bridge.getWebView().evaluateJavascript(js, null));
        }
    }
}
