param([string]$Toolchain='C:/Users/19075/Documents/deepseek-harness/default-workspace/watch-together-pc/tools/android')
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $project
$env:JAVA_HOME=Join-Path $Toolchain 'jdk-17.0.2'
$bt=Join-Path $Toolchain 'sdk/build-tools/android-37.0'
$jar=(Get-ChildItem (Join-Path $Toolchain 'sdk/platforms') -Recurse -Filter android.jar | Select-Object -Last 1).FullName
$out=Join-Path ([IO.Path]::GetTempPath()) ('TogetherWatchBuild-'+[Guid]::NewGuid().ToString('N'))
$dist=Join-Path $project 'dist'
New-Item -ItemType Directory -Force -Path $out,"$out/classes","$out/dex",$dist | Out-Null
& "$bt/aapt2.exe" compile --dir android/app/res -o "$out/compiled.zip"
if($LASTEXITCODE){throw 'Resource compile failed'}
& "$bt/aapt2.exe" link -o "$out/resources.apk" -I $jar --manifest android/base-interop/AndroidManifest.xml "$out/compiled.zip" --min-sdk-version 24 --target-sdk-version 36
if($LASTEXITCODE){throw 'Resource link failed'}
& "$env:JAVA_HOME/bin/javac.exe" -encoding UTF-8 -source 8 -target 8 -classpath $jar -d "$out/classes" android/compile-stubs/com/watchtogether/phone/MainActivity.java android/next-src/com/watchtogether/phone/NextActivity.java
if($LASTEXITCODE){throw 'Navigation compile failed'}
$classes=Get-ChildItem "$out/classes/com/watchtogether/phone" -Filter 'NextActivity*.class' | ForEach-Object {$_.FullName}
& "$bt/d8.bat" --lib $jar --classpath "$out/classes" --min-api 24 --output "$out/dex" @classes
if($LASTEXITCODE){throw 'Navigation dex failed'}
& 'C:/Users/19075/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe' tools/repack_phone_interop.py input/base.apk "$out/resources.apk" "$out/unsigned.apk" "$out/dex/classes.dex"
if($LASTEXITCODE){throw 'Repack failed'}
& "$bt/zipalign.exe" -f 4 "$out/unsigned.apk" "$out/aligned.apk"
if($LASTEXITCODE){throw 'Alignment failed'}
$apk=Join-Path $out 'signed.apk'
& "$bt/apksigner.bat" sign --ks android/wt.keystore --ks-pass env:WT_SIGN_PASSWORD --key-pass env:WT_SIGN_PASSWORD --in "$out/aligned.apk" --out $apk
if($LASTEXITCODE){throw 'Signing failed'}
& "$bt/apksigner.bat" verify $apk
if($LASTEXITCODE){throw 'Signature verification failed'}
& "$bt/zipalign.exe" -c 4 $apk
if($LASTEXITCODE){throw 'Alignment verification failed'}
$final=Join-Path $dist '一起看手机端-Android-v5.6.apk'
Copy-Item -LiteralPath $apk -Destination $final -Force
Write-Output "Built $final"
