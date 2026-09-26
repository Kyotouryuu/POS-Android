package com.zatpos.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
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
            Log.i(TAG, "Sunmi inner printer service connected");
            injectAvailabilityFlag(true);
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

    public void handlePrintReceipt(JSONObject msg) {
        new Thread(() -> {
            String requestId = msg.optString("requestId", null);
            if (!isAvailable()) {
                sendPrintResult(requestId, false, "Sunmi inner printer not available");
                return;
            }
            try {
                String escposB64 = msg.optString("escpos_base64", "").trim();
                if (escposB64.isEmpty()) {
                    sendPrintResult(requestId, false, "No escpos_base64 data to print");
                    return;
                }
                byte[] data = Base64.decode(escposB64, Base64.DEFAULT);
                woyouService.sendRAWData(data, new ICallback.Stub() {
                    @Override public void onRunResult(boolean isSuccess) {
                        sendPrintResult(requestId, isSuccess, isSuccess ? null : "Sunmi print failed");
                    }
                    @Override public void onReturnString(String result) {}
                    @Override public void onRaiseException(int code, String msg2) {
                        sendPrintResult(requestId, false, "Sunmi error " + code + ": " + msg2);
                    }
                    @Override public void onPrintResult(int code, String msg2) {
                        sendPrintResult(requestId, code == 0, code != 0 ? msg2 : null);
                    }
                });
            } catch (Exception e) {
                Log.e(TAG, "handlePrintReceipt error: " + e.getMessage());
                sendPrintResult(requestId, false, "Sunmi print error: " + e.getMessage());
            }
        }).start();
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

    private void injectAvailabilityFlag(boolean value) {
        String js = "window.__sunmiInnerPrinterAvailable = " + value + ";";
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
