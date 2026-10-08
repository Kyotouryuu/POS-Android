package com.zatpos.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private ReactNativeWebViewBridge webViewBridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) {
            WebSettingsCompat.setForceDark(webView.getSettings(), WebSettingsCompat.FORCE_DARK_OFF);
        }
        webViewBridge = new ReactNativeWebViewBridge(this, getBridge());
        webView.addJavascriptInterface(webViewBridge, "ReactNativeWebView");
        // Permissions are requested lazily when the user taps Scan,
        // so we don't fire a dialog before the app is even visible.
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == ReactNativeWebViewBridge.BT_PERMISSIONS_REQUEST) {
            for (int i = 0; i < permissions.length; i++) {
                if (Manifest.permission.BLUETOOTH_CONNECT.equals(permissions[i])
                        && grantResults[i] == PackageManager.PERMISSION_GRANTED) {
                    webViewBridge.onBluetoothPermissionGranted();
                    break;
                }
            }
        }
    }
}
