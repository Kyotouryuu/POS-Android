package com.zatpos.app;

import android.content.Context;
import android.content.Intent;
import android.webkit.JavascriptInterface;
import androidx.core.content.FileProvider;
import com.getcapacitor.Bridge;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class ReactNativeWebViewBridge {
    private final Context context;
    private final BluetoothPrinterManager btManager;
    private final SunmiPrinterManager sunmiManager;
    private final Bridge bridge;

    public ReactNativeWebViewBridge(Context context, Bridge bridge) {
        this.context = context;
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
                case "download_and_install_apk":
                    String url = msg.optString("url", "");
                    String apiKey = msg.optString("apiKey", "");
                    if (!url.isEmpty()) {
                        downloadAndInstallApk(url, apiKey);
                    }
                    break;
            }
        } catch (Exception e) {
            android.util.Log.e("ZatPOS", "Bridge message error: " + e.getMessage());
        }
    }

    private void downloadAndInstallApk(String urlStr, String apiKey) {
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(urlStr);
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(60000);
                if (apiKey != null && !apiKey.isEmpty()) {
                    conn.setRequestProperty("Authorization", "Bearer " + apiKey);
                }
                conn.connect();

                int fileLength = conn.getContentLength();
                File apkFile = new File(context.getCacheDir(), "zat_update.apk");

                try (InputStream input = conn.getInputStream();
                     FileOutputStream output = new FileOutputStream(apkFile)) {
                    byte[] buffer = new byte[8192];
                    int bytesRead;
                    long totalRead = 0;
                    int lastReported = -1;

                    while ((bytesRead = input.read(buffer)) != -1) {
                        output.write(buffer, 0, bytesRead);
                        totalRead += bytesRead;
                        if (fileLength > 0) {
                            int progress = (int) (totalRead * 100L / fileLength);
                            if (progress != lastReported) {
                                lastReported = progress;
                                dispatchProgressEvent(progress);
                            }
                        }
                    }
                }

                dispatchInstallingEvent();
                triggerInstall(apkFile);

            } catch (Exception e) {
                android.util.Log.e("ZatPOS", "APK download error: " + e.getMessage());
                dispatchErrorEvent(e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    private void dispatchProgressEvent(int progress) {
        evaluateJs("window.dispatchEvent(new CustomEvent('apk-download-progress',{detail:{progress:" + progress + "}}))");
    }

    private void dispatchInstallingEvent() {
        evaluateJs("window.dispatchEvent(new CustomEvent('apk-download-progress',{detail:{installing:true}}))");
    }

    private void dispatchErrorEvent(String message) {
        try {
            String escaped = new JSONObject().put("m", message).getString("m")
                    .replace("\\", "\\\\").replace("'", "\\'");
            evaluateJs("window.dispatchEvent(new CustomEvent('apk-download-progress',{detail:{error:'" + escaped + "'}}))");
        } catch (Exception ignored) {
            evaluateJs("window.dispatchEvent(new CustomEvent('apk-download-progress',{detail:{error:'Download failed'}}))");
        }
    }

    private void evaluateJs(String js) {
        android.app.Activity act = bridge.getActivity();
        if (act != null) {
            act.runOnUiThread(() -> bridge.getWebView().evaluateJavascript(js, null));
        }
    }

    private void triggerInstall(File apkFile) {
        android.app.Activity act = bridge.getActivity();
        if (act == null) return;
        act.runOnUiThread(() -> {
            try {
                android.net.Uri apkUri = FileProvider.getUriForFile(
                        act,
                        act.getPackageName() + ".fileprovider",
                        apkFile
                );
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                act.startActivity(intent);
            } catch (Exception e) {
                android.util.Log.e("ZatPOS", "Install intent error: " + e.getMessage());
                dispatchErrorEvent("Could not launch installer");
            }
        });
    }
}
