param([string]$Serial="127.0.0.1:16416",[string]$AndroidSdk="$env:LOCALAPPDATA/Android/Sdk",[string]$Model="")
$ErrorActionPreference="Stop"
$adb="$AndroidSdk/platform-tools/adb.exe"
$repo=(Resolve-Path "$PSScriptRoot/../../..").Path
if(!$Model){$Model="$repo/.tools/models/qwen2.5-0.5b-instruct-q4_k_m.gguf"}
$runner="org.shufang.android.acceptance.test/androidx.test.runner.AndroidJUnitRunner"
$output="$repo/docs/evidence/android-ios/local-model"
New-Item -ItemType Directory -Force $output | Out-Null
& $adb -s $Serial push $Model /data/local/tmp/shufang-acceptance.gguf | Out-Null
$before=(& $adb -s $Serial shell am instrument -w -e class org.shufang.android.IosParityRuntimeTest#networkPrecondition -e networkExpectation online $runner | Out-String)
$before | Set-Content -Encoding utf8 "$output/network-online.txt"
if($before -notmatch 'OK \(1 test\)'){throw "The online control failed; offline inference must not be claimed"}
$chain=(& $adb -s $Serial shell cmd connectivity get-chain3-enabled | Out-String).Trim()
$allowed=(& $adb -s $Serial shell cmd connectivity get-package-networking-enabled org.shufang.android.acceptance | Out-String).Trim()
if($chain -eq 'chain:disabled'){$chain='false'}elseif($chain -eq 'chain:enabled'){$chain='true'}
if($allowed -eq 'org.shufang.android.acceptance:allow'){$allowed='true'}elseif($allowed -eq 'org.shufang.android.acceptance:deny'){$allowed='false'}
if($chain -notin @('true','false') -or $allowed -notin @('true','false')){throw 'Unable to preserve networking configuration'}
try {
    & $adb -s $Serial shell cmd connectivity set-package-networking-enabled false org.shufang.android.acceptance | Out-Null
    & $adb -s $Serial shell cmd connectivity set-chain3-enabled true | Out-Null
    $result=(& $adb -s $Serial shell am instrument -w -e class 'org.shufang.android.IosParityRuntimeTest#networkPrecondition,org.shufang.android.IosParityRuntimeTest#installedRealModelStreamsAndCancelsWithoutServer,org.shufang.android.ReaderBridgeTest' -e networkExpectation offline -e requireOffline true -e modelPath /data/local/tmp/shufang-acceptance.gguf $runner | Out-String)
    $result | Set-Content -Encoding utf8 "$output/offline-results.txt"
    if($result -notmatch 'OK \(4 tests\)'){throw 'Offline model or local document verification failed'}
    & $adb -s $Serial shell run-as org.shufang.android.acceptance cat files/local-ai-acceptance.txt | Set-Content -Encoding utf8 "$output/partial-output.txt"
    Get-FileHash -LiteralPath $Model -Algorithm SHA256 | ConvertTo-Json | Set-Content -Encoding utf8 "$output/model-hash.json"
} finally {
    & $adb -s $Serial shell cmd connectivity set-package-networking-enabled $allowed org.shufang.android.acceptance | Out-Null
    & $adb -s $Serial shell cmd connectivity set-chain3-enabled $chain | Out-Null
}
