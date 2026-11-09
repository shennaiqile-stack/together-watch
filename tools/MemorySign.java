import java.io.*;
import java.nio.*;
import java.nio.file.*;
import java.security.*;
import java.security.cert.X509Certificate;
import java.util.*;
import com.android.apksig.ApkSigner;
import com.android.apksig.util.*;

/** Use the official signer in memory; the parent process saves its binary output. */
class MemorySign {
    public static void main(String[] args) throws Exception {
        char[] password=System.getenv("WT_SIGN_PASSWORD").toCharArray();
        KeyStore store=KeyStore.getInstance(new File(args[0]),password);
        String alias=null;
        Enumeration<String> aliases=store.aliases();
        while(aliases.hasMoreElements()){String next=aliases.nextElement();if(store.isKeyEntry(next)){alias=next;break;}}
        if(alias==null)throw new IllegalStateException("Signing key not found");
        PrivateKey key=(PrivateKey)store.getKey(alias,password);
        X509Certificate cert=(X509Certificate)store.getCertificate(alias);
        ApkSigner.SignerConfig signer=new ApkSigner.SignerConfig.Builder("TOGETHER",key,Collections.singletonList(cert)).build();
        ReadableDataSink output=DataSinks.newInMemoryDataSink();
        new ApkSigner.Builder(Collections.singletonList(signer))
            .setInputApk(DataSources.asDataSource(ByteBuffer.wrap(Files.readAllBytes(Paths.get(args[1])))))
            .setOutputApk(output).setV1SigningEnabled(false).setV2SigningEnabled(true)
            .setV3SigningEnabled(true).setV4SigningEnabled(false).setMinSdkVersion(24)
            .setAlignmentPreserved(true).build().sign();
        output.feed(0,output.size(),DataSinks.asDataSink(System.out));
        System.out.flush();
    }
}
