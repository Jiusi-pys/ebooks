param([string]$Serial='127.0.0.1:16416',[string]$AndroidSdk="$env:LOCALAPPDATA/Android/Sdk",[int[]]$Widths=@(320,600,840,1024),[double[]]$FontScales=@(1.0,2.0))
$ErrorActionPreference='Stop'
$repo=(Resolve-Path "$PSScriptRoot/../../..").Path
$adb="$AndroidSdk/platform-tools/adb.exe"
$output="$repo/docs/evidence/android-ios/mind-matrix"
New-Item -ItemType Directory -Force $output | Out-Null
$font=(& $adb -s $Serial shell settings get system font_scale | Out-String).Trim()
$results=@()
try {
    foreach($width in $Widths){foreach($scale in $FontScales){
        $label="w$width-font$($scale.ToString([Globalization.CultureInfo]::InvariantCulture))"
        & $adb -s $Serial shell settings put system font_scale ($scale.ToString([Globalization.CultureInfo]::InvariantCulture)) | Out-Null
        & $adb -s $Serial shell rm -f /sdcard/Android/data/org.shufang.android.acceptance/files/mind-move-touch.png /sdcard/Android/data/org.shufang.android.acceptance/files/mind-move-metrics.json
        $run=(& $adb -s $Serial shell am instrument -w -e windowWidthDp $width -e class org.shufang.android.MindMoveTouchTest org.shufang.android.acceptance.test/androidx.test.runner.AndroidJUnitRunner | Out-String)
        $run | Set-Content -Encoding utf8 "$output/$label.txt"
        $passed=$run -match 'OK \(1 test\)' -and $run -notmatch 'FAILURES|INSTRUMENTATION_FAILED'
        $metrics=$null
        if($passed) {
            & $adb -s $Serial pull /sdcard/Android/data/org.shufang.android.acceptance/files/mind-move-touch.png "$output/$label.png" | Out-Null
            if($LASTEXITCODE){throw 'Screenshot retrieval failed'}
            & $adb -s $Serial pull /sdcard/Android/data/org.shufang.android.acceptance/files/mind-move-metrics.json "$output/$label.json" | Out-Null
            if($LASTEXITCODE){throw 'Window metadata retrieval failed'}
            $metrics=Get-Content "$output/$label.json" -Raw | ConvertFrom-Json
            $passed=$metrics.widthDp -eq $width -and [Math]::Abs($metrics.fontScale-$scale) -lt 0.01
        }
        $results+=@{profile=$label;passed=$passed;actual=$metrics}
        Write-Output "$label : $passed"
    }}
} finally {
    if($font -eq 'null'){& $adb -s $Serial shell settings delete system font_scale | Out-Null}else{& $adb -s $Serial shell settings put system font_scale $font | Out-Null}
    $results | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 "$output/results.json"
}
if(@($results | Where-Object {!$_.passed}).Count){throw 'Mind map touch profiles failed; inspect the evidence logs'}
