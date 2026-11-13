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
    private String pendingInvite;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        WebView web=player(getWindow().getDecorView());
        if(web!=null){
            web.addJavascriptInterface(new UpdateDownload(),"PhoneUpdates");
            web.addJavascriptInterface(new InviteInbox(),"PhoneInvites");
        }
        if(saved!=null)pendingInvite=saved.getString("pendingInvite");
        acceptInvite(getIntent());
        if (Build.VERSION.SDK_INT >= 33) backCallback = ModernBack.register(this);
    }

    private synchronized void acceptInvite(android.content.Intent intent) {
        android.net.Uri uri=intent==null?null:intent.getData();
        android.util.Log.d("TogetherWatchInvite","received "+(uri==null?"none":uri.getScheme()+" "+uri.getHost()+" "+uri.getPath()+" "+uri.getPort()));
        if(uri==null||!"togetherwatch".equalsIgnoreCase(uri.getScheme()))return;
        String host=uri.getHost(),path=uri.getPath();int port=uri.getPort();
        if(host==null||host.length()>253||!host.matches("[A-Za-z0-9.-]+")||path==null||!path.matches("/[A-Za-z0-9]{3,12}")||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null||port==0||port>65535)return;
        pendingInvite=uri.toString();
        android.util.Log.d("TogetherWatchInvite","invitation queued");
    }

    @Override protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);setIntent(intent);acceptInvite(intent);
    }

    @Override protected synchronized void onSaveInstanceState(Bundle state) {
        state.putString("pendingInvite",pendingInvite);super.onSaveInstanceState(state);
    }

    public class InviteInbox {
        @android.webkit.JavascriptInterface public String takePending() {
            synchronized(NextActivity.this){
                String value=pendingInvite;pendingInvite=null;
                if(value!=null)android.util.Log.d("TogetherWatchInvite","invitation delivered");
                if(value!=null)runOnUiThread(()->{
                    android.content.Intent intent=getIntent();
                    if(intent!=null&&value.equals(intent.getDataString()))intent.setData(null);
                });
                return value;
            }
        }
    }

    public class UpdateDownload {
        private volatile String stage="idle",error="";
        private volatile long downloaded,total;
        private java.io.File packageFile(){return new java.io.File(getFilesDir(),"updates/TogetherWatch-update.apk");}
        private java.io.File readyFile(){return new java.io.File(packageFile().getParentFile(),"ready.json");}
        public UpdateDownload(){
            try{verifyCached();downloaded=total=packageFile().length();stage="ready";}catch(Exception ignored){}
        }
        private String hashFile(java.io.File file)throws Exception{
            java.security.MessageDigest hash=java.security.MessageDigest.getInstance("SHA-256");
            try(java.io.InputStream input=new java.io.FileInputStream(file)){byte[] b=new byte[131072];int n;while((n=input.read(b))!=-1)hash.update(b,0,n);}
            StringBuilder value=new StringBuilder();for(byte b:hash.digest())value.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return value.toString();
        }
        private void verifyCached()throws Exception{
            StringBuilder text=new StringBuilder();
            try(java.io.BufferedReader reader=new java.io.BufferedReader(new java.io.FileReader(readyFile()))){String line;while((line=reader.readLine())!=null){text.append(line);if(text.length()>4096)throw new java.io.IOException("更新缓存无效");}}
            org.json.JSONObject info=new org.json.JSONObject(text.toString());
            if(packageFile().length()!=info.getLong("size")||!hashFile(packageFile()).equals(info.getString("sha256")))throw new java.io.IOException("更新缓存校验失败");
            validatePackage(packageFile());
        }
        private boolean trusted(String value,boolean initial){
            try{
                java.net.URI uri=new java.net.URI(value);String host=uri.getHost(),path=uri.getPath();
                if(!"https".equals(uri.getScheme())||uri.getUserInfo()!=null||uri.getPort()!=-1||
                    !("github.com".equals(host)||"release-assets.githubusercontent.com".equals(host)||"objects.githubusercontent.com".equals(host)))return false;
                return !initial||("github.com".equals(host)&&uri.getQuery()==null&&uri.getFragment()==null&&path!=null&&path.matches("/shennaiqile-stack/together-watch/releases/download/[^/]+/TogetherWatch-Android-v[0-9]+(?:\\.[0-9]+){1,3}\\.apk"));
            }catch(Exception e){return false;}
        }
        @android.webkit.JavascriptInterface public synchronized String status(){
            org.json.JSONObject state=new org.json.JSONObject();
            try{state.put("stage",stage);state.put("downloaded",downloaded);state.put("total",total);state.put("error",error);}catch(Exception ignored){}
            return state.toString();
        }
        @android.webkit.JavascriptInterface public synchronized void start(String descriptor){
            if("downloading".equals(stage)||"installing".equals(stage))return;
            try{
                org.json.JSONObject input=new org.json.JSONObject(descriptor);
                String url=input.getString("url"),hash=input.getString("sha256").replace("sha256:","").toLowerCase(java.util.Locale.ROOT);
                long size=input.getLong("size");
                if(!trusted(url,true)||!hash.matches("[0-9a-f]{64}")||size<=0||size>300L*1024*1024)throw new java.io.IOException("更新文件校验信息无效");
                stage="downloading";error="";downloaded=0;total=size;
                new Thread(()->download(url,hash,size),"app-update-download").start();
            }catch(Exception e){stage="error";error=e.getMessage();}
        }
        private void download(String initial,String expected,long size){
            java.io.File part=new java.io.File(packageFile().getParentFile(),"package.part");
            java.net.HttpURLConnection connection=null;
            try{
                part.getParentFile().mkdirs();String url=initial;
                for(int redirect=0;redirect<7;redirect++){
                    if(!trusted(url,false))throw new java.io.IOException("更新重定向地址无效");
                    connection=(java.net.HttpURLConnection)new java.net.URL(url).openConnection();
                    connection.setConnectTimeout(15000);connection.setReadTimeout(30000);connection.setInstanceFollowRedirects(false);
                    connection.setRequestProperty("User-Agent","TogetherWatch-Updater");connection.setRequestProperty("Accept-Encoding","identity");
                    int code=connection.getResponseCode();
                    if(code>=300&&code<400){String next=connection.getHeaderField("Location");if(next==null)throw new java.io.IOException("更新重定向失败");url=new java.net.URL(new java.net.URL(url),next).toString();connection.disconnect();connection=null;continue;}
                    if(code!=200)throw new java.io.IOException("下载失败：HTTP "+code);
                    break;
                }
                if(connection==null||connection.getResponseCode()!=200)throw new java.io.IOException("更新重定向次数过多");
                java.security.MessageDigest digest=java.security.MessageDigest.getInstance("SHA-256");
                try(java.io.InputStream in=connection.getInputStream();java.io.FileOutputStream out=new java.io.FileOutputStream(part)){
                    byte[] buffer=new byte[131072];int count;
                    while((count=in.read(buffer))!=-1){downloaded+=count;if(downloaded>size)throw new java.io.IOException("更新文件大小异常");out.write(buffer,0,count);digest.update(buffer,0,count);}
                }
                StringBuilder actual=new StringBuilder();for(byte b:digest.digest())actual.append(String.format(java.util.Locale.ROOT,"%02x",b&255));
                if(downloaded!=size||!actual.toString().equals(expected))throw new java.io.IOException("安装包校验失败，请重新下载");
                validatePackage(part);
                if(packageFile().exists()&&!packageFile().delete())throw new java.io.IOException("无法替换旧的更新缓存");
                if(!part.renameTo(packageFile()))throw new java.io.IOException("无法保存更新安装包");
                org.json.JSONObject saved=new org.json.JSONObject();saved.put("sha256",expected);saved.put("size",size);
                try(java.io.FileOutputStream meta=new java.io.FileOutputStream(readyFile())){meta.write(saved.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));}
                stage="ready";
            }catch(Exception e){part.delete();error=e.getMessage()==null?"更新下载失败":e.getMessage();stage="error";}
            finally{if(connection!=null)connection.disconnect();}
        }
        private void validatePackage(java.io.File file)throws Exception{
            android.content.pm.PackageManager manager=getPackageManager();
            int flags=Build.VERSION.SDK_INT>=28?android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES:android.content.pm.PackageManager.GET_SIGNATURES;
            android.content.pm.PackageInfo candidate=manager.getPackageArchiveInfo(file.getAbsolutePath(),flags);
            android.content.pm.PackageInfo installed=manager.getPackageInfo(getPackageName(),flags);
            if(candidate==null||!getPackageName().equals(candidate.packageName))throw new java.io.IOException("安装包与当前应用不匹配");
            long next=Build.VERSION.SDK_INT>=28?candidate.getLongVersionCode():candidate.versionCode;
            long current=Build.VERSION.SDK_INT>=28?installed.getLongVersionCode():installed.versionCode;
            if(next<=current)throw new java.io.IOException("安装包版本不高于当前版本");
            android.content.pm.Signature[] a=Build.VERSION.SDK_INT>=28?candidate.signingInfo.getApkContentsSigners():candidate.signatures;
            android.content.pm.Signature[] b=Build.VERSION.SDK_INT>=28?installed.signingInfo.getApkContentsSigners():installed.signatures;
            if(a==null||b==null||a.length!=b.length)throw new java.io.IOException("安装包签名不匹配");
            for(int i=0;i<a.length;i++)if(!a[i].equals(b[i]))throw new java.io.IOException("安装包签名不匹配，无法覆盖安装");
        }
        @android.webkit.JavascriptInterface public void install(){
            if(!"ready".equals(stage)&&!"permission".equals(stage))return;
            runOnUiThread(()->{
                try{
                    if(Build.VERSION.SDK_INT>=26&&!getPackageManager().canRequestPackageInstalls()){
                        stage="permission";error="请允许本应用安装更新，然后返回点击安装更新";
                        startActivity(new android.content.Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,android.net.Uri.parse("package:"+getPackageName())));return;
                    }
                    verifyCached();
                    android.net.Uri uri=android.net.Uri.parse("content://"+getPackageName()+".updates/package");
                    android.content.Intent intent=new android.content.Intent(android.content.Intent.ACTION_VIEW);
                    intent.setDataAndType(uri,"application/vnd.android.package-archive");intent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(intent);stage="ready";error="请在系统安装界面确认覆盖安装";
                }catch(Exception e){stage="error";error=e.getMessage()==null?"无法打开安装界面":e.getMessage();}
            });
        }
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

    public static class UpdateProvider extends android.content.ContentProvider {
        private java.io.File file(android.net.Uri uri)throws java.io.FileNotFoundException{
            if(!"/package".equals(uri.getPath()))throw new java.io.FileNotFoundException();
            java.io.File file=new java.io.File(getContext().getFilesDir(),"updates/TogetherWatch-update.apk");
            if(!file.isFile())throw new java.io.FileNotFoundException();return file;
        }
        @Override public boolean onCreate(){return true;}
        @Override public String getType(android.net.Uri uri){return "application/vnd.android.package-archive";}
        @Override public android.os.ParcelFileDescriptor openFile(android.net.Uri uri,String mode)throws java.io.FileNotFoundException{
            if(!"r".equals(mode))throw new java.io.FileNotFoundException();return android.os.ParcelFileDescriptor.open(file(uri),android.os.ParcelFileDescriptor.MODE_READ_ONLY);
        }
        @Override public android.database.Cursor query(android.net.Uri uri,String[] projection,String selection,String[] args,String order){
            try{java.io.File file=file(uri);android.database.MatrixCursor result=new android.database.MatrixCursor(new String[]{"_display_name","_size"});result.addRow(new Object[]{"TogetherWatch-update.apk",file.length()});return result;}catch(Exception e){return null;}
        }
        @Override public android.net.Uri insert(android.net.Uri uri,android.content.ContentValues values){throw new UnsupportedOperationException();}
        @Override public int delete(android.net.Uri uri,String where,String[] args){throw new UnsupportedOperationException();}
        @Override public int update(android.net.Uri uri,android.content.ContentValues values,String where,String[] args){throw new UnsupportedOperationException();}
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
        // During startup a missing handler must not be treated as the home page.
        web.evaluateJavascript("window.WatchBack ? Boolean(window.WatchBack.handle()) : null", result -> {
            waitingBack=false;
            if("false".equals(result)) finish();
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
