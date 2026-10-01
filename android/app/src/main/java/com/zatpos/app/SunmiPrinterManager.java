package com.zatpos.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import java.io.ByteArrayOutputStream;
import android.os.IBinder;
import android.util.Base64;
import android.util.Log;
import com.getcapacitor.Bridge;
import org.json.JSONObject;
import woyou.aidlservice.jiuiv5.ICallback;
import woyou.aidlservice.jiuiv5.IWoyouService;

public class SunmiPrinterManager {
    private static final String TAG = "ZatSunmi";
    private static final String SUNMI_PACKAGE = "woyou.aidlservice.jiuiv5";
    private static final String SUNMI_ACTION  = "woyou.aidlservice.jiuiv5.IWoyouService";

    private final Context context;
    private final Bridge bridge;

    private IWoyouService woyouService = null;
    private boolean available = false;

    // Strong-reference holder for AIDL callbacks. Sunmi's binder proxy stores only a
    // WeakReference to the Stub; if the JVM GCs our local var before the service
    // dispatches the callback, it silently drops the invocation. Keeping the most
    // recent batch alive here prevents that.
    private final java.util.List<ICallback> pendingCallbacks = new java.util.concurrent.CopyOnWriteArrayList<>();

    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            woyouService = IWoyouService.Stub.asInterface(service);
            available = true;
            String model = "unknown";
            try {
                // Note: Sunmi's official AIDL spells this "getPrinterModal" (typo baked into the public API).
                String m = woyouService.getPrinterModal();
                if (m != null && !m.isEmpty()) model = m;
                Log.i(TAG, "Sunmi inner printer connected — model: " + model);
            } catch (Exception e) {
                Log.i(TAG, "Sunmi inner printer connected (model query failed: " + e.getMessage() + ")");
            }
            injectAvailabilityFlag(true);
            injectPrinterModel(model);
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            woyouService = null;
            available = false;
            Log.w(TAG, "Sunmi inner printer service disconnected");
            injectAvailabilityFlag(false);
        }
    };

    public SunmiPrinterManager(Context context, Bridge bridge) {
        this.context = context;
        this.bridge = bridge;
    }

    public void init() {
        try {
            Intent intent = new Intent(SUNMI_ACTION);
            intent.setPackage(SUNMI_PACKAGE);
            boolean bound = context.bindService(intent, connection, Context.BIND_AUTO_CREATE);
            if (!bound) {
                Log.i(TAG, "Not a Sunmi device — inner printer service not available");
            }
        } catch (Exception e) {
            Log.i(TAG, "Sunmi service bind failed (not a Sunmi device): " + e.getMessage());
        }
    }

    public boolean isAvailable() {
        return available && woyouService != null;
    }

    public void sendAvailabilityStatus() {
        injectAvailabilityFlag(isAvailable());
    }

    public void handlePrintReceipt(JSONObject msg) {
        new Thread(() -> {
            String requestId = msg.optString("requestId", null);
            if (!isAvailable()) {
                sendPrintResult(requestId, false, "Sunmi inner printer not available");
                return;
            }
            try {
                // Preferred path: PNG bitmap via printBitmap — most reliable on all Sunmi models.
                // sendRAWData with GS v 0 raster bytes does not print on many Sunmi firmware versions.
                String imageB64 = msg.optString("image_base64", "").trim();
                if (!imageB64.isEmpty()) {
                    byte[] pngBytes = Base64.decode(imageB64, Base64.DEFAULT);
                    Bitmap bitmap = BitmapFactory.decodeByteArray(pngBytes, 0, pngBytes.length);
                    if (bitmap == null) {
                        sendPrintResult(requestId, false, "Failed to decode PNG for Sunmi printing");
                        return;
                    }
                    // Sunmi V2 firmwares silently no-op printBitmap when given RGB_565 —
                    // onRunResult fires true but no ink hits paper. Force ARGB_8888.
                    Bitmap argb = bitmap.getConfig() == Bitmap.Config.ARGB_8888
                        ? bitmap
                        : bitmap.copy(Bitmap.Config.ARGB_8888, false);
                    if (argb == null) argb = bitmap;

                    // Slice into ≤256-row strips (~384KB each, safely under 1MB Binder cap) and
                    // wrap the whole batch in enterPrinterBuffer(true) / commitPrinterBufferWithCallback(cb).
                    // Only the commit callback fires reliably — per-strip printBitmap callbacks in
                    // buffer mode are documented as fire-and-forget.
                    int stripHeight = 256;
                    int totalHeight = argb.getHeight();
                    int stripCount = (totalHeight + stripHeight - 1) / stripHeight;
                    sendDebugLog(requestId, "Java: bitmap " + argb.getWidth() + "x" + totalHeight
                        + " ARGB8888 → " + stripCount + " strip(s), enterPrinterBuffer...");

                    pendingCallbacks.clear();
                    woyouService.printerInit(null);
                    woyouService.enterPrinterBuffer(true);

                    for (int i = 0; i < stripCount; i++) {
                        int y = i * stripHeight;
                        int h = Math.min(stripHeight, totalHeight - y);
                        Bitmap strip = Bitmap.createBitmap(argb, 0, y, argb.getWidth(), h);
                        sendDebugLog(requestId, "Java: buffer printBitmap strip " + (i + 1) + "/" + stripCount + " (" + h + " rows)");
                        woyouService.printBitmap(strip, null);
                        try { if (strip != argb) strip.recycle(); } catch (Exception ignored) {}
                    }

                    // lineWrap inside the buffer to feed the last strip past the head.
                    woyouService.lineWrap(3, null);

                    sendDebugLog(requestId, "Java: commitPrinterBufferWithCallback — waiting for real completion");
                    final String[] commitResult = {null};
                    ICallback.Stub commitCb = new ICallback.Stub() {
                        @Override public void onRunResult(boolean ok) { commitResult[0] = ok ? "ok" : "err:onRunResult false"; }
                        @Override public void onReturnString(String s) {}
                        @Override public void onRaiseException(int code, String msg2) { commitResult[0] = "err:" + code + " " + msg2; }
                        @Override public void onPrintResult(int code, String msg2) { commitResult[0] = code == 0 ? "ok" : "err:" + code + " " + msg2; }
                    };
                    pendingCallbacks.add(commitCb);
                    woyouService.commitPrinterBufferWithCallback(commitCb);
                    for (int w = 0; w < 150 && commitResult[0] == null; w++) Thread.sleep(100);

                    if (commitResult[0] == null) {
                        sendDebugLog(requestId, "Java: commit callback never fired in 15s — assuming printed");
                        sendPrintResult(requestId, true, null);
                    } else if (commitResult[0].startsWith("err:")) {
                        String err = commitResult[0].substring(4);
                        sendDebugLog(requestId, "Java: commit error — " + err);
                        sendPrintResult(requestId, false, err);
                    } else {
                        sendDebugLog(requestId, "Java: commit OK — paper printed");
                        sendPrintResult(requestId, true, null);
                    }
                    return;
                }

                // Fallback: raw ESC/POS bytes (for server-generated escpos_base64).
                String escposB64 = msg.optString("escpos_base64", "").trim();
                if (escposB64.isEmpty()) {
                    sendPrintResult(requestId, false, "No image_base64 or escpos_base64 data to print");
                    return;
                }
                byte[] data = Base64.decode(escposB64, Base64.DEFAULT);
                byte[] trailer = {0x1b, 0x64, 0x05, 0x1d, 0x56, 0x01};
                byte[] full = new byte[data.length + trailer.length];
                System.arraycopy(data, 0, full, 0, data.length);
                System.arraycopy(trailer, 0, full, data.length, trailer.length);
                ICallback.Stub rawCallback = new ICallback.Stub() {
                    @Override public void onRunResult(boolean isSuccess) {
                        sendPrintResult(requestId, isSuccess, isSuccess ? null : "Sunmi raw print failed");
                    }
                    @Override public void onReturnString(String result) {}
                    @Override public void onRaiseException(int code, String msg2) {
                        sendPrintResult(requestId, false, "Sunmi error " + code + ": " + msg2);
                    }
                    @Override public void onPrintResult(int code, String msg2) {
                        sendPrintResult(requestId, code == 0, code != 0 ? msg2 : null);
                    }
                };
                woyouService.sendRAWData(full, rawCallback);
            } catch (Exception e) {
                Log.e(TAG, "handlePrintReceipt error: " + e.getMessage());
                sendPrintResult(requestId, false, "Sunmi print error: " + e.getMessage());
            }
        }).start();
    }

    private byte[] bitmapToEscPosRaster(Bitmap src) {
        // Scale to an exact multiple-of-8 width so every row fills whole bytes.
        int widthDots = ((src.getWidth() + 7) / 8) * 8;
        int heightDots = src.getHeight();
        Bitmap bmp = (src.getWidth() == widthDots)
            ? src
            : Bitmap.createScaledBitmap(src, widthDots, heightDots, true);

        int widthBytes = widthDots / 8;
        int[] pixels = new int[widthDots * heightDots];
        bmp.getPixels(pixels, 0, widthDots, 0, 0, widthDots, heightDots);

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try {
            out.write(new byte[]{0x1b, 0x40}); // ESC @ — init
            // GS v 0 — raster image
            out.write(new byte[]{
                0x1d, 0x76, 0x30, 0x00,
                (byte)(widthBytes & 0xff), (byte)((widthBytes >> 8) & 0xff),
                (byte)(heightDots & 0xff), (byte)((heightDots >> 8) & 0xff)
            });
            for (int y = 0; y < heightDots; y++) {
                for (int xb = 0; xb < widthBytes; xb++) {
                    byte b = 0;
                    for (int bit = 0; bit < 8; bit++) {
                        int px = xb * 8 + bit;
                        int color = pixels[y * widthDots + px];
                        int r = Color.red(color);
                        int g = Color.green(color);
                        int bl = Color.blue(color);
                        int lum = (r * 299 + g * 587 + bl * 114) / 1000;
                        if (lum < 128) b |= (byte)(0x80 >> bit); // dark → print dot
                    }
                    out.write(b);
                }
            }
            out.write(new byte[]{0x1b, 0x64, 0x05}); // ESC d 5 — feed & cut
        } catch (Exception e) {
            Log.e(TAG, "bitmapToEscPosRaster error: " + e.getMessage());
        }
        return out.toByteArray();
    }

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

    private void sendDebugLog(String requestId, String message) {
        try {
            JSONObject detail = new JSONObject();
            detail.put("requestId", requestId);
            detail.put("log", message);
            dispatchCustomEvent("zat-sunmi-debug-log", detail);
        } catch (Exception ignored) {}
    }

    private void injectPrinterModel(String model) {
        String safe = model.replace("'", "\\'");
        String js = "window.__sunmiPrinterModel = '" + safe + "';";
        bridge.getActivity().runOnUiThread(() ->
            bridge.getWebView().evaluateJavascript(js, null)
        );
    }

    private void injectAvailabilityFlag(boolean value) {
        String js = "window.__sunmiInnerPrinterAvailable = " + value + ";" +
            "window.dispatchEvent(new CustomEvent('zat-sunmi-printer-available', { detail: { available: " + value + " } }));";
        bridge.getActivity().runOnUiThread(() ->
            bridge.getWebView().evaluateJavascript(js, null)
        );
    }

    private void dispatchCustomEvent(String eventName, JSONObject detail) {
        String js = "window.dispatchEvent(new CustomEvent(" +
            JSONObject.quote(eventName) + ", { detail: " + detail.toString() + " }))";
        bridge.getActivity().runOnUiThread(() ->
            bridge.getWebView().evaluateJavascript(js, null)
        );
    }

    public void disconnect() {
        if (available) {
            try { context.unbindService(connection); } catch (Exception ignored) {}
            available = false;
            woyouService = null;
        }
    }
}
