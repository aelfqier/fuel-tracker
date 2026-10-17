package com.fueltracker.app;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FuelNativePlugin.class);
        super.onCreate(savedInstanceState);
        // Same edge-to-edge on every Android version; Capacitor's SystemBars docs ask for it until Capacitor 9 does it.
        // Only after super.onCreate: earlier, the window is built with the launch theme and keeps its splash background.
        EdgeToEdge.enable(this);
    }
}
