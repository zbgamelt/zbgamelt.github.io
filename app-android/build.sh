#!/bin/bash
# 手工编译原生 Android App → 已签名 APK（不用 Gradle / 不用 AndroidX）
# 依赖：aapt2 / javac / d8 / zipalign / apksigner / android.jar
set -e
cd "$(dirname "$0")"

SDK=/usr/lib/android-sdk
BT=$SDK/build-tools/35.0.0        # aapt2
BT2=$SDK/build-tools/34.0.0       # d8 / zipalign / apksigner
ANDROID_JAR=$SDK/platforms/android-35/android.jar
OUT=build
APK=zbgamelt.apk

KS=~/.android/zbgamelt.keystore
KSPASS=zbgamelt2026
KSALIAS=zbgamelt

# ⚠️ 必须用 JDK 17/11 的 javac，别用 PATH 里的 21。
#    JDK 21 编出来的 .class 文件 d8 一律拒收：只要里面有**匿名内部类**，d8 就抛
#    NullPointerException: Cannot invoke "String.length()" because "<parameter1>" is null
#    （build-tools 33 的 d8 3.3.20 和 34 的 d8 8.2.2 都一样）。
#    javac 17 / 11 用同一组参数编出来就没事。
#    注意报错会指向某个 $N.class，别以为是那个匿名类写错了 —— 换 javac 即可。
JAVAC=""
for cand in /usr/lib/jvm/java-17-openjdk-amd64/bin/javac \
            /usr/lib/jvm/java-11-openjdk-amd64/bin/javac; do
    if [ -x "$cand" ]; then JAVAC="$cand"; break; fi
done
if [ -z "$JAVAC" ]; then
    echo "✗ 找不到 JDK 17/11 的 javac；JDK 21 编出来的类 d8 收不了"
    exit 1
fi
echo "    用 javac: $JAVAC ($("$JAVAC" -version 2>&1))"

if [ ! -f "$KS" ]; then
    echo "==> 0/6 生成签名密钥（一次就够）"
    keytool -genkeypair -keystore "$KS" -alias "$KSALIAS" \
        -keyalg RSA -keysize 2048 -validity 10950 \
        -storepass "$KSPASS" -keypass "$KSPASS" \
        -dname "CN=ZBGAME LT, OU=forum, O=zbgamelt, C=CN"
fi

rm -rf $OUT
mkdir -p $OUT/gen $OUT/classes

echo "==> 1/6 编译资源 (aapt2 compile)"
$BT/aapt2 compile --dir res -o $OUT/res.zip

echo "==> 2/6 链接资源 + 生成 R.java (aapt2 link)"
$BT/aapt2 link -o $OUT/base.apk \
    -I $ANDROID_JAR \
    --manifest AndroidManifest.xml \
    --java $OUT/gen \
    --auto-add-overlay \
    -R $OUT/res.zip

echo "==> 3/6 编译 Java (javac --release 8)"
"$JAVAC" --release 8 -nowarn -classpath $ANDROID_JAR -d $OUT/classes \
    $(find src $OUT/gen -name "*.java")

echo "==> 4/6 转 dex (d8)"
$BT2/d8 --release --lib $ANDROID_JAR --min-api 21 --output $OUT \
    $(find $OUT/classes -name "*.class")

echo "==> 5/6 打包 + 对齐"
cp $OUT/base.apk $OUT/unsigned.apk
(cd $OUT && zip -q -j unsigned.apk classes.dex)
$BT2/zipalign -f 4 $OUT/unsigned.apk $OUT/aligned.apk

echo "==> 6/6 签名 (v1+v2+v3)"
$BT2/apksigner sign --ks "$KS" --ks-pass "pass:$KSPASS" --ks-key-alias "$KSALIAS" \
    --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
    --out "$APK" $OUT/aligned.apk

$BT2/apksigner verify --verbose "$APK" | head -6
echo "✅ 完成：$APK ($(stat -c%s "$APK") bytes)"
