package com.zatpos.app;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Base64;
import android.util.Log;
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

    public BluetoothPrinterManager(Context context, Bridge bridge) {
        this.context = context;
        this.bridge = bridge;
    }

    public void sendPairedDevices(String requestId) {
        new Thread(() -> {
            try {
                JSONArray devices = new JSONArray();
                BluetoothAdapter adapter = getBluetoothAdapter();
                if (adapter != null && hasConnectPermission()) {
                    for (BluetoothDevice device : adapter.getBondedDevices()) {
                        JSONObject d = new JSONObject();
                        d.put("name", device.getName() != null ? device.getName() : "Unknown");
                        d.put("address", device.getAddress());
                        devices.put(d);
                    }
                }
                JSONObject detail = new JSONObject();
                detail.put("devices", devices);
                if (requestId != null) detail.put("requestId", requestId);
                dispatchCustomEvent("zat-android-bluetooth-devices", detail);
            } catch (Exception e) {
                Log.e(TAG, "sendPairedDevices error: " + e.getMessage());
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

        BluetoothSocket socket = null;
        try {
            BluetoothDevice device = adapter.getRemoteDevice(address);
            socket = device.createRfcommSocketToServiceRecord(SPP_UUID);
            adapter.cancelDiscovery();
            socket.connect();

            OutputStream out = socket.getOutputStream();
            int offset = 0;
            while (offset < data.length) {
                int chunk = Math.min(16384, data.length - offset);
                out.write(data, offset, chunk);
                offset += chunk;
            }
            out.flush();
            Thread.sleep(200);

            sendPrintResult(requestId, true, null);
        } catch (Exception e) {
            Log.e(TAG, "sendBytesToPrinter error: " + e.getMessage());
            sendPrintResult(requestId, false, "Bluetooth send error: " + e.getMessage());
        } finally {
            if (socket != null) {
                try { socket.close(); } catch (Exception ignored) {}
            }
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
