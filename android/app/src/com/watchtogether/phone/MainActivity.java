package com.watchtogether.phone;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * 一起看手机端：WebView 壳。
 * 界面内置在 assets/web（本地秒开）；API/同步通过页面远程模式走房主服务器；
 * 拦截 /relay?u=<base64url(B站CDN地址)> 的媒体请求，由本机带 Referer 直连 B 站。
 * 服务器只承担几 KB 级的签名和同步流量。
 */
public class MainActivity extends Activity {
    private static final String PREFS = "wt";
    private static final String KEY_SERVER = "server";
    private static final String LOCAL_HOST = "wt.local";
    private static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        showHome();
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private void showHome() {
        SharedPreferences sp = getSharedPreferences(PREFS, 0);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(Color.rgb(23, 26, 33));
        int pad = dp(28);
        root.setPadding(pad, dp(90), pad, pad);

        TextView title = new TextView(this);
        title.setText("一起看 · 手机端");
        title.setTextColor(Color.WHITE);
        title.setTextSize(24);
        title.setGravity(Gravity.CENTER);
        root.addView(title, new LinearLayout.LayoutParams(-1, -2));

        TextView sub = new TextView(this);
        sub.setText("界面本地加载，视频直连 B 站，服务器只同步进度");
        sub.setTextColor(Color.rgb(148, 163, 184));
        sub.setTextSize(13);
        sub.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(-1, -2);
        subLp.topMargin = dp(10);
        root.addView(sub, subLp);

        final EditText input = new EditText(this);
        input.setHint("粘贴房主的分享链接（http://…:8770/?k=…）");
        input.setHintTextColor(Color.rgb(100, 116, 139));
        input.setTextColor(Color.WHITE);
        input.setSingleLine(true);
        input.setText(sp.getString(KEY_SERVER, ""));
        input.setSelection(input.getText().length());
        LinearLayout.LayoutParams inLp = new LinearLayout.LayoutParams(-1, -2);
        inLp.topMargin = dp(36);
        root.addView(input, inLp);

        Button go = new Button(this);
        go.setText("进入房间");
        LinearLayout.LayoutParams goLp = new LinearLayout.LayoutParams(-1, -2);
        goLp.topMargin = dp(20);
        root.addView(go, goLp);

        go.setOnClickListener(v -> {
            String url = input.getText().toString().trim();
            if (!url.startsWith("http")) {
                Toast.makeText(this, "链接应以 http 开头", Toast.LENGTH_SHORT).show();
                return;
            }
            getSharedPreferences(PREFS, 0).edit().putString(KEY_SERVER, url).apply();
            showPlayer(url);
        });

        setContentView(root);
    }

    private void showPlayer(String server) {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                try {
                    String u = request.getUrl().toString();
                    String path = request.getUrl().getPath();
                    String host = request.getUrl().getHost();
                    if (path != null && path.startsWith("/relay") && u.contains("u=")) {
                        return relay(u, request.getRequestHeaders());
                    }
                    if (LOCAL_HOST.equalsIgnoreCase(host)) {
                        return local(path == null ? "/" : path);
                    }
                } catch (Throwable ignored) {
                }
                return super.shouldInterceptRequest(view, request);
            }
        });
        setContentView(web);
        String srv = Base64.encodeToString(server.getBytes(StandardCharsets.UTF_8),
                Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        web.loadUrl("http://" + LOCAL_HOST + "/index.html#srv=" + srv);
    }

    /* 内置页面：静态资源读 assets/web；/api 给最小应答（真正的 API 由远程模式发到房主） */
    private WebResourceResponse local(String path) {
        try {
            if (path.startsWith("/api/")) {
                byte[] b;
                if (path.startsWith("/api/health")) {
                    b = "{\"ok\":true,\"version\":\"0.0.0-phone\"}".getBytes(StandardCharsets.UTF_8);
                } else if (path.startsWith("/api/cache")) {
                    b = "{\"ok\":true,\"items\":[]}".getBytes(StandardCharsets.UTF_8);
                } else if (path.startsWith("/api/speed")) {
                    b = new byte[262144];
                } else {
                    b = "{\"ok\":false}".getBytes(StandardCharsets.UTF_8);
                }
                return new WebResourceResponse("application/json", "utf-8", 200, "OK", null, new ByteArrayInputStream(b));
            }
            String p = path.equals("/") ? "/index.html" : path;
            InputStream in = getAssets().open("web" + p);
            return new WebResourceResponse(mime(p), null, 200, "OK", null, in);
        } catch (Exception e) {
            byte[] b = "not found".getBytes(StandardCharsets.UTF_8);
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, new ByteArrayInputStream(b));
        }
    }

    private static String mime(String p) {
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".woff")) return "font/woff";
        return "application/octet-stream";
    }

    /* 解码 CDN 地址，本机带 Referer 发起请求，透传 Range，流式回给 WebView */
    private WebResourceResponse relay(String pageUrl, Map<String, String> reqHeaders) {
        HttpURLConnection c = null;
        try {
            String b64 = pageUrl.substring(pageUrl.indexOf("u=") + 2);
            int amp = b64.indexOf('&');
            if (amp >= 0) b64 = b64.substring(0, amp);
            while (b64.length() % 4 != 0) b64 += "=";
            String target = new String(Base64.decode(b64, Base64.URL_SAFE), StandardCharsets.UTF_8);

            c = (HttpURLConnection) new URL(target).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("Referer", "https://www.bilibili.com/");
            c.setRequestProperty("User-Agent", UA);
            for (Map.Entry<String, String> h : reqHeaders.entrySet()) {
                if ("range".equalsIgnoreCase(h.getKey())) {
                    c.setRequestProperty("Range", h.getValue());
                }
            }
            c.connect();
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();

            Map<String, String> headers = new HashMap<>();
            String ct = c.getContentType();
            String cr = c.getHeaderField("Content-Range");
            String ar = c.getHeaderField("Accept-Ranges");
            long len = c.getContentLengthLong();
            if (ct != null) headers.put("Content-Type", ct);
            if (len >= 0) headers.put("Content-Length", String.valueOf(len));
            if (cr != null) headers.put("Content-Range", cr);
            headers.put("Accept-Ranges", ar != null ? ar : "bytes");

            String mime = ct != null ? ct.split(";")[0].trim() : "application/octet-stream";
            String reason = code == 206 ? "Partial Content" : code == 200 ? "OK" : "Error";
            // 连接不能在这里断开：WebView 会边播边读这个流
            return new WebResourceResponse(mime, null, code, reason, headers, in);
        } catch (Exception e) {
            if (c != null) c.disconnect();
            byte[] msg = ("relay failed: " + e).getBytes(StandardCharsets.UTF_8);
            return new WebResourceResponse("text/plain", "utf-8", 502, "Bad Gateway",
                    new HashMap<String, String>(), new ByteArrayInputStream(msg));
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
