package com.zatpos.app;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Base64;
import android.util.Log;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Bridge;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.util.UUID;

public class BluetoothPrinterManager {
    private static final String TAG = "ZatBluetooth";
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    private final Context context;
    private final Bridge bridge;
    private String pendingScanRequestId = null;

    public BluetoothPrinterManager(Context context, Bridge bridge) {
        this.context = context;
        this.bridge = bridge;
    }

    /**
     * Called when the user taps Scan. Checks permission first — if missing,
     * requests it from the Activity and stores the requestId for after the grant.
     * If already granted, scans immediately.
     */
    public void requestScan(Activity activity, String requestId, int permissionRequestCode) {
        boolean hasPermission = hasConnectPermission();
        boolean needsRuntime = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S;
        boolean canShowDialog = !needsRuntime || ActivityCompat.shouldShowRequestPermissionRationale(
                activity, Manifest.permission.BLUETOOTH_CONNECT);

        // Fire an ack immediately so the JS overlay can see what Java observed
        sendScanAck(requestId, hasPermission, canShowDialog || !needsRuntime);

        if (hasPermission) {
            sendPairedDevices(requestId);
        } else if (needsRuntime) {
            pendingScanRequestId = requestId;
            ActivityCompat.requestPermissions(activity, new String[]{
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.BLUETOOTH_SCAN
            }, permissionRequestCode);
        } else {
            sendPairedDevices(requestId);
        }
    }

    private void sendScanAck(String requestId, boolean permissionGranted, boolean canRequest) {
        try {
            JSONObject detail = new JSONObject();
            if (requestId != null) detail.put("requestId", requestId);
            detail.put("permission_granted", permissionGranted);
            detail.put("can_request_permission", canRequest);
            detail.put("sdk_int", Build.VERSION.SDK_INT);
            dispatchCustomEvent("zat-android-bt-scan-ack", detail);
        } catch (Exception e) {
            Log.e(TAG, "sendScanAck error: " + e.getMessage());
        }
    }

    /** Called by MainActivity after BLUETOOTH_CONNECT is granted. */
    public void onPermissionGranted() {
        String rid = pendingScanRequestId;
        pendingScanRequestId = null;
        sendPairedDevices(rid);
    }

    private void dispatchBtScanLog(String msg) {
        try {
            JSONObject d = new JSONObject();
            d.put("msg", msg);
            dispatchCustomEvent("zat-android-bt-scan-log", d);
        } catch (Exception ignored) {}
    }

    public void sendPairedDevices(String requestId) {
        new Thread(() -> {
            try {
                dispatchBtScanLog("thread started");
                boolean hasPermission = hasConnectPermission();
                dispatchBtScanLog("permission: " + hasPermission);
                BluetoothAdapter adapter = getBluetoothAdapter();
                dispatchBtScanLog("adapter: " + (adapter == null ? "NULL" : "ok"));
                boolean btEnabled = adapter != null && adapter.isEnabled();
                dispatchBtScanLog("bt enabled: " + btEnabled);
                JSONArray devices = new JSONArray();
                if (adapter != null && hasPermission) {
                    dispatchBtScanLog("calling getBondedDevices...");
                    java.util.Set<BluetoothDevice> bonded = adapter.getBondedDevices();
                    dispatchBtScanLog("bonded set: " + (bonded == null ? "NULL" : bonded.size() + " devices"));
                    if (bonded != null) {
                        for (BluetoothDevice device : bonded) {
                            String name;
                            try { name = device.getName(); } catch (Exception e2) { name = "err:" + e2.getMessage(); }
                            String addr;
                            try { addr = device.getAddress(); } catch (Exception e2) { addr = "err:" + e2.getMessage(); }
                            int majorClass = BluetoothClass.Device.Major.UNCATEGORIZED;
                            try {
                                BluetoothClass btClass = device.getBluetoothClass();
                                if (btClass != null) majorClass = btClass.getMajorDeviceClass();
                            } catch (Exception ignored) {}
                            // Keep IMAGING (printers/scanners) and UNCATEGORIZED (cheap thermal printers)
                            boolean isPrinter = (majorClass == BluetoothClass.Device.Major.IMAGING
                                || majorClass == BluetoothClass.Device.Major.UNCATEGORIZED);
                            dispatchBtScanLog("device: " + name + " / " + addr + " class=" + majorClass + (isPrinter ? " [PRINTER]" : " [SKIP]"));
                            if (!isPrinter) continue;
                            JSONObject d = new JSONObject();
                            d.put("name", name != null ? name : "Unknown");
                            d.put("address", addr != null ? addr : "");
                            devices.put(d);
                        }
                    }
                }
                JSONObject detail = new JSONObject();
                detail.put("devices", devices);
                detail.put("permission_granted", hasPermission);
                detail.put("bluetooth_enabled", btEnabled);
                if (requestId != null) detail.put("requestId", requestId);
                dispatchBtScanLog("dispatching " + devices.length() + " device(s)...");
                dispatchDevicesDirectly(detail);
            } catch (Exception e) {
                Log.e(TAG, "sendPairedDevices error: " + e.getMessage());
                dispatchBtScanLog("EXCEPTION: " + e.getClass().getSimpleName() + ": " + e.getMessage());
                try {
                    JSONObject err = new JSONObject();
                    err.put("devices", new JSONArray());
                    err.put("permission_granted", false);
                    err.put("bluetooth_enabled", false);
                    err.put("error", e.getMessage());
                    if (requestId != null) err.put("requestId", requestId);
                    dispatchDevicesDirectly(err);
                } catch (Exception ignored) {}
            }
        }).start();
    }

