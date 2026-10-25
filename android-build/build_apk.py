"""Build the standalone Android APK without Android Studio/Gradle.

Requires the toolchain under android-build/tooling:
  - jdk4py JRE (java.exe)
  - ecj.jar (Java compiler)
  - android-all.jar (Android API classes, from Robolectric Maven artifact)
  - android.jar (framework resources for aapt2)
  - aapt2.exe (Android asset packaging)
  - r8.jar (D8 dexer)
  - apksig.jar (APK signature scheme v1/v2/v3)
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
APP = ROOT / "app"
SRC = APP / "src"
ASSETS = APP / "assets"
RES = APP / "res"
BUILD = APP / "build"
TOOL = ROOT / "tooling"
LIBS = TOOL / "libs"
JAVA = next((TOOL / "jdk4py").rglob("java.exe"))
ECJ = LIBS / "ecj.jar"
ANDROID_JAR = LIBS / "android.jar"
ANDROID_ALL = LIBS / "android-all.jar"
AAPT2 = TOOL / "aapt2" / "aapt2.exe"
R8 = LIBS / "r8.jar"
APKSIG = LIBS / "apksig.jar"
KEYSTORE = ROOT / "lianbo.keystore"
OUTPUT = ROOT / "output" / "联播夜读-2.2.4.apk"


def run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess:
    print("$", " ".join(str(x) for x in cmd))
    proc = subprocess.run(cmd, text=True, encoding="utf-8", errors="replace",
                          capture_output=True)
    if proc.stdout:
        print(proc.stdout.rstrip())
    if proc.stderr:
        print(proc.stderr.rstrip())
    if check and proc.returncode != 0:
        raise SystemExit("command failed: %s" % proc.returncode)
    return proc


def compile_java(source, classpath: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    sources = source if isinstance(source, (list, tuple)) else [source]
    run([
        str(JAVA), "-Xmx1400m", "-jar", str(ECJ),
        "-source", "8", "-target", "8", "-encoding", "UTF-8",
        "-classpath", str(classpath), "-d", str(out_dir),
        *[str(item) for item in sources],
    ])


def main() -> None:
    for path in (JAVA, ECJ, ANDROID_JAR, ANDROID_ALL, AAPT2, R8, APKSIG, KEYSTORE):
        if not path.exists():
            raise SystemExit("missing toolchain file: %s" % path)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    BUILD.mkdir(parents=True, exist_ok=True)
    for name in ("classes", "dex", "signer"):
        p = BUILD / name
        if p.exists():
            shutil.rmtree(p)
    for name in ("res.zip", "app-unsigned.apk", "app-withdex.apk", "app-signed.apk"):
        p = BUILD / name
        if p.exists():
            p.unlink()
    # Ensure no dev-only page gets packaged
    for junk in (ASSETS / "www" / "test.html", ASSETS / "www" / "docs"):
        if junk.is_dir():
            shutil.rmtree(junk)
        elif junk.exists():
            junk.unlink()

    # 1) Java classes
    classes = BUILD / "classes"
    compile_java([
        SRC / "com" / "lianbo" / "mobile" / "MainActivity.java",
        SRC / "com" / "lianbo" / "mobile" / "BackgroundAudioService.java",
    ], ANDROID_ALL, classes)
    signer_dir = BUILD / "signer"
    compile_java(SRC / "SignApk.java", APKSIG, signer_dir)
    compile_java(SRC / "VerifyApk.java", APKSIG, signer_dir)

    # 2) DEX
    dex = BUILD / "dex"
    dex.mkdir()
    class_files = [str(p) for p in classes.rglob("*.class")]
    run([str(JAVA), "-Xmx1400m", "-cp", str(R8), "com.android.tools.r8.D8",
         "--min-api", "24", "--lib", str(ANDROID_ALL), "--output", str(dex), *class_files])

    # 3) resources + assets
    res_zip = BUILD / "res.zip"
    run([str(AAPT2), "compile", "-o", str(res_zip), "--dir", str(RES)])
    unsigned = BUILD / "app-unsigned.apk"
    run([
        str(AAPT2), "link", "-o", str(unsigned), "-I", str(ANDROID_JAR),
        "--manifest", str(SRC / "AndroidManifest.xml"), "-R", str(res_zip),
        "-A", str(ASSETS), "--auto-add-overlay",
    ])

    # 4) add classes.dex
    withdex = BUILD / "app-withdex.apk"
    with zipfile.ZipFile(unsigned, "r") as zin, zipfile.ZipFile(withdex, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            zout.writestr(item, zin.read(item.filename))
        zout.write(dex / "classes.dex", "classes.dex")

    # 5) sign
    signed = BUILD / "app-signed.apk"
    run([str(JAVA), "-cp", f"{signer_dir}{os.pathsep}{APKSIG}", "SignApk",
         str(withdex), str(signed), str(KEYSTORE), "lianbo123", "lianbo"])
    verify = run([str(JAVA), "-cp", f"{signer_dir}{os.pathsep}{APKSIG}", "VerifyApk", str(signed)],
                 check=False)
    if verify.returncode != 0 or "verified=true" not in verify.stdout:
        raise SystemExit("APK signature verification failed")
    shutil.copy2(signed, OUTPUT)
    print("APK:", OUTPUT)
    print("size MB:", round(OUTPUT.stat().st_size / 1024 / 1024, 1))


if __name__ == "__main__":
    sys.exit(main())
