import java.io.File;
import com.android.apksig.ApkVerifier;

public class VerifyApk {
    public static void main(String[] args) throws Exception {
        ApkVerifier.Result result = new ApkVerifier.Builder(new File(args[0]))
                .setMinCheckedPlatformVersion(21)
                .build()
                .verify();
        System.out.println("verified=" + result.isVerified()
                + " v1=" + result.isVerifiedUsingV1Scheme()
                + " v2=" + result.isVerifiedUsingV2Scheme()
                + " v3=" + result.isVerifiedUsingV3Scheme());
        if (!result.isVerified()) {
            for (Object issue : result.getErrors()) System.out.println("ERR " + issue);
        }
    }
}
