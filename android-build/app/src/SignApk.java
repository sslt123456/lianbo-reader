import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import com.android.apksig.ApkSigner;

public class SignApk {
    public static void main(String[] args) throws Exception {
        String in = args[0];
        String out = args[1];
        String keystorePath = args[2];
        String storePass = args[3];
        String alias = args[4];

        KeyStore keyStore = KeyStore.getInstance("PKCS12");
        try (InputStream is = new FileInputStream(keystorePath)) {
            keyStore.load(is, storePass.toCharArray());
        }
        PrivateKey key = (PrivateKey) keyStore.getKey(alias, storePass.toCharArray());
        Certificate[] chain = keyStore.getCertificateChain(alias);
        List<X509Certificate> certs = new ArrayList<X509Certificate>();
        for (int i = 0; i < chain.length; i++) {
            certs.add((X509Certificate) chain[i]);
        }
        ApkSigner.SignerConfig signerConfig =
                new ApkSigner.SignerConfig.Builder("CERT", key, certs).build();
        List<ApkSigner.SignerConfig> signers = new ArrayList<ApkSigner.SignerConfig>();
        signers.add(signerConfig);
        new ApkSigner.Builder(signers)
                .setInputApk(new File(in))
                .setOutputApk(new File(out))
                .setV1SigningEnabled(true)
                .setV2SigningEnabled(true)
                .setV3SigningEnabled(true)
                .setMinSdkVersion(21)
                .build()
                .sign();
        System.out.println("signed " + out);
    }
}
