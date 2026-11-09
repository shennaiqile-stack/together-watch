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
        WebView web=player(getWindow().getDecorView());
        if(web!=null)web.addJavascriptInterface(new UpdateDownload(),"PhoneUpdates");
        if (Build.VERSION.SDK_INT >= 33) backCallback = ModernBack.register(this);
    }

    public class UpdateDownload {
        @android.webkit.JavascriptInterface public void openDownload(String value) {
            android.net.Uri uri=android.net.Uri.parse(value);
            String path=uri.getPath();
            if(!"https".equals(uri.getScheme()) || !"github.com".equals(uri.getHost()) ||
               uri.getUserInfo()!=null || uri.getPort()!=-1 || uri.getQuery()!=null ||
               !("/shennaiqile-stack/together-watch/releases/latest".equals(path) ||
                 (path!=null && path.startsWith("/shennaiqile-stack/together-watch/releases/download/") && path.endsWith(".apk")))) return;
            runOnUiThread(()->{
                try {startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW,uri));}
                catch(android.content.ActivityNotFoundException error) {
                    android.widget.Toast.makeText(NextActivity.this,"请先安装浏览器以下载安装包",android.widget.Toast.LENGTH_LONG).show();
                }
            });
        }
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
