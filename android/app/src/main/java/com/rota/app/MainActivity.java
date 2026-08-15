package com.rota.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RotaNfcReaderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
