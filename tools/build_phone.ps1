# 一起看手机端构建（无 Gradle）：aapt2 -> javac -> d8 -> zipalign -> apksigner
# 工具链不能放在「文档」目录下，Windows 会拒绝这些二进制在那里写文件，默认放在 %LOCALAPPDATA%\wtbuild\tools。
param(
    [string]$Toolchain = "$env:LOCALAPPDATA\wtbuild\tools",
    [string]$AndroidJar = "C:\Users\19075\Documents\deepseek-harness\default-workspace\watch-together-pc\tools\android\sdk\platforms\android-36\android.jar",
    [string]$Version = "5.7",
    [int]$VersionCode = 18,
    [string]$BaseApp = "input\base.apk",
    [switch]$Shell
)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$bt = Join-Path $Toolchain 'bt'
$jdk = Join-Path $Toolchain 'jdk'
$app = Join-Path $root 'android\app'
$out = Join-Path $root '.build\phone'
$dist = Join-Path $root 'dist'
$ks = Join-Path $root 'android\wt.keystore'

foreach ($t in @((Join-Path $bt 'aapt2.exe'), (Join-Path $bt 'd8.bat'), (Join-Path $bt 'zipalign.exe'), (Join-Path $bt 'apksigner.bat'), (Join-Path $jdk 'bin\javac.exe'), $AndroidJar, $ks)) {
    if (-not (Test-Path $t)) { throw "缺少构建依赖: $t" }
}
$env:JAVA_HOME = $jdk

Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $out, $dist | Out-Null

Write-Output '== aapt2 compile =='
& (Join-Path $bt 'aapt2.exe') compile --dir (Join-Path $app 'res') -o (Join-Path $out 'compiled.zip')
if ($LASTEXITCODE) { throw 'aapt2 compile 失败' }

Write-Output '== aapt2 link =='
& (Join-Path $bt 'aapt2.exe') link -o (Join-Path $out 'resources.apk') -I $AndroidJar `
    --manifest (Join-Path $app 'AndroidManifest.xml') `
    (Join-Path $out 'compiled.zip') `
    --min-sdk-version 24 --target-sdk-version 36
if ($LASTEXITCODE) { throw 'aapt2 link 失败' }

if ($Shell) {
    Write-Output '== 打包网页资源 =='
    $assets = Join-Path $out 'assets\web'
    New-Item -ItemType Directory -Force -Path $assets | Out-Null
    robocopy (Join-Path $root 'web') $assets /MIR /NFL /NDL /NJH /NJS | Out-Null
    if ($LASTEXITCODE -gt 7) { throw '复制网页资源失败' }
    $global:LASTEXITCODE = 0

    Write-Output '== javac =='
    $src = Join-Path $app 'src\com\watchtogether\phone\MainActivity.java'
    & (Join-Path $jdk 'bin\javac.exe') -encoding UTF-8 -classpath $AndroidJar -d (Join-Path $out 'classes') $src
    if ($LASTEXITCODE) { throw 'javac 失败' }

    Write-Output '== d8 =='
    New-Item -ItemType Directory -Force -Path (Join-Path $out 'dex') | Out-Null
    $classes = Get-ChildItem (Join-Path $out 'classes') -Recurse -Filter *.class | ForEach-Object { $_.FullName }
    & (Join-Path $bt 'd8.bat') --lib $AndroidJar --min-api 24 --output (Join-Path $out 'dex') @classes
    if ($LASTEXITCODE) { throw 'd8 失败' }

    Write-Output '== 合并 dex =='
    python (Join-Path $root 'tools\pack_phone_apk.py') (Join-Path $out 'resources.apk') (Join-Path $out 'dex\classes.dex') (Join-Path $out 'packed.apk')
    if ($LASTEXITCODE) { throw '合并 dex 失败' }
} else {
    Write-Output '== 合入原生基线（保留本机服务与开房能力）=='
    $base = Join-Path $root $BaseApp
    if (-not (Test-Path $base)) { throw "缺少原生基线 APK: $base" }
    python (Join-Path $root 'tools\repack_phone_interop.py') $base (Join-Path $out 'resources.apk') (Join-Path $out 'packed.apk')
    if ($LASTEXITCODE) { throw '合入原生基线失败' }
}

Write-Output '== zipalign =='
& (Join-Path $bt 'zipalign.exe') -f 4 (Join-Path $out 'packed.apk') (Join-Path $out 'aligned.apk')
if ($LASTEXITCODE) { throw 'zipalign 失败' }

Write-Output '== 签名 =='
$final = Join-Path $dist "一起看手机端-Android-v$Version.apk"
& (Join-Path $bt 'apksigner.bat') sign --ks $ks --ks-pass pass:watchtogether --key-pass pass:watchtogether `
    --in (Join-Path $out 'aligned.apk') --out $final
if ($LASTEXITCODE) { throw 'apksigner 失败' }
& (Join-Path $bt 'apksigner.bat') verify --print-certs $final
if ($LASTEXITCODE) { throw 'apksigner verify 失败' }

Write-Output ("完成 -> " + $final + " (" + [math]::Round((Get-Item $final).Length / 1MB, 2) + " MB)")
