package com.zatpos.app;

import android.content.Context;
import android.webkit.JavascriptInterface;
import com.getcapacitor.Bridge;
import org.json.JSONObject;

public class ReactNativeWebViewBridge {
    private final BluetoothPrinterManager btManager;
    private final SunmiPrinterManager sunmiManager;

    public ReactNativeWebViewBridge(Context context, Bridge bridge) {
        this.btManager = new BluetoothPrinterManager(context, bridge);
        this.sunmiManager = new SunmiPrinterManager(context, bridge);
        sunmiManager.init();
    }

    @JavascriptInterface
    public void postMessage(String jsonStr) {
        try {
            JSONObject msg = new JSONObject(jsonStr);
            String type = msg.optString("type", "");
            switch (type) {
                case "bluetooth_print_receipt":
                    btManager.handlePrintReceipt(msg);
                    break;
                case "sunmi_inner_print_receipt":
                    sunmiManager.handlePrintReceipt(msg);
                    break;
                case "get_bluetooth_printers":
                case "request_bluetooth_scan":
                    btManager.sendPairedDevices(msg.optString("requestId", null));
                    break;
            }
        } catch (Exception e) {
            android.util.Log.e("ZatPOS", "Bridge message error: " + e.getMessage());
        }
    }
}