    public void handlePrintReceipt(JSONObject msg) {
        new Thread(() -> {
            String requestId = msg.optString("requestId", null);
            String address = msg.optString("address", msg.optString("bluetooth_printer_mac", "")).trim();

            if (address.isEmpty()) {
                sendPrintResult(requestId, false, "Bluetooth MAC address is missing");
                return;
            }
            if (!hasConnectPermission()) {
                sendPrintResult(requestId, false, "BLUETOOTH_CONNECT permission not granted");
                return;
            }

            try {
                byte[] printBytes = resolvePrintBytes(msg);
                if (printBytes == null || printBytes.length == 0) {
                    sendPrintResult(requestId, false, "No printable data (escpos_base64 or commands required)");
                    return;
                }
                sendBytesToPrinter(address, printBytes, requestId);
            } catch (Exception e) {
                Log.e(TAG, "handlePrintReceipt error: " + e.getMessage());
                sendPrintResult(requestId, false, "Print error: " + e.getMessage());
            }
        }).start();
    }

    private byte[] resolvePrintBytes(JSONObject msg) throws Exception {
        // Priority 1: escpos_base64 — full ESC/POS document already rendered by JS (preferred)
        String escposB64 = msg.optString("escpos_base64", "").trim();
        if (!escposB64.isEmpty()) {
            return Base64.decode(escposB64, Base64.DEFAULT);
        }

        // Priority 2: JSON commands array → minimal ESC/POS
        JSONArray commands = msg.optJSONArray("commands");
        if (commands != null && commands.length() > 0) {
            return buildFromCommands(commands);
        }

        return null;
    }

