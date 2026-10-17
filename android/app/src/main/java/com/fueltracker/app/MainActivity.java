package com.fueltracker.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FuelNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
