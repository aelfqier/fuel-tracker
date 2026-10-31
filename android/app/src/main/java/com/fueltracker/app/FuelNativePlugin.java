package com.fueltracker.app;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.util.Base64;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

/**
 * Phone features the web layer can't do on its own:
 * reading numbers from a photo (ML Kit, on the phone, works offline), refreshing the home-screen widget,
 * and printing or saving the history report as a PDF with the system print dialog.
 */
@CapacitorPlugin(name = "FuelNative")
public class FuelNativePlugin extends Plugin {
    private TextRecognizer recognizer;
    private WebView printView; // kept alive until the print job has been laid out

    @PluginMethod
    public void recognizeText(PluginCall call) {
        String b64 = call.getString("base64");
        if (b64 == null || b64.isEmpty()) {
            call.reject("No image");
            return;
        }
        Bitmap bitmap;
        try {
            byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
            bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (IllegalArgumentException e) {
            call.reject("Bad image", e);
            return;
        }
        if (bitmap == null) {
            call.reject("Bad image");
            return;
        }
        if (recognizer == null) recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        recognizer
            .process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener(result -> {
                JSObject ret = new JSObject();
                ret.put("text", result.getText());
                call.resolve(ret);
            })
            .addOnFailureListener(e -> call.reject("Recognition failed", e));
    }

    @PluginMethod
    public void refreshWidget(PluginCall call) {
        Context ctx = getContext();
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, FuelWidgetProvider.class));
        FuelWidgetProvider.updateAll(ctx, mgr, ids);
        call.resolve();
    }

    @PluginMethod
    public void printHtml(PluginCall call) {
        String html = call.getString("html", "");
        String name = call.getString("name", "Fuel Tracker");
        getActivity().runOnUiThread(() -> {
            WebView view = new WebView(getActivity());
            view.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView v, String url) {
                    PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                    PrintDocumentAdapter adapter = v.createPrintDocumentAdapter(name);
                    pm.print(name, adapter, new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build());
                    call.resolve();
                }
            });
            view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
            printView = view;
        });
    }
}