    private void sendBytesToPrinter(String address, byte[] data, String requestId) {
        BluetoothAdapter adapter = getBluetoothAdapter();
        if (adapter == null) {
            sendPrintResult(requestId, false, "Bluetooth not supported on this device");
            return;
        }

        BluetoothDevice device;
        try {
            device = adapter.getRemoteDevice(address);
        } catch (Exception e) {
            sendPrintResult(requestId, false, "Invalid Bluetooth address: " + address);
            return;
        }

        try { adapter.cancelDiscovery(); } catch (Exception ignored) {}

        // Try secure RFCOMM first; many cheap thermal printers don't implement secure
        // pairing properly, so fall back to insecure if the first attempt fails.
        BluetoothSocket socket = null;
        Exception lastError = null;
        for (boolean insecure : new boolean[]{false, true}) {
            try {
                socket = insecure
                    ? device.createInsecureRfcommSocketToServiceRecord(SPP_UUID)
                    : device.createRfcommSocketToServiceRecord(SPP_UUID);
                connectWithTimeout(socket, 10000);
                lastError = null;
                break;
            } catch (Exception e) {
                Log.w(TAG, (insecure ? "Insecure" : "Secure") + " RFCOMM failed: " + e.getMessage());
                lastError = e;
                if (socket != null) { try { socket.close(); } catch (Exception ignored) {} socket = null; }
            }
        }

        if (lastError != null) {
            sendPrintResult(requestId, false, "Bluetooth connection failed: " + lastError.getMessage());
            return;
        }

        try {
            OutputStream out = socket.getOutputStream();
            // Feed 4 lines then partial cut so the receipt tears cleanly.
            byte[] cut = {0x1b, 0x64, 0x04, 0x1d, 0x56, 0x01};
            byte[] full = new byte[data.length + cut.length];
            System.arraycopy(data, 0, full, 0, data.length);
            System.arraycopy(cut, 0, full, data.length, cut.length);
            out.write(full);
            out.flush();
            Thread.sleep(200);
            sendPrintResult(requestId, true, null);
        } catch (Exception e) {
            Log.e(TAG, "sendBytesToPrinter write error: " + e.getMessage());
            sendPrintResult(requestId, false, "Bluetooth write error: " + e.getMessage());
        } finally {
            if (socket != null) { try { socket.close(); } catch (Exception ignored) {} }
        }
    }

    private void connectWithTimeout(BluetoothSocket socket, long timeoutMs) throws Exception {
        final boolean[] connected = {false};
        final Exception[] error = {null};
        Thread t = new Thread(() -> {
            try { socket.connect(); connected[0] = true; }
            catch (Exception e) { error[0] = e; }
        });
        t.start();
        t.join(timeoutMs);
        if (!connected[0]) {
            Exception e = error[0];
            throw new Exception(e != null ? e.getMessage() : "Connection timed out after " + timeoutMs + "ms");
        }
    }

    private byte[] buildFromCommands(JSONArray commands) {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try {
            baos.write(new byte[]{ 0x1b, 0x40 }); // ESC @ init
            for (int i = 0; i < commands.length(); i++) {
                JSONObject cmd = commands.optJSONObject(i);
                if (cmd == null) continue;
                String type = cmd.optString("type", "").toLowerCase();
                if (type.equals("text") || type.equals("line")) {
                    String text = cmd.optString("text", cmd.optString("value", ""));
                    if (!text.isEmpty()) {
                        baos.write((text + "\n").getBytes("UTF-8"));
                    }
                }
            }
            baos.write(new byte[]{ 0x1b, 0x64, 0x05 }); // ESC d 5 line feeds
        } catch (Exception e) {
            Log.e(TAG, "buildFromCommands error: " + e.getMessage());
        }
        return baos.toByteArray();
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

    private void dispatchDevicesDirectly(JSONObject detail) {
        String json = detail.toString();
        // Wrap in try-catch so JS errors surface in the scan debug overlay instead of dying silently.
        String js = "try{" +
            "if(typeof window.__onAndroidBluetoothDevices==='function'){" +
            "window.__onAndroidBluetoothDevices(" + json + ");" +
            "}else{" +
            "window.dispatchEvent(new CustomEvent('zat-android-bluetooth-devices',{detail:" + json + "}));" +
            "document.dispatchEvent(new CustomEvent('zat-android-bluetooth-devices',{detail:" + json + "}));" +
            "}" +
            "}catch(e){" +
            "window.dispatchEvent(new CustomEvent('zat-android-bt-scan-log',{detail:{msg:'JS ERR dispatch: '+e.message}}));" +
            "}";
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

    private boolean hasConnectPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT)
                == PackageManager.PERMISSION_GRANTED;
        }
        return ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH)
            == PackageManager.PERMISSION_GRANTED;
    }

    private BluetoothAdapter getBluetoothAdapter() {
        BluetoothManager bm = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        return bm != null ? bm.getAdapter() : null;
    }
}
