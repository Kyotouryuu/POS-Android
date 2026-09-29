package com.zatpos.app;

import android.content.Context;
import android.webkit.JavascriptInterface;
import com.getcapacitor.Bridge;
import org.json.JSONObject;

public class ReactNativeWebViewBridge {
    private final BluetoothPrinterManager btManager;
    private final SunmiPrinterManager sunmiManager;
    private final Bridge bridge;

    public ReactNativeWebViewBridge(Context context, Bridge bridge) {
        this.bridge = bridge;
        this.btManager = new BluetoothPrinterManager(context, bridge);
        this.sunmiManager = new SunmiPrinterManager(context, bridge);
        sunmiManager.init();
    }

    static final int BT_PERMISSIONS_REQUEST = 1001;

    public void sendPairedBluetoothDevices() {
        btManager.sendPairedDevices(null);
    }

    public void onBluetoothPermissionGranted() {
        btManager.onPermissionGranted();
    }

    @JavascriptInterface
    public void postMessage(String jsonStr) {
        try {
            JSONObject msg = new JSONObject(jsonStr);
            String type = msg.optString("type", "");
            String requestId = msg.optString("requestId", null);
            switch (type) {
                case "bluetooth_print_receipt":
                    btManager.handlePrintReceipt(msg);
                    break;
                case "sunmi_inner_print_receipt":
                    sunmiManager.handlePrintReceipt(msg);
                    break;
                case "get_bluetooth_printers":
                case "request_bluetooth_scan":
                    android.app.Activity act = bridge.getActivity();
                    if (act != null) {
                        act.runOnUiThread(() -> {
                            android.app.Activity a = bridge.getActivity();
                            if (a != null) btManager.requestScan(a, requestId, BT_PERMISSIONS_REQUEST);
                        });
                    }
                    break;
                case "check_sunmi_available":
                    sunmiManager.sendAvailabilityStatus();
                    break;
            }
        } catch (Exception e) {
            android.util.Log.e("ZatPOS", "Bridge message error: " + e.getMessage());
        }
    }
}
