package com.watchtogether.phone;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

/** Additional behavior around the supplied APK; its native features stay intact. */
public class NextActivity extends MainActivity {
    private boolean waitingBack;
    private Object backCallback;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (Build.VERSION.SDK_INT >= 33) backCallback = ModernBack.register(this);
    }

    private WebView player(View view) {
        if (view instanceof WebView) return (WebView)view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup)view;
            for (int i=0;i<group.getChildCount();i++) {
                WebView found=player(group.getChildAt(i));
                if(found!=null)return found;
            }
        }
        return null;
    }

    @Override public void onBackPressed() {
        if(waitingBack)return;
        WebView web=player(getWindow().getDecorView());
        if(web==null){finish();return;}
        waitingBack=true;
        web.evaluateJavascript("Boolean(window.WatchBack && window.WatchBack.handle())", result -> {
            waitingBack=false;
            if(!"true".equals(result)) finish();
        });
    }

    @Override protected void onDestroy() {
        if(Build.VERSION.SDK_INT>=33 && backCallback!=null)ModernBack.unregister(this,backCallback);
        super.onDestroy();
    }

    private static class ModernBack {
        static Object register(NextActivity activity) {
            android.window.OnBackInvokedCallback callback=activity::onBackPressed;
            activity.getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,callback);
            return callback;
        }
        static void unregister(NextActivity activity,Object callback) {
            activity.getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(
                (android.window.OnBackInvokedCallback)callback);
        }
    }
}
