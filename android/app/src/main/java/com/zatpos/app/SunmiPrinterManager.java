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

    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            woyouService = IWoyouService.Stub.asInterface(service);
            available = true;
            String model = "unknown";
            try {
                String m = woyouService.getPrinterModel();
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
                    // Convert to RGB_565 — halves the Binder payload (~0.8MB vs 1.6MB for ARGB_8888).
                    Bitmap rgb = bitmap.copy(Bitmap.Config.RGB_565, false);
                    if (rgb == null) rgb = bitmap;
                    sendDebugLog(requestId, "Java: bitmap " + rgb.getWidth() + "x" + rgb.getHeight()
                        + " RGB565, calling printerInit...");
                    woyouService.printerInit(null);
                    sendDebugLog(requestId, "Java: calling printBitmap...");
                    final Bitmap finalBmp = rgb;
                    final String[] cbResult = {null}; // null = pending, "ok" or "err:..." after callback
                    ICallback.Stub cb = new ICallback.Stub() {
                        @Override public void onRunResult(boolean ok) { cbResult[0] = ok ? "ok" : "err:onRunResult false"; }
                        @Override public void onReturnString(String s) {}
                        @Override public void onRaiseException(int code, String msg2) { cbResult[0] = "err:" + code + " " + msg2; }
                        @Override public void onPrintResult(int code, String msg2) { cbResult[0] = code == 0 ? "ok" : "err:" + code + " " + msg2; }
                    };
                    woyouService.printBitmap(finalBmp, cb);
                    // Wait up to 8s for the callback, then treat as success (many Sunmi firmwares never call it).
                    for (int i = 0; i < 80 && cbResult[0] == null; i++) {
                        Thread.sleep(100);
                    }
                    if (cbResult[0] == null) {
                        sendDebugLog(requestId, "Java: callback never fired — feeding paper anyway");
                        woyouService.sendRAWData(new byte[]{0x1b, 0x64, 0x05}, null);
                        sendPrintResult(requestId, true, null);
                    } else if (cbResult[0].startsWith("err:")) {
                        sendDebugLog(requestId, "Java: callback error — " + cbResult[0]);
                        sendPrintResult(requestId, false, cbResult[0].substring(4));
                    } else {
                        sendDebugLog(requestId, "Java: callback OK");
                        woyouService.sendRAWData(new byte[]{0x1b, 0x64, 0x05}, null);
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
